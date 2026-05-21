// =====================================================================
//  SERVICE : FinanceService
//  ---------------------------------------------------------------------
//  Gère les wallets, transactions, escrow (en 2 volets produit/transport),
//  moyens de paiement et batches de payout.
//
//  Modèle économique :
//   Le BUYER paye au total : prix_produit + prix_transport
//   La plateforme prélève (configurable via .env) :
//     • SERVICE_FEE_PRODUCT (3% par défaut)   → sur le seller
//     • SERVICE_FEE_TRANSPORT (3% par défaut) → sur le transporter
//   Le BUYER ne paye AUCUNE commission. Il voit le prix d'affichage.
//
//  Cycle escrow (par commande avec shipment) :
//
//   ┌────────────────────────────── createOrder (Orders) ────────────────────┐
//   │ Insert commande (montant_total = produit + transport)                  │
//   │ Insert shipment (prix_final = transport)                               │
//   │ Insert 2 escrow_conditions (PRODUCT seller + TRANSPORT null)           │
//   │ Call finance.processPayin → simul provider                             │
//   │ confirmPayment → balance_escrow += total, 2 escrows LOCKED             │
//   │                                  + commande.status = ACCEPTED          │
//   └─────────────────────────────────────────────────────────────────────────┘
//                                       │
//   ┌─── Logistics : transporter accept ┘
//   │   Set shipment.transporter_id
//   │   Set escrow TRANSPORT.beneficiary_id = transporter_id
//   │
//   └─── BUYER confirme livraison
//         confirmDelivery → releaseEscrow ALL escrows of commande
//          • PRODUCT  → seller crédité (montant - fee)
//          • TRANSPORT → transporter crédité (montant - fee)
//          • Plateforme touche les 2 fees (transactions FEE)
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mobile_provider, order_status, Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService, NotificationType } from '@farmcash/notifications';
import { PAYMENT_PROVIDER_TOKEN } from './providers/payment-provider.token';
import type { PaymentProvider } from './providers/payment-provider.interface';

