"""Le canal SMTP, et l'indépendance des deux canaux, contre un VRAI serveur SMTP local.

@verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 (mode TLS, certificat toujours vérifié,
          mot de passe, adresses, message), §47.3.2 bis (deux témoins indépendants : l'échec
          de l'un n'empêche pas l'autre), §47.4 (ce que l'envoi porte, jamais le payload),
          §47.5 (un serveur muet ne retarde jamais un geste), §47.6 (l'agrégat et le détail)

Ce que ces preuves gardent : **ce qui part réellement sur la socket**, pas ce qu'on croit avoir
donné à `smtplib`. Le serveur (`smtp_local.py`) parle le protocole ; il annonce STARTTLS, parle
en TLS implicite, exige le TLS avant `AUTH`, refuse un mot de passe, et sait se taire.
"""

from __future__ import annotations

import functools
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from sparkd import audit, migrations, notification
from sparkd.db import connect

from smtp_local import (ServeurSmtp, contexte_client, contexte_serveur,
                         fabriquer_certificat)

SECRET = "SECRET-DU-PAYLOAD-à-ne-jamais-voir"


@pytest.fixture(scope="module")
def pki(tmp_path_factory):
    cert, cle = fabriquer_certificat(tmp_path_factory.mktemp("pki"))
    return {"cert": cert, "serveur": contexte_serveur(cert, cle), "client": contexte_client(cert)}


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


@pytest.fixture()
def registre(tmp_path):
    connection = connect(tmp_path / "registre.db")
    migrations.upgrade(connection)
    yield connection
    audit.set_canal(None)
    connection.close()


#: Un « serveur » qui n'existe pas : le message se construit sans réseau.
SANS_SERVEUR = type("SansServeur", (), {"port": 25})()


def reglage(serveur: ServeurSmtp, **extra) -> notification.ReglageSmtp:
    base = dict(host="127.0.0.1", port=serveur.port, tls="none", sender="forge@exemple.fr",
                recipients=("admin@exemple.fr",))
    base.update(extra)
    return notification.ReglageSmtp(**base)


def envoi(pki, **options):
    return functools.partial(notification.envoyer_courriel, contexte=pki["client"], **options)


def charge(**extra) -> dict:
    return {**notification.corps({
        "ts": "2026-11-18T10:00:00+00:00", "action": "spark.delete", "actor": "console/prod",
        "actor_class": "human", "target_type": "spark", "target_id": "crm", "result": "ok",
        "message": "Spark « crm » supprimé.", "payload": {"secret": SECRET}}, "ma-forge"), **extra}


# --- les adresses : un en-tête ne se construit pas depuis un texte qui en injecte un autre -----


def test_adresses_valides_et_refusees():
    assert notification.adresses_valides("a@x.fr, b@y.org") == ("a@x.fr", "b@y.org")
    for mauvais in ("", "pas-une-adresse", "a@x.fr\r\nBcc: v@z.fr", "a@x.fr\nBcc: v@z.fr",
                    "<a@x.fr>", "a b@x.fr", "a@", "@x.fr", "a@x.fr;b@x.fr"):
        with pytest.raises(ValueError):
            notification.adresses_valides(mauvais)
    with pytest.raises(ValueError, match="11 adresses"):
        notification.adresses_valides(",".join(f"u{i}@x.fr" for i in range(11)))


def test_le_reglage_ne_montre_pas_son_mot_de_passe_dans_une_trace():
    r = notification.ReglageSmtp("h", 25, "tls", "a@x.fr", ("b@x.fr",), "compte", "TRÈS-SECRET")
    assert "TRÈS-SECRET" not in repr(r) and "TRÈS-SECRET" not in str(r)


# --- le message : les dix champs, jamais le payload, jamais un en-tête injecté ---------------------


