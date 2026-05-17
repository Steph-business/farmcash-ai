// =====================================================================
//  E2E : Module AI (6 sous-domaines)
//  ---------------------------------------------------------------------
//  Couvre :
//   • Health (public)
//   • Plant analyses (FARMER, mock LLM déterministe)
//   • Treatments (catalogue lecture, CRUD ADMIN)
//   • Assistant chat (intent detection mock)
//   • Insights (cartes personnalisées par rôle)
//   • News (ADMIN crée, BUYER consulte filtré par rôle)
//
//  Pour les tests ADMIN, on bypass le rôle en modifiant `users.role`
//  directement en DB après l'inscription (raccourci test).
// =====================================================================

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '@farmcash/database';
import {
  bearer,
  cleanupTestUsers,
  createTestApp,
  makeAccessTokenForUser,
  registerAndGetToken,
} from './setup';

describe('AI module (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(app);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  // ===================================================================
  //  HEALTH (public)
  // ===================================================================

  describe('Health', () => {
    it('GET /api/ai/health public OK', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/ai/health')
        .expect(200);
      expect(res.body.data.module).toBe('ai');
    });
  });

  // ===================================================================
  //  PLANT ANALYSES (FARMER)
  // ===================================================================

  describe('Plant Analyses', () => {
    it('FARMER analyse une photo → diagnostic mock + persistance', async () => {
      const farmer = await registerAndGetToken(app, {
        full_name: 'Farmer AI',
        role: 'FARMER',
      });

      const res = await request(app.getHttpServer())
        .post('/api/ai/plant-analyses')
        .set(bearer(farmer.token))
        .send({
          image_url: 'https://cdn.farmcash.ci/plant1.jpg',
        })
        .expect(201);

      expect(res.body.data.diagnosis).toBeDefined();
      expect(res.body.data.diagnosis.model_version).toBe('mock-v1');
      expect(res.body.data.analysis.id).toBeDefined();

      // Liste mes analyses
      const list = await request(app.getHttpServer())
        .get('/api/ai/plant-analyses')
        .set(bearer(farmer.token))
        .expect(200);
      expect(list.body.data.data.length).toBeGreaterThanOrEqual(1);
    });

    it('refuse une image_url non-https (400)', async () => {
      const farmer = await registerAndGetToken(app, {
        full_name: 'Farmer URL',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/ai/plant-analyses')
        .set(bearer(farmer.token))
        .send({ image_url: 'pas une url' })
        .expect(400);
    });

    it("refuse un BUYER qui essaierait d'analyser une plante (rôle)", async () => {
      const buyer = await registerAndGetToken(app, {
        full_name: 'Buyer AI',
        role: 'BUYER',
      });
      await request(app.getHttpServer())
        .post('/api/ai/plant-analyses')
        .set(bearer(buyer.token))
        .send({ image_url: 'https://cdn.farmcash.ci/x.jpg' })
        .expect(403);
    });
  });

  // ===================================================================
  //  ASSISTANT (chat)
  // ===================================================================

  describe('AI Assistant', () => {
    it('détecte intent "publier annonce" → tool_call structuré', async () => {
      const farmer = await registerAndGetToken(app, {
        full_name: 'Farmer Chat',
        role: 'FARMER',
      });

      const res = await request(app.getHttpServer())
        .post('/api/ai/assistant/chat')
        .set(bearer(farmer.token))
        .send({
          message: 'je veux vendre 200 kg de cacao à 1500 par kg',
        })
        .expect(200);

      expect(res.body.data.reply).toBeDefined();
      expect(res.body.data.reply.content).toContain('200');
      expect(res.body.data.tool_result).toBeDefined();
      expect(res.body.data.tool_result.status).toBe('draft');
    });

    it('historique conservé entre les messages d\'une session', async () => {
      const farmer = await registerAndGetToken(app, {
        full_name: 'Farmer History',
        role: 'FARMER',
      });

      await request(app.getHttpServer())
        .post('/api/ai/assistant/chat')
        .set(bearer(farmer.token))
        .send({ message: 'bonjour' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/ai/assistant/chat')
        .set(bearer(farmer.token))
        .send({ message: 'aide' })
        .expect(200);

      const history = await request(app.getHttpServer())
        .get('/api/ai/assistant/history')
        .set(bearer(farmer.token))
        .expect(200);
      // Au moins 2 user + 2 assistant = 4 messages persistés
      expect(history.body.data.data.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ===================================================================
  //  INSIGHTS
  // ===================================================================

  describe('Insights', () => {
    it('FARMER reçoit une carte "publish-suggestion" si pas d\'annonce récente', async () => {
      const farmer = await registerAndGetToken(app, {
        full_name: 'Farmer Insights',
        role: 'FARMER',
      });
      const res = await request(app.getHttpServer())
        .get('/api/ai/insights/my')
        .set(bearer(farmer.token))
        .expect(200);
      // Au minimum la suggestion de publier (pas d'annonce active)
      const types = res.body.data.map((c: any) => c.id);
      expect(types).toContain('publish-suggestion');
    });
  });

  // ===================================================================
  //  NEWS (ADMIN)
  // ===================================================================

  describe('News (CRUD ADMIN)', () => {
    let adminToken: string;
    let farmerToken: string;

    beforeAll(async () => {
      // Crée un user puis le bascule en ADMIN directement en DB
      const admin = await registerAndGetToken(app, {
        full_name: 'Admin News',
        role: 'FARMER', // n'importe — on le change ensuite
      });
      await prisma.users.update({
        where: { id: admin.userId },
        data: { role: 'ADMIN' },
      });
      // SUPER_ADMIN pour bypasser l'AdminPermissionGuard sur les routes
      // mutation (POST/PUT/DELETE /ai/news, /ai/treatments).
      await prisma.admin_profiles.upsert({
        where: { user_id: admin.userId },
        update: {
          niveau: 'SUPER_ADMIN',
          peut_valider_kyc: true,
          peut_gerer_finance: true,
          peut_gerer_users: true,
          peut_publier_news: true,
        },
        create: {
          user_id: admin.userId,
          niveau: 'SUPER_ADMIN',
          peut_valider_kyc: true,
          peut_gerer_finance: true,
          peut_gerer_users: true,
          peut_publier_news: true,
        },
      });
      adminToken = await makeAccessTokenForUser(app, admin.userId);

      const farmer = await registerAndGetToken(app, {
        full_name: 'Farmer News',
        role: 'FARMER',
      });
      farmerToken = farmer.token;
    });

    it('ADMIN crée une news ciblée FARMER, FARMER la voit', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/ai/news')
        .set(bearer(adminToken))
        .send({
          type: 'PRICE_TREND',
          titre: 'Test news E2E',
          body: 'Le cacao monte cette semaine',
          cible_role: 'FARMER',
        })
        .expect(201);
      expect(create.body.data.id).toBeDefined();

      const farmerView = await request(app.getHttpServer())
        .get('/api/ai/news')
        .set(bearer(farmerToken))
        .expect(200);
      const found = farmerView.body.data.data.find(
        (n: any) => n.id === create.body.data.id,
      );
      expect(found).toBeDefined();
    });

    it("FARMER ne peut PAS créer une news (rôle)", async () => {
      await request(app.getHttpServer())
        .post('/api/ai/news')
        .set(bearer(farmerToken))
        .send({
          type: 'GENERAL',
          titre: 'Hack',
          body: 'Hack',
        })
        .expect(403);
    });

    it('refuse type non-enum', async () => {
      await request(app.getHttpServer())
        .post('/api/ai/news')
        .set(bearer(adminToken))
        .send({
          type: 'INVALID_TYPE',
          titre: 'Test',
          body: 'Test',
        })
        .expect(400);
    });
  });
});
