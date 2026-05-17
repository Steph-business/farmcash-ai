-- =====================================================================
--  Migration : negotiation_messages (chat libre attaché à une négo)
--  ---------------------------------------------------------------------
--  Une seule table polymorphique : chaque message pointe vers
--  EXACTEMENT UNE des 3 négociations (candidature, proposition,
--  contre-offre coop) via un CHECK XOR.
--
--  Avantages :
--   • Un seul code/route à maintenir (insert/list par scope)
--   • Index unique par scope
--   • Filtrage propre par scope
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS negotiation_messages (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidature_id       UUID REFERENCES candidatures_achat(id)   ON DELETE CASCADE,
  proposition_id       UUID REFERENCES propositions_vente(id)   ON DELETE CASCADE,
  contre_offre_coop_id UUID REFERENCES contre_offres_coop(id)   ON DELETE CASCADE,
  sender_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content              TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 5000),
  read_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- XOR : EXACTEMENT 1 des 3 références doit être renseignée
  CONSTRAINT one_scope_only CHECK (
    (candidature_id IS NOT NULL)::int +
    (proposition_id IS NOT NULL)::int +
    (contre_offre_coop_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_negmsg_candidature ON negotiation_messages (candidature_id, created_at)
  WHERE candidature_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_negmsg_proposition ON negotiation_messages (proposition_id, created_at)
  WHERE proposition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_negmsg_contreoffre ON negotiation_messages (contre_offre_coop_id, created_at)
  WHERE contre_offre_coop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_negmsg_sender ON negotiation_messages (sender_id);

COMMIT;
