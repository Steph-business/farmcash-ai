-- =====================================================================
--  Migration : Workflow prévision → annonce + acompte 10%
--  ---------------------------------------------------------------------
--  • previsions_production : statut + lien vers l'annonce convertie
--  • reservations_previsions : montant deposit + délai final + lien commande
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'prevision_status') THEN
    CREATE TYPE prevision_status AS ENUM (
      'OPEN',         -- en attente, accepte de nouvelles réservations
      'CONVERTED',    -- transformée en annonce
      'EXPIRED',      -- date de récolte dépassée sans conversion
      'CANCELLED'     -- annulée par le producteur (refund auto)
    );
  END IF;
END $$;

ALTER TABLE previsions_production
  ADD COLUMN IF NOT EXISTS status prevision_status NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS converted_to_annonce_id UUID,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'previsions_converted_annonce_fkey'
  ) THEN
    ALTER TABLE previsions_production
      ADD CONSTRAINT previsions_converted_annonce_fkey
      FOREIGN KEY (converted_to_annonce_id) REFERENCES annonces_vente(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_previsions_status ON previsions_production (status);

-- ---------------------------------------------------------------------
-- reservations_previsions : workflow acompte
-- ---------------------------------------------------------------------

ALTER TABLE reservations_previsions
  ADD COLUMN IF NOT EXISTS deposit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_rate DECIMAL(5,4) NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS final_order_id UUID,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'reservations_deposit_tx_fkey'
  ) THEN
    ALTER TABLE reservations_previsions
      ADD CONSTRAINT reservations_deposit_tx_fkey
      FOREIGN KEY (deposit_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'reservations_final_order_fkey'
  ) THEN
    ALTER TABLE reservations_previsions
      ADD CONSTRAINT reservations_final_order_fkey
      FOREIGN KEY (final_order_id) REFERENCES commandes_vente(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reservations_status_expires
  ON reservations_previsions (status, expires_at);

COMMIT;
