"""Preuves du pilote Incus : ce qu'il dit d'un refus, et ce qu'il envoie.

@verifies docs/BACKLOG.md#SPK-90 · docs/DAT.md §5.3 (le corps d'Incus fait
          autorité sur la cause), §5.4 (supprimer, c'est arrêter puis détruire),
          §14.5 (une absence RAPPORTÉE porte son propre type)

Ce que ces preuves gardent : un refus d'Incus doit arriver LISIBLE. Le produit
formatait l'exception `httpx` et rendait un lien vers MDN là où le serveur avait
écrit la cause en trois mots — « Instance is running ».
"""

from __future__ import annotations

import pytest

from sparkd.incus import InstanceAbsente, IncusError, UnixSocketIncus

# --- SPK-90 · un refus d'Incus se lit, et supprimer arrête d'abord ---------
#
# @verifies docs/BACKLOG.md#SPK-90 · docs/DAT.md §5.3 (le corps fait autorité
#           sur la cause), §5.4 (arrêter puis détruire), §14.5 (le 404 reste
#           une absence RAPPORTÉE)

import httpx as _httpx

from sparkd.incus import _raison


def _refus(code: int, corps):
    """Une erreur `httpx` telle que le vrai pilote la reçoit."""
    requete = _httpx.Request("DELETE", "http://incus/1.0/instances/ubuntu-demo")
    reponse = _httpx.Response(code, json=corps, request=requete)
    return _httpx.HTTPStatusError("Client error", request=requete, response=reponse)


def test_le_corps_d_incus_fait_autorite_sur_la_cause():
    """Le cas mesuré le 2026-09-02 : le produit rendait « Client error '400 Bad
    Request' … » et un lien vers MDN, quand Incus avait écrit la raison."""
    erreur = _refus(400, {"error_code": 400, "error": "Instance is running",
                          "type": "error", "metadata": None})
    assert _raison(erreur) == "Instance is running"
    assert "developer.mozilla.org" not in _raison(erreur)


def test_un_corps_SANS_cause_ne_fait_pas_inventer_de_raison():
    """Ne pas savoir n'autorise pas à écrire une cause plausible : on rend alors
    ce que le transport dit, faute de mieux."""
    for corps in ({}, {"error": ""}, {"autre": "chose"}, "pas du json"):
        erreur = _refus(400, corps) if corps != "pas du json" else _refus(400, {})
        assert _raison(erreur), "un message vide ne renseignerait personne"


def test_supprimer_ARRETE_la_cellule_avant_de_la_detruire(tmp_path):
    """§5.4 : Incus refuse `DELETE` sur une instance en marche. Sans l'arrêt,
    supprimer un Spark démarré échouait TOUJOURS."""
    gestes = []

    class Pilote(UnixSocketIncus):
        def set_instance_state(self, name, action):
            gestes.append(("state", name, action))

        def _request(self, method, path, body):
            gestes.append((method, path))
            return {}

    Pilote(socket_path=str(tmp_path / "s")).delete_instance("ubuntu-demo")
    assert gestes[0] == ("state", "ubuntu-demo", "stop"), "l'arrêt vient d'abord"
    assert gestes[1] == ("DELETE", "/1.0/instances/ubuntu-demo")


def test_une_cellule_DEJA_arretee_se_supprime_quand_meme(tmp_path):
    """L'arrêt est un moyen, pas une condition : son refus ne doit pas empêcher
    une suppression que l'exploitant a confirmée."""
    supprimees = []

    class Pilote(UnixSocketIncus):
        def set_instance_state(self, name, action):
            raise IncusError("The instance is already stopped")

        def _request(self, method, path, body):
            supprimees.append(path)
            return {}

    Pilote(socket_path=str(tmp_path / "s")).delete_instance("boutique")
    assert supprimees == ["/1.0/instances/boutique"]


def test_une_instance_ABSENTE_reste_une_absence_rapportee(tmp_path):
    """§14.5 : la correction du message ne doit pas transformer un 404 en panne.
    Confondre les deux ferait effacer une ligne du registre parce qu'on n'a pas
    pu poser la question."""
    class Pilote(UnixSocketIncus):
        def set_instance_state(self, name, action):
            raise InstanceAbsente("Incus ne connaît pas « orphelin ».")

    with pytest.raises(InstanceAbsente):
        Pilote(socket_path=str(tmp_path / "s")).delete_instance("orphelin")
