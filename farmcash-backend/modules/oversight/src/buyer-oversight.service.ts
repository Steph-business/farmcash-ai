// =====================================================================
//  SERVICE : BuyerOversightService
//  ---------------------------------------------------------------------
//  Dashboard agrégé pour les acheteurs locaux (rôle BUYER). Croise
//  commandes_vente + wallets + favoris + panier + candidatures pour
//  donner une vue résumée. Le détail reste accessible via les routes
//  des modules métier (Orders, Marketplace, Finance, Negotiation).
// =====================================================================

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { bucketByWeek, Period, periodSince } from './oversight-helpers';

@Injectable()
export class BuyerOversightService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tableau de bord BUYER : KPIs sur 30 jours + statuts en cours.
   */
  async getOverview(buyerId: string) {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      ordersByStatus,
      spend30d,
      pendingCandidatures,
      panier,
      favorisCount,
      walletBalance,
    ] = await Promise.all([
      this.prisma.commandes_vente.groupBy({
        by: ['status'],
        where: { buyer_id: buyerId },
        _count: true,
      }),
      this.prisma.commandes_vente.aggregate({
        where: {
          buyer_id: buyerId,
          created_at: { gte: since30d },
          status: { in: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED'] },
        },
        _sum: { montant_total: true },
        _count: true,
      }),
      this.prisma.candidatures_achat.count({
        where: {
          buyer_id: buyerId,
          status: { in: ['PENDING', 'COUNTER_OFFER'] },
        },
      }),
      this.prisma.panier.findUnique({
        where: { user_id: buyerId },
        include: { _count: { select: { panier_items: true } } },
      }),
      this.prisma.favoris.count({ where: { user_id: buyerId } }),
      this.prisma.wallets.findUnique({
        where: {
          user_id_currency: { user_id: buyerId, currency: 'XOF' },
        },
      }),
    ]);

    return {
      orders: {
        by_status: ordersByStatus.reduce(
          (acc, r) => ({ ...acc, [r.status]: r._count }),
          {} as Record<string, number>,
        ),
      },
      spending: {
        last_30d_xof: spend30d._sum.montant_total?.toNumber() ?? 0,
        orders_count_30d: spend30d._count,
      },
      pending: {
        candidatures: pendingCandidatures,
        panier_items: panier?._count?.panier_items ?? 0,
        favoris: favorisCount,
      },
      wallet: {
        balance_xof: walletBalance?.balance.toNumber() ?? 0,
        balance_escrow_xof: walletBalance?.balance_escrow.toNumber() ?? 0,
        is_frozen: walletBalance?.is_frozen ?? false,
      },
    };
  }

  /**
   * Top 5 produits les plus achetés par le buyer (par quantité totale).
   * Utile pour personnaliser le feed annonces.
   */
  async getTopProducts(buyerId: string) {
    const top = await this.prisma.commandes_vente.findMany({
      where: {
        buyer_id: buyerId,
        status: { in: ['DELIVERED', 'COMPLETED'] },
      },
      include: {
        annonces_vente: {
          select: {
            produit_id: true,
            produits_agricoles: { select: { nom: true } },
          },
        },
      },
      take: 100,
      orderBy: { created_at: 'desc' },
    });

    const counter = new Map<
      string,
      { produit_id: string; produit_nom: string; total_kg: number; count: number }
    >();
    for (const order of top) {
      const pid = order.annonces_vente?.produit_id;
      if (!pid) continue;
      const nom = order.annonces_vente?.produits_agricoles?.nom ?? '(inconnu)';
      const entry = counter.get(pid) ?? {
        produit_id: pid,
        produit_nom: nom,
        total_kg: 0,
        count: 0,
      };
      entry.total_kg += order.quantite_kg.toNumber();
      entry.count += 1;
      counter.set(pid, entry);
    }

    return [...counter.values()]
      .sort((a, b) => b.total_kg - a.total_kg)
      .slice(0, 5);
  }

  // ===================================================================
  //  ENRICHISSEMENTS PHASE 2
  // ===================================================================

  /** Dépenses hebdomadaires sur la période. */
  async spendingTimeline(buyerId: string, period: Period = '30d') {
    const since = periodSince(period);
    const orders = await this.prisma.commandes_vente.findMany({
      where: {
        buyer_id: buyerId,
        created_at: { gte: since },
        status: { in: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED'] },
      },
      select: { created_at: true, montant_total: true },
    });
    const buckets = bucketByWeek(orders, (o) => o.created_at);
    const timeline = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, items]) => ({
        week,
        xof: items.reduce((s, o) => s + Number(o.montant_total), 0),
        orders: items.length,
      }));
    return {
      period,
      since: since.toISOString(),
      timeline,
      total_xof: timeline.reduce((s, w) => s + w.xof, 0),
    };
  }

  /** Top sellers récurrents du buyer (par nb de commandes + montant). */
  async favoriteSellers(buyerId: string, limit = 10) {
    const grouped = await this.prisma.commandes_vente.groupBy({
      by: ['seller_id'],
      where: {
        buyer_id: buyerId,
        status: { in: ['DELIVERED', 'COMPLETED'] },
      },
      _sum: { montant_total: true },
      _count: true,
      orderBy: { _count: { seller_id: 'desc' } },
      take: limit,
    });
    if (grouped.length === 0) return [];

    const sellers = await this.prisma.users.findMany({
      where: { id: { in: grouped.map((g) => g.seller_id) } },
      select: {
        id: true,
        full_name: true,
        photo_url: true,
        rating: true,
        rating_count: true,
      },
    });
    const sellerMap = new Map(sellers.map((s) => [s.id, s]));

    return grouped.map((g) => ({
      seller: sellerMap.get(g.seller_id),
      orders_count: g._count,
      total_xof: Number(g._sum.montant_total ?? 0),
    }));
  }

  /** Commandes en cours détaillées (ACCEPTED/IN_PROGRESS/DELIVERED). */
  async activeOrders(buyerId: string) {
    return this.prisma.commandes_vente.findMany({
      where: {
        buyer_id: buyerId,
        status: { in: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED'] },
      },
      include: {
        annonces_vente: {
          select: { titre: true, produits_agricoles: { select: { nom: true } } },
        },
        users_commandes_vente_seller_idTousers: {
          select: { full_name: true, phone: true },
        },
        shipments: {
          select: { id: true, status: true, origin_zone: true, destination_zone: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
  }
}
