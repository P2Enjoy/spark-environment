"""@verifies docs/BACKLOG.md#SPK-36 · docs/CONTINGENCE.md §4 (l'entrée fantôme,
            ce qu'elle coûte et comment on en sort), §4.4 (le signal qui
            manquait) · docs/DAT.md §14.3 (la reprise des états transitoires),
            §14.5 (une absence RAPPORTÉE n'est pas une panne), §33.3 (ne pas
            savoir n'est pas savoir que ce n'est pas là)

Mesuré sur la Forge de validation le 2026-08-21, sur un Spark jetable dont la
cellule avait été détruite hors du produit : `POST /start` rendait **500**,
`service.finish` n'était jamais appelé, et le Spark restait STABLEMENT en
« starting » avec `allowed_commands: []` et `last_error: null`. Depuis la
console il n'était alors plus possible ni de reconstruire, ni de supprimer.

La cause tient en une ligne : `InstanceAbsente` n'hérite pas d'`IncusError`.
SPK-52 l'avait traitée pour la suppression ; la branche du cycle de vie ne
l'attrapait pas. Le pilote factice masquait l'écart en rendant `IncusError` là
où le vrai rend `InstanceAbsente` — les preuves mesuraient donc une forme qui ne
tourne jamais en production, ce que le commentaire de SPK-52 interdit
explicitement dans `incus.py`.

Ces preuves tiennent les deux bouts : la perte doit être DITE, et elle doit
laisser le Spark dans un état d'où l'exploitant peut encore agir.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load
from sparkd.incus import InstanceAbsente

GIO = 1024**3


def _pile(tmp_path):
    application = create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                   "SPARKD_DRIVER": "fake"}))
    client = TestClient(application)
    assert client.post("/v1/forge/sync").status_code == 200
    return client, application


def _spark(client, nom="perdu"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": GIO,
        "network_bps": 10_000_000}).status_code in (201, 202)
    assert client.post(f"/v1/sparks/{nom}/apply").status_code in (200, 202)
    return nom


def _etat(client, nom):
    corps = client.get(f"/v1/sparks/{nom}").json()
    return corps["state"], corps["allowed_commands"]


# --- le pilote factice doit MENTIR AUTANT que le vrai, c'est-à-dire pas -------


def test_le_pilote_FACTICE_rend_l_absence_comme_le_VRAI(tmp_path):
    """La borne qui explique pourquoi le défaut a survécu aux preuves.

    Le vrai pilote lève `InstanceAbsente` sur TOUT 404 (`incus.py:_request`),
    donc aussi sur `set_instance_state`. Le factice levait `IncusError`, que la
    route attrapait — la panne était donc invisible ici et visible seulement sur
    la Forge.
    """
    _, application = _pile(tmp_path)
    with pytest.raises(InstanceAbsente):
        application.state.incus.set_instance_state("jamais-cree", "start")


# --- la règle : la perte est DITE, et laisse de quoi agir --------------------


def test_DEMARRER_une_cellule_disparue_ne_coince_pas_le_spark(tmp_path):
    """LE cœur de l'unité : le Spark doit rester manœuvrable."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.created.pop(nom)   # la cellule disparaît hors du produit

    reponse = client.post(f"/v1/sparks/{nom}/start")
    assert reponse.status_code == 409, reponse.text
    assert reponse.json()["detail"]["error"] == "cellule_absente"

    etat, commandes = _etat(client, nom)
    assert etat == "error", "surtout pas un état transitoire dont on ne sort plus"
    assert "retry" in commandes and "delete" in commandes, (
        "les DEUX remèdes annoncés par REG-FANTOME doivent être offerts")


def test_le_refus_DIT_la_perte_et_ne_la_devine_pas(tmp_path):
    """Un exploitant doit comprendre sans lire le code ni le journal."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.created.pop(nom)

    message = client.post(f"/v1/sparks/{nom}/start").json()["detail"]["message"]
    assert nom in message, "le message nomme le Spark concerné"
    assert "cellule" in message.lower()
    corps = client.get(f"/v1/sparks/{nom}").json()
    assert corps["last_error"], "la raison RESTE lisible sur la fiche du Spark"


def test_ARRETER_une_cellule_disparue_le_DIT_au_lieu_de_faire_semblant(tmp_path):
    """La différence avec §14.5, et elle est délibérée.

    Pour `delete`, l'absence vaut réussite : l'intention est le retrait, et la
    ligne part avec le fantôme. Pour `stop`, la ligne SURVIT — faire semblant de
    réussir laisserait un fantôme silencieux au registre, ce que le §4 de
    `docs/CONTINGENCE.md` cherche précisément à rendre impossible.
    """
    client, application = _pile(tmp_path)
    nom = _spark(client)
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    application.state.incus.created.pop(nom)

    reponse = client.post(f"/v1/sparks/{nom}/stop")
    assert reponse.status_code == 409, reponse.text
    etat, commandes = _etat(client, nom)
    assert etat == "error"
    assert "retry" in commandes and "delete" in commandes


# --- et la reprise doit RÉELLEMENT reconstruire ------------------------------


def test_apres_le_refus_le_spark_se_RECONSTRUIT_par_le_produit(tmp_path):
    """Le remède annoncé doit exister pour de bon, bout en bout, sans toucher
    à la base à la main."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.created.pop(nom)
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 409

    assert client.post(f"/v1/sparks/{nom}/retry").status_code in (200, 202)

    etat, _ = _etat(client, nom)
    assert etat == "stopped", "le Spark est revenu à un état ordinaire"
    assert nom in application.state.incus.created, "la cellule EXISTE de nouveau"


def test_l_autre_remede_reste_ouvert_la_suppression(tmp_path):
    """SPK-52 doit continuer de fonctionner depuis cet état-là aussi."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.created.pop(nom)
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 409

    assert client.post(f"/v1/sparks/{nom}/delete").status_code == 200
    assert client.get(f"/v1/sparks/{nom}").status_code == 404


# --- la borne : ne pas confondre l'absence et l'ignorance (§33.3) ------------


def test_un_pilote_MUET_reste_une_PANNE_et_pas_une_absence(tmp_path):
    """La borne la plus importante, reprise du §33.3 pour cette branche.

    Ne pas pouvoir demander n'est pas savoir que ce n'est pas là. Un pilote
    injoignable doit rester un 502 : conclure à l'absence ferait proposer une
    reconstruction alors que la cellule tourne peut-être encore.
    """
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.fail_next["set_instance_state"] = "socket injoignable"

    reponse = client.post(f"/v1/sparks/{nom}/start")
    assert reponse.status_code == 502, reponse.text
    assert reponse.json()["detail"]["error"] == "incus_failed"
    assert nom in application.state.incus.created, "la cellule, elle, est intacte"
