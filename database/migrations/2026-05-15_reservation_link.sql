-- =====================================================================
--  Migration : Lier commande à sa réservation source
--  ---------------------------------------------------------------------
--  Permet à confirmPayment de savoir si une commande vient d'une
--  réservation (auquel cas le stock annonce n'est PAS décrémenté car
--  il a déjà été réservé à la conversion).
-- =====================================================================

BEGIN;

ALTER TABLE commandes_vente
  ADD COLUMN IF NOT EXISTS from_reservation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'commandes_from_reservation_fkey'
  ) THEN
    ALTER TABLE commandes_vente
      ADD CONSTRAINT commandes_from_reservation_fkey
      FOREIGN KEY (from_reservation_id) REFERENCES reservations_previsions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_commandes_from_reservation
  ON commandes_vente (from_reservation_id)
  WHERE from_reservation_id IS NOT NULL;

COMMIT;
