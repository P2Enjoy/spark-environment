-- @spec docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §2 a §10, §12
-- Socle du registre : capacite de l'hote, topologie CPU, Sparks, ingress,
-- cles SSH, instantanes, sauvegardes et journal d'audit.

-- @up
CREATE TABLE host (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    hostname               TEXT    NOT NULL,
    cpu_threads_total      INTEGER NOT NULL CHECK (cpu_threads_total > 0),
    cpu_cores_total        INTEGER NOT NULL CHECK (cpu_cores_total > 0),
    memory_total_bytes     INTEGER NOT NULL CHECK (memory_total_bytes > 0),
    storage_total_bytes    INTEGER NOT NULL CHECK (storage_total_bytes > 0),
    network_total_bps      INTEGER NOT NULL CHECK (network_total_bps > 0),
    memory_reserve_bytes   INTEGER NOT NULL DEFAULT 0 CHECK (memory_reserve_bytes >= 0),
    storage_reserve_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (storage_reserve_bytes >= 0),
    overcommit_cpu         REAL    NOT NULL DEFAULT 1.0 CHECK (overcommit_cpu >= 1.0),
    overcommit_memory      REAL    NOT NULL DEFAULT 1.0 CHECK (overcommit_memory >= 1.0),
    overcommit_network     REAL    NOT NULL DEFAULT 1.0 CHECK (overcommit_network >= 1.0),
    topology_synced_at     TEXT
);

CREATE TABLE cpu_core (
    id         INTEGER PRIMARY KEY,
    socket_id  INTEGER NOT NULL,
    numa_node  INTEGER NOT NULL,
    core_id    INTEGER NOT NULL,
    pool       TEXT    NOT NULL DEFAULT 'shared' CHECK (pool IN ('shared', 'dedicated')),
    spark_id   TEXT    REFERENCES spark(id) ON DELETE SET NULL,
    UNIQUE (socket_id, core_id),
    -- Un coeur dedie appartient a un Spark, un coeur partage n'appartient a personne.
    CHECK ((pool = 'dedicated' AND spark_id IS NOT NULL)
        OR (pool = 'shared'    AND spark_id IS NULL))
);

CREATE TABLE cpu_thread (
    cpu_id   INTEGER PRIMARY KEY,
    core_id  INTEGER NOT NULL REFERENCES cpu_core(id) ON DELETE CASCADE
);

CREATE TABLE spark (
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

CREATE INDEX idx_spark_state ON spark(state);

CREATE TABLE spark_cpu_pin (
    spark_id  TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    core_id   INTEGER NOT NULL REFERENCES cpu_core(id) ON DELETE CASCADE,
    PRIMARY KEY (spark_id, core_id),
    -- docs/SCHEMA.md §5 : un coeur ne peut appartenir qu'a un seul Spark.
    UNIQUE (core_id)
);

CREATE TABLE ingress_route (
    id           TEXT    PRIMARY KEY,
    domain       TEXT    NOT NULL UNIQUE,
    spark_id     TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    target_port  INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
    tls          INTEGER NOT NULL DEFAULT 1 CHECK (tls IN (0, 1)),
    enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    applied_at   TEXT
);

CREATE INDEX idx_ingress_spark ON ingress_route(spark_id);

CREATE TABLE ssh_key (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL UNIQUE,
    public_key   TEXT NOT NULL,
    fingerprint  TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    -- docs/SCHEMA.md §7 : seules des cles PUBLIQUES sont stockees. Une cle
    -- privee commence par un en-tete PEM ; la base la refuse plutot que de
    -- compter sur la vigilance de l'appelant.
    CHECK (public_key NOT LIKE '%PRIVATE KEY%')
);

CREATE TABLE spark_ssh_key (
    spark_id    TEXT NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    ssh_key_id  TEXT NOT NULL REFERENCES ssh_key(id) ON DELETE CASCADE,
    PRIMARY KEY (spark_id, ssh_key_id)
);

CREATE TABLE snapshot (
    id          TEXT    PRIMARY KEY,
    spark_id    TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    incus_name  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    size_bytes  INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    stateful    INTEGER NOT NULL DEFAULT 0 CHECK (stateful IN (0, 1)),
    UNIQUE (spark_id, incus_name)
);

CREATE TABLE backup (
    id          TEXT    PRIMARY KEY,
    spark_id    TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    path        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    size_bytes  INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum    TEXT
);

CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    actor        TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    payload      TEXT,
    result       TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'error')),
    message      TEXT
);

CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);

-- @down
DROP INDEX IF EXISTS idx_audit_target;
DROP INDEX IF EXISTS idx_audit_ts;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS backup;
DROP TABLE IF EXISTS snapshot;
DROP TABLE IF EXISTS spark_ssh_key;
DROP TABLE IF EXISTS ssh_key;
DROP INDEX IF EXISTS idx_ingress_spark;
DROP TABLE IF EXISTS ingress_route;
DROP TABLE IF EXISTS spark_cpu_pin;
DROP INDEX IF EXISTS idx_spark_state;
DROP TABLE IF EXISTS spark;
DROP TABLE IF EXISTS cpu_thread;
DROP TABLE IF EXISTS cpu_core;
DROP TABLE IF EXISTS host;
