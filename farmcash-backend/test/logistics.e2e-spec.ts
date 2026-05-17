// =====================================================================
//  E2E : Module Logistics + 2 escrows
//  ---------------------------------------------------------------------
//  Scénario complet AVEC transport :
//   1. TRANSPORTER déclare une route Bouaké → Abidjan
//   2. BUYER demande un devis → reçoit le tarif du transporteur
//   3. BUYER commande avec transporter_route_id → 2 escrows créés
//   4. TRANSPORTER liste missions disponibles → voit la nôtre
//   5. TRANSPORTER accepte → escrow TRANSPORT.beneficiary = lui
//   6. TRANSPORTER : LOADING → IN_TRANSIT → DELIVERED (avec photo preuve)
//   7. BUYER confirme livraison → libère les 2 escrows
//   8. Vérifie que seller ET transporter sont crédités (nets - 3%)
// =====================================================================

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '@farmcash/database';
import {
  addPaymentMethod,
  bearer,
  cleanupTestUsers,
  createTestApp,
  getCatalogIds,
  publishAnnonceVente,
  registerAndGetToken,
} from './setup';

describe('Logistics end-to-end : 2 escrows (produit + transport)', () => {
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

  it('scénario complet : commande avec transport, 2 escrows libérés', async () => {
    // 1. Trois users : FARMER, BUYER, TRANSPORTER
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer Logistics',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Logistics',
      role: 'BUYER',
    });
    const transporter = await registerAndGetToken(app, {
      full_name: 'Transporter Logistics',
      role: 'TRANSPORTER',
    });
    const pmId = await addPaymentMethod(app, buyer.userId);

    // 2. TRANSPORTER déclare une route Bouaké → Abidjan
    const routeRes = await request(app.getHttpServer())
      .post('/api/logistics/routes')
      .set(bearer(transporter.token))
      .send({
        origin_zone: 'Bouaké',
        destination_zone: 'Abidjan',
        tarif_kg: 200,
        tarif_minimum: 10000,
        capacite_max_kg: 1000,
        delai_typique: 'Sous 24h',
      })
      .expect(201);
    const route_id = routeRes.body.data.id;

    // 3. BUYER demande un devis → trouve l'offre du transporter
    const quotes = await request(app.getHttpServer())
      .get('/api/logistics/quotes?origin_zone=Bouak%C3%A9&destination_zone=Abidjan&quantite_kg=100')
      .set(bearer(buyer.token))
      .expect(200);
    expect(quotes.body.data).toHaveLength(1);
    expect(quotes.body.data[0].route_id).toBe(route_id);
    expect(quotes.body.data[0].tarif_total).toBe(20000); // max(10000, 200*100)

    // 4. FARMER publie une annonce
    const annonce_id = await publishAnnonceVente(app, farmer.token, catalog, {
      titre: 'Cacao Bouaké',
      prix_par_kg: 1500,
      quantite_kg: 500,
      quantite_min_kg: 50,
    });

    // 5. BUYER commande AVEC transport
    const orderRes = await request(app.getHttpServer())
      .post('/api/orders')
      .set(bearer(buyer.token))
      .send({
        source_type: 'DIRECT_ANNONCE_VENTE',
        annonce_vente_id: annonce_id,
        quantite_kg: 100,
        payment_method_id: pmId,
        transporter_route_id: route_id,
        delivery_address: 'Abidjan Plateau, rue 12',
      })
      .expect(201);

    const orderId = orderRes.body.data.id;
    // Total = 100 × 1500 + 20000 (transport) = 170 000
    expect(Number(orderRes.body.data.montant_total)).toBe(170000);

    // 6. Vérifie les 2 escrows créés
    const escrows = await prisma.escrow_conditions.findMany({
      where: { commande_id: orderId },
      orderBy: { kind: 'asc' }, // PRODUCT avant TRANSPORT
    });
    expect(escrows).toHaveLength(2);

    const productEscrow = escrows.find((e) => e.kind === 'PRODUCT')!;
    const transportEscrow = escrows.find((e) => e.kind === 'TRANSPORT')!;

    expect(Number(productEscrow.montant)).toBe(150000);
    expect(Number(productEscrow.frais_service)).toBe(4500); // 3% × 150 000
    expect(productEscrow.beneficiary_id).toBe(farmer.userId);

    expect(Number(transportEscrow.montant)).toBe(20000);
    expect(Number(transportEscrow.frais_service)).toBe(600); // 3% × 20 000
    expect(transportEscrow.beneficiary_id).toBeNull(); // pas encore accepté

    // 7. TRANSPORTER voit la mission disponible
    const missions = await request(app.getHttpServer())
      .get('/api/logistics/missions/available')
      .set(bearer(transporter.token))
      .expect(200);
    expect(missions.body.data.length).toBeGreaterThan(0);
    const shipment_id = missions.body.data.find(
      (m: any) => m.commande_id === orderId,
    )?.id;
    expect(shipment_id).toBeDefined();

    // 8. TRANSPORTER accepte la mission → escrow TRANSPORT lié
    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/accept`)
      .set(bearer(transporter.token))
      .expect(200);

    const transportEscrowAfter = await prisma.escrow_conditions.findFirst({
      where: { commande_id: orderId, kind: 'TRANSPORT' },
    });
    expect(transportEscrowAfter?.beneficiary_id).toBe(transporter.userId);

    // 9. TRANSPORTER : LOADING → IN_TRANSIT → DELIVERED
    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/start-loading`)
      .set(bearer(transporter.token))
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/track`)
      .set(bearer(transporter.token))
      .send({
        position: { lat: 5.5, lng: -4.5 },
        status: 'IN_TRANSIT',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/deliver`)
      .set(bearer(transporter.token))
      .send({
        photo_preuve_url: 'https://cdn.farmcash.ci/proof/abc.jpg',
        delivery_position: { lat: 5.345317, lng: -4.024429 },
        note: 'Livré au buyer',
      })
      .expect(200);

    // Commande basculée à DELIVERED par le service logistics
    const orderAfterDelivery = await prisma.commandes_vente.findUnique({
      where: { id: orderId },
    });
    expect(orderAfterDelivery?.status).toBe('DELIVERED');

    // 10. BUYER confirme → libère les 2 escrows
    await request(app.getHttpServer())
      .post('/api/finance/confirm-delivery')
      .set(bearer(buyer.token))
      .send({ commande_id: orderId })
      .expect(200);

    // 11. Vérifie les soldes
    const sellerWallet = await prisma.wallets.findUnique({
      where: {
        user_id_currency: { user_id: farmer.userId, currency: 'XOF' },
      },
    });
    expect(Number(sellerWallet!.balance)).toBe(145500); // 150 000 - 3%

    const transporterWallet = await prisma.wallets.findUnique({
      where: {
        user_id_currency: { user_id: transporter.userId, currency: 'XOF' },
      },
    });
    expect(Number(transporterWallet!.balance)).toBe(19400); // 20 000 - 3%

    const buyerWallet = await prisma.wallets.findUnique({
      where: {
        user_id_currency: { user_id: buyer.userId, currency: 'XOF' },
      },
    });
    expect(Number(buyerWallet!.balance_escrow)).toBe(0);

    // 12. Commande COMPLETED
    const orderFinal = await prisma.commandes_vente.findUnique({
      where: { id: orderId },
    });
    expect(orderFinal?.status).toBe('COMPLETED');
  }, 60000);

  it('refuse un transporter d\'accepter sans route correspondante (anti-fraude)', async () => {
    const farmer = await registerAndGetToken(app, {
      full_name: 'Farmer Sec',
      role: 'FARMER',
    });
    const buyer = await registerAndGetToken(app, {
      full_name: 'Buyer Sec',
      role: 'BUYER',
    });
    const transporterA = await registerAndGetToken(app, {
      full_name: 'Transporter A',
      role: 'TRANSPORTER',
    });
    const transporterB = await registerAndGetToken(app, {
      full_name: 'Transporter B',
      role: 'TRANSPORTER',
    });

    const pmId = await addPaymentMethod(app, buyer.userId);

    // Seul TransporterA déclare la route
    const routeA = await request(app.getHttpServer())
      .post('/api/logistics/routes')
      .set(bearer(transporterA.token))
      .send({
        origin_zone: 'Yamoussoukro',
        destination_zone: 'Abidjan',
        tarif_kg: 100,
        tarif_minimum: 5000,
        capacite_max_kg: 500,
      })
      .expect(201);

    const annonce_id = await publishAnnonceVente(app, farmer.token, catalog, {
      prix_par_kg: 1000,
      quantite_kg: 200,
    });

    const orderRes = await request(app.getHttpServer())
      .post('/api/orders')
      .set(bearer(buyer.token))
      .send({
        source_type: 'DIRECT_ANNONCE_VENTE',
        annonce_vente_id: annonce_id,
        quantite_kg: 100,
        payment_method_id: pmId,
        transporter_route_id: routeA.body.data.id,
        delivery_address: 'Abidjan',
      })
      .expect(201);

    const missions = await request(app.getHttpServer())
      .get('/api/logistics/missions/available')
      .set(bearer(transporterA.token))
      .expect(200);
    const shipment_id = missions.body.data.find(
      (m: any) => m.commande_id === orderRes.body.data.id,
    )?.id;
    expect(shipment_id).toBeDefined();

    // TransporterB (sans route Yamoussoukro→Abidjan) essaie d'accepter
    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/accept`)
      .set(bearer(transporterB.token))
      .expect(403);

    // TransporterA légitime accepte → OK
    await request(app.getHttpServer())
      .post(`/api/logistics/shipments/${shipment_id}/accept`)
      .set(bearer(transporterA.token))
      .expect(200);
  }, 60000);
});
