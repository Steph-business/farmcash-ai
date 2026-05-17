// =====================================================================
//  RetryQueueService
//  ---------------------------------------------------------------------
//  File de retry simple in-memory pour les opérations Mobile Money
//  qui échouent (timeout provider, FAILED). En prod, remplacer par
//  Bull/BullMQ (Redis-backed) sans changer l'API du service.
//
//  Stratégie :
//   • Backoff exponentiel : 30s, 2min, 10min
//   • Max 3 tentatives avant abandon
//   • Persiste l'état dans `transactions.attempts` + last_attempt_at
//
//  Limitations in-memory :
//   • Les jobs sont perdus au restart du processus.
//   • Pour de vrais montants, passer à Bull (Redis déjà dispo).
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@farmcash/database';

const BACKOFFS_MS = [30_000, 120_000, 600_000]; // 30s, 2min, 10min
const MAX_ATTEMPTS = BACKOFFS_MS.length;

interface Job {
  transaction_id: string;
  scheduled_at: number;
  attempt: number;
  handler: () => Promise<void>;
}

@Injectable()
export class RetryQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(RetryQueueService.name);
  private readonly jobs = new Map<string, NodeJS.Timeout>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Programme un retry. Le handler doit être idempotent (on peut
   * l'appeler plusieurs fois sans effet de bord cumulé).
   */
  async schedule(
    transactionId: string,
    handler: () => Promise<void>,
    attemptOverride?: number,
  ): Promise<void> {
    const tx = await this.prisma.transactions.findUnique({
      where: { id: transactionId },
      select: { attempts: true, status: true },
    });
    if (!tx) {
      this.logger.warn(`schedule: transaction ${transactionId} introuvable.`);
      return;
    }
    if (tx.status === 'SUCCESS' || tx.status === 'ESCROW') {
      // Déjà résolu, pas de retry.
      return;
    }
    const attempt = attemptOverride ?? tx.attempts ?? 0;
    if (attempt >= MAX_ATTEMPTS) {
      this.logger.warn(
        `Max retries atteint pour tx ${transactionId} (${attempt})`,
      );
      await this.prisma.transactions.update({
        where: { id: transactionId },
        data: { status: 'FAILED', failed_reason: 'MAX_RETRIES_EXCEEDED' },
      });
      return;
    }

    const delay = BACKOFFS_MS[attempt];
    const timer = setTimeout(async () => {
      try {
        await this.prisma.transactions.update({
          where: { id: transactionId },
          data: { attempts: { increment: 1 }, last_attempt_at: new Date() },
        });
        await handler();
      } catch (e: any) {
        this.logger.warn(`Retry ${attempt} KO pour ${transactionId}: ${e?.message}`);
        // Re-programme avec attempt + 1
        void this.schedule(transactionId, handler, attempt + 1);
      } finally {
        this.jobs.delete(transactionId);
      }
    }, delay);
    this.jobs.set(transactionId, timer);
    this.logger.log(`Retry #${attempt + 1} programmé pour ${transactionId} dans ${delay}ms`);
  }

  /** Annule un retry programmé. */
  cancel(transactionId: string): void {
    const t = this.jobs.get(transactionId);
    if (t) {
      clearTimeout(t);
      this.jobs.delete(transactionId);
    }
  }

  onModuleDestroy() {
    for (const t of this.jobs.values()) clearTimeout(t);
    this.jobs.clear();
  }
}
