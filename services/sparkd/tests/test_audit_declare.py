"""@verifies docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.4.5 (ce que le journal
            reçoit d'une session), §37.4.6 (une porte ÉTROITE, et pourquoi),
            §37.5 (rien du contenu) · §21.6.2 (l'acteur est déclaré par l'hôte
            console) · §36.9 (la chaîne d'intégrité)

Le journal n'avait aucune écriture depuis l'extérieur. Cette porte en ouvre une :
ces preuves gardent qu'elle reste étroite, sans quoi une entrée forgée ne se
distinguerait pas d'une vraie.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load


def _client(tmp_path):
    return TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                       "SPARKD_DRIVER": "fake"})))


def _sessions(client):
    """Les entrées de SESSION, et elles seules.

    Le démarrage de `sparkd` en écrit d'autres — le relevé du catalogue —, et
    exiger un journal vide mesurerait le démarrage, pas cette porte.
    """
    return [e for e in client.get("/v1/audit").json()["entries"]
            if e["action"].startswith("spark.terminal_")]


def test_une_ouverture_de_session_est_declarable(tmp_path):
    client = _client(tmp_path)
    r = client.post("/v1/audit", json={
        "action": "spark.terminal_open", "target_id": "crm",
        "message": "Session de terminal ouverte sur « crm » par ssh.",
        "payload": {"path": "ssh"}},
        headers={"x-spark-actor": "console/local"})
    assert r.status_code == 201, r.text
    entrees = client.get("/v1/audit").json()["entries"]
    ouverture = next(e for e in entrees if e["action"] == "spark.terminal_open")
    assert ouverture["actor"] == "console/local"
    assert ouverture["result"] == "ok"


def test_une_action_HORS_LISTE_est_refusee_en_nommant_les_admises(tmp_path):
    """Sans cette borne, un appelant se ferait passer pour le runtime : une
    entrée forgée ne se distinguerait pas d'une vraie (§37.4.6)."""
    client = _client(tmp_path)
    for interdite in ("spark.delete", "host.sync", "image.verify", "n'importe quoi"):
        r = client.post("/v1/audit", json={"action": interdite},
                        headers={"x-spark-actor": "console/local"})
        assert r.status_code == 422, interdite
        assert "spark.terminal_open" in r.json()["detail"]["message"]
    assert _sessions(client) == []


def test_l_acteur_vient_de_l_EN_TETE_et_le_corps_ne_le_contredit_pas(tmp_path):
    """Laisser une requête choisir son identité au journal la rendrait triviale
    à falsifier depuis le poste lui-même (§21.6.2)."""
    client = _client(tmp_path)
    client.post("/v1/audit", json={
        "action": "spark.terminal_open", "target_id": "crm",
        "actor": "le-responsable-en-personne",
        "payload": {"path": "ssh"}},
        headers={"x-spark-actor": "console/poste-de-test"})
    entree = _sessions(client)[0]
    assert entree["actor"] == "console/poste-de-test"
    assert "responsable-en-personne" not in json.dumps(entree)


def test_une_cle_INCONNUE_de_la_charge_est_refusee_en_la_nommant(tmp_path):
    """Un champ libre deviendrait le dépôt de secrets en clair que le §37.5
    interdit précisément — c'est tout l'objet de la borne."""
    client = _client(tmp_path)
    r = client.post("/v1/audit", json={
        "action": "spark.terminal_close", "target_id": "crm",
        "payload": {"path": "ssh", "keystrokes": "mysql -pSECRET"}},
        headers={"x-spark-actor": "console/local"})
    assert r.status_code == 422
    assert "keystrokes" in r.json()["detail"]["message"]
    assert _sessions(client) == []


def test_une_charge_qui_n_est_pas_un_objet_est_refusee(tmp_path):
    client = _client(tmp_path)
    r = client.post("/v1/audit", json={"action": "spark.terminal_open",
                                       "payload": "mysql -pSECRET"},
                    headers={"x-spark-actor": "console/local"})
    assert r.status_code == 422


