-- @spec docs/BACKLOG.md#SPK-104 · docs/DAT.md §54 (les trois notes), §54.4 (le
--       registre écrit, la cellule propose), §54.9 (la surface d'API) ·
--       docs/SCHEMA.md §10 septies
--
-- Le §44.7 dit depuis toujours que le briefing « ne décrit pas l'application du
-- locataire ». Cette table porte ce que le produit ne peut pas savoir et que
-- ceux qui connaissent l'application écrivent pour les suivants.
--
-- Les notes sont une PROJECTION comme tout le reste : `/etc/spark/notes/*.md`
-- est régénéré depuis ces lignes, et ce qui vient de la cellule passe par le
-- fichier `.?` du §55. Il n'y a donc aucune empreinte de projection à retenir —
-- la première rédaction du §54 en avait besoin, la seconde l'a rendue inutile.
--
-- Le texte n'est pas chiffré, contrairement à `env_entry.value_enc`. Une note
-- est faite pour être lue, copiée et collée vers un tiers ; le §54.6 refuse
-- précisément qu'une valeur de secret y entre. Chiffrer un texte dont la raison
-- d'être est d'être publié donnerait une garantie fausse.
--
-- Une note JAMAIS ÉCRITE n'a pas de ligne. « Personne n'a encore écrit » n'est
-- pas « quelqu'un a écrit une chaîne vide », et les deux se lisent différemment
-- à l'écran (§14.6 du design system).

-- @up
CREATE TABLE spark_note (
    spark_id    TEXT NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    note_id     TEXT NOT NULL CHECK (note_id IN ('readme', 'contributors', 'install')),
    body        TEXT NOT NULL,
    revision    INTEGER NOT NULL CHECK (revision >= 1),
    origin      TEXT NOT NULL CHECK (origin IN ('console', 'suggestion')),
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (spark_id, note_id)
);

-- @down
DROP TABLE spark_note;
