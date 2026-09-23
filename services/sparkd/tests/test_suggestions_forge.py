"""@verifies docs/BACKLOG.md#SPK-115 · docs/DAT.md §60.1 (un index : ce qui
             attend, et où — sans aucune valeur), §60.2 (lecture seule, un
             Spark sans cellule absent, une cellule illisible nommée)

Ce que ces preuves gardent : la vue d'ensemble ne transporte AUCUN corps — un
`secrets.?` porte ses valeurs en clair — et n'écrit dans aucune cellule.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import suggestions
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3
SECRET = "valeur-de-secret-proposee-7c1e"


@pytest.fixture
def client(tmp_path):
    c = TestClient(create_app(load({
        "SPARKD_DB": str(tmp_path / "forge-sugg.db"), "SPARKD_DRIVER": "fake",
    })))
    assert c.post("/v1/forge/sync").status_code in (200, 201)
    return c


def creer(client, nom, *, appliquer=True):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "storage_bytes": 5 * GIO, "network_bps": 10_000_000,
    }).status_code == 201
    if appliquer:
        assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    return nom


def deposer(client, nom, kind, texte):
    client.app.state.incus.push_file(
        nom, suggestions.chemin(kind), suggestions.entete(kind) + texte)


def test_la_Forge_dit_ce_qui_attend_et_OU_sans_aucune_valeur(client):
    creer(client, "a")
    creer(client, "b")
    deposer(client, "a", "secrets", f"# le mot de passe\nMDP={SECRET}\nAUTRE=\n")
    deposer(client, "a", "readme", "# Titre\n\nUn texte.\n")
    deposer(client, "b", "routes", "x.exemple.test 8080\n")

    rendu = client.get("/v1/suggestions")
    assert rendu.status_code == 200, rendu.text
    par = {s["spark"]: s for s in rendu.json()["sparks"]}
    assert par["a"]["cell_read"] is True
    assert sorted(par["a"]["pending"], key=lambda p: p["kind"]) == [
        {"kind": "readme", "lines": None},     # une note se tranche en entier
        {"kind": "secrets", "lines": 2},       # le commentaire ne compte pas
    ]
    assert par["b"]["pending"] == [{"kind": "routes", "lines": 1}]
    # §60.1 : RIEN du corps ne transite, ni une valeur, ni un nom.
    assert SECRET not in rendu.text and "MDP" not in rendu.text


def test_la_vue_d_ensemble_ne_POSE_aucun_fichier(client):
    """§60.2 : contrairement à la lecture d'un Spark (§55.8), elle n'écrit dans
    aucune cellule. Un `.?` retiré reste absent après la lecture."""
    creer(client, "a")
    fichiers = client.app.state.incus.created["a"].setdefault("files", {})
    fichiers.pop(suggestions.chemin("variables"), None)
    # Le doublon relit son état sur disque à chaque accès : le retrait s'écrit.
    client.app.state.incus._persist()
    avant = dict(fichiers)
    assert client.get("/v1/suggestions").status_code == 200
    assert client.app.state.incus.created["a"].get("files", {}) == avant


def test_un_Spark_SANS_cellule_est_absent_et_une_cellule_perdue_est_NOMMEE(client):
    creer(client, "declare", appliquer=False)          # pas encore de cellule
    creer(client, "perdu")
    client.app.state.incus.created.pop("perdu")        # l'instance a disparu
    client.app.state.incus._persist()                  # hors du produit, comme au seed
    par = {s["spark"]: s for s in client.get("/v1/suggestions").json()["sparks"]}
    assert "declare" not in par, "un Spark sans cellule ne peut rien proposer"
    assert par["perdu"] == {"spark": "perdu", "cell_read": False, "pending": []}


def test_un_Spark_PROTEGE_se_lit_comme_un_autre(client):
    """§60.2, §35 : lire n'est pas écrire."""
    creer(client, "gele")
    deposer(client, "gele", "variables", "A=1\n")
    assert client.post("/v1/sparks/gele/protection",
                       json={"password": "mot-de-passe-long-9"}).status_code in (200, 201)
    par = {s["spark"]: s for s in client.get("/v1/suggestions").json()["sparks"]}
    assert par["gele"]["pending"] == [{"kind": "variables", "lines": 1}]


def test_une_Forge_sans_proposition_rend_des_listes_vides(client):
    creer(client, "calme")
    par = {s["spark"]: s for s in client.get("/v1/suggestions").json()["sparks"]}
    assert par["calme"] == {"spark": "calme", "cell_read": True, "pending": []}
