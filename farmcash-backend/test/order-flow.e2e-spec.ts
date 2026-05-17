// =====================================================================
//  E2E : Scénario complet bout-en-bout
//  ---------------------------------------------------------------------
//  Ce test joue le parcours d'une commande de A à Z et valide que tous
//  les modules s'enchaînent correctement :
//
//   1. Inscription d'un FARMER (vendeur)
//   2. Inscription d'un BUYER (acheteur)
//   3. Le BUYER ajoute un moyen de paiement
//   4. Le FARMER publie une annonce de vente
//   5. Le BUYER liste les annonces et en consulte une (incrémente views)
//   6. Le BUYER ajoute au panier → vérifie que le prix est relu serveur
//   7. Le BUYER crée une commande (DIRECT_ANNONCE_VENTE)
//   8. Le payin auto met la commande en ACCEPTED + crée escrow PRODUCT
//   9. Le FARMER fait IN_PROGRESS → DELIVERED
//  10. Le BUYER confirme la livraison → escrow libéré
//  11. Vérifie que le wallet du seller est crédité du net
//  12. Vérifie que le balance_escrow du buyer est décrémenté
// =====================================================================

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '@farmcash/database';
import {
  addPaymentMethod,
  bearer,
  cleanupTestUsers,
  createTestApp,
  registerAndGetToken,
} from './setup';

