-- =====================================================================
--  Migration : Traçabilité des traitements utilisés
--  ---------------------------------------------------------------------
--  Quand un FARMER ou une COOP publie une annonce / publication, il
--  peut déclarer les produits de traitement utilisés. Améliore la
--  confiance (transparence), facilite la certification BIO et le
--  contrôle des résidus à l'export.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS annonce_vente_traitements (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  annonce_vente_id        UUID NOT NULL REFERENCES annonces_vente(id) ON DELETE CASCADE,
  produit_traitement_id   UUID NOT NULL REFERENCES produits_traitement(id) ON DELETE RESTRICT,
  dosage_utilise          VARCHAR(200),
  date_application        DATE,
  delai_carence_respecte  BOOLEAN,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_annonce_traitement UNIQUE (annonce_vente_id, produit_traitement_id)
);

CREATE INDEX IF NOT EXISTS idx_annonce_traitements_annonce
  ON annonce_vente_traitements (annonce_vente_id);

CREATE TABLE IF NOT EXISTS publication_coop_traitements (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publication_id          UUID NOT NULL REFERENCES publications_stock_coop(id) ON DELETE CASCADE,
  produit_traitement_id   UUID NOT NULL REFERENCES produits_traitement(id) ON DELETE RESTRICT,
  dosage_utilise          VARCHAR(200),
  date_application        DATE,
  delai_carence_respecte  BOOLEAN,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_publication_traitement UNIQUE (publication_id, produit_traitement_id)
);

CREATE INDEX IF NOT EXISTS idx_publication_traitements_pub
  ON publication_coop_traitements (publication_id);

COMMIT;
