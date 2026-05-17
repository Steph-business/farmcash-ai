// =====================================================================
//  CONTROLLER : PrevisionsController
//  ---------------------------------------------------------------------
//  Prévisions de récolte (FARMER) et réservations sur ces prévisions
//  (BUYER). Deux flows distincts, deux jeux de permissions.
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { PrevisionsService } from './previsions.service';
import {
  ConvertPrevisionDto,
  CreatePrevisionDto,
  CreateReservationDto,
} from './dto/previsions.dto';

@ApiTags('📅 Prévisions & Réservations Futures')
@Controller('marketplace/previsions')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PrevisionsController {
  constructor(private readonly previsionsService: PrevisionsService) {}

  @Get()
  @Roles('FARMER')
  @ApiOperation({ summary: 'Lister mes prévisions de production (FARMER)' })
  getMesPrevisions(@CurrentUser() user: AuthenticatedUser) {
    return this.previsionsService.getMesPrevisions(user.sub);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('FARMER')
  @ApiOperation({ summary: 'Enregistrer une prévision de production (FARMER)' })
  createPrevision(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePrevisionDto,
  ) {
    return this.previsionsService.createPrevision(user.sub, dto);
  }

  @Post('reserver')
  @HttpCode(HttpStatus.CREATED)
  @Roles('BUYER')
  @ApiOperation({
    summary: 'Réserver une quantité sur une prévision (BUYER, acompte 10%)',
    description:
      "Verse immédiatement l'acompte (10% par défaut) via Mobile Money. Le buyer doit fournir payment_method_id.",
  })
  reserverPrevision(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReservationDto,
  ) {
    return this.previsionsService.reserverPrevision(user.sub, dto);
  }

  @Post(':id/convert')
  @HttpCode(HttpStatus.CREATED)
  @Roles('FARMER', 'COOPERATIVE')
  @ApiOperation({
    summary: 'Convertir une prévision en annonce officielle',
    description:
      "Le producteur déclenche la conversion quand la récolte est prête. Crée l'annonce, notifie tous les buyers réservés.",
  })
  convertPrevision(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConvertPrevisionDto,
  ) {
    return this.previsionsService.convertPrevision(user.sub, user.role, id, dto);
  }
}
