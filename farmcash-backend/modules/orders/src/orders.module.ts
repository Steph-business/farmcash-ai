// =====================================================================
//  MODULE : OrdersModule
//  ---------------------------------------------------------------------
//  Dépend de FinanceModule (pour processPayin + releaseEscrow) et
//  de NotificationsModule (pour notifier buyer/seller à chaque
//  transition de statut).
// =====================================================================

import { Module } from '@nestjs/common';
import { FinanceModule } from '@farmcash/finance';
import { NotificationsModule } from '@farmcash/notifications';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersCleanupCron } from './orders-cleanup.cron';

@Module({
  imports: [FinanceModule, NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersCleanupCron],
  exports: [OrdersService],
})
export class OrdersModule {}
