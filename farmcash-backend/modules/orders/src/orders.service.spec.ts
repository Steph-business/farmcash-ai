// =====================================================================
//  UNIT : OrdersService — payOrder (Chantier 4 / Chantier 5)
//  ---------------------------------------------------------------------
//  Couvre :
//   1. payOrder refuse une commande déjà payée (escrow LOCKED existant)
//   2. payOrder refuse une commande dans un autre statut que SENT
//   3. payOrder refuse si l'appelant n'est pas le buyer
//   4. payOrder délègue à finance.processPayin en cas de validation OK
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@farmcash/database';
import { FinanceService } from '@farmcash/finance';
import { NotificationsService } from '@farmcash/notifications';
import { OrdersService } from './orders.service';

function buildPrismaMock() {
  return {
    commandes_vente: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    escrow_conditions: {
      findFirst: jest.fn(),
    },
    moyen_de_payement: {
      findFirst: jest.fn(),
    },
  } as any;
}

function buildFinanceMock(): FinanceService {
  return {
    processPayin: jest.fn().mockResolvedValue({}),
    refundBuyer: jest.fn(),
    releaseEscrow: jest.fn(),
    partialRefund: jest.fn(),
    consumeReservationDeposit: jest.fn(),
  } as any;
}

function buildNotifsMock(): NotificationsService {
  return { create: jest.fn().mockResolvedValue({}) } as any;
}

function buildConfigMock(): ConfigService {
  return { get: jest.fn() } as any;
}

describe('OrdersService — payOrder (Chantier 4)', () => {
  const ORDER_ID = '11111111-1111-1111-1111-111111111111';
  const BUYER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const PAY_METHOD_ID = '22222222-2222-2222-2222-222222222222';

  let prisma: any;
  let finance: FinanceService;
  let notifs: NotificationsService;
  let config: ConfigService;
  let service: OrdersService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    finance = buildFinanceMock();
    notifs = buildNotifsMock();
    config = buildConfigMock();
    service = new OrdersService(
      prisma as unknown as PrismaService,
      finance,
      notifs,
      config,
    );
  });

  it('1. refuse si la commande est déjà payée (escrow LOCKED existant)', async () => {
    prisma.commandes_vente.findUnique.mockResolvedValue({
      id: ORDER_ID,
      buyer_id: BUYER_ID,
      status: 'SENT',
      reference: 'ORD-1',
    });
    // escrow LOCKED existant = double-paiement détecté
    prisma.escrow_conditions.findFirst.mockResolvedValue({ id: 'escrow-lock' });

    await expect(
      service.payOrder(BUYER_ID, ORDER_ID, { payment_method_id: PAY_METHOD_ID }),
    ).rejects.toThrow(ConflictException);

    expect(finance.processPayin).not.toHaveBeenCalled();
  });

  it('2. refuse si la commande n\'est pas en SENT', async () => {
    prisma.commandes_vente.findUnique.mockResolvedValue({
      id: ORDER_ID,
      buyer_id: BUYER_ID,
      status: 'ACCEPTED',
      reference: 'ORD-2',
    });

    await expect(
      service.payOrder(BUYER_ID, ORDER_ID, { payment_method_id: PAY_METHOD_ID }),
    ).rejects.toThrow(BadRequestException);

    expect(finance.processPayin).not.toHaveBeenCalled();
  });

  it('3. refuse si l\'appelant n\'est pas le buyer (ownership)', async () => {
    prisma.commandes_vente.findUnique.mockResolvedValue({
      id: ORDER_ID,
      buyer_id: BUYER_ID,
      status: 'SENT',
      reference: 'ORD-3',
    });

    await expect(
      service.payOrder(OTHER_USER, ORDER_ID, { payment_method_id: PAY_METHOD_ID }),
    ).rejects.toThrow(ForbiddenException);

    expect(finance.processPayin).not.toHaveBeenCalled();
  });

  it('4. délègue à finance.processPayin si toutes les conditions sont OK', async () => {
    prisma.commandes_vente.findUnique.mockResolvedValue({
      id: ORDER_ID,
      buyer_id: BUYER_ID,
      status: 'SENT',
      reference: 'ORD-4',
      from_reservation_id: null,
    });
    prisma.escrow_conditions.findFirst.mockResolvedValue(null); // aucun escrow LOCKED
    prisma.moyen_de_payement.findFirst.mockResolvedValue({
      id: PAY_METHOD_ID,
      provider: 'MTN_MOMO',
      phone_display: '+2250709123456',
    });

    const result = await service.payOrder(BUYER_ID, ORDER_ID, {
      payment_method_id: PAY_METHOD_ID,
    });

    expect(finance.processPayin).toHaveBeenCalledWith(
      BUYER_ID,
      expect.objectContaining({
        commande_id: ORDER_ID,
        buyer_id: BUYER_ID,
        payment_method_id: PAY_METHOD_ID,
      }),
    );
    expect(result).toMatchObject({
      message: 'Paiement confirmé.',
      commande_id: ORDER_ID,
      reference: 'ORD-4',
    });
  });
});
