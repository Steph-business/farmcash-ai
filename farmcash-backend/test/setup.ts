// IMPORTANT : doit être défini AVANT l'import de AppModule. Sinon le
// ThrottlerModule sera initialisé avec ses valeurs prod et bloquera les
// tests qui créent beaucoup de users en rafale (5 register/h, etc.).
process.env.DISABLE_THROTTLE = 'true';

// =====================================================================
//  TEST SETUP — Helpers communs pour les tests E2E
//  ---------------------------------------------------------------------
//  • createTestApp()         : boote l'app NestJS en mémoire (pas de port)
//  • cleanupTestUsers()      : supprime tous les users dont phone matche
//                              le préfixe de test (cascade supprime le reste)
//  • registerUser()          : appelle POST /auth/register
//  • setPinForUser()         : POST /auth/set-pin (avec JWT)
//  • loginPin()              : POST /auth/login-pin
//  • bearer(token)           : header Authorization formaté
//
//  Convention : tous les phones de test commencent par +22599 (zone
//  réservée test, jamais utilisée en prod).
// =====================================================================

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../apps/api-gateway/src/app.module';
import { PrismaService } from '@farmcash/database';

/**
 * Préfixe phone réservé aux tests. Doit être un préfixe valide CI pour
 * passer libphonenumber-js. On utilise Orange CI `+225070999` (range
 * réservé en pratique aux numéros de test) puis on ajoute 4 chiffres.
 */
export const TEST_PHONE_PREFIX = '+225070999';

/**
 * Boote l'app NestJS pour les tests (sans listen sur un port).
 * Applique la même config que main.ts (ValidationPipe, filters, etc.).
 */