// UUID fixe du compte plateforme (TREASURY) — créé par migration.
// Sert à accumuler les frais service plutôt que de les "perdre".
const TREASURY_USER_ID = '00000000-0000-0000-0000-000000000001';
import {
  ConfirmDeliveryDto,
  CreateMoyenPayementDto,
  CreatePayoutBatchDto,
  EscrowKind,
  ListerTransactionsQueryDto,
  PayinPayload,
  PayoutDto,
  ReleaseEscrowDto,
  TopupWalletDto,
  TopupWalletResponseDto,
  TransactionType,
  UpdateMoyenPayementDto,
} from './dto/finance.dto';

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER_TOKEN)
    private readonly paymentProvider: PaymentProvider,
    private readonly notifications: NotificationsService,
  ) {}

  /** Pourcentage prélevé au seller (configurable via env). */
  private get feeProduct(): Prisma.Decimal {
    return new Prisma.Decimal(
      this.config.get<string>('SERVICE_FEE_PRODUCT') ?? '0.03',
    );
  }
  /** Pourcentage prélevé au transporter (configurable via env). */
  private get feeTransport(): Prisma.Decimal {
    return new Prisma.Decimal(
      this.config.get<string>('SERVICE_FEE_TRANSPORT') ?? '0.03',
    );
  }

  // ===================================================================
  //  HELPERS — verrouillage de wallets, ledger, audit, decimals
  // ===================================================================

  /**
   * Verrouille un wallet pour la durée d'une transaction Postgres
   * (SELECT ... FOR UPDATE). Doit être appelé À L'INTÉRIEUR d'un
   * `prisma.$transaction()` — sinon le lock est libéré immédiatement.
   *
   * Retourne les balances "fraîches" verrouillées, pour utiliser dans
   * la transaction (calcul de balance_avant/balance_apres).
   */
  private async lockWallet(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{
    id: string;
    user_id: string;
    balance: Prisma.Decimal;
    balance_escrow: Prisma.Decimal;
    is_frozen: boolean;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        user_id: string;
        balance: Prisma.Decimal;
        balance_escrow: Prisma.Decimal;
        is_frozen: boolean;
      }[]
    >`SELECT id, user_id, balance, balance_escrow, is_frozen
        FROM wallets
        WHERE user_id = ${userId}::uuid AND currency = 'XOF'
        FOR UPDATE`;
    if (rows.length === 0) {
      // Pas de wallet → on en crée un (toujours dans la même TX).
      await tx.wallets.create({
        data: { user_id: userId, currency: 'XOF', balance: 0, balance_escrow: 0 },
      });
      const created = await tx.$queryRaw<
        {
          id: string;
          user_id: string;
          balance: Prisma.Decimal;
          balance_escrow: Prisma.Decimal;
          is_frozen: boolean;
        }[]
      >`SELECT id, user_id, balance, balance_escrow, is_frozen
          FROM wallets
          WHERE user_id = ${userId}::uuid AND currency = 'XOF'
          FOR UPDATE`;
      return created[0];
    }
    return rows[0];
  }

  /**
   * Verrouille deux wallets dans un ordre déterministe (par user_id
   * lexicographique) pour éviter les deadlocks quand 2 transactions
   * concurrentes verrouillent les mêmes paires en ordre inverse.
   */
  private async lockTwoWallets(
    tx: Prisma.TransactionClient,
    userIdA: string,
    userIdB: string,
  ): Promise<{
    a: Awaited<ReturnType<FinanceService['lockWallet']>>;
    b: Awaited<ReturnType<FinanceService['lockWallet']>>;
  }> {
    const [first, second] =
      userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
    const lockedFirst = await this.lockWallet(tx, first);
    const lockedSecond = await this.lockWallet(tx, second);
    return userIdA < userIdB
      ? { a: lockedFirst, b: lockedSecond }
      : { a: lockedSecond, b: lockedFirst };
  }

  /**
   * Enregistre une action admin dans admin_audit_log. Fire-and-forget :
   * le succès de l'action métier ne dépend pas du log.
   */
  private async logAdminAction(
    adminId: string,
    action: string,
    target: { type: string; id?: string },
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.admin_audit_log.create({
        data: {
          admin_id: adminId,
          action,
          target_type: target.type,
          target_id: target.id,
          payload: (payload as Prisma.InputJsonValue) ?? undefined,
        },
      });
    } catch (e: any) {
      this.logger.warn(`admin_audit_log écriture KO: ${e?.message}`);
    }
  }

  // ===================================================================
  //  WALLETS
  // ===================================================================

  async getOrCreateWallet(userId: string) {
    let wallet = await this.prisma.wallets.findUnique({
      where: { user_id_currency: { user_id: userId, currency: 'XOF' } },
    });
    if (!wallet) {
      wallet = await this.prisma.wallets.create({
        data: { user_id: userId, currency: 'XOF', balance: 0, balance_escrow: 0 },
      });
    }
    return wallet;
  }

  async getWalletDetails(userId: string, query: ListerTransactionsQueryDto) {
    const wallet = await this.getOrCreateWallet(userId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.transactionsWhereInput = {
      user_id: userId,
      ...(query.type && { type: query.type }),
    };
    const [transactions, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.transactions.count({ where }),
    ]);
    return {
      wallet,
      transactions: {
        data: transactions,
        meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
      },
    };
  }

  // ===================================================================
  //  PAYIN (interne — appelé par OrdersService)
  // ===================================================================

  /**
   * Initie le paiement entrant. Lit les montants depuis la DB :
   *   • commande.montant_total = produit + transport (total à débiter)
   *   • shipment.prix_final = portion transport (si shipment existe)
   *   • produit = montant_total − transport
   *
   * Crée une transaction PENDING puis simule la confirmation provider.
   */
  async processPayin(buyerId: string, dto: PayinPayload) {
    const commande = await this.prisma.commandes_vente.findUnique({
      where: { id: dto.commande_id },
      include: { shipments: true },
    });
    if (!commande) throw new NotFoundException('Commande introuvable.');
    if (commande.buyer_id !== buyerId) {
      throw new ForbiddenException('Cette commande ne vous appartient pas.');
    }
    if (commande.status !== order_status.SENT) {
      throw new BadRequestException(`Statut invalide : ${commande.status}.`);
    }

    const moyen = await this.prisma.moyen_de_payement.findFirst({
      where: { id: dto.payment_method_id, user_id: buyerId, is_active: true },
    });
    if (!moyen) throw new BadRequestException('Moyen de paiement invalide.');

    const wallet = await this.getOrCreateWallet(buyerId);
    if (wallet.is_frozen) throw new ForbiddenException('Wallet gelé.');

    // Si la commande vient d'une réservation, l'acompte 10% est déjà
    // bloqué en escrow. Le payin ne doit débiter QUE le solde restant.
    // L'escrow final (côté confirmPayment) reste calculé sur le total.
    let chargeAmount: Prisma.Decimal = commande.montant_total;
    let depositReused: Prisma.Decimal | null = null;
    if (dto.from_reservation_id) {
      const r = await this.prisma.reservations_previsions.findUnique({
        where: { id: dto.from_reservation_id },
        select: { deposit_amount: true, acheteur_id: true },
      });
      if (r && r.acheteur_id === buyerId) {
        depositReused = new Prisma.Decimal(r.deposit_amount.toString());
        chargeAmount = commande.montant_total.minus(depositReused);
        if (chargeAmount.lessThan(0)) chargeAmount = new Prisma.Decimal(0);
      }
    }

    const tx = await this.prisma.transactions.create({
      data: {
        user_id: buyerId,
        commande_id: dto.commande_id,
        type: TransactionType.PAYIN,
        montant: chargeAmount,
        balance_avant: wallet.balance,
        balance_apres: wallet.balance,
        status: 'PENDING',
        description: depositReused
          ? `Solde commande (acompte ${depositReused} déjà payé)`
          : `Paiement Mobile Money (${moyen.phone_display})`,
        provider: moyen.provider,
      },
    });

    const providerRef = `${moyen.provider}-${Date.now().toString(36)}`;
    return this.confirmPayment(tx.id, providerRef);
  }

  /**
   * Confirme le paiement après retour du provider. Crée les 2 escrows
   * (produit + transport si shipment) et bascule la commande à ACCEPTED.
   */
  async confirmPayment(transactionId: string, providerRef: string) {
    const tx = await this.prisma.transactions.findUnique({
      where: { id: transactionId },
    });
    if (!tx) throw new NotFoundException('Transaction introuvable.');
    if (tx.status !== 'PENDING') {
      this.logger.warn(`confirmPayment ignored: tx ${transactionId} status=${tx.status}`);
      return tx;
    }
    if (!tx.commande_id) {
      throw new BadRequestException('Transaction sans commande associée.');
    }

    const commande = await this.prisma.commandes_vente.findUnique({
      where: { id: tx.commande_id },
      include: { shipments: true },
    });
    if (!commande) throw new NotFoundException('Commande introuvable.');

    // Calculs en Decimal pour zéro perte d'arrondi.
    const transportAmount = new Prisma.Decimal(
      commande.shipments?.[0]?.prix_final?.toString() ?? '0',
    );
    const productAmount = commande.montant_total.minus(transportAmount);
    const productFee = productAmount.times(this.feeProduct).toDecimalPlaces(2);
    const transportFee = transportAmount
      .times(this.feeTransport)
      .toDecimalPlaces(2);

    return this.prisma.$transaction(async (prisma) => {
      // ─── DÉCRÉMENT DU STOCK AU MOMENT DU PAIEMENT ───
      // Règle métier : on ne touche au stock que quand l'argent est
      // effectivement bloqué en escrow (= paiement confirmé). Lock
      // SELECT FOR UPDATE pour éviter qu'un autre payment confirme en
      // parallèle sur la même annonce/publication coop.
      //
      // Exception : si la commande vient d'une RÉSERVATION, le stock a
      // déjà été soustrait au moment de la conversion prévision→annonce.
      // On ne re-décrémente PAS (sinon on enlèverait 2x).
      const qty = new Prisma.Decimal(commande.quantite_kg.toString());
      const fromReservation = !!commande.from_reservation_id;
      if (commande.annonce_id && !fromReservation) {
        const rows = await prisma.$queryRaw<
          { quantite_kg: Prisma.Decimal; status: string }[]
        >`SELECT quantite_kg, status FROM annonces_vente
            WHERE id = ${commande.annonce_id}::uuid
            FOR UPDATE`;
        if (rows.length === 0) {
          throw new NotFoundException('Annonce introuvable au paiement.');
        }
        const stockAvant = new Prisma.Decimal(rows[0].quantite_kg.toString());
        if (qty.greaterThan(stockAvant)) {
          throw new BadRequestException(
            `Stock épuisé entre la commande et le paiement (${stockAvant} kg restant).`,
          );
        }
        const stockApres = stockAvant.minus(qty);
        await prisma.annonces_vente.update({
          where: { id: commande.annonce_id },
          data: {
            quantite_kg: stockApres,
            // Stock 0 → annonce SOLD : disparaît immédiatement du marketplace.
            ...(stockApres.isZero() && { status: 'SOLD' as any }),
          },
        });
      }
      if (commande.publication_coop_id) {
        const rows = await prisma.$queryRaw<
          { quantite_kg: Prisma.Decimal; is_active: boolean }[]
        >`SELECT quantite_kg, is_active FROM publications_stock_coop
            WHERE id = ${commande.publication_coop_id}::uuid
            FOR UPDATE`;
        if (rows.length === 0) {
          throw new NotFoundException('Publication coop introuvable au paiement.');
        }
        const stockAvant = new Prisma.Decimal(rows[0].quantite_kg.toString());
        if (qty.greaterThan(stockAvant)) {
          throw new BadRequestException(
            `Stock coop épuisé entre la commande et le paiement (${stockAvant} kg restant).`,
          );
        }
        const stockApres = stockAvant.minus(qty);
        await prisma.publications_stock_coop.update({
          where: { id: commande.publication_coop_id },
          data: {
            quantite_kg: stockApres,
            ...(stockApres.isZero() && { is_active: false }),
          },
        });
      }

      const updatedTx = await prisma.transactions.update({
        where: { id: transactionId },
        data: { status: 'ESCROW', provider_ref: providerRef, provider_status: 'ACCEPTED' },
      });

      // Verrouille le wallet du buyer puis applique l'escrow.
      const buyerWallet = await this.lockWallet(prisma, tx.user_id);
      const newEscrow = buyerWallet.balance_escrow.plus(tx.montant);
      await prisma.wallets.update({
        where: { id: buyerWallet.id },
        data: { balance_escrow: newEscrow },
      });

      // Escrow PRODUCT (bénéficiaire = seller)
      await prisma.escrow_conditions.create({
        data: {
          commande_id: tx.commande_id!,
          kind: EscrowKind.PRODUCT,
          beneficiary_id: commande.seller_id,
          montant: productAmount,
          frais_service: productFee,
          status: 'LOCKED',
          condition: 'DELIVERY_CONFIRMED',
        },
      });

      // Escrow TRANSPORT (bénéficiaire = null, fixé à l'acceptation)
      if (transportAmount.greaterThan(0)) {
        await prisma.escrow_conditions.create({
          data: {
            commande_id: tx.commande_id!,
            kind: EscrowKind.TRANSPORT,
            beneficiary_id: null,
            montant: transportAmount,
            frais_service: transportFee,
            status: 'LOCKED',
            condition: 'DELIVERY_CONFIRMED',
          },
        });
      }

      await prisma.commandes_vente.update({
        where: { id: tx.commande_id! },
        data: { status: order_status.ACCEPTED },
      });

      this.logger.log(
        `Payin confirmed: tx=${transactionId} prod=${productAmount} trans=${transportAmount}`,
      );
      return updatedTx;
    });
  }

  // ===================================================================
  //  CONFIRM DELIVERY → libération escrow
  // ===================================================================

  async confirmDelivery(userId: string, dto: ConfirmDeliveryDto) {
    const commande = await this.prisma.commandes_vente.findUnique({
      where: { id: dto.commande_id },
    });
    if (!commande) throw new NotFoundException('Commande introuvable.');
    if (commande.buyer_id !== userId) {
      throw new ForbiddenException("Seul l'acheteur peut confirmer.");
    }
    if (commande.status !== order_status.DELIVERED) {
      throw new BadRequestException(
        `Commande en statut ${commande.status} (DELIVERED requis).`,
      );
    }
    return this.releaseEscrow(dto.commande_id, userId, undefined, 'DELIVERY_CONFIRMED');
  }

  /**
   * Libère les escrows LOCKED d'une commande. Si `kindFilter` est précisé,
   * libère uniquement ce kind (PRODUCT ou TRANSPORT). Sinon : tous.
   *
   * Pour chaque escrow :
   *   • Décrémente balance_escrow du buyer du `montant`.
   *   • Crédite balance du beneficiary de `montant - frais_service`.
   *   • Trace 2 transactions : RELEASE (au bénéficiaire) + FEE (plateforme).
   *   • Marque escrow RELEASED.
   *
   * Si après libération aucun escrow LOCKED ne reste pour la commande,
   * passe la commande à COMPLETED.
   */
  async releaseEscrow(
    commandeId: string,
    releasedBy?: string,
    kindFilter?: EscrowKind,
    reason: string = 'DELIVERY_CONFIRMED',
  ) {
    const commande = await this.prisma.commandes_vente.findUnique({
      where: { id: commandeId },
    });
    if (!commande) throw new NotFoundException('Commande introuvable.');

    const escrows = await this.prisma.escrow_conditions.findMany({
      where: {
        commande_id: commandeId,
        status: 'LOCKED',
        ...(kindFilter && { kind: kindFilter }),
      },
    });
    if (escrows.length === 0) {
      throw new NotFoundException('Aucun escrow LOCKED à libérer.');
    }

    // Collecte des libérations effectuées pour notification hors-TX.
    const releasedSummaries: Array<{
      beneficiary_id: string;
      kind: string;
      net: Prisma.Decimal;
    }> = [];

    const txResult = await this.prisma.$transaction(async (prisma) => {
      // Verrouille le wallet buyer une seule fois en tête de TX.
      const buyerWallet = await this.lockWallet(prisma, commande.buyer_id);

      for (const escrow of escrows) {
        if (!escrow.beneficiary_id) {
          throw new BadRequestException(
            `Escrow ${escrow.id} (${escrow.kind}) sans bénéficiaire — refusez de libérer.`,
          );
        }

        const net = escrow.montant.minus(escrow.frais_service);
        releasedSummaries.push({
          beneficiary_id: escrow.beneficiary_id,
          kind: escrow.kind,
          net,
        });

        // Locks bénéficiaire + treasury (ordre déterministe pour éviter
        // les deadlocks si plusieurs escrows libérés en parallèle).
        const { a: benefLocked, b: treasuryLocked } = await this.lockTwoWallets(
          prisma,
          escrow.beneficiary_id,
          TREASURY_USER_ID,
        );

        // 1. Décrémente balance_escrow du buyer
        const buyerEscrowBefore = buyerWallet.balance_escrow;
        // Re-lit le wallet pour avoir la valeur fraîche après les autres
        // itérations de la boucle.
        const buyerFresh = await prisma.wallets.findUnique({
          where: { id: buyerWallet.id },
          select: { balance_escrow: true },
        });
        const buyerEscrowAfter = (buyerFresh?.balance_escrow ?? buyerEscrowBefore).minus(
          escrow.montant,
        );
        await prisma.wallets.update({
          where: { id: buyerWallet.id },
          data: { balance_escrow: buyerEscrowAfter },
        });

        // 2. Crédite le bénéficiaire (montant net)
        const benefBalanceAvant = benefLocked.balance;
        const benefBalanceApres = benefBalanceAvant.plus(net);
        await prisma.wallets.update({
          where: { id: benefLocked.id },
          data: { balance: benefBalanceApres },
        });

        // 3. Crédite la TREASURY plateforme du frais service
        const treasuryAvant = treasuryLocked.balance;
        const treasuryApres = treasuryAvant.plus(escrow.frais_service);
        if (escrow.frais_service.greaterThan(0)) {
          await prisma.wallets.update({
            where: { id: treasuryLocked.id },
            data: { balance: treasuryApres },
          });
        }

        // 4. Trace : transaction RELEASE (bénéficiaire)
        await prisma.transactions.create({
          data: {
            user_id: escrow.beneficiary_id,
            commande_id: commandeId,
            type: TransactionType.RELEASE,
            montant: net,
            balance_avant: benefBalanceAvant,
            balance_apres: benefBalanceApres,
            status: 'SUCCESS',
            description: `Libération escrow ${escrow.kind} — ${commande.reference}`,
          },
        });

        // 5. Trace : transaction FEE (TREASURY accumule)
        if (escrow.frais_service.greaterThan(0)) {
          await prisma.transactions.create({
            data: {
              user_id: TREASURY_USER_ID,
              commande_id: commandeId,
              type: TransactionType.FEE,
              montant: escrow.frais_service,
              balance_avant: treasuryAvant,
              balance_apres: treasuryApres,
              status: 'SUCCESS',
              description: `Frais service ${escrow.kind} (${commande.reference})`,
            },
          });
        }

        // 6. Marque l'escrow RELEASED
        await prisma.escrow_conditions.update({
          where: { id: escrow.id },
          data: {
            status: 'RELEASED',
            released_at: new Date(),
            released_by: releasedBy,
            release_reason: reason,
          },
        });

        this.logger.log(
          `Escrow released: cmd=${commandeId} kind=${escrow.kind} amt=${escrow.montant} net=${net} fee=${escrow.frais_service}`,
        );
      }

      // Si plus aucun escrow LOCKED → commande COMPLETED
      const remaining = await prisma.escrow_conditions.count({
        where: { commande_id: commandeId, status: 'LOCKED' },
      });
      if (remaining === 0 && commande.status !== order_status.COMPLETED) {
        await prisma.commandes_vente.update({
          where: { id: commandeId },
          data: { status: order_status.COMPLETED },
        });
      }

      return {
        status: 'success',
        message: `${escrows.length} escrow(s) libéré(s).`,
      };
    });

    // Hors transaction : notifie chaque bénéficiaire du crédit
    // (best-effort, ne casse pas la libération si la notif échoue).
    for (const r of releasedSummaries) {
      try {
        await this.notifications.create({
          user_id: r.beneficiary_id,
          type: NotificationType.WALLET_CREDITED,
          titre: 'Paiement reçu',
          body: `Votre wallet a été crédité de ${r.net.toString()} F (escrow ${r.kind} libéré).`,
          commande_id: commandeId,
        });
      } catch (e: any) {
        this.logger.warn(
          `Notif WALLET_CREDITED KO user=${r.beneficiary_id} cmd=${commandeId}: ${e?.message ?? e}`,
        );
      }
    }

    return txResult;
  }

  async releaseEscrowAdmin(adminId: string, dto: ReleaseEscrowDto) {
    const result = await this.releaseEscrow(
      dto.commande_id,
      adminId,
      dto.kind,
      dto.reason ?? 'ADMIN_OVERRIDE',
    );
    await this.logAdminAction(
      adminId,
      'ESCROW_RELEASE_OVERRIDE',
      { type: 'commande', id: dto.commande_id },
      { kind: dto.kind, reason: dto.reason ?? 'ADMIN_OVERRIDE' },
    );
    return result;
  }

  // ===================================================================
  //  PAYOUT (retrait vers Mobile Money)
  // ===================================================================

  async processPayout(userId: string, dto: PayoutDto) {
    const moyen = await this.prisma.moyen_de_payement.findFirst({
      where: { id: dto.payment_method_id, user_id: userId, is_active: true },
    });
    if (!moyen) throw new BadRequestException('Moyen de paiement invalide.');

    const wallet = await this.getOrCreateWallet(userId);
    if (wallet.is_frozen) throw new ForbiddenException('Wallet gelé.');

    return this.prisma.$transaction(async (prisma) => {
      // SELECT ... FOR UPDATE → blocage des concurrents jusqu'à commit.
      const fresh = await this.lockWallet(prisma, userId);
      if (fresh.is_frozen) throw new ForbiddenException('Wallet gelé.');
      if (fresh.balance.lt(dto.amount)) {
        throw new BadRequestException('Solde insuffisant.');
      }
      const newBalance = fresh.balance.minus(dto.amount);
      await prisma.wallets.update({
        where: { id: fresh.id },
        data: { balance: newBalance },
      });
      const providerRef = `${moyen.provider}-${Date.now().toString(36)}`;
      const tx = await prisma.transactions.create({
        data: {
          user_id: userId,
          type: TransactionType.PAYOUT,
          montant: dto.amount,
          balance_avant: fresh.balance,
          balance_apres: newBalance,
          status: 'SUCCESS',
          provider_status: 'ACCEPTED',
          description: `Retrait Mobile Money (${moyen.phone_display})`,
          provider: moyen.provider,
          provider_ref: providerRef,
        },
      });
      this.logger.log(`Payout: user=${userId} amount=${dto.amount}`);
      return tx;
    });
  }

  // ===================================================================
  //  MOYENS DE PAIEMENT
  // ===================================================================

  async addMoyenPayement(userId: string, dto: CreateMoyenPayementDto) {
    return this.prisma.$transaction(async (prisma) => {
      if (dto.is_default) {
        await prisma.moyen_de_payement.updateMany({
          where: { user_id: userId, is_default: true },
          data: { is_default: false },
        });
      }
      const created = await prisma.moyen_de_payement.create({
        data: {
          user_id: userId,
          provider: dto.provider as mobile_provider,
          phone_display: dto.phone_display,
          is_default: dto.is_default ?? false,
          is_active: true,
        },
      });
      const { token, ...safe } = created;
      void token;
      return safe;
    });
  }

  async getMoyensPayement(userId: string) {
    const list = await this.prisma.moyen_de_payement.findMany({
      where: { user_id: userId, is_active: true },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    });
    return list.map(({ token, ...rest }) => {
      void token;
      return rest;
    });
  }

  async updateMoyenPayement(userId: string, id: string, dto: UpdateMoyenPayementDto) {
    const moyen = await this.prisma.moyen_de_payement.findFirst({
      where: { id, user_id: userId },
    });
    if (!moyen) throw new NotFoundException('Moyen introuvable.');
    return this.prisma.$transaction(async (prisma) => {
      if (dto.is_default === true) {
        await prisma.moyen_de_payement.updateMany({
          where: { user_id: userId, is_default: true, id: { not: id } },
          data: { is_default: false },
        });
      }
      const updated = await prisma.moyen_de_payement.update({
        where: { id },
        data: {
          ...(dto.is_default !== undefined && { is_default: dto.is_default }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        },
      });
      const { token, ...safe } = updated;
      void token;
      return safe;
    });
  }

  async deleteMoyenPayement(userId: string, id: string) {
    const moyen = await this.prisma.moyen_de_payement.findFirst({
      where: { id, user_id: userId },
    });
    if (!moyen) throw new NotFoundException('Moyen introuvable.');
    await this.prisma.moyen_de_payement.update({
      where: { id },
      data: { is_active: false, is_default: false },
    });
    return { message: 'Moyen supprimé.' };
  }

  // ===================================================================
  //  PAYOUT BATCH
  // ===================================================================

  async createPayoutBatch(initiatorId: string, dto: CreatePayoutBatchDto) {
    const initiatorWallet = await this.getOrCreateWallet(initiatorId);
    if (initiatorWallet.is_frozen) throw new ForbiddenException('Wallet gelé.');

    const totalAmount = dto.items.reduce((sum, i) => sum + i.amount, 0);
    if (initiatorWallet.balance.lt(totalAmount)) {
      throw new BadRequestException(`Solde insuffisant (< ${totalAmount}).`);
    }

    const userIds = [...new Set(dto.items.map((i) => i.user_id))];
    const existing = await this.prisma.users.findMany({
      where: { id: { in: userIds } },
      select: { id: true },
    });
    if (existing.length !== userIds.length) {
      throw new BadRequestException('Bénéficiaires introuvables.');
    }

    return this.prisma.$transaction(async (prisma) => {
      // Lock initiator
      const initLocked = await this.lockWallet(prisma, initiatorId);
      if (initLocked.is_frozen) throw new ForbiddenException('Wallet gelé.');
      if (initLocked.balance.lt(totalAmount)) {
        throw new BadRequestException(`Solde insuffisant (< ${totalAmount}).`);
      }
      const initBalanceApres = initLocked.balance.minus(totalAmount);
      await prisma.wallets.update({
        where: { id: initLocked.id },
        data: { balance: initBalanceApres },
      });

      // Trace le débit côté initiator
      await prisma.transactions.create({
        data: {
          user_id: initiatorId,
          type: TransactionType.PAYOUT,
          montant: totalAmount,
          balance_avant: initLocked.balance,
          balance_apres: initBalanceApres,
          status: 'SUCCESS',
          description: `Payout batch (${dto.items.length} items)`,
        },
      });

      const batch = await prisma.payout_batches.create({
        data: {
          initiator_id: initiatorId,
          total_amount: totalAmount,
          nb_items: dto.items.length,
          status: 'PENDING',
        },
      });

      for (const item of dto.items) {
        await prisma.payout_items.create({
          data: {
            batch_id: batch.id,
            user_id: item.user_id,
            amount: item.amount,
            commande_id: item.commande_id,
            status: 'PENDING',
          },
        });

        // Lock + credit bénéficiaire
        const benefLocked = await this.lockWallet(prisma, item.user_id);
        const benefAvant = benefLocked.balance;
        const benefApres = benefAvant.plus(item.amount);
        await prisma.wallets.update({
          where: { id: benefLocked.id },
          data: { balance: benefApres },
        });

        await prisma.transactions.create({
          data: {
            user_id: item.user_id,
            commande_id: item.commande_id,
            type: TransactionType.PAYOUT,
            montant: item.amount,
            balance_avant: benefAvant,
            balance_apres: benefApres,
            status: 'SUCCESS',
            description: `Payout batch ${batch.id}`,
          },
        });
      }
      this.logger.log(`Payout batch: init=${initiatorId} total=${totalAmount}`);
      return batch;
    });
  }

  async listerPayoutBatches(initiatorId: string) {
    return this.prisma.payout_batches.findMany({
      where: { initiator_id: initiatorId },
      include: { payout_items: true },
      orderBy: { created_at: 'desc' },
    });
  }

  // ===================================================================
  //  HOOKS POUR LE MODULE LOGISTICS
  // ===================================================================

  /**
   * Appelé par LogisticsService quand un transporter accepte la mission.
   * Renseigne `beneficiary_id` sur l'escrow TRANSPORT pour que la
   * libération sache à qui verser.
   */
  // ===================================================================
  //  RÉCONCILIATION (audit comptable)
  //  ---------------------------------------------------------------------
  //  Vérifie que la somme des wallets correspond bien à la somme des
  //  transactions SUCCESS. Si écart, c'est qu'un bug ou une fraude a
  //  produit de l'argent "fantôme" → alerter.
  //
  //  Formule simplifiée :
  //    sum(wallets.balance + balance_escrow)
  //      ?= sum(PAYIN ESCROW) - sum(PAYOUT SUCCESS depuis wallets)
  //
  //  En MVP avec providers mockés, on attend une cohérence parfaite.
  // ===================================================================

  async reconcile() {
    const walletsAgg = await this.prisma.wallets.aggregate({
      _sum: { balance: true, balance_escrow: true },
      where: { currency: 'XOF' },
    });

    const totalWallets =
      (walletsAgg._sum.balance ?? new Prisma.Decimal(0)).plus(
        walletsAgg._sum.balance_escrow ?? new Prisma.Decimal(0),
      );

    // Total des PAYIN qui sont passés en ESCROW (argent entré dans le système)
    const payinAgg = await this.prisma.transactions.aggregate({
      where: {
        type: TransactionType.PAYIN,
        status: { in: ['ESCROW', 'SUCCESS'] },
      },
      _sum: { montant: true },
    });
    const totalPayin = payinAgg._sum.montant ?? new Prisma.Decimal(0);

    // Total des PAYOUT SUCCESS (argent sorti du système vers Mobile Money)
    // Ne compte que les transactions où l'initiateur DÉBITE son wallet :
    // les PAYOUT de batch ont 2 lignes (1 débit init + N crédits bénéf).
    // Pour simplifier, on prend uniquement les PAYOUT avec provider_ref (vrais retraits).
    const payoutAgg = await this.prisma.transactions.aggregate({
      where: { type: TransactionType.PAYOUT, status: 'SUCCESS', provider_ref: { not: null } },
      _sum: { montant: true },
    });
    const totalPayout = payoutAgg._sum.montant ?? new Prisma.Decimal(0);

    // Solde théorique du système = PAYIN entrés - PAYOUT sortis vers Mobile Money
    const expected = totalPayin.minus(totalPayout);
    const drift = totalWallets.minus(expected);

    return {
      timestamp: new Date().toISOString(),
      sums: {
        wallets_balance_total: walletsAgg._sum.balance?.toString() ?? '0',
        wallets_escrow_total: walletsAgg._sum.balance_escrow?.toString() ?? '0',
        wallets_total: totalWallets.toString(),
        payin_total: totalPayin.toString(),
        payout_total: totalPayout.toString(),
        expected_system_balance: expected.toString(),
      },
      drift: drift.toString(),
      drift_is_zero: drift.isZero(),
      status: drift.isZero() ? 'OK' : 'DRIFT_DETECTED',
    };
  }

  // ===================================================================
  //  RÉSERVATIONS PRÉVISION : deposit 10%
  //  ---------------------------------------------------------------------
  //  Une réservation immobilise un acompte (10% par défaut) jusqu'à
  //  conversion de la prévision en annonce. À ce moment-là, le buyer
  //  paye le solde 90% via un order standard ; le deposit est appliqué.
  //  Si le buyer ne paye pas le solde dans le délai, le deposit est
  //  soit forfait au producteur, soit remboursé selon la politique.
  // ===================================================================

  async processPayinReservation(dto: {
    buyer_id: string;
    reservation_id: string;
    amount: number;
    payment_method_id: string;
  }) {
    const moyen = await this.prisma.moyen_de_payement.findFirst({
      where: { id: dto.payment_method_id, user_id: dto.buyer_id, is_active: true },
    });
    if (!moyen) throw new BadRequestException('Moyen de paiement invalide.');

    // Crée la transaction PAYIN et la confirme immédiatement (mock).
    // L'escrow est lié à la réservation (pas à une commande).
    return this.prisma.$transaction(async (prisma) => {
      const tx = await prisma.transactions.create({
        data: {
          user_id: dto.buyer_id,
          type: TransactionType.PAYIN,
          montant: dto.amount,
          balance_avant: 0,
          balance_apres: 0,
          status: 'PENDING',
          description: `Acompte réservation ${dto.reservation_id}`,
          provider: moyen.provider,
        },
      });
      const buyerWallet = await this.lockWallet(prisma, dto.buyer_id);
      await prisma.wallets.update({
        where: { id: buyerWallet.id },
        data: { balance_escrow: { increment: dto.amount } },
      });
      const providerRef = `${moyen.provider}-${Date.now().toString(36)}`;
      const updated = await prisma.transactions.update({
        where: { id: tx.id },
        data: { status: 'ESCROW', provider_ref: providerRef, provider_status: 'ACCEPTED' },
      });
      return updated;
    });
  }

  /** Rembourse l'acompte au buyer (cas REFUND_BUYER ou annulation par farmer). */
  async refundReservationDeposit(reservationId: string) {
    const r = await this.prisma.reservations_previsions.findUnique({
      where: { id: reservationId },
    });
    if (!r || !r.deposit_transaction_id) {
      throw new NotFoundException('Réservation ou transaction introuvable.');
    }
    return this.prisma.$transaction(async (prisma) => {
      const wallet = await this.lockWallet(prisma, r.acheteur_id);
      const amount = new Prisma.Decimal(r.deposit_amount.toString());
      const balanceApres = wallet.balance.plus(amount);
      const escrowApres = wallet.balance_escrow.minus(amount);
      await prisma.wallets.update({
        where: { id: wallet.id },
        data: { balance: balanceApres, balance_escrow: escrowApres },
      });
      await prisma.transactions.create({
        data: {
          user_id: r.acheteur_id,
          type: TransactionType.REFUND,
          montant: amount,
          balance_avant: wallet.balance,
          balance_apres: balanceApres,
          status: 'SUCCESS',
          description: `Refund acompte réservation ${reservationId}`,
        },
      });
      return { refunded: true, amount: amount.toString() };
    });
  }

  /** Transfère l'acompte du buyer vers le farmer (cas FORFEIT). */
  async forfeitReservationDeposit(reservationId: string, farmerId: string) {
    const r = await this.prisma.reservations_previsions.findUnique({
      where: { id: reservationId },
    });
    if (!r) throw new NotFoundException('Réservation introuvable.');
    return this.prisma.$transaction(async (prisma) => {
      const { a: buyerWallet, b: farmerWallet } = await this.lockTwoWallets(
        prisma,
        r.acheteur_id,
        farmerId,
      );
      const amount = new Prisma.Decimal(r.deposit_amount.toString());
      // Buyer perd l'escrow
      await prisma.wallets.update({
        where: { id: buyerWallet.id },
        data: { balance_escrow: buyerWallet.balance_escrow.minus(amount) },
      });
      // Farmer reçoit
      await prisma.wallets.update({
        where: { id: farmerWallet.id },
        data: { balance: farmerWallet.balance.plus(amount) },
      });
      await prisma.transactions.create({
        data: {
          user_id: farmerId,
          type: TransactionType.RELEASE,
          montant: amount,
          balance_avant: farmerWallet.balance,
          balance_apres: farmerWallet.balance.plus(amount),
          status: 'SUCCESS',
          description: `Acompte forfait réservation ${reservationId} (buyer a expiré)`,
        },
      });
      return { forfeited: true, amount: amount.toString() };
    });
  }

  /**
   * Appelée par OrdersService quand un buyer paye le solde 90% après
   * conversion de la prévision. Le deposit (10%) est déjà dans son
   * balance_escrow ; il faut juste y ajouter le solde, créer l'escrow
   * PRODUCT global et marquer la transaction du deposit comme
   * "consommée".
   */
  async consumeReservationDeposit(reservationId: string, commandeId: string) {
    const r = await this.prisma.reservations_previsions.findUnique({
      where: { id: reservationId },
    });
    if (!r) throw new NotFoundException('Réservation introuvable.');
    if (r.deposit_transaction_id) {
      await this.prisma.transactions.update({
        where: { id: r.deposit_transaction_id },
        data: { commande_id: commandeId },
      });
    }
    await this.prisma.reservations_previsions.update({
      where: { id: reservationId },
      data: { status: 'COMPLETED', final_order_id: commandeId },
    });
  }

  // ===================================================================
  //  REFUND (annulation et remboursement)
  //  ---------------------------------------------------------------------
  //  Inverse de releaseEscrow : l'argent en escrow revient au buyer.
  //  Utilisé par les disputes résolus en REFUND_BUYER ou PARTIAL_REFUND.
  // ===================================================================

  /**
   * Rembourse intégralement le buyer : tous les escrows LOCKED de la
   * commande sont annulés et balance_escrow du buyer est restauré en
   * balance (l'argent redevient utilisable).
   * Idempotent : si plus aucun LOCKED, ne fait rien.
   */
  async refundBuyer(commandeId: string, refundedBy?: string, reason = 'BUYER_REFUND') {
    const commande = await this.prisma.commandes_vente.findUnique({
      where: { id: commandeId },
    });
    if (!commande) throw new NotFoundException('Commande introuvable.');

    const escrows = await this.prisma.escrow_conditions.findMany({
      where: { commande_id: commandeId, status: 'LOCKED' },
    });
    if (escrows.length === 0) {
      return { status: 'noop', message: 'Aucun escrow LOCKED.' };
    }

    return this.prisma.$transaction(async (prisma) => {
      const buyerWallet = await this.lockWallet(prisma, commande.buyer_id);

      for (const escrow of escrows) {
        // balance_escrow → balance (l'argent revient utilisable)
        const escrowAvant = buyerWallet.balance_escrow;
        const balanceAvant = buyerWallet.balance;
        const escrowApres = (
          await prisma.wallets.findUnique({
            where: { id: buyerWallet.id },
            select: { balance_escrow: true },
          })
        )!.balance_escrow.minus(escrow.montant);
        const balanceApres = (
          await prisma.wallets.findUnique({
            where: { id: buyerWallet.id },
            select: { balance: true },
          })
        )!.balance.plus(escrow.montant);
        await prisma.wallets.update({
          where: { id: buyerWallet.id },
          data: {
            balance_escrow: escrowApres,
            balance: balanceApres,
          },
        });

        await prisma.transactions.create({
          data: {
            user_id: commande.buyer_id,
            commande_id: commandeId,
            type: TransactionType.REFUND,
            montant: escrow.montant,
            balance_avant: balanceAvant,
            balance_apres: balanceApres,
            status: 'SUCCESS',
            description: `Remboursement escrow ${escrow.kind} — ${commande.reference}`,
          },
        });

        await prisma.escrow_conditions.update({
          where: { id: escrow.id },
          data: {
            status: 'REFUNDED',
            released_at: new Date(),
            released_by: refundedBy,
            release_reason: reason,
          },
        });
      }

      this.logger.log(
        `Refund: cmd=${commandeId} ${escrows.length} escrow(s) → buyer`,
      );
      return {
        status: 'success',
        message: `${escrows.length} escrow(s) remboursé(s) au buyer.`,
      };
    });
  }

  /**
   * Refund partiel : split entre buyer et seller selon `buyer_pct` (0-1).
   * Ex: buyer_pct=0.30 → 30% au buyer, 70% au seller (- frais).
   * Pas de double-frais : on prélève le frais une seule fois sur la part seller.
   */
  async partialRefund(
    commandeId: string,
    buyerPct: number,
    refundedBy?: string,
    reason = 'PARTIAL_REFUND',
  ) {
    if (buyerPct < 0 || buyerPct > 1) {
      throw new BadRequestException('buyer_pct doit être entre 0 et 1.');
    }
    const commande = await this.prisma.commandes_vente.findUnique({
      where: { id: commandeId },
    });
    if (!commande) throw new NotFoundException('Commande introuvable.');

    const escrows = await this.prisma.escrow_conditions.findMany({
      where: { commande_id: commandeId, status: 'LOCKED' },
    });
    if (escrows.length === 0) {
      return { status: 'noop', message: 'Aucun escrow LOCKED.' };
    }

    return this.prisma.$transaction(async (prisma) => {
      const buyerWallet = await this.lockWallet(prisma, commande.buyer_id);
      const buyerPctDec = new Prisma.Decimal(buyerPct);

      for (const escrow of escrows) {
        if (!escrow.beneficiary_id) continue;
        const refundAmount = escrow.montant.times(buyerPctDec).toDecimalPlaces(2);
        const sellerGross = escrow.montant.minus(refundAmount);
        const sellerFee = sellerGross.times(this.feeProduct).toDecimalPlaces(2);
        const sellerNet = sellerGross.minus(sellerFee);

        // Buyer récupère refundAmount
        const buyerBalAvant = buyerWallet.balance;
        const buyerEscrowAvant = buyerWallet.balance_escrow;
        const buyerFresh = await prisma.wallets.findUnique({
          where: { id: buyerWallet.id },
        });
        await prisma.wallets.update({
          where: { id: buyerWallet.id },
          data: {
            balance: buyerFresh!.balance.plus(refundAmount),
            balance_escrow: buyerFresh!.balance_escrow.minus(escrow.montant),
          },
        });

        // Seller reçoit sellerNet, TREASURY reçoit sellerFee
        const { a: benefLocked, b: treasuryLocked } = await this.lockTwoWallets(
          prisma,
          escrow.beneficiary_id,
          TREASURY_USER_ID,
        );
        await prisma.wallets.update({
          where: { id: benefLocked.id },
          data: { balance: benefLocked.balance.plus(sellerNet) },
        });
        await prisma.wallets.update({
          where: { id: treasuryLocked.id },
          data: { balance: treasuryLocked.balance.plus(sellerFee) },
        });

        // Traces
        await prisma.transactions.create({
          data: {
            user_id: commande.buyer_id,
            commande_id: commandeId,
            type: TransactionType.REFUND,
            montant: refundAmount,
            balance_avant: buyerBalAvant,
            balance_apres: buyerBalAvant.plus(refundAmount),
            status: 'SUCCESS',
            description: `Refund partiel ${(buyerPct * 100).toFixed(0)}% — ${commande.reference}`,
          },
        });
        await prisma.transactions.create({
          data: {
            user_id: escrow.beneficiary_id,
            commande_id: commandeId,
            type: TransactionType.RELEASE,
            montant: sellerNet,
            balance_avant: benefLocked.balance,
            balance_apres: benefLocked.balance.plus(sellerNet),
            status: 'SUCCESS',
            description: `Release partiel ${escrow.kind} — ${commande.reference}`,
          },
        });
        if (sellerFee.greaterThan(0)) {
          await prisma.transactions.create({
            data: {
              user_id: TREASURY_USER_ID,
              commande_id: commandeId,
              type: TransactionType.FEE,
              montant: sellerFee,
              balance_avant: treasuryLocked.balance,
              balance_apres: treasuryLocked.balance.plus(sellerFee),
              status: 'SUCCESS',
              description: `Frais service partial refund (${commande.reference})`,
            },
          });
        }

        await prisma.escrow_conditions.update({
          where: { id: escrow.id },
          data: {
            status: 'RELEASED',
            released_at: new Date(),
            released_by: refundedBy,
            release_reason: `${reason} (buyer=${(buyerPct * 100).toFixed(0)}%)`,
          },
        });
      }

      return {
        status: 'success',
        message: `${escrows.length} escrow(s) split.`,
        buyer_pct: buyerPct,
      };
    });
  }

  // ===================================================================
  //  TOPUP — recharger son wallet via Mobile Money (Chantier 4)
  //  ---------------------------------------------------------------------
  //  Flow asynchrone :
  //    1. topupWallet()   → crée TX PENDING + appelle provider
  //       • si provider ACCEPTED (mock synchrone) → confirmTopup direct
  //       • si provider PENDING (vrai prod)      → on rend la main,
  //         le webhook /webhooks/payment-provider/:p arrivera plus tard
  //         et appellera confirmTopup() via handleProviderWebhook.
  //    2. confirmTopup()  → idempotent, crédite balance, log notif.
  //
  //  Idempotence FORTE basée sur transactions.idempotency_key
  //  (unique partial index uniq_transactions_idempotency en base) :
  //  même clé envoyée 2x = même TX retournée, jamais 2 crédits.
  // ===================================================================

  async topupWallet(
    userId: string,
    dto: TopupWalletDto,
  ): Promise<TopupWalletResponseDto> {
    // 1. Idempotence FORTE — si la même clé existe déjà, renvoyer la TX
    //    sans rien recréer ni recréditer. Détecte aussi les clés
    //    "détournées" (même UUID utilisé par 2 users différents).
    const existing = await this.prisma.transactions.findFirst({
      where: { idempotency_key: dto.idempotency_key },
    });
    if (existing) {
      if (existing.user_id !== userId) {
        throw new ConflictException("Clé d'idempotence détournée.");
      }
      // Si la TX est déjà SUCCESS, on tente de remonter le solde actuel
      // pour économiser un round-trip au client.
      let currentBalance: number | undefined;
      if (existing.status === 'SUCCESS') {
        const w = await this.prisma.wallets.findUnique({
          where: { user_id_currency: { user_id: userId, currency: 'XOF' } },
        });
        currentBalance = w?.balance.toNumber();
      }
      return {
        transaction_id: existing.id,
        status: existing.status,
        provider_ref: existing.provider_ref ?? '',
        new_balance: currentBalance,
      };
    }

    // 2. Vérifications classiques
    const moyen = await this.prisma.moyen_de_payement.findFirst({
      where: { id: dto.payment_method_id, user_id: userId, is_active: true },
    });
    if (!moyen) throw new BadRequestException('Moyen de paiement invalide.');

    const wallet = await this.getOrCreateWallet(userId);
    if (wallet.is_frozen) throw new ForbiddenException('Wallet gelé.');

    // 3. Créer la transaction PENDING. Le UNIQUE INDEX partiel
    //    (uniq_transactions_idempotency) garantit qu'une race condition
    //    sur 2 INSERT parallèles avec la même clé fera échouer le 2e
    //    avec P2002 — le caller pourra retry et tomber sur le findFirst().
    let tx;
    try {
      tx = await this.prisma.transactions.create({
        data: {
          user_id: userId,
          type: TransactionType.TOPUP,
          montant: dto.amount,
          balance_avant: wallet.balance,
          balance_apres: wallet.balance, // mis à jour à la confirmation
          status: 'PENDING',
          description: `Recharge wallet (${moyen.provider}, ${moyen.phone_display})`,
          provider: moyen.provider,
          idempotency_key: dto.idempotency_key,
        },
      });
    } catch (e: any) {
      // P2002 = unique constraint (concurrent topup avec même clé).
      // On relit la TX existante et on la renvoie (comportement idempotent).
      if (e?.code === 'P2002') {
        const existed = await this.prisma.transactions.findFirst({
          where: { idempotency_key: dto.idempotency_key },
        });
        if (existed && existed.user_id === userId) {
          return {
            transaction_id: existed.id,
            status: existed.status,
            provider_ref: existed.provider_ref ?? '',
          };
        }
        throw new ConflictException("Clé d'idempotence détournée.");
      }
      throw e;
    }

    // 4. Appeler le provider Mobile Money (mock en dev).
    const webhookBase =
      this.config.get<string>('PAYMENT_WEBHOOK_BASE_URL') ??
      'http://localhost:3000/api';
    const providerResponse = await this.paymentProvider.initiateTopup({
      idempotency_key: dto.idempotency_key,
      amount: dto.amount,
      // phone_display est nullable côté schema mais en pratique toujours
      // présent (saisi à l'ajout du moyen). Fallback string vide pour
      // satisfaire la signature PaymentRequest.phone: string.
      phone: moyen.phone_display ?? '',
      provider: moyen.provider,
      description: `Recharge wallet ${dto.amount} XOF`,
      webhook_url: `${webhookBase}/webhooks/payment-provider/${this.paymentProvider.name}`,
    });

    // 4.a Echec immédiat → marquer FAILED et 422
    if (providerResponse.status === 'FAILED' || providerResponse.status === 'REJECTED') {
      await this.prisma.transactions.update({
        where: { id: tx.id },
        data: {
          status: 'FAILED',
          provider_status: providerResponse.status,
          provider_ref: providerResponse.provider_ref,
          failed_reason: providerResponse.message ?? 'Provider refus',
        },
      });
      throw new UnprocessableEntityException(
        `Provider refus: ${providerResponse.message ?? providerResponse.status}`,
      );
    }

    // 4.b PENDING → la balance sera créditée par webhook (confirmTopup)
    if (providerResponse.status === 'PENDING' || providerResponse.status === 'TIMEOUT') {
      await this.prisma.transactions.update({
        where: { id: tx.id },
        data: {
          provider_ref: providerResponse.provider_ref,
          provider_status: providerResponse.status,
        },
      });
      return {
        transaction_id: tx.id,
        status: 'PENDING',
        provider_ref: providerResponse.provider_ref,
      };
    }

    // 5. ACCEPTED synchrone → créditer immédiatement
    return this.confirmTopup(tx.id, providerResponse.provider_ref);
  }

  /**
   * Confirme la recharge :
   *   • Soit appelée synchroniquement par topupWallet() si provider
   *     répond ACCEPTED immédiatement (mock).
   *   • Soit appelée par handleProviderWebhook() quand le vrai callback
   *     provider arrive plus tard avec status=ACCEPTED.
   *
   * Idempotente : si la TX est déjà SUCCESS, retourne l'état courant
   * sans recréditer (protège contre les webhooks dupliqués).
   */
  async confirmTopup(
    transactionId: string,
    providerRef: string,
  ): Promise<TopupWalletResponseDto> {
    return this.prisma.$transaction(async (prisma) => {
      const tx = await prisma.transactions.findUnique({
        where: { id: transactionId },
      });
      if (!tx) throw new NotFoundException('Transaction introuvable.');
      if (tx.type !== TransactionType.TOPUP) {
        throw new BadRequestException(
          `Transaction ${transactionId} n'est pas un TOPUP (${tx.type}).`,
        );
      }

      // Idempotence : déjà confirmée → retourner l'état actuel.
      if (tx.status === 'SUCCESS') {
        const w = await prisma.wallets.findUnique({
          where: { user_id_currency: { user_id: tx.user_id, currency: 'XOF' } },
        });
        return {
          transaction_id: tx.id,
          status: 'SUCCESS',
          provider_ref: tx.provider_ref ?? providerRef,
          new_balance: w?.balance.toNumber(),
        };
      }
      if (tx.status !== 'PENDING') {
        throw new ConflictException(`Statut invalide: ${tx.status}`);
      }

      // Verrouille le wallet + crédite atomiquement.
      const wallet = await this.lockWallet(prisma, tx.user_id);
      if (wallet.is_frozen) {
        throw new ForbiddenException('Wallet gelé.');
      }
      const balanceAvant = wallet.balance;
      const balanceApres = balanceAvant.plus(tx.montant);

      await prisma.wallets.update({
        where: { id: wallet.id },
        data: { balance: balanceApres },
      });
      await prisma.transactions.update({
        where: { id: tx.id },
        data: {
          status: 'SUCCESS',
          balance_avant: balanceAvant,
          balance_apres: balanceApres,
          provider_ref: providerRef,
          provider_status: 'ACCEPTED',
        },
      });

      // Notif info — fire-and-forget (best-effort, ne casse pas le crédit).
      try {
        await prisma.notifications.create({
          data: {
            user_id: tx.user_id,
            type: 'WALLET_TOPUP_SUCCESS',
            titre: 'Recharge confirmée',
            body: `Votre wallet a été rechargé de ${tx.montant} XOF.`,
            data: {
              transaction_id: tx.id,
              amount: tx.montant.toString(),
              new_balance: balanceApres.toString(),
            } as Prisma.InputJsonValue,
          },
        });
      } catch (e: any) {
        this.logger.warn(`Notif WALLET_TOPUP_SUCCESS KO: ${e?.message}`);
      }

      this.logger.log(
        `Topup confirmed: tx=${tx.id} user=${tx.user_id} amount=${tx.montant} balance=${balanceApres}`,
      );
      return {
        transaction_id: tx.id,
        status: 'SUCCESS',
        provider_ref: providerRef,
        new_balance: balanceApres.toNumber(),
      };
    });
  }

  /**
   * Lecture du statut d'une recharge (ownership enforced).
   */
  async getTopupStatus(userId: string, transactionId: string) {
    const tx = await this.prisma.transactions.findUnique({
      where: { id: transactionId },
    });
    if (!tx || tx.type !== TransactionType.TOPUP) {
      throw new NotFoundException('Transaction TOPUP introuvable.');
    }
    if (tx.user_id !== userId) {
      throw new ForbiddenException('Cette transaction ne vous appartient pas.');
    }
    return {
      transaction_id: tx.id,
      status: tx.status,
      provider_status: tx.provider_status,
      provider_ref: tx.provider_ref,
      amount: tx.montant,
      created_at: tx.created_at,
    };
  }

  // ===================================================================
  //  WEBHOOK PROVIDER (entrée Phase 1.5)
  //  ---------------------------------------------------------------------
  //  Reçoit la confirmation async d'un provider Mobile Money.
  //  Retrouve la transaction via idempotency_key, applique le résultat.
  //  Idempotent : si la TX est déjà en ESCROW/SUCCESS, ne refait rien.
  // ===================================================================

  async handleProviderWebhook(
    provider: string,
    payload: {
      provider_ref: string;
      idempotency_key: string;
      status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FAILED' | 'TIMEOUT';
      kind?: 'PAYIN' | 'PAYOUT' | 'TOPUP';
    },
  ) {
    const tx = await this.prisma.transactions.findFirst({
      where: { idempotency_key: payload.idempotency_key },
    });
    if (!tx) {
      this.logger.warn(
        `Webhook reçu pour idempotency_key inconnue: ${payload.idempotency_key}`,
      );
      return { received: true, applied: false, reason: 'TX_NOT_FOUND' };
    }

    // Idempotent : déjà traitée.
    if (tx.status === 'ESCROW' || tx.status === 'SUCCESS') {
      return { received: true, applied: false, reason: 'ALREADY_PROCESSED' };
    }

    if (payload.status === 'ACCEPTED' && tx.type === TransactionType.PAYIN) {
      // Délègue à confirmPayment (existe déjà, idempotent)
      await this.confirmPayment(tx.id, payload.provider_ref);
      return { received: true, applied: true, action: 'PAYIN_CONFIRMED' };
    }

    if (payload.status === 'ACCEPTED' && tx.type === TransactionType.TOPUP) {
      // Délègue à confirmTopup (idempotent : 2e webhook = no-op)
      await this.confirmTopup(tx.id, payload.provider_ref);
      return { received: true, applied: true, action: 'TOPUP_CONFIRMED' };
    }

    if (
      payload.status === 'FAILED' ||
      payload.status === 'REJECTED' ||
      payload.status === 'TIMEOUT'
    ) {
      await this.prisma.transactions.update({
        where: { id: tx.id },
        data: {
          status: 'FAILED',
          provider_status: payload.status,
          failed_reason: `Provider ${provider} returned ${payload.status}`,
        },
      });
      return { received: true, applied: true, action: 'TX_FAILED' };
    }

    return { received: true, applied: false, reason: 'NO_OP' };
  }

  async assignTransportEscrowBeneficiary(commandeId: string, transporterId: string) {
    const result = await this.prisma.escrow_conditions.updateMany({
      where: {
        commande_id: commandeId,
        kind: EscrowKind.TRANSPORT,
        status: 'LOCKED',
        beneficiary_id: null,
      },
      data: { beneficiary_id: transporterId },
    });
    if (result.count === 0) {
      this.logger.warn(
        `No TRANSPORT escrow to assign for commande ${commandeId}`,
      );
    }
    return result;
  }
}
