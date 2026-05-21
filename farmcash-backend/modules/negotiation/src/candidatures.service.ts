// =====================================================================
//  SERVICE : CandidaturesService (Négociation B2B/C2C)
//  ---------------------------------------------------------------------
//  Implémente les 3 flux de négociation :
//   • CANDIDATURE   (BUYER → FARMER  sur annonce_vente)
//   • PROPOSITION   (FARMER/COOP → BUYER sur annonce_achat)
//   • CONTRE-OFFRE  (BUYER → COOPERATIVE sur publication_stock_coop)
//
//  Chaque flux suit le MÊME pattern :
//   1. Lookup de la cible + checks métier (status, propriétaire ≠ acteur,
//      quantité dispo, pas de doublon pending).
//   2. Insertion dans la table principale.
//   3. Insertion d'une ligne d'audit dans la table *_traitements.
//   4. Le tout dans une transaction Prisma (atomicité).
//
//  Pour traiter (accepter/refuser/counter/annuler) :
//   • On vérifie que l'acteur a le DROIT (seller, buyer, ou coopérative).
//   • On applique une state machine (pas de transition arbitraire).
//   • On log l'action dans *_traitements.
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { order_status, Prisma, product_status } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService, NotificationType } from '@farmcash/notifications';
import {
  CreateCandidatureAchatDto,
  CreateContreOffreCoopDto,
  CreatePropositionVenteDto,
  ListerNegotiationsQueryDto,
  NegotiationAction,
  NegotiationDirection,
  NegotiationStatus,
  TraiterOffreDto,
} from './dto/candidatures.dto';

// État → transitions autorisées. Centralisé pour faciliter l'audit.
const ALLOWED_TRANSITIONS: Record<NegotiationStatus, NegotiationStatus[]> = {
  PENDING: [
    NegotiationStatus.ACCEPTED,
    NegotiationStatus.REJECTED,
    NegotiationStatus.COUNTER_OFFER,
    NegotiationStatus.CANCELLED,
  ],
  COUNTER_OFFER: [
    NegotiationStatus.ACCEPTED,
    NegotiationStatus.REJECTED,
    NegotiationStatus.COUNTER_OFFER,
    NegotiationStatus.CANCELLED,
  ],
  // États terminaux : aucune transition autorisée.
  ACCEPTED: [],
  REJECTED: [],
  CANCELLED: [],
};

// Frais service par défaut si la config env n'est pas définie.
// Aligné sur DEFAULT_SERVICE_FEE_PRODUCT d'Orders pour éviter toute
// divergence entre commande créée via négo vs via marketplace direct.
const DEFAULT_SERVICE_FEE_PRODUCT = 0.03;