export async function createTestApp(): Promise<INestApplication> {
  // Le rate limiting est désactivé via DISABLE_THROTTLE=true au top de
  // ce fichier (le ThrottlerGuard n'est alors PAS enregistré au boot).
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Génère X-Request-Id pour cohérence avec main.ts
  app.use((req: any, res: any, next: () => void) => {
    const id = randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  await app.init();
  return app;
}

/**
 * Supprime tous les users de test et toutes leurs références en DB.
 *
 * Certaines FK vers users sont NO ACTION (ex. commandes_vente.seller_id) :
 * il faut donc nettoyer manuellement ces tables avant de supprimer le
 * user. Les FK CASCADE (wallets, annonces, parcelles, etc.) sont
 * automatiquement nettoyées par le DELETE final sur users.
 */
export async function cleanupTestUsers(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);

  const userIdsResult = await prisma.users.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true },
  });
  const ids = userIdsResult.map((u) => u.id);
  if (ids.length === 0) return;

  // Tables référençant users via FK NO ACTION → nettoyage manuel.

  // 1. Récupère les commandes de test pour nettoyer leurs transactions
  //    (y compris celles créées par TREASURY platform : frais service).
  const testCommandes = await prisma.commandes_vente.findMany({
    where: { OR: [{ buyer_id: { in: ids } }, { seller_id: { in: ids } }] },
    select: { id: true },
  });
  const commandeIds = testCommandes.map((c) => c.id);

  await prisma.transactions.deleteMany({
    where: {
      OR: [
        { user_id: { in: ids } },
        ...(commandeIds.length ? [{ commande_id: { in: commandeIds } }] : []),
      ],
    },
  });

  // Nouvelles tables Phase 1.5 : avances coop, contributions agrégées,
  // messages négo, etc.
  await prisma.coop_advance_payments.deleteMany({
    where: { OR: [{ farmer_id: { in: ids } }, { paid_by: { in: ids } }] },
  });
  await prisma.publication_contributions.deleteMany({
    where: { farmer_id: { in: ids } },
  });
  await prisma.negotiation_messages.deleteMany({
    where: { sender_id: { in: ids } },
  });
  await prisma.coop_join_requests.deleteMany({
    where: {
      OR: [{ farmer_id: { in: ids } }, { handled_by: { in: ids } }],
    },
  });
  await prisma.coop_invitations.deleteMany({
    where: {
      OR: [{ invited_user_id: { in: ids } }, { invited_by: { in: ids } }],
    },
  });
  await prisma.admin_audit_log.deleteMany({
    where: { admin_id: { in: ids } },
  });

  await prisma.commandes_vente.deleteMany({
    where: { OR: [{ buyer_id: { in: ids } }, { seller_id: { in: ids } }] },
  });
  await prisma.commande_b2b.deleteMany({
    where: { OR: [{ exporter_id: { in: ids } }, { supplier_id: { in: ids } }] },
  });
  await prisma.lot_contributions.deleteMany({
    where: { farmer_id: { in: ids } },
  });
  await prisma.lots.deleteMany({
    where: { farmer_id: { in: ids } },
  });
  await prisma.propositions_vente.deleteMany({
    where: { vendeur_id: { in: ids } },
  });
  await prisma.contre_offres_coop.deleteMany({
    where: { acheteur_id: { in: ids } },
  });
  await prisma.contrats_vente_coop.deleteMany({
    where: { acheteur_id: { in: ids } },
  });
  await prisma.reservations_previsions.deleteMany({
    where: { acheteur_id: { in: ids } },
  });
  await prisma.offres_marche_b2b.deleteMany({
    where: { exporter_id: { in: ids } },
  });
  await prisma.payout_items.deleteMany({
    where: { user_id: { in: ids } },
  });
  await prisma.payout_batches.deleteMany({
    where: { initiator_id: { in: ids } },
  });
  await prisma.shipments.updateMany({
    where: { transporter_id: { in: ids } },
    data: { transporter_id: null },
  });
  await prisma.candidature_traitements.deleteMany({
    where: { acteur_id: { in: ids } },
  });
  await prisma.proposition_traitements.deleteMany({
    where: { acteur_id: { in: ids } },
  });
  await prisma.contre_offre_coop_traitements.deleteMany({
    where: { acteur_id: { in: ids } },
  });
  await prisma.escrow_conditions.updateMany({
    where: { OR: [{ released_by: { in: ids } }, { beneficiary_id: { in: ids } }] },
    data: { released_by: null, beneficiary_id: null },
  });
  // Sollicitations coop (Chantier 2) : recipients en CASCADE depuis
  // sollicitations_coop, mais sollicitations_coop.initiated_by est en
  // NO ACTION → on supprime manuellement avant de delete les users.
  await prisma.sollicitation_recipients.deleteMany({
    where: { user_id: { in: ids } },
  });
  await prisma.sollicitations_coop.deleteMany({
    where: { initiated_by: { in: ids } },
  });
  await prisma.disputes.updateMany({
    where: { resolved_by: { in: ids } },
    data: { resolved_by: null },
  });
  await prisma.disputes.deleteMany({
    where: { opened_by: { in: ids } },
  });
  await prisma.traceability_events.deleteMany({
    where: { actor_id: { in: ids } },
  });
  await prisma.ai_news.deleteMany({
    where: { created_by: { in: ids } },
  });
  // messages.sender_id est nullable et en NO ACTION → on nullifie
  // plutôt que de supprimer (préserve la trace de la conv côté autre user).
  await prisma.messages.updateMany({
    where: { sender_id: { in: ids } },
    data: { sender_id: null },
  });

  // Le DELETE final déclenche les CASCADE sur les autres tables
  // (wallets, annonces_vente, panier, parcelle, conversations via
  // conversation_participants, etc.).
  await prisma.users.deleteMany({
    where: { id: { in: ids } },
  });

  // Reset le wallet TREASURY plateforme : il accumule les frais service
  // pendant les tests mais n'est jamais cleaned via CASCADE (c'est un
  // user système permanent). Sans ce reset, le ReconciliationCronService
  // détecterait un drift à chaque run.
  await prisma.wallets.updateMany({
    where: { user_id: '00000000-0000-0000-0000-000000000001' },
    data: { balance: 0, balance_escrow: 0 },
  });
}

/**
 * Génère un phone unique pour la durée du test (timestamp + random).
 */
// Compteur monotone pour garantir l'unicité des phones de test au sein
// d'un même run (random ne suffit pas — collisions possibles sur 10k).
let testPhoneCounter = 0;

export function makeTestPhone(suffix?: string): string {
  // 4 chiffres seulement après le prefix → numéro CI valide à 10 chiffres.
  // On utilise un compteur (+ random offset au boot) pour éviter collisions.
  if (suffix !== undefined) {
    return `${TEST_PHONE_PREFIX}${suffix.padStart(4, '0').slice(-4)}`;
  }
  if (testPhoneCounter === 0) {
    testPhoneCounter = Math.floor(Math.random() * 1000);
  }
  testPhoneCounter = (testPhoneCounter + 1) % 10000;
  return `${TEST_PHONE_PREFIX}${testPhoneCounter.toString().padStart(4, '0')}`;
}

/**
 * Helpers d'auth — encapsulent les appels HTTP les plus utilisés.
 */

