-- @spec docs/BACKLOG.md#SPK-58 · docs/DAT.md §43 (l'environnement d'un Spark),
--       §43.3 (la différence est DÉCLARÉE), §43.6 (général d'abord, surcharge
--       ensuite), §43.9.1 (le modèle) · docs/SCHEMA.md §10 ter
--
-- UNE table pour les DEUX portées. Les deux niveaux du §43.6 partagent
-- exactement les mêmes colonnes et les mêmes règles ; deux tables imposeraient
-- d'écrire deux fois la validation du nom, deux fois le chiffrement, deux fois
-- la résolution — et de les faire diverger.

-- @up
CREATE TABLE env_entry (
    id          TEXT    PRIMARY KEY,
    scope       TEXT    NOT NULL CHECK (scope IN ('forge', 'spark')),
    spark_id    TEXT             REFERENCES spark(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    is_secret   INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
    value       TEXT,
    value_enc   TEXT,
    fingerprint TEXT,
    updated_at  TEXT    NOT NULL,

    -- `spark_id` est NULL SI ET SEULEMENT SI la portee est la Forge. Sans cette
    -- contrainte, une entree « forge » rattachee a un Spark serait heritee par
    -- tous et supprimee avec un seul.
    CHECK ((scope = 'forge') = (spark_id IS NULL)),

    -- La grammaire du shell. Un nom qui ne s'exporte pas produirait un fichier
    -- qu'`env_file:` refuse, et la panne se lirait chez le locataire, loin du
    -- geste qui l'a causee.
    CHECK (name GLOB '[A-Za-z_]*'
           AND NOT name GLOB '*[^A-Za-z0-9_]*'
           AND length(name) BETWEEN 1 AND 128)
);

-- DEUX index PARTIELS, et c'est une contrainte de SQLite et non un choix de
-- style : un UNIQUE (scope, spark_id, name) ne protegerait RIEN au niveau
-- Forge, SQLite tenant deux NULL pour distincts.
CREATE UNIQUE INDEX env_entry_forge_nom
    ON env_entry (name) WHERE scope = 'forge';
CREATE UNIQUE INDEX env_entry_spark_nom
    ON env_entry (spark_id, name) WHERE scope = 'spark';

-- Lire l'environnement d'un Spark est le geste le plus frequent : il a lieu a
-- chaque application, a chaque demarrage et apres chaque restauration.
CREATE INDEX env_entry_par_spark ON env_entry (spark_id) WHERE scope = 'spark';

-- La coherence des trois colonnes de valeur, tenue par la BASE et non par le
-- code appelant — comme au §10 bis pour la signature d'un geste. Une ligne
-- secrete qui porterait sa valeur en clair serait exactement la fuite que
-- l'unite existe pour empecher.
CREATE TRIGGER env_entry_valeur_coherente_insert
BEFORE INSERT ON env_entry
WHEN (NEW.is_secret = 1) <> (NEW.value IS NULL)
  OR (NEW.is_secret = 1) <> (NEW.value_enc IS NOT NULL)
  OR (NEW.is_secret = 1) <> (NEW.fingerprint IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'une entree secrete porte un chiffre et une empreinte, jamais de valeur en clair');
END;

CREATE TRIGGER env_entry_valeur_coherente_update
BEFORE UPDATE ON env_entry
WHEN (NEW.is_secret = 1) <> (NEW.value IS NULL)
  OR (NEW.is_secret = 1) <> (NEW.value_enc IS NOT NULL)
  OR (NEW.is_secret = 1) <> (NEW.fingerprint IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'une entree secrete porte un chiffre et une empreinte, jamais de valeur en clair');
END;

-- @down
-- IRREVERSIBLE pour les secrets : le chiffre part avec la ligne, et le
-- reappliquer ne le ramene pas (docs/SCHEMA.md §10 ter).
DROP TRIGGER env_entry_valeur_coherente_update;
DROP TRIGGER env_entry_valeur_coherente_insert;
DROP INDEX env_entry_par_spark;
DROP INDEX env_entry_spark_nom;
DROP INDEX env_entry_forge_nom;
DROP TABLE env_entry;
