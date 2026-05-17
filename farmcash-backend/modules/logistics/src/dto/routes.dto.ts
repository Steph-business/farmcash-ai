// =====================================================================
//  DTOs : Routes transporteur
//  ---------------------------------------------------------------------
//  Chaque TRANSPORTER déclare ses routes (origine → destination) avec
//  son tarif. Quand une mission survient, le système matche par zone.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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

export class CreateTransporterRouteDto {
  @ApiProperty({ example: 'Bouaké' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  origin_zone: string;

  @ApiProperty({ example: 'Abidjan' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  destination_zone: string;

  @ApiProperty({ example: 150, description: 'FCFA par kg' })
  @IsNumber()
  @Min(0)
  tarif_kg: number;

  @ApiPropertyOptional({
    example: 10000,
    description: 'Tarif minimum facturé même pour petits volumes',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarif_minimum?: number;

  @ApiProperty({ example: 1000, description: 'Capacité max en kg' })
  @IsNumber()
  @Min(1)
  capacite_max_kg: number;

  @ApiPropertyOptional({ example: 'Sous 24h' })
  @IsOptional()
  @IsString()
  @Length(0, 50)
  delai_typique?: string;
}

export class UpdateTransporterRouteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarif_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarif_minimum?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  capacite_max_kg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 50)
  delai_typique?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/**
 * Devis : permet au buyer (ou orders) d'obtenir la liste des tarifs
 * dispo sur un trajet et une quantité données. Le moins cher est en tête.
 */
export class QuoteTransportQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  origin_zone: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  destination_zone: string;

  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantite_kg: number;
}
