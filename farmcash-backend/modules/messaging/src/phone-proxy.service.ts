// =====================================================================
//  SERVICE : PhoneProxyService (Chantier 5.a)
//  ---------------------------------------------------------------------
//  Orchestre l'allocation d'un numéro proxy Twilio pour un user qui
//  veut appeler un autre user de la plateforme. Combine :
//
//    1. MaskingService.resolveVisibility → vérifie qu'il y a bien une
//       relation business justifiant l'appel (commande, livraison, coop).
//       Si MIN → 403 (pas de proxy pour des étrangers).
//    2. TwilioProxyService.getOrCreateProxyNumber → réutilise une session
//       existante si encore valide, sinon en alloue une nouvelle.
//
//  L'utilisateur final n'a JAMAIS accès au vrai téléphone du callee.
// =====================================================================

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { MaskingService, TwilioProxyService } from '@farmcash/shared';
import { CreateProxyCallDto, TwilioWebhookDto } from './dto/phone-proxy.dto';

@Injectable()
export class PhoneProxyService {
  private readonly logger = new Logger(PhoneProxyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maskingService: MaskingService,
    private readonly twilioProxy: TwilioProxyService,
  ) {}

  /**
   * Crée (ou réutilise) une session proxy. Retourne le numéro à composer.
   */
  async createProxyCall(
    callerId: string,
    callerRole: string | null | undefined,
    dto: CreateProxyCallDto,
  ) {
    // 1. Le callee doit exister
    const callee = await this.prisma.users.findUnique({
      where: { id: dto.callee_user_id },
      select: { id: true, is_active: true },
    });
    if (!callee || callee.is_active === false) {
      throw new NotFoundException('Utilisateur cible introuvable.');
    }

    // 2. On vérifie qu'il y a une relation business autorisée
    const visibility = await this.maskingService.resolveVisibility(
      callerId,
      callerRole ?? null,
      dto.callee_user_id,
    );
    if (visibility === 'MIN') {
      throw new ForbiddenException(
        'Pas de relation justifiant un appel proxy entre ces utilisateurs.',
      );
    }

    // 3. Allouer (ou réutiliser) un numéro proxy
    const session = await this.twilioProxy.getOrCreateProxyNumber(
      callerId,
      dto.callee_user_id,
      { commandeId: dto.commande_id ?? null },
    );
    if (!session) {
      // Provider externe DOWN → 503 plutôt que mentir avec un faux numéro
      throw new ForbiddenException(
        'Service téléphone proxy indisponible. Veuillez réessayer plus tard.',
      );
    }

    return {
      proxy_phone: session.proxyPhone,
      expires_at: session.expiresAt.toISOString(),
      session_id: session.sessionId,
    };
  }

  /**
   * Webhook Twilio — typiquement `call.completed`. On met à jour les
   * compteurs (nombre d'appels, durée totale) pour QA et facturation.
   *
   * Best-effort : si on ne reconnaît pas la session, on ignore (réponse
   * 200 quand même pour ne pas faire retry Twilio en boucle).
   */
  async handleWebhook(dto: TwilioWebhookDto): Promise<{ received: true }> {
    const sessionSid = dto.SessionSid?.trim();
    const eventType = dto.EventType?.trim() ?? '';
    const duration = dto.CallDuration ? parseInt(dto.CallDuration, 10) : 0;

    this.logger.log(
      `Twilio webhook: event=${eventType} session=${sessionSid ?? 'n/a'} duration=${duration}`,
    );

    if (!sessionSid) return { received: true };

    const local = await this.twilioProxy.findByProviderSessionId(sessionSid);
    if (!local) {
      this.logger.warn(`Twilio webhook: session inconnue (${sessionSid})`);
      return { received: true };
    }

    // Incrémente sur les events qui correspondent à un appel terminé.
    // On reste tolérant sur les noms (varie selon version API Twilio).
    if (
      eventType.includes('completed') ||
      eventType.includes('call-completed') ||
      eventType === ''
    ) {
      await this.twilioProxy.recordCall(local.id, isNaN(duration) ? 0 : duration);
    }

    return { received: true };
  }
}
