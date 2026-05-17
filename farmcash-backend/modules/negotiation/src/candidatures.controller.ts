// =====================================================================
//  CONTROLLER : CandidaturesController (Négociation)
//  ---------------------------------------------------------------------
//  Trois flux exposés, chacun avec ses verbes propres :
//
//   /negotiation/candidatures           (BUYER  → FARMER)
//     POST   /                          → créer
//     GET    /                          → lister (?direction=outgoing|incoming)
//     PUT    /:id/traiter               → accepter/refuser/contre-offrir/annuler
//
//   /negotiation/propositions           (FARMER/COOPERATIVE → BUYER)
//     POST   /                          → créer
//     GET    /                          → lister
//     PUT    /:id/traiter               → traiter
//
//   /negotiation/contre-offres-coop     (BUYER → COOPERATIVE)
//     POST   /                          → créer
//     GET    /                          → lister
//     PUT    /:id/traiter               → traiter
//
//  Pour les routes "/traiter", l'autorisation fine (qui peut faire quoi)
//  est validée DANS LE SERVICE en croisant identité et état du dossier.
//  Au niveau controller on garde uniquement JwtAuthGuard + un Roles
//  large (toutes les parties prenantes peuvent appeler /traiter).
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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, MaskFields } from '@farmcash/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { CandidaturesService } from './candidatures.service';
import {
  CreateCandidatureAchatDto,
  CreateContreOffreCoopDto,
  CreatePropositionVenteDto,
  ListerNegotiationsQueryDto,
  SendNegotiationMessageDto,
  TraiterOffreDto,
} from './dto/candidatures.dto';

