// =====================================================================
//  CONTROLLERS : Module Cooperatives
//  ---------------------------------------------------------------------
//  Deux contrôleurs dans un seul fichier pour rester proche du domaine :
//
//   1. PublicCooperativesController  → /cooperatives/*   (lookup public)
//      • Sans auth → alimente le dropdown d'inscription côté mobile.
//
//   2. CoopManagementController      → /coop/*           (auth requise)
//      • Gestion profil, membres, adhésions, validations, agrégation,
//        distribution. Accès limité aux rôles FARMER ou COOPERATIVE
//        selon la route (granularité par méthode).
// =====================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
// Import direct (pas via le barrel @farmcash/auth) pour éviter le
// cycle CJS auth ↔ cooperatives. Le barrel reste utilisable par les
// modules hors-cycle.
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth/guards/jwt.guard';
import { AuthenticatedUser, CurrentUser, MaskFields } from '@farmcash/shared';
import { CooperativesService } from './cooperatives.service';
import {
  AggregatePublicationDto,
  CreateInvitationDto,
  CreateJoinRequestDto,
  CreatePublicationCoopDto,
  HandleInvitationDto,
  HandleJoinRequestDto,
  ListAdvancesQueryDto,
  ListCooperativesQueryDto,
  ListMembersQueryDto,
  ListPendingAnnoncesQueryDto,
  ListerPublicationsCoopQueryDto,
  PayAdvanceDto,
  RejectAnnonceDto,
  UpdateMemberRoleDto,
  UpdatePublicationCoopDto,
  UpsertCoopProfileDto,
  ValidateAnnonceDto,
  ValidatePrevisionDto,
} from './dto/cooperatives.dto';

// =====================================================================
//  1. ROUTES PUBLIQUES — découverte des coopératives
// =====================================================================

@ApiTags('🏢 Cooperatives — Public')
@Controller('cooperatives')
export class PublicCooperativesController {
  constructor(private readonly service: CooperativesService) {}

  @Get()
  @ApiOperation({ summary: 'Liste publique des coopératives (search + région)' })
  list(@Query() query: ListCooperativesQueryDto) {
    return this.service.listPublic(query);
  }

  // -------------------------------------------------------------------
  //  Publications coop — lecture publique (migrée depuis marketplace)
  //  Routes spécifiques DÉCLARÉES AVANT la route ':id' pour éviter
  //  qu'elle ne tente de parser "publications" comme UUID.
  // -------------------------------------------------------------------

  @Get('publications/list')
  @ApiOperation({ summary: 'Liste publique des publications coop actives' })
  listPublications(@Query() query: ListerPublicationsCoopQueryDto) {
    return this.service.listPublicationsCoop(query);
  }

