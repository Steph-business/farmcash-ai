-- =================================================================
--  FARMCASH AI — Base de données complète (RÉORGANISÉE)
--  Fichier : farmcash_schema_final.sql
--  Version : 1.1 — Côte d'Ivoire
--
--  ORDRE D'EXÉCUTION (corrigé) :
--    1. Extensions PostgreSQL
--    2. Fonction set_updated_at()
--    3. Types ENUM
--    4. Tables catalogue (cultures CI)
--    5. Seed catalogue
--    6. Tables AUTH
--    7. Tables MARKETPLACE
--    8. Tables NÉGOCIATION
--    9. Tables COMMANDES
--   10. Tables FINANCE
--   11. Tables LOGISTIQUE
--   12. Tables MESSAGERIE
--   13. Tables IA
--   14. Tables INFRASTRUCTURE
--   15. Triggers updated_at
--   16. Seed données IA
--
--  UTILISATION :
--    psql -U farmcash_user -d farmcash_db -f farmcash_schema_final.sql
--    OU via pgAdmin → Query Tool sur farmcash_db → Open File → Run
-- =================================================================


-- =================================================================
--  GLOSSAIRE MÉTIER  —  À LIRE AVANT TOUT POUR COMPRENDRE LE SCHÉMA
-- =================================================================
--
--  CONTEXTE GÉNÉRAL
--    FarmCash AI est une plateforme agricole pour la Côte d'Ivoire (CI)
--    qui connecte producteurs, coopératives, acheteurs, transporteurs
--    et exportateurs. Inclut paiement mobile money, traçabilité
--    blockchain et assistant IA.
--
--  TERMES BUSINESS
--    CI            : Côte d'Ivoire (pays cible MVP)
--    FCFA / XOF    : Franc CFA Afrique de l'Ouest (devise locale, 1 EUR ≈ 656 XOF)
--    USD           : Dollar US (utilisé pour l'export international)
--    PRODUCTEUR    : Agriculteur qui cultive et vend ses produits
--    ACHETEUR      : Grossiste, restaurateur, transformateur qui achète
--    COOPÉRATIVE   : Groupement de producteurs qui mutualise vente/achat
--    EXPORTATEUR   : Société qui exporte à l'international
--    TRANSPORTEUR  : Société/personne qui livre la marchandise
--
--  TERMES FINANCIERS
--    ESCROW        : Argent bloqué sur la plateforme jusqu'à confirmation
--                    de livraison. Si litige, l'argent reste bloqué.
--                    Une fois OK, l'argent est libéré vers le vendeur.
--    MOBILE MONEY  : Paiement par téléphone via opérateurs (Orange, MTN,
--                    Wave, Moov). Standard ouest-africain.
--    PAYOUT        : Versement effectif d'argent vers un wallet mobile money
--    WALLET        : Portefeuille numérique intégré à la plateforme
--    COMMISSION    : Frais prélevés par FarmCash sur chaque vente (1.5%)
--    PRÉFINANCEMENT: Prêt accordé à un producteur avant la récolte
--                    (microcrédit, Phase 5 du projet)
--
--  TERMES SÉCURITÉ / IDENTITÉ
--    KYC           : Know Your Customer = vérification d'identité légale
--                    (CNI, passeport, RCCM pour les sociétés)
--    CNI           : Carte Nationale d'Identité
--    RCCM          : Registre du Commerce et du Crédit Mobilier (CI)
--                    = numéro d'immatriculation officielle d'une société
--    OTP           : One-Time Password = code à 6 chiffres envoyé par SMS
--                    pour s'authentifier
--    JWT           : JSON Web Token = jeton de session de l'API (15min)
--    PIN           : Code secret à 4-6 chiffres saisi sur mobile
--                    (préféré au mot de passe en zones rurales)
--
--  TERMES EXPORT INTERNATIONAL
--    B2B           : Business-to-Business (entreprise à entreprise)
--    INCOTERM      : Terme commercial international qui précise QUI paie
--                    QUOI et JUSQU'OÙ dans la chaîne logistique
--                      - FOB  : Free On Board (vendeur livre au port)
--                      - CIF  : Cost, Insurance, Freight (vendeur paie
--                               le transport et l'assurance jusqu'à
--                               destination)
--                      - EXW  : Ex Works (acheteur prend tout en charge
--                               depuis l'usine)
--                      - DAP  : Delivered At Place (livré à l'adresse)
--                      - CFR  : Cost & Freight (transport mais pas assurance)
--    BL            : Bill of Lading = Connaissement maritime = titre de
--                    propriété de la marchandise pendant le transport
--    PHYTOSANITAIRE: Certificat de santé des plantes (obligatoire export)
--
--  TERMES AGRICOLES
--    PARCELLE      : Champ délimité par GPS (polygone)
--    LOT           : Regroupement de produits avec QR Code de traçabilité
--                    Peut être INDIVIDUAL (1 producteur) ou AGGREGATED
--                    (coop = plusieurs producteurs)
--    CULTURE       : Variété cultivée (igname, cacao, mangue Kent...)
--    SAISON        : Période de récolte (varie selon la culture)
--    TRAÇABILITÉ   : Suivi du produit du champ à l'assiette, enregistré
--                    sur blockchain Polygon pour preuve immuable
--
--  TERMES TECHNIQUES
--    UUID          : Identifiant unique universel (format 8-4-4-4-12)
--                    Évite les conflits entre serveurs/microservices
--    JSONB         : JSON binaire indexé (stockage flexible de données
--                    structurées dans une colonne SQL)
--    GEOGRAPHY     : Type PostGIS pour stocker des coordonnées GPS
--                    (4326 = système WGS84 standard mondial)
--    OUTBOX        : Pattern de communication événementielle pour les
--                    futurs microservices (non utilisé en MVP)
--    BLOCKCHAIN_TX : Hash de la transaction sur la blockchain Polygon
--                    Sert de preuve d'immuabilité
--
-- =================================================================
--  SCHÉMA SIMPLIFIÉ DES RELATIONS PRINCIPALES
-- =================================================================
--
--   ┌─────────┐
--   │  users  │  ← table centrale (tout le monde s'y rattache)
--   └────┬────┘
--        │
--        ├─→ producteur_profiles      (extension role=FARMER)
--        ├─→ acheteur_profiles        (extension role=BUYER)
--        ├─→ cooperative_profiles ─→ cooperative_members
--        ├─→ wallets, moyen_de_payement
--        ├─→ user_documents, otps, refresh_tokens, device_tokens
--        ├─→ parcelle ─→ plant_analyses
--        └─→ ... etc
--
--   FLUX MARKETPLACE :
--   ┌────────────────────────────────────────────────────────────┐
--   │                                                            │
--   │  PRODUCTEUR publie ──→ annonces_vente                      │
--   │                              ↓ candidate                   │
--   │  ACHETEUR ←──────────── candidatures_achat                 │
--   │                              ↓ historique                  │
--   │                         candidature_traitements            │
--   │                                                            │
--   │  COOP publie ─────────→ publications_stock_coop            │
--   │                              ↓ négocie                     │
--   │  ACHETEUR ←──────────── contre_offres_coop                 │
--   │                              ↓ historique                  │
--   │                         contre_offre_coop_traitements      │
--   │                                                            │
--   │  ACHETEUR publie ────→ annonces_achat                      │
--   │                              ↓ propose                     │
--   │  PRODUCTEUR/COOP ←──── propositions_vente                  │
--   │                              ↓ historique                  │
--   │                         proposition_traitements            │
--   │                                                            │
--   │  Tout aboutit à ─────→ commandes_vente                     │
--   │                              ↓                             │
--   │                         shipments + escrow_conditions      │
--   │                              ↓                             │
--   │                         transactions + payout_items        │
--   └────────────────────────────────────────────────────────────┘
--
--   FLUX TRAÇABILITÉ BLOCKCHAIN :
--   parcelle → lots (+ lot_contributions si coop) → traceability_events
--           → QR Code scan → historique complet
--
--   FLUX EXPORT B2B :
--   offres_marche_b2b → commande_b2b + export_documents (5+ docs)
--   → container maritime (compagnie + tracking_number)
--
-- =================================================================




-- =================================================================
--  1. EXTENSIONS POSTGRESQL
-- =================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";


-- =================================================================
--  2. FONCTION set_updated_at()
--  Met à jour automatiquement le champ updated_at à chaque UPDATE.
-- =================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =================================================================
--  3. TYPES ENUM
--  Le DROP TYPE IF EXISTS rend le script idempotent (ré-exécutable
--  sans erreur même si les types existent déjà).
-- =================================================================
DROP TYPE IF EXISTS user_role        CASCADE;
DROP TYPE IF EXISTS product_quality  CASCADE;
DROP TYPE IF EXISTS product_status   CASCADE;
DROP TYPE IF EXISTS order_status     CASCADE;
DROP TYPE IF EXISTS mobile_provider  CASCADE;
DROP TYPE IF EXISTS kyc_status       CASCADE;
DROP TYPE IF EXISTS shipment_status  CASCADE;

CREATE TYPE user_role AS ENUM (
  'FARMER', 'BUYER', 'TRANSPORTER', 'EXPORTER', 'COOPERATIVE', 'ADMIN'
);

CREATE TYPE product_quality AS ENUM (
  'STANDARD', 'PREMIUM', 'BIO', 'EQUITABLE'
);

CREATE TYPE product_status AS ENUM (
  'DRAFT', 'ACTIVE', 'PAUSED', 'SOLD', 'EXPIRED'
);

CREATE TYPE order_status AS ENUM (
  'SENT', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS',
  'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED'
);

CREATE TYPE mobile_provider AS ENUM (
  'ORANGE_MONEY', 'MTN_MOMO', 'WAVE', 'MOOV', 'VIREMENT', 'WALLET'
);

CREATE TYPE kyc_status AS ENUM (
  'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'
);

CREATE TYPE shipment_status AS ENUM (
  'REQUESTED', 'ACCEPTED', 'LOADING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'
);


-- =================================================================
--  4. CATALOGUE DES CULTURES — CÔTE D'IVOIRE
-- =================================================================

-- ---------- Catégories ----------
CREATE TABLE categories_cultures (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        VARCHAR(30) UNIQUE NOT NULL,
  nom         VARCHAR(100) NOT NULL,
  description TEXT,
  icone       VARCHAR(50) DEFAULT 'ti-leaf',
  couleur_hex VARCHAR(7) DEFAULT '#3B6D11',
  sort_order  INTEGER DEFAULT 0,
  pays_code   VARCHAR(5)[] NOT NULL DEFAULT ARRAY['CI'],
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE categories_cultures
  IS 'Domaine: MARKETPLACE | Grandes familles de produits agricoles';

-- ---------- Sous-catégories ----------
CREATE TABLE sous_categories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  categorie_id  UUID NOT NULL REFERENCES categories_cultures(id) ON DELETE CASCADE,
  slug          VARCHAR(50) UNIQUE NOT NULL,
  nom           VARCHAR(100) NOT NULL,
  description   TEXT,
  sort_order    INTEGER DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE sous_categories
  IS 'Domaine: MARKETPLACE | Sous-groupes dans une catégorie';

-- ---------- Produits agricoles ----------
CREATE TABLE produits_agricoles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sous_categorie_id UUID NOT NULL REFERENCES sous_categories(id) ON DELETE RESTRICT,
  slug              VARCHAR(60) UNIQUE NOT NULL,
  nom               VARCHAR(150) NOT NULL,
  nom_local         VARCHAR(200),
  nom_scientifique  VARCHAR(200),
  description       TEXT,
  unite_mesure      VARCHAR(10) NOT NULL DEFAULT 'KG',
  poids_unitaire_kg DECIMAL(8,3),
  prix_marche_min   DECIMAL(10,2),
  prix_marche_max   DECIMAL(10,2),
  est_saisonnier    BOOLEAN NOT NULL DEFAULT FALSE,
  saison_debut      VARCHAR(20),
  saison_fin        VARCHAR(20),
  zones_production  TEXT[],
  est_exportable    BOOLEAN NOT NULL DEFAULT FALSE,
  pays_code         VARCHAR(5)[] NOT NULL DEFAULT ARRAY['CI'],
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INTEGER DEFAULT 0,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_produits_sous_cat ON produits_agricoles(sous_categorie_id);
CREATE INDEX idx_produits_slug     ON produits_agricoles(slug);
CREATE INDEX idx_produits_pays     ON produits_agricoles USING GIN(pays_code);
CREATE INDEX idx_produits_actifs   ON produits_agricoles(is_active) WHERE is_active = TRUE;

COMMENT ON TABLE produits_agricoles
  IS 'Domaine: MARKETPLACE | Référentiel des produits — remplace ENUM product_category';


-- =================================================================
--  5. SEED CATALOGUE — DONNÉES CÔTE D'IVOIRE
-- =================================================================

-- ---------- Catégories (5) ----------
INSERT INTO categories_cultures
  (slug, nom, description, icone, couleur_hex, sort_order, pays_code)
VALUES
  ('TUBERCULES',  'Tubercules & Racines',
   'Cultures souterraines : igname, manioc, taro. Base de l''alimentation en CI.',
   'ti-plant-2', '#3B6D11', 1, ARRAY['CI']),
  ('CEREALES',    'Céréales',
   'Grains secs : maïs, riz, sorgho. Sécurité alimentaire et marchés régionaux.',
   'ti-grain', '#854F0B', 2, ARRAY['CI']),
  ('FRUITS',      'Fruits tropicaux',
   'Fruits frais : banane, mangue, ananas, papaye. Marchés locaux et export frais.',
   'ti-apple', '#993556', 3, ARRAY['CI']),
  ('LEGUMES',     'Légumes & Condiments',
   'Cultures maraîchères : tomate, gombo, aubergine, piment. Marchés urbains CI.',
   'ti-salad', '#0F6E56', 4, ARRAY['CI']),
  ('LEGUMINEUSES','Légumineuses',
   'Graines protéinées : arachide, niébé, soja. Marché local et export régional.',
   'ti-leaf', '#534AB7', 5, ARRAY['CI']);

-- ---------- Sous-catégories (14) ----------
INSERT INTO sous_categories (categorie_id, slug, nom, sort_order)
SELECT id, 'ignames',         'Ignames',           1 FROM categories_cultures WHERE slug = 'TUBERCULES'
UNION ALL
SELECT id, 'manioc-racines',  'Manioc & racines',  2 FROM categories_cultures WHERE slug = 'TUBERCULES'
UNION ALL
SELECT id, 'mais',            'Maïs',              1 FROM categories_cultures WHERE slug = 'CEREALES'
UNION ALL
SELECT id, 'riz',             'Riz',               2 FROM categories_cultures WHERE slug = 'CEREALES'
UNION ALL
SELECT id, 'autres-cereales', 'Autres céréales',   3 FROM categories_cultures WHERE slug = 'CEREALES'
UNION ALL
SELECT id, 'bananes',         'Bananes',           1 FROM categories_cultures WHERE slug = 'FRUITS'
UNION ALL
SELECT id, 'mangues',         'Mangues',           2 FROM categories_cultures WHERE slug = 'FRUITS'
UNION ALL
SELECT id, 'ananas',          'Ananas',            3 FROM categories_cultures WHERE slug = 'FRUITS'
UNION ALL
SELECT id, 'autres-fruits',   'Autres fruits',     4 FROM categories_cultures WHERE slug = 'FRUITS'
UNION ALL
SELECT id, 'agrumes',         'Agrumes',           5 FROM categories_cultures WHERE slug = 'FRUITS'
UNION ALL
SELECT id, 'legumes-fruits',  'Légumes-fruits',    1 FROM categories_cultures WHERE slug = 'LEGUMES'
UNION ALL
SELECT id, 'legumes-feuilles','Légumes feuilles',  2 FROM categories_cultures WHERE slug = 'LEGUMES'
UNION ALL
SELECT id, 'legumes-racines-bulbes', 'Racines & bulbes', 3 FROM categories_cultures WHERE slug = 'LEGUMES'
UNION ALL
SELECT id, 'arachides-soja',  'Arachides & Soja',  1 FROM categories_cultures WHERE slug = 'LEGUMINEUSES'
UNION ALL
SELECT id, 'haricots-niebe',  'Haricots & Niébé',  2 FROM categories_cultures WHERE slug = 'LEGUMINEUSES';

-- ---------- Produits TUBERCULES > Ignames ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  est_saisonnier, saison_debut, saison_fin,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max,
       p.est_saison, p.s_debut, p.s_fin, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('igname-kponan','Igname Kponan','Kponan (Baoulé) · Foro (Dioula)','Dioscorea cayenensis',
   'KG', 150.00, 280.00, TRUE, 'Novembre', 'Février',
   ARRAY['Bouaké','Yamoussoukro','Toumodi','Dimbokro'], FALSE, 1),
  ('igname-florido','Igname Florido','Florido (Dioula)','Dioscorea alata',
   'KG', 120.00, 220.00, TRUE, 'Novembre', 'Mars',
   ARRAY['Bouaké','Bondoukou','Agnibilékrou'], FALSE, 2),
  ('igname-lokpa','Igname Lokpa','Lokpa · Gnidrou (Dioula)','Dioscorea dumetorum',
   'KG', 100.00, 180.00, TRUE, 'Décembre', 'Février',
   ARRAY['Korhogo','Ferkessédougou','Odienné'], FALSE, 3)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       est_saison, s_debut, s_fin, zones, exportable, ordre)
WHERE sc.slug = 'ignames';

-- ---------- Produits TUBERCULES > Manioc & racines ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  est_saisonnier, zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max,
       p.est_saison, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('manioc-doux','Manioc doux','Barakoura (Dioula) · Akwaba (Baoulé)','Manihot esculenta',
   'KG', 60.00, 120.00, FALSE,
   ARRAY['Abidjan','Yamoussoukro','San-Pédro','Daloa'], FALSE, 1),
  ('manioc-amer','Manioc amer','Barakoura kôrô (Dioula)','Manihot esculenta var. amara',
   'KG', 50.00, 100.00, FALSE,
   ARRAY['Yamoussoukro','Abengourou','Bouaké'], FALSE, 2),
  ('taro-macabo','Taro (Macabo)','Mankani (Dioula) · Koko (Baoulé)','Colocasia esculenta',
   'KG', 150.00, 250.00, FALSE,
   ARRAY['Man','Daloa','San-Pédro','Gagnoa'], FALSE, 3),
  ('patate-douce','Patate douce','Toma wolo (Dioula)','Ipomoea batatas',
   'KG', 80.00, 150.00, FALSE,
   ARRAY['Korhogo','Ferkessédougou','Bondoukou'], FALSE, 4)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       est_saison, zones, exportable, ordre)
WHERE sc.slug = 'manioc-racines';

-- ---------- Produits CÉRÉALES > Maïs ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, poids_unitaire_kg, prix_marche_min, prix_marche_max,
  est_saisonnier, saison_debut, saison_fin,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.poids_kg, p.prix_min, p.prix_max,
       p.est_saison, p.s_debut, p.s_fin, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('mais-grain-jaune','Maïs grain jaune','Blé jaune (Dioula)','Zea mays',
   'SAC', 50.00, 8000.00, 13000.00, TRUE, 'Juillet', 'Septembre',
   ARRAY['Korhogo','Ferkessédougou','Boundiali','Bouaké'], FALSE, 1),
  ('mais-grain-blanc','Maïs grain blanc','Blé firin (Dioula)','Zea mays',
   'SAC', 50.00, 8500.00, 14000.00, TRUE, 'Juillet', 'Septembre',
   ARRAY['Korhogo','Odienné','Touba'], FALSE, 2)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, poids_kg, prix_min, prix_max,
       est_saison, s_debut, s_fin, zones, exportable, ordre)
WHERE sc.slug = 'mais';

-- ---------- Produits CÉRÉALES > Riz ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, poids_unitaire_kg, prix_marche_min, prix_marche_max,
  est_saisonnier, saison_debut, saison_fin,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.poids_kg, p.prix_min, p.prix_max,
       p.est_saison, p.s_debut, p.s_fin, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('riz-paddy','Riz paddy','Malo gbê (Dioula)','Oryza sativa',
   'SAC', 50.00, 9000.00, 14000.00, TRUE, 'Octobre', 'Décembre',
   ARRAY['Bouaké','San-Pédro','Man','Gagnoa'], FALSE, 1)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, poids_kg, prix_min, prix_max,
       est_saison, s_debut, s_fin, zones, exportable, ordre)
WHERE sc.slug = 'riz';

-- ---------- Produits CÉRÉALES > Autres céréales ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('sorgho','Sorgho','Tô kolo (Dioula)','Sorghum bicolor',
   'KG', 120.00, 200.00, ARRAY['Korhogo','Ferkessédougou','Odienné'], FALSE, 1),
  ('mil','Mil (petit mil)','Tô fitini (Dioula)','Pennisetum glaucum',
   'KG', 130.00, 220.00, ARRAY['Korhogo','Boundiali','Tengrela'], FALSE, 2)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'autres-cereales';

-- ---------- Produits FRUITS > Bananes ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, poids_unitaire_kg, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.poids_kg, p.prix_min, p.prix_max,
       p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('banane-plantain','Banane plantain','Aloko kle (Dioula) · Aloko (Baoulé)','Musa paradisiaca',
   'REGIME', 15.00, 800.00, 1500.00,
   ARRAY['San-Pédro','Abidjan','Gagnoa','Daloa','Man'], FALSE, 1),
  ('banane-douce','Banane douce','Banana (Dioula)','Musa acuminata',
   'REGIME', 12.00, 600.00, 1200.00,
   ARRAY['Abidjan','San-Pédro','Abengourou'], TRUE, 2)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, poids_kg, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'bananes';

-- ---------- Produits FRUITS > Mangues ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  est_saisonnier, saison_debut, saison_fin,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max,
       p.est_saison, p.s_debut, p.s_fin, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('mangue-amelie','Mangue Amélie','Mangoro Amelie (Dioula)','Mangifera indica var. Amélie',
   'KG', 100.00, 250.00, TRUE, 'Mars', 'Juin',
   ARRAY['Korhogo','Ferkessédougou','Bouaké','Odienné'], TRUE, 1),
  ('mangue-kent','Mangue Kent','Mangoro Kent (Dioula)','Mangifera indica var. Kent',
   'KG', 200.00, 450.00, TRUE, 'Avril', 'Juillet',
   ARRAY['Korhogo','Bouaké','Ferkessédougou'], TRUE, 2),
  ('mangue-brooks','Mangue Brooks','Mangoro Brooks (Dioula)','Mangifera indica var. Brooks',
   'KG', 150.00, 350.00, TRUE, 'Mars', 'Juin',
   ARRAY['Korhogo','Odienné','Touba'], TRUE, 3)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       est_saison, s_debut, s_fin, zones, exportable, ordre)
