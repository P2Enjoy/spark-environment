-- @spec docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.3 (paquets releves), §44.4
--       (date du releve), §44.8 (modele unique du briefing) · docs/SCHEMA.md
--       §10 quinquies
--
-- Le briefing ne reconstitue pas retrospectivement une installation depuis
-- l'etat courant de la cellule : cette ligne garde le RELEVE date de
-- l'amorcage et les composants que sparkd a reellement changes.

-- @up
CREATE TABLE spark_bootstrap_observation (
    spark_id          TEXT PRIMARY KEY REFERENCES spark(id) ON DELETE CASCADE,
    observed_at       TEXT NOT NULL,
    openssh_version   TEXT,
    docker_version    TEXT,
    compose_version   TEXT,
    docker_mode       TEXT CHECK (docker_mode IN ('enracine', 'rootless') OR docker_mode IS NULL),
    managed_items     TEXT NOT NULL DEFAULT '[]'
);

-- @down
DROP TABLE spark_bootstrap_observation;
