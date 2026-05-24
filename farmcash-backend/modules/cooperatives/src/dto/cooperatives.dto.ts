// =====================================================================
//  DTOs : Module Cooperatives
//  ---------------------------------------------------------------------
//  Regroupe tous les DTOs (entrée + sortie) du module coopératives :
//   • Profil coop (création, mise à jour, commission)
//   • Adhésion (join-requests, invitations, gestion membres)
//   • Annonces assignées (validation, refus)
//   • Agrégation + distribution (publications, payouts)
//
//  Convention :
//   • Tous les UUIDs sont validés par @IsUUID()
//   • Les montants sont des nombres décimaux ≥ 0
//   • Les enums sont strictement validés (forbidNonWhitelisted global)
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// ---------------------------------------------------------------------
//  Enums miroir des types Prisma / SQL
// ---------------------------------------------------------------------

export enum CoopAnnonceStatus {
  PENDING = 'PENDING',
  VALIDATED = 'VALIDATED',
  INCLUDED = 'INCLUDED',
  REJECTED = 'REJECTED',
}

export enum CoopRequestStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum CoopMemberRole {
  PRESIDENT = 'PRESIDENT',
  GERANT = 'GERANT',
  TRESORIER = 'TRESORIER',
  MEMBER = 'MEMBER',
}

export enum ProductQuality {
  STANDARD = 'STANDARD',
  PREMIUM = 'PREMIUM',
  BIO = 'BIO',
  EQUITABLE = 'EQUITABLE',
}

// ---------------------------------------------------------------------
//  Recherche publique de coopératives (pour l'inscription FARMER)
// ---------------------------------------------------------------------

export class ListCooperativesQueryDto {
  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Recherche par nom (insensible casse)' })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filtrer par région' })
  @IsOptional()
  @IsUUID()
  region_id?: string;
}

// ---------------------------------------------------------------------
//  Profil COOP (création + update)
// ---------------------------------------------------------------------

export class UpsertCoopProfileDto {
  @ApiProperty({ example: 'Coobamoul Coopérative' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 200)
  nom: string;

  @ApiPropertyOptional({ example: 'CI-COOP-2024-1234' })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  numero_agrement?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({ example: 45, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  nb_membres?: number;

  @ApiPropertyOptional({
    description: 'Commission de la coop sur chaque vente (0–0.30)',
    example: 0.05,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.3)
  commission_rate?: number;

  @ApiPropertyOptional({
    description: 'Distribuer automatiquement aux membres dès la vente confirmée',
  })
  @IsOptional()
  @IsBoolean()
  auto_distribute?: boolean;
}

// ---------------------------------------------------------------------
//  Adhésion — FARMER initie (join-requests)
// ---------------------------------------------------------------------

export class CreateJoinRequestDto {
  @ApiProperty()
  @IsUUID()
  cooperative_id: string;

  @ApiPropertyOptional({ example: "Je produis 2 tonnes de maïs/an à Korhogo." })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  message?: string;
}

export class HandleJoinRequestDto {
  @ApiProperty({ example: 'ACCEPTED', enum: ['ACCEPTED', 'REJECTED'] })
  @IsIn(['ACCEPTED', 'REJECTED'])
  decision: 'ACCEPTED' | 'REJECTED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  rejection_reason?: string;
}

// ---------------------------------------------------------------------
//  Adhésion — COOP initie (invitations)
// ---------------------------------------------------------------------

export class CreateInvitationDto {
  @ApiProperty({ example: '+2250701020304' })
  @IsString()
  @IsNotEmpty()
  @Length(8, 20)
  invited_phone: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  message?: string;
}

export class HandleInvitationDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  @IsIn(['ACCEPTED', 'REJECTED'])
  decision: 'ACCEPTED' | 'REJECTED';
}

// ---------------------------------------------------------------------
//  Gestion des membres
// ---------------------------------------------------------------------

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: CoopMemberRole })
  @IsEnum(CoopMemberRole)
  role_in_coop: CoopMemberRole;
}

