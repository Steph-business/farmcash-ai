// =====================================================================
//  SERVICE : AdminOversightService
//  ---------------------------------------------------------------------
//  Vue transverse pour les ADMIN FarmCash. Permet de :
//   • Voir le dashboard global de la plateforme (counts, totaux, alertes)
//   • Lister tous les users, transactions, commandes, disputes…
//   • Inspecter le profil complet d'un user (toutes ses activités)
//   • Geler/dégeler un wallet en cas de fraude
//   • Désactiver un compte utilisateur
//
//  Toutes les méthodes sont en LECTURE — sauf freezeWallet et
//  deactivateUser qui sont des actions sensibles, restreintes à ADMIN
//  au niveau du controller.
// =====================================================================

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import {
  FreezeWalletDto,
  ListOrdersQueryDto,
  ListTransactionsQueryDto,
  ListUsersQueryDto,
} from './dto/oversight.dto';
import { bucketByWeek, Period, periodSince } from './oversight-helpers';

const TREASURY_USER_ID = '00000000-0000-0000-0000-000000000001';

@Injectable()
export class AdminOversightService {
  private readonly logger = new Logger(AdminOversightService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Audit immuable des actions admin sensibles. Fire-and-forget :
   * le succès de l'action ne dépend pas du log.
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
      this.logger.warn(`admin_audit_log KO: ${e?.message}`);
    }
  }

  // ===================================================================
  //  DASHBOARD GLOBAL
  // ===================================================================

  /**
   * Tableau de bord ADMIN : un seul appel rassemble les KPIs.
   * Tous les comptages sont parallélisés pour minimiser la latence.
   */
  async getOverview() {
    const [
      usersByRole,
      activeUsers,
      lockedEscrow,
      ordersByStatus,
      openDisputes,
      activeAnnonces,
      activeShipments,
      pendingPayouts,
    ] = await Promise.all([
      this.prisma.users.groupBy({
        by: ['role'],
        _count: true,
      }),
      this.prisma.users.count({ where: { is_active: true } }),
      this.prisma.escrow_conditions.aggregate({
        where: { status: 'LOCKED' },
        _sum: { montant: true },
        _count: true,
      }),
      this.prisma.commandes_vente.groupBy({
        by: ['status'],
        _count: true,
      }),
      this.prisma.disputes.count({ where: { status: 'OPEN' } }),
      this.prisma.annonces_vente.count({ where: { status: 'ACTIVE' } }),
      this.prisma.shipments.count({
        where: { status: { in: ['REQUESTED', 'ACCEPTED', 'LOADING', 'IN_TRANSIT'] } },
      }),
      this.prisma.payout_batches.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      users: {
        total: usersByRole.reduce((acc, r) => acc + r._count, 0),
        active: activeUsers,
        by_role: usersByRole.reduce(
          (acc, r) => ({ ...acc, [r.role]: r._count }),
          {} as Record<string, number>,
        ),
      },
      finance: {
        escrow_locked_total_xof: lockedEscrow._sum.montant?.toNumber() ?? 0,
        escrow_locked_count: lockedEscrow._count,
        pending_payout_batches: pendingPayouts,
      },
      commerce: {
        active_annonces: activeAnnonces,
        active_shipments: activeShipments,
        orders_by_status: ordersByStatus.reduce(
          (acc, r) => ({ ...acc, [r.status]: r._count }),
          {} as Record<string, number>,
        ),
      },
      alerts: {
        open_disputes: openDisputes,
      },
    };
  }

  // ===================================================================
  //  USERS
  // ===================================================================

  async listUsers(query: ListUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.usersWhereInput = {
      ...(query.role && { role: query.role as any }),
      ...(query.search && {
        full_name: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.users.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          phone: true,
          email: true,
          full_name: true,
          role: true,
          is_active: true,
          is_verified: true,
          locked_until: true,
          rating: true,
          rating_count: true,
          last_login: true,
          created_at: true,
        },
      }),
      this.prisma.users.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Profil complet d'un user pour ADMIN. Inclut wallet, derniers ordres,
   * activité récente. Le pin_hash est exclu de la réponse.
   */
  async getUserProfile(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: {
        producteur_profiles: true,
        acheteur_profiles: true,
        cooperative_profiles: true,
        device_tokens: { where: { is_active: true } },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const [wallet, recentTransactions, asBuyer, asSeller] = await Promise.all([
      this.prisma.wallets.findUnique({
        where: { user_id_currency: { user_id: userId, currency: 'XOF' } },
      }),
      this.prisma.transactions.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
      this.prisma.commandes_vente.count({ where: { buyer_id: userId } }),
      this.prisma.commandes_vente.count({ where: { seller_id: userId } }),
    ]);

    const { pin_hash, ...safe } = user;
    void pin_hash;
    return {
      user: safe,
      wallet,
      recent_transactions: recentTransactions,
      orders_count: { as_buyer: asBuyer, as_seller: asSeller },
    };
  }

  // ===================================================================
  //  TRANSACTIONS
  // ===================================================================

  async listTransactions(query: ListTransactionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.transactionsWhereInput = {
      ...(query.type && { type: query.type }),
      ...(query.status && { status: query.status }),
      ...(query.user_id && { user_id: query.user_id }),
    };

    const [data, total, totalAmount] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          users: { select: { id: true, full_name: true, role: true } },
        },
      }),
      this.prisma.transactions.count({ where }),
      this.prisma.transactions.aggregate({
        where,
        _sum: { montant: true },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        last_page: Math.ceil(total / limit) || 1,
        total_amount_xof: totalAmount._sum.montant?.toNumber() ?? 0,
      },
    };
  }

  // ===================================================================
  //  ORDERS
  // ===================================================================

  async listOrders(query: ListOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.commandes_venteWhereInput = {
      ...(query.status && { status: query.status as any }),
    };

    const [data, total] = await Promise.all([
      this.prisma.commandes_vente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          users_commandes_vente_buyer_idTousers: {
            select: { full_name: true },
          },
          users_commandes_vente_seller_idTousers: {
            select: { full_name: true },
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

  // ===================================================================
  //  DISPUTES
  // ===================================================================

  async listOpenDisputes() {
    return this.prisma.disputes.findMany({
      where: { status: 'OPEN' },
      include: {
        commandes_vente: {
          select: {
            reference: true,
            buyer_id: true,
            seller_id: true,
            montant_total: true,
          },
        },
        users_disputes_opened_byTousers: {
          select: { id: true, full_name: true, role: true },
        },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  // ===================================================================
  //  ESCROWS BLOQUÉS
  // ===================================================================

  async listLockedEscrows() {
    return this.prisma.escrow_conditions.findMany({
      where: { status: 'LOCKED' },
      include: {
        commandes_vente: {
          select: { reference: true, status: true },
        },
      },
      orderBy: { locked_at: 'asc' },
      take: 100,
    });
  }

  // ===================================================================
  //  ACTIONS ADMIN (sensibles)
  // ===================================================================

  /**
   * Gèle un wallet : aucun débit ne sera autorisé tant que `is_frozen`
   * est true. Utilisé en cas de suspicion de fraude.
   */
  async freezeWallet(adminId: string, userId: string, dto: FreezeWalletDto) {
    const wallet = await this.prisma.wallets.findUnique({
      where: { user_id_currency: { user_id: userId, currency: 'XOF' } },
    });
    if (!wallet) throw new NotFoundException('Wallet introuvable.');

    await this.prisma.wallets.update({
      where: { id: wallet.id },
      data: { is_frozen: true },
    });
    this.logger.warn(
      `Wallet frozen: user=${userId} by=${adminId} reason=${dto.reason ?? 'unspecified'}`,
    );
    await this.logAdminAction(
      adminId,
      'WALLET_FREEZE',
      { type: 'user', id: userId },
      { reason: dto.reason ?? null },
    );
    return { message: 'Wallet gelé.', user_id: userId };
  }

  async unfreezeWallet(adminId: string, userId: string) {
    const wallet = await this.prisma.wallets.findUnique({
      where: { user_id_currency: { user_id: userId, currency: 'XOF' } },
    });
    if (!wallet) throw new NotFoundException('Wallet introuvable.');

    await this.prisma.wallets.update({
      where: { id: wallet.id },
      data: { is_frozen: false },
    });
    this.logger.log(`Wallet unfrozen: user=${userId} by=${adminId}`);
    await this.logAdminAction(
      adminId,
      'WALLET_UNFREEZE',
      { type: 'user', id: userId },
    );
    return { message: 'Wallet dégelé.', user_id: userId };
  }

  /**
   * Désactive un compte (is_active=false). L'utilisateur ne peut plus
   * se connecter ni effectuer d'actions. Tous ses tokens existants
   * sont aussi révoqués pour le déconnecter immédiatement.
   */
  async deactivateUser(adminId: string, userId: string) {
    if (adminId === userId) {
      throw new ForbiddenException('Un admin ne peut pas se désactiver lui-même.');
    }
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    // Anti-lockout : si la cible est un ADMIN, vérifier qu'il reste au
    // moins un autre admin actif APRÈS la désactivation.
    if (user.role === 'ADMIN') {
      const otherActiveAdmins = await this.prisma.users.count({
        where: {
          role: 'ADMIN',
          is_active: true,
          id: { not: userId },
        },
      });
      if (otherActiveAdmins === 0) {
        throw new ForbiddenException(
          'Impossible : désactiver le dernier admin actif verrouillerait la plateforme.',
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: userId },
        data: { is_active: false },
      }),
      this.prisma.refresh_tokens.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);

    this.logger.warn(`User deactivated: user=${userId} by=${adminId}`);
    await this.logAdminAction(
      adminId,
      'USER_DEACTIVATE',
      { type: 'user', id: userId },
      { role: user.role, phone: user.phone },
    );
    return { message: 'Utilisateur désactivé.', user_id: userId };
  }

  async reactivateUser(adminId: string, userId: string) {
    await this.prisma.users.update({
      where: { id: userId },
      data: { is_active: true },
    });
    this.logger.log(`User reactivated: user=${userId} by=${adminId}`);
    await this.logAdminAction(
      adminId,
      'USER_REACTIVATE',
      { type: 'user', id: userId },
    );
    return { message: 'Utilisateur réactivé.', user_id: userId };
  }

  // ===================================================================
  //  ENRICHISSEMENTS PHASE 2
  // ===================================================================

  /**
   * Revenu plateforme hebdo : somme des frais service (transactions FEE
   * sur TREASURY).
   */
  async revenueTimeline(period: Period = '30d') {
    const since = periodSince(period);
    const fees = await this.prisma.transactions.findMany({
      where: {
        user_id: TREASURY_USER_ID,
        type: 'FEE',
        created_at: { gte: since },
      },
      select: { created_at: true, montant: true },
    });
    const buckets = bucketByWeek(fees, (f) => f.created_at);
    const timeline = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, items]) => ({
        week,
        fees_xof: items.reduce((s, t) => s + Number(t.montant), 0),
        transactions: items.length,
      }));
    return {
      period,
      since: since.toISOString(),
      timeline,
      total_fees_xof: timeline.reduce((s, w) => s + w.fees_xof, 0),
    };
  }

  /**
   * Historique TREASURY : toutes les transactions FEE + RELEASE
   * (paiements sortants vers la coop / refunds) sur la période.
   */
  async treasuryHistory(period: Period = '30d') {
    const since = periodSince(period);
    const txs = await this.prisma.transactions.findMany({
      where: { user_id: TREASURY_USER_ID, created_at: { gte: since } },
      orderBy: { created_at: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        montant: true,
        balance_avant: true,
        balance_apres: true,
        description: true,
        commande_id: true,
        created_at: true,
      },
    });
    const wallet = await this.prisma.wallets.findUnique({
      where: {
        user_id_currency: { user_id: TREASURY_USER_ID, currency: 'XOF' },
      },
    });
    return {
      period,
      since: since.toISOString(),
      current_balance_xof: Number(wallet?.balance ?? 0),
      current_escrow_xof: Number(wallet?.balance_escrow ?? 0),
      transactions: txs,
    };
  }

  /**
   * Santé système : état des crons (derniers warnings), circuit breakers,
   * compteurs critiques (orphelins, drift potentiel).
   */
  async systemHealth() {
    const [
      circuitStates,
      pendingPayouts,
      orphanShipments,
      lockedEscrows,
      openDisputes,
      pendingJoinRequests,
      pendingTransactions,
    ] = await Promise.all([
      this.prisma.provider_circuit_state.findMany({
        orderBy: { provider: 'asc' },
      }),
      this.prisma.payout_batches.count({ where: { status: 'PENDING' } }),
      this.prisma.shipments.count({
        where: {
          status: 'REQUESTED',
          transporter_id: null,
          created_at: { lt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.escrow_conditions.count({ where: { status: 'LOCKED' } }),
      this.prisma.disputes.count({ where: { status: 'OPEN' } }),
      this.prisma.coop_join_requests.count({ where: { status: 'PENDING' } }),
      this.prisma.transactions.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      timestamp: new Date().toISOString(),
      providers: circuitStates.map((s) => ({
        provider: s.provider,
        state: s.state,
        failure_count: s.failure_count,
        last_failure_at: s.last_failure_at,
      })),
      alerts: {
        pending_payouts: pendingPayouts,
        orphan_shipments_48h: orphanShipments,
        locked_escrows: lockedEscrows,
        open_disputes: openDisputes,
        pending_join_requests: pendingJoinRequests,
        pending_transactions: pendingTransactions,
      },
    };
  }
}
