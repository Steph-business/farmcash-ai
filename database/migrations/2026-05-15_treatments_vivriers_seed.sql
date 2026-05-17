-- =====================================================================
--  Seed : catalogue traitements pour produits vivriers (Côte d'Ivoire)
--  ---------------------------------------------------------------------
--  Pesticides + engrais + bio-stimulants couramment utilisés sur les
--  cultures vivrières en CI. Tous homologués CSP (Comité Sahélien des
--  Pesticides) ou intrants naturels reconnus.
--
--  Idempotent : ON CONFLICT (nom) DO NOTHING — relançable.
--  Types : FONGICIDE | INSECTICIDE | HERBICIDE | ENGRAIS | BIO_STIMULANT | AUTRE
-- =====================================================================

BEGIN;

-- Index unique pour idempotence (au cas où il n'existe pas)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_treatments_nom ON produits_traitement (nom);

-- ===================================================================
--  Insertion en un seul INSERT pour permettre ON CONFLICT global
-- ===================================================================

INSERT INTO produits_traitement (nom, type, cultures_cibles, maladies_cibles, dosage, mode_application, delai_carence_j) VALUES

-- ───── FONGICIDES ─────
('Bouillie bordelaise',
 'FONGICIDE',
 ARRAY['tomate','piment','aubergine','oignon','ananas','mangue'],
 ARRAY['mildiou','alternariose','anthracnose'],
 '20-30g pour 10L d''eau (200-300g/100L)',
 'Pulvérisation foliaire dès l''apparition des symptômes, à renouveler tous les 7-10 jours',
 7),

('Mancozèbe 80% WP (Dithane M-45)',
 'FONGICIDE',
 ARRAY['tomate','piment','oignon','banane-plantain'],
 ARRAY['mildiou','alternariose','cercosporiose'],
 '25g pour 10L d''eau',
 'Pulvérisation préventive ou curative, 3-4 applications espacées de 10 jours',
 14),

('Métalaxyl-M + Mancozèbe (Ridomil Gold MZ)',
 'FONGICIDE',
 ARRAY['tomate','oignon','piment'],
 ARRAY['mildiou','phytophthora'],
 '25g pour 10L d''eau',
 'Pulvérisation foliaire curative, 2-3 traitements maxi par cycle',
 10),

('Hexaconazole 5% SC',
 'FONGICIDE',
 ARRAY['riz','banane-plantain'],
 ARRAY['pyriculariose','sigatoka'],
 '10-15ml pour 10L d''eau',
 'Pulvérisation foliaire au stade tallage et épiaison (riz)',
 21),

-- ───── INSECTICIDES ─────
('Cypermethrine 100 EC',
 'INSECTICIDE',
 ARRAY['mais','riz','tomate','piment','aubergine','gombo','haricot','niebe'],
 ARRAY['foreuse-tige','chenilles','pucerons','heliothis'],
 '10ml pour 10L d''eau',
 'Pulvérisation en début d''attaque, applications espacées de 7-14 jours',
 7),

('Lambda-cyhalothrine 25 EC (Karaté)',
 'INSECTICIDE',
 ARRAY['mais','riz','tomate','piment','aubergine','haricot'],
 ARRAY['foreuse-tige','chenilles','pucerons','thrips'],
 '10-15ml pour 10L d''eau',
 'Pulvérisation foliaire au crépuscule pour préserver les pollinisateurs',
 7),

('Acétamipride 20 SP (Mospilan)',
 'INSECTICIDE',
 ARRAY['tomate','piment','aubergine','oignon','ananas'],
 ARRAY['mouche-blanche','pucerons','cochenilles'],
 '5g pour 10L d''eau',
 'Pulvérisation systémique, efficace sur insectes piqueurs-suceurs',
 14),

('Bacillus thuringiensis (Dipel DF — BIO)',
 'INSECTICIDE',
 ARRAY['mais','tomate','piment','aubergine','chou','gombo'],
 ARRAY['chenilles','spodoptera','heliothis'],
 '10-15g pour 10L d''eau',
 'Pulvérisation en début d''attaque (jeunes chenilles), à renouveler tous les 5 jours. Bio, agréé culture biologique.',
 0),

('Spinosad 240 SC (Tracer — BIO)',
 'INSECTICIDE',
 ARRAY['oignon','tomate','piment','chou'],
 ARRAY['thrips','chenilles','mineuses'],
 '5ml pour 10L d''eau',
 'Pulvérisation foliaire, agréé bio (issu de fermentation bactérienne)',
 3),

('Pyrèthre naturel (extrait de chrysanthème)',
 'INSECTICIDE',
 ARRAY['tomate','piment','aubergine','gombo','haricot'],
 ARRAY['pucerons','mouches','chenilles'],
 '20ml pour 10L d''eau',
 'Pulvérisation foliaire en fin de journée (sensible à la lumière). Bio, dégradation rapide.',
 1),

-- ───── HERBICIDES ─────
('Atrazine 500 SC',
 'HERBICIDE',
 ARRAY['mais'],
 ARRAY['adventices-dicotylees'],
 '300ml pour 15L d''eau (par hectare)',
 'Pré-levée ou post-levée précoce du maïs (stade 2-4 feuilles). Sélectif maïs.',
 90),

('Pendiméthaline 400 SC (Stomp)',
 'HERBICIDE',
 ARRAY['mais','riz','oignon','arachide','niebe'],
 ARRAY['adventices-graminees','adventices-dicotylees'],
 '250-300ml pour 15L (par hectare)',
 'Application en pré-levée sur sol humide',
 60),

('2,4-D Amine 720 SL',
 'HERBICIDE',
 ARRAY['mais','riz'],
 ARRAY['adventices-dicotylees-vivaces'],
 '100ml pour 15L (par hectare)',
 'Post-levée, sur adventices à feuilles larges. Ne PAS appliquer en floraison.',
 30),

-- ───── ENGRAIS ─────
('NPK 15-15-15 (engrais complet)',
 'ENGRAIS',
 ARRAY['mais','riz','tomate','piment','aubergine','oignon','haricot'],
 ARRAY[]::text[],
 '200-300 kg/ha au démarrage, 100-150 kg/ha au tallage/floraison',
 'Apport au sol, enfoui légèrement. Fractionner si possible (semis + 30 jours)',
 0),

('NPK 12-22-22 (tubercules/fruits)',
 'ENGRAIS',
 ARRAY['igname','manioc','patate-douce','ananas','banane-plantain'],
 ARRAY[]::text[],
 '300-400 kg/ha au démarrage',
 'Apport au sol au moment du buttage (igname) ou plantation (manioc/ananas)',
 0),

('Urée 46% (azote pur)',
 'ENGRAIS',
 ARRAY['mais','riz','banane-plantain','oignon'],
 ARRAY[]::text[],
 '100-150 kg/ha en couverture',
 'Apport en 2-3 fractions : tallage, montaison, épiaison (céréales)',
 0),

('Sulfate de potassium (K2SO4)',
 'ENGRAIS',
 ARRAY['tomate','piment','banane-plantain','ananas','igname'],
 ARRAY[]::text[],
 '100-150 kg/ha',
 'Apport au sol en pleine fructification — améliore la qualité gustative et la conservation',
 0),

-- ───── BIO-STIMULANTS / ORGANIQUES ─────
('Compost organique mûr',
 'BIO_STIMULANT',
 ARRAY['tomate','piment','aubergine','oignon','mais','igname','manioc','banane-plantain'],
 ARRAY[]::text[],
 '10-20 tonnes/ha',
 'Apport au sol avant labour ou en surface en couverture (paillage)',
 0),

('Fumier de poulet décomposé',
 'BIO_STIMULANT',
 ARRAY['tomate','piment','aubergine','gombo','oignon','mais'],
 ARRAY[]::text[],
 '5-10 tonnes/ha (riche en azote — doser modérément)',
 'Apport au sol 2 semaines avant semis/plantation. Doit être bien décomposé (3-6 mois).',
 0),

('Bouse de vache compostée',
 'BIO_STIMULANT',
 ARRAY['mais','riz','igname','manioc','banane-plantain'],
 ARRAY[]::text[],
 '10-15 tonnes/ha',
 'Apport au sol en pré-plantation',
 0),

('Tourteau de neem',
 'BIO_STIMULANT',
 ARRAY['tomate','piment','oignon','gombo','manioc'],
 ARRAY['nematodes','insectes-du-sol'],
 '500-1000 kg/ha',
 'Incorporation au sol au moment du semis/plantation — fertilisant + nématicide naturel',
 0),

-- ───── AUTRES (techniques paysannes) ─────
('Savon noir + ail/piment (bio)',
 'AUTRE',
 ARRAY['tomate','piment','aubergine','gombo','oignon'],
 ARRAY['pucerons','mouche-blanche','cochenilles'],
 '50g savon noir + 100g ail/piment écrasés / 10L d''eau, laisser macérer 24h',
 'Pulvérisation foliaire le soir, à renouveler tous les 5-7 jours',
 0),

('Cendre de bois (anti-charançons stockage)',
 'AUTRE',
 ARRAY['oignon','mais','arachide','manioc'],
 ARRAY['fourmis','charancons-stockage'],
 'Saupoudrer 100-200 g/m² au pied des plants',
 'Au sol en culture ou mélangée aux graines stockées (anti-charançons)',
 0)

ON CONFLICT (nom) DO NOTHING;

COMMIT;
