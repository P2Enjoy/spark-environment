-- @spec docs/BACKLOG.md#SPK-184 · docs/SCHEMA.md §8 quater (`health_check` et
--       `health_result`) · docs/DAT.md §75 (la santé d'un Spark), §75.6 (la
--       machine à états), §75.3 (la sonde HTTPS), §75.5 (le script)
--
-- Les sondes d'un Spark et leurs derniers relevés. Une sonde est un type
-- (`http` ou `script`), une cible, un résultat attendu, une cadence en chaîne
-- crontab, un seuil d'échecs consécutifs, et un ÉTAT qui ne change qu'à la
-- transition — c'est lui, jamais un relevé, qui déclenche une alerte (§75.7).
--
-- `health_result` est BORNÉ par l'écriture (au plus 100 relevés par sonde,
-- §75.8) : une table qui grossit sans borne finit par peser plus que ce qu'elle
-- surveille. Aucun corps de réponse et aucune sortie de script n'y entrent :
-- `detail` est un motif court. Une sortie de script peut contenir un secret.
--
-- Le `down` supprime les deux tables : l'historique d'une sonde n'a pas d'autre
-- foyer. Aucun Spark ni instantané n'est touché.

-- @up
CREATE TABLE health_check (
    id                    TEXT    PRIMARY KEY,
    spark_id              TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    name                  TEXT    NOT NULL,
    kind                  TEXT    NOT NULL CHECK (kind IN ('http', 'script')),
    target                TEXT    NOT NULL,
    expected              INTEGER NOT NULL,
    schedule              TEXT    NOT NULL,
    threshold             INTEGER NOT NULL CHECK (threshold BETWEEN 1 AND 20),
    enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    state                 TEXT    NOT NULL DEFAULT 'unknown' CHECK (state IN
                              ('unknown', 'healthy', 'unstable', 'down', 'stopped')),
    consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    state_since           TEXT,
    next_run_at           TEXT,
    last_run_at           TEXT,
    last_latency_ms       INTEGER,
    last_detail           TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL,
    UNIQUE (spark_id, name)
);

CREATE TABLE health_result (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id    TEXT    NOT NULL REFERENCES health_check(id) ON DELETE CASCADE,
    run_at      TEXT    NOT NULL,
    ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
    latency_ms  INTEGER,
    detail      TEXT
);

CREATE INDEX health_result_par_sonde ON health_result (check_id, id);

-- @down
DROP INDEX health_result_par_sonde;
DROP TABLE health_result;
DROP TABLE health_check;
