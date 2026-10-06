"""@verifies docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 (l'aperçu : le même
rendu que l'envoi, sur un événement d'exemple ; rien d'écrit, rien d'envoyé)

Le DAT promettait que l'écran montre le rendu du gabarit avant d'enregistrer ;
l'onglet Alertes n'en montrait aucun. Ces preuves gardent la propriété qui donne
son sens à l'aperçu : il rend EXACTEMENT ce que l'envoi enverrait. Diagnostics
sur le doublon (DAT §28.7) ; la console se voit sur la VM du banc.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from sparkd import notification
from sparkd.app import create_app
from sparkd.config import load


def _client(tmp_path):
    return TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                       "SPARKD_DRIVER": "fake"})))


# --- le service -------------------------------------------------------------------

def test_l_apercu_rend_ce_que_l_ENVOI_enverrait():
    """La propriété centrale : un seul chemin pour l'aperçu et pour l'envoi."""
    gabarit = '{"content": "{action} sur {target_id} par {actor}"}'
    rendu = notification.apercu(gabarit, "forge-test")
    assert rendu["rendered"] == notification.texte_envoye(gabarit, rendu["event"])
    assert json.loads(rendu["rendered"]) == {
        "content": "spark.unprotect sur exemple par console/local"}
    assert rendu["valid_json"] is True and rendu["unknown_fields"] == []


def test_sans_gabarit_l_apercu_est_le_corps_STRUCTURE_du_47_4():
    rendu = notification.apercu("", "forge-test")
    assert json.loads(rendu["rendered"]) == rendu["event"]
    assert rendu["event"]["forge"] == "forge-test"
    assert "payload" not in rendu["event"], "le payload n'est jamais envoyé (§47.4)"


def test_un_champ_inconnu_est_NOMME_et_rien_n_est_rendu():
    rendu = notification.apercu('{"content": "{inconnu} {action}"}', "f")
    assert rendu["unknown_fields"] == ["inconnu"]
    assert rendu["rendered"] is None


def test_un_message_qui_n_est_pas_du_JSON_se_dit():
    rendu = notification.apercu("Alerte : {action}", "f")
    assert rendu["rendered"] == "Alerte : spark.unprotect"
    assert rendu["valid_json"] is False


def test_l_evenement_d_exemple_est_un_geste_que_la_liste_fermee_NOTIFIE():
    """§47.2 : un exemple qui ne notifierait pas montrerait un message qui ne
    part jamais."""
    evenement = notification.apercu("", "f")["event"]
    assert notification.notifiable(evenement["action"], evenement["result"],
                                   evenement["actor_class"])


# --- la route ----------------------------------------------------------------------

def test_la_route_rend_l_apercu_sans_RIEN_ecrire_ni_envoyer(tmp_path):
    client = _client(tmp_path)
    journal_avant = client.get("/v1/audit", params={"limit": 500}).json()["entries"]
    envoyes_avant = client.app.state.notify.etat()

    rendu = client.post("/v1/notify/preview",
                        json={"template": '{"text": "{forge} — {action}"}'})

    assert rendu.status_code == 200
    corps = rendu.json()
    assert json.loads(corps["rendered"])["text"].endswith("— spark.unprotect")
    assert corps["valid_json"] is True
    assert client.get("/v1/audit", params={"limit": 500}).json()["entries"] == journal_avant, \
        "rien n'entre au journal : c'est un calcul, pas un geste"
    assert client.app.state.notify.etat() == envoyes_avant, "rien n'est envoyé"


def test_la_route_refuse_un_gabarit_qui_n_est_pas_un_texte(tmp_path):
    refus = _client(tmp_path).post("/v1/notify/preview", json={"template": 42})
    assert refus.status_code == 422
    assert refus.json()["detail"]["error"] == "template_invalide"
