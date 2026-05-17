// =====================================================================
//  DTOs : Finance (Wallets, Escrow, Mobile Money)
//  ---------------------------------------------------------------------
//  Règles d'or :
//   • Le client n'envoie JAMAIS `amount` quand un montant peut être
//     lu côté serveur (ex. payin → on relit `commande.montant_total`).
//   • Le client n'envoie JAMAIS `phone_number` brut : il sélectionne
//     un `payment_method_id` (table moyen_de_payement) vérifié serveur.
//   • Tous les `provider` sont restreints à l'enum SQL `mobile_provider`.
//
//  Note sur les 2 escrows :
//   Chaque commande génère 2 lignes dans `escrow_conditions` :
//     • kind = PRODUCT   → bénéficiaire = seller, frais = SERVICE_FEE_PRODUCT
//     • kind = TRANSPORT → bénéficiaire = transporter (renseigné à
//       l'acceptation de la mission), frais = SERVICE_FEE_TRANSPORT
// =====================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export enum MobileProvider {
  ORANGE_MONEY = 'ORANGE_MONEY',
  MTN_MOMO = 'MTN_MOMO',
  WAVE = 'WAVE',
  MOOV = 'MOOV',
  VIREMENT = 'VIREMENT',
  WALLET = 'WALLET',
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  ESCROW = 'ESCROW',
  ESCROW_RELEASED = 'ESCROW_RELEASED',
  REFUNDED = 'REFUNDED',
}

export enum TransactionType {
  PAYIN = 'PAYIN',
  RELEASE = 'RELEASE',
  PAYOUT = 'PAYOUT',
  REFUND = 'REFUND',
  FEE = 'FEE',
  TOPUP = 'TOPUP',
}

export enum EscrowKind {
  PRODUCT = 'PRODUCT',
  TRANSPORT = 'TRANSPORT',
}

// ===================================================================
//  PAYIN (interne — appelé par OrdersService)
// ===================================================================
// Le service lit les montants depuis la DB (commande + shipment) et
// calcule les escrows. Le payload ici est minimal.

export interface PayinPayload {
  commande_id: string;
  buyer_id: string;
  payment_method_id: string;
  /** Optionnel : si la commande provient d'une réservation, on déduit
   *  l'acompte 10% déjà payé du débit Mobile Money. */
  from_reservation_id?: string;
}

// ===================================================================
//  CONFIRM DELIVERY
// ===================================================================

export class ConfirmDeliveryDto {
  @ApiProperty({ example: 'uuid-commande' })
  @IsUUID()
  @IsNotEmpty()
  commande_id: string;
}

// ===================================================================
//  PAYOUT
// ===================================================================

export class PayoutDto {
  @ApiProperty({ example: 50000 })
  @IsNumber()
  @Min(100)
  amount: number;

  @ApiProperty({ description: 'ID du moyen de paiement (vérifié serveur)' })
  @IsUUID()
  @IsNotEmpty()
  payment_method_id: string;
}

// ===================================================================
//  MOYENS DE PAIEMENT
// ===================================================================

export class CreateMoyenPayementDto {
  @ApiProperty({ enum: MobileProvider })
  @IsEnum(MobileProvider)
  provider: MobileProvider;

  @ApiProperty({ example: '+2250709123456' })
  @IsNotEmpty()
  phone_display: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}

export class UpdateMoyenPayementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

// ===================================================================
//  PAYOUT BATCH (COOPERATIVE → membres)
// ===================================================================

export class PayoutBatchItemDto {
  @ApiProperty({ example: 'uuid-user-beneficiaire' })
  @IsUUID()
  @IsNotEmpty()
  user_id: string;

  @ApiProperty({ example: 50000 })
  @IsNumber()
  @Min(100)
  amount: number;

  @ApiPropertyOptional({ example: 'uuid-commande' })
  @IsOptional()
  @IsUUID()
  commande_id?: string;
}

export class CreatePayoutBatchDto {
  @ApiProperty({ type: [PayoutBatchItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PayoutBatchItemDto)
  items: PayoutBatchItemDto[];
}

// ===================================================================
//  RELEASE ESCROW (ADMIN — override)
// ===================================================================

export class ReleaseEscrowDto {
  @ApiProperty({ example: 'uuid-commande' })
  @IsUUID()
  @IsNotEmpty()
  commande_id: string;

  @ApiPropertyOptional({ enum: EscrowKind, description: 'Si omis : tous les escrows LOCKED de la commande' })
  @IsOptional()
  @IsEnum(EscrowKind)
  kind?: EscrowKind;

  @ApiPropertyOptional()
  @IsOptional()
  reason?: string;
}

// ===================================================================
//  LISTING : transactions paginées
// ===================================================================

export class ListerTransactionsQueryDto {
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

  @ApiPropertyOptional({ enum: TransactionType })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;
}

// ===================================================================
//  TOPUP — recharger son wallet via Mobile Money
//  ---------------------------------------------------------------------
//  Le BUYER (ou tout autre rôle ayant un wallet) charge son solde
//  avant de payer une commande. Le flow est asynchrone :
//    1. POST /finance/wallet/topup → transaction PENDING + appel provider
//    2. Provider répond ACCEPTED (synchrone mock) ou PENDING (vrai)
//    3. Si PENDING, le webhook /webhooks/payment-provider/:p arrive
//       plus tard et bascule la TX à SUCCESS via confirmTopup().
//
//  Idempotence : la clé `idempotency_key` (UUID v4 client) est unique
//  partielle en base. Une retry réseau retourne la même TX sans
//  recréditer le wallet.
// ===================================================================

export class TopupWalletDto {
  /** Montant à recharger en XOF. Min 500, max 1 000 000 (limite Mobile Money). */
  @ApiProperty({ example: 25000, description: 'Montant en XOF (500 ≤ x ≤ 1 000 000)' })
  @IsInt()
  @Min(500)
  @Max(1_000_000)
  amount: number;

  @ApiProperty({ description: 'ID du moyen de paiement (vérifié serveur)' })
  @IsUUID()
  @IsNotEmpty()
  payment_method_id: string;

  /**
   * Clé d'idempotence générée côté client (UUID v4).
   * Garantit qu'une retry réseau ne crée pas un 2e crédit.
   */
  @ApiProperty({
    description: 'UUID v4 pour idempotence (anti-double-crédit)',
    example: '00000000-0000-4000-8000-000000000000',
  })
  @IsUUID()
  @IsNotEmpty()
  idempotency_key: string;
}

export class TopupWalletResponseDto {
  @ApiProperty({ description: 'ID de la transaction TOPUP créée' })
  transaction_id: string;

  @ApiProperty({
    enum: ['PENDING', 'SUCCESS', 'FAILED'],
    description: 'PENDING = webhook attendu, SUCCESS = crédité, FAILED = refus provider',
  })
  status: string;

  @ApiProperty({ description: 'Référence provider (utile pour réconciliation)' })
  provider_ref: string;

  @ApiPropertyOptional({
    description: 'Solde wallet après recharge (présent uniquement si SUCCESS immédiat)',
  })
  new_balance?: number;
}
