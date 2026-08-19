"""@verifies docs/BACKLOG.md#SPK-34 · docs/DAT.md §35.2 (portee entiere, ses
             trois exceptions), §35.3 (le mot de passe), §35.5 (surface d'API)

La DoD exige que le refus soit prouve sur CHACUNE des ecritures listees, avec
les vrais droits et SANS passer par l'interface. C'est le sens meme du §35.1 :
la protection est appliquee cote runtime, sinon elle ne protegerait pas du cas
le plus frequent — le script, pas l'humain.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

#: Reprise de test_audit.py : une cle qui passe reellement le controle de forme.
CLE_PUBLIQUE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3f"
                "SF4BkFEV5LL5Sl2XoT poste")


@pytest.fixture
def client(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "p.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/host/sync")
    return c


def creer(client, nom="crm"):
    reponse = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    })
    assert reponse.status_code == 201, reponse.text
    return nom


def armer(client, nom, mot="secret"):
    reponse = client.post(f"/v1/sparks/{nom}/protection", json={"password": mot})
    assert reponse.status_code == 200, reponse.text
    assert reponse.json()["protected"] is True
    return reponse.json()


# --- armer, lever, rearmer (§35.4, §35.5) -----------------------------------

def test_armer_puis_lever_par_l_API(client):
    nom = creer(client)
    assert client.get(f"/v1/sparks/{nom}/protection").json()["protected"] is False
    armer(client, nom, "un")
    assert client.get(f"/v1/sparks/{nom}/protection").json()["protected"] is True

    leve = client.request("DELETE", f"/v1/sparks/{nom}/protection",
                          json={"password": "un"})
    assert leve.status_code == 200 and leve.json()["protected"] is False


def test_un_mot_de_passe_errone_repond_403_et_ne_desarme_rien(client):
    nom = creer(client)
    armer(client, nom, "bon")
    refus = client.request("DELETE", f"/v1/sparks/{nom}/protection",
                           json={"password": "mauvais"})
    assert refus.status_code == 403
    assert refus.json()["detail"]["error"] == "bad_protection_password"
    assert client.get(f"/v1/sparks/{nom}/protection").json()["protected"] is True


def test_l_etat_protege_est_visible_DANS_LA_LISTE(client):
    """§35.4 : partout ou le Spark est liste, pas seulement dans sa fenetre."""
    a, b = creer(client, "protege"), creer(client, "libre")
    armer(client, a)
    par_nom = {s["name"]: s for s in client.get("/v1/sparks").json()["sparks"]}
    assert par_nom[a]["protected"] is True
    # Un Spark desarme le DIT aussi clairement, pour que l'oubli se voie.
    assert par_nom[b]["protected"] is False
    assert client.get(f"/v1/sparks/{a}").json()["protected"] is True


def test_l_empreinte_ne_sort_JAMAIS_du_registre(client):
    """docs/SCHEMA.md §4.1. La publier laisserait attaquer hors ligne un secret
    que le §35.1 assume deja comme faible."""
    nom = creer(client)
    armer(client, nom, "correct horse")
    corps = json.dumps([client.get("/v1/sparks").json(),
                        client.get(f"/v1/sparks/{nom}").json(),
                        client.get(f"/v1/sparks/{nom}/protection").json()])
    for interdit in ("protection_hash", "protection_salt", "protection_params",
                     "correct horse"):
        assert interdit not in corps


# --- LE REFUS 423 SUR CHACUNE DES ECRITURES (§35.2) -------------------------

def test_les_commandes_de_cycle_de_vie_sont_refusees(client):
    nom = creer(client)
    armer(client, nom)
    for action in ("apply", "start", "stop", "restart", "retry", "delete"):
        refus = client.post(f"/v1/sparks/{nom}/{action}")
        assert refus.status_code == 423, f"{action} : {refus.status_code}"
        detail = refus.json()["detail"]
        assert detail["error"] == "spark_protected"
        assert detail["spark"] == nom
        # Le refus NOMME le geste, pas seulement le Spark (§35.5).
        assert "protégé" in detail["message"]


def test_une_route_est_refusee_EN_AJOUT_COMME_EN_RETRAIT(client):
    nom = creer(client)
    # La route est declaree AVANT l'armement : c'est le retrait qu'on eprouve.
    pose = client.post("/v1/ingress", json={
        "spark": nom, "domain": "exemple.test", "port": 8080, "tls": False})
    assert pose.status_code in (201, 502), pose.text
    armer(client, nom)

    ajout = client.post("/v1/ingress", json={
        "spark": nom, "domain": "autre.test", "port": 8080, "tls": False})
    assert ajout.status_code == 423

    retrait = client.delete("/v1/ingress/exemple.test")
    assert retrait.status_code == 423, "le Spark visé se lit sur la ROUTE"


def test_l_octroi_d_une_cle_est_refuse(client):
    nom = creer(client)
    assert client.post("/v1/ssh-keys", json={
        "label": "poste", "public_key": CLE_PUBLIQUE}).status_code == 201
    armer(client, nom)
    refus = client.post(f"/v1/sparks/{nom}/ssh-keys/poste")
    assert refus.status_code == 423
    assert refus.json()["detail"]["gesture"] == "ssh-key-grant"


def test_les_instantanes_sont_refuses_y_compris_la_RESTAURATION(client):
    nom = creer(client)
    client.post(f"/v1/sparks/{nom}/apply")
    pris = client.post(f"/v1/sparks/{nom}/snapshots", json={"name": "avant"})
    assert pris.status_code == 201, pris.text
    armer(client, nom)

    assert client.post(f"/v1/sparks/{nom}/snapshots",
                       json={"name": "apres"}).status_code == 423
    assert client.post(
        f"/v1/sparks/{nom}/snapshots/avant/restore", json={}).status_code == 423
    assert client.delete(f"/v1/sparks/{nom}/snapshots/avant").status_code == 423


def test_les_LECTURES_ne_sont_jamais_refusees(client):
    """§35.2 : « Ne sont pas refusées : les lectures, les métriques, le journal »."""
    nom = creer(client)
    armer(client, nom)
    for chemin in (f"/v1/sparks/{nom}", "/v1/sparks", f"/v1/sparks/{nom}/usage",
                   "/v1/audit", "/v1/host", f"/v1/sparks/{nom}/snapshots"):
        assert client.get(chemin).status_code == 200, chemin


# --- LES DEUX EXCEPTIONS STRUCTURELLES (§35.2) ------------------------------

def test_les_recalculs_globaux_passent_TOUJOURS_sur_un_spark_protege(client):
    """Les bloquer ferait echouer la creation d'un AUTRE Spark parce qu'un
    troisieme est protege : incomprehensible, et faux — ces recalculs n'alterent
    ni sa configuration, ni son etat, ni ses donnees."""
    protege = creer(client, "protege")
    client.post(f"/v1/sparks/{protege}/apply")
    armer(client, protege)

    # Creer un Spark DEDIE declenche la redistribution des coeurs (§7.4 bis) et
    # la reponderation de la tranche (§32.2). Les deux traversent le protege.
    autre = client.post("/v1/sparks", json={
        "name": "dedie", "image": "images:debian/13", "cpu_mode": "dedicated",
        "cpu_cores": 1, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 5 * GIO,
    })
    assert autre.status_code == 201, autre.text
    # Et le protege l'est toujours : rien ne l'a desarme au passage.
    assert client.get(f"/v1/sparks/{protege}/protection").json()["protected"] is True


# --- RETIRER UN ACCES PASSE TOUJOURS (§35.2, §35.5) -------------------------

def _poser_cle(client, nom, label="poste"):
    assert client.post("/v1/ssh-keys", json={
        "label": label, "public_key": CLE_PUBLIQUE}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/ssh-keys/{label}").status_code == 200
    return label


def test_revoquer_au_registre_NOMME_les_sparks_proteges_puis_aboutit(client):
    nom = creer(client)
    label = _poser_cle(client, nom)
    armer(client, nom)

    premier = client.delete(f"/v1/ssh-keys/{label}")
    assert premier.status_code == 409
    detail = premier.json()["detail"]
    assert detail["error"] == "protected_sparks_affected"
    assert detail["protected_sparks"] == [nom], "la liste est NOMMEE"
    assert nom in detail["message"]

    second = client.request("DELETE", f"/v1/ssh-keys/{label}",
                            json={"accept_protected": True})
    assert second.status_code == 200, second.text
    # AUCUNE protection n'a ete levee au passage (§35.2).
    assert client.get(f"/v1/sparks/{nom}/protection").json()["protected"] is True


def test_sans_spark_protege_la_revocation_passe_DIRECTEMENT(client):
    """§35.5 : « s'il n'y a aucun Spark protégé, il n'y a pas de refus du tout »."""
    nom = creer(client)
    label = _poser_cle(client, nom)
    assert client.delete(f"/v1/ssh-keys/{label}").status_code == 200


