// =====================================================================
//  E2E : Sécurisation création d'admins (bootstrap + register)
//  ---------------------------------------------------------------------
//  Vérifie :
//   • POST /auth/register refuse role=ADMIN (400 au DTO)
//   • POST /auth/admin/bootstrap :
//       - 403 si X-Bootstrap-Token absent
//       - 403 si X-Bootstrap-Token incorrect
//       - 403 si un admin existe déjà en base
//   • POST /auth/admin/register :
//       - 401 sans token
//       - 403 si appelant pas ADMIN
//       - 403 si ADMIN mais pas SUPER_ADMIN
//       - 201 si appelant SUPER_ADMIN
//       - 409 si phone déjà utilisé
//
//  Note : le test "bootstrap success" est volontairement OMIS — il
//  nécessiterait une base SANS aucun admin, ce qui n'est garanti que
//  sur une DB fraîche. Le path nominal est néanmoins indirectement
//  validé par /auth/admin/register (qui partage la même logique de
//  création d'admin_profiles).
// =====================================================================

// IMPORTANT : définis l'env AVANT d'importer setup.ts (qui importe AppModule).
process.env.DISABLE_THROTTLE = 'true';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'e2e-test-bootstrap-token-do-not-use-in-prod';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '@farmcash/database';
import {
  bearer,
  cleanupTestUsers,
  createTestApp,
  makeAccessTokenForUser,
  makeTestPhone,
  registerAndGetToken,
  registerUser,
} from './setup';

const BOOTSTRAP_TOKEN = 'e2e-test-bootstrap-token-do-not-use-in-prod';

