// =====================================================================
//  E2E : Chantier 4 — Wallet topup (recharger via Mobile Money)
//  ---------------------------------------------------------------------
//  Couvre :
//   1. Happy path : POST /finance/wallet/topup avec 50 000 F
//      → status PENDING (provider mock répond PENDING + webhook async)
//      → simulate webhook → poll GET /finance/wallet/topup/:id → SUCCESS
//      → vérifie le solde wallet via GET /finance/wallet
//   2. Idempotence : 2 POST consécutifs avec même idempotency_key
//      → 1 seule TX créée, le 2e renvoie la même transaction_id.
//
//  Note : on appelle directement FinanceService.handleProviderWebhook
//  via le port HTTP exposé en /api/webhooks/payment-provider/:provider
//  pour simuler le callback. Si la signature webhook est gardée, on
//  utilise un appel direct au service via app.get(FinanceService).
// =====================================================================

import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  addPaymentMethod,
  bearer,
  cleanupTestUsers,
  createTestApp,
  registerAndGetToken,
} from './setup';
import { FinanceService } from '@farmcash/finance';

describe('Wallet Topup (E2E)', () => {
  let app: INestApplication;
  let finance: FinanceService;

  beforeAll(async () => {
    app = await createTestApp();
    await cleanupTestUsers(app);
    finance = app.get(FinanceService);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  // ===================================================================
  //  1. Happy path
  // ===================================================================

  it('1. Happy path : topup 50 000 → PENDING → webhook → SUCCESS + balance +50 000', async () => {
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Topup Happy',
      role: 'BUYER',
    });
    const moyenId = await addPaymentMethod(app, buyer.userId, 'MTN_MOMO');
    const idempKey = randomUUID();

    // POST /finance/wallet/topup
    const initRes = await request(app.getHttpServer())
      .post('/api/finance/wallet/topup')
      .set(bearer(buyer.token))
      .send({
        amount: 50000,
        payment_method_id: moyenId,
        idempotency_key: idempKey,
      })
      .expect(200);

    const txId = initRes.body.data.transaction_id;
    expect(txId).toBeDefined();
    // Le mock provider répond PENDING → status renvoyé = PENDING
    expect(initRes.body.data.status).toBe('PENDING');
    const providerRef = initRes.body.data.provider_ref;
    expect(providerRef).toBeDefined();

    // Simule le webhook ACCEPTED via appel direct au service
    // (le MockPaymentProvider envoie un vrai webhook async setTimeout 1-3s,
    //  mais pour garder le test rapide et déterministe on appelle l'API
    //  directement avec le payload qu'il enverrait).
    await finance.handleProviderWebhook('mock', {
      provider_ref: providerRef,
      idempotency_key: idempKey,
      status: 'ACCEPTED',
      kind: 'TOPUP',
    });

    // Poll GET /finance/wallet/topup/:id → SUCCESS
    const pollRes = await request(app.getHttpServer())
      .get(`/api/finance/wallet/topup/${txId}`)
      .set(bearer(buyer.token))
      .expect(200);
    expect(pollRes.body.data.status).toBe('SUCCESS');

    // Vérifie le solde wallet : balance créditée de 50 000
    const walletRes = await request(app.getHttpServer())
      .get('/api/finance/wallet')
      .set(bearer(buyer.token))
      .expect(200);
    expect(Number(walletRes.body.data.wallet.balance)).toBe(50000);
  });

  // ===================================================================
  //  2. Idempotence
  // ===================================================================

  it('2. Idempotence : 2 POST avec même idempotency_key → 1 seule TX', async () => {
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Topup Idem',
      role: 'BUYER',
    });
    const moyenId = await addPaymentMethod(app, buyer.userId, 'MTN_MOMO');
    const idempKey = randomUUID();
    const payload = {
      amount: 10000,
      payment_method_id: moyenId,
      idempotency_key: idempKey,
    };

    const first = await request(app.getHttpServer())
      .post('/api/finance/wallet/topup')
      .set(bearer(buyer.token))
      .send(payload)
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/api/finance/wallet/topup')
      .set(bearer(buyer.token))
      .send(payload)
      .expect(200);

    // Même transaction_id → 1 seule TX en base
    expect(second.body.data.transaction_id).toBe(
      first.body.data.transaction_id,
    );
  });
});
