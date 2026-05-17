# 📘 Guide d'Architecture Backend — FarmCash AI

> Plateforme agricole reliant **producteurs**, **acheteurs**, **coopératives**, **transporteurs**, **exportateurs** et **administrateurs** autour d'une marketplace + escrow Mobile Money + diagnostic IA.

---

## 👥 1. Les 6 acteurs de la plateforme

Chaque utilisateur a UN rôle parmi ces 6, déterminé à l'inscription et stocké dans `users.role` (enum SQL `user_role`). Le rôle conditionne toutes les autorisations.

| Rôle | Qui | Profil étendu | Actions principales |
|---|---|---|---|
| **FARMER** | Producteur agricole | `producteur_profiles` (parcelles, cultures, coop) | Publier annonces de vente, gérer parcelles, déclarer cultures, recevoir paiements |
| **BUYER** | Acheteur local | `acheteur_profiles` (entreprise, RCCM, zones) | Acheter sur le marketplace, faire des offres, payer via Mobile Money |
| **COOPERATIVE** | Coopérative agricole | `cooperative_profiles` + `cooperative_members` | Agréger les stocks des membres, vendre en B2B, gérer le payout aux membres |
| **TRANSPORTER** | Transporteur | (pas de profil étendu, déclare des `transporter_routes`) | Déclarer ses routes/tarifs, accepter des missions, livrer avec preuve photo |
| **EXPORTER** | Acheteur international B2B | (pas de profil étendu) | Acheter via `commande_b2b`, gérer `export_documents` douaniers |
| **ADMIN** | Équipe FarmCash | (pas de profil étendu) | Superviser la plateforme, arbitrer les litiges, gérer le catalogue |

**Le module `Auth` gère tous les 6 rôles** via une seule table `users`. L'inscription crée automatiquement le profil étendu correspondant si applicable.

---

## 🏗️ 2. Architecture monorepo

```text
farmcash-backend/
├── apps/
│   └── api-gateway/                  # Point d'entrée HTTP (port 3000)
│       └── src/main.ts → app.module.ts
├── modules/                          # 12 modules autonomes
│   ├── shared/                       # Utilitaires : filters, interceptors, decorators
│   ├── database/                     # PrismaService (@Global)
│   ├── auth/                         # 🔐 Authentification (6 rôles)
│   ├── marketplace/                  # 🏪 Annonces, panier, stocks, parcelles
│   ├── negotiation/                  # 🤝 Candidatures, propositions, contre-offres
│   ├── orders/                       # 📦 Commandes + disputes
│   ├── finance/                      # 💰 Wallets, escrow, Mobile Money
│   ├── logistics/                    # 🚚 Routes transporteur, missions, GPS
│   ├── messaging/                    # 💬 Chat REST + WebSocket
│   ├── notifications/                # 🔔 Notifs + SSE temps réel
│   ├── ai/                           # 🤖 IA, traçabilité, assistant, news
│   └── oversight/                    # 👁️ Dashboards par rôle (admin/coop/etc.)
├── prisma/schema.prisma              # 64 tables introspectées
├── test/                             # Tests E2E (7 suites, 53 tests)
└── apps/api-gateway/src/app.module.ts  # Importe les 10 modules métier
```

**Architecture** : monolithe modulaire prêt à devenir microservices. Chaque module est indépendant (DTOs, controllers, services, index.ts) et expose son service via DI. Une seule DB Postgres+PostGIS partagée.

### Structure interne d'un module type

```text
modules/<nom>/src/
├── dto/                              # Validation entrée (class-validator)
├── entities/                         # Forme de sortie (réponses API)
├── guards/                           # Sécurité spécifique (optionnel)
├── <nom>.module.ts                   # Déclaration NestJS
├── <nom>.controller.ts               # Routes HTTP
├── <nom>.service.ts                  # Logique métier (appels Prisma)
└── index.ts                          # Exports publics (@farmcash/<nom>)
```

---

## 🔐 3. Module `Auth` — gère TOUS les acteurs

**Responsabilité** : Inscription, vérification OTP, login PIN, JWT + refresh tokens, gestion des profils étendus pour les 6 rôles.

