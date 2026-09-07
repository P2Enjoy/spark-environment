-- @spec docs/BACKLOG.md#SPK-93 · docs/DAT.md §52 (l historien), §52.3 (ce qu une
--       ligne dit), §52.4 (deux causes a un trou), §52.5 (retention) · §20.1
--       (null jamais zero), §20.4 (un Spark arrete) · docs/SCHEMA.md §10 sexies
--       · docs/PROD_MIGRATIONS.md OP-16
--
-- L usage ne se rendait qu a l instant ou on le demandait. Cette table porte le
-- temps : une ligne par Spark et par tic de l historien.
--
-- TOUTES les colonnes de mesure sont nullables, et c est le contrat. NULL y veut
-- dire « non mesure », jamais « zero » (§20.1) — un Spark qui ne tourne pas n a
-- aucune mesure, et un premier releve n a pas de fenetre donc pas de taux.
--
-- `state` est ecrit a chaque ligne parce qu une ligne SANS mesure et une ABSENCE
-- de ligne ne disent pas la meme chose (§52.4) : la premiere est un fait sur le
-- Spark, la seconde un fait sur la Forge — personne ne relevait. Sans cette
-- colonne, un arret planifie se lirait comme une panne du plan de controle.
--
-- La cascade suit le §14.4 : ce qui est rendu a la suppression l est
-- entierement. La consommation d un Spark qui n existe plus ne repond a aucune
-- question qu on puisse encore poser.

-- @up
CREATE TABLE metric_sample (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    spark_id       TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    sampled_at     TEXT    NOT NULL,
    state          TEXT    NOT NULL,
    window_seconds REAL,
    cpu_used       REAL,
    memory_bytes   INTEGER,
    disk_bytes     INTEGER,
    net_rx_bps     INTEGER,
    net_tx_bps     INTEGER
);

-- Les deux routes de lecture filtrent par Spark puis par periode.
CREATE INDEX idx_metric_sample_spark ON metric_sample (spark_id, sampled_at);

-- La purge du §52.5 balaie par date, tous Sparks confondus. A sept jours de
-- retention elle passe sur des centaines de milliers de lignes : sans cet
-- index, chaque tic ferait un parcours complet de la table.
CREATE INDEX idx_metric_sample_date ON metric_sample (sampled_at);

-- @down
DROP INDEX idx_metric_sample_date;
DROP INDEX idx_metric_sample_spark;
DROP TABLE metric_sample;