WHERE sc.slug = 'mangues';

-- ---------- Produits FRUITS > Ananas ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('ananas-pain-de-sucre','Ananas pain de sucre','Anani (Dioula)','Ananas comosus var. Cayenne',
   'PIECE', 300.00, 700.00,
   ARRAY['Abidjan','Grand-Bassam','Adzopé','Agboville'], TRUE, 1),
  ('ananas-cayenne-lisse','Ananas cayenne lisse','Anani cayenne (Dioula)','Ananas comosus var. Smooth Cayenne',
   'PIECE', 400.00, 900.00,
   ARRAY['Abidjan','Grand-Bassam','Adzopé'], TRUE, 2)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'ananas';

-- ---------- Produits FRUITS > Autres fruits ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('papaye','Papaye','Papaye (Dioula)','Carica papaya',
   'KG', 150.00, 300.00, ARRAY['Abidjan','San-Pédro','Abengourou'], TRUE, 1),
  ('avocat','Avocat','Avocat (Dioula)','Persea americana',
   'KG', 200.00, 500.00, ARRAY['Man','Daloa','Gagnoa','Abidjan'], FALSE, 2),
  ('noix-de-coco','Noix de coco','Koro (Dioula)','Cocos nucifera',
   'PIECE', 150.00, 400.00, ARRAY['Grand-Lahou','Jacqueville','Sassandra','Tabou'], FALSE, 3),
  ('pasteque','Pastèque','Pastèque (Dioula)','Citrullus lanatus',
   'PIECE', 500.00, 1500.00, ARRAY['Korhogo','Ferkessédougou','Bouaké'], FALSE, 4)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'autres-fruits';

