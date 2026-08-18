"""@verifies docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.2, §5.3 · docs/SCHEMA.md §2, §3

Les trois pièges du §5.2 ont été rencontrés à la mesure sur l'hôte réel. Ces
tests existent pour qu'ils ne reviennent jamais en silence.
"""

from __future__ import annotations

import copy

import pytest

from sparkd import migrations
from sparkd.db import connect
from sparkd.incus import FakeIncus, _EXEMPLE_HOTE
from sparkd.inventory import InventoryError, read_topology, sibling_cpus, sync


@pytest.fixture
def arc_connu(tmp_path, monkeypatch):
    """Reproduit l'hote de validation : 94,2 Gio geres, ARC plafonne a 16 Gio.

    MemTotal est fixe autant que l'ARC : sans cela les tests mesureraient la
    machine qui les execute — sa RAM et la presence de ZFS — plutot que le
    comportement du produit.
    """
    from sparkd import hostmem
    arc = tmp_path / "zfs_arc_max"
    arc.write_text(str(16 * 1024**3))
    monkeypatch.setattr(hostmem, "ARC_MAX", arc)
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:       98810556 kB\nMemFree:  1 kB\n")
    monkeypatch.setattr(hostmem, "MEMINFO", meminfo)
    return arc


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


# --- les trois pieges du §5.2 ----------------------------------------------

def test_les_coeurs_ne_sont_pas_les_threads():
    """cpu.total vaut 8 ; la capacite est de 4 coeurs. Confondre reviendrait a
    vendre deux fois la meme chose (DAT §7.7)."""
    topology = read_topology(FakeIncus(), "spark")
    assert topology.cpu_threads_total == 8
    assert topology.cpu_cores_total == 4


def test_link_speed_converti_de_mbit_en_bit():
    """L'hote rend 1000 pour un lien 1 Gbit/s. Le registre stocke des bit/s."""
    assert read_topology(FakeIncus(), "spark").network_total_bps == 1_000_000_000


def test_port_non_detecte_n_ajoute_aucune_capacite():
    """eno2 n'est pas raccorde : il ne doit rien promettre."""
    charge = copy.deepcopy(_EXEMPLE_HOTE)
    charge["network"]["cards"][1]["ports"][0]["link_speed"] = 10_000
    assert read_topology(FakeIncus(payload=charge), "spark").network_total_bps == 1_000_000_000


def test_capacite_de_stockage_lue_sur_le_pool_pas_sur_le_disque():
    topology = read_topology(FakeIncus(), "spark")
    assert topology.storage_total_bytes == 207_030_845_440  # 192,8 Gio, le pool


# --- freres SMT -------------------------------------------------------------

def test_freres_smt_conserves(db):
    """DAT §7.5 : un coeur dedie n'est pas un CPU logique."""
    sync(db, FakeIncus(), "spark")
    coeurs = db.execute("SELECT id, core_id FROM cpu_core ORDER BY core_id").fetchall()
    assert len(coeurs) == 4
    # Freres mesures sur l'hote : (0,4) (1,5) (2,6) (3,7).
    for rang, ligne in enumerate(coeurs):
        assert sibling_cpus(db, ligne["id"]) == [rang, rang + 4]


# --- releve inexploitable ---------------------------------------------------

@pytest.mark.parametrize("mutation", [
    lambda d: d["cpu"].__setitem__("sockets", []),
    lambda d: d["network"].__setitem__("cards", []),
])
def test_releve_inexploitable_refuse(mutation):
    """Mieux vaut echouer que retenir une capacite fausse."""
    charge = copy.deepcopy(_EXEMPLE_HOTE)
    mutation(charge)
    with pytest.raises(InventoryError):
        read_topology(FakeIncus(payload=charge), "spark")


def test_memory_total_d_incus_n_est_plus_consulte():
    """Revise le 2026-08-19, avec SPK-03.

    Ce cas exigeait auparavant qu'un « memory.total » nul fasse echouer le
    releve. La regle a change : la memoire ne vient plus d'Incus mais de
    /proc/meminfo, parce que « memory.total » est la RAM PHYSIQUE — 98 Gio de
    barrettes contre 94,2 Gio reellement gerables par le noyau. Le cas est donc
    revise, non supprime : ce qui reste verifie, c'est que la valeur d'Incus
    n'influence plus le releve.
    """
    charge = copy.deepcopy(_EXEMPLE_HOTE)
    charge["memory"]["total"] = 0
    topology = read_topology(FakeIncus(payload=charge), "spark")
    assert topology.memory_total_bytes > 0


def test_pool_de_stockage_vide_refuse():
    with pytest.raises(InventoryError):
        read_topology(FakeIncus(pool_payload={"space": {"total": 0}}), "spark")


# --- ecriture dans le registre ---------------------------------------------

def test_sync_ecrit_host_et_topologie(db):
    sync(db, FakeIncus(), "spark")
    host = db.execute("SELECT * FROM host WHERE id = 1").fetchone()
    assert host["hostname"] == "spark-experiment"
    assert host["cpu_cores_total"] == 4
    assert host["topology_synced_at"] is not None
    assert db.execute("SELECT count(*) FROM cpu_thread").fetchone()[0] == 8


