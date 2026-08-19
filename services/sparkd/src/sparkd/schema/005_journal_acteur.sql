-- @spec docs/BACKLOG.md#SPK-37 · docs/SCHEMA.md §9.1 · docs/DAT.md §21.6
--       (qui a agi), §21.6.1 (deux classes), §21.6.4 (le journal ne se recrit
--       pas par megarde), §36.4, §36.7
--
-- Deux choses, et elles vont ensemble.
--
-- 1. La CLASSE de l'acteur. Un geste humain et un evenement du runtime ne se
--    distinguaient pas ; les afficher pareillement laisserait croire que le
--    second est signe par quelqu'un — il ne l'est par personne, et ne le sera
--    jamais (§36.4).
--
-- 2. Le VERROU. Une table qu'on s'interdit d'ecraser par discipline est une
--    table qu'on ecrasera : le premier script de maintenance ecrit a deux
--    heures du matin suffit. Le verrou protege de l'ERREUR, pas de root, qui
--    peut supprimer les declencheurs — ce qui protege de root est l'ancre
--    tenue ailleurs (§36.3, SPK-38).

-- @up
-- Le defaut est `runtime` DELIBEREMENT : une ecriture qui oublierait de se
-- declarer sera classee comme un evenement de la machine, jamais comme un geste
-- humain. Se tromper dans ce sens fait perdre une attribution ; se tromper dans
-- l'autre en FABRIQUERAIT une, ce qui est bien pire.
--
-- Les lignes existantes la recoivent pour la meme raison : leur acteur reel
-- n'est pas connu, et le supposer humain inventerait une attribution.
ALTER TABLE audit_log ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'runtime';

-- SQLite n'ajoute pas de CHECK a une table existante : la contrainte de domaine
-- est portee par un declencheur, comme l'invariant de protection du 004.
CREATE TRIGGER audit_log_classe_connue
AFTER INSERT ON audit_log
WHEN NEW.actor_class NOT IN ('human', 'runtime')
BEGIN
    SELECT RAISE(ABORT, 'actor_class inconnue : attendu human ou runtime');
END;

-- INSERT reste libre. La purge du §36.5 n'est pas tranchee : le jour ou elle le
-- sera, elle passera par une migration qui suspend ce declencheur, scelle le
-- prefixe dans un point de controle, et le repose.
CREATE TRIGGER audit_log_immuable_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log est en ecriture seule : UPDATE refuse');
END;

CREATE TRIGGER audit_log_immuable_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log est en ecriture seule : DELETE refuse');
END;

CREATE INDEX audit_log_classe ON audit_log (actor_class);

-- @down
DROP INDEX audit_log_classe;
DROP TRIGGER audit_log_immuable_delete;
DROP TRIGGER audit_log_immuable_update;
DROP TRIGGER audit_log_classe_connue;
ALTER TABLE audit_log DROP COLUMN actor_class;