def test_le_message_porte_les_dix_champs_et_JAMAIS_le_payload():
    m = notification.message_courriel(charge(), reglage(SANS_SERVEUR))
    texte = m.get_content()
    for champ in notification.CHAMPS:
        assert f"{champ} : " in texte
    assert SECRET not in m.as_string() and "payload" not in m.as_string()
    assert m["Subject"] == "[ma-forge] spark.delete — crm"
    assert m["From"] == "forge@exemple.fr" and m["To"] == "admin@exemple.fr"
    assert m["Date"] and m["Message-ID"]


def test_un_saut_de_ligne_dans_la_cible_ne_peut_pas_injecter_un_en_tete():
    sale = charge(target_id="crm\r\nBcc: victime@x.fr", action="a\nb")
    m = notification.message_courriel(sale, reglage(SANS_SERVEUR))
    assert "\n" not in m["Subject"] and "\r" not in m["Subject"]
    assert m["Bcc"] is None
    assert "Bcc" not in [k for k, _ in m.items()]


# --- ce qui part RÉELLEMENT sur la socket ------------------------------------------------------------


def test_en_clair_sans_compte_le_courriel_est_recu(serveurs, pki):
    s = serveurs()
    notification.envoyer_courriel(reglage(s), charge(), delai=3)
    assert len(s.recus) == 1
    recu = s.recus[0]
    assert recu["de"] == "forge@exemple.fr" and recu["a"] == ["admin@exemple.fr"]
    assert recu["tls"] is False
    assert recu["message"]["Subject"] == "[ma-forge] spark.delete — crm"
    assert SECRET not in recu["brut"], "le payload n'a pas à figurer sur la socket"


def test_STARTTLS_avec_compte_le_mot_de_passe_ne_part_qu_APRES_la_montee_en_TLS(serveurs, pki):
    s = serveurs(starttls=True, contexte=pki["serveur"], compte=("alerte", "le-mot"))
    notification.envoyer_courriel(
        reglage(s, tls="starttls", username="alerte", password="le-mot"), charge(),
        contexte=pki["client"], delai=3)
    assert s.authentifications == [{"utilisateur": "alerte", "mot_de_passe": "le-mot", "tls": True}]
    assert len(s.recus) == 1 and s.recus[0]["tls"] is True


def test_TLS_implicite_avec_compte(serveurs, pki):
    s = serveurs(tls_implicite=True, contexte=pki["serveur"], compte=("alerte", "le-mot"))
    notification.envoyer_courriel(
        reglage(s, tls="tls", username="alerte", password="le-mot"), charge(),
        contexte=pki["client"], delai=3)
    assert len(s.recus) == 1 and s.recus[0]["tls"] is True


def test_STARTTLS_exige_PAS_de_repli_en_clair(serveurs, pki):
    """Le serveur n'annonce pas STARTTLS : l'envoi ÉCHOUE, et rien — surtout pas un mot de
    passe — n'est parti en clair (§47.3.2 point 1)."""
    s = serveurs(starttls=False, compte=("alerte", "le-mot"), tls_avant_auth=False)
    with pytest.raises(Exception):
        notification.envoyer_courriel(
            reglage(s, tls="starttls", username="alerte", password="le-mot"), charge(),
            contexte=pki["client"], delai=3)
    assert s.authentifications == [] and s.recus == []


def test_le_certificat_est_TOUJOURS_verifie(serveurs, pki):
    """Sans `contexte`, le contexte par défaut du système ne fait pas confiance à ce certificat
    auto-signé : l'envoi échoue. Aucun réglage ne permet de s'en dispenser."""
    s = serveurs(tls_implicite=True, contexte=pki["serveur"])
    with pytest.raises(Exception, match="CERTIFICATE|certificate|verify"):
        notification.envoyer_courriel(reglage(s, tls="tls"), charge(), delai=3)
    assert s.recus == []


