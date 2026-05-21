// =====================================================================
//  DTOs : Adresses de livraison BUYER
//  ---------------------------------------------------------------------
//  Le BUYER peut enregistrer plusieurs adresses (Domicile, Restaurant,
//  Entrepot, ...) et désigner une adresse par défaut. À la commande,
//  on lui propose ses adresses pour pré-remplir delivery_address.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class CreateBuyerAddressDto {
  @ApiProperty({ example: 'Domicile' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  libelle: string;

  @ApiProperty({ example: 'Kouassi N\'Guessan' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  contact_nom: string;

  @ApiProperty({ example: '+2250701020304' })
  @IsString()
  @IsNotEmpty()
  @Length(8, 20)
  contact_phone: string;

  @ApiProperty({ example: 'Rue 12, Cocody Riviera Faya, Abidjan' })
  @IsString()
  @IsNotEmpty()
  @Length(5, 500)
  adresse_complete: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional({ example: 5.3622 })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: -4.0083 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}

export class UpdateBuyerAddressDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 100)
  libelle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 100)
  contact_nom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 20)
  contact_phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(5, 500)
  adresse_complete?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ville_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
