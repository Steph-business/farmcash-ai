# lancer Docker (une seule fois par session)
cd ~/chemin/farmcash-ai
docker compose up -d


# verifie que tout tourne bien

cd ~/Desktop/farmcash-ai
docker compose ps

# Arreter Docker 

cd ~/Desktop/farmcash-ai
docker compose stop

# Voir les differentes tables dans la base de données
pgAdmin (voir les tables)
    url: http://localhost:5050
    username: admin@farmcash.ai 
    password:farmcash_pass_2025


# Voir les photos et images dans minI0
MinIO (fichiers/photos)  
    url: http://localhost:9001
    username: farmcash_minio / 
    password: farmcash_minio_2025


# Voir les differentes temails  de test sur Mailhog
Mailhog (emails test)http://localhost:8025 


# Terminal 2 — lancer NestJS (quand le projet sera créé)
cd ~/chemin/farmcash-ai/farmcash-backend
npm run start:dev