describe('Order flow end-to-end (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // IDs de catalogue récupérés une fois pour tout le test
  let produit_id: string;
  let region_id: string;
  let ville_id: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(app);

    // Prend le premier produit, première région, première ville
    const [produit, region, ville] = await Promise.all([
      prisma.produits_agricoles.findFirst({ where: { is_active: true } }),
      prisma.regions_ci.findFirst(),
      prisma.villes_ci.findFirst(),
    ]);
    if (!produit || !region || !ville) {
      throw new Error(
        'Catalogue vide. Le seed initial des tables produits_agricoles, regions_ci, villes_ci est requis.',
      );
    }
    produit_id = produit.id;
    region_id = region.id;
    ville_id = ville.id;
  });

  afterAll(async () => {
    await cleanupTestUsers(app);
    await app.close();
  });

  it('joue le scénario complet : commande → livraison → escrow libéré', async () => {
    // ----- 1. Inscription FARMER -----
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer E2E',
      role: 'FARMER',
    });

    // ----- 2. Inscription BUYER -----
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer E2E',
      role: 'BUYER',
    });

    // ----- 3. BUYER ajoute moyen de paiement -----
    const paymentMethodId = await addPaymentMethod(app, buyer.userId);

    // ----- 4. FARMER publie une annonce de vente -----
    const createAnnonce = await request(app.getHttpServer())
      .post('/api/marketplace/annonces/vente')
      .set(bearer(farmer.token))
      .send({
        produit_id,
        titre: 'Cacao premium e2e',
        description: 'Test scénario complet',
        quantite_kg: 1000,
        prix_par_kg: 1500,
        quantite_min_kg: 50,
        qualite: 'PREMIUM',
        region_id,
        ville_id,
        coordinates: { lat: 5.345317, lng: -4.024429 },
      })
      .expect(201);

    const annonce_id = createAnnonce.body.data.annonce_id;
    expect(annonce_id).toBeDefined();

    // ----- 5. BUYER liste + consulte le détail (vue) -----
    const list = await request(app.getHttpServer())
      .get('/api/marketplace/annonces/vente')
      .expect(200);
    const myAnnonceInList = list.body.data.data.find(
      (a: { id: string }) => a.id === annonce_id,
    );
    expect(myAnnonceInList).toBeDefined();

    const detail = await request(app.getHttpServer())
      .get(`/api/marketplace/annonces/vente/${annonce_id}`)
      .set(bearer(buyer.token))
      .expect(200);
    expect(detail.body.data.titre).toBe('Cacao premium e2e');
    expect(Number(detail.body.data.prix_par_kg)).toBe(1500);

    // ----- 6. BUYER ajoute au panier (prix relu serveur) -----
    const addCart = await request(app.getHttpServer())
      .post('/api/marketplace/panier/add')
      .set(bearer(buyer.token))
      .send({
        annonce_id,
        quantite_kg: 100,
        // Note : on n'envoie volontairement PAS de prix_unitaire — le serveur le lit
      })
      .expect(200);
    expect(addCart.body.data.message).toContain('ajouté');

    // ----- 7. BUYER crée une commande directe -----
    const createOrder = await request(app.getHttpServer())
      .post('/api/orders')
      .set(bearer(buyer.token))
      .send({
        source_type: 'DIRECT_ANNONCE_VENTE',
        annonce_vente_id: annonce_id,
        quantite_kg: 100,
        payment_method_id: paymentMethodId,
        delivery_address: 'Abidjan, Plateau, rue de la Paix',
      })
      .expect(201);

    const orderId = createOrder.body.data.id;
    expect(orderId).toBeDefined();

    // Vérifie le calcul serveur : 100 kg × 1500 FCFA = 150 000
    expect(Number(createOrder.body.data.montant_total)).toBe(150000);
    // frais_service = 3% × 150000 = 4500
    expect(Number(createOrder.body.data.frais_service)).toBe(4500);
    // montant_net pour le seller = 150000 - 4500 = 145500
    expect(Number(createOrder.body.data.montant_net)).toBe(145500);

    // ----- 8. processPayin auto a basculé la commande à ACCEPTED -----
    const orderAfterPayin = await prisma.commandes_vente.findUnique({
      where: { id: orderId },
    });
    expect(orderAfterPayin?.status).toBe('ACCEPTED');

    // Escrow PRODUCT créé pour le seller
    const escrows = await prisma.escrow_conditions.findMany({
      where: { commande_id: orderId },
    });
    expect(escrows).toHaveLength(1); // pas de transport ici (pas de route)
    expect(escrows[0].kind).toBe('PRODUCT');
    expect(escrows[0].beneficiary_id).toBe(farmer.userId);
    expect(escrows[0].status).toBe('LOCKED');
    expect(Number(escrows[0].montant)).toBe(150000);
    expect(Number(escrows[0].frais_service)).toBe(4500);

    // ----- 9. FARMER bascule IN_PROGRESS → DELIVERED -----
    await request(app.getHttpServer())
      .put(`/api/orders/${orderId}/status`)
      .set(bearer(farmer.token))
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    await request(app.getHttpServer())
      .put(`/api/orders/${orderId}/status`)
      .set(bearer(farmer.token))
      .send({ status: 'DELIVERED' })
      .expect(200);

    // ----- 10. BUYER confirme la livraison → libère l'escrow -----
    await request(app.getHttpServer())
      .post('/api/finance/confirm-delivery')
      .set(bearer(buyer.token))
      .send({ commande_id: orderId })
      .expect(200);

    // ----- 11. Vérifie les soldes finaux -----
    const orderFinal = await prisma.commandes_vente.findUnique({
      where: { id: orderId },
    });
    expect(orderFinal?.status).toBe('COMPLETED');

    const sellerWallet = await prisma.wallets.findUnique({
      where: {
        user_id_currency: { user_id: farmer.userId, currency: 'XOF' },
      },
    });
    // Le seller doit avoir reçu 145 500 (montant_total - 3% frais)
    expect(sellerWallet).toBeTruthy();
    expect(Number(sellerWallet!.balance)).toBe(145500);

    const buyerWallet = await prisma.wallets.findUnique({
      where: {
        user_id_currency: { user_id: buyer.userId, currency: 'XOF' },
      },
    });
    // Le balance_escrow du buyer doit être revenu à 0 (incrémenté de
    // 150000 au payin, puis décrémenté de 150000 à la release).
    expect(buyerWallet).toBeTruthy();
    expect(Number(buyerWallet!.balance_escrow)).toBe(0);

    // ----- 12. L'escrow doit être marqué RELEASED -----
    const escrowsFinal = await prisma.escrow_conditions.findMany({
      where: { commande_id: orderId },
    });
    expect(escrowsFinal[0].status).toBe('RELEASED');
    expect(escrowsFinal[0].released_by).toBe(buyer.userId);
  }, 30000);

  it("refuse qu'un tiers libère l'escrow (sécurité)", async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer Tiers',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Tiers',
      role: 'BUYER',
    });
    const intruder = await registerAndGetToken(app, {
      full_name: 'Intruder',
      role: 'BUYER',
    });

    const pmId = await addPaymentMethod(app, buyer.userId);

    const createAnnonce = await request(app.getHttpServer())
      .post('/api/marketplace/annonces/vente')
      .set(bearer(farmer.token))
      .send({
        produit_id,
        titre: 'Test sécurité escrow',
        quantite_kg: 100,
        prix_par_kg: 1000,
        quantite_min_kg: 10,
        qualite: 'STANDARD',
        region_id,
        ville_id,
        coordinates: { lat: 5.345317, lng: -4.024429 },
      })
      .expect(201);

    const order = await request(app.getHttpServer())
      .post('/api/orders')
      .set(bearer(buyer.token))
      .send({
        source_type: 'DIRECT_ANNONCE_VENTE',
        annonce_vente_id: createAnnonce.body.data.annonce_id,
        quantite_kg: 50,
        payment_method_id: pmId,
        delivery_address: 'Test',
      })
      .expect(201);

    const orderId = order.body.data.id;

    // FARMER fait livrer
    await request(app.getHttpServer())
      .put(`/api/orders/${orderId}/status`)
      .set(bearer(farmer.token))
      .send({ status: 'IN_PROGRESS' })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/orders/${orderId}/status`)
      .set(bearer(farmer.token))
      .send({ status: 'DELIVERED' })
      .expect(200);

    // L'INTRUDER essaie de confirmer la livraison → doit échouer 403
    await request(app.getHttpServer())
      .post('/api/finance/confirm-delivery')
      .set(bearer(intruder.token))
      .send({ commande_id: orderId })
      .expect(403);

    // Le BUYER légitime confirme → OK
    await request(app.getHttpServer())
      .post('/api/finance/confirm-delivery')
      .set(bearer(buyer.token))
      .send({ commande_id: orderId })
      .expect(200);
  }, 30000);
});
