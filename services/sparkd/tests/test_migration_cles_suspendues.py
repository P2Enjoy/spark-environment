"""@verifies docs/BACKLOG.md#SPK-152 · docs/SCHEMA.md §12.3 bis (reconstruire une
             table parente : les clés étrangères suspendues), §12.3, §12.2

SQLite ne modifie pas un `CHECK` existant : on reconstruit la table. Sur une
table PARENTE, clés étrangères actives, `DROP TABLE` vide d'abord la table et la
cascade emporte les lignes filles. Ces tests éprouvent les trois promesses du
§12.3 bis : rien n'est suspendu sans la ligne qui le demande ; avec elle, les
filles survivent ; une référence cassée annule tout, et les clés reviennent
toujours.
"""

from __future__ import annotations

import pytest

from sparkd import migrations
from sparkd.db import connect

SOCLE = """-- @up
CREATE TABLE mere (id TEXT PRIMARY KEY, n INTEGER CHECK (n < 10));
CREATE TABLE fille (id INTEGER PRIMARY KEY,
                    mere_id TEXT NOT NULL REFERENCES mere(id) ON DELETE CASCADE);

-- @down
DROP TABLE fille;
DROP TABLE mere;
"""

#: La reconstruction ordinaire : nouvelle table, copie, suppression, renommage.
RECONSTRUIRE = """CREATE TABLE mere_2 (id TEXT PRIMARY KEY, n INTEGER CHECK (n < 100));
INSERT INTO mere_2 SELECT * FROM mere;
DROP TABLE mere;
ALTER TABLE mere_2 RENAME TO mere;"""

AVEC_MARQUEUR = f"""-- @up
-- @cles-etrangeres: suspendues
{RECONSTRUIRE}

-- @down
-- IRREVERSIBLE: preuve
"""

SANS_MARQUEUR = f"""-- @up
{RECONSTRUIRE}

-- @down
-- IRREVERSIBLE: preuve
"""


@pytest.fixture
def db():
    connection = connect(":memory:")
    yield connection
    connection.close()


def _peupler(db, dossier):
    (dossier / "001_socle.sql").write_text(SOCLE, encoding="utf-8")
    migrations.upgrade(db, dossier)
    db.execute("INSERT INTO mere VALUES ('m1', 1)")
    db.execute("INSERT INTO fille (mere_id) VALUES ('m1')")


def _filles(db) -> int:
    return db.execute("SELECT count(*) AS n FROM fille").fetchone()["n"]


def _cles_actives(db) -> bool:
    return db.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_sans_la_ligne_la_cascade_emporte_les_filles(db, tmp_path):
    """Le moteur ne suspend RIEN de lui-même : c'est le défaut qu'il évite."""
    _peupler(db, tmp_path)
    (tmp_path / "002_reconstruire.sql").write_text(SANS_MARQUEUR, encoding="utf-8")
    migrations.upgrade(db, tmp_path)
    assert _filles(db) == 0


def test_avec_la_ligne_les_filles_survivent(db, tmp_path):
    _peupler(db, tmp_path)
    (tmp_path / "002_reconstruire.sql").write_text(AVEC_MARQUEUR, encoding="utf-8")
    assert migrations.upgrade(db, tmp_path) == [2]
    assert _filles(db) == 1
    # La contrainte élargie est bien celle de la nouvelle table.
    db.execute("UPDATE mere SET n = 50 WHERE id = 'm1'")
    # Les clés sont revenues : la cascade fonctionne de nouveau.
    assert _cles_actives(db)
    db.execute("DELETE FROM mere WHERE id = 'm1'")
    assert _filles(db) == 0


def test_la_ligne_est_lue_section_par_section(tmp_path):
    (tmp_path / "001_x.sql").write_text(AVEC_MARQUEUR, encoding="utf-8")
    migration = migrations.discover(tmp_path)[0]
    assert migration.cles_suspendues_up is True
    assert migration.cles_suspendues_down is False


def test_une_reference_cassee_annule_tout(db, tmp_path):
    """`foreign_key_check` avant la validation : une ligne rendue, rien ne passe."""
    _peupler(db, tmp_path)
    (tmp_path / "002_casse.sql").write_text(
        "-- @up\n-- @cles-etrangeres: suspendues\n"
        "INSERT INTO fille (mere_id) VALUES ('personne');\n\n"
        "-- @down\n-- IRREVERSIBLE: preuve\n",
        encoding="utf-8",
    )
    with pytest.raises(migrations.MigrationError, match="fille"):
        migrations.upgrade(db, tmp_path)
    assert 2 not in migrations.applied(db)
    assert _filles(db) == 1
    # Même après l'échec, les clés sont revenues.
    assert _cles_actives(db)


def test_les_cles_reviennent_apres_une_erreur_sql(db, tmp_path):
    _peupler(db, tmp_path)
    (tmp_path / "002_casse.sql").write_text(
        "-- @up\n-- @cles-etrangeres: suspendues\nCREATE TABLE ;\n\n"
        "-- @down\n-- IRREVERSIBLE: preuve\n",
        encoding="utf-8",
    )
    with pytest.raises(Exception):
        migrations.upgrade(db, tmp_path)
    assert _cles_actives(db)


def test_le_retour_arriere_suit_la_meme_regle(db, tmp_path):
    _peupler(db, tmp_path)
    (tmp_path / "002_reconstruire.sql").write_text(
        "-- @up\n-- @cles-etrangeres: suspendues\n" + RECONSTRUIRE + "\n\n"
        "-- @down\n-- @cles-etrangeres: suspendues\n"
        "CREATE TABLE mere_1 (id TEXT PRIMARY KEY, n INTEGER CHECK (n < 10));\n"
        "INSERT INTO mere_1 SELECT * FROM mere;\n"
        "DROP TABLE mere;\n"
        "ALTER TABLE mere_1 RENAME TO mere;\n",
        encoding="utf-8",
    )
    migrations.upgrade(db, tmp_path)
    assert migrations.downgrade(db, tmp_path) == [2]
    assert _filles(db) == 1
    assert _cles_actives(db)
