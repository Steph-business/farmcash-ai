# Collection Postman - FarmCash API

Tester l'ensemble des ~170 routes via Postman (237 requêtes dans la collection, dont variantes/scénarios).

## Fichiers

| Fichier | Rôle |
|---|---|
| `farmcash-api.postman_collection.json` | La collection (toutes les routes, organisées par module) |
| `farmcash-local.postman_environment.json` | Les variables (baseUrl, tokens, IDs dynamiques) |

## Import dans Postman

1. Ouvrir Postman → bouton **Import** (haut-gauche).
2. Glisser-déposer les deux fichiers .json.
3. En haut à droite, sélectionner l'environnement **FarmCash - Local**.

## Démarrer le backend

```bash
cd farmcash-backend
docker compose up -d                       # postgres + redis + minio + pgadmin + mailhog
npx prisma generate
npm run start:dev                          # API sur http://localhost:3000/api
```

### Désactiver les crons pendant les tests

Si tu vois des warnings de cron pendant tes tests, ajoute en env :

```bash
DISABLE_RECONCILIATION_CRON=true \
DISABLE_ORDERS_CLEANUP=true \
DISABLE_RESERVATION_EXPIRATION=true \
DISABLE_LOGISTICS_CLEANUP=true \
DISABLE_THROTTLE=true \
npm run start:dev
```

## Ordre d'exécution recommandé

Exécuter dans cet ordre car certaines requêtes alimentent les variables (token, IDs) utilisées par les suivantes.

1. **🩺 Health** → vérifie que l'API répond.
2. **📦 Catalogue (public)** → récupère un `produit_id`, un `region_id`, un `ville_id` (stockés automatiquement).
3. **🔐 Auth** → exécuter dans l'ordre pour chacun des 6 rôles :
   - `Register FARMER` → `Send OTP` → `Verify OTP` → `Set PIN`
   - répéter pour BUYER, COOPERATIVE, TRANSPORTER, EXPORTER, ADMIN
   - Les tokens sont automatiquement sauvegardés dans `farmer_token`, `buyer_token`, etc.
4. **🛒 Marketplace** → tester les annonces (vente/achat/coop), le panier, les favoris.
5. **💬 Negotiation** → créer une candidature ou proposition, traiter l'offre.
6. **📋 Orders** → créer une commande, suivre son cycle de vie.
7. **🚚 Logistics** → flow complet transporteur (route, devis, accept, deliver).
8. **💰 Finance** → confirmer livraison, voir le wallet, ajouter un moyen de paiement.
9. **💬 Messaging** → créer une conversation, envoyer un message.
10. **🔔 Notifications** → consulter et marquer comme lues.
11. **🤖 AI** → analyser une plante, chatter avec l'assistant, lire les news.
12. **👮 Oversight** → dashboards par rôle (ADMIN, COOP, EXPORTER, BUYER, TRANSPORTER, FARMER).
13. **🏢 Cooperatives** → tout le workflow coop (profil, membres, adhésion, validation annonces/prévisions, agrégation, avances, distribution, vue producteur).
14. **🔔 Webhooks & Finance** → `POST /webhooks/payment-provider/:provider` (simul provider) + `GET /finance/reconciliation` (audit ADMIN).

## Tip : récupérer les IDs catalogue via SQL

Si les routes catalogue ne renvoient rien (DB vide), seeder d'abord :

```bash
docker exec -it farmcash_postgres psql -U farmcash_user -d farmcash_db <<'SQL'
SELECT id FROM produits LIMIT 1;
SELECT id FROM regions LIMIT 1;
SELECT id FROM villes LIMIT 1;
SQL
```

Puis copier-coller les UUID dans l'environnement Postman (`produit_id`, `region_id`, `ville_id`).

## Création de comptes ADMIN

Le rôle ADMIN est volontairement **refusé** par `POST /auth/register`
(403 ForbiddenException). Deux chemins dédiés à utiliser :

### 1. Premier admin (bootstrap)

Si la base ne contient AUCUN admin, utilise la route protégée par token.

1. Met une valeur dans `.env` :
   ```bash
   BOOTSTRAP_ADMIN_TOKEN=mon-token-secret-temporaire
   ```
