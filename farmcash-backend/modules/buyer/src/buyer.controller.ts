// =====================================================================
//  CONTROLLER : BuyerController
//  ---------------------------------------------------------------------
//  Routes spécifiques au rôle BUYER. Pour l'instant : carnet d'adresses
//  de livraison. À étendre ensuite (préférences, alertes...).
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
import { BuyerAddressesService } from './buyer-addresses.service';
import {
  CreateBuyerAddressDto,
  UpdateBuyerAddressDto,
} from './dto/buyer-addresses.dto';

@ApiTags('🛒 Buyer — Adresses de livraison')
@ApiBearerAuth()
@Controller('buyer/addresses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('BUYER')
export class BuyerAddressesController {
  constructor(private readonly service: BuyerAddressesService) {}

  @Get()
  @ApiOperation({ summary: '[BUYER] Lister mes adresses de livraison' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.sub);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '[BUYER] Créer une adresse (débadge les autres si is_default)',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBuyerAddressDto,
  ) {
    return this.service.create(user.sub, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: '[BUYER] Modifier une adresse (ownership requis)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBuyerAddressDto,
  ) {
    return this.service.update(user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '[BUYER] Supprimer une adresse (soft delete)' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.remove(user.sub, id);
  }
}
