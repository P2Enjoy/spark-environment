"""@verifies docs/BACKLOG.md#SPK-152 · docs/SCHEMA.md §4 (cpu_mode, cpu_max ≥
             cpu_reservation), §12.3 bis · docs/DAT.md §7.2 quater

La VRAIE migration 022, sur le registre migré par les vraies migrations : la
reconstruction de `spark` ne doit rien perdre — ni ses lignes filles, ni ses
déclencheurs de protection —, et le mode `shared-capped` doit être tenu par la
base dans les deux sens.
"""

from __future__ import annotations

import sqlite3

import pytest

from sparkd import migrations
from sparkd.db import connect


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def _spark(db, ident="S1", name="demo", **colonnes):
    valeurs = {
        "id": ident, "name": name, "image": "images:debian/13",
        "cpu_mode": "shared", "cpu_reservation": 0.5, "cpu_max": None, "cpu_cores": None,
        "memory_reservation_bytes": 2 * 1024**3, "network_reservation_bps": 100_000_000,
        "storage_bytes": 10 * 1024**3, "created_at": "t", "updated_at": "t",
        **colonnes,
    }
    db.execute(
        f"INSERT INTO spark ({', '.join(valeurs)}) VALUES ({', '.join('?' * len(valeurs))})",
        tuple(valeurs.values()),
    )


def _note(db, spark_id="S1"):
    db.execute(
        "INSERT INTO spark_note VALUES (?, 'readme', 'corps', 1, 'console', 't')", (spark_id,))


def _notes(db) -> int:
    return db.execute("SELECT count(*) AS n FROM spark_note").fetchone()["n"]


def test_la_version_022_est_appliquee(db):
    assert max(migrations.applied(db)) >= 22


def test_le_mode_porte_une_reservation_et_un_plafond(db):
    _spark(db, cpu_mode="shared-capped", cpu_reservation=0.5, cpu_max=1.5)
    ligne = db.execute("SELECT cpu_mode, cpu_reservation, cpu_max FROM spark").fetchone()
    assert tuple(ligne) == ("shared-capped", 0.5, 1.5)


@pytest.mark.parametrize("colonnes", [
    {"cpu_reservation": 1.0, "cpu_max": 0.5},           # plafond sous le plancher
    {"cpu_reservation": None, "cpu_max": 1.0},          # pas de réservation
    {"cpu_reservation": 0.5, "cpu_max": None},          # pas de plafond
    {"cpu_reservation": 0.5, "cpu_max": 1.0, "cpu_cores": 2},  # des cœurs imposés
])
def test_la_base_refuse_un_mode_incoherent(db, colonnes):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _spark(db, cpu_mode="shared-capped", **colonnes)


def test_un_plafond_egal_a_la_reservation_est_admis(db):
    _spark(db, cpu_mode="shared-capped", cpu_reservation=1.0, cpu_max=1.0)


def test_les_autres_modes_n_ont_pas_change(db):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _spark(db, cpu_mode="shared", cpu_reservation=0.5, cpu_max=1.0)
    _spark(db, ident="S2", name="plafonne", cpu_mode="capped", cpu_reservation=None, cpu_max=1.0)


def test_les_declencheurs_de_protection_sont_recrees(db):
    _spark(db)
    with pytest.raises(sqlite3.IntegrityError, match="protection incoherente"):
        db.execute("UPDATE spark SET protected_at = 't' WHERE id = 'S1'")


def test_aller_retour_sans_perdre_les_lignes_filles(db):
    """Le cœur du §12.3 bis : la reconstruction, dans les deux sens, garde les filles."""
    _spark(db)
    _note(db)
    assert migrations.downgrade(db) == [22]
    assert _notes(db) == 1
    assert migrations.upgrade(db) == [22]
    assert _notes(db) == 1
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    # La cascade fonctionne de nouveau : la table reconstruite est bien la mère.
    db.execute("DELETE FROM spark WHERE id = 'S1'")
    assert _notes(db) == 0


def test_le_retour_arriere_est_refuse_tant_qu_un_spark_est_dans_le_mode(db):
    _spark(db, cpu_mode="shared-capped", cpu_reservation=0.5, cpu_max=1.0)
    _note(db)
    with pytest.raises(sqlite3.IntegrityError, match="repassez-le dans un autre mode"):
        migrations.downgrade(db)
    assert 22 in migrations.applied(db)
    assert _notes(db) == 1


def test_apres_le_retour_arriere_le_mode_n_existe_plus(db):
    migrations.downgrade(db)
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _spark(db, cpu_mode="shared-capped", cpu_reservation=0.5, cpu_max=1.0)
