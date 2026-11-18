"""@verifies docs/BACKLOG.md#SPK-188 · docs/DAT.md §76.3 (les deux lectures de parc : états exclusifs
et additifs, ordre, `without`, ni cible ni sortie de script), §76.2 (lecture seule : ni cellule, ni
audit), §76.5 (un SLA qui n'a jamais tourné n'est pas un échec) · docs/SCHEMA.md §8 ter, §8 quater
(lus, non modifiés) · CLAUDE.md §10 (la règle se prouve par la requête directe)

Tout passe par le VRAI registre et les VRAIS planificateurs : les états « en panne », « instable »,
« en échec » viennent d'un relevé joué par le fil de santé contre une sonde de doublon, et d'une prise
du planificateur du SLA contre une cellule factice qui refuse — jamais d'une écriture directe, sauf
l'unique cas qu'aucun chemin normal ne produit (une taille d'instantané inconnue).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from sparkd import sla
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

GIO = 1024**3
MAINTENANT = datetime.now(timezone.utc)


@pytest.fixture
def env(tmp_path):
    base = tmp_path / "p.db"
    app = create_app(load({"SPARKD_DB": str(base), "SPARKD_DRIVER": "fake"}))
    client = TestClient(app)
    client.post("/v1/forge/sync")
    return client, app, base


def creer(client, nom, domaine=None):
    r = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO})
    assert r.status_code == 201, r.text
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    if domaine:
        r = client.post("/v1/ingress", json={"spark": nom, "domain": domaine, "port": 8080, "tls": True})
        assert r.status_code == 201, r.text
    return nom


def politique(**extra):
    return {"schedule": "0 2 * * *", "retention_days": 7, "retention_count": None, **extra}


def sonde(domaine, **extra):
    return {"kind": "http", "target": f"https://{domaine}/healthz", "expected": 200,
            "schedule": "*/5 * * * *", "threshold": 3, **extra}


def echeoir_les_sla(base, instant, spark):
    """Rend la politique d'un Spark échue, comme le temps qui passe — la seule colonne qu'on avance."""
    connection = connect(base)
    try:
        connection.execute(
            "UPDATE sla SET next_run_at = ? WHERE spark_id = (SELECT id FROM spark WHERE name = ?)",
            (sla._iso(instant), spark))
        connection.commit()
    finally:
        connection.close()


@pytest.fixture
def parc_sla(env):
    """a : actif, une prise réussie · b : en échec · c : suspendu · d : sans SLA."""
    client, app, base = env
    for nom in ("alpha", "bravo", "charlie", "delta"):
        creer(client, nom)
    for nom in ("alpha", "bravo", "charlie"):
        assert client.put(f"/v1/sparks/{nom}/sla", json=politique()).status_code == 200
    assert client.post("/v1/sparks/charlie/sla/suspend").status_code == 200
    # bravo, dont la cellule refuse, échoue ; puis alpha prend son instantané.
    instant = datetime.now(timezone.utc) + timedelta(days=1)
    rendus = {}
    for nom in ("alpha", "bravo", "charlie"):                 # rien n'est échu, sauf ce qu'on avance ensuite
        echeoir_les_sla(base, instant + timedelta(days=30), nom)
    echeoir_les_sla(base, instant, "bravo")
    app.state.incus.fail_next["create_snapshot"] = "pool saturé"
    rendus.update({r["spark"]: r["resultat"] for r in app.state.planificateur_sla.un_pas(instant, retention=False)})
    echeoir_les_sla(base, instant, "alpha")
    rendus.update({r["spark"]: r["resultat"] for r in app.state.planificateur_sla.un_pas(instant, retention=False)})
    return client, app, base, rendus


# --- SLA --------------------------------------------------------------------------------------------------

def test_sans_aucun_sla_l_absence_est_nommee_et_les_chiffres_sont_nuls(env):
    client, _app, _base = env
    creer(client, "bravo")
    creer(client, "alpha")
    corps = client.get("/v1/forge/sla").json()
    assert corps["summary"] == {
        "sparks": 2, "configured": 0, "active": 0, "failing": 0, "suspended": 0,
        "snapshots_count": 0, "snapshots_size_bytes": 0}
    assert corps["sparks"] == []
    assert corps["without"] == ["alpha", "bravo"]            # triés, nommés


def test_un_parc_de_sla_les_etats_sont_exclusifs_additifs_et_le_pire_vient_en_tete(parc_sla):
    client, _app, _base, rendus = parc_sla
    assert rendus == {"bravo": "error", "alpha": "ok"}        # le doublon a bien joué un échec et une prise
    corps = client.get("/v1/forge/sla").json()
    resume = corps["summary"]
    assert (resume["sparks"], resume["configured"]) == (4, 3)
    assert (resume["failing"], resume["active"], resume["suspended"]) == (1, 1, 1)
    assert resume["configured"] == resume["active"] + resume["failing"] + resume["suspended"]
    assert resume["snapshots_count"] == 1              # seule la prise d'alpha existe : celle de bravo a échoué
    # ordre : en échec, actifs, suspendus
    assert [(s["spark"], s["state"]) for s in corps["sparks"]] == [
        ("bravo", "failing"), ("alpha", "active"), ("charlie", "suspended")]
    assert corps["without"] == ["delta"]


def test_une_entree_de_sla_porte_la_vue_du_spark_et_le_motif_de_l_echec(parc_sla):
    client, _app, _base, _rendus = parc_sla
    par_nom = {s["spark"]: s for s in client.get("/v1/forge/sla").json()["sparks"]}
    echec = par_nom["bravo"]
    assert echec["last_status"] == "error" and "pool saturé" in echec["last_error"]
    assert echec["schedule"] == "0 2 * * *" and echec["description"] == "Tous les jours à 02:00 UTC"
    assert echec["retention_days"] == 7 and echec["retention_count"] is None
    # la même vue que la facette du Spark : un seul modèle, jamais deux
    individuel = client.get("/v1/sparks/bravo/sla").json()
    for cle in ("schedule", "description", "enabled", "next_run_at", "last_run_at", "last_status",
                "last_error", "retention_days", "retention_count", "snapshots"):
        assert echec[cle] == individuel[cle], cle
    assert par_nom["alpha"]["snapshots"]["count"] == 1


def test_la_charge_de_la_semaine_ne_compte_que_les_sla_qui_prennent(parc_sla):
    client, _app, _base, _rendus = parc_sla
    semaine = client.get("/v1/forge/sla").json()["week"]
    # alpha (actif) et bravo (en échec) prennent à 02:00 chaque jour ; charlie, suspendu, ne charge rien
    assert len(semaine["slots"]) == 672 and semaine["peak"] == 2 and semaine["busy_slots"] == 7
    assert semaine["busiest"][0]["sparks"] == ["alpha", "bravo"]
    assert sum(semaine["slots"]) == 14
    assert datetime.fromisoformat(semaine["start"]).weekday() == 0           # un lundi


def test_un_sla_qui_n_a_jamais_tourne_est_actif_pas_en_echec(env):
    client, _app, _base = env
    creer(client, "alpha")
    client.put("/v1/sparks/alpha/sla", json=politique())
    corps = client.get("/v1/forge/sla").json()
    assert corps["summary"]["active"] == 1 and corps["summary"]["failing"] == 0
    assert corps["sparks"][0]["state"] == "active" and corps["sparks"][0]["last_run_at"] is None


def test_une_taille_inconnue_rend_la_taille_cumulee_inconnue_pas_zero(parc_sla):
    client, _app, base, _rendus = parc_sla
    connection = connect(base)
    try:
        # le doublon ne mesure pas la taille : on la pose, comme le fait la vraie cellule
        connection.execute("UPDATE snapshot SET size_bytes = 4096")
        connection.commit()
    finally:
        connection.close()
    avant = client.get("/v1/forge/sla").json()["summary"]
    assert avant["snapshots_size_bytes"] == 4096 * avant["snapshots_count"]   # toutes les tailles sont connues : la somme
    connection = connect(base)
    try:
        connection.execute("UPDATE snapshot SET size_bytes = NULL")
        connection.commit()
    finally:
        connection.close()
    apres = client.get("/v1/forge/sla").json()["summary"]
    assert apres["snapshots_count"] == 1 and apres["snapshots_size_bytes"] is None


# --- Santé ------------------------------------------------------------------------------------------------

@pytest.fixture
def parc_sante(env):
    """alpha : une sonde en panne, une saine · bravo : instable · charlie : en panne puis suspendue ·
    delta : aucune sonde. Chaque état est celui que le fil de santé a écrit."""
    client, app, base = env
    domaines = {"alpha": "alpha.example.com", "bravo": "bravo.example.com", "charlie": "charlie.example.com"}
    for nom in ("alpha", "bravo", "charlie", "delta"):
        creer(client, nom, domaines.get(nom))
    assert client.put("/v1/sparks/alpha/health/api", json=sonde(domaines["alpha"], threshold=1)).status_code == 200
    assert client.put("/v1/sparks/alpha/health/web", json=sonde(domaines["alpha"])).status_code == 200
    assert client.put("/v1/sparks/bravo/health/api", json=sonde(domaines["bravo"], threshold=3)).status_code == 200
    assert client.put("/v1/sparks/charlie/health/api", json=sonde(domaines["charlie"], threshold=1)).status_code == 200
    # alpha : « api » et « web » visent le même domaine → les deux voient 500 ; « web » à seuil 3 reste instable.
    app.state.sondes.poser("alpha.example.com", sante={"status": 500})
    app.state.sondes.poser("bravo.example.com", sante={"status": 500})
    app.state.sondes.poser("charlie.example.com", sante={"status": 500})
    app.state.sante.un_pas(datetime.now(timezone.utc) + timedelta(minutes=1))
    assert client.post("/v1/sparks/charlie/health/api/suspend").status_code == 200
    return client, app, base


def test_sans_aucune_sonde_l_absence_est_nommee(env):
    client, _app, _base = env
    creer(client, "alpha")
    corps = client.get("/v1/forge/health").json()
    assert corps["summary"] == {
        "sparks": 1, "monitored": 0, "checks": 0, "down": 0, "unstable": 0, "unknown": 0,
        "stopped": 0, "healthy": 0, "suspended": 0}
    assert corps["sparks"] == [] and corps["without"] == ["alpha"]


def test_un_parc_de_sondes_les_etats_sont_exclusifs_additifs(parc_sante):
    client, _app, _base = parc_sante
    resume = client.get("/v1/forge/health").json()["summary"]
    assert (resume["sparks"], resume["monitored"], resume["checks"]) == (4, 3, 4)
    # api(alpha) seuil 1 → en panne ; web(alpha) seuil 3 et bravo.api → instables ; charlie.api suspendue.
    assert (resume["down"], resume["unstable"], resume["suspended"]) == (1, 2, 1)
    assert resume["healthy"] == resume["unknown"] == resume["stopped"] == 0
    somme = sum(resume[k] for k in ("down", "unstable", "unknown", "stopped", "healthy", "suspended"))
    assert resume["checks"] == somme


def test_une_sonde_suspendue_sort_de_l_etat_qu_elle_gardait(parc_sante):
    client, _app, _base = parc_sante
    corps = client.get("/v1/forge/health").json()
    charlie = next(s for s in corps["sparks"] if s["spark"] == "charlie")
    # la sonde garde son dernier état (en panne) dans sa ligne, mais le parc ne la compte pas en panne
    assert charlie["checks"][0]["state"] == "down" and charlie["checks"][0]["enabled"] is False
    assert charlie["worst"] == "suspended"
    assert corps["summary"]["down"] == 1                       # seule alpha.api


def test_les_sparks_et_les_sondes_viennent_du_pire_au_plus_sain(parc_sante):
    client, _app, _base = parc_sante
    corps = client.get("/v1/forge/health").json()
    assert [(s["spark"], s["worst"]) for s in corps["sparks"]] == [
        ("alpha", "down"), ("bravo", "unstable"), ("charlie", "suspended")]
    assert [(c["name"], c["state"]) for c in corps["sparks"][0]["checks"]] == [
        ("api", "down"), ("web", "unstable")]
    assert corps["without"] == ["delta"]


def test_une_sonde_porte_ses_releves_son_motif_et_son_etat_individuel(parc_sante):
    client, _app, _base = parc_sante
    corps = client.get("/v1/forge/health").json()
    api = corps["sparks"][0]["checks"][0]
    assert api["kind"] == "http" and api["threshold"] == 1 and api["consecutive_failures"] >= 1
    assert api["results"] and api["results"][-1]["ok"] is False
    assert "HTTP 500" in api["last_detail"]
    individuel = client.get("/v1/sparks/alpha/health").json()["checks"][0]
    for cle in ("state", "enabled", "schedule", "description", "threshold", "consecutive_failures",
                "state_since", "last_run_at", "next_run_at", "last_latency_ms", "last_detail", "results"):
        assert api[cle] == individuel[cle], cle


def test_ni_la_cible_ni_la_commande_d_un_script_ne_sortent_de_l_index(env):
    client, _app, _base = env
    creer(client, "alpha", "alpha.example.com")
    marqueur = "MARQUEUR_NE_DOIT_PAS_SORTIR"
    r = client.put("/v1/sparks/alpha/health/jobs", json={
        "kind": "script", "target": f"echo {marqueur}; exit 0", "expected": 0,
        "schedule": "*/5 * * * *", "threshold": 3})
    assert r.status_code == 200, r.text
    client.put("/v1/sparks/alpha/health/api", json=sonde("alpha.example.com"))
    brut = client.get("/v1/forge/health").text
    assert marqueur not in brut                               # la commande
    assert "alpha.example.com/healthz" not in brut            # l'URL : le Spark la montre, pas l'index
    assert '"target"' not in brut


# --- lecture seule ----------------------------------------------------------------------------------------

class CelluleInterdite:
    """Toute tentative de toucher une cellule, ou Incus, fait échouer l'épreuve."""

    def __getattr__(self, nom):
        raise AssertionError(f"l'index de la Forge a touché Incus : {nom}")


@pytest.mark.parametrize("chemin", ["/v1/forge/sla", "/v1/forge/health"])
def test_lire_n_ecrit_rien_et_ne_touche_aucune_cellule(parc_sante, chemin):
    client, app, base = parc_sante

    def etat():
        connection = connect(base)
        try:
            return (connection.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0],
                    connection.execute("SELECT COUNT(*) FROM health_result").fetchone()[0],
                    connection.execute("SELECT COUNT(*) FROM snapshot").fetchone()[0])
        finally:
            connection.close()

    avant = etat()
    reel, app.state.incus = app.state.incus, CelluleInterdite()
    try:
        assert client.get(chemin).status_code == 200
    finally:
        app.state.incus = reel
    assert etat() == avant


@pytest.mark.parametrize("chemin", ["/v1/forge/sla", "/v1/forge/health"])
def test_les_deux_lectures_n_acceptent_que_get(env, chemin):
    client, _app, _base = env
    for verbe in (client.post, client.put, client.delete):
        assert verbe(chemin).status_code == 405