@Injectable()
export class CandidaturesService {
  private readonly logger = new Logger(CandidaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Helper : envoie une notif "NEGOTIATION" en arrière-plan. On utilise
   * fire-and-forget pour ne pas bloquer la réponse HTTP si Prisma de
   * notifs est lent — l'événement RxJS est déjà émis vers le SSE.
   * Les erreurs sont seulement loggées (non bloquantes).
   */
  private notifyNegotiation(
    userId: string,
    titre: string,
    body: string,
    data: Record<string, string>,
  ): void {
    this.notifications
      .create({
        user_id: userId,
        type: NotificationType.NEGOTIATION,
        titre,
        body,
        data,
      })
      .catch((e) => this.logger.warn(`Notif KO: ${e?.message}`));
  }

  // ===================================================================
  //  CANDIDATURE  (BUYER → FARMER)
  // ===================================================================

  /**
   * Le buyer propose un achat sur une annonce de vente.
   *
   * Garde-fous :
   *   • L'annonce existe et est ACTIVE.
   *   • Le buyer n'est pas le farmer (pas d'auto-offre).
   *   • Quantité demandée ≤ stock affiché.
   *   • Pas déjà une candidature PENDING/COUNTER_OFFER en cours du même
   *     buyer sur la même annonce (anti-spam).
   *   • Si prix_propose_kg n'est pas fourni, on reprend le prix de l'annonce.
   */
  async createCandidatureAchat(buyerId: string, dto: CreateCandidatureAchatDto) {
    const annonce = await this.prisma.annonces_vente.findUnique({
      where: { id: dto.annonce_id },
      select: {
        id: true,
        farmer_id: true,
        status: true,
        quantite_kg: true,
        prix_par_kg: true,
        coop_status: true,
      },
    });
    if (!annonce) throw new NotFoundException('Annonce introuvable.');
    if (annonce.status !== product_status.ACTIVE) {
      throw new BadRequestException("L'annonce n'est pas active.");
    }
    // Annonces en workflow coop : invisibles du marketplace public, donc
    // non négociables directement. La vente passera par la publication
    // coop agrégée (contre_offres_coop).
    if (annonce.coop_status !== null) {
      throw new ForbiddenException(
        'Cette annonce est gérée par une coopérative — négociez via la publication coop.',
      );
    }
    if (annonce.farmer_id === buyerId) {
      throw new BadRequestException('Vous ne pouvez pas offrir sur votre propre annonce.');
    }
    if (dto.quantite_kg > annonce.quantite_kg.toNumber()) {
      throw new BadRequestException(
        `Quantité (${dto.quantite_kg}kg) supérieure au stock (${annonce.quantite_kg}kg).`,
      );
    }
    const enCours = await this.prisma.candidatures_achat.findFirst({
      where: {
        annonce_id: dto.annonce_id,
        buyer_id: buyerId,
        status: { in: [NegotiationStatus.PENDING, NegotiationStatus.COUNTER_OFFER] },
      },
      select: { id: true },
    });
    if (enCours) {
      throw new ConflictException(
        'Vous avez déjà une candidature en cours sur cette annonce.',
      );
    }

    const prix = dto.prix_propose_kg ?? annonce.prix_par_kg.toNumber();

    const result = await this.prisma.$transaction(async (tx) => {
      const c = await tx.candidatures_achat.create({
        data: {
          annonce_id: dto.annonce_id,
          buyer_id: buyerId,
          quantite_kg: dto.quantite_kg,
          prix_propose_kg: prix,
          message: dto.message,
          status: NegotiationStatus.PENDING,
        },
      });
      await tx.candidature_traitements.create({
        data: {
          candidature_id: c.id,
          acteur_id: buyerId,
          action: 'CREATED',
          prix_contre_offre: prix,
          quantite_kg: dto.quantite_kg,
          note: dto.message,
        },
      });
      return c;
    });

    // Notifier le FARMER en arrière-plan (SSE + DB).
    this.notifyNegotiation(
      annonce.farmer_id,
      'Nouvelle offre sur votre annonce 📩',
      `Un acheteur propose ${dto.quantite_kg} kg à ${prix} FCFA/kg.`,
      { candidature_id: result.id, annonce_id: dto.annonce_id },
    );

    return { message: 'Offre envoyée au vendeur.', id: result.id };
  }

  /**
   * Traite (accepter/refuser/contre-offrir/annuler) une candidature.
   *
   * Autorisations :
   *   • Le FARMER (annonce.farmer_id) peut : ACCEPTED, REJECTED, COUNTER_OFFER
   *   • Le BUYER  (candidature.buyer_id)  peut : CANCELLED, COUNTER_OFFER
   *   • Nul autre user ne peut traiter.
   */
  async traiterCandidatureAchat(
    acteurId: string,
    candidatureId: string,
    dto: TraiterOffreDto,
  ) {
    const candidature = await this.prisma.candidatures_achat.findUnique({
      where: { id: candidatureId },
      include: { annonces_vente: { select: { farmer_id: true } } },
    });
    if (!candidature) throw new NotFoundException('Candidature introuvable.');

    const isSeller = candidature.annonces_vente.farmer_id === acteurId;
    const isBuyer = candidature.buyer_id === acteurId;
    if (!isSeller && !isBuyer) {
      throw new ForbiddenException('Vous n\'êtes pas partie à cette négociation.');
    }

    const sellerActions = new Set([
      NegotiationAction.ACCEPTED,
      NegotiationAction.REJECTED,
      NegotiationAction.COUNTER_OFFER,
    ]);
    const buyerActions = new Set([
      NegotiationAction.CANCELLED,
      NegotiationAction.COUNTER_OFFER,
    ]);
    const allowed = isSeller ? sellerActions : buyerActions;
    if (!allowed.has(dto.action)) {
      throw new ForbiddenException(`Action ${dto.action} non autorisée pour votre rôle dans cette négociation.`);
    }

    this.assertTransition(candidature.status as NegotiationStatus, dto.action);

    if (dto.action === NegotiationAction.COUNTER_OFFER) {
      if (dto.prix_contre_offre === undefined || dto.quantite_kg === undefined) {
        throw new BadRequestException(
          'COUNTER_OFFER requiert prix_contre_offre ET quantite_kg.',
        );
      }
    }

    // Cas particulier : ACCEPTED par le farmer → on crée immédiatement
    // la commande au prix négocié, dans la MÊME transaction, et on
    // marque les autres candidatures PENDING/COUNTER_OFFER sur la même
    // annonce comme REJECTED_BY_RACE (race-loser).
    //
    // TODO Orders : exposer `POST /orders/:id/pay` (ou équivalent) pour
    // que le buyer puisse déclencher le payin sur une commande SENT
    // existante. Aujourd'hui le payin n'est lancé QUE depuis `createOrder`.
    // En attendant, le cleanup automatique des orders SENT > 24h
    // (cf. OrdersCleanupCron + cleanupOrphanOrders) restitue la
    // quantité bloquée si le buyer ne paie pas.
    const shouldCreateOrder =
      dto.action === NegotiationAction.ACCEPTED && isSeller;

    let createdOrderId: string | null = null;
    let orderRef: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      await tx.candidatures_achat.update({
        where: { id: candidatureId },
        data: {
          status: dto.action,
          updated_at: new Date(),
          ...(dto.action === NegotiationAction.COUNTER_OFFER && {
            quantite_kg: dto.quantite_kg!,
            prix_propose_kg: dto.prix_contre_offre!,
          }),
        },
      });
      await tx.candidature_traitements.create({
        data: {
          candidature_id: candidatureId,
          acteur_id: acteurId,
          action: dto.action,
          prix_contre_offre: dto.prix_contre_offre,
          quantite_kg: dto.quantite_kg,
          note: dto.note,
        },
      });

      if (shouldCreateOrder) {
        // Lock l'annonce (FOR UPDATE) pour empêcher une autre acceptation
        // concurrente sur la même annonce de créer 2 commandes.
        const annonceRows = await tx.$queryRaw<
          {
            id: string;
            farmer_id: string;
            quantite_kg: Prisma.Decimal;
            prix_par_kg: Prisma.Decimal;
            status: string;
          }[]
        >`SELECT id, farmer_id, quantite_kg, prix_par_kg, status
            FROM annonces_vente
            WHERE id = ${candidature.annonce_id}::uuid
            FOR UPDATE`;
        if (annonceRows.length === 0) {
          throw new NotFoundException('Annonce introuvable.');
        }
        const annonce = annonceRows[0];
        if (annonce.status !== product_status.ACTIVE) {
          throw new BadRequestException("L'annonce n'est plus active.");
        }

        const qty = new Prisma.Decimal(candidature.quantite_kg.toString());
        const prixKg = new Prisma.Decimal(
          (candidature.prix_propose_kg ?? annonce.prix_par_kg).toString(),
        );
        const annonceQty = new Prisma.Decimal(annonce.quantite_kg.toString());
        if (qty.greaterThan(annonceQty)) {
          throw new BadRequestException(
            `Stock insuffisant (${annonce.quantite_kg} kg dispo).`,
          );
        }

        // Idempotency : candidature_id (une candidature => 1 seule cmd).
        const existing = await tx.commandes_vente.findFirst({
          where: { idempotency_key: candidatureId },
          select: { id: true, reference: true },
        });
        if (existing) {
          createdOrderId = existing.id;
          orderRef = existing.reference;
        } else {
          const feeRate = new Prisma.Decimal(
            this.config.get<string>('SERVICE_FEE_PRODUCT') ??
              String(DEFAULT_SERVICE_FEE_PRODUCT),
          );
          const productAmount = qty.times(prixKg).toDecimalPlaces(2);
          const productFee = productAmount.times(feeRate).toDecimalPlaces(2);
          const sellerNet = productAmount.minus(productFee);
          const ref = `ORD-${Date.now()}-${randomBytes(2).toString('hex')}`;

          const cmd = await tx.commandes_vente.create({
            data: {
              reference: ref,
              buyer_id: candidature.buyer_id,
              seller_id: annonce.farmer_id,
              annonce_id: candidature.annonce_id,
              quantite_kg: qty,
              prix_unitaire_kg: prixKg,
              montant_total: productAmount,
              frais_service: productFee,
              montant_net: sellerNet,
              status: order_status.SENT,
              idempotency_key: candidatureId,
              notes: "Issue d'une candidature acceptée",
            },
          });
          createdOrderId = cmd.id;
          orderRef = cmd.reference;
        }

        // Marque les autres candidatures PENDING/COUNTER_OFFER sur cette
        // annonce comme REJECTED_BY_RACE (status VARCHAR(30), pas un
        // enum SQL — on peut écrire une string libre).
        await tx.candidatures_achat.updateMany({
          where: {
            annonce_id: candidature.annonce_id,
            id: { not: candidatureId },
            status: {
              in: [NegotiationStatus.PENDING, NegotiationStatus.COUNTER_OFFER],
            },
          },
          data: { status: 'REJECTED_BY_RACE', updated_at: new Date() },
        });
      }
    });

