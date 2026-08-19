"""@verifies docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §2 a §10

Ces tests appliquent la VRAIE migration 001, pas un jeu d'essai, et verifient
que les regles du modele sont portees par la base et pas seulement ecrites dans
le document. Une contrainte qui n'est pas eprouvee n'est qu'un commentaire.
"""

from __future__ import annotations

import sqlite3

import pytest

from sparkd import migrations
from sparkd.db import connect

MODES = {
    "shared":        "cpu_mode, cpu_reservation",
    "capped":        "cpu_mode, cpu_max",
    "dedicated":     "cpu_mode, cpu_cores",
}


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def _spark(db, **overrides):
    valeurs = {
        "id": "01J0", "name": "demo", "image": "images:debian/13",
        "cpu_mode": "shared", "cpu_reservation": 0.5,
        "cpu_max": None, "cpu_cores": None,
        "memory_reservation_bytes": 2 * 1024**3,
        "network_reservation_bps": 100_000_000,
        "storage_bytes": 10 * 1024**3,
        "created_at": "2026-08-18T00:00:00+00:00",
        "updated_at": "2026-08-18T00:00:00+00:00",
    }
    valeurs.update(overrides)
    colonnes = ", ".join(valeurs)
    marques = ", ".join("?" * len(valeurs))
    db.execute(f"INSERT INTO spark ({colonnes}) VALUES ({marques})", tuple(valeurs.values()))


def test_la_vraie_migration_cree_toutes_les_tables(db):
    """REVISE par SPK-42 : la table `host` est renommee `forge`.

    La machine qui porte sparkd s'appelle desormais une Forge (§1 bis) ; « hote »
    designait aussi le processus Node du poste, et le meme mot valait pour deux
    machines. Ce que la preuve etablit — la migration cree TOUTES les tables —
    est inchange ; c'est un nom de la liste qui a change.
    """
    tables = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    attendues = {
        "forge", "cpu_core", "cpu_thread", "spark", "spark_cpu_pin",
        "ingress_route", "ssh_key", "spark_ssh_key", "snapshot", "backup",
        "audit_log", "schema_migration",
    }
    assert attendues <= tables
    assert "host" not in tables, "l'ancien nom ne doit plus exister (SPK-42)"


def test_forge_est_une_ligne_unique(db):
    colonnes = ("id, hostname, cpu_threads_total, cpu_cores_total, memory_total_bytes,"
                " storage_total_bytes, network_total_bps")
    db.execute(f"INSERT INTO forge ({colonnes}) VALUES (1,'spark-experiment',8,4,?,?,?)",
               (98_810_556 * 1024, 5_841_025_024 * 1024, 1_000_000_000))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(f"INSERT INTO forge ({colonnes}) VALUES (2,'autre',8,4,1,1,1)")


@pytest.mark.parametrize("mode,champs", [
    ("shared", {"cpu_reservation": 0.5}),
    ("capped", {"cpu_reservation": None, "cpu_max": 0.5}),
    ("dedicated", {"cpu_reservation": None, "cpu_cores": 2}),
    ("shared-pinned", {"cpu_reservation": 0.5, "cpu_cores": 2}),
])
def test_modes_cpu_coherents_acceptes(db, mode, champs):
    _spark(db, cpu_mode=mode, **champs)


@pytest.mark.parametrize("mode,champs", [
    ("shared", {"cpu_reservation": None}),                      # reservation manquante
    ("shared", {"cpu_reservation": 0.5, "cpu_max": 0.5}),       # plafond en trop
    ("capped", {"cpu_reservation": 0.5, "cpu_max": 0.5}),       # les deux a la fois
    ("dedicated", {"cpu_reservation": 0.5, "cpu_cores": 2}),    # reservation en trop
    ("dedicated", {"cpu_reservation": None, "cpu_cores": None}),# coeurs manquants
])
def test_modes_cpu_incoherents_refuses(db, mode, champs):
    with pytest.raises(sqlite3.IntegrityError):
        _spark(db, cpu_mode=mode, **champs)


def test_nom_de_spark_unique(db):
    _spark(db)
    with pytest.raises(sqlite3.IntegrityError):
        _spark(db, id="01J1")


