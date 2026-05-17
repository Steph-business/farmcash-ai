-- =====================================================================
--  Migration : Hardening orders
--  ---------------------------------------------------------------------
--  • idempotency_key sur commandes_vente (anti-double-clic)
--  • cancelled_at sur commandes_vente (pour le cron cleanup)
--  • cancelled_reason (audit)
-- =====================================================================

BEGIN;

ALTER TABLE commandes_vente
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_reason VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_commandes_idempotency_key
  ON commandes_vente (buyer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commandes_status_created
  ON commandes_vente (status, created_at)
  WHERE status IN ('SENT', 'ACCEPTED');

COMMIT;
