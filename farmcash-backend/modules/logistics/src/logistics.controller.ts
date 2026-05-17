// =====================================================================
//  CONTROLLER : LogisticsController
//  ---------------------------------------------------------------------
//  Surface API du module logistique. Trois groupes de routes :
//
//   /logistics/routes              → CRUD des routes TRANSPORTER (TRANSPORTER)
//   /logistics/quotes              → Devis transport (BUYER, COOP, ADMIN)
//   /logistics/missions/available  → Missions dispo (TRANSPORTER)
//   /logistics/shipments/*         → Cycle de vie d'une mission
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
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { LogisticsService } from './logistics.service';
import {
  CreateTransporterRouteDto,
  QuoteTransportQueryDto,
  UpdateTransporterRouteDto,
} from './dto/routes.dto';
import {
  MarkDeliveredDto,
  PickupQrTokenResponseDto,
  ScanPickupDto,
  StartLoadingDto,
  TrackPositionDto,
} from './dto/shipments.dto';

@ApiTags('🚚 Logistique')
@Controller('logistics')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class LogisticsController {
  constructor(private readonly logisticsService: LogisticsService) {}

  // ----------------- ROUTES TRANSPORTEUR -----------------

  @Get('routes/my')
  @Roles('TRANSPORTER')
  @ApiOperation({ summary: 'Mes routes déclarées (TRANSPORTER)' })
  getMyRoutes(@CurrentUser() user: AuthenticatedUser) {
    return this.logisticsService.getMyRoutes(user.sub);
  }

  @Post('routes')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Déclarer une route avec son tarif' })
  createRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTransporterRouteDto,
  ) {
    return this.logisticsService.createRoute(user.sub, dto);
  }

  @Put('routes/:id')
  @Roles('TRANSPORTER')
  @ApiOperation({ summary: 'Modifier une route (tarif, capacité, statut)' })
  updateRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTransporterRouteDto,
  ) {
    return this.logisticsService.updateRoute(user.sub, id, dto);
  }

  @Delete('routes/:id')
  @Roles('TRANSPORTER')
  @ApiOperation({ summary: 'Désactiver une route' })
  deleteRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.logisticsService.deleteRoute(user.sub, id);
  }

  // ----------------- DEVIS -----------------

  @Get('quotes')
  @ApiOperation({
    summary: 'Devis transport pour un trajet (offres triées par prix croissant)',
  })
  getQuotes(@Query() query: QuoteTransportQueryDto) {
    return this.logisticsService.getQuotes(query);
  }

  // ----------------- MISSIONS DISPONIBLES -----------------

  @Get('missions/available')
  @Roles('TRANSPORTER')
  @ApiOperation({ summary: 'Missions REQUESTED qui matchent mes routes' })
  getAvailableMissions(@CurrentUser() user: AuthenticatedUser) {
    return this.logisticsService.getAvailableMissions(user.sub);
  }

  // ----------------- LIFECYCLE D'UN SHIPMENT -----------------

  @Post('shipments/:id/accept')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accepter une mission (premier arrivé, premier servi)' })
  acceptShipment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.logisticsService.acceptShipment(user.sub, id);
  }

  @Post('shipments/:id/start-loading')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Déclarer le chargement chez le vendeur' })
  startLoading(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StartLoadingDto,
  ) {
    return this.logisticsService.startLoading(user.sub, id, dto);
  }

  @Post('shipments/:id/track')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envoyer une position GPS (et basculer IN_TRANSIT si besoin)',
  })
  trackPosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TrackPositionDto,
  ) {
    return this.logisticsService.markInTransit(user.sub, id, dto);
  }

  @Post('shipments/:id/deliver')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Marquer livré (photo preuve obligatoire). Bascule commande en DELIVERED.',
  })
  markDelivered(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkDeliveredDto,
  ) {
    return this.logisticsService.markDelivered(user.sub, id, dto);
  }

  @Post('shipments/:id/cancel')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Annuler une mission (avant DELIVERED)' })
  cancelShipment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.logisticsService.cancelShipment(user.sub, id);
  }

  // ----------------- TRACKING (lecture) -----------------

  @Get('shipments/:id/tracking')
  @ApiOperation({ summary: "Historique GPS de la livraison (parties à la commande)" })
  getTracking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.logisticsService.getTracking(user.sub, id);
  }

  // ----------------- QR PICKUP (Chantier 1) -----------------

  @Get('shipments/:id/qr-token')
  @Roles('FARMER')
  @ApiOperation({
    summary:
      "Générer un QR signé (15 min) pour preuve d'enlèvement (FARMER seller uniquement)",
  })
  @ApiOkResponse({ type: PickupQrTokenResponseDto })
  @ApiResponse({ status: 403, description: 'Vous n\'êtes pas le vendeur de la commande' })
  @ApiResponse({ status: 404, description: 'Shipment introuvable' })
  @ApiResponse({ status: 409, description: 'Shipment status !== ACCEPTED' })
  generatePickupQrToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.logisticsService.generatePickupQrToken(user.sub, id);
  }

  @Post('shipments/:id/scan-pickup')
  @Roles('TRANSPORTER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Scanner le QR du producteur → LOADING + auto-release escrow PRODUCT (TRANSPORTER)",
  })
  @ApiResponse({ status: 200, description: 'Scan validé, escrow PRODUCT libéré' })
  @ApiResponse({ status: 400, description: 'Token invalide / expiré / GPS > 500m' })
  @ApiResponse({ status: 403, description: 'Mission non rattachée à votre compte' })
  @ApiResponse({ status: 404, description: 'Shipment introuvable' })
  @ApiResponse({
    status: 409,
    description: 'Shipment status !== ACCEPTED ou déjà scanné',
  })
  scanPickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ScanPickupDto,
  ) {
    return this.logisticsService.scanPickup(user.sub, id, dto);
  }
}
