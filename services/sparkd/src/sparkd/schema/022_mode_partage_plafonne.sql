-- @spec docs/BACKLOG.md#SPK-152 · docs/SCHEMA.md §4 (cpu_mode, cpu_max),
--       §12.3 bis (reconstruire une table parente, cles etrangeres suspendues)
--       · docs/DAT.md §7.2, §7.2 quater (le mode partage plafonne), §7.7
--
-- Le cinquieme mode CPU, `shared-capped`, porte une reservation ET un plafond.
-- SQLite ne modifie pas un CHECK existant : la table `spark` est reconstruite,
-- a l'identique sauf ses deux CHECK de mode. Elle est PARENTE d'une quinzaine
-- de tables en `ON DELETE CASCADE` : cles etrangeres actives, `DROP TABLE spark`
-- emporterait leurs lignes. D'ou la ligne qui demande au moteur de les
-- suspendre (§12.3 bis) ; il verifie les references avant de valider.
--
-- Aucune donnee n'est transformee : chaque ligne est recopiee telle quelle, les
-- quatre colonnes de protection comprises (migration 004), puis les index et
-- les declencheurs de `spark` sont recrees.

-- @up
-- @cles-etrangeres: suspendues
CREATE TABLE spark_022 (
    id                        TEXT PRIMARY KEY,
    name                      TEXT NOT NULL UNIQUE,
    state                     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
                                  'pending', 'creating', 'stopped', 'starting',
                                  'running', 'stopping', 'error', 'deleting')),
    runtime                   TEXT NOT NULL DEFAULT 'container' CHECK (runtime IN ('container', 'vm')),
    image                     TEXT NOT NULL,
    cpu_mode                  TEXT NOT NULL CHECK (cpu_mode IN (
                                  'shared', 'capped', 'dedicated', 'shared-pinned',
                                  'shared-capped')),
    cpu_reservation           REAL    CHECK (cpu_reservation IS NULL OR cpu_reservation > 0),
    cpu_max                   REAL    CHECK (cpu_max IS NULL OR cpu_max > 0),
    cpu_cores                 INTEGER CHECK (cpu_cores IS NULL OR cpu_cores > 0),
    cpu_priority              INTEGER NOT NULL DEFAULT 5 CHECK (cpu_priority BETWEEN 0 AND 10),
    memory_reservation_bytes  INTEGER NOT NULL CHECK (memory_reservation_bytes > 0),
    memory_enforce            TEXT    NOT NULL DEFAULT 'hard' CHECK (memory_enforce IN ('hard', 'soft')),
    memory_swap               INTEGER NOT NULL DEFAULT 0 CHECK (memory_swap IN (0, 1)),
    network_reservation_bps   INTEGER NOT NULL CHECK (network_reservation_bps > 0),
    network_burst_bps         INTEGER CHECK (network_burst_bps IS NULL OR network_burst_bps > 0),
    storage_bytes             INTEGER NOT NULL CHECK (storage_bytes > 0),
    storage_io_priority       INTEGER NOT NULL DEFAULT 5 CHECK (storage_io_priority BETWEEN 0 AND 10),
    ipv4_address              TEXT UNIQUE,
    incus_name                TEXT UNIQUE,
    docker_enabled            INTEGER NOT NULL DEFAULT 1 CHECK (docker_enabled IN (0, 1)),
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    last_error                TEXT,
    protected_at              TEXT,
    protection_hash           TEXT,
    protection_salt           TEXT,
    protection_params         TEXT,

    -- docs/SCHEMA.md §4 : coherence des modes CPU. Portee par la base ET
    -- revalidee en Python, parce qu'un CHECK ne produit pas de message lisible.
    CHECK (
        (cpu_mode = 'shared'        AND cpu_reservation IS NOT NULL AND cpu_max IS NULL     AND cpu_cores IS NULL)
     OR (cpu_mode = 'capped'        AND cpu_max         IS NOT NULL AND cpu_reservation IS NULL AND cpu_cores IS NULL)
     OR (cpu_mode = 'dedicated'     AND cpu_cores       IS NOT NULL AND cpu_reservation IS NULL AND cpu_max IS NULL)
     OR (cpu_mode = 'shared-pinned' AND cpu_cores       IS NOT NULL AND cpu_reservation IS NOT NULL)
     -- SPK-152 · DAT §7.2 quater : une reservation ET un plafond, le plafond
     -- jamais sous le plancher qu'il borne.
     OR (cpu_mode = 'shared-capped' AND cpu_reservation IS NOT NULL AND cpu_max IS NOT NULL
                                    AND cpu_cores IS NULL AND cpu_max >= cpu_reservation)
    ),
    -- La rafale ne descend jamais sous la reservation comptabilisee.
    CHECK (network_burst_bps IS NULL OR network_burst_bps >= network_reservation_bps)
);

INSERT INTO spark_022 SELECT * FROM spark;
DROP TABLE spark;
ALTER TABLE spark_022 RENAME TO spark;

CREATE INDEX idx_spark_state ON spark(state);
CREATE INDEX spark_protected ON spark (protected_at) WHERE protected_at IS NOT NULL;

CREATE TRIGGER spark_protection_coherente_insert
AFTER INSERT ON spark
WHEN ( (NEW.protected_at      IS NULL) + (NEW.protection_hash   IS NULL)
     + (NEW.protection_salt   IS NULL) + (NEW.protection_params IS NULL) ) NOT IN (0, 4)
BEGIN
    SELECT RAISE(ABORT, 'protection incoherente : les quatre colonnes vont ensemble');
