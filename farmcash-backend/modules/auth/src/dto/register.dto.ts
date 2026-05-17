// =====================================================================
//  DTO : InscriptionDto
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

/**
 * Rôles autorisés à l'inscription PUBLIQUE.
 * ADMIN est volontairement EXCLU : la création d'un compte admin
 * passe par :
 *   - POST /auth/admin/register (callé par un SUPER_ADMIN existant)
 *   - POST /auth/admin/bootstrap (UNIQUEMENT si la DB n'a aucun admin,
 *     gated par le header X-Bootstrap-Token)
 *
 * Côté code on continue à utiliser `user_role` de @prisma/client pour
 * les types internes (qui inclut bien ADMIN).
 */
export enum UserRole {
  FARMER = 'FARMER',
  BUYER = 'BUYER',
  COOPERATIVE = 'COOPERATIVE',
  TRANSPORTER = 'TRANSPORTER',
  EXPORTER = 'EXPORTER',
}

export enum SupportedLanguage {
  FR = 'fr',
  EN = 'en',
}

/**
 * Normalise les variantes humaines vers le code court canonique.
 * v1 : FR + EN uniquement. Les langues locales (dioula, baoulé, agni)
 * seront ajoutées plus tard quand on aura :
 *   • Les traductions UI mobile complètes (locales/*.json)
 *   • Un LLM capable de répondre en langue locale avec qualité
 *   • Un STT pour permettre l'usage vocal aux non-alphabétisés
 *
 *   fr | francais | français | french    → 'fr'
 *   en | english | anglais | inglés       → 'en'
 */
export function normalizeLanguage(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  const map: Record<string, SupportedLanguage> = {
    fr: SupportedLanguage.FR,
    francais: SupportedLanguage.FR,
    français: SupportedLanguage.FR,
    french: SupportedLanguage.FR,
    en: SupportedLanguage.EN,
    english: SupportedLanguage.EN,
    anglais: SupportedLanguage.EN,
    inglés: SupportedLanguage.EN,
  };
  return map[v] ?? v;
}

export class InscriptionDto {
  @ApiProperty({
    example: '+2250709123456',
    description: 'Numéro de téléphone au format international (E.164)',
  })
  @IsString()
  @IsNotEmpty({ message: 'Le numéro de téléphone est obligatoire' })
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Format invalide. Exemple : +2250709123456',
  })
  phone: string;

  @ApiProperty({ example: 'Koffi Aya' })
  @IsString()
  @IsNotEmpty({ message: 'Le nom complet est obligatoire' })
  @Length(2, 150, { message: 'Le nom doit avoir entre 2 et 150 caractères' })
  full_name: string;

  @ApiProperty({ enum: UserRole, example: UserRole.FARMER })
  @IsEnum(UserRole, { message: 'Rôle invalide' })
  role: UserRole;

  @ApiPropertyOptional({ example: 'contact@koffiaya.ci' })
  @IsOptional()
  @IsEmail({}, { message: 'Email invalide' })
  email?: string;

  @ApiPropertyOptional({
    enum: SupportedLanguage,
    default: SupportedLanguage.FR,
    description:
      "Code court (fr|en). Accepte aussi les variantes : 'français', 'anglais', 'english'.",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLanguage(value))
  @IsIn(Object.values(SupportedLanguage), {
    message: 'Langue non supportée. Accepté : fr, en (ou anglais, français, english).',
  })
  langue?: SupportedLanguage;

  /**
   * UUID d'une coopérative existante choisie par le FARMER à l'inscription.
   * Déclenche automatiquement une demande d'adhésion (status PENDING) que
   * la coopérative validera ensuite depuis son dashboard.
   * Ignoré silencieusement si role !== FARMER.
   */
  @ApiPropertyOptional({
    description: 'Coopérative à rejoindre (FARMER uniquement)',
  })
  @IsOptional()
  @IsUUID('4', { message: 'cooperative_id invalide' })
  default_cooperative_id?: string;
}
