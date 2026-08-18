"""@verifies docs/BACKLOG.md#SPK-01 · docs/DAT.md §4, §5

Les sondes d'etat sont distinctes a dessein : « readyz » ne doit pas annoncer
une disponibilite que rien ne prouve (CLAUDE.md §18, pas de succes simule).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load


def client(tmp_path=None):
    import tempfile
    base = tempfile.mkdtemp() + "/spark.db"
    return TestClient(create_app(load({"SPARKD_DB": base, "SPARKD_DRIVER": "fake"})))


def test_healthz_repond():
    reponse = client().get("/healthz")
    assert reponse.status_code == 200
    assert reponse.json()["status"] == "ok"


def test_readyz_ne_pretend_pas_etre_pret():
    """Revise le 2026-08-18, avec SPK-04.

    Cette preuve exigeait auparavant que TOUTES les dependances soient
    « unknown ». La regle a change parce que le registre existe desormais : son
    etat est reellement connu, et continuer a le declarer inconnu serait le
    mensonge que ce test cherche justement a empecher. Elle est donc revisee, et
    non contournee : ce qui reste verifie, c'est qu'aucune dependance encore
    non implementee — Incus, Caddy — ne s'annonce prete.
    """
    reponse = client().get("/readyz")
    assert reponse.status_code == 200
    corps = reponse.json()
    assert corps["status"] == "degraded"
    assert set(corps["dependencies"]) == {"incus", "registry", "caddy"}
    assert corps["dependencies"]["incus"] == "unknown"
    assert corps["dependencies"]["caddy"] == "unknown"
    # Le registre est migre par create_app : il est connu, jamais « unknown ».
    assert corps["dependencies"]["registry"] in {"ready", "empty"}


def test_openapi_expose_le_contrat():
    schema = client().get("/openapi.json").json()
    assert "/healthz" in schema["paths"]
    assert "/readyz" in schema["paths"]


def test_readyz_annonce_la_version_de_schema(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §12.4"""
    from sparkd import migrations
    from sparkd.db import connect

    base = tmp_path / "spark.db"
    connexion = connect(base)
    migrations.upgrade(connexion)
    connexion.close()

    app = create_app(load({"SPARKD_DB": str(base), "SPARKD_DRIVER": "fake"}))
    corps = TestClient(app).get("/readyz").json()
    assert corps["dependencies"]["registry"] == "ready"
    assert corps["schema_version"] == 1


def test_demarrage_refuse_si_le_schema_a_derive(tmp_path, monkeypatch):
    """@verifies docs/SCHEMA.md §12.4 — sparkd refuse de servir une base derivee."""
    from sparkd import migrations
    from sparkd.db import connect

    base = tmp_path / "spark.db"
    connexion = connect(base)
    migrations.upgrade(connexion)
    # La base declare une migration dont le depot n'a pas le fichier.
    connexion.execute(
        "INSERT INTO schema_migration (version, applied_at, checksum)"
        " VALUES (99, '2026-08-18', 'inexistant')"
    )
    connexion.close()

    with pytest.raises(migrations.MigrationError, match="autre code"):
        create_app(load({"SPARKD_DB": str(base), "SPARKD_DRIVER": "fake"}))


# --- inventaire de l'hote (SPK-07) -----------------------------------------

def test_host_refuse_avant_tout_releve(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.3"""
    app = create_app(load({"SPARKD_DB": str(tmp_path / "a.db"), "SPARKD_DRIVER": "fake"}))
    reponse = TestClient(app).get("/v1/host")
    assert reponse.status_code == 409
    assert reponse.json()["detail"]["remedy"] == "POST /v1/host/sync"


def test_sync_puis_host_expose_les_pools(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-07, #SPK-05 — l'admission control devient observable."""
    app = create_app(load({"SPARKD_DB": str(tmp_path / "b.db"), "SPARKD_DRIVER": "fake"}))
    client_http = TestClient(app)

    releve = client_http.post("/v1/host/sync")
    assert releve.status_code == 200
    assert releve.json()["cpu_cores_total"] == 4

    corps = client_http.get("/v1/host").json()
    assert corps["cpu"]["cores_total"] == 4
    assert corps["cpu"]["threads_total"] == 8
    assert corps["pools"]["cpu"]["capacity"] == 4.0
    assert corps["pools"]["cpu"]["available"] == 4.0
    assert corps["pools"]["network"]["capacity"] == 1_000_000_000
    # docs/DAT.md §7.3 bis : la garantie annoncee reste exacte.
    assert corps["reservation_guarantee"] == "proportional_between_sparks_only"
