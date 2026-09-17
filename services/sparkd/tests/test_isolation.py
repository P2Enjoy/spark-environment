"""@verifies docs/BACKLOG.md#SPK-109 · docs/DAT.md §57.2 (l'`eth0` de tout
           Spark porte les deux clés), §57.3 (« Isoler le parc » : une entrée
           d'audit par Spark, le protégé refuse et reste visiblement non
           isolé, l'état se lit dans Incus), §57.7 · §35.2 ·
           docs/PROD_MIGRATIONS.md#OP-22

Le pilote est le doublon : il retient les devices là où le vrai Incus les
garde, et c'est ce qui permet de simuler une cellule d'AVANT l'isolation — on
lui retire ce qu'une build antérieure n'aurait jamais posé — puis de prouver
que le geste les repose par la même route qu'en production.
"""

from __future__ import annotations

import tempfile

from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load
from sparkd.translate import CLES_ISOLATION

GIO = 1024**3


def client() -> TestClient:
    base = tempfile.mkdtemp() + "/spark.db"
    return TestClient(create_app(load({"SPARKD_DB": base, "SPARKD_DRIVER": "fake"})))


def creer(c: TestClient, nom: str, *, appliquer: bool = True) -> None:
    assert c.post("/v1/forge/sync").status_code == 200
    reponse = c.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO, "storage_bytes": 10 * GIO,
        "network_bps": 100_000_000})
    assert reponse.status_code == 201, reponse.text
    if appliquer:
        assert c.post(f"/v1/sparks/{nom}/apply").status_code == 200
        assert c.post(f"/v1/sparks/{nom}/start").status_code == 200


def desisoler(c: TestClient, nom: str) -> None:
    """Une cellule d'AVANT SPK-109 : les clés que sa build n'a jamais posées."""
    incus = c.app.state.incus
    for cle in CLES_ISOLATION:
        incus.created[nom]["devices"]["eth0"].pop(cle, None)
    # Le doublon de l'application est PERSISTANT (§28.4) et se relit à chaque
    # opération : ce qu'on retire en mémoire doit être écrit, comme le seed.
    incus._persist()


def test_un_spark_cree_par_le_produit_nait_isole():
    """§57.2 : l'isolation est la règle du produit, rendue pour TOUT Spark."""
    c = client()
    creer(c, "neuf")
    eth0 = c.app.state.incus.created["neuf"]["devices"]["eth0"]
    assert eth0["security.port_isolation"] == "true"
    assert eth0["security.ipv4_filtering"] == "true"
    etat = c.get("/v1/forge/isolation").json()
    assert etat["readable"] is True
    assert etat["isolated"] == 1 and etat["pending"] == 0
    assert c.get("/v1/sparks/neuf/isolation").json() == {
        "name": "neuf", "isolated": True, "missing": []}


def test_une_cellule_d_avant_est_dite_NON_ENCORE_isolee_et_nommee():
    """§57.3 : une Forge à moitié migrée se lit comme telle."""
    c = client()
    creer(c, "ancienne")
    desisoler(c, "ancienne")
    etat = c.get("/v1/forge/isolation").json()
    assert etat["pending"] == 1 and etat["isolated"] == 0
    ligne = etat["sparks"][0]
    assert ligne["name"] == "ancienne" and ligne["isolated"] is False
    assert set(ligne["missing"]) == set(CLES_ISOLATION)
    seul = c.get("/v1/sparks/ancienne/isolation").json()
    assert seul["isolated"] is False and set(seul["missing"]) == set(CLES_ISOLATION)


