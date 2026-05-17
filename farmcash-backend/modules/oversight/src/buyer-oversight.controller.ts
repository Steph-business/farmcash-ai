// =====================================================================
//  CONTROLLER : BuyerOversightController
//  ---------------------------------------------------------------------
//  Dashboard pour les acheteurs locaux (rôle BUYER). Routes en lecture
//  seule, ownership stricte via le JWT (user.sub).
// =====================================================================

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { BuyerOversightService } from './buyer-oversight.service';
import { TimelineQueryDto, TopQueryDto } from './dto/oversight.dto';

@ApiTags('👁️ Oversight Buyer')
@Controller('oversight/buyer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('BUYER')
@ApiBearerAuth()
export class BuyerOversightController {
  constructor(private readonly service: BuyerOversightService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      "Tableau de bord BUYER (commandes en cours, dépenses 30j, panier, wallet)",
  })
  getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOverview(user.sub);
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Top 5 produits que j\'achète le plus' })
  getTopProducts(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getTopProducts(user.sub);
  }

  @Get('spending-timeline')
  @ApiOperation({ summary: 'Dépenses hebdo (7d / 30d / 90d / year)' })
  spendingTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TimelineQueryDto,
  ) {
    return this.service.spendingTimeline(user.sub, query.period);
  }

  @Get('favorite-sellers')
  @ApiOperation({ summary: 'Sellers chez qui j\'achète le plus souvent' })
  favoriteSellers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TopQueryDto,
  ) {
    return this.service.favoriteSellers(user.sub, query.limit);
  }

  @Get('active-orders')
  @ApiOperation({ summary: 'Commandes en cours détaillées (avec shipments)' })
  activeOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.service.activeOrders(user.sub);
  }
}
