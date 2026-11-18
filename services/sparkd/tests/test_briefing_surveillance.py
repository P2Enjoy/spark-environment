"""Le briefing d'un Spark dit la surveillance et les instantanés.

@verifies docs/BACKLOG.md#SPK-187 · docs/DAT.md §44.12 (les clés `health` et `snapshots`, les deux sections,
          la section « 7 bis » du dossier, la réécriture après chaque geste), §44.4 (un état se commande, il ne
          se copie pas), §44.6 (un fait, jamais une autorisation), §44.3 (rien du canal d'alerte), §75
          (les limites viennent des constantes du service), §74 (le SLA)

Ce que ces preuves gardent : un agent qui entre dans une cellule lit un briefing qui **nomme** la surveillance
déjà posée et ce qu'une sonde a le droit de faire — et qui ne ment pas : aucun état, qui périmerait avant
d'être lu, et rien d'un réglage de la Forge (webhook, SMTP).
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from sparkd import briefing, health
from sparkd.app import create_app
from sparkd.config import load

from test_briefing import _CELLULE, _RELEVE, _section

GIO = 1024**3

#: Une sonde TELLE QUE `health.lister` la rend : définition ET état. Le briefing ne doit garder que la
#: définition — c'est tout l'objet de la preuve « aucun état ».
SONDE_HTTP = {
    "name": "accueil", "kind": "http", "target": "https://crm.example.com/healthz", "expected": 200,
    "schedule": "*/5 * * * *", "description": "Toutes les 5 minutes (UTC)", "threshold": 3, "enabled": True,
    # --- l'état : à ne JAMAIS retrouver dans le briefing ---------------------------------------------
    "state": "down", "consecutive_failures": 7, "last_detail": "HTTP 503 (attendu 200)",
    "last_run_at": "2026-11-19T10:00:00+00:00", "results": [{"ok": False, "detail": "ETAT-PERIME"}],
}
SONDE_SCRIPT = {
    "name": "base", "kind": "script", "target": "pg_isready", "expected": 0, "schedule": "*/10 * * * *",
    "description": "Toutes les 10 minutes (UTC)", "threshold": 1, "enabled": True, "state": "healthy",
}
SLA = {"configured": True, "enabled": True, "schedule": "0 3 * * *", "retention_days": 7,
       "retention_count": 3, "description": "Tous les jours à 03:00 (UTC)",
       # l'état de la politique : à ne pas retrouver non plus
       "last_run_at": "2026-11-19T03:00:09+00:00", "last_status": "ok",
       "snapshots": {"count": 3, "size_bytes": 123456}}


def _modele(mode="enracine", *, sondes=None, sla=None):
    return briefing.modele(
        {**_CELLULE, "id": "s1", "docker_enabled": 1}, forge_public_address="", environment=[],
        routes=[], ports=[], bootstrap={**_RELEVE, "docker_mode": mode},
        surveillance=sondes, sla=sla)


def _bloc(texte):
    """La surveillance ET les instantanés, d'une présentation : du premier titre jusqu'à la section suivante."""
    debut = texte.index("Surveillance de ce Spark")
    fins = [texte.index(f, debut) for f in ("## Proposer un changement", "## 8. Pièges") if f in texte[debut:]]
    return texte[debut:min(fins)]


def _textes(model):
    return {"briefing": briefing.markdown(model), "dossier": briefing.dossier(model, jump=None)}


# --- le modèle : définitions et limites, jamais un état -------------------------------------------------


def test_le_modele_porte_les_limites_du_SERVICE_et_pas_une_seconde_copie():
    h = _modele()["health"]
    assert h["limits"] == {
        "max_checks": health.MAX_SONDES, "min_gap_minutes": health.ECART_MINUTES,
        "script_timeout_s": health.DELAI_SCRIPT, "threshold_min": health.SEUIL_MIN,
        "threshold_max": health.SEUIL_MAX}
    assert h["file"] == "/etc/spark/health" and h["proposals"] == "/etc/spark/health.?"


def test_le_compte_des_scripts_vient_du_mode_RELEVE_pas_de_la_ligne_du_Spark():
    """Le défaut mesuré sur spark-010 (SPK-184) : le mode vit dans l'observation d'amorçage."""
    assert _modele("rootless")["health"]["script_account"] == "spark-docker"
    assert _modele("enracine")["health"]["script_account"] == "root"
    jamais = briefing.modele({**_CELLULE, "id": "s1", "docker_enabled": 1}, forge_public_address="",
                             environment=[], routes=[], ports=[], bootstrap=None)
    assert jamais["health"]["script_account"] == "root"


def test_le_modele_ne_garde_que_la_DEFINITION_d_une_sonde():
    cles = {c for s in _modele(sondes=[SONDE_HTTP, SONDE_SCRIPT])["health"]["checks"] for c in s}
    assert cles == {"name", "kind", "target", "expected", "schedule", "description", "threshold", "enabled"}


def test_le_modele_ne_garde_que_la_POLITIQUE_du_SLA_jamais_son_etat():
    sla = _modele(sla=SLA)["snapshots"]["sla"]
    assert sla == {"enabled": True, "schedule": "0 3 * * *", "description": "Tous les jours à 03:00 (UTC)",
                   "retention_days": 7, "retention_count": 3}
    assert _modele()["snapshots"]["sla"] is None
    assert _modele(sla={"configured": False})["snapshots"]["sla"] is None
    s = _modele()["snapshots"]
    assert s["naming"] == "SLA_AAAAMMJJ-HHMMSS" and s["shares_disk_quota"] is True


# --- le rendu : le texte NOMME ce que l'agent doit savoir ----------------------------------------------


@pytest.mark.parametrize("presentation", ["briefing", "dossier"])
def test_les_deux_presentations_nomment_les_sondes_et_leurs_limites(presentation):
    texte = _textes(_modele(sondes=[SONDE_HTTP, SONDE_SCRIPT]))[presentation]
    assert "accueil" in texte and "https://crm.example.com/healthz" in texte
    assert "base" in texte and "pg_isready" in texte
    assert "Toutes les 5 minutes" in texte and "Toutes les 10 minutes" in texte
    for fait in ("cat /etc/spark/health", "/etc/spark/health.?", "60 s", "5 minutes", "20 sondes",
                 "code de sortie", "route TLS"):
        assert fait in texte, fait


def test_le_compte_des_scripts_est_dit_pour_la_cellule_rootless():
    assert "spark-docker" in _section(briefing.markdown(_modele("rootless", sondes=[SONDE_SCRIPT])),
                                      "## Surveillance de ce Spark", "\n## ")
    assert "spark-docker" not in _section(briefing.markdown(_modele("enracine", sondes=[SONDE_SCRIPT])),
                                          "## Surveillance de ce Spark", "\n## ")


@pytest.mark.parametrize("presentation", ["briefing", "dossier"])
def test_une_absence_est_NOMMEE_pas_un_silence(presentation):
    texte = _textes(_modele())[presentation]
    assert "Aucune sonde : rien ne surveille ce Spark" in texte
    assert "Aucun SLA" in texte


@pytest.mark.parametrize("presentation", ["briefing", "dossier"])
def test_les_instantanes_sont_dits_pour_ce_qu_ils_sont(presentation):
    texte = _textes(_modele(sla=SLA))[presentation]
    for fait in ("Tous les jours à 03:00", "7 jours", "3 instantanés", "SLA_AAAAMMJJ-HHMMSS", "quota disque",
                 "console"):
        assert fait in texte, fait
    assert "par la Forge" in texte


@pytest.mark.parametrize("presentation", ["briefing", "dossier"])
def test_AUCUN_etat_ne_figure_dans_le_texte_il_perimerait_avant_d_etre_lu(presentation):
    model = _modele(sondes=[SONDE_HTTP, SONDE_SCRIPT], sla=SLA)
    texte = _textes(model)[presentation]
    for perime in ("ETAT-PERIME", "HTTP 503", "consecutive_failures", "last_run_at", "123456", "healthy"):
        assert perime not in texte, perime
    brut = json.dumps(model)
    for perime in ("ETAT-PERIME", "HTTP 503", "consecutive_failures", "last_run_at", "123456", "last_status"):
        assert perime not in brut, perime


@pytest.mark.parametrize("presentation", ["briefing", "dossier"])
def test_rien_du_canal_d_alerte_n_est_dit_a_l_agent(presentation):
    """§44.3 : c'est un réglage de la Forge, pas une chose qu'un agent doit connaître ni pouvoir lire."""
    texte = _textes(_modele(sondes=[SONDE_HTTP], sla=SLA))[presentation]
    sections = _bloc(texte)
    for mot in ("webhook", "smtp", "courriel", "destinataire", "Discord", "Slack"):
        assert mot.lower() not in sections.lower(), mot


@pytest.mark.parametrize("presentation", ["briefing", "dossier"])
def test_le_texte_invite_a_proposer_sans_donner_une_permission(presentation):
    """§44.6 : « proposez » est une invitation à demander ; une proposition ne pose rien."""
    texte = _bloc(_textes(_modele())[presentation])
    assert "ne pose rien" in texte
    assert "autorisé" not in texte and "vous pouvez poser" not in texte


def test_le_dossier_place_la_section_7_bis_sans_renumeroter_les_autres():
    dossier = briefing.dossier(_modele(sondes=[SONDE_SCRIPT], sla=SLA), jump=None)
    ordre = [dossier.index(t) for t in (
        "## 7. Proposer un changement", "## 7 bis. Surveillance et instantanés",
        "## 8. Pièges connus", "## 9. Ce que ce dossier ne contient pas", "## 10. Avant de dire que c'est fini")]
    assert ordre == sorted(ordre), "7, 7 bis, 8, 9, 10 dans cet ordre, numérotation d'origine intacte"


def test_le_briefing_place_ses_sections_avant_le_canal_de_proposition():
    texte = briefing.markdown(_modele(sondes=[SONDE_SCRIPT], sla=SLA))
    assert (texte.index("## Surveillance de ce Spark") < texte.index("## Instantanés")
            < texte.index("## Proposer un changement"))


def test_aucune_valeur_de_secret_ne_traverse_ces_sections():
    sonde = {**SONDE_SCRIPT, "target": "curl -fs https://api.exemple.fr/ping"}
    texte = _textes(_modele(sondes=[sonde]))["briefing"]
    # une commande est une DÉFINITION lisible de /etc/spark/health ; aucune variable n'est interpolée
    assert "curl -fs https://api.exemple.fr/ping" in texte
    assert "$SMTP_PASSWORD" not in texte


# --- l'API, contre le vrai registre : le briefing suit chaque geste -------------------------------------


@pytest.fixture
def client(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "b.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    return c


def _creer(client, nom="crm"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared", "cpu_reservation": 0.25,
        "memory_bytes": GIO, "network_bps": 10_000_000, "storage_bytes": 10 * GIO}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def _dossier(client, nom):
    return client.get(f"/v1/sparks/{nom}/briefing").json()["markdown"]


def test_l_API_dit_une_absence_puis_la_sonde_puis_a_nouveau_l_absence(client):
    nom = _creer(client)
    assert "Aucune sonde : rien ne surveille ce Spark" in _dossier(client, nom)
    r = client.put(f"/v1/sparks/{nom}/health/base", json={
        "kind": "script", "target": "pg_isready", "expected": 0, "schedule": "*/5 * * * *", "threshold": 2})
    assert r.status_code == 200, r.text
    texte = _dossier(client, nom)
    assert "pg_isready" in texte and "Aucune sonde" not in texte
    assert client.delete(f"/v1/sparks/{nom}/health/base").status_code == 200
    assert "Aucune sonde : rien ne surveille ce Spark" in _dossier(client, nom)


def test_l_API_suit_le_SLA_programme_suspendu_et_retire(client):
    nom = _creer(client)
    assert "Aucun SLA" in _dossier(client, nom)
    r = client.put(f"/v1/sparks/{nom}/sla", json={
        "schedule": "0 3 * * *", "retention_days": 7, "retention_count": 3, "enabled": True})
    assert r.status_code == 200, r.text
    assert "Tous les jours à 03:00" in _dossier(client, nom)
    assert client.delete(f"/v1/sparks/{nom}/sla").status_code == 200
    assert "Aucun SLA" in _dossier(client, nom)


def _amorcer(client, nom):
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200


def _dans_la_cellule(client, nom):
    """Ce que la CELLULE (le doublon Incus) porte réellement dans `/etc/spark/BRIEFING.md`."""
    return client.app.state.incus.pull_file(nom, briefing.FICHIER_MARKDOWN) or ""


def test_la_cellule_recoit_un_briefing_reecrit_apres_CHAQUE_geste_de_sonde(client):
    nom = _creer(client)
    _amorcer(client, nom)
    assert "Aucune sonde : rien ne surveille ce Spark" in _dans_la_cellule(client, nom)
    assert client.put(f"/v1/sparks/{nom}/health/base", json={
        "kind": "script", "target": "pg_isready", "expected": 0, "schedule": "*/5 * * * *",
        "threshold": 2}).status_code == 200
    assert "pg_isready" in _dans_la_cellule(client, nom), "poser une sonde réécrit le briefing de la cellule"
    assert client.post(f"/v1/sparks/{nom}/health/base/suspend").status_code == 200
    assert "suspendue" in _dans_la_cellule(client, nom), "suspendre aussi"
    assert client.delete(f"/v1/sparks/{nom}/health/base").status_code == 200
    texte = _dans_la_cellule(client, nom)
    assert "pg_isready" not in texte and "Aucune sonde" in texte, "retirer aussi"


def test_la_cellule_recoit_un_briefing_reecrit_apres_CHAQUE_geste_de_SLA(client):
    nom = _creer(client)
    _amorcer(client, nom)
    assert "Aucun SLA" in _dans_la_cellule(client, nom)
    assert client.put(f"/v1/sparks/{nom}/sla", json={
        "schedule": "0 3 * * *", "retention_days": 7, "retention_count": 3, "enabled": True}).status_code == 200
    assert "Tous les jours à 03:00" in _dans_la_cellule(client, nom)
    assert client.post(f"/v1/sparks/{nom}/sla/suspend").status_code == 200
    assert "SUSPENDU" in _dans_la_cellule(client, nom)
    assert client.delete(f"/v1/sparks/{nom}/sla").status_code == 200
    assert "Aucun SLA" in _dans_la_cellule(client, nom)


def test_le_briefing_json_de_la_cellule_porte_les_deux_cles_sans_aucun_etat(client):
    nom = _creer(client)
    _amorcer(client, nom)
    client.put(f"/v1/sparks/{nom}/health/base", json={
        "kind": "script", "target": "pg_isready", "expected": 0, "schedule": "*/5 * * * *", "threshold": 2})
    brut = client.app.state.incus.pull_file(nom, briefing.FICHIER_JSON)
    modele = json.loads(brut)
    assert modele["health"]["checks"][0]["name"] == "base" and "state" not in modele["health"]["checks"][0]
    assert modele["snapshots"]["sla"] is None