def test_etat_inconnu_refuse(db):
    with pytest.raises(sqlite3.IntegrityError):
        _spark(db, state="zombie")


def test_rafale_inferieure_a_la_reservation_refusee(db):
    with pytest.raises(sqlite3.IntegrityError):
        _spark(db, network_reservation_bps=100_000_000, network_burst_bps=50_000_000)


def test_domaine_unique_porte_par_la_base(db):
    _spark(db)
    db.execute("INSERT INTO ingress_route (id, domain, spark_id, target_port)"
               " VALUES ('r1','crm.example.com','01J0',8080)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO ingress_route (id, domain, spark_id, target_port)"
                   " VALUES ('r2','crm.example.com','01J0',9090)")


def test_route_vers_un_spark_inexistant_refusee(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO ingress_route (id, domain, spark_id, target_port)"
                   " VALUES ('r1','x.example.com','inexistant',8080)")


def test_cle_privee_refusee(db):
    """docs/SCHEMA.md §7 : seules des cles PUBLIQUES sont stockees."""
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO ssh_key (id,label,public_key,fingerprint,created_at)"
                   " VALUES ('k1','fuite','-----BEGIN OPENSSH PRIVATE KEY-----','fp','2026-08-18')")


def test_cle_publique_acceptee(db):
    db.execute("INSERT INTO ssh_key (id,label,public_key,fingerprint,created_at)"
               " VALUES ('k1','poste','ssh-ed25519 AAAAC3Nza...','SHA256:abc','2026-08-18')")


def test_un_coeur_dedie_n_appartient_qu_a_un_spark(db):
    _spark(db)
    _spark(db, id="01J1", name="autre")
    db.execute("INSERT INTO cpu_core (id,socket_id,numa_node,core_id,pool,spark_id)"
               " VALUES (1,0,0,3,'dedicated','01J0')")
    db.execute("INSERT INTO spark_cpu_pin (spark_id, core_id) VALUES ('01J0',1)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO spark_cpu_pin (spark_id, core_id) VALUES ('01J1',1)")


def test_coeur_partage_sans_proprietaire(db):
    db.execute("INSERT INTO cpu_core (id,socket_id,numa_node,core_id,pool)"
               " VALUES (1,0,0,3,'shared')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO cpu_core (id,socket_id,numa_node,core_id,pool,spark_id)"
                   " VALUES (2,0,0,2,'shared','01J0')")


def test_suppression_d_un_spark_emporte_ses_routes(db):
    _spark(db)
    db.execute("INSERT INTO ingress_route (id,domain,spark_id,target_port)"
               " VALUES ('r1','a.example.com','01J0',8080)")
    db.execute("DELETE FROM spark WHERE id='01J0'")
    assert db.execute("SELECT count(*) FROM ingress_route").fetchone()[0] == 0


def test_resultat_d_audit_contraint(db):
    db.execute("INSERT INTO audit_log (ts,actor,action,result)"
               " VALUES ('2026-08-18','responsable','spark.create','denied')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO audit_log (ts,actor,action,result)"
                   " VALUES ('2026-08-18','responsable','spark.create','peut-etre')")


def test_migration_reelle_reversible(tmp_path):
    """Toutes les migrations du paquet s'appliquent, se defont et se rejouent.

    L'attente etait figee sur `[1]` : elle rougissait a l'ajout de 002 sans rien
    dire du produit. Ce qui compte est que le paquet ENTIER soit reversible, quel
    que soit le nombre de migrations (docs/SCHEMA.md §11).
    """
    toutes = [m.version for m in migrations.discover()]
    connection = connect(tmp_path / "r.db")
    assert migrations.upgrade(connection) == toutes

    # `downgrade` retire UNE migration par appel (docs/SCHEMA.md §12) : on
    # deroule la pile entiere, ce qui eprouve chaque sens `down` un a un.
    defaites = []
    while (retire := migrations.downgrade(connection)):
        defaites.extend(retire)
    assert defaites == list(reversed(toutes))

    tables = {r["name"] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "spark" not in tables
    assert migrations.upgrade(connection) == toutes
    connection.close()
