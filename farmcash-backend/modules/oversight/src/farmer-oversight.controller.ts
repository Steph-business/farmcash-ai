// =====================================================================
//  CONTROLLER : FarmerOversightController
//  ---------------------------------------------------------------------
//  Dashboard pour les producteurs. Vue agrégée : ventes, conversion
//  annonces, état des cultures, candidatures en attente, revenus.
// =====================================================================

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { FarmerOversightService } from './farmer-oversight.service';
import { TimelineQueryDto, TopQueryDto } from './dto/oversight.dto';

@ApiTags('👁️ Oversight Producteur')
@Controller('oversight/farmer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('FARMER')
@ApiBearerAuth()
export class FarmerOversightController {
  constructor(private readonly service: FarmerOversightService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Tableau de bord FARMER (annonces, revenus 30j, commandes à expédier, alertes cultures)',
  })
  getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOverview(user.sub);
  }

  @Get('conversion-funnel')
  @ApiOperation({
    summary: 'Funnel de conversion par annonce (vues → candidatures → commandes)',
  })
  getConversionFunnel(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getConversionFunnel(user.sub);
  }

  @Get('revenue-timeline')
  @ApiOperation({
    summary: 'Revenus hebdo (direct vs via coop) sur 7d / 30d / 90d / year',
  })
  revenueTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TimelineQueryDto,
  ) {
    return this.service.revenueTimeline(user.sub, query.period);
  }

  @Get('top-buyers')
  @ApiOperation({ summary: 'Top N acheteurs récurrents (lifetime value)' })
  topBuyers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TopQueryDto,
  ) {
    return this.service.topBuyers(user.sub, query.limit);
  }

  @Get('health-alerts')
  @ApiOperation({
    summary: 'Alertes santé cultures (analyses HIGH/CRITICAL + traitements suggérés)',
  })
  healthAlerts(@CurrentUser() user: AuthenticatedUser) {
    return this.service.healthAlerts(user.sub);
  }

  @Get('pending-actions')
  @ApiOperation({
    summary: 'Actions en attente (candidatures, livraisons, conversions prévision)',
  })
  pendingActions(@CurrentUser() user: AuthenticatedUser) {
    return this.service.pendingActions(user.sub);
  }
}
