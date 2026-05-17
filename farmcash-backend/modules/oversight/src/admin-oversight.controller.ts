// =====================================================================
//  CONTROLLER : AdminOversightController
//  ---------------------------------------------------------------------
//  Routes ADMIN — accès strictement réservé au rôle ADMIN.
//
//  Toutes les routes sont préfixées `/api/oversight/admin/*` et exigent
//  JWT + `@Roles('ADMIN')`. Aucune route mutation sauf freeze/deactivate.
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import {
  AdminPermission,
  AdminPermissionGuard,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from '@farmcash/auth';
import { AdminOversightService } from './admin-oversight.service';
import {
  FreezeWalletDto,
  ListOrdersQueryDto,
  ListTransactionsQueryDto,
  ListUsersQueryDto,
  TimelineQueryDto,
} from './dto/oversight.dto';

@ApiTags('👁️ Oversight Admin')
@Controller('oversight/admin')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminOversightController {
  constructor(private readonly service: AdminOversightService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Dashboard global FarmCash (KPIs)' })
  getOverview() {
    return this.service.getOverview();
  }

  // ----- Users -----

  @Get('users')
  @ApiOperation({ summary: 'Lister tous les users (filtres rôle + search)' })
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.service.listUsers(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Profil complet (user + wallet + activité)' })
  getUserProfile(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getUserProfile(id);
  }

  @Post('users/:id/deactivate')
  @AdminPermission('peut_gerer_users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Désactiver un compte (révoque aussi les sessions)' })
  deactivateUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.deactivateUser(admin.sub, id);
  }

  @Post('users/:id/reactivate')
  @AdminPermission('peut_gerer_users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réactiver un compte désactivé' })
  reactivateUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.reactivateUser(admin.sub, id);
  }

  // ----- Wallets -----

  @Post('users/:id/wallet/freeze')
  @AdminPermission('peut_gerer_users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Geler le wallet (anti-fraude)' })
  freezeWallet(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: FreezeWalletDto,
  ) {
    return this.service.freezeWallet(admin.sub, id, dto);
  }

  @Post('users/:id/wallet/unfreeze')
  @AdminPermission('peut_gerer_users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dégeler un wallet' })
  unfreezeWallet(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.unfreezeWallet(admin.sub, id);
  }

  // ----- Transactions / Orders / Escrows / Disputes -----

  @Get('transactions')
  @ApiOperation({ summary: 'Toutes les transactions paginées + filtres' })
  listTransactions(@Query() query: ListTransactionsQueryDto) {
    return this.service.listTransactions(query);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Toutes les commandes paginées + filtre status' })
  listOrders(@Query() query: ListOrdersQueryDto) {
    return this.service.listOrders(query);
  }

  @Get('disputes/open')
  @ApiOperation({ summary: 'Litiges ouverts (à arbitrer)' })
  listOpenDisputes() {
    return this.service.listOpenDisputes();
  }

  @Get('escrows/locked')
  @ApiOperation({ summary: 'Escrows actuellement bloqués (jusqu\'à 100)' })
  listLockedEscrows() {
    return this.service.listLockedEscrows();
  }

  @Get('revenue-timeline')
  @ApiOperation({ summary: 'Revenu plateforme hebdo (frais service)' })
  revenueTimeline(@Query() query: TimelineQueryDto) {
    return this.service.revenueTimeline(query.period);
  }

  @Get('treasury/history')
  @ApiOperation({ summary: 'Historique TREASURY (200 dernières transactions sur période)' })
  treasuryHistory(@Query() query: TimelineQueryDto) {
    return this.service.treasuryHistory(query.period);
  }

  @Get('system-health')
  @ApiOperation({
    summary: 'Santé système : circuit breakers, orphelins, alertes opérationnelles',
  })
  systemHealth() {
    return this.service.systemHealth();
  }
}
