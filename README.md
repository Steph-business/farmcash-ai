# 🌱 FarmCash AI — Documentation Complète & Guide d'Architecture

> **Bienvenue sur FarmCash AI.** Ce projet est une plateforme agrotech modulaire conçue pour transformer l'agriculture africaine par la technologie, l'IA et la traçabilité.

---

## 🚀 1. Démarrage Rapide

### 📂 Structure du projet
```text
farmcash-ai/
├── README.md                   ← Cette documentation
├── docker-compose.yml          ← Infrastructure complète (BDD, Cache, S3, Email)
├── database/
│   └── init/
│       └── 01_schema.sql       ← Schéma SQL complet (~60 tables)
└── farmcash-backend/           ← API NestJS (Monorepo modulaire)
```

### 🛠️ Installation
1. **Docker Desktop** : Installez [Docker Desktop](https://www.docker.com/products/docker-desktop).
2. **Infrastructure** :
   ```bash
   cd farmcash-ai
   docker compose up -d
   ```
3. **Backend** :
   ```bash
   cd farmcash-backend
   npm install
   npm run start:dev
   ```

### 🔗 URLs des Services
| Service | URL | Identifiants |
|---------|-----|--------------|
| **pgAdmin** (BDD) | [http://localhost:5050](http://localhost:5050) | admin@farmcash.ai / farmcash_admin_2025 |
| **Swagger** (Docs API) | [http://localhost:3000/api/docs](http://localhost:3000/api/docs) | *(Public)* |
| **MinIO** (Stockage S3) | [http://localhost:9001](http://localhost:9001) | farmcash_minio / farmcash_minio_2025 |
| **Mailhog** (Emails) | [http://localhost:8025](http://localhost:8025) | *(Public)* |

---

## 🏗️ 2. Architecture Technique (Backend)

Le backend utilise **NestJS** dans une architecture **Monorepo modulaire**. Chaque domaine métier est encapsulé dans son propre module, garantissant une séparation stricte des responsabilités et facilitant une migration future vers des microservices.

### 📂 Structure d'un Module
```text
modules/nom_du_module/src/
├── dto/                    # Validation des entrées (class-validator)
├── entities/               # Représentation des données de sortie
├── guards/                 # Sécurité et permissions
├── module_name.controller.ts # Endpoints HTTP
├── module_name.service.ts    # Logique métier pure
└── index.ts                # Exports publics
```

### 🔐 3. Sécurité "Uber-Level"
Le système d'authentification (`AuthModule`) implémente des standards de sécurité de niveau bancaire :
- **PIN Hashing** : Bcrypt (rounds=12) pour les codes secrets.
- **OTP Hashing** : Bcrypt (rounds=10) stockés en DB, jamais en clair.
- **Refresh Tokens** : Rotation systématique à chaque renouvellement avec détection de rejeu (révoque toutes les sessions en cas de fraude).
- **Verrouillage de compte** : 3 tentatives PIN ratées = 15 minutes de blocage.
- **Anti-énumération** : Timing attacks masquées et messages d'erreur génériques.

---

## 🧩 4. Domaines Métier & Modules

### 🔐 Auth (Authentification)
Gestion des utilisateurs (Farmer, Buyer, Cooperative), sécurité (OTP, PIN, JWT) et profils étendus. Intègre `SmsProvider` pour les codes de vérification.

### 🏪 Marketplace (Place de marché)
Le plus gros module. Gère le catalogue, les annonces de vente/achat, les stocks, l'agronomie (parcelles/cultures), les favoris, les avis et le panier.

### 🤝 Negotiation (Négociation)
Flux B2B/C2C : Candidatures d'achat, propositions de vente et contre-offres. Machine à états stricte (Pending → Accepted/Rejected).

### 📦 Orders (Commandes)
Cycle de vie complet : SENT → ACCEPTED → IN_PROGRESS → DELIVERED → COMPLETED. Intègre la gestion des litiges (Disputes).

### 💰 Finance (Wallets & Escrow)
Gestion des portefeuilles XOF, séquestre (Escrow) en deux volets (Produit + Transport), et simulation de paiement Mobile Money (Orange, MTN, Wave).

### 🚚 Logistics (Transport)
Matching entre transporteurs et commandes. Suivi GPS en temps réel et libération de l'escrow transport à la livraison.

### 💬 Messaging (Tchat)
Conversations 1-1 et de groupe. Temps réel via **WebSockets** et intégration avec les notifications push.

### 🔔 Notifications
Système centralisé (Global) gérant les notifications In-App (SSE), Push (FCM) et SMS.

### 🧠 AI (Intelligence Artificielle)
Analyses phytosanitaires (maladies des plantes), recommandations de traitements, et assistant IA pour les agriculteurs.

---

## ✅ 5. État d'Avancement & Roadmap

- [x] **Phase 1 : Infrastructure** (Docker, PostgreSQL, PostGIS, Redis)
- [x] **Phase 2 : Core Engine** (Auth Sécurisé, KYC, Profils)
- [x] **Phase 3 : Marketplace & Négociation** (Annonces, Agronomie, Négociation B2B)
- [x] **Phase 4 : Transactionnel** (Orders, Finance, Escrow, Wallets)
- [x] **Phase 5 : Logistique & Temps Réel** (Shipments, Tracking, Messaging)
- [x] **Phase 6 : IA & Traçabilité** (Plant Analysis, AI Insights)
- [ ] **Étape Suivante** : Tests E2E complets et Intégration réelle des API Orange Money/Twilio.

---

*FarmCash AI — La technologie au service de l'agriculture africaine* 🌍
