// =====================================================================
//  E2E : Profils étendus (transporteur / exportateur / admin)
//  ---------------------------------------------------------------------
//  Couvre les 3 nouvelles routes ajoutées le 2026-05-16 :
//
//   • POST /auth/profile/transporteur
//       - Premier onboarding : refuse si numero_permis/type_vehicule/
//         immatriculation/capacite_max_kg manquent (400)
//       - Crée le profil quand tous les champs requis sont fournis (200)
//       - PATCH partiel ensuite (upsert)
//       - Refus si appelant n'est pas TRANSPORTER (403)
//       - Refus si immatriculation déjà utilisée (409)
//
//   • POST /auth/profile/exportateur
//       - 100% optionnel → profil créable vide (200)
//       - PATCH partiel après création
//       - Refus si appelant n'est pas EXPORTER (403)
//
//   • POST /auth/profile/admin
//       - ADMIN niveau ADMIN peut modifier departement/notes (200)
//       - ADMIN niveau ADMIN ne peut PAS modifier niveau (403)
//       - ADMIN niveau ADMIN ne peut PAS modifier permissions peut_* (403)
//       - SUPER_ADMIN peut tout modifier (200)
//       - Refus si appelant n'est pas ADMIN (403)
// =====================================================================

process.env.DISABLE_THROTTLE = 'true';

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

