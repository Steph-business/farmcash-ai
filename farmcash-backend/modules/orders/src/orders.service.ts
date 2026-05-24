// =====================================================================
//  SERVICE : OrdersService
//  ---------------------------------------------------------------------
//  Cycle de vie d'une commande :
//
//      ┌──── 4 sources possibles ────┐
//      │ • DIRECT_ANNONCE_VENTE      │  (achat direct sur annonce)
//      │ • CANDIDATURE_ACCEPTED      │  (offre buyer acceptée par seller)
//      │ • PROPOSITION_ACCEPTED      │  (proposition seller acceptée par buyer)
//      │ • RESERVATION_CONFIRMED     │  (acompte 20% sur prévision)
//      │ • CONTRE_OFFRE_ACCEPTED     │  (contre-offre coop acceptée)
//      └─────────────────────────────┘
//                       │
//                       ▼
//      ┌──────────────────────────────┐
//      │ createOrder  (transaction)   │
//      │  1. Vérifie la "preuve"      │
//      │  2. Lit prix/qty serveur     │
//      │  3. Crée la commande SENT    │
//      │  4. Lance le payin           │
//      │  5. Sur succès payin :       │
//      │     - status → ACCEPTED      │
//      │     - escrow_conditions OK   │
//      └──────────────────────────────┘
//                       │
//      SENT → ACCEPTED → IN_PROGRESS → DELIVERED → COMPLETED
//                ↓                          ↓           ↑
//             CANCELLED                 DISPUTED      releaseEscrow
//
//  Toute transition de statut est gouvernée par une state machine
//  (ALLOWED_TRANSITIONS) et par une matrice rôle → actions autorisées.
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
import {
  mobile_provider,
  order_status,
  Prisma,
  product_status,
} from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { FinanceService } from '@farmcash/finance';
import { NotificationsService, NotificationType } from '@farmcash/notifications';
import {
  CreateOrderDto,
  ListerOrdersQueryDto,
  OpenDisputeDto,
  OrderSourceType,
  OrderStatus,
  PayOrderDto,
  ResolveDisputeDto,
  UpdateOrderStatusDto,
} from './dto/orders.dto';

/**
 * State machine des statuts de commande.
 * Chaque clé = état actuel. Valeur = transitions autorisées.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.SENT]: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS]: [OrderStatus.DELIVERED, OrderStatus.DISPUTED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.DISPUTED],
  // États terminaux
  [OrderStatus.REJECTED]: [],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED], // résolution
};

/** Matrice acteur autorisé pour chaque transition. */
const TRANSITION_ACTOR: Record<OrderStatus, 'buyer' | 'seller' | 'both'> = {
  [OrderStatus.ACCEPTED]: 'seller', // c'est confirmé par le système après payin, mais aussi possible manuellement par seller
  [OrderStatus.REJECTED]: 'seller',
  [OrderStatus.IN_PROGRESS]: 'seller',
  [OrderStatus.DELIVERED]: 'seller',
  [OrderStatus.COMPLETED]: 'buyer', // le buyer confirme la réception
  [OrderStatus.DISPUTED]: 'both',
  [OrderStatus.CANCELLED]: 'both',
  [OrderStatus.SENT]: 'both', // état initial, jamais en transition cible
};

