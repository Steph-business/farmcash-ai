-- =====================================================================
--  Migration : Profil métier Admin (2026-05-16)
--  ---------------------------------------------------------------------
--  Sixième et dernier profil métier. Distinct des autres :
--   - un admin a un NIVEAU (SUPER_ADMIN > ADMIN > MODERATOR > SUPPORT)
--   - et des PERMISSIONS fines (peut_valider_kyc, peut_gerer_finance,
--     peut_gerer_users, peut_publier_news)
--
--  Le rôle générique 'ADMIN' (enum user_role) ne suffit pas : on veut
--  pouvoir différencier en interne un super-admin technique d'un
--  modérateur qui n'a accès qu'aux contenus.
--
--  Tous les ADMIN existants sont backfillés avec niveau 'ADMIN' par
--  défaut. Un super-admin doit promouvoir manuellement les comptes.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ENUM admin_niveau
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_niveau') THEN
    CREATE TYPE admin_niveau AS ENUM (
      'SUPER_ADMIN',  -- accès total, peut promouvoir d'autres admins
      'ADMIN',        -- accès opérationnel complet sauf gestion d'admins
      'MODERATOR',    -- modération de contenu (annonces, news, avis)
      'SUPPORT'       -- lecture seule + tickets utilisateurs
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. TABLE admin_profiles
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_profiles (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  niveau               admin_niveau NOT NULL DEFAULT 'ADMIN',
  departement          VARCHAR(100),     -- "Finance", "Modération", "Tech", "Support"

  -- Permissions fines (par défaut tout OFF, sera ouvert manuellement)
  peut_valider_kyc     BOOLEAN NOT NULL DEFAULT FALSE,
  peut_gerer_finance   BOOLEAN NOT NULL DEFAULT FALSE,
  peut_gerer_users     BOOLEAN NOT NULL DEFAULT FALSE,
  peut_publier_news    BOOLEAN NOT NULL DEFAULT FALSE,

  notes                TEXT,             -- notes internes (qui, pourquoi, depuis quand)

  -- Audit
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_niveau ON admin_profiles (niveau);
CREATE INDEX IF NOT EXISTS idx_admin_departement
  ON admin_profiles (departement)
  WHERE departement IS NOT NULL;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION trg_admin_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_admin_profiles ON admin_profiles;
CREATE TRIGGER set_updated_at_admin_profiles
  BEFORE UPDATE ON admin_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_admin_profiles_updated_at();

-- ---------------------------------------------------------------------
-- 3. Backfill : tous les ADMIN existants reçoivent un profil niveau ADMIN
--    Le premier admin déclaré sera promu SUPER_ADMIN par convention,
--    pour éviter de se retrouver sans personne capable de promouvoir.
-- ---------------------------------------------------------------------

INSERT INTO admin_profiles (user_id, niveau)
SELECT u.id, 'ADMIN'
FROM users u
LEFT JOIN admin_profiles ap ON ap.user_id = u.id
WHERE u.role = 'ADMIN' AND ap.id IS NULL;

-- Promotion du tout premier admin en SUPER_ADMIN (si aucun n'existe encore)
WITH first_admin AS (
  SELECT ap.id
  FROM admin_profiles ap
  JOIN users u ON u.id = ap.user_id
  WHERE u.role = 'ADMIN'
  ORDER BY u.created_at ASC
  LIMIT 1
)
UPDATE admin_profiles
SET niveau = 'SUPER_ADMIN',
    peut_valider_kyc = TRUE,
    peut_gerer_finance = TRUE,
    peut_gerer_users = TRUE,
    peut_publier_news = TRUE
WHERE id IN (SELECT id FROM first_admin)
  AND NOT EXISTS (
    SELECT 1 FROM admin_profiles WHERE niveau = 'SUPER_ADMIN'
  );

COMMIT;