describe('Profils étendus — transporteur / exportateur / admin (E2E)', () => {
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
  //  POST /auth/profile/transporteur
  // ===================================================================

  describe('POST /auth/profile/transporteur', () => {
    let transporterToken: string;
    let transporterId: string;

    beforeAll(async () => {
      const { userId, token } = await registerAndGetToken(app, {
        full_name: 'Test Transporteur',
        role: 'TRANSPORTER',
      });
      transporterToken = token;
      transporterId = userId;
    });

    it('refuse premier onboarding sans champs requis (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/transporteur')
        .set(bearer(transporterToken))
        .send({
          nom_entreprise: 'Mon Transport SARL',
          // manque : numero_permis, type_vehicule, immatriculation, capacite_max_kg
        })
        .expect(400);

      // Le message doit lister les champs manquants
      const msg = JSON.stringify(res.body);
      expect(msg).toContain('numero_permis');
      expect(msg).toContain('type_vehicule');
      expect(msg).toContain('immatriculation');
      expect(msg).toContain('capacite_max_kg');
    });

    it('crée le profil avec tous les champs requis (200)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/transporteur')
        .set(bearer(transporterToken))
        .send({
          numero_permis: 'CI-PERM-2020-111111',
          type_vehicule: 'CAMION',
          immatriculation: 'TEST-9999-AB-01',
          capacite_max_kg: 3000,
          marque_modele: 'Isuzu N-Series 2020',
          annee_vehicule: 2020,
          is_bache: true,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user_id).toBe(transporterId);
      expect(res.body.data.type_vehicule).toBe('CAMION');
      expect(res.body.data.immatriculation).toBe('TEST-9999-AB-01');
      expect(Number(res.body.data.capacite_max_kg)).toBe(3000);
      expect(res.body.data.is_bache).toBe(true);
      expect(res.body.data.is_refrigere).toBe(false); // default
    });

    it('PATCH partiel ensuite (200) — change un seul champ', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/transporteur')
        .set(bearer(transporterToken))
        .send({
          disponible: false,
        })
        .expect(200);

      expect(res.body.data.disponible).toBe(false);
      // Les autres champs restent inchangés
      expect(res.body.data.type_vehicule).toBe('CAMION');
      expect(res.body.data.immatriculation).toBe('TEST-9999-AB-01');
    });

    it("refuse si l'appelant n'est pas TRANSPORTER (403)", async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Farmer Curieux',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/profile/transporteur')
        .set(bearer(token))
        .send({
          numero_permis: 'CI-PERM-2020-222222',
          type_vehicule: 'PICKUP',
          immatriculation: 'OTHER-1234-CD-02',
          capacite_max_kg: 500,
        })
        .expect(403);
    });

    it('refuse immatriculation déjà utilisée (409)', async () => {
      // Crée un 2e transporteur qui tente de réutiliser une immat existante
      const { token: token2 } = await registerAndGetToken(app, {
        full_name: 'Second Transporteur',
        role: 'TRANSPORTER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/profile/transporteur')
        .set(bearer(token2))
        .send({
          numero_permis: 'CI-PERM-2020-333333',
          type_vehicule: 'FOURGON',
          immatriculation: 'TEST-9999-AB-01', // ← déjà prise
          capacite_max_kg: 1500,
        })
        .expect(409);
    });

    it('refuse type_vehicule invalide (400)', async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Bad Type Transporteur',
        role: 'TRANSPORTER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/profile/transporteur')
        .set(bearer(token))
        .send({
          numero_permis: 'CI-PERM-XYZ',
          type_vehicule: 'AVION', // pas dans l'enum
          immatriculation: 'XYZ-0000-00',
          capacite_max_kg: 100,
        })
        .expect(400);
    });
  });

  // ===================================================================
  //  POST /auth/profile/exportateur
  // ===================================================================

  describe('POST /auth/profile/exportateur', () => {
    let exporterToken: string;
    let exporterId: string;

    beforeAll(async () => {
      const { userId, token } = await registerAndGetToken(app, {
        full_name: 'Test Exportateur',
        role: 'EXPORTER',
      });
      exporterToken = token;
      exporterId = userId;
    });

    it('crée un profil vide (200) — tous les champs optionnels', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/exportateur')
        .set(bearer(exporterToken))
        .send({}) // body vide
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user_id).toBe(exporterId);
      expect(res.body.data.produits_exportes).toEqual([]);
      expect(res.body.data.pays_destination).toEqual([]);
      expect(res.body.data.incoterms_supportes).toEqual([]);
    });

    it('renseigne tous les champs (200)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/exportateur')
        .set(bearer(exporterToken))
        .send({
          company_name: 'CocoaExport CI SA',
          numero_rccm: 'CI-2024-E-99999',
          numero_ifu: '1801234B',
          agrement_export: 'AE-CI-2024-789',
          produits_exportes: ['anacarde', 'gingembre'],
          pays_destination: ['FR', 'DE', 'NL'],
          incoterms_supportes: ['FOB', 'CIF'],
          port_attache: 'Abidjan',
          volume_annuel_kg: 250000,
          iban: 'CI05 CI05 0123 4567 8901 2345 678',
          swift_bic: 'BICICIDAXXX',
        })
        .expect(200);

      expect(res.body.data.company_name).toBe('CocoaExport CI SA');
      expect(res.body.data.produits_exportes).toEqual(['anacarde', 'gingembre']);
      expect(res.body.data.pays_destination).toEqual(['FR', 'DE', 'NL']);
      expect(res.body.data.port_attache).toBe('Abidjan');
      expect(Number(res.body.data.volume_annuel_kg)).toBe(250000);
    });

    it('PATCH partiel (200) — change un seul champ', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/exportateur')
        .set(bearer(exporterToken))
        .send({ port_attache: 'San-Pédro' })
        .expect(200);

      expect(res.body.data.port_attache).toBe('San-Pédro');
      // Les autres restent
      expect(res.body.data.company_name).toBe('CocoaExport CI SA');
      expect(res.body.data.produits_exportes).toEqual(['anacarde', 'gingembre']);
    });

    it("refuse si l'appelant n'est pas EXPORTER (403)", async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Farmer Curieux Bis',
        role: 'FARMER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/profile/exportateur')
        .set(bearer(token))
        .send({ company_name: 'Should fail' })
        .expect(403);
    });
  });

  // ===================================================================
  //  POST /auth/profile/admin
  // ===================================================================

  describe('POST /auth/profile/admin', () => {
    let superAdminToken: string;
    let superAdminId: string;
    let normalAdminToken: string;
    let normalAdminId: string;

    beforeAll(async () => {
      // SUPER_ADMIN : promu via Prisma directement (simule post-bootstrap)
      const suPhone = makeTestPhone();
      const { user_id: suId } = await registerUser(app, {
        phone: suPhone,
        full_name: 'SU for profile tests',
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

      // ADMIN niveau ADMIN (pas SUPER)
      const naPhone = makeTestPhone();
      const { user_id: naId } = await registerUser(app, {
        phone: naPhone,
        full_name: 'Normal Admin for profile tests',
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

    it('ADMIN normal peut modifier departement + notes (200)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(normalAdminToken))
        .send({
          departement: 'Finance',
          notes: 'Admin du pôle Finance depuis 2026-05.',
        })
        .expect(200);

      expect(res.body.data.departement).toBe('Finance');
      expect(res.body.data.notes).toBe('Admin du pôle Finance depuis 2026-05.');
      // Niveau reste ADMIN (non touché)
      expect(res.body.data.niveau).toBe('ADMIN');
    });

    it('ADMIN normal ne peut PAS modifier niveau (403)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(normalAdminToken))
        .send({
          niveau: 'SUPER_ADMIN', // tentative d'auto-escalation
        })
        .expect(403);
    });

    it('ADMIN normal ne peut PAS modifier peut_* (403)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(normalAdminToken))
        .send({
          peut_gerer_finance: true,
        })
        .expect(403);
    });

    it('SUPER_ADMIN peut modifier niveau (200)', async () => {
      // Le SUPER_ADMIN s'auto-modifie en gardant SUPER_ADMIN — pas
      // d'effet de bord, on vérifie juste que la route accepte.
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(superAdminToken))
        .send({
          niveau: 'SUPER_ADMIN',
          departement: 'Direction',
        })
        .expect(200);

      expect(res.body.data.niveau).toBe('SUPER_ADMIN');
      expect(res.body.data.departement).toBe('Direction');
    });

    it('SUPER_ADMIN peut modifier peut_* (200)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(superAdminToken))
        .send({
          peut_publier_news: false,
        })
        .expect(200);

      expect(res.body.data.peut_publier_news).toBe(false);
      // Les autres permissions du SUPER_ADMIN restent à true
      expect(res.body.data.peut_valider_kyc).toBe(true);
      expect(res.body.data.peut_gerer_finance).toBe(true);
      expect(res.body.data.peut_gerer_users).toBe(true);
    });

    it("refuse si l'appelant n'est pas ADMIN (403)", async () => {
      const { token } = await registerAndGetToken(app, {
        full_name: 'Buyer Curieux',
        role: 'BUYER',
      });
      await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(token))
        .send({ departement: 'Should fail' })
        .expect(403);
    });

    it('refuse niveau invalide (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/profile/admin')
        .set(bearer(superAdminToken))
        .send({ niveau: 'GOD' })
        .expect(400);
    });
  });
});
