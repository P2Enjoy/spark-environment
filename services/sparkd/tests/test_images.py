"""@verifies docs/BACKLOG.md#SPK-32 · docs/DAT.md §33 (le catalogue),
           §33.2 (refus AVANT ecriture), §33.3 (le releve, ses trois etats),
           §33.4 (ce que le catalogue n'est pas) · §14.2

Le coeur : une reference inexistante est refusee A LA CREATION, et le registre
reste inchange. Avant, la ligne etait ecrite, la ressource comptee, et le refus
n'arrivait qu'a `apply`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import images, migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect
from sparkd.images import MISSING, UNKNOWN, VERIFIED, Catalogue, ImageError

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "c.db")
    migrations.upgrade(connection)
    images.seed_defaults(connection)
    yield connection
    connection.close()


def catalogue(*alias) -> Catalogue:
    return Catalogue(frozenset(alias), len(alias))


# --- une entree nait NON verifiee (§33.3) -----------------------------------


def test_le_catalogue_pre_renseigne_nait_non_verifie(db):
    """L'etat vient du RELEVE, jamais d'une declaration.

    Une reference declaree verifiee par celui qui l'ajoute ne prouverait rien.
    """
    etats = {e["reference"]: e["state"] for e in images.listing(db)}
    assert etats and set(etats.values()) == {UNKNOWN}
    assert images.selectable(db) == [], "rien n'est proposable avant un releve"


def test_ajouter_une_image_ne_la_declare_pas_verifiee(db):
    ajoutee = images.add(db, "images:fedora/41", "Fedora 41")
    assert ajoutee["state"] == UNKNOWN
    assert ajoutee["verified_at"] is None


def test_une_reference_illisible_est_refusee(db):
    with pytest.raises(ImageError, match="dépôt:alias"):
        images.add(db, "sans-separateur", "Bidon")


def test_un_doublon_est_refuse(db):
    with pytest.raises(ImageError, match="déjà au catalogue"):
        images.add(db, "images:debian/13", "Doublon")


def test_le_pre_renseignement_est_idempotent(db):
    assert images.seed_defaults(db) == 0


# --- le releve et ses trois etats (§33.3) -----------------------------------


def test_un_releve_distingue_verifiee_et_absente(db):
    images.add(db, "images:debian/31", "Version inexistante")
    bilan = images.verify(db, fetch=lambda url, client=None: catalogue(
        "debian/13", "debian/12", "ubuntu/24.04", "alpine/3.21"))
    assert bilan[VERIFIED] == 4 and bilan[MISSING] == 1
    etats = {e["reference"]: e["state"] for e in images.listing(db)}
    assert etats["images:debian/13"] == VERIFIED
    assert etats["images:debian/31"] == MISSING


def test_un_depot_injoignable_rend_UNKNOWN_et_jamais_MISSING(db):
    """Ne pas savoir n'est pas savoir que ce n'est pas la (§33.3).

    Rendre `missing` sur une panne reseau ferait disparaitre de la liste des
    images parfaitement valides, et l'exploitant conclurait qu'elles ont ete
    retirees du depot.
    """
    def panne(url, client=None):
        raise OSError("connexion refusée")

    bilan = images.verify(db, fetch=panne)
    assert bilan[UNKNOWN] == 4 and bilan[MISSING] == 0
    assert all(e["state"] == UNKNOWN for e in images.listing(db))
    assert any("connexion refusée" in e["detail"] for e in images.listing(db))


def test_un_releve_est_DATE(db):
    """Une capacite sans date serait crue a jour (meme regle qu'au §27.8)."""
    bilan = images.verify(db, fetch=lambda url, client=None: catalogue("debian/13"))
    assert bilan["verified_at"]
    assert all(e["verified_at"] == bilan["verified_at"] for e in images.listing(db))


def test_une_entree_absente_reste_VISIBLE(db):
    """La faire disparaitre ferait croire qu'elle n'a jamais existe (§33.3)."""
    images.verify(db, fetch=lambda url, client=None: catalogue("debian/13"))
    references = [e["reference"] for e in images.listing(db)]
    assert "images:alpine/3.21" in references
    assert "images:alpine/3.21" not in [e["reference"] for e in images.selectable(db)]


def test_le_releve_factice_ne_publie_que_le_pre_renseigne():
    """Il doit se comporter comme le vrai depot pour une reference inventee."""
    rendu = images.fake_fetch("peu importe")
    assert "debian/13" in rendu.aliases
    assert "debian/99" not in rendu.aliases


# --- le refus a la creation (§33.2) -----------------------------------------


def test_ensure_selectable_refuse_une_reference_absente(db):
    with pytest.raises(ImageError, match="n'est pas au catalogue"):
        images.ensure_selectable(db, "images:debian/99")


def test_ensure_selectable_refuse_une_reference_NON_RELEVEE(db):
    """Presente au catalogue ne suffit pas : il faut un releve."""
    with pytest.raises(ImageError, match="unknown"):
        images.ensure_selectable(db, "images:debian/13")


def test_ensure_selectable_accepte_une_reference_verifiee(db):
    images.verify(db, fetch=lambda url, client=None: catalogue("debian/13"))
    assert images.ensure_selectable(db, "images:debian/13")["label"]


# --- par l'API, et le registre reste INCHANGE -------------------------------


def _client(tmp_path):
    return TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                       "SPARKD_DRIVER": "fake"})))


def test_une_image_inconnue_est_refusee_SANS_ecrire_la_ligne(tmp_path):
    """LE test de l'unite.

    Avant : la ligne etait ecrite, la ressource comptee, et le refus ne venait
    qu'a `apply` — le Spark restait en `error` avec ses quotas engages.
    """
    client = _client(tmp_path)
    client.post("/v1/host/sync")
    avant = client.get("/v1/host").json()["pools"]["memory"]["allocated"]

    refus = client.post("/v1/sparks", json={
        "name": "faute-de-frappe", "image": "images:debian/31",
        "cpu_mode": "shared", "cpu_reservation": 0.5, "memory_bytes": GIO,
        "storage_bytes": GIO, "network_bps": 10_000_000})

    assert refus.status_code == 409
    detail = refus.json()["detail"]
    assert detail["error"] == "image_refused"
    assert "images:debian/31" in detail["message"], "le refus NOMME la reference"

    assert client.get("/v1/sparks/faute-de-frappe").status_code == 404
    assert client.get("/v1/host").json()["pools"]["memory"]["allocated"] == avant, (
        "aucune ressource ne doit avoir ete engagee"
    )


def test_une_image_du_catalogue_est_acceptee(tmp_path):
    client = _client(tmp_path)
    client.post("/v1/host/sync")
    rendu = client.post("/v1/sparks", json={
        "name": "bonne-image", "image": "images:debian/13",
        "cpu_mode": "shared", "cpu_reservation": 0.5, "memory_bytes": GIO,
        "storage_bytes": GIO, "network_bps": 10_000_000})
    assert rendu.status_code == 201


def test_l_api_publie_le_catalogue_et_ce_qui_est_proposable(tmp_path):
    corps = _client(tmp_path).get("/v1/images").json()
    assert len(corps["images"]) >= 4
    assert "images:debian/13" in corps["selectable"]
    # L'entree par defaut vient en tete (docs/DAT.md §33.5).
    assert corps["images"][0]["is_default"] == 1


def test_l_api_refuse_d_ajouter_une_reference_illisible(tmp_path):
    rendu = _client(tmp_path).post("/v1/images", json={
        "reference": "sans-separateur", "label": "Bidon"})
    assert rendu.status_code == 422
    assert rendu.json()["detail"]["error"] == "invalid_image"
