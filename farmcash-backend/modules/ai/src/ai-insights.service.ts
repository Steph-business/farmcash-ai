// =====================================================================
//  SERVICE : AiInsightsService
//  ---------------------------------------------------------------------
//  Calcule des insights personnalisés pour un user en croisant ses
//  données (parcelles, historique commandes, région) avec les tendances
//  agrégées du marché.
//
//  En MVP : calculs SQL agrégés simples (moyennes de prix par produit
//  sur 30 jours, nb d'analyses récentes par maladie dans la région).
//  Plus tard : ML / personnalisation avancée.
//
//  Le résultat est une liste de "cartes d'insight" (style dashboard
//  swipable côté mobile).
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';

export interface InsightCard {
  /** Identifiant logique (utile pour le dismiss côté front). */
  id: string;
  /** Catégorie (PRICE, DISEASE, WEATHER, OPPORTUNITY, ADVICE). */
  type: string;
  titre: string;
  body: string;
  /** Icône / emoji pour l'affichage mobile. */
  icon?: string;
  /** Severity : INFO | WARNING | CRITICAL */
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  /** Action suggérée (deep link côté app). */
  action?: { label: string; route: string };
}

@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les insights pertinents pour le user connecté, basés sur
   * son rôle, sa région et son activité récente.
   */
  async getMyInsights(userId: string): Promise<InsightCard[]> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) return [];

    const cards: InsightCard[] = [];

    if (user.role === 'FARMER') {
      cards.push(...(await this.farmerInsights(userId)));
    } else if (user.role === 'BUYER') {
      cards.push(...(await this.buyerInsights(userId)));
    } else if (user.role === 'COOPERATIVE') {
      cards.push(...(await this.coopInsights(userId)));
    }

    return cards;
  }

  // -------------------------------------------------------------------
  //  Calculs par rôle
  // -------------------------------------------------------------------

  /**
   * Pour les FARMERS : tendances prix sur leurs produits, alertes
   * maladie dans leur région, opportunités de vente.
   */
  private async farmerInsights(userId: string): Promise<InsightCard[]> {
    const cards: InsightCard[] = [];

    // Carte 1 : tendance de prix moyenne sur les commandes des 30 derniers jours.
    const recent = await this.prisma.commandes_vente.aggregate({
      where: {
        created_at: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
        status: { in: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED'] },
      },
      _avg: { prix_unitaire_kg: true },
      _count: true,
    });
    if (recent._count > 0 && recent._avg.prix_unitaire_kg) {
      cards.push({
        id: 'price-trend-30d',
        type: 'PRICE',
        titre: '📈 Tendance prix marché',
        body: `Prix moyen plateforme sur 30 jours : ${recent._avg.prix_unitaire_kg.toFixed(0)} FCFA/kg (${recent._count} ventes).`,
        icon: '📊',
        severity: 'INFO',
      });
    }

    // Carte 2 : alertes maladies détectées récemment dans la même région
    // (à raffiner quand le user aura un region_id sur producteur_profiles).
    const recentAnalyses = await this.prisma.plant_analyses.findMany({
      where: {
        created_at: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        risk_level: { in: ['HIGH', 'CRITICAL'] },
        disease_detected: { not: null },
      },
      select: { disease_detected: true },
      take: 50,
    });
    const diseaseCount = new Map<string, number>();
    for (const a of recentAnalyses) {
      const d = a.disease_detected!;
      diseaseCount.set(d, (diseaseCount.get(d) ?? 0) + 1);
    }
    const topDisease = [...diseaseCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDisease && topDisease[1] >= 2) {
      cards.push({
        id: 'disease-alert',
        type: 'DISEASE',
        titre: '⚠️ Alerte maladie',
        body: `${topDisease[0]} détecté ${topDisease[1]} fois ces 2 dernières semaines. Surveillez vos plantes et utilisez le diagnostic IA.`,
        icon: '🦠',
        severity: 'WARNING',
        action: { label: 'Analyser une plante', route: '/ai/plant-analyses' },
      });
    }

    // Carte 3 : suggestion de publier une annonce si pas d'activité récente.
    const recentSale = await this.prisma.annonces_vente.count({
      where: {
        farmer_id: userId,
        status: 'ACTIVE',
        created_at: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
    if (recentSale === 0) {
      cards.push({
        id: 'publish-suggestion',
        type: 'OPPORTUNITY',
        titre: '💡 Publiez votre récolte',
        body: "Vous n'avez pas publié d'annonce depuis 30 jours. Le marché est actif — c'est le bon moment.",
        icon: '🌱',
        severity: 'INFO',
        action: { label: 'Publier', route: '/ai/assistant/chat' },
      });
    }

    return cards;
  }

  /**
   * Pour les BUYERS : annonces actives matching leurs précédents achats,
   * tendances prix favorables.
   */
  private async buyerInsights(userId: string): Promise<InsightCard[]> {
    const cards: InsightCard[] = [];

    const lastOrders = await this.prisma.commandes_vente.findMany({
      where: { buyer_id: userId },
      orderBy: { created_at: 'desc' },
      take: 5,
      include: { annonces_vente: { select: { produit_id: true } } },
    });
    const produitIds = [
      ...new Set(
        lastOrders
          .map((o) => o.annonces_vente?.produit_id)
          .filter((id): id is string => !!id),
      ),
    ];

    if (produitIds.length > 0) {
      const available = await this.prisma.annonces_vente.count({
        where: { produit_id: { in: produitIds }, status: 'ACTIVE' },
      });
      cards.push({
        id: 'similar-listings',
        type: 'OPPORTUNITY',
        titre: '🛒 Annonces pour vous',
        body: `${available} annonce(s) active(s) sur vos produits habituels.`,
        icon: '🛍️',
        severity: 'INFO',
        action: { label: 'Voir', route: '/marketplace/annonces/vente' },
      });
    }
    return cards;
  }

  /**
   * Pour les COOPS : agrégation de leurs membres (nb annonces, nb
   * commandes en cours, alertes membres).
   */
  private async coopInsights(userId: string): Promise<InsightCard[]> {
    const cards: InsightCard[] = [];
    // Stub : à enrichir quand on aura le module oversight + les vues coop.
    cards.push({
      id: 'coop-welcome',
      type: 'ADVICE',
      titre: '🏢 Tableau de bord coopérative',
      body: 'Les insights agrégés des membres seront disponibles bientôt.',
      icon: '📋',
      severity: 'INFO',
    });
    return cards;
  }
}
