-- @spec docs/BACKLOG.md#SPK-110 · docs/DAT.md §58.2 (le modèle : sous-réseau
--       et adresses attribués par le registre, un nom DNS unique, la cascade
--       sur le Spark), §58.3 (le pool, porté par cette migration) ·
--       docs/SCHEMA.md §6 ter · docs/PROD_MIGRATIONS.md#OP-23
--
-- Un réseau privé est un COMMUTATEUR interne à la Forge (§58.1) : un nom, un
-- sous-réseau, des membres. Le registre attribue le sous-réseau sur le pool et
-- l'adresse de chaque membre sur son réseau — comme il attribue les adresses de
-- `sparkbr0` (§15.1) —, et Incus épingle.
--
-- L'unicité du nom et du sous-réseau est portée par la BASE (§18.4, §39.5) :
-- deux créations simultanées ne peuvent pas obtenir le même. La cascade sur
-- `spark_id` suit celle des routes et des ports : une adhésion qui survivrait
-- à son Spark serait une adresse promise à rien. La cascade sur `network_id`
-- ne sert jamais par le produit — supprimer un réseau habité est REFUSÉ
-- (§58.4) —, elle garde la base cohérente si quelqu'un passe à côté.
--
-- `cell_configured` dit si le produit a pu configurer l'interface DANS la
-- cellule (§58.6 : familles à networkd) ; `cell_note` porte la raison sinon.
-- Ce n'est pas un état déduit : c'est ce que le geste a constaté.
--
-- Le pool des réseaux privés vit sur la ligne unique de `forge`, avec sa valeur
-- du 2026-09-17. Le champ du plan d'installation qui la rendrait réglable est
-- différé (§58.3) ; la colonne existe pour qu'il n'y ait qu'un endroit à lire.

-- @up
CREATE TABLE private_network (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    cidr        TEXT NOT NULL UNIQUE,
    note        TEXT NOT NULL DEFAULT '',
    applied_at  TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE private_network_member (
    network_id       TEXT NOT NULL REFERENCES private_network(id) ON DELETE CASCADE,
    spark_id         TEXT NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    ipv4_address     TEXT NOT NULL,
    applied_at       TEXT,
    cell_configured  INTEGER NOT NULL DEFAULT 0 CHECK (cell_configured IN (0, 1)),
    cell_note        TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    PRIMARY KEY (network_id, spark_id),
    UNIQUE (network_id, ipv4_address)
);

ALTER TABLE forge ADD COLUMN private_pool_cidr TEXT NOT NULL DEFAULT '10.78.0.0/16';

-- @down
ALTER TABLE forge DROP COLUMN private_pool_cidr;
DROP TABLE private_network_member;
DROP TABLE private_network;
