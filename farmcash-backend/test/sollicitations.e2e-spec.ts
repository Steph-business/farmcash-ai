// =====================================================================
//  E2E : Sollicitations coop multi-audience (Chantier 2)
//  ---------------------------------------------------------------------
//  3 scénarios (spec § 2.8) :
//   1. Happy path : COOP crée une sollicitation aux MEMBRES → 3 FARMER
//      members répondent ACCEPTED → status passe en FULFILLED auto.
//   2. Fan-out COOPS_VOISINES : COOP A + COOP B avec coords proches,
//      A crée la sollicitation, on vérifie que sollicitation_recipients
//      contient bien la COOP B (avec audience_segment = COOPS_VOISINES).
//   3. Close manuel : COOP crée puis close → tous les recipients
//      PENDING reçoivent une notif COOP_SOLLICITATION_CLOSED.
//
//  Setup : on utilise registerAndGetToken pour COOPERATIVE (auto-crée
//  cooperative_profiles avec nom = 'Ma coopérative'). Les members et
//  l'annonce_achat sont insérés en raw Prisma.
// =====================================================================

import { INestApplication } from '@nestjs/common';
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

/**
 * Crée une annonce_achat ciblée sur la coop donnée (la sollicitation
 * doit pouvoir trouver cette annonce). location est NOT NULL côté DB
 * (Unsupported(geography)) → on passe par $executeRaw.
 */
