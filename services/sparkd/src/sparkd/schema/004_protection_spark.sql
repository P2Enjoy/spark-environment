-- @spec docs/BACKLOG.md#SPK-34 · docs/SCHEMA.md §4.1 · docs/DAT.md §35
--       (les Sparks proteges), §35.3 (le mot de passe), §35.4 (lever est un
--       etat, pas une fenetre de temps)
--
-- Un interrupteur de protection par Spark. Il arrete le geste ACCIDENTEL : le
-- mauvais Spark selectionne, le `curl` recopie d'un autre bocal, le script
-- d'astreinte lance sur le mauvais nom. Ce n'est PAS un controle d'acces —
-- qui detient root sur l'hote atteint ce fichier (§35.1) — et le produit ne le
-- presentera jamais comme une frontiere de securite.
--
-- Les quatre colonnes vont TOUJOURS ensemble. Un etat mi-arme serait
-- indecidable : une empreinte sans sel ne se verifie pas, et un `protected_at`
-- sans empreinte verrouillerait un Spark que plus rien ne peut lever.
--
-- Elles naissent NULL sur les Sparks existants : une protection ne s'arme
-- JAMAIS retroactivement, sans quoi la migration verrouillerait des Sparks
-- dont personne ne connaitrait le mot de passe.

-- @up
-- `protected_at` FAIT FOI : sparkd repond « protege » sur sa non-nullite,
-- jamais sur la presence d'une empreinte.
ALTER TABLE spark ADD COLUMN protected_at      TEXT;
-- Empreinte scrypt, en hexadecimal. Le mot de passe n'est jamais stocke en
-- clair, et jamais journalise (§21, §35.3).
ALTER TABLE spark ADD COLUMN protection_hash   TEXT;
-- Sel aleatoire PAR SPARK : un sel commun rendrait deux Sparks au meme mot de
-- passe reconnaissables a leur empreinte identique.
ALTER TABLE spark ADD COLUMN protection_salt   TEXT;
-- Parametres de cout en JSON, ranges A COTE de l'empreinte plutot que dans le
-- code : une empreinte posee avec n = 2^14 reste verifiable le jour ou le
-- defaut passe a 2^15.
ALTER TABLE spark ADD COLUMN protection_params TEXT;

-- L'invariant du §4.1, applique par la base et non par la seule vigilance du
-- code. SQLite n'ajoute pas de CHECK a une table existante : la contrainte est
-- portee par un trigger sur chaque ecriture.
CREATE TRIGGER spark_protection_coherente_insert
AFTER INSERT ON spark
WHEN ( (NEW.protected_at      IS NULL) + (NEW.protection_hash   IS NULL)
     + (NEW.protection_salt   IS NULL) + (NEW.protection_params IS NULL) ) NOT IN (0, 4)
BEGIN
    SELECT RAISE(ABORT, 'protection incoherente : les quatre colonnes vont ensemble');
END;

CREATE TRIGGER spark_protection_coherente_update
AFTER UPDATE ON spark
WHEN ( (NEW.protected_at      IS NULL) + (NEW.protection_hash   IS NULL)
     + (NEW.protection_salt   IS NULL) + (NEW.protection_params IS NULL) ) NOT IN (0, 4)
BEGIN
    SELECT RAISE(ABORT, 'protection incoherente : les quatre colonnes vont ensemble');
END;

-- Lister les Sparks proteges est le geste de la revocation de cle (§35.2) :
-- elle doit les NOMMER avant d'aboutir.
CREATE INDEX spark_protected ON spark (protected_at) WHERE protected_at IS NOT NULL;

-- @down
DROP INDEX spark_protected;
DROP TRIGGER spark_protection_coherente_update;
DROP TRIGGER spark_protection_coherente_insert;
ALTER TABLE spark DROP COLUMN protection_params;
ALTER TABLE spark DROP COLUMN protection_salt;
ALTER TABLE spark DROP COLUMN protection_hash;
ALTER TABLE spark DROP COLUMN protected_at;
