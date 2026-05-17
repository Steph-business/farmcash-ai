// =====================================================================
//  ReconciliationCronService
//  ---------------------------------------------------------------------
//  Lance la réconciliation comptable une fois par 24h.
//  Si un drift est détecté → log WARN + (futurs hooks : Slack, email).
//
//  Implémentation simple via setInterval — pas de dépendance externe.
//  En prod sérieuse : remplacer par @nestjs/schedule + cron expression,
//  ou par un job externe (k8s CronJob, GitHub Actions, etc.).
// =====================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FinanceService } from '../finance.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ReconciliationCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationCronService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly finance: FinanceService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Désactivé en test pour ne pas polluer les logs.
    if (this.config.get<string>('DISABLE_RECONCILIATION_CRON') === 'true') {
      this.logger.log('Reconciliation cron désactivé (env).');
      return;
    }

    // Premier passage : 1 min après boot, pour ne pas bloquer le démarrage.
    setTimeout(() => this.runOnce(), 60_000);
    this.timer = setInterval(() => this.runOnce(), DAY_MS);
    this.logger.log('Reconciliation cron : daily (24h)');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce() {
    try {
      const report = await this.finance.reconcile();
      if (report.status === 'OK') {
        this.logger.log(
          `Réconciliation OK — wallets=${report.sums.wallets_total}`,
        );
      } else {
        this.logger.warn(
          `⚠️ DRIFT détecté : ${report.drift} (wallets=${report.sums.wallets_total}, attendu=${report.sums.expected_system_balance})`,
        );
      }
    } catch (e: any) {
      this.logger.error(`Reconciliation crashed: ${e?.message}`);
    }
  }
}
