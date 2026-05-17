// =====================================================================
//  E2E : Chantier 5.a — Phone proxy (Twilio)
//  ---------------------------------------------------------------------
//  Couvre :
//   1. POST /api/messaging/phone-proxy crée une session et retourne
//      un proxy_phone + expires_at + session_id.
//      → Setup : BUYER + FARMER avec commande ACCEPTED entre eux (sinon
//        la visibility tombe à MIN et le service refuse en 403).
//   2. Webhook Twilio simulé : POST /api/messaging/phone-proxy/webhook
//      avec SessionSid de la session créée → 200 et call_count++.
// =====================================================================

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  bearer,
  cleanupTestUsers,
  createTestApp,
  getCatalogIds,
  publishAnnonceVente,
  registerAndGetToken,
} from './setup';
import { PrismaService } from '@farmcash/database';

describe('Phone Proxy (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await cleanupTestUsers(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  /**
   * Crée une commande ACCEPTED entre 2 users directement en DB pour
   * débloquer la visibility PARTIAL côté MaskingService. On crée d'abord
   * une annonce (la contrainte chk_commande_source exige qu'au moins
   * annonce_id, publication_coop_id ou lot_id soit non-null).
   */
  async function createAcceptedOrderInDb(
    buyerId: string,
    sellerId: string,
    sellerToken: string,
  ): Promise<string> {
    const catalog = await getCatalogIds(app);
    const annonceId = await publishAnnonceVente(app, sellerToken, catalog, {
      titre: `Proxy test annonce ${Date.now()}`,
    });
    const ref = `TEST-PROXY-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const cmd = await prisma.commandes_vente.create({
      data: {
        buyer_id: buyerId,
        seller_id: sellerId,
        annonce_id: annonceId,
        reference: ref,
        quantite_kg: 100,
        prix_unitaire_kg: 1000,
        montant_total: 100000,
        montant_net: 100000,
        status: 'ACCEPTED',
      },
    });
    return cmd.id;
  }

  it(
    '1. POST /api/messaging/phone-proxy crée une session et retourne un proxy_number',
    async () => {
      const buyer = await registerAndGetToken(app, {
        full_name: 'Proxy Buyer',
        role: 'BUYER',
      });
      const farmer = await registerAndGetToken(app, {
        full_name: 'Proxy Farmer',
        role: 'FARMER',
      });
      // Commande ACCEPTED → la visibility passe à PARTIAL (BUYER↔FARMER)
      await createAcceptedOrderInDb(buyer.userId, farmer.userId, farmer.token);

      const res = await request(app.getHttpServer())
        .post('/api/messaging/phone-proxy')
        .set(bearer(buyer.token))
        .send({ callee_user_id: farmer.userId })
        .expect(201);

      expect(res.body.data.proxy_phone).toMatch(/^\+225/);
      expect(res.body.data.session_id).toBeDefined();
      expect(res.body.data.expires_at).toBeDefined();
    },
    60000,
  );

  it(
    '2. Webhook Twilio simulé : POST /webhook → 200 et call_count incrémenté',
    async () => {
      const buyer = await registerAndGetToken(app, {
        full_name: 'Webhook Buyer',
        role: 'BUYER',
      });
      const farmer = await registerAndGetToken(app, {
        full_name: 'Webhook Farmer',
        role: 'FARMER',
      });
      await createAcceptedOrderInDb(buyer.userId, farmer.userId, farmer.token);

      // Crée d'abord la session proxy pour récupérer son provider_session_id
      const createRes = await request(app.getHttpServer())
        .post('/api/messaging/phone-proxy')
        .set(bearer(buyer.token))
        .send({ callee_user_id: farmer.userId })
        .expect(201);
      const sessionId = createRes.body.data.session_id;

      // Lit le provider_session_id en DB (c'est ce que Twilio enverrait dans SessionSid)
      const dbSession = await prisma.phone_proxy_sessions.findUnique({
        where: { id: sessionId },
      });
      expect(dbSession).not.toBeNull();
      const providerSid = dbSession!.provider_session_id!;
      expect(providerSid).toBeDefined();

      // Simule un webhook Twilio "call.completed" (pas de signature HMAC en MVP)
      await request(app.getHttpServer())
        .post('/api/messaging/phone-proxy/webhook')
        .send({
          EventType: 'call-completed',
          SessionSid: providerSid,
          CallSid: `CA${Date.now()}`,
          CallDuration: '42',
          CallStatus: 'completed',
        })
        .expect(200);

      // Vérifie que call_count a été incrémenté et la durée enregistrée
      const updated = await prisma.phone_proxy_sessions.findUnique({
        where: { id: sessionId },
      });
      expect(updated!.call_count).toBe(1);
      expect(updated!.total_duration_sec).toBe(42);
      expect(updated!.last_call_at).not.toBeNull();
    },
    60000,
  );
});
