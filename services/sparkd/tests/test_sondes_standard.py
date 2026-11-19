"""@verifies docs/BACKLOG.md#SPK-190 · docs/DAT.md §77.2 (le catalogue : quatre sondes ordinaires du §75, une
seule source), §77.3 (« celles qui manquent, par leur nom » : jamais une existante modifiée, idempotent, borne de
20), §77.4 (GET ne montre que ce qui serait ajouté ; POST pose par le chemin normal ; un Spark protégé refuse),
§75.5 (le compte d'un script : le mode Docker relevé, ou, à défaut, la cellule) · CLAUDE.md §10 (la règle d'accès
se prouve par la requête directe avec les vrais identifiants), §18 (le défaut du compte rootless : preuve rouge avant)

Tout passe par le VRAI registre et la vraie validation du §75 : le catalogue n'a aucun privilège sur une sonde
saisie à la main.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import health
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

GIO = 1024**3
NOMS = ["disque", "memoire", "cpu", "docker"]


@pytest.fixture
def env(tmp_path):
    base = tmp_path / "p.db"
    app = create_app(load({"SPARKD_DB": str(base), "SPARKD_DRIVER": "fake"}))
    client = TestClient(app)
    client.post("/v1/forge/sync")
    return client, app, base


def creer(client, nom="crm", docker=True, base=None):
    r = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO})
    assert r.status_code == 201, r.text
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    if base is not None:
        connection = connect(base)
        try:
            connection.execute("UPDATE spark SET docker_enabled = ? WHERE name = ?", (int(docker), nom))
            connection.commit()
        finally:
            connection.close()
    return nom


def compte(base, table):
    connection = connect(base)
    try:
        return connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        connection.close()


# --- le catalogue -----------------------------------------------------------------------------------------

def test_le_catalogue_porte_les_quatre_sondes_dans_cet_ordre_avec_des_noms_distincts():
    assert [s["name"] for s in health.STANDARD] == NOMS
    assert len({s["name"] for s in health.STANDARD}) == 4


def test_chaque_entree_est_une_sonde_script_d_une_ligne_qui_attend_le_code_zero():
    for s in health.STANDARD:
        assert s["kind"] == "script" and s["expected"] == 0, s["name"]
        assert "\n" not in s["target"] and 0 < len(s["target"]) < 2000, s["name"]
        assert s["description"], s["name"]


def test_seule_docker_exige_docker():
    assert {s["name"]: s.get("requires") for s in health.STANDARD} == {
        "disque": None, "memoire": None, "cpu": None, "docker": "docker"}


def test_chaque_entree_passe_la_validation_du_75_comme_une_sonde_saisie_a_la_main(env):
    client, _app, base = env
    nom = creer(client, base=base)
    for s in health.STANDARD:
        r = client.post(f"/v1/sparks/{nom}/health/validate", json={
            "kind": s["kind"], "target": s["target"], "expected": s["expected"],
            "schedule": s["schedule"], "threshold": s["threshold"]})
        assert r.status_code == 200, (s["name"], r.text)


def test_la_commande_docker_du_catalogue_est_celle_deja_proposee_aux_dix_sparks_reels():
    """Une seule commande `docker` : les propositions déposées le 2026-11-19 et le bouton ne divergent pas."""
    docker = next(s for s in health.STANDARD if s["name"] == "docker")
    assert docker["target"] == (
        'docker ps -q >/dev/null && test -z "$(docker ps -q --filter status=restarting)" '
        '&& test -z "$(docker ps -q --filter health=unhealthy)"')


# --- GET : ce qui serait ajouté, sans rien écrire ---------------------------------------------------------------

def test_get_dit_ce_qui_serait_ajoute_et_n_ecrit_rien(env):
    client, _app, base = env
    nom = creer(client, base=base)
    avant = (compte(base, "health_check"), compte(base, "audit_log"))
    r = client.get(f"/v1/sparks/{nom}/health/standard")
    assert r.status_code == 200, r.text
    corps = r.json()
    assert [s["name"] for s in corps["to_add"]] == NOMS
    assert corps["present"] == [] and corps["unavailable"] == []
    assert set(corps["to_add"][0]) >= {"name", "kind", "target", "expected", "schedule", "threshold", "description"}
    assert (compte(base, "health_check"), compte(base, "audit_log")) == avant


def test_sans_docker_la_sonde_docker_est_dite_indisponible_avec_sa_raison(env):
    client, _app, base = env
    nom = creer(client, docker=False, base=base)
    corps = client.get(f"/v1/sparks/{nom}/health/standard").json()
    assert [s["name"] for s in corps["to_add"]] == ["disque", "memoire", "cpu"]
    assert corps["unavailable"] == [{"name": "docker", "reason": "Docker n'est pas activé sur ce Spark."}]


# --- POST : poser celles qui manquent ---------------------------------------------------------------------------------

def test_post_pose_les_quatre_par_le_chemin_normal_et_les_journalise(env):
    client, _app, base = env
    nom = creer(client, base=base)
    audit_avant = compte(base, "audit_log")
    r = client.post(f"/v1/sparks/{nom}/health/standard")
    assert r.status_code == 200, r.text
    corps = r.json()
    assert [s["name"] for s in corps["added"]] == NOMS and corps["present"] == []
    assert [c["name"] for c in corps["checks"]] == sorted(NOMS)
    # lue de nouveau : ce sont de vraies sondes, activées, prêtes à relever
    posees = client.get(f"/v1/sparks/{nom}/health").json()["checks"]
    assert len(posees) == 4 and all(c["enabled"] and c["state"] == "unknown" and c["next_run_at"] for c in posees)
    assert compte(base, "audit_log") - audit_avant >= 4, "chaque pose passe par `poser`, donc par le journal"


def test_post_est_idempotent_un_second_clic_n_ajoute_rien(env):
    client, _app, base = env
    nom = creer(client, base=base)
    client.post(f"/v1/sparks/{nom}/health/standard")
    audit = compte(base, "audit_log")
    corps = client.post(f"/v1/sparks/{nom}/health/standard").json()
    assert corps["added"] == [] and corps["present"] == NOMS
    assert compte(base, "audit_log") == audit and compte(base, "health_check") == 4


def test_une_sonde_du_meme_nom_vaut_presence_et_n_est_jamais_modifiee(env):
    client, _app, base = env
    nom = creer(client, base=base)
    perso = {"kind": "script", "target": 'test "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt 95',
             "expected": 0, "schedule": "*/30 * * * *", "threshold": 7}
    assert client.put(f"/v1/sparks/{nom}/health/disque", json=perso).status_code == 200
    corps = client.post(f"/v1/sparks/{nom}/health/standard").json()
    assert [s["name"] for s in corps["added"]] == ["memoire", "cpu", "docker"]
    assert corps["present"] == ["disque"]
    gardee = next(c for c in client.get(f"/v1/sparks/{nom}/health").json()["checks"] if c["name"] == "disque")
    assert gardee["threshold"] == 7 and gardee["schedule"] == "*/30 * * * *" and "-lt 95" in gardee["target"]


def test_la_borne_de_vingt_sondes_est_respectee_et_dite(env):
    client, _app, base = env
    nom = creer(client, base=base)
    for i in range(18):
        r = client.put(f"/v1/sparks/{nom}/health/p{i:02d}", json={
            "kind": "script", "target": "true", "expected": 0, "schedule": "*/5 * * * *", "threshold": 3})
        assert r.status_code == 200, r.text
    corps = client.post(f"/v1/sparks/{nom}/health/standard").json()
    assert [s["name"] for s in corps["added"]] == ["disque", "memoire"]
    assert [u["name"] for u in corps["unavailable"]] == ["cpu", "docker"]
    assert all("20" in u["reason"] for u in corps["unavailable"])
    assert len(client.get(f"/v1/sparks/{nom}/health").json()["checks"]) == 20


def test_un_spark_inconnu_est_404_en_lecture_comme_en_ecriture(env):
    client, _app, base = env
    creer(client, base=base)
    assert client.get("/v1/sparks/absent/health/standard").status_code == 404
    assert client.post("/v1/sparks/absent/health/standard").status_code == 404


# --- l'autorisation, par requête directe -------------------------------------------------------------------------------------

def test_un_spark_protege_refuse_la_pose_mais_se_lit(env):
    client, _app, base = env
    nom = creer(client, base=base)
    assert client.post(f"/v1/sparks/{nom}/protection", json={"password": "secret"}).status_code == 200
    r = client.post(f"/v1/sparks/{nom}/health/standard")
    assert r.status_code == 423 and r.json()["detail"]["error"] == "spark_protected", r.text
    assert compte(base, "health_check") == 0, "le refus n'a rien posé"
    assert client.get(f"/v1/sparks/{nom}/health/standard").status_code == 200       # lire est ouvert


# --- le compte d'un script, sans observation d'amorçage : la cellule le dit (défaut vu sur magiline-mcp) --------------------------

class Espion:
    def __init__(self, code_id):
        self.code_id, self.vus = code_id, []

    def exec_capture(self, nom, commande):
        self.vus.append(commande)
        return (self.code_id, "", "") if commande[:2] == ["id", "-u"] else (0, "", "")


def ligne_du_spark(base, nom, docker=True):
    connection = connect(base)
    try:
        connection.execute("UPDATE spark SET docker_enabled = ? WHERE name = ?", (int(docker), nom))
        connection.commit()
        return connection, dict(connection.execute("SELECT * FROM spark WHERE name = ?", (nom,)).fetchone())
    except Exception:
        connection.close()
        raise


def test_sans_observation_un_spark_dont_la_cellule_a_le_compte_rootless_joue_ses_scripts_sous_lui(env):
    """Vu sur spark-010 (2026-11-19) : `magiline-mcp` fait tourner un Docker rootless que le registre n'a jamais relevé.
    « Jamais amorcé vaut enraciné » envoyait donc `docker ps` sous root : code 1, une fausse panne permanente."""
    client, _app, base = env
    nom = creer(client, base=base)
    connection, s = ligne_du_spark(base, nom)
    try:
        assert connection.execute("SELECT COUNT(*) FROM spark_bootstrap_observation").fetchone()[0] == 0
        espion = Espion(code_id=0)                                     # `id -u spark-docker` : le compte existe
        sonde = {"kind": "script", "target": "docker ps -q", "expected": 0}
        assert health._executer(connection, espion, None, s, sonde)["ok"] is True
        script = espion.vus[-1]
        assert "runuser -u spark-docker" in script[6] and script[-1] == "docker ps -q"
    finally:
        connection.close()


def test_sans_observation_et_sans_compte_rootless_le_script_reste_nu(env):
    client, _app, base = env
    nom = creer(client, base=base)
    connection, s = ligne_du_spark(base, nom)
    try:
        espion = Espion(code_id=1)                                     # le compte n'existe pas : enraciné
        health._executer(connection, espion, None, s, {"kind": "script", "target": "docker ps -q", "expected": 0})
        assert espion.vus[-1] == ["timeout", "-k", "5", "60", "sh", "-c", "docker ps -q"]
    finally:
        connection.close()


def test_sans_docker_activé_la_cellule_n_est_pas_interrogee_sur_son_compte(env):
    client, _app, base = env
    nom = creer(client, docker=False, base=base)
    connection, s = ligne_du_spark(base, nom, docker=False)
    try:
        espion = Espion(code_id=0)
        health._executer(connection, espion, None, s, {"kind": "script", "target": "pg_isready", "expected": 0})
        assert espion.vus == [["timeout", "-k", "5", "60", "sh", "-c", "pg_isready"]], \
            "aucune question inutile à une cellule sans Docker : le script part nu"
    finally:
        connection.close()


def test_une_observation_qui_dit_le_mode_l_emporte_sur_la_question_a_la_cellule(env):
    client, _app, base = env
    nom = creer(client, base=base)
    connection, s = ligne_du_spark(base, nom)
    try:
        connection.execute(
            "INSERT INTO spark_bootstrap_observation (spark_id, observed_at, docker_mode, managed_items)"
            " VALUES (?, '2026-11-18T10:00:00+00:00', 'enracine', '[]')", (s["id"],))
        espion = Espion(code_id=0)                                     # la cellule dirait « rootless »…
        health._executer(connection, espion, None, s, {"kind": "script", "target": "docker ps -q", "expected": 0})
        assert espion.vus == [["timeout", "-k", "5", "60", "sh", "-c", "docker ps -q"]]   # …l'observation fait foi
    finally:
        connection.close()
