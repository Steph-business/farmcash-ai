// =====================================================================
//  DTOs : Traceability
//  ---------------------------------------------------------------------
//  Événements horodatés du cycle de vie d'un lot. Permet au consommateur
//  final de scanner le QR du produit et de voir toute l'histoire
//  (récolte → coopérative → transport → buyer).
//
//  Le champ `metadata` est libre (JSON) → chaque type d'event peut y
//  mettre ce qui est utile (température, humidité, photo, etc.).
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  ValidateNested,
} from 'class-validator';

/**
 * Types d'événements de traçabilité. Calqué sur les grandes étapes
 * du parcours agricole en CI.
 */
export enum TraceabilityEventType {
  HARVEST = 'HARVEST',                   // récolte par le farmer
  STORAGE = 'STORAGE',                   // entrée en entrepôt
  COOP_AGGREGATED = 'COOP_AGGREGATED',   // intégré à une publication coop
  QUALITY_CHECK = 'QUALITY_CHECK',       // contrôle qualité
  ORDER_PLACED = 'ORDER_PLACED',         // commandé par un buyer
  PICKED_UP = 'PICKED_UP',               // récupéré par le transporter
  IN_TRANSIT = 'IN_TRANSIT',             // en route
  DELIVERED = 'DELIVERED',               // livré chez le buyer
  COMPLETED = 'COMPLETED',               // commande confirmée
  EXPORT_CUSTOMS = 'EXPORT_CUSTOMS',     // passage douane (B2B export)
}

export class GpsPointDto {
  @ApiProperty({ example: 5.345317 })
  @IsLatitude()
  @Type(() => Number)
  lat: number;

  @ApiProperty({ example: -4.024429 })
  @IsLongitude()
  @Type(() => Number)
  lng: number;
}

/**
 * Body utilisé en INTERNE (via DI) par les autres services (Marketplace,
 * Orders, Logistics) pour pousser un event sur la timeline d'un lot.
 * Aucune route HTTP publique ne crée d'events arbitraires.
 */
export class CreateTraceabilityEventDto {
  @ApiProperty({ enum: TraceabilityEventType })
  @IsEnum(TraceabilityEventType)
  event_type: TraceabilityEventType;

  @ApiPropertyOptional({ type: GpsPointDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GpsPointDto)
  location?: GpsPointDto;

  @ApiPropertyOptional({
    description: 'Métadonnées libres (température, humidité, photo, etc.)',
    example: { temperature_c: 22, photo_url: 'https://...' },
  })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
