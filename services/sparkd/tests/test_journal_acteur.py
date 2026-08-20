"""@verifies docs/BACKLOG.md#SPK-37 · docs/DAT.md §21.6 (qui a agi), §21.6.1
             (deux classes), §21.6.2 (l'identite est declarative), §21.6.4 (le
             journal ne se recrit pas par megarde), §36.4, §36.7 ·
             docs/SCHEMA.md §9.1

La DoD nomme quatre preuves : le verrou d'ecriture EN BASE et non par convention
de code, la completude de la couverture des ecritures, la distinction entre un
geste humain et un evenement du runtime prouvee de bout en bout, et le reexamen
d'INC-02.
"""

from __future__ import annotations

import ast
import json
import pathlib

import pytest
from fastapi.testclient import TestClient

from sparkd import audit, migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

GIO = 1024**3
SOURCES = pathlib.Path(__file__).resolve().parents[1] / "src" / "sparkd"


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "j.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


@pytest.fixture
def client(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "a.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    return c


def entrees(client, limite=500):
    return client.get(f"/v1/audit?limit={limite}").json()["entries"]


# --- LE VERROU, EN BASE (§21.6.4) -------------------------------------------

def test_un_UPDATE_direct_sur_audit_log_echoue(db):
    """Execute DIRECTEMENT en base, pas par l'application : une table qu'on
    s'interdit d'ecraser par discipline est une table qu'on ecrasera."""
    audit.record(db, "moi", "essai", "ok", "message d'origine")
    with pytest.raises(Exception) as refus:
        db.execute("UPDATE audit_log SET message = 'récrit'")
    assert "ecriture seule" in str(refus.value)
    assert db.execute("SELECT message FROM audit_log").fetchone()[0] == "message d'origine"


def test_un_DELETE_direct_sur_audit_log_echoue(db):
    audit.record(db, "moi", "essai", "ok", "trace")
    with pytest.raises(Exception) as refus:
        db.execute("DELETE FROM audit_log")
    assert "ecriture seule" in str(refus.value)
    assert db.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 1


def test_l_INSERT_reste_libre(db):
    """Le verrou porte sur la RECRITURE. Un journal qu'on ne peut plus alimenter
    ne serait pas un journal."""
    for n in range(3):
        audit.record(db, "moi", "essai", "ok", f"ligne {n}")
    assert db.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 3


def test_une_classe_inconnue_est_refusee_par_la_base(db):
    with pytest.raises(Exception):
        db.execute(
            "INSERT INTO audit_log (ts, actor, actor_class, action, result, message)"
            " VALUES ('t', 'a', 'administrateur', 'x', 'ok', 'm')")


# --- L'ACTEUR ET SA CLASSE (§21.6.1, §21.6.2) -------------------------------

def test_sans_declaration_l_acteur_est_INCONNU_et_jamais_responsable(db):
    """Affirmer une identite que rien n'etablit est un mensonge ; l'ignorance
    n'en est pas un (§21.6.2)."""
    audit.record(db, None, "essai", "ok", "m")
    ligne = db.execute("SELECT actor, actor_class FROM audit_log").fetchone()
    assert ligne["actor"] == "sparkd"
    assert ligne["actor_class"] == audit.RUNTIME


def test_le_contexte_de_requete_porte_l_acteur_a_TOUTE_ecriture(db):
    with audit.acting_as("console/prod key=SHA256:Ab", audit.HUMAN):
        audit.record(db, None, "geste", "ok", "m")
    ligne = db.execute("SELECT actor, actor_class FROM audit_log").fetchone()
    assert ligne["actor"] == "console/prod key=SHA256:Ab"
    assert ligne["actor_class"] == audit.HUMAN


def test_une_declaration_EXPLICITE_de_runtime_l_emporte_sur_le_contexte(db):
    """§36.4 : un recalcul global declenche par une requete humaine reste un
    evenement du runtime. Le contraire ferait croire qu'une personne l'a
    reclame."""
    with audit.acting_as("console/prod", audit.HUMAN):
        with audit.as_runtime():
            audit.record(db, None, "ingress.reconcile", "ok", "m")
    ligne = db.execute("SELECT actor, actor_class FROM audit_log").fetchone()
    assert ligne["actor_class"] == audit.RUNTIME
    assert ligne["actor"] == "sparkd"


def test_l_identite_declaree_est_bornee_et_sans_saut_de_ligne(db):
    """Elle arrive d'un en-tete HTTP, donc de l'exterieur. Un journal dont une
    ligne peut en fabriquer d'autres n'est plus lisible."""
    with audit.acting_as("a\nfaux\ractor " + "x" * 500, audit.HUMAN):
        audit.record(db, None, "essai", "ok", "m")
    valeur = db.execute("SELECT actor FROM audit_log").fetchone()["actor"]
    assert "\n" not in valeur and "\r" not in valeur
    assert len(valeur) <= audit.MAX_ACTOR


def test_le_non_ASCII_est_ecarte_a_l_entree(db):
    """Un en-tete HTTP ne transporte pas d'accent — mesure : une valeur
    accentuee fait echouer la requete a l'encodage, AVANT d'atteindre le
    service. Ce qui arriverait par un autre transport est ecarte ici."""
    with audit.acting_as("console/prod cle\u00e9 SHA256:Ab", audit.HUMAN):
        audit.record(db, None, "essai", "ok", "m")
    valeur = db.execute("SELECT actor FROM audit_log").fetchone()["actor"]
    assert valeur.isascii()
    assert "SHA256:Ab" in valeur, "l'empreinte survit au nettoyage"


def test_une_identite_vide_vaut_inconnu(db):
    for vide in ("", "   ", None):
        with audit.acting_as(vide, audit.HUMAN):
            audit.record(db, None, "essai", "ok", "m")
    valeurs = {r["actor"] for r in db.execute("SELECT actor FROM audit_log")}
    assert valeurs == {audit.UNKNOWN_ACTOR}


# --- DE BOUT EN BOUT, PAR L'API (§21.6.2) -----------------------------------

def _creer(client, nom="crm", **entetes):
    return client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }, headers=entetes)


