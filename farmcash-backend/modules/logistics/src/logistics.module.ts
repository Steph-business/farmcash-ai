// =====================================================================
//  MODULE : LogisticsModule
//  ---------------------------------------------------------------------
//  Dépend de FinanceModule (pour affecter le bénéficiaire de l'escrow
//  TRANSPORT à l'acceptation) et NotificationsModule (alertes mission
//  disponible, livraison effectuée).
// =====================================================================

import { Module } from '@nestjs/common';
import { FinanceModule } from '@farmcash/finance';
import { NotificationsModule } from '@farmcash/notifications';
import { LogisticsController } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import { LogisticsCleanupCron } from './logistics-cleanup.cron';

@Module({
  imports: [FinanceModule, NotificationsModule],
  controllers: [LogisticsController],
  providers: [LogisticsService, LogisticsCleanupCron],
  exports: [LogisticsService],
})
export class LogisticsModule {}
