// =====================================================================
//  UNIT TESTS : SollicitationsService — Chantier 2 (multi-audience)
//  ---------------------------------------------------------------------
//  Couvre les 8 cas prévus par la spec § 2.8 :
//   1. createSollicitation : fan-out aux MEMBRES uniquement
//   2. createSollicitation : fan-out MEMBRES + COOPS_VOISINES (ST_DWithin)
//   3. createSollicitation : exclut l'initiateur du fan-out
//   4. createSollicitation : rejette si annonce non ciblée sur la coop
//   5. respond : ACCEPTED → incrémente qty_engaged et total_responses
//   6. respond : auto-FULFILLED quand total atteint quantite_cible
//   7. respond : idempotent — 2e réponse = ConflictException
//   8. close : notifie tous les recipients PENDING
// =====================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@farmcash/database';
import { NotificationsService } from '@farmcash/notifications';
import { SmsProvider } from '@farmcash/auth';
import { SollicitationsService } from './sollicitations.service';
import {
  SollicitationAudience,
  SollicitationStatus,
} from './dto/sollicitations.dto';

// ---------------------------------------------------------------------
//  Helpers de mock
// ---------------------------------------------------------------------

function buildPrismaMock() {
  return {
    cooperative_profiles: {
      findUnique: jest.fn(),
    },
    cooperative_members: {
      findMany: jest.fn(),
    },
    annonces_achat: {
      findUnique: jest.fn(),
    },
    users: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    sollicitations_coop: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    sollicitation_recipients: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    notifications: {
      create: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  } as any;
}

function buildSmsProviderMock() {
  return {
    send: jest.fn().mockResolvedValue(undefined),
    sendOtp: jest.fn().mockResolvedValue(undefined),
  } as unknown as SmsProvider;
}

function buildNotificationsMock() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'notif-id' }),
  } as unknown as NotificationsService;
}

// ---------------------------------------------------------------------

