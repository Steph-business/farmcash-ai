// =====================================================================
//  DTOs : Collectes coop internes (coop_collections)
//  ---------------------------------------------------------------------
//  Planification + suivi des collectes membre → coop avant la pesée.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

export enum CoopCollectionStatus {
  PLANNED = 'PLANNED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export class CreateCoopCollectionDto {
  @ApiProperty({ description: 'UUID du farmer chez qui collecter' })
  @IsUUID()
  @IsNotEmpty()
  farmer_id: string;

  @ApiProperty({ example: '2026-05-23T08:00:00Z' })
  @IsDateString()
  scheduled_at: string;

  @ApiProperty({ example: 'Lot Cocody, près du marché' })
  @IsString()
  @Length(3, 500)
  pickup_address: string;

  @ApiProperty({ example: 500, description: 'Quantité prévue à collecter (kg)' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantite_prevue_kg: number;

  @ApiPropertyOptional({ description: 'Véhicule assigné (parc coop)' })
  @IsOptional()
  @IsUUID()
  vehicle_id?: string;

  @ApiPropertyOptional({ description: 'Annonce de vente liée (optionnel)' })
  @IsOptional()
  @IsUUID()
  annonce_vente_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

export class UpdateCoopCollectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 500)
  pickup_address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantite_prevue_kg?: number;

  @ApiPropertyOptional({ enum: CoopCollectionStatus })
  @IsOptional()
  @IsEnum(CoopCollectionStatus)
  status?: CoopCollectionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vehicle_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

export class ListCoopCollectionsQueryDto {
  @ApiPropertyOptional({ enum: CoopCollectionStatus })
  @IsOptional()
  @IsEnum(CoopCollectionStatus)
  status?: CoopCollectionStatus;
}
