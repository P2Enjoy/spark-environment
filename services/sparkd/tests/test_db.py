"""@verifies docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §12.5

foreign_keys est la valeur par defaut la plus couteuse de SQLite : desactivee, et
par connexion. Ce test existe pour qu'une regression sur ce pragma soit visible
immediatement, et non le jour ou une reference vers rien sera decouverte en base.
"""

from __future__ import annotations

import pytest

from sparkd.db import connect, transaction


def test_cles_etrangeres_actives():
    connection = connect(":memory:")
    assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_reference_invalide_refusee():
    connection = connect(":memory:")
    connection.executescript(
        "CREATE TABLE parent (id TEXT PRIMARY KEY);"
        "CREATE TABLE enfant (id TEXT PRIMARY KEY,"
        " parent_id TEXT NOT NULL REFERENCES parent(id));"
    )
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        connection.execute("INSERT INTO enfant VALUES ('a', 'inexistant')")


def test_transaction_annulee_ne_laisse_rien():
    connection = connect(":memory:")
    connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    with pytest.raises(RuntimeError):
        with transaction(connection):
            connection.execute("INSERT INTO t VALUES (1)")
            raise RuntimeError("echec au milieu")
    assert connection.execute("SELECT count(*) FROM t").fetchone()[0] == 0
