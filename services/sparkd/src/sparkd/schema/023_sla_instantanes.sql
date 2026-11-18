-- @spec docs/BACKLOG.md#SPK-182 · docs/SCHEMA.md §8 ter (`sla` et
--       `snapshot.origin`) · docs/DAT.md §74.2 (la politique), §74.4 (le nom et la
--       provenance), §74.6 (la rétention ne touche que ce qui est à elle)
--
-- Le SLA des instantanés : une politique par Spark — une fréquence en chaîne
-- crontab, une rétention par âge et/ou par nombre — et la PROVENANCE de chaque
-- instantané. La rétention supprime sans qu'on le lui demande : elle ne doit
-- jamais pouvoir toucher un instantané manuel, et elle ne le sait que si le
-- registre le dit. D'où `origin`, qui porte la provenance et non le nom.
--
-- Le CHECK de `sla` impose AU MOINS UNE rétention, dans la base et pas
-- seulement dans l'API : un SLA sans rétention accumule des instantanés qui
-- comptent dans le quota du Spark (§19.4).
--
-- Les instantanés existants reçoivent `manual` : aucune ligne n'est devinée.
-- Le `down` supprime la politique, jamais un instantané.

-- @up
CREATE TABLE sla (
    spark_id         TEXT    PRIMARY KEY REFERENCES spark(id) ON DELETE CASCADE,
    enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    schedule         TEXT    NOT NULL,
    retention_days   INTEGER CHECK (retention_days  IS NULL OR retention_days  BETWEEN 1 AND 3650),
    retention_count  INTEGER CHECK (retention_count IS NULL OR retention_count BETWEEN 1 AND 1000),
    next_run_at      TEXT,
    last_run_at      TEXT,
    last_status      TEXT    CHECK (last_status IS NULL OR last_status IN ('ok', 'error', 'skipped')),
    last_error       TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    CHECK (retention_days IS NOT NULL OR retention_count IS NOT NULL)
);

ALTER TABLE snapshot ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'sla'));

-- @down
ALTER TABLE snapshot DROP COLUMN origin;
DROP TABLE sla;
