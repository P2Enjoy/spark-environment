-- @spec docs/BACKLOG.md#SPK-111 · docs/DAT.md §59.1 (un lien privé est un
--       port publié dont la portée n'est pas Internet), §59.2 (le modèle :
--       l'unicité par portée, les ports réservés dans toute portée, la
--       suppression d'un réseau porteur refusée) · docs/SCHEMA.md §6 bis ·
--       docs/PROD_MIGRATIONS.md#OP-24
--
-- Un port publié gagne une PORTÉE : `internet` — ce qu'il était depuis la
-- migration 008 — ou un réseau privé du §58. Deux colonnes, parce qu'une
-- seule ne pouvait pas porter les deux garanties : `scope` est la clé
-- d'unicité — un port n'est unique que DANS sa portée, et `UNIQUE (scope,
-- public_port)` remplace `UNIQUE (public_port)` —, `network_id` est la clé
-- étrangère, en RESTRICT : la base refuse de supprimer un réseau qui porte un
-- lien, quoi que le service ait oublié de vérifier. Le CHECK lie les deux :
-- `scope` vaut `internet` sans réseau, ou l'identifiant du réseau.
--
-- SQLite ne modifie pas une contrainte UNIQUE en place : la table est
-- reconstruite, ses lignes recopiées telles quelles — un port sans portée
-- explicite vaut Internet, et rien ne change pour lui (§59.4).

-- @up
CREATE TABLE published_port_new (
    id           TEXT    PRIMARY KEY,
    public_port  INTEGER NOT NULL CHECK (public_port BETWEEN 1 AND 65535),
    spark_id     TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    target_port  INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
    protocol     TEXT    NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
    note         TEXT    NOT NULL DEFAULT '',
    applied_at   TEXT,
    created_at   TEXT    NOT NULL,
    scope        TEXT    NOT NULL DEFAULT 'internet',
    network_id   TEXT    REFERENCES private_network(id) ON DELETE RESTRICT,
    CHECK ((scope = 'internet' AND network_id IS NULL) OR scope = network_id),
    UNIQUE (scope, public_port)
);
INSERT INTO published_port_new (id, public_port, spark_id, target_port, protocol,
                                note, applied_at, created_at)
    SELECT id, public_port, spark_id, target_port, protocol, note, applied_at, created_at
    FROM published_port;
DROP INDEX idx_published_port_spark;
DROP TABLE published_port;
ALTER TABLE published_port_new RENAME TO published_port;
CREATE INDEX idx_published_port_spark ON published_port(spark_id);
CREATE INDEX idx_published_port_network ON published_port(network_id);

-- @down
-- Les liens n'ont pas de place dans l'ancienne table : ils sont retirés — le
-- contrat de déploiement le dit (OP-24). Les ports d'Internet sont conservés.
DELETE FROM published_port WHERE scope <> 'internet';
CREATE TABLE published_port_old (
    id           TEXT    PRIMARY KEY,
    public_port  INTEGER NOT NULL UNIQUE CHECK (public_port BETWEEN 1 AND 65535),
    spark_id     TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    target_port  INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
    protocol     TEXT    NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
    note         TEXT    NOT NULL DEFAULT '',
    applied_at   TEXT,
    created_at   TEXT    NOT NULL
);
INSERT INTO published_port_old (id, public_port, spark_id, target_port, protocol,
                                note, applied_at, created_at)
    SELECT id, public_port, spark_id, target_port, protocol, note, applied_at, created_at
    FROM published_port;
DROP INDEX idx_published_port_spark;
DROP INDEX idx_published_port_network;
DROP TABLE published_port;
ALTER TABLE published_port_old RENAME TO published_port;
CREATE INDEX idx_published_port_spark ON published_port(spark_id);