describe('Admin bootstrap & register (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminId: string;
  let superAdminToken: string;
  let normalAdminId: string;
  let normalAdminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(app);

    // ─── Prépare un SUPER_ADMIN de test (promu directement en DB) ──────
    // On simule l'état post-bootstrap pour pouvoir tester /admin/register.
    const suPhone = makeTestPhone();
    const { user_id: suId } = await registerUser(app, {
      phone: suPhone,
      full_name: 'Test SuperAdmin',
      role: 'FARMER',
    });
    await prisma.users.update({ where: { id: suId }, data: { role: 'ADMIN' } });
    await prisma.admin_profiles.upsert({
      where: { user_id: suId },
      update: {
        niveau: 'SUPER_ADMIN',
        peut_valider_kyc: true,
        peut_gerer_finance: true,
        peut_gerer_users: true,
        peut_publier_news: true,
      },
      create: {
        user_id: suId,
        niveau: 'SUPER_ADMIN',
        peut_valider_kyc: true,
        peut_gerer_finance: true,
        peut_gerer_users: true,
        peut_publier_news: true,
      },
    });
    superAdminId = suId;
    superAdminToken = await makeAccessTokenForUser(app, suId);

    // ─── Prépare un ADMIN niveau ADMIN (pas SUPER) pour tester l'escalation ──
    const naPhone = makeTestPhone();
    const { user_id: naId } = await registerUser(app, {
      phone: naPhone,
      full_name: 'Test NormalAdmin',
      role: 'FARMER',
    });
    await prisma.users.update({ where: { id: naId }, data: { role: 'ADMIN' } });
    await prisma.admin_profiles.upsert({
      where: { user_id: naId },
      update: { niveau: 'ADMIN' },
      create: { user_id: naId, niveau: 'ADMIN' },
    });
    normalAdminId = naId;
    normalAdminToken = await makeAccessTokenForUser(app, naId);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  // ===================================================================
  //  POST /auth/register avec role=ADMIN
  // ===================================================================

  describe('POST /auth/register avec role=ADMIN', () => {
    it('rejette ADMIN à la validation DTO (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone: makeTestPhone(),
          full_name: 'Should be rejected',
          role: 'ADMIN',
        })
        .expect(400);
    });

    it('accepte toujours les autres rôles (FARMER OK)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone: makeTestPhone(),
          full_name: 'Valid farmer',
          role: 'FARMER',
        })
        .expect(201);
    });
  });

  // ===================================================================
  //  POST /auth/admin/bootstrap
  // ===================================================================

  describe('POST /auth/admin/bootstrap', () => {
    it('refuse sans header X-Bootstrap-Token (403)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/admin/bootstrap')
        .send({
          phone: makeTestPhone(),
          full_name: 'Should fail',
        })
        .expect(403);
    });

    it('refuse avec un X-Bootstrap-Token incorrect (403)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/admin/bootstrap')
        .set('X-Bootstrap-Token', 'wrong-token-value')
        .send({
          phone: makeTestPhone(),
          full_name: 'Should fail',
        })
        .expect(403);
    });

    it('refuse si un admin existe déjà (403)', async () => {
      // Le beforeAll a créé un SUPER_ADMIN → bootstrap doit refuser
      // même avec le bon token.
      await request(app.getHttpServer())
        .post('/api/auth/admin/bootstrap')
        .set('X-Bootstrap-Token', BOOTSTRAP_TOKEN)
        .send({
          phone: makeTestPhone(),
          full_name: 'Should fail (admin exists)',
        })
        .expect(403);
    });

    it('refuse phone mal formaté (400) — validation DTO', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/admin/bootstrap')
        .set('X-Bootstrap-Token', BOOTSTRAP_TOKEN)
        .send({
          phone: '0709123456', // pas E.164
          full_name: 'Should fail',
        })
        .expect(400);
    });
  });

  // ===================================================================
  //  POST /auth/admin/register
  // ===================================================================

  describe('POST /auth/admin/register', () => {
    it('refuse sans token (401)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .send({
          phone: makeTestPhone(),
          full_name: 'Should fail',
        })
        .expect(401);
    });

    it("refuse si l'appelant n'est pas ADMIN (403)", async () => {
      // Crée un FARMER + token, puis tente d'appeler /admin/register
      const { token } = await registerAndGetToken(app, {
        full_name: 'Curious Farmer',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .set(bearer(token))
        .send({
          phone: makeTestPhone(),
          full_name: 'Should fail',
        })
        .expect(403);
    });

    it("refuse si l'appelant est ADMIN mais pas SUPER_ADMIN (403)", async () => {
      await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .set(bearer(normalAdminToken))
        .send({
          phone: makeTestPhone(),
          full_name: 'Should fail (caller not SUPER)',
          niveau: 'MODERATOR',
        })
        .expect(403);
    });

    it('crée un MODERATOR quand appelé par un SUPER_ADMIN (201)', async () => {
      const phone = makeTestPhone();
      const res = await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .set(bearer(superAdminToken))
        .send({
          phone,
          full_name: 'Test Moderator',
          email: `${phone.replace('+', '')}@farmcash-test.ci`,
          niveau: 'MODERATOR',
          departement: 'Modération',
          peut_publier_news: true,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user_id).toBeDefined();
      expect(res.body.data.niveau).toBe('MODERATOR');

      // Vérifie en DB que role + admin_profiles sont bien créés
      const created = await prisma.users.findUnique({
        where: { id: res.body.data.user_id },
        include: { admin_profiles: true },
      });
      expect(created?.role).toBe('ADMIN');
      expect(created?.admin_profiles?.niveau).toBe('MODERATOR');
      expect(created?.admin_profiles?.departement).toBe('Modération');
      expect(created?.admin_profiles?.peut_publier_news).toBe(true);
      // Les autres permissions doivent rester false par défaut
      expect(created?.admin_profiles?.peut_valider_kyc).toBe(false);
      expect(created?.admin_profiles?.peut_gerer_finance).toBe(false);
      expect(created?.admin_profiles?.peut_gerer_users).toBe(false);
    });

    it('crée un ADMIN par défaut si niveau non précisé (201)', async () => {
      const phone = makeTestPhone();
      const res = await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .set(bearer(superAdminToken))
        .send({
          phone,
          full_name: 'Default Admin',
        })
        .expect(201);

      expect(res.body.data.niveau).toBe('ADMIN');
    });

    it('refuse phone déjà utilisé (409)', async () => {
      const phone = makeTestPhone();
      await registerUser(app, {
        phone,
        full_name: 'Existing user',
        role: 'FARMER',
      });

      await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .set(bearer(superAdminToken))
        .send({
          phone,
          full_name: 'Try to duplicate',
        })
        .expect(409);
    });

    it('refuse niveau invalide (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/admin/register')
        .set(bearer(superAdminToken))
        .send({
          phone: makeTestPhone(),
          full_name: 'Bad niveau',
          niveau: 'GOD_MODE', // pas dans l'enum
        })
        .expect(400);
    });
  });
});
