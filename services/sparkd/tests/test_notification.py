"""@verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.1 (elle s'accroche au SEUL
            chemin), §47.2 (liste FERMÉE), §47.4 (aucun secret n'y transite),
            §47.5 (un canal injoignable ne fait JAMAIS échouer un geste),
            §47.6 (l'échec est dit) · §21.2 (le caviardage) · §45.4

Ce que ces preuves gardent, et c'est LE point de l'unité : **le geste aboutit
quoi qu'il arrive au canal**, et **aucun secret n'y transite**.

Le canal est un VRAI serveur HTTP local, jamais un doublon de la fonction
d'envoi : c'est ce qui part sur le réseau qu'on veut mesurer, pas ce qu'on croit
lui avoir donné. Le §47.3 a retenu le webhook précisément parce qu'il se double
ainsi.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from sparkd import audit, migrations, notification
from sparkd.db import connect


class Facteur(BaseHTTPRequestHandler):
    """Un canal qui reçoit, et qui peut refuser sur commande."""

    def do_POST(self):  # noqa: N802 - imposé par http.server
        taille = int(self.headers.get("content-length", 0))
        brut = self.rfile.read(taille)
        self.server.recus.append(json.loads(brut.decode("utf-8")))
        code = self.server.code
        self.send_response(code)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):  # silence
        pass


@pytest.fixture()
def canal():
    serveur = HTTPServer(("127.0.0.1", 0), Facteur)
    serveur.recus = []
    serveur.code = 200
    fil = threading.Thread(target=serveur.serve_forever, daemon=True)
    fil.start()
    url = f"http://127.0.0.1:{serveur.server_address[1]}/notify"
    yield serveur, url
    serveur.shutdown()
    serveur.server_close()


@pytest.fixture()
def registre(tmp_path):
    connection = connect(tmp_path / "registre.db")
    migrations.upgrade(connection)
    yield connection
    audit.set_canal(None)
    connection.close()


# --- Ce qui notifie, et ce qui ne notifie pas (§47.2) -----------------------

@pytest.mark.parametrize("action", sorted(notification.ACTIONS))
def test_les_neuf_actions_sensibles_notifient(action):
    assert notification.notifiable(action, "ok", "human")


@pytest.mark.parametrize("action", [
    "spark.create", "snapshot.create", "ingress.declare", "port.publish",
    "image.add", "spark.settle", "spark.reconcile", "spark.protect",
    "spark.start", "spark.terminal_open", "audit.verify",
])
def test_les_gestes_de_construction_ne_notifient_pas(action):
    assert not notification.notifiable(action, "ok", "human")


def test_une_ligne_du_RUNTIME_ne_notifie_pas():
    """§36.4 : personne ne l'a demandée. Les notifier noierait les neuf actions
    sous des dizaines d'autres, et un canal qui crie tout le temps n'est plus lu
    — c'est la panne la plus probable de ce dispositif (§47.2)."""
    assert not notification.notifiable("spark.delete", "ok", "runtime")


def test_un_REFUS_ne_notifie_pas():
    # Rien n'a eu lieu. Le notifier apprendrait à ignorer le canal.
    for refuse in ("denied", "error"):
        assert not notification.notifiable("spark.delete", refuse, "human")


def test_la_liste_est_FERMEE_et_ne_se_deduit_d_aucun_motif():
    # Un motif « tout ce qui contient delete » laisserait passer
    # `spark.unprotect`, qui est le geste le PLUS grave de la liste.
    assert "spark.unprotect" in notification.ACTIONS
    assert not notification.notifiable("spark.deleted", "ok", "human")


# --- LE POINT DE L'UNITÉ : le geste aboutit quoi qu'il arrive (§47.5) -------

