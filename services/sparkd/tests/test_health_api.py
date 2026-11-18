"""@verifies docs/BACKLOG.md#SPK-184 · docs/DAT.md §75.3 (la sonde ne vise que les domaines du
Spark), §75.8 (l'API ; poser est une écriture, relever continue), §75.9 (valider) · CLAUDE.md §10
(toute règle d'accès se prouve par une requête directe qui contourne l'interface)

Les refus sont prouvés par l'API, sans interface : une adresse qui n'est pas une route du Spark est
refusée (c'est ce qui ferme la voie à une requête choisie par un locataire), un Spark protégé refuse
toute écriture et le test d'un script, mais ses relevés planifiés continuent.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3
T0 = datetime(2026, 11, 18, 10, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def env(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "p.db"), "SPARKD_DRIVER": "fake"}))
    client = TestClient(app)
    client.post("/v1/forge/sync")
    return client, app


@pytest.fixture
def client(env):
    return env[0]


def creer(client, nom="crm", domaine="crm.example.com"):
    r = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO})
    assert r.status_code == 201, r.text
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    if domaine:
        r = client.post("/v1/ingress", json={"spark": nom, "domain": domaine, "port": 8080, "tls": True})
        assert r.status_code == 201, r.text
    return nom


def corps(**extra):
    return {"kind": "http", "target": "https://crm.example.com/healthz", "expected": 200,
            "schedule": "*/5 * * * *", "threshold": 3, **extra}


# --- lire, poser, relire -------------------------------------------------------------------------------

def test_sans_sonde_la_liste_est_vide_avec_sa_borne(client):
    nom = creer(client)
    assert client.get(f"/v1/sparks/{nom}/health").json() == {"checks": [], "limit": 20}


def test_poser_puis_relire(client):
    nom = creer(client)
    r = client.put(f"/v1/sparks/{nom}/health/api", json=corps())
    assert r.status_code == 200, r.text
    vue = r.json()
    assert vue["name"] == "api" and vue["state"] == "unknown" and vue["enabled"]
    assert vue["description"] == "Toutes les 5 minutes (UTC)"
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == [vue]


def test_le_nom_vient_du_chemin_pas_du_corps(client):
    nom = creer(client)
    r = client.put(f"/v1/sparks/{nom}/health/api", json=corps(name="autre"))
    assert r.json()["name"] == "api"


def test_un_spark_inconnu_est_404(client):
    creer(client)
    for r in (client.get("/v1/sparks/absent/health"),
              client.put("/v1/sparks/absent/health/api", json=corps()),
              client.delete("/v1/sparks/absent/health/api"),
              client.post("/v1/sparks/absent/health/test", json=corps())):
        assert r.status_code == 404


# --- le point de sécurité : une adresse qui n'est pas une route du Spark est refusée ------------------------

@pytest.mark.parametrize("cible, raison", [
    ("https://127.0.0.1:2019/config/", "port"),                       # l'API de Caddy
    ("https://127.0.0.1/", "pas une route de ce Spark"),
    ("https://localhost/", "pas une route de ce Spark"),
    ("https://10.77.0.17/", "pas une route de ce Spark"),            # l'intérieur d'un autre Spark
    ("https://autre.example.com/", "pas une route de ce Spark"),     # la route d'un AUTRE Spark
    ("http://crm.example.com/", "https"),
    ("https://user:x@crm.example.com/", "identifiant"),
    ("https://*.example.com/", "joker"),
])
def test_une_sonde_ne_peut_viser_que_les_routes_de_son_spark(env, cible, raison):
    client, _app = env
    nom = creer(client)
    creer(client, "autre", "autre.example.com")
    r = client.put(f"/v1/sparks/{nom}/health/api", json=corps(target=cible))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_health" and raison in r.json()["detail"]["message"]
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []        # rien n'a été écrit
    # Et le test (qui exécute) refuse la même chose.
    assert client.post(f"/v1/sparks/{nom}/health/test", json=corps(target=cible)).status_code == 422


@pytest.mark.parametrize("modif, raison", [
    ({"threshold": 0}, "entre 1 et 20"),
    ({"schedule": "*/3 * * * *"}, "5 minutes"),
    ({"schedule": "@daily"}, "alias"),
    ({"expected": 42}, "entre 100 et 599"),
    ({"kind": "tcp"}, "Type"),
])
def test_refus_de_validation_avec_la_raison(client, modif, raison):
    nom = creer(client)
    r = client.put(f"/v1/sparks/{nom}/health/api", json=corps(**modif))
    assert r.status_code == 422 and raison in r.json()["detail"]["message"]


def test_nom_invalide_dans_le_chemin(client):
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/health/MAJ", json=corps()).status_code == 422


def test_un_script_se_pose_et_se_teste(client):
    nom = creer(client)
    script = {"kind": "script", "target": "true", "expected": 0, "schedule": "*/10 * * * *", "threshold": 2}
    assert client.put(f"/v1/sparks/{nom}/health/base", json=script).status_code == 200
    r = client.post(f"/v1/sparks/{nom}/health/test", json=script)
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["kind"] == "script"
    echec = client.post(f"/v1/sparks/{nom}/health/test", json={**script, "target": "exit 4"}).json()
    assert echec["ok"] is False and "code de sortie 4" in echec["detail"]


# --- tester n'écrit rien --------------------------------------------------------------------------------------

def test_tester_n_ecrit_ni_sonde_ni_releve(env):
    client, app = env
    nom = creer(client)
    app.state.sondes.poser("crm.example.com", sante={"status": 503})
    r = client.post(f"/v1/sparks/{nom}/health/test", json=corps())
    assert r.status_code == 200 and r.json()["ok"] is False and "HTTP 503" in r.json()["detail"]
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []


# --- suspendre, reprendre, retirer -------------------------------------------------------------------------------

def test_suspendre_reprendre_retirer(client):
    nom = creer(client)
    client.put(f"/v1/sparks/{nom}/health/api", json=corps())
    assert client.post(f"/v1/sparks/{nom}/health/api/suspend").json()["enabled"] is False
    assert client.post(f"/v1/sparks/{nom}/health/api/resume").json()["enabled"] is True
    assert client.delete(f"/v1/sparks/{nom}/health/api").json()["checks"] == []


def test_gestes_sur_une_sonde_absente_et_geste_inconnu(client):
    nom = creer(client)
    assert client.post(f"/v1/sparks/{nom}/health/x/suspend").status_code == 422
    assert client.delete(f"/v1/sparks/{nom}/health/x").status_code == 422
    assert client.post(f"/v1/sparks/{nom}/health/x/danser").status_code == 404


# --- un Spark protégé refuse les écritures, mais ses relevés continuent ----------------------------------------------

def test_un_spark_protege_refuse_poser_modifier_suspendre_retirer_et_tester(client):
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/health/api", json=corps()).status_code == 200
    assert client.post(f"/v1/sparks/{nom}/protection", json={"password": "secret"}).status_code == 200
    for r in (
        client.put(f"/v1/sparks/{nom}/health/api", json=corps(threshold=5)),
        client.put(f"/v1/sparks/{nom}/health/neuf", json=corps()),
        client.post(f"/v1/sparks/{nom}/health/api/suspend"),
        client.post(f"/v1/sparks/{nom}/health/api/resume"),
        client.delete(f"/v1/sparks/{nom}/health/api"),
        client.post(f"/v1/sparks/{nom}/health/test", json=corps()),       # exécuter est un geste
    ):
        assert r.status_code == 423, r.text
        assert r.json()["detail"]["error"] == "spark_protected"
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"][0]["threshold"] == 3   # inchangée
    assert client.get(f"/v1/sparks/{nom}/health").status_code == 200                       # lire est ouvert


def test_les_releves_continuent_sur_un_spark_protege(env):
    client, app = env
    nom = creer(client)
    client.put(f"/v1/sparks/{nom}/health/api", json=corps(threshold=1))
    client.post(f"/v1/sparks/{nom}/protection", json={"password": "secret"})
    app.state.sondes.poser("crm.example.com", sante={"status": 500})
    rendus = app.state.sante.un_pas(datetime.now(timezone.utc) + timedelta(minutes=1))
    assert [r["resultat"] for r in rendus] == ["echec"]
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"][0]["state"] == "down"


# --- le fil est câblé ------------------------------------------------------------------------------------------------------

def test_le_fil_de_sante_est_cable_et_vide_sans_sonde(env):
    _client, app = env
    assert app.state.sante.un_pas(T0) == []


def test_un_spark_arrete_est_arrete_pour_la_sonde(env):
    client, app = env
    nom = creer(client)
    client.put(f"/v1/sparks/{nom}/health/api", json=corps())
    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 200
    rendus = app.state.sante.un_pas(datetime.now(timezone.utc) + timedelta(minutes=1))
    assert [r["resultat"] for r in rendus] == ["stopped"]
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"][0]["state"] == "stopped"
