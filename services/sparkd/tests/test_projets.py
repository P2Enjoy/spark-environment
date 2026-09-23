"""@verifies docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.1 (un projet range et ne
           touche aucun Spark ; la protection ne s'y applique pas), §61.2 (nom
           de 1 à 40 caractères, unique sans égard à la casse), §61.3 (la
           surface d'API et le journal) · docs/SCHEMA.md §10 octies

Ce que ces preuves gardent : supprimer un projet DÉSAFFECTE ses Sparks sans les
modifier, un Spark appartient à plusieurs projets, et un Spark protégé se range
comme un autre — le geste n'atteint pas la cellule.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


@pytest.fixture
def client(tmp_path):
    c = TestClient(create_app(load({
        "SPARKD_DB": str(tmp_path / "projets.db"), "SPARKD_DRIVER": "fake",
    })))
    assert c.post("/v1/forge/sync").status_code in (200, 201)
    return c


def creer_spark(client, nom):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "storage_bytes": 5 * GIO, "network_bps": 10_000_000,
    }).status_code == 201
    return nom


def creer_projet(client, nom):
    r = client.post("/v1/projects", json={"name": nom})
    assert r.status_code == 201, r.text
    return r.json()


def ranger(client, spark, *ids):
    return client.put(f"/v1/sparks/{spark}/projects", json={"projects": list(ids)})


def journal(client, action):
    """Les entrées de cette action, la plus récente d'abord, payload décodé."""
    entrees = client.get("/v1/audit", params={"limit": 200, "action": action}).json()["entries"]
    return [{**e, "payload": json.loads(e["payload"]) if e.get("payload") else None}
            for e in entrees]


def test_un_projet_se_cree_se_liste_par_ordre_alphabetique_et_se_journalise(client):
    creer_projet(client, "zeta")
    alpha = creer_projet(client, "  Alpha  ")
    assert alpha["name"] == "Alpha", "les bords blancs ne font pas partie du nom"
    assert alpha["sparks"] == []
    noms = [p["name"] for p in client.get("/v1/projects").json()["projects"]]
    assert noms == ["Alpha", "zeta"]
    assert journal(client, "project.create")


@pytest.mark.parametrize("nom", ["", "   ", "x" * 41, "a\tb", None, 12])
def test_un_nom_vide_trop_long_ou_de_controle_est_refuse_en_422(client, nom):
    r = client.post("/v1/projects", json={"name": nom})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_project"


def test_quarante_caracteres_passent(client):
    assert client.post("/v1/projects", json={"name": "x" * 40}).status_code == 201


def test_le_nom_est_unique_SANS_EGARD_A_LA_CASSE_y_compris_hors_ASCII(client):
    creer_projet(client, "Client A")
    r = client.post("/v1/projects", json={"name": "client a"})
    assert r.status_code == 409 and r.json()["detail"]["error"] == "name_taken"
    creer_projet(client, "Été")
    assert client.post("/v1/projects", json={"name": "été"}).status_code == 409


def test_renommer_change_le_nom_refuse_un_nom_pris_et_accepte_sa_propre_casse(client):
    a = creer_projet(client, "boutique")
    creer_projet(client, "vitrine")
    assert client.patch(f"/v1/projects/{a['id']}", json={"name": "Vitrine"}).status_code == 409
    r = client.patch(f"/v1/projects/{a['id']}", json={"name": "Boutique"})
    assert r.status_code == 200 and r.json()["name"] == "Boutique"
    assert client.patch("/v1/projects/inconnu", json={"name": "x"}).status_code == 404
    [entree] = journal(client, "project.rename")
    assert entree["payload"] == {"from": "boutique", "to": "Boutique"}


