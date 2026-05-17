-- =====================================================================
--  Migration : Profil métier Exportateur (2026-05-16)
--  ---------------------------------------------------------------------
--  Cinquième profil métier, aligné sur les autres (producteur, acheteur,
--  coopérative, transporteur).
--
--  L'exportateur :
--   - est presque toujours une ENTREPRISE (RCCM/IFU + agrément export)
--   - exporte vers des pays cibles via un port d'attache (Abidjan, San-Pédro…)
--   - opère sur des produits / incoterms spécifiques
--   - garde commande_b2b / offres_marche_b2b pour les transactions
--
--  Tous les champs sont OPTIONNELS pour permettre un profil vide à
--  l'inscription, complété progressivement durant l'onboarding KYC.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS exportateur_profiles (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Identité société
  company_name         VARCHAR(200),
  numero_rccm          VARCHAR(100),
  numero_ifu           VARCHAR(50),
  agrement_export      VARCHAR(100),  -- agrément ministère commerce extérieur

  -- Activité
  produits_exportes    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  pays_destination     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],  -- codes ISO ou libellés
  incoterms_supportes  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],  -- FOB, CIF, EXW…
  port_attache         VARCHAR(100),  -- Abidjan, San-Pédro
  volume_annuel_kg     DECIMAL(15, 2),

  -- Bancaire (règlements internationaux)
  iban                 VARCHAR(50),
  swift_bic            VARCHAR(20),

  -- Audit
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Cohérence
  CONSTRAINT chk_volume_export_positive
    CHECK (volume_annuel_kg IS NULL OR volume_annuel_kg >= 0),
  CONSTRAINT chk_entreprise_export_coherence CHECK (
    (numero_rccm IS NULL AND numero_ifu IS NULL AND agrement_export IS NULL)
    OR company_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_exportateur_port
  ON exportateur_profiles (port_attache);
CREATE INDEX IF NOT EXISTS idx_exportateur_agrement
  ON exportateur_profiles (agrement_export)
  WHERE agrement_export IS NOT NULL;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION trg_exportateur_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_exportateur_profiles ON exportateur_profiles;
CREATE TRIGGER set_updated_at_exportateur_profiles
  BEFORE UPDATE ON exportateur_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_exportateur_profiles_updated_at();

-- Backfill profils vides pour exportateurs existants
INSERT INTO exportateur_profiles (user_id)
SELECT u.id
FROM users u
LEFT JOIN exportateur_profiles ep ON ep.user_id = u.id
WHERE u.role = 'EXPORTER' AND ep.id IS NULL;

COMMIT;
