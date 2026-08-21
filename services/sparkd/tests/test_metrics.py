"""@verifies docs/BACKLOG.md#SPK-14 · docs/DAT.md §20

Le piege que ces tests gardent : un compteur n'est pas un taux, et rendre 0
quand on ne sait pas serait affirmer une mesure non faite — d'autant plus
dangereux que 0 est plausible, donc indetectable.
"""

from __future__ import annotations

import pytest

from sparkd import metrics

GIO = 1024**3

# Etat reel releve sur l'hote le 2026-08-19.
ETAT = {
    "status": "Running",
    "cpu": {"usage": 4_815_083_000, "allocated_time": 8_000_000_000},
    "memory": {"usage": 174_764_032, "total": 2 * GIO},
    "disk": {"root": {"total": 10 * GIO, "usage": 534_981_632}},
    "network": {
        "eth0": {"counters": {"bytes_received": 461, "bytes_sent": 2192}},
        # Bridges internes que Docker cree DANS le Spark.
        "docker0": {"counters": {"bytes_received": 10**9, "bytes_sent": 10**9}},
        "br-463ed": {"counters": {"bytes_received": 10**9, "bytes_sent": 10**9}},
        "lo": {"counters": {"bytes_received": 10**9, "bytes_sent": 10**9}},
    },
}

SPARK = {
    "name": "crm", "state": "running", "cpu_mode": "shared", "cpu_reservation": 0.5,
    "cpu_max": None, "memory_reservation_bytes": 2 * GIO, "storage_bytes": 10 * GIO,
    "network_reservation_bps": 100_000_000, "network_burst_bps": 500_000_000,
}


# --- seule eth0 compte (§20.2) ----------------------------------------------

def test_les_bridges_docker_ne_sont_pas_comptes():
    """Ce trafic ne traverse jamais le bridge de l'hote."""
    e = metrics.read_sample(ETAT, now=0.0)
    assert e.rx_bytes == 461 and e.tx_bytes == 2192   # et non 3 x 10^9


def test_une_interface_absente_ne_fait_pas_echouer():
    e = metrics.read_sample({"cpu": {"usage": 1}, "network": {}}, now=0.0)
    assert e.rx_bytes == 0 and e.tx_bytes == 0


# --- un compteur n'est pas un taux (§20.1) ----------------------------------

def test_le_premier_releve_ne_rend_PAS_zero():
    """Zero est plausible, donc indetectable : il faut dire qu'on ne sait pas."""
    suivi = metrics.RateTracker()
    r = suivi.observe("S1", metrics.Sample(0.0, 1_000_000_000, 100, 200))
    assert r["cpu"] is None
    assert r["network_rx_bps"] is None
    assert r["window_seconds"] is None
    assert "Premier relevé" in r["unavailable"]


def test_le_taux_est_calcule_sur_deux_releves():
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 4_815_083_000, 461, 2192))
    r = suivi.observe("S1", metrics.Sample(3.0, 4_817_955_000, 461, 2192))
    # Les chiffres mesures sur l'hote : 2 872 000 ns sur 3 s.
    assert r["cpu"] == pytest.approx(0.001, abs=1e-4)
    assert r["window_seconds"] == 3.0


def test_le_debit_reseau_est_en_bits_par_seconde():
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    r = suivi.observe("S1", metrics.Sample(1.0, 0, 1_000_000, 2_000_000))
    assert r["network_rx_bps"] == 8_000_000
    assert r["network_tx_bps"] == 16_000_000


def test_une_fenetre_trop_courte_ne_produit_pas_de_taux():
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    r = suivi.observe("S1", metrics.Sample(0.1, 10**9, 0, 0))
    assert r["cpu"] is None and "trop courte" in r["unavailable"]


def test_un_compteur_qui_recule_signale_un_redemarrage():
    """Sans ce controle, la difference serait negative donc absurde."""
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 10**10, 10**6, 10**6))
    r = suivi.observe("S1", metrics.Sample(5.0, 1000, 10, 10))
    assert r["cpu"] is None and "redémarré" in r["unavailable"]


