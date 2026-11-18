"""Le canal SMTP par l'API : réglage, refus directs, secret jamais rendu, geste réel, coupure.

@verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 (validation à l'enregistrement, mot de
          passe scellé), §47.3.2 ter (couper un canal le dit, par lui), §47.3.3 (le mot de
          passe du garde), §47.6 (agrégat et détail) · CLAUDE.md §10 (toute règle d'accès se
          prouve par une requête directe qui contourne l'interface)

Le registre est le vrai (SQLite, vraies migrations), la clé de la Forge est un vrai fichier, le
serveur SMTP est un vrai serveur sur une socket (`smtp_local.py`). Les refus sont prouvés par des
requêtes directes : aucune interface n'est sollicitée.
"""

from __future__ import annotations

import functools
import json

import pytest
from fastapi.testclient import TestClient

from sparkd import audit, environnement, notification
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

from smtp_local import (ServeurSmtp, contexte_client, contexte_serveur,
                        fabriquer_certificat)

GIO = 1024**3
GARDE = "le-garde"
MOT_SMTP = "MOT-DE-PASSE-SMTP-reconnaissable"


@pytest.fixture(scope="module")
def pki(tmp_path_factory):
    cert, cle = fabriquer_certificat(tmp_path_factory.mktemp("pki"))
    return {"serveur": contexte_serveur(cert, cle), "client": contexte_client(cert)}


@pytest.fixture()
def serveurs():
    ouverts: list[ServeurSmtp] = []

    def monter(**options) -> ServeurSmtp:
        s = ServeurSmtp(**options).demarrer()
        ouverts.append(s)
        return s

    yield monter
    for s in ouverts:
        s.arreter()


def forge(tmp_path):
    source = {"SPARKD_DB": str(tmp_path / "p.db"), "SPARKD_DRIVER": "fake",
              "SPARKD_SECRET_KEY_FILE": str(tmp_path / "cle")}
    client = TestClient(create_app(load(source)))
    client.post("/v1/forge/sync")
    return client


@pytest.fixture()
def client(tmp_path):
    yield forge(tmp_path)
    audit.set_canal(None)


def smtp(serveur, **extra):
    return {"password": GARDE, "smtp_enabled": 1, "smtp_host": "127.0.0.1",
            "smtp_port": serveur.port, "smtp_tls": "none", "smtp_from": "forge@exemple.fr",
            "smtp_to": "admin@exemple.fr", **extra}


def geste(client, nom="crm"):
    """Un VRAI geste sensible : créer puis supprimer un instantané."""
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared", "cpu_reservation": 0.25,
        "memory_bytes": GIO, "network_bps": 10_000_000, "storage_bytes": 10 * GIO}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/snapshots", json={"name": "avant"}).status_code in (200, 201)
    r = client.delete(f"/v1/sparks/{nom}/snapshots/avant")
    assert r.status_code == 200, r.text


# --- régler, relire, et le secret ne sort jamais ---------------------------------------------------


def test_regler_le_SMTP_puis_le_relire_sans_le_mot_de_passe(client, serveurs, pki):
    s = serveurs(starttls=True, contexte=pki["serveur"], compte=("alerte", MOT_SMTP))
    r = client.put("/v1/notify/channels", json=smtp(
        s, smtp_tls="starttls", smtp_username="alerte", smtp_password=MOT_SMTP))
    assert r.status_code == 200, r.text
    vue = r.json()["smtp"]
    assert vue["enabled"] and vue["configured"] and vue["password_set"] is True
    assert vue["host"] == "127.0.0.1" and vue["tls"] == "starttls" and vue["username"] == "alerte"
    # LE POINT : le mot de passe n'apparaît ni en réponse, ni en relecture, ni au registre en clair.
    assert MOT_SMTP not in r.text
    assert MOT_SMTP not in client.get("/v1/notify/channels").text
    assert MOT_SMTP not in client.get("/v1/forge").text
    brut = connect(client.app.state.config.database).execute(
        "SELECT * FROM notify_channels WHERE id = 1").fetchone()
    assert all(MOT_SMTP not in str(v) for v in tuple(brut))
    # ... il est SCELLÉ : la clé de la Forge, et le nom lié, le rouvrent.
    cle = environnement.charger_cle(client.app.state.config.secret_key_file)
    assert environnement.dechiffrer(cle, "notify.smtp.password", brut["smtp_password_secret"]) == MOT_SMTP
    with pytest.raises(environnement.CleError):
        environnement.dechiffrer(cle, "autre.nom", brut["smtp_password_secret"])
    # ... et il n'entre pas dans le journal.
    lignes = json.dumps(audit.listing(connect(client.app.state.config.database), limit=20))
    assert MOT_SMTP not in lignes


