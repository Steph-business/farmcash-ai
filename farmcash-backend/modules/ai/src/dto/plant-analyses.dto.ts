// =====================================================================
//  DTOs : Plant Analyses
//  ---------------------------------------------------------------------
//  Diagnostic IA d'une plante. Le FARMER fournit une URL d'image
//  (uploadée préalablement sur S3/MinIO) et le contexte (parcelle,
//  produit). Le service appelle l'IA via PlantAiProvider et persiste
//  le diagnostic.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export class GpsPoint {
  @ApiProperty({ example: 5.345317 })
  @IsLatitude()
  @Type(() => Number)
  lat: number;

  @ApiProperty({ example: -4.024429 })
  @IsLongitude()
  @Type(() => Number)
  lng: number;
}

export class AnalyzePlantDto {
  @ApiProperty({ example: 'https://cdn.farmcash.ci/plants/photo.jpg' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  image_url: string;

  @ApiPropertyOptional({
    description: "ID de la parcelle où la photo a été prise (vérifié ownership)",
  })
  @IsOptional()
  @IsUUID()
  parcelle_id?: string;

  @ApiPropertyOptional({ description: 'ID du produit suspecté' })
  @IsOptional()
  @IsUUID()
  produit_id?: string;

  @ApiPropertyOptional({
    type: GpsPoint,
    description: 'Position GPS de la prise de vue (utile pour les alertes régionales)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GpsPoint)
  location?: GpsPoint;
}

export class ListPlantAnalysesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsOptional()
  @IsEnum(RiskLevel)
  risk_level?: RiskLevel;
}
