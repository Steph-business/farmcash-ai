// =====================================================================
//  DTOs : Annonces de vente + Annonces d'achat
//  ---------------------------------------------------------------------
//  • CreateAnnonceVenteDto  : POST /marketplace/annonces/vente   (FARMER)
//  • UpdateAnnonceVenteDto  : PUT  /marketplace/annonces/vente/:id
//  • CreateAnnonceAchatDto  : POST /marketplace/annonces/achat   (BUYER)
//  • UpdateAnnonceAchatDto  : PUT  /marketplace/annonces/achat/:id
//
//  L'enum AnnoncePublicStatus mirror l'enum SQL `product_status` côté DB :
//  DRAFT, ACTIVE, PAUSED, SOLD, EXPIRED — toute autre valeur est rejetée.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export enum ProductQuality {
  STANDARD = 'STANDARD',
  PREMIUM = 'PREMIUM',
  BIO = 'BIO',
  EQUITABLE = 'EQUITABLE',
}

export enum AnnoncePublicStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  SOLD = 'SOLD',
  EXPIRED = 'EXPIRED',
}

/**
 * Coordonnées GPS validées. Sans @ValidateNested + @Type, class-validator
 * n'inspecte pas les objets imbriqués.
 */
export class CoordinatesDto {
  @ApiProperty({ example: 5.345317 })
  @IsLatitude({ message: 'Latitude invalide' })
  @Type(() => Number)
  lat: number;

  @ApiProperty({ example: -4.024429 })
  @IsLongitude({ message: 'Longitude invalide' })
  @Type(() => Number)
  lng: number;
}

/**
 * Traitement déclaré sur une annonce / publication coop.
 * Améliore la traçabilité : le buyer voit ce qui a été appliqué.
 *
 * 2 façons d'identifier le produit (au moins UNE doit être fournie) :
 *   • produit_traitement_id (UUID, idéal côté mobile avec dropdown)
 *   • produit_traitement_nom (insensible casse, idéal pour test/import)
 *
 * Le produit doit exister dans le catalogue ADMIN (produits_traitement).
 */
export class TraitementAppliqueDto {
  @ApiPropertyOptional({
    description: 'UUID du traitement dans le catalogue (alternative au nom)',
  })
  @IsOptional()
  @IsUUID()
  produit_traitement_id?: string;

  @ApiPropertyOptional({
    description:
      "Nom du traitement (insensible à la casse, recherche partielle). Ex: 'Neem bio' trouvera 'Neem bio (huile de neem)'.",
    example: 'Neem bio',
  })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  produit_traitement_nom?: string;

  @ApiPropertyOptional({ example: '50g / 10L eau' })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  dosage_utilise?: string;

  @ApiPropertyOptional({ example: '2026-04-01' })
  @IsOptional()
  @IsDateString()
  date_application?: string;

  @ApiPropertyOptional({
    description: 'Le délai de carence avant récolte a-t-il été respecté ?',
  })
  @IsOptional()
  @IsBoolean()
  delai_carence_respecte?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

export class CreateAnnonceVenteDto {
  @ApiProperty({ example: 'uuid-produit' })
  @IsUUID()
  @IsNotEmpty()
  produit_id: string;

  @ApiProperty({ example: 'Maïs grain blanc bien sec — récolte mars 2026' })
  @IsString()
  @IsNotEmpty()
  @Length(3, 200)
  titre: string;