def test_un_mot_de_passe_absent_du_PUT_est_CONSERVE_et_vider_le_compte_l_EFFACE(client, serveurs):
    s = serveurs(compte=("alerte", MOT_SMTP), tls_avant_auth=False)
    base = smtp(s, smtp_tls="starttls", smtp_username="alerte", smtp_password=MOT_SMTP)
    assert client.put("/v1/notify/channels", json=base).status_code == 200
    r = client.put("/v1/notify/channels", json={"password": GARDE, "smtp_to": "autre@exemple.fr"})
    assert r.json()["smtp"]["password_set"] is True and r.json()["smtp"]["to"] == "autre@exemple.fr"
    r = client.put("/v1/notify/channels", json={
        "password": GARDE, "smtp_username": "", "smtp_tls": "none"})
    assert r.status_code == 200, r.text
    assert r.json()["smtp"]["password_set"] is False and r.json()["smtp"]["username"] is None


# --- les refus, par des requêtes DIRECTES --------------------------------------------------------


@pytest.mark.parametrize("changement,attendu", [
    ({"smtp_username": "alerte", "smtp_password": "x", "smtp_tls": "none"}, "ne part pas en clair"),
    ({"smtp_to": "a@x.fr\r\nBcc: victime@x.fr"}, "Destinataires refusés"),
    ({"smtp_to": ",".join(f"u{i}@x.fr" for i in range(11))}, "11 adresses"),
    ({"smtp_from": "a@x.fr, b@x.fr"}, "Adresse d'envoi refusée"),
    ({"smtp_port": 70000}, "n'existe pas"),
    ({"smtp_port": "abc"}, "n'est pas un nombre"),
    ({"smtp_tls": "ssl3"}, "inconnu"),
    ({"smtp_host": "https://mail.exemple.fr/"}, "n'est pas un nom d'hôte"),
    ({"smtp_username": "alerte", "smtp_tls": "starttls"}, "sans mot de passe"),
    ({"smtp_to": ""}, "il manque"),
    ({"smtp_nimporte": "x"}, "Champs inconnus"),
])
def test_une_configuration_invalide_est_REFUSEE_et_ne_change_rien(client, serveurs, changement, attendu):
    s = serveurs()
    assert client.put("/v1/notify/channels", json=smtp(s)).status_code == 200
    avant = client.get("/v1/notify/channels").json()["smtp"]
    r = client.put("/v1/notify/channels", json={"password": GARDE, **changement})
    assert r.status_code == 422, r.text
    assert attendu in r.json()["detail"]["message"]
    assert client.get("/v1/notify/channels").json()["smtp"] == avant, "un refus ne change RIEN"


def test_sans_le_bon_mot_de_passe_du_garde_rien_ne_change(client, serveurs):
    s = serveurs()
    assert client.put("/v1/notify/channels", json=smtp(s)).status_code == 200
    avant = client.get("/v1/notify/channels").json()
    for mot in ("", "FAUX"):
        r = client.put("/v1/notify/channels", json={
            "password": mot, "smtp_enabled": 0, "smtp_to": "pirate@evil.fr"})
        assert r.status_code == 403, r.text
    assert client.get("/v1/notify/channels").json()["smtp"] == avant["smtp"]


def test_un_canal_incomplet_ne_peut_pas_etre_active(client):
    r = client.put("/v1/notify/channels", json={"password": GARDE, "smtp_enabled": 1,
                                                "smtp_host": "mail.exemple.fr"})
    assert r.status_code == 422 and "il manque" in r.json()["detail"]["message"]


def test_desactive_un_brouillon_incomplet_est_permis(client):
    r = client.put("/v1/notify/channels", json={"password": GARDE, "smtp_host": "mail.exemple.fr"})
    assert r.status_code == 200 and r.json()["smtp"]["enabled"] is False
    assert r.json()["smtp"]["configured"] is True  # un serveur est posé : « configuré mais désactivé »


# --- un geste RÉEL produit un courriel, et la configuration survit au redémarrage ----------------------


def test_un_geste_reel_produit_un_courriel_chez_le_destinataire(client, serveurs):
    s = serveurs()
    r = client.put("/v1/notify/channels", json=smtp(s))
    assert r.status_code == 200 and r.json()["live_smtp"]["configured"] is True
    geste(client)
    client.app.state.notify_all.vider(10.0)
    assert len(s.recus) == 1
    recu = s.recus[0]
    assert recu["a"] == ["admin@exemple.fr"] and "snapshot.delete" in recu["message"]["Subject"]
    forge_vue = client.get("/v1/forge").json()["notify"]
    assert forge_vue["configured"] is True and forge_vue["sent"] == 1
    assert forge_vue["channels"]["smtp"]["sent"] == 1


