// =====================================================================
//  UNIT : CandidaturesService — Chantier 5 (négociation atomique)
//  ---------------------------------------------------------------------
//  Couvre le path critique « accept candidature → create order + reject
//  concurrents » introduit au chantier précédent :
//
//   1. traiterCandidatureAchat(ACCEPTED) par le farmer crée la commande
//      avec idempotency_key = candidatureId.
//   2. Les autres candidatures PENDING/COUNTER_OFFER sur la même
//      annonce sont marquées REJECTED_BY_RACE.
//   3. La commande créée a status = SENT (en attente de paiement).
// =====================================================================

import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService } from '@farmcash/notifications';
import { CandidaturesService } from './candidatures.service';
import { NegotiationAction } from './dto/candidatures.dto';

// ---------------------------------------------------------------------
//  Helpers de mocks
// ---------------------------------------------------------------------

function decimal(value: number | string): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/**
 * Mock minimal de PrismaService. Le $transaction reçoit un client de
 * transaction qui exécute la callback synchroniquement avec un proxy
 * vers les sub-méthodes mockées (suffisant : on n'a pas besoin d'isolation
 * réelle pour vérifier le séquencement des appels).
 */
function buildPrismaMock() {
  const candidatures_achat = {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const candidature_traitements = {
    create: jest.fn().mockResolvedValue({}),
  };
  const commandes_vente = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  };
  const $queryRaw = jest.fn();
  const $transaction = jest.fn(async (cb: any) => {
    // Proxy : la callback reçoit un client qui pointe vers les mêmes mocks.
    return cb({
      candidatures_achat,
      candidature_traitements,
      commandes_vente,
      $queryRaw,
    });
  });

  return {
    candidatures_achat,
    candidature_traitements,
    commandes_vente,
    $queryRaw,
    $transaction,
  } as any;
}

function buildNotificationsMock(): NotificationsService {
  return { create: jest.fn().mockResolvedValue({}) } as any;
}

function buildConfigMock(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'SERVICE_FEE_PRODUCT') return '0.03';
      return undefined;
    }),
  } as any;
}

// ---------------------------------------------------------------------

describe('CandidaturesService — traiterCandidatureAchat ACCEPTED', () => {
  const ANNONCE_ID = '11111111-1111-1111-1111-111111111111';
  const CANDIDATURE_ID = '22222222-2222-2222-2222-222222222222';
  const FARMER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const BUYER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  let prisma: any;
  let notifications: NotificationsService;
  let config: ConfigService;
  let service: CandidaturesService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    notifications = buildNotificationsMock();
    config = buildConfigMock();
    service = new CandidaturesService(
      prisma as unknown as PrismaService,
      notifications,
      config,
    );
  });

  function setupAcceptedCandidatureScenario() {
    // Lookup initial : candidature PENDING + annonce attachée.
    prisma.candidatures_achat.findUnique.mockResolvedValueOnce({
      id: CANDIDATURE_ID,
      annonce_id: ANNONCE_ID,
      buyer_id: BUYER_ID,
      status: 'PENDING',
      quantite_kg: decimal(100),
      prix_propose_kg: decimal(500),
      annonces_vente: { farmer_id: FARMER_ID },
    });

    // Le SELECT FOR UPDATE retourne l'annonce ACTIVE avec stock dispo.
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: ANNONCE_ID,
        farmer_id: FARMER_ID,
        quantite_kg: decimal(500),
        prix_par_kg: decimal(500),
        status: 'ACTIVE',
      },
    ]);

    // commandes_vente.create renvoie une commande SENT
    prisma.commandes_vente.create.mockResolvedValueOnce({
      id: 'cmd-new-1',
      reference: 'ORD-TEST-001',
      status: 'SENT',
    });
  }

  it('1. ACCEPTED par le farmer → crée une commande SENT avec idempotency_key=candidatureId', async () => {
    setupAcceptedCandidatureScenario();

    const result = await service.traiterCandidatureAchat(
      FARMER_ID,
      CANDIDATURE_ID,
      { action: NegotiationAction.ACCEPTED },
    );

    expect(prisma.commandes_vente.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          buyer_id: BUYER_ID,
          seller_id: FARMER_ID,
          annonce_id: ANNONCE_ID,
          status: 'SENT',
          idempotency_key: CANDIDATURE_ID,
        }),
      }),
    );
    expect(result).toMatchObject({
      message: expect.stringContaining('ACCEPTED'),
      commande_id: 'cmd-new-1',
      reference: 'ORD-TEST-001',
    });
  });

  it('2. ACCEPTED → marque les autres candidatures PENDING/COUNTER_OFFER comme REJECTED_BY_RACE', async () => {
    setupAcceptedCandidatureScenario();

    await service.traiterCandidatureAchat(FARMER_ID, CANDIDATURE_ID, {
      action: NegotiationAction.ACCEPTED,
    });

    expect(prisma.candidatures_achat.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          annonce_id: ANNONCE_ID,
          id: { not: CANDIDATURE_ID },
          status: { in: expect.arrayContaining(['PENDING', 'COUNTER_OFFER']) },
        }),
        data: expect.objectContaining({ status: 'REJECTED_BY_RACE' }),
      }),
    );
  });

  it('3. ACCEPTED idempotent → si une commande existe déjà avec idempotency_key=candidatureId, ne re-crée pas', async () => {
    prisma.candidatures_achat.findUnique.mockResolvedValueOnce({
      id: CANDIDATURE_ID,
      annonce_id: ANNONCE_ID,
      buyer_id: BUYER_ID,
      status: 'PENDING',
      quantite_kg: decimal(100),
      prix_propose_kg: decimal(500),
      annonces_vente: { farmer_id: FARMER_ID },
    });
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: ANNONCE_ID,
        farmer_id: FARMER_ID,
        quantite_kg: decimal(500),
        prix_par_kg: decimal(500),
        status: 'ACTIVE',
      },
    ]);
    // findFirst trouve une commande existante avec la même idempotency_key
    prisma.commandes_vente.findFirst.mockResolvedValueOnce({
      id: 'cmd-existing',
      reference: 'ORD-EXISTING-001',
    });

    const result = await service.traiterCandidatureAchat(
      FARMER_ID,
      CANDIDATURE_ID,
      { action: NegotiationAction.ACCEPTED },
    );

    // Pas de re-création
    expect(prisma.commandes_vente.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      commande_id: 'cmd-existing',
      reference: 'ORD-EXISTING-001',
    });
  });
});
