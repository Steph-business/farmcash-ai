# FarmCash API — OpenAPI & collection Postman

Spec OpenAPI 3.0 + collection Postman du backend NestJS FarmCash.
Pour partage avec l'équipe (front-end mobile, intégrateurs, QA).

## Fichiers fournis

| Fichier | Rôle | Format |
|---|---|---|
| [`openapi.json`](./openapi.json) | Spec OpenAPI 3.0 (placeholder en attendant re-génération depuis Swagger) | OpenAPI 3.0 JSON |
| [`farmcash.postman_collection.json`](./farmcash.postman_collection.json) | Collection Postman prête à importer (250+ requêtes, test scripts inclus) | Postman v2.1 |

> L'environnement Postman (`baseUrl`, tokens par rôle, IDs dynamiques) est versionné dans [`../../postman/farmcash-local.postman_environment.json`](../../postman/farmcash-local.postman_environment.json) — importe-le en même temps que la collection.

> **`openapi.json` est marqué `"x-placeholder": true`** : l'agent qui a généré ces fichiers n'avait pas d'accès réseau vers `http://localhost:3000/api/docs-json`. Le placeholder contient les principaux endpoints (auth, sollicitations coop, wallet topup, shipment QR pickup, marketplace, orders, oversight, ai, finance) mais sans les schémas DTOs complets. **Exécute `bash scripts/export-openapi.sh` pour remplacer ce placeholder par la spec OpenAPI 3.0 complète issue de Swagger** (environ 200+ endpoints, ~300 KB).

## Visualiser dans le navigateur

Quand le backend tourne (`npm run start:dev`) :

- **Swagger UI**  : http://localhost:3000/api/docs
- **Spec brute**  : http://localhost:3000/api/docs-json
- **Spec YAML** *(non exposé par défaut)* : exécute `scripts/export-openapi.sh` pour produire la version locale formatée.

## Import dans les outils clients

### Postman

1. Ouvrir Postman -> bouton **Import** (haut-gauche).
2. Glisser-déposer `farmcash.postman_collection.json`.
3. Glisser-déposer aussi l'environnement `postman/farmcash-local.postman_environment.json`.
4. En haut à droite, sélectionner l'environnement **FarmCash - Local**.
5. Tu peux aussi importer `openapi.json` (Postman le convertit automatiquement en collection) — utile pour la version "automatique" issue de Swagger ; la collection manuelle versionnée a en plus les test scripts qui auto-injectent les tokens.

### Insomnia

1. **Application -> Import / Export -> Import Data -> From File**.
2. Choisir `openapi.json` (Insomnia gère nativement OpenAPI 3.0) ou `farmcash.postman_collection.json`.
3. Définir l'environnement `base_url = http://localhost:3000/api`.

### VS Code REST Client (extension `humao.rest-client`)

1. Pas d'import direct ; copie un endpoint depuis Swagger UI sous forme de requête `.http`.
2. Alternative : utiliser l'extension `42Crunch.vscode-openapi` qui ouvre `openapi.json` avec preview Swagger UI intégrée et permet d'exécuter les requêtes.

### Hoppscotch / Bruno

- **Hoppscotch** : *Settings -> Import / Export -> Import from OpenAPI* -> `openapi.json`.
- **Bruno** : *Collection -> Import -> Postman Collection* -> `farmcash.postman_collection.json`.

### Génération de SDK clients

```bash
# Client TypeScript axios
npx -y @openapitools/openapi-generator-cli generate \
  -i docs/api/openapi.json \
  -g typescript-axios \
  -o ../farmcash-mobile/src/api/generated

# Client Dart / Flutter
npx -y @openapitools/openapi-generator-cli generate \
  -i docs/api/openapi.json \
  -g dart-dio \
  -o ../farmcash-mobile/lib/api_generated
```

## Configuration recommandée

### Variables Postman (environnement)

| Variable | Valeur par défaut | Description |
|---|---|---|
| `baseUrl` | `http://localhost:3000/api` | URL racine de l'API (préfixe `/api` inclus) |
| `authToken` | *(rempli après login)* | Bearer JWT (header `Authorization: Bearer {{authToken}}`) |
| `{role}_phone` | `+2250701020301..06` | Téléphones de test E.164 (Orange CI) par rôle |
| `default_pin` | `123456` | PIN à 6 chiffres pour login |
| `{role}_token` | *(rempli auto)* | JWT spécifique au rôle (FARMER, BUYER, COOPERATIVE, TRANSPORTER, EXPORTER, ADMIN) |
| `{role}_refresh` | *(rempli auto)* | Refresh token |
| `{role}_id` | *(rempli auto)* | UUID du user créé |
| `produit_id`, `region_id`, `ville_id` | *(à seeder)* | IDs catalogue (voir tip SQL dans `../../postman/README.md`) |

### Workflow d'authentification recommandé

1. **`POST /auth/register`** -> crée le user (phone E.164, role parmi FARMER/BUYER/COOPERATIVE/TRANSPORTER/EXPORTER).
2. **`POST /auth/send-otp`** -> reçoit l'OTP (mailhog en local : http://localhost:8025).
3. **`POST /auth/verify-otp`** -> active le user, renvoie `access_token` + `refresh_token`.
4. **`POST /auth/set-pin`** -> définit le PIN à 6 chiffres.
5. **`POST /auth/login-pin`** -> renvoie un nouveau couple `access_token` + `refresh_token`.
6. Stocker `access_token` dans `{{authToken}}` (ou `{{{role}_token}}` selon le rôle).
7. Toutes les autres requêtes utilisent `Authorization: Bearer {{authToken}}`.