def test_STARTTLS_avec_compte_de_bout_en_bout_le_mot_de_passe_scelle_est_celui_employe(client, serveurs, pki):
    s = serveurs(starttls=True, contexte=pki["serveur"], compte=("alerte", MOT_SMTP))
    client.app.state.notify_smtp._envoi = functools.partial(
        notification.envoyer_courriel, contexte=pki["client"], delai=3)
    r = client.put("/v1/notify/channels", json=smtp(
        s, smtp_tls="starttls", smtp_username="alerte", smtp_password=MOT_SMTP))
    assert r.status_code == 200, r.text
    geste(client)
    client.app.state.notify_all.vider(10.0)
    assert s.authentifications == [{"utilisateur": "alerte", "mot_de_passe": MOT_SMTP, "tls": True}]
    assert len(s.recus) == 1


def test_la_configuration_est_reprise_au_demarrage_depuis_le_registre(tmp_path, serveurs):
    s = serveurs()
    premier = forge(tmp_path)
    assert premier.put("/v1/notify/channels", json=smtp(s)).status_code == 200
    second = forge(tmp_path)  # une nouvelle application, le MÊME registre
    try:
        assert second.get("/v1/notify/channels").json()["live_smtp"]["configured"] is True
        geste(second)
        second.app.state.notify_all.vider(10.0)
        assert len(s.recus) == 1
    finally:
        audit.set_canal(None)


def test_un_mot_de_passe_qui_ne_se_dechiffre_plus_met_le_canal_en_mal_configure(tmp_path, serveurs, pki):
    s = serveurs(starttls=True, contexte=pki["serveur"], compte=("alerte", MOT_SMTP))
    premier = forge(tmp_path)
    assert premier.put("/v1/notify/channels", json=smtp(
        s, smtp_tls="starttls", smtp_username="alerte", smtp_password=MOT_SMTP)).status_code == 200
    (tmp_path / "cle").unlink()  # la clé de la Forge change : le chiffré est illisible
    second = forge(tmp_path)
    try:
        live = second.get("/v1/notify/channels").json()["live_smtp"]
        assert live["misconfigured"] is True and "ressaisissez" in live["misconfiguration"]
        assert second.get("/v1/forge").json()["notify"]["misconfigured"] is True
    finally:
        audit.set_canal(None)


# --- couper un canal le DIT, par lui (§47.3.2 ter) ------------------------------------------------------


class Espion:
    def __init__(self):
        self.envois: list[dict] = []

    def __call__(self, url, charge, **_):
        self.envois.append(charge if isinstance(charge, dict) else json.loads(charge))
        return True


def test_couper_le_SMTP_alors_que_le_webhook_reste_previent_les_DEUX(client, serveurs):
    s = serveurs()
    espion = Espion()
    client.app.state.notify._envoi = espion
    assert client.put("/v1/notify/channels", json={
        **smtp(s), "webhook_enabled": 1, "webhook_url": "https://salon.test/hook"}).status_code == 200
    avant_http, avant_smtp = len(espion.envois), len(s.recus)
    r = client.put("/v1/notify/channels", json={"password": GARDE, "smtp_enabled": 0})
    assert r.status_code == 200, r.text
    assert len(s.recus) == avant_smtp + 1, "le canal qu'on coupe dit qu'il se tait, PAR LUI"
    texte = s.recus[-1]["message"].get_content()
    assert "DÉSACTIVÉ" in texte and "courriel (SMTP)" in texte
    assert len(espion.envois) == avant_http + 1, "l'autre canal sait qu'il reste seul"
    assert "continue de veiller" in espion.envois[-1]["message"]
    # Et le canal coupé est bien coupé.
    assert client.get("/v1/notify/channels").json()["live_smtp"]["configured"] is False


def test_couper_les_DEUX_dit_que_plus_rien_ne_veille(client, serveurs):
    s = serveurs()
    espion = Espion()
    client.app.state.notify._envoi = espion
    client.put("/v1/notify/channels", json={
        **smtp(s), "webhook_enabled": 1, "webhook_url": "https://salon.test/hook"})
    avant_http, avant_smtp = len(espion.envois), len(s.recus)
    client.put("/v1/notify/channels", json={"password": GARDE, "smtp_enabled": 0, "webhook_enabled": 0})
    assert len(s.recus) == avant_smtp + 1 and len(espion.envois) == avant_http + 1
    assert "plus rien ne veille" in s.recus[-1]["message"].get_content()
    assert "plus rien ne veille" in espion.envois[-1]["message"]


def test_un_refus_du_garde_n_annonce_aucune_coupure(client, serveurs):
    s = serveurs()
    client.put("/v1/notify/channels", json=smtp(s))
    avant = len(s.recus)
    assert client.put("/v1/notify/channels", json={"password": "FAUX", "smtp_enabled": 0}).status_code == 403
    assert len(s.recus) == avant, "le canal ne crie pas sa mort quand le mot de passe est refusé"


def test_changer_le_destinataire_n_est_pas_une_coupure(client, serveurs):
    s = serveurs()
    client.put("/v1/notify/channels", json=smtp(s))
    avant = len(s.recus)
    client.put("/v1/notify/channels", json={"password": GARDE, "smtp_to": "autre@exemple.fr"})
    assert len(s.recus) == avant
