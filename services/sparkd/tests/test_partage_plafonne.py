"""@verifies docs/BACKLOG.md#SPK-152 · docs/DAT.md §7.2 quater (traduction, contrôles
de cohérence), §7.7 (l'admission compte la réservation), §49.8 (le plafond prend
effet au démarrage ; `ceiling`, `ceiling_in_force`, `ceiling_status`) ·
§44.2 (le briefing) · docs/SCHEMA.md §4

Le cinquième mode CPU porte une réservation ET un plafond. Ce qui se prouve ici,
sur le doublon et en processus : la traduction, les refus nommés, la
comptabilité, la relecture du plafond et son écart. Ce sont des diagnostics
(DAT §28.7) : que le plafond tienne réellement dans la tranche se constate sur
la VM du banc (épreuve `spk152-plafond`).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import cgroup, metrics
from sparkd.admission import Request
from sparkd.app import create_app
from sparkd.briefing import _cpu
from sparkd.config import load
from sparkd.translate import Manifest, TranslationError, translate

GIO = 1024**3
MBIT = 1_000_000


# --- la traduction ------------------------------------------------------------

def _manifest(**cpu) -> Manifest:
    return Manifest(name="api", image="images:debian/13", memory_bytes=GIO,
                    network_burst_bps=10 * MBIT, storage_bytes=5 * GIO, **cpu)


def test_la_traduction_est_celle_de_shared_plus_le_plafond_dans_raw_lxc():
    rendu = translate(_manifest(cpu_mode="shared-capped", cpu_reservation=0.5,
                                cpu_max=1.5), [0, 1, 2, 3], 4.0).config
    partage = translate(_manifest(cpu_mode="shared", cpu_reservation=0.5),
                        [0, 1, 2, 3], 4.0).config
    for cle in ("limits.cpu", "limits.cpu.allowance", "limits.cpu.priority"):
        assert rendu[cle] == partage[cle], cle
    assert rendu["raw.lxc"] == (
        "lxc.cgroup.dir.container = spark.slice/api\n"
        "lxc.cgroup.dir.monitor = spark.slice/monitor-api\n"
        "lxc.cgroup2.cpu.max = 150000 100000\n"
    )
    # Le mode `shared` garde ses deux lignes, et `cpu.max` à `max`.
    assert "cpu.max" not in partage["raw.lxc"]


@pytest.mark.parametrize("cpu", [
    {"cpu_reservation": 0.5}, {"cpu_max": 1.0},
])
def test_la_traduction_refuse_un_mode_incomplet(cpu):
    with pytest.raises(TranslationError, match="réservation ET un plafond"):
        translate(_manifest(cpu_mode="shared-capped", **cpu), [0, 1], 2.0)


# --- l'admission -------------------------------------------------------------

def test_l_admission_compte_la_reservation_pas_le_plafond():
    demande = Request(cpu_mode="shared-capped", memory_bytes=GIO, network_bps=MBIT,
                      storage_bytes=GIO, cpu_reservation=0.25, cpu_max=1.5)
    assert demande.cpu_pool_demand == 0.25


# --- le plafond relu ---------------------------------------------------------

def _cgroup(tmp_path, contenu: str | None):
    dossier = tmp_path / cgroup.SLICE / "api"
    dossier.mkdir(parents=True)
    if contenu is not None:
        (dossier / "cpu.max").write_text(contenu)
    return tmp_path


def test_le_plafond_relu_dit_max_comme_une_absence_de_plafond(tmp_path):
    assert cgroup.plafond_en_vigueur("api", _cgroup(tmp_path, "max 100000\n")) == (True, None)


def test_le_plafond_relu_se_rend_en_cpu(tmp_path):
    assert cgroup.plafond_en_vigueur("api", _cgroup(tmp_path, "150000 100000\n")) == (True, 1.5)


def test_un_cgroup_illisible_n_est_ni_un_plafond_ni_son_absence(tmp_path):
    assert cgroup.plafond_en_vigueur("api", _cgroup(tmp_path, None)) == (False, None)
    assert cgroup.plafond_en_vigueur("absent", tmp_path) == (False, None)


@pytest.mark.parametrize("promis, relu, statut", [
    (1.5, cgroup.PlafondRelu(True, 1.5), "applied"),
    (1.5, cgroup.PlafondRelu(True, None), "pending"),     # pas encore démarré
    (1.5, cgroup.PlafondRelu(True, 0.75), "pending"),     # l'ancien plafond
    (None, cgroup.PlafondRelu(True, 0.75), "pending"),    # retour à `shared`
    (None, cgroup.PlafondRelu(True, None), "applied"),
    (1.5, cgroup.PlafondRelu(False, None), "unread"),
    (1.5, None, "unread"),
])
def test_le_statut_compare_la_promesse_au_releve(promis, relu, statut):
    assert metrics.statut_du_plafond(promis, relu) == statut


# --- le briefing ---------------------------------------------------------------

def test_le_briefing_dit_le_plancher_et_le_plafond():
    rendu = _cpu({"cpu_mode": "shared-capped", "cpu_reservation": 0.5, "cpu_max": 1.5,
                  "cpu_cores": None})
    assert rendu["value"] == 0.5
    assert "plafond de 1.5 CPU" in rendu["semantic"]


# --- l'API : les refus nommés, la pose, la relecture -----------------------------

def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "r.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _coeurs_partages(client) -> int:
    return len(client.get("/v1/forge/cores").json()["shared"]["cores"])


def _creer(client, nom="api", **cpu):
    corps = {"name": nom, "image": "images:debian/13", "cpu_mode": "shared-capped",
             "cpu_reservation": 0.5, "cpu_max": 1.0, "memory_bytes": GIO,
             "storage_bytes": 5 * GIO, "network_bps": 10 * MBIT, **cpu}
    return client.post("/v1/sparks", json=corps)


def _demarre(client, nom="api", **cpu):
    assert _creer(client, nom, **cpu).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200


def _refus(reponse, champ):
    assert reponse.status_code == 422, reponse.text
    detail = reponse.json()["detail"]
    assert detail["error"] == "quota_incoherent"
    assert detail["field"] == champ
    return detail["message"]


def test_creer_puis_lire_le_mode(tmp_path):
    client = _client(tmp_path)
    assert _creer(client).status_code == 201
    spark = client.get("/v1/sparks/api").json()
    assert (spark["cpu_mode"], spark["cpu_reservation"], spark["cpu_max"]) == (
        "shared-capped", 0.5, 1.0)
    # L'admission a compté la réservation, pas le plafond.
    assert client.get("/v1/forge").json()["pools"]["cpu"]["allocated"] == 0.5


def test_un_plafond_sous_la_reservation_est_refuse_et_nomme(tmp_path):
    message = _refus(_creer(_client(tmp_path), cpu_reservation=1.0, cpu_max=0.5), "cpu_max")
    assert "sous la réservation" in message


def test_un_plafond_au_dela_des_coeurs_partages_est_refuse(tmp_path):
    client = _client(tmp_path)
    coeurs = _coeurs_partages(client)
    message = _refus(_creer(client, cpu_max=coeurs + 0.25), "cpu_max")
    assert f"{coeurs} cœurs" in message
    assert _creer(client, cpu_max=float(coeurs)).status_code == 201


def test_un_plafond_qui_ne_tombe_pas_sur_une_milliseconde_est_refuse(tmp_path):
    message = _refus(_creer(_client(tmp_path), cpu_max=1.234), "cpu_max")
    assert "0,01 CPU" in message


def test_sans_reservation_le_champ_nomme_est_la_reservation(tmp_path):
    _refus(_creer(_client(tmp_path), cpu_reservation=None), "cpu_reservation")


def test_rien_n_est_ecrit_sur_un_refus(tmp_path):
    client = _client(tmp_path)
    _creer(client, cpu_reservation=1.0, cpu_max=0.5)
    assert client.get("/v1/sparks/api").status_code == 404


def test_redimensionner_vers_le_mode_pose_le_plafond_dans_raw_lxc(tmp_path):
    client = _client(tmp_path)
    _demarre(client, cpu_mode="shared", cpu_max=None)

    rendu = client.patch("/v1/sparks/api", json={
        "cpu_mode": "shared-capped", "cpu_reservation": 0.5, "cpu_max": 0.75})

    assert rendu.status_code == 200, rendu.text
    config = client.app.state.incus.created["api"]["config"]
    assert "lxc.cgroup2.cpu.max = 75000 100000" in config["raw.lxc"]


def test_redimensionner_sous_la_reservation_est_refuse_sans_rien_ecrire(tmp_path):
    client = _client(tmp_path)
    _demarre(client)
    _refus(client.patch("/v1/sparks/api", json={"cpu_max": 0.25}), "cpu_max")
    assert client.get("/v1/sparks/api").json()["cpu_max"] == 1.0


@pytest.mark.parametrize("relu, statut, en_vigueur", [
    (cgroup.PlafondRelu(True, None), "pending", None),
    (cgroup.PlafondRelu(True, 1.0), "applied", 1.0),
    (cgroup.PlafondRelu(False, None), "unread", None),
])
def test_l_usage_publie_la_promesse_le_releve_et_l_ecart(tmp_path, monkeypatch, relu,
                                                        statut, en_vigueur):
    client = _client(tmp_path)
    _demarre(client)
    lus = []
    monkeypatch.setattr("sparkd.app.cgroup_service.plafond_en_vigueur",
                        lambda nom: lus.append(nom) or relu)

    cpu = client.get("/v1/sparks/api/usage").json()["cpu"]

    assert lus == ["api"], "le cgroup relu est celui de la cellule"
    assert cpu["ceiling"] == 1.0
    assert cpu["ceiling_in_force"] == en_vigueur
    assert cpu["ceiling_status"] == statut
    assert cpu["reservation"] == 0.5 and cpu["capped"] is False


def test_un_spark_arrete_ne_publie_aucun_releve(tmp_path, monkeypatch):
    client = _client(tmp_path)
    assert _creer(client).status_code == 201
    monkeypatch.setattr("sparkd.app.cgroup_service.plafond_en_vigueur",
                        lambda nom: pytest.fail("aucune relecture hors marche"))
    assert client.get("/v1/sparks/api/usage").json()["cpu"] is None
