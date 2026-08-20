"""@verifies docs/BACKLOG.md#SPK-52 · docs/DAT.md §14.5 (une instance déjà
            absente vaut suppression réussie), §14.4 (ce que la suppression
            rend), §33.3 (ne pas savoir n'est pas savoir que ce n'est pas là),
            §35 (les Sparks protégés)

L'arbitrage fait de l'absence une raison de RÉUSSIR. Ces preuves gardent les
trois bornes qui l'empêchent d'être un mensonge : l'écart reste lisible au
journal, un pilote MUET reste une panne, et une protection armée s'applique
d'abord.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


def _pile(tmp_path):
    application = create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                   "SPARKD_DRIVER": "fake"}))
    client = TestClient(application)
    assert client.post("/v1/forge/sync").status_code == 200
    return client, application


def _spark(client, nom="condamne"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": GIO,
        "network_bps": 10_000_000}).status_code in (201, 202)
    assert client.post(f"/v1/sparks/{nom}/apply").status_code in (200, 202)
    return nom


def _journal(client, nom_action="spark.delete"):
    return [e for e in client.get("/v1/audit?limit=200").json()["entries"]
            if e["action"] == nom_action]


# --- la règle (§14.5) --------------------------------------------------------


def test_une_instance_DEJA_ABSENTE_fait_reussir_la_suppression(tmp_path):
    """LE cœur de l'unité.

    Mesuré le 2026-08-19 : `delete` rendait 502, l'entrée restait au registre,
    pesait dans l'admission, et aucun redémarrage ne la retirait — la reprise du
    §14.3 ne traite que les états transitoires. Le seul recours était d'ouvrir la
    base à la main.
    """
    client, application = _pile(tmp_path)
    nom = _spark(client)

    # L'instance disparaît HORS du produit, comme cela s'est réellement produit.
    application.state.incus.created.pop(nom)

    reponse = client.post(f"/v1/sparks/{nom}/delete")
    assert reponse.status_code == 200, reponse.text
    assert reponse.json() == {"deleted": nom}
    assert client.get(f"/v1/sparks/{nom}").status_code == 404, "la ligne doit partir"


def test_la_ressource_est_RENDUE_et_l_admission_la_recupere(tmp_path):
    """§14.4 : la ressource n'est rendue qu'à la disparition de la ligne. Une
    suppression qui échoue laisse donc la place occupée pour rien."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    # Les pools vivent sur l'écran de la Forge : c'est LÀ que l'exploitant voit
    # la place revenir, et c'est donc là qu'on la constate.
    avant = client.get("/v1/forge").json()["pools"]["memory"]["allocated"]

    application.state.incus.created.pop(nom)
    assert client.post(f"/v1/sparks/{nom}/delete").status_code == 200

    apres = client.get("/v1/forge").json()["pools"]["memory"]["allocated"]
    assert apres < avant, "la mémoire du Spark disparu doit retourner au pool" 


def test_l_ecart_est_LISIBLE_au_journal_et_ne_se_confond_pas(tmp_path):
    """Première borne : un `delete` ordinaire et un `delete` sur une instance
    disparue ne se lisent pas pareil (§14.5)."""
    client, application = _pile(tmp_path)

    ordinaire = _spark(client, "ordinaire")
    assert client.post(f"/v1/sparks/{ordinaire}/delete").status_code == 200

    disparu = _spark(client, "disparu")
    application.state.incus.created.pop(disparu)
    assert client.post(f"/v1/sparks/{disparu}/delete").status_code == 200

    entrees = _journal(client)
    # Le journal rend `payload` sous forme de TEXTE JSON : c'est la colonne du
    # registre, telle quelle. On la relit plutôt que de supposer sa forme.
    def charge(entree):
        brut = entree.get("payload")
        if isinstance(brut, str):
            try:
                return json.loads(brut)
            except json.JSONDecodeError:
                return {}
        return brut or {}

    marquees = [e for e in entrees if charge(e).get("instance_absente")]
    assert len(marquees) == 1, "une seule des deux suppressions porte la marque"
    assert "ABSENTE" in marquees[0]["message"], "le message le DIT en toutes lettres"
    assert "admission" in marquees[0]["message"], (
        "il dit aussi ce que la ligne coûtait, pas seulement qu'elle est partie")


def test_un_pilote_MUET_reste_une_panne(tmp_path):
    """Deuxième borne, et c'est la plus importante : ne pas pouvoir demander
    n'est PAS savoir que ce n'est pas là (§33.3). Confondre les deux ferait
    effacer une ligne pendant que l'instance continue de consommer."""
    client, application = _pile(tmp_path)
    nom = _spark(client)
    application.state.incus.fail_next["delete_instance"] = "socket injoignable"

    reponse = client.post(f"/v1/sparks/{nom}/delete")
    assert reponse.status_code == 502, reponse.text
    assert reponse.json()["detail"]["error"] == "incus_failed"
    assert client.get(f"/v1/sparks/{nom}").status_code == 200, (
        "la ligne RESTE : on ne sait pas ce qu'il en est de l'instance")


def test_un_spark_PROTEGE_reste_refuse_meme_sans_instance(tmp_path):
    """Troisième borne : le §35 s'applique d'abord. Une instance absente n'est
    pas une raison de contourner une protection armée."""
    client, application = _pile(tmp_path)
    nom = _spark(client, "protege")
    assert client.post(f"/v1/sparks/{nom}/protection",
                       json={"password": "mot-de-passe-long"}).status_code == 200

    application.state.incus.created.pop(nom)
    reponse = client.post(f"/v1/sparks/{nom}/delete")
    assert reponse.status_code == 423, reponse.text
    assert client.get(f"/v1/sparks/{nom}").status_code == 200


def test_un_spark_JAMAIS_applique_se_supprime_sans_toucher_au_pilote(tmp_path):
    """Un Spark `pending` n'a pas d'`incus_name` : il n'y a rien à supprimer chez
    le pilote, et la ligne part sans qu'on lui demande quoi que ce soit."""
    client, application = _pile(tmp_path)
    assert client.post("/v1/sparks", json={
        "name": "jamais", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": GIO,
        "network_bps": 10_000_000}).status_code in (201, 202)
    application.state.incus.fail_next["delete_instance"] = "ne doit pas être appelé"

    assert client.post("/v1/sparks/jamais/delete").status_code == 200
    assert client.get("/v1/sparks/jamais").status_code == 404
    assert "delete_instance" in application.state.incus.fail_next, (
        "le pilote ne doit pas avoir été sollicité")