END;

CREATE TRIGGER spark_protection_coherente_update
AFTER UPDATE ON spark
WHEN ( (NEW.protected_at      IS NULL) + (NEW.protection_hash   IS NULL)
     + (NEW.protection_salt   IS NULL) + (NEW.protection_params IS NULL) ) NOT IN (0, 4)
BEGIN
    SELECT RAISE(ABORT, 'protection incoherente : les quatre colonnes vont ensemble');
END;

-- @down
-- @cles-etrangeres: suspendues
-- Refuse tant qu'un Spark est dans ce mode : la table d'avant ne saurait pas le
-- porter, et le CHECK de la copie le dirait sans nommer la cause.
CREATE TEMP TABLE retour_022 (
    sparks_en_mode_shared_capped INTEGER
        CONSTRAINT "retour arriere refuse : un Spark au moins est en mode shared-capped ; repassez-le dans un autre mode d'abord"
        CHECK (sparks_en_mode_shared_capped = 0)
);
INSERT INTO retour_022 SELECT count(*) FROM spark WHERE cpu_mode = 'shared-capped';
DROP TABLE retour_022;

CREATE TABLE spark_021 (
    id                        TEXT PRIMARY KEY,
    name                      TEXT NOT NULL UNIQUE,
    state                     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
                                  'pending', 'creating', 'stopped', 'starting',
                                  'running', 'stopping', 'error', 'deleting')),
    runtime                   TEXT NOT NULL DEFAULT 'container' CHECK (runtime IN ('container', 'vm')),
    image                     TEXT NOT NULL,
    cpu_mode                  TEXT NOT NULL CHECK (cpu_mode IN (
                                  'shared', 'capped', 'dedicated', 'shared-pinned')),
    cpu_reservation           REAL    CHECK (cpu_reservation IS NULL OR cpu_reservation > 0),
    cpu_max                   REAL    CHECK (cpu_max IS NULL OR cpu_max > 0),
    cpu_cores                 INTEGER CHECK (cpu_cores IS NULL OR cpu_cores > 0),
    cpu_priority              INTEGER NOT NULL DEFAULT 5 CHECK (cpu_priority BETWEEN 0 AND 10),
    memory_reservation_bytes  INTEGER NOT NULL CHECK (memory_reservation_bytes > 0),
    memory_enforce            TEXT    NOT NULL DEFAULT 'hard' CHECK (memory_enforce IN ('hard', 'soft')),
    memory_swap               INTEGER NOT NULL DEFAULT 0 CHECK (memory_swap IN (0, 1)),
    network_reservation_bps   INTEGER NOT NULL CHECK (network_reservation_bps > 0),
    network_burst_bps         INTEGER CHECK (network_burst_bps IS NULL OR network_burst_bps > 0),
    storage_bytes             INTEGER NOT NULL CHECK (storage_bytes > 0),
    storage_io_priority       INTEGER NOT NULL DEFAULT 5 CHECK (storage_io_priority BETWEEN 0 AND 10),
    ipv4_address              TEXT UNIQUE,
    incus_name                TEXT UNIQUE,
    docker_enabled            INTEGER NOT NULL DEFAULT 1 CHECK (docker_enabled IN (0, 1)),
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    last_error                TEXT,
    protected_at              TEXT,
    protection_hash           TEXT,
    protection_salt           TEXT,
    protection_params         TEXT,

    -- docs/SCHEMA.md §4 : coherence des modes CPU. Portee par la base ET
    -- revalidee en Python, parce qu'un CHECK ne produit pas de message lisible.
    CHECK (
        (cpu_mode = 'shared'        AND cpu_reservation IS NOT NULL AND cpu_max IS NULL     AND cpu_cores IS NULL)
     OR (cpu_mode = 'capped'        AND cpu_max         IS NOT NULL AND cpu_reservation IS NULL AND cpu_cores IS NULL)
     OR (cpu_mode = 'dedicated'     AND cpu_cores       IS NOT NULL AND cpu_reservation IS NULL AND cpu_max IS NULL)
     OR (cpu_mode = 'shared-pinned' AND cpu_cores       IS NOT NULL AND cpu_reservation IS NOT NULL)
    ),
    -- La rafale ne descend jamais sous la reservation comptabilisee.
    CHECK (network_burst_bps IS NULL OR network_burst_bps >= network_reservation_bps)
);

INSERT INTO spark_021 SELECT * FROM spark;
DROP TABLE spark;
ALTER TABLE spark_021 RENAME TO spark;

CREATE INDEX idx_spark_state ON spark(state);
CREATE INDEX spark_protected ON spark (protected_at) WHERE protected_at IS NOT NULL;

CREATE TRIGGER spark_protection_coherente_insert
AFTER INSERT ON spark
WHEN ( (NEW.protected_at      IS NULL) + (NEW.protection_hash   IS NULL)
     + (NEW.protection_salt   IS NULL) + (NEW.protection_params IS NULL) ) NOT IN (0, 4)
BEGIN
    SELECT RAISE(ABORT, 'protection incoherente : les quatre colonnes vont ensemble');
END;

CREATE TRIGGER spark_protection_coherente_update
AFTER UPDATE ON spark
WHEN ( (NEW.protected_at      IS NULL) + (NEW.protection_hash   IS NULL)
     + (NEW.protection_salt   IS NULL) + (NEW.protection_params IS NULL) ) NOT IN (0, 4)
BEGIN
    SELECT RAISE(ABORT, 'protection incoherente : les quatre colonnes vont ensemble');
END;
