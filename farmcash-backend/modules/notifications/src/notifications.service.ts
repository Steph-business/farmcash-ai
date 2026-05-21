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
//      côté controller par userId.
//
//   4. PUSH FCM (Chantier 1 — production) — chaque `create()` déclenche
//      un push best-effort via `firebase-admin` vers les tokens FCM
//      enregistrés en base (`device_tokens.is_active = true`). Les
//      tokens invalides (registration-token-not-registered) sont
//      désactivés automatiquement pour éviter les rejets répétés. Si
//      la variable `FIREBASE_SERVICE_ACCOUNT_PATH` n'est pas définie,
//      le service log un warn UNE FOIS et opère en mode no-op (les
//      tokens continuent d'être collectés côté /auth/device-token).
// =====================================================================

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Subject } from 'rxjs';
import * as admin from 'firebase-admin';
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

  // Lazy init Firebase Admin : on n'initialise qu'au premier sendFcm
  // pour ne pas bloquer le boot si le service account n'est pas dispo
  // (ex. en local). `_firebaseReady` reste null tant qu'on n'a pas
  // décidé (init OK ou warn no-op).
  private _firebaseReady: boolean | null = null;
  private _firebaseWarned = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Initialise Firebase Admin SDK UNE seule fois (lazy + idempotent).
   * Retourne true si admin.messaging() est utilisable, false sinon.
   *
   * Le service account est lu depuis FIREBASE_SERVICE_ACCOUNT_PATH
   * (chemin absolu vers un JSON Google). Si la variable manque ou si
   * le fichier ne se charge pas, on log un warn UNE FOIS et on
   * retourne false — toutes les notifs DB continuent de fonctionner,
   * seul le push FCM est désactivé.
   *
   * En tests (NODE_ENV === 'test'), on bypass complètement pour ne pas
   * polluer les logs et éviter une dépendance à un fichier de creds.
   */
  private _initFirebase(): boolean {
    if (this._firebaseReady !== null) return this._firebaseReady;

    if (process.env.NODE_ENV === 'test') {
      this._firebaseReady = false;
      return false;
    }

    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!serviceAccountPath) {
      if (!this._firebaseWarned) {
        this.logger.warn(
          'FIREBASE_SERVICE_ACCOUNT_PATH non défini — push FCM désactivé (les notifs in-app + SSE continuent de fonctionner).',
        );
        this._firebaseWarned = true;
      }
      this._firebaseReady = false;
      return false;
    }

    try {
      // Si une app par défaut a déjà été initialisée (autre process,
      // hot reload), on la réutilise au lieu d'en créer une 2e (sinon
      // firebase-admin throw `app/duplicate-app`).
      if (admin.apps.length === 0) {
        // require() dynamique pour ne pas faire planter la compilation
        // si le fichier n'existe pas au build (path résolu au runtime).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      }
      this._firebaseReady = true;
      this.logger.log(`Firebase Admin initialisé (${serviceAccountPath}).`);
      return true;
    } catch (err) {
      if (!this._firebaseWarned) {
        this.logger.warn(
          `Firebase Admin init KO (${(err as Error).message}) — push FCM désactivé.`,
        );
        this._firebaseWarned = true;
      }
      this._firebaseReady = false;
      return false;
    }
  }

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
   *
   * Le push FCM est ensuite déclenché en best-effort (try/catch silencieux,
   * hors flow critique). Si Firebase n'est pas configuré, le service
   * fonctionne en mode dégradé (notif DB + SSE OK, push muet).
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

    // Best-effort push FCM — n'interrompt JAMAIS la création de la notif.
    this.sendFcm(dto.user_id, dto.titre, dto.body, extendedData).catch((e) =>
      this.logger.warn(`sendFcm KO user=${dto.user_id}: ${e?.message}`),
    );

    return notification;
  }

  /**
   * Push FCM réel via `firebase-admin`. Best-effort :
   *   1. Init Firebase (lazy) — si pas de service account, on quitte.
   *   2. Lit les `device_tokens` actifs du user.
   *   3. `sendEachForMulticast` (jusqu'à 500 tokens en 1 appel).
   *   4. Pour chaque échec, si le token est invalide
   *      (`messaging/registration-token-not-registered`) → on le
   *      désactive en base pour ne plus le pousser.
   *
   * Aucune erreur n'est propagée : un push KO ne doit pas casser la
   * création de la notif DB côté caller.
   */
  async sendFcm(
    userId: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this._initFirebase()) return;

    const tokens = await this.prisma.device_tokens.findMany({
      where: { user_id: userId, is_active: true },
      select: { id: true, fcm_token: true },
    });
    if (tokens.length === 0) {
      this.logger.debug(`sendFcm: aucun device_token actif pour user=${userId}`);
      return;
    }

    // FCM data payload doit être Map<string,string>. On stringify les
    // valeurs non-string (UUIDs OK, mais on couvre les nombres/objets).
    const stringData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      stringData[k] =
        typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: tokens.map((t) => t.fcm_token),
        notification: { title, body },
        data: stringData,
      });

      // Désactive les tokens définitivement invalides. On ne touche
      // pas aux échecs transitoires (quota, server unavailable…) :
      // ils repasseront au prochain push.
      const toDisable: string[] = [];
      response.responses.forEach((r, idx) => {
        if (!r.success && r.error) {
          const code = r.error.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            toDisable.push(tokens[idx].id);
          } else {
            this.logger.warn(
              `FCM push KO (transient) user=${userId} code=${code} msg=${r.error.message}`,
            );
          }
        }
      });

      if (toDisable.length > 0) {
        await this.prisma.device_tokens.updateMany({
          where: { id: { in: toDisable } },
          data: { is_active: false },
        });
        this.logger.log(
          `FCM: ${toDisable.length} token(s) invalide(s) désactivé(s) pour user=${userId}.`,
        );
      }

      this.logger.log(
        `FCM push: user=${userId} sent=${response.successCount}/${tokens.length}`,
      );
    } catch (err) {
      // Échec global (réseau, projet Firebase mal configuré…) — on log et c'est tout.
      this.logger.warn(
        `FCM push global KO user=${userId}: ${(err as Error).message}`,
      );
    }
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
