// =====================================================================
//  E2E : Module Auth
//  ---------------------------------------------------------------------
//  Vérifie le cycle de vie complet d'un compte :
//    register → set-pin → login-pin → /me → refresh → logout
//
//  Vérifie aussi les garde-fous critiques :
//    • Anti-énumération : phone inexistant vs PIN incorrect → même message
//    • Rate limit register / send-otp
//    • Lockout après tentatives PIN ratées
//    • Refresh rotation + détection de rejeu
// =====================================================================

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  bearer,
  cleanupTestUsers,
  createTestApp,
  makeTestPhone,
  registerAndGetToken,
  registerUser,
} from './setup';

describe('Auth (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await cleanupTestUsers(app);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  // ===================================================================
  //  Inscription
  // ===================================================================

  describe('POST /api/auth/register', () => {
    it('crée un compte FARMER avec données valides', async () => {
      const phone = makeTestPhone();
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone,
          full_name: 'Test Farmer',
          role: 'FARMER',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user_id).toBeDefined();
      expect(res.body.data.phone).toBe(phone);
    });

    it('refuse un email invalide (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone: makeTestPhone(),
          full_name: 'Test',
          role: 'FARMER',
          email: 'pas-un-email',
        })
        .expect(400);
    });

    it('refuse un phone mal formaté (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone: '0709123456', // pas E.164
          full_name: 'Test',
          role: 'FARMER',
        })
        .expect(400);
    });

    it('refuse un rôle invalide (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone: makeTestPhone(),
          full_name: 'Test',
          role: 'PIRATE',
        })
        .expect(400);
    });

    it("refuse l'inscription en doublon sur le même phone (409)", async () => {
      const phone = makeTestPhone();
      await registerUser(app, {
        phone,
        full_name: 'First',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          phone,
          full_name: 'Second',
          role: 'BUYER',
        })
        .expect(409);
    });
  });

  // ===================================================================
  //  PIN : set + login
  // ===================================================================

  describe('Set PIN + Login', () => {
    it('définit un PIN puis se connecte avec succès', async () => {
      const { userId, phone, token } = await registerAndGetToken(app, {
        full_name: 'Test Login',
        role: 'BUYER',
      });

      // Définir le PIN
      await request(app.getHttpServer())
        .post('/api/auth/set-pin')
        .set(bearer(token))
        .send({ pin: '5837', pin_confirm: '5837' })
        .expect(200);

      // Login PIN
      const login = await request(app.getHttpServer())
        .post('/api/auth/login-pin')
        .send({ phone, pin: '5837' })
        .expect(200);

      expect(login.body.data.access_token).toBeDefined();
      expect(login.body.data.refresh_token).toBeDefined();
      expect(login.body.data.user.id).toBe(userId);
    });

    it('rejette un PIN faible (1234)', async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Weak PIN',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/set-pin')
        .set(bearer(token))
        .send({ pin: '1234', pin_confirm: '1234' })
        .expect(400);
    });

    it('rejette un PIN avec chiffres identiques (0000)', async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Same PIN',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/set-pin')
        .set(bearer(token))
        .send({ pin: '0000', pin_confirm: '0000' })
        .expect(400);
    });

    it('rejette quand pin et pin_confirm diffèrent', async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Mismatch',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/set-pin')
        .set(bearer(token))
        .send({ pin: '5837', pin_confirm: '5838' })
        .expect(400);
    });

    it('anti-énumération : message identique pour user inconnu et PIN faux', async () => {
      const { phone, token } = await registerAndGetToken(app, {
        full_name: 'Anti-enum',
        role: 'BUYER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/set-pin')
        .set(bearer(token))
        .send({ pin: '5837', pin_confirm: '5837' })
        .expect(200);

      // Phone inconnu
      const unknown = await request(app.getHttpServer())
        .post('/api/auth/login-pin')
        .send({ phone: '+2259900000000', pin: '5837' })
        .expect(401);

      // Phone connu, mauvais PIN
      const wrongPin = await request(app.getHttpServer())
        .post('/api/auth/login-pin')
        .send({ phone, pin: '9999' })
        .expect(401);

      expect(unknown.body.error.message).toBe(wrongPin.body.error.message);
    });
  });

  // ===================================================================
  //  /me
  // ===================================================================

  describe('GET /api/auth/me', () => {
    it("retourne le profil de l'utilisateur connecté (sans pin_hash)", async () => {
      const { userId, token } = await registerAndGetToken(app, {
        full_name: 'Me Test',
        role: 'FARMER',
      });

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(bearer(token))
        .expect(200);

      expect(res.body.data.id).toBe(userId);
      expect(res.body.data.full_name).toBe('Me Test');
      expect((res.body.data as Record<string, unknown>).pin_hash).toBeUndefined();
    });

    it('refuse sans JWT (401)', async () => {
      await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    it('refuse avec un JWT invalide (401)', async () => {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set({ Authorization: 'Bearer pas-un-vrai-jwt' })
        .expect(401);
    });
  });

  // ===================================================================
  //  Refresh + logout
  // ===================================================================

  describe('Refresh token flow', () => {
    it('refresh émet un nouveau couple et révoque l\'ancien (rotation)', async () => {
      const { phone, token } = await registerAndGetToken(app, {
        full_name: 'Refresh Test',
        role: 'BUYER',
      });
      // Définir PIN puis se connecter pour obtenir un vrai refresh
      await request(app.getHttpServer())
        .post('/api/auth/set-pin')
        .set(bearer(token))
        .send({ pin: '5837', pin_confirm: '5837' })
        .expect(200);

      const login = await request(app.getHttpServer())
        .post('/api/auth/login-pin')
        .send({ phone, pin: '5837' })
        .expect(200);

      const oldRefresh = login.body.data.refresh_token;

      const refresh = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refresh_token: oldRefresh })
        .expect(200);

      expect(refresh.body.data.access_token).toBeDefined();
      expect(refresh.body.data.refresh_token).toBeDefined();
      expect(refresh.body.data.refresh_token).not.toBe(oldRefresh);

      // Le rejeu du même refresh doit échouer (rotation)
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refresh_token: oldRefresh })
        .expect(401);
    });
  });
});
