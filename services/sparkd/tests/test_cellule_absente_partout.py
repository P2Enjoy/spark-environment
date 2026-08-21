"""@verifies docs/BACKLOG.md#SPK-67 · docs/DAT.md §12.1.4 (ce que le contrat
            exige des appelants), §12.1.2 (le contrat est uniforme), §14.6 (une
            cellule absente ne vaut PAS démarrage réussi), §33.3 ·
            docs/CONTINGENCE.md §4.5 · docs/JOURNAL.md (décision INC-15)

Uniformiser le contrat d'échec du pilote CRÉE l'absence là où ces routes n'en
voyaient pas : sans traitement, `InstanceAbsente` s'y échapperait en erreur
interne. Le contrat n'est donc pas tenu tant que chacune ne la nomme pas.

Ces preuves parcourent les routes une par une, sur une cellule réellement
disparue. Elles ont d'abord été écrites contre le code non traité : toutes
rendaient **500**.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3
_CLE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fSF4BkF"
        "EV5LL5Sl2XoT poste")


def _pile(tmp_path):
    application = create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                   "SPARKD_DRIVER": "fake"}))
    client = TestClient(application)
    assert client.post("/v1/forge/sync").status_code == 200
    return client, application


def _spark(client, nom="perdu", demarrer=True):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": GIO,
        "network_bps": 10_000_000}).status_code in (201, 202)
    assert client.post(f"/v1/sparks/{nom}/apply").status_code in (200, 202)
    if demarrer:
        assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def _preparer(client, nom):
    """Ce dont chaque geste a besoin AVANT la perte.

    Sans cela, une route refuserait pour une autre raison — instantané absent,
    clé inconnue — et la preuve ne mesurerait pas ce qu'elle croit mesurer.
    """
    assert client.post(f"/v1/sparks/{nom}/snapshots",
                       json={"name": "s1"}).status_code in (200, 201, 202)
    assert client.post("/v1/ssh-keys",
                       json={"label": "responsable",
                             "public_key": _CLE}).status_code in (200, 201)


def _perdre_la_cellule(application, nom):
    """La perte est ÉCRITE, pas seulement oubliée en mémoire (SPK-67, §12.1.3)."""
    application.state.incus.created.pop(nom, None)
    application.state.incus._persist()


#: Une route, un geste. Chacune emprunte une aide privée différente du client
#: réel — c'est tout le propos du §12.1 : l'appelant ne peut pas le savoir.
def _gestes(client, nom):
    return {
        "usage":              lambda: client.get(f"/v1/sparks/{nom}/usage"),
        "instantané créé":    lambda: client.post(f"/v1/sparks/{nom}/snapshots",
                                                  json={"name": "s2"}),
        "instantané restauré": lambda: client.post(
            f"/v1/sparks/{nom}/snapshots/s1/restore", json={}),
        "instantané supprimé": lambda: client.delete(
            f"/v1/sparks/{nom}/snapshots/s1"),
        "amorçage relevé":    lambda: client.get(f"/v1/sparks/{nom}/bootstrap"),
        "amorçage posé":      lambda: client.post(f"/v1/sparks/{nom}/bootstrap",
                                                  json={}),
        "clé accordée":       lambda: client.post(f"/v1/sparks/{nom}/ssh-keys/responsable"),
        "clé révoquée":       lambda: client.delete(f"/v1/sparks/{nom}/ssh-keys/responsable"),
    }


@pytest.mark.parametrize("geste", sorted(_gestes(None, "x")))
def test_chaque_route_NOMME_la_cellule_perdue(geste, tmp_path):
    """LE cœur du §12.1.4 : la réponse est la MÊME partout.

    Un exploitant n'a pas à apprendre une réponse différente par écran pour un
    seul et même incident.
    """
    client, application = _pile(tmp_path)
    nom = _spark(client)
    _preparer(client, nom)
    _perdre_la_cellule(application, nom)

    reponse = _gestes(client, nom)[geste]()
    assert reponse.status_code == 409, f"{geste} : {reponse.status_code} — {reponse.text}"
    detail = reponse.json()["detail"]
    assert detail["error"] == "cellule_absente"
    assert nom in detail["message"], "le message NOMME le Spark"
    assert "reconstruite" in detail["message"] and "supprimé" in detail["message"], (
        "il dit les deux issues")
    # §1.5 bis, vu à l'écran le 2026-08-21 : ces routes se rencontrent sur un
    # Spark dans N'IMPORTE quel état, et « Reprendre » n'est offert qu'en panne.
    # Nommer ce bouton ici enverrait chercher un bouton absent — la faute
    # symétrique de celle corrigée la veille. Seul le cycle de vie le nomme,
    # parce qu'il vient de le faire apparaître.
    assert "« Reprendre »" not in detail["message"], (
        "un refus ne nomme un bouton que là où ce bouton est certain d'exister")
    assert "/1.0/" not in detail["message"], (
        "aucun chemin de l'API interne d'Incus sous les yeux de l'exploitant (§20)")


@pytest.mark.parametrize("geste", sorted(_gestes(None, "x")))
def test_aucune_de_ces_routes_ne_MET_le_spark_en_panne(geste, tmp_path):
    """La borne du §12.1.4, et elle distingue ces routes du cycle de vie.

    Elles n'ont posé aucun état transitoire : elles refusent et n'écrivent rien.
    Faire passer le Spark en panne parce qu'on a voulu LIRE son usage serait un
    effet de bord que rien n'annonce — et le message ne doit donc pas annoncer
    un changement qui n'a pas eu lieu (DESIGN_SYSTEM.md §1.3).
    """
    client, application = _pile(tmp_path)
    nom = _spark(client)
    _preparer(client, nom)
    avant = client.get(f"/v1/sparks/{nom}").json()["state"]
    _perdre_la_cellule(application, nom)

    assert _gestes(client, nom)[geste]().status_code == 409
    apres = client.get(f"/v1/sparks/{nom}").json()
    assert apres["state"] == avant, "l'état ne bouge pas"
    assert apres["last_error"] is None, "et rien n'est écrit sur la fiche"
    message = _gestes(client, nom)[geste]().json()["detail"]["message"]
    assert "passe en panne" not in message, (
        "seule la route du cycle de vie annonce la panne, parce qu'elle la PRODUIT")


def test_le_cycle_de_vie_lui_MET_bien_le_spark_en_panne(tmp_path):
    """Le contraste, sans lequel la preuve précédente ne prouverait rien : la
    route qui a posé un état transitoire doit le refermer (§14.6)."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    _perdre_la_cellule(application, nom)

    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 409
    fiche = client.get(f"/v1/sparks/{nom}").json()
    assert fiche["state"] == "error"
    assert "passe en panne" in fiche["last_error"]


def test_un_pilote_MUET_reste_une_PANNE_sur_ces_routes_aussi(tmp_path):
    """La borne du §33.3, portée aux routes de cette unité.

    Ne pas pouvoir demander n'est pas savoir que ce n'est pas là. Proposer de
    reconstruire une cellule qui tourne peut-être encore serait pire que de ne
    rien proposer.
    """
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.fail_next["instance_state"] = "socket injoignable"

    reponse = client.get(f"/v1/sparks/{nom}/usage")
    assert reponse.status_code == 502, reponse.text
    assert reponse.json()["detail"]["error"] == "incus_failed"
