// =====================================================================
//  CONTROLLER : MarketplaceController
//  ---------------------------------------------------------------------
//  Routes pour le cœur du marketplace : catalogue, annonces de vente,
//  annonces d'achat et publications coopératives.
//
//  Conventions URL — symétriques entre les 3 ressources :
//    GET    /marketplace/<ressource>          → liste (public)
//    GET    /marketplace/<ressource>/:id      → détail (public)
//    POST   /marketplace/<ressource>          → créer (rôle dédié)
//    PUT    /marketplace/<ressource>/:id      → modifier (ownership)
//    DELETE /marketplace/<ressource>/:id      → supprimer (ownership)
//
//  Les 3 ressources :
//    • annonces/vente        → publié par FARMER, consulté par tous
//    • annonces/achat        → publié par BUYER,  consulté par FARMER/COOP
//    • publications/coop     → publié par COOP,   consulté par BUYER/COOP
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
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, MaskFields } from '@farmcash/shared';
import {
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  Roles,
  RolesGuard,
} from '@farmcash/auth';
import { MarketplaceService } from './marketplace.service';
import {
  CreateAnnonceAchatDto,
  CreateAnnonceVenteDto,
  ListerAnnoncesAchatQueryDto,
  ListerAnnoncesVenteQueryDto,
  UpdateAnnonceAchatDto,
  UpdateAnnonceVenteDto,
} from './dto/annonces.dto';

@ApiTags('🏪 Marketplace')
@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  // ===================================================================
  //  CATALOGUE (public)
  // ===================================================================

  @Get('produits')
  @ApiOperation({ summary: 'Liste du catalogue agricole' })
  getProduitsAgricoles() {
    return this.marketplaceService.getProduitsAgricoles();
  }

  @Get('categories')
  @ApiOperation({ summary: 'Liste des catégories + sous-catégories' })
  getCategories() {
    return this.marketplaceService.getCategories();
  }

  /**
   * Référentiel léger des villes (~40 entrées en CI). Utilisé par les
   * formulaires mobiles (autocomplete parcelles, annonces) → chargement
   * one-shot côté client, filtre client-side.
   */
  @Get('villes')
  @ApiOperation({ summary: 'Liste de toutes les villes (avec leur région)' })
  getVilles() {
    return this.marketplaceService.getVilles();
  }

  // ===================================================================
  //  ANNONCES DE VENTE (FARMER vend → tout le monde voit)
  // ===================================================================

  @Get('annonces/vente')
  // OptionalJwtAuthGuard : route publique mais on a besoin du rôle viewer
  // pour appliquer le masking selon paires (BUYER↔FARMER en MIN, TRANSPORTER FULL…).
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Lister les annonces de vente actives' })
  // Anti-contournement (Chantier 3) : BUYER ne doit pas voir le téléphone
  // ni le nom complet d'un FARMER tant qu'aucune commande n'a été acceptée.
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  getAnnoncesVente(@Query() query: ListerAnnoncesVenteQueryDto) {
    return this.marketplaceService.getAnnoncesVente(query);
  }

  @Get('annonces/vente/:id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: "Détail d'une annonce de vente (incrémente views_count)" })
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  getAnnonceVenteById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.marketplaceService.getAnnonceVenteById(id, user?.sub);
  }

  @Post('annonces/vente')
  @UseGuards(JwtAuthGuard, RolesGuard)
  // FARMER classique = publication directe. COOPERATIVE = publication
  // « au nom de » via act_as_farmer_id (cf. service : contrôles métier).
  @Roles('FARMER', 'COOPERATIVE')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Publier une annonce de vente (FARMER pour soi, COOPERATIVE pour un membre géré via act_as_farmer_id)",
  })
  @ApiResponse({ status: 201 })
  createAnnonceVente(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAnnonceVenteDto,
  ) {
    return this.marketplaceService.createAnnonceVente(user.sub, user.role, dto);
  }

  @Put('annonces/vente/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('FARMER')
  @ApiBearerAuth()
  updateAnnonceVente(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAnnonceVenteDto,
  ) {
    return this.marketplaceService.updateAnnonceVente(user.sub, id, dto);
  }

  @Delete('annonces/vente/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('FARMER')
  @ApiBearerAuth()
  deleteAnnonceVente(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.marketplaceService.deleteAnnonceVente(user.sub, id);
  }

  // ===================================================================
  //  ANNONCES D'ACHAT (BUYER demande → FARMER/COOP voient)
  // ===================================================================

  @Get('annonces/achat')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: "Lister les demandes d'achat actives" })
  // Symétrique : FARMER/COOP ne doit pas voir les coords du BUYER hors transaction.
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  getAnnoncesAchat(@Query() query: ListerAnnoncesAchatQueryDto) {
    return this.marketplaceService.getAnnoncesAchat(query);
  }

  @Get('annonces/achat/:id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: "Détail d'une demande d'achat" })
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  getAnnonceAchatById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.marketplaceService.getAnnonceAchatById(id);
  }

  @Post('annonces/achat')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('BUYER')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Publier une demande d'achat (BUYER)" })
  createAnnonceAchat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAnnonceAchatDto,
  ) {
    return this.marketplaceService.createAnnonceAchat(user.sub, dto);
  }

  @Put('annonces/achat/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('BUYER')
  @ApiBearerAuth()
  updateAnnonceAchat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAnnonceAchatDto,
  ) {
    return this.marketplaceService.updateAnnonceAchat(user.sub, id, dto);
  }

  @Delete('annonces/achat/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('BUYER')
  @ApiBearerAuth()
  deleteAnnonceAchat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.marketplaceService.deleteAnnonceAchat(user.sub, id);
  }

  // ===================================================================
  //  Publications coopératives → MIGRÉES vers le module Cooperatives :
  //   • Lecture publique : GET /api/cooperatives/publications/list
  //                        GET /api/cooperatives/publications/:id
  //   • Écriture COOP   : POST /api/coop/publications
  //                        PUT  /api/coop/publications/:id
  //                        DELETE /api/coop/publications/:id
  //   • Agrégation      : POST /api/coop/publications/aggregate
  // ===================================================================
}
