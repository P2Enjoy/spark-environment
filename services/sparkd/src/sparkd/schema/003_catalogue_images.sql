-- @spec docs/BACKLOG.md#SPK-32 · docs/SCHEMA.md · docs/DAT.md §33.2 (un
--       catalogue tenu par le registre), §33.3 (la verification est un releve)
--
-- `spark.image` est un texte libre : le seul controle porte sur le DEPOT, pas
-- sur l'alias. `images:debian/31` passe donc tous les controles locaux, la ligne
-- du registre est ecrite, la ressource comptee, et le refus ne vient qu'a
-- `apply`. Une faute de frappe coute une ligne morte et une part de pool
-- immobilisee.
--
-- Le catalogue rend cette erreur connaissable AVANT d'ecrire quoi que ce soit.

-- @up
CREATE TABLE image_catalog (
    id           TEXT    PRIMARY KEY,
    -- Ce que l'exploitant ecrit et ce que le traducteur recevra.
    reference    TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL,
    remote       TEXT    NOT NULL,
    alias        TEXT    NOT NULL,
    architecture TEXT    NOT NULL DEFAULT 'amd64',
    -- Trois etats, jamais confondus (docs/DAT.md §33.3). `unknown` par defaut :
    -- une entree jamais relevee n'est pas une entree absente.
    state        TEXT    NOT NULL DEFAULT 'unknown'
                 CHECK (state IN ('verified', 'missing', 'unknown')),
    -- Date du dernier releve. NULL tant qu'il n'y en a pas eu : une capacite
    -- sans date serait crue a jour (meme regle qu'au §27.8).
    verified_at  TEXT,
    -- Ce que le releve a constate, pour que l'ecart soit lisible sans remesurer.
    detail       TEXT    NOT NULL DEFAULT '',
    -- L'entree par defaut de la liste deroulante (docs/DAT.md §33.5).
    is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at   TEXT    NOT NULL,
    UNIQUE (remote, alias, architecture)
);

CREATE INDEX image_catalog_state ON image_catalog (state);

-- @down
DROP INDEX image_catalog_state;
DROP TABLE image_catalog;
