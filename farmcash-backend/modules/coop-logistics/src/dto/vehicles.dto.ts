// =====================================================================
//  DTOs : Parc véhicules coop (coop_vehicles)
//  ---------------------------------------------------------------------
//  CRUD basique du parc véhicules détenu par une coopérative.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class CreateCoopVehicleDto {
  @ApiProperty({ example: 'Pick-up', description: 'Type libre (ex: Pick-up, Camion 3.5t, Camion 8t)' })
  @IsString()
  @Length(2, 30)
  type: string;

  @ApiPropertyOptional({ example: '1234-AB-01' })
  @IsOptional()
  @IsString()
  @Length(2, 20)
  immatriculation?: string;

  @ApiPropertyOptional({ example: 'Toyota Hilux' })
  @IsOptional()
  @IsString()
  @Length(2, 50)
  marque?: string;

  @ApiProperty({ example: 3500, description: 'Charge max en kg' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  charge_max_kg: number;

  @ApiPropertyOptional({ example: 'Ousmane Coulibaly' })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  chauffeur_nom?: string;

  @ApiPropertyOptional({ example: '+225 0701020304' })
  @IsOptional()
  @IsString()
  @Length(5, 20)
  chauffeur_phone?: string;
}

export class UpdateCoopVehicleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 30)
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 20)
  immatriculation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 50)
  marque?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  charge_max_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 100)
  chauffeur_nom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(5, 20)
  chauffeur_phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