def test_un_mauvais_mot_de_passe_echoue_et_ne_livre_rien(serveurs, pki):
    s = serveurs(starttls=True, contexte=pki["serveur"], compte=("alerte", "le-mot"))
    with pytest.raises(Exception, match="535|credentials|Authentication"):
        notification.envoyer_courriel(
            reglage(s, tls="starttls", username="alerte", password="FAUX"), charge(),
            contexte=pki["client"], delai=3)
    assert s.recus == []


# --- LE POINT DE L'UNITÉ : un serveur muet ne retarde jamais un geste (§47.5) ---------------------


def test_un_serveur_MUET_ne_retarde_pas_le_geste_et_l_echec_est_dit(serveurs, registre, pki):
    s = serveurs(mode="muet")
    c = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=0.6))
    c.reregler(reglage(s))
    audit.set_canal(c)
    debut = time.monotonic()
    audit.record(registre, "console/prod", "spark.delete", "ok", "Spark « crm » supprimé.",
                 actor_class="human")
    assert time.monotonic() - debut < 0.5, "le geste a attendu le serveur SMTP"
    assert audit.listing(registre, limit=1)[0]["action"] == "spark.delete"
    assert c.vider(10.0)
    e = c.etat()
    assert e["failed"] == 1 and e["sent"] == 0 and e["last_error"], "l'échec est DIT (§47.6)"


# --- le canal derrière l'audit : un geste réel produit un courriel -----------------------------------


def test_un_geste_destructif_produit_un_courriel_sans_le_payload(serveurs, registre, pki):
    s = serveurs()
    c = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=3))
    c.reregler(reglage(s))
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.delete", "ok", "Spark « crm » supprimé.",
                 actor_class="human", target_type="spark", target_id="crm",
                 payload={"cle_privee": SECRET})
    assert c.vider(10.0)
    assert len(s.recus) == 1
    assert SECRET not in s.recus[0]["brut"]
    assert c.etat()["sent"] == 1


def test_un_geste_de_construction_ou_un_canal_desactive_ne_produit_rien(serveurs, registre, pki):
    s = serveurs()
    c = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=3))
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.delete", "ok", "x", actor_class="human")  # non configuré
    c.reregler(reglage(s))
    audit.record(registre, "console/prod", "spark.create", "ok", "x", actor_class="human")  # hors liste
    c.vider(5.0)
    assert s.recus == []
    c.reregler(None)  # désactivé = absent
    audit.record(registre, "console/prod", "spark.delete", "ok", "x", actor_class="human")
    c.vider(5.0)
    assert s.recus == [] and c.etat()["configured"] is False


def test_un_mot_de_passe_illisible_met_le_canal_en_mal_configure_sans_rien_tenter(serveurs, registre, pki):
    s = serveurs()
    c = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=3))
    c.reregler(reglage(s, username="alerte", password=None), illisible=True)
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.delete", "ok", "x", actor_class="human")
    c.vider(5.0)
    e = c.etat()
    assert e["misconfigured"] is True and "ressaisissez" in e["misconfiguration"]
    assert s.connexions == 0, "un canal mal configuré ne tente rien"


# --- L'INDÉPENDANCE : l'échec de l'un n'empêche pas l'autre (§47.3.2 bis) ----------------------------


class Facteur(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        taille = int(self.headers.get("content-length", 0))
        self.server.recus.append(json.loads(self.rfile.read(taille).decode("utf-8")))
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture()
def webhook():
    serveur = HTTPServer(("127.0.0.1", 0), Facteur)
    serveur.recus = []
    threading.Thread(target=serveur.serve_forever, daemon=True).start()
    yield serveur, f"http://127.0.0.1:{serveur.server_address[1]}/notify"
    serveur.shutdown()
    serveur.server_close()


def ensemble(url, smtp):
    wh = notification.Canal(url=url, forge="ma-forge")
    return wh, notification.Ensemble(webhook=wh, smtp=smtp)


def test_les_DEUX_canaux_recoivent_le_meme_geste(serveurs, registre, pki, webhook):
    http, url = webhook
    s = serveurs()
    smtp = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=3))
    smtp.reregler(reglage(s))
    wh, tous = ensemble(url, smtp)
    audit.set_canal(tous)
    audit.record(registre, "console/prod", "spark.unprotect", "ok", "Protection levée.",
                 actor_class="human", target_type="spark", target_id="crm")
    assert tous.vider(10.0)
    assert len(http.recus) == 1 and len(s.recus) == 1
    e = tous.etat()
    assert e["sent"] == 2 and e["failed"] == 0 and e["configured"] is True
    assert e["channels"]["webhook"]["sent"] == 1 and e["channels"]["smtp"]["sent"] == 1


