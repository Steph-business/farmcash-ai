// =====================================================================
//  Interface : PaymentProvider
//  ---------------------------------------------------------------------
//  Contrat unique que toute implémentation Mobile Money doit respecter.
//  En dev : MockPaymentProvider (délais simulés + succès auto).
//  En prod : OrangeMoneyProvider / MTNMoMoProvider / WaveProvider
//            (à brancher quand on aura les credentials marchands).
//
//  Toutes les implémentations doivent :
//   • Retourner une référence provider (provider_ref) unique
//   • Être idempotentes (même idempotency_key → même résultat)
//   • Ne PAS muter de wallet directement — c'est FinanceService qui
//     applique les effets selon le webhook reçu
//   • Faire émerger les vrais statuts provider (PENDING, FAILED, etc.)
// =====================================================================

import type { mobile_provider } from '@prisma/client';

export type ProviderStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'FAILED'
  | 'TIMEOUT';

export interface PaymentRequest {
  /** Clé d'idempotence — si re-envoyée, le provider doit retourner
   *  le même résultat sans nouveau débit. */
  idempotency_key: string;
  amount: number;
  phone: string;
  provider: mobile_provider;
  description?: string;
  /** URL à appeler quand le statut change (POST). */
  webhook_url: string;
}

export interface PaymentResponse {
  /** Référence unique du provider — sera stockée en transaction.provider_ref */
  provider_ref: string;
  status: ProviderStatus;
  message?: string;
  /** Si TIMEOUT/FAILED, le caller peut décider de retry. */
  retryable?: boolean;
}

export interface PaymentProvider {
  readonly name: string;

  /** Initie un paiement entrant (PAYIN) : le buyer paye via Mobile Money. */
  initiatePayin(req: PaymentRequest): Promise<PaymentResponse>;

  /** Initie un retrait (PAYOUT) : on transfère du wallet vers Mobile Money. */
  initiatePayout(req: PaymentRequest): Promise<PaymentResponse>;

  /**
   * Initie une recharge wallet (TOPUP) : le user créditer son wallet
   * FarmCash via Mobile Money. Sémantiquement identique au PAYIN mais
   * sans commande associée (pas d'escrow, crédit direct).
   */
  initiateTopup(req: PaymentRequest): Promise<PaymentResponse>;

  /** Statut courant d'une opération (polling de secours si webhook KO). */
  getStatus(provider_ref: string): Promise<ProviderStatus>;
}
