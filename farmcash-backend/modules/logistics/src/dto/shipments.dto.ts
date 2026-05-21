// =====================================================================
//  DTOs : Shipments
//  ---------------------------------------------------------------------
//  Un shipment est créé automatiquement par OrdersService au moment de
//  la commande (avec transporter_id = null). Le buyer ne le crée pas
//  directement. Les actions exposées ici sont :
//   • TRANSPORTER : accepter une mission disponible, déclarer LOADING,
//     IN_TRANSIT, DELIVERED + envoi position GPS.
//   • BUYER : consulter sa livraison + tracking GPS.
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Mirror de l'enum SQL `shipment_status`. Utilisé pour valider les
 * transitions côté DTO.
 */
export enum ShipmentStatus {
  REQUESTED = 'REQUESTED',
  ACCEPTED = 'ACCEPTED',
  LOADING = 'LOADING',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

/**
 * Coordonnées GPS pour le tracking ou la preuve.
 */
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
 * Le TRANSPORTER déclare un point GPS périodique pendant le transit.
 * Optionnel : statut courant (LOADING, IN_TRANSIT) — sinon on garde
 * celui déjà en base.
 */
export class TrackPositionDto {
  @ApiProperty({ type: GpsPointDto })
  @ValidateNested()
  @Type(() => GpsPointDto)
  position: GpsPointDto;

  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

/**
 * Le TRANSPORTER marque la mission livrée. Doit fournir au moins une
 * preuve : photo (URL du média uploadé) ou GPS.
 */
export class MarkDeliveredDto {
  @ApiProperty({ description: 'URL de la photo de livraison (S3/MinIO)' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  photo_preuve_url: string;

  @ApiPropertyOptional({ type: GpsPointDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GpsPointDto)
  delivery_position?: GpsPointDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

/**
 * Le TRANSPORTER passe la mission à LOADING (en train de charger chez
 * le seller). Optionnel : un point GPS pour confirmer la présence.
 */
export class StartLoadingDto {
  @ApiPropertyOptional({ type: GpsPointDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GpsPointDto)
  pickup_position?: GpsPointDto;
}

// =====================================================================
//  DTOs : QR pickup (Chantier 1 — auto-release escrow PRODUCT)
//  ---------------------------------------------------------------------
//  Flow :
//   1. Producteur (FARMER) appelle GET /shipments/:id/qr-token et
//      reçoit un token signé HMAC valable 15 min, à encoder en QR.
//   2. Transporteur scanne le QR depuis son téléphone et appelle
//      POST /shipments/:id/scan-pickup avec le token + sa position GPS.
//      Le serveur valide la signature, l'expiration, la distance GPS
//      (< 500 m), bascule le shipment en LOADING et libère l'escrow
//      PRODUCT (producteur crédité immédiatement).
// =====================================================================

/**
 * Réponse de GET /shipments/:id/qr-token (producteur uniquement).
 * Le client mobile encode `token` dans un QR code (formato PNG/SVG côté UI).
 */
export class PickupQrTokenResponseDto {
  @ApiProperty({ example: 'a1b2c3d4.1737062400.f9e8d7c6b5a4' })
  token: string;

  @ApiProperty({ example: '2026-05-18T14:30:00Z' })
  expires_at: string;

  @ApiProperty({ example: 900 })
  ttl_seconds: number;
}

/**
 * Body de POST /shipments/:id/scan-pickup (transporteur uniquement).
 * Le token vient du QR scanné chez le producteur.
 */
export class ScanPickupDto {
  @ApiProperty({ description: 'Token brut lu depuis le QR' })
  @IsString()
  @IsNotEmpty()
  @Length(20, 120)
  token: string;

  /**
   * Position GPS au moment du scan (anti-fraude : on vérifie que le
   * transporteur est physiquement à < 500 m du pickup_location).
   */
  @ApiProperty({ type: GpsPointDto })
  @ValidateNested()
  @Type(() => GpsPointDto)
  scan_position: GpsPointDto;
}

// =====================================================================
//  DTOs : Évaluation post-livraison (Chantier 3 — lacune 3)
//  ---------------------------------------------------------------------
//  Le BUYER évalue le TRANSPORTER après réception. Un seul avis par
//  buyer/shipment (anti-doublon). Recalcule la moyenne `users.rating`.
// =====================================================================

export class EvaluateShipmentDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  note: number;

  @ApiPropertyOptional({ description: 'Commentaire libre' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  commentaire?: string;
}