def test_un_geste_de_la_console_porte_SON_identite_jusqu_au_journal(client):
    reponse = client.post("/v1/sparks", json={
        "name": "avec-identite", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }, headers={"x-spark-actor": "console/prod key=SHA256:AbCd"})
    assert reponse.status_code == 201, reponse.text

    creation = next(e for e in entrees(client)
                    if e["action"] == "spark.create" and "avec-identite" in str(e))
    assert creation["actor"] == "console/prod key=SHA256:AbCd"
    assert creation["actor_class"] == "human"


def test_un_geste_HUMAIN_et_un_evenement_du_RUNTIME_sont_distincts(client):
    """Le coeur de la DoD, prouve de bout en bout : la meme requete produit les
    deux classes, et elles ne se confondent pas."""
    client.post("/v1/sparks", json={
        "name": "distinct", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }, headers={"x-spark-actor": "console/prod"})
    client.post("/v1/sparks/distinct/apply", headers={"x-spark-actor": "console/prod"})

    par_classe = {}
    for e in entrees(client):
        par_classe.setdefault(e["actor_class"], set()).add(e["action"])

    assert "human" in par_classe and "runtime" in par_classe
    assert "spark.create" in par_classe["human"]
    # `spark.settle` conclut l'operation : c'est la MACHINE qui l'ecrit, meme si
    # une personne a demande l'application.
    assert "spark.settle" in par_classe["runtime"]
    assert "spark.settle" not in par_classe.get("human", set())


def test_une_LECTURE_n_ouvre_pas_de_contexte_humain(client):
    """§36.7 : les lectures ne sont pas journalisees. Le middleware ne doit donc
    pas les classer — et surtout pas classer `human` un recalcul qu'une lecture
    declencherait."""
    avant = len(entrees(client))
    for chemin in ("/v1/sparks", "/v1/forge", "/v1/audit", "/v1/images"):
        assert client.get(chemin, headers={"x-spark-actor": "console/prod"}).status_code == 200
    assert len(entrees(client)) == avant


