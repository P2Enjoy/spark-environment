"""@verifies docs/BACKLOG.md#SPK-93 · docs/DAT.md §52.6 (les deux routes et leurs
bornes), §52.7 (l'agregat), §52.8 (a quoi chaque courbe se compare), §52.11 (les
deux surfaces) · §20.3 (le reseau se compare au PLAFOND) · docs/SCHEMA.md
§10 sexies

Preuves d'API : les routes que la console appelle, contre un vrai registre migre
et le pilote doublon. Ce qu'elles gardent, et qu'un test unitaire ne garderait
pas : la fenetre est VALIDEE a la frontiere, le refus NOMME ce qui est offert, et
la ligne de reference publiee est bien celle du §20.3 — le plafond reseau, jamais
la reservation.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load


def _app(tmp_path, **env):
    base = {"SPARKD_DB": str(tmp_path / "m.db"), "SPARKD_DRIVER": "fake"}
    base.update(env)
    app = create_app(load(base))
    client = TestClient(app)
    client.post("/v1/forge/sync")
    return client


def _spec(**champs):
    base = {
        "name": "crm-production", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": 2 * 1024**3,
        "network_bps": 100_000_000, "storage_bytes": 10 * 1024**3,
    }
    base.update(champs)
    return base


def _spark_en_marche(client, **champs):
    client.post("/v1/sparks", json=_spec(**champs))
    nom = _spec(**champs)["name"]
    client.post(f"/v1/sparks/{nom}/apply")
    client.post(f"/v1/sparks/{nom}/start")
    return nom


def _tic(client):
    """Un tic REEL de l'historien, par son propre chemin (pas d'insertion a la main)."""
    return client.app.state.historien.un_tic()


# --------------------------------------------------------------------------- #
# La route d'un Spark
# --------------------------------------------------------------------------- #

def test_la_route_d_un_spark_rend_une_serie_apres_deux_tics(tmp_path):
    client = _app(tmp_path)
    nom = _spark_en_marche(client)

    _tic(client)
    _tic(client)

    vu = client.get(f"/v1/sparks/{nom}/metrics?window=15m")
    assert vu.status_code == 200
    corps = vu.json()
    assert corps["spark"] == nom
    assert corps["enabled"] is True
    assert corps["last_sample_at"] is not None
    assert len(corps["series"]) == corps["window"]["points"]
    # Les deux relevés tombent dans le DERNIER seau : la fenêtre remonte le
    # passé, et le passé d'un Spark créé à l'instant est vide.
    portants = [p for p in corps["series"] if p["samples"] > 0]
    assert portants, "les deux tics doivent se retrouver quelque part"
    assert portants[-1]["memory_bytes"] is not None


def test_les_references_publiees_sont_celles_du_20_3(tmp_path):
    """§20.3 : le reseau se compare au PLAFOND, JAMAIS a la reservation que le
    noyau n'applique pas. Publier la reservation laisserait croire a une garantie
    qui n'existe pas."""
    client = _app(tmp_path)
    # Reservation et plafond DIFFERENTS : c'est la seule facon de prouver
    # laquelle des deux la route publie. Egales, l'assertion passerait sur la
    # mauvaise valeur sans que rien ne le signale.
    nom = _spark_en_marche(client, network_bps=100_000_000,
                           network_burst_bps=300_000_000)
    declare = client.get(f"/v1/sparks/{nom}").json()
    assert declare["network_burst_bps"] != declare["network_reservation_bps"]

    limites = client.get(f"/v1/sparks/{nom}/metrics").json()["limits"]

    assert limites["net_bps"] == declare["network_burst_bps"]
    assert limites["net_bps"] != declare["network_reservation_bps"]
    assert limites["cpu"] == declare["cpu_reservation"]
    assert limites["cpu_capped"] is False
    assert limites["memory_bytes"] == declare["memory_reservation_bytes"]
    assert limites["disk_bytes"] == declare["storage_bytes"]


def test_en_mode_capped_la_reference_CPU_devient_le_plafond(tmp_path):
    """Le mode `capped` est le SEUL ou un plafond est reellement pose (§7.2)."""
    client = _app(tmp_path)
    # Le registre refuse `cpu_reservation` en mode `capped` (SCHEMA §4) : les
    # deux grandeurs s'excluent, et la preuve doit poser un manifeste que le
    # produit accepte.
    nom = _spark_en_marche(client, cpu_mode="capped", cpu_max=1.5,
                           cpu_reservation=None)

    limites = client.get(f"/v1/sparks/{nom}/metrics").json()["limits"]

    assert limites["cpu"] == 1.5
    assert limites["cpu_capped"] is True


def test_un_spark_ARRETE_a_des_seaux_qui_NOMMENT_l_arret(tmp_path):
    """§52.4, SPK-DS-03 : « arrete » et « personne n'a releve » font le meme trou
    a l'ecran, et ne veulent pas du tout dire la meme chose."""
    client = _app(tmp_path)
    client.post("/v1/sparks", json=_spec())
    client.post("/v1/sparks/crm-production/apply")  # la cellule existe, a l'arret

    _tic(client)

    serie = client.get("/v1/sparks/crm-production/metrics").json()["series"]
    portants = [p for p in serie if p["samples"] > 0]
    assert portants, "un Spark arrete produit une LIGNE, pas rien"
    assert portants[-1]["states"] == ["stopped"]
    assert portants[-1]["cpu"] is None
    assert portants[-1]["memory_bytes"] is None


