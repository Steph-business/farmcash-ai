// =====================================================================
//  MODULE : FinanceModule
//  ---------------------------------------------------------------------
//  Wallets + transactions + escrow + payouts + webhooks providers.
//
//  Phase 1.5 — composants nouveaux :
//   • PaymentProvider interface + MockPaymentProvider (Mobile Money fake)
//   • PaymentWebhookController (endpoint /webhooks/payment-provider/:p)
//   • CircuitBreakerService (anti-cascade en cas de provider down)
//
//  Le binding "PAYMENT_PROVIDER_TOKEN" sélectionne l'implémentation
//  selon l'env PAYMENT_PROVIDER (mock|orange|mtn|wave).
// =====================================================================

import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { MockPaymentProvider } from './providers/mock-payment.provider';
import { PaymentWebhookController } from './providers/payment-webhook.controller';
import { CircuitBreakerService } from './providers/circuit-breaker.service';
import { RetryQueueService } from './providers/retry-queue.service';
import { ReconciliationCronService } from './providers/reconciliation-cron.service';
import { PAYMENT_PROVIDER_TOKEN } from './providers/payment-provider.token';

// Re-export pour compat ascendante (anciens imports `import { PAYMENT_PROVIDER_TOKEN }
// from '.../finance.module'`).
export { PAYMENT_PROVIDER_TOKEN } from './providers/payment-provider.token';

@Module({
  controllers: [FinanceController, PaymentWebhookController],
  providers: [
    FinanceService,
    MockPaymentProvider,
    CircuitBreakerService,
    RetryQueueService,
    ReconciliationCronService,
    {
      // Sélection dynamique selon env PAYMENT_PROVIDER.
      // En prod : remplacer par OrangeMoneyProvider, etc.
      provide: PAYMENT_PROVIDER_TOKEN,
      useExisting: MockPaymentProvider,
    },
  ],
  exports: [FinanceService, CircuitBreakerService, RetryQueueService, PAYMENT_PROVIDER_TOKEN],
})
export class FinanceModule {}
