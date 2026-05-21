// =====================================================================
//  DTOs : Commandes (Orders)
//  ---------------------------------------------------------------------
//  Une commande peut provenir de 4 sources distinctes. Pour chaque
//  source, la "preuve" d'antériorité diffère :
//
//   • DIRECT_ANNONCE_VENTE  → annonces_vente_id     (achat direct)
//   • CANDIDATURE_ACCEPTED  → candidature_id        (offre acceptée par seller)
//   • PROPOSITION_ACCEPTED  → proposition_id        (réponse acceptée par buyer)
//   • RESERVATION_CONFIRMED → reservation_id        (acompte 20% sur prévision)
//   • CONTRE_OFFRE_ACCEPTED → contre_offre_id       (offre coop acceptée)
//
//  Le service vérifie côté serveur que la "preuve" est bien ACCEPTED /
//  CONFIRMED ET appartient à l'utilisateur. Le buyer ne peut donc PAS
//  forcer la création d'une commande sans qu'une négociation valide
//  l'ait précédée (sauf l'achat direct).
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

/** Source d'origine d'une commande, alignée sur les flux métier. */
export enum OrderSourceType {
  DIRECT_ANNONCE_VENTE = 'DIRECT_ANNONCE_VENTE',
  CANDIDATURE_ACCEPTED = 'CANDIDATURE_ACCEPTED',
  PROPOSITION_ACCEPTED = 'PROPOSITION_ACCEPTED',
  RESERVATION_CONFIRMED = 'RESERVATION_CONFIRMED',
  CONTRE_OFFRE_ACCEPTED = 'CONTRE_OFFRE_ACCEPTED',
}

/** Mirror de l'enum SQL `order_status`. */
export enum OrderStatus {
  SENT = 'SENT',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  IN_PROGRESS = 'IN_PROGRESS',
  DELIVERED = 'DELIVERED',
  COMPLETED = 'COMPLETED',
  DISPUTED = 'DISPUTED',
  CANCELLED = 'CANCELLED',
}

export class CreateOrderDto {
  @ApiProperty({ enum: OrderSourceType })
  @IsEnum(OrderSourceType)
  source_type: OrderSourceType;

  // Une seule des références ci-dessous doit être présente, selon source_type.
  @ApiPropertyOptional({ description: 'Requis si source_type = DIRECT_ANNONCE_VENTE' })
  @IsOptional()
  @IsUUID()
  annonce_vente_id?: string;

  @ApiPropertyOptional({ description: 'Requis si source_type = CANDIDATURE_ACCEPTED' })
  @IsOptional()
  @IsUUID()
  candidature_id?: string;

  @ApiPropertyOptional({ description: 'Requis si source_type = PROPOSITION_ACCEPTED' })
  @IsOptional()
  @IsUUID()
  proposition_id?: string;

  @ApiPropertyOptional({ description: 'Requis si source_type = RESERVATION_CONFIRMED' })
  @IsOptional()
  @IsUUID()
  reservation_id?: string;

  @ApiPropertyOptional({ description: 'Requis si source_type = CONTRE_OFFRE_ACCEPTED' })
  @IsOptional()
  @IsUUID()
  contre_offre_id?: string;

  @ApiProperty({ example: 100, description: 'Quantité (en kg) — toujours en kg' })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiPropertyOptional({
    description:
      'ID du moyen de paiement (table moyen_de_payement) à utiliser. Si omis : le moyen marqué is_default du buyer.',
  })
  @IsOptional()
  @IsUUID()
  payment_method_id?: string;

  // ─── Transport ────────────────────────────────────────────────────
  // Si transporter_route_id est fourni, le système crée un shipment et
  // calcule le tarif transport à partir de la route choisie (voir
  // /logistics/quotes pour lister les routes disponibles).
  // Si omis : commande sans transport (pickup at warehouse).

  @ApiPropertyOptional({
    description: 'ID de la route transporteur choisie (cf. GET /logistics/quotes).',
  })
  @IsOptional()
  @IsUUID()
  transporter_route_id?: string;

  @ApiPropertyOptional({ description: "Adresse de retrait (déduite de l'annonce si vide)" })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  pickup_address?: string;

  @ApiPropertyOptional({ description: 'Adresse de livraison (requise si transport)' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  delivery_address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;

  // Note : `prix_total` est volontairement absent. Le serveur le calcule
  // à partir de la source de référence (annonce/candidature/etc.).
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

// ===================================================================
//  PAY ORDER (Chantier 4 — paiement d'une commande déjà créée)
//  ---------------------------------------------------------------------
//  Typiquement utilisé après acceptation d'une candidature/proposition :
//  la négociation crée la commande en SENT, le buyer déclenche ensuite
//  le payin via cette route. Distinct de POST /orders qui combine
//  création + paiement (achat direct).
// ===================================================================

export class PayOrderDto {
  @ApiPropertyOptional({
    description:
      "ID du moyen de paiement à utiliser. Si omis : le moyen marqué is_default du buyer.",
  })
  @IsOptional()
  @IsUUID()
  payment_method_id?: string;
}

export class ListerOrdersQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({
    enum: ['buyer', 'seller'],
    description: "Filtre côté : 'buyer' (mes achats) ou 'seller' (mes ventes). Sinon : les deux.",
  })
  @IsOptional()
  @IsEnum(['buyer', 'seller'] as any)
  side?: 'buyer' | 'seller';
}

// ===================================================================
//  DISPUTES
// ===================================================================

export class OpenDisputeDto {
  @ApiProperty({ example: 'uuid-commande' })
  @IsUUID()
  @IsNotEmpty()
  commande_id: string;

  @ApiProperty({ example: 'Marchandise non conforme à la description' })
  @IsString()
  @Length(10, 2000)
  raison: string;

  @ApiPropertyOptional({
    type: [String],
    description: "URLs des photos/documents en preuve",
  })
  @IsOptional()
  preuves_urls?: string[];
}

export class ResolveDisputeDto {
  @ApiProperty({ example: 'REFUND_BUYER', enum: ['REFUND_BUYER', 'PAY_SELLER', 'PARTIAL_REFUND'] })
  @IsEnum(['REFUND_BUYER', 'PAY_SELLER', 'PARTIAL_REFUND'] as any)
  resolution: string;

  /**
   * Fraction reversée au buyer en cas de PARTIAL_REFUND (0–1).
   * Ex: 0.30 → 30% au buyer, 70% au seller (minus frais).
   * Requis si resolution = PARTIAL_REFUND ; ignoré sinon.
   */
  @ApiPropertyOptional({
    example: 0.3,
    description: 'Fraction au buyer si PARTIAL_REFUND (0–1)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  buyer_pct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}
