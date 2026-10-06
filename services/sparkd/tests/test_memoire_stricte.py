"""@verifies docs/BACKLOG.md#SPK-146 · docs/DAT.md §7.6 (la mémoire est un plafond
strict ; la création refuse `memory_enforce=soft`)

Mesuré sur la VM du banc le 2026-10-01 (SPK-143) : le mode « souple » pose
`memory.high`, et une cellule qui le dépasse est freinée jusqu'au blocage. La
création le refuse donc, en le nommant ; `hard` reste le mode, par défaut.
Diagnostics sur le doublon (DAT §28.7) : c'est une règle de l'API, la VM n'a
rien à y ajouter.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "m.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _creer(client, **extra):
    return client.post("/v1/sparks", json={
        "name": "crm", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000, **extra})


def test_le_mode_SOUPLE_est_refuse_a_la_creation_en_le_nommant(tmp_path):
    """Rouge sur le code d'avant : le Spark était créé, et se figerait au
    premier dépassement."""
    client = _client(tmp_path)
    refus = _creer(client, memory_enforce="soft")
    assert refus.status_code == 422
    detail = refus.json()["detail"]
    assert detail["error"] == "quota_incoherent"
    assert detail["field"] == "memory_enforce"
    assert "freinée" in detail["message"]
    assert client.get("/v1/sparks").json()["sparks"] == [], "rien n'a été créé"


def test_le_mode_STRICT_reste_le_defaut_et_s_accepte_nomme(tmp_path):
    client = _client(tmp_path)
    assert _creer(client).status_code == 201
    assert client.get("/v1/sparks/crm").json().get("memory_enforce", "hard") == "hard"
    assert _creer(client, name="autre", memory_enforce="hard").status_code == 201
