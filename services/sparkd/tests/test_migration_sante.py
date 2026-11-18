"""@verifies docs/BACKLOG.md#SPK-184 · docs/SCHEMA.md §8 quater (`health_check`, `health_result`)

Les bornes sont dans la base, pas seulement dans l'API ; supprimer un Spark supprime ses sondes ; le
retour arrière supprime les deux tables sans toucher à un Spark ni à un instantané.
"""

from __future__ import annotations

import sqlite3

import pytest

from sparkd import migrations
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "m.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "incus_name,created_at,updated_at) VALUES ('S1','crm','images:debian/13',"
        "'shared',0.5,?,10000000,?,'crm','x','x')", (GIO, GIO))
    yield connection
    connection.close()


def sonde(db, **extra):
    valeurs = {"id": "C1", "spark_id": "S1", "name": "api", "kind": "http", "target": "t",
               "expected": 200, "schedule": "*/5 * * * *", "threshold": 3, **extra}
    db.execute(
        "INSERT INTO health_check (id, spark_id, name, kind, target, expected, schedule, threshold,"
        " created_at, updated_at) VALUES (:id,:spark_id,:name,:kind,:target,:expected,:schedule,"
        ":threshold,'x','x')", valeurs)


@pytest.mark.parametrize("modif", [{"kind": "tcp"}, {"threshold": 0}, {"threshold": 21}])
def test_les_bornes_sont_dans_la_base(db, modif):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        sonde(db, **modif)


def test_un_nom_par_spark(db):
    sonde(db)
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        sonde(db, id="C2")


def test_l_etat_est_contraint_et_vaut_inconnu_par_defaut(db):
    sonde(db)
    assert db.execute("SELECT state, enabled, consecutive_failures FROM health_check").fetchone()[:] == ("unknown", 1, 0)
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("UPDATE health_check SET state = 'suspended'")


def test_supprimer_le_spark_supprime_ses_sondes_et_leur_historique(db):
    sonde(db)
    db.execute("INSERT INTO health_result (check_id, run_at, ok) VALUES ('C1','x',1)")
    db.execute("DELETE FROM spark WHERE id='S1'")
    assert db.execute("SELECT COUNT(*) FROM health_check").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == 0


def test_le_retour_arriere_supprime_les_tables_pas_le_spark(db):
    sonde(db)
    assert migrations.downgrade(db) == [24]
    assert db.execute("SELECT COUNT(*) FROM spark").fetchone()[0] == 1
    for table in ("health_check", "health_result"):
        with pytest.raises(sqlite3.OperationalError, match="no such table"):
            db.execute(f"SELECT * FROM {table}")
    assert migrations.upgrade(db) == [24]
