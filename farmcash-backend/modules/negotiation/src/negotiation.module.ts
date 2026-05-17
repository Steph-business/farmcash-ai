// =====================================================================
//  MODULE : NegotiationModule
//  ---------------------------------------------------------------------
//  Trois flux de négociation regroupés dans un seul controller +
//  service (par souci de cohérence : ce sont les mêmes invariants
//  state machine sur 3 entités jumelles).
//
//  Exporte le service pour que le module Orders puisse, lors de la
//  création d'une commande, vérifier qu'une négociation a bien été
//  ACCEPTED en amont.
// =====================================================================

import { Module } from '@nestjs/common';
import { CandidaturesController } from './candidatures.controller';
import { CandidaturesService } from './candidatures.service';

@Module({
  controllers: [CandidaturesController],
  providers: [CandidaturesService],
  exports: [CandidaturesService],
})
export class NegotiationModule {}