export class ListMembersQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: CoopMemberRole })
  @IsOptional()
  @IsEnum(CoopMemberRole)
  role?: CoopMemberRole;
}

// ---------------------------------------------------------------------
//  Validation des annonces assignées
// ---------------------------------------------------------------------

export class ValidateAnnonceDto {
  @ApiProperty({
    description: 'Quantité réelle pesée par la coop (peut différer de la déclaration)',
    example: 187.5,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  quantite_kg_reelle: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite_reelle?: ProductQuality;

  @ApiPropertyOptional({ example: 'Pesé le 15/05, sacs secs, qualité conforme.' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes_pesee?: string;
}

export class RejectAnnonceDto {
  @ApiProperty({ example: 'Qualité insuffisante après pesée.' })
  @IsString()
  @IsNotEmpty()
  @Length(5, 1000)
  rejection_reason: string;
}

// ---------------------------------------------------------------------
//  Validation des prévisions assignées (workflow miroir des annonces)
// ---------------------------------------------------------------------

export class ValidatePrevisionDto {
  @ApiProperty({
    description: 'Quantité prévisionnelle confirmée après inspection terrain',
    example: 1800,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantite_kg_validee: number;

  @ApiPropertyOptional({ example: 'Parcelle de 2 ha, 1200 pieds, bon état sanitaire.' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes_inspection?: string;
}

// ---------------------------------------------------------------------
//  Membres gérés par la coop (« farmer sans téléphone »)
//  ---------------------------------------------------------------------
//  Permet à une coopérative d'enregistrer un producteur qui n'a PAS de
//  téléphone (cas fréquent zones rurales) — la coop publie/vend en son
//  nom via `act_as_farmer_id` sur les annonces. Plus tard, quand le
//  farmer obtient un téléphone, la coop peut le « promouvoir » en
//  farmer autonome (passage à un compte normal avec auth OTP+PIN).
// ---------------------------------------------------------------------

export class CreateManagedMemberDto {
  @ApiProperty({
    example: 'Aïssata Touré',
    description: 'Nom complet du producteur — affiché aux acheteurs',
  })
  @IsString()
  @IsNotEmpty()
  @Length(2, 150)
  full_name: string;

  /**
   * Village ou hameau d'origine du producteur. Stocké tel quel
   * (texte libre) car les villages de brousse ne sont pas tous dans
   * le référentiel `villes_ci`. Sert d'indication de localisation à
   * la coop et à l'acheteur final.
   */
  @ApiPropertyOptional({
    example: 'Kongasso, Korhogo Nord',
    description: 'Village/hameau (texte libre, optionnel — VARCHAR 100 en DB)',
  })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  village?: string;

  /**
   * Produit principal cultivé — pré-remplit le formulaire de création
   * d'annonce quand la coop publie pour ce farmer. Optionnel.
   */
  @ApiPropertyOptional({ description: 'UUID du produit cultivé par défaut' })
  @IsOptional()
  @IsUUID()
  default_product_id?: string;

  @ApiPropertyOptional({
    description: 'URL de la photo du producteur (optionnel)',
  })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  photo_url?: string;
}

export class PromoteManagedMemberDto {
  /**
   * Téléphone E.164 du farmer (le compte devient autonome).
   * Validé contre la regex CI : +225 suivi de 10 chiffres.
   * Le farmer pourra ensuite demander un OTP pour définir son PIN.
   */
  @ApiProperty({
    example: '+2250701020304',
    description: 'Téléphone E.164 CI à associer au compte (devient autonome)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(10, 20)
  phone: string;
}

// ---------------------------------------------------------------------
//  Avance de paiement (coop → producteur)
// ---------------------------------------------------------------------

export class PayAdvanceDto {
  @ApiProperty({ description: 'UUID du producteur bénéficiaire' })
  @IsUUID()
  farmer_id: string;

  @ApiPropertyOptional({
    description: "UUID de l'annonce concernée — sert au calcul du plafond",
  })
  @IsOptional()
  @IsUUID()
  annonce_vente_id?: string;

  @ApiProperty({ example: 140250, description: 'Montant à verser (FCFA)' })
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  amount: number;

  @ApiPropertyOptional({ example: 'Avance 50% sur lot maïs mai 2026.' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

// ---------------------------------------------------------------------
//  Publications coop (CRUD direct — migré depuis marketplace)
// ---------------------------------------------------------------------

class PubCoordinatesDto {
  @ApiProperty({ example: 5.345317 })
  @IsLatitude({ message: 'Latitude invalide' })
  @Type(() => Number)
  lat: number;

  @ApiProperty({ example: -4.024429 })
  @IsLongitude({ message: 'Longitude invalide' })
  @Type(() => Number)
  lng: number;
}

export class PubTraitementAppliqueDto {
  @ApiPropertyOptional({ description: 'UUID du traitement (alternative au nom)' })
  @IsOptional()
  @IsUUID()
  produit_traitement_id?: string;

  @ApiPropertyOptional({
    description:
      "Nom du traitement (insensible à la casse, recherche partielle).",
    example: 'NPK 15-15-15',
  })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  produit_traitement_nom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 200)
  dosage_utilise?: string;

  @ApiPropertyOptional({ example: '2026-04-01' })
  @IsOptional()
  @IsString()
  date_application?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  delai_carence_respecte?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

export class CreatePublicationCoopDto {
  @ApiProperty()
  @IsUUID()
  produit_id: string;

  @ApiProperty({ example: 50000, description: 'Quantité agrégée en KG' })
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  quantite_kg: number;

  @ApiPropertyOptional({ example: 1200 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  prix_par_kg?: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;

  @ApiProperty()
  @IsUUID()
  region_id: string;

  @ApiProperty()
  @IsUUID()
  ville_id: string;

  @ApiProperty({ type: PubCoordinatesDto })
  @ValidateNested()
  @Type(() => PubCoordinatesDto)
  coordinates: PubCoordinatesDto;

  /**
   * Liste des produits de traitement appliqués sur le stock agrégé.
   * Optionnel mais fortement recommandé pour les acheteurs export et BIO.
   */
  @ApiPropertyOptional({ type: [PubTraitementAppliqueDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PubTraitementAppliqueDto)
  traitements?: PubTraitementAppliqueDto[];
}

export class UpdatePublicationCoopDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantite_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  prix_par_kg?: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ListerPublicationsCoopQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  produit_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cooperative_id?: string;
}

export class ListAdvancesQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: ['PAID', 'REIMBURSED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['PAID', 'REIMBURSED', 'CANCELLED'])
  status?: 'PAID' | 'REIMBURSED' | 'CANCELLED';
}

export class ListPendingAnnoncesQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    enum: CoopAnnonceStatus,
    description: 'Par défaut PENDING (en attente de pesée)',
  })
  @IsOptional()
  @IsEnum(CoopAnnonceStatus)
  status?: CoopAnnonceStatus;
}

// ---------------------------------------------------------------------
//  Agrégation des annonces validées en une publication
// ---------------------------------------------------------------------

export class AggregatePublicationDto {
  @ApiProperty({
    description: "UUIDs des annonces VALIDATED à agréger en 1 publication",
    type: [String],
    example: ['uuid-1', 'uuid-2', 'uuid-3'],
  })
  @IsUUID('4', { each: true })
  annonce_ids: string[];

  @ApiProperty({ example: 1500, description: 'Prix de vente unitaire (FCFA/kg)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  prix_par_kg: number;

  @ApiProperty({ enum: ProductQuality })
  @IsEnum(ProductQuality)
  qualite: ProductQuality;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({ example: 'Entrepôt principal Bouaké' })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  adresse_detail?: string;
}
