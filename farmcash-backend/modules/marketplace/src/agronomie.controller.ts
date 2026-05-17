// =====================================================================
//  CONTROLLER : AgronomieController
//  ---------------------------------------------------------------------
//  Routes pour la gestion des parcelles et cultures déclarées par les
//  producteurs (FARMER) et les coopératives (COOPERATIVE).
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { AgronomieService } from './agronomie.service';
import {
  AddCultureDto,
  CreateParcelleDto,
  UpdateParcelleDto,
} from './dto/agronomie.dto';

@ApiTags('🌱 Agronomie (Parcelles & Cultures)')
@Controller('marketplace/agronomie')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@Roles('FARMER', 'COOPERATIVE')
export class AgronomieController {
  constructor(private readonly agronomieService: AgronomieService) {}

  // ----- Parcelles -----

  @Get('parcelles')
  @ApiOperation({ summary: 'Lister mes parcelles' })
  getMesParcelles(@CurrentUser() user: AuthenticatedUser) {
    return this.agronomieService.getMesParcelles(user.sub);
  }

  @Post('parcelles')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer une parcelle' })
  createParcelle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateParcelleDto,
  ) {
    return this.agronomieService.createParcelle(user.sub, dto);
  }

  @Put('parcelles/:id')
  @ApiOperation({ summary: 'Modifier une parcelle' })
  updateParcelle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateParcelleDto,
  ) {
    return this.agronomieService.updateParcelle(user.sub, id, dto);
  }

  @Delete('parcelles/:id')
  @ApiOperation({ summary: 'Supprimer une parcelle' })
  deleteParcelle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.agronomieService.deleteParcelle(user.sub, id);
  }

  // ----- Cultures -----

  @Get('cultures')
  @ApiOperation({
    summary:
      'Lister mes cultures. Filtre `parcelle_id` (optionnel) pour ne ramener que les cultures d\'une parcelle donnée.',
  })
  getMesCultures(
    @CurrentUser() user: AuthenticatedUser,
    @Query('parcelle_id') parcelleId?: string,
  ) {
    return this.agronomieService.getMesCultures(user.sub, parcelleId);
  }

  @Post('cultures')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ajouter une culture sur une parcelle' })
  addCultureToParcelle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddCultureDto,
  ) {
    return this.agronomieService.addCultureToParcelle(user.sub, dto);
  }

  @Delete('cultures/:id')
  @ApiOperation({ summary: 'Supprimer une culture' })
  deleteCulture(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.agronomieService.deleteCulture(user.sub, id);
  }
}
