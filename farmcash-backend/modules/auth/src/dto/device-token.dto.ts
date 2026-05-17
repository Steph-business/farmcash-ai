// =====================================================================
//  DTO : DeviceTokenDto
//  ---------------------------------------------------------------------
//  Body de POST /auth/device-token. Reçoit le token FCM (Firebase Cloud
//  Messaging) que l'application mobile génère au démarrage. Ce token
//  permet ensuite au backend d'envoyer des notifications push à
//  l'appareil correspondant.
//
//  L'app mobile renvoie ce token à chaque démarrage (il peut être
//  régénéré par FCM) — c'est pour ça que le service utilise un upsert.
// =====================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export enum DevicePlatform {
  ANDROID = 'android',
  IOS = 'ios',
}

export class DeviceTokenDto {
  @ApiProperty({ description: 'Token Firebase Cloud Messaging' })
  @IsString()
  @IsNotEmpty()
  // MaxLength sert de protection contre l'envoi de données aberrantes
  // (tokens FCM réels font ~150 caractères, jamais 4096).
  @MaxLength(4096)
  fcm_token: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsIn(Object.values(DevicePlatform), { message: 'platform doit être android ou ios' })
  platform: DevicePlatform;
}
