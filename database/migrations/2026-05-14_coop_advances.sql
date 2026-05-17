-- =====================================================================
--  Migration : coop_advance_payments (avances coop → producteur)
--  ---------------------------------------------------------------------
--  La coop peut verser une avance à un producteur sur une annonce
--  VALIDATED (avant ou après inclusion dans une publication).
--
--  Calcul du plafond (côté code) :
--    max_advance = quantite_kg_validee × prix_par_kg (annonce d'origine)
--    ≈ ce que le producteur recevrait au meilleur cas
--
--  Statuts :
--    • PAID       — avance versée, en attente de remboursement automatique
--    • REIMBURSED — déduite lors de la distribution de la publication
--    • CANCELLED  — annulée (rare, géré par l'admin)
--
--  L'avance est REMBOURSÉE automatiquement au moment du
--  distributePublication : on déduit le montant de la part du producteur,
--  puis on marque l'avance REIMBURSED.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'coop_advance_status') THEN
    CREATE TYPE coop_advance_status AS ENUM ('PAID', 'REIMBURSED', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS coop_advance_payments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cooperative_id    UUID NOT NULL REFERENCES cooperative_profiles(id) ON DELETE CASCADE,
  farmer_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  annonce_vente_id  UUID REFERENCES annonces_vente(id) ON DELETE SET NULL,
  amount            DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  status            coop_advance_status NOT NULL DEFAULT 'PAID',
  paid_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reimbursed_at     TIMESTAMPTZ,
  notes             TEXT,
  paid_by           UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advances_coop_status   ON coop_advance_payments (cooperative_id, status);
CREATE INDEX IF NOT EXISTS idx_advances_farmer        ON coop_advance_payments (farmer_id, status);
CREATE INDEX IF NOT EXISTS idx_advances_annonce       ON coop_advance_payments (annonce_vente_id);

COMMIT;