describe('SollicitationsService — Chantier 2 (multi-audience)', () => {
  const COOP_ID = '11111111-1111-1111-1111-111111111111';
  const COOP_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ANNONCE_ID = '22222222-2222-2222-2222-222222222222';
  const MEMBER_1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
  const MEMBER_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
  const MEMBER_3 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3';
  const NEIGHBOR_USER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const NEIGHBOR_COOP = 'cccccccc-1111-cccc-cccc-cccccccccccc';
  const SOLLICIT_ID = '33333333-3333-3333-3333-333333333333';

  let prisma: ReturnType<typeof buildPrismaMock>;
  let notifications: NotificationsService;
  let smsProvider: SmsProvider;
  let service: SollicitationsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    notifications = buildNotificationsMock();
    smsProvider = buildSmsProviderMock();
    service = new SollicitationsService(
      prisma as unknown as PrismaService,
      notifications,
      smsProvider,
    );
  });

  // -------------------------------------------------------------------
  //  Helpers : pré-paramétrage createSollicitation avec coop + annonce
  // -------------------------------------------------------------------

  function setupValidCreate(opts: {
    audiences: SollicitationAudience[];
    members?: Array<{ member_id: string }>;
    neighbors?: Array<{ user_id: string; coop_id: string }>;
    independants?: Array<{ id: string }>;
    annonceQty?: number;
  }) {
    prisma.cooperative_profiles.findUnique.mockResolvedValueOnce({
      id: COOP_ID,
      user_id: COOP_USER_ID,
      nom: 'Coop Test',
    });
    prisma.annonces_achat.findUnique.mockResolvedValueOnce({
      id: ANNONCE_ID,
      is_active: true,
      target_audience: 'SPECIFIC_COOPERATIVE',
      target_cooperative_id: COOP_ID,
      quantite_kg: new Prisma.Decimal(opts.annonceQty ?? 1000),
      produits_agricoles: { nom: 'Maïs' },
    });
    if (opts.audiences.includes(SollicitationAudience.MEMBRES)) {
      prisma.cooperative_members.findMany.mockResolvedValueOnce(
        opts.members ?? [],
      );
    }
    // $queryRaw est appelé 1× par audience non-MEMBRES (COOPS_VOISINES, INDEPENDANTS)
    if (opts.audiences.includes(SollicitationAudience.COOPS_VOISINES)) {
      prisma.$queryRaw.mockResolvedValueOnce(opts.neighbors ?? []);
    }
    if (opts.audiences.includes(SollicitationAudience.INDEPENDANTS)) {
      prisma.$queryRaw.mockResolvedValueOnce(opts.independants ?? []);
    }
    // Transaction : la callback est exécutée avec un tx miroir.
    prisma.$transaction.mockImplementationOnce(async (cb: any) => {
      const tx = {
        sollicitations_coop: {
          create: jest.fn().mockResolvedValue({
            id: SOLLICIT_ID,
            cooperative_id: COOP_ID,
            initiated_by: COOP_USER_ID,
            status: SollicitationStatus.OPEN,
            quantite_cible_kg: new Prisma.Decimal(opts.annonceQty ?? 1000),
          }),
        },
        sollicitation_recipients: {
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: jest.fn(),
        },
        notifications: {
          create: jest.fn().mockResolvedValue({ id: 'notif-id' }),
        },
      };
      return cb(tx);
    });
  }

  // -------------------------------------------------------------------
  //  createSollicitation
  // -------------------------------------------------------------------

  describe('createSollicitation', () => {
    it('fan-out MEMBRES uniquement', async () => {
      setupValidCreate({
        audiences: [SollicitationAudience.MEMBRES],
        members: [
          { member_id: MEMBER_1 },
          { member_id: MEMBER_2 },
          { member_id: MEMBER_3 },
        ],
      });

      const result = await service.createSollicitation(COOP_USER_ID, {
        annonce_achat_id: ANNONCE_ID,
        message: 'Besoin de maïs cette semaine.',
        audiences: [SollicitationAudience.MEMBRES],
        rayon_km: 50,
        duree_jours: 7,
      });

      expect(result.sollicitation_id).toBe(SOLLICIT_ID);
      expect(result.recipients_count.MEMBRES).toBe(3);
      expect(result.recipients_count.COOPS_VOISINES).toBe(0);
      expect(result.recipients_count.INDEPENDANTS).toBe(0);
      expect(result.notifications_dispatched).toBe(3);
      // Pas de raw query pour les audiences non sélectionnées
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('fan-out MEMBRES + COOPS_VOISINES (filtre ST_DWithin via $queryRaw)', async () => {
      setupValidCreate({
        audiences: [
          SollicitationAudience.MEMBRES,
          SollicitationAudience.COOPS_VOISINES,
        ],
        members: [{ member_id: MEMBER_1 }, { member_id: MEMBER_2 }],
        neighbors: [{ user_id: NEIGHBOR_USER, coop_id: NEIGHBOR_COOP }],
      });

      const result = await service.createSollicitation(COOP_USER_ID, {
        annonce_achat_id: ANNONCE_ID,
        message: 'Besoin de maïs cette semaine.',
        audiences: [
          SollicitationAudience.MEMBRES,
          SollicitationAudience.COOPS_VOISINES,
        ],
        rayon_km: 50,
        duree_jours: 7,
      });

      // Le $queryRaw COOPS_VOISINES a bien été appelé
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      // 2 membres + 1 coop voisine = 3 destinataires
      expect(result.recipients_count.MEMBRES).toBe(2);
      expect(result.recipients_count.COOPS_VOISINES).toBe(1);
      expect(result.notifications_dispatched).toBe(3);
    });

    it('exclut l\'initiateur du fan-out', async () => {
      // L'initiateur (COOP_USER_ID) apparaît dans la liste members (cas dégénéré
      // où une coop serait elle-même membre — non sensé mais le code doit
      // gérer). On vérifie qu'il est filtré.
      setupValidCreate({
        audiences: [SollicitationAudience.MEMBRES],
        members: [
          { member_id: COOP_USER_ID }, // initiateur
          { member_id: MEMBER_1 },
          { member_id: MEMBER_2 },
        ],
      });

      const result = await service.createSollicitation(COOP_USER_ID, {
        annonce_achat_id: ANNONCE_ID,
        message: 'Besoin de maïs cette semaine.',
        audiences: [SollicitationAudience.MEMBRES],
        rayon_km: 50,
        duree_jours: 7,
      });

      // 3 members - 1 initiateur = 2 destinataires
      expect(result.recipients_count.MEMBRES).toBe(2);
      expect(result.notifications_dispatched).toBe(2);
    });

    it('rejette si annonce SPECIFIC_COOPERATIVE ciblée sur une autre coop (403)', async () => {
      prisma.cooperative_profiles.findUnique.mockResolvedValueOnce({
        id: COOP_ID,
        user_id: COOP_USER_ID,
        nom: 'Coop Test',
      });
      prisma.annonces_achat.findUnique.mockResolvedValueOnce({
        id: ANNONCE_ID,
        is_active: true,
        target_audience: 'SPECIFIC_COOPERATIVE',
        target_cooperative_id: 'autre-coop-uuid', // pas la nôtre
        quantite_kg: new Prisma.Decimal(1000),
        produits_agricoles: { nom: 'Maïs' },
      });

      await expect(
        service.createSollicitation(COOP_USER_ID, {
          annonce_achat_id: ANNONCE_ID,
          message: 'Besoin de maïs cette semaine.',
          audiences: [SollicitationAudience.MEMBRES],
        }),
      ).rejects.toThrow(ForbiddenException);

      // Aucune écriture
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejette si annonce PUBLIC (sollicitation coop sans cible)', async () => {
      prisma.cooperative_profiles.findUnique.mockResolvedValueOnce({
        id: COOP_ID,
        user_id: COOP_USER_ID,
        nom: 'Coop Test',
      });
      prisma.annonces_achat.findUnique.mockResolvedValueOnce({
        id: ANNONCE_ID,
        is_active: true,
        target_audience: 'PUBLIC',
        target_cooperative_id: null,
        quantite_kg: new Prisma.Decimal(1000),
        produits_agricoles: { nom: 'Maïs' },
      });

      await expect(
        service.createSollicitation(COOP_USER_ID, {
          annonce_achat_id: ANNONCE_ID,
          message: 'Besoin de maïs cette semaine.',
          audiences: [SollicitationAudience.MEMBRES],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------
  //  respond
  // -------------------------------------------------------------------

  describe('respond', () => {
    const FUTURE = new Date(Date.now() + 86_400_000);
    const PAST = new Date(Date.now() - 86_400_000);

    it('ACCEPTED → incrémente total_quantite_offerte et total_responses', async () => {
      prisma.sollicitation_recipients.findUnique.mockResolvedValueOnce({
        id: 'recip-1',
        sollicitation_id: SOLLICIT_ID,
        user_id: MEMBER_1,
        responded_at: null,
        sollicitations_coop: {
          status: SollicitationStatus.OPEN,
          expires_at: FUTURE,
          quantite_cible_kg: new Prisma.Decimal(1000),
        },
      });

      // tx mock : update recip + update solli + findUnique post-update
      const txUpdate = jest.fn();
      const txFindUnique = jest.fn().mockResolvedValue({
        id: SOLLICIT_ID,
        status: SollicitationStatus.OPEN,
        quantite_cible_kg: new Prisma.Decimal(1000),
        total_quantite_offerte: new Prisma.Decimal(300), // n'atteint pas la cible
        initiated_by: COOP_USER_ID,
      });
      prisma.$transaction.mockImplementationOnce(async (cb: any) => {
        const tx = {
          sollicitation_recipients: { update: jest.fn() },
          sollicitations_coop: { update: txUpdate, findUnique: txFindUnique },
          notifications: { create: jest.fn() },
        };
        return cb(tx);
      });

      const result = await service.respond(MEMBER_1, SOLLICIT_ID, {
        action: 'ACCEPTED',
        quantite_kg: 300,
      });

      expect(result.response_action).toBe('ACCEPTED');
      expect(result.response_quantite_kg).toBe(300);
      // L'update doit incrémenter total_responses ET total_quantite_offerte
      expect(txUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SOLLICIT_ID },
          data: expect.objectContaining({
            total_responses: { increment: 1 },
            total_quantite_offerte: { increment: 300 },
          }),
        }),
      );
      // Pas en FULFILLED (300 < 1000)
      expect(result.sollicitation_status).toBe(SollicitationStatus.OPEN);
    });

    it('auto-FULFILLED quand total_quantite_offerte >= quantite_cible_kg', async () => {
      prisma.sollicitation_recipients.findUnique.mockResolvedValueOnce({
        id: 'recip-2',
        sollicitation_id: SOLLICIT_ID,
        user_id: MEMBER_2,
        responded_at: null,
        sollicitations_coop: {
          status: SollicitationStatus.OPEN,
          expires_at: FUTURE,
          quantite_cible_kg: new Prisma.Decimal(1000),
        },
      });

      const txUpdateSolli = jest.fn();
      const txNotif = jest.fn();
      prisma.$transaction.mockImplementationOnce(async (cb: any) => {
        const tx = {
          sollicitation_recipients: { update: jest.fn() },
          sollicitations_coop: {
            update: txUpdateSolli,
            // Après le 1er update incrément, la cible est atteinte : 1100 > 1000
            findUnique: jest.fn().mockResolvedValue({
              id: SOLLICIT_ID,
              status: SollicitationStatus.OPEN,
              quantite_cible_kg: new Prisma.Decimal(1000),
              total_quantite_offerte: new Prisma.Decimal(1100),
              initiated_by: COOP_USER_ID,
            }),
          },
          notifications: { create: txNotif },
        };
        return cb(tx);
      });

      const result = await service.respond(MEMBER_2, SOLLICIT_ID, {
        action: 'ACCEPTED',
        quantite_kg: 1100,
      });

      expect(result.sollicitation_status).toBe(SollicitationStatus.FULFILLED);
      // 2 appels update : 1 pour incrémenter, 1 pour passer en FULFILLED
      expect(txUpdateSolli).toHaveBeenCalledTimes(2);
      expect(txUpdateSolli).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: { status: SollicitationStatus.FULFILLED },
        }),
      );
      // La coop initiatrice reçoit une notif "tonnage atteint"
      expect(txNotif).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: COOP_USER_ID,
            type: 'COOP_SOLLICITATION_FULFILLED',
          }),
        }),
      );
    });

    it('idempotent : 2e réponse du même user lève ConflictException', async () => {
      prisma.sollicitation_recipients.findUnique.mockResolvedValueOnce({
        id: 'recip-3',
        sollicitation_id: SOLLICIT_ID,
        user_id: MEMBER_1,
        responded_at: new Date(), // déjà répondu
        sollicitations_coop: {
          status: SollicitationStatus.OPEN,
          expires_at: FUTURE,
          quantite_cible_kg: new Prisma.Decimal(1000),
        },
      });

      await expect(
        service.respond(MEMBER_1, SOLLICIT_ID, {
          action: 'ACCEPTED',
          quantite_kg: 200,
        }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejette si sollicitation expirée (410)', async () => {
      prisma.sollicitation_recipients.findUnique.mockResolvedValueOnce({
        id: 'recip-4',
        sollicitation_id: SOLLICIT_ID,
        user_id: MEMBER_1,
        responded_at: null,
        sollicitations_coop: {
          status: SollicitationStatus.OPEN,
          expires_at: PAST, // expirée
          quantite_cible_kg: new Prisma.Decimal(1000),
        },
      });

      await expect(
        service.respond(MEMBER_1, SOLLICIT_ID, {
          action: 'ACCEPTED',
          quantite_kg: 200,
        }),
      ).rejects.toThrow(GoneException);
    });
  });

  // -------------------------------------------------------------------
  //  close
  // -------------------------------------------------------------------

  describe('close', () => {
    it('notifie tous les recipients PENDING (responded_at = null)', async () => {
      prisma.sollicitations_coop.findUnique.mockResolvedValueOnce({
        id: SOLLICIT_ID,
        status: SollicitationStatus.OPEN,
        cooperative_profiles: { user_id: COOP_USER_ID, nom: 'Coop Test' },
      });

      const txFindMany = jest
        .fn()
        .mockResolvedValue([{ user_id: MEMBER_1 }, { user_id: MEMBER_2 }]);
      const txNotif = jest.fn();
      const txUpdate = jest.fn().mockResolvedValue({
        id: SOLLICIT_ID,
        status: SollicitationStatus.CLOSED,
      });
      prisma.$transaction.mockImplementationOnce(async (cb: any) => {
        const tx = {
          sollicitations_coop: { update: txUpdate },
          sollicitation_recipients: { findMany: txFindMany },
          notifications: { create: txNotif },
        };
        return cb(tx);
      });

      const result = await service.close(COOP_USER_ID, SOLLICIT_ID);

      expect(result.status).toBe(SollicitationStatus.CLOSED);
      // Un appel par destinataire pending
      expect(txNotif).toHaveBeenCalledTimes(2);
      expect(txFindMany).toHaveBeenCalledWith({
        where: { sollicitation_id: SOLLICIT_ID, responded_at: null },
        select: { user_id: true },
      });
    });

    it('rejette si user n\'est pas la coop initiatrice (403)', async () => {
      prisma.sollicitations_coop.findUnique.mockResolvedValueOnce({
        id: SOLLICIT_ID,
        status: SollicitationStatus.OPEN,
        cooperative_profiles: { user_id: 'autre-user', nom: 'Coop Test' },
      });

      await expect(service.close(COOP_USER_ID, SOLLICIT_ID)).rejects.toThrow(
        ForbiddenException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejette si sollicitation introuvable (404)', async () => {
      prisma.sollicitations_coop.findUnique.mockResolvedValueOnce(null);

      await expect(service.close(COOP_USER_ID, SOLLICIT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