2. Lance la requête `POST {{baseUrl}}/auth/admin/bootstrap` avec :
   - **Header** `X-Bootstrap-Token: mon-token-secret-temporaire`
   - **Body** :
     ```json
     {
       "phone": "+2250700000001",
       "full_name": "Super Admin Initial",
       "email": "admin@farmcash.ci",
       "langue": "fr"
     }
     ```
3. Le compte est créé automatiquement avec :
   - `role = ADMIN`
   - `niveau = SUPER_ADMIN`
   - toutes permissions `peut_*` activées
4. **⚠️ Rotate** `BOOTSTRAP_ADMIN_TOKEN` (ou retire-le du .env) après cette opération.

### 2. Admins suivants (par un SUPER_ADMIN existant)

Une fois le 1er SUPER_ADMIN connecté, il peut créer d'autres admins via
`POST {{baseUrl}}/auth/admin/register` (Authorization: Bearer {{admin_token}}) :

```json
{
  "phone": "+2250700000002",
  "full_name": "Modérateur Marketplace",
  "email": "moderation@farmcash.ci",
  "niveau": "MODERATOR",
  "departement": "Modération",
  "peut_publier_news": false
}
```

Niveaux disponibles : `SUPER_ADMIN`, `ADMIN`, `MODERATOR`, `SUPPORT`.

### 3. Bascule rapide en dev (legacy, NON recommandé)

Si tu veux vraiment promouvoir un compte existant en ADMIN sans passer
par les routes ci-dessus (debug rapide uniquement) :

```bash
docker exec -it farmcash_postgres psql -U farmcash_user -d farmcash_db \
  -c "UPDATE users SET role='ADMIN' WHERE phone='+2250701020306'; \
      INSERT INTO admin_profiles (user_id, niveau) \
      SELECT id, 'SUPER_ADMIN' FROM users WHERE phone='+2250701020306' \
      ON CONFLICT (user_id) DO NOTHING;"
```

Refais ensuite `Login PIN` pour récupérer un token avec claim `role: ADMIN`.

## Scripts automatiques inclus

Chaque requête a un **test script** qui :
- Vérifie le code HTTP (200 / 201 / 400 / 403…).
- Extrait l'ID retourné et le stocke dans la variable correspondante (`{{annonce_vente_id}}`, `{{order_id}}`, etc.).
- Affiche l'ID dans la console Postman.

## Variables principales

| Variable | Description |
|---|---|
| `baseUrl` | `http://localhost:3000/api` |
| `{{role}_phone` | Téléphone E.164 du rôle (Orange CI valide) |
| `default_pin` | PIN à 6 chiffres pour login |
| `{role}_token` | Access token JWT du rôle (rempli auto) |
| `{role}_refresh` | Refresh token du rôle (rempli auto) |
| `{role}_id` | UUID du user créé (rempli auto) |
| `produit_id`, `region_id`, `ville_id` | Catalogue (à seeder ou remplir manuellement) |
| `annonce_vente_id`, `order_id`, … | IDs créés au fil des requêtes |

## Erreurs fréquentes

| Code | Cause |
|---|---|
| 401 | Token manquant/expiré → relancer login-pin |
| 403 | Mauvais rôle (ex. BUYER tente une route FARMER) |
| 400 | Validation DTO : phone non E.164, PIN faible, UUID invalide |
| 409 | Conflit (téléphone déjà utilisé, deuxième register) |
| 429 | Throttle (5 register/h, 3 send-otp/15min, 20 plant-analyses/h) — attendre ou `DISABLE_THROTTLE=true` |

## Idempotency-Key sur les commandes

Pour éviter qu'un double-clic crée 2 commandes, le `POST /orders` accepte un header :

```
Idempotency-Key: cart-buyer123-2026-05-15-001
```

Si la même clé arrive 2x (même buyer), la 2e requête renvoie la commande existante au lieu d'en créer une nouvelle.

## Header courant à régénérer

Le backend a été refactoré pour utiliser `Idempotency-Key` sur `POST /orders`. Tu peux ajouter ce header dans ton template Postman si tu veux le tester.
