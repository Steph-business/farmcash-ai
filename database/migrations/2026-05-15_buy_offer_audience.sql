-- =====================================================================
--  Migration : Visibilité des offres d'achat (BUYER)
--  ---------------------------------------------------------------------
--  3 niveaux de visibilité :
--    • PUBLIC               (défaut) : tout le monde voit sur le marketplace
--    • ALL_COOPERATIVES     : seules toutes les coops voient (pas les
--                              FARMERS individuels, pas le public)
--    • SPECIFIC_COOPERATIVE : seule la coop ciblée voit (target_cooperative_id
--                              doit être renseigné)
--
--  Les valeurs existantes sont remappées :
--    target_cooperative_id NULL    → target_audience = PUBLIC
--    target_cooperative_id présent → target_audience = SPECIFIC_COOPERATIVE
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buy_offer_audience') THEN
    CREATE TYPE buy_offer_audience AS ENUM (
      'PUBLIC',
      'ALL_COOPERATIVES',
      'SPECIFIC_COOPERATIVE'
    );
  END IF;
END $$;

ALTER TABLE annonces_achat
  ADD COLUMN IF NOT EXISTS target_audience buy_offer_audience NOT NULL DEFAULT 'PUBLIC';

-- Backfill : si target_cooperative_id est déjà renseigné, c'est SPECIFIC_COOPERATIVE
UPDATE annonces_achat
  SET target_audience = 'SPECIFIC_COOPERATIVE'
  WHERE target_cooperative_id IS NOT NULL AND target_audience = 'PUBLIC';

CREATE INDEX IF NOT EXISTS idx_annonces_achat_audience
  ON annonces_achat (target_audience)
  WHERE target_audience != 'PUBLIC';

COMMIT;
