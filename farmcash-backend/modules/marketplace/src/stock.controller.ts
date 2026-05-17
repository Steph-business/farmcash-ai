// =====================================================================
//  CONTROLLER : StockController
//  ---------------------------------------------------------------------
//  Gestion des entrepôts et lots. Restreint aux FARMER et COOPERATIVE
//  (les autres rôles n'ont pas de stock physique à gérer).
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { StockService } from './stock.service';
import {
  CreateEntrepotDto,
  CreateLotDto,
  UpdateEntrepotDto,
  UpdateLotDto,
} from './dto/stock.dto';

@ApiTags('📦 Stocks & Entrepôts')
@Controller('marketplace/stocks')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@Roles('FARMER', 'COOPERATIVE')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Get('entrepots')
  @ApiOperation({ summary: 'Lister mes entrepôts' })
  getMesEntrepots(@CurrentUser() user: AuthenticatedUser) {
    return this.stockService.getMesEntrepots(user.sub);
  }

  @Post('entrepots')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un entrepôt' })
  createEntrepot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEntrepotDto,
  ) {
    return this.stockService.createEntrepot(user.sub, dto);
  }

  @Put('entrepots/:id')
  @ApiOperation({ summary: 'Modifier un entrepôt' })
  updateEntrepot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEntrepotDto,
  ) {
    return this.stockService.updateEntrepot(user.sub, id, dto);
  }

  @Delete('entrepots/:id')
  @ApiOperation({ summary: 'Supprimer un entrepôt' })
  deleteEntrepot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.stockService.deleteEntrepot(user.sub, id);
  }

  @Get('lots')
  @ApiOperation({ summary: 'Lister mes lots de production' })
  getMesLots(@CurrentUser() user: AuthenticatedUser) {
    return this.stockService.getMesLots(user.sub, user.cooperative_id);
  }

  @Post('lots')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enregistrer un lot (type INDIVIDUAL ou COOPERATIVE)' })
  createLot(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLotDto) {
    return this.stockService.createLot(user.sub, user.role, user.cooperative_id, dto);
  }

  @Put('lots/:id')
  @ApiOperation({ summary: 'Modifier un lot' })
  updateLot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLotDto,
  ) {
    return this.stockService.updateLot(user.sub, user.cooperative_id, id, dto);
  }

  @Delete('lots/:id')
  @ApiOperation({ summary: 'Supprimer un lot' })
  deleteLot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.stockService.deleteLot(user.sub, user.cooperative_id, id);
  }
}
