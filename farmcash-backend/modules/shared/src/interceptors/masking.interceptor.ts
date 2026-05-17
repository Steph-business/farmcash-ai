// =====================================================================
//  MaskingInterceptor — anti-contournement (Chantier 3).
//  ---------------------------------------------------------------------
//  Interceptor GLOBAL : il s'exécute sur TOUTES les réponses HTTP. Pour
//  rester 100% transparent sur les routes qui n'ont pas de PII :
//
//    1. Si le handler porte @SkipMasking() → passthrough.
//    2. Si le handler ne porte PAS @MaskFields(...) → passthrough.
//    3. Sinon : on lit le viewer (req.user), on résout la visibilité par
//       resource observée, et on applique les masks aux chemins déclarés.
//
//  ORDRE D'EXÉCUTION
//  -----------------
//  Doit s'exécuter AVANT TransformInterceptor (sinon il essaie de masker
//  l'enveloppe `{success, data, timestamp}` au lieu du payload métier).
//  → Il est donc enregistré AVANT TransformInterceptor dans
//    apps/api-gateway/src/app.module.ts (Nest applique les interceptors
//    dans l'ordre des providers APP_INTERCEPTOR).
//
//  CACHE DE VISIBILITÉ
//  -------------------
//  resolveVisibility() fait jusqu'à 3 SELECTs par observed user.
//  Pour les listes de N éléments (ex. GET /annonces/vente?limit=100), on
//  pourrait exploser la latence. On utilise un cache de requête (Map
//  locale à l'invocation de map()) qui mémoise (viewerId, observedId).
// =====================================================================

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import type { Request } from 'express';

import { SKIP_MASKING_KEY } from '../decorators/skip-masking.decorator';
import {
  MASK_FIELDS_KEY,
  type MaskKind,
} from '../decorators/mask-fields.decorator';
import { MaskingService, type Visibility } from '../services/masking.service';

/**
 * Champs candidats pour identifier l'user observé dans un objet renvoyé
 * par les services. L'ordre détermine la priorité.
 */
const OBSERVED_ID_KEYS = [
  'user_id',
  'farmer_id',
  'seller_id',
  'buyer_id',
  'transporter_id',
  'observed_user_id',
];

