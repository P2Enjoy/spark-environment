"""@verifies docs/BACKLOG.md#SPK-185 · docs/DAT.md §75.9 (la paire `health` / `health.?`), §55
(le fichier `.?`), §55.3 (ce qu'une acceptation fait), §55.4 (une suggestion n'est pas une
écriture), §55.5 (écarter n'est pas refuser), §55.7 (ce que l'en-tête doit dire)

Le point de ces preuves est ce qui N'ARRIVE PAS : une proposition ne pose rien, ne retire rien ;
un refus du produit laisse le fichier intact pour que son auteur le corrige ; une ligne refusable
n'en laisse aucune autre à moitié acceptée ; le fichier réel ne porte jamais la sortie d'un script.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import suggestions
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


@pytest.fixture
def client(tmp_path):
    c = TestClient(create_app(load({
        "SPARKD_DB": str(tmp_path / "hs.db"), "SPARKD_DRIVER": "fake"})))
    assert c.post("/v1/forge/sync").status_code in (200, 201)
    return c


def creer(client, nom="crm", domaine="crm.example.com"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "storage_bytes": 5 * GIO, "network_bps": 10_000_000}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    if domaine:
        assert client.post("/v1/ingress", json={"spark": nom, "domain": domaine, "port": 8080,
                                                "tls": True}).status_code == 201
    return nom


def deposer(client, nom, texte):
    client.app.state.incus.push_file(
        nom, suggestions.chemin("health"), suggestions.entete("health") + texte)


def lire_cellule(client, nom, chemin):
    return client.app.state.incus.pull_file(nom, chemin)


def sonde(**extra):
    return {"name": "api", "kind": "http", "schedule": "*/5 * * * *", "threshold": 3,
            "expected": 200, "target": "https://crm.example.com/healthz", **extra}


# --- la septième paire ----------------------------------------------------------------------------

def test_health_est_la_septieme_paire_et_ajoute_ou_remplace_entree_par_entree():
    assert "health" in suggestions.NATURES and len(suggestions.PAIRES) == 7
    paire = suggestions.definition("health")
    assert paire["reel"] == "/etc/spark/health" and paire["nature"] == suggestions.ENTREES
    assert suggestions.chemin("health") == "/etc/spark/health.?"


def test_l_entete_apprend_la_grammaire_et_le_script_a_l_agent():
    entete = suggestions.entete("health")
    for attendu in ("<nom> <type> <cadence", "http", "script", "cinq champs", "5 minutes",
                    "https://<un domaine de VOS routes>", "ni port, ni identifiant, ni joker",
                    "DANS la cellule", "CODE DE SORTIE", "n'est ni gardée ni envoyée",
                    "commande EXACTE", "Rien n'est jamais retiré", "/etc/spark/health",
                    "api    http    */5 * * * *"):
        assert attendu in entete, attendu
    assert entete.endswith(suggestions.FIN_DIESE + "\n")


def test_la_cellule_recoit_health_point_interrogation_vide_avec_son_entete(client):
    nom = creer(client)
    client.get(f"/v1/sparks/{nom}/suggestions")                 # la lecture de l'écran est le filet
    brut = lire_cellule(client, nom, "/etc/spark/health.?")
    assert brut and suggestions.MARQUEUR + ":health" in brut
    assert suggestions.vide("health", brut) is True


# --- le fichier réel ---------------------------------------------------------------------------------

def test_le_fichier_reel_dit_l_absence_quand_aucune_sonde_ne_surveille(client):
    nom = creer(client)
    client.get(f"/v1/sparks/{nom}/suggestions")
    reel = lire_cellule(client, nom, "/etc/spark/health")
    assert "Aucune sonde ne surveille ce Spark." in reel
    assert "<nom> <type> <cadence" in reel and "/etc/spark/health.?" in reel


def test_le_fichier_reel_est_regenere_depuis_le_registre_apres_chaque_geste(client):
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/health/api", json={k: v for k, v in sonde().items()
                                                            if k != "name"}).status_code == 200
    reel = lire_cellule(client, nom, "/etc/spark/health")
    assert "api http */5 * * * * 3 200 https://crm.example.com/healthz" in reel
    assert "# api : jamais relevée" in reel
    client.post(f"/v1/sparks/{nom}/health/api/suspend")
    assert "SUSPENDUE" in lire_cellule(client, nom, "/etc/spark/health")
    client.delete(f"/v1/sparks/{nom}/health/api")
    assert "Aucune sonde ne surveille ce Spark." in lire_cellule(client, nom, "/etc/spark/health")


def test_le_fichier_reel_dit_l_etat_au_dernier_releve_mais_jamais_une_sortie(client):
    nom = creer(client)
    script = {"kind": "script", "target": "exit 3", "expected": 0, "schedule": "*/10 * * * *",
              "threshold": 1}
    client.put(f"/v1/sparks/{nom}/health/base", json=script)
    from datetime import datetime, timedelta, timezone
    client.app.state.sante.un_pas(datetime.now(timezone.utc) + timedelta(minutes=1))
    client.get(f"/v1/sparks/{nom}/suggestions")                 # relit l'état et réécrit le fichier
    reel = lire_cellule(client, nom, "/etc/spark/health")
    assert "# base : EN PANNE (code de sortie 3 (attendu 0))" in reel
    assert "base script */10 * * * * 1 0 exit 3" in reel


def test_ecrire_a_la_main_dans_le_fichier_reel_n_a_aucun_effet_durable(client):
    nom = creer(client)
    client.app.state.incus.push_file(nom, "/etc/spark/health", "evil http * * * * * 1 200 https://x/\n")
    client.get(f"/v1/sparks/{nom}/suggestions")
    assert "evil" not in lire_cellule(client, nom, "/etc/spark/health")
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []


# --- une proposition ne pose rien, ne retire rien ----------------------------------------------------------

def test_une_proposition_ne_pose_aucune_sonde_et_la_forge_dit_qu_elle_attend(client):
    nom = creer(client)
    deposer(client, nom, "api http */5 * * * * 3 200 https://crm.example.com/healthz\n")
    lue = client.get(f"/v1/sparks/{nom}/suggestions").json()
    par_kind = {s["kind"]: s for s in lue["suggestions"]}
    assert par_kind["health"]["present"] is True
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []     # RIEN n'est posé
    pending = client.get("/v1/suggestions").json()["sparks"]
    assert any(p["kind"] == "health" and p["lines"] == 1
               for s in pending if s["spark"] == nom for p in s["pending"])


def test_accepter_pose_par_le_chemin_normal_et_vide_le_fichier(client):
    nom = creer(client)
    deposer(client, nom, "api http */5 * * * * 3 200 https://crm.example.com/healthz\n")
    lue = client.get(f"/v1/sparks/{nom}/suggestions").json()
    sha = {s["kind"]: s["sha256"] for s in lue["suggestions"]}["health"]
    r = client.post(f"/v1/sparks/{nom}/suggestions/health/apply",
                    json={"sha256": sha, "entries": [sonde()]})
    assert r.status_code == 200, r.text
    assert r.json()["checks"] == ["api"] and r.json()["cleared"] is True
    vue = client.get(f"/v1/sparks/{nom}/health").json()["checks"]
    assert [c["name"] for c in vue] == ["api"] and vue[0]["state"] == "unknown"
    # Le fichier voisin dit laquelle des décisions a été prise (§55.5.1).
    assert "api http */5 * * * * 3 200" in lire_cellule(client, nom, "/etc/spark/health")
    assert suggestions.vide("health", lire_cellule(client, nom, "/etc/spark/health.?")) is True


def test_une_ligne_refusable_refuse_tout_et_ne_consomme_pas_la_proposition(client):
    nom = creer(client)
    creer(client, "autre", "autre.example.com")
    texte = ("api http */5 * * * * 3 200 https://crm.example.com/healthz\n"
             "voisin http */5 * * * * 3 200 https://autre.example.com/\n")
    deposer(client, nom, texte)
    sha = {s["kind"]: s["sha256"] for s in client.get(f"/v1/sparks/{nom}/suggestions").json()["suggestions"]}["health"]
    r = client.post(f"/v1/sparks/{nom}/suggestions/health/apply", json={
        "sha256": sha, "entries": [sonde(), sonde(name="voisin", target="https://autre.example.com/")]})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "health_refused"
    assert "pas une route de ce Spark" in r.json()["detail"]["message"]
    # La première ligne, valide, n'est PAS à moitié acceptée.
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []
    # Et la proposition reste : son auteur peut la corriger (§55.5).
    assert suggestions.vide("health", lire_cellule(client, nom, "/etc/spark/health.?")) is False


def test_accepter_ne_retire_aucune_sonde_existante(client):
    nom = creer(client)
    corps = {k: v for k, v in sonde().items() if k != "name"}
    client.put(f"/v1/sparks/{nom}/health/ancienne", json=corps)
    deposer(client, nom, "api http */5 * * * * 3 200 https://crm.example.com/healthz\n")
    sha = {s["kind"]: s["sha256"] for s in client.get(f"/v1/sparks/{nom}/suggestions").json()["suggestions"]}["health"]
    client.post(f"/v1/sparks/{nom}/suggestions/health/apply", json={"sha256": sha, "entries": [sonde()]})
    assert sorted(c["name"] for c in client.get(f"/v1/sparks/{nom}/health").json()["checks"]) == ["ancienne", "api"]


def test_accepter_remplace_par_nom_une_sonde_deja_posee(client):
    nom = creer(client)
    client.put(f"/v1/sparks/{nom}/health/api", json={k: v for k, v in sonde().items() if k != "name"})
    deposer(client, nom, "api http */10 * * * * 5 200 https://crm.example.com/healthz\n")
    sha = {s["kind"]: s["sha256"] for s in client.get(f"/v1/sparks/{nom}/suggestions").json()["suggestions"]}["health"]
    client.post(f"/v1/sparks/{nom}/suggestions/health/apply",
                json={"sha256": sha, "entries": [sonde(schedule="*/10 * * * *", threshold=5)]})
    (api,) = client.get(f"/v1/sparks/{nom}/health").json()["checks"]
    assert (api["schedule"], api["threshold"]) == ("*/10 * * * *", 5)


def test_une_entree_qui_n_est_pas_une_sonde_est_refusee(client):
    nom = creer(client)
    deposer(client, nom, "api http */5 * * * * 3 200 https://crm.example.com/healthz\n")
    sha = {s["kind"]: s["sha256"] for s in client.get(f"/v1/sparks/{nom}/suggestions").json()["suggestions"]}["health"]
    assert client.post(f"/v1/sparks/{nom}/suggestions/health/apply",
                       json={"sha256": sha, "entries": ["n'importe quoi"]}).status_code == 422
    assert client.post(f"/v1/sparks/{nom}/suggestions/health/apply",
                       json={"sha256": sha, "entries": []}).status_code == 422     # rien à appliquer


def test_refuser_vide_le_fichier_sans_rien_poser(client):
    nom = creer(client)
    deposer(client, nom, "api http */5 * * * * 3 200 https://crm.example.com/healthz\n")
    sha = {s["kind"]: s["sha256"] for s in client.get(f"/v1/sparks/{nom}/suggestions").json()["suggestions"]}["health"]
    r = client.post(f"/v1/sparks/{nom}/suggestions/health/reject", json={"sha256": sha})
    assert r.status_code == 200 and r.json()["cleared"] is True
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []


# --- valider sans exécuter ni écrire -------------------------------------------------------------------------------

def test_valider_rend_la_definition_normalisee_sans_rien_ecrire(client):
    nom = creer(client)
    r = client.post(f"/v1/sparks/{nom}/health/validate", json={
        k: v for k, v in sonde(target="https://CRM.example.com/healthz").items() if k != "name"})
    assert r.status_code == 200 and r.json()["valid"] is True
    assert r.json()["target"] == "https://crm.example.com/healthz"
    assert client.get(f"/v1/sparks/{nom}/health").json()["checks"] == []


@pytest.mark.parametrize("modif, raison", [
    ({"target": "https://127.0.0.1:2019/"}, "port"),
    ({"target": "https://autre.example.com/"}, "pas une route de ce Spark"),
    ({"schedule": "*/2 * * * *"}, "5 minutes"),
    ({"threshold": 99}, "entre 1 et 20"),
])
def test_valider_refuse_ce_que_poser_refuserait(client, modif, raison):
    nom = creer(client)
    corps = {k: v for k, v in sonde(**modif).items() if k != "name"}
    r = client.post(f"/v1/sparks/{nom}/health/validate", json=corps)
    assert r.status_code == 422 and raison in r.json()["detail"]["message"]


def test_valider_n_est_pas_une_ecriture_donc_ouvert_sur_un_spark_protege(client):
    nom = creer(client)
    client.post(f"/v1/sparks/{nom}/protection", json={"password": "secret"})
    corps = {k: v for k, v in sonde().items() if k != "name"}
    assert client.post(f"/v1/sparks/{nom}/health/validate", json=corps).status_code == 200


def test_le_brief_nomme_health_point_interrogation_et_dit_la_grammaire_des_sondes():
    """Le brief énumère les paires depuis `PAIRES` : la septième y figure, et sa grammaire est dite."""
    from sparkd import briefing
    from test_briefing import _modele          # le modèle d'une cellule, tel que les preuves du brief le construisent
    texte = briefing.markdown(_modele("enracine"))
    assert "`/etc/spark/health.?` — Sondes de santé souhaitées ; ajoute ou remplace." in texte
    assert "`<nom> <type> <cadence> <seuil> <attendu> <cible…>` pour les sondes de santé" in texte
