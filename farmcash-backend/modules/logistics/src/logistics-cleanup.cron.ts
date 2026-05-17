// =====================================================================
//  LogisticsCleanupCron
//  ---------------------------------------------------------------------
//  Toutes les heures : annule les shipments REQUESTED sans transporter
//  depuis plus de 48h. Refund l'escrow TRANSPORT du buyer.
//
//  Désactivable via DISABLE_LOGISTICS_CLEANUP=true (utile en tests).
// =====================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogisticsService } from './logistics.service';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class LogisticsCleanupCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogisticsCleanupCron.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly logistics: LogisticsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('DISABLE_LOGISTICS_CLEANUP') === 'true') {
      this.logger.log('Logistics cleanup cron désactivé (env).');
      return;
    }
    setTimeout(() => this.runOnce(), 10 * 60 * 1000); // 1er passage 10 min après boot
    this.timer = setInterval(() => this.runOnce(), HOUR_MS);
    this.logger.log('Logistics cleanup cron : hourly');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce() {
    try {
      const result = await this.logistics.cleanupOrphanShipments(48);
      if (result.cancelled > 0) {
        this.logger.warn(
          `Shipments orphelins annulés : ${result.cancelled} (>48h sans transporteur)`,
        );
      }
    } catch (e: any) {
      this.logger.error(`Logistics cleanup crashed: ${e?.message}`);
    }
  }
}
