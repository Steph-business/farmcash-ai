// =====================================================================
//  DTOs : Parcelles + Cultures (agronomie)
//  ---------------------------------------------------------------------
//  Une parcelle = un terrain agricole (table `parcelle`).
//  Une culture  = un produit planté sur une parcelle (table `user_cultures`).
//
//  La superficie d'une culture est explicitement renseignée et bornée
//  à la superficie de la parcelle (vérifié côté service).
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { CoordinatesDto } from './annonces.dto';

export class CreateParcelleDto {
  @ApiProperty({ example: 'Champ derrière la maison' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  nom: string;

  /**
   * Superficie en hectares. Nommé `superficie_ha` pour rester aligné
   * avec la colonne DB (`parcelle.superficie_ha`).
   */
  @ApiProperty({ example: 1.5, description: 'Superficie en hectares' })
   @IsNumber()
   @Min(0.01)
  superficie_ha: number;

  /**
   * Produit principal cultivé sur la parcelle (optionnel — peut être
   * complété plus tard via les cultures).
   */
  @ApiPropertyOptional({ example: 'uuid-produit' })
  @IsOptional()
  @IsUUID()
  produit_id?: string;

  /**
   * Région / ville rendues OPTIONNELLES : un producteur low-tech qui
   * publie depuis son champ n'a pas à choisir manuellement. On déduit
   * du profil utilisateur ou on stocke le centroid GPS.
   */
  @ApiPropertyOptional({ example: 'uuid-region' })
  @IsOptional()
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional({ example: 'uuid-ville' })
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({ type: CoordinatesDto, description: 'Centroïde GPS' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordinatesDto)
  centroid?: CoordinatesDto;
}

export class UpdateParcelleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 100)
  nom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  superficie_ha?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  produit_id?: string;
}

export class AddCultureDto {
  @ApiProperty({ example: 'uuid-parcelle' })
  @IsUUID()
  @IsNotEmpty()
  parcelle_id: string;

  @ApiProperty({ example: 'uuid-produit' })
  @IsUUID()
  @IsNotEmpty()
  produit_id: string;

  // OBLIGATOIRE : on ne suppose plus que la culture couvre toute la parcelle.
  @ApiProperty({ example: 3.5, description: 'Superficie de la culture en ha' })
  @IsNumber()
  @Min(0.01)
  superficie_ha: number;

  @ApiPropertyOptional({ example: '2025-05-15' })
  @IsOptional()
  @IsDateString()
  date_plantation?: string;
}
