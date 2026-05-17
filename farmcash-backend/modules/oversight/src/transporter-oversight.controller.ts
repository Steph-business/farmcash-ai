// =====================================================================
//  CONTROLLER : TransporterOversightController
//  ---------------------------------------------------------------------
//  Dashboard pour les transporteurs. Statistiques de revenus, missions,
//  performance par route.
// =====================================================================

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { TransporterOversightService } from './transporter-oversight.service';
import { TimelineQueryDto } from './dto/oversight.dto';

@ApiTags('👁️ Oversight Transporteur')
@Controller('oversight/transporter')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TRANSPORTER')
@ApiBearerAuth()
export class TransporterOversightController {
  constructor(private readonly service: TransporterOversightService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Tableau de bord TRANSPORTER (revenus 30j, missions, rating, wallet)',
  })
  getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOverview(user.sub);
  }

  @Get('top-routes')
  @ApiOperation({ summary: 'Top 5 routes par revenus générés' })
  getTopRoutes(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getTopRoutes(user.sub);
  }

  @Get('earnings-timeline')
  @ApiOperation({ summary: 'Revenus hebdo sur la période' })
  earningsTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TimelineQueryDto,
  ) {
    return this.service.earningsTimeline(user.sub, query.period);
  }

  @Get('delivery-stats')
  @ApiOperation({ summary: 'Stats livraison (temps moyen, taux complétion)' })
  deliveryStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TimelineQueryDto,
  ) {
    return this.service.deliveryStats(user.sub, query.period);
  }

  @Get('pending-actions')
  @ApiOperation({ summary: 'Missions à accepter, à charger, en transit' })
  pendingActions(@CurrentUser() user: AuthenticatedUser) {
    return this.service.pendingActions(user.sub);
  }
}
