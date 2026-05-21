// =====================================================================
//  DTOs : Véhicules transporteur
//  ---------------------------------------------------------------------
//  Un TRANSPORTER peut déclarer plusieurs véhicules (pick-up, camion
//  3.5t, camion 8t...). Chaque véhicule a sa charge max et son volume.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Min,
} from 'class-validator';

export class CreateVehicleDto {
  @ApiProperty({ example: 'Pick-up', description: 'Type de véhicule' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 30)
  type: string;

  @ApiPropertyOptional({ example: '1234 AB 01' })
  @IsOptional()
  @IsString()
  @Length(2, 20)
  immatriculation?: string;

  @ApiPropertyOptional({ example: 'Toyota Hilux' })
  @IsOptional()
  @IsString()
  @Length(0, 50)
  marque?: string;

  @ApiProperty({ example: 1500, description: 'Charge maximale en kg' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  charge_max_kg: number;

  @ApiPropertyOptional({ example: 8.5, description: 'Volume en m3' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  volume_m3?: number;

  @ApiPropertyOptional({ example: 'https://cdn.farmcash.ci/vehicles/foo.jpg' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  photo_url?: string;
}

export class UpdateVehicleDto {
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
  @Length(0, 50)
  marque?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  charge_max_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  volume_m3?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  photo_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
