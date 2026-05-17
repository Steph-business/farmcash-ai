// =====================================================================
//  PrevisionsReminderCron (Chantier 5.b)
//  ---------------------------------------------------------------------
//  Tâche planifiée quotidienne qui rappelle au FARMER 5 jours avant la
//  date prévue de récolte qu'il doit publier son annonce.
//
//  Fenêtre J+4 à J+6 (et non strictement J+5) pour rattraper un éventuel
//  cron raté (machine down, redéploiement…). Anti-spam : on ne re-notifie
//  pas si une notif PREVISION_J5_REMINDER existe déjà pour cette prévision
//  dans les 6 derniers jours.
//
//  Désactivable via DISABLE_PREVISIONS_REMINDER=true (utile en tests E2E).
//
//  Le pattern setTimeout/setInterval suit celui du
//  ReservationsExpirationCron — pas de dépendance @nestjs/schedule.
// =====================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService } from '@farmcash/notifications';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Anti-spam : on ne re-notifie pas pour la même prévision dans cette fenêtre. */
const ANTI_SPAM_WINDOW_MS = 6 * DAY_MS;

@Injectable()
export class PrevisionsReminderCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrevisionsReminderCron.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('DISABLE_PREVISIONS_REMINDER') === 'true') {
      this.logger.log('Previsions reminder cron désactivé (env).');
      return;
    }
    // Premier run 2 minutes après le boot pour laisser le reste de l'app
    // se stabiliser, puis quotidien.
    setTimeout(() => this.runOnce(), 2 * 60 * 1000);
    this.timer = setInterval(() => this.runOnce(), DAY_MS);
    this.logger.log('Previsions reminder cron : daily');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Exécution unique : trouve les prévisions OPEN dont la date de
   * récolte tombe dans [J+4, J+6], puis pousse une notif au farmer
   * (en évitant les doublons).
   *
   * Public pour pouvoir être déclenché manuellement (tests E2E, /admin).
   */
  async runOnce(): Promise<{ scanned: number; notified: number }> {
    const now = new Date();
    const lowerBound = new Date(now.getTime() + 4 * DAY_MS);
    const upperBound = new Date(now.getTime() + 6 * DAY_MS);

    try {
      const dueRows = await this.prisma.previsions_production.findMany({
        where: {
          status: 'OPEN',
          date_recolte_prev: { gte: lowerBound, lte: upperBound },
          converted_to_annonce_id: null,
        },
        include: { produits_agricoles: { select: { nom: true } } },
      });

      let notified = 0;
      for (const p of dueRows) {
        // Anti-spam : déjà notifié récemment ?
        const recent = await this.prisma.notifications.findFirst({
          where: {
            user_id: p.farmer_id,
            type: 'PREVISION_J5_REMINDER',
            created_at: { gte: new Date(Date.now() - ANTI_SPAM_WINDOW_MS) },
            data: { path: ['prevision_id'], equals: p.id },
          },
        });
        if (recent) continue;

        const produitNom = p.produits_agricoles?.nom ?? 'à venir';
        try {
          // On utilise directement prisma.notifications.create pour pouvoir
          // passer un `type` custom (PREVISION_J5_REMINDER n'est pas dans
          // l'enum NotificationType du DTO, qui couvre seulement les
          // catégories transverses).
          await this.prisma.notifications.create({
            data: {
              user_id: p.farmer_id,
              type: 'PREVISION_J5_REMINDER',
              titre: `Récolte ${produitNom} dans 5 jours`,
              body: 'Publie ton annonce maintenant pour trouver des acheteurs.',
              data: {
                prevision_id: p.id,
                produit_nom: produitNom,
                date_recolte_prev: p.date_recolte_prev?.toISOString() ?? null,
              } as Prisma.InputJsonValue,
              sent_at: new Date(),
            },
          });
          notified++;
        } catch (e: any) {
          this.logger.warn(
            `Notif J-5 échouée pour prevision=${p.id}: ${e?.message}`,
          );
        }
      }

      if (notified > 0) {
        this.logger.log(
          `Previsions J-5 : ${notified} notif(s) envoyée(s) sur ${dueRows.length} prévision(s) éligible(s).`,
        );
      }
      return { scanned: dueRows.length, notified };
    } catch (e: any) {
      this.logger.error(`Previsions reminder cron crashed: ${e?.message}`);
      return { scanned: 0, notified: 0 };
    }
  }
}
