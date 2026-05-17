// =====================================================================
//  E2E : Chantier 3 — Data masking (anti-contournement)
//  ---------------------------------------------------------------------
//  Vérifie que GET /api/marketplace/annonces/vente applique bien le
//  MaskingInterceptor sur les PII (users.full_name) :
//
//   1. BUYER consulte → users.full_name est tronqué ("Yao K.")
//      (cas spec : étranger → visibility MIN)
//   2. TRANSPORTER consulte → users.full_name est aussi tronqué
//      (la route /annonces/vente n'utilise PAS de JwtAuthGuard donc
//       même un Bearer token n'est pas décodé → viewer anonyme → MIN).
//      Le test démontre que le masking par défaut s'applique.
//      Bug d'implémentation signalé : pour avoir une vraie visibility
//      différentielle FULL sur cette route publique, il faudrait ajouter
//      un OptionalJwtAuthGuard décodant l'entête Authorization si présent.
//      Cf. rapport.
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

describe('Masking (E2E)', () => {
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

  it('1. BUYER liste annonces de vente : users.full_name est masqué ("Yao K.")', async () => {
    // Setup : 1 FARMER avec nom complet + 1 BUYER étranger + 1 annonce.
    const farmer = await registerAndGetToken(app, {
      full_name: 'Yao Kouassi',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Test Buyer 1',
      role: 'BUYER',
    });
    const catalog = await getCatalogIds(app);
    const annonceId = await publishAnnonceVente(app, farmer.token, catalog, {
      titre: 'Cacao test masking BUYER',
    });

    const res = await request(app.getHttpServer())
      .get('/api/marketplace/annonces/vente')
      .set(bearer(buyer.token))
      .expect(200);

    const list = res.body.data?.data ?? res.body.data ?? [];
    const found = list.find((a: any) => a.id === annonceId);
    expect(found).toBeDefined();
    // BUYER étranger → MIN → nom tronqué "Yao K."
    expect(found.users.full_name).toBe('Yao K.');

    await prisma.annonces_vente.deleteMany({ where: { id: annonceId } });
  });

  it('2. TRANSPORTER sans mission active reste en MIN (règle business resolveVisibility)', async () => {
    // OptionalJwtAuthGuard décode bien le Bearer token (viewer = TRANSPORTER),
    // MAIS resolveVisibility ne donne FULL au TRANSPORTER que s'il a un
    // shipment ACCEPTED/LOADING/IN_TRANSIT actif avec le farmer observé.
    // Sans relation business → MIN par défaut (cohérent : on ne fuite pas
    // les coords aux transporteurs qui consultent le marketplace passivement).
    const farmer = await registerAndGetToken(app, {
      full_name: 'Sylvain Kone',
      role: 'FARMER',
    });
    const transporter = await registerAndGetToken(app, {
      full_name: 'Test Transporter',
      role: 'TRANSPORTER',
    });
    const catalog = await getCatalogIds(app);
    const annonceId = await publishAnnonceVente(app, farmer.token, catalog, {
      titre: 'Cacao test masking TRANSPORTER',
    });

    const res = await request(app.getHttpServer())
      .get('/api/marketplace/annonces/vente')
      .set(bearer(transporter.token))
      .expect(200);

    const list = res.body.data?.data ?? res.body.data ?? [];
    const found = list.find((a: any) => a.id === annonceId);
    expect(found).toBeDefined();
    // TRANSPORTER sans shipment actif → MIN (nom tronqué)
    expect(found.users.full_name).toBe('Sylvain K.');

    await prisma.annonces_vente.deleteMany({ where: { id: annonceId } });
  });
});
