"""@verifies docs/BACKLOG.md#SPK-05 · docs/DAT.md §7.3, §7.3 bis, §7.7

La Definition of Done nomme quatre cas limites — pool exactement plein,
dépassement d'une unité, surengagement > 1, réserve hôte — et exige un refus qui
nomme la ressource fautive et la capacité restante. Ces tests les éprouvent tous,
et surtout les REFUS : un admission control qui n'a jamais dit non n'a rien prouvé.

L'hôte de référence est la machine réellement mesurée le 2026-08-18 : 4 cœurs
physiques, 94 Gio, 1 Gbit/s, 5,4 Tio.
"""

from __future__ import annotations

import pytest

from sparkd import migrations
from sparkd.admission import (
    HostNotConfigured,
    Request,
    Resource,
    admit,
    pools,
)
from sparkd.db import connect

GIO = 1024**3
TIO = 1024**4


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def poser_hote(db, **overrides):
    valeurs = {
        "id": 1, "hostname": "spark-experiment",
        "cpu_threads_total": 8, "cpu_cores_total": 4,
        "memory_total_bytes": 94 * GIO,
        "storage_total_bytes": 5 * TIO,
        "network_total_bps": 1_000_000_000,
        "memory_reserve_bytes": 0, "storage_reserve_bytes": 0,
        "overcommit_cpu": 1.0, "overcommit_memory": 1.0, "overcommit_network": 1.0,
    }
    valeurs.update(overrides)
    colonnes = ", ".join(valeurs)
    db.execute(f"INSERT INTO host ({colonnes}) VALUES ({', '.join('?' * len(valeurs))})",
               tuple(valeurs.values()))


_compteur = [0]


def poser_spark(db, cpu_mode="shared", state="running", **champs):
    _compteur[0] += 1
    n = _compteur[0]
    valeurs = {
        "id": f"S{n}", "name": f"spark-{n}", "state": state,
        "image": "images:debian/13", "cpu_mode": cpu_mode,
        "cpu_reservation": None, "cpu_max": None, "cpu_cores": None,
        "memory_reservation_bytes": GIO,
        "network_reservation_bps": 10_000_000,
        "storage_bytes": 10 * GIO,
        "created_at": "2026-08-18T00:00:00+00:00",
        "updated_at": "2026-08-18T00:00:00+00:00",
    }
    valeurs.update(champs)
    colonnes = ", ".join(valeurs)
    db.execute(f"INSERT INTO spark ({colonnes}) VALUES ({', '.join('?' * len(valeurs))})",
               tuple(valeurs.values()))


