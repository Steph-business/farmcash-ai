// =====================================================================
//  UNIT TESTS : LogisticsService — Chantier 1 (QR pickup + auto-release)
//  ---------------------------------------------------------------------
//  Couvre les 8 cas prévus par la spec § 1.8 :
//   1. generatePickupQrToken : token bien formé + expiry persisté
//   2. generatePickupQrToken : refuse si user n'est pas le seller (403)
//   3. generatePickupQrToken : refuse si shipment !== ACCEPTED (409)
//   4. scanPickup : rejette token avec signature forgée (400)
//   5. scanPickup : rejette token expiré (400)
//   6. scanPickup : rejette si transporter n'est pas assigné (403)
//   7. scanPickup : idempotent (2e scan = même réponse, pas de double release)
//   8. scanPickup : appelle releaseEscrow(PRODUCT) exactement 1× au 1er scan
// =====================================================================

import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@farmcash/database';
import { FinanceService, EscrowKind } from '@farmcash/finance';
import { NotificationsService } from '@farmcash/notifications';
import { LogisticsService } from './logistics.service';

const TEST_SECRET = 'a-test-secret-with-at-least-32-bytes-of-entropy';

// ---------------------------------------------------------------------
//  Helpers de mock — créent des objets jest.fn() pour chaque méthode
//  Prisma utilisée par scanPickup / generatePickupQrToken.
// ---------------------------------------------------------------------

function buildPrismaMock() {
  return {
    shipments: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    escrow_conditions: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    transporter_routes: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ d: 10 }]), // dist 10 m
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(async (cb: any) => {
      // Simule l'exécution de la callback avec un tx miroir du prisma mock.
      // Pour scanPickup la callback fait shipments.update + executeRaw ×2.
      const tx = {
        shipments: {
          update: jest.fn().mockResolvedValue({
            id: 'shipment-id',
            status: 'LOADING',
            commande_id: 'commande-id',
          }),
        },
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      return cb(tx);
    }),
  } as any;
}

function buildFinanceMock() {
  return {
    releaseEscrow: jest
      .fn()
      .mockResolvedValue({ released: true, kind: 'PRODUCT' }),
  } as unknown as FinanceService;
}

function buildNotificationsMock() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'notif-id' }),
  } as unknown as NotificationsService;
}

function buildConfigMock(secret: string = TEST_SECRET) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'PICKUP_QR_SECRET') return secret;
      return undefined;
    }),
  } as unknown as ConfigService;
}

/**
 * Génère un token HMAC valide compatible avec le format attendu par
 * scanPickup : `<shipShort>.<exp>.<sig16>`.
 */