@ApiTags('🤝 Négociation & Offres')
@Controller('negotiation')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CandidaturesController {
  constructor(private readonly candidaturesService: CandidaturesService) {}

  // ===================================================================
  //  CANDIDATURES (BUYER → FARMER)
  // ===================================================================

  @Post('candidatures')
  @HttpCode(HttpStatus.CREATED)
  @Roles('BUYER')
  @ApiOperation({ summary: 'BUYER : faire une offre sur une annonce de vente' })
  createCandidatureAchat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCandidatureAchatDto,
  ) {
    return this.candidaturesService.createCandidatureAchat(user.sub, dto);
  }

  @Get('candidatures')
  @Roles('BUYER', 'FARMER')
  @ApiOperation({
    summary: 'Lister mes candidatures (direction=outgoing par défaut)',
  })
  // Anti-contournement : FARMER ne doit pas avoir les coords claires d'un
  // BUYER qui n'a pas encore eu de commande ACCEPTED avec lui.
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  listerCandidatures(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListerNegotiationsQueryDto,
  ) {
    return this.candidaturesService.listerCandidatures(user.sub, query);
  }

  @Put('candidatures/:id/traiter')
  @Roles('BUYER', 'FARMER')
  @ApiOperation({
    summary: 'Accepter / Refuser / Contre-offrir / Annuler une candidature',
  })
  traiterCandidatureAchat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TraiterOffreDto,
  ) {
    return this.candidaturesService.traiterCandidatureAchat(user.sub, id, dto);
  }

  // ===================================================================
  //  PROPOSITIONS (FARMER/COOPERATIVE → BUYER)
  // ===================================================================

  @Post('propositions')
  @HttpCode(HttpStatus.CREATED)
  @Roles('FARMER', 'COOPERATIVE')
  @ApiOperation({
    summary: 'FARMER/COOP : faire une proposition sur une demande d\'achat',
  })
  createPropositionVente(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePropositionVenteDto,
  ) {
    return this.candidaturesService.createPropositionVente(
      user.sub,
      user.role,
      user.cooperative_id,
      dto,
    );
  }

  @Get('propositions')
  @Roles('BUYER', 'FARMER', 'COOPERATIVE')
  @ApiOperation({ summary: 'Lister les propositions (outgoing/incoming)' })
  // Anti-contournement (Chantier 3) : tant qu'une commande n'est pas ACCEPTED,
  // le BUYER ne voit que prénom + initiale du FARMER/COOP qui propose.
  @MaskFields({
    'users.full_name': 'name',
    'users.phone': 'phone',
  })
  listerPropositions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListerNegotiationsQueryDto,
  ) {
    return this.candidaturesService.listerPropositions(user.sub, query);
  }

  @Put('propositions/:id/traiter')
  @Roles('BUYER', 'FARMER', 'COOPERATIVE')
  @ApiOperation({
    summary: 'Traiter une proposition (BUYER accepte/refuse, vendeur annule)',
  })
  traiterPropositionVente(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TraiterOffreDto,
  ) {
    return this.candidaturesService.traiterPropositionVente(user.sub, id, dto);
  }

  // ===================================================================
  //  CONTRE-OFFRES COOP (BUYER → COOPERATIVE)
  // ===================================================================

  @Post('contre-offres-coop')
  @HttpCode(HttpStatus.CREATED)
  @Roles('BUYER')
  @ApiOperation({
    summary: 'BUYER : contre-offre sur une publication coopérative',
  })
  createContreOffreCoop(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateContreOffreCoopDto,
  ) {
    return this.candidaturesService.createContreOffreCoop(user.sub, dto);
  }

  @Get('contre-offres-coop')
  @Roles('BUYER', 'COOPERATIVE')
  @ApiOperation({ summary: 'Lister les contre-offres coop' })
  listerContreOffres(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListerNegotiationsQueryDto,
  ) {
    return this.candidaturesService.listerContreOffres(
      user.sub,
      user.cooperative_id,
      query,
    );
  }

  @Put('contre-offres-coop/:id/traiter')
  @Roles('BUYER', 'COOPERATIVE')
  @ApiOperation({ summary: 'Traiter une contre-offre coop' })
  traiterContreOffreCoop(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TraiterOffreDto,
  ) {
    return this.candidaturesService.traiterContreOffreCoop(
      user.sub,
      user.cooperative_id,
      id,
      dto,
    );
  }

  // ===================================================================
  //  CHAT LIBRE ATTACHÉ À UNE NÉGOCIATION
  //  ---------------------------------------------------------------------
  //  3 sous-ressources symétriques (candidatures / propositions / contre-
  //  offres-coop), même body, mêmes permissions (parties seulement).
  //  Le service résout les 2 parties autorisées en interne et fait le
  //  check ; le controller délègue simplement.
  // ===================================================================

  @Post('candidatures/:id/messages')
  @ApiOperation({ summary: 'Envoyer un message libre sur une candidature' })
  sendCandidatureMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendNegotiationMessageDto,
  ) {
    return this.candidaturesService.sendNegotiationMessage(
      user.sub,
      { candidature_id: id },
      dto.content,
    );
  }

  @Get('candidatures/:id/messages')
  @ApiOperation({ summary: 'Lister les messages d\'une candidature' })
  listCandidatureMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.candidaturesService.listNegotiationMessages(user.sub, {
      candidature_id: id,
    });
  }

  @Post('propositions/:id/messages')
  @ApiOperation({ summary: 'Envoyer un message libre sur une proposition' })
  sendPropositionMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendNegotiationMessageDto,
  ) {
    return this.candidaturesService.sendNegotiationMessage(
      user.sub,
      { proposition_id: id },
      dto.content,
    );
  }

  @Get('propositions/:id/messages')
  @ApiOperation({ summary: 'Lister les messages d\'une proposition' })
  listPropositionMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.candidaturesService.listNegotiationMessages(user.sub, {
      proposition_id: id,
    });
  }

  @Post('contre-offres-coop/:id/messages')
  @ApiOperation({ summary: 'Envoyer un message libre sur une contre-offre coop' })
  sendContreOffreMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendNegotiationMessageDto,
  ) {
    return this.candidaturesService.sendNegotiationMessage(
      user.sub,
      { contre_offre_coop_id: id },
      dto.content,
    );
  }

  @Get('contre-offres-coop/:id/messages')
  @ApiOperation({ summary: 'Lister les messages d\'une contre-offre coop' })
  listContreOffreMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.candidaturesService.listNegotiationMessages(user.sub, {
      contre_offre_coop_id: id,
    });
  }
}
