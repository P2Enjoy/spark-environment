-- @spec docs/BACKLOG.md#SPK-42 · docs/DAT.md §1 bis (glossaire : Forge, Spark,
--       console), §1 bis.1 (ce que le renommage change et ce qu'il ne change
--       pas) · docs/SCHEMA.md §2
--
-- La machine qui porte sparkd s'appelle desormais une FORGE. Elle etait appelee
-- « l'hote », mot deja pris par le processus Node du poste (§22) : le meme mot
-- designait deux machines, et la console affichait les deux.
--
-- Ce qui NE change PAS, et c'est deliberé : la colonne `hostname`. Elle porte le
-- nom RESEAU de la machine, au sens de TCP et d'OpenSSH — pas le nom du concept.
-- La renommer produirait un contresens, et le §1 bis.1 le dit.
--
-- SQLite renomme une table sans la recopier depuis 3.25, et met a jour les
-- references des cles etrangeres : aucune donnee ne bouge.

-- @up
ALTER TABLE host RENAME TO forge;

-- @down
ALTER TABLE forge RENAME TO host;
