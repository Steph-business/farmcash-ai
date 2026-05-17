// =====================================================================
//  CONTROLLER : AiController
//  ---------------------------------------------------------------------
//  Six sous-domaines exposés depuis le même controller :
//
//   • Plant Analyses     : FARMER analyse une photo, consulte historique
//   • Treatments         : catalogue (GET libre, CRUD ADMIN)
//   • Traceability       : lecture publique par scan QR, écriture interne
//   • Assistant (chat)   : conversationnel + tool-use (publier annonce, etc.)
//   • Insights           : cartes personnalisées (tendances prix, alertes…)
//   • News               : fil d'actualité (CRUD ADMIN, lecture filtrée)
// =====================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import {
  AdminPermission,
  AdminPermissionGuard,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from '@farmcash/auth';
import { AiService } from './ai.service';
import { PlantAnalysesService } from './plant-analyses.service';
import { TreatmentsService } from './treatments.service';
import { TraceabilityService } from './traceability.service';
import { AiAssistantService } from './ai-assistant.service';
import { AiInsightsService } from './ai-insights.service';
import { AiNewsService } from './ai-news.service';
import {
  AnalyzePlantDto,
  ListPlantAnalysesQueryDto,
} from './dto/plant-analyses.dto';
import {
  CreateTreatmentDto,
  ListTreatmentsQueryDto,
  UpdateTreatmentDto,
} from './dto/treatments.dto';
import {
  ChatMessageDto,
  ListAiHistoryQueryDto,
} from './dto/assistant.dto';
import {
  CreateNewsDto,
  ListNewsQueryDto,
  UpdateNewsDto,
} from './dto/news.dto';