def test_un_spark_inconnu_rend_404(tmp_path):
    client = _app(tmp_path)
    vu = client.get("/v1/sparks/fantome/metrics")
    assert vu.status_code == 404
    assert vu.json()["detail"]["error"] == "not_found"


# --------------------------------------------------------------------------- #
# Les bornes de fenêtre
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("requete", [
    "?window=30m", "?window=1j", "?points=0", f"?points=100000",
])
def test_une_fenetre_hors_bornes_est_REFUSEE_et_le_refus_NOMME_ce_qui_existe(
        tmp_path, requete):
    client = _app(tmp_path)
    _spark_en_marche(client)

    vu = client.get(f"/v1/sparks/crm-production/metrics{requete}")

    assert vu.status_code == 422
    detail = vu.json()["detail"]
    assert detail["error"] == "fenetre_invalide"
    # Un refus qui n'enumere pas ce qu'il accepte oblige a lire le code.
    assert "15m" in detail["windows"] and "7d" in detail["windows"]


def test_la_meme_borne_vaut_pour_la_route_de_la_forge(tmp_path):
    client = _app(tmp_path)
    vu = client.get("/v1/forge/metrics?window=1an")
    assert vu.status_code == 422
    assert vu.json()["detail"]["error"] == "fenetre_invalide"


def test_le_pas_de_seau_est_PUBLIE_avec_la_serie(tmp_path):
    """§52.6 regle 3 : une valeur agregee sans son pas n'est pas interpretable."""
    client = _app(tmp_path)
    _spark_en_marche(client)

    fenetre = client.get(
        "/v1/sparks/crm-production/metrics?window=1h&points=60").json()["window"]

    assert fenetre["name"] == "1h"
    assert fenetre["points"] == 60
    assert fenetre["bucket_seconds"] == 60.0


def test_les_points_demandes_sont_PLAFONNES_par_la_cadence(tmp_path):
    """Sinon la courbe serait pointillee sans qu'aucune mesure ne manque."""
    client = _app(tmp_path, SPARKD_METRICS_INTERVAL="15s")
    _spark_en_marche(client)

    fenetre = client.get(
        "/v1/sparks/crm-production/metrics?window=15m&points=240").json()["window"]

    assert fenetre["points"] == 60
    assert fenetre["bucket_seconds"] == 15.0


# --------------------------------------------------------------------------- #
# La route de la Forge
# --------------------------------------------------------------------------- #

def test_la_forge_rend_l_agregat_ET_la_repartition_par_spark(tmp_path):
    client = _app(tmp_path)
    _spark_en_marche(client)
    _spark_en_marche(client, name="site-vitrine")
    _tic(client)
    _tic(client)

    corps = client.get("/v1/forge/metrics?window=15m").json()

    assert len(corps["total"]) == corps["window"]["points"]
    noms = sorted(s["spark"] for s in corps["sparks"])
    assert noms == ["crm-production", "site-vitrine"]
    # La repartition par Spark est une MICRO-courbe : moins de points, parce
    # qu'une ligne de tableau ne porte pas deux cent quarante points.
    assert corps["spark_points"] <= corps["window"]["points"]
    assert len(corps["sparks"][0]["series"]) == corps["spark_points"]


def test_chaque_seau_de_l_agregat_dit_COMBIEN_de_sparks_il_somme(tmp_path):
    """§52.7 : une somme dont le nombre de termes varie change de marche sans
    que rien n'ait bouge dans la machine."""
    client = _app(tmp_path)
    _spark_en_marche(client)
    _tic(client)
    _tic(client)

    total = client.get("/v1/forge/metrics?window=15m").json()["total"]

    portants = [p for p in total if p["samples"] > 0]
    assert portants and portants[-1]["sparks"] == 1
    assert all(p["sparks"] == 0 and p["cpu"] is None
               for p in total if p["samples"] == 0)


def test_les_references_de_la_forge_sont_ses_POOLS(tmp_path):
    """§52.8 : une courbe sans sa ligne de reference est un chiffre faux."""
    client = _app(tmp_path)
    pools = client.get("/v1/forge").json()["pools"]

    limites = client.get("/v1/forge/metrics").json()["limits"]

    assert limites["cpu"] == pools["cpu"]["capacity"]
    assert limites["memory_bytes"] == pools["memory"]["capacity"]
    assert limites["disk_bytes"] == pools["storage"]["capacity"]
    assert limites["net_bps"] > 0


# --------------------------------------------------------------------------- #
# L'historien désactivé
# --------------------------------------------------------------------------- #

def test_une_cadence_NULLE_se_DIT_au_lieu_de_rendre_un_ecran_vide(tmp_path):
    """§14.5, §52.2 : c'est une configuration, pas une panne. L'ecran doit
    pouvoir ecrire « supervision desactivee sur cette Forge » plutot que de
    tracer un graphique vide sans dire pourquoi."""
    client = _app(tmp_path, SPARKD_METRICS_INTERVAL="0")
    _spark_en_marche(client)

    forge = client.get("/v1/forge/metrics").json()
    spark = client.get("/v1/sparks/crm-production/metrics").json()

    assert forge["enabled"] is False and spark["enabled"] is False
    assert forge["interval_seconds"] == 0
    assert forge["last_sample_at"] is None
    # La route repond quand meme : c'est l'ECRAN qui nomme, pas une erreur HTTP.
    assert forge["total"] and spark["series"]


def test_la_retention_est_PUBLIEE_pour_que_l_ecran_borne_ses_fenetres(tmp_path):
    client = _app(tmp_path, SPARKD_METRICS_RETENTION="24h")
    assert client.get("/v1/forge/metrics").json()["retention_seconds"] == 86400