-- ---------- Produits FRUITS > Agrumes ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('orange','Orange','Orange (Dioula)','Citrus sinensis',
   'KG', 200.00, 400.00, ARRAY['Abidjan','Bouaké','Man'], FALSE, 1),
  ('citron-vert','Citron vert','Citron (Dioula)','Citrus aurantifolia',
   'KG', 300.00, 600.00, ARRAY['Abidjan','Agboville','Grand-Bassam'], FALSE, 2),
  ('mandarine','Mandarine','Mandarine (Dioula)','Citrus reticulata',
   'KG', 250.00, 500.00, ARRAY['Man','Daloa','Abidjan'], FALSE, 3)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'agrumes';

-- ---------- Produits LÉGUMES > Légumes-fruits ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('tomate','Tomate','Tomati (Dioula)','Solanum lycopersicum',
   'KG', 200.00, 500.00, ARRAY['Bouaké','Korhogo','Abidjan','Daloa'], FALSE, 1),
  ('gombo-frais','Gombo frais','Gnama (Dioula) · Fétri (Baoulé)','Abelmoschus esculentus',
   'KG', 300.00, 700.00, ARRAY['Bouaké','Korhogo','Boundiali','Ferké'], FALSE, 2),
  ('aubergine-africaine','Aubergine africaine (douce)','Djagba (Dioula)','Solanum macrocarpon',
   'KG', 250.00, 500.00, ARRAY['Bouaké','Korhogo','Abidjan'], FALSE, 3),
  ('aubergine-amere-ndrowa','Aubergine amère (Ndrowa)','Ndrowa (Baoulé) · Djagba kôrô (Dioula)','Solanum aethiopicum',
   'KG', 300.00, 600.00, ARRAY['Bouaké','Gagnoa','Daloa','Abidjan'], FALSE, 4),
  ('piment-woro-woro','Piment wôrô wôrô','Wôrô wôrô (Dioula et Baoulé)','Capsicum frutescens',
   'KG', 500.00, 1500.00, ARRAY['Bouaké','Korhogo','Yamoussoukro'], FALSE, 5),
  ('piment-doux','Piment doux (poivron)','Piment gbê (Dioula)','Capsicum annuum',
   'KG', 400.00, 900.00, ARRAY['Bouaké','Abidjan','Yamoussoukro'], FALSE, 6),
  ('concombre','Concombre','Concombre (Dioula)','Cucumis sativus',
   'KG', 200.00, 500.00, ARRAY['Bouaké','Korhogo','Abidjan'], FALSE, 7),
  ('courge','Courge','Woyo (Dioula)','Cucurbita pepo',
   'KG', 150.00, 400.00, ARRAY['Bouaké','Korhogo','Ferkessédougou'], FALSE, 8),
  ('chou','Chou pommé','Chou (Dioula)','Brassica oleracea var. capitata',
   'PIECE', 300.00, 700.00, ARRAY['Abidjan','Bouaké','Man'], FALSE, 9),
  ('carotte','Carotte','Carotte (Dioula)','Daucus carota',
   'KG', 400.00, 900.00, ARRAY['Man','Bouaké','Abidjan'], FALSE, 10)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'legumes-fruits';

-- ---------- Produits LÉGUMES > Feuilles ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('feuilles-manioc','Feuilles de manioc','Barakoura foro (Dioula)','Manihot esculenta (feuilles)',
   'KG', 100.00, 250.00, ARRAY['Abidjan','Yamoussoukro','Daloa','Gagnoa'], FALSE, 1),
  ('epinard-africain','Épinard africain (Gboma)','Gboma (Dioula et Baoulé)','Solanum macrocarpon (feuilles)',
   'KG', 200.00, 450.00, ARRAY['Abidjan','Bouaké','Yamoussoukro'], FALSE, 2),
  ('ciboule-cive','Ciboule (cive)','Ciboule (Dioula)','Allium fistulosum',
   'KG', 500.00, 1200.00, ARRAY['Abidjan','Bouaké','Man'], FALSE, 3),
  ('gingembre-frais','Gingembre frais','Kankan (Dioula)','Zingiber officinale',
   'KG', 800.00, 2000.00, ARRAY['Man','Danané','Daloa'], TRUE, 4)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'legumes-feuilles';

-- ---------- Produits LÉGUMES > Racines & bulbes ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('oignon-sec','Oignon sec','Gnini (Dioula)','Allium cepa',
   'KG', 300.00, 700.00, ARRAY['Korhogo','Ferkessédougou','Bouaké'], FALSE, 1)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'legumes-racines-bulbes';

-- ---------- Produits LÉGUMINEUSES > Arachides & Soja ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, poids_unitaire_kg, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.poids_kg, p.prix_min, p.prix_max,
       p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('arachide-coques','Arachide en coques','Tiganè (Dioula) · Eguinlé (Baoulé)','Arachis hypogaea',
   'SAC', 50.00, 12000.00, 20000.00,
   ARRAY['Korhogo','Boundiali','Ferkessédougou','Bouaké'], TRUE, 1),
  ('arachide-decortiquee','Arachide décortiquée','Tiganè gnini (Dioula)','Arachis hypogaea',
   'KG', NULL, 350.00, 600.00,
   ARRAY['Korhogo','Bouaké','Ferkessédougou'], TRUE, 2),
  ('soja-grain','Soja grain sec','Soja (Dioula)','Glycine max',
   'KG', NULL, 250.00, 500.00,
   ARRAY['Bouaké','Korhogo','Yamoussoukro'], TRUE, 3)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, poids_kg, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'arachides-soja';

-- ---------- Produits LÉGUMINEUSES > Haricots & Niébé ----------
INSERT INTO produits_agricoles (
  sous_categorie_id, slug, nom, nom_local, nom_scientifique,
  unite_mesure, prix_marche_min, prix_marche_max,
  zones_production, est_exportable, sort_order
)
SELECT sc.id, p.slug, p.nom, p.nom_local, p.nom_scientifique,
       p.unite_mesure, p.prix_min, p.prix_max, p.zones, p.exportable, p.ordre
FROM sous_categories sc,
(VALUES
  ('niebe-blanc','Niébé blanc (haricot blanc)','Soumbi gbê (Dioula)','Vigna unguiculata',
   'KG', 300.00, 600.00, ARRAY['Korhogo','Ferkessédougou','Boundiali'], FALSE, 1),
  ('niebe-rouge','Niébé rouge (haricot rouge)','Soumbi kôlô (Dioula)','Vigna unguiculata',
   'KG', 350.00, 650.00, ARRAY['Korhogo','Bouaké','Ferké'], FALSE, 2),
  ('voandzou','Voandzou (pois bambara)','Voandzou (Dioula)','Vigna subterranea',
   'KG', 400.00, 800.00, ARRAY['Korhogo','Boundiali','Ferkessédougou'], FALSE, 3),
  ('haricot-vert','Haricot vert','Haricot vert (Dioula)','Phaseolus vulgaris',
   'KG', 400.00, 900.00, ARRAY['Bouaké','Man','Abidjan'], FALSE, 4)
) AS p(slug, nom, nom_local, nom_scientifique, unite_mesure, prix_min, prix_max,
       zones, exportable, ordre)
WHERE sc.slug = 'haricots-niebe';


-- =================================================================
--  5b. RÉFÉRENCES GÉOGRAPHIQUES — CÔTE D'IVOIRE
--  Tables de référence pour standardiser les noms de régions et de
--  villes. Évite les fautes d'orthographe et permet des statistiques
--  régionales propres.
--
--  Hiérarchie administrative CI (réforme 2011) :
--    14 Districts → 31 Régions + 2 Districts autonomes (Abidjan, Yamoussoukro)
--    Régions     → Départements → Sous-préfectures → Villes/Villages
-- =================================================================

