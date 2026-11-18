"""@verifies docs/BACKLOG.md#SPK-182 · docs/SCHEMA.md §8 ter (`sla` et `snapshot.origin`) ·
docs/DAT.md §74.2 (une rétention au moins), §74.4 (la provenance est une donnée)

La migration 023 ne devine rien : les instantanés existants sont `manual`, et son retour
arrière supprime la politique, jamais un instantané.
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


def test_les_instantanes_existants_deviennent_manuels(tmp_path):
    connection = connect(tmp_path / "ancienne.db")
    # Une base AVANT la 023 : on la monte jusqu'à la 022 puis on y met un instantané.
    migrations.upgrade(connection)
    while max(migrations.applied(connection)) > 22:
        migrations.downgrade(connection)
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "incus_name,created_at,updated_at) VALUES ('S1','crm','images:debian/13',"
        "'shared',0.5,?,10000000,?,'crm','x','x')", (GIO, GIO))
    connection.execute("INSERT INTO snapshot (id, spark_id, incus_name, created_at, stateful)"
                       " VALUES ('N1', 'S1', 'avant-deploiement', 'x', 0)")
    assert migrations.upgrade(connection) == [23]
    assert connection.execute("SELECT origin FROM snapshot WHERE id='N1'").fetchone()[0] == "manual"
    connection.close()


def test_la_provenance_est_contrainte(db):
    db.execute("INSERT INTO snapshot (id, spark_id, incus_name, created_at, origin)"
               " VALUES ('N1','S1','a','x','sla')")
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("INSERT INTO snapshot (id, spark_id, incus_name, created_at, origin)"
                   " VALUES ('N2','S1','b','x','autre')")


def test_une_politique_exige_une_retention_dans_la_base(db):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("INSERT INTO sla (spark_id, schedule, created_at, updated_at)"
                   " VALUES ('S1','0 2 * * *','x','x')")
    db.execute("INSERT INTO sla (spark_id, schedule, retention_days, created_at, updated_at)"
               " VALUES ('S1','0 2 * * *',7,'x','x')")


@pytest.mark.parametrize("colonne, valeur", [
    ("retention_days", 0), ("retention_days", 3651),
    ("retention_count", 0), ("retention_count", 1001),
])
def test_les_bornes_de_retention_sont_dans_la_base(db, colonne, valeur):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute(f"INSERT INTO sla (spark_id, schedule, {colonne}, created_at, updated_at)"
                   " VALUES ('S1','0 2 * * *',?,'x','x')", (valeur,))


def test_un_sla_par_spark(db):
    db.execute("INSERT INTO sla (spark_id, schedule, retention_days, created_at, updated_at)"
               " VALUES ('S1','0 2 * * *',7,'x','x')")
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE|PRIMARY"):
        db.execute("INSERT INTO sla (spark_id, schedule, retention_days, created_at, updated_at)"
                   " VALUES ('S1','0 3 * * *',7,'x','x')")


def test_supprimer_le_spark_supprime_sa_politique_pas_l_inverse(db):
    db.execute("INSERT INTO sla (spark_id, schedule, retention_days, created_at, updated_at)"
               " VALUES ('S1','0 2 * * *',7,'x','x')")
    db.execute("DELETE FROM sla WHERE spark_id='S1'")
    assert db.execute("SELECT COUNT(*) FROM spark").fetchone()[0] == 1
    db.execute("INSERT INTO sla (spark_id, schedule, retention_days, created_at, updated_at)"
               " VALUES ('S1','0 2 * * *',7,'x','x')")
    db.execute("DELETE FROM spark WHERE id='S1'")
    assert db.execute("SELECT COUNT(*) FROM sla").fetchone()[0] == 0


def test_le_retour_arriere_supprime_la_politique_jamais_un_instantane(db):
    db.execute("INSERT INTO sla (spark_id, schedule, retention_days, created_at, updated_at)"
               " VALUES ('S1','0 2 * * *',7,'x','x')")
    db.execute("INSERT INTO snapshot (id, spark_id, incus_name, created_at, origin)"
               " VALUES ('N1','S1','SLA_20261118-020000','x','sla')")
    assert migrations.downgrade(db) == [23]
    assert db.execute("SELECT COUNT(*) FROM snapshot").fetchone()[0] == 1
    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        db.execute("SELECT * FROM sla")
    assert "origin" not in [c[1] for c in db.execute("PRAGMA table_info(snapshot)")]
    assert migrations.upgrade(db) == [23]                      # et il remonte
