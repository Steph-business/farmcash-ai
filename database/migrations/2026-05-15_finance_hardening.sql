-- =====================================================================
--  Migration : Hardening finance (Phase 1 + 1.5)
--  ---------------------------------------------------------------------
--  • CHECK balance >= 0 sur wallets (jamais négatif au niveau DB)
--  • idempotency_key sur transactions (dedup webhooks providers)
--  • provider_status sur transactions (mapping riche prov)
--  • Compte TREASURY système qui accumule les frais
--  • Table admin_audit_log (traçabilité actions admin sensibles)
--  • Table provider_circuit_state (état du circuit breaker)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Wallets : contrainte de non-négativité au niveau DB
-- ---------------------------------------------------------------------

ALTER TABLE wallets
  DROP CONSTRAINT IF EXISTS wallet_balance_non_negative;
ALTER TABLE wallets
  ADD CONSTRAINT wallet_balance_non_negative CHECK (balance >= 0);

ALTER TABLE wallets
  DROP CONSTRAINT IF EXISTS wallet_balance_escrow_non_negative;
ALTER TABLE wallets
  ADD CONSTRAINT wallet_balance_escrow_non_negative CHECK (balance_escrow >= 0);

-- ---------------------------------------------------------------------
-- 2. transactions : idempotency_key + provider_status riche
-- ---------------------------------------------------------------------

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS provider_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_idempotency_key
  ON transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);

-- ---------------------------------------------------------------------
-- 3. Compte plateforme TREASURY
--    User système dont le wallet accumule les commissions service.
-- ---------------------------------------------------------------------

INSERT INTO users (id, phone, full_name, role, is_active, langue)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '+225000000000',
  'FarmCash Treasury',
  'ADMIN',
  true,
  'fr'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallets (user_id, currency, balance, balance_escrow)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'XOF',
  0,
  0
)
ON CONFLICT (user_id, currency) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Table admin_audit_log
--    Trace immuable des actions admin sensibles (libération escrow,
--    gel wallet, etc.). Append-only conceptuellement (pas de UPDATE).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id      UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(80) NOT NULL,
  target_type   VARCHAR(50),
  target_id     UUID,
  payload       JSONB,
  ip            VARCHAR(64),
  user_agent    VARCHAR(255),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log (admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log (action, created_at);

-- ---------------------------------------------------------------------
-- 5. Table provider_circuit_state
--    État du circuit breaker par provider (ouvert/fermé/half-open).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_circuit_state (
  provider          VARCHAR(40) PRIMARY KEY,
  state             VARCHAR(20) NOT NULL DEFAULT 'CLOSED', -- CLOSED|OPEN|HALF_OPEN
  failure_count     INTEGER NOT NULL DEFAULT 0,
  last_failure_at   TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
