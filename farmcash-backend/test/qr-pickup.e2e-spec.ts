// =====================================================================
//  E2E : QR pickup + auto-release escrow PRODUCT (Chantier 1)
//  ---------------------------------------------------------------------
//  3 scénarios (spec § 1.8) :
//   1. Happy path : FARMER génère QR → TRANSPORTER scan → wallet
//      producteur crédité (montant net = 150 000 - 3 %).
//   2. Token expiré : forgé avec exp dans le passé → POST scan = 400.
//   3. Mauvais transporteur : transporter B scanne un shipment assigné
//      à transporter A → 403.
//
//  On utilise des inserts Prisma directs pour aller vite (annonce +
//  commande + shipment + escrow + wallets), au lieu de passer par les
//  endpoints (qui exigent payment_provider, confirmation OTP, etc.).
// =====================================================================

import * as crypto from 'crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '@farmcash/database';
import {
  bearer,
  cleanupTestUsers,
  createTestApp,
  getCatalogIds,
  registerAndGetToken,
} from './setup';

const TREASURY_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Re-implémente la signature HMAC côté test pour forger un token avec
 * la même clé que le service. Utile uniquement pour le scénario "token
 * expiré" (sinon on appelle l'endpoint /qr-token légitimement).
 */
function makeToken(opts: {
  shipmentId: string;
  expUnix: number;
  secret: string;
}) {
  const shipShort = opts.shipmentId.replace(/-/g, '').slice(0, 8);
  const payload = `${shipShort}.${opts.expUnix}`;
  const sig = crypto
    .createHmac('sha256', opts.secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  return `${payload}.${sig}`;
}

/**
 * Seed atomique d'une commande + shipment + escrow PRODUCT/TRANSPORT
 * + wallets (buyer débité, seller à 0). Évite de passer par l'endpoint
 * /api/orders qui exige un payment provider + confirmation Mobile Money.
 *
 * Retourne shipment_id + commande_id pour exécuter le scan.
 */
async function seedCommandeWithShipment(
  prisma: PrismaService,
  opts: {
    farmerId: string;
    buyerId: string;
    transporterId: string;
    produitId: string;
    montantProduct?: number;
    fraisProduct?: number;
  },
): Promise<{ commande_id: string; shipment_id: string; refRand: string }> {
  const montantProduct = opts.montantProduct ?? 150_000;
  const fraisProduct = opts.fraisProduct ?? 4500; // 3 %
  const refRand = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // S'assure que l'utilisateur TREASURY existe (créé par migration en prod
  // mais peut manquer sur les DB de test : on l'insère idempotent en raw).
  await prisma.$executeRaw`
    INSERT INTO users (id, phone, role, full_name, is_active)
    VALUES (
      '00000000-0000-0000-0000-000000000001'::uuid,
      '+22500000001',
      'ADMIN'::user_role,
      'FarmCash Treasury',
      true
    ) ON CONFLICT (id) DO NOTHING`;
  await prisma.wallets.upsert({
    where: {
      user_id_currency: {
        user_id: TREASURY_USER_ID,
        currency: 'XOF',
      },
    },
    create: {
      user_id: TREASURY_USER_ID,
      currency: 'XOF',
      balance: 0,
      balance_escrow: 0,
    },
    update: {},
  });

  // Wallets : buyer a balance_escrow couvrant le montant PRODUCT (le scan
  // décrémente uniquement cette part). On pré-crée aussi le wallet farmer
  // (qui sera crédité du net à la libération) pour éviter une race auto-create
  // côté FinanceService.lockWallet.
  await prisma.wallets.upsert({
    where: {
      user_id_currency: { user_id: opts.buyerId, currency: 'XOF' },
    },
    create: {
      user_id: opts.buyerId,
      currency: 'XOF',
      balance: 0,
      balance_escrow: montantProduct,
    },
    update: { balance_escrow: montantProduct },
  });
  await prisma.wallets.upsert({
    where: {
      user_id_currency: { user_id: opts.farmerId, currency: 'XOF' },
    },
    create: {
      user_id: opts.farmerId,
      currency: 'XOF',
      balance: 0,
      balance_escrow: 0,
    },
    update: {},
  });

  // annonces_vente.location est NOT NULL côté DB (geography Unsupported)
  // → on passe par $executeRaw pour pouvoir l'insérer.
  const annonceRows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO annonces_vente (
      farmer_id, produit_id, titre, quantite_kg, prix_par_kg,
      quantite_min_kg, qualite, location, status
    ) VALUES (
      ${opts.farmerId}::uuid,
      ${opts.produitId}::uuid,
      ${'Annonce QR ' + refRand},
      500,
      1500,
      50,
      'STANDARD'::product_quality,
      ST_SetSRID(ST_MakePoint(-4.024429, 5.345317), 4326),
      'ACTIVE'::product_status
    )
    RETURNING id::text AS id`;
  const annonceId = annonceRows[0].id;

  // Commande directe : FARMER seller, BUYER buyer
  const commande = await prisma.commandes_vente.create({
    data: {
      reference: refRand,
      buyer_id: opts.buyerId,
      seller_id: opts.farmerId,
      annonce_id: annonceId,
      quantite_kg: new Prisma.Decimal(100),
      prix_unitaire_kg: new Prisma.Decimal(1500),
      montant_total: new Prisma.Decimal(montantProduct),
      frais_service: new Prisma.Decimal(fraisProduct),
      montant_net: new Prisma.Decimal(montantProduct - fraisProduct),
      status: 'ACCEPTED',
      delivery_address: 'Abidjan Plateau',
    },
  });

  // Escrow PRODUCT LOCKED (le scan va le libérer)
  await prisma.escrow_conditions.create({
    data: {
      commande_id: commande.id,
      kind: 'PRODUCT',
      beneficiary_id: opts.farmerId,
      montant: new Prisma.Decimal(montantProduct),
      frais_service: new Prisma.Decimal(fraisProduct),
      status: 'LOCKED',
      condition: 'DELIVERY_CONFIRMED',
    },
  });

  // Shipment ACCEPTED rattaché au transporter
  const shipment = await prisma.shipments.create({
    data: {
      commande_id: commande.id,
      transporter_id: opts.transporterId,
      origin_zone: 'Bouaké',
      destination_zone: 'Abidjan',
      pickup_address: 'Bouaké Centre',
      delivery_address: 'Abidjan Plateau',
      quantite_kg: new Prisma.Decimal(100),
      prix_final: new Prisma.Decimal(0),
      status: 'ACCEPTED',
    },
  });

  return {
    commande_id: commande.id,
    shipment_id: shipment.id,
    refRand,
  };
}

describe('QR pickup + auto-release escrow PRODUCT (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: ConfigService;
  let catalog: { produit_id: string; region_id: string; ville_id: string };
  let pickupSecret: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    config = app.get(ConfigService);
    pickupSecret = config.get<string>('PICKUP_QR_SECRET')!;
    if (!pickupSecret || pickupSecret.length < 32) {
      throw new Error(
        'PICKUP_QR_SECRET manquant ou < 32 chars — configure dans .env',
      );
    }
    await cleanupTestUsers(app);
    catalog = await getCatalogIds(app);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  it('happy path : FARMER génère QR → TRANSPORTER scan → wallet producteur crédité', async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer QR Happy',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer QR Happy',
      role: 'BUYER',
    });
    const transporter = await registerAndGetToken(app, {
      full_name: 'Transporter QR Happy',
      role: 'TRANSPORTER',
    });

    const { commande_id, shipment_id } = await seedCommandeWithShipment(
      prisma,
      {
        farmerId: farmer.userId,
        buyerId: buyer.userId,
        transporterId: transporter.userId,
        produitId: catalog.produit_id,
      },
    );

    // 1. FARMER appelle GET /qr-token → reçoit un token signé
    const tokenRes = await request(app.getHttpServer())
      .get(`/api/logistics/shipments/${shipment_id}/qr-token`)
      .set(bearer(farmer.token))
      .expect(200);

    const token = tokenRes.body.data.token;
    expect(token.split('.')).toHaveLength(3);
    expect(tokenRes.body.data.ttl_seconds).toBe(900);

    // Vérifie le solde producteur avant scan : wallet pas encore créé (sera
    // auto-créé par FinanceService.releaseEscrow → lockWallet pendant le scan).
    const walletBefore = await prisma.wallets.findUnique({
      where: { user_id_currency: { user_id: farmer.userId, currency: 'XOF' } },
    });
    expect(walletBefore?.balance ? Number(walletBefore.balance) : 0).toBe(0);

    // 2. TRANSPORTER scan le QR (GPS à 0 m du shipment → pickup_location
    //    est NULL dans le seed donc le check distance est skip)
    const scanRes = await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/scan-pickup`)
      .set(bearer(transporter.token))
      .send({
        token,
        scan_position: { lat: 5.345317, lng: -4.024429 },
      })
      .expect(200);

    expect(scanRes.body.data.shipment.status).toBe('LOADING');
    expect(scanRes.body.data.shipment.pickup_scanned_by).toBe(transporter.userId);

    // 3. Wallet producteur crédité du montant net (150 000 - 4500 = 145 500)
    const walletAfter = await prisma.wallets.findUnique({
      where: { user_id_currency: { user_id: farmer.userId, currency: 'XOF' } },
    });
    expect(Number(walletAfter!.balance)).toBe(145_500);

    // 4. Escrow PRODUCT en RELEASED + flag auto_released_on_pickup = true
    const escrowAfter = await prisma.escrow_conditions.findFirst({
      where: { commande_id, kind: 'PRODUCT' },
    });
    expect(escrowAfter!.status).toBe('RELEASED');
    expect(escrowAfter!.auto_released_on_pickup).toBe(true);
    expect(escrowAfter!.release_reason).toBe('AUTO_PICKUP_SCAN');
  }, 60000);

  it('token expiré : POST scan retourne 400', async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer QR Exp',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer QR Exp',
      role: 'BUYER',
    });
    const transporter = await registerAndGetToken(app, {
      full_name: 'Transporter QR Exp',
      role: 'TRANSPORTER',
    });

    const { shipment_id } = await seedCommandeWithShipment(prisma, {
      farmerId: farmer.userId,
      buyerId: buyer.userId,
      transporterId: transporter.userId,
      produitId: catalog.produit_id,
    });

    // Token forgé avec exp 5 min dans le passé (signature valide mais expiré)
    const expiredToken = makeToken({
      shipmentId: shipment_id,
      expUnix: Math.floor(Date.now() / 1000) - 300,
      secret: pickupSecret,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/scan-pickup`)
      .set(bearer(transporter.token))
      .send({
        token: expiredToken,
        scan_position: { lat: 5.345317, lng: -4.024429 },
      })
      .expect(400);

    // Le wrapper d'erreurs encapsule sous `error.message` ; on cherche
    // le mot "expir" peu importe la profondeur.
    const errPayload = JSON.stringify(res.body);
    expect(errPayload).toMatch(/expir/i);
  }, 60000);

  it('mauvais transporteur : TRANSPORTER B scanne un shipment assigné à TRANSPORTER A → 403', async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer QR Wrong',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer QR Wrong',
      role: 'BUYER',
    });
    const transporterA = await registerAndGetToken(app, {
      full_name: 'Transporter A QR',
      role: 'TRANSPORTER',
    });
    const transporterB = await registerAndGetToken(app, {
      full_name: 'Transporter B QR',
      role: 'TRANSPORTER',
    });

    // Shipment assigné à transporter A
    const { shipment_id } = await seedCommandeWithShipment(prisma, {
      farmerId: farmer.userId,
      buyerId: buyer.userId,
      transporterId: transporterA.userId,
      produitId: catalog.produit_id,
    });

    // FARMER génère un QR légitime
    const tokenRes = await request(app.getHttpServer())
      .get(`/api/logistics/shipments/${shipment_id}/qr-token`)
      .set(bearer(farmer.token))
      .expect(200);
    const token = tokenRes.body.data.token;

    // Transporter B (pas assigné) tente de scanner → 403
    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/scan-pickup`)
      .set(bearer(transporterB.token))
      .send({
        token,
        scan_position: { lat: 5.345317, lng: -4.024429 },
      })
      .expect(403);

    // Le shipment reste en ACCEPTED (pas de bascule LOADING)
    const shipmentAfter = await prisma.shipments.findUnique({
      where: { id: shipment_id },
    });
    expect(shipmentAfter!.status).toBe('ACCEPTED');
  }, 60000);
});