### Tables consommées
`users`, `producteur_profiles`, `acheteur_profiles`, `cooperative_profiles`, `cooperative_members`, `otps`, `refresh_tokens`, `device_tokens`, `user_documents`, `user_login_history`.

### Flow d'inscription par rôle

| Rôle | Profil étendu créé automatiquement ? |
|---|---|
| FARMER | ✅ `producteur_profiles` |
| BUYER | ✅ `acheteur_profiles` |
| COOPERATIVE | ✅ `cooperative_profiles` (nom "Ma coopérative" par défaut) |
| TRANSPORTER | ❌ Pas de profil étendu. Le transporteur déclare ses `transporter_routes` après inscription |
| EXPORTER | ❌ Pas de profil étendu. Identifié uniquement par `users.role = 'EXPORTER'` |
| ADMIN | ❌ Pas de profil étendu. Promotion via DB (pas via API publique) |

### Sécurité

- **PIN** : bcrypt rounds=12, blacklist anti-PIN-faibles (`1234`, `0000`...)
- **OTP** : bcrypt rounds=10, durée 10 min, à usage unique
- **Refresh tokens** : sha256 déterministe + rotation à chaque `/refresh` + détection de rejeu
- **Account lock** : 3 PIN ratés → 15 min lock
- **Anti-énumération** : message identique pour "user inconnu" et "PIN faux" + bcrypt simulé timing
- **Rate limiting** : 5 register/h, 3 send-otp/15min, 10 login-pin/5min
- **JWT_SECRET** obligatoire ≥ 32 caractères (crash au boot sinon)

### Routes (préfixées `/api/auth`)
| Méthode | Route | Description |
|---|---|---|
| POST | `/register` | Inscription tous rôles |
| POST | `/send-otp` + `/verify-otp` | Vérification phone |
| POST | `/login-pin` | Connexion PIN → JWT |
| POST | `/refresh` | Rotation des tokens |
| POST | `/logout` | Révoque session |
| GET | `/me` | Profil complet (pin_hash exclu) |
| POST | `/set-pin`, `/change-pin` | Gestion du PIN |
| POST | `/profile/update`, `/device-token` | Profil + FCM |

---

## 🏪 4. Module `Marketplace`

**Responsabilité** : Catalogue, annonces de vente (FARMER), demandes d'achat (BUYER), publications agrégées (COOP), panier, entrepôts, lots, parcelles, cultures, favoris, avis, médias, prévisions de récolte.

### Tables
`annonces_vente`, `annonces_achat`, `publications_stock_coop`, `produits_agricoles`, `categories_cultures`, `sous_categories`, `lots`, `lot_contributions`, `entrepots`, `stock`, `medias`, `favoris`, `avis`, `panier`, `panier_items`, `user_cultures`, `parcelle`, `previsions_production`, `reservations_previsions`.

### Sous-domaines (6 sous-controllers)

| Sous-controller | Routes | Rôles |
|---|---|---|
| `MarketplaceController` | Catalogue, annonces vente/achat, publications coop | tous (lecture publique) |
| `PanierController` | Get/add/remove panier | BUYER, COOPERATIVE |
| `StockController` | Entrepôts + lots | FARMER, COOPERATIVE |
| `AgronomieController` | Parcelles + cultures | FARMER, COOPERATIVE |
| `InteractionsController` | Favoris, avis, médias | BUYER, FARMER, COOPERATIVE |
| `PrevisionsController` | Prévisions + réservations | FARMER → BUYER |

### Garde-fous métier
- Prix du panier **relu serveur** (pas envoyé par le client)
- `views_count` incrémenté uniquement si viewer ≠ owner
- Coordinates GPS validées (`@IsLatitude/IsLongitude`), pas de fallback
- Médias : ownership vérifiée sur la cible avant ajout/suppression
- Avis : exige une commande COMPLETED + pas d'auto-review + pas de doublon
- `cooperative_id` toujours pris du JWT, jamais du body

---

## 🤝 5. Module `Negotiation`

**Responsabilité** : 3 flux de négociation avec state machine commune (PENDING → ACCEPTED/REJECTED/COUNTER_OFFER/CANCELLED).

### Tables
`candidatures_achat`, `candidature_traitements`, `propositions_vente`, `proposition_traitements`, `contre_offres_coop`, `contre_offre_coop_traitements`.