def test_un_webhook_INJOIGNABLE_n_empeche_pas_le_courriel(serveurs, registre, pki):
    s = serveurs()
    smtp = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=3))
    smtp.reregler(reglage(s))
    wh, tous = ensemble("http://127.0.0.1:1/absent", smtp)
    audit.set_canal(tous)
    audit.record(registre, "console/prod", "spark.delete", "ok", "Spark « crm » supprimé.",
                 actor_class="human")
    assert tous.vider(10.0)
    assert len(s.recus) == 1, "le courriel doit partir malgré le webhook coupé"
    e = tous.etat()
    assert e["channels"]["webhook"]["failed"] == 1 and e["channels"]["smtp"]["sent"] == 1
    assert e["failed"] == 1 and e["sent"] == 1
    assert e["last_error"].startswith("Webhook : "), "l'agrégat dit LEQUEL est muet"


def test_un_SMTP_muet_n_empeche_ni_ne_retarde_le_webhook(serveurs, registre, pki, webhook):
    http, url = webhook
    s = serveurs(mode="muet")
    smtp = notification.CanalSmtp(forge="ma-forge", envoi=envoi(pki, delai=1.5))
    smtp.reregler(reglage(s))
    wh, tous = ensemble(url, smtp)
    audit.set_canal(tous)
    debut = time.monotonic()
    audit.record(registre, "console/prod", "spark.delete", "ok", "Spark « crm » supprimé.",
                 actor_class="human")
    # Le webhook reçoit PENDANT que le SMTP attend encore son délai de garde.
    wh.vider(10.0)
    assert len(http.recus) == 1
    assert time.monotonic() - debut < 1.2, "le webhook a attendu le SMTP muet"
    assert smtp.etat()["sent"] == 0
    assert tous.vider(10.0)
    e = tous.etat()
    assert e["channels"]["smtp"]["failed"] == 1 and e["channels"]["webhook"]["sent"] == 1
    assert e["last_error"].startswith("SMTP : ")


def test_une_exception_d_un_canal_ne_retient_pas_l_autre(serveurs, registre, pki, webhook):
    http, url = webhook

    class Casse(notification.CanalSmtp):
        def poster(self, ligne, *, maintenant=None):
            raise RuntimeError("canal cassé")

    casse = Casse(forge="ma-forge")
    wh = notification.Canal(url=url, forge="ma-forge")
    tous = notification.Ensemble(smtp=casse, webhook=wh)  # le cassé est ALIMENTÉ en premier
    audit.set_canal(tous)
    audit.record(registre, "console/prod", "spark.delete", "ok", "x", actor_class="human")
    assert tous.vider(10.0)
    assert len(http.recus) == 1


def test_l_agregat_ne_dit_pas_tout_va_bien_quand_un_canal_est_muet(serveurs, pki, webhook):
    http, url = webhook
    smtp = notification.CanalSmtp(forge="ma-forge")
    wh, tous = ensemble(url, smtp)
    assert tous.etat()["configured"] is True  # le webhook veille, le SMTP n'est pas configuré
    assert tous.etat()["channels"]["smtp"]["configured"] is False
    sans, aucun = ensemble("", notification.CanalSmtp(forge="ma-forge"))
    assert aucun.etat()["configured"] is False and aucun.vivants() == ()
