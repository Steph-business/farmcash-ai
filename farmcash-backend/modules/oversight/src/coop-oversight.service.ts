// =====================================================================
//  SERVICE : CoopOversightService
//  ---------------------------------------------------------------------
//  Vue agrégée des membres d'une coopérative pour le responsable COOP.
//
//  Périmètre :
//   • Liste des membres (table `cooperative_members`)
//   • Stats globales (nb membres, total ventes des membres, top produits)
//   • Annonces actives des membres (utile pour aider la coop à agréger)
//   • Commandes en cours impliquant les membres
//   • Publications coop propres
//
//  Le COOP ne voit JAMAIS le wallet/PIN/transactions privées de ses
//  membres — il voit l'activité publique (annonces, statut commandes).
// =====================================================================

import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { PaginationQueryDto } from './dto/oversight.dto';
import { bucketByWeek, Period, periodSince } from './oversight-helpers';

@Injectable()
export class CoopOversightService {
  private readonly logger = new Logger(CoopOversightService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tableau de bord COOP : KPIs des membres + activité.
   * @param coopId UUID du cooperative_profiles (extrait du JWT)
   */
  async getOverview(coopId: string | null) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coopérative.');

    const memberIds = await this.getMemberIds(coopId);

    if (memberIds.length === 0) {
      return {
        members: { total: 0, active: 0 },
        commerce: {
          active_annonces: 0,
          completed_orders_30d: 0,
          revenue_30d_xof: 0,
        },
        publications_coop: 0,
        workflow: { pending_validation: 0, validated_pending_aggregation: 0, included: 0 },
        advances: { outstanding_count: 0, outstanding_amount: 0, reimbursed_30d: 0 },
        pending_join_requests: 0,
      };
    }

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      activeMembers,
      activeAnnonces,
      completedOrders,
      pubsCoop,
      pendingAnnonces,
      validatedAnnonces,
      includedAnnonces,
      outstandingAdvances,
      reimbursedAdvances30d,
      pendingJoinRequests,
    ] = await Promise.all([
      this.prisma.cooperative_members.count({
        where: { cooperative_id: coopId, is_active: true },
      }),
      this.prisma.annonces_vente.count({
        where: { farmer_id: { in: memberIds }, status: 'ACTIVE' },
      }),
      this.prisma.commandes_vente.aggregate({
        where: {
          seller_id: { in: memberIds },
          status: 'COMPLETED',
          created_at: { gte: since30d },
        },
        _count: true,
        _sum: { montant_net: true },
      }),
      this.prisma.publications_stock_coop.count({
        where: { cooperative_id: coopId, is_active: true },
      }),
      this.prisma.annonces_vente.count({
        where: { assigned_to_cooperative_id: coopId, coop_status: 'PENDING' },
      }),
      this.prisma.annonces_vente.count({
        where: { assigned_to_cooperative_id: coopId, coop_status: 'VALIDATED' },
      }),
      this.prisma.annonces_vente.count({
        where: { assigned_to_cooperative_id: coopId, coop_status: 'INCLUDED' },
      }),
      this.prisma.coop_advance_payments.aggregate({
        where: { cooperative_id: coopId, status: 'PAID' },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.coop_advance_payments.aggregate({
        where: {
          cooperative_id: coopId,
          status: 'REIMBURSED',
          reimbursed_at: { gte: since30d },
        },
        _sum: { amount: true },
      }),
      this.prisma.coop_join_requests.count({
        where: { cooperative_id: coopId, status: 'PENDING' },
      }),
    ]);

    return {
      members: { total: memberIds.length, active: activeMembers },
      commerce: {
        active_annonces: activeAnnonces,
        completed_orders_30d: completedOrders._count,
        revenue_30d_xof: completedOrders._sum.montant_net?.toNumber() ?? 0,
      },
      publications_coop: pubsCoop,
      workflow: {
        pending_validation: pendingAnnonces,
        validated_pending_aggregation: validatedAnnonces,
        included: includedAnnonces,
      },
      advances: {
        outstanding_count: outstandingAdvances._count,
        outstanding_amount: Number(outstandingAdvances._sum.amount ?? 0),
        reimbursed_30d: Number(reimbursedAdvances30d._sum.amount ?? 0),
      },
      pending_join_requests: pendingJoinRequests,
    };
  }

  /**
   * Liste paginée des membres de la coop avec leurs infos publiques
   * + leur dernière activité.
   */
  async listMembers(coopId: string | null, query: PaginationQueryDto) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coopérative.');

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.cooperative_membersWhereInput = {
      cooperative_id: coopId,
    };

    const [data, total] = await Promise.all([
      this.prisma.cooperative_members.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date_adhesion: 'desc' },
        include: {
          users: {
            select: {
              id: true,
              full_name: true,
              phone: true,
              rating: true,
              rating_count: true,
              is_active: true,
              last_login: true,
            },
          },
        },
      }),
      this.prisma.cooperative_members.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Liste les annonces de vente actives des membres de la coop. Utile
   * pour identifier les volumes disponibles à agréger en publication
   * coopérative.
   */
  async listMemberAnnonces(coopId: string | null, query: PaginationQueryDto) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coopérative.');
    const memberIds = await this.getMemberIds(coopId);
    if (memberIds.length === 0) return this.emptyPage(query);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.annonces_venteWhereInput = {
      farmer_id: { in: memberIds },
      status: 'ACTIVE',
    };

