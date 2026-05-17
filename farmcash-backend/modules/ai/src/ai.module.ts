// =====================================================================
//  MODULE : AiModule
//  ---------------------------------------------------------------------
//  Six services internes :
//   • AiService              : health
//   • PlantAnalysesService   : diagnostic photo (utilise PlantAiProvider)
//   • TreatmentsService      : catalogue de traitements
//   • TraceabilityService    : timeline lots (exporté pour DI)
//   • AiAssistantService     : chat conversationnel (utilise LlmProvider)
//   • AiInsightsService      : insights personnalisés
//   • AiNewsService          : fil d'actualité
//
//  Dépend de MarketplaceModule (l'assistant peut publier une annonce).
// =====================================================================

import { Module } from '@nestjs/common';
import { MarketplaceModule } from '@farmcash/marketplace';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PlantAnalysesService } from './plant-analyses.service';
import { TreatmentsService } from './treatments.service';
import { TraceabilityService } from './traceability.service';
import { AiAssistantService } from './ai-assistant.service';
import { AiInsightsService } from './ai-insights.service';
import { AiNewsService } from './ai-news.service';
import { PlantAiProvider } from './providers/plant-ai.provider';
import { LlmProvider } from './providers/llm.provider';

@Module({
  imports: [MarketplaceModule],
  controllers: [AiController],
  providers: [
    AiService,
    PlantAnalysesService,
    TreatmentsService,
    TraceabilityService,
    AiAssistantService,
    AiInsightsService,
    AiNewsService,
    PlantAiProvider,
    LlmProvider,
  ],
  exports: [
    AiService,
    PlantAnalysesService,
    TreatmentsService,
    TraceabilityService, // hook DI pour Marketplace/Orders/Logistics
    AiInsightsService,
    AiNewsService,
  ],
})
export class AiModule {}
