// =====================================================================
//  CONTROLLER : CoopLogisticsController
//  ---------------------------------------------------------------------
//  Préfixe : /coop/logistics
//
//  Endpoints :
//    GET    /coop/logistics/vehicles                       (COOPERATIVE)
//    POST   /coop/logistics/vehicles                       (COOPERATIVE)
//    PUT    /coop/logistics/vehicles/:id                   (COOPERATIVE, ownership)
//    DELETE /coop/logistics/vehicles/:id                   (COOPERATIVE, soft delete)
//
//    GET    /coop/logistics/collections                    (COOPERATIVE)
//    POST   /coop/logistics/collections                    (COOPERATIVE)
//    PUT    /coop/logistics/collections/:id                (COOPERATIVE, ownership)
//    POST   /coop/logistics/collections/:id/complete       (COOPERATIVE)
//    DELETE /coop/logistics/collections/:id                (COOPERATIVE, soft cancel)
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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { CoopVehiclesService } from './coop-vehicles.service';
import { CoopCollectionsService } from './coop-collections.service';
import {
  CreateCoopVehicleDto,
  UpdateCoopVehicleDto,
} from './dto/vehicles.dto';
import {
  CreateCoopCollectionDto,
  ListCoopCollectionsQueryDto,
  UpdateCoopCollectionDto,
} from './dto/collections.dto';

@ApiTags('🏢 Coop Logistique')
@Controller('coop/logistics')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@Roles('COOPERATIVE')
export class CoopLogisticsController {
  constructor(
    private readonly vehiclesService: CoopVehiclesService,
    private readonly collectionsService: CoopCollectionsService,
  ) {}

  // ----------------- PARC VÉHICULES -----------------

  @Get('vehicles')
  @ApiOperation({ summary: 'Lister les véhicules du parc coop' })
  listVehicles(@CurrentUser() user: AuthenticatedUser) {
    return this.vehiclesService.list(user.sub);
  }

  @Post('vehicles')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ajouter un véhicule au parc coop' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409, description: 'Immatriculation déjà utilisée' })
  createVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCoopVehicleDto,
  ) {
    return this.vehiclesService.create(user.sub, dto);
  }

  @Put('vehicles/:id')
  @ApiOperation({ summary: 'Modifier un véhicule du parc coop (ownership requis)' })
  updateVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCoopVehicleDto,
  ) {
    return this.vehiclesService.update(user.sub, id, dto);
  }

  @Delete('vehicles/:id')
  @ApiOperation({ summary: 'Désactiver un véhicule (soft delete)' })
  deleteVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vehiclesService.remove(user.sub, id);
  }

  // ----------------- COLLECTES INTERNES -----------------

  @Get('collections')
  @ApiOperation({
    summary: 'Lister les collectes planifiées de la coop (filtrable par statut)',
  })
  listCollections(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCoopCollectionsQueryDto,
  ) {
    return this.collectionsService.list(user.sub, query);
  }

  @Post('collections')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Planifier une collecte membre → coop' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'Farmer/Vehicle/Annonce invalide' })
  createCollection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCoopCollectionDto,
  ) {
    return this.collectionsService.create(user.sub, dto);
  }

  @Put('collections/:id')
  @ApiOperation({ summary: 'Modifier une collecte (status, véhicule, horaire)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Collecte déjà COMPLETED/CANCELLED' })
  updateCollection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCoopCollectionDto,
  ) {
    return this.collectionsService.update(user.sub, id, dto);
  }

  @Post('collections/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marquer la collecte effectuée + notif farmer' })
  completeCollection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.collectionsService.complete(user.sub, id);
  }

  @Delete('collections/:id')
  @ApiOperation({ summary: 'Annuler une collecte (soft cancel → status=CANCELLED)' })
  cancelCollection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.collectionsService.cancel(user.sub, id);
  }
}
