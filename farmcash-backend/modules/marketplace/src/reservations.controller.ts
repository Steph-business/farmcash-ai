// =====================================================================
//  CONTROLLER : ReservationsController
//  ---------------------------------------------------------------------
//  Route dédiée au BUYER pour consulter ses réservations de prévisions
//  hors du sous-chemin /previsions. Pratique pour le menu "Mes
//  réservations" côté mobile.
// =====================================================================

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { PrevisionsService } from './previsions.service';

@ApiTags('🛒 Réservations BUYER')
@ApiBearerAuth()
@Controller('marketplace/reservations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReservationsController {
  constructor(private readonly previsionsService: PrevisionsService) {}

  @Get('my')
  @Roles('BUYER')
  @ApiOperation({
    summary: 'Lister mes réservations de prévisions (BUYER, alias)',
  })
  getMyReservations(@CurrentUser() user: AuthenticatedUser) {
    return this.previsionsService.getMyReservations(user.sub);
  }
}