CREATE TABLE regions_ci (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Code court pour les requêtes/URLs (ex: 'PORO', 'GBKE')
  code                 VARCHAR(10) UNIQUE NOT NULL,
  nom                  VARCHAR(100) UNIQUE NOT NULL,
  -- District de rattachement (14 districts en CI)
  district             VARCHAR(100) NOT NULL,
  -- Ville chef-lieu de la région
  chef_lieu            VARCHAR(100),
  -- Statut spécial pour Abidjan et Yamoussoukro
  is_district_autonome BOOLEAN NOT NULL DEFAULT FALSE,
  -- Centroïde GPS de la région (pour cartes)
  centroid             GEOGRAPHY(POINT, 4326),
  -- Données démographiques
  population           INTEGER,
  superficie_km2       DECIMAL(10,2),
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_regions_district ON regions_ci(district);

COMMENT ON TABLE regions_ci IS
  'Référence | 31 régions officielles + 2 districts autonomes de Côte d''Ivoire (réforme 2011). Source de vérité pour la géographie administrative.';


CREATE TABLE villes_ci (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  region_id    UUID NOT NULL REFERENCES regions_ci(id) ON DELETE RESTRICT,
  nom          VARCHAR(100) NOT NULL,
  -- Slug pour les URLs (ex: 'korhogo', 'san-pedro')
  slug         VARCHAR(100) UNIQUE NOT NULL,
  -- Type d'agglomération
  type         VARCHAR(20) NOT NULL DEFAULT 'VILLE',
  -- Valeurs : 'VILLE', 'VILLAGE', 'COMMUNE'
  population   INTEGER,
  location     GEOGRAPHY(POINT, 4326),
  -- Marquage des chefs-lieux de région
  is_chef_lieu BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_villes_region   ON villes_ci(region_id);
CREATE INDEX idx_villes_location ON villes_ci USING GIST(location);
CREATE UNIQUE INDEX uq_villes_nom_region ON villes_ci(LOWER(nom), region_id);

COMMENT ON TABLE villes_ci IS
  'Référence | Villes, communes et villages principaux de Côte d''Ivoire. Rattachées à une région via region_id.';


-- =================================================================
--  5c. SEED RÉFÉRENCES GÉOGRAPHIQUES
-- =================================================================

-- ---------- 33 régions/districts officiels ----------
INSERT INTO regions_ci (code, nom, district, chef_lieu, is_district_autonome) VALUES
  -- Districts autonomes
  ('ABJ',  'Abidjan',         'Abidjan',         'Abidjan',         TRUE),
  ('YAM',  'Yamoussoukro',    'Yamoussoukro',    'Yamoussoukro',    TRUE),
  -- District du Bas-Sassandra
  ('GBKL', 'Gbôklé',          'Bas-Sassandra',   'Sassandra',       FALSE),
  ('NAWA', 'Nawa',            'Bas-Sassandra',   'Soubré',          FALSE),
  ('SP',   'San-Pédro',       'Bas-Sassandra',   'San-Pédro',       FALSE),
  -- District de la Comoé
  ('INDJ', 'Indénié-Djuablin','Comoé',           'Abengourou',      FALSE),
  ('SC',   'Sud-Comoé',       'Comoé',           'Aboisso',         FALSE),
  -- District du Denguélé
  ('FOL',  'Folon',           'Denguélé',        'Minignan',        FALSE),
  ('KAB',  'Kabadougou',      'Denguélé',        'Odienné',         FALSE),
  -- District du Gôh-Djiboua
  ('GOH',  'Gôh',             'Gôh-Djiboua',     'Gagnoa',          FALSE),
  ('LD',   'Loh-Djiboua',     'Gôh-Djiboua',     'Divo',            FALSE),
  -- District des Lacs
  ('BEL',  'Bélier',          'Lacs',            'Toumodi',         FALSE),
  ('IFF',  'Iffou',           'Lacs',            'Daoukro',         FALSE),
  ('MOR',  'Moronou',         'Lacs',            'Bongouanou',      FALSE),
  ('NZI',  'N''Zi',           'Lacs',            'Dimbokro',        FALSE),
  -- District des Lagunes
  ('AGT',  'Agnéby-Tiassa',   'Lagunes',         'Agboville',       FALSE),
  ('GP',   'Grands-Ponts',    'Lagunes',         'Dabou',           FALSE),
  ('LME',  'La Mé',           'Lagunes',         'Adzopé',          FALSE),
  -- District des Montagnes
  ('CAV',  'Cavally',         'Montagnes',       'Guiglo',          FALSE),
  ('GUE',  'Guémon',          'Montagnes',       'Duékoué',         FALSE),
  ('TON',  'Tonkpi',          'Montagnes',       'Man',             FALSE),
  -- District du Sassandra-Marahoué
  ('HS',   'Haut-Sassandra',  'Sassandra-Marahoué', 'Daloa',        FALSE),
  ('MAR',  'Marahoué',        'Sassandra-Marahoué', 'Bouaflé',      FALSE),
  -- District des Savanes
  ('BAG',  'Bagoué',          'Savanes',         'Boundiali',       FALSE),
  ('POR',  'Poro',            'Savanes',         'Korhogo',         FALSE),
  ('TCH',  'Tchologo',        'Savanes',         'Ferkessédougou',  FALSE),
  -- District de la Vallée du Bandama
  ('GBE',  'Gbêkê',           'Vallée du Bandama', 'Bouaké',        FALSE),
  ('HAM',  'Hambol',          'Vallée du Bandama', 'Katiola',       FALSE),
  -- District du Woroba
  ('BAF',  'Bafing',          'Woroba',          'Touba',           FALSE),
  ('BER',  'Béré',            'Woroba',          'Mankono',         FALSE),
  ('WOR',  'Worodougou',      'Woroba',          'Séguéla',         FALSE),
  -- District du Zanzan
  ('BNK',  'Bounkani',        'Zanzan',          'Bouna',           FALSE),
  ('GTG',  'Gontougo',        'Zanzan',          'Bondoukou',       FALSE);


-- ---------- Principales villes (chef-lieux + villes citées dans le seed produits) ----------
INSERT INTO villes_ci (region_id, nom, slug, type, is_chef_lieu)
SELECT r.id, v.nom, v.slug, v.type, v.is_cl
FROM regions_ci r,
(VALUES
  -- Districts autonomes (la "ville" et la "région" ont le même nom)
  ('ABJ',  'Abidjan',         'abidjan',         'VILLE', TRUE),
  ('YAM',  'Yamoussoukro',    'yamoussoukro',    'VILLE', TRUE),
  -- Bas-Sassandra
  ('GBKL', 'Sassandra',       'sassandra',       'VILLE', TRUE),
  ('NAWA', 'Soubré',          'soubre',          'VILLE', TRUE),
  ('SP',   'San-Pédro',       'san-pedro',       'VILLE', TRUE),
  ('SP',   'Tabou',           'tabou',           'VILLE', FALSE),
  -- Comoé
  ('INDJ', 'Abengourou',      'abengourou',      'VILLE', TRUE),
  ('INDJ', 'Agnibilékrou',    'agnibilekrou',    'VILLE', FALSE),
  ('SC',   'Aboisso',         'aboisso',         'VILLE', TRUE),
  ('SC',   'Grand-Bassam',    'grand-bassam',    'VILLE', FALSE),
  -- Denguélé
  ('FOL',  'Minignan',        'minignan',        'VILLE', TRUE),
  ('KAB',  'Odienné',         'odienne',         'VILLE', TRUE),
  -- Gôh-Djiboua
  ('GOH',  'Gagnoa',          'gagnoa',          'VILLE', TRUE),
  ('LD',   'Divo',            'divo',            'VILLE', TRUE),
  -- Lacs
  ('BEL',  'Toumodi',         'toumodi',         'VILLE', TRUE),
  ('IFF',  'Daoukro',         'daoukro',         'VILLE', TRUE),
  ('MOR',  'Bongouanou',      'bongouanou',      'VILLE', TRUE),
  ('NZI',  'Dimbokro',        'dimbokro',        'VILLE', TRUE),
  -- Lagunes
  ('AGT',  'Agboville',       'agboville',       'VILLE', TRUE),
  ('GP',   'Dabou',           'dabou',           'VILLE', TRUE),
  ('GP',   'Grand-Lahou',     'grand-lahou',     'VILLE', FALSE),
  ('GP',   'Jacqueville',     'jacqueville',     'VILLE', FALSE),
  ('LME',  'Adzopé',          'adzope',          'VILLE', TRUE),
  -- Montagnes
  ('CAV',  'Guiglo',          'guiglo',          'VILLE', TRUE),
  ('GUE',  'Duékoué',         'duekoue',         'VILLE', TRUE),
  ('TON',  'Man',             'man',             'VILLE', TRUE),
  ('TON',  'Danané',          'danane',          'VILLE', FALSE),
  -- Sassandra-Marahoué
  ('HS',   'Daloa',           'daloa',           'VILLE', TRUE),
  ('MAR',  'Bouaflé',         'bouafle',         'VILLE', TRUE),
  -- Savanes
  ('BAG',  'Boundiali',       'boundiali',       'VILLE', TRUE),
  ('BAG',  'Tengréla',        'tengrela',        'VILLE', FALSE),
  ('POR',  'Korhogo',         'korhogo',         'VILLE', TRUE),
  ('TCH',  'Ferkessédougou',  'ferkessedougou',  'VILLE', TRUE),
  -- Vallée du Bandama
  ('GBE',  'Bouaké',          'bouake',          'VILLE', TRUE),
  ('HAM',  'Katiola',         'katiola',         'VILLE', TRUE),
  -- Woroba
  ('BAF',  'Touba',           'touba',           'VILLE', TRUE),
  ('BER',  'Mankono',         'mankono',         'VILLE', TRUE),
  ('WOR',  'Séguéla',         'seguela',         'VILLE', TRUE),
  -- Zanzan
  ('BNK',  'Bouna',           'bouna',           'VILLE', TRUE),
  ('GTG',  'Bondoukou',       'bondoukou',       'VILLE', TRUE)
) AS v(region_code, nom, slug, type, is_cl)
WHERE r.code = v.region_code;


-- =================================================================
--  6. DOMAINE AUTH & UTILISATEURS
-- =================================================================

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           VARCHAR(20) UNIQUE NOT NULL,
  email           VARCHAR(150) UNIQUE,
  role            user_role NOT NULL DEFAULT 'FARMER',
  full_name       VARCHAR(150) NOT NULL,
  photo_url       TEXT,
  is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Sécurité : compteur de tentatives PIN ratées + lock temporaire après seuil
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMP WITH TIME ZONE,
  last_login      TIMESTAMP WITH TIME ZONE,
  rating          DECIMAL(3,2) NOT NULL DEFAULT 0.00,
  rating_count    INTEGER NOT NULL DEFAULT 0,
  location        GEOGRAPHY(POINT, 4326),
  wallet_balance  DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  pin_hash        VARCHAR(255),
  langue          VARCHAR(10) NOT NULL DEFAULT 'fr',
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_locked_until ON users(locked_until) WHERE locked_until IS NOT NULL;
CREATE INDEX idx_users_location ON users USING GIST(location);

CREATE TABLE producteur_profiles (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Localisation administrative (FK propres au lieu de texte libre)
  region_id            UUID REFERENCES regions_ci(id),
  ville_id             UUID REFERENCES villes_ci(id),
  -- Nom de village libre si le village n'est pas dans villes_ci
  -- (beaucoup de petits villages agricoles ne sont pas dans la base officielle)
  village_libre        VARCHAR(100),
  superficie_ha        DECIMAL(10,2),
  nb_annees_exp        INTEGER,
  cultures_principales TEXT[],
  est_membre_coop      BOOLEAN DEFAULT FALSE,
  coop_id              UUID,  -- FK ajoutée plus bas (cooperative_profiles pas encore créé)
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);
CREATE INDEX idx_producteur_region ON producteur_profiles(region_id);
CREATE INDEX idx_producteur_ville  ON producteur_profiles(ville_id);

CREATE TABLE acheteur_profiles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name      VARCHAR(200),
  numero_rccm       VARCHAR(100),
  capacite_achat_kg DECIMAL(12,2),
  zones_achat       TEXT[],
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE cooperative_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nom             VARCHAR(200) NOT NULL,
  numero_agrement VARCHAR(100),
  -- Localisation administrative (FK propres)
  region_id       UUID REFERENCES regions_ci(id),
  ville_id        UUID REFERENCES villes_ci(id),
  -- Siège GPS de la coopérative (souvent un bureau dans une ville)
  location        GEOGRAPHY(POINT, 4326),
  nb_membres      INTEGER DEFAULT 0,
  produits        TEXT[],
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);
CREATE INDEX idx_coop_region ON cooperative_profiles(region_id);
CREATE INDEX idx_coop_ville  ON cooperative_profiles(ville_id);

CREATE TABLE cooperative_members (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  member_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_coop   VARCHAR(50) DEFAULT 'MEMBER',
  date_adhesion  DATE,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(cooperative_id, member_id)
);
CREATE INDEX idx_coop_members_coop   ON cooperative_members(cooperative_id);
CREATE INDEX idx_coop_members_member ON cooperative_members(member_id);

CREATE TABLE user_documents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type         VARCHAR(50) NOT NULL,
  doc_url          TEXT NOT NULL,
  status           kyc_status NOT NULL DEFAULT 'PENDING',
  rejection_reason TEXT,
  verified_by      UUID,
  verified_at      TIMESTAMP WITH TIME ZONE,
  expires_at       DATE,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE otps (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone      VARCHAR(20) NOT NULL,
  code_hash  VARCHAR(255) NOT NULL,
  purpose    VARCHAR(50) NOT NULL,
  is_used    BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_otps_phone ON otps(phone, purpose) WHERE is_used = FALSE;

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) UNIQUE NOT NULL,
  device_info TEXT,
  ip_address  INET,
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at  TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE device_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token  TEXT NOT NULL,
  platform   VARCHAR(10) NOT NULL,
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, fcm_token)
);

CREATE TABLE user_login_history (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address     INET,
  device_info    TEXT,
  success        BOOLEAN NOT NULL,
  failure_reason VARCHAR(100),
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);


-- =================================================================
--  7. DOMAINE MARKETPLACE
-- =================================================================

