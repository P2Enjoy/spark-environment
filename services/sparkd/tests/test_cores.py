"""@verifies docs/BACKLOG.md#SPK-06 · docs/DAT.md §7.4, §7.4 bis, §7.4 ter, §7.5

Le point le plus important n'est pas que les coeurs changent de pool, c'est que
le POIDS des Sparks partages suive : ne reconfigurer que le cpuset leur
laisserait un poids calcule pour un pool qui n'existe plus.

Hote de reference : 4 coeurs, freres SMT (0,4) (1,5) (2,6) (3,7).
"""

from __future__ import annotations

import pytest

from sparkd import cores, migrations
from sparkd.db import connect
from sparkd.incus import FakeIncus
from sparkd.inventory import sync

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "c.db")
    migrations.upgrade(connection)
    sync(connection, FakeIncus(), "spark")
    yield connection
    connection.close()


def poser_spark(db, ident, mode="shared", reservation=0.5, priorite=5, plafond=None):
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,cpu_max,cpu_cores,"
        "cpu_priority,memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'x','x')",
        (ident, f"s-{ident}", "images:debian/13", mode,
         reservation if mode in ("shared", "shared-pinned") else None,
         plafond, 1 if mode in ("dedicated", "shared-pinned") else None,
         priorite, GIO, 10_000_000, GIO),
    )


# --- etat initial -----------------------------------------------------------

def test_tout_est_partage_au_depart(db):
    assert cores.shared_capacity(db) == 4.0
    assert cores.shared_cpus(db) == [0, 1, 2, 3, 4, 5, 6, 7]
    assert cores.layout(db)["dedicated"] == []


# --- decoupe ----------------------------------------------------------------

def test_la_decoupe_emporte_les_freres_smt(db):
    """docs/DAT.md §7.5 : un coeur dedie n'est pas un CPU logique."""
    poser_spark(db, "D", mode="dedicated")
    r = cores.carve(db, "D", 1)
    # Coeur 0 -> CPU 0 ET 4. Prendre le seul CPU 0 ne donnerait aucune exclusivite.
    assert r.dedicated_cpus == (0, 4)
    assert cores.shared_cpus(db) == [1, 2, 3, 5, 6, 7]


def test_la_decoupe_est_deterministe(db):
    """Les coeurs libres de plus petit indice, pour que ce soit verifiable."""
    poser_spark(db, "D", mode="dedicated")
    assert cores.carve(db, "D", 2).dedicated_cpus == (0, 4, 1, 5)


def test_la_capacite_partagee_diminue(db):
    poser_spark(db, "D", mode="dedicated")
    cores.carve(db, "D", 2)
    assert cores.shared_capacity(db) == 2.0


# --- LE point : le poids suit la capacite -----------------------------------

def test_le_poids_des_partages_est_recalcule(db):
    """docs/DAT.md §7.4 bis — sinon 0,5 CPU vaudrait la moitie de ce qui est vendu."""
    poser_spark(db, "P", mode="shared", reservation=0.5)
    poser_spark(db, "D", mode="dedicated")
    # Avant : 0,5 / 4 x 1000 = 125 %
    assert cores._recompute_shared(db, 4.0)[0]["allowance"] == "125%"
    r = cores.carve(db, "D", 2)
    # Apres : 0,5 / 2 x 1000 = 250 %. La reservation absolue est preservee.
    assert r.reconfigured[0]["allowance"] == "250%"


def test_tous_les_sparks_partages_sont_reconfigures(db):
    poser_spark(db, "A", reservation=0.5)
    poser_spark(db, "B", reservation=1.0)
    poser_spark(db, "D", mode="dedicated")
    r = cores.carve(db, "D", 2)
    assert {e["name"] for e in r.reconfigured} == {"s-A", "s-B"}
    assert [e["allowance"] for e in r.reconfigured] == ["250%", "500%"]


def test_un_spark_plafonne_n_est_pas_recalcule(db):
    """Un plafond dur est absolu : il ne depend pas de la capacite du pool."""
    poser_spark(db, "C", mode="capped", reservation=None, plafond=0.5)
    poser_spark(db, "D", mode="dedicated")
    r = cores.carve(db, "D", 2)
    assert r.reconfigured[0]["allowance"] is None


def test_shared_pinned_est_recalcule_comme_un_partage(db):
    poser_spark(db, "SP", mode="shared-pinned", reservation=0.5)
    poser_spark(db, "D", mode="dedicated")
    assert cores.carve(db, "D", 2).reconfigured[0]["allowance"] == "250%"


# --- refus ------------------------------------------------------------------

def test_pas_assez_de_coeurs_libres(db):
    poser_spark(db, "D", mode="dedicated")
    with pytest.raises(cores.CoreAllocationError, match="libres"):
        cores.carve(db, "D", 5)


def test_zero_coeur_refuse(db):
    poser_spark(db, "D", mode="dedicated")
    with pytest.raises(cores.CoreAllocationError, match="au moins un"):
        cores.carve(db, "D", 0)


def test_vider_le_pool_partage_est_refuse_s_il_est_habite(db):
    """Les Sparks partages n'auraient plus ou tourner."""
    poser_spark(db, "P", reservation=0.5)
    poser_spark(db, "D", mode="dedicated")
    with pytest.raises(cores.CoreAllocationError, match="aucun cœur"):
        cores.carve(db, "D", 4)


def test_vider_le_pool_partage_est_permis_s_il_est_vide(db):
    poser_spark(db, "D", mode="dedicated")
    assert cores.carve(db, "D", 4).shared_capacity == 0.0


def test_un_refus_ne_modifie_rien(db):
    poser_spark(db, "P", reservation=0.5)
    poser_spark(db, "D", mode="dedicated")
    with pytest.raises(cores.CoreAllocationError):
        cores.carve(db, "D", 4)
    assert cores.shared_capacity(db) == 4.0
    assert cores.layout(db)["dedicated"] == []


# --- restitution ------------------------------------------------------------

def test_la_restitution_rend_les_coeurs_et_le_poids(db):
    poser_spark(db, "P", reservation=0.5)
    poser_spark(db, "D", mode="dedicated")
    cores.carve(db, "D", 2)
    r = cores.release(db, "D")
    assert r.shared_capacity == 4.0
    assert r.shared_cpus == (0, 1, 2, 3, 4, 5, 6, 7)
    assert r.reconfigured[0]["allowance"] == "125%"   # revenu a l'etat initial


def test_decoupe_puis_restitution_rendent_l_etat_initial(db):
    poser_spark(db, "P", reservation=0.5)
    poser_spark(db, "D", mode="dedicated")
    avant = cores.layout(db)
    cores.carve(db, "D", 2)
    cores.release(db, "D")
    assert cores.layout(db) == avant


def test_l_epinglage_est_efface_a_la_restitution(db):
    poser_spark(db, "D", mode="dedicated")
    cores.carve(db, "D", 1)
    assert db.execute("SELECT count(*) FROM spark_cpu_pin").fetchone()[0] == 1
    cores.release(db, "D")
    assert db.execute("SELECT count(*) FROM spark_cpu_pin").fetchone()[0] == 0


def test_deux_sparks_dedies_ne_partagent_aucun_coeur(db):
    poser_spark(db, "D1", mode="dedicated")
    poser_spark(db, "D2", mode="dedicated")
    a = cores.carve(db, "D1", 1)
    b = cores.carve(db, "D2", 1)
    assert set(a.dedicated_cpus).isdisjoint(b.dedicated_cpus)
    assert cores.shared_capacity(db) == 2.0
