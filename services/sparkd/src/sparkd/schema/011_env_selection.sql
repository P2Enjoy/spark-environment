-- @spec docs/BACKLOG.md#SPK-64 · docs/DAT.md §43.6 révisé (la Forge propose, le
--       Spark choisit), §43.5.1 (la valeur redevient en clair dans la cellule) ·
--       docs/SCHEMA.md §10 quater
--
-- SPK-58 faisait descendre TOUTE entree du catalogue dans TOUS les Sparks. Comme
-- la valeur redevient en clair dans la cellule, definir un secret une fois a la
-- Forge le deposait en clair dans trente cellules — y compris celles qui n'en
-- ont aucun usage. Cette table rend la descente EXPLICITE.

-- @up
CREATE TABLE env_selection (
    spark_id    TEXT NOT NULL REFERENCES spark(id)     ON DELETE CASCADE,
    entry_id    TEXT NOT NULL REFERENCES env_entry(id) ON DELETE CASCADE,
    selected_at TEXT NOT NULL,

    -- Une case cochee deux fois n'a pas de sens, et la cle primaire suffit a
    -- l'interdire : le geste est idempotent par construction.
    PRIMARY KEY (spark_id, entry_id)
);

-- On reference l'IDENTIFIANT de l'entree, jamais son nom. Renommer une entree du
-- catalogue garde donc les cases cochees, et la supprimer les retire toutes par
-- cascade — sans quoi une case survivrait a ce qu'elle designe.
CREATE INDEX env_selection_entree ON env_selection (entry_id);

-- Seule une entree de la FORGE se coche. Une entree propre a un Spark est deja
-- chez lui : la cocher n'aurait aucun sens et ferait croire a un second
-- mecanisme. La contrainte ne peut pas s'ecrire en CHECK — elle porte sur une
-- autre table — d'ou le declencheur.
CREATE TRIGGER env_selection_forge_seulement
BEFORE INSERT ON env_selection
WHEN (SELECT scope FROM env_entry WHERE id = NEW.entry_id) <> 'forge'
BEGIN
    SELECT RAISE(ABORT, 'Seule une entree du catalogue de la Forge se coche.');
END;

-- MIGRATION DE L'EXISTANT — le point qui decide de cette migration.
--
-- Avant elle, chaque Spark recevait TOUT le catalogue. Ne rien cocher retirerait
-- donc, au premier geste suivant, des variables dont des piles en marche
-- dependent : une correction de securite qui casse la production est un mauvais
-- echange. On coche donc pour chaque Spark existant ce qu'il recevait deja.
--
-- Le comportement observable ne change pas ici. Ce sont les AJOUTS SUIVANTS qui
-- cessent de descendre tout seuls.
INSERT INTO env_selection (spark_id, entry_id, selected_at)
SELECT s.id, e.id, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
  FROM spark s, env_entry e
 WHERE e.scope = 'forge';

-- @down
DROP TRIGGER env_selection_forge_seulement;
DROP INDEX env_selection_entree;
DROP TABLE env_selection;