    const [data, total] = await Promise.all([
      this.prisma.annonces_vente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          users: { select: { id: true, full_name: true } },
          produits_agricoles: { select: { nom: true, unite_mesure: true } },
        },
      }),
      this.prisma.annonces_vente.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Liste les commandes en cours impliquant les membres (en tant que
   * seller). Permet à la coop de voir l'activité commerciale.
   */
  async listMemberOrders(coopId: string | null, query: PaginationQueryDto) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coopérative.');
    const memberIds = await this.getMemberIds(coopId);
    if (memberIds.length === 0) return this.emptyPage(query);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.commandes_venteWhereInput = {
      seller_id: { in: memberIds },
    };

    const [data, total] = await Promise.all([
      this.prisma.commandes_vente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          users_commandes_vente_seller_idTousers: {
            select: { id: true, full_name: true },
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

  // -------------------------------------------------------------------
  //  Helpers privés
  // -------------------------------------------------------------------

  /**
   * Charge la liste des user_id actifs de la coopérative.
   */
  private async getMemberIds(coopId: string): Promise<string[]> {
    const members = await this.prisma.cooperative_members.findMany({
      where: { cooperative_id: coopId, is_active: true },
      select: { member_id: true },
    });
    return members.map((m) => m.member_id);
  }

  private emptyPage(query: PaginationQueryDto) {
    return {
      data: [],
      meta: {
        total: 0,
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        last_page: 1,
      },
    };
  }

  // ===================================================================
  //  ENRICHISSEMENTS PHASE 2
  // ===================================================================

  /**
   * Revenu coop hebdo : commissions encaissées + ventes des publications.
   */
  async revenueTimeline(coopId: string | null, period: Period = '30d') {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coop.');
    const since = periodSince(period);
    const memberIds = await this.getMemberIds(coopId);

    const coopProfile = await this.prisma.cooperative_profiles.findUnique({
      where: { id: coopId },
      select: { user_id: true, commission_rate: true },
    });

    // Commissions encaissées : transactions FEE de TREASURY... non, en fait
    // la coop reçoit du fric quand l'escrow PRODUCT release vers son user_id.
    // On regarde les RELEASE crédités au user_id de la coop.
    const releases = await this.prisma.transactions.findMany({
      where: {
        user_id: coopProfile?.user_id,
        type: 'RELEASE',
        created_at: { gte: since },
      },
      select: { created_at: true, montant: true },
    });

    const buckets = bucketByWeek(releases, (t) => t.created_at);
    const timeline = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, items]) => ({
        week,
        revenue_xof: items.reduce((s, t) => s + Number(t.montant), 0),
        sales_count: items.length,
      }));

    return {
      period,
      since: since.toISOString(),
      members_count: memberIds.length,
      commission_rate: Number(coopProfile?.commission_rate ?? 0),
      timeline,
      total_xof: timeline.reduce((s, w) => s + w.revenue_xof, 0),
    };
  }

  /**
   * Top contributeurs (membres) sur la période, ordonnés par quantité
   * livrée totale (somme publication_contributions). Inclut le revenu
   * touché par chaque membre.
   */
  async topContributors(coopId: string | null, period: Period = '30d', limit = 10) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coop.');
    const since = periodSince(period);

    const grouped = await this.prisma.publication_contributions.groupBy({
      by: ['farmer_id'],
      where: {
        publication_id: {
          in: (
            await this.prisma.publications_stock_coop.findMany({
              where: { cooperative_id: coopId, created_at: { gte: since } },
              select: { id: true },
            })
          ).map((p) => p.id),
        },
      },
      _sum: { quantite_kg: true, paid_amount: true },
      _count: true,
      orderBy: { _sum: { quantite_kg: 'desc' } },
      take: limit,
    });

    if (grouped.length === 0) return [];
    const farmers = await this.prisma.users.findMany({
      where: { id: { in: grouped.map((g) => g.farmer_id) } },
      select: { id: true, full_name: true, phone: true, photo_url: true },
    });
    const farmerMap = new Map(farmers.map((f) => [f.id, f]));

    return grouped.map((g) => ({
      farmer: farmerMap.get(g.farmer_id),
      contributions_count: g._count,
      total_kg: Number(g._sum.quantite_kg ?? 0),
      total_received_xof: Number(g._sum.paid_amount ?? 0),
    }));
  }

  /**
   * Prévisions OPEN dont la date de récolte approche (< 14 jours).
   * Alerte au gérant pour déclencher la conversion à temps.
   */
  async upcomingConversions(coopId: string | null) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coop.');
    const memberIds = await this.getMemberIds(coopId);
    const upcomingThreshold = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    return this.prisma.previsions_production.findMany({
      where: {
        farmer_id: { in: memberIds },
        status: 'OPEN',
        date_recolte_prev: { lte: upcomingThreshold, gte: new Date() },
      },
      include: {
        users: { select: { id: true, full_name: true, phone: true } },
        produits_agricoles: { select: { nom: true } },
        reservations_previsions: {
          where: { status: 'CONFIRMED' },
          select: { quantite_kg: true, deposit_amount: true },
        },
      },
      orderBy: { date_recolte_prev: 'asc' },
    });
  }

  /**
   * Aging des avances coop encore PAID (non remboursées).
   * 4 tranches : 0-30j, 30-60j, 60-90j, 90j+.
   */
  async advancesAging(coopId: string | null) {
    if (!coopId) throw new BadRequestException('Compte non rattaché à une coop.');
    const advances = await this.prisma.coop_advance_payments.findMany({
      where: { cooperative_id: coopId, status: 'PAID' },
      select: { id: true, amount: true, paid_at: true, farmer_id: true },
    });

    const now = Date.now();
    const buckets = {
      '0-30d': { count: 0, amount: 0 },
      '30-60d': { count: 0, amount: 0 },
      '60-90d': { count: 0, amount: 0 },
      '90d+': { count: 0, amount: 0 },
    };
    for (const a of advances) {
      const ageDays = (now - a.paid_at.getTime()) / (24 * 60 * 60 * 1000);
      const amount = Number(a.amount);
      const bucket =
        ageDays <= 30
          ? '0-30d'
          : ageDays <= 60
            ? '30-60d'
            : ageDays <= 90
              ? '60-90d'
              : '90d+';
      buckets[bucket].count += 1;
      buckets[bucket].amount += amount;
    }

    return {
      total_count: advances.length,
      total_amount: advances.reduce((s, a) => s + Number(a.amount), 0),
      aging: buckets,
    };
  }
}