def test_un_canal_INJOIGNABLE_laisse_le_geste_aboutir(registre):
    """§37.4.5 : une panne de traçabilité ne devient pas une panne
    d'exploitation. C'est la règle qui décide de la forme du code."""
    c = notification.Canal(url="http://127.0.0.1:1/absent", forge="essai")
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.delete", "ok",
                 "Spark « crm » supprimé.", actor_class="human")
    # La ligne EXISTE : le geste a été journalisé malgré le canal muet.
    lignes = audit.listing(registre, limit=5)
    assert lignes[0]["action"] == "spark.delete"
    c.vider(10.0)
    etat = c.etat()
    assert etat["failed"] == 1
    assert etat["sent"] == 0
    assert etat["last_error"], "l'échec est DIT, jamais tu (§47.6)"


def test_un_canal_qui_REFUSE_est_compte_comme_un_echec(registre, canal):
    serveur, url = canal
    serveur.code = 500
    c = notification.Canal(url=url, forge="essai")
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.unprotect", "ok",
                 "Protection levée.", actor_class="human")
    c.vider(10.0)
    assert c.etat()["failed"] == 1
    assert c.etat()["sent"] == 0


def test_poster_ne_LEVE_jamais_meme_avec_un_envoi_qui_explose():
    def explose(url, charge):
        raise RuntimeError("boum")
    c = notification.Canal(url="http://x/", forge="e", envoi=explose)
    c.poster({"action": "spark.delete", "result": "ok", "actor_class": "human"})
    c.vider(5.0)
    assert c.etat()["failed"] == 1


# --- Ce qui part réellement sur le réseau (§47.4) ---------------------------

def test_le_message_arrive_au_canal_avec_ce_qu_il_doit_porter(registre, canal):
    serveur, url = canal
    c = notification.Canal(url=url, forge="spark-experiment")
    audit.set_canal(c)
    audit.record(registre, "console/prod key=SHA256:AbCd", "spark.delete", "ok",
                 "Spark « crm-production » supprimé.",
                 target_type="spark", target_id="S3", actor_class="human")
    assert c.vider(10.0)
    assert len(serveur.recus) == 1
    vu = serveur.recus[0]
    assert vu["version"] == notification.VERSION
    assert vu["action"] == "spark.delete"
    assert vu["actor"] == "console/prod key=SHA256:AbCd"
    assert vu["actor_class"] == "human"
    assert vu["target_type"] == "spark"
    assert vu["target_id"] == "S3"
    assert vu["result"] == "ok"
    assert "crm-production" in vu["message"]
    # §47.4 : le nom de la Forge, sans quoi « un Spark a été supprimé » est une
    # alerte inexploitable quand plusieurs Forges écrivent dans le même canal.
    assert vu["forge"] == "spark-experiment"
    assert vu["ts"]


def test_AUCUN_SECRET_ne_transite_par_le_canal(registre, canal):
    """§47.4 : le `payload` n'est PAS envoyé. C'est là que vivent les valeurs
    d'un geste, et un champ qu'on n'envoie pas ne fuit pas.

    On le mesure sur ce qui part RÉELLEMENT sur le réseau, corps entier, et non
    sur ce qu'on croit avoir donné à la fonction d'envoi."""
    serveur, url = canal
    c = notification.Canal(url=url, forge="essai")
    audit.set_canal(c)
    audit.record(
        registre, "console/prod", "sshkey.revoke", "ok",
        "Clé retirée.", target_type="sshkey", target_id="K1",
        payload={"private_key": "TRES-SECRET-A-NE-PAS-SORTIR",
                 "password": "mot-de-passe-en-clair",
                 "fingerprint": "SHA256:AbCd"},
        actor_class="human")
    assert c.vider(10.0)
    brut = json.dumps(serveur.recus[0], ensure_ascii=False)
    assert "TRES-SECRET-A-NE-PAS-SORTIR" not in brut
    assert "mot-de-passe-en-clair" not in brut
    # …et le payload n'y est pas DU TOUT, pas même caviardé.
    assert "payload" not in serveur.recus[0]


