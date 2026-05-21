# lancer Docker (une seule fois par session)
cd ~/Desktop/farmcash-ai
docker compose up -d

# vérifier que tout tourne bien
cd ~/Desktop/farmcash-ai
docker compose ps

# arrêter Docker
cd ~/Desktop/farmcash-ai
docker compose stop

# Voir les différentes tables dans la base de données
pgAdmin (voir les tables)
    url: http://localhost:5050
    username: admin@farmcash.ai
    password: farmcash_pass_2025

# Voir les photos et images dans MinIO
MinIO (fichiers/photos)
    url: http://localhost:9001
    username: farmcash_minio
    password: farmcash_minio_2025

# Voir les emails de test sur Mailhog
Mailhog (emails test)
    url: http://localhost:8025

# Terminal 2 — lancer NestJS (quand le projet sera créé)
cd ~/Desktop/farmcash-ai/farmcash-backend
npm run start:dev


