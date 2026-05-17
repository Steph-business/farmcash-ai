// =====================================================================
//  CONTROLLER : SollicitationsController (Chantier 2)
//  ---------------------------------------------------------------------
//  Préfixe d'URL : /coop/sollicitations
//
//  Endpoints :
//    POST   /coop/sollicitations            (COOPERATIVE)   création + fan-out
//    GET    /coop/sollicitations            (COOPERATIVE)   liste pour la coop
//    GET    /coop/sollicitations/:id        (COOPERATIVE|FARMER)  détail + agrégats
//    POST   /coop/sollicitations/:id/respond (FARMER|COOPERATIVE) réponse destinataire
//    POST   /coop/sollicitations/:id/close   (COOPERATIVE)   fermeture manuelle
// =====================================================================

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
// Import direct (cf. cooperatives.controller.ts) pour éviter le cycle.
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth/guards/jwt.guard';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { SollicitationsService } from './sollicitations.service';
import {
  CreateSollicitationDto,
  ListerSollicitationsQueryDto,
  RespondSollicitationDto,
} from './dto/sollicitations.dto';

@ApiTags('🏢 Cooperatives — Sollicitations')
@ApiBearerAuth()
@Controller('coop/sollicitations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SollicitationsController {
  constructor(private readonly service: SollicitationsService) {}

  @Post()
  @Roles('COOPERATIVE')
  @ApiOperation({
    summary:
      '[COOP] Créer une sollicitation et fan-out aux audiences cochées',
  })
  @ApiResponse({ status: 201, description: 'Sollicitation créée + destinataires dispatchés' })
  @ApiResponse({ status: 400, description: 'Annonce PUBLIC ou audiences vides' })
  @ApiResponse({ status: 403, description: 'Annonce non ciblée sur la coop' })
  @ApiResponse({ status: 404, description: 'Annonce introuvable' })
  @ApiResponse({ status: 409, description: 'Annonce inactive' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSollicitationDto,
  ) {
    return this.service.createSollicitation(user.sub, dto);
  }

  @Get()
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Liste paginée des sollicitations de la coop' })
  @ApiResponse({ status: 200 })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListerSollicitationsQueryDto,
  ) {
    return this.service.listForCoop(user.sub, query);
  }

  @Get(':id')
  @Roles('COOPERATIVE', 'FARMER')
  @ApiOperation({
    summary:
      '[COOP|FARMER] Détail d\'une sollicitation + agrégats (coop initiatrice OU destinataire)',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'Ni initiateur ni destinataire' })
  @ApiResponse({ status: 404 })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(user.sub, id);
  }

  @Post(':id/respond')
  @HttpCode(HttpStatus.OK)
  @Roles('FARMER', 'COOPERATIVE')
  @ApiOperation({
    summary:
      '[FARMER|COOP] Répondre à une sollicitation (ACCEPTED / REJECTED)',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'quantite_kg manquante si ACCEPTED' })
  @ApiResponse({ status: 403, description: 'Pas destinataire' })
  @ApiResponse({ status: 409, description: 'Déjà répondu / sollicitation fermée' })
  @ApiResponse({ status: 410, description: 'Sollicitation expirée' })
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondSollicitationDto,
  ) {
    return this.service.respond(user.sub, id, dto);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Roles('COOPERATIVE')
  @ApiOperation({
    summary: '[COOP] Clôturer manuellement la sollicitation (avant auto-FULFILLED)',
  })
  @ApiResponse({ status: 200, description: 'status: CLOSED' })
  @ApiResponse({ status: 403, description: 'Non initiateur' })
  @ApiResponse({ status: 409, description: 'Sollicitation déjà fermée/remplie' })
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.close(user.sub, id);
  }
}
