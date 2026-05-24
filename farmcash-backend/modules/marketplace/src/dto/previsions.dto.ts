// =====================================================================
//  DTOs : Prévisions de récolte + Réservations
//  ---------------------------------------------------------------------
//  Un fermier déclare ce qu'il prévoit de récolter (table
//  `previsions_production`). Un acheteur peut alors RÉSERVER une part
//  de cette récolte future (table `reservations_previsions`).
//
//  Règles métier (côté service) :
//    • date_recolte_prev doit être dans le FUTUR
//    • quantite_kg réservée ≤ quantité prévue - somme des réservations
//      déjà confirmées
//    • prix_reserve_kg ≥ prix_cible_kg si le fermier en a fixé un
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

export class CreatePrevisionDto {
  @ApiProperty({ example: 'uuid-produit' })
  @IsUUID()
  @IsNotEmpty()
  produit_id: string;

  @ApiPropertyOptional({ example: 'uuid-parcelle' })
  @IsOptional()
  @IsUUID()
  parcelle_id?: string;

  @ApiPropertyOptional({ example: 'Saison des pluies 2026' })
  @IsOptional()
  @IsString()
  @Length(2, 20)
  saison?: string;

  @ApiProperty({ example: 5000 })
  @IsNumber()
  @Min(1)
  quantite_prev_kg: number;

  @ApiPropertyOptional({
    example: '2026-10-15',
    description: 'Date prévue de récolte (doit être dans le futur)',
  })
  @IsOptional()
  @IsDateString()
  date_recolte_prev?: string;

  @ApiPropertyOptional({ example: 1500 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_cible_kg?: number;

  @ApiPropertyOptional({ example: 'Récolte attendue excellente' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;

  /**
   * Si renseigné, la prévision est attribuée à cette coopérative et passe
   * en PENDING (en attente d'inspection). Le farmer ne peut plus la
   * modifier une fois VALIDATED par la coop. La réservation par un
   * acheteur ne sera possible qu'après validation coop.
   */
  @ApiPropertyOptional({
    description: 'UUID de la coop à laquelle confier la prévision',
  })
  @IsOptional()
  @IsUUID()
  assigned_to_cooperative_id?: string;
}

/**
 * Body de PUT /marketplace/previsions/:id — modification par le FARMER
 * propriétaire. Tous les champs sont optionnels (modification partielle).
 *
 * IMPORTANT : si la prévision est déjà `VALIDATED` ou `INCLUDED` côté
 * coopérative, le service refuse la modification (la coop a la main).
 */
export class UpdatePrevisionDto {
  @ApiPropertyOptional({ example: 6000 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantite_prev_kg?: number;

  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @IsDateString()
  date_recolte_prev?: string;

  @ApiPropertyOptional({ example: 1600 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_cible_kg?: number;

  @ApiPropertyOptional({ example: 'Saison des pluies 2026' })
  @IsOptional()
  @IsString()
  @Length(2, 20)
  saison?: string;

  @ApiPropertyOptional({ example: 'Mise à jour suite à inspection' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

export class CreateReservationDto {
  @ApiProperty({ example: 'uuid-prevision' })
  @IsUUID()
  @IsNotEmpty()
  prevision_id: string;

  @ApiProperty({ example: 2000 })
  @IsNumber()
  @Min(1)
  quantite_kg: number;

  @ApiPropertyOptional({ example: 1450 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  prix_reserve_kg?: number;

  /**
   * Moyen de paiement utilisé pour verser l'acompte (10% par défaut,
   * configurable via RESERVATION_DEPOSIT_RATE).
   */
  @ApiProperty({ example: 'uuid-payment-method' })
  @IsUUID()
  payment_method_id: string;
}

/**
 * Body de POST /marketplace/previsions/:id/convert
 * Transforme une prévision en annonce officielle (déclenchée par le
 * producteur ou la coop quand la récolte est prête).
 */
export class ConvertPrevisionDto {
  @ApiProperty({ example: 'Igname Kponan — récolte septembre 2026, lot Bondoukou' })
  @IsString()
  @IsNotEmpty()
  @Length(3, 200)
  titre: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @ApiProperty({
    example: 1500,
    description: 'Prix final au kg (peut être différent du prix cible)',
  })
  @IsNumber()
  @Min(0)
  prix_par_kg: number;

  @ApiProperty({ example: 50 })
  @IsNumber()
  @Min(1)
  quantite_min_kg: number;

  @ApiProperty({ example: 'PREMIUM' })
  @IsString()
  qualite: string;

  @ApiProperty()
  @IsUUID()
  region_id: string;

  @ApiProperty()
  @IsUUID()
  ville_id: string;

  @ApiProperty({ example: { lat: 7.683, lng: -5.0303 } })
  coordinates: { lat: number; lng: number };
}
