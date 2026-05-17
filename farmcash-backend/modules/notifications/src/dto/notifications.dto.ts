// =====================================================================
//  DTOs : Notifications
//  ---------------------------------------------------------------------
//  Les notifications sont créées en interne par les autres modules
//  (Orders, Finance, Logistics, Marketplace…) via DI. La structure
//  reflète tous les types métier possibles.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export enum NotificationType {
  SYSTEM = 'SYSTEM',
  MESSAGE = 'MESSAGE',
  ORDER = 'ORDER',
  PAYMENT = 'PAYMENT',
  NEGOTIATION = 'NEGOTIATION',
  SHIPMENT = 'SHIPMENT',
  MARKETPLACE = 'MARKETPLACE',
}

/**
 * Body utilisé en INTERNE (via DI) par les autres services pour pousser
 * une notification à un user. Pas exposé via une route HTTP : aucun
 * client ne doit pouvoir créer des notifs arbitraires.
 */
export class CreateNotificationDto {
  @ApiProperty({ example: 'uuid-user-destinataire' })
  @IsUUID()
  @IsNotEmpty()
  user_id: string;

  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({ example: 'Nouvelle commande 📦' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  titre: string;

  @ApiProperty({ example: 'Vous avez reçu une commande...' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 2000)
  body: string;

  // Champs contextuels — tous mergés dans le JSON `data`.
  @ApiPropertyOptional() @IsOptional() @IsUUID() commande_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reservation_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() contre_offre_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() candidature_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shipment_id?: string;

  @ApiPropertyOptional({ example: { key: 'value' } })
  @IsOptional()
  data?: Record<string, unknown>;
}

export class MarkReadDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  is_read: boolean;
}

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({
    description: 'Si true, ne retourne que les non lues',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unread_only?: boolean;
}
