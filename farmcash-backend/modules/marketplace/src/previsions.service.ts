// =====================================================================
//  SERVICE : PrevisionsService
//  ---------------------------------------------------------------------
//  Prévisions de récolte (FARMER) + réservations futures (BUYER).
//
//  Règles métier :
//   • Une prévision est créée par un FARMER (farmer_id = user_id).
//     Les COOPERATIVE qui veulent agréger passent par leur propre
//     mécanisme (publications_stock_coop) — pas ici.
//   • date_recolte_prev doit être > now.
//   • Une réservation BUYER est limitée par la quantité prévue
//     diminuée des réservations CONFIRMED précédentes.
//   • Si le fermier a fixé un prix cible, le prix réservé doit ≥ cible.
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, product_status } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { FinanceService } from '@farmcash/finance';
import { NotificationsService } from '@farmcash/notifications';
import {
  ConvertPrevisionDto,
  CreatePrevisionDto,
  CreateReservationDto,
} from './dto/previsions.dto';

@Injectable()
export class PrevisionsService {
  private readonly logger = new Logger(PrevisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => FinanceService))
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
  ) {}

  private get depositRate(): number {
    return parseFloat(
      this.config.get<string>('RESERVATION_DEPOSIT_RATE') ?? '0.10',
    );
  }
  private get finalPaymentDays(): number {
    return parseInt(
      this.config.get<string>('RESERVATION_FINAL_PAYMENT_DAYS') ?? '7',
      10,
    );
  }

  // ===================================================================
  //  CÔTÉ FERMIER
  // ===================================================================

  async getMesPrevisions(farmerId: string) {
    return this.prisma.previsions_production.findMany({
      where: { farmer_id: farmerId },
      include: {
        produits_agricoles: { select: { nom: true } },
        parcelle: { select: { nom: true } },
        reservations_previsions: {
          select: { id: true, status: true, quantite_kg: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Crée une prévision de récolte. La date prévue doit être future.
   */
  async createPrevision(farmerId: string, dto: CreatePrevisionDto) {
    if (dto.date_recolte_prev) {
      const target = new Date(dto.date_recolte_prev);
      if (target.getTime() <= Date.now()) {
        throw new BadRequestException(
          'La date de récolte prévue doit être dans le futur.',
        );
      }
    }

    // Si la prévision est attribuée à une coop, vérifier que le farmer
    // en est bien membre actif (anti-fraude, idem annonces).
    let assignedCoopId: string | null = null;
    if (dto.assigned_to_cooperative_id) {
      const membership = await this.prisma.cooperative_members.findFirst({
        where: {
          member_id: farmerId,
          cooperative_id: dto.assigned_to_cooperative_id,
          is_active: true,
        },
      });
      if (!membership) {
        throw new ForbiddenException(
          "Vous n'êtes pas membre actif de cette coopérative.",
        );
      }
      assignedCoopId = dto.assigned_to_cooperative_id;
    }

    const prevision = await this.prisma.previsions_production.create({
      data: {
        farmer_id: farmerId,
        produit_id: dto.produit_id,
        parcelle_id: dto.parcelle_id,
        saison: dto.saison,
        quantite_prev_kg: dto.quantite_prev_kg,
        date_recolte_prev: dto.date_recolte_prev
          ? new Date(dto.date_recolte_prev)
          : undefined,
        prix_cible_kg: dto.prix_cible_kg,
        notes: dto.notes,
        assigned_to_cooperative_id: assignedCoopId,
        coop_status: assignedCoopId ? 'PENDING' : null,
      },
    });
    return {
      message: assignedCoopId
        ? 'Prévision confiée à votre coopérative (en attente de validation).'
        : 'Prévision de production ajoutée.',
      id: prevision.id,
      coop_status: assignedCoopId ? 'PENDING' : null,
    };
  }

  // ===================================================================
  //  CÔTÉ ACHETEUR
  // ===================================================================

  /**
   * Réservation d'une part de récolte future. Vérifie :
   *   - prévision existante,
   *   - quantité demandée ≤ quantité disponible (prévision - réservations
   *     CONFIRMED précédentes),
   *   - prix réservé ≥ prix cible si défini par le fermier.
   */
  async reserverPrevision(buyerId: string, dto: CreateReservationDto) {
    // Étape 1 : valider + créer la réservation en PENDING dans une TX
    //           avec lock sur la prévision (anti-race).
    const { reservation, depositAmount, prixUtilise } =
      await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          {
            id: string;
            farmer_id: string;
            quantite_prev_kg: any;
            prix_cible_kg: any;
            coop_status: string | null;
            status: string;
          }[]
        >`SELECT id, farmer_id, quantite_prev_kg, prix_cible_kg, coop_status, status
            FROM previsions_production
            WHERE id = ${dto.prevision_id}::uuid
            FOR UPDATE`;
        if (locked.length === 0) {
          throw new NotFoundException('Prévision introuvable.');
        }
        const prevision = locked[0];

        if (prevision.status !== 'OPEN') {
          throw new BadRequestException(
            `Prévision en statut ${prevision.status} — réservation impossible.`,
          );
        }
        if (prevision.farmer_id === buyerId) {
          throw new BadRequestException(
            'Vous ne pouvez pas réserver votre propre prévision.',
          );
        }
        if (
          prevision.coop_status === 'PENDING' ||
          prevision.coop_status === 'REJECTED'
        ) {
          throw new ForbiddenException(
            'Cette prévision est en attente de validation par sa coopérative.',
          );
        }

        const quantitePrev = Number(prevision.quantite_prev_kg ?? 0);
        const dejaReserve = await tx.reservations_previsions.aggregate({
          where: {
            prevision_id: prevision.id,
            status: { in: ['CONFIRMED', 'PENDING', 'AWAITING_FINAL'] },
          },
          _sum: { quantite_kg: true },
        });
        const restant =
          quantitePrev - (dejaReserve._sum.quantite_kg?.toNumber() ?? 0);

        if (dto.quantite_kg > restant) {
          throw new BadRequestException(
            `Quantité demandée (${dto.quantite_kg}kg) supérieure au restant (${restant}kg).`,
          );
        }

        const prixCible = Number(prevision.prix_cible_kg ?? 0);
        const prixUtilise =
          dto.prix_reserve_kg ?? (prixCible > 0 ? prixCible : 0);
        if (prixUtilise <= 0) {
          throw new BadRequestException(
            'Aucun prix réservable (ni prix proposé, ni prix cible).',
          );
        }
        if (prixCible > 0 && prixUtilise < prixCible) {
          throw new BadRequestException(
            `Prix réservé (${prixUtilise}) inférieur au prix cible (${prixCible}).`,
          );
        }

        const depositAmount =
          Math.round(prixUtilise * dto.quantite_kg * this.depositRate * 100) / 100;

        const r = await tx.reservations_previsions.create({
          data: {
            prevision_id: dto.prevision_id,
            acheteur_id: buyerId,
            quantite_kg: dto.quantite_kg,
            prix_reserve_kg: prixUtilise,
            status: 'PENDING',
            deposit_amount: depositAmount,
            deposit_rate: this.depositRate,
          },
        });
        return { reservation: r, depositAmount, prixUtilise };
      });

    // Étape 2 : déclenche le payin du dépôt 10% via FinanceService.
    // Hors de la 1ère TX car processPayin a sa propre TX + circuit
    // breaker + idempotency. Si le payin échoue → on supprime la
    // réservation pour ne pas laisser un PENDING orphelin.
    try {
      const tx = await this.finance.processPayinReservation({
        buyer_id: buyerId,
        reservation_id: reservation.id,
        amount: depositAmount,
        payment_method_id: dto.payment_method_id,
      });

      // Si payin instantané OK (mock), on bascule en CONFIRMED.
      if (tx.status === 'ESCROW' || tx.status === 'SUCCESS') {
        await this.prisma.reservations_previsions.update({
          where: { id: reservation.id },
          data: {
            status: 'CONFIRMED',
            deposit_paid_at: new Date(),
            deposit_transaction_id: tx.id,
          },
        });
      }
      return {
        message: `Réservation enregistrée. Acompte ${depositAmount} F bloqué (${(this.depositRate * 100).toFixed(0)}%).`,
        id: reservation.id,
        deposit_amount: depositAmount,
        deposit_status: tx.status,
      };
    } catch (e: any) {
      await this.prisma.reservations_previsions.delete({
        where: { id: reservation.id },
      });
      throw new BadRequestException(
        `Échec du paiement de l'acompte : ${e?.message ?? e}`,
      );
    }
  }

  // ===================================================================
  //  CONVERSION PRÉVISION → ANNONCE
  // ===================================================================

  /**
   * Le producteur (ou la coop) clique "Convertir" quand la récolte
   * est prête. Crée une annonce_vente officielle à partir de la
   * prévision et notifie tous les buyers qui ont réservé.
   * Chaque réservation passe en AWAITING_FINAL avec un délai pour
   * payer le solde 90% restant.
   */
  async convertPrevision(
    userId: string,
    role: string,
    previsionId: string,
    dto: ConvertPrevisionDto,
  ) {
    if (role !== 'FARMER' && role !== 'COOPERATIVE') {
      throw new ForbiddenException(
        'Seul un FARMER ou une COOPERATIVE peut convertir.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<
        {
          id: string;
          farmer_id: string;
          quantite_prev_kg: any;
          coop_status: string | null;
          status: string;
          produit_id: string | null;
        }[]
      >`SELECT id, farmer_id, quantite_prev_kg, coop_status, status, produit_id
          FROM previsions_production
          WHERE id = ${previsionId}::uuid
          FOR UPDATE`;
      if (lockedRows.length === 0) throw new NotFoundException('Prévision introuvable.');
      const prevision = lockedRows[0];

      if (prevision.farmer_id !== userId) {
        throw new ForbiddenException('Cette prévision ne vous appartient pas.');
      }
      if (prevision.status !== 'OPEN') {
        throw new ConflictException(
          `Prévision déjà en statut ${prevision.status}.`,
        );
      }
      if (
        prevision.coop_status === 'PENDING' ||
        prevision.coop_status === 'REJECTED'
      ) {
        throw new BadRequestException(
          'Validation coop requise avant conversion.',
        );
      }
      if (!prevision.produit_id) {
        throw new BadRequestException(
          'Produit manquant sur la prévision — impossible de convertir.',
        );
      }

      // Calcule la quantité publique de l'annonce :
      //   total prévu MOINS le total réservé par des buyers (qui ont payé l'acompte 10%).
      // Le stock réservé n'apparaît PAS sur le marketplace public : il
      // est garanti aux buyers en attente, tant qu'ils paient le solde
      // avant expiration. À l'expiration, ce stock revient au public.
      const totalReserved = await tx.reservations_previsions.aggregate({
        where: {
          prevision_id: previsionId,
          status: { in: ['CONFIRMED', 'PENDING'] },
        },
        _sum: { quantite_kg: true },
      });
      const reservedKg = Number(totalReserved._sum.quantite_kg ?? 0);
      const publicKg = Math.max(
        Number(prevision.quantite_prev_kg) - reservedKg,
        0,
      );

      // Crée l'annonce_vente officielle (publique = solde non réservé).
      const { lng, lat } = dto.coordinates;
      const created = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO annonces_vente (
          farmer_id, produit_id, titre, description,
          quantite_kg, prix_par_kg, quantite_min_kg, qualite,
          region_id, ville_id, location, status
        ) VALUES (
          ${prevision.farmer_id}::uuid,
          ${prevision.produit_id}::uuid,
          ${dto.titre},
          ${dto.description ?? null},
          ${publicKg},
          ${dto.prix_par_kg},
          ${dto.quantite_min_kg},
          ${dto.qualite}::product_quality,
          ${dto.region_id}::uuid,
          ${dto.ville_id}::uuid,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326),
          ${product_status.ACTIVE}::product_status
        ) RETURNING id;
      `;
      const annonceId = created[0]?.id;

      // Marque la prévision CONVERTED + lie à l'annonce
      await tx.previsions_production.update({
        where: { id: previsionId },
        data: {
          status: 'CONVERTED',
          converted_to_annonce_id: annonceId,
          converted_at: new Date(),
        },
      });

      // Bascule toutes les réservations CONFIRMED en AWAITING_FINAL avec
      // une date d'expiration pour payer le solde.
      const expiresAt = new Date(
        Date.now() + this.finalPaymentDays * 24 * 60 * 60 * 1000,
      );
      const reservations = await tx.reservations_previsions.findMany({
        where: {
          prevision_id: previsionId,
          status: { in: ['CONFIRMED', 'PENDING'] },
        },
      });
      for (const r of reservations) {
        await tx.reservations_previsions.update({
          where: { id: r.id },
          data: {
            status: 'AWAITING_FINAL',
            expires_at: expiresAt,
            notified_at: new Date(),
          },
        });
      }

      return { annonceId, reservations };
    });

    // Notifications hors transaction
    for (const r of result.reservations) {
      this.notifications
        .create({
          user_id: r.acheteur_id,
          type: 'MARKETPLACE' as any,
          titre: '🎉 Votre prévision est prête !',
          body: `La récolte est livrable. Payez le solde 90% sous ${this.finalPaymentDays} jours pour confirmer votre lot.`,
          data: {
            reservation_id: r.id,
            prevision_id: previsionId,
            annonce_id: result.annonceId,
          },
        })
        .catch((e) => this.logger.warn(`Notif KO: ${e?.message}`));
    }

    this.logger.log(
      `Prévision ${previsionId} convertie en annonce ${result.annonceId} (${result.reservations.length} buyers notifiés)`,
    );
    return {
      annonce_id: result.annonceId,
      reservations_notified: result.reservations.length,
      expires_in_days: this.finalPaymentDays,
    };
  }

  // ===================================================================
  //  EXPIRATION : reservations AWAITING_FINAL non payées
  //  ---------------------------------------------------------------------
  //  Appelée par un cron quotidien (ou à la demande par un admin).
  //  Selon RESERVATION_EXPIRED_DEPOSIT_POLICY :
  //   • FORFEIT_TO_FARMER (défaut) : le deposit reste au producteur
  //   • REFUND_BUYER : le deposit est remboursé au buyer
  // ===================================================================

  async expireReservations(): Promise<{ expired: number; forfeited: number; refunded: number }> {
    const policy =
      this.config.get<string>('RESERVATION_EXPIRED_DEPOSIT_POLICY') ??
      'FORFEIT_TO_FARMER';
    const expired = await this.prisma.reservations_previsions.findMany({
      where: {
        status: 'AWAITING_FINAL',
        expires_at: { lt: new Date() },
      },
      include: {
        previsions_production: {
          select: { farmer_id: true, converted_to_annonce_id: true },
        },
      },
    });

    let forfeited = 0;
    let refunded = 0;
    for (const r of expired) {
      try {
        // 1. Argent : forfeit ou refund
        if (policy === 'REFUND_BUYER' && r.deposit_transaction_id) {
          await this.finance.refundReservationDeposit(r.id);
          refunded++;
        } else {
          await this.finance.forfeitReservationDeposit(
            r.id,
            r.previsions_production.farmer_id,
          );
          forfeited++;
        }

        // 2. Stock : libère la quantité réservée vers l'annonce publique
        //    (verrouillage atomique pour éviter qu'un buyer commande
        //    pendant la libération).
        await this.prisma.$transaction(async (tx) => {
          if (r.previsions_production.converted_to_annonce_id) {
            await tx.$queryRaw`
              SELECT id FROM annonces_vente
                WHERE id = ${r.previsions_production.converted_to_annonce_id}::uuid
                FOR UPDATE`;
            await tx.annonces_vente.update({
              where: { id: r.previsions_production.converted_to_annonce_id },
              data: {
                quantite_kg: { increment: r.quantite_kg },
                // Si l'annonce était SOLD (stock=0), elle redevient ACTIVE
                status: 'ACTIVE' as any,
              },
            });
          }
          await tx.reservations_previsions.update({
            where: { id: r.id },
            data: { status: 'EXPIRED' },
          });
        });

        this.logger.warn(
          `Reservation ${r.id} expired → +${r.quantite_kg} kg libérés sur l'annonce`,
        );
      } catch (e: any) {
        this.logger.error(`Expiration KO pour resa ${r.id}: ${e?.message}`);
      }
    }
    return { expired: expired.length, forfeited, refunded };
  }
}
