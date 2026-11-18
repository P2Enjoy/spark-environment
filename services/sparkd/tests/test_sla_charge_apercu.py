"""L'aperçu du SLA dit où tombent les prises : le taux d'occupation de chaque prise.

@verifies docs/BACKLOG.md#SPK-189 · docs/DAT.md §74.14 (`load` : les AUTRES SLA qui prennent, celui du Spark exclu,
          taux relatif à la tranche la plus chargée de la semaine, débuts de prise), §76.3 bis (la charge de la
          semaine), §74.7 (l'aperçu est un calcul : rien n'est écrit)

Ce que ces preuves gardent : le chiffre montré au moment de CHOISIR un horaire est celui du planificateur — la même
sémantique de jour que `convient_jour`, la même tranche de 15 minutes que le graphe de la Forge — et le candidat ne
se compte jamais lui-même.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from sparkd import sla
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3
UTC = timezone.utc


def instant(texte: str) -> datetime:
    return datetime.fromisoformat(texte).replace(tzinfo=UTC)


MAINTENANT = instant("2026-11-19T10:00:00")


def charge(autres, *prises):
    return sla.charge_des_prises(autres, [instant(p) for p in prises], MAINTENANT)


# --- le calcul pur -------------------------------------------------------------------------------------


def test_sans_autre_SLA_le_zero_est_un_vrai_zero_et_ne_divise_pas():
    c = charge([], "2026-11-20T02:00:00")
    assert c["peak"] == 0 and c["slot_minutes"] == 15
    r = c["runs"][0]
    assert r["others"] == 0 and r["sparks"] == [] and r["rate"] == 0.0


def test_une_collision_exacte_est_nommee_et_vaut_cent_pour_cent_quand_c_est_le_pire_creneau():
    c = charge([("orphelin", "0 * * * *")], "2026-11-20T02:00:00", "2026-11-20T02:30:00")
    assert c["peak"] == 1
    assert (c["runs"][0]["others"], c["runs"][0]["sparks"], c["runs"][0]["rate"]) == (1, ["orphelin"], 1.0)
    assert (c["runs"][1]["others"], c["runs"][1]["rate"]) == (0, 0.0)


def test_la_tranche_est_de_quinze_minutes_ses_bornes_comprises_a_gauche():
    # tranche [02:00, 02:15) : 02:14 y est, 02:15 non
    dedans = charge([("a", "14 2 * * *")], "2026-11-20T02:00:00")["runs"][0]
    dehors = charge([("a", "15 2 * * *")], "2026-11-20T02:00:00")["runs"][0]
    assert dedans["others"] == 1 and dehors["others"] == 0
    # et la prise elle-même peut tomber n'importe où DANS sa tranche
    assert charge([("a", "0 2 * * *")], "2026-11-20T02:14:59")["runs"][0]["others"] == 1


def test_les_bornes_de_la_tranche_sont_rendues():
    r = charge([], "2026-11-20T02:37:12")["runs"][0]
    assert r["slot_start"].startswith("2026-11-20T02:30:00") and r["slot_end"].startswith("2026-11-20T02:45:00")


def test_deux_autres_SLA_dans_la_meme_tranche_s_additionnent():
    c = charge([("a", "0 2 * * *"), ("b", "5 2 * * *")], "2026-11-20T02:10:00")
    assert c["runs"][0]["others"] == 2 and c["runs"][0]["sparks"] == ["a", "b"]


def test_le_taux_est_relatif_a_la_tranche_la_plus_chargee_de_la_semaine():
    autres = [("a", "0 2 * * *"), ("b", "0 2 * * *"), ("c", "0 3 * * *")]
    c = charge(autres, "2026-11-20T02:00:00", "2026-11-20T03:00:00", "2026-11-20T04:00:00")
    assert c["peak"] == 2
    assert [r["rate"] for r in c["runs"]] == [1.0, 0.5, 0.0]


def test_un_SLA_hebdomadaire_ne_charge_que_son_jour_de_semaine():
    autres = [("dimanche", "0 3 * * 0")]
    lundi = charge(autres, "2026-11-23T03:00:00")["runs"][0]       # 2026-11-23 est un lundi
    dimanche = charge(autres, "2026-11-22T03:00:00")["runs"][0]    # 2026-11-22 est un dimanche
    assert lundi["others"] == 0 and dimanche["others"] == 1


def test_un_SLA_mensuel_charge_son_jour_de_mois_pas_une_moyenne():
    autres = [("mensuel", "0 3 1 * *")]
    assert charge(autres, "2026-12-01T03:00:00")["runs"][0]["others"] == 1
    assert charge(autres, "2026-12-02T03:00:00")["runs"][0]["others"] == 0


def test_le_taux_ne_depasse_jamais_cent_pour_cent():
    # une prise un jour de mois très chargé peut dépasser le pic de la SEMAINE courante : on borne.
    c = charge([("m1", "0 3 5 * *"), ("m2", "0 3 5 * *")], "2026-12-05T03:00:00")
    assert c["runs"][0]["others"] == 2 and c["runs"][0]["rate"] <= 1.0


# --- l'API, contre le vrai registre ---------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "c.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    return c


def _creer(client, nom):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared", "cpu_reservation": 0.25,
        "memory_bytes": GIO, "network_bps": 10_000_000, "storage_bytes": 10 * GIO}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def _sla(client, nom, schedule, **extra):
    r = client.put(f"/v1/sparks/{nom}/sla", json={
        "schedule": schedule, "retention_days": 7, "retention_count": 3, "enabled": True, **extra})
    assert r.status_code == 200, r.text


def _apercu(client, nom, schedule):
    r = client.post(f"/v1/sparks/{nom}/sla/preview", json={
        "schedule": schedule, "retention_days": 7, "retention_count": 3, "enabled": True})
    assert r.status_code == 200, r.text
    return r.json()


def test_l_apercu_rend_la_charge_de_chacune_des_trois_prises_dans_le_meme_ordre(client):
    _creer(client, "autre")
    _sla(client, "autre", "0 * * * *")
    nom = _creer(client, "moi")
    a = _apercu(client, nom, "0 2 * * *")
    assert len(a["next_runs"]) == 3 and len(a["load"]["runs"]) == 3
    assert [r["at"] for r in a["load"]["runs"]] == a["next_runs"]
    assert all(r["others"] == 1 and r["sparks"] == ["autre"] and r["rate"] == 1.0 for r in a["load"]["runs"])
    assert a["load"]["peak"] == 1 and a["load"]["slot_minutes"] == 15


def test_un_autre_horaire_hors_collision_dit_zero(client):
    _creer(client, "autre")
    _sla(client, "autre", "0 * * * *")
    nom = _creer(client, "moi")
    a = _apercu(client, nom, "30 2 * * *")
    assert all(r["others"] == 0 and r["rate"] == 0.0 for r in a["load"]["runs"])


def test_le_SLA_du_Spark_qu_on_edite_n_entre_pas_en_collision_avec_lui_meme(client):
    nom = _creer(client, "moi")
    _sla(client, nom, "0 2 * * *")
    a = _apercu(client, nom, "0 2 * * *")
    assert all(r["others"] == 0 for r in a["load"]["runs"]) and a["load"]["peak"] == 0


def test_un_SLA_suspendu_ne_charge_rien(client):
    _creer(client, "dort")
    _sla(client, "dort", "0 2 * * *")
    assert client.post("/v1/sparks/dort/sla/suspend").status_code == 200
    nom = _creer(client, "moi")
    a = _apercu(client, nom, "0 2 * * *")
    assert all(r["others"] == 0 for r in a["load"]["runs"]) and a["load"]["peak"] == 0


def test_l_apercu_n_ecrit_rien_ni_au_registre_ni_au_journal(client):
    _creer(client, "autre")
    _sla(client, "autre", "0 * * * *")
    nom = _creer(client, "moi")
    avant = client.get("/v1/audit", params={"limit": 200}).json()
    avant_sla = client.get(f"/v1/sparks/{nom}/sla").json()
    _apercu(client, nom, "0 2 * * *")
    apres = client.get("/v1/audit", params={"limit": 200}).json()
    assert apres == avant and client.get(f"/v1/sparks/{nom}/sla").json() == avant_sla
    assert avant_sla["configured"] is False