def test_un_Spark_appartient_a_PLUSIEURS_projets_et_les_porte_dans_sa_lecture(client):
    creer_spark(client, "crm")
    creer_spark(client, "vitrine")
    a, b = creer_projet(client, "Client A"), creer_projet(client, "Interne")
    r = ranger(client, "crm", a["id"], b["id"], a["id"])     # le doublon compte une fois
    assert r.status_code == 200, r.text
    assert [p["name"] for p in r.json()["projects"]] == ["Client A", "Interne"]
    par = {s["name"]: s for s in client.get("/v1/sparks").json()["sparks"]}
    assert [p["name"] for p in par["crm"]["projects"]] == ["Client A", "Interne"]
    assert par["vitrine"]["projects"] == []
    assert [p["name"] for p in client.get("/v1/sparks/crm").json()["projects"]] == [
        "Client A", "Interne"]
    projets = {p["name"]: p for p in client.get("/v1/projects").json()["projects"]}
    assert projets["Client A"]["sparks"] == ["crm"]


def test_ranger_REMPLACE_la_liste_et_le_journal_garde_l_avant_et_l_apres(client):
    creer_spark(client, "crm")
    a, b = creer_projet(client, "A"), creer_projet(client, "B")
    ranger(client, "crm", a["id"])
    assert ranger(client, "crm", b["id"]).json()["projects"] == [{"id": b["id"], "name": "B"}]
    dernier = journal(client, "spark.projects.set")[0]
    assert dernier["payload"] == {"spark": "crm", "before": ["A"], "after": ["B"]}
    assert ranger(client, "crm").json()["projects"] == []


def test_un_projet_inconnu_refuse_TOUT_le_rangement(client):
    creer_spark(client, "crm")
    a = creer_projet(client, "A")
    ranger(client, "crm", a["id"])
    r = ranger(client, "crm", a["id"], "fantome")
    assert r.status_code == 422 and "fantome" in r.json()["detail"]["message"]
    assert [p["name"] for p in client.get("/v1/sparks/crm").json()["projects"]] == ["A"]
    assert client.put("/v1/sparks/crm/projects", json={"projects": "A"}).status_code == 422
    assert ranger(client, "absent", a["id"]).status_code == 404


def test_supprimer_un_projet_DESAFFECTE_ses_Sparks_sans_les_toucher(client):
    creer_spark(client, "crm")
    creer_spark(client, "vitrine")
    a, b = creer_projet(client, "A"), creer_projet(client, "B")
    ranger(client, "crm", a["id"], b["id"])
    ranger(client, "vitrine", a["id"])
    avant = {s["name"]: {k: v for k, v in s.items() if k != "projects"}
             for s in client.get("/v1/sparks").json()["sparks"]}

    r = client.delete(f"/v1/projects/{a['id']}")
    assert r.status_code == 200 and r.json() == {"unassigned": ["crm", "vitrine"]}

    apres = client.get("/v1/sparks").json()["sparks"]
    assert {s["name"]: {k: v for k, v in s.items() if k != "projects"} for s in apres} == avant
    assert {s["name"]: [p["name"] for p in s["projects"]] for s in apres} == {
        "crm": ["B"], "vitrine": []}
    [entree] = journal(client, "project.delete")
    assert entree["payload"] == {"name": "A", "unassigned": ["crm", "vitrine"]}
    assert client.delete(f"/v1/projects/{a['id']}").status_code == 404


def test_supprimer_un_Spark_retire_ses_adhesions_et_garde_le_projet(client):
    creer_spark(client, "crm")
    creer_spark(client, "vitrine")
    a = creer_projet(client, "A")
    ranger(client, "crm", a["id"])
    ranger(client, "vitrine", a["id"])
    assert client.post("/v1/sparks/crm/delete").status_code in (200, 202)
    assert client.get("/v1/sparks/crm").status_code == 404
    assert client.get("/v1/projects").json()["projects"] == [
        {"id": a["id"], "name": "A", "sparks": ["vitrine"]}]


def test_un_Spark_PROTEGE_se_range_comme_un_autre(client):
    """§61.1 : la protection garde ce qui atteint le Spark ; ranger ne l'atteint pas."""
    creer_spark(client, "gele")
    assert client.post("/v1/sparks/gele/protection",
                       json={"password": "mot-de-passe-long-9"}).status_code in (200, 201)
    a = creer_projet(client, "A")
    assert ranger(client, "gele", a["id"]).status_code == 200
    assert client.get("/v1/sparks/gele").json()["protected"] is True
