// =====================================================================
//  Génère la collection Postman v2.1 pour l'API FarmCash
//  ---------------------------------------------------------------------
//  Lancement :  node postman/build-collection.mjs
//  Sortie    :  postman/farmcash-api.postman_collection.json
// =====================================================================

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'farmcash-api.postman_collection.json');

// ---------- helpers --------------------------------------------------

const url = (path) => {
  const clean = path.replace(/^\//, '').split('?')[0];
  const queryStr = path.includes('?') ? path.split('?')[1] : '';
  const queryArr = queryStr
    ? queryStr.split('&').map((kv) => {
        const [key, value = ''] = kv.split('=');
        return { key, value };
      })
    : [];
  return {
    raw: `{{baseUrl}}/${clean}${queryStr ? `?${queryStr}` : ''}`,
    host: ['{{baseUrl}}'],
    path: clean.split('/'),
    ...(queryArr.length ? { query: queryArr } : {}),
  };
};

const json = (obj) => JSON.stringify(obj, null, 2);

const req = ({
  name,
  method,
  path,
  token,
  body,
  desc,
  test,
  headers, // [{ key, value }, …] pour headers additionnels (X-Bootstrap-Token, Idempotency-Key…)
}) => ({
  name,
  ...(test
    ? {
        event: [
          {
            listen: 'test',
            script: { type: 'text/javascript', exec: test.split('\n') },
          },
        ],
      }
    : {}),
  request: {
    method,
    header: [
      ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...(token
        ? [{ key: 'Authorization', value: `Bearer {{${token}}}` }]
        : []),
      ...(headers ?? []),
    ],
    ...(body ? { body: { mode: 'raw', raw: json(body) } } : {}),
    url: url(path),
    ...(desc ? { description: desc } : {}),
  },
  response: [],
});

const folder = (name, items, desc) => ({
  name,
  ...(desc ? { description: desc } : {}),
  item: items,
});

// Test script qui extrait un id du body et le stocke en variable d'env.
const captureId = (envKey, jsonPath = 'data.id') =>
  `try {
  const json = pm.response.json();
  const v = json.${jsonPath};
  if (v) { pm.environment.set('${envKey}', v); console.log('${envKey} =', v); }
} catch (e) {}`;

// Test script pour le register : capture user_id, token, refresh
const captureAuthRegister = (role) =>
  `try {
  const j = pm.response.json();
  if (j.data?.user?.id) pm.environment.set('${role}_id', j.data.user.id);
  if (j.data?.tokens?.access_token)  pm.environment.set('${role}_token',   j.data.tokens.access_token);
  if (j.data?.tokens?.refresh_token) pm.environment.set('${role}_refresh', j.data.tokens.refresh_token);
  console.log('${role}_id      =', pm.environment.get('${role}_id'));
} catch (e) {}`;

const captureAuthLogin = (role) =>
  `try {
  const j = pm.response.json();
  if (j.data?.tokens?.access_token)  pm.environment.set('${role}_token',   j.data.tokens.access_token);
  if (j.data?.tokens?.refresh_token) pm.environment.set('${role}_refresh', j.data.tokens.refresh_token);
  if (j.data?.user?.id)              pm.environment.set('${role}_id',      j.data.user.id);
  console.log('${role}_token (set)');
} catch (e) {}`;

// =====================================================================
//  0. HEALTH + CATALOGUE
// =====================================================================

const healthFolder = folder('🩺 0. Health', [
  req({
    name: 'GET /auth/health',
    method: 'GET',
    path: '/auth/health',
  }),
  req({
    name: 'GET /ai/health',
    method: 'GET',
    path: '/ai/health',
  }),
]);

const catalogueFolder = folder(
  '📦 0. Catalogue (public)',
  [
    req({
      name: 'GET /marketplace/produits',
      method: 'GET',
      path: '/marketplace/produits',
      test: `try {
  const list = pm.response.json().data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('produit_id', list[0].id);
    console.log('produit_id =', list[0].id);
  }
} catch (e) {}`,
    }),
    req({
      name: 'GET /marketplace/categories',
      method: 'GET',
      path: '/marketplace/categories',
    }),
  ],
  'Routes publiques. Au moins une fois → seed `produit_id`. Pour `region_id` et `ville_id`, voir le README (SQL direct).',
);

// =====================================================================
//  1. AUTH (gère TOUS les acteurs)
// =====================================================================

// Rôles autorisés via /auth/register (public). ADMIN n'y figure plus —
// utiliser /auth/admin/bootstrap puis /auth/admin/register (voir plus bas).
const roles = [
  { key: 'farmer',      role: 'FARMER',      name: 'Farmer Test',      phone: '{{farmer_phone}}' },
  { key: 'buyer',       role: 'BUYER',       name: 'Buyer Test',       phone: '{{buyer_phone}}' },
  { key: 'coop',        role: 'COOPERATIVE', name: 'Coop Test',        phone: '{{coop_phone}}' },
  { key: 'transporter', role: 'TRANSPORTER', name: 'Transporter Test', phone: '{{transporter_phone}}' },
  { key: 'exporter',    role: 'EXPORTER',    name: 'Exporter Test',    phone: '{{exporter_phone}}' },
];

const authFolder = folder(
  '🔐 1. Auth (6 rôles)',
  [
    ...roles.flatMap((r) => [
      req({
        name: `Register ${r.role}`,
        method: 'POST',
        path: '/auth/register',
        body: {
          phone: r.phone,
          full_name: r.name,
          role: r.role,
          langue: 'fr',
        },
        test: captureAuthRegister(r.key),
      }),
      req({
        name: `Send OTP - ${r.role}`,
        method: 'POST',
        path: '/auth/send-otp',
        body: { phone: r.phone, purpose: 'LOGIN' },
        desc:
          'Mode dev : l\'OTP est loggé côté serveur. Récupère-le dans les logs, puis utilise-le dans `verify-otp`.',
      }),
      req({
        name: `Verify OTP - ${r.role}`,
        method: 'POST',
        path: '/auth/verify-otp',
        body: { phone: r.phone, code: '000000', purpose: 'LOGIN' },
        desc:
          'Remplace `000000` par le code affiché dans les logs serveur (mode dev).',
      }),
      req({
        name: `Set PIN - ${r.role}`,
        method: 'POST',
        path: '/auth/set-pin',
        token: `${r.key}_token`,
        body: { pin: '{{default_pin}}', pin_confirm: '{{default_pin}}' },
      }),
      req({
        name: `Login PIN - ${r.role}`,
        method: 'POST',
        path: '/auth/login-pin',
        body: { phone: r.phone, pin: '{{default_pin}}' },
        test: captureAuthLogin(r.key),
      }),
    ]),
    req({
      name: 'GET /auth/me (farmer)',
      method: 'GET',
      path: '/auth/me',
      token: 'farmer_token',
    }),
    req({
      name: 'POST /auth/profile/update',
      method: 'POST',
      path: '/auth/profile/update',
      token: 'farmer_token',
      body: {
        full_name: 'Farmer Test Updated',
        email: 'farmer@example.ci',
        langue: 'dioula',
      },
    }),
    req({
      name: 'POST /auth/change-pin',
      method: 'POST',
      path: '/auth/change-pin',
      token: 'farmer_token',
      body: {
        old_pin: '{{default_pin}}',
        new_pin: '654321',
        new_pin_confirm: '654321',
      },
    }),
    req({
      name: 'POST /auth/device-token (FCM)',
      method: 'POST',
      path: '/auth/device-token',
      token: 'farmer_token',
      body: {
        fcm_token: 'fcm-test-token-abc123xyz',
        platform: 'android',
      },
    }),
    req({
      name: 'POST /auth/refresh',
      method: 'POST',
      path: '/auth/refresh',
      body: { refresh_token: '{{farmer_refresh}}' },
      test: captureAuthLogin('farmer'),
    }),
    req({
      name: 'POST /auth/logout (single session)',
      method: 'POST',
      path: '/auth/logout',
      token: 'farmer_token',
      body: { refresh_token: '{{farmer_refresh}}' },
    }),
    req({
      name: 'POST /auth/logout (all sessions)',
      method: 'POST',
      path: '/auth/logout',
      token: 'farmer_token',
      body: {},
    }),

    // ─── ADMIN : bootstrap (1er super-admin) + register (admins suivants) ──
    req({
      name: 'POST /auth/admin/bootstrap (1er SUPER_ADMIN)',
      method: 'POST',
      path: '/auth/admin/bootstrap',
      headers: [
        { key: 'X-Bootstrap-Token', value: '{{bootstrap_admin_token}}' },
      ],
      body: {
        phone: '{{admin_phone}}',
        full_name: 'Super Admin Initial',
        email: 'admin@farmcash.ci',
        langue: 'fr',
      },
      test: `try {
  const j = pm.response.json();
  if (j.data?.user_id) pm.environment.set('admin_id', j.data.user_id);
  console.log('admin_id =', pm.environment.get('admin_id'));
} catch (e) {}`,
      desc:
        'Crée le 1er SUPER_ADMIN avec toutes les permissions. Requiert :\n' +
        '  • Header X-Bootstrap-Token doit matcher BOOTSTRAP_ADMIN_TOKEN (env)\n' +
        '  • Aucun admin ne doit déjà exister en base\n\n' +
        '⚠️ Après cette opération : rotate `BOOTSTRAP_ADMIN_TOKEN` dans .env.\n\n' +
        'Workflow ensuite : Send OTP → Verify OTP → Set PIN → Login PIN (admin_phone)\n' +
        'pour récupérer admin_token et utiliser les routes ADMIN.',
    }),
    req({
      name: 'POST /auth/admin/register (par SUPER_ADMIN)',
      method: 'POST',
      path: '/auth/admin/register',
      token: 'admin_token',
      body: {
        phone: '+2250701020307',
        full_name: 'Modérateur Marketplace',
        email: 'moderation@farmcash.ci',
        langue: 'fr',
        niveau: 'MODERATOR',
        departement: 'Modération',
        peut_valider_kyc: false,
        peut_gerer_finance: false,
        peut_gerer_users: false,
        peut_publier_news: false,
      },
      desc:
        'Création d\'un admin par un SUPER_ADMIN authentifié.\n' +
        'Niveaux : SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT.\n' +
        '403 si admin_token n\'appartient pas à un SUPER_ADMIN.',
    }),

    // ─── ADMIN : compléter la chaîne d'auth pour récupérer admin_token ───
    req({
      name: 'Send OTP - ADMIN',
      method: 'POST',
      path: '/auth/send-otp',
      body: { phone: '{{admin_phone}}', purpose: 'LOGIN' },
      desc:
        'Après /auth/admin/bootstrap : envoie un OTP pour pouvoir définir un PIN.',
    }),
    req({
      name: 'Verify OTP - ADMIN',
      method: 'POST',
      path: '/auth/verify-otp',
      body: { phone: '{{admin_phone}}', code: '000000', purpose: 'LOGIN' },
      test: captureAuthLogin('admin'),
      desc: 'Remplace `000000` par le code affiché dans les logs serveur.',
    }),
    req({
      name: 'Set PIN - ADMIN',
      method: 'POST',
      path: '/auth/set-pin',
      token: 'admin_token',
      body: { pin: '{{default_pin}}', pin_confirm: '{{default_pin}}' },
    }),
    req({
      name: 'Login PIN - ADMIN',
      method: 'POST',
      path: '/auth/login-pin',
      body: { phone: '{{admin_phone}}', pin: '{{default_pin}}' },
      test: captureAuthLogin('admin'),
    }),
  ],
  '🔐 Workflow ADMIN sécurisé :\n' +
    '  1. Définir `BOOTSTRAP_ADMIN_TOKEN` dans .env serveur (puis restart).\n' +
    '  2. Définir `bootstrap_admin_token` dans cet environnement Postman.\n' +
    '  3. `POST /auth/admin/bootstrap` → crée le 1er SUPER_ADMIN.\n' +
    '  4. Send OTP → Verify OTP → Set PIN → Login PIN (admin_phone) → admin_token.\n' +
    '  5. (optionnel) `POST /auth/admin/register` pour créer d\'autres admins.\n' +
    '  6. Retirer/rotate `BOOTSTRAP_ADMIN_TOKEN` du .env.\n\n' +
    'Le rôle ADMIN N\'EST PLUS accepté par `/auth/register` (403 ForbiddenException).',
);

// =====================================================================
//  2. MARKETPLACE - Annonces vente / achat / publications coop
// =====================================================================

const marketplaceAnnoncesVenteFolder = folder('🛒 2.1 Annonces vente', [
  req({
    name: 'GET /marketplace/annonces/vente (public)',
    method: 'GET',
    path: '/marketplace/annonces/vente?page=1&limit=20',
  }),
  req({
    name: 'POST /marketplace/annonces/vente (FARMER)',
    method: 'POST',
    path: '/marketplace/annonces/vente',
    token: 'farmer_token',
    body: {
      produit_id: '{{produit_id}}',
      titre: 'Maïs premium Bouaké récolte 2026',
      description: 'Maïs fermenté 7 jours, séché au soleil. Origine Bouaké.',
      quantite_kg: 500,
      prix_par_kg: 1500,
      quantite_min_kg: 50,
      qualite: 'PREMIUM',
      certifications: ['BIO'],
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      coordinates: { lat: 7.683, lng: -5.0303 },
    },
    test: captureId('annonce_vente_id'),
  }),
  req({
    name: 'POST /marketplace/annonces/vente AVEC TRAITEMENTS (par NOM — simple)',
    method: 'POST',
    path: '/marketplace/annonces/vente',
    token: 'farmer_token',
    body: {
      produit_id: '{{produit_id}}',
      titre: 'Maïs grain blanc avec traçabilité traitements',
      quantite_kg: 300,
      prix_par_kg: 350,
      quantite_min_kg: 50,
      qualite: 'PREMIUM',
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      coordinates: { lat: 7.683, lng: -5.0303 },
      traitements: [
        {
          produit_traitement_nom: 'Neem bio',
          dosage_utilise: '50g / 10L eau',
          date_application: '2026-03-15',
          delai_carence_respecte: true,
          notes: 'Pulvérisation foliaire 2 semaines avant récolte.',
        },
        {
          produit_traitement_nom: 'NPK 15-15-15',
          date_application: '2026-02-20',
          notes: 'Apport en couverture au tallage.',
        },
      ],
    },
  }),
  req({
    name: 'GET /ai/treatments/search?q=neem (autocomplete)',
    method: 'GET',
    path: '/ai/treatments/search?q=neem',
    token: 'farmer_token',
    desc: 'Recherche par préfixe/contains sur le nom. Min 2 caractères. Pour autocomplete mobile.',
  }),
  req({
    name: 'GET /marketplace/annonces/vente/:id',
    method: 'GET',
    path: '/marketplace/annonces/vente/{{annonce_vente_id}}',
  }),
  req({
    name: 'PUT /marketplace/annonces/vente/:id (FARMER)',
    method: 'PUT',
    path: '/marketplace/annonces/vente/{{annonce_vente_id}}',
    token: 'farmer_token',
    body: { prix_par_kg: 1450, quantite_kg: 480 },
  }),
  req({
    name: 'DELETE /marketplace/annonces/vente/:id (FARMER)',
    method: 'DELETE',
    path: '/marketplace/annonces/vente/{{annonce_vente_id}}',
    token: 'farmer_token',
  }),
]);

const marketplaceAnnoncesAchatFolder = folder('🛒 2.2 Annonces achat', [
  req({
    name: 'GET /marketplace/annonces/achat',
    method: 'GET',
    path: '/marketplace/annonces/achat?page=1&limit=20',
  }),
  req({
    name: 'POST /marketplace/annonces/achat (PUBLIC, défaut)',
    method: 'POST',
    path: '/marketplace/annonces/achat',
    token: 'buyer_token',
    body: {
      produit_id: '{{produit_id}}',
      quantite_kg: 300,
      prix_max_kg: 1600,
      qualite: 'PREMIUM',
      region_id: '{{region_id}}',
      rayon_km: 100,
    },
    test: captureId('annonce_achat_id'),
  }),
  req({
    name: 'POST /marketplace/annonces/achat (ALL_COOPERATIVES)',
    method: 'POST',
    path: '/marketplace/annonces/achat',
    token: 'buyer_token',
    body: {
      produit_id: '{{produit_id}}',
      quantite_kg: 1000,
      prix_max_kg: 1500,
      qualite: 'PREMIUM',
      region_id: '{{region_id}}',
      rayon_km: 200,
      target_audience: 'ALL_COOPERATIVES',
    },
  }),
  req({
    name: 'POST /marketplace/annonces/achat (SPECIFIC_COOPERATIVE)',
    method: 'POST',
    path: '/marketplace/annonces/achat',
    token: 'buyer_token',
    body: {
      produit_id: '{{produit_id}}',
      quantite_kg: 500,
      prix_max_kg: 1550,
      qualite: 'PREMIUM',
      region_id: '{{region_id}}',
      target_audience: 'SPECIFIC_COOPERATIVE',
      target_cooperative_id: '{{cooperative_id}}',
    },
  }),
  req({
    name: 'GET /marketplace/annonces/achat/:id',
    method: 'GET',
    path: '/marketplace/annonces/achat/{{annonce_achat_id}}',
  }),
  req({
    name: 'PUT /marketplace/annonces/achat/:id (BUYER)',
    method: 'PUT',
    path: '/marketplace/annonces/achat/{{annonce_achat_id}}',
    token: 'buyer_token',
    body: { quantite_kg: 350, prix_max_kg: 1700 },
  }),
  req({
    name: 'DELETE /marketplace/annonces/achat/:id (BUYER)',
    method: 'DELETE',
    path: '/marketplace/annonces/achat/{{annonce_achat_id}}',
    token: 'buyer_token',
  }),
]);

// Publications coop déplacées dans le dossier 12. Cooperatives.
// Ce sous-dossier reste vide pour rappeler la migration.
const marketplacePublicationsCoopFolder = folder('🛒 2.3 Publications coop → migrées 12. Cooperatives', []);

// =====================================================================
//  3. MARKETPLACE - Panier, Interactions, Stocks, Agronomie, Prévisions
// =====================================================================

const panierFolder = folder('🛍 3.1 Panier (BUYER/COOP)', [
  req({
    name: 'GET /marketplace/panier',
    method: 'GET',
    path: '/marketplace/panier',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /marketplace/panier/add',
    method: 'POST',
    path: '/marketplace/panier/add',
    token: 'buyer_token',
    body: { annonce_id: '{{annonce_vente_id}}', quantite_kg: 100 },
    test: captureId('panier_item_id'),
  }),
  req({
    name: 'DELETE /marketplace/panier/:itemId',
    method: 'DELETE',
    path: '/marketplace/panier/{{panier_item_id}}',
    token: 'buyer_token',
  }),
]);

const interactionsFolder = folder('❤️ 3.2 Interactions (favoris/avis/médias)', [
  req({
    name: 'GET /marketplace/interactions/favoris',
    method: 'GET',
    path: '/marketplace/interactions/favoris',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /marketplace/interactions/favoris/toggle',
    method: 'POST',
    path: '/marketplace/interactions/favoris/toggle',
    token: 'buyer_token',
    body: { annonce_id: '{{annonce_vente_id}}' },
  }),
  req({
    name: 'POST /marketplace/interactions/avis',
    method: 'POST',
    path: '/marketplace/interactions/avis',
    token: 'buyer_token',
    body: {
      annonce_id: '{{annonce_vente_id}}',
      rating: 5,
      commentaire: 'Excellent maïs, livraison rapide.',
    },
    test: captureId('avis_id'),
  }),
  req({
    name: 'DELETE /marketplace/interactions/avis/:id',
    method: 'DELETE',
    path: '/marketplace/interactions/avis/{{avis_id}}',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /marketplace/interactions/medias',
    method: 'POST',
    path: '/marketplace/interactions/medias',
    token: 'farmer_token',
    body: {
      target_type: 'ANNONCE_VENTE',
      target_id: '{{annonce_vente_id}}',
      url: 'https://cdn.farmcash.ci/photos/maïs1.jpg',
      thumbnail_url: 'https://cdn.farmcash.ci/photos/maïs1_thumb.jpg',
      type: 'IMAGE',
    },
    test: captureId('media_id'),
  }),
  req({
    name: 'DELETE /marketplace/interactions/medias/:id',
    method: 'DELETE',
    path: '/marketplace/interactions/medias/{{media_id}}',
    token: 'farmer_token',
  }),
]);

const stocksFolder = folder('📦 3.3 Stocks (entrepôts + lots)', [
  req({
    name: 'GET /marketplace/stocks/entrepots',
    method: 'GET',
    path: '/marketplace/stocks/entrepots',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /marketplace/stocks/entrepots',
    method: 'POST',
    path: '/marketplace/stocks/entrepots',
    token: 'farmer_token',
    body: {
      nom: 'Entrepôt Bouaké Centre',
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      adresse: 'Quartier Air France, près du marché',
      capacite_kg: 10000,
      is_refrigere: false,
    },
    test: captureId('entrepot_id'),
  }),
  req({
    name: 'PUT /marketplace/stocks/entrepots/:id',
    method: 'PUT',
    path: '/marketplace/stocks/entrepots/{{entrepot_id}}',
    token: 'farmer_token',
    body: { capacite_kg: 12000, is_refrigere: true },
  }),
  req({
    name: 'DELETE /marketplace/stocks/entrepots/:id',
    method: 'DELETE',
    path: '/marketplace/stocks/entrepots/{{entrepot_id}}',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /marketplace/stocks/lots',
    method: 'GET',
    path: '/marketplace/stocks/lots',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /marketplace/stocks/lots',
    method: 'POST',
    path: '/marketplace/stocks/lots',
    token: 'farmer_token',
    body: {
      lot_code: 'LOT-CACAO-2026-001',
      type: 'INDIVIDUAL',
      produit_id: '{{produit_id}}',
      quantite_kg: 500,
      qualite: 'PREMIUM',
      date_recolte: '2026-04-15',
    },
    test: captureId('lot_id'),
  }),
  req({
    name: 'PUT /marketplace/stocks/lots/:id',
    method: 'PUT',
    path: '/marketplace/stocks/lots/{{lot_id}}',
    token: 'farmer_token',
    body: { quantite_kg: 480, qualite: 'BIO' },
  }),
  req({
    name: 'DELETE /marketplace/stocks/lots/:id',
    method: 'DELETE',
    path: '/marketplace/stocks/lots/{{lot_id}}',
    token: 'farmer_token',
  }),
]);

const agronomieFolder = folder('🌱 3.4 Agronomie (parcelles + cultures)', [
  req({
    name: 'GET /marketplace/agronomie/parcelles',
    method: 'GET',
    path: '/marketplace/agronomie/parcelles',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /marketplace/agronomie/parcelles',
    method: 'POST',
    path: '/marketplace/agronomie/parcelles',
    token: 'farmer_token',
    body: {
      nom: 'Parcelle Nord-Bouaké',
      taille_hectares: 5.5,
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      centroid: { lat: 7.690, lng: -5.030 },
    },
    test: captureId('parcelle_id'),
  }),
  req({
    name: 'PUT /marketplace/agronomie/parcelles/:id',
    method: 'PUT',
    path: '/marketplace/agronomie/parcelles/{{parcelle_id}}',
    token: 'farmer_token',
    body: { taille_hectares: 6.0 },
  }),
  req({
    name: 'DELETE /marketplace/agronomie/parcelles/:id',
    method: 'DELETE',
    path: '/marketplace/agronomie/parcelles/{{parcelle_id}}',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /marketplace/agronomie/cultures',
    method: 'GET',
    path: '/marketplace/agronomie/cultures',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /marketplace/agronomie/cultures',
    method: 'POST',
    path: '/marketplace/agronomie/cultures',
    token: 'farmer_token',
    body: {
      parcelle_id: '{{parcelle_id}}',
      produit_id: '{{produit_id}}',
      superficie_ha: 3.5,
      date_plantation: '2026-01-10',
    },
    test: captureId('culture_id'),
  }),
  req({
    name: 'DELETE /marketplace/agronomie/cultures/:id',
    method: 'DELETE',
    path: '/marketplace/agronomie/cultures/{{culture_id}}',
    token: 'farmer_token',
  }),
]);

const previsionsFolder = folder('🌾 3.5 Prévisions de récolte', [
  req({
    name: 'GET /marketplace/previsions (FARMER)',
    method: 'GET',
    path: '/marketplace/previsions',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /marketplace/previsions (FARMER)',
    method: 'POST',
    path: '/marketplace/previsions',
    token: 'farmer_token',
    body: {
      produit_id: '{{produit_id}}',
      parcelle_id: '{{parcelle_id}}',
      saison: 'Q3-2026',
      quantite_prev_kg: 2000,
      date_recolte_prev: '2026-09-15',
      prix_cible_kg: 1500,
      notes: 'Récolte estimée 5% en plus que 2025.',
    },
    test: captureId('prevision_id'),
  }),
  req({
    name: 'POST /marketplace/previsions/reserver (BUYER)',
    method: 'POST',
    path: '/marketplace/previsions/reserver',
    token: 'buyer_token',
    body: {
      prevision_id: '{{prevision_id}}',
      quantite_kg: 500,
      prix_reserve_kg: 1500,
    },
    test: captureId('reservation_id'),
  }),
]);

// =====================================================================
//  4. NEGOTIATION
// =====================================================================

const negotiationMessagesFolder = folder('💬 4.4 Chat libre par négociation', [
  req({
    name: 'POST /negotiation/candidatures/:id/messages',
    method: 'POST',
    path: '/negotiation/candidatures/{{candidature_id}}/messages',
    token: 'buyer_token',
    body: { content: 'Bonjour, est-ce que vous pouvez livrer sous 48h ?' },
  }),
  req({
    name: 'GET /negotiation/candidatures/:id/messages',
    method: 'GET',
    path: '/negotiation/candidatures/{{candidature_id}}/messages',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /negotiation/propositions/:id/messages',
    method: 'POST',
    path: '/negotiation/propositions/{{proposition_id}}/messages',
    token: 'farmer_token',
    body: { content: 'OK pour 1500 F/kg si commande > 200 kg.' },
  }),
  req({
    name: 'GET /negotiation/propositions/:id/messages',
    method: 'GET',
    path: '/negotiation/propositions/{{proposition_id}}/messages',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /negotiation/contre-offres-coop/:id/messages',
    method: 'POST',
    path: '/negotiation/contre-offres-coop/{{contre_offre_id}}/messages',
    token: 'buyer_token',
    body: { content: 'Pouvez-vous certifier BIO sur ce lot ?' },
  }),
  req({
    name: 'GET /negotiation/contre-offres-coop/:id/messages',
    method: 'GET',
    path: '/negotiation/contre-offres-coop/{{contre_offre_id}}/messages',
    token: 'coop_token',
  }),
]);

const negotiationFolder = folder('💬 4. Negotiation', [
  // Candidatures BUYER → FARMER
  req({
    name: 'POST /negotiation/candidatures (BUYER)',
    method: 'POST',
    path: '/negotiation/candidatures',
    token: 'buyer_token',
    body: {
      annonce_id: '{{annonce_vente_id}}',
      quantite_kg: 100,
      prix_propose_kg: 1450,
      message: "J'achète 100 kg si vous baissez le prix.",
    },
    test: captureId('candidature_id'),
  }),
  req({
    name: 'GET /negotiation/candidatures (outgoing - BUYER)',
    method: 'GET',
    path: '/negotiation/candidatures?direction=outgoing',
    token: 'buyer_token',
  }),
  req({
    name: 'GET /negotiation/candidatures (incoming - FARMER)',
    method: 'GET',
    path: '/negotiation/candidatures?direction=incoming',
    token: 'farmer_token',
  }),
  req({
    name: 'PUT /negotiation/candidatures/:id/traiter (FARMER accepte)',
    method: 'PUT',
    path: '/negotiation/candidatures/{{candidature_id}}/traiter',
    token: 'farmer_token',
    body: { action: 'ACCEPTED', note: 'OK on est d\'accord.' },
  }),
  req({
    name: 'PUT /negotiation/candidatures/:id/traiter (FARMER contre-offre)',
    method: 'PUT',
    path: '/negotiation/candidatures/{{candidature_id}}/traiter',
    token: 'farmer_token',
    body: {
      action: 'COUNTER_OFFER',
      prix_contre_offre: 1500,
      quantite_kg: 100,
      note: 'Je peux faire 1500 FCFA/kg.',
    },
  }),
  // Propositions FARMER/COOP → BUYER
  req({
    name: 'POST /negotiation/propositions (FARMER)',
    method: 'POST',
    path: '/negotiation/propositions',
    token: 'farmer_token',
    body: {
      annonce_achat_id: '{{annonce_achat_id}}',
      annonce_vente_id: '{{annonce_vente_id}}',
      quantite_kg: 200,
      prix_propose_kg: 1500,
      delai_livraison_j: 7,
      lieu_livraison: 'Abidjan Plateau',
      message: "J'ai 200 kg disponibles sous 7 jours.",
    },
    test: captureId('proposition_id'),
  }),
  req({
    name: 'GET /negotiation/propositions (BUYER incoming)',
    method: 'GET',
    path: '/negotiation/propositions?direction=incoming',
    token: 'buyer_token',
  }),
  req({
    name: 'PUT /negotiation/propositions/:id/traiter (BUYER accepte)',
    method: 'PUT',
    path: '/negotiation/propositions/{{proposition_id}}/traiter',
    token: 'buyer_token',
    body: { action: 'ACCEPTED' },
  }),
  // Contre-offres BUYER → COOP
  req({
    name: 'POST /negotiation/contre-offres-coop (BUYER)',
    method: 'POST',
    path: '/negotiation/contre-offres-coop',
    token: 'buyer_token',
    body: {
      publication_id: '{{publication_coop_id}}',
      quantite_kg: 1000,
      prix_propose_kg: 1300,
      message: 'Offre groupée pour 1 tonne.',
    },
  }),
  req({
    name: 'GET /negotiation/contre-offres-coop (COOP incoming)',
    method: 'GET',
    path: '/negotiation/contre-offres-coop?direction=incoming',
    token: 'coop_token',
  }),
  // Sous-dossier chat libre (inline pour rester dans le module Negotiation)
  negotiationMessagesFolder,
]);

// =====================================================================
//  5. ORDERS
// =====================================================================

const ordersFolder = folder('📋 5. Orders', [
  req({
    name: 'POST /orders (DIRECT_ANNONCE_VENTE, sans transport)',
    method: 'POST',
    path: '/orders',
    token: 'buyer_token',
    body: {
      source_type: 'DIRECT_ANNONCE_VENTE',
      annonce_vente_id: '{{annonce_vente_id}}',
      quantite_kg: 100,
      payment_method_id: '{{payment_method_id}}',
      pickup_address: 'Bouaké, Quartier Air France',
      notes: 'Retrait sur place.',
    },
    test: captureId('order_id'),
  }),
  req({
    name: 'POST /orders (DIRECT_ANNONCE_VENTE + transport)',
    method: 'POST',
    path: '/orders',
    token: 'buyer_token',
    body: {
      source_type: 'DIRECT_ANNONCE_VENTE',
      annonce_vente_id: '{{annonce_vente_id}}',
      quantite_kg: 100,
      payment_method_id: '{{payment_method_id}}',
      transporter_route_id: '{{route_id}}',
      delivery_address: 'Abidjan, Plateau, rue 12',
    },
    test: captureId('order_id'),
  }),
  req({
    name: 'POST /orders (CANDIDATURE_ACCEPTED)',
    method: 'POST',
    path: '/orders',
    token: 'buyer_token',
    body: {
      source_type: 'CANDIDATURE_ACCEPTED',
      candidature_id: '{{candidature_id}}',
      quantite_kg: 100,
      payment_method_id: '{{payment_method_id}}',
    },
  }),
  req({
    name: 'POST /orders (PROPOSITION_ACCEPTED)',
    method: 'POST',
    path: '/orders',
    token: 'buyer_token',
    body: {
      source_type: 'PROPOSITION_ACCEPTED',
      proposition_id: '{{proposition_id}}',
      quantite_kg: 200,
      payment_method_id: '{{payment_method_id}}',
    },
  }),
  req({
    name: 'POST /orders (RESERVATION_CONFIRMED)',
    method: 'POST',
    path: '/orders',
    token: 'buyer_token',
    body: {
      source_type: 'RESERVATION_CONFIRMED',
      reservation_id: '{{reservation_id}}',
      quantite_kg: 500,
      payment_method_id: '{{payment_method_id}}',
    },
  }),
  req({
    name: 'GET /orders/my (BUYER)',
    method: 'GET',
    path: '/orders/my?page=1&limit=20&side=buyer',
    token: 'buyer_token',
  }),
  req({
    name: 'GET /orders/my (FARMER vue seller)',
    method: 'GET',
    path: '/orders/my?page=1&limit=20&side=seller',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /orders/:id',
    method: 'GET',
    path: '/orders/{{order_id}}',
    token: 'buyer_token',
  }),
  req({
    name: 'PUT /orders/:id/status (FARMER accepte)',
    method: 'PUT',
    path: '/orders/{{order_id}}/status',
    token: 'farmer_token',
    body: { status: 'ACCEPTED', notes: 'OK, je prépare.' },
  }),
  req({
    name: 'PUT /orders/:id/status (DELIVERED)',
    method: 'PUT',
    path: '/orders/{{order_id}}/status',
    token: 'farmer_token',
    body: { status: 'DELIVERED' },
  }),
  // Disputes
  req({
    name: 'POST /orders/disputes (BUYER)',
    method: 'POST',
    path: '/orders/disputes',
    token: 'buyer_token',
    body: {
      commande_id: '{{order_id}}',
      raison: "La qualité reçue ne correspond pas à l'annonce, sacs humides.",
      preuves_urls: ['https://cdn.farmcash.ci/proof/dispute1.jpg'],
    },
    test: captureId('dispute_id'),
  }),
  req({
    name: 'GET /orders/disputes/my',
    method: 'GET',
    path: '/orders/disputes/my',
    token: 'buyer_token',
  }),
  req({
    name: 'PUT /orders/disputes/:id/resolve (ADMIN)',
    method: 'PUT',
    path: '/orders/disputes/{{dispute_id}}/resolve',
    token: 'admin_token',
    body: { resolution: 'PARTIAL_REFUND', note: 'Remboursement 30%' },
  }),
]);

// =====================================================================
//  6. FINANCE
// =====================================================================

const financeFolder = folder('💰 6. Finance', [
  req({
    name: 'GET /finance/wallet',
    method: 'GET',
    path: '/finance/wallet?page=1&limit=20',
    token: 'buyer_token',
  }),
  req({
    name: 'GET /finance/moyens-payement',
    method: 'GET',
    path: '/finance/moyens-payement',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /finance/moyens-payement',
    method: 'POST',
    path: '/finance/moyens-payement',
    token: 'buyer_token',
    body: {
      provider: 'ORANGE_MONEY',
      phone_display: '+2250701020302',
      is_default: true,
    },
    test: captureId('payment_method_id'),
  }),
  req({
    name: 'PUT /finance/moyens-payement/:id',
    method: 'PUT',
    path: '/finance/moyens-payement/{{payment_method_id}}',
    token: 'buyer_token',
    body: { is_default: true, is_active: true },
  }),
  req({
    name: 'DELETE /finance/moyens-payement/:id',
    method: 'DELETE',
    path: '/finance/moyens-payement/{{payment_method_id}}',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /finance/confirm-delivery (BUYER libère escrows)',
    method: 'POST',
    path: '/finance/confirm-delivery',
    token: 'buyer_token',
    body: { commande_id: '{{order_id}}' },
  }),
  req({
    name: 'POST /finance/release-escrow (ADMIN, kind=PRODUCT)',
    method: 'POST',
    path: '/finance/release-escrow',
    token: 'admin_token',
    body: {
      commande_id: '{{order_id}}',
      kind: 'PRODUCT',
      reason: 'Litige résolu côté vendeur.',
    },
  }),
  req({
    name: 'POST /finance/payout',
    method: 'POST',
    path: '/finance/payout',
    token: 'farmer_token',
    body: {
      amount: 50000,
      payment_method_id: '{{payment_method_id}}',
    },
  }),
  req({
    name: 'POST /finance/payout-batches (COOP/ADMIN)',
    method: 'POST',
    path: '/finance/payout-batches',
    token: 'coop_token',
    body: {
      items: [
        { user_id: '{{farmer_id}}', amount: 30000 },
        { user_id: '{{farmer_id}}', amount: 20000, commande_id: '{{order_id}}' },
      ],
    },
  }),
  req({
    name: 'GET /finance/payout-batches',
    method: 'GET',
    path: '/finance/payout-batches',
    token: 'coop_token',
  }),
  req({
    name: 'GET /finance/reconciliation (ADMIN)',
    method: 'GET',
    path: '/finance/reconciliation',
    token: 'admin_token',
    desc: 'Vérifie la cohérence wallets ↔ transactions. Renvoie le drift (0 = OK).',
  }),
  req({
    name: 'POST /webhooks/payment-provider/mock (simulation callback)',
    method: 'POST',
    path: '/webhooks/payment-provider/mock',
    body: {
      provider: 'mock',
      provider_ref: 'mock-test-12345',
      idempotency_key: 'test-key-001',
      status: 'ACCEPTED',
      amount: 1000,
      kind: 'PAYIN',
    },
    desc: 'Endpoint qui sera appelé par Orange/MTN/Wave en prod. En dev, simulation manuelle.',
  }),
]);

// =====================================================================
//  7. LOGISTICS
// =====================================================================

const logisticsFolder = folder('🚚 7. Logistics', [
  req({
    name: 'GET /logistics/routes/my (TRANSPORTER)',
    method: 'GET',
    path: '/logistics/routes/my',
    token: 'transporter_token',
  }),
  req({
    name: 'POST /logistics/routes (TRANSPORTER)',
    method: 'POST',
    path: '/logistics/routes',
    token: 'transporter_token',
    body: {
      origin_zone: 'Bouaké',
      destination_zone: 'Abidjan',
      tarif_kg: 200,
      tarif_minimum: 10000,
      capacite_max_kg: 1000,
      delai_typique: 'Sous 24h',
    },
    test: captureId('route_id'),
  }),
  req({
    name: 'PUT /logistics/routes/:id',
    method: 'PUT',
    path: '/logistics/routes/{{route_id}}',
    token: 'transporter_token',
    body: { tarif_kg: 180, capacite_max_kg: 1500 },
  }),
  req({
    name: 'DELETE /logistics/routes/:id',
    method: 'DELETE',
    path: '/logistics/routes/{{route_id}}',
    token: 'transporter_token',
  }),
  req({
    name: 'GET /logistics/quotes (BUYER)',
    method: 'GET',
    path: '/logistics/quotes?origin_zone=Bouak%C3%A9&destination_zone=Abidjan&quantite_kg=100',
    token: 'buyer_token',
  }),
  req({
    name: 'GET /logistics/missions/available (TRANSPORTER)',
    method: 'GET',
    path: '/logistics/missions/available',
    token: 'transporter_token',
    test: `try {
  const list = pm.response.json().data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('shipment_id', list[0].id);
    console.log('shipment_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'POST /logistics/shipments/:id/accept',
    method: 'POST',
    path: '/logistics/shipments/{{shipment_id}}/accept',
    token: 'transporter_token',
  }),
  req({
    name: 'POST /logistics/shipments/:id/start-loading',
    method: 'POST',
    path: '/logistics/shipments/{{shipment_id}}/start-loading',
    token: 'transporter_token',
    body: { pickup_position: { lat: 7.683, lng: -5.0303 } },
  }),
  req({
    name: 'POST /logistics/shipments/:id/track',
    method: 'POST',
    path: '/logistics/shipments/{{shipment_id}}/track',
    token: 'transporter_token',
    body: {
      position: { lat: 5.5, lng: -4.5 },
      status: 'IN_TRANSIT',
      note: 'En route vers Abidjan.',
    },
  }),
  req({
    name: 'POST /logistics/shipments/:id/deliver',
    method: 'POST',
    path: '/logistics/shipments/{{shipment_id}}/deliver',
    token: 'transporter_token',
    body: {
      photo_preuve_url: 'https://cdn.farmcash.ci/proof/delivery1.jpg',
      delivery_position: { lat: 5.345317, lng: -4.024429 },
      note: 'Livré au buyer.',
    },
  }),
  req({
    name: 'POST /logistics/shipments/:id/cancel',
    method: 'POST',
    path: '/logistics/shipments/{{shipment_id}}/cancel',
    token: 'transporter_token',
  }),
  req({
    name: 'GET /logistics/shipments/:id/tracking',
    method: 'GET',
    path: '/logistics/shipments/{{shipment_id}}/tracking',
    token: 'buyer_token',
  }),
]);

// =====================================================================
//  8. MESSAGING
// =====================================================================

const messagingFolder = folder('💬 8. Messaging', [
  req({
    name: 'POST /messaging/conversations (DIRECT)',
    method: 'POST',
    path: '/messaging/conversations',
    token: 'buyer_token',
    body: {
      participants: ['{{farmer_id}}'],
      type: 'DIRECT',
    },
    test: captureId('conversation_id'),
  }),
  req({
    name: 'POST /messaging/conversations (GROUP)',
    method: 'POST',
    path: '/messaging/conversations',
    token: 'coop_token',
    body: {
      participants: ['{{farmer_id}}', '{{buyer_id}}'],
      titre: 'Discussion coopérative',
      type: 'GROUP',
    },
  }),
  req({
    name: 'GET /messaging/conversations',
    method: 'GET',
    path: '/messaging/conversations?page=1&limit=20',
    token: 'buyer_token',
  }),
  req({
    name: 'POST /messaging/conversations/:id/messages (TEXT)',
    method: 'POST',
    path: '/messaging/conversations/{{conversation_id}}/messages',
    token: 'buyer_token',
    body: { content: 'Bonjour, j\'aimerais acheter votre maïs.' },
    test: captureId('message_id'),
  }),
  req({
    name: 'POST /messaging/conversations/:id/messages (IMAGE)',
    method: 'POST',
    path: '/messaging/conversations/{{conversation_id}}/messages',
    token: 'farmer_token',
    body: {
      content: 'Voici la photo du lot.',
      media_type: 'IMAGE',
      media_url: 'https://cdn.farmcash.ci/messages/img1.jpg',
    },
  }),
  req({
    name: 'GET /messaging/conversations/:id/messages',
    method: 'GET',
    path: '/messaging/conversations/{{conversation_id}}/messages?page=1&limit=30',
    token: 'buyer_token',
  }),
  req({
    name: 'PUT /messaging/conversations/:id/read',
    method: 'PUT',
    path: '/messaging/conversations/{{conversation_id}}/read',
    token: 'farmer_token',
  }),
]);

// =====================================================================
//  9. NOTIFICATIONS
// =====================================================================

const notificationsFolder = folder('🔔 9. Notifications', [
  req({
    name: 'GET /notifications',
    method: 'GET',
    path: '/notifications?page=1&limit=20',
    token: 'buyer_token',
    test: `try {
  const list = pm.response.json().data?.data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('notification_id', list[0].id);
    console.log('notification_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'GET /notifications?unread_only=true',
    method: 'GET',
    path: '/notifications?page=1&limit=20&unread_only=true',
    token: 'buyer_token',
  }),
  req({
    name: 'GET /notifications/stream (SSE)',
    method: 'GET',
    path: '/notifications/stream',
    token: 'buyer_token',
    desc:
      'Stream Server-Sent Events. Postman ne gère pas le SSE longue-poll : utilise plutôt `curl -N` ou EventSource côté front.',
  }),
  req({
    name: 'PUT /notifications/:id/read',
    method: 'PUT',
    path: '/notifications/{{notification_id}}/read',
    token: 'buyer_token',
  }),
  req({
    name: 'PUT /notifications/read-all',
    method: 'PUT',
    path: '/notifications/read-all',
    token: 'buyer_token',
  }),
  req({
    name: 'DELETE /notifications/:id',
    method: 'DELETE',
    path: '/notifications/{{notification_id}}',
    token: 'buyer_token',
  }),
]);

// =====================================================================
//  10. AI
// =====================================================================

const aiPlantsFolder = folder('🌱 10.1 AI - Plant analyses', [
  req({
    name: 'POST /ai/plant-analyses (FARMER)',
    method: 'POST',
    path: '/ai/plant-analyses',
    token: 'farmer_token',
    body: {
      image_url: 'https://cdn.farmcash.ci/plants/leaf1.jpg',
      parcelle_id: '{{parcelle_id}}',
      produit_id: '{{produit_id}}',
      location: { lat: 7.690, lng: -5.030 },
    },
    test: captureId('plant_analysis_id', 'data.analysis.id'),
  }),
  req({
    name: 'GET /ai/plant-analyses',
    method: 'GET',
    path: '/ai/plant-analyses?page=1&limit=20',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/plant-analyses/:id',
    method: 'GET',
    path: '/ai/plant-analyses/{{plant_analysis_id}}',
    token: 'farmer_token',
  }),
]);

const aiTreatmentsFolder = folder('💊 10.2 AI - Treatments', [
  req({
    name: 'GET /ai/treatments',
    method: 'GET',
    path: '/ai/treatments?page=1&limit=50',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/treatments/for-analysis/:analysisId',
    method: 'GET',
    path: '/ai/treatments/for-analysis/{{plant_analysis_id}}',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/treatments/:id',
    method: 'GET',
    path: '/ai/treatments/{{treatment_id}}',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /ai/treatments (ADMIN)',
    method: 'POST',
    path: '/ai/treatments',
    token: 'admin_token',
    body: {
      nom: 'Anti-foreuse maïs (insecticide bio)',
      type: 'FONGICIDE',
      cultures_cibles: ['maïs'],
      maladies_cibles: ['mildiou', 'pourriture brune'],
      dosage: '50g / 10L eau',
      mode_application: 'Pulvérisation foliaire 2x/mois',
      delai_carence_j: 14,
    },
    test: captureId('treatment_id'),
  }),
  req({
    name: 'PUT /ai/treatments/:id (ADMIN)',
    method: 'PUT',
    path: '/ai/treatments/{{treatment_id}}',
    token: 'admin_token',
    body: { dosage: '60g / 10L eau' },
  }),
  req({
    name: 'DELETE /ai/treatments/:id (ADMIN)',
    method: 'DELETE',
    path: '/ai/treatments/{{treatment_id}}',
    token: 'admin_token',
  }),
]);

const aiAssistantFolder = folder('🤖 10.3 AI - Assistant chat', [
  req({
    name: 'POST /ai/assistant/chat (intent : vendre)',
    method: 'POST',
    path: '/ai/assistant/chat',
    token: 'farmer_token',
    body: { message: 'je veux vendre 200 kg de maïs à 1500 par kg' },
  }),
  req({
    name: 'POST /ai/assistant/chat (intent : prix)',
    method: 'POST',
    path: '/ai/assistant/chat',
    token: 'farmer_token',
    body: { message: 'quel est le prix du maïs aujourd\'hui ?' },
  }),
  req({
    name: 'GET /ai/assistant/history',
    method: 'GET',
    path: '/ai/assistant/history?page=1&limit=30',
    token: 'farmer_token',
  }),
  req({
    name: 'POST /ai/assistant/reset',
    method: 'POST',
    path: '/ai/assistant/reset',
    token: 'farmer_token',
  }),
]);

const aiInsightsFolder = folder('📊 10.4 AI - Insights', [
  req({
    name: 'GET /ai/insights/my (FARMER)',
    method: 'GET',
    path: '/ai/insights/my',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/insights/my (BUYER)',
    method: 'GET',
    path: '/ai/insights/my',
    token: 'buyer_token',
  }),
  req({
    name: 'GET /ai/insights/my (TRANSPORTER)',
    method: 'GET',
    path: '/ai/insights/my',
    token: 'transporter_token',
  }),
]);

const aiNewsFolder = folder('📰 10.5 AI - News', [
  req({
    name: 'GET /ai/news (rôle automatique)',
    method: 'GET',
    path: '/ai/news?page=1&limit=20',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/news?type=PRICE_TREND',
    method: 'GET',
    path: '/ai/news?page=1&limit=20&type=PRICE_TREND',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/news/:id',
    method: 'GET',
    path: '/ai/news/{{ai_news_id}}',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /ai/admin/news (ADMIN)',
    method: 'GET',
    path: '/ai/admin/news',
    token: 'admin_token',
  }),
  req({
    name: 'POST /ai/news (ADMIN)',
    method: 'POST',
    path: '/ai/news',
    token: 'admin_token',
    body: {
      type: 'PRICE_TREND',
      titre: 'Le maïs monte de 5% cette semaine',
      body: 'Selon les marchés internationaux, le prix du maïs a augmenté de 5% en moyenne sur 7 jours.',
      cible_role: 'FARMER',
      region_id: '{{region_id}}',
      expires_at: '2026-12-31',
    },
    test: captureId('ai_news_id'),
  }),
  req({
    name: 'PUT /ai/news/:id (ADMIN)',
    method: 'PUT',
    path: '/ai/news/{{ai_news_id}}',
    token: 'admin_token',
    body: { titre: 'MAJ - Le maïs monte de 7%' },
  }),
  req({
    name: 'DELETE /ai/news/:id (ADMIN)',
    method: 'DELETE',
    path: '/ai/news/{{ai_news_id}}',
    token: 'admin_token',
  }),
]);

const aiTraceabilityFolder = folder('🔍 10.6 AI - Traceability', [
  req({
    name: 'GET /ai/traceability/:lotId (public)',
    method: 'GET',
    path: '/ai/traceability/{{lot_id}}',
  }),
]);

const aiFolder = folder('🤖 10. AI', [
  aiPlantsFolder,
  aiTreatmentsFolder,
  aiAssistantFolder,
  aiInsightsFolder,
  aiNewsFolder,
  aiTraceabilityFolder,
]);

// =====================================================================
//  11. OVERSIGHT (6 dashboards)
// =====================================================================

const oversightAdminFolder = folder('👮 11.1 Oversight ADMIN', [
  req({ name: 'GET /oversight/admin/overview',          method: 'GET', path: '/oversight/admin/overview',         token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/users',             method: 'GET', path: '/oversight/admin/users?page=1&limit=20', token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/users?role=FARMER', method: 'GET', path: '/oversight/admin/users?page=1&limit=20&role=FARMER', token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/users/:id',         method: 'GET', path: '/oversight/admin/users/{{farmer_id}}', token: 'admin_token' }),
  req({ name: 'POST /oversight/admin/users/:id/deactivate', method: 'POST', path: '/oversight/admin/users/{{farmer_id}}/deactivate', token: 'admin_token' }),
  req({ name: 'POST /oversight/admin/users/:id/reactivate', method: 'POST', path: '/oversight/admin/users/{{farmer_id}}/reactivate', token: 'admin_token' }),
  req({
    name: 'POST /oversight/admin/users/:id/wallet/freeze',
    method: 'POST',
    path: '/oversight/admin/users/{{farmer_id}}/wallet/freeze',
    token: 'admin_token',
    body: { reason: 'Soupçon de fraude' },
  }),
  req({ name: 'POST /oversight/admin/users/:id/wallet/unfreeze', method: 'POST', path: '/oversight/admin/users/{{farmer_id}}/wallet/unfreeze', token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/transactions',  method: 'GET', path: '/oversight/admin/transactions?page=1&limit=20', token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/orders',        method: 'GET', path: '/oversight/admin/orders?page=1&limit=20',       token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/disputes/open', method: 'GET', path: '/oversight/admin/disputes/open',                token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/escrows/locked',method: 'GET', path: '/oversight/admin/escrows/locked',               token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/revenue-timeline?period=30d', method: 'GET', path: '/oversight/admin/revenue-timeline?period=30d', token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/treasury/history?period=30d', method: 'GET', path: '/oversight/admin/treasury/history?period=30d', token: 'admin_token' }),
  req({ name: 'GET /oversight/admin/system-health',  method: 'GET', path: '/oversight/admin/system-health',  token: 'admin_token' }),
]);

const oversightBuyerFolder = folder('👮 11.2 Oversight BUYER', [
  req({ name: 'GET /oversight/buyer/overview',           method: 'GET', path: '/oversight/buyer/overview',           token: 'buyer_token' }),
  req({ name: 'GET /oversight/buyer/top-products',       method: 'GET', path: '/oversight/buyer/top-products',       token: 'buyer_token' }),
  req({ name: 'GET /oversight/buyer/spending-timeline?period=30d', method: 'GET', path: '/oversight/buyer/spending-timeline?period=30d', token: 'buyer_token' }),
  req({ name: 'GET /oversight/buyer/favorite-sellers?limit=10', method: 'GET', path: '/oversight/buyer/favorite-sellers?limit=10', token: 'buyer_token' }),
  req({ name: 'GET /oversight/buyer/active-orders',      method: 'GET', path: '/oversight/buyer/active-orders',      token: 'buyer_token' }),
]);

const oversightCoopFolder = folder('👮 11.3 Oversight COOPERATIVE', [
  req({ name: 'GET /oversight/coop/overview',                   method: 'GET', path: '/oversight/coop/overview',                  token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/members',                    method: 'GET', path: '/oversight/coop/members?page=1&limit=20',   token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/members/annonces',           method: 'GET', path: '/oversight/coop/members/annonces?page=1&limit=20', token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/members/orders',             method: 'GET', path: '/oversight/coop/members/orders?page=1&limit=20',   token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/revenue-timeline?period=30d',method: 'GET', path: '/oversight/coop/revenue-timeline?period=30d', token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/top-contributors?period=30d&limit=10', method: 'GET', path: '/oversight/coop/top-contributors?period=30d&limit=10', token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/upcoming-conversions',       method: 'GET', path: '/oversight/coop/upcoming-conversions', token: 'coop_token' }),
  req({ name: 'GET /oversight/coop/advances-aging',             method: 'GET', path: '/oversight/coop/advances-aging',      token: 'coop_token' }),
]);

const oversightExporterFolder = folder('👮 11.4 Oversight EXPORTER', [
  req({ name: 'GET /oversight/exporter/overview',     method: 'GET', path: '/oversight/exporter/overview',                       token: 'exporter_token' }),
  req({ name: 'GET /oversight/exporter/commandes-b2b',method: 'GET', path: '/oversight/exporter/commandes-b2b?page=1&limit=20', token: 'exporter_token' }),
  req({ name: 'GET /oversight/exporter/commandes-b2b/:id/documents', method: 'GET', path: '/oversight/exporter/commandes-b2b/{{order_id}}/documents', token: 'exporter_token' }),
  req({ name: 'GET /oversight/exporter/offres',       method: 'GET', path: '/oversight/exporter/offres?page=1&limit=20',         token: 'exporter_token' }),
]);

const oversightFarmerFolder = folder('👮 11.5 Oversight FARMER', [
  req({ name: 'GET /oversight/farmer/overview',          method: 'GET', path: '/oversight/farmer/overview',         token: 'farmer_token' }),
  req({ name: 'GET /oversight/farmer/conversion-funnel', method: 'GET', path: '/oversight/farmer/conversion-funnel',token: 'farmer_token' }),
  req({ name: 'GET /oversight/farmer/revenue-timeline?period=30d', method: 'GET', path: '/oversight/farmer/revenue-timeline?period=30d', token: 'farmer_token' }),
  req({ name: 'GET /oversight/farmer/top-buyers?limit=10', method: 'GET', path: '/oversight/farmer/top-buyers?limit=10', token: 'farmer_token' }),
  req({ name: 'GET /oversight/farmer/health-alerts',     method: 'GET', path: '/oversight/farmer/health-alerts',    token: 'farmer_token' }),
  req({ name: 'GET /oversight/farmer/pending-actions',   method: 'GET', path: '/oversight/farmer/pending-actions',  token: 'farmer_token' }),
]);

const oversightTransporterFolder = folder('👮 11.6 Oversight TRANSPORTER', [
  req({ name: 'GET /oversight/transporter/overview',         method: 'GET', path: '/oversight/transporter/overview',   token: 'transporter_token' }),
  req({ name: 'GET /oversight/transporter/top-routes',       method: 'GET', path: '/oversight/transporter/top-routes', token: 'transporter_token' }),
  req({ name: 'GET /oversight/transporter/earnings-timeline?period=30d', method: 'GET', path: '/oversight/transporter/earnings-timeline?period=30d', token: 'transporter_token' }),
  req({ name: 'GET /oversight/transporter/delivery-stats?period=30d', method: 'GET', path: '/oversight/transporter/delivery-stats?period=30d', token: 'transporter_token' }),
  req({ name: 'GET /oversight/transporter/pending-actions',  method: 'GET', path: '/oversight/transporter/pending-actions', token: 'transporter_token' }),
]);

const oversightFolder = folder('👮 11. Oversight (6 rôles)', [
  oversightAdminFolder,
  oversightBuyerFolder,
  oversightCoopFolder,
  oversightExporterFolder,
  oversightFarmerFolder,
  oversightTransporterFolder,
]);

// =====================================================================
//  12. COOPERATIVES (nouveau module)
// =====================================================================

const coopPublicFolder = folder('🏢 12.1 Lookup public (inscription)', [
  req({
    name: 'GET /cooperatives (liste publique)',
    method: 'GET',
    path: '/cooperatives?page=1&limit=20',
    test: `try {
  const list = pm.response.json().data?.data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('cooperative_id', list[0].id);
    console.log('cooperative_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'GET /cooperatives?search=...',
    method: 'GET',
    path: '/cooperatives?page=1&limit=20&search=Coobamoul',
  }),
  req({
    name: 'GET /cooperatives/:id (profil public)',
    method: 'GET',
    path: '/cooperatives/{{cooperative_id}}',
  }),
  req({
    name: 'GET /cooperatives/publications/list (publications publiques)',
    method: 'GET',
    path: '/cooperatives/publications/list?page=1&limit=20',
  }),
  req({
    name: 'GET /cooperatives/publications/:id',
    method: 'GET',
    path: '/cooperatives/publications/{{publication_coop_id}}',
  }),
]);

const coopPublicationsCrudFolder = folder('🏢 12.11 Publications coop — CRUD direct', [
  req({
    name: 'POST /coop/publications (publication directe sans agrégation)',
    method: 'POST',
    path: '/coop/publications',
    token: 'coop_token',
    body: {
      produit_id: '{{produit_id}}',
      quantite_kg: 5000,
      prix_par_kg: 1400,
      qualite: 'STANDARD',
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      coordinates: { lat: 7.683, lng: -5.0303 },
    },
    test: captureId('publication_coop_id', 'data.publication_id'),
  }),
  req({
    name: 'PUT /coop/publications/:id',
    method: 'PUT',
    path: '/coop/publications/{{publication_coop_id}}',
    token: 'coop_token',
    body: { prix_par_kg: 1350, quantite_kg: 4500 },
  }),
  req({
    name: 'DELETE /coop/publications/:id',
    method: 'DELETE',
    path: '/coop/publications/{{publication_coop_id}}',
    token: 'coop_token',
  }),
]);

const coopProfileFolder = folder('🏢 12.2 Profil COOP', [
  req({
    name: 'PUT /coop/profile (raison sociale + commission)',
    method: 'PUT',
    path: '/coop/profile',
    token: 'coop_token',
    body: {
      nom: 'Coobamoul Coopérative',
      numero_agrement: 'CI-COOP-2026-001',
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      nb_membres: 45,
      commission_rate: 0.05,
      auto_distribute: true,
    },
  }),
]);

const coopJoinRequestsFolder = folder('🏢 12.3 Adhésion — FARMER initie', [
  req({
    name: 'POST /coop/join-requests (FARMER demande)',
    method: 'POST',
    path: '/coop/join-requests',
    token: 'farmer_token',
    body: {
      cooperative_id: '{{cooperative_id}}',
      message: "Je produis 2 tonnes de maïs/an à Bouaké.",
    },
    test: captureId('join_request_id'),
  }),
  req({
    name: 'GET /coop/join-requests (COOP voit demandes)',
    method: 'GET',
    path: '/coop/join-requests',
    token: 'coop_token',
    test: `try {
  const list = pm.response.json().data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('join_request_id', list[0].id);
    console.log('join_request_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'PUT /coop/join-requests/:id/handle (ACCEPT)',
    method: 'PUT',
    path: '/coop/join-requests/{{join_request_id}}/handle',
    token: 'coop_token',
    body: { decision: 'ACCEPTED' },
  }),
  req({
    name: 'PUT /coop/join-requests/:id/handle (REJECT)',
    method: 'PUT',
    path: '/coop/join-requests/{{join_request_id}}/handle',
    token: 'coop_token',
    body: {
      decision: 'REJECTED',
      rejection_reason: 'Profil non vérifié.',
    },
  }),
]);

const coopInvitationsFolder = folder('🏢 12.4 Adhésion — COOP initie', [
  req({
    name: 'POST /coop/invitations (COOP invite par tel)',
    method: 'POST',
    path: '/coop/invitations',
    token: 'coop_token',
    body: {
      invited_phone: '{{farmer_phone}}',
      message: "Rejoins notre coopérative !",
    },
    test: captureId('invitation_id'),
  }),
  req({
    name: 'GET /coop/invitations/my (FARMER voit)',
    method: 'GET',
    path: '/coop/invitations/my',
    token: 'farmer_token',
    test: `try {
  const list = pm.response.json().data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('invitation_id', list[0].id);
    console.log('invitation_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'PUT /coop/invitations/:id/handle (FARMER accepte)',
    method: 'PUT',
    path: '/coop/invitations/{{invitation_id}}/handle',
    token: 'farmer_token',
    body: { decision: 'ACCEPTED' },
  }),
]);

const coopMembersFolder = folder('🏢 12.5 Gestion membres', [
  req({
    name: 'GET /coop/members',
    method: 'GET',
    path: '/coop/members?page=1&limit=20',
    token: 'coop_token',
  }),
  req({
    name: 'GET /coop/members?role=MEMBER',
    method: 'GET',
    path: '/coop/members?page=1&limit=20&role=MEMBER',
    token: 'coop_token',
  }),
  req({
    name: 'PUT /coop/members/:userId/role (promotion)',
    method: 'PUT',
    path: '/coop/members/{{farmer_id}}/role',
    token: 'coop_token',
    body: { role_in_coop: 'GERANT' },
  }),
  req({
    name: 'DELETE /coop/members/:userId (retrait)',
    method: 'DELETE',
    path: '/coop/members/{{farmer_id}}',
    token: 'coop_token',
  }),
]);

const coopAnnoncesFolder = folder('🏢 12.6 Annonces assignées — workflow validation', [
  req({
    name: 'POST /marketplace/annonces/vente (FARMER assigne à sa coop)',
    method: 'POST',
    path: '/marketplace/annonces/vente',
    token: 'farmer_token',
    body: {
      produit_id: '{{produit_id}}',
      titre: 'Maïs premium - vendu via ma coop',
      quantite_kg: 200,
      prix_par_kg: 1500,
      quantite_min_kg: 50,
      qualite: 'PREMIUM',
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      coordinates: { lat: 7.683, lng: -5.0303 },
      assigned_to_cooperative_id: '{{cooperative_id}}',
    },
    test: captureId('annonce_vente_id', 'data.annonce_id'),
  }),
  req({
    name: 'GET /coop/annonces-vente/assigned (PENDING)',
    method: 'GET',
    path: '/coop/annonces-vente/assigned?page=1&limit=20',
    token: 'coop_token',
    test: `try {
  const list = pm.response.json().data?.data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('annonce_vente_id', list[0].id);
    console.log('annonce_vente_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'GET /coop/annonces-vente/assigned?status=VALIDATED',
    method: 'GET',
    path: '/coop/annonces-vente/assigned?page=1&limit=20&status=VALIDATED',
    token: 'coop_token',
  }),
  req({
    name: 'PUT /coop/annonces-vente/:id/validate (après pesée)',
    method: 'PUT',
    path: '/coop/annonces-vente/{{annonce_vente_id}}/validate',
    token: 'coop_token',
    body: {
      quantite_kg_reelle: 187.5,
      qualite_reelle: 'PREMIUM',
      notes_pesee: 'Pesé le 15/05, sacs secs, qualité conforme.',
    },
  }),
  req({
    name: 'PUT /coop/annonces-vente/:id/reject',
    method: 'PUT',
    path: '/coop/annonces-vente/{{annonce_vente_id}}/reject',
    token: 'coop_token',
    body: { rejection_reason: 'Qualité insuffisante après pesée.' },
  }),
  req({
    name: 'GET /coop/annonces-achat/incoming (offres ciblées)',
    method: 'GET',
    path: '/coop/annonces-achat/incoming',
    token: 'coop_token',
  }),
]);

const coopPrevisionsFolder = folder('🏢 12.7 Prévisions assignées — validation', [
  req({
    name: 'POST /marketplace/previsions (FARMER assigne à sa coop)',
    method: 'POST',
    path: '/marketplace/previsions',
    token: 'farmer_token',
    body: {
      produit_id: '{{produit_id}}',
      parcelle_id: '{{parcelle_id}}',
      saison: 'Q3-2026',
      quantite_prev_kg: 2000,
      date_recolte_prev: '2026-09-15',
      prix_cible_kg: 1500,
      notes: 'Récolte estimée 5% en plus que 2025.',
      assigned_to_cooperative_id: '{{cooperative_id}}',
    },
    test: captureId('prevision_id', 'data.id'),
  }),
  req({
    name: 'GET /coop/previsions/assigned (PENDING)',
    method: 'GET',
    path: '/coop/previsions/assigned?page=1&limit=20',
    token: 'coop_token',
    test: `try {
  const list = pm.response.json().data?.data;
  if (Array.isArray(list) && list[0]?.id) {
    pm.environment.set('prevision_id', list[0].id);
    console.log('prevision_id =', list[0].id);
  }
} catch (e) {}`,
  }),
  req({
    name: 'PUT /coop/previsions/:id/validate (après inspection)',
    method: 'PUT',
    path: '/coop/previsions/{{prevision_id}}/validate',
    token: 'coop_token',
    body: {
      quantite_kg_validee: 1800,
      notes_inspection: 'Parcelle de 2 ha, 1200 pieds, bon état sanitaire.',
    },
  }),
  req({
    name: 'PUT /coop/previsions/:id/reject',
    method: 'PUT',
    path: '/coop/previsions/{{prevision_id}}/reject',
    token: 'coop_token',
    body: { rejection_reason: 'Parcelle non conforme aux standards coop.' },
  }),
  req({
    name: 'POST /marketplace/previsions/reserver (BUYER après VALIDATED)',
    method: 'POST',
    path: '/marketplace/previsions/reserver',
    token: 'buyer_token',
    body: {
      prevision_id: '{{prevision_id}}',
      quantite_kg: 500,
      prix_reserve_kg: 1500,
    },
    test: captureId('reservation_id'),
  }),
]);

const coopProducerViewFolder = folder('🏢 12.8 Vue PRODUCTEUR (mes annonces côté coop)', [
  req({
    name: 'GET /coop/my-annonces (FARMER)',
    method: 'GET',
    path: '/coop/my-annonces',
    token: 'farmer_token',
  }),
  req({
    name: 'GET /coop/my-annonces/:id/context (revenu projeté)',
    method: 'GET',
    path: '/coop/my-annonces/{{annonce_vente_id}}/context',
    token: 'farmer_token',
  }),
]);

const coopAdvancesFolder = folder('🏢 12.9 Avances de paiement coop → producteur', [
  req({
    name: 'POST /coop/advances (verser une avance)',
    method: 'POST',
    path: '/coop/advances',
    token: 'coop_token',
    body: {
      farmer_id: '{{farmer_id}}',
      annonce_vente_id: '{{annonce_vente_id}}',
      amount: 140000,
      notes: 'Avance 50% sur lot maïs mai 2026.',
    },
    test: captureId('advance_id'),
  }),
  req({
    name: 'GET /coop/advances (toutes)',
    method: 'GET',
    path: '/coop/advances?page=1&limit=20',
    token: 'coop_token',
  }),
  req({
    name: 'GET /coop/advances?status=PAID',
    method: 'GET',
    path: '/coop/advances?page=1&limit=20&status=PAID',
    token: 'coop_token',
  }),
  req({
    name: 'GET /coop/advances/by-annonce/:annonceId',
    method: 'GET',
    path: '/coop/advances/by-annonce/{{annonce_vente_id}}',
    token: 'coop_token',
  }),
]);

const coopPublicationsFolder = folder('🏢 12.10 Agrégation + distribution', [
  req({
    name: 'POST /coop/publications/aggregate',
    method: 'POST',
    path: '/coop/publications/aggregate',
    token: 'coop_token',
    body: {
      annonce_ids: ['{{annonce_vente_id}}'],
      prix_par_kg: 1500,
      qualite: 'PREMIUM',
      region_id: '{{region_id}}',
      ville_id: '{{ville_id}}',
      adresse_detail: 'Entrepôt central Bouaké',
    },
    test: captureId('publication_coop_id', 'data.publication.id'),
  }),
  req({
    name: 'GET /coop/publications/:id/contributions',
    method: 'GET',
    path: '/coop/publications/{{publication_coop_id}}/contributions',
    token: 'coop_token',
  }),
  req({
    name: 'POST /coop/publications/:id/distribute?dry_run=true',
    method: 'POST',
    path: '/coop/publications/{{publication_coop_id}}/distribute?dry_run=true',
    token: 'coop_token',
  }),
  req({
    name: 'POST /coop/publications/:id/distribute (exec)',
    method: 'POST',
    path: '/coop/publications/{{publication_coop_id}}/distribute',
    token: 'coop_token',
  }),
]);

const cooperativesFolder = folder('🏢 12. Cooperatives', [
  coopPublicFolder,
  coopProfileFolder,
  coopJoinRequestsFolder,
  coopInvitationsFolder,
  coopMembersFolder,
  coopAnnoncesFolder,
  coopPrevisionsFolder,
  coopProducerViewFolder,
  coopAdvancesFolder,
  coopPublicationsFolder,
  coopPublicationsCrudFolder,
]);

// =====================================================================
//  Assemblage final
// =====================================================================

const collection = {
  info: {
    _postman_id: 'f4c0a801-1000-4001-b001-000000000001',
    name: 'FarmCash AI - Backend API',
    description:
      "Collection complète des 145 routes du backend FarmCash.\n" +
      "Modules : Auth (6 rôles), Marketplace, Negotiation, Orders, Finance, " +
      "Logistics, Messaging, Notifications, AI, Oversight.\n\n" +
      "Variables auto-injectées par les test scripts (token, IDs).\n" +
      "Voir `postman/README.md` pour l'ordre d'exécution.",
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    healthFolder,
    catalogueFolder,
    authFolder,
    folder('🛒 2. Marketplace - Annonces', [
      marketplaceAnnoncesVenteFolder,
      marketplaceAnnoncesAchatFolder,
      marketplacePublicationsCoopFolder,
    ]),
    folder('🛍 3. Marketplace - Avancé', [
      panierFolder,
      interactionsFolder,
      stocksFolder,
      agronomieFolder,
      previsionsFolder,
    ]),
    negotiationFolder,
    ordersFolder,
    financeFolder,
    logisticsFolder,
    messagingFolder,
    notificationsFolder,
    aiFolder,
    oversightFolder,
    cooperativesFolder,
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000/api', type: 'string' },
  ],
};

writeFileSync(OUT, JSON.stringify(collection, null, 2));
console.log(`✅ Collection générée : ${OUT}`);
console.log(`   Dossiers : ${collection.item.length}`);

const countRequests = (items) =>
  items.reduce(
    (acc, it) => (it.request ? acc + 1 : acc + countRequests(it.item || [])),
    0,
  );
console.log(`   Requêtes : ${countRequests(collection.item)}`);
