// =====================================================================
//  DTO : ProfilProducteurDto
//  Données du profil étendu pour un utilisateur FARMER.
//  Utilisé dans POST /auth/profile/producteur
//  (Correspond à la table producteur_profiles en SQL)
// =====================================================================

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { normalizeLanguage, SupportedLanguage } from './register.dto';

export class ProfilProducteurDto {
  @ApiPropertyOptional({
    example: 'uuid-region',
    description: 'ID de la région (table regions_ci)',
  })
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({
    example: 'uuid-ville',
    description: 'ID de la ville (table villes_ci)',
  })
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({
    example: 'Village Kokoblé',
    description: 'Nom du village si non présent dans villes_ci',
  })
  @IsOptional()
  @IsString()
  village_libre?: string;

  @ApiPropertyOptional({
    example: 5.5,
    description: 'Superficie totale exploitée en hectares',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  superficie_ha?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Nombre d\'années d\'expérience agricole',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  nb_annees_exp?: number;

  @ApiPropertyOptional({
    example: ['igname', 'manioc', 'tomate'],
    description: 'Liste des cultures pratiquées',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cultures_principales?: string[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  est_membre_coop?: boolean;

  @ApiPropertyOptional({ example: 'uuid-coop' })
  @IsOptional()
  @IsUUID()
  coop_id?: string;
}

// =====================================================================
//  DTO : ProfilAcheteurDto
//  Données du profil étendu pour un utilisateur BUYER.
//  (Correspond à la table acheteur_profiles en SQL)
// =====================================================================

export class ProfilAcheteurDto {
  @ApiPropertyOptional({
    example: 'SARL AgriCommerce',
    description: 'Nom de la société (pour les acheteurs professionnels)',
  })
  @IsOptional()
  @IsString()
  company_name?: string;

  @ApiPropertyOptional({
    example: 'CI-2024-B-12345',
    description: 'Numéro RCCM (Registre du Commerce et Crédit Mobilier)',
  })
  @IsOptional()
  @IsString()
  numero_rccm?: string;

  @ApiPropertyOptional({
    example: 5000,
    description: 'Capacité maximale d\'achat en kg par commande',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacite_achat_kg?: number;

  @ApiPropertyOptional({
    example: ['Abidjan', 'Bouaké', 'Korhogo'],
    description: 'Zones géographiques où l\'acheteur opère',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  zones_achat?: string[];
}

// =====================================================================
//  DTO : ProfilCooperativeDto
//  Données du profil étendu pour une COOPERATIVE.
//  (Correspond à la table cooperative_profiles en SQL)
// =====================================================================

export class ProfilCooperativeDto {
  @ApiPropertyOptional({
    example: 'Coopérative Ananas de l\'Agnéby',
    description: 'Nom officiel de la coopérative',
  })
  @IsOptional()
  @IsString()
  nom?: string;

  @ApiPropertyOptional({
    example: 'MINEFI-2023-COOP-0042',
    description: 'Numéro d\'agrément officiel de la coopérative',
  })
  @IsOptional()
  @IsString()
  numero_agrement?: string;

  @ApiPropertyOptional({ example: 'uuid-region' })
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({ example: 'uuid-ville' })
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({
    example: ['ananas', 'manioc'],
    description: 'Produits gérés par la coopérative',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  produits?: string[];
}

// =====================================================================
//  DTO : ProfilTransporteurDto
//  Données du profil étendu pour un utilisateur TRANSPORTER.
//  (Correspond à la table transporteur_profiles en SQL)
//
//  Les 3 champs obligatoires en DB (numero_permis, immatriculation,
//  type_vehicule, capacite_max_kg) restent optionnels au niveau DTO
//  pour permettre des PATCH partiels. Le service vérifie qu'ils sont
//  tous fournis au premier create (pas de profil vide possible côté DB).
// =====================================================================

export enum TypeVehicule {
  MOTO = 'MOTO',
  TRICYCLE = 'TRICYCLE',
  PICKUP = 'PICKUP',
  FOURGON = 'FOURGON',
  CAMION = 'CAMION',
  CAMION_FRIGO = 'CAMION_FRIGO',
  REMORQUE = 'REMORQUE',
}

export class ProfilTransporteurDto {
  @ApiPropertyOptional({
    example: 'Transport Yao Express SARL',
    description: 'Nom commercial (laissez vide si transporteur indépendant)',
  })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nom_entreprise?: string;

  @ApiPropertyOptional({ example: 'CI-2024-T-98765' })
  @IsOptional()
  @IsString()
  numero_rccm?: string;

  @ApiPropertyOptional({ example: '1801234A' })
  @IsOptional()
  @IsString()
  numero_ifu?: string;

  @ApiPropertyOptional({ example: 'CI-PERM-2020-456789' })
  @IsOptional()
  @IsString()
  @Length(3, 100)
  numero_permis?: string;

  @ApiPropertyOptional({ example: 'C', description: 'A, B, C, D, E, CE…' })
  @IsOptional()
  @IsString()
  @Length(1, 10)
  categorie_permis?: string;

  @ApiPropertyOptional({ enum: TypeVehicule })
  @IsOptional()
  @IsIn(Object.values(TypeVehicule), {
    message:
      'type_vehicule invalide. Accepté : MOTO, TRICYCLE, PICKUP, FOURGON, CAMION, CAMION_FRIGO, REMORQUE.',
  })
  type_vehicule?: TypeVehicule;

  @ApiPropertyOptional({ example: '4567 AB 01' })
  @IsOptional()
  @IsString()
  @Length(2, 20)
  immatriculation?: string;

  @ApiPropertyOptional({ example: 'Isuzu N-Series 2020' })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  marque_modele?: string;

  @ApiPropertyOptional({ example: 2020 })
  @IsOptional()
  @IsInt()
  @Min(1980)
  annee_vehicule?: number;

  @ApiPropertyOptional({ example: 3000, description: 'Capacité max en kg' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  capacite_max_kg?: number;

  @ApiPropertyOptional({ example: 18.5, description: 'Volume max en m³' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume_max_m3?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_refrigere?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_bache?: boolean;

  @ApiPropertyOptional({ example: 'uuid-region' })
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({ example: 'uuid-ville' })
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({
    example: ['Bouaké', 'Yamoussoukro', 'Abidjan'],
    description: 'Zones additionnelles couvertes',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  zones_couvertes?: string[];

  @ApiPropertyOptional({ example: 300, description: 'Rayon d\'action en km' })
  @IsOptional()
  @IsInt()
  @Min(1)
  rayon_action_km?: number;

  @ApiPropertyOptional({ example: 150, description: 'Tarif/kg par défaut (FCFA)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarif_kg_default?: number;

  @ApiPropertyOptional({ example: 10000, description: 'Tarif minimum par défaut (FCFA)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarif_minimum_default?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  disponible?: boolean;
}

// =====================================================================
//  DTO : ProfilExportateurDto
//  Données du profil étendu pour un utilisateur EXPORTER.
//  (Correspond à la table exportateur_profiles en SQL)
// =====================================================================

export class ProfilExportateurDto {
  @ApiPropertyOptional({ example: 'CocoaExport CI SA' })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  company_name?: string;

  @ApiPropertyOptional({ example: 'CI-2024-E-11111' })
  @IsOptional()
  @IsString()
  numero_rccm?: string;

  @ApiPropertyOptional({ example: '1801234B' })
  @IsOptional()
  @IsString()
  numero_ifu?: string;

  @ApiPropertyOptional({
    example: 'AE-CI-2024-789',
    description: 'Agrément du ministère du commerce extérieur',
  })
  @IsOptional()
  @IsString()
  agrement_export?: string;

  @ApiPropertyOptional({
    example: ['anacarde', 'manioc séché', 'gingembre'],
    description: 'Produits exportés',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  produits_exportes?: string[];

  @ApiPropertyOptional({
    example: ['FR', 'DE', 'NL', 'CN'],
    description: 'Codes ISO ou libellés des pays cibles',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pays_destination?: string[];

  @ApiPropertyOptional({
    example: ['FOB', 'CIF', 'EXW'],
    description: 'Incoterms gérés',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  incoterms_supportes?: string[];

  @ApiPropertyOptional({ example: 'Abidjan' })
  @IsOptional()
  @IsString()
  port_attache?: string;

  @ApiPropertyOptional({ example: 250000, description: 'Volume annuel approx. (kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume_annuel_kg?: number;

  @ApiPropertyOptional({ example: 'CI05 CI05 0123 4567 8901 2345 678' })
  @IsOptional()
  @IsString()
  @Length(8, 50)
  iban?: string;

  @ApiPropertyOptional({ example: 'BICICIDAXXX' })
  @IsOptional()
  @IsString()
  @Length(8, 20)
  swift_bic?: string;
}

// =====================================================================
//  DTO : ProfilAdminDto
//  Données du profil étendu pour un utilisateur ADMIN.
//  (Correspond à la table admin_profiles en SQL)
//
//  Note sécurité : seul un SUPER_ADMIN peut modifier le `niveau` et les
//  permissions `peut_*` d'un autre admin. Les autres champs (departement,
//  notes) restent éditables par l'admin lui-même. Le service applique
//  cette logique.
// =====================================================================

export enum AdminNiveau {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  MODERATOR = 'MODERATOR',
  SUPPORT = 'SUPPORT',
}

export class ProfilAdminDto {
  @ApiPropertyOptional({ enum: AdminNiveau })
  @IsOptional()
  @IsIn(Object.values(AdminNiveau), {
    message:
      'niveau invalide. Accepté : SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT.',
  })
  niveau?: AdminNiveau;

  @ApiPropertyOptional({ example: 'Finance' })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  departement?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  peut_valider_kyc?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  peut_gerer_finance?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  peut_gerer_users?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  peut_publier_news?: boolean;

  @ApiPropertyOptional({ example: 'Admin du pôle Finance depuis mars 2026.' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Koffi Aya' })
  @IsOptional()
  @IsString()
  @Length(2, 150)
  full_name?: string;

  @ApiPropertyOptional({ example: 'contact@koffiaya.ci' })
  @IsOptional()
  @IsEmail({}, { message: 'Email invalide' })
  email?: string;

  @ApiPropertyOptional({ example: 'https://cdn.farmcash.ci/photo.jpg' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }, { message: 'URL invalide' })
  photo_url?: string;

  @ApiPropertyOptional({
    enum: SupportedLanguage,
    description:
      "Code court (fr|en). Accepte aussi : 'français', 'anglais', 'english'.",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLanguage(value))
  @IsIn(Object.values(SupportedLanguage), {
    message: 'Langue non supportée. Accepté : fr, en (ou anglais, français, english).',
  })
  langue?: SupportedLanguage;
}
