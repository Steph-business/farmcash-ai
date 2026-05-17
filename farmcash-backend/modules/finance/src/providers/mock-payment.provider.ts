// =====================================================================
//  MockPaymentProvider
//  ---------------------------------------------------------------------
//  Simule un provider Mobile Money réaliste :
//   • Délai aléatoire 200–1500ms (réseau Orange/MTN)
//   • Taux d'échec configurable (FINANCE_MOCK_FAIL_RATE, défaut 5%)
//   • Callback webhook asynchrone (setTimeout) — comme en prod
//   • Idempotency : même key → même réponse (cache mémoire)
//
//  ⚠️ Ne JAMAIS l'utiliser en production. Le service refuse de booter si
//  NODE_ENV=production et PAYMENT_PROVIDER=mock.
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  PaymentProvider,
  PaymentRequest,
  PaymentResponse,
  ProviderStatus,
} from './payment-provider.interface';

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockPaymentProvider.name);

  /** Cache idempotency_key → réponse (anti-double-débit). */
  private readonly idempCache = new Map<string, PaymentResponse>();

  /** Cache provider_ref → état (pour getStatus). */
  private readonly stateCache = new Map<string, ProviderStatus>();

  constructor(private readonly config: ConfigService) {
    if (
      this.config.get<string>('NODE_ENV') === 'production' &&
      (this.config.get<string>('PAYMENT_PROVIDER') ?? 'mock') === 'mock'
    ) {
      throw new Error(
        'MockPaymentProvider est interdit en production. Configurez PAYMENT_PROVIDER=orange|mtn|wave.',
      );
    }
  }

  async initiatePayin(req: PaymentRequest): Promise<PaymentResponse> {
    return this.simulate('PAYIN', req);
  }

  async initiatePayout(req: PaymentRequest): Promise<PaymentResponse> {
    return this.simulate('PAYOUT', req);
  }

  async initiateTopup(req: PaymentRequest): Promise<PaymentResponse> {
    // Sémantiquement = PAYIN côté Mobile Money. On utilise le même
    // simulate() avec un kind distinct pour les logs.
    return this.simulate('TOPUP', req);
  }

  async getStatus(providerRef: string): Promise<ProviderStatus> {
    return this.stateCache.get(providerRef) ?? 'PENDING';
  }

  // -------------------------------------------------------------------
  //  Helpers privés
  // -------------------------------------------------------------------

  private async simulate(
    kind: 'PAYIN' | 'PAYOUT' | 'TOPUP',
    req: PaymentRequest,
  ): Promise<PaymentResponse> {
    // Idempotence : même key → même réponse instantanée.
    const cached = this.idempCache.get(req.idempotency_key);
    if (cached) {
      this.logger.log(`[${kind}] idempotency hit ${req.idempotency_key}`);
      return cached;
    }

    // Délai réseau simulé (200–1500ms).
    const delay = 200 + Math.floor(Math.random() * 1300);
    await new Promise((resolve) => setTimeout(resolve, delay));

    const failRate = parseFloat(
      this.config.get<string>('FINANCE_MOCK_FAIL_RATE') ?? '0',
    );
    const fails = Math.random() < failRate;

    const providerRef = `${req.provider}-${randomBytes(8).toString('hex')}`;

    const response: PaymentResponse = fails
      ? {
          provider_ref: providerRef,
          status: 'FAILED',
          message: 'Échec simulé par le provider mock.',
          retryable: true,
        }
      : {
          provider_ref: providerRef,
          status: 'PENDING',
          message: 'Opération en attente — webhook à suivre.',
        };

    this.idempCache.set(req.idempotency_key, response);
    this.stateCache.set(providerRef, response.status);

    // Webhook async : 1–3s plus tard, on appelle webhook_url avec le statut final.
    if (!fails && req.webhook_url) {
      const webhookDelay = 1000 + Math.floor(Math.random() * 2000);
      setTimeout(async () => {
        const finalStatus: ProviderStatus = 'ACCEPTED';
        this.stateCache.set(providerRef, finalStatus);
        try {
          await fetch(req.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: this.name,
              provider_ref: providerRef,
              idempotency_key: req.idempotency_key,
              status: finalStatus,
              amount: req.amount,
              kind,
              timestamp: new Date().toISOString(),
            }),
          });
        } catch (e: any) {
          this.logger.warn(
            `Webhook callback KO (${req.webhook_url}): ${e?.message}`,
          );
        }
      }, webhookDelay);
    }

    this.logger.log(
      `[${kind}] mock provider_ref=${providerRef} status=${response.status} delay=${delay}ms`,
    );
    return response;
  }
}
