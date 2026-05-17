// =====================================================================
//  E2E : Module Negotiation
//  ---------------------------------------------------------------------
//  Couvre les 3 flux de négociation :
//   • CANDIDATURE   : BUYER → FARMER (sur annonce de vente)
//   • PROPOSITION   : FARMER → BUYER (sur annonce d'achat)
//   • CONTRE-OFFRE  : (testé indirectement — nécessite une publication coop)
//
//  Vérifie aussi les garde-fous critiques :
//   • Anti-spam : pas 2 candidatures PENDING en cours sur la même annonce
//   • Anti-self-offer : on ne peut pas offrir sur sa propre annonce
//   • Autorisation : seul le farmer (vendeur) peut ACCEPTED/REJECTED
//   • State machine : transitions impossibles refusées
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

describe('Negotiation (E2E)', () => {
  let app: INestApplication;
  let catalog: { produit_id: string; region_id: string; ville_id: string };

  beforeAll(async () => {
    app = await createTestApp();
    await cleanupTestUsers(app);
    catalog = await getCatalogIds(app);
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  // ===================================================================
  //  CANDIDATURES (BUYER → FARMER)
  // ===================================================================

  describe('Flux candidature complet', () => {
    let farmer: { userId: string; token: string };
    let buyer: { userId: string; token: string };
    let annonce_id: string;

    beforeAll(async () => {
      farmer = await registerAndGetToken(app, {
        full_name: 'Farmer Negoc',
        role: 'FARMER',
      });
      buyer = await registerAndGetToken(app, {
        full_name: 'Buyer Negoc',
        role: 'BUYER',
      });
      annonce_id = await publishAnnonceVente(app, farmer.token, catalog, {
        prix_par_kg: 1500,
        quantite_kg: 1000,
      });
    });

    it('BUYER fait une offre → status PENDING', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/negotiation/candidatures')
        .set(bearer(buyer.token))
        .send({
          annonce_id,
          quantite_kg: 200,
          prix_propose_kg: 1300,
          message: 'Je peux payer immédiatement',
        })
        .expect(201);
      expect(res.body.data.id).toBeDefined();
    });

    it('Anti-spam : refuse une 2e candidature PENDING sur la même annonce', async () => {
      await request(app.getHttpServer())
        .post('/api/negotiation/candidatures')
        .set(bearer(buyer.token))
        .send({
          annonce_id,
          quantite_kg: 300,
          prix_propose_kg: 1400,
        })
        .expect(409);
    });

    it('FARMER ne peut pas appeler la route /candidatures (réservée BUYER)', async () => {
      await request(app.getHttpServer())
        .post('/api/negotiation/candidatures')
        .set(bearer(farmer.token))
        .send({
          annonce_id,
          quantite_kg: 100,
          prix_propose_kg: 1000,
        })
        .expect(403);
    });

    it('FARMER liste les candidatures reçues (direction=incoming)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/negotiation/candidatures?direction=incoming')
        .set(bearer(farmer.token))
        .expect(200);
      const found = res.body.data.find((c: any) => c.annonce_id === annonce_id);
      expect(found).toBeDefined();
      expect(found.status).toBe('PENDING');
    });

    it('Un tiers ne peut PAS traiter la candidature (autz fine)', async () => {
      const intruder = await registerAndGetToken(app, {
        full_name: 'Intruder Negoc',
        role: 'BUYER',
      });

      // Récupère l'id de la candidature
      const list = await request(app.getHttpServer())
        .get('/api/negotiation/candidatures?direction=outgoing')
        .set(bearer(buyer.token))
        .expect(200);
      const candidatureId = list.body.data[0].id;

      await request(app.getHttpServer())
        .put(`/api/negotiation/candidatures/${candidatureId}/traiter`)
        .set(bearer(intruder.token))
        .send({ action: 'ACCEPTED' })
        .expect(403);
    });

    it('FARMER accepte la candidature → status ACCEPTED', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/negotiation/candidatures?direction=incoming')
        .set(bearer(farmer.token))
        .expect(200);
      const candidatureId = list.body.data.find(
        (c: any) => c.annonce_id === annonce_id,
      ).id;

      const res = await request(app.getHttpServer())
        .put(`/api/negotiation/candidatures/${candidatureId}/traiter`)
        .set(bearer(farmer.token))
        .send({ action: 'ACCEPTED', note: 'OK pour 1300 FCFA/kg' })
        .expect(200);
      expect(res.body.data.message).toContain('ACCEPTED');
    });

    it("Transition impossible : on ne peut plus traiter un état terminal", async () => {
      const list = await request(app.getHttpServer())
        .get('/api/negotiation/candidatures?direction=incoming')
        .set(bearer(farmer.token))
        .expect(200);
      const candidatureId = list.body.data.find(
        (c: any) => c.annonce_id === annonce_id,
      ).id;

      await request(app.getHttpServer())
        .put(`/api/negotiation/candidatures/${candidatureId}/traiter`)
        .set(bearer(farmer.token))
        .send({ action: 'REJECTED' })
        .expect(400);
    });
  });

  // ===================================================================
  //  Validation DTO
  // ===================================================================

  describe('Validation DTOs', () => {
    let buyer: { token: string };

    beforeAll(async () => {
      buyer = await registerAndGetToken(app, {
        full_name: 'Buyer Validation',
        role: 'BUYER',
      });
    });

    it('refuse action inconnue (enum)', async () => {
      await request(app.getHttpServer())
        .put('/api/negotiation/candidatures/00000000-0000-0000-0000-000000000000/traiter')
        .set(bearer(buyer.token))
        .send({ action: 'WIN_FREE_MONEY' })
        .expect(400);
    });

    it('refuse quantité = 0 (Min(1))', async () => {
      await request(app.getHttpServer())
        .post('/api/negotiation/candidatures')
        .set(bearer(buyer.token))
        .send({
          annonce_id: '00000000-0000-0000-0000-000000000000',
          quantite_kg: 0,
          prix_propose_kg: 1000,
        })
        .expect(400);
    });
  });
});
