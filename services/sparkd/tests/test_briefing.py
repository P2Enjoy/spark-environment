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
    # SPK-82 · §42.10.4 : une cellule complète a une clé accordée. Sans elle,
    # elle est fermée à tout le monde et l'amorçage a quelque chose à faire.
    assert client.post("/v1/ssh-keys", json={
        "label": "poste",
        "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+"
                      "fV4q3fR0CvBnyFDMmDcrFbYT poste"}).status_code == 201
    assert client.post(f"/v1/sparks/{name}/ssh-keys/poste").status_code == 200
    files = client.app.state.incus.created[name]["files"]
    client.app.state.incus.created[name].setdefault("runtime", {}).update({
        "sshd": "active", "openssh_version": "1:9.8p1-1",
        "os_id": "debian", "os_suite": "trixie",
        "depot_distro": "debian", "depot_suite": "trixie",
        "docker": "Docker version 29.7.2",
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


def test_le_briefing_rootless_nomme_le_compte_et_le_socket_sans_inventer_le_uid():
    spark = {
        "id": "spark-rootless", "name": "rootless", "ipv4_address": "10.77.0.42",
        "protected": False, "cpu_mode": "shared", "cpu_reservation": 0.5,
        "memory_reservation_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_reservation_bps": 10_000_000,
    }
    observed = {
        "observed_at": "2026-08-21T21:00:00+00:00", "openssh_version": "1:9",
        "docker_version": "5:29", "compose_version": "2.40",
        "docker_mode": "rootless", "managed_items": ["docker"],
    }
    model = briefing.modele(
        spark, forge_public_address="", routes=[], ports=[], environment=[],
        bootstrap=observed, written_at="2026-08-21T21:00:00+00:00")

    assert model["docker"] == {
        "mode": "rootless", "user": "spark-docker",
        "socket": "/run/user/<uid>/docker.sock",
        "socket_uid_source": "id -u spark-docker",
    }
    rendered = briefing.markdown(model)
    assert "Compte : spark-docker" in rendered
    assert "Socket : /run/user/<uid>/docker.sock" in rendered
    assert "/run/user/1000/docker.sock" not in rendered


# --- Le dossier de déploiement (SPK-85, docs/DAT.md §44.9) --------------------
#
# @verifies docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9.2 (ce qu'il porte de
#           plus), §44.9.3 (ce qu'il ne porte jamais), §44.9.4 (la surface d'API)
#
# Ces preuves portent sur ce que le texte DIT, parce que c'est tout ce que le
# produit livre ici : personne ne lit le modèle, on colle le Markdown.


def test_le_dossier_ne_porte_aucune_valeur_de_secret(tmp_path):
    """§44.9.3 : la propriété qui décide de tout. Ce texte est fait pour être
    collé dans une conversation avec un tiers ; un secret qui y entre est sorti."""
    client = _client(tmp_path)
    name = _spark(client)
    secret = "valeur-qui-ne-doit-jamais-etre-collee-4f21"
    assert client.put(f"/v1/sparks/{name}/env/SMTP_PASSWORD", json={
        "value": secret, "secret": True}).status_code == 200
    assert client.post(f"/v1/sparks/{name}/bootstrap").status_code == 200

    rendu = client.get(f"/v1/sparks/{name}/briefing")
    assert rendu.status_code == 200, rendu.text
    corps = rendu.json()
    assert secret not in corps["markdown"]
    assert secret not in json.dumps(corps["model"], ensure_ascii=False)
    # Le NOM y est, lui : c'est ce qui permet d'écrire la pile.
    assert "`SMTP_PASSWORD`" in corps["markdown"]


def test_le_dossier_donne_la_commande_ssh_avec_son_rebond(tmp_path):
    """§44.9.2 : le rebond est obligatoire, et sa cible n'est connue que de la
    console. Fournie, elle produit une ligne prête à coller."""
    client = _client(tmp_path)
    name = _spark(client)
    assert client.post(f"/v1/sparks/{name}/bootstrap").status_code == 200
    adresse = client.get(f"/v1/sparks/{name}").json()["ipv4_address"]

    corps = client.get(f"/v1/sparks/{name}/briefing",
                       params={"jump": "responsable@forge.example.test"}).json()
    assert f"ssh -J responsable@forge.example.test root@{adresse}" in corps["markdown"]
    # Le fragment ssh_config reste rendu à côté : les deux chemins mènent au même
    # endroit, et l'un des deux suppose un alias que l'autre n'exige pas.
    assert "ProxyJump spark-host" in corps["markdown"]


def test_un_rebond_non_reconnu_ne_produit_AUCUNE_commande(tmp_path):
    """§44.9.2 : cette valeur entre dans une ligne que quelqu'un collera dans un
    shell. On refuse ce qu'on ne reconnaît pas plutôt que de l'échapper."""
    client = _client(tmp_path)
    name = _spark(client)

    for piege in ("forge.test; rm -rf /", "$(id)", "a b", "forge.test'\"",
                  "-oProxyCommand=touch /tmp/x"):
        corps = client.get(f"/v1/sparks/{name}/briefing",
                           params={"jump": piege}).json()
        assert "ssh -J" not in corps["markdown"], piege
        assert piege not in corps["markdown"], piege
        assert "n'a pas pu être composée" in corps["markdown"]


def test_le_dossier_nomme_le_systeme_releve_et_le_port_attendu_par_la_route(tmp_path):
    """§44.9.2 : les deux faits qu'un agent ne peut trouver nulle part ailleurs —
    l'architecture des images à tirer, et le port que Caddy vise déjà."""
    client = _client(tmp_path)
    name = _spark(client)
    assert client.post(f"/v1/sparks/{name}/bootstrap").status_code == 200
    assert client.post("/v1/ingress", json={
        "spark": name, "domain": "app.example.test", "port": 8080, "tls": True,
    }).status_code == 201

    corps = client.get(f"/v1/sparks/{name}/briefing").json()
    systeme = corps["model"]["system"]
    assert systeme["os_id"] == "debian" and systeme["os_suite"] == "trixie"
    assert systeme["arch"]
    assert f"- Architecture : {systeme['arch']}" in corps["markdown"]
    assert "Distribution : debian trixie" in corps["markdown"]
    assert "la pile doit écouter sur **8080**" in corps["markdown"]
    # Les deux lignes sans lesquelles aucune variable n'atteint un conteneur.
    assert "env_file:" in corps["markdown"]
    assert f"      - {briefing.FICHIER_VARIABLES}" in corps["markdown"]
    assert f"      - {briefing.FICHIER_SECRETS}" in corps["markdown"]


def test_le_dossier_repond_sur_un_spark_ARRETE_et_jamais_amorce(tmp_path):
    """§44.9.4 : on prépare un déploiement AVANT de démarrer quoi que ce soit. La
    route ne lit que le registre, donc elle répond — en nommant ce qu'elle ignore."""
    client = _client(tmp_path)
    name = _spark(client, "endormi")
    assert client.post(f"/v1/sparks/{name}/stop").status_code == 200

    corps = client.get(f"/v1/sparks/{name}/briefing").json()
    assert corps["model"]["bootstrap"] is None
    assert corps["model"]["system"] is None
    assert "Amorçage jamais relevé" in corps["markdown"]
    assert "Non relevé" in corps["markdown"]
    # §14.6 : ne pas savoir n'est pas savoir que non. Le dossier ne prétend
    # aucune version, et ne déclare pas Docker absent non plus.
    assert "Aucun Docker utilisable n'a été relevé" in corps["markdown"]


def test_un_spark_sans_cellule_refuse_le_dossier_au_lieu_d_en_inventer_un(tmp_path):
    """§44.9.4 : sans cellule, il n'y a ni adresse ni accès. Un dossier rendu là
    décrirait un déploiement qui n'a nulle part où aller."""
    client = _client(tmp_path)
    assert client.post("/v1/sparks", json={
        "name": "declare", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO // 2,
        "storage_bytes": GIO, "network_bps": 10_000_000,
    }).status_code == 201

    refus = client.get("/v1/sparks/declare/briefing")
    assert refus.status_code == 409, refus.text
    assert refus.json()["detail"]["error"] == "no_instance"


def test_le_dossier_dit_l_absence_de_cle_parce_qu_elle_decide_de_la_connexion(tmp_path):
    """§44.9.2 et §14.5 : sans clé accordée, la commande ci-dessus échouera. Le
    taire ferait chercher une panne de réseau là où il n'y a qu'un accès manquant."""
    client = _client(tmp_path)
    name = _spark(client)

    sans = client.get(f"/v1/sparks/{name}/briefing").json()["markdown"]
    assert "Aucune clé n'est autorisée sur ce Spark" in sans

    assert client.post("/v1/ssh-keys", json={
        "label": "poste", "public_key":
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER",
    }).status_code == 201
    assert client.post(f"/v1/sparks/{name}/ssh-keys/poste").status_code == 200

    avec = client.get(f"/v1/sparks/{name}/briefing").json()["markdown"]
    assert "Aucune clé n'est autorisée" not in avec
    assert "- poste — `SHA256:" in avec


def test_une_console_servie_SUR_la_forge_donne_une_commande_directe(tmp_path):
    """§44.9.2 : depuis la Forge, il n'y a rien à sauter. Écrire un `-J` y
    désignerait un hôte déjà présent ; ne rien écrire priverait de la commande."""
    client = _client(tmp_path)
    name = _spark(client)
    adresse = client.get(f"/v1/sparks/{name}").json()["ipv4_address"]

    corps = client.get(f"/v1/sparks/{name}/briefing",
                       params={"direct": "true"}).json()
    assert f"ssh root@{adresse}" in corps["markdown"]
    assert "ssh -J" not in corps["markdown"]

    # Un rebond nommé PRIME : la console qui en donne un sait où elle est.
    avec = client.get(f"/v1/sparks/{name}/briefing",
                      params={"direct": "true", "jump": "forge.test"}).json()
    assert f"ssh -J forge.test root@{adresse}" in avec["markdown"]
