// =====================================================================
//  DTO : Création d'un compte ADMIN
//  ---------------------------------------------------------------------
//  Deux usages :
//    • CreateAdminDto       → utilisé par POST /auth/admin/register
//                              (appelé par un SUPER_ADMIN authentifié)
//    • BootstrapAdminDto    → utilisé par POST /auth/admin/bootstrap
//                              (premier admin, gated par X-Bootstrap-Token)
//
//  Différences :
//    • Bootstrap force `niveau=SUPER_ADMIN` + toutes permissions = true,
//      pour garantir qu'on a au moins un super-admin opérationnel.
//      Les champs niveau/permissions du DTO sont donc IGNORÉS au bootstrap.
//    • CreateAdminDto laisse le SUPER_ADMIN choisir le niveau et les
//      permissions du nouvel admin.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { AdminNiveau } from './profile.dto';
import { normalizeLanguage, SupportedLanguage } from './register.dto';

export class CreateAdminDto {
  @ApiProperty({ example: '+2250709123456' })
  @IsString()
  @IsNotEmpty({ message: 'Le numéro de téléphone est obligatoire' })
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Format invalide. Exemple : +2250709123456',
  })
  phone: string;

  @ApiProperty({ example: 'Aya Konan' })
  @IsString()
  @IsNotEmpty({ message: 'Le nom complet est obligatoire' })
  @Length(2, 150)
  full_name: string;

  @ApiPropertyOptional({ example: 'aya.konan@farmcash.ci' })
  @IsOptional()
  @IsEmail({}, { message: 'Email invalide' })
  email?: string;

  @ApiPropertyOptional({ enum: SupportedLanguage, default: SupportedLanguage.FR })
  @IsOptional()
  @Transform(({ value }) => normalizeLanguage(value))
  @IsIn(Object.values(SupportedLanguage), {
    message: 'Langue non supportée. Accepté : fr, en.',
  })
  langue?: SupportedLanguage;

  // ─── Profil admin (modifiable par le SUPER_ADMIN appelant) ────────
  @ApiPropertyOptional({
    enum: AdminNiveau,
    default: AdminNiveau.ADMIN,
    description: 'Niveau attribué au nouvel admin. Défaut: ADMIN.',
  })
  @IsOptional()
  @IsIn(Object.values(AdminNiveau), {
    message: 'niveau invalide. Accepté : SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT.',
  })
  niveau?: AdminNiveau;

  @ApiPropertyOptional({ example: 'Modération' })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  departement?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  peut_valider_kyc?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  peut_gerer_finance?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  peut_gerer_users?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  peut_publier_news?: boolean;
}

/**
 * Bootstrap = même corps que CreateAdminDto, mais on documente que les
 * champs `niveau` et `peut_*` seront IGNORÉS et forcés à SUPER_ADMIN + true.
 * Toujours une seule fois — si la DB contient déjà un admin, la route 403.
 */
export class BootstrapAdminDto {
  @ApiProperty({ example: '+2250700000000' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{7,14}$/)
  phone: string;

  @ApiProperty({ example: 'Super Admin Initial' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 150)
  full_name: string;

  @ApiPropertyOptional({ example: 'admin@farmcash.ci' })
  @IsOptional()
  @IsEmail({})
  email?: string;

  @ApiPropertyOptional({ enum: SupportedLanguage, default: SupportedLanguage.FR })
  @IsOptional()
  @Transform(({ value }) => normalizeLanguage(value))
  @IsIn(Object.values(SupportedLanguage))
  langue?: SupportedLanguage;
}
