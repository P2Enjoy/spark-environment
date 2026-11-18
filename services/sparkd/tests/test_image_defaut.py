"""@verifies docs/BACKLOG.md#SPK-174 · docs/DAT.md §69 (désigner l'image par défaut), §33.5
           (la présélection à la création), §33.7 (les deux refus du retrait) ·
           docs/DESIGN_SYSTEM.md §1.3 (pas de succès simulé) · CLAUDE.md §10 (la règle est
           appliquée côté serveur, prouvée par une requête directe)

Le défaut du constat : l'entrée par défaut n'était retirable par personne, et rien ne permettait
d'en désigner une autre — un refus sans issue. Le service désigne atomiquement, une seule entrée
`verified`, sans succès simulé ; le refus du retrait dit désormais sa sortie.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import audit, images, migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect
from sparkd.images import Catalogue, ImageError


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "c.db")
    migrations.upgrade(connection)
    images.seed_defaults(connection)
    # Un relevé contre un dépôt qui publie debian/13 et alpine/3.21 : ces deux-là sont `verified`,
    # les autres `missing`. Le défaut pré-renseigné est debian/13.
    contenu = {"debian/13", "alpine/3.21"}
    images.verify(connection, fetch=lambda url, client=None: Catalogue(frozenset(contenu), 10, {}))
    yield connection
    connection.close()


def etats(db):
    return {e["reference"]: e for e in images.listing(db)}


def defauts(db):
    return [r for r, e in etats(db).items() if e["is_default"]]


# --- le service : atomique, une seule entrée par défaut ---------------------------------------


def test_designer_une_autre_entree_la_rend_seule_par_defaut(db):
    assert defauts(db) == ["images:debian/13"]
    nouvelle = etats(db)["images:alpine/3.21"]
    assert nouvelle["state"] == "verified"
    rendu = images.set_default(db, nouvelle["id"], actor="console/local")
    assert rendu["changed"] is True and rendu["image"]["reference"] == "images:alpine/3.21"
    assert defauts(db) == ["images:alpine/3.21"], "une et UNE SEULE entrée par défaut"


def test_l_ancienne_entree_par_defaut_devient_retirable_apres_la_designation(db):
    ancienne = etats(db)["images:debian/13"]
    with pytest.raises(ImageError, match="Désignez-en une autre"):
        images.remove(db, ancienne["id"])
    images.set_default(db, etats(db)["images:alpine/3.21"]["id"])
    images.remove(db, ancienne["id"])
    assert "images:debian/13" not in etats(db)


def test_le_refus_du_retrait_dit_sa_sortie_et_ne_pretend_plus_qu_il_n_y_a_pas_de_geste(db):
    with pytest.raises(ImageError) as erreur:
        images.remove(db, etats(db)["images:debian/13"]["id"])
    message = str(erreur.value)
    assert "Désignez-en une autre par défaut, puis retirez celle-ci" in message
    assert "n'offre pas encore de geste" not in message


def test_deja_par_defaut_rien_n_est_ecrit_ni_journalise(db):
    courante = etats(db)["images:debian/13"]
    avant = len(audit.listing(db, limit=500))
    rendu = images.set_default(db, courante["id"])
    assert rendu["changed"] is False, "pas de succès simulé (design system §1.3)"
    assert len(audit.listing(db, limit=500)) == avant
    assert defauts(db) == ["images:debian/13"]


def test_la_designation_est_journalisee_de_l_ancienne_vers_la_nouvelle(db):
    images.set_default(db, etats(db)["images:alpine/3.21"]["id"], actor="console/local")
    ligne = next(l for l in audit.listing(db, limit=50) if l["action"] == "image.default")
    assert ligne["result"] == "ok" and ligne["actor"] == "console/local"
    assert "images:debian/13" in ligne["message"] and "images:alpine/3.21" in ligne["message"]
    assert ligne["target_type"] == "image"


@pytest.mark.parametrize("reference,attendu", [
    ("images:debian/12", "missing"),   # absent du dépôt relevé
])
def test_une_entree_non_verifiee_ne_peut_pas_etre_designee(db, reference, attendu):
    entree = etats(db)[reference]
    assert entree["state"] == attendu
    with pytest.raises(ImageError, match=attendu):
        images.set_default(db, entree["id"])
    assert defauts(db) == ["images:debian/13"], "le refus ne change RIEN"


def test_une_entree_unknown_ne_peut_pas_etre_designee(tmp_path):
    connection = connect(tmp_path / "u.db")
    migrations.upgrade(connection)
    images.seed_defaults(connection)  # jamais relevé : tout est `unknown`
    entree = next(iter(images.listing(connection)))
    with pytest.raises(ImageError, match="unknown"):
        images.set_default(connection, entree["id"])


def test_une_entree_inconnue_est_refusee(db):
    with pytest.raises(ImageError, match="n'est pas au catalogue"):
        images.set_default(db, "00000000000000000000000000000000")


def test_aucun_instant_sans_defaut_ni_avec_deux_n_est_lisible(db, monkeypatch):
    """L'invariant se tient dans UNE transaction : si l'écriture échoue en route, l'ancienne
    entrée reste la seule par défaut."""
    cible = etats(db)["images:alpine/3.21"]
    vrai = images._audit

    def casse(*a, **k):
        raise RuntimeError("panne pendant l'audit")

    monkeypatch.setattr(images, "_audit", casse)
    with pytest.raises(RuntimeError):
        images.set_default(db, cible["id"])
    monkeypatch.setattr(images, "_audit", vrai)
    assert defauts(db) == ["images:debian/13"], "rien n'a bougé : la désignation est atomique"


# --- par l'API, contre le vrai registre : une requête directe, sans interface ------------------


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                       "SPARKD_DRIVER": "fake"})))


def catalogue_api(client):
    return {e["reference"]: e for e in client.get("/v1/images").json()["images"]}


def test_l_api_designe_puis_dit_que_rien_n_a_change_la_seconde_fois(client):
    verifiees = [e for e in catalogue_api(client).values()
                 if e["state"] == "verified" and not e["is_default"]]
    assert verifiees, "le seed doit offrir une autre entrée vérifiée à désigner"
    cible = verifiees[0]
    r = client.put(f"/v1/images/{cible['id']}/default")
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True and r.json()["image"]["reference"] == cible["reference"]
    assert [e["reference"] for e in catalogue_api(client).values() if e["is_default"]] == [cible["reference"]]
    r2 = client.put(f"/v1/images/{cible['id']}/default")
    assert r2.status_code == 200 and r2.json()["changed"] is False


def test_l_api_refuse_une_entree_non_verifiee_et_une_inconnue_et_ne_change_rien(client):
    avant = [e["reference"] for e in catalogue_api(client).values() if e["is_default"]]
    non_verifiee = next((e for e in catalogue_api(client).values() if e["state"] != "verified"), None)
    if non_verifiee:
        r = client.put(f"/v1/images/{non_verifiee['id']}/default")
        assert r.status_code == 422 and r.json()["detail"]["error"] == "invalid_image"
        assert non_verifiee["state"] in r.json()["detail"]["message"]
    r = client.put("/v1/images/00000000000000000000000000000000/default")
    assert r.status_code == 422 and "n'est pas au catalogue" in r.json()["detail"]["message"]
    assert [e["reference"] for e in catalogue_api(client).values() if e["is_default"]] == avant


def test_l_api_journalise_image_default_sans_notification_hors_bande(client):
    from sparkd import notification
    assert not notification.notifiable("image.default", "ok", "human"), (
        "réversible, ne détruit rien, ne donne aucun accès : pas d'alerte (DAT §69.2)")
    cible = next(e for e in catalogue_api(client).values()
                 if e["state"] == "verified" and not e["is_default"])
    assert client.put(f"/v1/images/{cible['id']}/default").status_code == 200
    lignes = client.get("/v1/audit", params={"limit": 20}).json()
    lignes = lignes["entries"] if isinstance(lignes, dict) and "entries" in lignes else lignes
    assert any(l["action"] == "image.default" for l in lignes)


def test_l_api_retirer_l_entree_par_defaut_est_refuse_puis_possible_apres_designation(client):
    cat = catalogue_api(client)
    defaut = next(e for e in cat.values() if e["is_default"])
    refus = client.delete(f"/v1/images/{defaut['id']}")
    assert refus.status_code == 422
    assert "Désignez-en une autre par défaut" in refus.json()["detail"]["message"]
    autre = next(e for e in cat.values() if e["state"] == "verified" and not e["is_default"])
    assert client.put(f"/v1/images/{autre['id']}/default").status_code == 200
    r = client.delete(f"/v1/images/{defaut['id']}")
    # Le second refus (un Spark l'emploie) peut s'appliquer ; sur un seed sans Spark il ne s'applique pas.
    assert r.status_code in (200, 422)
    if r.status_code == 422:
        assert "employée par" in r.json()["detail"]["message"]
