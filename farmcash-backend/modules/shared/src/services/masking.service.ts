// =====================================================================
//  MaskingService — pilier du Chantier 3 (anti-contournement).
//  ---------------------------------------------------------------------
//  Centralise :
//    1. La résolution de la VISIBILITÉ d'un viewer sur un user observé,
//       en croisant rôle + relation business (commande active, livraison,
//       même coopérative).
//    2. Les TRANSFORMATIONS atomiques (téléphone, nom, géoloc, adresse)
//       appliquées par le MaskingInterceptor.
//
//  Pattern produit "Uber/Airbnb" :
//    - tant que les 2 parties n'ont pas de transaction → identité MIN
//    - dès qu'une commande est ACCEPTED → identité PARTIAL (proxy phone,
//      adresse approx)
//    - ADMIN ou self → FULL
//
//  Aucune écriture DB. Toutes les requêtes sont des SELECTs ciblés.
// =====================================================================

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { TwilioProxyService } from './twilio-proxy.service';

/**
 * Granularité de visibilité d'un viewer sur un user observé.
 *  - FULL    : tout en clair (admin, self, même coop)
 *  - PARTIAL : téléphone proxy, adresse approx 2 décimales, nom complet
 *              (commande/livraison active entre les 2)
 *  - MIN     : prénom + initiale, téléphone masqué, géoloc arrondie
 *              (cas par défaut entre étrangers)
 */
export type Visibility = 'FULL' | 'PARTIAL' | 'MIN';

@Injectable()
export class MaskingService {
  private readonly logger = new Logger(MaskingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Injection OPTIONNELLE — si TwilioProxyService n'est pas fourni
    // (ex. tests unitaires ou contexte minimal), on retombe sur la
    // troncation classique pour PARTIAL.
    @Optional() private readonly twilioProxy?: TwilioProxyService,
  ) {}

