// =====================================================================
//  DTOs : Phone proxy (Chantier 5.a)
//  ---------------------------------------------------------------------
//  Allocation d'un numéro proxy Twilio pour qu'un BUYER puisse appeler
//  un FARMER (ou inversement) sans exposer son vrai téléphone.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateProxyCallDto {
  @ApiProperty({ description: 'User cible (le callee)' })
  @IsUUID()
  callee_user_id: string;

  @ApiPropertyOptional({
    description: 'Commande contexte (obligatoire pour FARMER↔BUYER)',
  })
  @IsOptional()
  @IsUUID()
  commande_id?: string;
}

export class ProxyCallResponseDto {
  @ApiProperty({ example: '+2250123456789' })
  proxy_phone: string;

  @ApiProperty({ example: '2026-06-04T08:00:00.000Z' })
  expires_at: string;

  @ApiProperty({ example: '8d4f5a3b-...' })
  session_id: string;
}

/**
 * Payload simplifié envoyé par Twilio sur le webhook events. On ne
 * valide pas strictement chaque champ (les versions de l'API varient) :
 * on récupère best-effort les infos qu'on persiste.
 */
export class TwilioWebhookDto {
  @ApiPropertyOptional({ description: 'Type d\'événement Twilio' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  EventType?: string;

  @ApiPropertyOptional({ description: 'SID de la session Proxy Twilio' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  SessionSid?: string;

  @ApiPropertyOptional({ description: 'SID de l\'appel' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  CallSid?: string;

  @ApiPropertyOptional({ description: 'Durée de l\'appel en secondes' })
  @IsOptional()
  @IsString()
  CallDuration?: string;

  @ApiPropertyOptional({ description: 'Status final de l\'appel' })
  @IsOptional()
  @IsString()
  CallStatus?: string;
}
