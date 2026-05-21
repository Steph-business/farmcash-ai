// =====================================================================
//  MODULE : CoopLogisticsModule
//  ---------------------------------------------------------------------
//  Logistique interne d'une coopérative :
//   • Parc véhicules détenu par la coop (coop_vehicles)
//   • Collectes membre → coop (coop_collections)
//
//  Distinct de LogisticsModule qui couvre le transport tiers (shipments
//  buyer/seller). Ici on est dans l'agrégation et le ramassage amont.
// =====================================================================

import { Module } from '@nestjs/common';
import { AuthModule } from '@farmcash/auth';
import { NotificationsModule } from '@farmcash/notifications';
import { CoopLogisticsController } from './coop-logistics.controller';
import { CoopVehiclesService } from './coop-vehicles.service';
import { CoopCollectionsService } from './coop-collections.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [CoopLogisticsController],
  providers: [CoopVehiclesService, CoopCollectionsService],
  exports: [CoopVehiclesService, CoopCollectionsService],
})
export class CoopLogisticsModule {}
