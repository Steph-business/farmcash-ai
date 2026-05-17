// =====================================================================
//  DTOs : Assistant IA conversationnel
//  ---------------------------------------------------------------------
//  L'assistant exploite les tables `conversations` (avec is_ai_session
//  = true) et `messages` (role = 'user' | 'assistant') déjà existantes
//  dans le schéma. Une seule session active par user à la fois pour
//  simplifier le MVP.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class ChatMessageDto {
  @ApiProperty({
    example: 'Je veux vendre 200 kg de maïs à 350 FCFA le kg',
    description: 'Message de l\'utilisateur (texte). La voix devra être transcrite côté client avant envoi.',
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 2000)
  message: string;

  @ApiPropertyOptional({
    description:
      "ID de la conversation IA existante. Si omis, on continue la session AI courante ou on en crée une nouvelle.",
  })
  @IsOptional()
  @IsUUID()
  conversation_id?: string;
}

export class ListAiHistoryQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 30, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;
}