def test_revoquer_SUR_un_spark_protege_suit_la_meme_mecanique(client):
    nom = creer(client)
    label = _poser_cle(client, nom)
    armer(client, nom)

    premier = client.delete(f"/v1/sparks/{nom}/ssh-keys/{label}")
    assert premier.status_code == 409
    assert premier.json()["detail"]["protected_sparks"] == [nom]

    second = client.request("DELETE", f"/v1/sparks/{nom}/ssh-keys/{label}",
                            json={"accept_protected": True})
    assert second.status_code == 200, second.text


def test_aucun_mot_de_passe_n_est_demande_pour_revoquer(client):
    """Exiger le secret de chaque Spark protege pour revoquer une cle qui a fui
    reviendrait a refuser (§35.5)."""
    nom = creer(client)
    label = _poser_cle(client, nom)
    armer(client, nom, "un secret que je ne fournis pas")
    assert client.request("DELETE", f"/v1/ssh-keys/{label}",
                          json={"accept_protected": True}).status_code == 200


# --- le journal (§21, §35.3) ------------------------------------------------

def test_aucun_mot_de_passe_n_atteint_le_journal_par_l_API(client):
    nom = creer(client)
    armer(client, nom, "correct horse battery staple")
    client.request("DELETE", f"/v1/sparks/{nom}/protection",
                   json={"password": "tentative ratee"})
    entier = json.dumps(client.get("/v1/audit?limit=200").json(), ensure_ascii=False)
    assert "correct horse battery staple" not in entier
    assert "tentative ratee" not in entier


def test_la_revocation_consigne_les_sparks_proteges_touches(client):
    """§35.2 : la trace doit dire ce que la revocation a traverse."""
    nom = creer(client)
    label = _poser_cle(client, nom)
    armer(client, nom)
    client.request("DELETE", f"/v1/ssh-keys/{label}", json={"accept_protected": True})

    entrees = client.get("/v1/audit?limit=200").json()["entries"]
    forget = next(e for e in entrees if e["action"] == "sshkey.forget")
    charge = forget["payload"]
    if isinstance(charge, str):
        charge = json.loads(charge)
    assert charge["protected_sparks"] == [nom]
    assert nom in forget["message"]