function makeToken(opts: {
  shipmentId: string;
  expUnix: number;
  secret?: string;
}) {
  const secret = opts.secret ?? TEST_SECRET;
  const shipShort = opts.shipmentId.replace(/-/g, '').slice(0, 8);
  const payload = `${shipShort}.${opts.expUnix}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  return `${payload}.${sig}`;
}

// ---------------------------------------------------------------------

describe('LogisticsService — Chantier 1 (QR pickup + auto-release escrow)', () => {
  const SHIPMENT_ID = '11111111-2222-3333-4444-555555555555';
  const FARMER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TRANSPORTER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const OTHER_TRANSPORTER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const COMMANDE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  let prisma: ReturnType<typeof buildPrismaMock>;
  let finance: FinanceService;
  let notifications: NotificationsService;
  let config: ConfigService;
  let service: LogisticsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    finance = buildFinanceMock();
    notifications = buildNotificationsMock();
    config = buildConfigMock();
    service = new LogisticsService(
      prisma as unknown as PrismaService,
      finance,
      notifications,
      config,
    );
  });

  // -------------------------------------------------------------------
  //  generatePickupQrToken
  // -------------------------------------------------------------------

  describe('generatePickupQrToken', () => {
    it('génère un token signé HMAC valide + persiste l\'expiry', async () => {
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'ACCEPTED',
        commandes_vente: { seller_id: FARMER_ID },
      });
      prisma.shipments.update.mockResolvedValueOnce({ id: SHIPMENT_ID });

      const result = await service.generatePickupQrToken(FARMER_ID, SHIPMENT_ID);

      // Forme du token : <shipShort>.<exp>.<sig16>
      const parts = result.token.split('.');
      expect(parts).toHaveLength(3);
      expect(parts[2]).toHaveLength(16);
      expect(result.ttl_seconds).toBe(900);
      expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());

      // Re-calcule la signature pour vérifier la validité HMAC
      const expectedSig = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(`${parts[0]}.${parts[1]}`)
        .digest('hex')
        .slice(0, 16);
      expect(parts[2]).toBe(expectedSig);

      // Persistance du token + expiry sur le shipment
      expect(prisma.shipments.update).toHaveBeenCalledWith({
        where: { id: SHIPMENT_ID },
        data: {
          pickup_qr_token: result.token,
          pickup_qr_expires_at: expect.any(Date),
        },
      });
    });

    it('rejette si user n\'est pas le seller (FARMER propriétaire de l\'annonce)', async () => {
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'ACCEPTED',
        commandes_vente: { seller_id: 'autre-user' },
      });

      await expect(
        service.generatePickupQrToken(FARMER_ID, SHIPMENT_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.shipments.update).not.toHaveBeenCalled();
    });

    it('rejette si shipment.status !== ACCEPTED (409)', async () => {
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'LOADING',
        commandes_vente: { seller_id: FARMER_ID },
      });

      await expect(
        service.generatePickupQrToken(FARMER_ID, SHIPMENT_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('rejette si shipment introuvable (404)', async () => {
      prisma.shipments.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.generatePickupQrToken(FARMER_ID, SHIPMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------
  //  scanPickup
  // -------------------------------------------------------------------

  describe('scanPickup', () => {
    const validNow = () => Math.floor(Date.now() / 1000) + 600; // 10 min ahead

    it('rejette un token signé avec une autre clé (forgerie)', async () => {
      const forgedToken = makeToken({
        shipmentId: SHIPMENT_ID,
        expUnix: validNow(),
        secret: 'wrong-secret-with-32-bytes-of-entropy-too',
      });

      await expect(
        service.scanPickup(TRANSPORTER_ID, SHIPMENT_ID, {
          token: forgedToken,
          scan_position: { lat: 5.345, lng: -4.024 },
        } as any),
      ).rejects.toThrow(BadRequestException);

      // Aucun appel DB après rejet cryptographique
      expect(prisma.shipments.findUnique).not.toHaveBeenCalled();
    });

    it('rejette un token expiré', async () => {
      const expiredToken = makeToken({
        shipmentId: SHIPMENT_ID,
        expUnix: Math.floor(Date.now() / 1000) - 60, // 1 min in past
      });

      await expect(
        service.scanPickup(TRANSPORTER_ID, SHIPMENT_ID, {
          token: expiredToken,
          scan_position: { lat: 5.345, lng: -4.024 },
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejette si transporter n\'est pas assigné à la mission (403)', async () => {
      const token = makeToken({
        shipmentId: SHIPMENT_ID,
        expUnix: validNow(),
      });
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'ACCEPTED',
        transporter_id: OTHER_TRANSPORTER_ID, // assigné à un autre transporter
        pickup_qr_token: token,
        pickup_scanned_at: null,
        commande_id: COMMANDE_ID,
        commandes_vente: { seller_id: FARMER_ID, lot_id: null },
      });

      await expect(
        service.scanPickup(TRANSPORTER_ID, SHIPMENT_ID, {
          token,
          scan_position: { lat: 5.345, lng: -4.024 },
        } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepte un token valide et libère l\'escrow PRODUCT exactement 1×', async () => {
      const token = makeToken({
        shipmentId: SHIPMENT_ID,
        expUnix: validNow(),
      });
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'ACCEPTED',
        transporter_id: TRANSPORTER_ID,
        pickup_qr_token: token,
        pickup_scanned_at: null,
        commande_id: COMMANDE_ID,
        commandes_vente: { seller_id: FARMER_ID, lot_id: null },
      });

      const result = await service.scanPickup(TRANSPORTER_ID, SHIPMENT_ID, {
        token,
        scan_position: { lat: 5.345, lng: -4.024 },
      } as any);

      expect(result.shipment).toBeDefined();
      expect(result.escrow_released).toEqual({ released: true, kind: 'PRODUCT' });

      // releaseEscrow appelé 1× avec kind=PRODUCT et reason=AUTO_PICKUP_SCAN
      expect(finance.releaseEscrow).toHaveBeenCalledTimes(1);
      expect(finance.releaseEscrow).toHaveBeenCalledWith(
        COMMANDE_ID,
        TRANSPORTER_ID,
        EscrowKind.PRODUCT,
        'AUTO_PICKUP_SCAN',
      );

      // Notif au producteur
      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('est idempotent : 2e scan retourne already_done et n\'appelle PAS releaseEscrow', async () => {
      const token = makeToken({
        shipmentId: SHIPMENT_ID,
        expUnix: validNow(),
      });
      // shipment déjà scanné (pickup_scanned_at non null)
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'LOADING',
        transporter_id: TRANSPORTER_ID,
        pickup_qr_token: token,
        pickup_scanned_at: new Date(),
        commande_id: COMMANDE_ID,
        commandes_vente: { seller_id: FARMER_ID, lot_id: null },
      });

      const result = await service.scanPickup(TRANSPORTER_ID, SHIPMENT_ID, {
        token,
        scan_position: { lat: 5.345, lng: -4.024 },
      } as any);

      // Réponse idempotente : { product: { already_done: true } }
      expect(result.escrow_released).toEqual({
        product: { already_done: true },
      });
      // Pas de double release
      expect(finance.releaseEscrow).not.toHaveBeenCalled();
      // Pas d'écriture shipments via transaction
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejette si GPS distance > 500 m', async () => {
      const token = makeToken({
        shipmentId: SHIPMENT_ID,
        expUnix: validNow(),
      });
      prisma.shipments.findUnique.mockResolvedValueOnce({
        id: SHIPMENT_ID,
        status: 'ACCEPTED',
        transporter_id: TRANSPORTER_ID,
        pickup_qr_token: token,
        pickup_scanned_at: null,
        commande_id: COMMANDE_ID,
        commandes_vente: { seller_id: FARMER_ID, lot_id: null },
      });
      // Mock une distance de 1200 m (> 500 m)
      prisma.$queryRaw.mockResolvedValueOnce([{ d: 1200 }]);

      await expect(
        service.scanPickup(TRANSPORTER_ID, SHIPMENT_ID, {
          token,
          scan_position: { lat: 5.99, lng: -4.99 },
        } as any),
      ).rejects.toThrow(BadRequestException);

      expect(finance.releaseEscrow).not.toHaveBeenCalled();
    });
  });
});