### Les 3 flux

| Flux | Émetteur | Receveur | Cible |
|---|---|---|---|
| Candidature | BUYER | FARMER | `annonce_vente` |
| Proposition | FARMER ou COOPERATIVE | BUYER | `annonce_achat` |
| Contre-offre | BUYER | COOPERATIVE | `publication_stock_coop` |

Anti-spam : pas deux offres PENDING simultanées sur la même cible. State machine refuse les transitions illégales.

---

## 📦 6. Module `Orders` (avec Disputes)

**Responsabilité** : Cycle de vie complet d'une commande, de la création à la libération de l'escrow.

### Tables
`commandes_vente`, `disputes`. Lecture : `annonces_vente`, `candidatures_achat`, `propositions_vente`, `reservations_previsions`, `contre_offres_coop`, `publications_stock_coop`, `moyen_de_payement`.

### 5 sources de commande possibles

| `source_type` | Référence requise | Vendeur déduit de |
|---|---|---|
| `DIRECT_ANNONCE_VENTE` | `annonce_vente_id` | `annonces_vente.farmer_id` |
| `CANDIDATURE_ACCEPTED` | `candidature_id` (ACCEPTED) | annonce.farmer_id |
| `PROPOSITION_ACCEPTED` | `proposition_id` (ACCEPTED) | proposition.vendeur_id |
| `RESERVATION_CONFIRMED` | `reservation_id` (CONFIRMED) | prevision.farmer_id |
| `CONTRE_OFFRE_ACCEPTED` | `contre_offre_id` (ACCEPTED) | coop.user_id |

### State machine
```
SENT → ACCEPTED → IN_PROGRESS → DELIVERED → COMPLETED
  └──→ REJECTED   └──→ CANCELLED   └──→ DISPUTED → COMPLETED ou CANCELLED
```

Matrice acteur :
- **Seller** : ACCEPTED, REJECTED, IN_PROGRESS, DELIVERED
- **Buyer** : COMPLETED (confirme la livraison)
- **Les deux** : DISPUTED, CANCELLED

---

## 💰 7. Module `Finance`

**Responsabilité** : Wallets, transactions, escrow en 2 volets (produit + transport), moyens de paiement Mobile Money, batches de payout coop.

### Tables
`wallets`, `transactions`, `escrow_conditions`, `moyen_de_payement`, `payout_batches`, `payout_items`.

### Modèle économique

```
BUYER paye : produit + transport
  ├── Escrow PRODUCT  → seller (montant − 3% commission)
  └── Escrow TRANSPORT → transporter (montant − 3% commission)

Commissions configurables via .env :
  SERVICE_FEE_PRODUCT=0.03
  SERVICE_FEE_TRANSPORT=0.03
  PREVISION_DOWNPAYMENT_RATE=0.20
```

### Sécurité financière
- `amount` jamais accepté du body (lu côté serveur depuis `commande.montant_total`)
- `phone_number` retiré des DTOs, remplacé par `payment_method_id` (ownership vérifiée)
- `is_frozen` empêche tout débit
- 2 escrows distincts dans `escrow_conditions` (`kind` = PRODUCT ou TRANSPORT)
- **Pas de route publique** `POST /finance/payin` — appelé uniquement par OrdersService en interne
- `POST /finance/release-escrow` réservé ADMIN (override pour litiges)

---

## 🚚 8. Module `Logistics`

**Responsabilité** : Routes des transporteurs, devis, missions de transport, tracking GPS, preuve de livraison.

