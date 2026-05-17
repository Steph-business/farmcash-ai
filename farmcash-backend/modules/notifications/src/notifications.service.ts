// =====================================================================
//  SERVICE : NotificationsService
//  ---------------------------------------------------------------------
//  Trois usages :
//
//   1. INTERNE — `create(dto)` est appelé par les autres modules (Orders,
//      Finance, Logistics, Messaging, Marketplace…) pour pousser une
//      notif à un user. Ce service ne vérifie PAS les permissions :
//      c'est au caller de s'assurer qu'il a le droit. Il N'EXISTE PAS
//      de route HTTP publique pour créer des notifs arbitraires.
//
//   2. CLIENT — l'utilisateur consulte/modifie ses notifs via le
//      controller : list, mark read, delete.
//
//   3. SSE — flux temps réel `notifications$` (Subject RxJS). Filtré
//      côté controller par userId. Pas de push réel FCM en MVP — le
//      token FCM est stocké via `auth/device-token` pour quand le
//      provider Firebase sera câblé.
// =====================================================================

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Subject } from 'rxjs';
import { PrismaService } from '@farmcash/database';
import {
  CreateNotificationDto,
  ListNotificationsQueryDto,
} from './dto/notifications.dto';

interface NotificationEvent {
  userId: string;
  notification: unknown;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly notifications$ = new Subject<NotificationEvent>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Subject RxJS pour le SSE. Filtré côté controller pour ne renvoyer
   * que les notifs du user connecté.
   */
  getNotificationsStream() {
    return this.notifications$.asObservable();
  }

  /**
   * Crée une notification et l'émet sur le flux temps réel.
   * Les champs contextuels (commande_id, reservation_id, etc.) sont
   * fusionnés dans le JSON `data` pour rester schémaless tout en
   * gardant la trace.
   */
  async create(dto: CreateNotificationDto) {
    const extendedData: Record<string, unknown> = {
      ...(dto.data ?? {}),
      ...(dto.commande_id && { commande_id: dto.commande_id }),
      ...(dto.reservation_id && { reservation_id: dto.reservation_id }),
      ...(dto.contre_offre_id && { contre_offre_id: dto.contre_offre_id }),
      ...(dto.candidature_id && { candidature_id: dto.candidature_id }),
      ...(dto.shipment_id && { shipment_id: dto.shipment_id }),
    };

    const notification = await this.prisma.notifications.create({
      data: {
        user_id: dto.user_id,
        type: dto.type,
        titre: dto.titre,
        body: dto.body,
        data: extendedData as Prisma.InputJsonValue,
        sent_at: new Date(),
      },
    });

    this.notifications$.next({ userId: dto.user_id, notification });
    this.logger.log(`Notif created: user=${dto.user_id} type=${dto.type}`);
    return notification;
  }

  /**
   * Listing paginé + filtres (type, unread_only).
   */
  async getUserNotifications(userId: string, query: ListNotificationsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.notificationsWhereInput = {
      user_id: userId,
      ...(query.type && { type: query.type }),
      ...(query.unread_only && { is_read: false }),
    };

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notifications.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.notifications.count({ where }),
      this.prisma.notifications.count({
        where: { user_id: userId, is_read: false },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        last_page: Math.ceil(total / limit) || 1,
        unread_count: unreadCount,
      },
    };
  }

  /**
   * Marque une notif comme lue. Vérifie l'ownership stricte (403 sinon).
   */
  async markAsRead(userId: string, notificationId: string) {
    const notif = await this.prisma.notifications.findUnique({
      where: { id: notificationId },
    });
    if (!notif) throw new NotFoundException('Notification introuvable.');
    if (notif.user_id !== userId) {
      throw new ForbiddenException('Cette notification ne vous appartient pas.');
    }
    return this.prisma.notifications.update({
      where: { id: notificationId },
      data: { is_read: true },
    });
  }

  /**
   * Marque toutes les notifs non lues du user comme lues.
   * Retourne le nombre de notifs affectées.
   */
  async markAllAsRead(userId: string) {
    const result = await this.prisma.notifications.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });
    return { updated: result.count };
  }

  async delete(userId: string, notificationId: string) {
    const notif = await this.prisma.notifications.findUnique({
      where: { id: notificationId },
    });
    if (!notif) throw new NotFoundException('Notification introuvable.');
    if (notif.user_id !== userId) {
      throw new ForbiddenException('Cette notification ne vous appartient pas.');
    }
    await this.prisma.notifications.delete({ where: { id: notificationId } });
    return { message: 'Notification supprimée.' };
  }
}