def test_chaque_spark_a_son_propre_suivi():
    suivi = metrics.RateTracker()
    suivi.observe("A", metrics.Sample(0.0, 0, 0, 0))
    # Le premier releve de B ne doit pas emprunter la fenetre de A.
    assert suivi.observe("B", metrics.Sample(3.0, 10**9, 0, 0))["cpu"] is None


def test_oublier_un_spark_repart_de_zero():
    suivi = metrics.RateTracker()
    suivi.observe("A", metrics.Sample(0.0, 0, 0, 0))
    suivi.forget("A")
    assert suivi.observe("A", metrics.Sample(3.0, 10**9, 0, 0))["cpu"] is None


# --- a quoi ca se compare (§20.3) -------------------------------------------

def test_le_reseau_se_compare_au_PLAFOND_pas_a_la_reservation():
    """Comparer a la reservation laisserait croire a une garantie inexistante."""
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    taux = suivi.observe("S1", metrics.Sample(2.0, 0, 0, 0))
    u = metrics.usage(SPARK, ETAT, taux)
    assert u["network"]["limit_bps"] == 500_000_000       # le plafond
    assert u["network"]["reservation_bps"] == 100_000_000  # rappele, pas compare
    assert "seul le plafond est" in u["network"]["note"]


def test_la_garantie_cpu_reste_honnete():
    """docs/DAT.md §7.3 bis — tant que SPK-29 n'est pas livree."""
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    u = metrics.usage(SPARK, ETAT, suivi.observe("S1", metrics.Sample(2.0, 0, 0, 0)))
    assert u["cpu"]["guarantee"] == "floor_under_contention"
    assert u["cpu"]["reservation"] == 0.5


def test_un_spark_plafonne_se_compare_a_son_plafond():
    plafonne = dict(SPARK, cpu_mode="capped", cpu_reservation=None, cpu_max=0.5)
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    u = metrics.usage(plafonne, ETAT, suivi.observe("S1", metrics.Sample(2.0, 0, 0, 0)))
    assert u["cpu"]["reservation"] == 0.5


def test_memoire_et_disque_sont_instantanes():
    suivi = metrics.RateTracker()
    u = metrics.usage(SPARK, ETAT, suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0)))
    # Disponibles des le PREMIER releve, contrairement aux taux.
    assert u["memory"]["used_bytes"] == 174_764_032
    assert u["memory"]["ratio"] == pytest.approx(0.0814, abs=1e-3)
    assert u["disk"]["used_bytes"] == 534_981_632
    assert "instantanés" in u["disk"]["note"]


# --- un Spark arrete (§20.4) ------------------------------------------------

def test_un_spark_arrete_n_a_pas_un_usage_nul():
    """Afficher 0 laisserait croire qu'il ne coute rien."""
    u = metrics.stopped(dict(SPARK, state="stopped"))
    assert u["cpu"] is None and u["disk"] is None
    assert "disque reste" in u["unavailable"]
    assert "comptabilisée" in u["unavailable"]


# --- consommer plus que sa reservation est NORMAL (§20.3 bis) ---------------

def test_le_burst_n_est_pas_un_depassement():
    """Mesure sur l'hote : 1,996 CPU pour une reservation de 0,5.

    Une jauge rouge sur « 1,99 / 0,5 » signalerait une violation la ou il n'y a
    qu'un usage optimal de la machine.
    """
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    taux = suivi.observe("S1", metrics.Sample(6.0, int(1.996 * 6 * 1e9), 0, 0))
    cpu = metrics.usage(SPARK, ETAT, taux)["cpu"]
    assert cpu["used"] == pytest.approx(1.996, abs=1e-3)
    assert cpu["burst"] == pytest.approx(1.496, abs=1e-3)
    assert cpu["capped"] is False
    assert cpu["over_limit"] is False        # jamais un depassement en mode partage


def test_un_depassement_n_existe_qu_en_mode_plafonne():
    plafonne = dict(SPARK, cpu_mode="capped", cpu_reservation=None, cpu_max=0.5)
    suivi = metrics.RateTracker()
    suivi.observe("S1", metrics.Sample(0.0, 0, 0, 0))
    taux = suivi.observe("S1", metrics.Sample(6.0, int(1.5 * 6 * 1e9), 0, 0))
    cpu = metrics.usage(plafonne, ETAT, taux)["cpu"]
    assert cpu["capped"] is True and cpu["over_limit"] is True
