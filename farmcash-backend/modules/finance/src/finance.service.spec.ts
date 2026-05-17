// =====================================================================
//  UNIT : FinanceService.topupWallet / confirmTopup / handleProviderWebhook
//  (Chantier 4)
//  ---------------------------------------------------------------------
//  Couvre :
//   1. topupWallet crée une TX TOPUP PENDING
//   2. topupWallet idempotent (même clé → même TX)
//   3. topupWallet idempotency_key détournée (autre user) → 409
//   4. confirmTopup crédite + passe à SUCCESS
//   5. confirmTopup idempotent (2e appel → no-op)
//   6. handleProviderWebhook route TOPUP → confirmTopup
//
//  Tous les accès DB sont stubés via Jest mocks de PrismaService.
//  Le PaymentProvider est aussi mocké pour piloter la réponse provider.
// =====================================================================

import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FinanceService } from './finance.service';
import { TransactionType } from './dto/finance.dto';

// -------------------------------------------------------------------
//  Helpers de stub
// -------------------------------------------------------------------

function decimal(value: number | string): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/**
 * Stub PrismaService — uniquement ce que topupWallet/confirmTopup/
 * handleProviderWebhook touchent. On utilise des jest.fn() pour piloter
 * chaque appel et vérifier les arguments.
 */
function createPrismaStub() {
  const wallets = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const transactions = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const moyen_de_payement = {
    findFirst: jest.fn(),
  };
  const notifications = {
    create: jest.fn().mockResolvedValue({}),
  };
  // $transaction(fn) → exécute fn avec le même stub (proxy interne).
  // Suffisant car confirmTopup utilise le client transactionnel comme
  // un Prisma normal — pas de différentiel sémantique pour ces tests.
  const $transaction = jest.fn(async (cb: any) => {
    // Le callback reçoit le client transactionnel. On lui passe le même
    // stub pour que les sub-methods soient mockables.
    return cb(prismaStub);
  });
  // Pour lockWallet (raw SELECT FOR UPDATE) — on retourne le wallet courant.
  const $queryRaw = jest.fn();
  const prismaStub: any = {
    wallets,
    transactions,
    moyen_de_payement,
    notifications,
    $transaction,
    $queryRaw,
  };
  return prismaStub;
}

function createConfigStub() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'SERVICE_FEE_PRODUCT') return '0.03';
      if (key === 'SERVICE_FEE_TRANSPORT') return '0.03';
      if (key === 'PAYMENT_WEBHOOK_BASE_URL') return 'http://localhost:3000/api';
      return undefined;
    }),
  };
}

/** Mock du PaymentProvider — par défaut PENDING (webhook async). */
function createProviderStub(status: string = 'PENDING') {
  return {
    name: 'mock',
    initiatePayin: jest.fn(),
    initiatePayout: jest.fn(),
    initiateTopup: jest.fn().mockResolvedValue({
      provider_ref: 'MOCK-REF-123',
      status,
      message: `mock ${status}`,
    }),
    getStatus: jest.fn(),
  };
}