    // Notifie l'autre partie. Si c'est le farmer qui a agi, on notifie
    // le buyer ; et inversement. Message contextualisé selon l'action.
    const recipientId = isSeller ? candidature.buyer_id : candidature.annonces_vente.farmer_id;
    const labels: Record<NegotiationAction, { titre: string; body: string }> = {
      ACCEPTED:      { titre: '✅ Offre acceptée',        body: 'Votre offre vient d\'être acceptée.' },
      REJECTED:      { titre: '❌ Offre refusée',         body: 'Votre offre a été refusée.' },
      COUNTER_OFFER: { titre: '🔄 Contre-offre reçue',    body: `Nouvelle contre-proposition : ${dto.quantite_kg} kg à ${dto.prix_contre_offre} FCFA/kg.` },
      CANCELLED:     { titre: '🚫 Offre annulée',         body: 'L\'acheteur a annulé son offre.' },
    };

    // Si ACCEPTED par le seller → message enrichi pour le buyer
    // (commande créée, l'inviter à payer).
    if (shouldCreateOrder && createdOrderId) {
      labels.ACCEPTED = {
        titre: '✅ Votre candidature a été acceptée',
        body: `Commande ${orderRef ?? ''} créée. Procédez au paiement depuis votre liste de commandes.`,
      };
    }

    const { titre, body } = labels[dto.action];
    const notifData: Record<string, string> = { candidature_id: candidatureId };
    if (createdOrderId) notifData.commande_id = createdOrderId;
    this.notifyNegotiation(recipientId, titre, body, notifData);

