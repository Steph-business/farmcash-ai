// =====================================================================
//  DTOs : Produits de traitement
//  ---------------------------------------------------------------------
//  Catalogue de traitements agricoles (pesticides, fongicides, engrais,
//  bio-stimulants). Géré par ADMIN, consulté par FARMER.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export enum TreatmentType {
  FONGICIDE = 'FONGICIDE',
  INSECTICIDE = 'INSECTICIDE',
  HERBICIDE = 'HERBICIDE',
  ENGRAIS = 'ENGRAIS',
  BIO_STIMULANT = 'BIO_STIMULANT',
  AUTRE = 'AUTRE',
}

export class CreateTreatmentDto {
  @ApiProperty({ example: 'Cuivrosan 50 WG' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 200)
  nom: string;

  @ApiPropertyOptional({ enum: TreatmentType })
  @IsOptional()
  @IsEnum(TreatmentType)
  type?: TreatmentType;

  @ApiPropertyOptional({
    example: ['mais-grain-blanc', 'ananas-cayenne-lisse'],
    description: 'Slugs de cultures cibles',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cultures_cibles?: string[];

  @ApiPropertyOptional({
    example: ['mildiou', 'pourriture noire'],
    description: 'Maladies/ravageurs cibles',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  maladies_cibles?: string[];

  @ApiPropertyOptional({ example: '50g par 100L d\'eau' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  dosage?: string;

  @ApiPropertyOptional({ example: 'Pulvérisation foliaire le matin' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  mode_application?: string;

  @ApiPropertyOptional({ example: 14, description: 'Délai avant récolte (jours)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  delai_carence_j?: number;
}

export class UpdateTreatmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nom?: string;

  @ApiPropertyOptional({ enum: TreatmentType })
  @IsOptional()
  @IsEnum(TreatmentType)
  type?: TreatmentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cultures_cibles?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  maladies_cibles?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  dosage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  mode_application?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  delai_carence_j?: number;
}

export class ListTreatmentsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ description: 'Filtre par maladie (recherche exacte sur le tableau)' })
  @IsOptional()
  @IsString()
  disease?: string;

  @ApiPropertyOptional({ description: 'Filtre par culture' })
  @IsOptional()
  @IsString()
  culture?: string;

  @ApiPropertyOptional({ enum: TreatmentType })
  @IsOptional()
  @IsEnum(TreatmentType)
  type?: TreatmentType;
}
