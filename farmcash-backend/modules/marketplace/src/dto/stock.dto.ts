// =====================================================================
//  DTOs : Entrepôts + Lots (stock)
//  ---------------------------------------------------------------------
//  Le type de lot est restreint à INDIVIDUAL ou COOPERATIVE via un enum.
//  Le service vérifie en plus que le rôle du user matche le type
//  (FARMER → INDIVIDUAL, COOPERATIVE → COOPERATIVE) — voir StockService.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
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
import { ProductQuality } from './annonces.dto';

export enum LotType {
  INDIVIDUAL = 'INDIVIDUAL',
  COOPERATIVE = 'COOPERATIVE',
}

export class CreateEntrepotDto {
  @ApiProperty({ example: 'Entrepôt Central Bouaké' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 200)
  nom: string;

  @ApiProperty({ example: 'uuid-region' })
  @IsUUID()
  @IsNotEmpty()
  region_id: string;

  @ApiProperty({ example: 'uuid-ville' })
  @IsUUID()
  @IsNotEmpty()
  ville_id: string;

  @ApiPropertyOptional({ example: 'Quartier Commerce, Rue 12' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  adresse?: string;

  @ApiPropertyOptional({ example: 10000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacite_kg?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_refrigere?: boolean;
}

export class UpdateEntrepotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacite_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_refrigere?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class CreateLotDto {
  @ApiProperty({ example: 'LOT-CACAO-2025-001' })
  @IsString()
  @IsNotEmpty()
  @Length(3, 30)
  lot_code: string;

  @ApiProperty({ enum: LotType })
  @IsEnum(LotType)
  type: LotType;

  @ApiPropertyOptional({ example: 'uuid-produit' })
  @IsOptional()
  @IsUUID()
  produit_id?: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;

  @ApiPropertyOptional({ example: '2025-08-15' })
  @IsOptional()
  @IsDateString()
  date_recolte?: string;
}

export class UpdateLotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_kg?: number;

  @ApiPropertyOptional({ enum: ProductQuality })
  @IsOptional()
  @IsEnum(ProductQuality)
  qualite?: ProductQuality;
}