export async function registerUser(
  app: INestApplication,
  data: { phone: string; full_name: string; role: string; email?: string },
): Promise<{ user_id: string; phone: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send(data);
  if (res.status !== 201) {
    throw new Error(
      `Register failed (${res.status}) for ${JSON.stringify(data)} → ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.data;
}

/**
 * Récupère le code OTP en lisant directement la DB (vu qu'en dev le
 * provider SMS ne fait que logger). On hash → on a juste le code en
 * clair via les logs ou on doit faire autrement. Solution simple :
 * on ne teste pas le flow OTP complet ici, on définit directement le
 * PIN après inscription en utilisant un fake JWT généré manuellement.
 *
 * Pour rester réaliste sans dépendance OTP, on génère un JWT
 * directement via JwtService pour les tests.
 */
export async function makeAccessTokenForUser(
  app: INestApplication,
  userId: string,
): Promise<string> {
  const prisma = app.get(PrismaService);
  const user = await prisma.users.findUnique({
    where: { id: userId },
    include: {
      producteur_profiles: true,
      cooperative_profiles: true,
    },
  });
  if (!user) throw new Error(`Test user ${userId} not found`);

  const config = app.get(ConfigService);
  const jwt = require('@nestjs/jwt');
  const jwtService = new jwt.JwtService({
    secret: config.get<string>('JWT_SECRET'),
  });

  const cooperativeId =
    user.role === 'COOPERATIVE' && user.cooperative_profiles
      ? user.cooperative_profiles.id
      : user.role === 'FARMER' && user.producteur_profiles?.coop_id
        ? user.producteur_profiles.coop_id
        : null;

  return jwtService.signAsync(
    {
      sub: user.id,
      role: user.role,
      phone: user.phone,
      cooperative_id: cooperativeId,
    },
    { expiresIn: '15m' },
  );
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Helper combiné : enregistre un user + génère un token d'accès.
 * Skip le flow OTP — utile pour les tests qui n'ont pas besoin de
 * vérifier l'auth elle-même mais besoin d'un user "connecté".
 */
export async function registerAndGetToken(
  app: INestApplication,
  data: { full_name: string; role: string; email?: string; phone?: string },
): Promise<{ userId: string; phone: string; token: string }> {
  const phone = data.phone ?? makeTestPhone();
  const res = await registerUser(app, {
    phone,
    full_name: data.full_name,
    role: data.role,
    email: data.email,
  });
  const token = await makeAccessTokenForUser(app, res.user_id);
  return { userId: res.user_id, phone: res.phone, token };
}

/**
 * Récupère le premier produit/région/ville actif du catalogue. Throw si
 * la DB est vide (catalogue manquant = setup à corriger).
 */
export async function getCatalogIds(app: INestApplication): Promise<{
  produit_id: string;
  region_id: string;
  ville_id: string;
}> {
  const prisma = app.get(PrismaService);
  const [produit, region, ville] = await Promise.all([
    prisma.produits_agricoles.findFirst({ where: { is_active: true } }),
    prisma.regions_ci.findFirst(),
    prisma.villes_ci.findFirst(),
  ]);
  if (!produit || !region || !ville) {
    throw new Error('Catalogue vide : seed produits_agricoles/regions_ci/villes_ci requis.');
  }
  return { produit_id: produit.id, region_id: region.id, ville_id: ville.id };
}

/**
 * Helper : un FARMER publie une annonce de vente standard. Retourne
 * l'id de l'annonce créée. Utilisé par les tests qui ont besoin d'une
 * annonce mais ne testent pas spécifiquement le marketplace.
 */
export async function publishAnnonceVente(
  app: INestApplication,
  farmerToken: string,
  catalog: { produit_id: string; region_id: string; ville_id: string },
  overrides: Partial<{
    titre: string;
    quantite_kg: number;
    prix_par_kg: number;
    quantite_min_kg: number;
    qualite: string;
  }> = {},
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/marketplace/annonces/vente')
    .set(bearer(farmerToken))
    .send({
      produit_id: catalog.produit_id,
      titre: overrides.titre ?? 'Annonce test',
      quantite_kg: overrides.quantite_kg ?? 500,
      prix_par_kg: overrides.prix_par_kg ?? 1000,
      quantite_min_kg: overrides.quantite_min_kg ?? 50,
      qualite: overrides.qualite ?? 'STANDARD',
      region_id: catalog.region_id,
      ville_id: catalog.ville_id,
      coordinates: { lat: 5.345317, lng: -4.024429 },
    });
  if (res.status !== 201) {
    throw new Error(`publishAnnonceVente failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.annonce_id;
}

/**
 * Helper pour les tests : ajouter un moyen de paiement actif au user.
 * Le BUYER en a besoin pour créer une commande (cf. OrdersService).
 */
export async function addPaymentMethod(
  app: INestApplication,
  userId: string,
  provider: string = 'MTN_MOMO',
): Promise<string> {
  const prisma = app.get(PrismaService);
  const moyen = await prisma.moyen_de_payement.create({
    data: {
      user_id: userId,
      provider: provider as any,
      phone_display: '+2250709123456',
      is_default: true,
      is_active: true,
    },
  });
  return moyen.id;
}
