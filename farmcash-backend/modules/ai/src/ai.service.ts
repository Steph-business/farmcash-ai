// =====================================================================
//  SERVICE : AiService
//  ---------------------------------------------------------------------
//  Service "racine" du module AI. Contient juste le ping de santé.
//  Les vraies logiques sont dans :
//   • PlantAnalysesService    (modules/ai/src/plant-analyses.service.ts)
//   • TreatmentsService       (modules/ai/src/treatments.service.ts)
//   • TraceabilityService     (modules/ai/src/traceability.service.ts)
// =====================================================================

import { Injectable } from '@nestjs/common';

@Injectable()
export class AiService {
  ping(): { module: string; status: string } {
    return { module: 'ai', status: 'ok' };
  }
}