@Injectable()
export class MaskingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MaskingInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly maskingService: MaskingService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    // 1) Route opt-out explicite (admin audit, etc.)
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_MASKING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    // 2) Pas de @MaskFields → passthrough (cas par défaut, transparent)
    const cfg = this.reflector.getAllAndOverride<Record<string, MaskKind>>(
      MASK_FIELDS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!cfg || Object.keys(cfg).length === 0) return next.handle();

    // 3) Récupère le viewer depuis le JWT
    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as unknown as { user?: unknown }).user as
      | { sub?: string; role?: string }
      | undefined;
    const viewerId = user?.sub ?? null;
    const viewerRole = user?.role ?? null;

    return next.handle().pipe(
      switchMap((payload: unknown) => {
        // Garde sécurité : ne touche pas les types de réponse "spéciaux"
        if (payload == null || payload instanceof StreamableFile) {
          return of(payload);
        }
        if (Buffer.isBuffer(payload) || typeof payload === 'string') {
          return of(payload);
        }
        // Cache de visibilité par invocation (évite N SELECTs sur les listes)
        const visibilityCache = new Map<string, Visibility>();
        const promise = this.walkAndMask(
          payload,
          cfg,
          viewerId,
          viewerRole,
          visibilityCache,
        );
        return from(promise);
      }),
    );
  }

  // -------------------------------------------------------------------
  //  Walker récursif
  // -------------------------------------------------------------------

  /**
   * Traverse récursivement le payload : array → map sur chaque élément,
   * objet → tente de masker, descend sur les sous-objets/sub-arrays.
   * IMPORTANT : retourne le même objet (mutation in-place) pour préserver
   * les références et éviter de réenvelopper TransformInterceptor.
   */
  private async walkAndMask(
    node: unknown,
    cfg: Record<string, MaskKind>,
    viewerId: string | null,
    viewerRole: string | null,
    cache: Map<string, Visibility>,
  ): Promise<unknown> {
    if (node == null) return node;

    // Array → walk chaque entrée en série pour préserver les await
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        node[i] = await this.walkAndMask(node[i], cfg, viewerId, viewerRole, cache);
      }
      return node;
    }

    // Plain object → tente de masker puis descend
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;

      // Cas enveloppes courantes : {data, meta}, {items}, etc.
      // On masque récursivement dessus puis on retourne.
      await this.tryMaskObject(obj, cfg, viewerId, viewerRole, cache);

      // Descend sur les sous-structures (utile pour {users: {...}} imbriqués
      // ou pour les listes en pagination {data: [...], meta})
      for (const key of Object.keys(obj)) {
        const child = obj[key];
        if (child && typeof child === 'object') {
          await this.walkAndMask(child, cfg, viewerId, viewerRole, cache);
        }
      }
      return obj;
    }

    return node;
  }

  /**
   * Pour un objet donné, tente de :
   *  - détecter l'observed user (via OBSERVED_ID_KEYS ou un sous-objet `users.id`)
   *  - résoudre la visibilité (cache)
   *  - appliquer chaque entrée de cfg sur les chemins déclarés
   *
   * Sans observed user identifiable, on ne masque PAS (sécurité du défaut :
   * mieux que faux positif qui casserait l'UX).
   */
  private async tryMaskObject(
    obj: Record<string, unknown>,
    cfg: Record<string, MaskKind>,
    viewerId: string | null,
    viewerRole: string | null,
    cache: Map<string, Visibility>,
  ): Promise<void> {
    const observedId = this.detectObservedId(obj);
    if (!observedId) return;

    const cacheKey = `${viewerId ?? 'anon'}::${observedId}`;
    let visibility = cache.get(cacheKey);
    if (!visibility) {
      try {
        visibility = await this.maskingService.resolveVisibility(
          viewerId,
          viewerRole,
          observedId,
        );
      } catch (err) {
        // Défaut sécurisé en cas d'erreur DB : MIN (mieux que tout exposer)
        this.logger.warn(
          `resolveVisibility failed (${(err as Error).message}) — defaulting to MIN`,
        );
        visibility = 'MIN';
      }
      cache.set(cacheKey, visibility);
    }

    if (visibility === 'FULL') return;

    for (const [path, kind] of Object.entries(cfg)) {
      const value = getByPath(obj, path);
      if (value == null) continue;
      const masked = await this.applyMaskValue(
        value,
        kind,
        visibility,
        viewerId,
        observedId,
      );
      if (masked !== value) setByPath(obj, path, masked);
    }
  }

  /**
   * Identifie l'observed user dans un objet :
   *  1. Clés directes (user_id, farmer_id, seller_id, ...)
   *  2. Sous-objet { users: { id } } (pattern Prisma include)
   */
  private detectObservedId(obj: Record<string, unknown>): string | null {
    for (const k of OBSERVED_ID_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
    }
    const users = obj.users;
    if (users && typeof users === 'object') {
      const id = (users as Record<string, unknown>).id;
      if (typeof id === 'string' && id) return id;
    }
    return null;
  }

  /**
   * Applique une transformation atomique selon le kind déclaré.
   * Les masks 'phone' et 'address' se comportent un peu différemment en
   * PARTIAL vs MIN — cf. MaskingService pour les détails.
   *
   * Async pour pouvoir aller chercher un numéro proxy Twilio (chantier 5)
   * quand visibility === PARTIAL ; les autres kinds restent synchrones
   * mais sont enveloppés dans la même signature pour homogénéité.
   */
  private async applyMaskValue(
    value: unknown,
    kind: MaskKind,
    visibility: Visibility,
    viewerId: string | null,
    observedId: string | null,
  ): Promise<unknown> {
    switch (kind) {
      case 'phone':
        // PARTIAL → tente proxy Twilio ; MIN → troncation classique.
        // Fallback transparent géré côté MaskingService.maskPhoneFor.
        if (typeof value !== 'string') return value;
        return this.maskingService.maskPhoneFor(
          value,
          visibility,
          viewerId,
          observedId,
        );
      case 'name':
        return typeof value === 'string'
          ? this.maskingService.maskName(value)
          : value;
      case 'geo':
        return typeof value === 'object' && value !== null
          ? this.maskingService.maskGeo(value as Record<string, unknown>)
          : value;
      case 'address':
        return typeof value === 'string'
          ? this.maskingService.maskAddress(value, visibility)
          : value;
      default:
        return value;
    }
  }
}

// =====================================================================
//  Helpers chemin "a.b.c" → utilisés par tryMaskObject.
//  Volontairement minimalistes : pas de support des arrays par index dans
//  le chemin (les arrays sont traversés par walkAndMask).
// =====================================================================

function getByPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setByPath(obj: unknown, path: string, value: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next == null || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