def test_la_fermeture_porte_la_DUREE_et_le_motif(tmp_path):
    client = _client(tmp_path)
    client.post("/v1/audit", json={
        "action": "spark.terminal_close", "target_id": "crm",
        "message": "Session de terminal fermée sur « crm » après 42 s (sortie).",
        "payload": {"path": "ssh", "reason": "sortie", "duration_seconds": 42}},
        headers={"x-spark-actor": "console/local"})
    entree = _sessions(client)[0]
    charge = json.loads(entree["payload"]) if isinstance(entree["payload"], str) else entree["payload"]
    assert charge == {"path": "ssh", "reason": "sortie", "duration_seconds": 42}
    assert "42 s" in entree["message"]


def test_l_entree_declaree_REJOINT_la_chaine_d_integrite(tmp_path):
    """§36.9 : une session de terminal est un geste du produit, pas une note en
    marge. La vérification la traverse sans la distinguer."""
    client = _client(tmp_path)
    client.post("/v1/audit", json={
        "action": "spark.terminal_open", "target_id": "crm",
        "payload": {"path": "ssh"}},
        headers={"x-spark-actor": "console/local"})
    verdict = client.get("/v1/audit/verify").json()
    assert verdict["intact"] is True
    assert verdict["head"]


def test_le_message_est_borne_en_longueur(tmp_path):
    """Un message sans borne serait un champ libre déguisé."""
    client = _client(tmp_path)
    client.post("/v1/audit", json={
        "action": "spark.terminal_open", "target_id": "crm",
        "message": "x" * 5000, "payload": {"path": "ssh"}},
        headers={"x-spark-actor": "console/local"})
    assert len(_sessions(client)[0]["message"]) <= 500


def test_le_depannage_est_une_action_DISTINCTE_et_donc_denombrable(tmp_path):
    """§37.3 : « pour qu'un relevé du journal montre combien de fois cette voie
    a servi ». C'est la raison d'être de l'action séparée, et c'est donc ce que
    cette preuve mesure — pas seulement qu'elle est acceptée.

    Le chemin de dépannage donne au plan de contrôle l'exécution en root chez le
    locataire (§37.3), ce que le §11 évite partout ailleurs. Noyé dans
    `spark.terminal_open`, son usage serait indénombrable, et une voie
    d'exception qu'on ne peut pas compter cesse d'être une exception.
    """
    client = _client(tmp_path)
    for _ in range(2):
        assert client.post("/v1/audit", json={
            "action": "spark.terminal_open", "target_id": "crm",
            "message": "Session de terminal ouverte sur « crm » par ssh.",
            "payload": {"path": "ssh"}},
            headers={"x-spark-actor": "console/local"}).status_code == 201
    r = client.post("/v1/audit", json={
        "action": "spark.rescue_exec", "target_id": "crm",
        "message": "Dépannage ouvert sur « crm » : exécution en root dans la "
                   "cellule, depuis le plan de contrôle.",
        "payload": {"path": "rescue", "reason": "sshd_muet"}},
        headers={"x-spark-actor": "console/local"})
    assert r.status_code == 201, r.text

    entrees = client.get("/v1/audit").json()["entries"]
    depannages = [e for e in entrees if e["action"] == "spark.rescue_exec"]
    normales = [e for e in entrees if e["action"] == "spark.terminal_open"]
    assert len(depannages) == 1, "le dépannage se compte tout seul"
    assert len(normales) == 2, "et il ne se confond pas avec les sessions SSH"
    assert depannages[0]["actor"] == "console/local"
    assert json.loads(depannages[0]["payload"])["path"] == "rescue"


def test_le_motif_du_depannage_reste_borne_aux_cles_admises(tmp_path):
    """Le §37.5 interdit qu'un champ libre serve de dépôt à ce qui a transité.
    Le dépannage ne relâche pas cette borne : il l'emprunte telle quelle."""
    client = _client(tmp_path)
    r = client.post("/v1/audit", json={
        "action": "spark.rescue_exec", "target_id": "crm",
        "payload": {"path": "rescue", "commande": "cat /etc/shadow"}},
        headers={"x-spark-actor": "console/local"})
    assert r.status_code == 422, r.text
    assert "commande" in r.json()["detail"]["message"]
    assert [e for e in client.get("/v1/audit").json()["entries"]
            if e["action"] == "spark.rescue_exec"] == []