def demande(**champs):
    base = {
        "cpu_mode": "shared", "cpu_reservation": 0.5,
        "memory_bytes": GIO, "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }
    base.update(champs)
    return Request(**base)


# --- prealable --------------------------------------------------------------

def test_rien_n_est_admis_sans_capacite_relevee(db):
    with pytest.raises(HostNotConfigured):
        admit(db, demande())


# --- capacite ---------------------------------------------------------------

def test_capacite_comptee_en_coeurs_physiques_pas_en_threads(db):
    """DAT §7.7 : le SMT entrelace l'execution, il n'ajoute pas de capacite."""
    poser_hote(db)  # 4 coeurs, 8 threads
    assert pools(db).cpu.capacity == 4.0


def test_reserve_hote_soustraite(db):
    poser_hote(db, memory_reserve_bytes=16 * GIO, storage_reserve_bytes=100 * GIO)
    etat = pools(db)
    assert etat.memory.capacity == (94 - 16) * GIO
    assert etat.storage.capacity == 5 * TIO - 100 * GIO


def test_surengagement_multiplie_la_capacite(db):
    poser_hote(db, overcommit_cpu=2.0, overcommit_memory=1.5)
    etat = pools(db)
    assert etat.cpu.capacity == 8.0
    assert etat.memory.capacity == 94 * GIO * 1.5


def test_stockage_jamais_surengage(db):
    """DAT §7.7 : un pool de stockage sature est une panne dure."""
    poser_hote(db, overcommit_cpu=4.0)
    assert pools(db).storage.overcommit == 1.0


# --- ce que chaque mode consomme -------------------------------------------

def test_capped_consomme_son_plafond(db):
    """DAT §7.7 : on provisionne ce que le Spark PEUT prendre."""
    poser_hote(db)
    poser_spark(db, cpu_mode="capped", cpu_max=1.5)
    assert pools(db).cpu.allocated == 1.5


def test_dedicated_ne_consomme_pas_de_reservation_mais_reduit_la_capacite(db):
    poser_hote(db)
    poser_spark(db, cpu_mode="dedicated", cpu_cores=2)
    etat = pools(db)
    assert etat.cpu.allocated == 0.0
    assert etat.cpu.capacity == 2.0  # 4 coeurs - 2 dedies
    assert etat.dedicated_cores == 2


def test_shared_pinned_consomme_sa_reservation_sans_retirer_de_coeurs(db):
    poser_hote(db)
    poser_spark(db, cpu_mode="shared-pinned", cpu_reservation=0.5, cpu_cores=2)
    etat = pools(db)
    assert etat.cpu.allocated == 0.5
    assert etat.cpu.capacity == 4.0


# --- quels Sparks comptent --------------------------------------------------

@pytest.mark.parametrize("state", ["running", "stopped", "error", "deleting", "pending"])
def test_tous_les_etats_comptent(db, state):
    """DAT §7.7 : la ressource n'est rendue qu'a la disparition de la ligne."""
    poser_hote(db)
    poser_spark(db, state=state, cpu_reservation=1.0)
    assert pools(db).cpu.allocated == 1.0


def test_ressource_rendue_a_la_suppression(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=1.0)
    db.execute("DELETE FROM spark")
    assert pools(db).cpu.allocated == 0.0


# --- les cas limites de la DoD ---------------------------------------------

def test_pool_exactement_plein_admis(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.5)
    assert admit(db, demande(cpu_reservation=0.5)).admitted is True


def test_depassement_d_une_unite_refuse(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.5)
    decision = admit(db, demande(cpu_reservation=0.51))
    assert decision.admitted is False
    assert [m.resource for m in decision.shortfalls] == [Resource.CPU]


def test_surengagement_permet_ce_qui_serait_refuse_sans_lui(db):
    poser_hote(db, overcommit_cpu=2.0)
    poser_spark(db, cpu_reservation=4.0)
    assert admit(db, demande(cpu_reservation=3.0)).admitted is True


def test_reserve_hote_provoque_le_refus(db):
    poser_hote(db, memory_reserve_bytes=90 * GIO)
    decision = admit(db, demande(memory_bytes=10 * GIO))
    assert decision.admitted is False
    assert decision.shortfalls[0].resource is Resource.MEMORY


# --- forme du refus ---------------------------------------------------------

def test_le_refus_nomme_la_ressource_et_ce_qui_reste(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.5)
    manque = admit(db, demande(cpu_reservation=1.0)).shortfalls[0]
    assert manque.resource is Resource.CPU
    assert manque.requested == 1.0
    assert manque.available == pytest.approx(0.5)
    assert manque.capacity == 4.0
    assert manque.allocated == 3.5
    assert manque.missing == pytest.approx(0.5)


def test_toutes_les_ressources_manquantes_sont_rapportees(db):
    """DAT §7.7 : corriger une demande pour se heurter a la suivante est evitable."""
    poser_hote(db)
    decision = admit(db, demande(
        cpu_reservation=99.0, memory_bytes=200 * GIO,
        network_bps=9_000_000_000, storage_bytes=99 * TIO,
    ))
    assert decision.admitted is False
    assert {m.resource for m in decision.shortfalls} == {
        Resource.CPU, Resource.MEMORY, Resource.NETWORK, Resource.STORAGE
    }


def test_le_message_de_refus_est_exploitable(db):
    poser_hote(db, overcommit_cpu=2.0)
    poser_spark(db, cpu_reservation=7.5)
    message = admit(db, demande(cpu_reservation=1.0)).reason
    assert "cpu" in message
    assert "surengagement" in message  # visible seulement s'il n'est pas a 1
    assert "il manque" in message


def test_decision_utilisable_comme_booleen(db):
    poser_hote(db)
    assert bool(admit(db, demande())) is True


# --- coeurs dedies ----------------------------------------------------------

def test_dedie_refuse_si_pas_assez_de_coeurs_libres(db):
    poser_hote(db)
    poser_spark(db, cpu_mode="dedicated", cpu_cores=3)
    decision = admit(db, demande(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    assert decision.admitted is False


def test_dedie_refuse_s_il_asphyxierait_les_sparks_partages(db):
    """Retirer des coeurs reduit le pool : les Sparks deja admis doivent y tenir."""
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.0)
    decision = admit(db, demande(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    assert decision.admitted is False
    assert decision.shortfalls[0].resource is Resource.CPU


def test_dedie_admis_si_la_place_existe(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=1.0)
    assert admit(db, demande(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2)).admitted