describe('FinanceService — Chantier 4 (topup)', () => {
  let service: FinanceService;
  let prisma: any;
  let config: any;
  let provider: any;

  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const MOYEN_ID = '22222222-2222-2222-2222-222222222222';
  const IDEM_KEY = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    prisma = createPrismaStub();
    config = createConfigStub();
    provider = createProviderStub('PENDING');
    service = new FinanceService(prisma, config, provider);
  });

  // ===================================================================
  //  topupWallet
  // ===================================================================

  describe('topupWallet', () => {
    it('1. crée une transaction TOPUP en status PENDING', async () => {
      // Pas de TX existante avec cette clé
      prisma.transactions.findFirst.mockResolvedValue(null);
      prisma.moyen_de_payement.findFirst.mockResolvedValue({
        id: MOYEN_ID,
        user_id: USER_ID,
        is_active: true,
        provider: 'MTN_MOMO',
        phone_display: '+2250709123456',
      });
      // getOrCreateWallet → findUnique d'abord, wallet existe
      prisma.wallets.findUnique.mockResolvedValue({
        id: 'wallet-1',
        user_id: USER_ID,
        balance: decimal(0),
        balance_escrow: decimal(0),
        is_frozen: false,
      });
      const createdTx = {
        id: 'tx-new',
        user_id: USER_ID,
        type: TransactionType.TOPUP,
        montant: decimal(50000),
        status: 'PENDING',
        idempotency_key: IDEM_KEY,
      };
      prisma.transactions.create.mockResolvedValue(createdTx);
      prisma.transactions.update.mockResolvedValue(createdTx);

      const result = await service.topupWallet(USER_ID, {
        amount: 50000,
        payment_method_id: MOYEN_ID,
        idempotency_key: IDEM_KEY,
      });

      expect(prisma.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: USER_ID,
            type: TransactionType.TOPUP,
            status: 'PENDING',
            idempotency_key: IDEM_KEY,
            montant: 50000,
          }),
        }),
      );
      expect(provider.initiateTopup).toHaveBeenCalledTimes(1);
      // Provider mock PENDING → service renvoie PENDING (webhook attendu)
      expect(result.status).toBe('PENDING');
      expect(result.transaction_id).toBe('tx-new');
    });

    it('2. idempotent : 2e appel avec même idempotency_key → renvoie la TX existante', async () => {
      const existingTx = {
        id: 'tx-existing',
        user_id: USER_ID,
        type: TransactionType.TOPUP,
        status: 'PENDING',
        provider_ref: 'EXIST-REF',
        idempotency_key: IDEM_KEY,
      };
      prisma.transactions.findFirst.mockResolvedValue(existingTx);

      const result = await service.topupWallet(USER_ID, {
        amount: 50000,
        payment_method_id: MOYEN_ID,
        idempotency_key: IDEM_KEY,
      });

      expect(result.transaction_id).toBe('tx-existing');
      expect(result.status).toBe('PENDING');
      expect(result.provider_ref).toBe('EXIST-REF');
      // Aucune TX recréée, aucun provider appelé.
      expect(prisma.transactions.create).not.toHaveBeenCalled();
      expect(provider.initiateTopup).not.toHaveBeenCalled();
    });

    it('3. rejette (409) si même idempotency_key utilisée par un autre user', async () => {
      const otherUserTx = {
        id: 'tx-other',
        user_id: 'OTHER-USER-ID',
        status: 'PENDING',
        idempotency_key: IDEM_KEY,
      };
      prisma.transactions.findFirst.mockResolvedValue(otherUserTx);

      await expect(
        service.topupWallet(USER_ID, {
          amount: 50000,
          payment_method_id: MOYEN_ID,
          idempotency_key: IDEM_KEY,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ===================================================================
  //  confirmTopup
  // ===================================================================

  describe('confirmTopup', () => {
    const TX_ID = 'tx-pending-1';

    /**
     * Configure prisma pour qu'un confirmTopup réussisse :
     *  - findUnique(transactions) → TX PENDING TOPUP
     *  - $queryRaw (lockWallet) → wallet existe
     *  - update(wallets), update(transactions), create(notifications) OK
     */
    function setupSuccessfulConfirm(initialBalance: number = 0) {
      const tx = {
        id: TX_ID,
        user_id: USER_ID,
        type: TransactionType.TOPUP,
        status: 'PENDING',
        montant: decimal(50000),
        provider_ref: null,
      };
      prisma.transactions.findUnique.mockResolvedValue(tx);
      // lockWallet appelle $queryRaw 2x : SELECT FOR UPDATE.
      // Si wallet existe (1 row), pas de create + 1 seul $queryRaw.
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'wallet-1',
          user_id: USER_ID,
          balance: decimal(initialBalance),
          balance_escrow: decimal(0),
          is_frozen: false,
        },
      ]);
      prisma.wallets.update.mockResolvedValue({});
      prisma.transactions.update.mockResolvedValue({
        ...tx,
        status: 'SUCCESS',
      });
      return tx;
    }

    it('4. crédite le wallet et passe la TX en SUCCESS', async () => {
      setupSuccessfulConfirm(0);

      const result = await service.confirmTopup(TX_ID, 'PROVIDER-REF-XYZ');

      // Wallet crédité de 50 000 (balance: 0 → 50 000)
      expect(prisma.wallets.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'wallet-1' },
          data: expect.objectContaining({ balance: expect.anything() }),
        }),
      );
      const walletCall = prisma.wallets.update.mock.calls[0][0];
      expect(walletCall.data.balance.toString()).toBe('50000');

      // TX update : status SUCCESS + provider_ref + provider_status ACCEPTED
      expect(prisma.transactions.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TX_ID },
          data: expect.objectContaining({
            status: 'SUCCESS',
            provider_ref: 'PROVIDER-REF-XYZ',
            provider_status: 'ACCEPTED',
          }),
        }),
      );

      expect(result.status).toBe('SUCCESS');
      expect(result.new_balance).toBe(50000);
    });

    it('5. idempotent : 2e appel avec une TX déjà SUCCESS ne re-crédite pas', async () => {
      // TX déjà SUCCESS
      prisma.transactions.findUnique.mockResolvedValue({
        id: TX_ID,
        user_id: USER_ID,
        type: TransactionType.TOPUP,
        status: 'SUCCESS',
        montant: decimal(50000),
        provider_ref: 'OLD-REF',
      });
      prisma.wallets.findUnique.mockResolvedValue({
        id: 'wallet-1',
        balance: decimal(50000),
      });

      const result = await service.confirmTopup(TX_ID, 'NEW-REF');

      // Aucun nouveau crédit
      expect(prisma.wallets.update).not.toHaveBeenCalled();
      expect(prisma.transactions.update).not.toHaveBeenCalled();
      expect(result.status).toBe('SUCCESS');
      expect(result.new_balance).toBe(50000);
    });
  });

  // ===================================================================
  //  handleProviderWebhook routing
  // ===================================================================

  describe('handleProviderWebhook', () => {
    it('6. type=TOPUP + status=ACCEPTED → délègue à confirmTopup', async () => {
      const TX_ID = 'tx-topup-pending';
      // Le webhook commence par chercher la TX via idempotency_key
      prisma.transactions.findFirst.mockResolvedValue({
        id: TX_ID,
        user_id: USER_ID,
        type: TransactionType.TOPUP,
        status: 'PENDING',
        montant: decimal(10000),
        idempotency_key: IDEM_KEY,
      });
      // Espion confirmTopup pour vérifier qu'il est bien appelé.
      const spy = jest
        .spyOn(service, 'confirmTopup')
        .mockResolvedValue({
          transaction_id: TX_ID,
          status: 'SUCCESS',
          provider_ref: 'WEBHOOK-REF',
          new_balance: 10000,
        });

      const res = await service.handleProviderWebhook('mock', {
        provider_ref: 'WEBHOOK-REF',
        idempotency_key: IDEM_KEY,
        status: 'ACCEPTED',
        kind: 'TOPUP',
      });

      expect(spy).toHaveBeenCalledWith(TX_ID, 'WEBHOOK-REF');
      expect(res).toEqual(
        expect.objectContaining({
          received: true,
          applied: true,
          action: 'TOPUP_CONFIRMED',
        }),
      );
    });
  });
});
