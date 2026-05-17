// =====================================================================
//  DTOs : Négociation
//  ---------------------------------------------------------------------
//  Trois flux distincts coexistent dans ce module :
//
//   1. CANDIDATURE   : BUYER → FARMER       (sur annonce_vente)
//                      `candidatures_achat` + `candidature_traitements`
//
//   2. PROPOSITION   : FARMER → BUYER        (sur annonce_achat)
//                      `propositions_vente` + `proposition_traitements`
//
//   3. CONTRE-OFFRE  : BUYER → COOPERATIVE   (sur publication_stock_coop)
//                      `contre_offres_coop` + `contre_offre_coop_traitements`
//
//  Chaque flux dispose de son propre statut PENDING → ACCEPTED |
//  REJECTED | COUNTER_OFFER | CANCELLED, avec un historique horodaté
//  dans la table *_traitements correspondante.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * Statut métier commun à toutes les négociations. Stocké en VARCHAR(30)
 * côté DB (pas un enum SQL), mais on l'applique en TS via @IsEnum.
 */
export enum NegotiationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  COUNTER_OFFER = 'COUNTER_OFFER',
  CANCELLED = 'CANCELLED',
}

/**
 * Actions possibles dans le cadre d'un `traiter*` :
 *   • Le receveur de l'offre peut    : ACCEPTED, REJECTED, COUNTER_OFFER
 *   • L'émetteur de l'offre peut     : CANCELLED, COUNTER_OFFER (réponse)
 */
export enum NegotiationAction {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  COUNTER_OFFER = 'COUNTER_OFFER',
  CANCELLED = 'CANCELLED',
}

// =====================================================================
//  CANDIDATURE — BUYER -> FARMER (sur annonce de vente)
// =====================================================================

export class CreateCandidatureAchatDto {
  @ApiProperty({ example: 'uuid-annonce-vente' })
  @IsUUID()
  @IsNotEmpty()
  annonce_id: string;

  @ApiProperty({ example: 1000, description: 'Quantité demandée en kg' })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiPropertyOptional({
    example: 1200,
    description: 'Prix proposé par kg. Si omis, reprend le prix de l\'annonce.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_propose_kg?: number;

  @ApiPropertyOptional({ example: 'Je peux payer en avance' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  message?: string;
}

// =====================================================================
//  PROPOSITION — FARMER/COOPERATIVE -> BUYER (sur demande d'achat)
// =====================================================================

export class CreatePropositionVenteDto {
  @ApiProperty({ example: 'uuid-annonce-achat' })
  @IsUUID()
  @IsNotEmpty()
  annonce_achat_id: string;

  @ApiPropertyOptional({
    example: 'uuid-annonce-vente',
    description: "Pour rattacher la proposition à une annonce de vente existante du vendeur (ownership vérifiée serveur).",
  })
  @IsOptional()
  @IsUUID()
  annonce_vente_id?: string;

  @ApiPropertyOptional({
    example: 'uuid-publication-coop',
    description: "Idem mais pour une coopérative et sa publication agrégée.",
  })
  @IsOptional()
  @IsUUID()
  publication_coop_id?: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiProperty({ example: 1500 })
  @IsNumber()
  @Min(0)
  prix_propose_kg: number;

  @ApiPropertyOptional({ example: 3, description: 'Délai de livraison en jours' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  delai_livraison_j?: number;

  @ApiPropertyOptional({ example: 'Livraison possible à Abidjan' })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  lieu_livraison?: string;

  @ApiPropertyOptional({ example: 'Produit de première qualité' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  message?: string;
}

// =====================================================================
//  CONTRE-OFFRE — BUYER -> COOPERATIVE (sur publication coop)
// =====================================================================
//  Note : `cooperative_id` n'est PAS dans ce DTO. Il est déduit de la
//  publication côté serveur (sinon un client pourrait dissocier l'offre
//  de sa publication).

export class CreateContreOffreCoopDto {
  @ApiProperty({ example: 'uuid-publication-coop' })
  @IsUUID()
  @IsNotEmpty()
  publication_id: string;

  @ApiProperty({ example: 5000 })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiProperty({ example: 1400 })
  @IsNumber()
  @Min(0)
  prix_propose_kg: number;

  @ApiPropertyOptional({ example: 'Je prends tout le stock.' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  message?: string;
}

// =====================================================================
//  TRAITEMENT — réponse du receveur (ou retrait par l'émetteur)
// =====================================================================

export class TraiterOffreDto {
  @ApiProperty({ enum: NegotiationAction })
  @IsEnum(NegotiationAction)
  action: NegotiationAction;

  @ApiPropertyOptional({
    example: 1450,
    description: 'Nouveau prix en cas de COUNTER_OFFER',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_contre_offre?: number;

  @ApiPropertyOptional({
    example: 500,
    description: 'Nouvelle quantité en cas de COUNTER_OFFER',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_kg?: number;

  @ApiPropertyOptional({ example: 'Je vous propose plutôt 1450 F CFA' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}

// =====================================================================
//  DTOs de listing
// =====================================================================

export enum NegotiationDirection {
  /** Mes offres (que j'ai émises) */
  OUTGOING = 'outgoing',
  /** Les offres que j'ai reçues (à traiter) */
  INCOMING = 'incoming',
}

export class ListerNegotiationsQueryDto {
  @ApiPropertyOptional({ enum: NegotiationDirection, default: NegotiationDirection.OUTGOING })
  @IsOptional()
  @IsEnum(NegotiationDirection)
  direction?: NegotiationDirection;

  @ApiPropertyOptional({ enum: NegotiationStatus })
  @IsOptional()
  @IsEnum(NegotiationStatus)
  status?: NegotiationStatus;
}

// =====================================================================
//  Chat libre attaché à une négociation
// =====================================================================

export class SendNegotiationMessageDto {
  @ApiProperty({
    example: 'Bonjour, je peux faire 1450 F si vous garantissez la livraison sous 48h.',
  })
  @IsString()
  @Length(1, 5000)
  content: string;
}
