// =====================================================================
//  SERVICE : TransporterOversightService
//  ---------------------------------------------------------------------
//  Dashboard pour les transporteurs : revenus, missions, performance,
//  routes les plus rentables. Croise shipments + transactions + wallet
//  + transporter_routes.
// =====================================================================

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { bucketByWeek, Period, periodSince } from './oversight-helpers';

@Injectable()
export class TransporterOversightService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tableau de bord TRANSPORTER : KPIs revenus + missions + rating.
   */
  async getOverview(transporterId: string) {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      shipmentsByStatus,
      completedShipments,
      revenue30d,
      activeMissions,
      activeRoutes,
      walletBalance,
      user,
    ] = await Promise.all([
      this.prisma.shipments.groupBy({
        by: ['status'],
        where: { transporter_id: transporterId },
        _count: true,
      }),
      this.prisma.shipments.count({
        where: {
          transporter_id: transporterId,
          status: 'DELIVERED',
          delivered_at: { gte: since30d },
        },
      }),
      this.prisma.transactions.aggregate({
        where: {
          user_id: transporterId,
          type: 'RELEASE',
          created_at: { gte: since30d },
        },
        _sum: { montant: true },
      }),
      this.prisma.shipments.count({
        where: {
          transporter_id: transporterId,
          status: { in: ['ACCEPTED', 'LOADING', 'IN_TRANSIT'] },
        },
      }),
      this.prisma.transporter_routes.count({
        where: { transporter_id: transporterId, is_active: true },
      }),
      this.prisma.wallets.findUnique({
        where: {
          user_id_currency: { user_id: transporterId, currency: 'XOF' },
        },
      }),
      this.prisma.users.findUnique({
        where: { id: transporterId },
        select: { rating: true, rating_count: true },
      }),
    ]);

    return {
      missions: {
        by_status: shipmentsByStatus.reduce(
          (acc, r) => ({ ...acc, [r.status]: r._count }),
          {} as Record<string, number>,
        ),
        completed_30d: completedShipments,
        active: activeMissions,
      },
      revenue: {
        last_30d_xof: revenue30d._sum.montant?.toNumber() ?? 0,
      },
      routes: {
        active_count: activeRoutes,
      },
      rating: {
        average: user?.rating.toNumber() ?? 0,
        count: user?.rating_count ?? 0,
      },
      wallet: {
        balance_xof: walletBalance?.balance.toNumber() ?? 0,
        is_frozen: walletBalance?.is_frozen ?? false,
      },
    };
  }

  /**
   * Top routes du transporter par revenus générés. Utile pour décider
   * de moduler les tarifs (saison des pluies, etc.).
   */
  async getTopRoutes(transporterId: string) {
    const shipments = await this.prisma.shipments.findMany({
      where: { transporter_id: transporterId, status: 'DELIVERED' },
      select: {
        origin_zone: true,
        destination_zone: true,
        prix_final: true,
      },
      orderBy: { delivered_at: 'desc' },
      take: 200,
    });

    const counter = new Map<
      string,
      { origin: string; destination: string; revenue: number; count: number }
    >();
    for (const s of shipments) {
      if (!s.origin_zone || !s.destination_zone) continue;
      const key = `${s.origin_zone}→${s.destination_zone}`;
      const entry = counter.get(key) ?? {
        origin: s.origin_zone,
        destination: s.destination_zone,
        revenue: 0,
        count: 0,
      };
      entry.revenue += s.prix_final?.toNumber() ?? 0;
      entry.count += 1;
      counter.set(key, entry);
    }

    return [...counter.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }

  // ===================================================================
  //  ENRICHISSEMENTS PHASE 2
  // ===================================================================

  /** Revenus hebdomadaires du transporter sur la période. */
  async earningsTimeline(transporterId: string, period: Period = '30d') {
    const since = periodSince(period);
    const txs = await this.prisma.transactions.findMany({
      where: {
        user_id: transporterId,
        type: 'RELEASE',
        created_at: { gte: since },
      },
      select: { created_at: true, montant: true },
    });
    const buckets = bucketByWeek(txs, (t) => t.created_at);
    const timeline = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, items]) => ({
        week,
        xof: items.reduce((s, t) => s + Number(t.montant), 0),
        deliveries: items.length,
      }));
    return {
      period,
      since: since.toISOString(),
      timeline,
      total_xof: timeline.reduce((s, w) => s + w.xof, 0),
    };
  }

  /**
   * Stats de performance livraison : temps moyen, taux d'achèvement.
   */
  async deliveryStats(transporterId: string, period: Period = '30d') {
    const since = periodSince(period);
    const shipments = await this.prisma.shipments.findMany({
      where: {
        transporter_id: transporterId,
        created_at: { gte: since },
      },
      select: { status: true, created_at: true, delivered_at: true },
    });

    const total = shipments.length;
    const delivered = shipments.filter((s) => s.status === 'DELIVERED');
    const cancelled = shipments.filter((s) => s.status === 'CANCELLED');

    // Temps moyen accept → livré (en heures)
    const deliveryDurations = delivered
      .filter((s) => s.created_at && s.delivered_at)
      .map(
        (s) =>
          (s.delivered_at!.getTime() - s.created_at.getTime()) / (60 * 60 * 1000),
      );
    const avgHours = deliveryDurations.length
      ? Math.round(
          (deliveryDurations.reduce((a, b) => a + b, 0) /
            deliveryDurations.length) *
            10,
        ) / 10
      : 0;

    return {
      period,
      since: since.toISOString(),
      total_missions: total,
      delivered: delivered.length,
      cancelled: cancelled.length,
      completion_rate_pct:
        total > 0 ? Math.round((delivered.length / total) * 1000) / 10 : 0,
      avg_delivery_hours: avgHours,
    };
  }

  /** Actions en attente pour le transporter. */
  async pendingActions(transporterId: string) {
    const [missionsToAccept, toLoad, inTransit] = await Promise.all([
      // Missions REQUESTED matchant ses routes actives
      this.prisma.shipments.count({
        where: { transporter_id: null, status: 'REQUESTED' },
        // Note : le matching route est fait dans logistics.getAvailableMissions.
        // Ici on retourne le count brut, le mobile filtrera côté détails.
      }),
      this.prisma.shipments.count({
        where: { transporter_id: transporterId, status: 'ACCEPTED' },
      }),
      this.prisma.shipments.count({
        where: {
          transporter_id: transporterId,
          status: { in: ['LOADING', 'IN_TRANSIT'] },
        },
      }),
    ]);

    return {
      missions_available: missionsToAccept,
      to_load: toLoad,
      in_transit: inTransit,
      total: missionsToAccept + toLoad + inTransit,
    };
  }
}
