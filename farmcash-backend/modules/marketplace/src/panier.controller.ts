// =====================================================================
//  CONTROLLER : PanierController
//  ---------------------------------------------------------------------
//  Routes du panier d'achat. Réservées aux BUYER et COOPERATIVE (les
//  FARMER vendent, ils n'achètent pas via le marketplace ; les
//  TRANSPORTER et EXPORTER ont leurs propres flows).
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { PanierService } from './panier.service';
import { AjouterPanierDto } from './dto/panier.dto';

@ApiTags('🛒 Panier')
@Controller('marketplace/panier')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@Roles('BUYER', 'COOPERATIVE')
export class PanierController {
  constructor(private readonly panierService: PanierService) {}

  @Get()
  @ApiOperation({ summary: 'Obtenir le contenu de mon panier' })
  getMonPanier(@CurrentUser() user: AuthenticatedUser) {
    return this.panierService.getMonPanier(user.sub);
  }

  @Post('add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ajouter un article au panier (prix relu côté serveur)' })
  ajouterArticle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AjouterPanierDto,
  ) {
    return this.panierService.ajouterArticle(user.sub, dto);
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retirer un article du panier' })
  supprimerArticle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    return this.panierService.supprimerArticle(user.sub, itemId);
  }
}