> La collection Postman a un **test script** sur les requêtes auth qui auto-injecte le token dans la variable d'environnement -> tu n'as pas besoin de le copier-coller manuellement.

### Header `X-Request-Id`

Le middleware backend génère un `X-Request-Id` (UUID v4) si absent et le renvoie dans la réponse. Tu peux le forcer côté client pour tracer une requête bout-en-bout (logs ELK / Sentry).

### Header `Idempotency-Key` sur `POST /orders`

```
Idempotency-Key: cart-buyer123-2026-05-17-001
```

Évite la double-création d'une commande en cas de retry réseau.

## Endpoints récents notables

| Endpoint | Module | Description |
|---|---|---|
| `POST /coop/sollicitations` | cooperatives | Création + fan-out d'une sollicitation coopérative |
| `GET /coop/sollicitations` | cooperatives | Liste paginée des sollicitations |
| `POST /coop/sollicitations/:id/respond` | cooperatives | Réponse d'un destinataire (FARMER ou COOPERATIVE) |
| `POST /coop/sollicitations/:id/close` | cooperatives | Fermeture manuelle par la coop |
| `POST /finance/wallet/topup` | finance | Recharge wallet idempotente |
| `GET /finance/wallet/topup/:transactionId` | finance | Statut d'une recharge |
| `GET /logistics/shipments/:id/qr-token` | logistics | Token QR signé pour scan de prise en charge |
| `POST /logistics/shipments/:id/scan-pickup` | logistics | Scan transporteur : passage `READY -> IN_TRANSIT` |

## Re-génération

Le serveur backend doit tourner. Exécute :

```bash
bash scripts/export-openapi.sh
```

Le script :

1. Vérifie que `http://localhost:3000/api/docs-json` répond `200`.
2. Télécharge la spec et l'enregistre formatée dans `docs/api/openapi.json`.
3. Régénère `docs/api/farmcash.postman_collection.json` via `openapi-to-postmanv2` (npx).
4. Affiche le nombre d'endpoints et la liste des tags.

Variable d'environnement supportée :

```bash
BASE_URL=https://staging.farmcash.ai bash scripts/export-openapi.sh
```

> **Note** : le script n'est pas marqué exécutable dans le repo (pas de `chmod +x`). Lance-le toujours avec `bash scripts/export-openapi.sh`. Si tu préfères `./scripts/export-openapi.sh`, fais `chmod +x scripts/export-openapi.sh` une fois en local.

## Pré-requis pour la re-génération

- Node >= 18 (pour `npx` + `openapi-to-postmanv2`).
- Python 3 (pour le formatage `json.tool`).
- Backend démarré :

  ```bash
  cd farmcash-backend
  docker compose up -d                    # postgres + redis + minio
  npx prisma generate
  DISABLE_RECONCILIATION_CRON=true \
  DISABLE_ORDERS_CLEANUP=true \
  DISABLE_RESERVATION_EXPIRATION=true \
  DISABLE_LOGISTICS_CLEANUP=true \
  DISABLE_THROTTLE=true \
  npm run start:dev                       # API sur http://localhost:3000/api
  ```

## Différences openapi.json vs farmcash.postman_collection.json

| | `openapi.json` (auto Swagger) | `farmcash.postman_collection.json` (manuel + auto) |
|---|---|---|
| Source | Décorateurs `@ApiOperation`, `@ApiTags`, DTOs class-validator -> SwaggerModule | Maintenu via `postman/build-collection.mjs` (scénarios) + re-généré depuis `openapi.json` |
| Schémas request / response | Oui, avec exemples si annotés | Oui (bodies typés) |
| Test scripts (auto-injection token, IDs) | Non | Oui (sur les requêtes auth & création) |
| Ordre d'exécution suggéré | Aucun | Numéroté par module (cf. `postman/README.md`) |

Recommandation : utiliser **`openapi.json`** pour générer un SDK ou onboarder un nouvel intégrateur, et la **collection Postman manuelle** (`postman/farmcash-api.postman_collection.json`) pour les tests bout-en-bout avec scénarios.

## Erreurs HTTP fréquentes

| Code | Cause | Remède |
|---|---|---|
| 401 | Token manquant / expiré | Relancer `POST /auth/login-pin` (ou `/auth/refresh`) |
| 403 | Mauvais rôle | Vérifier le claim `role` du JWT (jwt.io) |
| 400 | Validation DTO (phone non E.164, PIN faible, UUID invalide) | Inspecter la réponse `message` |
| 409 | Conflit (téléphone déjà utilisé) | Changer de téléphone ou supprimer l'utilisateur |
| 429 | Throttle (5 register/h, 3 send-otp/15min, 20 plant-analyses/h) | Attendre ou `DISABLE_THROTTLE=true` |

## Politique de versionnement

- `openapi.json` et `farmcash.postman_collection.json` sont **versionnés** (commités). Ne pas les `.gitignore`.
- Régénérer **avant chaque PR** qui ajoute / modifie un endpoint -> `bash scripts/export-openapi.sh` + commit du diff.
- Le `info.version` de la spec suit la version définie dans `apps/api-gateway/src/main.ts` (`setVersion`).

## Pour aller plus loin

- Spec source des décorateurs Swagger : voir [`apps/api-gateway/src/main.ts`](../../apps/api-gateway/src/main.ts) (`DocumentBuilder`).
- Conventions de tags Nest : `@ApiTags('auth' | 'marketplace' | 'negotiation' | 'orders' | 'finance' | 'logistics' | 'messaging' | 'ai' | ...)` au-dessus du controller.
- Convention de description : `@ApiOperation({ summary: '[RÔLE] Description courte' })` -> facilite la lecture dans Swagger UI groupé par rôle.
