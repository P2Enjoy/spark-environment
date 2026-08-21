"""@verifies docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.1 (fichier lu sans shell),
             §44.3 (aucune valeur secrète), §44.4 (réécriture), §44.5 (pièges),
             §44.6 (donnée et non consigne), §44.8 (modèle unique) ·
             docs/SCHEMA.md §10 quinquies

Le point de ces preuves est l'absence : une valeur de secret est cherchée dans
CHAQUE projection. Vérifier seulement que le JSON dit « secret » laisserait la
fuite dans le Markdown — précisément le fichier qu'un agent copie hors de la
cellule.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from sparkd import briefing
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


def _client(tmp_path) -> TestClient:
    client = TestClient(create_app(load({
        "SPARKD_DB": str(tmp_path / "briefing.db"),
        "SPARKD_DRIVER": "fake",
        "SPARKD_FORGE_PUBLIC_ADDRESS": "forge.example.test",
    })))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _spark(client: TestClient, name: str = "agent") -> str:
    response = client.post("/v1/sparks", json={
        "name": name, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO,
        "storage_bytes": 5 * GIO, "network_bps": 10_000_000,
    })
    assert response.status_code == 201, response.text
    assert client.post(f"/v1/sparks/{name}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{name}/start").status_code == 200
    return name


def _briefing_files(client: TestClient, name: str) -> tuple[dict, str, str]:
    files = client.app.state.incus.created[name]["files"]
    return (
        json.loads(files[briefing.FICHIER_JSON]),
        files[briefing.FICHIER_MARKDOWN],
        files[briefing.FICHIER_MOTD],
    )


def test_le_briefing_n_expose_aucune_valeur_de_secret_dans_aucun_format(tmp_path):
    client = _client(tmp_path)
    name = _spark(client)
    secret = "ne-doit-jamais-sortir-du-spark-9d8c"

    response = client.put(f"/v1/sparks/{name}/env/SMTP_PASSWORD", json={
        "value": secret, "secret": True,
    })
    assert response.status_code == 200, response.text
    assert client.post(f"/v1/sparks/{name}/bootstrap").status_code == 200

    model, markdown, motd = _briefing_files(client, name)
    # Le Markdown est la présentation du JSON, pas une seconde écriture de faits.
    assert briefing.markdown(model) == markdown
    assert model["environment"]["secrets"] == ["SMTP_PASSWORD"]
    assert model["environment"]["variables"] == []
    assert model["forge"]["public_address"] == "forge.example.test"
    assert motd.splitlines() == [
        "Spark : agent", "Protection : non armée",
        f"Briefing : {briefing.FICHIER_MARKDOWN}",
    ]
    modes = client.app.state.incus.created[name]["file_modes"]
    assert modes[briefing.FICHIER_JSON] == "0600"
    assert modes[briefing.FICHIER_MARKDOWN] == "0600"
    assert modes[briefing.FICHIER_MOTD] == "0644"
    for projection in (json.dumps(model, ensure_ascii=False), markdown, motd):
        assert secret not in projection
        assert "SMTP_PASSWORD" in projection or projection == motd


def test_le_briefing_est_reecrit_apres_route_variable_port_et_protection(tmp_path):
    client = _client(tmp_path)
    name = _spark(client)
    assert client.post(f"/v1/sparks/{name}/bootstrap").status_code == 200

    assert client.put(f"/v1/sparks/{name}/env/LOG_LEVEL", json={
        "value": "debug", "secret": False,
    }).status_code == 200
    assert client.post("/v1/ingress", json={
        "spark": name, "domain": "app.example.test", "port": 8080, "tls": True,
    }).status_code == 201
    assert client.post("/v1/ports", json={
        "spark": name, "public_port": 2525, "target_port": 2525,
        "protocol": "tcp", "note": "SMTP entrant",
    }).status_code == 201
    assert client.post(f"/v1/sparks/{name}/protection", json={
        "password": "mot-de-passe-long-et-valide",
    }).status_code == 200

    model, markdown, motd = _briefing_files(client, name)
    assert briefing.markdown(model) == markdown
    assert model["spark"]["protected"] is True
    assert model["ingress"] == [{
        "domain": "app.example.test", "target_port": 8080,
        "tls": True, "enabled": True,
    }]
    assert model["published_ports"] == [{
        "public_port": 2525, "target_port": 2525,
        "protocol": "tcp", "note": "SMTP entrant",
    }]
    assert model["environment"]["variables"] == ["LOG_LEVEL"]
    assert "app.example.test → 8080" in markdown
    assert "tcp 2525 → 2525 — SMTP entrant" in markdown
    assert "Protection : armée" in motd


def test_une_presence_preexistante_ne_devient_pas_une_installation_par_sparkd(tmp_path):
    client = _client(tmp_path)
    name = _spark(client)
    files = client.app.state.incus.created[name]["files"]
    client.app.state.incus.created[name].setdefault("runtime", {}).update({
        "sshd": "active", "openssh_version": "1:9.8p1-1",
        "depot": "present", "docker": "Docker version 29.7.2",
        "docker_version": "5:29.7.2-1", "origine": "docker-ce",
        "compose": "Docker Compose version v2.40.0", "compose_version": "2.40.0-1",
        "mode": "enracine",
    })
    # Les clés déjà posées lors du démarrage font aussi partie de l'état complet.
    from sparkd import bootstrap  # noqa: PLC0415

    client.app.state.incus.created[name]["runtime"]["cles"] = bootstrap.empreinte(
        files["/root/.ssh/authorized_keys"])
    client.app.state.incus._persist()

    response = client.post(f"/v1/sparks/{name}/bootstrap")
    assert response.status_code == 200, response.text
    assert response.json()["changed"] is False, json.dumps(response.json(), ensure_ascii=False)
    model, markdown, _ = _briefing_files(client, name)
    assert model["bootstrap"]["managed_items"] == []
    assert "Modifiés par sparkd : aucun lors des relevés connus" in markdown
