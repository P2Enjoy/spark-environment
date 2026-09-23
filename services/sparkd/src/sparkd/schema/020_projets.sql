-- @spec docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.1 (un projet range, et rien
--       d'autre), §61.2 (au registre de la Forge ; nom de 1 à 40 caractères,
--       unique sans égard à la casse) · docs/SCHEMA.md §10 octies ·
--       docs/PROD_MIGRATIONS.md#OP-26
--
-- Un projet est une ÉTIQUETTE : aucune cellule, aucun quota, aucune route n'en
-- dépend. D'où les deux `CASCADE`, qui sont la règle du responsable :
-- supprimer un projet retire ses adhésions et ne touche aucun Spark ;
-- supprimer un Spark retire les siennes et ne touche aucun projet.
--
-- `COLLATE NOCASE` porte l'unicité dans la BASE, comme pour les réseaux
-- (§58.2) : deux créations simultanées ne passent pas. Il ne replie que
-- l'ASCII ; le service compare en plus les noms repliés (`casefold`) pour que
-- « Été » et « été » se refusent aussi (SCHEMA §10 octies).

-- @up
CREATE TABLE project (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE
                CHECK (length(name) BETWEEN 1 AND 40),
    created_at  TEXT NOT NULL
);

CREATE TABLE spark_project (
    spark_id    TEXT NOT NULL REFERENCES spark(id) ON DELETE CASCADE,
    project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    PRIMARY KEY (spark_id, project_id)
);

CREATE INDEX spark_project_by_project ON spark_project (project_id);

-- @down
DROP TABLE spark_project;
DROP TABLE project;