async function seedAnnonceAchat(
  prisma: PrismaService,
  opts: {
    buyerId: string;
    coopId: string;
    produitId: string;
    quantite_kg: number;
  },
): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO annonces_achat (
      buyer_id, produit_id, quantite_kg, prix_max_kg,
      target_audience, target_cooperative_id, is_active, location
    ) VALUES (
      ${opts.buyerId}::uuid,
      ${opts.produitId}::uuid,
      ${opts.quantite_kg},
      1500,
      'SPECIFIC_COOPERATIVE'::buy_offer_audience,
      ${opts.coopId}::uuid,
      true,
      ST_SetSRID(ST_MakePoint(-4.024429, 5.345317), 4326)
    )
    RETURNING id::text AS id`;
  return rows[0].id;
}

describe('Sollicitations coop multi-audience (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let catalog: { produit_id: string; region_id: string; ville_id: string };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(app);
    catalog = await getCatalogIds(app);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  // -------------------------------------------------------------------

  it('happy path : COOP crée sollicitation MEMBRES → 3 farmers répondent → FULFILLED auto', async () => {
    const coop = await registerAndGetToken(app, {
      full_name: 'Coop Happy Path',
      role: 'COOPERATIVE',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Sollicit Happy',
      role: 'BUYER',
    });
    const farmer1 = await registerAndGetToken(app, {
      full_name: 'Farmer Sollicit 1',
      role: 'FARMER',
    });
    const farmer2 = await registerAndGetToken(app, {
      full_name: 'Farmer Sollicit 2',
      role: 'FARMER',
    });
    const farmer3 = await registerAndGetToken(app, {
      full_name: 'Farmer Sollicit 3',
      role: 'FARMER',
    });

    // Récupère la coop_id auto-créée à l'inscription
    const coopProfile = await prisma.cooperative_profiles.findUnique({
      where: { user_id: coop.userId },
    });
    expect(coopProfile).toBeDefined();

    // Ajoute les 3 farmers comme MEMBRES actifs de la coop
    await prisma.cooperative_members.createMany({
      data: [
        {
          cooperative_id: coopProfile!.id,
          member_id: farmer1.userId,
          is_active: true,
        },
        {
          cooperative_id: coopProfile!.id,
          member_id: farmer2.userId,
          is_active: true,
        },
        {
          cooperative_id: coopProfile!.id,
          member_id: farmer3.userId,
          is_active: true,
        },
      ],
    });

    // BUYER crée une annonce_achat ciblée sur la coop
    const annonce_id = await seedAnnonceAchat(prisma, {
      buyerId: buyer.userId,
      coopId: coopProfile!.id,
      produitId: catalog.produit_id,
      quantite_kg: 1000, // cible = 1000 kg
    });

    // 1. COOP crée la sollicitation aux MEMBRES
    const createRes = await request(app.getHttpServer())
      .post('/api/coop/sollicitations')
      .set(bearer(coop.token))
      .send({
        annonce_achat_id: annonce_id,
        message: 'Mobilisation 1 tonne de maïs cette semaine svp.',
        audiences: ['MEMBRES'],
        rayon_km: 50,
        duree_jours: 7,
      })
      .expect(201);

    const sollicit_id = createRes.body.data.sollicitation_id;
    expect(createRes.body.data.recipients_count.MEMBRES).toBe(3);
    expect(createRes.body.data.notifications_dispatched).toBe(3);

    // 2. Les 3 farmers répondent ACCEPTED avec 400 / 350 / 300 = 1050 (> 1000)
    await request(app.getHttpServer())
      .post(`/api/coop/sollicitations/${sollicit_id}/respond`)
      .set(bearer(farmer1.token))
      .send({ action: 'ACCEPTED', quantite_kg: 400 })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/coop/sollicitations/${sollicit_id}/respond`)
      .set(bearer(farmer2.token))
      .send({ action: 'ACCEPTED', quantite_kg: 350 })
      .expect(200);
    const finalResp = await request(app.getHttpServer())
      .post(`/api/coop/sollicitations/${sollicit_id}/respond`)
      .set(bearer(farmer3.token))
      .send({ action: 'ACCEPTED', quantite_kg: 300 })
      .expect(200);

    // La 3e réponse fait passer total à 1050 >= 1000 → auto FULFILLED
    expect(finalResp.body.data.sollicitation_status).toBe('FULFILLED');

    // 3. Vérifie en DB que le status est bien FULFILLED + total_quantite = 1050
    const sollicitDB = await prisma.sollicitations_coop.findUnique({
      where: { id: sollicit_id },
    });
    expect(sollicitDB!.status).toBe('FULFILLED');
    expect(Number(sollicitDB!.total_quantite_offerte)).toBe(1050);
    expect(sollicitDB!.total_responses).toBe(3);

    // 4. La coop reçoit la notif "tonnage atteint"
    const notifs = await prisma.notifications.findMany({
      where: {
        user_id: coop.userId,
        type: 'COOP_SOLLICITATION_FULFILLED',
      },
    });
    expect(notifs.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  // -------------------------------------------------------------------

  it('fan-out COOPS_VOISINES : sollicitation_recipients contient bien la coop voisine', async () => {
    const coopA = await registerAndGetToken(app, {
      full_name: 'Coop Voisine A',
      role: 'COOPERATIVE',
    });
    const coopB = await registerAndGetToken(app, {
      full_name: 'Coop Voisine B',
      role: 'COOPERATIVE',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Voisin',
      role: 'BUYER',
    });

    // Récupère les profils coop + injecte les locations GPS proches (< 10 km)
    const coopAProfile = await prisma.cooperative_profiles.findUnique({
      where: { user_id: coopA.userId },
    });
    const coopBProfile = await prisma.cooperative_profiles.findUnique({
      where: { user_id: coopB.userId },
    });
    expect(coopAProfile).toBeDefined();
    expect(coopBProfile).toBeDefined();

    // Coords GPS : Abidjan (5.34, -4.02) pour A, ~5 km plus loin pour B
    await prisma.$executeRaw`
      UPDATE cooperative_profiles
      SET location = ST_SetSRID(ST_MakePoint(-4.024, 5.345), 4326)
      WHERE id = ${coopAProfile!.id}::uuid`;
    await prisma.$executeRaw`
      UPDATE cooperative_profiles
      SET location = ST_SetSRID(ST_MakePoint(-4.05, 5.37), 4326)
      WHERE id = ${coopBProfile!.id}::uuid`;

    // Annonce ciblée sur coop A
    const annonce_id = await seedAnnonceAchat(prisma, {
      buyerId: buyer.userId,
      coopId: coopAProfile!.id,
      produitId: catalog.produit_id,
      quantite_kg: 5000,
    });

    // Coop A crée la sollicitation avec audiences = COOPS_VOISINES uniquement
    const res = await request(app.getHttpServer())
      .post('/api/coop/sollicitations')
      .set(bearer(coopA.token))
      .send({
        annonce_achat_id: annonce_id,
        message: 'Cherche partenaires voisins pour gros volume.',
        audiences: ['COOPS_VOISINES'],
        rayon_km: 50,
        duree_jours: 7,
      })
      .expect(201);

    const sollicit_id = res.body.data.sollicitation_id;
    expect(res.body.data.recipients_count.COOPS_VOISINES).toBeGreaterThanOrEqual(1);

    // Vérifie que sollicitation_recipients contient un row pour la COOP B
    const recipients = await prisma.sollicitation_recipients.findMany({
      where: { sollicitation_id: sollicit_id },
    });
    const coopBRecipient = recipients.find(
      (r) => r.user_id === coopB.userId,
    );
    expect(coopBRecipient).toBeDefined();
    expect(coopBRecipient!.audience_segment).toBe('COOPS_VOISINES');
    expect(coopBRecipient!.cooperative_id).toBe(coopBProfile!.id);
  }, 60000);

  // -------------------------------------------------------------------

  it('close manuel : recipients PENDING reçoivent une notif COOP_SOLLICITATION_CLOSED', async () => {
    const coop = await registerAndGetToken(app, {
      full_name: 'Coop Close',
      role: 'COOPERATIVE',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Close',
      role: 'BUYER',
    });
    const farmerA = await registerAndGetToken(app, {
      full_name: 'Farmer Close A',
      role: 'FARMER',
    });
    const farmerB = await registerAndGetToken(app, {
      full_name: 'Farmer Close B',
      role: 'FARMER',
    });

    const coopProfile = await prisma.cooperative_profiles.findUnique({
      where: { user_id: coop.userId },
    });

    await prisma.cooperative_members.createMany({
      data: [
        {
          cooperative_id: coopProfile!.id,
          member_id: farmerA.userId,
          is_active: true,
        },
        {
          cooperative_id: coopProfile!.id,
          member_id: farmerB.userId,
          is_active: true,
        },
      ],
    });

    const annonce_id = await seedAnnonceAchat(prisma, {
      buyerId: buyer.userId,
      coopId: coopProfile!.id,
      produitId: catalog.produit_id,
      quantite_kg: 2000,
    });

    // Création
    const createRes = await request(app.getHttpServer())
      .post('/api/coop/sollicitations')
      .set(bearer(coop.token))
      .send({
        annonce_achat_id: annonce_id,
        message: 'Sollicit close test message.',
        audiences: ['MEMBRES'],
        duree_jours: 7,
      })
      .expect(201);
    const sollicit_id = createRes.body.data.sollicitation_id;

    // Farmer A répond (ne sera donc PAS notifié à la fermeture)
    await request(app.getHttpServer())
      .post(`/api/coop/sollicitations/${sollicit_id}/respond`)
      .set(bearer(farmerA.token))
      .send({ action: 'ACCEPTED', quantite_kg: 500 })
      .expect(200);

    // Compte les notifs de farmerB avant close (juste celle de la création)
    const farmerBNotifsBefore = await prisma.notifications.count({
      where: {
        user_id: farmerB.userId,
        type: { in: ['COOP_SOLLICITATION_CLOSED'] },
      },
    });
    expect(farmerBNotifsBefore).toBe(0);

    // COOP ferme manuellement (POST sans @HttpCode → 201 par défaut)
    const closeRes = await request(app.getHttpServer())
      .post(`/api/coop/sollicitations/${sollicit_id}/close`)
      .set(bearer(coop.token))
      .expect(200);
    expect(closeRes.body.data.status).toBe('CLOSED');

    // Farmer B (PENDING) a bien reçu une notif COOP_SOLLICITATION_CLOSED
    const farmerBNotifsAfter = await prisma.notifications.findMany({
      where: {
        user_id: farmerB.userId,
        type: 'COOP_SOLLICITATION_CLOSED',
      },
    });
    expect(farmerBNotifsAfter.length).toBe(1);
    expect(farmerBNotifsAfter[0].titre).toMatch(/ferm/i);

    // Farmer A (déjà répondu) NE reçoit PAS la notif close
    const farmerANotifsClose = await prisma.notifications.count({
      where: {
        user_id: farmerA.userId,
        type: 'COOP_SOLLICITATION_CLOSED',
      },
    });
    expect(farmerANotifsClose).toBe(0);
  }, 60000);
});
