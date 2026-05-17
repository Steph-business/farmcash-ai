// =====================================================================
//  OrdersCleanupCron
//  ---------------------------------------------------------------------
//  Annule chaque heure les commandes SENT > 24h (orphelines suite à
//  échec payin non remonté). Restore le stock.
//
//  Désactivable via DISABLE_ORDERS_CLEANUP=true (utile en tests).
// =====================================================================

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from './orders.service';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class OrdersCleanupCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersCleanupCron.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('DISABLE_ORDERS_CLEANUP') === 'true') {
      this.logger.log('Orders cleanup cron désactivé (env).');
      return;
    }
    // 1er passage 5 minutes après boot, puis chaque heure.
    setTimeout(() => this.runOnce(), 5 * 60 * 1000);
    this.timer = setInterval(() => this.runOnce(), HOUR_MS);
    this.logger.log('Orders cleanup cron : hourly');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce() {
    try {
      const result = await this.orders.cleanupOrphanOrders(24);
      if (result.cancelled > 0) {
        this.logger.warn(`Cleanup orphan orders: ${result.cancelled} cancelled`);
      }
    } catch (e: any) {
      this.logger.error(`Orders cleanup crashed: ${e?.message}`);
    }
  }
}
