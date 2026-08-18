"""@verifies docs/BACKLOG.md#SPK-09, #SPK-05 · docs/DAT.md §14.2, §14.3, §7.7

C'est ici que l'admission control cesse d'etre un module sans appelant : la
creation d'un Spark le traverse, et un refus laisse une trace.
"""

from __future__ import annotations

import pytest

from sparkd import migrations, sparks
from sparkd.db import connect
from sparkd.incus import FakeIncus
from sparkd.inventory import sync
from sparkd.lifecycle import Command, State

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    sync(connection, FakeIncus(), "spark")  # hote : 4 coeurs, 98 Gio, 192 Gio
    yield connection
    connection.close()


def spec(**champs) -> sparks.SparkSpec:
    base = dict(
        name="crm-production", image="images:debian/13", cpu_mode="shared",
        cpu_reservation=0.5, memory_bytes=2 * GIO,
        network_bps=100_000_000, storage_bytes=10 * GIO,
    )
    base.update(champs)
    return sparks.SparkSpec(**base)


# --- creation ---------------------------------------------------------------

def test_creation_ecrit_la_ligne_en_pending(db):
    """docs/DAT.md §14.2 : le registre s'ecrit AVANT Incus."""
    spark = sparks.create(db, spec())
    assert spark["state"] == State.PENDING.value
    assert spark["name"] == "crm-production"
    # Rien n'a ete cree dans Incus : c'est deliberé.
    assert spark["incus_name"] is None


def test_creation_consomme_la_capacite(db):
    avant = sparks.__dict__  # marqueur inutile, lisibilite
    from sparkd.admission import pools
    assert pools(db).cpu.allocated == 0
    sparks.create(db, spec(cpu_reservation=1.5))
    assert pools(db).cpu.allocated == 1.5


def test_nom_deja_pris_refuse(db):
    sparks.create(db, spec())
    with pytest.raises(sparks.SparkError, match="existe deja".replace("deja", "déjà")):
        sparks.create(db, spec())


@pytest.mark.parametrize("nom", ["Majuscule", "-tiret-devant", "tiret-derriere-", "avec_underscore", ""])
def test_nom_invalide_refuse(db, nom):
    with pytest.raises(sparks.SparkError, match="invalide"):
        sparks.create(db, spec(name=nom))


# --- admission control : l'appelant existe enfin ----------------------------

def test_creation_refusee_faute_de_capacite(db):
    sparks.create(db, spec(name="gros", cpu_reservation=3.5))
    with pytest.raises(sparks.AdmissionRefused) as refus:
        sparks.create(db, spec(name="trop", cpu_reservation=1.0))
    assert "cpu" in str(refus.value)
    assert "il manque" in str(refus.value)


def test_le_refus_d_admission_est_journalise(db):
    """Un refus se journalise au meme titre qu'un succes."""
    sparks.create(db, spec(name="gros", cpu_reservation=3.5))
    with pytest.raises(sparks.AdmissionRefused):
        sparks.create(db, spec(name="trop", cpu_reservation=1.0))
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.create' AND result='denied'"
    ).fetchone()
    assert ligne is not None
    assert "cpu" in ligne["message"]


def test_un_refus_ne_laisse_aucune_ligne(db):
    sparks.create(db, spec(name="gros", cpu_reservation=3.5))
    with pytest.raises(sparks.AdmissionRefused):
        sparks.create(db, spec(name="trop", cpu_reservation=1.0))
    assert [s["name"] for s in sparks.listing(db)] == ["gros"]


# --- commandes --------------------------------------------------------------

def test_parcours_complet(db):
    s = sparks.create(db, spec())
    ident = s["id"]
    assert sparks.command(db, ident, Command.APPLY)["state"] == "creating"
    assert sparks.finish(db, ident, success=True)["state"] == "stopped"
    assert sparks.command(db, ident, Command.START)["state"] == "starting"
    assert sparks.finish(db, ident, success=True)["state"] == "running"
    assert sparks.command(db, ident, Command.STOP)["state"] == "stopping"
    assert sparks.finish(db, ident, success=True)["state"] == "stopped"


def test_commande_interdite_refusee_et_journalisee(db):
    s = sparks.create(db, spec())
    with pytest.raises(sparks.SparkError, match="impossible"):
        sparks.command(db, s["id"], Command.START)
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.start' AND result='denied'"
    ).fetchone()
    assert ligne is not None


def test_echec_mene_a_error_et_retient_la_cause(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    apres = sparks.finish(db, s["id"], success=False, error="image introuvable")
    assert apres["state"] == "error"
    assert apres["last_error"] == "image introuvable"


def test_reprise_apres_error(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.finish(db, s["id"], success=False, error="panne")
    repris = sparks.command(db, s["id"], Command.RETRY)
    assert repris["state"] == "creating"
    # La reprise efface la cause precedente.
    assert repris["last_error"] is None


# --- suppression et restitution ---------------------------------------------

def test_la_ressource_n_est_rendue_qu_a_la_disparition(db):
    """docs/DAT.md §14.4."""
    from sparkd.admission import pools
    s = sparks.create(db, spec(cpu_reservation=2.0))
    sparks.command(db, s["id"], Command.DELETE)
    # En « deleting », le Spark compte encore.
    assert pools(db).cpu.allocated == 2.0
    assert sparks.finish(db, s["id"], success=True) is None
    assert pools(db).cpu.allocated == 0.0


def test_suppression_ratee_ne_perd_pas_le_spark(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.DELETE)
    apres = sparks.finish(db, s["id"], success=False, error="volume occupe")
    assert apres["state"] == "error"


# --- reconciliation au demarrage (§14.3) ------------------------------------

def test_creation_interrompue_revient_a_pending(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    resultats = sparks.reconcile_all(db, presence={})  # rien dans Incus
    assert resultats[0]["to"] == "pending"
    assert sparks.get(db, s["id"])["state"] == "pending"


def test_creation_aboutie_avant_l_arret_passe_a_stopped(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.reconcile_all(db, presence={"crm-production": (True, False)})
    assert sparks.get(db, s["id"])["state"] == "stopped"


def test_suppression_aboutie_retire_la_ligne(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.DELETE)
    sparks.reconcile_all(db, presence={})
    assert sparks.listing(db) == []


def test_un_etat_stable_n_est_pas_touche(db):
    s = sparks.create(db, spec())
    assert sparks.reconcile_all(db, presence={}) == []
    assert sparks.get(db, s["id"])["state"] == "pending"


def test_chaque_reconciliation_est_tracee(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.reconcile_all(db, presence={})
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.reconcile'"
    ).fetchone()
    assert ligne is not None and ligne["message"]