@ApiTags('🤖 IA & Traçabilité')
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly plantAnalyses: PlantAnalysesService,
    private readonly treatments: TreatmentsService,
    private readonly traceability: TraceabilityService,
    private readonly assistant: AiAssistantService,
    private readonly insights: AiInsightsService,
    private readonly news: AiNewsService,
  ) {}

  // ===================================================================
  //  HEALTH (public)
  // ===================================================================

  @Get('health')
  @ApiOperation({ summary: 'Sonde du module AI' })
  health() {
    return this.aiService.ping();
  }

  // ===================================================================
  //  PLANT ANALYSES
  // ===================================================================

  @Post('plant-analyses')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('FARMER', 'COOPERATIVE')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  // Rate limit anti-coût : chaque analyse appelle le provider IA (Plant.id,
  // ~0.05€/call). On limite à 20/heure/user pour prévenir l'abus.
  @Throttle({ default: { limit: 20, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: 'Analyser une photo de plante (diagnostic IA + recommandations)',
  })
  analyzePlant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AnalyzePlantDto,
  ) {
    return this.plantAnalyses.analyze(user.sub, dto);
  }

  @Get('plant-analyses')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('FARMER', 'COOPERATIVE')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mon historique d'analyses" })
  getMyAnalyses(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPlantAnalysesQueryDto,
  ) {
    return this.plantAnalyses.getMyAnalyses(user.sub, query);
  }

  @Get('plant-analyses/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('FARMER', 'COOPERATIVE')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Détail d'une analyse (ownership)" })
  getAnalysisById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.plantAnalyses.getById(user.sub, id);
  }

  // ===================================================================
  //  TREATMENTS
  // ===================================================================

  @Get('treatments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Catalogue de traitements (filtres maladie/culture/type)' })
  listTreatments(@Query() query: ListTreatmentsQueryDto) {
    return this.treatments.list(query);
  }

  @Get('treatments/for-analysis/:analysisId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Traitements recommandés pour une analyse IA' })
  getTreatmentsForAnalysis(
    @CurrentUser() user: AuthenticatedUser,
    @Param('analysisId', new ParseUUIDPipe()) analysisId: string,
  ) {
    return this.treatments.getForAnalysis(user.sub, analysisId);
  }

  @Get('treatments/search')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Autocomplete par nom (mobile : champ "traitements appliqués")',
    description: 'Min 2 caractères. Retourne max 20 résultats triés alphabétiquement.',
  })
  searchTreatments(@Query('q') q: string) {
    return this.treatments.search(q ?? '');
  }

  @Get('treatments/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Détail d'un traitement" })
  getTreatmentById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.treatments.getById(id);
  }

  @Post('treatments')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles('ADMIN')
  @AdminPermission('peut_publier_news')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'ADMIN : ajouter un traitement' })
  createTreatment(@Body() dto: CreateTreatmentDto) {
    return this.treatments.create(dto);
  }

  @Put('treatments/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles('ADMIN')
  @AdminPermission('peut_publier_news')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'ADMIN : modifier un traitement' })
  updateTreatment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTreatmentDto,
  ) {
    return this.treatments.update(id, dto);
  }

  @Delete('treatments/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles('ADMIN')
  @AdminPermission('peut_publier_news')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'ADMIN : supprimer un traitement' })
  deleteTreatment(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.treatments.delete(id);
  }

  // ===================================================================
  //  TRACEABILITY (public)
  // ===================================================================

  @Get('traceability/:lotId')
  @ApiOperation({
    summary: "Historique public d'un lot (scan QR, pas de JWT)",
  })
  getLotTraceability(@Param('lotId', new ParseUUIDPipe()) lotId: string) {
    return this.traceability.getLotHistory(lotId);
  }

  // ===================================================================
  //  ASSISTANT (chat conversationnel + tool-use)
  // ===================================================================

  @Post('assistant/chat')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Envoyer un message à l'assistant IA (chat conversationnel)",
  })
  chat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChatMessageDto,
  ) {
    return this.assistant.chat(user.sub, dto);
  }

  @Get('assistant/history')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Historique de ma session IA active' })
  getAssistantHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAiHistoryQueryDto,
  ) {
    return this.assistant.getHistory(user.sub, query);
  }

  @Post('assistant/reset')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Démarrer une nouvelle session (réinitialise le contexte)' })
  resetSession(@CurrentUser() user: AuthenticatedUser) {
    return this.assistant.resetSession(user.sub);
  }

  // ===================================================================
  //  INSIGHTS (cartes personnalisées)
  // ===================================================================

  @Get('insights/my')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Mes insights personnalisés (tendances prix, alertes, opportunités)",
  })
  getMyInsights(@CurrentUser() user: AuthenticatedUser) {
    return this.insights.getMyInsights(user.sub);
  }

  // ===================================================================
  //  NEWS (lecture filtrée par rôle, CRUD ADMIN)
  // ===================================================================

  @Get('news')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Fil d'actualité filtré pour mon rôle" })
  listNews(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNewsQueryDto,
  ) {
    return this.news.listForUser(user.sub, query);
  }

  @Get('news/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Détail d'une actualité" })
  getNewsById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.news.getById(id);
  }

  @Get('admin/news')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'ADMIN : toutes les actualités (incl. inactives)' })
  listAllNews(@Query() query: ListNewsQueryDto) {
    return this.news.listAll(query);
  }

  @Post('news')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles('ADMIN')
  @AdminPermission('peut_publier_news')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "ADMIN : publier une actualité" })
  createNews(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateNewsDto,
  ) {
    return this.news.create(user.sub, dto);
  }

  @Put('news/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles('ADMIN')
  @AdminPermission('peut_publier_news')
  @ApiBearerAuth()
  @ApiOperation({ summary: "ADMIN : modifier une actualité" })
  updateNews(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateNewsDto,
  ) {
    return this.news.update(id, dto);
  }

  @Delete('news/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles('ADMIN')
  @AdminPermission('peut_publier_news')
  @ApiBearerAuth()
  @ApiOperation({ summary: "ADMIN : désactiver une actualité" })
  deleteNews(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.news.delete(id);
  }
}
