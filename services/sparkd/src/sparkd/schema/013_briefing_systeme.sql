-- @spec docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9.2 (ce que le dossier porte),
--       §44.8 (le modele unique), §42.6 (le releve) · docs/SCHEMA.md
--       §10 quinquies · docs/PROD_MIGRATIONS.md OP-15
--
-- Le releve d'amorcage LIT deja la distribution, sa suite et — depuis SPK-85 —
-- l'architecture de la cellule. Il ne les gardait pas. Un agent qui prepare le
-- deploiement AILLEURS ne peut ni les lire ni les deviner : une image tiree pour
-- la mauvaise architecture ne se decouvre qu'au premier `docker compose up`.
--
-- Les trois colonnes naissent NULL sur les lignes deja ecrites et le RESTENT :
-- reconstituer apres coup ce qu'une cellule declarait a une date passee
-- detruirait le seul interet d'un releve date.

-- @up
ALTER TABLE spark_bootstrap_observation ADD COLUMN os_id TEXT;
ALTER TABLE spark_bootstrap_observation ADD COLUMN os_suite TEXT;
ALTER TABLE spark_bootstrap_observation ADD COLUMN arch TEXT;

-- @down
ALTER TABLE spark_bootstrap_observation DROP COLUMN arch;
ALTER TABLE spark_bootstrap_observation DROP COLUMN os_suite;
ALTER TABLE spark_bootstrap_observation DROP COLUMN os_id;
