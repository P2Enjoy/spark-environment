"""@verifies docs/BACKLOG.md#SPK-184 · docs/DAT.md §75 (la santé d'un Spark), §75.3 (la sonde
HTTPS : l'adresse est fixe), §75.5 (le script), §75.6 (la machine à états), §75.7 (l'alerte :
une transition, pas un relevé) · docs/SCHEMA.md §8 quater

Ce que ces preuves gardent : une sonde ne vise que les domaines du Spark qui la porte ; la sortie
d'un script n'est jamais stockée ; l'alerte part UNE fois à la transition et pas à chaque relevé ;
une cellule arrêtée n'est pas malade ; un canal muet ne fait jamais échouer un relevé.

L'alerte est reçue par un VRAI serveur HTTP local (comme les preuves du canal, SPK-62) : c'est ce
qui part sur le réseau qu'on mesure, pas ce qu'on croit avoir donné.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from sparkd import audit, health, migrations, notification
from sparkd.db import connect
from sparkd.incus import FakeIncus
from sparkd.ingress_diagnostic import SondesFactices

GIO = 1024**3


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


T0 = utc(2026, 11, 18, 10, 0, 0)


# --- un récepteur HTTP réel -----------------------------------------------------------------

class Facteur(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        brut = self.rfile.read(int(self.headers.get("content-length", 0)))
        self.server.recus.append(json.loads(brut.decode("utf-8")))
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture()
def recepteur():
    serveur = HTTPServer(("127.0.0.1", 0), Facteur)
    serveur.recus = []
    fil = threading.Thread(target=serveur.serve_forever, daemon=True)
    fil.start()
    yield serveur, f"http://127.0.0.1:{serveur.server_address[1]}/notify"
    serveur.shutdown()
    serveur.server_close()


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "s.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "incus_name,created_at,updated_at,state) VALUES ('S1','crm','images:debian/13',"
        "'shared',0.5,?,10000000,?,'crm','x','x','running')", (GIO, GIO))
    connection.execute(
        "INSERT INTO ingress_route (id, spark_id, domain, target_port, tls)"
        " VALUES ('R1','S1','crm.example.com',8080,1)")
    connection.execute(
        "INSERT INTO ingress_route (id, spark_id, domain, target_port, tls)"
        " VALUES ('R2','S1','*.clients.example.com',8080,1)")
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "incus_name,created_at,updated_at,state) VALUES ('S2','autre','images:debian/13',"
        "'shared',0.5,?,10000000,?,'autre','x','x','running')", (GIO, GIO))
    connection.execute(
        "INSERT INTO ingress_route (id, spark_id, domain, target_port, tls)"
        " VALUES ('R3','S2','secret.example.com',8080,1)")
    connection.execute(
        "INSERT INTO ingress_route (id, spark_id, domain, target_port, tls)"
        " VALUES ('R4','S1','vieux.example.com',8080,0)")
    yield connection
    audit.set_canal(None)
    connection.close()


@pytest.fixture
def incus():
    faux = FakeIncus()
    faux.created["crm"] = {"name": "crm", "status": "Running"}
    faux.created["autre"] = {"name": "autre", "status": "Running"}
    return faux


@pytest.fixture
def sondes():
    return SondesFactices()


def spark(db, id_="S1"):
    return dict(db.execute("SELECT * FROM spark WHERE id=?", (id_,)).fetchone())


def definition(**extra):
    base = {"name": "api", "kind": "http", "target": "https://crm.example.com/healthz",
            "expected": 200, "schedule": "*/5 * * * *", "threshold": 3}
    return {**base, **extra}


# --- la machine à états : pure ---------------------------------------------------------------------

def suite(seuil, *oks, depart=("unknown", 0)):
    etat, echecs = depart
    rendu = []
    for ok in oks:
        etat, echecs = health.transition(etat, echecs, seuil, ok)
        rendu.append((etat, echecs))
    return rendu


def test_un_succes_est_sain_et_remet_le_compteur_a_zero():
    assert suite(3, True) == [("healthy", 0)]
    assert suite(3, False, False, True) == [("unstable", 1), ("unstable", 2), ("healthy", 0)]


def test_sous_le_seuil_c_est_instable_au_seuil_c_est_en_panne():
    assert suite(3, False, False, False) == [("unstable", 1), ("unstable", 2), ("down", 3)]
    assert suite(1, False) == [("down", 1)]


def test_une_panne_qui_dure_reste_en_panne_et_compte():
    assert suite(2, False, False, False, False)[-1] == ("down", 4)


def test_l_alerte_est_une_transition_pas_un_releve():
    alertes = []
    etat, echecs, deja = "unknown", 0, False
    for ok in (False, False, False, False, False, True, True):
        deja = health.etait_alerte(etat, echecs, 3)
        etat, echecs = health.transition(etat, echecs, 3, ok)
        alertes.append(health.evenement(deja, etat))
    assert alertes == [None, None, "down", None, None, "up", None]


def test_une_sonde_arretee_en_panne_garde_son_alerte_pour_le_retablissement():
    assert health.etait_alerte("stopped", 3, 3) is True       # arrêtée alors qu'elle était en panne
    assert health.etait_alerte("stopped", 2, 3) is False      # arrêtée alors qu'elle n'était qu'instable
    assert health.etait_alerte("unstable", 2, 3) is False


# --- la validation : ce qu'une sonde peut viser ------------------------------------------------------

def test_une_definition_valide_est_normalisee(db):
    sonde = health.valider(db, spark(db), definition(target="https://CRM.example.com/healthz?deep=1"))
    assert sonde["target"] == "https://crm.example.com/healthz?deep=1"
    assert sonde["schedule"] == "*/5 * * * *"


@pytest.mark.parametrize("cible, raison", [
    ("http://crm.example.com/", "https"),
    ("https://autre.example.net/", "pas une route de ce Spark"),
    ("https://secret.example.com/", "pas une route de ce Spark"),     # la route d'un AUTRE Spark
    ("https://127.0.0.1/", "pas une route de ce Spark"),
    ("https://localhost/", "pas une route de ce Spark"),
    ("https://127.0.0.1:2019/config/", "port"),
    ("https://crm.example.com:8443/", "port"),
    ("https://user:mdp@crm.example.com/", "identifiant"),
    ("https://crm.example.com/#frag", "fragment"),
    ("https://*.clients.example.com/", "joker"),
    ("https://crm.example.com/a b", "Chemin invalide"),
    ("https://crm.example.com/\"><x>", "Chemin invalide"),
    ("", "vide"), (None, "vide"), (42, "vide"),
    ("ftp://crm.example.com/", "https"),
    ("https:///chemin", "domaine"),
])
def test_la_cible_http_ne_peut_viser_que_les_routes_du_spark(db, cible, raison):
    with pytest.raises(health.SanteError, match=raison):
        health.valider(db, spark(db), definition(target=cible))


def test_une_route_servie_en_clair_ne_repond_pas_a_une_sonde_https(db):
    with pytest.raises(health.SanteError, match="servie en clair"):
        health.valider(db, spark(db), definition(target="https://vieux.example.com/"))


def test_un_joker_declare_n_est_pas_une_cible_meme_en_clair(db):
    # La route `*.clients.example.com` existe, mais un nom précis dessous pourrait être capté
    # par la route plus spécifique d'un autre Spark.
    with pytest.raises(health.SanteError):
        health.valider(db, spark(db), definition(target="https://app.clients.example.com/"))


@pytest.mark.parametrize("modif, raison", [
    ({"name": "Majuscule"}, "Nom invalide"), ({"name": "-x"}, "Nom invalide"), ({"name": ""}, "Nom invalide"),
    ({"kind": "tcp"}, "Type"),
    ({"threshold": 0}, "entre 1 et 20"), ({"threshold": 21}, "entre 1 et 20"),
    ({"threshold": "3"}, "entier"), ({"threshold": True}, "entier"), ({"threshold": None}, "entier"),
    ({"expected": 99}, "entre 100 et 599"), ({"expected": 600}, "entre 100 et 599"),
    ({"schedule": "*/4 * * * *"}, "5 minutes"), ({"schedule": "* * * * *"}, "5 minutes"),
    ({"schedule": "@hourly"}, "alias"), ({"schedule": "n'importe quoi"}, "Cadence"),
])
def test_refus_de_validation_avec_la_raison(db, modif, raison):
    with pytest.raises(health.SanteError, match=raison):
        health.valider(db, spark(db), definition(**modif))


def test_la_cadence_la_plus_serree_est_cinq_minutes(db):
    assert health.valider(db, spark(db), definition(schedule="*/5 * * * *"))
    assert health.valider(db, spark(db), definition(schedule="0,5,10 * * * *"))
    assert health.valider(db, spark(db), definition(schedule="0 * * * *"))


@pytest.mark.parametrize("commande, raison", [
    ("", "vide"), ("   ", "vide"), (None, "vide"),
    ("echo a\necho b", "une seule ligne"), ("x" * 2001, "2000 caractères"), ("a\x00b", "une seule ligne"),
])
def test_refus_d_une_commande(db, commande, raison):
    with pytest.raises(health.SanteError, match=raison):
        health.valider(db, spark(db), definition(kind="script", target=commande, expected=0))


def test_un_script_attend_un_code_de_sortie(db):
    assert health.valider(db, spark(db), definition(kind="script", target="pg_isready", expected=0))
    with pytest.raises(health.SanteError, match="entre 0 et 255"):
        health.valider(db, spark(db), definition(kind="script", target="x", expected=256))


def test_vingt_sondes_au_plus_par_spark(db):
    for i in range(health.MAX_SONDES):
        health.poser(db, spark(db), definition(name=f"s{i}"), T0)
    with pytest.raises(health.SanteError, match="au plus 20"):
        health.poser(db, spark(db), definition(name="de-trop"), T0)
    # Modifier une sonde existante reste possible.
    health.poser(db, spark(db), definition(name="s0", threshold=5), T0)


# --- poser, modifier, suspendre, retirer --------------------------------------------------------------

def test_poser_cree_une_sonde_inconnue_dont_le_premier_releve_part_au_pas_suivant(db):
    vue = health.poser(db, spark(db), definition(), T0)
    assert vue["state"] == "unknown" and vue["enabled"] is True
    assert vue["next_run_at"] == "2026-11-18T10:00:00+00:00"
    assert vue["description"] == "Toutes les 5 minutes (UTC)"
    assert vue["results"] == []


def test_poser_est_idempotent(db):
    a = health.poser(db, spark(db), definition(), T0)
    b = health.poser(db, spark(db), definition(), T0 + timedelta(hours=1))
    assert a == b
    assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action='health.set'").fetchone()[0] == 1


def test_changer_ce_qui_est_mesure_remet_l_etat_a_zero_pas_la_cadence(db, incus, sondes):
    health.poser(db, spark(db), definition(threshold=1), T0)
    sondes.poser("crm.example.com", sante={"status": 503})
    health.executer_une(db, incus, sondes, health._sonde(db, "S1", "api")["id"], T0)
    assert health._sonde(db, "S1", "api")["state"] == "down"
    # La seule cadence change : l'état demeure.
    health.poser(db, spark(db), definition(threshold=1, schedule="*/10 * * * *"), T0)
    assert health._sonde(db, "S1", "api")["state"] == "down"
    # Le statut attendu change : l'ancien état ne dit plus rien de la nouvelle sonde.
    health.poser(db, spark(db), definition(threshold=1, schedule="*/10 * * * *", expected=503), T0)
    ligne = health._sonde(db, "S1", "api")
    assert ligne["state"] == "unknown" and ligne["consecutive_failures"] == 0


def test_suspendre_ne_releve_rien_et_garde_le_dernier_etat(db, incus, sondes):
    health.poser(db, spark(db), definition(), T0)
    sonde_id = health._sonde(db, "S1", "api")["id"]
    health.executer_une(db, incus, sondes, sonde_id, T0)
    health.basculer(db, spark(db), "api", enabled=False, now=T0)
    assert health.echues(db, T0 + timedelta(days=9)) == []
    assert health._sonde(db, "S1", "api")["state"] == "healthy"
    health.basculer(db, spark(db), "api", enabled=True, now=T0 + timedelta(days=9))
    assert health.echues(db, T0 + timedelta(days=9)) == [sonde_id]


def test_retirer_emporte_l_historique(db, incus, sondes):
    health.poser(db, spark(db), definition(), T0)
    health.executer_une(db, incus, sondes, health._sonde(db, "S1", "api")["id"], T0)
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == 1
    assert health.retirer(db, spark(db), "api")["checks"] == []
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == 0


def test_gestes_sur_une_sonde_absente(db):
    for geste in (lambda: health.basculer(db, spark(db), "x", enabled=False),
                  lambda: health.retirer(db, spark(db), "x")):
        with pytest.raises(health.SanteError, match="n'a pas de sonde"):
            geste()


# --- les exécuteurs ---------------------------------------------------------------------------------------

def test_http_le_statut_attendu_est_sain_un_autre_est_un_echec_qui_le_dit(sondes):
    assert health.releve_http(sondes, "crm.example.com", "/", 200)["ok"] is True
    sondes.poser("crm.example.com", sante={"status": 503, "latency_ms": 40})
    r = health.releve_http(sondes, "crm.example.com", "/", 200)
    assert r == {"ok": False, "latency_ms": 40, "detail": "HTTP 503 (attendu 200)"}
    sondes.poser("crm.example.com", sante={"status": None, "error": "certificat invalide : expiré"})
    assert "certificat invalide" in health.releve_http(sondes, "crm.example.com", "/", 200)["detail"]


@pytest.mark.parametrize("commande, attendu, ok, detail", [
    ("true", 0, True, None),
    ("false", 0, False, "code de sortie 1 (attendu 0)"),
    ("exit 3", 3, True, None),
    ("exit 2", 0, False, "code de sortie 2 (attendu 0)"),
])
def test_script_seul_le_code_de_sortie_compte(db, incus, commande, attendu, ok, detail):
    r = health.releve_script(incus, spark(db), commande, attendu)
    assert (r["ok"], r["detail"]) == (ok, detail)


def test_script_les_codes_de_timeout_et_de_commande_introuvable_se_disent(db):
    class Stub:
        def __init__(self, code):
            self.code = code

        def exec_capture(self, nom, commande):
            return (self.code, "", "")
    assert "délai dépassé" in health.releve_script(Stub(124), spark(db), "x", 0)["detail"]
    assert "délai dépassé" in health.releve_script(Stub(137), spark(db), "x", 0)["detail"]
    assert "non exécutable" in health.releve_script(Stub(127), spark(db), "x", 0)["detail"]


def test_script_la_sortie_n_est_jamais_stockee_ni_envoyee(db, recepteur):
    """DAT §75.5 : une sortie de script peut contenir un secret."""
    serveur, url = recepteur
    secret = "MOT-DE-PASSE-SUPER-SECRET-123"

    class Bavard:
        def exec_capture(self, nom, commande):
            return (1, f"password={secret}", f"erreur: {secret}")

    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    health.poser(db, spark(db), definition(kind="script", target="./verifier.sh", expected=0,
                                           threshold=1), T0)
    health.executer_une(db, Bavard(), SondesFactices(), health._sonde(db, "S1", "api")["id"], T0)
    canal.vider()
    # Rien dans le registre…
    for table in ("health_check", "health_result", "audit_log"):
        for ligne in db.execute(f"SELECT * FROM {table}"):
            assert secret not in json.dumps(dict(ligne), default=str), table
    # … ni sur le réseau.
    assert serveur.recus and secret not in json.dumps(serveur.recus)


def test_script_une_cellule_injoignable_est_un_echec_pas_une_exception(db):
    class Casse:
        def exec_capture(self, nom, commande):
            raise RuntimeError("socket Incus indisponible")
    r = health.releve_script(Casse(), spark(db), "true", 0)
    assert r["ok"] is False and "cellule injoignable" in r["detail"]


def test_le_script_s_execute_sous_le_compte_de_la_pile(db):
    enracine = health.commande_script({"docker_mode": "enracine"}, "pg_isready")
    assert enracine == ["timeout", "-k", "5", "60", "sh", "-c", "pg_isready"]
    rootless = health.commande_script({"docker_mode": "rootless"}, "docker ps; echo $HOME")
    assert rootless[:4] == ["timeout", "-k", "5", "60"]
    assert "runuser -u spark-docker" in rootless[6] and "docker.sock" in rootless[6]
    # Le texte de l'agent est un ARGUMENT du `sh -c` du produit : jamais interpolé dedans.
    assert rootless[-1] == "docker ps; echo $HOME" and "docker ps" not in rootless[6]


def test_un_Spark_rootless_du_REGISTRE_joue_son_script_sous_le_compte_rootless(db):
    """Défaut vu sur spark-010 (2026-11-18), invisible aux doublons.

    `docker_mode` n'est PAS une colonne de la ligne `spark` : il vit dans l'observation d'amorçage
    (`spark_bootstrap_observation`). `commande_script` lisait `spark.get("docker_mode")`, donc rien :
    un Spark rootless était traité comme enraciné, et `docker ps` y sortait en code 1 (aucun démon
    root). Les tests passaient un dictionnaire où l'on avait écrit la clé à la main.
    """
    s = spark(db)
    assert "docker_mode" not in s, "le préalable : la ligne du Spark ne porte pas le mode"
    db.execute(
        "INSERT INTO spark_bootstrap_observation (spark_id, observed_at, docker_mode, managed_items)"
        " VALUES (?, ?, 'rootless', '[]')", (s["id"], "2026-11-18T10:00:00+00:00"))
    vus = []

    class Espion:
        def exec_capture(self, nom, commande):
            vus.append(commande)
            return 0, "", ""

    sonde = {"kind": "script", "target": "docker ps", "expected": 0}
    resultat = health._executer(db, Espion(), None, s, sonde)
    assert resultat["ok"] is True
    assert "runuser -u spark-docker" in vus[0][6], "le script doit passer par le compte rootless"
    assert vus[0][-1] == "docker ps"


def test_un_Spark_enracine_ou_non_releve_garde_le_script_nu(db):
    vus = []

    class Espion:
        def exec_capture(self, nom, commande):
            vus.append(commande)
            return 0, "", ""

    sonde = {"kind": "script", "target": "pg_isready", "expected": 0}
    health._executer(db, Espion(), None, spark(db), sonde)  # jamais amorcé : aucun relevé
    db.execute("INSERT INTO spark_bootstrap_observation (spark_id, observed_at, docker_mode, managed_items)"
               " VALUES ('S1', '2026-11-18T10:00:00+00:00', 'enracine', '[]')")
    health._executer(db, Espion(), None, spark(db), sonde)
    assert vus == [["timeout", "-k", "5", "60", "sh", "-c", "pg_isready"]] * 2


# --- appliquer : l'alerte part à la transition, une fois -----------------------------------------------------

def deroule(db, incus, sondes, statuts, seuil=3, debut=T0):
    health.poser(db, spark(db), definition(threshold=seuil), debut)
    sonde_id = health._sonde(db, "S1", "api")["id"]
    evenements = []
    for rang, statut in enumerate(statuts):
        sondes.poser("crm.example.com", sante={"status": statut})
        rendu = health.executer_une(db, incus, sondes, sonde_id, debut + timedelta(minutes=5 * rang))
        evenements.append(rendu["evenement"])
    return evenements


def test_une_seule_alerte_pour_toute_une_panne_puis_une_de_retablissement(db, incus, sondes, recepteur):
    serveur, url = recepteur
    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    with audit.acting_as("sante", audit.RUNTIME):
        evenements = deroule(db, incus, sondes, [503, 503, 503, 503, 503, 200, 200])
    canal.vider()
    assert evenements == [None, None, "down", None, None, "up", None]
    # Sur le réseau : DEUX messages, pas sept.
    assert [m["action"] for m in serveur.recus] == ["health.down", "health.up"]
    assert all(m["actor_class"] == "runtime" for m in serveur.recus)
    assert "EN PANNE" in serveur.recus[0]["message"] and "api" in serveur.recus[0]["message"]
    assert "HTTP 503" in serveur.recus[0]["message"]
    assert "rétablie" in serveur.recus[1]["message"]


def test_instable_ne_previent_personne(db, incus, sondes, recepteur):
    serveur, url = recepteur
    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    with audit.acting_as("sante", audit.RUNTIME):
        deroule(db, incus, sondes, [503, 503, 200, 503, 503, 200])
    canal.vider()
    assert serveur.recus == []
    assert health._sonde(db, "S1", "api")["state"] == "healthy"


def test_le_premier_releve_d_une_sonde_neuve_n_alerte_pas_sous_le_seuil(db, incus, sondes):
    assert deroule(db, incus, sondes, [503], seuil=3) == [None]
    assert health._sonde(db, "S1", "api")["state"] == "unstable"


def test_un_seuil_de_un_alerte_des_le_premier_echec(db, incus, sondes):
    assert deroule(db, incus, sondes, [503, 503, 200], seuil=1) == ["down", None, "up"]


def test_le_message_ne_porte_ni_corps_ni_adresse_interne(db, incus, sondes, recepteur):
    serveur, url = recepteur
    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    with audit.acting_as("sante", audit.RUNTIME):
        deroule(db, incus, sondes, [503, 503, 503])
    canal.vider()
    texte = json.dumps(serveur.recus)
    for interdit in ("127.0.0.1", "10.77.", "payload"):
        assert interdit not in texte


def test_un_canal_muet_ne_fait_pas_echouer_le_releve(db, incus, sondes):
    canal = notification.Canal("http://127.0.0.1:1/notify", "forge-test")   # personne n'écoute
    audit.set_canal(canal)
    with audit.acting_as("sante", audit.RUNTIME):
        assert deroule(db, incus, sondes, [503, 503, 503]) == [None, None, "down"]
    canal.vider(2.0)
    assert health._sonde(db, "S1", "api")["state"] == "down"          # l'état est écrit malgré tout
    assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action='health.down'").fetchone()[0] == 1


def test_sans_canal_l_etat_et_le_journal_portent_la_panne(db, incus, sondes):
    with audit.acting_as("sante", audit.RUNTIME):
        deroule(db, incus, sondes, [503, 503, 503])
    ligne = db.execute("SELECT actor, actor_class, result, message FROM audit_log"
                       " WHERE action='health.down'").fetchone()
    assert (ligne["actor"], ligne["actor_class"], ligne["result"]) == ("sante", "runtime", "ok")


# --- un Spark arrêté n'est pas malade -----------------------------------------------------------------------

def test_un_spark_arrete_est_arrete_et_rien_n_est_alerte(db, incus, sondes, recepteur):
    serveur, url = recepteur
    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    health.poser(db, spark(db), definition(), T0)
    sonde_id = health._sonde(db, "S1", "api")["id"]
    db.execute("UPDATE spark SET state='stopped' WHERE id='S1'")
    with audit.acting_as("sante", audit.RUNTIME):
        rendu = health.executer_une(db, incus, sondes, sonde_id, T0)
    canal.vider()
    assert rendu["resultat"] == "stopped"
    assert health._sonde(db, "S1", "api")["state"] == "stopped"
    assert serveur.recus == []
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == 0   # rien n'a été sondé


def test_arret_en_panne_puis_retablissement_leve_l_alerte_une_fois(db, incus, sondes, recepteur):
    serveur, url = recepteur
    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    with audit.acting_as("sante", audit.RUNTIME):
        deroule(db, incus, sondes, [503, 503, 503])                      # en panne : alerte
        sonde_id = health._sonde(db, "S1", "api")["id"]
        db.execute("UPDATE spark SET state='stopped' WHERE id='S1'")
        health.executer_une(db, incus, sondes, sonde_id, T0 + timedelta(hours=1))
        db.execute("UPDATE spark SET state='running' WHERE id='S1'")
        sondes.poser("crm.example.com", sante={"status": 200})
        rendu = health.executer_une(db, incus, sondes, sonde_id, T0 + timedelta(hours=2))
    canal.vider()
    assert rendu["evenement"] == "up"
    assert [m["action"] for m in serveur.recus] == ["health.down", "health.up"]


def test_arret_instable_le_compteur_repart_de_zero(db, incus, sondes):
    deroule(db, incus, sondes, [503, 503])                                 # instable à 2 / 3
    sonde_id = health._sonde(db, "S1", "api")["id"]
    db.execute("UPDATE spark SET state='stopped' WHERE id='S1'")
    health.executer_une(db, incus, sondes, sonde_id, T0 + timedelta(hours=1))
    db.execute("UPDATE spark SET state='running' WHERE id='S1'")
    sondes.poser("crm.example.com", sante={"status": 503})
    health.executer_une(db, incus, sondes, sonde_id, T0 + timedelta(hours=2))
    ligne = health._sonde(db, "S1", "api")
    assert (ligne["state"], ligne["consecutive_failures"]) == ("unstable", 1)   # pas 3 : pas en panne


def test_une_route_retiree_depuis_est_un_echec_qui_le_dit(db, incus, sondes):
    health.poser(db, spark(db), definition(threshold=1), T0)
    db.execute("DELETE FROM ingress_route WHERE id='R1'")
    rendu = health.executer_une(db, incus, sondes, health._sonde(db, "S1", "api")["id"], T0)
    assert rendu["resultat"] == "echec" and "n'est plus une route" in rendu["detail"]


# --- l'historique est borné ---------------------------------------------------------------------------------------

def test_l_historique_est_borne_a_cent_releves(db, incus, sondes):
    health.poser(db, spark(db), definition(), T0)
    sonde_id = health._sonde(db, "S1", "api")["id"]
    for i in range(health.MAX_RELEVES + 25):
        health.executer_une(db, incus, sondes, sonde_id, T0 + timedelta(minutes=5 * i))
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == health.MAX_RELEVES
    vue = health.lister(db, spark(db))["checks"][0]
    assert len(vue["results"]) == health.RELEVES_LUS
    horodatages = [r["run_at"] for r in vue["results"]]
    assert horodatages == sorted(horodatages)                           # du plus ancien au plus récent


# --- tester : rien n'est écrit -------------------------------------------------------------------------------------

def test_tester_n_ecrit_rien_ni_etat_ni_alerte(db, incus, sondes, recepteur):
    serveur, url = recepteur
    canal = notification.Canal(url, "forge-test")
    audit.set_canal(canal)
    sondes.poser("crm.example.com", sante={"status": 503})
    avant = db.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    rendu = health.tester(db, incus, sondes, spark(db), definition(threshold=1))
    canal.vider()
    assert rendu["ok"] is False and rendu["detail"] == "HTTP 503 (attendu 200)"
    assert db.execute("SELECT COUNT(*) FROM health_check").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == avant
    assert serveur.recus == []


def test_tester_un_script_exige_une_cellule_en_marche(db, incus, sondes):
    db.execute("UPDATE spark SET state='stopped' WHERE id='S1'")
    with pytest.raises(health.SanteError, match="pas en marche"):
        health.tester(db, incus, sondes, spark(db),
                      definition(kind="script", target="true", expected=0))


def test_tester_refuse_ce_que_poser_refuserait(db, incus, sondes):
    with pytest.raises(health.SanteError, match="pas une route"):
        health.tester(db, incus, sondes, spark(db), definition(target="https://secret.example.com/"))


# --- le fil ----------------------------------------------------------------------------------------------------------------

def test_le_fil_execute_les_sondes_echues_par_un_pool_borne(db, incus, sondes, tmp_path):
    for i in range(6):
        health.poser(db, spark(db), definition(name=f"s{i}"), T0)
    db.commit()
    fil = health.Sante(ouvrir=lambda: connect(tmp_path / "s.db"), incus=incus, sondes=sondes)
    rendus = fil.un_pas(T0)
    assert len(rendus) == 6 and all(r["resultat"] == "ok" for r in rendus)
    assert db.execute("SELECT COUNT(*) FROM health_result").fetchone()[0] == 6
    assert fil.un_pas(T0 + timedelta(minutes=1)) == []                  # rien n'est échu avant 5 minutes
    assert len(fil.un_pas(T0 + timedelta(minutes=5))) == 6


def test_les_lignes_du_fil_portent_l_acteur_sante_de_classe_runtime(db, incus, sondes, tmp_path):
    health.poser(db, spark(db), definition(threshold=1), T0)
    db.commit()
    sondes.poser("crm.example.com", sante={"status": 500})
    health.Sante(ouvrir=lambda: connect(tmp_path / "s.db"), incus=incus, sondes=sondes).un_pas(T0)
    ligne = db.execute("SELECT actor, actor_class FROM audit_log WHERE action='health.down'").fetchone()
    assert (ligne["actor"], ligne["actor_class"]) == ("sante", audit.RUNTIME)


def test_le_fil_survit_a_une_panne_du_registre(incus, sondes):
    def casse():
        raise RuntimeError("registre indisponible")
    fil = health.Sante(ouvrir=casse, incus=incus, sondes=sondes)
    assert fil.un_pas(T0) is None and fil.erreurs == 1
