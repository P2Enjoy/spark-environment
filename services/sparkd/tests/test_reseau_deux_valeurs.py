"""@verifies docs/BACKLOG.md#SPK-142 · docs/DAT.md §49.7 (la réservation et le
plafond réseau, réglés séparément ; les trois contrôles de cohérence ; le
plafond posé sur `eth0`) · §7.6, §15.4, §49.2 (`applied`)

Le défaut, signalé par le responsable le 2026-10-01 : monter le débit d'un Spark
finissait en `500`. La modale écrivait la réservation, jamais le plafond, et la
contrainte `plafond ≥ réservation` du registre levait une erreur que rien ne
rattrapait. Et rien n'atteignait la carte : `limits.max` vit sur `eth0`, que la
pose des quotas ne touchait pas.

Ces preuves tournent sur le doublon : ce sont des diagnostics (DAT §28.7). La
validation se fait dans la console branchée sur la VM du banc (SPK-137).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3
MBIT = 1_000_000


def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "r.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _capacite(client) -> int:
    return client.get("/v1/forge").json()["network"]["total_bps"]


def _creer(client, nom="crm", **reseau):
    corps = {"name": nom, "image": "images:debian/13", "cpu_mode": "shared",
             "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
             "network_bps": 10 * MBIT, **reseau}
    return client.post("/v1/sparks", json=corps)


def _demarre(client, nom="crm", **reseau):
    assert _creer(client, nom, **reseau).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200


def _eth0(client, nom="crm") -> dict:
    return client.app.state.incus.created[nom]["devices"]["eth0"]


# --- le défaut signalé ----------------------------------------------------------

def test_monter_la_RESERVATION_au_dessus_du_plafond_est_un_refus_NOMME_pas_un_500(tmp_path):
    """LE défaut. Rouge sur le code d'avant : `500 Internal Server Error`."""
    client = _client(tmp_path)
    _demarre(client)

    refus = client.patch("/v1/sparks/crm", json={"network_reservation_bps": 100 * MBIT})

    assert refus.status_code == 422
    detail = refus.json()["detail"]
    assert detail["error"] == "quota_incoherent"
    assert detail["field"] == "network_burst_bps"
    assert "plafond" in detail["message"] and "100" in detail["message"]
    spark = client.get("/v1/sparks/crm").json()
    assert spark["network_reservation_bps"] == 10 * MBIT, "rien n'a été écrit"


def test_monter_les_DEUX_ensemble_passe_et_le_plafond_atteint_la_carte(tmp_path):
    client = _client(tmp_path)
    _demarre(client)

    rendu = client.patch("/v1/sparks/crm", json={
        "network_reservation_bps": 100 * MBIT, "network_burst_bps": 200 * MBIT})

    assert rendu.status_code == 200, rendu.text
    assert rendu.json()["applied"] is True
    spark = client.get("/v1/sparks/crm").json()
    assert (spark["network_reservation_bps"], spark["network_burst_bps"]) == (100 * MBIT, 200 * MBIT)
    assert _eth0(client)["limits.max"] == str(200 * MBIT), "le plafond est POSÉ sur eth0"


def test_le_PLAFOND_seul_se_regle_sans_toucher_la_reservation(tmp_path):
    """Rouge sur le code d'avant : `network_burst_bps` n'était pas redimensionnable."""
    client = _client(tmp_path)
    _demarre(client)

    assert client.patch("/v1/sparks/crm", json={"network_burst_bps": 50 * MBIT}).status_code == 200

    spark = client.get("/v1/sparks/crm").json()
    assert (spark["network_reservation_bps"], spark["network_burst_bps"]) == (10 * MBIT, 50 * MBIT)
    assert _eth0(client)["limits.max"] == str(50 * MBIT)


# --- les trois contrôles de cohérence (§49.7) --------------------------------------

def test_un_plafond_SOUS_la_reservation_est_refuse(tmp_path):
    client = _client(tmp_path)
    _demarre(client)
    refus = client.patch("/v1/sparks/crm", json={"network_burst_bps": 5 * MBIT})
    assert refus.status_code == 422
    assert refus.json()["detail"]["field"] == "network_burst_bps"


def test_un_plafond_AU_DELA_de_la_capacite_de_la_Forge_est_refuse(tmp_path):
    client = _client(tmp_path)
    _demarre(client)
    capacite = _capacite(client)
    refus = client.patch("/v1/sparks/crm", json={"network_burst_bps": capacite + MBIT})
    assert refus.status_code == 422
    assert "capacité réseau de la Forge" in refus.json()["detail"]["message"]
    assert client.patch("/v1/sparks/crm", json={"network_burst_bps": capacite}).status_code == 200


@pytest.mark.parametrize("valeur", [0, -1, 1.5, "100", True])
def test_une_valeur_qui_n_est_pas_un_entier_POSITIF_est_refusee(tmp_path, valeur):
    client = _client(tmp_path)
    _demarre(client)
    refus = client.patch("/v1/sparks/crm", json={"network_burst_bps": valeur})
    assert refus.status_code == 422
    assert refus.json()["detail"]["error"] == "quota_incoherent"


# --- la création ------------------------------------------------------------------

def test_a_la_creation_un_plafond_absent_VAUT_la_reservation(tmp_path):
    client = _client(tmp_path)
    _demarre(client)
    spark = client.get("/v1/sparks/crm").json()
    assert spark["network_burst_bps"] == spark["network_reservation_bps"] == 10 * MBIT


def test_a_la_creation_les_deux_valeurs_se_donnent_separement(tmp_path):
    client = _client(tmp_path)
    _demarre(client, network_burst_bps=80 * MBIT)
    spark = client.get("/v1/sparks/crm").json()
    assert (spark["network_reservation_bps"], spark["network_burst_bps"]) == (10 * MBIT, 80 * MBIT)
    assert _eth0(client)["limits.max"] == str(80 * MBIT)


def test_a_la_creation_un_plafond_sous_la_reservation_est_refuse_SANS_500(tmp_path):
    """Rouge sur le code d'avant : la contrainte du registre levait, non rattrapée."""
    client = _client(tmp_path)
    refus = _creer(client, network_bps=50 * MBIT, network_burst_bps=10 * MBIT)
    assert refus.status_code == 422
    assert refus.json()["detail"]["field"] == "network_burst_bps"
    assert client.get("/v1/sparks").json()["sparks"] == [], "rien n'a été créé"