def test_sync_est_rejouable(db):
    sync(db, FakeIncus(), "spark")
    sync(db, FakeIncus(), "spark")
    assert db.execute("SELECT count(*) FROM cpu_core").fetchone()[0] == 4
    assert db.execute("SELECT count(*) FROM cpu_thread").fetchone()[0] == 8


def test_sync_est_trace(db, arc_connu):
    """Revise le 2026-08-19 : le verdict depend desormais de l'ARC.

    Sans le fixer, ce test dirait « ok » sur une machine avec ZFS et « denied »
    sans — il mesurerait la machine de test, pas le produit.
    """
    sync(db, FakeIncus(), "spark", actor="responsable")
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action = 'host.sync' ORDER BY id DESC"
    ).fetchone()
    assert ligne["result"] == "ok"
    assert ligne["actor"] == "responsable"


def test_sync_signale_un_arc_inconnu(db, tmp_path, monkeypatch):
    """docs/DAT.md §16.2 : on ne suppose JAMAIS un ARC nul en silence."""
    from sparkd import hostmem
    monkeypatch.setattr(hostmem, "ARC_MAX", tmp_path / "absent")
    sync(db, FakeIncus(), "spark")
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='host.sync' ORDER BY id DESC"
    ).fetchone()
    assert ligne["result"] == "denied"
    assert "surestime" in ligne["message"].replace("é", "e")


def test_la_reserve_soustrait_l_arc_et_la_marge(db, arc_connu):
    """docs/DAT.md §16.1 — un pool qui ignore l'ARC promet ce qu'il n'a pas."""
    sync(db, FakeIncus(), "spark", operating_margin=2 * 1024**3)
    host = db.execute("SELECT * FROM host WHERE id=1").fetchone()
    assert host["memory_total_bytes"] == 98810556 * 1024      # MemTotal, pas la RAM physique
    assert host["memory_reserve_bytes"] == 18 * 1024**3       # ARC 16 + marge 2
    from sparkd.admission import pools
    assert pools(db).memory.capacity == host["memory_total_bytes"] - 18 * 1024**3


def test_la_memoire_retenue_n_est_pas_celle_d_incus(db, arc_connu):
    """Incus rend 98,0 Gio de barrettes ; le noyau n'en gere que 94,2."""
    sync(db, FakeIncus(), "spark")
    host = db.execute("SELECT * FROM host WHERE id=1").fetchone()
    assert host["memory_total_bytes"] == 98810556 * 1024
    assert host["memory_total_bytes"] < 105_226_698_752  # ce que rapporte Incus


def test_une_reserve_qui_avale_tout_le_dit(tmp_path, monkeypatch):
    """Annoncer « 0 allouable » sans dire pourquoi ferait chercher ailleurs."""
    from sparkd import hostmem
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:       1048576 kB\n")   # 1 Gio
    arc = tmp_path / "arc"; arc.write_text(str(4 * 1024**3))
    monkeypatch.setattr(hostmem, "MEMINFO", meminfo)
    monkeypatch.setattr(hostmem, "ARC_MAX", arc)
    m = hostmem.measure(operating_margin=1024**3)
    assert m.allocatable_bytes == 0
    assert "Plus rien n'est allouable" in m.detail
    assert "zfs_arc_max" in m.detail


def test_sync_conserve_les_coeurs_deja_attribues(db):
    """La topologie se releve ; les allocations se conservent."""
    sync(db, FakeIncus(), "spark")
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_cores,memory_reservation_bytes,"
        "network_reservation_bps,storage_bytes,created_at,updated_at)"
        " VALUES ('S1','pg','images:debian/13','dedicated',1,1073741824,10000000,"
        "10737418240,'2026-08-18','2026-08-18')"
    )
    db.execute("UPDATE cpu_core SET pool='dedicated', spark_id='S1' WHERE core_id=2")
    sync(db, FakeIncus(), "spark")
    ligne = db.execute("SELECT pool, spark_id FROM cpu_core WHERE core_id=2").fetchone()
    assert ligne["pool"] == "dedicated"
    assert ligne["spark_id"] == "S1"


def test_capacite_reduite_sous_l_allocation_est_appliquee_mais_signalee(db):
    """DAT §5.3 : la realite fait foi, mais l'ecart doit rester visible."""
    sync(db, FakeIncus(), "spark")
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "created_at,updated_at) VALUES ('S1','gros','images:debian/13','shared',3.5,"
        "1073741824,10000000,107374182400,'2026-08-18','2026-08-18')"
    )
    # Le pool retrecit sous ce qui est deja alloue.
    sync(db, FakeIncus(pool_payload={"space": {"total": 1_000_000}}), "spark")
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='host.sync' ORDER BY id DESC"
    ).fetchone()
    assert ligne["result"] == "denied"
    assert "storage" in ligne["message"]
    # Applique malgre tout : le registre ne ment pas sur la machine.
    assert db.execute("SELECT storage_total_bytes FROM host").fetchone()[0] == 1_000_000


def test_le_nom_d_hote_vient_de_l_api_serveur_pas_des_ressources():
    """@verifies docs/DAT.md §5.2

    `/1.0/resources` ne porte aucun nom d'hote : sa cle « system » decrit le
    materiel. Chercher le nom la rendait « inconnu », mesure sur l'hote reel.
    """
    assert read_topology(FakeIncus(), "spark").hostname == "spark-experiment"
