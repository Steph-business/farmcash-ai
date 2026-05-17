// =====================================================================
//  DTOs : Actualités IA (news)
//  ---------------------------------------------------------------------
//  Publiées par ADMIN (manuellement ou via jobs externes). Le client
//  filtre par rôle et région pour ne voir que les news qui le concernent.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export enum NewsType {
  GENERAL = 'GENERAL',
  PRICE_TREND = 'PRICE_TREND',
  WEATHER_ALERT = 'WEATHER_ALERT',
  DISEASE_ALERT = 'DISEASE_ALERT',
  MARKET_NEWS = 'MARKET_NEWS',
  REGULATION = 'REGULATION',
  COOP_ANNOUNCEMENT = 'COOP_ANNOUNCEMENT',
}

export enum TargetRole {
  FARMER = 'FARMER',
  BUYER = 'BUYER',
  COOPERATIVE = 'COOPERATIVE',
  TRANSPORTER = 'TRANSPORTER',
  EXPORTER = 'EXPORTER',
}

export class CreateNewsDto {
  @ApiProperty({ enum: NewsType })
  @IsEnum(NewsType)
  type: NewsType;

  @ApiProperty({ example: 'Hausse du prix du maïs : +12% cette semaine' })
  @IsString()
  @IsNotEmpty()
  @Length(5, 200)
  titre: string;

  @ApiProperty({ example: 'Le marché local du maïs connaît une hausse en raison de la sécheresse...' })
  @IsString()
  @IsNotEmpty()
  @Length(10, 5000)
  body: string;

  @ApiPropertyOptional({
    enum: TargetRole,
    description: 'Si omis : visible par tous les rôles.',
  })
  @IsOptional()
  @IsEnum(TargetRole)
  cible_role?: TargetRole;

  @ApiPropertyOptional({ description: 'Si omis : actualité nationale.' })
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  expires_at?: string;
}

export class UpdateNewsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(5, 200)
  titre?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(10, 5000)
  body?: string;

  @ApiPropertyOptional({ enum: TargetRole })
  @IsOptional()
  @IsEnum(TargetRole)
  cible_role?: TargetRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expires_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ListNewsQueryDto {
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

  @ApiPropertyOptional({ enum: NewsType })
  @IsOptional()
  @IsEnum(NewsType)
  type?: NewsType;
}
