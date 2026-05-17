// =====================================================================
//  DTOs : Messaging
//  ---------------------------------------------------------------------
//  Conversations entre acteurs de la plateforme (BUYER↔SELLER notamment,
//  ou groupes COOP↔membres). Les messages peuvent contenir du texte, une
//  image, une vidéo, un document ou un audio.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

export enum ConversationType {
  DIRECT = 'DIRECT',
  GROUP = 'GROUP',
}

export enum MessageMediaType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
}

export class CreateConversationDto {
  @ApiProperty({
    type: [String],
    example: ['uuid1', 'uuid2'],
    description: 'IDs des AUTRES participants (le créateur est ajouté côté serveur)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  participants: string[];

  @ApiPropertyOptional({ example: 'Discussion sur la commande #123' })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  titre?: string;

  @ApiPropertyOptional({ enum: ConversationType, default: ConversationType.DIRECT })
  @IsOptional()
  @IsEnum(ConversationType)
  type?: ConversationType;
}

export class SendMessageDto {
  @ApiProperty({ example: 'Bonjour, est-ce que le produit est disponible ?' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 5000)
  content: string;

  @ApiPropertyOptional({ enum: MessageMediaType })
  @IsOptional()
  @IsEnum(MessageMediaType)
  media_type?: MessageMediaType;

  @ApiPropertyOptional({ example: 'https://cdn.farmcash.ci/media/photo.jpg' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  media_url?: string;
}

export class MarkAsReadDto {
  @ApiProperty({ example: 'uuid-conversation' })
  @IsUUID()
  @IsNotEmpty()
  conversation_id: string;
}

/**
 * Query string pour paginer les messages d'une conversation.
 */
export class ListMessagesQueryDto {
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
