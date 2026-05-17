// =====================================================================
//  DTOs : Connexion par PIN, gestion du PIN, refresh token
//  ---------------------------------------------------------------------
//  Chacune de ces classes est un "contrat" : elle décrit exactement les
//  champs attendus dans le body d'une requête, leur format, et les
//  validations à appliquer (longueur, regex, type). class-validator
//  refuse automatiquement toute requête qui n'y correspond pas.
// =====================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

// Le PIN est exactement 4 à 6 chiffres. On le valide deux fois :
// - via @Length(4, 6) → message d'erreur lisible
// - via @Matches(PIN_PATTERN) → empêche les caractères non numériques
const PIN_PATTERN = /^\d{4,6}$/;
const PIN_MESSAGE = 'Le PIN doit contenir 4 à 6 chiffres';

/**
 * Body de POST /auth/login-pin : numéro + PIN.
 * Le numéro DOIT être au format E.164 international (+225...).
 */
export class ConnexionPinDto {
  @ApiProperty({ example: '+2250709123456' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Format invalide. Exemple : +2250709123456',
  })
  phone: string;

  @ApiProperty({ example: '1234' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  pin: string;
}

/**
 * Body de POST /auth/set-pin : nouveau PIN + confirmation.
 * Le service vérifie également que le PIN n'est pas trivial (1234, 0000…).
 */
export class DefinirPinDto {
  @ApiProperty({ example: '1234' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  pin: string;

  @ApiProperty({ example: '1234' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  pin_confirm: string;
}

/**
 * Body de POST /auth/change-pin : ancien PIN, nouveau PIN, confirmation.
 * L'ancien PIN sert de preuve d'identité même si la requête est déjà
 * authentifiée par JWT — ceinture + bretelles.
 */
export class ChangePinDto {
  @ApiProperty({ example: '1234' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  old_pin: string;

  @ApiProperty({ example: '5678' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  new_pin: string;

  @ApiProperty({ example: '5678' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  new_pin_confirm: string;
}

/**
 * Body de POST /auth/refresh : le refresh_token brut reçu au login.
 * Le serveur recalcule sa sha256 pour le retrouver en base.
 */
export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token brut reçu lors du login' })
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}
