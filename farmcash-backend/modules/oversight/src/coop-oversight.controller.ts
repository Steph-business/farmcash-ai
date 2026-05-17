// =====================================================================
//  CONTROLLER : CoopOversightController
//  ---------------------------------------------------------------------
//  Routes COOPERATIVE — vue agrégée des membres + activité.
//  L'id de coopérative vient du JWT (user.cooperative_id).
// =====================================================================

import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { CoopOversightService } from './coop-oversight.service';
import {
  PaginationQueryDto,
  TimelineQueryDto,
  TopQueryDto,
} from './dto/oversight.dto';

@ApiTags('👁️ Oversight Coopérative')
@Controller('oversight/coop')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COOPERATIVE')
@ApiBearerAuth()
export class CoopOversightController {
  constructor(private readonly service: CoopOversightService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Tableau de bord coopérative (KPIs membres)' })
  getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOverview(user.cooperative_id);
  }

  @Get('members')
  @ApiOperation({ summary: 'Liste paginée de mes membres' })
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.listMembers(user.cooperative_id, query);
  }

  @Get('members/annonces')
  @ApiOperation({ summary: 'Annonces de vente actives de mes membres' })
  listMemberAnnonces(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.listMemberAnnonces(user.cooperative_id, query);
  }

  @Get('members/orders')
  @ApiOperation({ summary: 'Commandes (en tant que seller) impliquant mes membres' })
  listMemberOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.listMemberOrders(user.cooperative_id, query);
  }

  @Get('revenue-timeline')
  @ApiOperation({ summary: 'Revenu coop hebdo (ventes des publications)' })
  revenueTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TimelineQueryDto,
  ) {
    return this.service.revenueTimeline(user.cooperative_id, query.period);
  }

  @Get('top-contributors')
  @ApiOperation({ summary: 'Top membres contributeurs sur la période' })
  topContributors(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TopQueryDto,
  ) {
    return this.service.topContributors(
      user.cooperative_id,
      query.period,
      query.limit,
    );
  }

  @Get('upcoming-conversions')
  @ApiOperation({
    summary: 'Prévisions à convertir bientôt (< 14j) — alerte gérant',
  })
  upcomingConversions(@CurrentUser() user: AuthenticatedUser) {
    return this.service.upcomingConversions(user.cooperative_id);
  }

  @Get('advances-aging')
  @ApiOperation({ summary: 'Aging des avances PAID (0-30j, 30-60j, 60-90j, 90j+)' })
  advancesAging(@CurrentUser() user: AuthenticatedUser) {
    return this.service.advancesAging(user.cooperative_id);
  }
}
