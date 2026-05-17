// =====================================================================
//  SERVICE : FarmerOversightService
//  ---------------------------------------------------------------------
//  Dashboard pour les producteurs : ventes, conversion annonces →
//  commandes, état de santé des cultures (alertes plant_analyses),
//  commandes à expédier.
// =====================================================================

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import {
  bucketByWeek,
  Period,
  periodSince,
} from './oversight-helpers';

@Injectable()
export class FarmerOversightService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(farmerId: string) {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      activeAnnonces,
      totalViews,
      revenue30d,
      ordersToShip,
      pendingCandidatures,
      criticalAnalyses,
      parcelleCount,
      walletBalance,
      user,
    ] = await Promise.all([
      this.prisma.annonces_vente.count({
        where: { farmer_id: farmerId, status: 'ACTIVE' },
      }),
      this.prisma.annonces_vente.aggregate({
        where: { farmer_id: farmerId },
        _sum: { views_count: true },
      }),
      this.prisma.commandes_vente.aggregate({
        where: {
          seller_id: farmerId,
          status: 'COMPLETED',
          created_at: { gte: since30d },
        },
        _sum: { montant_net: true },
        _count: true,
      }),
      this.prisma.commandes_vente.count({
        where: {
          seller_id: farmerId,
          status: { in: ['ACCEPTED', 'IN_PROGRESS'] },
        },
      }),
      this.prisma.candidatures_achat.count({
        where: {
          annonces_vente: { farmer_id: farmerId },
          status: 'PENDING',
        },
      }),
      this.prisma.plant_analyses.count({
        where: {
          farmer_id: farmerId,
          risk_level: { in: ['HIGH', 'CRITICAL'] },
          created_at: { gte: since30d },
        },
      }),
      this.prisma.parcelle.count({ where: { user_id: farmerId } }),
      this.prisma.wallets.findUnique({
        where: {
          user_id_currency: { user_id: farmerId, currency: 'XOF' },
        },
      }),
      this.prisma.users.findUnique({
        where: { id: farmerId },
        select: { rating: true, rating_count: true },
      }),
    ]);

    return {
      commerce: {
        active_annonces: activeAnnonces,
        total_views: totalViews._sum.views_count ?? 0,
        orders_to_ship: ordersToShip,
        pending_candidatures: pendingCandidatures,
      },
      revenue: {
        last_30d_xof: revenue30d._sum.montant_net?.toNumber() ?? 0,
        orders_completed_30d: revenue30d._count,
      },
      cultures: {
        parcelles_count: parcelleCount,
        critical_analyses_30d: criticalAnalyses,
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
   * Funnel de conversion : pour chaque annonce active, donne le
   * compte de vues, candidatures reçues, commandes effectives.
   * Permet au FARMER d'identifier ses annonces les plus efficaces.
   */
  async getConversionFunnel(farmerId: string) {
    const annonces = await this.prisma.annonces_vente.findMany({
      where: { farmer_id: farmerId, status: 'ACTIVE' },
      select: {
        id: true,
        titre: true,
        views_count: true,
        _count: {
          select: {
            candidatures_achat: true,
            commandes_vente: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    return annonces.map((a) => ({
      annonce_id: a.id,
      titre: a.titre,
      views: a.views_count,
      candidatures: a._count.candidatures_achat,
      orders: a._count.commandes_vente,
      conversion_rate:
        a.views_count > 0
          ? Math.round((a._count.commandes_vente / a.views_count) * 10000) / 100
          : 0,
    }));
  }

  // ===================================================================
  //  ENRICHISSEMENTS PHASE 2
  // ===================================================================

  /**
   * Revenu hebdomadaire, séparé en :
   *   • direct (annonce vente sans coop)
   *   • via_coop (publication coop redistribuée au farmer)
   * Sur la période demandée (défaut 30j).
   */
  async revenueTimeline(farmerId: string, period: Period = '30d') {
    const since = periodSince(period);

    // Revenus directs : commandes COMPLETED où farmer est seller et pas via coop
    const directOrders = await this.prisma.commandes_vente.findMany({
      where: {
        seller_id: farmerId,
        status: 'COMPLETED',
        created_at: { gte: since },
        from_reservation_id: null, // exclut les conversions prévision
        publication_coop_id: null,  // exclut les ventes coop
      },
      select: { created_at: true, montant_net: true },
    });

    // Revenus via coop : publication_contributions payées
    const coopContribs = await this.prisma.publication_contributions.findMany({
      where: {
        farmer_id: farmerId,
        paid_at: { not: null, gte: since },
      },
      select: { paid_at: true, paid_amount: true },
    });

    const directBuckets = bucketByWeek(directOrders, (o) => o.created_at);
    const coopBuckets = bucketByWeek(coopContribs, (c) => c.paid_at);

    const allWeeks = new Set([...directBuckets.keys(), ...coopBuckets.keys()]);
    const timeline = [...allWeeks]
      .sort()
      .map((week) => ({
        week,
        direct_xof: (directBuckets.get(week) ?? []).reduce(
          (s, o) => s + Number(o.montant_net),
          0,
        ),
        via_coop_xof: (coopBuckets.get(week) ?? []).reduce(
          (s, c) => s + Number(c.paid_amount ?? 0),
          0,
        ),
      }));

    return {
      period,
      since: since.toISOString(),
      timeline,
      totals: {
        direct_xof: timeline.reduce((s, w) => s + w.direct_xof, 0),
        via_coop_xof: timeline.reduce((s, w) => s + w.via_coop_xof, 0),
      },
    };
  }

  /**
   * Top N acheteurs récurrents du farmer (lifetime value).
   * Agrège toutes les commandes COMPLETED, groupe par buyer_id.
   */
  async topBuyers(farmerId: string, limit = 10) {
    const grouped = await this.prisma.commandes_vente.groupBy({
      by: ['buyer_id'],
      where: { seller_id: farmerId, status: 'COMPLETED' },
      _sum: { montant_net: true, quantite_kg: true },
      _count: true,
      orderBy: { _sum: { montant_net: 'desc' } },
      take: limit,
    });

    if (grouped.length === 0) return [];

    const buyers = await this.prisma.users.findMany({
      where: { id: { in: grouped.map((g) => g.buyer_id) } },
      select: { id: true, full_name: true, phone: true, photo_url: true },
    });
    const buyerMap = new Map(buyers.map((b) => [b.id, b]));

    return grouped.map((g) => ({
      buyer: buyerMap.get(g.buyer_id),
      orders_count: g._count,
      total_kg: Number(g._sum.quantite_kg ?? 0),
      total_xof: Number(g._sum.montant_net ?? 0),
    }));
  }

  /**
   * Alertes santé cultures : analyses plantes HIGH/CRITICAL récentes.
   * Inclut un suggested_treatments pour chaque (croisé avec catalogue).
   */
  async healthAlerts(farmerId: string) {
    const recent = await this.prisma.plant_analyses.findMany({
      where: {
        farmer_id: farmerId,
        risk_level: { in: ['HIGH', 'CRITICAL'] },
        created_at: { gte: periodSince('30d') },
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: {
        parcelle: { select: { id: true, nom: true } },
        produits_agricoles: { select: { nom: true } },
      },
    });

    // Pour chaque maladie détectée, propose des traitements (max 3 par maladie)
    const results: Array<{
      analysis_id: string;
      date: Date;
      disease: string | null;
      risk_level: string | null;
      confidence: number;
      parcelle: { id: string; nom: string | null } | null;
      produit: string | undefined;
      suggested_treatments: { id: string; nom: string; type: string | null; delai_carence_j: number | null }[];
    }> = [];
    for (const analysis of recent) {
      let suggestions: { id: string; nom: string; type: string | null; delai_carence_j: number | null }[] = [];
      if (analysis.disease_detected) {
        suggestions = await this.prisma.produits_traitement.findMany({
          where: { maladies_cibles: { has: analysis.disease_detected } },
          select: { id: true, nom: true, type: true, delai_carence_j: true },
          take: 3,
        });
      }
      results.push({
        analysis_id: analysis.id,
        date: analysis.created_at,
        disease: analysis.disease_detected,
        risk_level: analysis.risk_level,
        confidence: Number(analysis.confidence_score ?? 0),
        parcelle: analysis.parcelle,
        produit: analysis.produits_agricoles?.nom,
        suggested_treatments: suggestions,
      });
    }
    return results;
  }

  /**
   * Actions en attente pour le farmer (mini-todo board).
   */
  async pendingActions(farmerId: string) {
    const [
      candidaturesToHandle,
      ordersToShip,
      previsionsToConvert,
      annoncesPendingCoop,
    ] = await Promise.all([
      // Candidatures reçues à traiter
      this.prisma.candidatures_achat.count({
        where: {
          annonces_vente: { farmer_id: farmerId },
          status: { in: ['PENDING', 'COUNTER_OFFER'] },
        },
      }),
      // Commandes ACCEPTED ou IN_PROGRESS à livrer
      this.prisma.commandes_vente.count({
        where: {
          seller_id: farmerId,
          status: { in: ['ACCEPTED', 'IN_PROGRESS'] },
        },
      }),
      // Prévisions OPEN dont la date approche (< 14 jours)
      this.prisma.previsions_production.count({
        where: {
          farmer_id: farmerId,
          status: 'OPEN',
          date_recolte_prev: {
            lte: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      // Annonces assignées à une coop en attente de validation
      this.prisma.annonces_vente.count({
        where: { farmer_id: farmerId, coop_status: 'PENDING' },
      }),
    ]);

    return {
      candidatures_to_handle: candidaturesToHandle,
      orders_to_ship: ordersToShip,
      previsions_to_convert_soon: previsionsToConvert,
      annonces_pending_coop: annoncesPendingCoop,
      total: candidaturesToHandle + ordersToShip + previsionsToConvert + annoncesPendingCoop,
    };
  }
}
