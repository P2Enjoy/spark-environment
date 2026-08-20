-- @spec docs/BACKLOG.md#SPK-40 · docs/SCHEMA.md §9.2 · docs/DAT.md §36.3 (ou la
--       signature est produite decide de ce qu'elle vaut), §36.4 (deux classes
--       de lignes), §36.10 (le contrat), §36.10.6 (le registre)
--
-- Une signature atteste que le geste a bien ete DEMANDE, et qu'il n'a pas ete
-- fabrique par la Forge apres coup. Elle ne prouve pas QUI agit : la cle volee
-- signe, et l'arbitrage de SPK-35 (§45.4) l'a etabli.
--
-- Ces colonnes n'entrent PAS dans l'empreinte de la chaine (§36.9.2). Le champ
-- retenu y est fige, et l'y ajouter invaliderait toutes les lignes existantes —
-- ce que le §36.9.2 interdit expressement. Les deux mecanismes sont donc
-- independants PAR CONSTRUCTION : la chaine couvre l'ordre et l'integrite, la
-- signature couvre l'intention.
--
-- Une ligne produite par le RUNTIME porte NULL aux trois. Ce n'est pas une
-- lacune : le §36.4 le dit, et la supervision montre la classe plutot que de la
-- masquer.

-- @up
ALTER TABLE audit_log ADD COLUMN signature TEXT;
ALTER TABLE audit_log ADD COLUMN signed_bytes TEXT;
ALTER TABLE audit_log ADD COLUMN signature_version TEXT;

-- Les trois vont ENSEMBLE ou pas du tout. Une signature sans ses octets ne se
-- verifie pas ; des octets sans signature n'attestent rien. Une ligne qui
-- porterait l'un sans l'autre affirmerait une preuve qu'elle n'a pas.
CREATE TRIGGER audit_log_signature_complete
BEFORE INSERT ON audit_log
WHEN (NEW.signature IS NULL) <> (NEW.signed_bytes IS NULL)
  OR (NEW.signature IS NULL) <> (NEW.signature_version IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'signature, signed_bytes et signature_version vont ensemble');
END;

-- Retrouver les gestes signes sans parcourir tout le journal : c'est la question
-- que pose qui audite.
CREATE INDEX audit_log_signee ON audit_log (signature) WHERE signature IS NOT NULL;

-- @down
DROP INDEX audit_log_signee;
DROP TRIGGER audit_log_signature_complete;
ALTER TABLE audit_log DROP COLUMN signature_version;
ALTER TABLE audit_log DROP COLUMN signed_bytes;
ALTER TABLE audit_log DROP COLUMN signature;
