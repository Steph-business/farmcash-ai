// =====================================================================
//  DTOs : Sollicitations coop multi-audience (Chantier 2)
//  ---------------------------------------------------------------------
//  Couvre :
//   • CreateSollicitationDto      → POST /coop/sollicitations
//   • RespondSollicitationDto     → POST /coop/sollicitations/:id/respond
//   • ListerSollicitationsQueryDto → GET  /coop/sollicitations
//
//  Convention :
//   • class-validator strict (forbidNonWhitelisted activé globalement)
//   • Enums TypeScript miroirs des valeurs SQL (audience_segment / status)
//   • @ApiProperty / @ApiPropertyOptional pour Swagger
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
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

// ---------------------------------------------------------------------
//  Enums miroir des valeurs SQL
// ---------------------------------------------------------------------

export enum SollicitationAudience {
  MEMBRES = 'MEMBRES',
  COOPS_VOISINES = 'COOPS_VOISINES',
  INDEPENDANTS = 'INDEPENDANTS',
}

export enum SollicitationStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  FULFILLED = 'FULFILLED',
}

export enum SollicitationResponseAction {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  IGNORED = 'IGNORED',
  CONFIRMED_BY_COOP = 'CONFIRMED_BY_COOP',
}

// ---------------------------------------------------------------------
//  POST /coop/sollicitations — création par le président d'une coop
// ---------------------------------------------------------------------

export class CreateSollicitationDto {
  /** Demande d'achat source — doit cibler la coop (ou être ALL_COOPERATIVES). */
  @ApiProperty({ description: 'UUID de l\'annonce d\'achat source' })
  @IsUUID()
  @IsNotEmpty()
  annonce_achat_id: string;

  @ApiProperty({ example: 'Besoin urgent de 5 tonnes de maïs cette semaine.' })
  @IsString()
  @Length(10, 2000)
  message: string;

  @ApiProperty({
    enum: SollicitationAudience,
    isArray: true,
    description: 'Au moins une audience requise',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(SollicitationAudience, { each: true })
  audiences: SollicitationAudience[];

  @ApiPropertyOptional({
    default: 50,
    description: 'Rayon km pour COOPS_VOISINES + INDEPENDANTS',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  rayon_km?: number = 50;

  @ApiPropertyOptional({ description: 'Délai max en jours (défaut : 7)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  duree_jours?: number = 7;
}

// ---------------------------------------------------------------------
//  POST /coop/sollicitations/:id/respond — réponse d'un destinataire
// ---------------------------------------------------------------------

export class RespondSollicitationDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  @IsIn(['ACCEPTED', 'REJECTED'])
  action: 'ACCEPTED' | 'REJECTED';

  @ApiPropertyOptional({
    description: 'Quantité offerte (kg) — requis si ACCEPTED',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantite_kg?: number;
}

// ---------------------------------------------------------------------
//  GET /coop/sollicitations — listing par la coop initiatrice
// ---------------------------------------------------------------------

export class ListerSollicitationsQueryDto {
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

  @ApiPropertyOptional({ enum: SollicitationStatus })
  @IsOptional()
  @IsEnum(SollicitationStatus)
  status?: SollicitationStatus;
}
