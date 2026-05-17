// =====================================================================
//  DTOs : Oversight (admin / coop / exporter)
//  ---------------------------------------------------------------------
//  Filtres de listing pour les vues de supervision. Toutes les routes
//  d'oversight sont en LECTURE SEULE (sauf admin freezeWallet /
//  deactivateUser). On filtre/agrège ce qui existe déjà dans les autres
//  modules — on ne duplique JAMAIS de logique métier.
// =====================================================================

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 20;
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['FARMER', 'BUYER', 'COOPERATIVE', 'TRANSPORTER', 'EXPORTER', 'ADMIN'],
  })
  @IsOptional()
  @IsEnum(['FARMER', 'BUYER', 'COOPERATIVE', 'TRANSPORTER', 'EXPORTER', 'ADMIN'])
  role?: string;

  @ApiPropertyOptional({ description: 'Recherche par nom (contains, case-insensitive)' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ListTransactionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['PAYIN', 'RELEASE', 'PAYOUT', 'REFUND', 'FEE'] })
  @IsOptional()
  @IsEnum(['PAYIN', 'RELEASE', 'PAYOUT', 'REFUND', 'FEE'])
  type?: string;

  @ApiPropertyOptional({ enum: ['PENDING', 'SUCCESS', 'FAILED', 'ESCROW', 'REFUNDED'] })
  @IsOptional()
  @IsEnum(['PENDING', 'SUCCESS', 'FAILED', 'ESCROW', 'REFUNDED'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  user_id?: string;
}

export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['SENT', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED'],
  })
  @IsOptional()
  @IsEnum(['SENT', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED'])
  status?: string;
}

export class FreezeWalletDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Filtre temporel pour les routes timeline / agrégations.
 * Toujours optionnel ; par défaut 30 jours.
 */
export class TimelineQueryDto {
  @ApiPropertyOptional({
    enum: ['7d', '30d', '90d', 'year'],
    default: '30d',
  })
  @IsOptional()
  @IsEnum(['7d', '30d', '90d', 'year'])
  period?: '7d' | '30d' | '90d' | 'year' = '30d';
}

export class TopQueryDto extends TimelineQueryDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;
}
