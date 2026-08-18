"""@verifies docs/BACKLOG.md#SPK-01 · docs/DAT.md §4, §5

Les sondes d'etat sont distinctes a dessein : « readyz » ne doit pas annoncer
une disponibilite que rien ne prouve (CLAUDE.md §18, pas de succes simule).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load


def client():
    return TestClient(create_app(load({"SPARKD_DRIVER": "fake"})))


def test_healthz_repond():
    reponse = client().get("/healthz")
    assert reponse.status_code == 200
    assert reponse.json()["status"] == "ok"


def test_readyz_ne_pretend_pas_etre_pret():
    reponse = client().get("/readyz")
    assert reponse.status_code == 200
    corps = reponse.json()
    assert corps["status"] == "degraded"
    assert set(corps["dependencies"]) == {"incus", "registry", "caddy"}
    assert all(etat == "unknown" for etat in corps["dependencies"].values())


def test_openapi_expose_le_contrat():
    schema = client().get("/openapi.json").json()
    assert "/healthz" in schema["paths"]
    assert "/readyz" in schema["paths"]
