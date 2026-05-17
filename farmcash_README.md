# 🌱 FarmCash AI — Documentation de démarrage

Ce fichier contient les instructions pour lancer l'infrastructure et le backend du projet FarmCash AI.

---

## 🏗️ Infrastructure Docker
Le projet utilise plusieurs services conteneurisés définis dans `docker-compose.yml`.

### Lancer les services :
```bash
docker compose up -d
```

### Services inclus :
- **PostgreSQL** (Port 5432) : Base de données principale avec PostGIS.
- **Redis** (Port 6379) : Cache et gestion des sessions.
- **pgAdmin** (Port 5050) : Interface de gestion de base de données.
- **MinIO** (Port 9000/9001) : Stockage d'objets (S3 compatible).
- **Mailhog** (Port 1025/8025) : Serveur SMTP de test.

---

## 🚀 Backend NestJS
Le backend est situé dans le dossier `farmcash-backend/`.

### Installation :
```bash
cd farmcash-backend
npm install
```

### Lancement en développement :
```bash
npm run start:dev
```

---

## 📊 Base de données
Le schéma complet est situé dans `database/init/01_schema.sql`.
Il contient environ 60 tables réparties par modules métier (Auth, Marketplace, Finance, etc.).

---

*Note : Pour plus de détails techniques sur l'architecture, consultez le fichier `farmcash-backend/guide_backend.md`.*
