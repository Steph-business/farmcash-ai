// =====================================================================
//  TwilioProxyService — Chantier 5.a
//  ---------------------------------------------------------------------
//  Wrapper bas niveau autour du provider de numéros proxy (Twilio Proxy
//  en prod, mock déterministe en dev). Sa seule responsabilité est :
//
//    1. Allouer un numéro proxy unique pour une paire (caller, callee).
//    2. Persister la session en DB (table `phone_proxy_sessions`) pour
//       que MaskingService / PhoneProxyService puissent la retrouver.
//    3. Libérer (release) un numéro à la fin de la fenêtre business.
//
//  MODE MOCK
//  ---------
//  Si TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN sont absents/vides de l'env,
//  on tombe automatiquement en mode mock : on génère un numéro déterministe
//  basé sur TWILIO_PROXY_BASE_NUMBER (défaut +22550000000) + un suffixe
//  pseudo-aléatoire. Aucun appel HTTP n'est fait vers Twilio.
//
//  Le mode mock est suffisant pour le dev et les tests E2E : les sessions
//  sont vraies (DB), seul le provider externe est simulé.
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { PrismaService } from '@farmcash/database';

/**
 * Durée par défaut d'une session proxy. 14 jours — couvre la fenêtre
 * commande active + une marge de SAV/dispute.
 */
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface AllocatedProxy {
  proxyPhone: string;
  providerSessionId: string | null;
}

export interface ProxyContextRef {
  /** Commande ou autre ressource business qui justifie l'appel. */
  commandeId?: string | null;
  /** TTL custom en ms — défaut 14 jours. */
  ttlMs?: number;
}

export interface ProxySessionView {
  sessionId: string;
  proxyPhone: string;
  expiresAt: Date;
}

@Injectable()
export class TwilioProxyService {
  private readonly logger = new Logger(TwilioProxyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * True si on a les credentials Twilio. Sinon → mode mock.
   */
  private get isLiveMode(): boolean {
    const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    return Boolean(sid && token && sid.trim() && token.trim());
  }

  /**
   * Récupère une session ACTIVE existante pour (caller, callee) ou en
   * crée une nouvelle. Optimisé pour l'usage MaskingService qui appelle
   * potentiellement à chaque lecture de payload.
   *
   * Retourne null si la persistence échoue (ex. callee inconnu) — le
   * caller (MaskingService) fait alors un fallback sur la troncation.
   */
  async getOrCreateProxyNumber(
    callerUserId: string,
    calleeUserId: string,
    context: ProxyContextRef = {},
  ): Promise<ProxySessionView | null> {
    if (!callerUserId || !calleeUserId || callerUserId === calleeUserId) {
      return null;
    }

    // 1) Réutiliser une session ACTIVE non expirée
    const existing = await this.prisma.phone_proxy_sessions.findFirst({
      where: {
        caller_user_id: callerUserId,
        callee_user_id: calleeUserId,
        status: 'ACTIVE',
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });
    if (existing) {
      return {
        sessionId: existing.id,
        proxyPhone: existing.proxy_phone,
        expiresAt: existing.expires_at,
      };
    }

    // 2) Allouer un nouveau numéro (live ou mock)
    let allocated: AllocatedProxy;
    try {
      allocated = this.isLiveMode
        ? await this.allocateLive()
        : this.allocateMock();
    } catch (e: any) {
      this.logger.error(
        `Proxy allocation failed (caller=${callerUserId} callee=${calleeUserId}): ${e?.message}`,
      );
      return null;
    }

    // 3) Persister
    const ttl = context.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    try {
      const created = await this.prisma.phone_proxy_sessions.create({
        data: {
          caller_user_id: callerUserId,
          callee_user_id: calleeUserId,
          commande_id: context.commandeId ?? null,
          proxy_phone: allocated.proxyPhone,
          provider_session_id: allocated.providerSessionId,
          expires_at: new Date(Date.now() + ttl),
          status: 'ACTIVE',
        },
      });
      this.logger.log(
        `Proxy session created id=${created.id} mode=${this.isLiveMode ? 'live' : 'mock'}`,
      );
      return {
        sessionId: created.id,
        proxyPhone: created.proxy_phone,
        expiresAt: created.expires_at,
      };
    } catch (e: any) {
      this.logger.error(`Proxy session persist failed: ${e?.message}`);
      return null;
    }
  }

  /**
   * Marque une session expirée (manuellement ou par cron de cleanup).
   * Idempotent.
   */
  async releaseProxyNumber(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
      await this.prisma.phone_proxy_sessions.updateMany({
        where: { id: sessionId, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
    } catch (e: any) {
      this.logger.warn(`releaseProxyNumber(${sessionId}) failed: ${e?.message}`);
    }
  }

  /**
   * Increment statistique appelée par le webhook Twilio (call.completed).
   * Best-effort : on log mais on ne crash pas si la session n'existe plus.
   */
  async recordCall(
    sessionId: string,
    durationSec: number,
  ): Promise<void> {
    if (!sessionId) return;
    try {
      await this.prisma.phone_proxy_sessions.updateMany({
        where: { id: sessionId },
        data: {
          call_count: { increment: 1 },
          total_duration_sec: { increment: Math.max(0, Math.floor(durationSec)) },
          last_call_at: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`recordCall(${sessionId}) failed: ${e?.message}`);
    }
  }

  /**
   * Récupère une session par son provider_session_id (utilisé par le
   * webhook Twilio qui ne connaît pas notre UUID interne).
   */
  async findByProviderSessionId(providerSessionId: string) {
    if (!providerSessionId) return null;
    return this.prisma.phone_proxy_sessions.findFirst({
      where: { provider_session_id: providerSessionId },
    });
  }

  // -------------------------------------------------------------------
  //  Allocators
  // -------------------------------------------------------------------

  /**
   * MOCK : génère un numéro à partir de TWILIO_PROXY_BASE_NUMBER. On
   * remplace les 6 derniers chiffres par un suffixe pseudo-random pour
   * éviter les collisions sur des sessions concurrentes en dev.
   */
  private allocateMock(): AllocatedProxy {
    const base =
      this.config.get<string>('TWILIO_PROXY_BASE_NUMBER') || '+22550000000';
    // Le numéro de base est au format +225XXXXXXXX. On force 6 derniers
    // chiffres aléatoires en gardant l'indicatif et la "head" intacts.
    const head = base.length > 6 ? base.slice(0, base.length - 6) : base;
    const suffix = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const proxyPhone = `${head}${suffix}`;
    return {
      proxyPhone,
      providerSessionId: `MOCK-${Date.now()}-${suffix}`,
    };
  }

  /**
   * LIVE : appelle l'API Twilio Proxy. Placeholder — l'intégration
   * réelle nécessite le SDK `twilio` (non installé en MVP). Si on bascule
   * en live sans avoir installé le SDK, on lève une erreur explicite
   * plutôt que de mentir avec un faux numéro.
   */
  private async allocateLive(): Promise<AllocatedProxy> {
    // TODO(prod) : installer `twilio` SDK et créer la session Proxy via :
    //   const session = await client.proxy.services(SVC).sessions.create({...});
    //   await session.participants.create({ identifier: callerPhone, ... });
    //   await session.participants.create({ identifier: calleePhone, ... });
    //   return { proxyPhone: participant.proxyIdentifier, providerSessionId: session.sid };
    throw new Error(
      'TwilioProxyService.allocateLive: SDK Twilio non câblé. ' +
        'Désactivez TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN pour rester en mode mock.',
    );
  }
}
