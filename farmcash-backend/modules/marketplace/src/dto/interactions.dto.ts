// =====================================================================
//  DTOs : Favoris + Avis + Médias
//  ---------------------------------------------------------------------
//  Les médias peuvent être attachés à :
//    • une annonce de vente (annonce_vente_id)
//    • une publication coopérative (publication_coop_id)
//    • un lot (lot_id)
//  Le service vérifie l'ownership de la cible avant d'autoriser
//  l'ajout / la suppression.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class AddFavoriDto {
  @ApiProperty({ example: 'uuid-annonce' })
  @IsUUID()
  @IsNotEmpty()
  annonce_id: string;
}

export class AddAvisDto {
  @ApiProperty({ example: 'uuid-annonce' })
  @IsUUID()
  @IsNotEmpty()
  annonce_id: string;

  @ApiProperty({ example: 4, description: 'Note de 1 à 5' })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ example: 'Très bonne qualité, livraison rapide.' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  commentaire?: string;
}

export enum MediaTargetType {
  ANNONCE_VENTE = 'ANNONCE_VENTE',
  PUBLICATION_COOP = 'PUBLICATION_COOP',
  LOT = 'LOT',
  PARCELLE = 'PARCELLE',
}

export enum MediaKind {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  DOCUMENT = 'DOCUMENT',
}

export class AddMediaDto {
  @ApiProperty({ enum: MediaTargetType, description: 'Type de cible' })
  @IsEnum(MediaTargetType)
  target_type: MediaTargetType;

  @ApiProperty({ example: 'uuid-cible', description: 'ID de la cible (annonce/publication/lot)' })
  @IsUUID()
  @IsNotEmpty()
  target_id: string;

  @ApiProperty({ example: 'https://cdn.farmcash.ci/photo.jpg' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }, { message: 'URL invalide' })
  url: string;

  @ApiPropertyOptional({ example: 'https://cdn.farmcash.ci/thumb.jpg' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  thumbnail_url?: string;

  @ApiProperty({ enum: MediaKind })
  @IsEnum(MediaKind)
  type: MediaKind;
}

/**
 * Body multipart pour POST /interactions/medias/upload.
 * Le fichier arrive via `@UploadedFile()` ; ce DTO ne contient que les
 * métadonnées transmises en form-data.
 */
export class UploadMediaDto {
  @ApiProperty({ enum: MediaTargetType })
  @IsEnum(MediaTargetType)
  target_type: MediaTargetType;

  @ApiProperty({ example: 'uuid-cible' })
  @IsUUID()
  @IsNotEmpty()
  target_id: string;

  @ApiPropertyOptional({ enum: MediaKind, default: MediaKind.IMAGE })
  @IsOptional()
  @IsEnum(MediaKind)
  type?: MediaKind;
}
