"""@verifies docs/BACKLOG.md#SPK-182 · docs/DAT.md §74.7 (l'aperçu précède l'écriture),
§74.8 (l'autorisation, côté serveur) · CLAUDE.md §10 (toute règle d'accès se prouve par
une requête directe qui contourne l'interface)

Les refus sont prouvés par l'API, sans interface : un Spark protégé refuse toute
écriture du SLA ; une politique sans rétention, un alias, une fréquence trop rapprochée
sont refusés avec leur raison ; une rétention qui supprimerait refuse sans confirmation
et NOMME les instantanés ; l'aperçu n'écrit rien.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from sparkd import sla, snapshots
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

GIO = 1024**3


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


@pytest.fixture
def env(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "p.db"), "SPARKD_DRIVER": "fake"}))
    client = TestClient(app)
    client.post("/v1/forge/sync")
    return client, app, tmp_path / "p.db"


@pytest.fixture
def client(env):
    return env[0]


def creer(client, nom="crm"):
    r = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO})
    assert r.status_code == 201, r.text
    # Un Spark créé n'a pas de cellule tant qu'il n'est pas appliqué : sans elle il n'y
    # a rien à capturer. Même chemin que le seed.
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def corps(**extra):
    return {"schedule": "0 2 * * *", "retention_days": 7, "retention_count": None, **extra}


def sla_pris(env, nom, jours):
    """Des instantanés SLA anciens, par le vrai service (comme le seed)."""
    _client, app, base = env
    connection = connect(base)
    try:
        ligne = dict(connection.execute("SELECT * FROM spark WHERE name = ?", (nom,)).fetchone())
        for j in jours:
            instant = utc(2026, 11, 18) - timedelta(days=j)
            snapshots.create(connection, ligne, sla.nom_sla(instant), app.state.incus,
                             origin="sla", created_at=sla._iso(instant))
    finally:
        connection.close()


# --- lire, poser, relire --------------------------------------------------------------

def test_sans_politique_l_absence_est_dite(client):
    nom = creer(client)
    reponse = client.get(f"/v1/sparks/{nom}/sla")
    assert reponse.status_code == 200
    assert reponse.json() == {"configured": False, "snapshots": {"count": 0, "size_bytes": None}}


def test_poser_puis_relire(client):
    nom = creer(client)
    reponse = client.put(f"/v1/sparks/{nom}/sla", json=corps())
    assert reponse.status_code == 200, reponse.text
    vue = reponse.json()
    assert vue["configured"] and vue["enabled"]
    assert vue["schedule"] == "0 2 * * *"
    assert vue["description"] == "Tous les jours à 02:00 UTC"
    assert vue["next_run_at"]
    assert client.get(f"/v1/sparks/{nom}/sla").json() == vue


def test_un_spark_inconnu_est_404(client):
    creer(client)
    assert client.get("/v1/sparks/absent/sla").status_code == 404
    assert client.put("/v1/sparks/absent/sla", json=corps()).status_code == 404
    assert client.delete("/v1/sparks/absent/sla").status_code == 404


# --- les refus de validation, par requête directe ---------------------------------------

@pytest.mark.parametrize("modif, raison", [
    ({"retention_days": None, "retention_count": None}, "rétention est obligatoire"),
    ({"schedule": "*/5 * * * *"}, "15 minutes"),
    ({"schedule": "@daily"}, "alias"),
    ({"schedule": "0 2 * *"}, "Cinq champs"),
    ({"schedule": "0 0 31 2 *"}, "Aucune date"),
    ({"retention_days": 0}, "entre 1 et 3650"),
    ({"retention_count": 5000}, "entre 1 et 1000"),
])
def test_refus_de_validation_avec_la_raison(client, modif, raison):
    nom = creer(client)
    reponse = client.put(f"/v1/sparks/{nom}/sla", json=corps(**modif))
    assert reponse.status_code == 422, reponse.text
    detail = reponse.json()["detail"]
    assert detail["error"] == "invalid_sla" and raison in detail["message"]
    assert client.get(f"/v1/sparks/{nom}/sla").json()["configured"] is False   # rien d'écrit


def test_les_booleens_sont_verifies(client):
    nom = creer(client)
    for champ in ("accept_deletion", "enabled"):
        reponse = client.put(f"/v1/sparks/{nom}/sla", json=corps(**{champ: "oui"}))
        assert reponse.status_code == 422


# --- l'aperçu n'écrit rien ---------------------------------------------------------------

def test_apercu_rend_la_phrase_les_prochaines_prises_et_n_ecrit_rien(env):
    client = env[0]
    nom = creer(client)
    sla_pris(env, nom, (10, 9, 1))
    reponse = client.post(f"/v1/sparks/{nom}/sla/preview", json=corps(retention_days=5))
    assert reponse.status_code == 200, reponse.text
    vue = reponse.json()
    assert vue["description"] == "Tous les jours à 02:00 UTC"
    assert len(vue["next_runs"]) == 3
    assert len(vue["would_delete"]) >= 1
    assert client.get(f"/v1/sparks/{nom}/sla").json()["configured"] is False
    assert len(client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]) == 3


def test_apercu_refuse_une_chaine_invalide(client):
    nom = creer(client)
    reponse = client.post(f"/v1/sparks/{nom}/sla/preview", json=corps(schedule="n'importe quoi"))
    assert reponse.status_code == 422


# --- la suppression se confirme, et se nomme ---------------------------------------------

def test_enregistrer_qui_supprimerait_refuse_sans_confirmation_et_nomme(env):
    client = env[0]
    nom = creer(client)
    sla_pris(env, nom, (10, 9, 1))
    reponse = client.put(f"/v1/sparks/{nom}/sla", json=corps(retention_days=None, retention_count=1))
    assert reponse.status_code == 409
    detail = reponse.json()["detail"]
    assert detail["error"] == "deletion_requires_confirmation"
    assert [d["name"] for d in detail["deletions"]] == ["SLA_20261108-000000", "SLA_20261109-000000"]
    assert "SLA_20261108-000000" in detail["message"]
    assert len(client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]) == 3
    assert client.get(f"/v1/sparks/{nom}/sla").json()["configured"] is False


def test_avec_la_confirmation_la_suppression_a_lieu_et_le_dernier_reste(env):
    client = env[0]
    nom = creer(client)
    sla_pris(env, nom, (10, 9, 1))
    reponse = client.put(f"/v1/sparks/{nom}/sla", json=corps(
        retention_days=None, retention_count=1, accept_deletion=True))
    assert reponse.status_code == 200, reponse.text
    restants = client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]
    assert [s["incus_name"] for s in restants] == ["SLA_20261117-000000"]
    assert restants[0]["origin"] == "sla"


def test_un_instantane_manuel_n_est_jamais_supprime_par_le_sla(env):
    client = env[0]
    nom = creer(client)
    assert client.post(f"/v1/sparks/{nom}/snapshots", json={"name": "avant-deploiement"}
                       ).status_code == 201
    sla_pris(env, nom, (10, 9, 1))
    client.put(f"/v1/sparks/{nom}/sla", json=corps(
        retention_days=None, retention_count=1, accept_deletion=True))
    noms = [s["incus_name"] for s in client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]]
    assert "avant-deploiement" in noms and "SLA_20261117-000000" in noms and len(noms) == 2


def test_la_creation_manuelle_refuse_le_nom_reserve(client):
    nom = creer(client)
    reponse = client.post(f"/v1/sparks/{nom}/snapshots", json={"name": "SLA_20261108-000000"})
    assert reponse.status_code == 409


def test_la_liste_des_instantanes_porte_la_provenance(env):
    client = env[0]
    nom = creer(client)
    client.post(f"/v1/sparks/{nom}/snapshots", json={"name": "manuel"})
    sla_pris(env, nom, (1,))
    origines = {s["incus_name"]: s["origin"]
                for s in client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]}
    assert origines == {"manuel": "manual", "SLA_20261117-000000": "sla"}


# --- suspendre, reprendre, retirer ---------------------------------------------------------

def test_suspendre_reprendre_retirer(env):
    client = env[0]
    nom = creer(client)
    client.put(f"/v1/sparks/{nom}/sla", json=corps())
    suspendu = client.post(f"/v1/sparks/{nom}/sla/suspend").json()
    assert suspendu["enabled"] is False and suspendu["next_run_at"] is None
    repris = client.post(f"/v1/sparks/{nom}/sla/resume").json()
    assert repris["enabled"] is True and repris["next_run_at"]
    sla_pris(env, nom, (1,))
    retire = client.delete(f"/v1/sparks/{nom}/sla")
    assert retire.status_code == 200 and retire.json()["configured"] is False
    # Retirer la politique ne supprime AUCUN instantané.
    assert len(client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]) == 1


def test_gestes_sur_une_politique_absente_et_geste_inconnu(client):
    nom = creer(client)
    assert client.post(f"/v1/sparks/{nom}/sla/suspend").status_code == 422
    assert client.delete(f"/v1/sparks/{nom}/sla").status_code == 422
    assert client.post(f"/v1/sparks/{nom}/sla/danser").status_code == 404


# --- l'autorisation : un Spark protégé refuse toute ÉCRITURE du SLA ---------------------------

def test_un_spark_protege_refuse_d_ecrire_son_sla_et_laisse_lire_et_previsualiser(client):
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/sla", json=corps()).status_code == 200
    assert client.post(f"/v1/sparks/{nom}/protection", json={"password": "secret"}).status_code == 200

    # Toute écriture : 423, comme les autres écritures protégées (§35.5).
    for reponse in (
        client.put(f"/v1/sparks/{nom}/sla", json=corps(retention_days=14)),
        client.post(f"/v1/sparks/{nom}/sla/suspend"),
        client.post(f"/v1/sparks/{nom}/sla/resume"),
        client.delete(f"/v1/sparks/{nom}/sla"),
    ):
        assert reponse.status_code == 423, reponse.text
        assert reponse.json()["detail"]["error"] == "spark_protected"
    # La politique n'a pas bougé.
    assert client.get(f"/v1/sparks/{nom}/sla").json()["retention_days"] == 7
    # Lire et prévisualiser ne sont pas des écritures.
    assert client.get(f"/v1/sparks/{nom}/sla").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/sla/preview", json=corps()).status_code == 200


# --- le planificateur agit sur un Spark protégé (DAT §74.8, décision à confirmer) -----------------

def test_le_planificateur_prend_et_supprime_meme_sous_protection(env):
    client, app, base = env
    nom = creer(client)
    client.put(f"/v1/sparks/{nom}/sla", json=corps(retention_days=None, retention_count=1))
    sla_pris(env, nom, (3, 2))
    assert client.post(f"/v1/sparks/{nom}/protection", json={"password": "secret"}).status_code == 200
    connection = connect(base)
    try:
        connection.execute("UPDATE sla SET next_run_at = ?", (sla._iso(utc(2026, 11, 18)),))
        connection.commit()
    finally:
        connection.close()
    rendus = app.state.planificateur_sla.un_pas(utc(2026, 11, 18, 0, 0, 5), retention=True)
    assert [r["resultat"] for r in rendus] == ["ok"]
    noms = [s["incus_name"] for s in client.get(f"/v1/sparks/{nom}/snapshots").json()["snapshots"]]
    assert noms == ["SLA_20261118-000005"]        # la prise a eu lieu, la rétention a purgé


def test_le_planificateur_est_cable_et_son_premier_pas_est_sans_effet_sans_politique(env):
    _client, app, _base = env
    assert app.state.planificateur_sla.un_pas(utc(2026, 11, 18)) == []