def test_isoler_le_parc_pose_les_cles_et_journalise_chaque_spark():
    c = client()
    creer(c, "ancienne")
    desisoler(c, "ancienne")
    rendu = c.post("/v1/forge/isolation").json()
    assert rendu == {"isolated": ["ancienne"], "already": [], "denied": [], "error": []}
    eth0 = c.app.state.incus.created["ancienne"]["devices"]["eth0"]
    assert eth0["security.port_isolation"] == "true"
    assert eth0["security.ipv4_filtering"] == "true"
    assert c.get("/v1/forge/isolation").json()["pending"] == 0
    entrees = [e for e in c.get("/v1/audit?limit=50").json()["entries"]
               if e["action"] == "spark.isolate"]
    assert len(entrees) == 1 and entrees[0]["result"] == "ok"


def test_un_spark_deja_isole_est_compte_sans_etre_touche_ni_journalise():
    """« 7 isolés » sur un parc où un seul l'a été mentirait : ce qui l'était
    déjà se compte à part, et n'entre pas au journal."""
    c = client()
    creer(c, "neuf")
    creer(c, "ancienne")
    desisoler(c, "ancienne")
    rendu = c.post("/v1/forge/isolation").json()
    assert rendu["isolated"] == ["ancienne"] and rendu["already"] == ["neuf"]
    entrees = [e for e in c.get("/v1/audit?limit=50").json()["entries"]
               if e["action"] == "spark.isolate"]
    assert len(entrees) == 1


def test_un_spark_protege_REFUSE_le_geste_et_reste_visiblement_non_isole():
    """§35.2 : le geste est une écriture qui vise le Spark ; la protection
    garde son sens, et l'état ne ment pas."""
    c = client()
    creer(c, "garde")
    desisoler(c, "garde")
    assert c.post("/v1/sparks/garde/protection", json={"password": "mot"}).status_code == 200
    rendu = c.post("/v1/forge/isolation").json()
    assert rendu["isolated"] == []
    assert [r["name"] for r in rendu["denied"]] == ["garde"]
    etat = c.get("/v1/forge/isolation").json()
    assert etat["pending"] == 1 and etat["sparks"][0]["protected"] is True
    refus = [e for e in c.get("/v1/audit?limit=50").json()["entries"]
             if e["action"] == "spark.isolate"]
    assert len(refus) == 1 and refus[0]["result"] == "denied"


def test_un_pilote_en_panne_ne_fait_pas_echouer_les_autres_et_se_nomme():
    c = client()
    creer(c, "a")
    creer(c, "b")
    desisoler(c, "a")
    desisoler(c, "b")
    c.app.state.incus.fail_next["update_device_config"] = "Incus a dit non"
    rendu = c.post("/v1/forge/isolation").json()
    assert len(rendu["error"]) == 1 and "Incus a dit non" in rendu["error"][0]["reason"]
    assert len(rendu["isolated"]) == 1
    assert c.get("/v1/forge/isolation").json()["pending"] == 1


def test_un_spark_sans_cellule_n_est_ni_compte_ni_touche():
    """Un Spark encore `pending` n'a rien à isoler : on déclare avant de créer."""
    c = client()
    creer(c, "declare", appliquer=False)
    assert c.get("/v1/forge/isolation").json()["sparks"] == []
    assert c.post("/v1/forge/isolation").json() == {"isolated": [], "already": [], "denied": [], "error": []}
    seul = c.get("/v1/sparks/declare/isolation").json()
    assert seul["isolated"] is None and "pas encore appliqué" in seul["reason"]


def test_incus_muet_rend_illisible_et_non_pas_non_isole():
    """§31.2 : ne pas avoir lu n'est pas avoir lu « non isolé »."""
    c = client()
    creer(c, "seul")
    c.app.state.incus.fail_next["instances"] = "socket fermée"
    etat = c.get("/v1/forge/isolation").json()
    assert etat["readable"] is False and etat["sparks"] == []
    c.app.state.incus.fail_next["instances"] = "socket fermée"
    seul = c.get("/v1/sparks/seul/isolation").json()
    assert seul["isolated"] is None and "Incus" in seul["reason"]


def test_un_spark_inconnu_repond_404():
    c = client()
    assert c.get("/v1/sparks/personne/isolation").status_code == 404
