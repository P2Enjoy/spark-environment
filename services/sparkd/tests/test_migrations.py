"""@verifies docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §10, §11, §12

La Definition of Done exige trois choses : migrations appliquees et rejouables,
checksum verifie au demarrage, retour arriere teste. Ces tests eprouvent les
trois, et surtout les REFUS — c'est la que le moteur gagne sa valeur.
"""

from __future__ import annotations

import pytest

from sparkd import migrations
from sparkd.db import connect

UP_DOWN = """-- @up
CREATE TABLE t (id INTEGER PRIMARY KEY);

-- @down
DROP TABLE t;
"""


@pytest.fixture
def db():
    connection = connect(":memory:")
    yield connection
    connection.close()


@pytest.fixture
def dossier(tmp_path):
    (tmp_path / "001_socle.sql").write_text(UP_DOWN, encoding="utf-8")
    return tmp_path


# --- lecture des fichiers ---------------------------------------------------

def test_decouverte_triee_par_version(tmp_path):
    (tmp_path / "002_deux.sql").write_text(UP_DOWN, encoding="utf-8")
    (tmp_path / "001_un.sql").write_text(UP_DOWN, encoding="utf-8")
    assert [m.version for m in migrations.discover(tmp_path)] == [1, 2]


def test_nom_de_fichier_invalide_refuse(tmp_path):
    (tmp_path / "socle.sql").write_text(UP_DOWN, encoding="utf-8")
    with pytest.raises(migrations.MigrationError, match="nom invalide"):
        migrations.discover(tmp_path)


def test_section_down_absente_refusee(tmp_path):
    (tmp_path / "001_x.sql").write_text("-- @up\nCREATE TABLE t (id INT);\n", encoding="utf-8")
    with pytest.raises(migrations.MigrationError, match="@down"):
        migrations.discover(tmp_path)


def test_migration_irreversible_reconnue(tmp_path):
    (tmp_path / "001_x.sql").write_text(
        "-- @up\nCREATE TABLE t (id INT);\n\n-- @down\n-- IRREVERSIBLE: perte de donnees\n",
        encoding="utf-8",
    )
    assert migrations.discover(tmp_path)[0].reversible is False


# --- application ------------------------------------------------------------

def test_application_puis_rejouabilite(db, dossier):
    assert migrations.upgrade(db, dossier) == [1]
    # Rejouer ne doit rien refaire : c'est ce qui rend le demarrage idempotent.
    assert migrations.upgrade(db, dossier) == []
    assert migrations.applied(db).keys() == {1}


def test_migration_en_echec_ne_laisse_rien(db, tmp_path):
    (tmp_path / "001_casse.sql").write_text(
        "-- @up\nCREATE TABLE bon (id INT);\nCREATE TABLE ;\n\n-- @down\nDROP TABLE bon;\n",
        encoding="utf-8",
    )
    with pytest.raises(Exception):
        migrations.upgrade(db, tmp_path)
    # Ni la table valide, ni la version : la transaction a tout annule.
    assert migrations.applied(db) == {}
    tables = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "bon" not in tables


# --- les trois refus du §12.4 ----------------------------------------------

def test_checksum_divergent_refuse(db, dossier):
    migrations.upgrade(db, dossier)
    (dossier / "001_socle.sql").write_text(
        UP_DOWN.replace("id INTEGER", "id INTEGER, ajout TEXT"), encoding="utf-8"
    )
    with pytest.raises(migrations.MigrationError, match="modifiee apres son application"):
        migrations.verify(db, dossier)


def test_fichier_disparu_refuse(db, dossier):
    migrations.upgrade(db, dossier)
    (dossier / "001_socle.sql").unlink()
    with pytest.raises(migrations.MigrationError, match="autre code"):
        migrations.verify(db, dossier)


def test_trou_dans_la_sequence_refuse(db, tmp_path):
    (tmp_path / "002_deux.sql").write_text(UP_DOWN.replace("t ", "deux "), encoding="utf-8")
    migrations.upgrade(db, tmp_path)
    # Une 001 apparait apres coup : historiques divergents fusionnes.
    (tmp_path / "001_un.sql").write_text(UP_DOWN.replace("t ", "un "), encoding="utf-8")
    with pytest.raises(migrations.MigrationError, match="Trou dans la sequence"):
        migrations.verify(db, tmp_path)


# --- retour arriere ---------------------------------------------------------

def test_retour_arriere(db, dossier):
    migrations.upgrade(db, dossier)
    assert migrations.downgrade(db, dossier) == [1]
    assert migrations.applied(db) == {}
    tables = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "t" not in tables
    # Et l'on doit pouvoir remigrer derriere.
    assert migrations.upgrade(db, dossier) == [1]


def test_retour_arriere_refuse_si_irreversible(db, tmp_path):
    (tmp_path / "001_x.sql").write_text(
        "-- @up\nCREATE TABLE t (id INT);\n\n-- @down\n-- IRREVERSIBLE: perte de donnees\n",
        encoding="utf-8",
    )
    migrations.upgrade(db, tmp_path)
    with pytest.raises(migrations.MigrationError, match="irreversible"):
        migrations.downgrade(db, tmp_path)


def test_retour_arriere_sans_migration_appliquee(db, dossier):
    assert migrations.downgrade(db, dossier) == []


def test_dossier_absent_est_une_erreur_pas_un_vide(tmp_path):
    """@verifies docs/SCHEMA.md §12.1

    Rendre une liste vide ferait demarrer sparkd sans schema, et chaque requete
    echouerait ensuite sans que rien ne designe la cause. Mesure vecue au premier
    deploiement sur machine propre.
    """
    with pytest.raises(migrations.MigrationError, match="introuvable"):
        migrations.discover(tmp_path / "inexistant")


def test_les_migrations_du_paquet_sont_trouvees():
    """Les fichiers SQL doivent voyager AVEC le paquet installe.

    L'attente portait sur la liste exacte `[1]`, ce qui la faisait rougir a
    chaque migration ajoutee. Ce que la preuve doit etablir, c'est que les
    fichiers accompagnent le paquet et que les versions se suivent sans trou --
    pas leur nombre a un instant donne (docs/SCHEMA.md §12.1).
    """
    trouvees = migrations.discover()
    assert trouvees, "aucune migration : le paquet n'embarque pas son schema"
    versions = [m.version for m in trouvees]
    assert versions == list(range(1, len(versions) + 1)), "versions non contigues"
    assert all(m.path.parent.name == "schema" for m in trouvees)
