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
    # SPK-94 · §44.1, §42.2 quater : la troisième ligne est IMPÉRATIVE. Elle
    # nommait un chemin sans dire qu'il fallait l'ouvrir, sous le bandeau de la
    # distribution — ni un humain ni un agent n'y voyait une instruction.
    assert motd.splitlines() == [
        "Spark : agent", "Protection : non armée",
        f"Lisez d'abord {briefing.FICHIER_MARKDOWN} : quotas réels, contexte "
        "Docker, variables d'environnement et pièges connus.",
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
    # SPK-101 · §44.2 ter : chaque entrée porte désormais le fait qui décide
    # qu'elle aboutira — ici `False`, la cellule n'étant pas relevée rootless et
    # les deux ports visés étant au-dessus de 1024.
    assert model["ingress"] == [{
        "domain": "app.example.test", "target_port": 8080,
        "tls": True, "enabled": True, "blocked_by_rootless": False,
    }]
    assert model["published_ports"] == [{
        "public_port": 2525, "target_port": 2525,
        "protocol": "tcp", "note": "SMTP entrant", "blocked_by_rootless": False,
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
        # SPK-94 · §42.2 quater : une cellule deja amorcee n'a plus le bandeau
        # de sa distribution, sinon l'amorcage aurait encore a le taire.
        "motd_distro": "absent",
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
        # SPK-98 · §42.13 : « pas encore relevé » et « n'en aura jamais »
        # rendaient tous deux `mode: None`. Un agent qui lit ce fichier ne
        # pouvait pas savoir s'il devait amorcer ou renoncer.
        "supported": True,
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


#: La forme minimale d'une ligne de `spark` telle que le briefing la lit.
_CELLULE = {
    "name": "sans-docker", "ipv4_address": "10.77.0.30", "protected": False,
    "cpu_mode": "shared", "cpu_reservation": 0.5,
    "memory_reservation_bytes": GIO, "storage_bytes": 5 * GIO,
    "network_reservation_bps": 10_000_000,
}


def test_une_cellule_SANS_Docker_le_dit_au_lieu_d_envoyer_amorcer(tmp_path):
    """SPK-98 · §42.13, SPK-DS-24 — « pas relevé » n'est pas « jamais ».

    @verifies docs/BACKLOG.md#SPK-98 · docs/DAT.md §42.13 ·
              docs/DESIGN_SYSTEM_APP.md SPK-DS-24

    Trouvé À L'ÉCRAN, sur une cellule Alpine réelle, en ouvrant le terminal : le
    panneau d'accueil promettait un « contexte Docker » à qui entre, et le
    briefing répondait « Docker n'a pas été relevé comme utilisable » — ce qui
    envoie amorcer une cellule qui n'aura jamais de Docker.
    """
    model = briefing.modele(
        {**_CELLULE, "docker_enabled": 0},
        forge_public_address="", routes=[], ports=[], environment=[],
        bootstrap={"observed_at": "2026-09-08T01:00:00+00:00",
                   "os_id": "alpine", "os_suite": "", "arch": "x86_64",
                   "openssh_version": "9.9p2", "docker_version": None,
                   "compose_version": None, "docker_mode": None,
                   "managed_items": ["sshd"]})
    assert model["docker"]["supported"] is False

    texte = briefing.markdown(model)
    assert "n'en aura pas" in texte
    assert "Docker n'a pas été relevé comme utilisable" not in texte
    # Le §41.2 reste dit, mais LÀ où il concerne le lecteur.
    assert "AppArmor" in texte
    assert not any("Docker" in p for p in model["pitfalls"]), (
        "le piège du dépôt amont ne s'adresse qu'à qui peut en installer un")

    # Le panneau d'accueil ne promet plus ce que le fichier ne contient pas.
    assert "contexte Docker" not in briefing.motd(model)
    assert "quotas réels" in briefing.motd(model)


def test_une_cellule_AVEC_Docker_garde_son_contexte(tmp_path):
    """Le garde-fou : retirer ne doit pas déborder."""
    model = briefing.modele(
        {**_CELLULE, "docker_enabled": 1},
        forge_public_address="", routes=[], ports=[], environment=[],
        bootstrap={"observed_at": "2026-09-08T01:00:00+00:00",
                   "os_id": "debian", "os_suite": "trixie", "arch": "x86_64",
                   "openssh_version": "1:9", "docker_version": "5:29",
                   "compose_version": "2.40", "docker_mode": "enracine",
                   "managed_items": ["docker"]})
    assert model["docker"]["supported"] is True
    assert "## Contexte Docker relevé" in briefing.markdown(model)
    assert "contexte Docker" in briefing.motd(model)
    assert any("Docker" in p for p in model["pitfalls"])


# --- SPK-99 · §44.9.2 point 4 et §44.9.7 : ce que le dossier dit à un agent ---


def test_le_dossier_nomme_le_briefing_et_donne_la_ligne_qui_le_lit_sans_shell(tmp_path):
    """§44.9.2 point 4 : `ssh hôte 'commande'` n'ouvre aucun shell, donc n'affiche
    aucun `motd` — et c'est le `motd` qui porte l'instruction de lire le briefing.

    @verifies docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.2 (point 4), §44.1
    """
    client = _client(tmp_path)
    name = _spark(client)
    assert client.post(f"/v1/sparks/{name}/bootstrap").status_code == 200
    adresse = client.get(f"/v1/sparks/{name}").json()["ipv4_address"]

    texte = client.get(f"/v1/sparks/{name}/briefing",
                       params={"jump": "responsable@forge.example.test"}).json()["markdown"]
    assert briefing.FICHIER_MARKDOWN in texte
    assert (f"ssh -J responsable@forge.example.test root@{adresse} "
            f"'cat {briefing.FICHIER_MARKDOWN}'") in texte
    # Le FAIT est dit même là où la commande ne l'est pas : c'est lui qui décide
    # qu'on ouvre le fichier, la commande n'est qu'un raccourci.
    assert "n'affiche donc aucun `motd`" in texte


def test_un_rebond_refuse_ne_produit_pas_davantage_la_ligne_de_LECTURE(tmp_path):
    """§44.9.2 : la ligne de lecture emploie le même rebond validé. Une cible
    piégée ne doit pas trouver dans ce second usage la sortie qu'on lui ferme
    dans le premier.

    @verifies docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.2
    """
    client = _client(tmp_path)
    name = _spark(client)

    for piege in ("forge.test; rm -rf /", "$(id)", "-oProxyCommand=touch /tmp/x"):
        texte = client.get(f"/v1/sparks/{name}/briefing",
                           params={"jump": piege}).json()["markdown"]
        assert f"cat {briefing.FICHIER_MARKDOWN}'" not in texte, piege
        assert piege not in texte, piege
        # Le fait reste dit : il ne dépend pas d'une cible de rebond.
        assert briefing.FICHIER_MARKDOWN in texte, piege


def test_le_dossier_dit_que_la_cellule_n_est_PAS_la_voie_pour_une_variable(tmp_path):
    """§44.9.7 : l'agent est root, les deux fichiers sont là, et les écrire ne
    sert à rien — le §43.2 les régénère en entier, le §43.5.2 repose le tmpfs.
    Le dossier nomme la seule voie, et la forme que la console accepte.

    @verifies docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.7, §43.2, §43.5.2,
              §43.10.1 (la grammaire du lot), §43.3 (le secret se déclare)
    """
    client = _client(tmp_path)
    name = _spark(client)
    texte = client.get(f"/v1/sparks/{name}/briefing").json()["markdown"]

    assert "ne sert à rien" in texte
    assert "Seul le propriétaire du Spark peut poser une variable" in texte
    assert "Importer un lot" in texte
    # La FORME, sans aucun nom de variable inventé pour le locataire (§44.7).
    assert "```dotenv" in texte
    assert "NOM_DE_VARIABLE=valeur" in texte
    # Les quatre points qui décident qu'un bloc passe du premier coup.
    assert "aucune valeur multiligne" in texte
    assert "`$` est **littéral**" in texte
    assert "en **début** de ligne" in texte
    assert "il ne retire jamais" in texte
    # §43.3 : le produit ne devine jamais un secret d'après son nom.
    assert "lesquelles sont des secrets" in texte


def test_le_dossier_dit_le_VIDE_et_l_ETIQUETTE_d_une_demande(tmp_path):
    """SPK-107 · §55.3.3, §55.7 : l'agent qui ignore une valeur n'avait que deux
    gestes, mauvais tous les deux — inventer un remplissage, ou se taire. Le
    dossier lui donne la forme, et la MONTRE plutôt que de la décrire.

    @verifies docs/BACKLOG.md#SPK-107 · docs/DAT.md §55.3.3, §55.7, §44.9.7
    """
    client = _client(tmp_path)
    name = _spark(client)
    texte = client.get(f"/v1/sparks/{name}/briefing").json()["markdown"]

    assert "se laisse VIDE" in texte
    assert "N'inventez pas de valeur de remplissage" in texte
    assert "juste au-dessus" in texte
    assert "120 caractères" in texte
    # Montrée, pas décrite : le bloc d'exemple porte les deux gestes.
    assert "BILLING_API_KEY=" in texte
    # §44.7 : aucun nom de variable inventé POUR le locataire. Ceux-ci sont des
    # exemples de forme, dans un bloc de code, et le texte ne prétend pas que
    # cette pile-ci en a besoin.
    assert "Clé d'API du fournisseur de facturation" in texte


def test_les_ajouts_du_SPK_99_n_ouvrent_aucune_fuite_de_valeur(tmp_path):
    """Le garde-fou du §44.9.3, rejoué sur le texte augmenté : un dossier qui
    parle de variables est précisément celui où une valeur pourrait se glisser.

    @verifies docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.3
    """
    client = _client(tmp_path)
    name = _spark(client)
    secret = "valeur-que-le-bloc-dotenv-ne-doit-pas-porter-7b3e"
    ordinaire = "valeur-ordinaire-qui-ne-sort-pas-non-plus-2c19"
    assert client.put(f"/v1/sparks/{name}/env/SMTP_PASSWORD", json={
        "value": secret, "secret": True}).status_code == 200
    assert client.put(f"/v1/sparks/{name}/env/APP_NAME", json={
        "value": ordinaire, "secret": False}).status_code == 200

    texte = client.get(f"/v1/sparks/{name}/briefing").json()["markdown"]
    assert secret not in texte
    # Même une valeur NON secrète reste hors du texte : le §44.3 ne fait pas de
    # distinction, et le bloc d'exemple ne doit pas devenir un export déguisé.
    assert ordinaire not in texte
    assert "`SMTP_PASSWORD`" in texte and "`APP_NAME`" in texte


# --- SPK-101 · §44.2 bis et ter : le chemin par lequel on vous atteint --------

_RELEVE = {"observed_at": "2026-09-14T09:00:00+00:00", "os_id": "ubuntu",
           "os_suite": "resolute", "arch": "x86_64", "openssh_version": "1:10",
           "docker_version": "5:29", "compose_version": "5.5",
           "managed_items": ["docker"]}


def _modele(mode: str, *, routes=(), ports=()):
    """Le modèle d'une cellule dont on choisit le MODE et ce qui la vise."""
    return briefing.modele(
        {**_CELLULE, "id": "s1", "docker_enabled": 1},
        forge_public_address="", environment=[],
        routes=[{"spark_id": "s1", **r} for r in routes],
        ports=[{"spark_id": "s1", **p} for p in ports],
        bootstrap={**_RELEVE, "docker_mode": mode})


def test_une_route_vers_un_port_privilegie_est_NOMMEE_inservable_en_rootless(tmp_path):
    """§44.2 ter : le cas réel du 2026-09-14, sur lequel un agent a inventé.

    @verifies docs/BACKLOG.md#SPK-101 · docs/DAT.md §44.2 ter, §42 (le rootless
              interdit un port privilégié dans la cellule)

    Le texte disait « écoutez sur 443 » ET « aucun port sous 1024 ne se publie ».
    Deux phrases vraies dont aucune ne nommait l'autre : l'agent a bâti une
    procédure autour du conflit au lieu de buter dessus.
    """
    model = _modele("rootless", routes=[
        {"domain": "oauth.lelabs.tech", "target_port": 443, "tls": 1, "enabled": 1}])

    assert model["ingress"][0]["blocked_by_rootless"] is True
    for texte in (briefing.markdown(model), briefing.dossier(model, jump=None)):
        assert "INSERVABLE" in texte or "n'aboutira pas en l'état" in texte
    # Le dossier dit AUSSI quoi faire, et que le contournement n'existe pas.
    dossier = briefing.dossier(model, jump=None)
    assert "changer le port cible de la route" in dossier
    assert "pas de contournement" in dossier


def test_la_MEME_route_sur_une_cellule_ENRACINEE_ne_bloque_rien(tmp_path):
    """Le garde-fou : c'est le MODE qui décide, pas le numéro de port seul."""
    model = _modele("enracine", routes=[
        {"domain": "oauth.lelabs.tech", "target_port": 443, "tls": 1, "enabled": 1}])

    assert model["ingress"][0]["blocked_by_rootless"] is False
    assert "INSERVABLE" not in briefing.markdown(model)
    assert "n'aboutira pas" not in briefing.dossier(model, jump=None)


def test_un_port_publie_vers_une_cible_privilegiee_est_nomme_de_meme(tmp_path):
    """§44.2 ter : c'est le port CIBLE qui décide, jamais le port public.

    La Forge écoute `25` sans difficulté ; c'est l'ouvrir DANS la cellule qui est
    impossible. Juger sur le port public dirait l'inverse de la vérité.
    """
    model = _modele("rootless", ports=[
        {"public_port": 2525, "target_port": 25, "protocol": "tcp", "note": None}])
    assert model["published_ports"][0]["blocked_by_rootless"] is True
    assert "INSERVABLE" in briefing.markdown(model)

    # Le port PUBLIC bas ne suffit pas à bloquer : la Forge n'est pas rootless.
    autre = _modele("rootless", ports=[
        {"public_port": 25, "target_port": 2525, "protocol": "tcp", "note": None}])
    assert autre["published_ports"][0]["blocked_by_rootless"] is False


def test_le_dossier_dit_QUI_termine_le_TLS_et_qu_aucun_port_n_est_a_demander(tmp_path):
    """§44.2 bis : la phrase qui manquait, et qui a coûté une procédure inventée.

    @verifies docs/BACKLOG.md#SPK-101 · docs/DAT.md §44.2 bis, §9 (un Caddy
              unique détient l'exposition publique), §39.1 (ce qui n'a besoin
              d'aucun port publié)
    """
    dossier = briefing.dossier(_modele("rootless", routes=[
        {"domain": "app.exemple.test", "target_port": 8080, "tls": 1, "enabled": 1}]),
        jump=None)

    assert "termine le TLS" in dossier
    # SPK-112 · §44.2 bis : la pile sert « en HTTP simple ». « En clair » est le
    # mot de la grammaire des routes qui publie un site en `http://`.
    assert "en HTTP simple" in dossier
    assert "ne demande aucun port publié" in dossier
    # Et le cas où un port publié sert VRAIMENT, sans quoi on aurait remplacé une
    # erreur par une autre.
    assert "SMTP" in dossier and "Postgres" in dossier


def test_le_dossier_donne_les_trois_faits_d_exploitation(tmp_path):
    """§44.2 bis : réseau sortant, ce qui relance la pile, où vivent les données.

    Chacun ne se découvre qu'en échouant, après avoir écrit la pile.
    """
    dossier = briefing.dossier(_modele("rootless"), jump=None)
    assert "docker pull` aboutit" in dossier
    assert "linger" in dossier and "restart:" in dossier
    assert "Un seul disque" in dossier

    # En enraciné, la même phrase nomme l'unité, pas le linger.
    enracine = briefing.dossier(_modele("enracine"), jump=None)
    assert "`docker.service` est activé" in enracine
    assert "linger" not in enracine


def test_une_cellule_SANS_Docker_ne_promet_ni_pull_ni_redemarrage(tmp_path):
    """Ces deux faits parlent d'un démon. Les dire sans démon serait mentir."""
    model = briefing.modele(
        {**_CELLULE, "id": "s1", "docker_enabled": 0},
        forge_public_address="", routes=[], ports=[], environment=[],
        bootstrap={**_RELEVE, "docker_mode": None, "docker_version": None,
                   "compose_version": None})
    dossier = briefing.dossier(model, jump=None)
    assert "docker pull" not in dossier
    assert "restart:" not in dossier


# --- SPK-102 · §44.2 quater et quinquies : ce que TLS implique, qui filtre quoi -

_COMPORTEMENT = {
    "handlers": ["reverse_proxy"],
    "forwarded_headers": ["X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"],
    "preserve_host": True, "adds_headers": False,
}


def _avec_route(tls: int, comportement=None):
    return briefing.modele(
        {**_CELLULE, "id": "s1", "docker_enabled": 1},
        forge_public_address="", environment=[], ports=[],
        routes=[{"spark_id": "s1", "domain": "app.exemple.test",
                 "target_port": 8443, "tls": tls, "enabled": 1}],
        bootstrap={**_RELEVE, "docker_mode": "rootless"},
        ingress_behaviour=_COMPORTEMENT if comportement is None else comportement)


def test_une_route_TLS_dit_son_origine_publique_en_https(tmp_path):
    """§44.2 quater : le briefing donnait `(TLS, active)`, un fait, et s'arrêtait.

    @verifies docs/BACKLOG.md#SPK-102 · docs/DAT.md §44.2 quater, §18.3

    Un agent réel a dû reconstruire seul que le schéma public était `https` et
    que la cellule ne voyait jamais de TLS.
    """
    model = _avec_route(tls=1)
    for texte in (briefing.markdown(model), briefing.dossier(model, jump=None)):
        assert "https://app.exemple.test" in texte
    dossier = briefing.dossier(model, jump=None)
    assert "votre application doit connaître" in dossier
    assert "émet des URL en `http://`" in dossier


def test_une_route_SANS_TLS_ne_pretend_pas_l_inverse(tmp_path):
    """§18.3 : une route `tls = 0` n'est servie qu'en clair sur `:80`.

    Le garde-fou : écrire `https` partout serait plus commode et faux.
    """
    model = _avec_route(tls=0)
    for texte in (briefing.markdown(model), briefing.dossier(model, jump=None)):
        assert "http://app.exemple.test" in texte
        assert "https://app.exemple.test" not in texte


def test_ce_que_l_ingress_applique_est_CALCULE_et_non_ecrit_en_dur(tmp_path):
    """§44.2 quater : « calculé sur la Forge », exigence du responsable.

    @verifies docs/BACKLOG.md#SPK-102 · docs/DAT.md §44.2 quater

    La preuve qui compte : on change ce que l'ingress FAIT, et le texte change
    tout seul. Une phrase écrite en dur resterait vraie après que le produit a
    cessé de l'être — c'est exactement le défaut que le responsable proscrit.
    """
    ordinaire = briefing.dossier(_avec_route(tls=1), jump=None)
    assert "n'ajoute aucun en-tête" in ordinaire
    assert "`reverse_proxy`" in ordinaire

    # Le jour où l'ingress posera un handler d'en-têtes, la phrase disparaît.
    durci = briefing.dossier(_avec_route(tls=1, comportement={
        **_COMPORTEMENT, "handlers": ["reverse_proxy", "headers"],
        "adds_headers": True}), jump=None)
    assert "n'ajoute aucun en-tête" not in durci
    assert "Un proxy dans votre pile n'y changerait rien" not in durci


def test_les_en_tetes_transmis_viennent_du_releve_et_non_du_texte(tmp_path):
    """Ce que la pile reçoit du proxy est ÉNUMÉRÉ par l'ingress, pas récité."""
    model = _avec_route(tls=1, comportement={
        "handlers": ["reverse_proxy"], "forwarded_headers": ["X-Machin"],
        "preserve_host": False, "adds_headers": False})
    dossier = briefing.dossier(model, jump=None)
    assert "`X-Machin`" in dossier
    assert "X-Forwarded-For" not in dossier
    # `Host` n'est promis que si le relevé dit qu'il est préservé.
    assert "l'en-tête `Host` est celui que le visiteur a demandé" not in dossier


def test_un_port_sortant_ferme_est_attribue_a_l_HEBERGEUR(tmp_path):
    """§44.2 quinquies : la nuance désigne l'interlocuteur.

    @verifies docs/BACKLOG.md#SPK-102 · docs/DAT.md §44.2 quinquies, §48.1

    Un agent réel a écrit « la cellule filtre la sortie SMTP ». Le produit ne
    pose qu'une chaîne `input` ; la cause est chez l'hébergeur, et chercher un
    réglage produit ne donnera jamais rien.
    """
    dossier = briefing.dossier(_avec_route(tls=1), jump=None)
    assert "ne filtre AUCUN port sortant" in dossier
    assert "fermé par l'hébergeur" in dossier
    # Le piège le redit là où on lit vite.
    assert any("hébergeur" in p for p in _avec_route(tls=1)["pitfalls"])


def test_la_pile_ne_se_dit_plus_EN_CLAIR_et_le_dernier_mot_est_explique(tmp_path):
    """SPK-112 · §44.2 bis, §55.3.1 : un agent a lu « servez en clair » comme une
    valeur de la grammaire `[tls|clair]`, et proposé `clair` pour un site public.

    @verifies docs/BACKLOG.md#SPK-112 · docs/DAT.md §44.2 bis, §55.3.1, §55.7

    Les deux présentations sont vérifiées : l'agent lit le briefing dans la
    cellule, et le dossier sur son poste.
    """
    model = _avec_route(tls=1)
    for texte in (briefing.markdown(model), briefing.dossier(model, jump=None)):
        assert "servez en clair" not in texte.lower()
        assert "**en clair**" not in texte
        assert ", en clair" not in texte
        assert "HTTP simple" in texte
        assert "Le dernier mot d'une route règle son côté PUBLIC" in texte
        assert "`clair`, il est publié en `http://`, sans certificat" in texte
