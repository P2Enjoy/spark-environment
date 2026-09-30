"""@verifies docs/BACKLOG.md#SPK-141 · docs/DAT.md §18.8 (une route ne sort du
registre qu'une fois Caddy confirmé), §18.5 (`applied_at`) · §36.4 (le journal)

Le défaut, constaté le 2026-10-01 : `DELETE /v1/ingress/{domain}` retirait la
route du registre AVANT d'appliquer ; Caddy injoignable, la réponse était un
`502`, la route n'existait plus au registre, et Caddy pouvait la servir encore.
Décision du responsable : « on ne retire que si confirmé supprimé chez Caddy ».

Ces preuves tournent sur le doublon `FakeCaddy` : ce sont des diagnostics
(DAT §28.7). La validation se fait sur la VM du banc (SPK-137).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import ingress, migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "r.db")
    migrations.upgrade(connection)
    for ident, nom, adresse in (("S1", "crm", "10.77.0.16"), ("S2", "boutique", "10.77.0.17")):
        connection.execute(
            "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
            "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
            "ipv4_address,created_at,updated_at) VALUES (?,?,?,'shared',0.5,?,?,?,?,'x','x')",
            (ident, nom, "images:debian/13", GIO, 10_000_000, GIO, adresse))
    ingress.declare(connection, "S1", "crm.example.com", 8080)
    ingress.declare(connection, "S2", "boutique.example.com", 3000)
    yield connection
    connection.close()


class CaddyQuiNOublieRien(ingress.FakeCaddy):
    """Accepte la pose, et sert pourtant toujours l'ancienne configuration."""

    def load(self, config: dict) -> None:
        if self.config is None:
            self.config = config


def _journal(db, action):
    return [dict(r) for r in db.execute(
        "SELECT result, message FROM audit_log WHERE action = ? ORDER BY id", (action,))]


def _au_registre(db):
    return {r["domain"] for r in ingress.listing(db)}


# --- la fonction du service ---------------------------------------------------

def test_le_retrait_CONFIRME_sort_la_route_du_registre(db):
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)

    ingress.retirer(db, caddy, "crm.example.com")

    assert _au_registre(db) == {"boutique.example.com"}
    assert ingress.domaines_servis(caddy.current()) == {"boutique.example.com"}
    assert _journal(db, "ingress.withdraw")[-1]["result"] == "ok"


def test_caddy_INJOIGNABLE_la_route_RESTE_au_registre(db):
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    caddy.fail = True

    with pytest.raises(ingress.RetraitNonConfirme, match="injoignable|échec"):
        ingress.retirer(db, caddy, "crm.example.com")

    assert _au_registre(db) == {"crm.example.com", "boutique.example.com"}
    tentative = _journal(db, "ingress.withdraw")[-1]
    assert tentative["result"] == "error", "la tentative entre au journal, en échec"


def test_caddy_qui_sert_ENCORE_le_domaine_ne_fait_pas_retirer(db):
    """La pose rendue `200` ne suffit pas : on RELIT ce que Caddy sert."""
    caddy = CaddyQuiNOublieRien()
    ingress.reconcile(db, caddy)

    with pytest.raises(ingress.RetraitNonConfirme, match="sert encore"):
        ingress.retirer(db, caddy, "crm.example.com")

    assert "crm.example.com" in _au_registre(db)


def test_les_AUTRES_routes_sont_datees_par_la_pose_qui_les_porte(db):
    caddy = ingress.FakeCaddy()
    ingress.retirer(db, caddy, "crm.example.com")
    [reste] = ingress.listing(db)
    assert reste["domain"] == "boutique.example.com" and reste["applied_at"]


def test_une_route_INCONNUE_reste_un_refus_ordinaire(db):
    with pytest.raises(ingress.IngressError) as refus:
        ingress.retirer(db, ingress.FakeCaddy(), "absent.example.com")
    assert not isinstance(refus.value, ingress.RetraitNonConfirme)


# --- la route d'API -------------------------------------------------------------

def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    assert client.post("/v1/sparks", json={
        "name": "crm", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000}).status_code == 201
    assert client.post("/v1/sparks/crm/apply").status_code == 200
    assert client.post("/v1/ingress", json={
        "spark": "crm", "domain": "crm.example.com", "port": 8080}).status_code in (200, 201)
    return client


def _domaines(client):
    corps = client.get("/v1/ingress").json()
    routes = corps.get("routes", corps) if isinstance(corps, dict) else corps
    return {r["domain"] for r in routes}


def test_API_caddy_injoignable_502_et_la_route_est_TOUJOURS_LA(tmp_path):
    """LE défaut. Rouge sur le code d'avant : la route avait déjà disparu."""
    client = _client(tmp_path)
    client.app.state.caddy.fail = True

    refus = client.delete("/v1/ingress/crm.example.com")

    assert refus.status_code == 502
    assert "crm.example.com" in refus.json()["detail"]["message"]
    assert "crm.example.com" in _domaines(client), "la route reste au registre"


def test_API_caddy_revenu_le_retrait_aboutit(tmp_path):
    client = _client(tmp_path)
    client.app.state.caddy.fail = True
    assert client.delete("/v1/ingress/crm.example.com").status_code == 502
    client.app.state.caddy.fail = False

    assert client.delete("/v1/ingress/crm.example.com").status_code == 200
    assert "crm.example.com" not in _domaines(client)
    assert "crm.example.com" not in ingress.domaines_servis(client.app.state.caddy.current())