### Tables
`transporter_routes` (nouvelle table créée pendant l'audit), `shipments`, `shipment_tracking`.

### Modèle tarifaire

**Les transporteurs fixent leurs tarifs** (pas la plateforme). À l'inscription :
```
TRANSPORTER déclare une route : origine → destination
  + tarif_kg (ex. 150 FCFA/kg)
  + tarif_minimum (ex. 10 000 FCFA forfait)
  + capacite_max_kg
  + delai_typique
```

**Au moment d'une commande** :
1. Buyer interroge `GET /logistics/quotes?origin=&destination=&quantite_kg=` → reçoit les offres triées
2. Buyer choisit (généralement le moins cher) et passe la commande avec `transporter_route_id`
3. Système crée un shipment REQUESTED + escrow TRANSPORT (beneficiary null)
4. Tous les transporteurs matchant les zones sont notifiés
5. **Premier qui accepte gagne** → escrow.beneficiary_id = lui

### Cycle de vie shipment
```
REQUESTED → ACCEPTED → LOADING → IN_TRANSIT → DELIVERED
   └──→ CANCELLED
```

---

## 💬 9. Module `Messaging`

**Responsabilité** : Chat REST + WebSocket entre acteurs.

### Tables
`conversations`, `conversation_participants`, `messages` (avec `role` = 'user' | 'assistant').

### Sécurité WebSocket
- JWT obligatoire au handshake (sinon disconnect immédiat)
- `userId` extrait du JWT, jamais du body client
- `joinConversation` vérifie ownership avant d'autoriser la room
- `sendMessage` force le sender à l'userId du JWT

---

## 🔔 10. Module `Notifications`

**Responsabilité** : Création de notifications via DI (par les autres modules), listing paginé + SSE temps réel.

### Tables
`notifications`, `device_tokens` (lecture).

### Architecture
- **Pas de route publique POST** : la création est uniquement INTERNE (via DI depuis Orders, Finance, Logistics, Messaging…)
- Flux SSE temps réel sur `/notifications/stream` (filtré par userId)
- Token FCM enregistré via `/auth/device-token` (canal unique, pas de duplication)

---

## 🤖 11. Module `AI` (6 sous-domaines)

**Responsabilité** : Tout ce qui touche à l'IA et à la traçabilité.

### Tables
`plant_analyses`, `produits_traitement`, `traceability_events`, `ai_news`, `conversations` (is_ai_session=true), `messages`.

### Sous-domaines

| Sous-domaine | Description | Provider externe |
|---|---|---|
| Plant Analyses | Diagnostic IA des maladies via photo | `PlantAiProvider` (stub dev / Plant.id en prod) |
| Treatments | Catalogue de traitements + recommandations | — |
| Traceability | Parcours d'un lot, scan QR public | Polygon blockchain (post-MVP) |
| Assistant | Chat conversationnel + tool-use (publier annonce) | `LlmProvider` (stub dev / Claude/GPT en prod) |
| Insights | Cartes personnalisées par rôle | — (SQL agrégé) |
| News | Fil d'actualité filtré par rôle/région | — |

### Sans API externes
- Treatments, Traceability, Insights, News → **100% fonctionnel**
- Plant Analyses, Assistant → **mocks déterministes** en dev, à brancher en prod via les Providers

---

## 👁️ 12. Module `Oversight` (Dashboards par rôle)

**Responsabilité** : Tableaux de bord agrégés en lecture, **un par rôle**.

### 6 vues, 6 controllers

| Rôle | Préfixe routes | Contenu du dashboard |
|---|---|---|
| ADMIN | `/oversight/admin/*` | Tout : users, transactions, orders, disputes, escrows. Actions : freeze wallet, deactivate user |
| COOPERATIVE | `/oversight/coop/*` | Membres + leurs annonces + commandes |
| EXPORTER | `/oversight/exporter/*` | Commandes B2B + documents export + offres |
| BUYER | `/oversight/buyer/*` | Mes achats, dépenses 30j, candidatures, panier, top produits |
| TRANSPORTER | `/oversight/transporter/*` | Mes missions, revenus 30j, rating, top routes |
| FARMER | `/oversight/farmer/*` | Ventes 30j, conversion annonces→commandes, alertes cultures IA |

Aucune logique métier propre — uniquement de l'agrégation SQL parallélisée (`Promise.all`).

---

## 🏢 13. Module `Cooperatives` (ajout 2026-05)

**Responsabilité** : tout le domaine coopérative en module dédié, prêt à être extrait en microservice.

### Tables principales

- `cooperative_profiles` (existante, étendue) : `commission_rate`, `auto_distribute`, `president_id`
- `cooperative_members` : rôles internes (`PRESIDENT`, `GERANT`, `TRESORIER`, `MEMBER`)
- `coop_join_requests` : un FARMER demande à rejoindre
- `coop_invitations` : une COOP invite un farmer (par téléphone)
- `publication_contributions` : traçabilité des contributions agrégées
- `coop_advance_payments` : avances versées par la coop à ses producteurs

### Workflow complet

```
1. FARMER s'inscrit avec default_cooperative_id  → join-request PENDING
2. COOP accepte                                   → membership active
3. FARMER publie annonce assigned_to_coop_id      → coop_status PENDING
   Stock annonce 100% privé (PAS visible marketplace)
4. COOP pèse, valide                              → coop_status VALIDATED
   Le farmer ne peut plus modifier
5. COOP agrège N annonces VALIDATED               → publications_stock_coop
   Crée publication_contributions (qui a contribué)
6. Publication visible sur le marketplace
7. BUYER achète via /orders                       → escrow PRODUCT LOCKED
8. Livraison → confirm-delivery                   → escrow → wallet COOP
9. COOP commission_rate% est retenu               → reste distribué au prorata
10. Distribution au prorata des contributions
    Acomptes déjà versés (advances) déduits automatiquement
```

### Avances coop → producteur (acompte avant agrégation)

```
POST /coop/advances { farmer_id, annonce_vente_id, amount }
→ La coop débite son wallet, crédite le producteur
→ Status PAID
→ À la distribution finale : marquée REIMBURSED, déduite de la part du producteur
```

### Prévisions → annonce officielle

```
FARMER POST /marketplace/previsions                 → status OPEN
BUYER  POST /marketplace/previsions/reserver
        + payment_method_id                         → 10% débité MoMo, escrow DEPOSIT
                                                    → reservation CONFIRMED
FARMER POST /marketplace/previsions/:id/convert
        + titre, prix, quantité_min, qualité…       → crée annonce_vente officielle
                                                    → annonce.quantite_kg = prevision - sum(reservations)
                                                    → réservations → AWAITING_FINAL
                                                    → notif buyers : "Payez le solde sous 7j"
BUYER  POST /orders source=RESERVATION_CONFIRMED   → débite QUE le solde 90%
                                                    → escrow LOCKED 100%
Si BUYER ne paye pas dans 7j → cron expire :
  • Deposit forfait au farmer (défaut) OU refund (REFUND_BUYER)
  • Stock libéré sur l'annonce publique
```

### Routes (préfixées `/api`)

- **Public** : `GET /cooperatives`, `GET /cooperatives/:id`, `GET /cooperatives/publications/list`
- **Profil** : `PUT /coop/profile`
- **Adhésion** : `POST/GET/PUT /coop/join-requests`, `POST /coop/invitations`, `GET /coop/invitations/my`, `PUT /coop/invitations/:id/handle`
- **Membres** : `GET /coop/members`, `DELETE /coop/members/:id`, `PUT /coop/members/:id/role`
- **Validation annonces** : `GET /coop/annonces-vente/assigned`, `PUT .../:id/validate`, `PUT .../:id/reject`
- **Validation prévisions** : `GET /coop/previsions/assigned`, `PUT .../:id/validate`, `PUT .../:id/reject`
- **Agrégation** : `POST /coop/publications/aggregate`, `GET /coop/publications/:id/contributions`, `POST /coop/publications/:id/distribute`
- **Publications CRUD** : `POST /coop/publications`, `PUT/DELETE /coop/publications/:id`
- **Avances** : `POST /coop/advances`, `GET /coop/advances`, `GET /coop/advances/by-annonce/:id`
- **Vue FARMER côté coop** : `GET /coop/my-annonces`, `GET /coop/my-annonces/:id/context`

---

## 🛡️ 14. Hardening finance (Phase 1 + 1.5, ajout 2026-05)

### Phase 1 : robustesse structurelle

- **Row locking `FOR UPDATE`** sur tous les wallets avant débit/crédit (anti-race)
- **`CHECK (balance >= 0)`** SQL → balance jamais négative au niveau DB
- **Wallet TREASURY plateforme** (`00000000-0000-0000-0000-000000000001`) qui accumule les frais 3%
- **`Prisma.Decimal`** partout (plus de `Math.round * 100 / 100`)
- **Table `admin_audit_log`** : trace immuable des actions admin (freeze, deactivate, escrow override)
- **Anti-lockout** : impossible de désactiver le dernier admin actif
- **Endpoint `GET /finance/reconciliation`** (ADMIN) : audit wallets ↔ transactions, drift OK/KO

### Phase 1.5 : architecture provider-ready

- **Interface `PaymentProvider`** : contrat stable pour Mobile Money
- **`MockPaymentProvider`** : simule délais 200-1500ms, taux d'échec configurable, webhook async réaliste, idempotency
- **`POST /webhooks/payment-provider/:provider`** : endpoint de callback (futur Orange/MTN/Wave/CinetPay)
- **`idempotency_key`** sur transactions : dedup des webhooks dupliqués
- **`CircuitBreakerService`** : CLOSED → OPEN après 5 échecs, HALF_OPEN après 30s
- **`RetryQueueService`** : backoff exponentiel 30s/2min/10min, max 3 tentatives
- **`ReconciliationCronService`** : daily (24h), log WARN si drift

### Refunds

- **`refundBuyer(commandeId)`** : remboursement intégral, escrow → balance
- **`partialRefund(commandeId, buyer_pct)`** : split négocié buyer/seller (- frais)
- **`refundReservationDeposit`** + **`forfeitReservationDeposit`** pour les expirations

---

## 🛡️ 15. Hardening orders (ajout 2026-05)

- **Stock annonce décrémenté SEULEMENT au paiement confirmé** (pas à la création de commande)
- **Si stock=0 → annonce.status = SOLD** (disparaît du marketplace)
- **Row lock sur `updateStatus`** : transitions concurrentes safe
- **`createOrder` atomique** : commande + payin dans une saga avec compensation (rollback complet si échec)
- **Cron orphan cleanup** (hourly) : commandes SENT > 24h → CANCELLED
- **Header `Idempotency-Key`** sur `POST /orders` : anti-double-clic
- **`ResolveDispute` complet** : REFUND_BUYER + PAY_SELLER + PARTIAL_REFUND avec split

---

## 🛡️ 16. Hardening transverse (ajout 2026-05)

| Module | Fix |
|---|---|
| **Logistics** | Row lock sur `acceptShipment` ; à `cancelShipment`, reset `escrow_TRANSPORT.beneficiary_id` ; cron horaire des shipments REQUESTED >48h |
| **Messaging** | Whitelist domaines pour `media_url` (HTTPS + `cdn.farmcash.ci` + `MEDIA_URL_ALLOWED_DOMAINS`) |
| **AI** | `treatments.getForAnalysis` exige ownership (anti-leak diseases) ; `@Throttle(20/h)` sur `POST /plant-analyses` |
| **Oversight** | `admin_audit_log` branché sur freeze/unfreeze/deactivate/reactivate ; anti-lockout dernier admin |
| **Negotiation** | Annonces en workflow coop (PENDING/VALIDATED/INCLUDED) interdites en candidature directe |

---

## ⏰ 17. Cron jobs en arrière-plan

4 services background, désactivables via env :

| Service | Fréquence | Action | Env var de désactivation |
|---|---|---|---|
| `ReconciliationCronService` | daily | Vérifie cohérence wallets ↔ transactions | `DISABLE_RECONCILIATION_CRON=true` |
| `OrdersCleanupCron` | hourly | Commandes SENT >24h → CANCELLED + restore stock | `DISABLE_ORDERS_CLEANUP=true` |
| `ReservationsExpirationCron` | hourly | Réservations AWAITING_FINAL expirées → forfait/refund + restore stock | `DISABLE_RESERVATION_EXPIRATION=true` |
| `LogisticsCleanupCron` | hourly | Shipments REQUESTED >48h → CANCELLED + refund escrow TRANSPORT | `DISABLE_LOGISTICS_CLEANUP=true` |

Tous utilisent `setInterval`/`OnModuleInit` (pas de dépendance externe). En prod sérieuse, migrer vers `@nestjs/schedule` ou cron externe.

---

## 🔁 18. Flow type d'une commande complète (avec transport)

```
1. FARMER  → POST /marketplace/annonces/vente
              + coordinates GPS validées
              → annonce ACTIVE

2. TRANSPORTER → POST /logistics/routes
                  Bouaké → Abidjan, 150 FCFA/kg, capacité 1000kg

3. BUYER   → GET /logistics/quotes?origin=Bouaké&dest=Abidjan&qty=100
              → reçoit Issa 16 000 FCFA, Mahmoud 18 000…

4. BUYER   → POST /orders {
                source_type: DIRECT_ANNONCE_VENTE,
                annonce_vente_id, quantite_kg: 100,
                transporter_route_id: <Issa>,
                payment_method_id, delivery_address
              }

5. Server  → Calcule total : 100×1500 + 16 000 = 166 000 FCFA
              Crée commande SENT
              Crée 2 escrows : PRODUCT (seller) + TRANSPORT (beneficiary null)
              Appelle FinanceService.processPayin (simul Mobile Money)
              confirmPayment → commande ACCEPTED + balance_escrow buyer +166 000

6. Issa    → POST /logistics/shipments/:id/accept
              shipment ACCEPTED + escrow TRANSPORT.beneficiary = Issa

7. Issa    → start-loading → track GPS → deliver (photo preuve obligatoire)
              shipment DELIVERED + commande DELIVERED

8. BUYER   → POST /finance/confirm-delivery
              → Libère les 2 escrows :
                • Seller crédité 145 500 (150 000 − 3%)
                • Issa crédité 15 520 (16 000 − 3%)
                • Plateforme touche 4 980 (3% × 2)
                • commande COMPLETED
                • balance_escrow buyer = 0
```

---

## 🧪 14. Tests E2E

Suite complète dans `test/` : **7 suites, 53 tests, ~8 secondes**.

| Suite | Couvre |
|---|---|
| `auth.e2e-spec.ts` | Register, set-pin, login, anti-énumération, /me, refresh rotation |
| `order-flow.e2e-spec.ts` | Scénario complet de A à Z |
| `negotiation.e2e-spec.ts` | Candidature → traitement, anti-spam, state machine |
| `logistics.e2e-spec.ts` | Flow avec transport + 2 escrows + anti-fraude transporter |
| `messaging.e2e-spec.ts` | Conversation, 403 tiers, validation media |
| `ai.e2e-spec.ts` | Plant analysis mock, assistant tool-use, news ADMIN |
| `oversight.e2e-spec.ts` | 6 dashboards, cross-role 403, freeze wallet |

```bash
npm run test:e2e                              # toute la suite
npm run test:e2e -- --testPathPatterns=auth   # une seule suite
```

---

## 🛠️ 15. Commandes utiles

| Commande | Action |
|---|---|
| `docker compose up -d` *(racine)* | Lance Postgres + Redis + MinIO + Mailhog + pgAdmin |
| `npm run start:dev` | Serveur NestJS auto-reload |
| `npm run start:prod` | Serveur compilé (`dist/`) |
| `npm run build` | Compile TS → JS dans `dist/` |
| `npm run test:e2e` | Tests d'intégration end-to-end |
| `npx prisma db pull` | Synchronise `schema.prisma` depuis la DB |
| `npx prisma generate` | Régénère le client Prisma TypeScript |
| `npx prisma studio` | Interface web pour explorer la DB (port 5555) |

URLs locales :
- API : http://localhost:3000/api
- Swagger : http://localhost:3000/api/docs
- pgAdmin : http://localhost:5050
- MinIO Console : http://localhost:9001
- Mailhog : http://localhost:8025

---

## 🚀 16. Bonnes pratiques

1. **DTOs avec class-validator** sur tous `@Body()` / `@Query()` / `@Param()`. Pas de `any`.
2. **`@CurrentUser()`** au lieu de `@Req() req: any` partout.
3. **Pas de logique métier dans les controllers** — délégué au service.
4. **Aliases TypeScript** : import via `@farmcash/<module>`, jamais en relatif vers un autre module.
5. **Ownership** sur tout update/delete : `findFirst({where: {id, owner_id: userId}})` avant action.
6. **Transactions Prisma** (`$transaction`) pour toute opération multi-tables (création commande, libération escrow, batch payout).
7. **Pas de prix client** : le serveur recalcule depuis la DB. Le DTO ne doit JAMAIS contenir un montant final.
8. **Coordinates** validées par `@ValidateNested` + `CoordinatesDto`, pas de fallback géographique.
