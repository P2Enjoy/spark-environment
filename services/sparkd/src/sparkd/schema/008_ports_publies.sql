-- @spec docs/BACKLOG.md#SPK-49 · docs/DAT.md §39 (les ports publiés), §39.2 (un
--       port public est une ressource de la FORGE), §39.5 (le modèle et où vit
--       l'unicité) · docs/SCHEMA.md §6 bis
--
-- Un serveur SMTP reçoit une connexion sur le port 25 sans qu'aucun nom ne soit
-- prononcé ; Postgres, Redis, SSH et MQTT sont dans le même cas. Le proxy du
-- §18 ne peut rien pour eux : le seul élément qui désigne le Spark destinataire
-- est le PORT sur lequel la connexion est arrivée.
--
-- `public_port` est UNIQUE, et c'est le coeur du modèle : un port public
-- appartient à la MACHINE, pas au Spark. Le premier qui le prend le prend, et
-- c'est la base qui refuse le doublon — une interface ne protégerait de rien
-- face à deux requêtes simultanées (§18.4, transposé).
--
-- La cascade suit celle d'`ingress_route` : un port qui survivrait à son Spark
-- serait un port ouvert vers rien.

-- @up
CREATE TABLE published_port (
    id           TEXT    PRIMARY KEY,
    public_port  INTEGER NOT NULL UNIQUE CHECK (public_port BETWEEN 1 AND 65535),
    spark_id     TEXT    NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    target_port  INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
    protocol     TEXT    NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
    note         TEXT    NOT NULL DEFAULT '',
    applied_at   TEXT,
    created_at   TEXT    NOT NULL
);

CREATE INDEX idx_published_port_spark ON published_port(spark_id);

-- @down
DROP INDEX idx_published_port_spark;
DROP TABLE published_port;