// Constantes par défaut si non définies dans .env. La source de vérité reste
// la config (cf. SERVICE_FEE_PRODUCT, SERVICE_FEE_TRANSPORT, PREVISION_DOWNPAYMENT_RATE).
const DEFAULT_SERVICE_FEE_PRODUCT = 0.03;
const DEFAULT_SERVICE_FEE_TRANSPORT = 0.03;
const DEFAULT_PREVISION_DOWNPAYMENT = 0.20;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ===================================================================
  //  CRÉATION DE COMMANDE
  // ===================================================================

  async createOrder(buyerId: string, dto: CreateOrderDto, idempotencyKey?: string) {
    // 0. Idempotency : si la même clé arrive 2x, renvoyer la commande existante.
    if (idempotencyKey) {
      const existing = await this.prisma.commandes_vente.findFirst({
        where: { buyer_id: buyerId, idempotency_key: idempotencyKey },
      });
      if (existing) {
        this.logger.log(
          `Idempotency hit ${idempotencyKey} → commande existante ${existing.id}`,
        );
        return existing;
      }
    }

    // 1. Résolution source (lue depuis DB, anti-tamper).
    const reference = await this.resolveOrderSource(buyerId, dto);
    if (reference.sellerId === buyerId) {
      throw new BadRequestException("Vous ne pouvez pas acheter à vous-même.");
    }

    // 1.bis Anti-doublons côté buyer : un même buyer ne peut pas avoir
    // 2 commandes ACTIVES (SENT/ACCEPTED/IN_PROGRESS) sur la même
    // annonce. Évite les re-clics, les double-tap, et les confusions
    // type "j'ai pas vu que c'était passé, je clique encore". La colonne
    // côté DB s'appelle `annonce_id` (pas `annonce_vente_id`).
    if (dto.annonce_vente_id) {
      const existingActive = await this.prisma.commandes_vente.findFirst({
        where: {
          buyer_id: buyerId,
          annonce_id: dto.annonce_vente_id,
          status: {
            in: [
              order_status.SENT,
              order_status.ACCEPTED,
              order_status.IN_PROGRESS,
            ],
          },
        },
        select: { id: true, status: true },
      });
      if (existingActive) {
        throw new ConflictException(
          `Tu as déjà une commande en cours sur cette annonce (#${existingActive.id.substring(0, 8)}). Consulte-la avant d'en créer une autre.`,
        );
      }
    }

    // Taux en Decimal pour zéro perte d'arrondi.
    const feeProduct = new Prisma.Decimal(
      this.config.get<string>('SERVICE_FEE_PRODUCT') ?? String(DEFAULT_SERVICE_FEE_PRODUCT),
    );
    const feeTransport = new Prisma.Decimal(
      this.config.get<string>('SERVICE_FEE_TRANSPORT') ?? String(DEFAULT_SERVICE_FEE_TRANSPORT),
    );
    const previsionDownpayment = new Prisma.Decimal(
      this.config.get<string>('PREVISION_DOWNPAYMENT_RATE') ?? String(DEFAULT_PREVISION_DOWNPAYMENT),
    );

    // 2. Calculs produit en Decimal.
    const isReservation = dto.source_type === OrderSourceType.RESERVATION_CONFIRMED;
    const qty = new Prisma.Decimal(dto.quantite_kg);
    const prixKg = new Prisma.Decimal(reference.prixUnitaireKg);
    const grossAmount = qty.times(prixKg);
    // Pour les réservations, l'acompte 10% est déjà payé : on calcule
    // donc le solde restant à débiter (90% par défaut). Le total reste
    // 100% pour les autres sources.
    let depositAlreadyPaid = new Prisma.Decimal(0);
    if (isReservation && dto.reservation_id) {
      const r = await this.prisma.reservations_previsions.findUnique({
        where: { id: dto.reservation_id },
        select: { deposit_amount: true },
      });
      if (r) depositAlreadyPaid = new Prisma.Decimal(r.deposit_amount.toString());
    }
    const productAmount = grossAmount;
    const productFee = productAmount.times(feeProduct).toDecimalPlaces(2);

    // 3. Transport (Decimal aussi).
    let transportAmount = new Prisma.Decimal(0);
    let transportFee = new Prisma.Decimal(0);
    let route: {
      id: string;
      origin_zone: string;
      destination_zone: string;
    } | null = null;
    if (dto.transporter_route_id) {
      const r = await this.prisma.transporter_routes.findFirst({
        where: { id: dto.transporter_route_id, is_active: true },
      });
      if (!r) throw new NotFoundException('Route transporteur introuvable.');
      if (dto.quantite_kg > r.capacite_max_kg.toNumber()) {
        throw new BadRequestException('Quantité supérieure à la capacité de la route.');
      }
      const calc = new Prisma.Decimal(r.tarif_kg.toString()).times(qty);
      const min = new Prisma.Decimal(r.tarif_minimum.toString());
      transportAmount = calc.greaterThan(min) ? calc : min;
      transportFee = transportAmount.times(feeTransport).toDecimalPlaces(2);
      route = {
        id: r.id,
        origin_zone: r.origin_zone,
        destination_zone: r.destination_zone,
      };
      if (!dto.delivery_address) {
        throw new BadRequestException(
          'delivery_address requis quand un transporter_route_id est fourni.',
        );
      }
    }

    const totalAmount = productAmount.plus(transportAmount);
    const totalFee = productFee.plus(transportFee);
    const sellerNet = productAmount.minus(productFee);

    // 4. Moyen de paiement validé.
    const paymentMethod = await this.resolvePaymentMethod(buyerId, dto.payment_method_id);

    // 5. Référence unique crypto-secure.
    const orderRef = `ORD-${Date.now()}-${randomBytes(2).toString('hex')}`;

    // 6. TRANSACTION GLOBALE : check rapide du stock + création commande.
    //    /!\ PAS de décrément ici. Le décrément ne survient que lorsque
    //    le paiement est confirmé (cf. finance.confirmPayment + lock
    //    SELECT FOR UPDATE sur la source). Conséquence : 2 buyers peuvent
    //    créer 2 orders sur le même stock ; seul le premier dont le
    //    paiement aboutit obtient effectivement la marchandise.
    const order = await this.prisma.$transaction(async (tx) => {
      // 6a. Check rapide (anti-fail-fast) : stock affiché >= qté.
      //     Pas de FOR UPDATE car on ne modifie pas — c'est juste pour
      //     éviter de créer des commandes manifestement non-honorables.
      if (reference.annonceVenteId) {
        const a = await tx.annonces_vente.findUnique({
          where: { id: reference.annonceVenteId },
          select: { quantite_kg: true, status: true },
        });
        if (!a) throw new NotFoundException('Annonce introuvable.');
        if (a.status !== product_status.ACTIVE) {
          throw new BadRequestException("L'annonce n'est pas active.");
        }
        if (qty.greaterThan(new Prisma.Decimal(a.quantite_kg.toString()))) {
          throw new BadRequestException(
            `Stock insuffisant (${a.quantite_kg} kg dispo, ${qty} demandé).`,
          );
        }
      }
      if (reference.publicationCoopId) {
        const p = await tx.publications_stock_coop.findUnique({
          where: { id: reference.publicationCoopId },
          select: { quantite_kg: true, is_active: true },
        });
        if (!p) throw new NotFoundException('Publication coop introuvable.');
        if (!p.is_active) {
          throw new BadRequestException("La publication n'est plus active.");
        }
        if (qty.greaterThan(new Prisma.Decimal(p.quantite_kg.toString()))) {
          throw new BadRequestException(
            `Stock coop insuffisant (${p.quantite_kg} kg dispo, ${qty} demandé).`,
          );
        }
      }

      // 6c. Crée la commande
      const cmd = await tx.commandes_vente.create({
        data: {
          reference: orderRef,
          buyer_id: buyerId,
          seller_id: reference.sellerId,
          annonce_id: reference.annonceVenteId ?? null,
          publication_coop_id: reference.publicationCoopId ?? null,
          lot_id: reference.lotId ?? null,
          quantite_kg: dto.quantite_kg,
          prix_unitaire_kg: reference.prixUnitaireKg,
          montant_total: totalAmount,
          frais_service: totalFee,
          montant_net: sellerNet,
          payment_provider: paymentMethod.provider,
          delivery_address: dto.delivery_address,
          notes: dto.notes,
          status: order_status.SENT,
          idempotency_key: idempotencyKey ?? null,
          // Si commande issue d'une réservation, on stocke le lien pour
          // que confirmPayment ne décrémente PAS l'annonce (le stock a
          // déjà été réservé à la conversion).
          from_reservation_id: reference.fromReservationId ?? null,
        },
      });

      // 6d. Crée le shipment si route choisie
      if (route) {
        await tx.shipments.create({
          data: {
            commande_id: cmd.id,
            origin_zone: route.origin_zone,
            destination_zone: route.destination_zone,
            pickup_address: dto.pickup_address ?? `Origine: ${route.origin_zone}`,
            delivery_address: dto.delivery_address!,
            quantite_kg: dto.quantite_kg,
            prix_devis: transportAmount,
            prix_final: transportAmount,
            status: 'REQUESTED',
          },
        });
      }

      return cmd;
    });

    this.logger.log(
      `Order ${orderRef} buyer=${buyerId} seller=${reference.sellerId} prod=${productAmount} trans=${transportAmount}`,
    );

    // 7. Déclenche le payin. Si la commande vient d'une réservation,
    //    le payin ne débite QUE le solde 90% (l'acompte 10% est déjà
    //    bloqué en escrow). Si KO → cancel + restore stock + refund.
    try {
      await this.finance.processPayin(buyerId, {
        commande_id: order.id,
        buyer_id: buyerId,
        payment_method_id: paymentMethod.id,
        from_reservation_id: isReservation ? dto.reservation_id : undefined,
      });

      // Marque la réservation COMPLETED + lie au final order.
      if (isReservation && dto.reservation_id) {
        await this.finance.consumeReservationDeposit(
          dto.reservation_id,
          order.id,
        );
      }
    } catch (err) {
      this.logger.error(
        `Payin failed for order ${order.id}: ${(err as Error).message}`,
      );
      // Compensation : annule la commande + restore le stock.
      await this.cancelOrderCompensation(order.id, 'PAYIN_FAILED');
      await this.safeNotify(buyerId, {
        type: NotificationType.SYSTEM,
        titre: 'Échec du paiement',
        body: `La commande ${orderRef} a été annulée — paiement refusé.`,
        commande_id: order.id,
      });
      throw err;
    }

    await this.safeNotify(reference.sellerId, {
      type: NotificationType.SYSTEM,
      titre: 'Nouvelle commande 📦',
      body: `Commande ${orderRef} reçue pour ${dto.quantite_kg}kg.`,
      commande_id: order.id,
    });

    return order;
  }

  // ===================================================================
  //  PAIEMENT D'UNE COMMANDE EXISTANTE  (Chantier 4)
  //  ---------------------------------------------------------------------
  //  Avec la négociation atomique (cf. CandidaturesService), une commande
  //  peut être créée en SENT sans déclenchement immédiat du payin (le
  //  buyer doit confirmer le paiement). Cette méthode comble ce gap :
  //   • Vérifie ownership (buyer_id).
  //   • Vérifie status = SENT (pas déjà payée/annulée).
  //   • Vérifie qu'aucun escrow LOCKED n'existe (anti-double-paiement).
  //   • Délègue à finance.processPayin (réutilise le path existant).
  // ===================================================================

  async payOrder(
    buyerId: string,
    orderId: string,
    dto: PayOrderDto,
    idempotencyKey?: string,
  ) {
    const order = await this.prisma.commandes_vente.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.buyer_id !== buyerId) {
      throw new ForbiddenException('Cette commande ne vous appartient pas.');
    }
    if (order.status !== order_status.SENT) {
      throw new BadRequestException(
        `Commande au statut ${order.status} : paiement impossible (SENT requis).`,
      );
    }

    // Anti-double-paiement : si un escrow LOCKED existe déjà sur cette
    // commande, c'est qu'un payin a abouti — refuser un 2e tour. Le
    // status SENT seul ne suffit pas (race : payin a confirmé l'escrow
    // mais la transition SENT→ACCEPTED a échoué — peu probable mais
    // possible, on ferme la porte).
    const existingEscrow = await this.prisma.escrow_conditions.findFirst({
      where: { commande_id: orderId, status: 'LOCKED' },
      select: { id: true },
    });
    if (existingEscrow) {
      throw new ConflictException(
        'Cette commande a déjà été payée (escrow LOCKED).',
      );
    }

    const paymentMethod = await this.resolvePaymentMethod(
      buyerId,
      dto.payment_method_id,
    );

    // Idempotency-Key transport-level : si la TX a déjà été créée avec
    // cette clé, processPayin lèvera son propre check via le UNIQUE
    // INDEX sur transactions.idempotency_key. On loggue le ref pour
    // que l'observabilité puisse corréler.
    if (idempotencyKey) {
      this.logger.log(
        `payOrder idempotency-key=${idempotencyKey} order=${orderId}`,
      );
    }

    try {
      await this.finance.processPayin(buyerId, {
        commande_id: orderId,
        buyer_id: buyerId,
        payment_method_id: paymentMethod.id,
        from_reservation_id: order.from_reservation_id ?? undefined,
      });
    } catch (err) {
      this.logger.error(
        `payOrder: payin failed order=${orderId}: ${(err as Error).message}`,
      );
      // Pas de cancel automatique ici : la commande reste SENT, le buyer
      // peut retenter avec un autre moyen de paiement. Le cleanup cron
      // (cleanupOrphanOrders) finira par l'annuler si elle reste SENT
      // > 24h. Si on cancellait à chaque échec, le buyer ne pourrait
      // plus retry après un timeout réseau.
      throw err;
    }

    return {
      message: 'Paiement confirmé.',
      commande_id: orderId,
      reference: order.reference,
    };
  }

  /**
   * Annule une commande en compensation (rollback applicatif après échec
   * de paiement). Si le paiement a été confirmé (status ACCEPTED+), le
   * stock a été décrémenté → on le restore et on rembourse le buyer.
   * Si la commande était encore en SENT (paiement jamais passé), pas de
   * stock ni d'argent à restituer.
   * Idempotent : si déjà annulée, ne fait rien.
   */
  private async cancelOrderCompensation(
    orderId: string,
    reason: string,
  ): Promise<void> {
    // Lock + détermination de l'état de la commande
    const orderInfo = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          status: string;
          quantite_kg: Prisma.Decimal;
          annonce_id: string | null;
          publication_coop_id: string | null;
        }[]
      >`SELECT id, status, quantite_kg, annonce_id, publication_coop_id
          FROM commandes_vente
          WHERE id = ${orderId}::uuid
          FOR UPDATE`;
      if (rows.length === 0) return null;
      const order = rows[0];
      if (order.status === 'CANCELLED' || order.status === 'COMPLETED') {
        return null; // déjà terminée
      }

      const wasPaid =
        order.status === 'ACCEPTED' ||
        order.status === 'IN_PROGRESS' ||
        order.status === 'DELIVERED';

      // Si le stock avait été décrémenté (paiement confirmé) → restore.
      if (wasPaid) {
        await this.restoreStockInTx(tx, orderId);
      }

      await tx.commandes_vente.update({
        where: { id: orderId },
        data: {
          status: order_status.CANCELLED,
          cancelled_at: new Date(),
          cancelled_reason: reason,
        },
      });

      return { ...order, wasPaid };
    });

    // Refund hors transaction (finance a sa propre TX + locks)
    if (orderInfo?.wasPaid) {
      try {
        await this.finance.refundBuyer(orderId, undefined, `CANCEL_${reason}`);
      } catch (e: any) {
        this.logger.error(
          `Refund échoué pour ${orderId} après cancel : ${e?.message}`,
        );
      }
    }

    this.logger.log(`Compensation: order ${orderId} CANCELLED (${reason})`);
  }

  // ===================================================================
  //  LECTURE
  // ===================================================================

  async getMyOrders(userId: string, query: ListerOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const sideFilter: Prisma.commandes_venteWhereInput = !query.side
      ? { OR: [{ buyer_id: userId }, { seller_id: userId }] }
      : query.side === 'buyer'
        ? { buyer_id: userId }
        : { seller_id: userId };

    const where: Prisma.commandes_venteWhereInput = {
      ...sideFilter,
      ...(query.status && { status: query.status as order_status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.commandes_vente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          annonces_vente: { include: { produits_agricoles: { select: { nom: true } } } },
          publications_stock_coop: { select: { produit_id: true, prix_par_kg: true } },
          users_commandes_vente_buyer_idTousers: {
            select: { full_name: true, photo_url: true },
          },
          users_commandes_vente_seller_idTousers: {
            select: { full_name: true, photo_url: true },
          },
        },
      }),
      this.prisma.commandes_vente.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Détail d'une commande. Lève 404 si introuvable, 403 si l'user n'est
   * ni buyer ni seller (on évite de leak l'existence à un tiers).
   */
  async getOrderById(userId: string, orderId: string) {
    const order = await this.prisma.commandes_vente.findUnique({
      where: { id: orderId },
      include: {
        annonces_vente: { include: { produits_agricoles: true } },
        publications_stock_coop: true,
        shipments: true,
        transactions: true,
        escrow_conditions: true,
        disputes: true,
        // Joins user pour avoir nom + photo de l'acheteur et du vendeur
        // côté UI sans n+1 query mobile.
        users_commandes_vente_buyer_idTousers: {
          select: { id: true, full_name: true, photo_url: true },
        },
        users_commandes_vente_seller_idTousers: {
          select: { id: true, full_name: true, photo_url: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');

    if (order.buyer_id !== userId && order.seller_id !== userId) {
      throw new ForbiddenException("Vous n'êtes pas partie à cette commande.");
    }
    return order;
  }

  // ===================================================================
  //  TRANSITIONS DE STATUT
  // ===================================================================

  async updateStatus(userId: string, orderId: string, dto: UpdateOrderStatusDto) {
    // Transaction avec SELECT FOR UPDATE : lit l'état frais + bloque les
    // updates concurrents jusqu'au commit. Élimine la race condition où
    // 2 acteurs (buyer + seller) appellent updateStatus en parallèle.
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          buyer_id: string;
          seller_id: string;
          status: string;
          reference: string;
        }[]
      >`SELECT id, buyer_id, seller_id, status, reference
          FROM commandes_vente
          WHERE id = ${orderId}::uuid
          FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('Commande introuvable.');
      const order = rows[0];

      const isBuyer = order.buyer_id === userId;
      const isSeller = order.seller_id === userId;
      if (!isBuyer && !isSeller) {
        throw new ForbiddenException("Vous n'êtes pas partie à cette commande.");
      }

      const current = order.status as unknown as OrderStatus;
      this.assertTransition(current, dto.status);
      this.assertActor(dto.status, isBuyer ? 'buyer' : 'seller');

      const updated = await tx.commandes_vente.update({
        where: { id: orderId },
        data: {
          status: dto.status as order_status,
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.status === OrderStatus.CANCELLED && {
            cancelled_at: new Date(),
            cancelled_reason: 'USER_CANCEL',
          }),
          updated_at: new Date(),
        },
      });

      // Si transition CANCELLED depuis un état où le paiement avait été
      // confirmé (donc stock décrémenté) → restore stock.
      // Si SENT (pas encore payé) → rien à restaurer.
      const wasPaid =
        current === OrderStatus.ACCEPTED ||
        current === OrderStatus.IN_PROGRESS ||
        current === OrderStatus.DELIVERED;
      if (dto.status === OrderStatus.CANCELLED && wasPaid) {
        await this.restoreStockInTx(tx, orderId);
      }

      return { updated, order, current, isBuyer, wasPaid };
    });

    // Refund hors transaction si paiement confirmé et CANCEL
    if (dto.status === OrderStatus.CANCELLED && result.wasPaid) {
      try {
        await this.finance.refundBuyer(orderId, userId, 'USER_CANCEL');
      } catch (e: any) {
        this.logger.error(
          `Refund échoué pour ${orderId} après cancel manuel : ${e?.message}`,
        );
      }
    }

    // Effet de bord hors transaction : libération escrow.
    // (releaseEscrow a sa propre TX et son propre locking.)
    if (
      result.current === OrderStatus.DELIVERED &&
      dto.status === OrderStatus.COMPLETED
    ) {
      await this.finance.releaseEscrow(orderId, userId);
    }

    const recipientId = result.isBuyer
      ? result.order.seller_id
      : result.order.buyer_id;
    await this.safeNotify(recipientId, {
      type: NotificationType.SYSTEM,
      titre: `Commande ${result.order.reference} : ${dto.status}`,
      body: `Statut mis à jour : ${dto.status}.`,
      commande_id: result.order.id,
    });

    return result.updated;
  }

  /**
   * Restore le stock source d'une commande (annonce ou publication coop).
   * Appelée dans la même TX que la transition CANCELLED.
   */
  private async restoreStockInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const cmd = await tx.commandes_vente.findUnique({
      where: { id: orderId },
      select: {
        quantite_kg: true,
        annonce_id: true,
        publication_coop_id: true,
      },
    });
    if (!cmd) return;
    if (cmd.annonce_id) {
      await tx.annonces_vente.update({
        where: { id: cmd.annonce_id },
        data: {
          quantite_kg: { increment: cmd.quantite_kg },
          status: product_status.ACTIVE,
        },
      });
    }
    if (cmd.publication_coop_id) {
      await tx.publications_stock_coop.update({
        where: { id: cmd.publication_coop_id },
        data: {
          quantite_kg: { increment: cmd.quantite_kg },
          is_active: true,
        },
      });
    }
  }

  // ===================================================================
  //  DISPUTES
  // ===================================================================

  async openDispute(userId: string, dto: OpenDisputeDto) {
    const order = await this.prisma.commandes_vente.findUnique({
      where: { id: dto.commande_id },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.buyer_id !== userId && order.seller_id !== userId) {
      throw new ForbiddenException("Vous n'êtes pas partie à cette commande.");
    }

    // Un litige ne peut s'ouvrir que sur certains statuts (livré ou en cours).
    const allowedStatuses: order_status[] = [
      order_status.IN_PROGRESS,
      order_status.DELIVERED,
    ];
    if (!allowedStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Litige impossible sur une commande au statut ${order.status}.`,
      );
    }

    const dejaOuvert = await this.prisma.disputes.findFirst({
      where: { commande_id: dto.commande_id, status: 'OPEN' },
      select: { id: true },
    });
    if (dejaOuvert) {
      throw new ConflictException('Un litige est déjà ouvert sur cette commande.');
    }

    return this.prisma.$transaction(async (tx) => {
      const dispute = await tx.disputes.create({
        data: {
          commande_id: dto.commande_id,
          opened_by: userId,
          raison: dto.raison,
          preuves_urls: dto.preuves_urls ?? [],
          status: 'OPEN',
        },
      });
      await tx.commandes_vente.update({
        where: { id: dto.commande_id },
        data: { status: order_status.DISPUTED },
      });
      return { message: 'Litige ouvert.', dispute_id: dispute.id };
    });
  }

  /**
   * Résout un litige. Réservé aux ADMIN (vérifié par RolesGuard au controller).
   * Selon la résolution choisie :
   *   - REFUND_BUYER   : annule la commande, l'escrow revient au buyer.
   *   - PAY_SELLER     : libère l'escrow vers le seller (status COMPLETED).
   *   - PARTIAL_REFUND : à câbler avec une logique de split (TODO).
   */
  async resolveDispute(adminId: string, disputeId: string, dto: ResolveDisputeDto) {
    const dispute = await this.prisma.disputes.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Litige introuvable.');
    if (dispute.status !== 'OPEN') {
      throw new BadRequestException('Litige déjà résolu.');
    }

    await this.prisma.disputes.update({
      where: { id: disputeId },
      data: {
        status: 'RESOLVED',
        resolution: dto.resolution,
        resolved_by: adminId,
        resolved_at: new Date(),
      },
    });

    if (dto.resolution === 'PAY_SELLER') {
      await this.finance.releaseEscrow(dispute.commande_id, adminId);
      await this.prisma.commandes_vente.update({
        where: { id: dispute.commande_id },
        data: { status: order_status.COMPLETED },
      });
    } else if (dto.resolution === 'REFUND_BUYER') {
      // Remboursement intégral : escrow → balance buyer.
      await this.finance.refundBuyer(dispute.commande_id, adminId, 'DISPUTE_REFUND');
      await this.prisma.commandes_vente.update({
        where: { id: dispute.commande_id },
        data: {
          status: order_status.CANCELLED,
          cancelled_at: new Date(),
          cancelled_reason: 'DISPUTE_REFUND',
        },
      });
    } else if (dto.resolution === 'PARTIAL_REFUND') {
      // Note.buyer_pct est requis quand resolution=PARTIAL_REFUND (validé au DTO).
      const buyerPct = (dto as any).buyer_pct ?? 0.5;
      await this.finance.partialRefund(
        dispute.commande_id,
        buyerPct,
        adminId,
        `DISPUTE_PARTIAL_REFUND_${buyerPct}`,
      );
      await this.prisma.commandes_vente.update({
        where: { id: dispute.commande_id },
        data: { status: order_status.COMPLETED },
      });
    }

    return { message: 'Litige résolu.', resolution: dto.resolution };
  }

  async listerDisputes(userId: string, isAdmin: boolean) {
    return this.prisma.disputes.findMany({
      where: isAdmin
        ? undefined
        : {
            commandes_vente: {
              OR: [{ buyer_id: userId }, { seller_id: userId }],
            },
          },
      include: {
        commandes_vente: { select: { reference: true, status: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // ===================================================================
  //  HELPERS PRIVÉS
  // ===================================================================

  /**
   * Résout la source de la commande et en extrait sellerId + prix
   * unitaire — TOUJOURS depuis la DB, jamais du client. Les "preuves"
   * de négociation acceptée sont vérifiées (status = ACCEPTED).
   */
  private async resolveOrderSource(
    buyerId: string,
    dto: CreateOrderDto,
  ): Promise<{
    sellerId: string;
    prixUnitaireKg: number;
    annonceVenteId?: string | null;
    publicationCoopId?: string | null;
    lotId?: string | null;
    fromReservationId?: string | null;
  }> {
    switch (dto.source_type) {
      case OrderSourceType.DIRECT_ANNONCE_VENTE: {
        if (!dto.annonce_vente_id) {
          throw new BadRequestException('annonce_vente_id requis.');
        }
        const a = await this.prisma.annonces_vente.findUnique({
          where: { id: dto.annonce_vente_id },
        });
        if (!a) throw new NotFoundException('Annonce introuvable.');
        if (a.status !== product_status.ACTIVE) {
          throw new BadRequestException("L'annonce n'est pas active.");
        }
        if (dto.quantite_kg > a.quantite_kg.toNumber()) {
          throw new BadRequestException('Quantité supérieure au stock disponible.');
        }
        return {
          sellerId: a.farmer_id,
          prixUnitaireKg: a.prix_par_kg.toNumber(),
          annonceVenteId: a.id,
        };
      }

      case OrderSourceType.CANDIDATURE_ACCEPTED: {
        if (!dto.candidature_id) throw new BadRequestException('candidature_id requis.');
        const c = await this.prisma.candidatures_achat.findUnique({
          where: { id: dto.candidature_id },
          include: { annonces_vente: true },
        });
        if (!c) throw new NotFoundException('Candidature introuvable.');
        if (c.buyer_id !== buyerId) {
          throw new ForbiddenException("Candidature non rattachée à votre compte.");
        }
        if (c.status !== 'ACCEPTED') {
          throw new BadRequestException('Candidature non acceptée.');
        }
        return {
          sellerId: c.annonces_vente.farmer_id,
          prixUnitaireKg: (c.prix_propose_kg ?? c.annonces_vente.prix_par_kg).toNumber(),
          annonceVenteId: c.annonce_id,
        };
      }

      case OrderSourceType.PROPOSITION_ACCEPTED: {
        if (!dto.proposition_id) throw new BadRequestException('proposition_id requis.');
        const p = await this.prisma.propositions_vente.findUnique({
          where: { id: dto.proposition_id },
          include: { annonces_achat: true },
        });
        if (!p) throw new NotFoundException('Proposition introuvable.');
        if (p.annonces_achat.buyer_id !== buyerId) {
          throw new ForbiddenException("Proposition non rattachée à votre compte.");
        }
        if (p.status !== 'ACCEPTED') {
          throw new BadRequestException('Proposition non acceptée.');
        }
        return {
          sellerId: p.vendeur_id,
          prixUnitaireKg: p.prix_propose_kg.toNumber(),
          annonceVenteId: p.annonce_vente_id ?? null,
          publicationCoopId: p.publication_coop_id ?? null,
        };
      }

      case OrderSourceType.RESERVATION_CONFIRMED: {
        if (!dto.reservation_id) throw new BadRequestException('reservation_id requis.');
        const r = await this.prisma.reservations_previsions.findUnique({
          where: { id: dto.reservation_id },
          include: { previsions_production: true },
        });
        if (!r) throw new NotFoundException('Réservation introuvable.');
        if (r.acheteur_id !== buyerId) {
          throw new ForbiddenException("Réservation non rattachée à votre compte.");
        }
        // Nouveau workflow : la prévision doit avoir été convertie en
        // annonce (le farmer a cliqué "Convertir"). Le buyer paye ici
        // le solde 90% (l'acompte 10% est déjà bloqué en escrow).
        if (r.status !== 'AWAITING_FINAL') {
          throw new BadRequestException(
            r.status === 'CONFIRMED'
              ? 'Prévision pas encore convertie en annonce. Patientez que le producteur clique sur "Convertir".'
              : `Réservation en statut ${r.status} — paiement final impossible.`,
          );
        }
        if (r.expires_at && r.expires_at < new Date()) {
          throw new BadRequestException(
            'Délai de paiement final dépassé. Réservation expirée.',
          );
        }
        return {
          sellerId: r.previsions_production.farmer_id,
          prixUnitaireKg: (
            r.prix_reserve_kg ?? r.previsions_production.prix_cible_kg ?? 0
          ).toString().length
            ? Number(r.prix_reserve_kg ?? r.previsions_production.prix_cible_kg)
            : 0,
          // L'annonce officielle créée par la conversion
          annonceVenteId: r.previsions_production.converted_to_annonce_id ?? null,
          fromReservationId: r.id,
        };
      }

      case OrderSourceType.CONTRE_OFFRE_ACCEPTED: {
        if (!dto.contre_offre_id) throw new BadRequestException('contre_offre_id requis.');
        const co = await this.prisma.contre_offres_coop.findUnique({
          where: { id: dto.contre_offre_id },
          include: {
            publications_stock_coop: { include: { cooperative_profiles: true } },
          },
        });
        if (!co) throw new NotFoundException('Contre-offre introuvable.');
        if (co.acheteur_id !== buyerId) {
          throw new ForbiddenException("Contre-offre non rattachée à votre compte.");
        }
        if (co.status !== 'ACCEPTED') {
          throw new BadRequestException('Contre-offre non acceptée.');
        }
        return {
          // seller_id = user_id de la coop (cooperative_profiles.user_id)
          sellerId: co.publications_stock_coop.cooperative_profiles.user_id,
          prixUnitaireKg: co.prix_propose_kg.toNumber(),
          publicationCoopId: co.publication_id,
        };
      }

      default:
        throw new BadRequestException('source_type invalide.');
    }
  }

  /**
   * Récupère le moyen de paiement à utiliser :
   *   - Si payment_method_id fourni : le valide (appartient au buyer + actif).
   *   - Sinon : le moyen marqué is_default.
   *   - Sinon : crash car on ne peut pas payer.
   */
  private async resolvePaymentMethod(
    buyerId: string,
    paymentMethodId?: string,
  ): Promise<{ id: string; provider: mobile_provider; phoneNumber: string }> {
    const where: Prisma.moyen_de_payementWhereInput = paymentMethodId
      ? { id: paymentMethodId, user_id: buyerId, is_active: true }
      : { user_id: buyerId, is_active: true, is_default: true };

    const pm = await this.prisma.moyen_de_payement.findFirst({ where });
    if (!pm) {
      throw new BadRequestException(
        paymentMethodId
          ? 'Moyen de paiement invalide ou inactif.'
          : "Aucun moyen de paiement par défaut. Ajoutez-en un d'abord.",
      );
    }
    if (!pm.phone_display) {
      throw new BadRequestException('Moyen de paiement sans numéro associé.');
    }
    return { id: pm.id, provider: pm.provider, phoneNumber: pm.phone_display };
  }

  private assertTransition(current: OrderStatus, next: OrderStatus): void {
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(`Transition impossible : ${current} → ${next}.`);
    }
  }

  private assertActor(target: OrderStatus, side: 'buyer' | 'seller'): void {
    const allowed = TRANSITION_ACTOR[target];
    if (allowed !== 'both' && allowed !== side) {
      throw new ForbiddenException(
        `Seul le ${allowed === 'buyer' ? "acheteur" : "vendeur"} peut déclencher ${target}.`,
      );
    }
  }

  // randomHex remplacé par crypto.randomBytes (cf. import en tête).

  // ===================================================================
  //  CLEANUP : commandes orphelines
  //  ---------------------------------------------------------------------
  //  Une commande créée en SENT qui n'a pas vu son payin se résoudre
  //  reste bloquée. Au bout de 24h, on annule + restore stock.
  //  À appeler depuis un cron (setInterval ou @nestjs/schedule).
  // ===================================================================

  async cleanupOrphanOrders(maxAgeHours = 24): Promise<{ cancelled: number }> {
    const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const orphans = await this.prisma.commandes_vente.findMany({
      where: { status: order_status.SENT, created_at: { lt: threshold } },
      select: { id: true, reference: true },
    });
    for (const o of orphans) {
      try {
        await this.cancelOrderCompensation(o.id, 'ORPHAN_TIMEOUT');
        this.logger.warn(`Orphan cancelled: ${o.reference}`);
      } catch (e: any) {
        this.logger.error(`Cleanup KO pour ${o.reference}: ${e?.message}`);
      }
    }
    return { cancelled: orphans.length };
  }

  private async safeNotify(
    userId: string,
    payload: {
      type: NotificationType;
      titre: string;
      body: string;
      commande_id?: string;
    },
  ): Promise<void> {
    try {
      await this.notifications.create({
        user_id: userId,
        type: payload.type,
        titre: payload.titre,
        body: payload.body,
        commande_id: payload.commande_id,
      });
    } catch (err) {
      this.logger.warn(`Notification failed for ${userId}: ${(err as Error).message}`);
    }
  }
}