  @ApiPropertyOptional({ example: 'Maïs récolté à maturité, séché 5 jours au soleil, triés et propres.' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiProperty({ example: 1000 })
  @IsNumber()
  @Min(0)
  prix_par_kg: number;

  /**
   * Quantité minimum vendable par commande. Optionnelle : si non
   * fournie, le service prend `quantite_kg` (= l'acheteur prend tout)
   * ce qui correspond au cas le plus fréquent côté petit producteur.
   */
  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_min_kg?: number;

  @ApiProperty({ enum: ProductQuality })
  @IsEnum(ProductQuality)
  qualite: ProductQuality;

  @ApiPropertyOptional({ example: ['Bio', 'Fairtrade'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  certifications?: string[];

  /**
   * Région / ville rendues OPTIONNELLES : l'app low-tech ne les demande
   * pas (déduit via le profil utilisateur ou laissé NULL). Les filtres
   * "près de chez moi" se basent alors sur le centroid `coordinates`.
   */
  @ApiPropertyOptional({ example: 'uuid-region' })
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({ example: 'uuid-ville' })
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({ example: '2025-12-31' })
  @IsOptional()
  @IsDateString()
  disponible_jusqu?: string;

  // Coordonnées OBLIGATOIRES pour la recherche géographique.
  // Pas de fallback "Abidjan" → on évite de polluer la carte.
  @ApiProperty({ type: CoordinatesDto })
  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates: CoordinatesDto;

  /**
   * Si renseigné, l'annonce est assignée à cette coopérative et passe
   * en statut PENDING (invisible du marketplace public jusqu'à
   * validation par la coop, puis intégration dans une publication).
   * Doit correspondre à la coopérative dont le farmer est membre actif.
   */
  @ApiPropertyOptional({
    description: "UUID de la coop à laquelle confier l'annonce (workflow validation)",
  })
  @IsOptional()
  @IsUUID()
  assigned_to_cooperative_id?: string;

  /**
   * Liste des produits de traitement appliqués sur ce lot (transparence
   * + certification BIO + contrôle résidus export). Optionnel.
   * Chaque produit_traitement_id doit exister dans le catalogue ADMIN.
   */
  @ApiPropertyOptional({ type: [TraitementAppliqueDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TraitementAppliqueDto)
  traitements?: TraitementAppliqueDto[];
}

/**
 * Mise à jour partielle d'une annonce de vente. Aucun champ obligatoire.
 * Le `status` est restreint aux valeurs de l'enum product_status.
 */
export class UpdateAnnonceVenteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 200)
  titre?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_par_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_min_kg?: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;

  @ApiPropertyOptional({ enum: AnnoncePublicStatus })
  @IsOptional()
  @IsEnum(AnnoncePublicStatus)
  status?: AnnoncePublicStatus;
}

export class CreateAnnonceAchatDto {
  @ApiProperty({ example: 'uuid-produit' })
  @IsUUID()
  @IsNotEmpty()
  produit_id: string;

  @ApiProperty({ example: 1000 })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiPropertyOptional({ example: 800 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_max_kg?: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;

  @ApiProperty({ example: 'uuid-region' })
  @IsUUID()
  @IsNotEmpty()
  region_id: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(500)
  rayon_km?: number;

  /**
   * Visibilité de l'offre d'achat — 3 niveaux possibles :
   *  • PUBLIC                (défaut) : visible par tout le monde
   *  • ALL_COOPERATIVES      : seules toutes les coops la voient
   *  • SPECIFIC_COOPERATIVE  : seule la coop ciblée (cf. target_cooperative_id)
   */
  @ApiPropertyOptional({
    enum: ['PUBLIC', 'ALL_COOPERATIVES', 'SPECIFIC_COOPERATIVE'],
    default: 'PUBLIC',
  })
  @IsOptional()
  @IsIn(['PUBLIC', 'ALL_COOPERATIVES', 'SPECIFIC_COOPERATIVE'])
  target_audience?: 'PUBLIC' | 'ALL_COOPERATIVES' | 'SPECIFIC_COOPERATIVE';

  /**
   * Si target_audience = SPECIFIC_COOPERATIVE, UUID de la coop ciblée.
   * Ignoré sinon.
   */
  @ApiPropertyOptional({ description: 'Cible d\'une coop précise (si SPECIFIC_COOPERATIVE)' })
  @IsOptional()
  @IsUUID()
  target_cooperative_id?: string;
}

export class UpdateAnnonceAchatDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_max_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/**
 * Query string de GET /marketplace/annonces/vente. Permet de filtrer la liste.
 * Tous les paramètres sont optionnels. `forbidNonWhitelisted` global
 * rejettera tout autre param non déclaré ici.
 */
export class ListerAnnoncesVenteQueryDto {
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
}

/**
 * Alias rétro-compatible. Le code consommateur doit migrer vers
 * `ListerAnnoncesVenteQueryDto`.
 * @deprecated
 */
export class ListerAnnoncesQueryDto extends ListerAnnoncesVenteQueryDto {}

/**
 * Query string de GET /marketplace/annonces/achat.
 * Mêmes filtres que pour les annonces de vente.
 */
export class ListerAnnoncesAchatQueryDto {
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
}
