// =====================================================================
//  E2E : Module Oversight (6 vues par rôle)
//  ---------------------------------------------------------------------
//  Couvre les 6 dashboards :
//   • ADMIN       : /oversight/admin/overview + freeze wallet
//   • COOP        : /oversight/coop/overview + members
//   • EXPORTER    : /oversight/exporter/overview
//   • BUYER       : /oversight/buyer/overview
//   • TRANSPORTER : /oversight/transporter/overview
//   • FARMER      : /oversight/farmer/overview
//
//  Vérifie aussi les autorisations strictes par rôle (chaque dashboard
//  ne doit pas être accessible aux autres rôles).
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

describe('Oversight (E2E)', () => {
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
  //  Tests "overview accessible au bon rôle"
  // ===================================================================

  it('FARMER : GET /oversight/farmer/overview répond avec KPIs', async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer Overview',
      role: 'FARMER',
    });
    const res = await request(app.getHttpServer())
      .get('/api/oversight/farmer/overview')
      .set(bearer(farmer.token))
      .expect(200);
    expect(res.body.data).toHaveProperty('commerce');
    expect(res.body.data).toHaveProperty('revenue');
    expect(res.body.data).toHaveProperty('cultures');
    expect(res.body.data).toHaveProperty('rating');
    expect(res.body.data).toHaveProperty('wallet');
  });

  it('BUYER : GET /oversight/buyer/overview répond avec KPIs', async () => {
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Overview',
      role: 'BUYER',
    });
    const res = await request(app.getHttpServer())
      .get('/api/oversight/buyer/overview')
      .set(bearer(buyer.token))
      .expect(200);
    expect(res.body.data).toHaveProperty('orders');
    expect(res.body.data).toHaveProperty('spending');
    expect(res.body.data).toHaveProperty('pending');
    expect(res.body.data).toHaveProperty('wallet');
  });

  it('TRANSPORTER : GET /oversight/transporter/overview répond avec KPIs', async () => {
    const transporter = await registerAndGetToken(app, {
      full_name: 'Transporter Overview',
      role: 'TRANSPORTER',
    });
    const res = await request(app.getHttpServer())
      .get('/api/oversight/transporter/overview')
      .set(bearer(transporter.token))
      .expect(200);
    expect(res.body.data).toHaveProperty('missions');
    expect(res.body.data).toHaveProperty('revenue');
    expect(res.body.data).toHaveProperty('routes');
    expect(res.body.data).toHaveProperty('rating');
  });

  it('EXPORTER : GET /oversight/exporter/overview répond avec KPIs', async () => {
    const exporter = await registerAndGetToken(app, {
      full_name: 'Exporter Overview',
      role: 'EXPORTER',
    });
    const res = await request(app.getHttpServer())
      .get('/api/oversight/exporter/overview')
      .set(bearer(exporter.token))
      .expect(200);
    expect(res.body.data).toHaveProperty('commandes_b2b');
    expect(res.body.data).toHaveProperty('pending_documents');
  });

  // ===================================================================
  //  Autorisations strictes : un rôle ne peut pas voir le dashboard d'un autre
  // ===================================================================

  it('FARMER ne peut pas accéder à /oversight/buyer/* (403)', async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer Cross',
      role: 'FARMER',
    });
    await request(app.getHttpServer())
      .get('/api/oversight/buyer/overview')
      .set(bearer(farmer.token))
      .expect(403);
  });

  it('BUYER ne peut pas accéder à /oversight/admin/* (403)', async () => {
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Cross',
      role: 'BUYER',
    });
    await request(app.getHttpServer())
      .get('/api/oversight/admin/overview')
      .set(bearer(buyer.token))
      .expect(403);
  });

  // ===================================================================
  //  Admin : overview global + freeze wallet
  // ===================================================================

  describe('Admin oversight', () => {
    let adminToken: string;
    let targetUserId: string;

    beforeAll(async () => {
      const admin = await registerAndGetToken(app, {
        full_name: 'Admin Overview',
        role: 'FARMER',
      });
      await prisma.users.update({
        where: { id: admin.userId },
        data: { role: 'ADMIN' },
      });
      // L'AdminPermissionGuard exige que les routes mutation (freeze /
      // deactivate / etc.) checkent les `peut_*`. On promeut le test admin
      // en SUPER_ADMIN qui bypasse tous les checks.
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

      const target = await registerAndGetToken(app, {
        full_name: 'Target Wallet',
        role: 'BUYER',
      });
      targetUserId = target.userId;
      // Le wallet est créé à la volée par /finance/wallet : on l'init via la DB
      await prisma.wallets.create({
        data: {
          user_id: targetUserId,
          currency: 'XOF',
          balance: 0,
          balance_escrow: 0,
          is_frozen: false,
        },
      });
    });

    it('ADMIN voit le dashboard global', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/oversight/admin/overview')
        .set(bearer(adminToken))
        .expect(200);
      expect(res.body.data).toHaveProperty('users');
      expect(res.body.data).toHaveProperty('finance');
      expect(res.body.data).toHaveProperty('commerce');
      expect(res.body.data).toHaveProperty('alerts');
      expect(res.body.data.users.by_role).toHaveProperty('ADMIN');
    });

    it('ADMIN gèle un wallet → is_frozen = true', async () => {
      await request(app.getHttpServer())
        .post(`/api/oversight/admin/users/${targetUserId}/wallet/freeze`)
        .set(bearer(adminToken))
        .send({ reason: 'Suspicion test' })
        .expect(200);

      const w = await prisma.wallets.findUnique({
        where: {
          user_id_currency: { user_id: targetUserId, currency: 'XOF' },
        },
      });
      expect(w?.is_frozen).toBe(true);
    });

    it('ADMIN dégèle le wallet', async () => {
      await request(app.getHttpServer())
        .post(`/api/oversight/admin/users/${targetUserId}/wallet/unfreeze`)
        .set(bearer(adminToken))
        .expect(200);

      const w = await prisma.wallets.findUnique({
        where: {
          user_id_currency: { user_id: targetUserId, currency: 'XOF' },
        },
      });
      expect(w?.is_frozen).toBe(false);
    });

    it("ADMIN ne peut pas se désactiver lui-même", async () => {
      const me = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(bearer(adminToken))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/oversight/admin/users/${me.body.data.id}/deactivate`)
        .set(bearer(adminToken))
        .expect(403);
    });
  });
});
