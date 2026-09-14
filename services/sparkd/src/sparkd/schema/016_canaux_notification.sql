-- @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (deux canaux, réglés depuis
--       un onglet), §47.3.1 (le gabarit), §47.3.2 (ce que SMTP suppose),
--       §47.3.3 (toute modification demande un mot de passe) ·
--       docs/SCHEMA.md §11
--
-- La configuration du canal hors bande QUITTE les variables d'environnement.
-- Motif écrit au §47.3 : une variable se règle par un redémarrage du service et
-- ne se voit nulle part ; un canal qu'on ne peut ni voir ni éprouver depuis
-- l'écran est un canal dont on ne sait pas s'il veille.
--
-- UNE SEULE LIGNE, et c'est délibéré. Le §47.3 décide deux canaux — un webhook
-- et un SMTP — activables séparément, pas N canaux du même genre. Une table de
-- lignes libres inviterait à en poser trois, et il faudrait alors décider ce que
-- « l'échec de l'un n'empêche pas l'autre » veut dire à trois. La contrainte
-- `id = 1` rend cette question impossible à poser par accident.
--
-- Le mot de passe du §47.3.3 emploie le MÊME mécanisme que la protection d'un
-- Spark (§35.3) : `scrypt`, sel propre, empreinte au registre, jamais la valeur.
-- En écrire un second donnerait deux endroits où un mot de passe peut fuir.
--
-- `smtp_password_secret` ne porte PAS le mot de passe : il porte le NOM de
-- l'entrée chiffrée du §43.3, qui est le seul endroit où un secret vit.

-- @up
CREATE TABLE notify_channels (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),

  -- Le garde du §47.3.3. NULL tant qu'aucun mot de passe n'a été fixé : le
  -- premier usage le pose, et c'est la seule écriture qui n'en exige pas un.
  guard_hash            TEXT,
  guard_salt            TEXT,
  guard_params          TEXT,
  guard_set_at          TEXT,

  -- Le webhook. `enabled` est distinct de « configuré » : on garde une URL en
  -- la désactivant, sans avoir à la retaper pour la remettre (§14.6 — les états
  -- se distinguent au lieu de se confondre dans un champ vide).
  webhook_enabled       INTEGER NOT NULL DEFAULT 0,
  webhook_url           TEXT,
  webhook_template      TEXT,

  -- Le SMTP du §47.3.2.
  smtp_enabled          INTEGER NOT NULL DEFAULT 0,
  smtp_host             TEXT,
  smtp_port             INTEGER,
  smtp_tls              TEXT,
  smtp_username         TEXT,
  smtp_password_secret  TEXT,
  smtp_from             TEXT,
  smtp_to               TEXT,

  updated_at            TEXT NOT NULL,
  updated_by            TEXT
);

-- La ligne existe TOUJOURS, dès la migration : l'écran lit un état, jamais une
-- absence de ligne. « Aucun canal » se dit par `enabled = 0`, ce qui est un
-- fait ; une table vide serait une question sans réponse.
INSERT INTO notify_channels (id, updated_at, updated_by)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'migration 016');

-- @down
DROP TABLE notify_channels;
