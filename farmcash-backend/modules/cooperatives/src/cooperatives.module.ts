// =====================================================================
//  MODULE : CooperativesModule
//  ---------------------------------------------------------------------
//  Expose :
//   • PublicCooperativesController   → /cooperatives/*       (public)
//   • CoopManagementController       → /coop/*               (auth)
//   • SollicitationsController       → /coop/sollicitations  (auth)
//
//  Le service est ré-exporté pour permettre à d'autres modules
//  (auth pour l'inscription, marketplace pour la validation) de
//  réutiliser la logique métier (création de join-request, etc.).
//
//  forwardRef(() => AuthModule) :
//   • AuthModule importe déjà CooperativesModule (cycle existant)
//   • On a besoin de SmsProvider exporté par AuthModule pour le
//     fan-out SMS des sollicitations → forwardRef double-sens.
// =====================================================================

import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '@farmcash/auth';
import {
  CoopManagementController,
  PublicCooperativesController,
} from './cooperatives.controller';
import { CooperativesService } from './cooperatives.service';
import { SollicitationsController } from './sollicitations.controller';
import { SollicitationsService } from './sollicitations.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [
    PublicCooperativesController,
    CoopManagementController,
    SollicitationsController,
  ],
  providers: [CooperativesService, SollicitationsService],
  exports: [CooperativesService, SollicitationsService],
})
export class CooperativesModule {}
