-- =====================================================================
--  Migration : Module Cooperatives (2026-05-14)
--  ---------------------------------------------------------------------
--  Ajoute :
--   • enum coop_annonce_status, coop_request_status
--   • commission_rate + auto_distribute + president_id sur cooperative_profiles
--   • assigned_to_cooperative_id + coop_status + champs validation sur annonces_vente
--   • target_cooperative_id sur annonces_achat
--   • cooperative_id sur users (coop active du farmer, unique)
--   • table coop_join_requests, coop_invitations, publication_contributions
--   • contrainte d'unicité 1 farmer = 1 coop max (cooperative_members.member_id)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'coop_annonce_status') THEN
    CREATE TYPE coop_annonce_status AS ENUM ('PENDING', 'VALIDATED', 'INCLUDED', 'REJECTED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'coop_request_status') THEN
    CREATE TYPE coop_request_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. cooperative_profiles — config commission + président
-- ---------------------------------------------------------------------

ALTER TABLE cooperative_profiles
  ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,4) NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS auto_distribute BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS president_id UUID;

-- Le président pointe vers un user (sera nécessairement un membre)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'cooperative_profiles_president_id_fkey'
  ) THEN
    ALTER TABLE cooperative_profiles
      ADD CONSTRAINT cooperative_profiles_president_id_fkey
      FOREIGN KEY (president_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE cooperative_profiles
  DROP CONSTRAINT IF EXISTS commission_rate_valid;
ALTER TABLE cooperative_profiles
  ADD CONSTRAINT commission_rate_valid CHECK (commission_rate >= 0 AND commission_rate <= 0.30);

-- ---------------------------------------------------------------------
-- 3. cooperative_members — un farmer ne peut être que dans 1 coop active
-- ---------------------------------------------------------------------

-- Supprime l'éventuelle ancienne contrainte UNIQUE (cooperative_id, member_id)
-- pour la remplacer par UNIQUE (member_id) WHERE is_active = true
DROP INDEX IF EXISTS uniq_active_member_one_coop;
CREATE UNIQUE INDEX uniq_active_member_one_coop
  ON cooperative_members (member_id)
  WHERE is_active = TRUE;

-- ---------------------------------------------------------------------
-- 4. users.cooperative_id — coop active du farmer (raccourci pour les jointures)
-- ---------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS cooperative_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_cooperative_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_cooperative_id_fkey
      FOREIGN KEY (cooperative_id) REFERENCES cooperative_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_cooperative ON users (cooperative_id);

-- ---------------------------------------------------------------------
-- 5. annonces_vente — assignation coop + workflow validation
-- ---------------------------------------------------------------------

ALTER TABLE annonces_vente
  ADD COLUMN IF NOT EXISTS assigned_to_cooperative_id UUID,
  ADD COLUMN IF NOT EXISTS coop_status coop_annonce_status,
  ADD COLUMN IF NOT EXISTS coop_publication_id UUID,
  ADD COLUMN IF NOT EXISTS quantite_kg_validee DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS qualite_validee product_quality,
  ADD COLUMN IF NOT EXISTS validee_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validee_by UUID,
  ADD COLUMN IF NOT EXISTS notes_pesee TEXT,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

-- Foreign keys
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'annonces_vente_assigned_coop_fkey') THEN
    ALTER TABLE annonces_vente
      ADD CONSTRAINT annonces_vente_assigned_coop_fkey
      FOREIGN KEY (assigned_to_cooperative_id) REFERENCES cooperative_profiles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'annonces_vente_coop_publication_fkey') THEN
    ALTER TABLE annonces_vente
      ADD CONSTRAINT annonces_vente_coop_publication_fkey
      FOREIGN KEY (coop_publication_id) REFERENCES publications_stock_coop(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'annonces_vente_validee_by_fkey') THEN
    ALTER TABLE annonces_vente
      ADD CONSTRAINT annonces_vente_validee_by_fkey
      FOREIGN KEY (validee_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_annonces_vente_coop
  ON annonces_vente (assigned_to_cooperative_id, coop_status)
  WHERE assigned_to_cooperative_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 6. annonces_achat — ciblage coop
-- ---------------------------------------------------------------------

ALTER TABLE annonces_achat
  ADD COLUMN IF NOT EXISTS target_cooperative_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'annonces_achat_target_coop_fkey') THEN
    ALTER TABLE annonces_achat
      ADD CONSTRAINT annonces_achat_target_coop_fkey
      FOREIGN KEY (target_cooperative_id) REFERENCES cooperative_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_annonces_achat_target_coop
  ON annonces_achat (target_cooperative_id)
  WHERE target_cooperative_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. coop_join_requests — Farmer demande à rejoindre une coop
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coop_join_requests (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id    UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  farmer_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message           TEXT,
  status            coop_request_status NOT NULL DEFAULT 'PENDING',
  handled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at        TIMESTAMPTZ,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_pending_join_request UNIQUE (cooperative_id, farmer_id, status)
);

CREATE INDEX IF NOT EXISTS idx_coop_join_requests_coop ON coop_join_requests (cooperative_id, status);
CREATE INDEX IF NOT EXISTS idx_coop_join_requests_farmer ON coop_join_requests (farmer_id, status);

-- ---------------------------------------------------------------------
-- 8. coop_invitations — Coop invite un farmer (par téléphone)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coop_invitations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id    UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  invited_phone     VARCHAR(20) NOT NULL,
  invited_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_by        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message           TEXT,
  status            coop_request_status NOT NULL DEFAULT 'PENDING',
  handled_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coop_invitations_phone ON coop_invitations (invited_phone, status);
CREATE INDEX IF NOT EXISTS idx_coop_invitations_coop ON coop_invitations (cooperative_id, status);

-- ---------------------------------------------------------------------
-- 9. publication_contributions — traçabilité (qui a contribué à quelle pub)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS publication_contributions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publication_id    UUID NOT NULL REFERENCES publications_stock_coop(id) ON DELETE CASCADE,
  annonce_vente_id  UUID NOT NULL REFERENCES annonces_vente(id) ON DELETE CASCADE,
  farmer_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantite_kg       DECIMAL(10,2) NOT NULL,
  prix_kg           DECIMAL(10,2) NOT NULL,
  part_pct          DECIMAL(7,4) NOT NULL,   -- part en % (0.1667 = 16.67%)
  paid_amount       DECIMAL(12,2),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_contrib_per_annonce UNIQUE (publication_id, annonce_vente_id)
);

CREATE INDEX IF NOT EXISTS idx_pub_contrib_publication ON publication_contributions (publication_id);
CREATE INDEX IF NOT EXISTS idx_pub_contrib_farmer ON publication_contributions (farmer_id);

COMMIT;