CREATE TABLE user_cultures (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  produit_id    UUID REFERENCES produits_agricoles(id),
  superficie_ha DECIMAL(8,2),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE parcelle (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nom           VARCHAR(100),
  contour       GEOGRAPHY(POLYGON, 4326),
  centroid      GEOGRAPHY(POINT, 4326),
  superficie_ha DECIMAL(8,2),
  produit_id    UUID REFERENCES produits_agricoles(id),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_parcelle_centroid ON parcelle USING GIST(centroid);

CREATE TABLE annonces_vente (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  produit_id      UUID REFERENCES produits_agricoles(id),
  qualite         product_quality NOT NULL DEFAULT 'STANDARD',
  titre           VARCHAR(200) NOT NULL,
  description     TEXT,
  quantite_kg     DECIMAL(10,2) NOT NULL,
  prix_par_kg     DECIMAL(10,2) NOT NULL,
  quantite_min_kg DECIMAL(10,2) NOT NULL DEFAULT 100,
  certifications  TEXT[],
  traceability_id VARCHAR(30) UNIQUE,
  -- LOCALISATION : 3 niveaux complémentaires
  -- 1. GPS précis (pour calculs de distance, carte, transport)
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  -- 2. Région administrative (pour filtres "produits dans ma région")
  region_id       UUID REFERENCES regions_ci(id),
  -- 3. Ville/village (pour filtres "produits près de Korhogo")
  ville_id        UUID REFERENCES villes_ci(id),
  -- Adresse libre complémentaire (quartier, point de repère)
  -- Ex: "Quartier Soba, à côté de l'école"
  adresse_detail  VARCHAR(200),
  disponible_jusqu DATE,
  status          product_status NOT NULL DEFAULT 'DRAFT',
  views_count     INTEGER NOT NULL DEFAULT 0,
  contacts_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_annonces_location       ON annonces_vente USING GIST(location);
CREATE INDEX idx_annonces_region         ON annonces_vente(region_id);
CREATE INDEX idx_annonces_ville          ON annonces_vente(ville_id);
CREATE INDEX idx_annonces_produit_status ON annonces_vente(produit_id, status) WHERE status = 'ACTIVE';
CREATE INDEX idx_annonces_farmer         ON annonces_vente(farmer_id);

-- Table polymorphique : peut attacher des photos/vidéos à n'importe quelle source
-- (annonce vente individuelle, publication coopérative, ou lot de traçabilité)
CREATE TABLE medias (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Source du média - EXACTEMENT UN des trois liens doit être rempli
  annonce_vente_id    UUID REFERENCES annonces_vente(id) ON DELETE CASCADE,
  publication_coop_id UUID,  -- FK ajoutée plus bas (publications_stock_coop pas encore créée)
  lot_id              UUID,  -- FK ajoutée plus bas (lots pas encore créés)
  media_type          VARCHAR(10) NOT NULL,  -- 'photo' ou 'video'
  url                 TEXT NOT NULL,
  thumbnail_url       TEXT,
  sort_order          INTEGER DEFAULT 0,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Garantit qu'exactement UN seul lien d'origine est rempli
  CONSTRAINT chk_media_source CHECK (
    (annonce_vente_id IS NOT NULL)::int +
    (publication_coop_id IS NOT NULL)::int +
    (lot_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX idx_medias_annonce_vente    ON medias(annonce_vente_id)    WHERE annonce_vente_id IS NOT NULL;
CREATE INDEX idx_medias_publication_coop ON medias(publication_coop_id) WHERE publication_coop_id IS NOT NULL;
CREATE INDEX idx_medias_lot              ON medias(lot_id)              WHERE lot_id IS NOT NULL;

COMMENT ON TABLE medias IS
  'Domaine: MARKETPLACE | Photos/vidéos polymorphiques attachées à une annonce vente, publication coop, ou lot.';

CREATE TABLE annonces_achat (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  produit_id      UUID REFERENCES produits_agricoles(id),
  qualite         product_quality,
  quantite_kg     DECIMAL(10,2) NOT NULL,
  prix_max_kg     DECIMAL(10,2),
  -- LOCALISATION DE LIVRAISON souhaitée (où l'acheteur veut recevoir)
  location        GEOGRAPHY(POINT, 4326),
  region_id       UUID REFERENCES regions_ci(id),
  ville_id        UUID REFERENCES villes_ci(id),
  adresse_detail  VARCHAR(200),
  -- Rayon de recherche autour du point pour matcher les vendeurs
  rayon_km        INTEGER DEFAULT 100,
  date_besoin     DATE,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_annonces_achat_buyer    ON annonces_achat(buyer_id);
CREATE INDEX idx_annonces_achat_location ON annonces_achat USING GIST(location);
CREATE INDEX idx_annonces_achat_region   ON annonces_achat(region_id);
CREATE INDEX idx_annonces_achat_ville    ON annonces_achat(ville_id);

CREATE TABLE publications_stock_coop (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  produit_id     UUID REFERENCES produits_agricoles(id),
  quantite_kg    DECIMAL(12,2) NOT NULL,
  prix_par_kg    DECIMAL(10,2),
  qualite        product_quality DEFAULT 'STANDARD',
  -- LOCALISATION du stock disponible (où vient chercher l'acheteur)
  location       GEOGRAPHY(POINT, 4326),
  region_id      UUID REFERENCES regions_ci(id),
  ville_id       UUID REFERENCES villes_ci(id),
  adresse_detail VARCHAR(200),
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_publications_coop_cooperative ON publications_stock_coop(cooperative_id);
CREATE INDEX idx_publications_coop_region      ON publications_stock_coop(region_id);
CREATE INDEX idx_publications_coop_ville       ON publications_stock_coop(ville_id);
CREATE INDEX idx_publications_coop_location    ON publications_stock_coop USING GIST(location);

CREATE TABLE lots (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lot_code       VARCHAR(30) UNIQUE NOT NULL,
  -- Type de lot : 'INDIVIDUAL' (1 producteur) ou 'AGGREGATED' (coopérative)
  type           VARCHAR(15) NOT NULL DEFAULT 'INDIVIDUAL',
  -- Origine du lot — UN seul des deux doit être rempli (CHECK ci-dessous) :
  --   farmer_id      : lot individuel d'un producteur
  --   cooperative_id : lot agrégé créé par une coopérative
  farmer_id      UUID REFERENCES users(id),
  cooperative_id UUID REFERENCES cooperative_profiles(id),
  -- Annonce ou publication source (optionnel)
  annonce_id     UUID,  -- si lot individuel publié via annonces_vente
  publication_id UUID REFERENCES publications_stock_coop(id),  -- si lot coop
  -- Caractéristiques du lot
  produit_id     UUID REFERENCES produits_agricoles(id),
  quantite_kg    DECIMAL(10,2) NOT NULL,
  qualite        product_quality,
  date_recolte   DATE,
  farm_location  GEOGRAPHY(POINT, 4326),
  -- Traçabilité blockchain
  blockchain_tx  VARCHAR(255),
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Garantit qu'un lot a soit un farmer, soit une coopérative (jamais les deux à NULL)
  CONSTRAINT chk_lot_origine CHECK (
    (farmer_id IS NOT NULL AND cooperative_id IS NULL)
    OR
    (farmer_id IS NULL AND cooperative_id IS NOT NULL)
  ),
  -- Garantit que le type correspond à l'origine
  CONSTRAINT chk_lot_type CHECK (
    (type = 'INDIVIDUAL' AND farmer_id IS NOT NULL)
    OR
    (type = 'AGGREGATED' AND cooperative_id IS NOT NULL)
  )
);
CREATE INDEX idx_lots_farmer      ON lots(farmer_id)      WHERE farmer_id IS NOT NULL;
CREATE INDEX idx_lots_cooperative ON lots(cooperative_id) WHERE cooperative_id IS NOT NULL;
CREATE INDEX idx_lots_produit     ON lots(produit_id);

COMMENT ON TABLE lots IS
  'Domaine: MARKETPLACE | Lot de produit avec QR Code et traçabilité blockchain. Peut être individuel (1 producteur) ou agrégé (coopérative regroupant plusieurs membres).';
COMMENT ON COLUMN lots.type IS
  'INDIVIDUAL = lot d''un seul producteur · AGGREGATED = lot coop avec plusieurs contributions (voir lot_contributions)';

-- -----------------------------------------------------------------
--  TABLE : lot_contributions
--  Détail des contributions individuelles à un lot AGRÉGÉ (coop).
--  Ex : Lot CAC-2025-08472 (1500kg) = 500kg Koffi + 400kg Aya + 600kg Issa
--  Pour les lots INDIVIDUAL, cette table reste vide.
-- -----------------------------------------------------------------
CREATE TABLE lot_contributions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Lot agrégé concerné
  lot_id              UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  -- Qui contribue ?
  farmer_id           UUID NOT NULL REFERENCES users(id),
  -- D'où vient sa contribution ?
  annonce_id          UUID,  -- annonce source du producteur (si existante)
  -- Combien apporte-t-il et à quel prix la coopérative lui paie ?
  quantite_kg         DECIMAL(10,2) NOT NULL,
  prix_achat_coop_kg  DECIMAL(10,2),  -- prix payé par la coop au producteur
  -- Qualité spécifique de cette contribution (peut différer du lot global)
  qualite             product_quality,
  date_collecte       DATE,
  -- Position GPS de la ferme d'origine (pour traçabilité fine)
  farm_location       GEOGRAPHY(POINT, 4326),
  notes               TEXT,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Un producteur ne peut contribuer qu'une fois par lot (sinon plusieurs lignes pour additionner)
  UNIQUE(lot_id, farmer_id, annonce_id)
);
CREATE INDEX idx_lot_contributions_lot    ON lot_contributions(lot_id);
CREATE INDEX idx_lot_contributions_farmer ON lot_contributions(farmer_id);

COMMENT ON TABLE lot_contributions IS
  'Domaine: MARKETPLACE | Détail des contributions des producteurs à un lot AGRÉGÉ. Permet la traçabilité fine pour l''export et le paiement individuel des membres.';

CREATE TABLE entrepots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Propriétaire de l'entrepôt : peut être N'IMPORTE QUEL user
  --   - Un producteur individuel (role = FARMER)
  --   - Un acheteur / grossiste (role = BUYER)
  --   - Une coopérative (role = COOPERATIVE)
  --   - Un transporteur qui loue du stockage (role = TRANSPORTER)
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nom             VARCHAR(200) NOT NULL,
  -- LOCALISATION
  location        GEOGRAPHY(POINT, 4326),
  region_id       UUID REFERENCES regions_ci(id),
  ville_id        UUID REFERENCES villes_ci(id),
  adresse         TEXT,  -- adresse postale complète
  capacite_kg     DECIMAL(12,2),
  is_refrigere    BOOLEAN DEFAULT FALSE,
  temperature_min DECIMAL(5,2),
  temperature_max DECIMAL(5,2),
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_entrepots_owner    ON entrepots(owner_id);
CREATE INDEX idx_entrepots_region   ON entrepots(region_id);
CREATE INDEX idx_entrepots_ville    ON entrepots(ville_id);
CREATE INDEX idx_entrepots_location ON entrepots USING GIST(location);
COMMENT ON COLUMN entrepots.owner_id
  IS 'Référence users.id — n''importe quel rôle peut posséder un entrepôt';

CREATE TABLE stock (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entrepot_id         UUID NOT NULL REFERENCES entrepots(id),
  -- Origine du stock — UN SEUL des trois liens suivants est rempli :
  --   lot_id              : stock issu d'un lot de traçabilité (universel)
  --   annonce_id          : stock rattaché à une annonce INDIVIDUELLE de vente
  --   publication_coop_id : stock rattaché à une publication de COOPÉRATIVE
  lot_id              UUID REFERENCES lots(id) ON DELETE SET NULL,
  annonce_id          UUID REFERENCES annonces_vente(id) ON DELETE SET NULL,
  publication_coop_id UUID REFERENCES publications_stock_coop(id) ON DELETE SET NULL,
  quantite_kg         DECIMAL(10,2) NOT NULL,
  date_entree         DATE,
  date_sortie_prev    DATE,
  notes               TEXT,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stock_entrepot    ON stock(entrepot_id);
CREATE INDEX idx_stock_annonce     ON stock(annonce_id)          WHERE annonce_id IS NOT NULL;
CREATE INDEX idx_stock_publication ON stock(publication_coop_id) WHERE publication_coop_id IS NOT NULL;
CREATE INDEX idx_stock_lot         ON stock(lot_id)              WHERE lot_id IS NOT NULL;
COMMENT ON TABLE stock
  IS 'Inventaire physique dans un entrepôt. Origine : lot, annonce individuelle, ou publication coop.';

CREATE TABLE favoris (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  annonce_id UUID NOT NULL REFERENCES annonces_vente(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, annonce_id)
);

CREATE TABLE avis (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reviewer_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewed_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context_type     VARCHAR(30) NOT NULL,  -- 'VENTE', 'TRANSPORT', 'COOP'
  context_id       UUID,                  -- FK générique, vérifiée côté appli
  note             INTEGER NOT NULL CHECK (note BETWEEN 1 AND 5),
  commentaire      TEXT,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_avis_reviewed ON avis(reviewed_user_id);

CREATE TABLE panier (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE panier_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  panier_id     UUID NOT NULL REFERENCES panier(id) ON DELETE CASCADE,
  annonce_id    UUID NOT NULL REFERENCES annonces_vente(id) ON DELETE CASCADE,
  quantite_kg   DECIMAL(10,2) NOT NULL,
  prix_unitaire DECIMAL(10,2) NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);


-- =================================================================
--  8. DOMAINE NÉGOCIATION
-- =================================================================

CREATE TABLE candidatures_achat (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  annonce_id      UUID NOT NULL REFERENCES annonces_vente(id) ON DELETE CASCADE,
  buyer_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantite_kg     DECIMAL(10,2) NOT NULL,
  prix_propose_kg DECIMAL(10,2),
  message         TEXT,
  status          VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_candidatures_annonce ON candidatures_achat(annonce_id);
CREATE INDEX idx_candidatures_buyer ON candidatures_achat(buyer_id);

CREATE TABLE candidature_traitements (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidature_id    UUID NOT NULL REFERENCES candidatures_achat(id) ON DELETE CASCADE,
  acteur_id         UUID NOT NULL REFERENCES users(id),
  action            VARCHAR(50) NOT NULL,
  prix_contre_offre DECIMAL(10,2),
  quantite_kg       DECIMAL(10,2),
  note              TEXT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE contre_offres_coop (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publication_id  UUID NOT NULL REFERENCES publications_stock_coop(id) ON DELETE CASCADE,
  acheteur_id     UUID NOT NULL REFERENCES users(id),
  cooperative_id  UUID NOT NULL REFERENCES cooperative_profiles(id),
  prix_propose_kg DECIMAL(10,2) NOT NULL,
  quantite_kg     DECIMAL(10,2) NOT NULL,
  message         TEXT,
  status          VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  -- Valeurs : PENDING, ACCEPTED, REJECTED, COUNTERED, NEGOTIATING, FINALIZED
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contre_offres_coop_pub      ON contre_offres_coop(publication_id);
CREATE INDEX idx_contre_offres_coop_acheteur ON contre_offres_coop(acheteur_id);
CREATE INDEX idx_contre_offres_coop_coop     ON contre_offres_coop(cooperative_id);

-- -----------------------------------------------------------------
--  TABLE : contre_offre_coop_traitements
--  Historique des actions de négociation entre l'acheteur et la
--  coopérative sur une contre-offre. Symétrique à candidature_traitements
--  et proposition_traitements.
--
--  Permet de retracer chaque étape : "L'acheteur a proposé 750,
--  la coop a contre-proposé 800, l'acheteur a accepté."
-- -----------------------------------------------------------------
CREATE TABLE contre_offre_coop_traitements (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contre_offre_id   UUID NOT NULL REFERENCES contre_offres_coop(id) ON DELETE CASCADE,
  -- Qui a fait l'action (acheteur ou représentant coop) ?
  acteur_id         UUID NOT NULL REFERENCES users(id),
  -- Action effectuée
  action            VARCHAR(50) NOT NULL,
  -- Valeurs : ACCEPT, REJECT, COUNTER_OFFER, MESSAGE, FINALIZE
  -- Si contre-offre : nouveaux paramètres proposés
  prix_contre_offre DECIMAL(10,2),
  quantite_kg       DECIMAL(10,2),
  note              TEXT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contre_offre_coop_traitements_co
  ON contre_offre_coop_traitements(contre_offre_id);

COMMENT ON TABLE contre_offre_coop_traitements IS
  'Domaine: NÉGOCIATION | Historique pas à pas des contre-offres entre acheteur et coop sur publications_stock_coop.';

-- -----------------------------------------------------------------
--  TABLE : propositions_vente
--  Flux INVERSE : un VENDEUR (producteur OU coopérative) répond à
--  une annonce d'achat publiée par un acheteur.
--
--  Exemple : Acheteur publie "Je cherche 5T cacao bio à 800 FCFA/kg"
--            → Coopérative Yamoussoukro propose "2T à 850 FCFA/kg"
--            → Producteur Koffi propose "500kg à 820 FCFA/kg"
--  L'acheteur voit toutes les propositions et peut accepter, refuser,
--  ou faire une contre-offre.
-- -----------------------------------------------------------------
CREATE TABLE propositions_vente (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Sur quelle annonce d'achat porte cette proposition ?
  annonce_achat_id UUID NOT NULL REFERENCES annonces_achat(id) ON DELETE CASCADE,
  -- Qui propose ? Peut être un producteur OU une coopérative
  -- (les coops sont aussi dans users avec role='COOPERATIVE')
  vendeur_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Origine de l'offre (UN seul des deux est rempli) :
  --   annonce_vente_id      : producteur propose une de ses annonces existantes
  --   publication_coop_id   : coopérative propose son stock collectif
  --   (les deux NULL = proposition ad-hoc créée pour cette demande)
  annonce_vente_id    UUID REFERENCES annonces_vente(id) ON DELETE SET NULL,
  publication_coop_id UUID REFERENCES publications_stock_coop(id) ON DELETE SET NULL,
  -- Ce que le vendeur propose
  quantite_kg     DECIMAL(10,2) NOT NULL,
  prix_propose_kg DECIMAL(10,2) NOT NULL,
  qualite         product_quality DEFAULT 'STANDARD',
  -- Conditions complémentaires
  delai_livraison_j  INTEGER,        -- en combien de jours peut livrer
  lieu_livraison     VARCHAR(200),
  message            TEXT,
  -- État de la proposition
  status          VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  -- Valeurs : PENDING, ACCEPTED, REJECTED, COUNTERED, NEGOTIATING, FINALIZED
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_propositions_annonce ON propositions_vente(annonce_achat_id);
CREATE INDEX idx_propositions_vendeur ON propositions_vente(vendeur_id);
CREATE INDEX idx_propositions_status  ON propositions_vente(status);

COMMENT ON TABLE propositions_vente IS
  'Domaine: NÉGOCIATION | Producteur ou coop répond à une annonce d''achat. Flux inverse de candidatures_achat.';

-- -----------------------------------------------------------------
--  TABLE : proposition_traitements
--  Historique de négociation sur une proposition.
--  Symétrique à candidature_traitements mais pour le flux inverse.
-- -----------------------------------------------------------------
CREATE TABLE proposition_traitements (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  proposition_id    UUID NOT NULL REFERENCES propositions_vente(id) ON DELETE CASCADE,
  -- Qui a fait l'action (acheteur ou vendeur) ?
  acteur_id         UUID NOT NULL REFERENCES users(id),
  -- Action effectuée
  action            VARCHAR(50) NOT NULL,
  -- Valeurs : ACCEPT, REJECT, COUNTER_OFFER, MESSAGE, FINALIZE
  -- Si contre-offre : nouveaux paramètres proposés
  prix_contre_offre DECIMAL(10,2),
  quantite_kg       DECIMAL(10,2),
  note              TEXT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_proposition_traitements_prop ON proposition_traitements(proposition_id);

CREATE TABLE previsions_production (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  produit_id        UUID REFERENCES produits_agricoles(id),
  parcelle_id       UUID REFERENCES parcelle(id),
  saison            VARCHAR(20),
  quantite_prev_kg  DECIMAL(10,2),
  date_recolte_prev DATE,
  prix_cible_kg     DECIMAL(10,2),
  notes             TEXT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE reservations_previsions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prevision_id    UUID NOT NULL REFERENCES previsions_production(id) ON DELETE CASCADE,
  acheteur_id     UUID NOT NULL REFERENCES users(id),
  quantite_kg     DECIMAL(10,2) NOT NULL,
  prix_reserve_kg DECIMAL(10,2),
  status          VARCHAR(30) DEFAULT 'PENDING',
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);


-- =================================================================
--  9. DOMAINE COMMANDES
-- =================================================================

CREATE TABLE commandes_vente (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference           VARCHAR(30) UNIQUE NOT NULL,
  -- Acheteur et vendeur (le vendeur peut être un user FARMER ou COOPERATIVE)
  buyer_id            UUID NOT NULL REFERENCES users(id),
  seller_id           UUID NOT NULL REFERENCES users(id),
  -- Source de la commande - exactement UN des trois doit être rempli
  annonce_id          UUID REFERENCES annonces_vente(id),
  publication_coop_id UUID REFERENCES publications_stock_coop(id),
  lot_id              UUID REFERENCES lots(id),
  quantite_kg         DECIMAL(10,2) NOT NULL,
  prix_unitaire_kg    DECIMAL(10,2) NOT NULL,
  montant_total       DECIMAL(15,2) NOT NULL,
  frais_service       DECIMAL(10,2) NOT NULL DEFAULT 0,
  montant_net         DECIMAL(15,2) NOT NULL,
  status              order_status NOT NULL DEFAULT 'SENT',
  payment_provider    mobile_provider,
  escrow_released     BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_address    TEXT,
  delivery_location   GEOGRAPHY(POINT, 4326),
  notes               TEXT,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Garantit qu'on sait d'où vient la commande
  CONSTRAINT chk_commande_source CHECK (
    (annonce_id IS NOT NULL)::int +
    (publication_coop_id IS NOT NULL)::int +
    (lot_id IS NOT NULL)::int >= 1
  )
);
CREATE INDEX idx_commandes_buyer  ON commandes_vente(buyer_id);
CREATE INDEX idx_commandes_seller ON commandes_vente(seller_id);
CREATE INDEX idx_commandes_status ON commandes_vente(status);

CREATE TABLE disputes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  commande_id  UUID NOT NULL REFERENCES commandes_vente(id) ON DELETE CASCADE,
  opened_by    UUID NOT NULL REFERENCES users(id),
  raison       TEXT NOT NULL,
  preuves_urls TEXT[],
  status       VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  resolution   TEXT,
  resolved_by  UUID REFERENCES users(id),
  resolved_at  TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_disputes_commande ON disputes(commande_id);

CREATE TABLE offres_marche_b2b (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exporter_id      UUID NOT NULL REFERENCES users(id),
  produit_id       UUID REFERENCES produits_agricoles(id),
  quantite_kg      DECIMAL(12,2) NOT NULL,
  prix_kg_usd      DECIMAL(10,4),
  incoterm         VARCHAR(10),
  port_chargement  VARCHAR(100),
  port_destination VARCHAR(100),
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE commande_b2b (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  offre_id         UUID REFERENCES offres_marche_b2b(id),
  exporter_id      UUID NOT NULL REFERENCES users(id),
  supplier_id      UUID NOT NULL REFERENCES users(id),  -- coop ou producteur
  produit_id       UUID REFERENCES produits_agricoles(id),
  lot_id           UUID REFERENCES lots(id),  -- lot exporté (souvent agrégé coop)
  quantite_kg      DECIMAL(12,2) NOT NULL,
  incoterm         VARCHAR(10),
  port_chargement  VARCHAR(100),
  port_destination VARCHAR(100),
  compagnie        VARCHAR(100),
  tracking_number  VARCHAR(100),
  montant_usd      DECIMAL(15,2),
  status           VARCHAR(30) DEFAULT 'PENDING',
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE export_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  commande_b2b_id UUID NOT NULL REFERENCES commande_b2b(id) ON DELETE CASCADE,
  doc_type        VARCHAR(50) NOT NULL,
  url             TEXT NOT NULL,
  is_validated    BOOLEAN DEFAULT FALSE,
  issued_at       DATE,
  expires_at      DATE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE contrats_vente_coop (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  acheteur_id    UUID NOT NULL REFERENCES users(id),
  produit_id     UUID REFERENCES produits_agricoles(id),
  quantite_kg    DECIMAL(12,2) NOT NULL,
  prix_kg        DECIMAL(10,2) NOT NULL,
  date_debut     DATE,
  date_fin       DATE,
  status         VARCHAR(30) DEFAULT 'ACTIVE',
  doc_url        TEXT,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contrats_coop_coop ON contrats_vente_coop(cooperative_id);


-- =================================================================
--  10. DOMAINE FINANCE
-- =================================================================

CREATE TABLE wallets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency       VARCHAR(5) NOT NULL DEFAULT 'XOF',
  balance        DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  balance_escrow DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  is_frozen      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, currency)
);

CREATE TABLE moyen_de_payement (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      mobile_provider NOT NULL,
  phone_display VARCHAR(30),
  token         TEXT,
  is_default    BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id),
  commande_id   UUID REFERENCES commandes_vente(id),
  type          VARCHAR(30) NOT NULL,
  montant       DECIMAL(15,2) NOT NULL,
  balance_avant DECIMAL(15,2) NOT NULL,
  balance_apres DECIMAL(15,2) NOT NULL,
  provider      mobile_provider,
  provider_ref  VARCHAR(200),
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  description   TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transactions_user     ON transactions(user_id);
CREATE INDEX idx_transactions_commande ON transactions(commande_id);
CREATE INDEX idx_transactions_date     ON transactions(created_at DESC);

CREATE TABLE escrow_conditions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  commande_id     UUID NOT NULL REFERENCES commandes_vente(id) ON DELETE CASCADE,
  -- Type d'escrow : 'PRODUCT' (versé au seller) ou 'TRANSPORT' (versé au transporter)
  kind            VARCHAR(20) NOT NULL DEFAULT 'PRODUCT',
  -- Bénéficiaire à qui les fonds reviendront à la libération
  -- (peuplé à l'acceptation de la mission pour TRANSPORT)
  beneficiary_id  UUID REFERENCES users(id),
  montant         DECIMAL(15,2) NOT NULL,
  -- Commission plateforme prélevée à la libération
  frais_service   DECIMAL(10,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'LOCKED',
  condition       TEXT,
  locked_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  released_at     TIMESTAMP WITH TIME ZONE,
  released_by     UUID REFERENCES users(id),
  release_reason  TEXT
);
CREATE INDEX idx_escrow_commande_kind ON escrow_conditions(commande_id, kind);
CREATE INDEX idx_escrow_beneficiary   ON escrow_conditions(beneficiary_id) WHERE beneficiary_id IS NOT NULL;

CREATE TABLE payout_batches (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiator_id UUID NOT NULL REFERENCES users(id),
  total_amount DECIMAL(15,2) NOT NULL,
  nb_items     INTEGER NOT NULL,
  status       VARCHAR(20) DEFAULT 'PENDING',
  executed_at  TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE payout_items (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id            UUID NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  -- Bénéficiaire du versement
  user_id             UUID NOT NULL REFERENCES users(id),
  -- Commande source du versement
  commande_id         UUID REFERENCES commandes_vente(id),
  -- Si versement issu d'une vente coop, lien vers la contribution exacte
  -- Permet de tracer : "Koffi reçoit 50 000 FCFA pour ses 500kg du lot CAC-XXX"
  lot_contribution_id UUID REFERENCES lot_contributions(id),
  amount              DECIMAL(15,2) NOT NULL,
  provider            mobile_provider,
  provider_ref        VARCHAR(200),
  status              VARCHAR(20) DEFAULT 'PENDING',
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payout_items_user        ON payout_items(user_id);
CREATE INDEX idx_payout_items_commande    ON payout_items(commande_id);
CREATE INDEX idx_payout_items_contribution ON payout_items(lot_contribution_id)
  WHERE lot_contribution_id IS NOT NULL;

CREATE TABLE annonces_prefinancement (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  montant_demande DECIMAL(15,2) NOT NULL,
  objet           TEXT,
  produit_id      UUID REFERENCES produits_agricoles(id),  -- ex: cacao, ananas
  credit_score    DECIMAL(5,2),
  statut          VARCHAR(30) DEFAULT 'PENDING',
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE candidatures_prefinancement (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  annonce_id   UUID NOT NULL REFERENCES annonces_prefinancement(id) ON DELETE CASCADE,
  financeur_id UUID NOT NULL REFERENCES users(id),
  montant      DECIMAL(15,2) NOT NULL,
  taux_interet DECIMAL(5,2),
  duree_mois   INTEGER,
  status       VARCHAR(30) DEFAULT 'PENDING',
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);


-- =================================================================
--  11. DOMAINE LOGISTIQUE
-- =================================================================

CREATE TABLE shipments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  commande_id       UUID NOT NULL REFERENCES commandes_vente(id) ON DELETE CASCADE,
  transporter_id    UUID REFERENCES users(id),
  -- Zones figées à la création (utilisées pour le matching transporter_routes)
  origin_zone       VARCHAR(100),
  destination_zone  VARCHAR(100),
  quantite_kg       DECIMAL(10,2),
  vehicle_type      VARCHAR(30),
  pickup_location   GEOGRAPHY(POINT, 4326),
  delivery_location GEOGRAPHY(POINT, 4326),
  pickup_address    TEXT,
  delivery_address  TEXT NOT NULL,
  scheduled_at      TIMESTAMP WITH TIME ZONE,
  prix_devis        DECIMAL(10,2),
  prix_final        DECIMAL(10,2),
  status            shipment_status NOT NULL DEFAULT 'REQUESTED',
  photo_preuve_url  TEXT,
  notes             TEXT,
  delivered_at      TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_shipments_commande    ON shipments(commande_id);
CREATE INDEX idx_shipments_transporter ON shipments(transporter_id);
-- Pour matcher rapidement les missions ouvertes avec les transporteurs des zones
CREATE INDEX idx_shipments_zones ON shipments(origin_zone, destination_zone)
  WHERE status = 'REQUESTED' AND transporter_id IS NULL;

CREATE TABLE shipment_tracking (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  status      shipment_status,
  note        TEXT,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tracking_shipment ON shipment_tracking(shipment_id, created_at DESC);

-- =================================================================
--  ROUTES TRANSPORTEURS (tarifs déclarés par chaque transporteur)
-- =================================================================
-- Chaque transporteur déclare les paires origine→destination qu'il dessert
-- avec son propre tarif. Au moment d'une commande, le système trouve toutes
-- les routes correspondantes et affiche au buyer le tarif le plus bas (ou
-- une liste de plusieurs offres).
--
-- Calcul du prix d'une mission de N kg :
--   prix = MAX(tarif_minimum, tarif_kg × N)
-- Si N > capacite_max_kg, la route n'est pas éligible.
CREATE TABLE transporter_routes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transporter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_zone      VARCHAR(100) NOT NULL,
  destination_zone VARCHAR(100) NOT NULL,
  tarif_kg         DECIMAL(8,2) NOT NULL,
  tarif_minimum    DECIMAL(10,2) NOT NULL DEFAULT 0,
  capacite_max_kg  DECIMAL(10,2) NOT NULL,
  delai_typique    VARCHAR(50),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(transporter_id, origin_zone, destination_zone)
);
CREATE INDEX idx_transporter_routes_zones  ON transporter_routes(origin_zone, destination_zone) WHERE is_active = TRUE;
CREATE INDEX idx_transporter_routes_owner  ON transporter_routes(transporter_id);


-- =================================================================
--  12. DOMAINE MESSAGERIE
-- =================================================================

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type            VARCHAR(20) NOT NULL DEFAULT 'DIRECT',
  titre           VARCHAR(200),
  is_ai_session   BOOLEAN NOT NULL DEFAULT FALSE,
  ai_context      JSONB,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE conversation_participants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, user_id)
);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID REFERENCES users(id),  -- NULL pour messages IA
  role            VARCHAR(15) NOT NULL DEFAULT 'user',
  content         TEXT NOT NULL,
  media_url       TEXT,
  media_type      VARCHAR(20),
  metadata        JSONB,
  status          VARCHAR(20) DEFAULT 'SENT',
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  titre      VARCHAR(200) NOT NULL,
  body       TEXT NOT NULL,
  data       JSONB,
  is_read    BOOLEAN DEFAULT FALSE,
  sent_at    TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifs_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;


-- =================================================================
--  13. DOMAINE INTELLIGENCE ARTIFICIELLE
-- =================================================================

CREATE TABLE plant_analyses (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parcelle_id      UUID REFERENCES parcelle(id),
  produit_id       UUID REFERENCES produits_agricoles(id),
  image_url        TEXT NOT NULL,
  disease_detected VARCHAR(100),
  risk_level       VARCHAR(10),
  confidence_score DECIMAL(4,3),
  recommendations  JSONB,
  location         GEOGRAPHY(POINT, 4326),
  model_version    VARCHAR(20),
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_plant_analyses_farmer   ON plant_analyses(farmer_id);
CREATE INDEX idx_plant_analyses_parcelle ON plant_analyses(parcelle_id);

CREATE TABLE produits_traitement (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom              VARCHAR(200) NOT NULL,
  type             VARCHAR(30),
  cultures_cibles  TEXT[],
  maladies_cibles  TEXT[],
  dosage           TEXT,
  mode_application TEXT,
  delai_carence_j  INTEGER,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE traceability_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lot_id         UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  event_type     VARCHAR(30) NOT NULL,
  actor_id       UUID NOT NULL REFERENCES users(id),
  location       GEOGRAPHY(POINT, 4326),
  metadata       JSONB NOT NULL DEFAULT '{}',
  blockchain_tx  VARCHAR(255),
  blockchain_net VARCHAR(20) DEFAULT 'POLYGON',
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_traceability_lot ON traceability_events(lot_id, created_at ASC);

-- =================================================================
--  ACTUALITÉS IA (alimente le fil d'actualité + alertes push)
-- =================================================================
-- Publiées par ADMIN (manuellement) ou par un job/cron (intégrations
-- externes : prix marché, météo, alertes sanitaires régionales).
-- Le client filtre par rôle (cible_role) et région (region_id) côté
-- requête pour ne montrer que ce qui concerne chaque user.
CREATE TABLE ai_news (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type        VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
  titre       VARCHAR(200) NOT NULL,
  body        TEXT NOT NULL,
  -- Si NULL : visible par tous les rôles. Sinon : restreint à ce rôle.
  cible_role  VARCHAR(30),
  -- Si NULL : actualité nationale. Sinon : ciblée région.
  region_id   UUID REFERENCES regions_ci(id),
  expires_at  TIMESTAMP WITH TIME ZONE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ai_news_active ON ai_news(is_active, created_at DESC) WHERE is_active = TRUE;
CREATE INDEX idx_ai_news_role   ON ai_news(cible_role) WHERE cible_role IS NOT NULL;
CREATE INDEX idx_ai_news_region ON ai_news(region_id) WHERE region_id IS NOT NULL;


-- =================================================================
--  14. INFRASTRUCTURE
-- =================================================================

CREATE TABLE outbox_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id   UUID NOT NULL,
  event_type     VARCHAR(100) NOT NULL,
  payload        JSONB NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  processed_at   TIMESTAMP WITH TIME ZONE,
  error          TEXT,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_outbox_pending ON outbox_events(status, created_at ASC) WHERE status = 'PENDING';


-- =================================================================
--  14b. CONTRAINTES FOREIGN KEY DIFFÉRÉES
--  (FKs ajoutées après création de toutes les tables — évite les
--  problèmes d'ordre de définition lorsque deux tables se référencent
--  mutuellement ou que la cible est définie plus loin dans le script)
-- =================================================================

-- medias → publications_stock_coop et lots
ALTER TABLE medias
  ADD CONSTRAINT fk_medias_publication
  FOREIGN KEY (publication_coop_id) REFERENCES publications_stock_coop(id) ON DELETE CASCADE;

ALTER TABLE medias
  ADD CONSTRAINT fk_medias_lot
  FOREIGN KEY (lot_id) REFERENCES lots(id) ON DELETE CASCADE;

-- producteur_profiles → cooperative_profiles
ALTER TABLE producteur_profiles
  ADD CONSTRAINT fk_producteur_coop
  FOREIGN KEY (coop_id) REFERENCES cooperative_profiles(id) ON DELETE SET NULL;

-- lot_contributions.annonce_id → annonces_vente
ALTER TABLE lot_contributions
  ADD CONSTRAINT fk_lot_contributions_annonce
  FOREIGN KEY (annonce_id) REFERENCES annonces_vente(id) ON DELETE SET NULL;


-- =================================================================
--  15. TRIGGERS updated_at
-- =================================================================

CREATE TRIGGER tg_produits_updated_at
  BEFORE UPDATE ON produits_agricoles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_annonces_updated_at
  BEFORE UPDATE ON annonces_vente
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_commandes_updated_at
  BEFORE UPDATE ON commandes_vente
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_shipments_updated_at
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_candidatures_updated_at
  BEFORE UPDATE ON candidatures_achat
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_propositions_updated_at
  BEFORE UPDATE ON propositions_vente
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tg_contre_offres_coop_updated_at
  BEFORE UPDATE ON contre_offres_coop
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =================================================================
--  16. SEED — PRODUITS DE TRAITEMENT (référentiel IA)
-- =================================================================

INSERT INTO produits_traitement
  (nom, type, cultures_cibles, maladies_cibles, dosage, mode_application, delai_carence_j)
VALUES
  ('Bordeaux mixture', 'FONGICIDE',
   ARRAY['CACAO', 'CAFE'],
   ARRAY['tache_brune', 'rouille', 'anthracnose'],
   '20g pour 10L d''eau',
   'Pulvérisation sur feuilles et cabosses', 15),
  ('Carbendazime 50%', 'FONGICIDE',
   ARRAY['CACAO', 'ANACARDE'],
   ARRAY['pourriture_brune', 'anthracnose'],
   '10ml pour 10L d''eau',
   'Pulvérisation complète de la plante', 21),
  ('Imidaclopride 200SC', 'INSECTICIDE',
   ARRAY['ANACARDE', 'CACAO'],
   ARRAY['miride', 'pucerons', 'mouche_blanc'],
   '5ml pour 10L d''eau',
   'Pulvérisation sur les nouvelles pousses', 30),
  ('Neem bio (huile de neem)', 'NATUREL',
   ARRAY['MAIS', 'RIZ', 'LEGUMES'],
   ARRAY['chenilles', 'pucerons', 'aleurodes'],
   '50ml pour 10L d''eau + quelques gouttes de savon',
   'Pulvérisation le soir (éviter le soleil)', 3),
  ('Glyphosate 480', 'HERBICIDE',
   ARRAY['MAIS', 'RIZ', 'SOJA'],
   ARRAY['mauvaises_herbes'],
   '200ml pour 15L d''eau',
   'Pulvérisation sur les adventices, éviter la culture', 7);


-- =================================================================
--  17. DOCUMENTATION DES TABLES (COMMENT ON TABLE)
--  Ces commentaires sont visibles dans pgAdmin (clic droit table →
--  Properties) et dans les outils de génération de doc automatique.
-- =================================================================

-- DOMAINE AUTH & UTILISATEURS
COMMENT ON TABLE users IS
  'Domaine: AUTH | Table centrale. Chaque personne (producteur, acheteur, coopérative, transporteur, exportateur, admin) a une ligne. Identifiant principal = phone.';

COMMENT ON TABLE producteur_profiles IS
  'Domaine: AUTH | Profil étendu pour les utilisateurs role=FARMER. Contient les infos agricoles (superficie, années d''expérience, cultures principales).';

COMMENT ON TABLE acheteur_profiles IS
  'Domaine: AUTH | Profil étendu pour les utilisateurs role=BUYER. Contient les infos commerciales (RCCM, capacité d''achat, zones).';

COMMENT ON TABLE cooperative_profiles IS
  'Domaine: AUTH | Profil étendu pour les utilisateurs role=COOPERATIVE. Contient l''agrément officiel, le siège géographique et le nombre de membres.';

COMMENT ON TABLE cooperative_members IS
  'Domaine: AUTH | Table de liaison N:N entre coopératives et producteurs membres. Rôle au sein de la coop : MEMBER, PRESIDENT, TRESORIER.';

COMMENT ON TABLE user_documents IS
  'Domaine: AUTH | Documents KYC (CNI, passeport, RCCM) uploadés par les utilisateurs pour vérification d''identité. Status workflow : PENDING → VERIFIED/REJECTED.';

COMMENT ON TABLE otps IS
  'Domaine: AUTH | Codes OTP à 6 chiffres envoyés par SMS pour authentification. Stockés hachés. Expiration 5-10 min. Usage unique.';

COMMENT ON TABLE refresh_tokens IS
  'Domaine: AUTH | Tokens de renouvellement de session JWT (durée 7 jours). Permet d''obtenir un nouveau JWT sans redemander le PIN.';

COMMENT ON TABLE device_tokens IS
  'Domaine: AUTH | Tokens FCM Firebase pour envoyer des notifications push aux appareils mobiles des utilisateurs.';

COMMENT ON TABLE user_login_history IS
  'Domaine: AUTH | Historique des tentatives de connexion. Utilisé pour la sécurité (détection de comportements anormaux).';


-- DOMAINE MARKETPLACE
COMMENT ON TABLE user_cultures IS
  'Domaine: MARKETPLACE | Liste des cultures pratiquées par chaque producteur. Avec superficie dédiée à chaque culture.';

COMMENT ON TABLE parcelle IS
  'Domaine: MARKETPLACE | Champs/parcelles d''un producteur avec polygone GPS précis. Utilisé pour l''analyse IA des plantes et la traçabilité.';

COMMENT ON TABLE annonces_vente IS
  'Domaine: MARKETPLACE | *** TABLE CENTRALE *** Une annonce = un producteur INDIVIDUEL propose un produit à la vente. Pour le stock coopératif, voir publications_stock_coop.';

COMMENT ON TABLE annonces_achat IS
  'Domaine: MARKETPLACE | Un acheteur publie ce dont il a besoin. Les producteurs et coopératives peuvent y répondre via propositions_vente.';

COMMENT ON TABLE publications_stock_coop IS
  'Domaine: MARKETPLACE | Une coopérative publie le stock collecté auprès de ses membres pour vente groupée. Équivalent coopératif des annonces_vente.';

COMMENT ON TABLE favoris IS
  'Domaine: MARKETPLACE | Annonces de vente mises en favoris par un utilisateur (pour retrouver rapidement).';

COMMENT ON TABLE avis IS
  'Domaine: MARKETPLACE | Notation 1-5 entre utilisateurs après une transaction (vente, transport, coopération). Met à jour users.rating.';

COMMENT ON TABLE panier IS
  'Domaine: MARKETPLACE | Panier d''achat de l''utilisateur (un seul panier actif par user). Contient des panier_items.';

COMMENT ON TABLE panier_items IS
  'Domaine: MARKETPLACE | Articles dans le panier avec quantité et prix figés au moment de l''ajout.';


-- DOMAINE NÉGOCIATION
COMMENT ON TABLE candidatures_achat IS
  'Domaine: NÉGOCIATION | Un acheteur candidate sur une annonce_vente (proposition de quantité/prix). Workflow : PENDING → ACCEPTED/REJECTED/COUNTERED.';

COMMENT ON TABLE candidature_traitements IS
  'Domaine: NÉGOCIATION | Historique pas à pas des actions sur une candidature (ACCEPT, REJECT, COUNTER_OFFER, MESSAGE, FINALIZE).';

COMMENT ON TABLE contre_offres_coop IS
  'Domaine: NÉGOCIATION | Acheteur fait une contre-offre sur publications_stock_coop. Équivalent coopératif de candidatures_achat.';

COMMENT ON TABLE previsions_production IS
  'Domaine: NÉGOCIATION | Producteur annonce sa récolte prévue à l''avance pour permettre les pré-achats par les acheteurs.';

COMMENT ON TABLE reservations_previsions IS
  'Domaine: NÉGOCIATION | Un acheteur réserve une partie de la récolte future d''un producteur (à un prix convenu à l''avance).';


-- DOMAINE COMMANDES
COMMENT ON TABLE commandes_vente IS
  'Domaine: COMMANDES | *** TABLE CENTRALE *** Commande finalisée entre acheteur et vendeur (producteur ou coopérative). Source : annonce_vente, publication_coop, ou lot.';

COMMENT ON TABLE disputes IS
  'Domaine: COMMANDES | Litiges ouverts sur une commande. L''équipe FarmCash arbitre sous 48h. Argent escrow gelé pendant le litige.';

COMMENT ON TABLE offres_marche_b2b IS
  'Domaine: COMMANDES | Offres pour le marché EXPORT international (AgroLink Export). Prix en USD, avec incoterm et ports.';

COMMENT ON TABLE commande_b2b IS
  'Domaine: COMMANDES | Commande export internationale finalisée. Transport par container maritime, paiement bancaire en USD.';

COMMENT ON TABLE export_documents IS
  'Domaine: COMMANDES | Documents douaniers obligatoires pour l''export (facture, certificat origine, phytosanitaire, BL, packing list).';

COMMENT ON TABLE contrats_vente_coop IS
  'Domaine: COMMANDES | Contrats formels d''approvisionnement entre une coopérative et un acheteur (validité plusieurs mois/saisons).';


-- DOMAINE FINANCE
COMMENT ON TABLE wallets IS
  'Domaine: FINANCE | Portefeuille numérique de chaque utilisateur. Sépare balance libre et balance_escrow (argent bloqué en attente de livraison).';

COMMENT ON TABLE moyen_de_payement IS
  'Domaine: FINANCE | Comptes mobile money enregistrés (Orange, MTN, Wave, Moov). Numéros stockés sous forme de tokens, jamais en clair.';

COMMENT ON TABLE transactions IS
  'Domaine: FINANCE | *** REGISTRE IMMUABLE *** Toutes les opérations financières (dépôt, retrait, paiement, escrow, commission, refund, payout). On n''efface JAMAIS.';

COMMENT ON TABLE escrow_conditions IS
  'Domaine: FINANCE | Conditions de libération d''un paiement en séquestre. Une fois la livraison confirmée et le délai de litige passé, l''argent est libéré au vendeur.';

COMMENT ON TABLE payout_batches IS
  'Domaine: FINANCE | Lot de versements groupés vers les wallets mobile money des bénéficiaires. Lancé par un admin.';

COMMENT ON TABLE payout_items IS
  'Domaine: FINANCE | Détail d''un versement individuel dans un batch. Pour les ventes coop, lot_contribution_id permet de distribuer aux contributeurs membres.';

COMMENT ON TABLE annonces_prefinancement IS
  'Domaine: FINANCE | Producteur demande un prêt avant la récolte (microcrédit, Phase 5). Score de crédit calculé par IA.';

COMMENT ON TABLE candidatures_prefinancement IS
  'Domaine: FINANCE | Institutions de microfinance qui proposent un prêt sur une annonce_prefinancement. Avec taux et durée.';


-- DOMAINE LOGISTIQUE
COMMENT ON TABLE shipments IS
  'Domaine: LOGISTIQUE | Mission de transport pour livrer une commande_vente. Du producteur/coop à l''acheteur, via un transporteur.';

COMMENT ON TABLE shipment_tracking IS
  'Domaine: LOGISTIQUE | Positions GPS du transporteur enregistrées toutes les X minutes. Suivi en temps réel sur carte.';


-- DOMAINE MESSAGERIE
COMMENT ON TABLE conversations IS
  'Domaine: MESSAGERIE | Fil de discussion (DIRECT entre 2 users, GROUP, ou AI_CHAT avec l''assistant IA).';

COMMENT ON TABLE conversation_participants IS
  'Domaine: MESSAGERIE | Qui participe à quelle conversation. Avec last_read_at pour gérer le badge "messages non lus".';

COMMENT ON TABLE messages IS
  'Domaine: MESSAGERIE | Chaque message envoyé (texte, audio, image). Pour les conversations IA, role distingue user/assistant.';

COMMENT ON TABLE notifications IS
  'Domaine: MESSAGERIE | Notifications push/in-app aux utilisateurs (nouvelle commande, paiement reçu, livraison, alerte prix).';


-- DOMAINE INTELLIGENCE ARTIFICIELLE
COMMENT ON TABLE plant_analyses IS
  'Domaine: IA | Résultats de l''analyse IA des photos de plantes envoyées par les agriculteurs. Détection de maladies + recommandations.';

COMMENT ON TABLE produits_traitement IS
  'Domaine: IA | Référentiel des produits de traitement agricole (fongicide, insecticide, herbicide, naturel). Utilisé par l''IA pour ses recommandations.';

COMMENT ON TABLE traceability_events IS
  'Domaine: IA | *** HISTORIQUE BLOCKCHAIN *** Chaque étape de la vie d''un lot enregistrée et stockée sur Polygon. Source du QR Code traçabilité.';


-- INFRASTRUCTURE
COMMENT ON TABLE outbox_events IS
  'Infrastructure | Pattern Transactional Outbox pour communication événementielle (futurs microservices, RabbitMQ/Kafka). Non utilisé en MVP.';


-- =================================================================
--  FIN — Base prête à l'emploi
--  Total : 60 tables + 43 produits + 5 traitements + 33 régions + 40 villes
--
--  COMPOSITION FINALE :
--    Catalogue (3)     : categories_cultures, sous_categories, produits_agricoles
--    Géographie (2)    : regions_ci (33), villes_ci (40)
--    Auth (10)         : users + profils + sécurité (KYC, OTP, sessions)
--    Marketplace (13)  : annonces (vente/achat/coop) + médias + lots + stock
--    Négociation (8)   : candidatures + propositions + contre-offres + historiques
--    Commandes (6)     : commandes locales + export B2B + litiges
--    Finance (8)       : wallets + paiements + escrow + microcrédit
--    Logistique (2)    : shipments + tracking GPS
--    Messagerie (4)    : conversations + messages + notifications
--    IA (3)            : analyse plantes + traçabilité blockchain
--    Infrastructure (1): outbox_events
-- =================================================================