    const response: Record<string, unknown> = {
      message: `Candidature marquée comme ${dto.action}.`,
    };
    if (createdOrderId) {
      response.commande_id = createdOrderId;
      response.reference = orderRef;
    }
    return response;
  }

  /**
   * Liste les candidatures. Selon `direction` :
   *   • outgoing : celles que j'ai émises (BUYER perspective)
   *   • incoming : celles reçues sur mes annonces (FARMER perspective)
   */
  async listerCandidatures(userId: string, query: ListerNegotiationsQueryDto) {
    const direction = query.direction ?? NegotiationDirection.OUTGOING;
    const where: Prisma.candidatures_achatWhereInput = {
      ...(query.status && { status: query.status }),
      ...(direction === NegotiationDirection.OUTGOING
        ? { buyer_id: userId }
        : { annonces_vente: { farmer_id: userId } }),
    };

    return this.prisma.candidatures_achat.findMany({
      where,
      include: {
        annonces_vente: { select: { titre: true, farmer_id: true } },
        candidature_traitements: { orderBy: { created_at: 'desc' }, take: 10 },
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  // ===================================================================
  //  PROPOSITION (FARMER/COOP → BUYER)
  // ===================================================================

  async createPropositionVente(
    vendeurId: string,
    role: string,
    coopId: string | null,
    dto: CreatePropositionVenteDto,
  ) {
    const annonceAchat = await this.prisma.annonces_achat.findUnique({
      where: { id: dto.annonce_achat_id },
      select: {
        id: true,
        buyer_id: true,
        is_active: true,
        quantite_kg: true,
        target_audience: true,
        target_cooperative_id: true,
      },
    });
    if (!annonceAchat) throw new NotFoundException("Demande d'achat introuvable.");
    if (!annonceAchat.is_active) {
      throw new BadRequestException("La demande d'achat n'est plus active.");
    }
    if (annonceAchat.buyer_id === vendeurId) {
      throw new BadRequestException('Vous ne pouvez pas répondre à votre propre demande.');
    }
    // Visibilité :
    //  • PUBLIC               → tout vendeur peut répondre (FARMER ou COOP)
    //  • ALL_COOPERATIVES     → seules les coops peuvent répondre
    //  • SPECIFIC_COOPERATIVE → seule la coop ciblée peut répondre
    if (annonceAchat.target_audience === 'ALL_COOPERATIVES') {
      if (role !== 'COOPERATIVE') {
        throw new ForbiddenException(
          "Cette demande d'achat est réservée aux coopératives.",
        );
      }
    } else if (annonceAchat.target_audience === 'SPECIFIC_COOPERATIVE') {
      if (role !== 'COOPERATIVE' || coopId !== annonceAchat.target_cooperative_id) {
        throw new ForbiddenException(
          'Cette demande d\'achat cible une coopérative spécifique.',
        );
      }
    }
    if (dto.quantite_kg > annonceAchat.quantite_kg.toNumber()) {
      throw new BadRequestException(
        `Quantité supérieure à la demande de l'acheteur (${annonceAchat.quantite_kg}kg).`,
      );
    }

    // Si une annonce_vente_id est fournie, vérifier que le vendeur en est propriétaire.
    if (dto.annonce_vente_id) {
      const owns = await this.prisma.annonces_vente.findFirst({
        where: { id: dto.annonce_vente_id, farmer_id: vendeurId },
        select: { id: true },
      });
      if (!owns) {
        throw new ForbiddenException("L'annonce_vente_id n'est pas la vôtre.");
      }
    }

    // Idem pour publication_coop_id (uniquement si role = COOPERATIVE).
    if (dto.publication_coop_id) {
      if (role !== 'COOPERATIVE' || !coopId) {
        throw new ForbiddenException(
          'Seul une COOPERATIVE peut rattacher une publication coop.',
        );
      }
      const owns = await this.prisma.publications_stock_coop.findFirst({
        where: { id: dto.publication_coop_id, cooperative_id: coopId },
        select: { id: true },
      });
      if (!owns) {
        throw new ForbiddenException("La publication coop n'appartient pas à votre coopérative.");
      }
    }

    const enCours = await this.prisma.propositions_vente.findFirst({
      where: {
        annonce_achat_id: dto.annonce_achat_id,
        vendeur_id: vendeurId,
        status: { in: [NegotiationStatus.PENDING, NegotiationStatus.COUNTER_OFFER] },
      },
      select: { id: true },
    });
    if (enCours) {
      throw new ConflictException(
        'Vous avez déjà une proposition en cours sur cette demande.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const p = await tx.propositions_vente.create({
        data: {
          annonce_achat_id: dto.annonce_achat_id,
          vendeur_id: vendeurId,
          annonce_vente_id: dto.annonce_vente_id,
          publication_coop_id: dto.publication_coop_id,
          quantite_kg: dto.quantite_kg,
          prix_propose_kg: dto.prix_propose_kg,
          delai_livraison_j: dto.delai_livraison_j,
          lieu_livraison: dto.lieu_livraison,
          message: dto.message,
          status: NegotiationStatus.PENDING,
        },
      });
      await tx.proposition_traitements.create({
        data: {
          proposition_id: p.id,
          acteur_id: vendeurId,
          action: 'CREATED',
          prix_contre_offre: dto.prix_propose_kg,
          quantite_kg: dto.quantite_kg,
          note: dto.message,
        },
      });
      return p;
    });

    this.notifyNegotiation(
      annonceAchat.buyer_id,
      'Nouvelle proposition reçue 📩',
      `Un vendeur propose ${dto.quantite_kg} kg à ${dto.prix_propose_kg} FCFA/kg.`,
      { proposition_id: result.id, annonce_achat_id: dto.annonce_achat_id },
    );

    return { message: "Proposition envoyée à l'acheteur.", id: result.id };
  }

  /**
   * Traite une proposition de vente. Symétrique de traiterCandidatureAchat :
   *   • Le BUYER (acheteur de la demande) peut : ACCEPTED, REJECTED, COUNTER_OFFER
   *   • Le VENDEUR (proposition.vendeur_id) peut : CANCELLED, COUNTER_OFFER
   */
  async traiterPropositionVente(
    acteurId: string,
    propositionId: string,
    dto: TraiterOffreDto,
  ) {
    const prop = await this.prisma.propositions_vente.findUnique({
      where: { id: propositionId },
      include: { annonces_achat: { select: { buyer_id: true } } },
    });
    if (!prop) throw new NotFoundException('Proposition introuvable.');

    const isBuyer = prop.annonces_achat.buyer_id === acteurId;
    const isVendeur = prop.vendeur_id === acteurId;
    if (!isBuyer && !isVendeur) {
      throw new ForbiddenException("Vous n'êtes pas partie à cette négociation.");
    }

    const buyerActions = new Set([
      NegotiationAction.ACCEPTED,
      NegotiationAction.REJECTED,
      NegotiationAction.COUNTER_OFFER,
    ]);
    const vendeurActions = new Set([
      NegotiationAction.CANCELLED,
      NegotiationAction.COUNTER_OFFER,
    ]);
    const allowed = isBuyer ? buyerActions : vendeurActions;
    if (!allowed.has(dto.action)) {
      throw new ForbiddenException(`Action ${dto.action} non autorisée pour votre rôle.`);
    }

    this.assertTransition(prop.status as NegotiationStatus, dto.action);

    if (dto.action === NegotiationAction.COUNTER_OFFER) {
      if (dto.prix_contre_offre === undefined || dto.quantite_kg === undefined) {
        throw new BadRequestException(
          'COUNTER_OFFER requiert prix_contre_offre ET quantite_kg.',
        );
      }
    }

    // Cas particulier : ACCEPTED par le buyer → on crée immédiatement la
    // commande (symétrique de traiterCandidatureAchat). Les autres
    // propositions PENDING sur la même annonce_achat sont marquées
    // REJECTED_BY_RACE. Cf. TODO sur le payin différé dans
    // traiterCandidatureAchat.
    const shouldCreateOrder =
      dto.action === NegotiationAction.ACCEPTED && isBuyer;

    let createdOrderId: string | null = null;
    let orderRef: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      await tx.propositions_vente.update({
        where: { id: propositionId },
        data: {
          status: dto.action,
          updated_at: new Date(),
          ...(dto.action === NegotiationAction.COUNTER_OFFER && {
            quantite_kg: dto.quantite_kg!,
            prix_propose_kg: dto.prix_contre_offre!,
          }),
        },
      });
      await tx.proposition_traitements.create({
        data: {
          proposition_id: propositionId,
          acteur_id: acteurId,
          action: dto.action,
          prix_contre_offre: dto.prix_contre_offre,
          quantite_kg: dto.quantite_kg,
          note: dto.note,
        },
      });

      if (shouldCreateOrder) {
        // Lock l'annonce_achat (FOR UPDATE) — protège contre double
        // acceptation concurrente de 2 propositions sur la même demande.
        const annonceRows = await tx.$queryRaw<
          {
            id: string;
            buyer_id: string;
            is_active: boolean;
            quantite_kg: Prisma.Decimal;
          }[]
        >`SELECT id, buyer_id, is_active, quantite_kg
            FROM annonces_achat
            WHERE id = ${prop.annonce_achat_id}::uuid
            FOR UPDATE`;
        if (annonceRows.length === 0) {
          throw new NotFoundException("Demande d'achat introuvable.");
        }
        const annonceAchat = annonceRows[0];
        if (!annonceAchat.is_active) {
          throw new BadRequestException("La demande d'achat n'est plus active.");
        }

        const qty = new Prisma.Decimal(prop.quantite_kg.toString());
        const prixKg = new Prisma.Decimal(prop.prix_propose_kg.toString());

        const existing = await tx.commandes_vente.findFirst({
          where: { idempotency_key: propositionId },
          select: { id: true, reference: true },
        });
        if (existing) {
          createdOrderId = existing.id;
          orderRef = existing.reference;
        } else {
          const feeRate = new Prisma.Decimal(
            this.config.get<string>('SERVICE_FEE_PRODUCT') ??
              String(DEFAULT_SERVICE_FEE_PRODUCT),
          );
          const productAmount = qty.times(prixKg).toDecimalPlaces(2);
          const productFee = productAmount.times(feeRate).toDecimalPlaces(2);
          const sellerNet = productAmount.minus(productFee);
          const ref = `ORD-${Date.now()}-${randomBytes(2).toString('hex')}`;

          const cmd = await tx.commandes_vente.create({
            data: {
              reference: ref,
              buyer_id: annonceAchat.buyer_id,
              seller_id: prop.vendeur_id,
              // Si la proposition est rattachée à une annonce_vente du
              // vendeur, on la relie pour traçabilité.
              annonce_id: prop.annonce_vente_id ?? null,
              publication_coop_id: prop.publication_coop_id ?? null,
              quantite_kg: qty,
              prix_unitaire_kg: prixKg,
              montant_total: productAmount,
              frais_service: productFee,
              montant_net: sellerNet,
              status: order_status.SENT,
              idempotency_key: propositionId,
              notes: "Issue d'une proposition acceptée",
            },
          });
          createdOrderId = cmd.id;
          orderRef = cmd.reference;
        }

        await tx.propositions_vente.updateMany({
          where: {
            annonce_achat_id: prop.annonce_achat_id,
            id: { not: propositionId },
            status: {
              in: [NegotiationStatus.PENDING, NegotiationStatus.COUNTER_OFFER],
            },
          },
          data: { status: 'REJECTED_BY_RACE', updated_at: new Date() },
        });
      }
    });

    const recipientId = isBuyer ? prop.vendeur_id : prop.annonces_achat.buyer_id;
    const labels: Record<NegotiationAction, { titre: string; body: string }> = {
      ACCEPTED:      { titre: '✅ Proposition acceptée', body: 'Votre proposition vient d\'être acceptée.' },
      REJECTED:      { titre: '❌ Proposition refusée',  body: 'Votre proposition a été refusée.' },
      COUNTER_OFFER: { titre: '🔄 Contre-offre reçue',   body: `Nouvelle contre-proposition : ${dto.quantite_kg} kg à ${dto.prix_contre_offre} FCFA/kg.` },
      CANCELLED:     { titre: '🚫 Proposition annulée',  body: 'Le vendeur a annulé sa proposition.' },
    };

    // Si ACCEPTED par le buyer → message enrichi pour le vendeur.
    if (shouldCreateOrder && createdOrderId) {
      labels.ACCEPTED = {
        titre: '✅ Votre proposition a été acceptée',
        body: `Commande ${orderRef ?? ''} créée. L'acheteur va procéder au paiement.`,
      };
    }

    const { titre, body } = labels[dto.action];
    const notifData: Record<string, string> = {
      proposition_id: propositionId,
    };
    if (createdOrderId) notifData.commande_id = createdOrderId;
    this.notifyNegotiation(recipientId, titre, body, notifData);

    const response: Record<string, unknown> = {
      message: `Proposition marquée comme ${dto.action}.`,
    };
    if (createdOrderId) {
      response.commande_id = createdOrderId;
      response.reference = orderRef;
    }
    return response;
  }

  async listerPropositions(userId: string, query: ListerNegotiationsQueryDto) {
    const direction = query.direction ?? NegotiationDirection.OUTGOING;
    const where: Prisma.propositions_venteWhereInput = {
      ...(query.status && { status: query.status }),
      ...(direction === NegotiationDirection.OUTGOING
        ? { vendeur_id: userId }
        : { annonces_achat: { buyer_id: userId } }),
    };
    return this.prisma.propositions_vente.findMany({
      where,
      include: {
        annonces_achat: { select: { quantite_kg: true, prix_max_kg: true } },
        proposition_traitements: { orderBy: { created_at: 'desc' }, take: 10 },
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  // ===================================================================
  //  CONTRE-OFFRE  (BUYER → COOPERATIVE)
  // ===================================================================

  async createContreOffreCoop(acheteurId: string, dto: CreateContreOffreCoopDto) {
    const publication = await this.prisma.publications_stock_coop.findUnique({
      where: { id: dto.publication_id },
      select: {
        id: true,
        cooperative_id: true,
        is_active: true,
        quantite_kg: true,
      },
    });
    if (!publication) throw new NotFoundException('Publication coop introuvable.');
    if (!publication.is_active) {
      throw new BadRequestException("La publication n'est plus active.");
    }
    if (dto.quantite_kg > publication.quantite_kg.toNumber()) {
      throw new BadRequestException(
        `Quantité supérieure au stock (${publication.quantite_kg}kg).`,
      );
    }

    const enCours = await this.prisma.contre_offres_coop.findFirst({
      where: {
        publication_id: dto.publication_id,
        acheteur_id: acheteurId,
        status: { in: [NegotiationStatus.PENDING, NegotiationStatus.COUNTER_OFFER] },
      },
      select: { id: true },
    });
    if (enCours) {
      throw new ConflictException(
        'Vous avez déjà une contre-offre en cours sur cette publication.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const co = await tx.contre_offres_coop.create({
        data: {
          publication_id: dto.publication_id,
          acheteur_id: acheteurId,
          // cooperative_id déduit de la publication, jamais du body.
          cooperative_id: publication.cooperative_id,
          prix_propose_kg: dto.prix_propose_kg,
          quantite_kg: dto.quantite_kg,
          message: dto.message,
          status: NegotiationStatus.PENDING,
        },
      });
      await tx.contre_offre_coop_traitements.create({
        data: {
          contre_offre_id: co.id,
          acteur_id: acheteurId,
          action: 'CREATED',
          prix_contre_offre: dto.prix_propose_kg,
          quantite_kg: dto.quantite_kg,
          note: dto.message,
        },
      });
      return co;
    });

    // Notif au user_id de la coopérative (le compte COOPERATIVE en propre).
    const coopProfile = await this.prisma.cooperative_profiles.findUnique({
      where: { id: publication.cooperative_id },
      select: { user_id: true },
    });
    if (coopProfile) {
      this.notifyNegotiation(
        coopProfile.user_id,
        'Nouvelle contre-offre 📩',
        `Un acheteur propose ${dto.quantite_kg} kg à ${dto.prix_propose_kg} FCFA/kg.`,
        { contre_offre_id: result.id, publication_id: dto.publication_id },
      );
    }

    return { message: 'Contre-offre envoyée à la coopérative.', id: result.id };
  }

  /**
   * Traite une contre-offre coop. Autorisations :
   *   • L'acheteur (acheteur_id) peut : CANCELLED, COUNTER_OFFER
   *   • La COOPÉRATIVE — i.e. user dont user.cooperative_id ==
   *     contre_offres_coop.cooperative_id — peut :
   *     ACCEPTED, REJECTED, COUNTER_OFFER
   */
  async traiterContreOffreCoop(
    acteurId: string,
    acteurCoopId: string | null,
    contreOffreId: string,
    dto: TraiterOffreDto,
  ) {
    const co = await this.prisma.contre_offres_coop.findUnique({
      where: { id: contreOffreId },
    });
    if (!co) throw new NotFoundException('Contre-offre introuvable.');

    const isAcheteur = co.acheteur_id === acteurId;
    const isCoop = acteurCoopId !== null && co.cooperative_id === acteurCoopId;
    if (!isAcheteur && !isCoop) {
      throw new ForbiddenException("Vous n'êtes pas partie à cette négociation.");
    }

    const coopActions = new Set([
      NegotiationAction.ACCEPTED,
      NegotiationAction.REJECTED,
      NegotiationAction.COUNTER_OFFER,
    ]);
    const acheteurActions = new Set([
      NegotiationAction.CANCELLED,
      NegotiationAction.COUNTER_OFFER,
    ]);
    const allowed = isCoop ? coopActions : acheteurActions;
    if (!allowed.has(dto.action)) {
      throw new ForbiddenException(`Action ${dto.action} non autorisée pour votre rôle.`);
    }

    this.assertTransition(co.status as NegotiationStatus, dto.action);

    if (dto.action === NegotiationAction.COUNTER_OFFER) {
      if (dto.prix_contre_offre === undefined || dto.quantite_kg === undefined) {
        throw new BadRequestException(
          'COUNTER_OFFER requiert prix_contre_offre ET quantite_kg.',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.contre_offres_coop.update({
        where: { id: contreOffreId },
        data: {
          status: dto.action,
          updated_at: new Date(),
          ...(dto.action === NegotiationAction.COUNTER_OFFER && {
            quantite_kg: dto.quantite_kg!,
            prix_propose_kg: dto.prix_contre_offre!,
          }),
        },
      });
      await tx.contre_offre_coop_traitements.create({
        data: {
          contre_offre_id: contreOffreId,
          acteur_id: acteurId,
          action: dto.action,
          prix_contre_offre: dto.prix_contre_offre,
          quantite_kg: dto.quantite_kg,
          note: dto.note,
        },
      });
    });

    // Si c'est la coop qui a agi → notif au buyer. Si c'est le buyer → notif au compte de la coop.
    let recipientId: string;
    if (isCoop) {
      recipientId = co.acheteur_id;
    } else {
      const coopProfile = await this.prisma.cooperative_profiles.findUnique({
        where: { id: co.cooperative_id },
        select: { user_id: true },
      });
      recipientId = coopProfile?.user_id ?? '';
    }
    if (recipientId) {
      const labels: Record<NegotiationAction, { titre: string; body: string }> = {
        ACCEPTED:      { titre: '✅ Contre-offre acceptée', body: 'Votre contre-offre vient d\'être acceptée.' },
        REJECTED:      { titre: '❌ Contre-offre refusée',  body: 'Votre contre-offre a été refusée.' },
        COUNTER_OFFER: { titre: '🔄 Nouvelle contre-offre', body: `Nouvelle proposition : ${dto.quantite_kg} kg à ${dto.prix_contre_offre} FCFA/kg.` },
        CANCELLED:     { titre: '🚫 Contre-offre annulée',  body: 'L\'autre partie a annulé sa contre-offre.' },
      };
      const { titre, body } = labels[dto.action];
      this.notifyNegotiation(recipientId, titre, body, { contre_offre_id: contreOffreId });
    }

    return { message: `Contre-offre marquée comme ${dto.action}.` };
  }

  async listerContreOffres(
    userId: string,
    coopId: string | null,
    query: ListerNegotiationsQueryDto,
  ) {
    const direction = query.direction ?? NegotiationDirection.OUTGOING;
    const where: Prisma.contre_offres_coopWhereInput = {
      ...(query.status && { status: query.status }),
      ...(direction === NegotiationDirection.OUTGOING
        ? { acheteur_id: userId }
        : coopId
          ? { cooperative_id: coopId }
          : { id: '__never__' }), // si pas de coop → aucun résultat
    };
    return this.prisma.contre_offres_coop.findMany({
      where,
      include: {
        publications_stock_coop: { select: { produit_id: true } },
        contre_offre_coop_traitements: {
          orderBy: { created_at: 'desc' },
          take: 10,
        },
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  // ===================================================================
  //  CHAT LIBRE ATTACHÉ À UNE NÉGOCIATION
  // ---------------------------------------------------------------------
  //  Trois "scopes" : candidature / proposition / contre-offre coop.
  //  Une seule table polymorphique → 1 méthode send + 1 méthode list,
  //  paramétrées par le scope. Les permissions sont vérifiées en
  //  trouvant les 2 parties autorisées, puis en checkant que l'acteur
  //  fait partie de cette paire.
  // ===================================================================

  /**
   * Retourne les 2 IDs autorisés (acteur_a, acteur_b) pour une négo.
   * Le 2e peut être un user_id de coopérative (compte COOPERATIVE)
   * — résolu via le cooperative_profiles.user_id.
   */
  private async getNegotiationParties(scope: {
    candidature_id?: string;
    proposition_id?: string;
    contre_offre_coop_id?: string;
  }): Promise<[string, string]> {
    if (scope.candidature_id) {
      const c = await this.prisma.candidatures_achat.findUnique({
        where: { id: scope.candidature_id },
        include: { annonces_vente: { select: { farmer_id: true } } },
      });
      if (!c) throw new NotFoundException('Candidature introuvable.');
      return [c.buyer_id, c.annonces_vente.farmer_id];
    }
    if (scope.proposition_id) {
      const p = await this.prisma.propositions_vente.findUnique({
        where: { id: scope.proposition_id },
        include: { annonces_achat: { select: { buyer_id: true } } },
      });
      if (!p) throw new NotFoundException('Proposition introuvable.');
      return [p.vendeur_id, p.annonces_achat.buyer_id];
    }
    if (scope.contre_offre_coop_id) {
      const co = await this.prisma.contre_offres_coop.findUnique({
        where: { id: scope.contre_offre_coop_id },
      });
      if (!co) throw new NotFoundException('Contre-offre introuvable.');
      const coopProfile = await this.prisma.cooperative_profiles.findUnique({
        where: { id: co.cooperative_id },
        select: { user_id: true },
      });
      return [co.acheteur_id, coopProfile?.user_id ?? ''];
    }
    throw new BadRequestException('Scope manquant.');
  }

  /**
   * Envoie un message dans le fil de négociation. Vérifie que l'acteur
   * est bien l'une des 2 parties autorisées. Notifie l'autre partie.
   */
  async sendNegotiationMessage(
    senderId: string,
    scope: {
      candidature_id?: string;
      proposition_id?: string;
      contre_offre_coop_id?: string;
    },
    content: string,
  ) {
    const [a, b] = await this.getNegotiationParties(scope);
    if (senderId !== a && senderId !== b) {
      throw new ForbiddenException('Vous n\'êtes pas partie à cette négociation.');
    }

    const msg = await this.prisma.negotiation_messages.create({
      data: {
        candidature_id: scope.candidature_id,
        proposition_id: scope.proposition_id,
        contre_offre_coop_id: scope.contre_offre_coop_id,
        sender_id: senderId,
        content,
      },
    });

    // Notif à l'autre partie. Body tronqué à 100 char (preview).
    const recipientId = senderId === a ? b : a;
    if (recipientId) {
      const preview = content.length > 100 ? content.slice(0, 97) + '…' : content;
      this.notifyNegotiation(
        recipientId,
        '💬 Nouveau message',
        preview,
        {
          ...(scope.candidature_id && { candidature_id: scope.candidature_id }),
          ...(scope.proposition_id && { proposition_id: scope.proposition_id }),
          ...(scope.contre_offre_coop_id && {
            contre_offre_id: scope.contre_offre_coop_id,
          }),
          message_id: msg.id,
        },
      );
    }

    return msg;
  }

  /**
   * Liste les messages d'une négociation. Permission identique au send :
   * seules les 2 parties peuvent voir le fil.
   */
  async listNegotiationMessages(
    userId: string,
    scope: {
      candidature_id?: string;
      proposition_id?: string;
      contre_offre_coop_id?: string;
    },
  ) {
    const [a, b] = await this.getNegotiationParties(scope);
    if (userId !== a && userId !== b) {
      throw new ForbiddenException('Vous n\'êtes pas partie à cette négociation.');
    }

    return this.prisma.negotiation_messages.findMany({
      where: {
        ...(scope.candidature_id && { candidature_id: scope.candidature_id }),
        ...(scope.proposition_id && { proposition_id: scope.proposition_id }),
        ...(scope.contre_offre_coop_id && {
          contre_offre_coop_id: scope.contre_offre_coop_id,
        }),
      },
      include: {
        users: { select: { id: true, full_name: true } },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  // ===================================================================
  //  HELPERS PRIVÉS
  // ===================================================================

  /**
   * State machine : refuse les transitions invalides (ex. accepter
   * une candidature déjà ACCEPTED ou CANCELLED).
   */
  private assertTransition(
    current: NegotiationStatus,
    action: NegotiationAction,
  ): void {
    const next = action as unknown as NegotiationStatus;
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(
        `Transition impossible : ${current} → ${next}.`,
      );
    }
  }
}
