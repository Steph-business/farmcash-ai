-- =====================================================================
--  Migration : Workflow coop pour previsions_production (2026-05-14)
--  ---------------------------------------------------------------------
--  Étend le workflow d'attribution coop (déjà appliqué aux annonces_vente)
--  aux prévisions de récolte. Mêmes statuts, même verrouillage.
-- =====================================================================

BEGIN;

ALTER TABLE previsions_production
  ADD COLUMN IF NOT EXISTS assigned_to_cooperative_id UUID,
  ADD COLUMN IF NOT EXISTS coop_status coop_annonce_status,
  ADD COLUMN IF NOT EXISTS quantite_kg_validee DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS validee_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validee_by UUID,
  ADD COLUMN IF NOT EXISTS notes_inspection TEXT,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'previsions_production_assigned_coop_fkey') THEN
    ALTER TABLE previsions_production
      ADD CONSTRAINT previsions_production_assigned_coop_fkey
      FOREIGN KEY (assigned_to_cooperative_id) REFERENCES cooperative_profiles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'previsions_production_validee_by_fkey') THEN
    ALTER TABLE previsions_production
      ADD CONSTRAINT previsions_production_validee_by_fkey
      FOREIGN KEY (validee_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_previsions_coop
  ON previsions_production (assigned_to_cooperative_id, coop_status)
  WHERE assigned_to_cooperative_id IS NOT NULL;

COMMIT;