  @Get('publications/:id')
  @ApiOperation({ summary: 'Détail public d\'une publication coop' })
  getPublication(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPublicationCoopById(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Profil public d\'une coopérative' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPublic(id);
  }
}

// =====================================================================
//  2. ROUTES PRIVÉES — gestion coopérative
// =====================================================================

@ApiTags('🏢 Cooperatives — Management')
@ApiBearerAuth()
@Controller('coop')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CoopManagementController {
  constructor(private readonly service: CooperativesService) {}

  // -------------------------------------------------------------------
  //  Profil COOP
  // -------------------------------------------------------------------

  @Put('profile')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: 'Mettre à jour profil + commission + auto-distribution' })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertCoopProfileDto,
  ) {
    return this.service.upsertProfile(user.sub, dto);
  }

  // -------------------------------------------------------------------
  //  Adhésion — FARMER initie (join-requests)
  // -------------------------------------------------------------------

  @Post('join-requests')
  @Roles('FARMER')
  @ApiOperation({ summary: '[FARMER] Demander à rejoindre une coopérative' })
  createJoinRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateJoinRequestDto,
  ) {
    return this.service.createJoinRequest(user.sub, dto);
  }

  @Get('join-requests')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Demandes en attente' })
  listJoinRequests(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listJoinRequests(user.cooperative_id ?? '');
  }

  @Put('join-requests/:id/handle')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Accepter / refuser une demande' })
  handleJoinRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HandleJoinRequestDto,
  ) {
    return this.service.handleJoinRequest(user.cooperative_id ?? '', user.sub, id, dto);
  }

  // -------------------------------------------------------------------
  //  Adhésion — COOP initie (invitations)
  // -------------------------------------------------------------------

  @Post('invitations')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Inviter un farmer par téléphone' })
  createInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.service.createInvitation(user.cooperative_id ?? '', user.sub, dto);
  }

  @Get('invitations/my')
  @Roles('FARMER')
  @ApiOperation({ summary: '[FARMER] Mes invitations en attente' })
  listMyInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listMyInvitations(user.sub, user.phone);
  }

  @Put('invitations/:id/handle')
  @Roles('FARMER')
  @ApiOperation({ summary: '[FARMER] Accepter / refuser une invitation' })
  handleInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HandleInvitationDto,
  ) {
    return this.service.handleInvitation(user.sub, user.phone, id, dto);
  }

  // -------------------------------------------------------------------
  //  Gestion des membres
  // -------------------------------------------------------------------

  @Get('members')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Liste paginée des membres' })
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMembersQueryDto,
  ) {
    return this.service.listMembers(user.cooperative_id ?? '', query);
  }

  @Delete('members/:memberUserId')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Retirer un membre' })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
  ) {
    return this.service.removeMember(user.cooperative_id ?? '', memberUserId);
  }

  @Put('members/:memberUserId/role')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Promouvoir un membre (GERANT, TRESORIER…)' })
  updateMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.service.updateMemberRole(user.cooperative_id ?? '', memberUserId, dto);
  }

  // -------------------------------------------------------------------
  //  Annonces assignées — workflow validation
  // -------------------------------------------------------------------

  @Get('annonces-vente/assigned')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Annonces des membres (PENDING par défaut)' })
  listAssigned(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPendingAnnoncesQueryDto,
  ) {
    return this.service.listAssignedAnnonces(user.cooperative_id ?? '', query);
  }

  @Put('annonces-vente/:id/validate')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Valider après pesée — verrouille l\'annonce' })
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ValidateAnnonceDto,
  ) {
    return this.service.validateAnnonce(user.cooperative_id ?? '', user.sub, id, dto);
  }

  @Put('annonces-vente/:id/reject')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Refuser une annonce (libère le farmer)' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectAnnonceDto,
  ) {
    return this.service.rejectAnnonce(user.cooperative_id ?? '', id, dto);
  }

  @Get('annonces-achat/incoming')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Offres d\'achat ciblant ma coop' })
  // Anti-contournement (Chantier 3) : COOP ne voit pas les coords claires
  // d'un BUYER tant qu'il n'y a pas de commande/contrat actif.
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  listTargetedOffers(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listTargetedBuyOffers(user.cooperative_id ?? '');
  }

  // -------------------------------------------------------------------
  //  Prévisions assignées — workflow validation (miroir des annonces)
  // -------------------------------------------------------------------

  @Get('previsions/assigned')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Prévisions des membres (PENDING par défaut)' })
  listAssignedPrevisions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPendingAnnoncesQueryDto,
  ) {
    return this.service.listAssignedPrevisions(user.cooperative_id ?? '', query);
  }

  @Put('previsions/:id/validate')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Valider après inspection terrain' })
  validatePrevision(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ValidatePrevisionDto,
  ) {
    return this.service.validatePrevision(user.cooperative_id ?? '', user.sub, id, dto);
  }

  @Put('previsions/:id/reject')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Refuser une prévision' })
  rejectPrevision(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectAnnonceDto,
  ) {
    return this.service.rejectPrevision(user.cooperative_id ?? '', id, dto);
  }

  // -------------------------------------------------------------------
  //  Agrégation + distribution
  // -------------------------------------------------------------------

  @Post('publications/aggregate')
  @Roles('COOPERATIVE')
  @ApiOperation({
    summary: "[COOP] Agréger N annonces VALIDATED en 1 publication coop",
  })
  aggregate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AggregatePublicationDto,
  ) {
    return this.service.aggregateIntoPublication(user.cooperative_id ?? '', dto);
  }

  @Get('publications/:id/contributions')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Qui a contribué à cette publication' })
  contributions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getContributions(user.cooperative_id ?? '', id);
  }

  @Post('publications/:id/distribute')
  @Roles('COOPERATIVE')
  @ApiOperation({
    summary: "[COOP] Payouts au prorata aux contributeurs (commission coop déduite)",
  })
  distribute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('dry_run') dryRun?: string,
  ) {
    const execute = dryRun !== 'true';
    return this.service.distributePublication(user.cooperative_id ?? '', id, execute);
  }

  // -------------------------------------------------------------------
  //  Vue producteur — mes annonces côté coop
  // -------------------------------------------------------------------

  @Get('my-annonces')
  @Roles('FARMER')
  @ApiOperation({ summary: '[FARMER] Mes annonces gérées par une coop (liste)' })
  myAnnonces(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listMyAnnoncesWithCoopContext(user.sub);
  }

  @Get('my-annonces/:id/context')
  @Roles('FARMER')
  @ApiOperation({
    summary: "[FARMER] Contexte coop complet d'une annonce (prix, part, revenu projeté, avances)",
  })
  myAnnonceContext(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getMyAnnonceContext(user.sub, id);
  }

  // -------------------------------------------------------------------
  //  Avances coop → producteur
  // -------------------------------------------------------------------

  @Post('advances')
  @Roles('COOPERATIVE')
  @ApiOperation({
    summary: '[COOP] Verser une avance à un producteur (déduite au moment du payout)',
  })
  payAdvance(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayAdvanceDto,
  ) {
    return this.service.payAdvance(user.cooperative_id ?? '', user.sub, dto);
  }

  @Get('advances')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Lister les avances versées (filtrable par statut)' })
  listAdvances(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAdvancesQueryDto,
  ) {
    return this.service.listAdvances(user.cooperative_id ?? '', query);
  }

  @Get('advances/by-annonce/:annonceId')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Avances versées sur une annonce précise' })
  advancesByAnnonce(
    @CurrentUser() user: AuthenticatedUser,
    @Param('annonceId', ParseUUIDPipe) annonceId: string,
  ) {
    return this.service.getAdvancesForAnnonce(user.cooperative_id ?? '', annonceId);
  }

  // -------------------------------------------------------------------
  //  Publications coop — CRUD direct (migré depuis marketplace)
  //  Distinct de POST /coop/publications/aggregate (workflow agrégation).
  // -------------------------------------------------------------------

  @Post('publications')
  @Roles('COOPERATIVE')
  @ApiOperation({
    summary: '[COOP] Publier directement un stock (sans agrégation depuis annonces)',
  })
  createPublication(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePublicationCoopDto,
  ) {
    return this.service.createPublicationCoop(user.cooperative_id, dto);
  }

  @Put('publications/:id')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Mettre à jour une publication' })
  updatePublication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePublicationCoopDto,
  ) {
    return this.service.updatePublicationCoop(user.cooperative_id, id, dto);
  }

  @Delete('publications/:id')
  @Roles('COOPERATIVE')
  @ApiOperation({ summary: '[COOP] Supprimer une publication' })
  deletePublication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deletePublicationCoop(user.cooperative_id, id);
  }
}
