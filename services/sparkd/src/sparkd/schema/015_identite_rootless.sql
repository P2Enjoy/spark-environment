-- @spec docs/BACKLOG.md#SPK-94 · docs/DAT.md §42.2 ter (le uid et le gid sont
--       relevés, jamais inventés) · docs/SCHEMA.md §10 quinquies
--
-- Le compte rootless possede le demon, et c'est lui qui lit `env_file:` quand
-- Compose tourne. Pour lui ouvrir les fichiers que sparkd pose, il faut son
-- identite NUMERIQUE — `useradd` ne garantit aucun UID particulier, et cette
-- identite appartient a la cellule.
--
-- Les deux colonnes restent NULL tant que le mode releve n'est pas `rootless` :
-- un compte present sans demon utilisable ne donne pas plus d'identite qu'il ne
-- donne de mode (§42.2 bis).

-- @up
ALTER TABLE spark_bootstrap_observation ADD COLUMN docker_uid INTEGER;
ALTER TABLE spark_bootstrap_observation ADD COLUMN docker_gid INTEGER;

-- @down
ALTER TABLE spark_bootstrap_observation DROP COLUMN docker_gid;
ALTER TABLE spark_bootstrap_observation DROP COLUMN docker_uid;
