// =====================================================================
//  MODULE : OversightModule
//  ---------------------------------------------------------------------
//  Module de supervision avec 6 vues, une par rôle métier :
//
//   • AdminOversightController       → /oversight/admin/*       (ADMIN)
//   • CoopOversightController        → /oversight/coop/*        (COOPERATIVE)
//   • ExporterOversightController    → /oversight/exporter/*    (EXPORTER)
//   • BuyerOversightController       → /oversight/buyer/*       (BUYER)
//   • TransporterOversightController → /oversight/transporter/* (TRANSPORTER)
//   • FarmerOversightController      → /oversight/farmer/*      (FARMER)
//
//  Aucune logique métier propre : ce module agrège et lit ce qui
//  existe ailleurs. Seules exceptions : freeze wallet / deactivate
//  user côté admin, qui mutent des flags simples.
// =====================================================================

import { Module } from '@nestjs/common';
import { AdminOversightController } from './admin-oversight.controller';
import { AdminOversightService } from './admin-oversight.service';
import { CoopOversightController } from './coop-oversight.controller';
import { CoopOversightService } from './coop-oversight.service';
import { ExporterOversightController } from './exporter-oversight.controller';
import { ExporterOversightService } from './exporter-oversight.service';
import { BuyerOversightController } from './buyer-oversight.controller';
import { BuyerOversightService } from './buyer-oversight.service';
import { TransporterOversightController } from './transporter-oversight.controller';
import { TransporterOversightService } from './transporter-oversight.service';
import { FarmerOversightController } from './farmer-oversight.controller';
import { FarmerOversightService } from './farmer-oversight.service';

@Module({
  controllers: [
    AdminOversightController,
    CoopOversightController,
    ExporterOversightController,
    BuyerOversightController,
    TransporterOversightController,
    FarmerOversightController,
  ],
  providers: [
    AdminOversightService,
    CoopOversightService,
    ExporterOversightService,
    BuyerOversightService,
    TransporterOversightService,
    FarmerOversightService,
  ],
  exports: [
    AdminOversightService,
    CoopOversightService,
    ExporterOversightService,
    BuyerOversightService,
    TransporterOversightService,
    FarmerOversightService,
  ],
})
export class OversightModule {}
