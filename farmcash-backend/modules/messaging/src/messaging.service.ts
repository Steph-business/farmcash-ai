// =====================================================================
//  SERVICE : MessagingService
//  ---------------------------------------------------------------------
//  Gère les conversations (1-1 et groupe) et les messages textuels ou
//  média (image / vidéo / audio / document).
//
//  Garde-fous :
//   • Toute action sur une conversation vérifie que le user en est
//     participant — sinon 403 ForbiddenException (pas 404).
//   • sendMessage est appelé aussi depuis le Gateway WebSocket avec le
//     même contrôle d'identité (userId vient du JWT, pas du client).
//   • Pagination obligatoire sur les listings pour éviter les payloads
//     explosifs.
// =====================================================================

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@farmcash/database';
import { NotificationsService } from '@farmcash/notifications';
import {
  ConversationType,
  CreateConversationDto,
  ListMessagesQueryDto,
  SendMessageDto,
} from './dto/messaging.dto';
import { NotificationType } from '@farmcash/notifications';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  /**
   * Map en mémoire du statut online. ⚠️ Pour un déploiement multi-pods,
   * remplacer par Redis pub/sub avec TTL par socket.
   */
  private readonly onlineUsers = new Map<string, boolean>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ===================================================================
  //  ONLINE STATUS (mémoire process)
  // ===================================================================

  setOnlineStatus(userId: string, isOnline: boolean): void {
    if (isOnline) this.onlineUsers.set(userId, true);
    else this.onlineUsers.delete(userId);
  }

  isUserOnline(userId: string): boolean {
    return this.onlineUsers.get(userId) === true;
  }

  // ===================================================================
  //  HELPERS D'AUTORISATION
  // ===================================================================

  /**
   * Vérifie que `userId` est participant de la conversation. Utilisé
   * par le Gateway WS avant de laisser rejoindre une room.
   */
  async isUserInConversation(
    userId: string,
    conversationId: string,
  ): Promise<boolean> {
    const p = await this.prisma.conversation_participants.findUnique({
      where: {
        conversation_id_user_id: {
          conversation_id: conversationId,
          user_id: userId,
        },
      },
      select: { id: true },
    });
    return p !== null;
  }

  // ===================================================================
  //  CONVERSATIONS
  // ===================================================================

  /**
   * Trouve une conversation DIRECT existante entre les deux participants,
   * ou en crée une nouvelle. Pour GROUP, crée toujours une nouvelle.
   *
   * Le créateur est toujours ajouté aux participants côté serveur ;
   * impossible de créer une conversation où on ne serait pas membre.
   */
  async findOrCreateConversation(userId: string, dto: CreateConversationDto) {
    const participants = [...new Set([userId, ...dto.participants])];
    const type = dto.type ?? ConversationType.DIRECT;

    if (type === ConversationType.DIRECT && participants.length === 2) {
      const existing = await this.prisma.conversations.findFirst({
        where: {
          type: ConversationType.DIRECT,
          AND: [
            { conversation_participants: { some: { user_id: participants[0] } } },
            { conversation_participants: { some: { user_id: participants[1] } } },
          ],
        },
        include: {
          conversation_participants: {
            include: {
              users: { select: { id: true, full_name: true, photo_url: true } },
            },
          },
        },
      });
      if (existing) return existing;
    }

    return this.prisma.conversations.create({
      data: {
        type,
        titre: dto.titre,
        conversation_participants: {
          create: participants.map((pId) => ({ user_id: pId })),
        },
      },
      include: {
        conversation_participants: {
          include: {
            users: { select: { id: true, full_name: true, photo_url: true } },
          },
        },
      },
    });
  }

  /**
   * Liste paginée des conversations d'un user, avec le dernier message
   * inclus en aperçu et le nombre de messages non lus.
   */
  async getUserConversations(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const where = {
      conversation_participants: { some: { user_id: userId } },
    } as const;

    const [data, total] = await Promise.all([
      this.prisma.conversations.findMany({
        where,
        skip,
        take: limit,
        include: {
          conversation_participants: {
            include: {
              users: { select: { id: true, full_name: true, photo_url: true } },
            },
          },
          messages: {
            take: 1,
            orderBy: { created_at: 'desc' },
          },
        },
        orderBy: { last_message_at: 'desc' },
      }),
      this.prisma.conversations.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  // ===================================================================
  //  MESSAGES
  // ===================================================================

  /**
   * Envoie un message. Vérifie que le sender est bien participant.
   * Crée le message + met à jour last_message_at + notifie chaque autre
   * participant (NotificationsService) pour le push mobile.
   */
  async sendMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ) {
    const conv = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      include: { conversation_participants: true },
    });
    if (!conv) throw new NotFoundException('Conversation introuvable.');

    const isParticipant = conv.conversation_participants.some(
      (p) => p.user_id === userId,
    );
    if (!isParticipant) {
      throw new ForbiddenException('Vous ne faites pas partie de cette conversation.');
    }

    // Anti-abus : si media_url fourni, valider qu'il pointe vers un
    // domaine de stockage de confiance (CDN FarmCash, R2/S3 sandbox).
    // Empêche un user d'attacher des URLs malveillantes (phishing,
    // tracking, malware) qui seraient affichées dans l'app mobile.
    if (dto.media_url) {
      this.assertMediaUrlAllowed(dto.media_url);
      if (!dto.media_type) {
        throw new BadRequestException('media_type requis si media_url fourni.');
      }
    }

    const [message] = await this.prisma.$transaction([
      this.prisma.messages.create({
        data: {
          conversation_id: conversationId,
          sender_id: userId,
          content: dto.content,
          media_type: dto.media_type,
          media_url: dto.media_url,
          status: 'SENT',
        },
      }),
      this.prisma.conversations.update({
        where: { id: conversationId },
        data: { last_message_at: new Date() },
      }),
    ]);

    // Notifie chaque AUTRE participant en best-effort (push mobile).
    for (const p of conv.conversation_participants) {
      if (p.user_id === userId) continue;
      void this.notifications
        .create({
          user_id: p.user_id,
          type: NotificationType.MESSAGE,
          titre: 'Nouveau message',
          body: dto.content.slice(0, 120),
          data: { conversation_id: conversationId, message_id: message.id },
        })
        .catch((e) =>
          this.logger.warn(`Notif msg échouée pour ${p.user_id}: ${e.message}`),
        );
    }

    return message;
  }

  /**
   * Liste paginée des messages d'une conversation, du plus récent au
   * plus ancien. 403 si l'user n'est pas participant.
   */
  async getConversationMessages(
    userId: string,
    conversationId: string,
    query: ListMessagesQueryDto,
  ) {
    const ok = await this.isUserInConversation(userId, conversationId);
    if (!ok) {
      throw new ForbiddenException('Accès refusé à cette conversation.');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 30;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.messages.findMany({
        where: { conversation_id: conversationId },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          users: { select: { id: true, full_name: true, photo_url: true } },
        },
      }),
      this.prisma.messages.count({ where: { conversation_id: conversationId } }),
    ]);

    return {
      data,
      meta: { total, page, limit, last_page: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Marque la conversation comme lue par le user (timestamp).
   */
  async markAsRead(userId: string, conversationId: string) {
    const p = await this.prisma.conversation_participants.findUnique({
      where: {
        conversation_id_user_id: {
          conversation_id: conversationId,
          user_id: userId,
        },
      },
    });
    if (!p) {
      throw new ForbiddenException('Vous ne faites pas partie de cette conversation.');
    }
    return this.prisma.conversation_participants.update({
      where: { id: p.id },
      data: { last_read_at: new Date() },
    });
  }

  /**
   * Whitelist des domaines autorisés pour media_url. Empêche
   * l'injection d'URLs malveillantes dans l'app mobile.
   * Extensible via env MEDIA_URL_ALLOWED_DOMAINS (CSV).
   */
  private assertMediaUrlAllowed(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('media_url invalide.');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('media_url doit utiliser HTTPS.');
    }
    const fromEnv = process.env.MEDIA_URL_ALLOWED_DOMAINS ?? '';
    const allowed = new Set<string>([
      'cdn.farmcash.ci',
      'storage.farmcash.ci',
      // MinIO local en dev
      'localhost',
      ...fromEnv.split(',').map((d) => d.trim()).filter(Boolean),
    ]);
    if (!allowed.has(parsed.hostname)) {
      throw new BadRequestException(
        `Domaine ${parsed.hostname} non autorisé pour media_url.`,
      );
    }
  }
}