def test_sans_en_tete_l_acteur_d_un_geste_est_INCONNU(client):
    """Un appel direct a l'API, sans passer par la console, ne peut pas se faire
    passer pour le responsable."""
    reponse = _creer(client, "sans-identite")
    assert reponse.status_code == 201, reponse.text
    creation = next(e for e in entrees(client)
                    if e["action"] == "spark.create" and "sans-identite" in str(e))
    assert creation["actor"] == audit.UNKNOWN_ACTOR
    assert creation["actor_class"] == "human", (
        "l'appel EST un geste : c'est l'identite qui manque, pas la classe")


# --- COMPLETUDE DE LA COUVERTURE (§36.7) ------------------------------------

def test_aucun_module_n_ecrit_dans_audit_log_hors_du_point_unique():
    """§21.1 rendu verifiable par le CODE et non par la relecture : un INSERT
    ecrit ailleurs echapperait au filtre de secrets ET a la classe."""
    fautifs = []
    for source in SOURCES.glob("*.py"):
        if source.name == "audit.py":
            continue
        texte = source.read_text(encoding="utf-8")
        if "audit_log" in texte and "INSERT INTO audit_log" in texte:
            fautifs.append(source.name)
    assert fautifs == [], f"écriture directe dans audit_log : {fautifs}"


def test_toute_ecriture_de_l_API_laisse_une_trace(client):
    """Recense les ECRITURES et prouve qu'aucune n'echappe au journal. Un
    journal qui ne contient que les gestes humains laisse croire que le reste
    n'est pas arrive (§36.7)."""
    client.post("/v1/sparks", json={
        "name": "trace", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }, headers={"x-spark-actor": "console/prod"})
    client.post("/v1/sparks/trace/apply", headers={"x-spark-actor": "console/prod"})
    client.post("/v1/ssh-keys", json={
        "label": "poste",
        "public_key": ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3f"
                       "SF4BkFEV5LL5Sl2XoT poste")})
    client.post("/v1/sparks/trace/ssh-keys/poste")
    client.post("/v1/sparks/trace/snapshots", json={"name": "avant"})
    client.post("/v1/sparks/trace/protection", json={"password": "x"})

    actions = {e["action"] for e in entrees(client)}
    for attendue in ("spark.create", "spark.settle", "sshkey.register",
                     "sshkey.grant", "snapshot.create", "spark.protect"):
        assert attendue in actions, f"« {attendue} » n'a laissé aucune trace"


def test_chaque_entree_porte_une_classe_connue(client):
    """Aucune ligne ne doit sortir du domaine : la base le refuserait, et ce
    test le prouve sur le trafic REEL plutot que sur un INSERT fabrique."""
    client.post("/v1/sparks", json={
        "name": "classee", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    })
    classes = {e["actor_class"] for e in entrees(client)}
    assert classes and classes <= {"human", "runtime"}


# --- INC-02, REEXAMINE (DoD de SPK-37) --------------------------------------

def test_INC_02_un_refus_de_creation_porte_desormais_un_ACTEUR(client):
    """Le registre d'incoherences demande si un refus doit porter le NOM demande.
    Cet arbitrage appartient au responsable et n'est PAS tranche ici.

    Ce que l'unite change en revanche, et qui se mesure : un refus portait
    « responsable » et un target_id d'entite inexistante. Il porte maintenant
    l'identite declaree, ce qui rend deux refus consecutifs distinguables par
    QUI les a demandes — meme si le nom demande reste absent du message.
    """
    refus = client.post("/v1/sparks", json={
        "name": "trop-gros", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": 512 * GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }, headers={"x-spark-actor": "console/prod key=SHA256:AbCd"})
    assert refus.status_code == 409

    denie = next(e for e in entrees(client) if e["result"] == "denied")
    assert denie["actor"] == "console/prod key=SHA256:AbCd"
    assert denie["actor_class"] == "human"
    # L'ecart d'INC-02 SUBSISTE, et le test le dit plutot que de le masquer :
    # le nom demande n'est toujours pas dans le message.
    assert "trop-gros" not in denie["message"]