  /**
   * Résout la visibilité d'un viewer sur un user observé.
   *
   * Table de décision (ordre des règles → première qui matche gagne) :
   *   1. self → FULL
   *   2. ADMIN → FULL
   *   3. TRANSPORTER avec shipment actif sur l'observé → FULL (doit aller chez lui)
   *   4. Commande ACCEPTED/IN_PROGRESS/DELIVERED/COMPLETED entre les 2 → PARTIAL
   *   5. Même coopérative (les 2 sont membres de la même coop) → FULL
   *   6. défaut → MIN
   */
  async resolveVisibility(
    viewerId: string | null | undefined,
    viewerRole: string | null | undefined,
    observedUserId: string | null | undefined,
  ): Promise<Visibility> {
    // Anonyme = masking maximum
    if (!viewerId || !observedUserId) return 'MIN';

    // Règle 1 — self
    if (viewerId === observedUserId) return 'FULL';

    // Règle 2 — ADMIN passe partout
    if (viewerRole === 'ADMIN') return 'FULL';

    // Règle 3 — TRANSPORTER doit voir clair pour aller chez l'expéditeur/destinataire.
    // On ne vérifie que les shipments actifs pour éviter la fuite après livraison.
    if (viewerRole === 'TRANSPORTER') {
      const hasShipment = await this.prisma.shipments.findFirst({
        where: {
          transporter_id: viewerId,
          status: { in: ['ACCEPTED', 'LOADING', 'IN_TRANSIT'] },
          commandes_vente: {
            OR: [{ buyer_id: observedUserId }, { seller_id: observedUserId }],
          },
        },
        select: { id: true },
      });
      if (hasShipment) return 'FULL';
    }

    // Règle 4 — commande active entre les 2 parties (BUYER ↔ FARMER/COOP)
    const hasOrder = await this.prisma.commandes_vente.findFirst({
      where: {
        OR: [
          {
            buyer_id: viewerId,
            seller_id: observedUserId,
            status: { in: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED'] },
          },
          {
            seller_id: viewerId,
            buyer_id: observedUserId,
            status: { in: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED'] },
          },
        ],
      },
      select: { id: true },
    });
    if (hasOrder) return 'PARTIAL';

    // Règle 5 — même coopérative.
    //
    // Décision produit (2026-05-17) :
    //   • COOPERATIVE ↔ membre  → FULL : la coop a une relation manager
    //     légitime avec ses membres (verse les avances, valide les annonces,
    //     suit les ventes). Voir clair les coords est requis pour son métier.
    //   • FARMER ↔ co-membre    → PARTIAL : les co-membres se connaissent
    //     IRL via les réunions de la coop, donc tronquer le nom est inutile.
    //     MAIS on garde le téléphone derrière un proxy (anti-contournement
    //     plateforme : ils ne doivent pas s'appeler en direct pour faire
    //     des transactions hors-FarmCash).
    const memberships = await this.prisma.cooperative_members.findMany({
      where: {
        member_id: { in: [viewerId, observedUserId] },
        is_active: true,
      },
      select: { cooperative_id: true, member_id: true },
    });
    const viewerCoops = new Set(
      memberships
        .filter((m) => m.member_id === viewerId)
        .map((m) => m.cooperative_id),
    );
    const observedCoops = memberships
      .filter((m) => m.member_id === observedUserId)
      .map((m) => m.cooperative_id);
    const sharedCoop = observedCoops.some((c) => viewerCoops.has(c));
    if (sharedCoop) {
      // La coop voit clair ses membres (manager relation).
      if (viewerRole === 'COOPERATIVE') return 'FULL';
      // Entre co-membres FARMER (ou autres) : PARTIAL — nom OK, phone proxy.
      return 'PARTIAL';
    }

    // Défaut — pas de relation business → MIN
    return 'MIN';
  }

  /**
   * Tronque un téléphone en gardant indicatif + 2 derniers chiffres.
   * `+2250709123456` → `+225 ** ** ** 56`.
   */
  maskPhone(phone: string | null | undefined): string {
    if (!phone || phone.length < 4) return '+*** ** ** ** **';
    const last2 = phone.slice(-2);
    return `+225 ** ** ** ${last2}`;
  }

  /**
   * Variante contextuelle de `maskPhone` qui tient compte de la visibilité
   * et du couple (viewer, observed) :
   *
   *  - FULL    → retourne le téléphone en clair.
   *  - PARTIAL → tente d'allouer un numéro proxy Twilio via le service
   *              dédié (chantier 5). Si l'allocation échoue ou si le
   *              service n'est pas dispo, fallback sur la troncation
   *              MIN (mieux que fuiter).
   *  - MIN     → troncation classique.
   *
   * Cette méthode résout le TODO laissé par le chantier 3 dans
   * `MaskingInterceptor.applyMaskValue` (cas 'phone').
   */
  async maskPhoneFor(
    phone: string | null | undefined,
    visibility: Visibility,
    viewerId?: string | null,
    observedId?: string | null,
  ): Promise<string> {
    if (visibility === 'FULL') return phone ?? '';
    if (visibility === 'PARTIAL' && this.twilioProxy && viewerId && observedId) {
      try {
        const session = await this.twilioProxy.getOrCreateProxyNumber(
          viewerId,
          observedId,
          {},
        );
        if (session?.proxyPhone) return session.proxyPhone;
      } catch (e: any) {
        this.logger.warn(
          `maskPhoneFor proxy fallback (viewer=${viewerId} observed=${observedId}): ${e?.message}`,
        );
      }
      // fallback troncation si proxy KO
    }
    return this.maskPhone(phone);
  }

  /**
   * Tronque un nom complet en `Prénom I.`.
   * Mono-mot → renvoyé tel quel (ex. `Aïcha`).
   */
  maskName(fullName: string | null | undefined): string {
    if (!fullName) return 'Utilisateur';
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'Utilisateur';
    if (parts.length === 1) return parts[0];
    const initial = parts[parts.length - 1][0] ?? '';
    return `${parts[0]} ${initial.toUpperCase()}.`;
  }

  /**
   * Arrondit lat/lng à 2 décimales (~1 km de précision).
   * Accepte les formats `{lat, lng}` ou `{latitude, longitude}` — renvoie
   * la même forme.
   */
  maskGeo<T extends Record<string, unknown>>(coord: T | null | undefined): T | null {
    if (!coord || typeof coord !== 'object') return coord ?? null;
    const round = (v: unknown): unknown =>
      typeof v === 'number' ? Math.round(v * 100) / 100 : v;
    const out = { ...coord } as Record<string, unknown>;
    if ('lat' in out) out.lat = round(out.lat);
    if ('lng' in out) out.lng = round(out.lng);
    if ('latitude' in out) out.latitude = round(out.latitude);
    if ('longitude' in out) out.longitude = round(out.longitude);
    return out as T;
  }

  /**
   * Masque une adresse précise. PARTIAL conserve la ligne (livraison),
   * MIN supprime tout sauf la dernière virgule (ville/région).
   */
  maskAddress(address: string | null | undefined, visibility: Visibility): string | null {
    if (!address) return address ?? null;
    if (visibility === 'FULL') return address;
    if (visibility === 'PARTIAL') return address;
    // MIN — on ne garde que la dernière section après la dernière virgule
    // (typiquement la ville / région). Si pas de virgule, on renvoie une
    // chaîne générique pour éviter de fuiter rue + numéro.
    const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) return 'Zone non précisée';
    return parts[parts.length - 1];
  }
}
