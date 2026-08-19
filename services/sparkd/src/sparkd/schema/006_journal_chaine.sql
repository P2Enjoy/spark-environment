-- @spec docs/BACKLOG.md#SPK-38 · docs/SCHEMA.md §9.2 · docs/DAT.md §36.1 (ce
--       qu'une chaine prouve, et contre qui), §36.5 (les pieges), §36.9 (le
--       contrat ligne a ligne)
--
-- Chaque entree porte l'empreinte de la precedente. Cela detecte la
-- MODIFICATION et la SUPPRESSION AU MILIEU — pas la troncature ni le
-- remplacement, que seule l'ancre tenue par la console voit (§36.1, §36.9.6).
--
-- Les lignes ANTERIEURES ne sont PAS chainees retroactivement. Recalculer leurs
-- empreintes produirait une chaine que rien n'atteste : elle prouverait
-- seulement que la migration sait calculer un sha256. Elles gardent donc la
-- chaine vide, ce qui les rend reconnaissables, et la verification les traverse
-- sans les juger.

-- @up
-- Defaut : chaine vide. Une ligne ancienne se distingue ainsi d'une ligne
-- chainee, et la verification sait ou commence ce qu'elle peut prouver.
ALTER TABLE audit_log ADD COLUMN entry_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN prev_hash  TEXT NOT NULL DEFAULT '';

-- La verification remonte la chaine depuis la tete : c'est l'ordre des `id`
-- qu'elle suit, et `prev_hash` qu'elle compare.
CREATE INDEX audit_log_chaine ON audit_log (id, prev_hash);

-- @down
DROP INDEX audit_log_chaine;
ALTER TABLE audit_log DROP COLUMN prev_hash;
ALTER TABLE audit_log DROP COLUMN entry_hash;
