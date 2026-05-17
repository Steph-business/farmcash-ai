-- =====================================================================
--  Migration : Profil métier Transporteur (2026-05-16)
--  ---------------------------------------------------------------------
--  Crée le quatrième profil métier dédié, aligné sur :
--   • producteur_profiles
--   • acheteur_profiles
--   • cooperative_profiles
--
--  Le transporteur :
--   - peut être une PERSONNE physique ou une ENTREPRISE de transport
--   - déclare un véhicule principal (avec immatriculation, capacité…)
--   - opère depuis une région/ville et couvre des zones additionnelles
--   - garde transporter_routes pour les TRAJETS détaillés et tarifés
--
--  Les PHOTOS (permis, carte grise, assurance) restent dans
--  user_documents avec doc_type approprié — ce profil ne stocke que
--  les données STRUCTURÉES.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ENUM type_vehicule
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'type_vehicule') THEN
    CREATE TYPE type_vehicule AS ENUM (
      'MOTO',          -- 2 roues, livraison courte distance / petit volume
      'TRICYCLE',      -- 3 roues, urbain / périurbain
      'PICKUP',        -- 4x4 / pickup, charges moyennes
      'FOURGON',       -- utilitaire fermé
      'CAMION',        -- camion plateau / benne
      'CAMION_FRIGO',  -- camion frigorifique
      'REMORQUE'       -- semi-remorque, longues distances
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. TABLE transporteur_profiles
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transporteur_profiles (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Identité (entreprise OU personne)
  nom_entreprise       VARCHAR(200),
  numero_rccm          VARCHAR(100),    -- registre commerce (si entreprise)
  numero_ifu           VARCHAR(50),     -- identifiant fiscal CI (si entreprise)

  -- Conducteur (obligatoire pour KYC)
  numero_permis        VARCHAR(100) NOT NULL,
  categorie_permis     VARCHAR(10),     -- A, B, C, D, E, CE…

  -- Véhicule principal
  type_vehicule        type_vehicule NOT NULL,
  immatriculation      VARCHAR(20) NOT NULL,
  marque_modele        VARCHAR(100),
  annee_vehicule       INT,
  capacite_max_kg      DECIMAL(10,2) NOT NULL,
  volume_max_m3        DECIMAL(8,2),
  is_refrigere         BOOLEAN NOT NULL DEFAULT FALSE,
  is_bache             BOOLEAN NOT NULL DEFAULT FALSE,

  -- Zone d'opération
  region_id            UUID REFERENCES regions_ci(id) ON DELETE SET NULL,
  ville_id             UUID REFERENCES villes_ci(id) ON DELETE SET NULL,
  zones_couvertes      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  rayon_action_km      INT,

  -- Tarification par défaut (les routes détaillées restent dans transporter_routes)
  tarif_kg_default     DECIMAL(8,2),
  tarif_minimum_default DECIMAL(10,2),

  -- Compteurs / état opérationnel
  nb_voyages_total     INT NOT NULL DEFAULT 0,
  disponible           BOOLEAN NOT NULL DEFAULT TRUE,

  -- Audit
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Contraintes métier
  CONSTRAINT chk_capacite_positive CHECK (capacite_max_kg > 0),
  CONSTRAINT chk_volume_positive CHECK (volume_max_m3 IS NULL OR volume_max_m3 > 0),
  CONSTRAINT chk_annee_vehicule
    CHECK (annee_vehicule IS NULL OR annee_vehicule BETWEEN 1980 AND EXTRACT(YEAR FROM NOW())::INT + 1),
  CONSTRAINT chk_rayon_action
    CHECK (rayon_action_km IS NULL OR (rayon_action_km > 0 AND rayon_action_km <= 5000)),
  CONSTRAINT chk_tarif_kg CHECK (tarif_kg_default IS NULL OR tarif_kg_default >= 0),
  CONSTRAINT chk_tarif_min CHECK (tarif_minimum_default IS NULL OR tarif_minimum_default >= 0),
  -- Si on déclare un IFU/RCCM, on doit avoir aussi le nom d'entreprise
  CONSTRAINT chk_entreprise_coherence CHECK (
    (numero_rccm IS NULL AND numero_ifu IS NULL)
    OR nom_entreprise IS NOT NULL
  )
);

-- Immatriculation unique (anti-doublon sur le pays — un même véhicule = un seul transporteur)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_transporteur_immatriculation
  ON transporteur_profiles (immatriculation);

CREATE INDEX IF NOT EXISTS idx_transporteur_region
  ON transporteur_profiles (region_id);
CREATE INDEX IF NOT EXISTS idx_transporteur_ville
  ON transporteur_profiles (ville_id);
CREATE INDEX IF NOT EXISTS idx_transporteur_type
  ON transporteur_profiles (type_vehicule);
CREATE INDEX IF NOT EXISTS idx_transporteur_dispo
  ON transporteur_profiles (disponible)
  WHERE disponible = TRUE;

-- ---------------------------------------------------------------------
-- 3. Trigger updated_at (cohérent avec les autres tables)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_transporteur_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_transporteur_profiles ON transporteur_profiles;
CREATE TRIGGER set_updated_at_transporteur_profiles
  BEFORE UPDATE ON transporteur_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_transporteur_profiles_updated_at();

-- ---------------------------------------------------------------------
-- 4. (Optionnel) Backfill : créer un profil vide pour les transporteurs
--    déjà inscrits avant cette migration, afin de ne pas casser les
--    flux qui attendent un profil. On ne le fait QUE si les données
--    minimales sont disponibles ; sinon on laisse le transporteur
--    finaliser son onboarding KYC.
--
--    On ne backfill PAS automatiquement ici pour éviter d'insérer des
--    valeurs bidon (numero_permis, immatriculation, capacite_max_kg
--    sont NOT NULL). Le service backend doit forcer le transporteur
--    à compléter son profil au prochain login.
-- ---------------------------------------------------------------------

COMMIT;