def test_le_message_CAVIARDE_reste_caviarde_dans_l_envoi(registre, canal):
    """Le message passe par le filtre du §21.2 AVANT d'être écrit au journal,
    donc avant d'arriver ici. On le MESURE plutôt que de le supposer.

    Ce qui est éprouvé est ce que le §21.2 garantit RÉELLEMENT sur une valeur :
    une clé privée en armure. Mesuré le 2026-08-21 : `SENSITIVE_VALUE` est un
    second filet étroit — un « password=… » composé à la main dans un message
    n'est PAS reconnu, et le commentaire du module le dit : « le nom du champ est
    le signal le plus fiable ».

    Cela ne fait pas fuir le canal, et il faut le dire précisément : le canal
    porte EXACTEMENT ce que le journal porte, ni plus ni moins. Un message que la
    Forge a jugé publiable pour son journal l'est aussi pour son canal ; le
    resserrer ici ferait diverger deux caviardages, et le §21.2 serait appliqué à
    deux endroits — ce que son propre commentaire proscrit.
    """
    serveur, url = canal
    c = notification.Canal(url=url, forge="essai")
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.delete", "ok",
                 "Clé trouvée : -----BEGIN OPENSSH PRIVATE KEY----- xyz",
                 actor_class="human")
    assert c.vider(10.0)
    envoye = json.dumps(serveur.recus[0], ensure_ascii=False)
    assert "PRIVATE KEY" not in envoye
    assert "caviardé" in serveur.recus[0]["message"]
    # …et c'est bien le message DU JOURNAL qui est parti, pas un autre.
    assert serveur.recus[0]["message"] == audit.listing(registre, limit=1)[0]["message"]


# --- L'accroche est sur le SEUL chemin (§47.1) ------------------------------

def test_un_geste_de_construction_ne_produit_AUCUN_envoi(registre, canal):
    serveur, url = canal
    c = notification.Canal(url=url, forge="essai")
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.create", "ok",
                 "Spark « neuf » enregistré.", actor_class="human")
    c.vider(2.0)
    assert serveur.recus == []


def test_sans_canal_configure_RIEN_ne_part_et_ce_n_est_pas_une_panne(registre):
    """§47.3, §14.5 : une Forge sans canal fonctionne exactement comme avant."""
    c = notification.Canal(url="", forge="essai")
    audit.set_canal(c)
    audit.record(registre, "console/prod", "spark.delete", "ok",
                 "Spark supprimé.", actor_class="human")
    assert audit.listing(registre, limit=1)[0]["action"] == "spark.delete"
    etat = c.etat()
    assert etat["configured"] is False
    assert (etat["sent"], etat["failed"], etat["dropped"]) == (0, 0, 0)


# --- La file est BORNÉE (§47.5) ---------------------------------------------

def test_une_file_pleine_jette_le_plus_ancien_et_le_COMPTE():
    """Une file sans borne transforme un canal muet en fuite de mémoire, et la
    Forge tomberait pour une raison étrangère à son travail."""
    bloque = threading.Event()

    def lent(url, charge):
        bloque.wait(5.0)

    c = notification.Canal(url="http://x/", forge="e", envoi=lent, file_max=2)
    for i in range(6):
        c.poster({"action": "spark.delete", "result": "ok",
                  "actor_class": "human", "target_id": str(i)})
    bloque.set()
    c.vider(10.0)
    assert c.etat()["dropped"] > 0, "ce qui est jeté est COMPTÉ"


# --- Ce que l'état rend (§47.6) ---------------------------------------------

def test_l_etat_distingue_non_configure_de_rien_a_signaler(canal):
    _, url = canal
    muet = notification.Canal(url="", forge="e")
    actif = notification.Canal(url=url, forge="e")
    assert muet.etat()["configured"] is False
    assert actif.etat()["configured"] is True
    # Les deux ont zéro envoi ; seul « configured » distingue « rien n'est
    # surveillé » de « rien à signaler » (§14.6).
    assert muet.etat()["sent"] == actif.etat()["sent"] == 0
