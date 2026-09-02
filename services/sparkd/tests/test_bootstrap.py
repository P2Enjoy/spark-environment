"""@verifies docs/BACKLOG.md#SPK-54 · docs/BACKLOG.md#SPK-76 ·
            docs/DAT.md §42.9 (la famille de la cellule décide) ·
            docs/DAT.md §41.2 (Docker vient du dépôt
            AMONT), §42.1 (détecter d'abord, n'installer que les manques),
            §42.5 (exec_capture, et le code de sortie qui n'est pas une erreur),
            §42.6 (ce que la détection exécute), §42.7 (le contrat d'API),
            §42.8 (ce que le journal reçoit), §42.2 bis (reprise rootless) ·
            §35 (un Spark protégé)

Ce que ces preuves gardent, et c'est LE point de l'unité : la détection porte sur
l'**origine** du paquet Docker, pas sur sa présence. Un `docker.io` de
distribution est présent *et* inutilisable (§41.2) ; le déclarer bon rendrait
l'amorçage inutile là où il sert — un Spark où aucune pile ne tournera.

La seconde garde est le silence : un second amorçage ne doit RIEN faire. Un geste
qui réinstallerait « au cas où » redémarrerait le démon Docker du locataire, donc
sa production.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from sparkd import bootstrap
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "b.db"),
                                         "SPARKD_DRIVER": "fake"})))
    # L'admission refuse tant que la capacité de la Forge n'est pas relevée : on
    # ignore ce qui existe, donc rien ne peut être admis (§7.7).
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _creer(client, nom="helo", demarrer=True):
    reponse = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000})
    assert reponse.status_code == 201, reponse.text
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    if demarrer:
        assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def _poser_runtime(client, nom, **valeurs):
    """Pose l'état de RUNTIME de la cellule factice (§28.4, §42.5).

    Sans lui, la détection n'aurait rien à observer et l'amorçage ne serait
    éprouvable que sur une cellule vierge — c'est-à-dire jamais sur le cas qui
    compte, celle qui est déjà complète.
    """
    pilote = client.app.state.incus
    pilote.created[nom].setdefault("runtime", {}).update(valeurs)
    pilote._persist()


# --- LE POINT QUI DÉCIDE : l'origine, pas la présence (§41.2) ---------------


def test_un_docker_io_de_DISTRIBUTION_est_un_DEFAUT_et_pas_un_etat_acceptable(tmp_path):
    """Il est présent, et il est inutilisable : son profil AppArmor refuse
    `socketpair()` sous imbrication. Le déclarer bon ferait dire à l'amorçage
    qu'un Spark est prêt alors qu'aucune pile n'y tournera."""
    vus = bootstrap.juger({
        "os_id": "debian", "os_suite": "trixie",
        "sshd": "active", "cles": "absent",
        "docker": "Docker version 26.1.5", "origine": "docker.io",
        "compose": "absent"})
    docker = next(v for v in vus if v["key"] == "docker")
    assert docker["state"] == bootstrap.DEFECT
    assert docker["state"] != bootstrap.PRESENT
    assert "docker.io" in docker["detail"]
    assert "socketpair" in docker["detail"], "le détail dit POURQUOI"
    # …et il entre dans les manques : un défaut se corrige.
    assert "docker" in bootstrap.manques(vus)


def test_un_docker_ce_du_depot_AMONT_est_present(tmp_path):
    vus = bootstrap.juger({
        "os_id": "debian", "os_suite": "trixie",
        "sshd": "active", "cles": "absent",
        "depot_distro": "debian", "depot_suite": "trixie",
        "docker": "Docker version 29.7.2", "origine": "docker-ce",
        "docker_version": "5:29.7.2-1~debian.13~trixie",
        "compose": "Docker Compose version v2"})
    docker = next(v for v in vus if v["key"] == "docker")
    assert docker["state"] == bootstrap.PRESENT
    assert "29.7.2" in docker["detail"]


def test_les_trois_etats_existent_et_ne_se_reduisent_pas_a_un_booleen(tmp_path):
    """§42.7 : réduire à présent/absent rendrait le `docker.io` inexprimable."""
    assert len({bootstrap.PRESENT, bootstrap.ABSENT, bootstrap.DEFECT}) == 3


def test_l_installation_de_docker_RETIRE_d_abord_le_paquet_de_distribution(tmp_path):
    """Les laisser cohabiter ne réparerait rien : c'est le profil AppArmor du
    paquet de la distribution qui casse, et il resterait posé (§41.2)."""
    commande = bootstrap.script_pour("docker")
    script = commande[-1]
    assert "purge" in script and "docker.io" in script
    assert script.index("purge") < script.index("docker-ce")
    # Et il vient du dépôt amont, pas de la distribution.
    depot = bootstrap.script_pour(
        "depot", {"os_id": "debian", "os_suite": "trixie"})[-1]
    assert "download.docker.com" in depot


# --- La détection, et ce qu'elle n'affirme pas (§42.6, §14.6) ---------------


def test_les_cles_qui_DIFFERENT_du_registre_sont_un_defaut_pas_une_absence(tmp_path):
    vus = bootstrap.juger({"cles": "a" * 64}, cles_voulues="b" * 64)
    cles = next(v for v in vus if v["key"] == "cles")
    assert cles["state"] == bootstrap.DEFECT
    assert "cles" in bootstrap.manques(vus)


def test_sans_etat_voulu_la_conformite_des_cles_n_est_pas_PRETENDUE(tmp_path):
    """§14.6 : « inconnu » n'est pas « bon ». Le détail le dit."""
    vus = bootstrap.juger({"cles": "a" * 64}, cles_voulues=None)
    cles = next(v for v in vus if v["key"] == "cles")
    assert cles["state"] == bootstrap.PRESENT
    assert "non vérifiée" in cles["detail"]


def test_le_releve_n_expose_QU_UNE_empreinte_tronquee(tmp_path):
    """§21.2 : une clé publique entière ne traverse pas le journal."""
    assert "cut -c1-64" in bootstrap.RELEVE
    assert len(bootstrap.empreinte("ssh-ed25519 AAAA... responsable")) == 64


def test_le_releve_n_ECRIT_rien(tmp_path):
    """Il doit pouvoir être lancé sur la production du locataire sans effet."""
    for interdit in ("apt-get install", "systemctl enable", "rm ", "> /etc"):
        assert interdit not in bootstrap.RELEVE, interdit


def test_le_releve_rootless_exige_un_SERVICE_et_un_SOCKET_utilisable(tmp_path):
    """Un compte de service seul n'est pas un démon. Le cas réel avait bien
    `spark-docker`, mais `docker.service` était inactive et aucun client ne
    pouvait joindre le socket rootless (§42.2 bis)."""
    assert "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" in bootstrap.RELEVE
    assert "systemctl --user is-active docker.service" in bootstrap.RELEVE
    assert "DOCKER_HOST=unix:///run/user/$uid/docker.sock docker info" in bootstrap.RELEVE
    assert "id spark-docker >/dev/null 2>&1 && echo rootless" not in bootstrap.RELEVE


# --- Le contrat d'API (§42.7) -----------------------------------------------


def test_le_releve_est_une_LECTURE_et_n_amorce_pas(tmp_path):
    """§42.7 : on peut regarder sans agir. Faire de la détection l'effet de bord
    d'une écriture obligerait à amorcer pour savoir s'il y a lieu d'amorcer."""
    client = _client(tmp_path)
    nom = _creer(client)
    reponse = client.get(f"/v1/sparks/{nom}/bootstrap")
    assert reponse.status_code == 200, reponse.text
    corps = reponse.json()
    assert corps["complete"] is False
    assert [v["key"] for v in corps["items"]] == list(bootstrap.ELEMENTS)
    # AUCUNE entrée au journal : une lecture ne se journalise pas (§36.7).
    entrees = client.get("/v1/audit?action=spark.bootstrap").json()["entries"]
    assert entrees == []


def test_un_Spark_SANS_CELLULE_est_refuse_en_le_nommant(tmp_path):
    client = _client(tmp_path)
    client.post("/v1/sparks", json={
        "name": "neuf", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000})
    for appel in (client.get, client.post):
        reponse = appel("/v1/sparks/neuf/bootstrap")
        assert reponse.status_code == 409, reponse.text
        assert reponse.json()["detail"]["error"] == "spark_not_reachable"


def test_une_cellule_A_L_ARRET_est_refusee_en_disant_pourquoi(tmp_path):
    """L'amorçage exécute des commandes DANS la cellule : elle doit tourner."""
    client = _client(tmp_path)
    nom = _creer(client, "arrete", demarrer=False)
    reponse = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert reponse.status_code == 409
    assert reponse.json()["detail"]["error"] == "spark_not_running"
    assert "DANS la cellule" in reponse.json()["detail"]["message"]


def test_un_Spark_PROTEGE_refuse_l_amorcage(tmp_path):
    """§35 : l'amorçage installe des paquets et redémarre des services chez le
    locataire — exactement ce que la protection arrête. Elle se lève par son
    geste distinct, jamais au passage (DESIGN_SYSTEM.md §6.23)."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.post(f"/v1/sparks/{nom}/protection",
                       json={"password": "mot-de-passe-long-et-valide"}
                       ).status_code == 200
    reponse = client.post(f"/v1/sparks/{nom}/bootstrap")
    # 423, et non 409 : c'est le code que le §35.5 a fixé pour TOUTE écriture
    # visant un Spark protégé. Une seconde convention pour le même refus
    # obligerait la console à en connaître deux.
    assert reponse.status_code == 423, reponse.text
    assert reponse.json()["detail"]["error"] == "spark_protected"
    # Le relevé, lui, reste possible : lire ne modifie rien.
    assert client.get(f"/v1/sparks/{nom}/bootstrap").status_code == 200


# --- LE SILENCE : un second amorçage ne fait RIEN (§42.1) -------------------


def test_un_amorcage_sur_cellule_COMPLETE_ne_fait_rien_et_le_DIT(tmp_path):
    """C'est là qu'un geste bavard casserait la production du locataire : il
    redémarrerait le démon Docker pour rien."""
    client = _client(tmp_path)
    nom = _creer(client)
    _poser_runtime(client, nom, sshd="active", os_id="debian",
                   os_suite="trixie", depot_distro="debian",
                   depot_suite="trixie",
                   docker="Docker version 29.7.2", origine="docker-ce",
                   compose="Docker Compose version v2",
                   cles=bootstrap.empreinte(
                       client.app.state.incus.created[nom]["files"].get(
                           "/root/.ssh/authorized_keys", "")))
    pilote = client.app.state.incus
    avant = len(pilote.created[nom].get("commands", []))

    reponse = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert reponse.status_code == 200, reponse.text
    corps = reponse.json()
    assert corps["changed"] is False
    assert corps["complete"] is True
    assert all(ligne["outcome"] == "inchangé" for ligne in corps["items"])
    assert all(ligne["action"] == "aucune" for ligne in corps["items"])

    # UNE seule commande de plus : le relevé. Aucun script d'installation.
    apres = pilote.created[nom].get("commands", [])
    assert len(apres) - avant == 1, apres[avant:]
    assert "apt-get install" not in json.dumps(apres[avant:])


def test_un_amorcage_qui_ne_change_RIEN_est_quand_meme_journalise(tmp_path):
    """§42.8 : savoir que quelqu'un a demandé le geste et que rien n'était à
    faire est une information. Son absence ferait croire qu'il n'a pas été
    tenté."""
    client = _client(tmp_path)
    nom = _creer(client)
    _poser_runtime(client, nom, sshd="active", os_id="debian",
                   os_suite="trixie", depot_distro="debian",
                   depot_suite="trixie",
                   docker="Docker version 29.7.2", origine="docker-ce",
                   compose="Docker Compose version v2",
                   cles=bootstrap.empreinte(
                       client.app.state.incus.created[nom]["files"].get(
                           "/root/.ssh/authorized_keys", "")))
    client.post(f"/v1/sparks/{nom}/bootstrap")
    entrees = client.get("/v1/audit?action=spark.bootstrap").json()["entries"]
    assert len(entrees) == 1
    assert "rien à faire" in entrees[0]["message"]
    assert json.loads(entrees[0]["payload"])["changed"] is False


# --- L'amorçage AGIT, et rend le sort de chaque ligne -----------------------


def test_une_cellule_VIERGE_recoit_tout_ce_qui_manque_et_rien_de_plus(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client)
    reponse = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert reponse.status_code == 200, reponse.text
    corps = reponse.json()
    assert corps["changed"] is True
    assert corps["path"] == "incus_exec"

    lances = json.dumps(client.app.state.incus.created[nom]["commands"])
    assert "openssh-server" in lances
    assert "docker-ce" in lances
    assert "docker-compose-plugin" in lances
    assert "download.docker.com" in lances, "le dépôt AMONT, jamais celui de la distribution"


def test_le_compte_rendu_rend_le_sort_de_CHAQUE_ligne(tmp_path):
    """§42.7 : jamais un verdict global. Un « succès » unique laisserait croire
    que tout a été fait alors qu'on n'agit que sur les manques."""
    client = _client(tmp_path)
    nom = _creer(client)
    _poser_runtime(client, nom, sshd="active")
    corps = client.post(f"/v1/sparks/{nom}/bootstrap").json()
    par_cle = {ligne["key"]: ligne for ligne in corps["items"]}
    assert set(par_cle) == set(bootstrap.ELEMENTS)
    assert par_cle["sshd"]["outcome"] == "inchangé"
    assert par_cle["sshd"]["action"] == "aucune"
    assert par_cle["docker"]["action"] == "amorcé"


def test_le_journal_NOMME_ce_qui_a_ete_installe(tmp_path):
    """§42.8. Un « amorçage effectué » n'apprendrait rien."""
    client = _client(tmp_path)
    nom = _creer(client)
    _poser_runtime(client, nom, sshd="active")
    client.post(f"/v1/sparks/{nom}/bootstrap")
    entree = client.get("/v1/audit?action=spark.bootstrap").json()["entries"][0]
    assert "moteur Docker" in entree["message"]
    assert "serveur SSH" not in entree["message"], "il était déjà là"
    charge = json.loads(entree["payload"])
    assert charge["path"] == "incus_exec"
    assert charge["changed"] is True
    assert "sshd" not in charge["items"]


def test_l_action_du_journal_est_DISTINCTE_du_depannage(tmp_path):
    """§42.8 et §37.3 : les deux passent par `incus exec`. Les confondre
    empêcherait de compter les emprunts du chemin de dépannage."""
    client = _client(tmp_path)
    nom = _creer(client)
    client.post(f"/v1/sparks/{nom}/bootstrap")
    toutes = client.get("/v1/audit?limit=200").json()["entries"]
    assert any(e["action"] == "spark.bootstrap" for e in toutes)
    assert not any(e["action"] == "spark.rescue_exec" for e in toutes)


def test_le_journal_ne_porte_PAS_la_sortie_des_commandes(tmp_path):
    """§42.8 : elle contiendrait la version des paquets du locataire sans qu'on
    en ait besoin, et le §21.2 borne ce qui traverse le journal."""
    client = _client(tmp_path)
    nom = _creer(client)
    _poser_runtime(client, nom, docker="Docker version 26.1.5", origine="docker.io")
    client.post(f"/v1/sparks/{nom}/bootstrap")
    entree = client.get("/v1/audit?action=spark.bootstrap").json()["entries"][0]
    assert "26.1.5" not in json.dumps(entree)


# --- exec_capture : un code non nul n'est pas une panne (§42.5) -------------


def test_exec_capture_rend_un_TRIPLET_sans_lever(tmp_path):
    """`command -v sshd` qui rend 1 est une réponse — « absent » —, pas une
    panne. Les confondre ferait échouer l'amorçage sur ce qu'il est venu
    constater."""
    client = _client(tmp_path)
    nom = _creer(client)
    code, sortie, erreurs = client.app.state.incus.exec_capture(
        nom, ["bash", "-lc", "true"])
    assert isinstance(code, int)
    assert isinstance(sortie, str) and isinstance(erreurs, str)


def test_exec_capture_sur_une_instance_ABSENTE_leve(tmp_path):
    """Là, en revanche, c'est bien une panne : il n'y a rien où exécuter.

    RÉVISÉE le 2026-08-21 par SPK-67, et la nuance n'est pas cosmétique. Cette
    preuve attendait `IncusError`, c'est-à-dire « je n'ai pas pu demander ». Le
    §12.1.2 du DAT tranche que l'absence RAPPORTÉE porte son propre type sur les
    trois transports : ici Incus répond, et il répond que la cellule n'existe
    pas. C'est une absence, pas une ignorance (§33.3), et l'amorçage doit
    pouvoir les distinguer — la première se répare en reconstruisant la cellule,
    la seconde en réparant le pilote.

    L'ancienne attente n'est pas conservée à côté : elle décrivait une règle qui
    n'est plus celle du produit.
    """
    client = _client(tmp_path)
    from sparkd.incus import InstanceAbsente  # noqa: PLC0415

    with pytest.raises(InstanceAbsente):
        client.app.state.incus.exec_capture("inexistant", ["bash", "-lc", "true"])


# --- SPK-54 · LE MODE ROOTLESS, ET LE REFUS DE BASCULER (§42.2, §42.2 bis) ---


def test_le_defaut_est_ENRACINE_et_l_option_doit_etre_demandee(tmp_path):
    """§42.2 : « d'où le défaut : enraciné, avec le rootless offert à qui le
    demande. Annoncer l'inverse ferait échouer la promesse centrale du produit
    sur la moitié des piles. »"""
    client = _client(tmp_path)
    nom = _creer(client)
    corps = client.post(f"/v1/sparks/{nom}/bootstrap").json()
    assert corps["mode"] == bootstrap.ENRACINE
    lances = json.dumps(client.app.state.incus.created[nom]["commands"])
    assert "dockerd-rootless-setuptool" not in lances


def test_l_option_rootless_installe_ce_qu_il_faut_pour_qu_il_SURVIVE(tmp_path):
    """`enable-linger` n'est pas une précaution : sans lui le démon meurt à la fin
    de la session du compte, ce qui donnerait une cellule qui marche jusqu'au
    premier redémarrage — et cela ne se verrait qu'alors (§42.2 bis)."""
    client = _client(tmp_path)
    nom = _creer(client)
    corps = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True}).json()
    assert corps["mode"] == bootstrap.ROOTLESS
    lances = json.dumps(client.app.state.incus.created[nom]["commands"])
    assert "docker-ce-rootless-extras" in lances
    # Dépendance explicitement portée par le contrat de reprise Debian 13.
    assert "systemd-container" in lances
    assert "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" in lances
    assert "dockerd-rootless-setuptool" in lances
    assert "machinectl shell" not in lances
    assert "/proc/self/uid_map" in lances and "/proc/self/gid_map" in lances
    assert "subuid_count" in lances and "subgid_count" in lances
    assert "enable-linger" in lances
    # Deux démons sur la même cellule se disputeraient stockage et réseaux.
    assert "systemctl disable --now docker.service" in lances


def test_le_script_rootless_reserve_une_sous_plage_DANS_l_idmap_incus(tmp_path):
    """`useradd` choisit 100000:65536, hors d'une cellule Incus mappée
    0:65536. Le script doit donc mesurer l'idmap et n'écrire que la sous-plage
    déléguable au compte de service (§42.2 bis)."""
    script = bootstrap.script_rootless()[-1]
    assert "/proc/self/uid_map" in script and "/proc/self/gid_map" in script
    assert "subuid_count" in script and "subgid_count" in script
    assert "idmap Incus insuffisant" in script
    assert "sed -i '/^spark-docker:/d' /etc/subuid /etc/subgid" in script


def test_un_rootless_interrompu_est_repris_sans_basculer_un_docker_enracine(tmp_path):
    """La Forge réelle a trouvé ce cas : les paquets existent, le démon
    utilisateur non. Rejouer la seule préparation est sûr car le mode root ne
    tourne pas; rejouer tout Docker ne le serait pas (§42.2 bis)."""
    client = _client(tmp_path)
    nom = _creer(client)
    pilote = client.app.state.incus
    _poser_runtime(
        client, nom, sshd="active", depot="present",
        docker="Docker version 29.7.2", origine="docker-ce",
        compose="Docker Compose version v5.5.0",
        cles=bootstrap.empreinte(pilote.created[nom]["files"]["/root/.ssh/authorized_keys"]),
    )
    avant = len(pilote.created[nom].get("commands", []))

    response = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    assert response.status_code == 200, response.text
    corps = response.json()
    assert corps["changed"] is True
    reprise = next(item for item in corps["items"] if item["key"] == "rootless")
    assert reprise["outcome"] == "installé"
    assert reprise["mode"] == bootstrap.ROOTLESS
    lancees = pilote.created[nom]["commands"][avant:]
    assert any("systemd-container" in commande[-1] for commande in lancees)
    assert not any("systemctl enable --now docker" in commande[-1] for commande in lancees)
    audit = client.get("/v1/audit?action=spark.bootstrap").json()["entries"][0]
    assert "rootless" in json.loads(audit["payload"])["items"]


def test_un_code_non_nul_d_installation_refuse_le_succes_et_l_audit(tmp_path):
    """Le non-zéro est une réponse POUR LE RELEVÉ, pas pour apt (§42.5)."""
    client = _client(tmp_path)
    nom = _creer(client)
    pilote = client.app.state.incus
    original = pilote.exec_capture

    def echouer_installation(name, command):
        if "apt-get install" in command[-1]:
            return 42, "", ""
        return original(name, command)

    pilote.exec_capture = echouer_installation
    response = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "bootstrap_failed"
    assert "code 42" in response.json()["detail"]["message"]
    assert client.get("/v1/audit?action=spark.bootstrap").json()["entries"] == []


def test_le_MODE_est_observe_et_rendu_par_le_releve(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client)
    client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    releve = client.get(f"/v1/sparks/{nom}/bootstrap").json()
    docker = next(v for v in releve["items"] if v["key"] == "docker")
    assert docker["mode"] == bootstrap.ROOTLESS


def test_un_Docker_ABSENT_n_a_PAS_de_mode(tmp_path):
    """§42.2 bis : lui en attribuer un ferait croire à un choix là où rien ne
    tourne (§14.6 — « inconnu » n'est pas une valeur)."""
    vus = bootstrap.juger({"docker": "absent", "origine": "absent", "mode": "absent"})
    docker = next(v for v in vus if v["key"] == "docker")
    assert docker["mode"] is None


def test_un_docker_io_de_distribution_n_a_pas_de_mode_non_plus(tmp_path):
    """Il tourne, mais il est défectueux : lui reconnaître un mode reviendrait à
    le compter comme un choix valide."""
    vus = bootstrap.juger({"docker": "Docker version 26.1.5",
                           "origine": "docker.io", "mode": "enracine"})
    docker = next(v for v in vus if v["key"] == "docker")
    assert docker["state"] == bootstrap.DEFECT
    assert docker["mode"] is None


def test_BASCULER_un_Docker_en_place_est_REFUSE_et_les_deux_modes_sont_nommes(tmp_path):
    """LE point du §42.2 bis. Basculer déplacerait le démon sous un autre compte,
    et avec lui les conteneurs, volumes et réseaux du locataire — sa production,
    sans qu'il l'ait demandé."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").json()["mode"] == "enracine"
    avant = len(client.app.state.incus.created[nom]["commands"])

    reponse = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    assert reponse.status_code == 409, reponse.text
    detail = reponse.json()["detail"]
    assert detail["error"] == "bootstrap_mode_conflict"
    assert detail["installed"] == "enracine"
    assert detail["requested"] == "rootless"
    assert "enraciné" in detail["message"] and "rootless" in detail["message"]
    # …et il dit ce que l'amorçage NE FERA PAS.
    assert "vider la cellule" in detail["message"]

    # RIEN n'a été exécuté : un refus ne touche pas la cellule.
    apres = client.app.state.incus.created[nom]["commands"]
    assert len(apres) - avant == 1, "seul le relevé, qui n'écrit rien"
    assert "dockerd-rootless-setuptool" not in json.dumps(apres[avant:])


def test_le_refus_de_bascule_joue_dans_les_DEUX_sens(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client)
    client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    reponse = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert reponse.status_code == 409
    assert reponse.json()["detail"]["installed"] == "rootless"


def test_redemander_le_MEME_mode_reste_idempotent(tmp_path):
    """Le refus porte sur la BASCULE, pas sur le fait de redemander. Confondre
    les deux rendrait un second amorçage impossible."""
    client = _client(tmp_path)
    nom = _creer(client)
    client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    reponse = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    assert reponse.status_code == 200, reponse.text
    assert reponse.json()["changed"] is False


def test_le_journal_porte_le_MODE_meme_quand_rien_n_a_ete_fait(tmp_path):
    """§42.2 bis : c'est ce qu'on cherchera le jour où une pile ne démarre pas,
    et il ne se retrouve nulle part ailleurs."""
    client = _client(tmp_path)
    nom = _creer(client)
    client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    entrees = client.get("/v1/audit?action=spark.bootstrap").json()["entries"]
    assert len(entrees) == 2
    for entree in entrees:
        assert json.loads(entree["payload"])["mode"] == "rootless"
    assert any("rien à faire" in e["message"] and "rootless" in e["message"]
               for e in entrees)


def test_le_compte_rendu_de_l_amorcage_PORTE_le_mode(tmp_path):
    """Défaut trouvé par le parcours E2E, invisible aux tests d'unité existants :
    ils interrogeaient le RELEVÉ, qui portait bien le mode, alors que le compte
    rendu de l'amorçage reconstruit ses lignes champ par champ et l'oubliait.

    L'écran lit le compte rendu juste après le geste : sans le mode, il ne peut
    pas dire dans quel mode le Spark vient d'être amorcé — c'est-à-dire au moment
    précis où l'information compte le plus (§42.2 bis).
    """
    client = _client(tmp_path)
    nom = _creer(client)
    corps = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True}).json()
    docker = next(v for v in corps["items"] if v["key"] == "docker")
    assert docker["mode"] == bootstrap.ROOTLESS

    # …et le compte rendu d'un amorçage qui ne change RIEN le porte aussi.
    encore = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True}).json()
    assert encore["changed"] is False
    assert next(v for v in encore["items"]
                if v["key"] == "docker")["mode"] == bootstrap.ROOTLESS


# --- SPK-76 · La famille de la cellule décide (§42.9) -----------------------
#
# @verifies docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.1 (le relevé n'exige plus
#           `bash`), §42.9.2 (le dépôt se construit), §42.9.3 (un dépôt présent
#           peut être faux), §42.9.4 (un `docker-ce` du mauvais dépôt),
#           §42.9.5 (le refus), §42.9.7 (l'échec qui dit sa cause)


def test_le_releve_n_exige_PAS_bash_puisqu_il_vient_le_diagnostiquer(tmp_path):
    """§42.9.1. C'est le défaut d'`alpine-demo` : `bash -lc` faisait refuser
    l'exécution par Incus — « Command not found » — avant que le produit n'ait pu
    NOMMER la distribution qu'il venait constater."""
    commande = bootstrap._shell("vrai")
    assert commande[0] == "sh", "une cellule sans bash doit pouvoir être RELEVÉE"
    assert "bash" not in commande[0]
    # Le motif d'origine de `bash -lc` reste honoré, mais explicitement.
    assert "/usr/sbin" in commande[-1], "sshd vit dans /usr/sbin"


def test_le_depot_amont_suit_la_DISTRIBUTION_de_la_cellule(tmp_path):
    """§42.9.2 : c'était `linux/debian` et `trixie`, constantes de module."""
    assert bootstrap.cible_apt({"os_id": "debian", "os_suite": "trixie"}) == (
        "debian", "trixie")
    assert bootstrap.cible_apt({"os_id": "debian", "os_suite": "bookworm"}) == (
        "debian", "bookworm")
    assert bootstrap.cible_apt({"os_id": "ubuntu", "os_suite": "noble"}) == (
        "ubuntu", "noble")
    script = bootstrap.script_pour("depot", {"os_id": "ubuntu", "os_suite": "noble"})[-1]
    assert "download.docker.com/linux/ubuntu noble stable" in script
    assert "linux/debian" not in script, "le défaut mesuré sur la cellule Ubuntu"


def test_une_derivee_est_servie_par_son_PARENT_quand_ID_LIKE_le_nomme(tmp_path):
    assert bootstrap.cible_apt(
        {"os_id": "linuxmint", "os_suite": "virginia", "os_like": "ubuntu debian"}
    ) == ("ubuntu", "virginia")


def test_sans_VERSION_CODENAME_on_REFUSE_au_lieu_de_deviner(tmp_path):
    """§42.9.2 : poser une suite fausse est le défaut qu'on corrige. Le dépôt
    répondrait, et l'échec n'arriverait qu'à l'installation."""
    with pytest.raises(bootstrap.OSNonServi):
        bootstrap.cible_apt({"os_id": "debian", "os_suite": ""})


def test_une_cellule_ALPINE_n_est_pas_servie_et_ce_n_est_pas_une_panne(tmp_path):
    """§42.9.5. Le type est distinct de `BootstrapFailed` à dessein : « je ne
    sais pas faire ça » n'est pas « ça a raté »."""
    brut = {"os_id": "alpine", "os_suite": "", "os_like": ""}
    assert bootstrap.servie(brut) is False
    assert bootstrap.identite(brut)["family"] == "alpine"
    with pytest.raises(bootstrap.OSNonServi) as refus:
        bootstrap.cible_apt(brut)
    assert "alpine" in str(refus.value), "le refus NOMME la distribution trouvée"
    assert not issubclass(bootstrap.OSNonServi, bootstrap.BootstrapFailed)


def test_un_depot_qui_pointe_une_AUTRE_distribution_est_un_DEFAUT(tmp_path):
    """§42.9.3 — le cas mesuré : `linux/debian trixie` sur une Ubuntu `noble`.
    Le dépôt RÉPOND, donc rien ne s'en plaignait jusqu'à `apt-get install`."""
    vus = bootstrap.juger({
        "os_id": "ubuntu", "os_suite": "noble", "os_like": "debian",
        "depot_distro": "debian", "depot_suite": "trixie",
        "docker": "absent", "origine": "absent", "compose": "absent"})
    depot = next(v for v in vus if v["key"] == "depot")
    assert depot["state"] == bootstrap.DEFECT
    assert depot["state"] != bootstrap.PRESENT, "présent n'est pas juste"
    assert "debian" in depot["detail"] and "ubuntu" in depot["detail"]
    assert "depot" in bootstrap.manques(vus)


def test_un_docker_ce_venu_du_MAUVAIS_depot_est_un_defaut(tmp_path):
    """§42.9.4 : les paquets amont portent leur origine dans leur version."""
    vus = bootstrap.juger({
        "os_id": "ubuntu", "os_suite": "noble", "os_like": "debian",
        "depot_distro": "ubuntu", "depot_suite": "noble",
        "docker": "Docker version 29.7.2", "origine": "docker-ce",
        "docker_version": "5:29.7.2-1~debian.13~trixie", "compose": "absent"})
    docker = next(v for v in vus if v["key"] == "docker")
    assert docker["state"] == bootstrap.DEFECT
    assert "trixie" in docker["detail"]
    # …et on ne lui attribue AUCUN mode : il ne tourne pas utilement (§42.2 bis).
    assert docker["mode"] is None


def test_un_paquet_SANS_marque_d_origine_n_est_pas_declare_defectueux(tmp_path):
    """§33.3 appliqué ici : ne pas savoir n'est pas savoir que c'est faux. Un
    paquet reconstruit localement ne doit pas être purgé sur un doute."""
    assert bootstrap.origine_paquet("5:29.7.2-1") is None
    vus = bootstrap.juger({
        "os_id": "debian", "os_suite": "trixie",
        "depot_distro": "debian", "depot_suite": "trixie",
        "docker": "Docker version 29.7.2", "origine": "docker-ce",
        "docker_version": "5:29.7.2-1", "compose": "absent"})
    assert next(v for v in vus if v["key"] == "docker")["state"] == bootstrap.PRESENT


def test_un_script_de_pose_S_ARRETE_au_premier_echec(tmp_path):
    """§42.9.7 : sans `set -e`, le code rendu était celui de la DERNIÈRE ligne.
    D'où un Docker installé « malgré l'erreur » — et, symétriquement, des poses
    ratées rendues réussies dès que la dernière ligne passait."""
    for cle, brut in (("sshd", {}), ("compose", {}),
                      ("depot", {"os_id": "debian", "os_suite": "trixie"}),
                      ("docker", {})):
        script = bootstrap.script_pour(cle, brut)[-1]
        assert "set -e" in script, f"« {cle} » poursuit après un échec"


def test_l_echec_d_une_pose_porte_sa_CAUSE_et_pas_seulement_un_code(tmp_path):
    """§42.9.7 : `code, _, _ = exec_capture(...)` jetait le stderr. Un code de
    sortie sans cause n'est pas un diagnostic (CLAUDE.md §18)."""
    message = bootstrap.echec("docker", 100, "Lecture des listes...\n"
                              "E: Impossible de trouver le paquet docker-ce\n")
    assert "code 100" in message
    assert "Impossible de trouver le paquet docker-ce" in message
    # Sans sortie, on le DIT au lieu de laisser croire qu'on n'a pas regardé.
    assert "rien écrit" in bootstrap.echec("docker", 1, "")


def test_le_releve_REPOND_sur_une_cellule_qu_on_ne_saurait_pas_amorcer(tmp_path):
    """§42.9.5 : on peut regarder sans agir, et cela vaut a fortiori ici — c'est
    là qu'il faut pouvoir lire ce que la cellule EST."""
    client = _client(tmp_path)
    nom = _creer(client, "alpine-demo")
    client.app.state.incus.created[nom]["alias"] = "alpine/3.21"
    client.app.state.incus._persist()

    releve = client.get(f"/v1/sparks/{nom}/bootstrap")
    assert releve.status_code == 200, releve.text
    assert releve.json()["supported"] is False
    assert releve.json()["os"]["id"] == "alpine"


def test_une_cellule_non_servie_est_REFUSEE_sans_qu_une_seule_pose_ne_parte(tmp_path):
    """§42.9.5. Le point de la preuve : elle COMPTE les exécutions. Un refus qui
    aurait déjà installé la moitié de quelque chose ne serait pas un refus."""
    client = _client(tmp_path)
    nom = _creer(client, "alpine-demo")
    pilote = client.app.state.incus
    pilote.created[nom]["alias"] = "alpine/3.21"
    pilote._persist()
    assert client.get(f"/v1/sparks/{nom}/bootstrap").status_code == 200
    avant = len(pilote.created[nom].get("commands", []))

    refus = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert refus.status_code == 409, refus.text
    detail = refus.json()["detail"]
    assert detail["error"] == "bootstrap_unsupported_os"
    assert "alpine" in detail["message"], "le refus NOMME la distribution"
    assert detail["os"]["id"] == "alpine"

    # Une seule commande de plus : le relevé. Aucune pose.
    apres = pilote.created[nom]["commands"][avant:]
    assert len(apres) == 1, f"{len(apres)} commandes, dont des poses : {apres}"
    assert "apt-get install" not in " ".join(apres[0])


def test_un_amorcage_sur_UBUNTU_pose_le_depot_d_ubuntu(tmp_path):
    """La cellule du responsable. Elle recevait `linux/debian trixie`, dont les
    paquets sont ensuite refusés par `apt` sur `noble`."""
    client = _client(tmp_path)
    nom = _creer(client, "ubuntu-demo")
    pilote = client.app.state.incus
    pilote.created[nom]["alias"] = "ubuntu/24.04"
    pilote._persist()

    amorce = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert amorce.status_code == 200, amorce.text
    assert amorce.json()["os"]["id"] == "ubuntu"
    assert amorce.json()["complete"] is True

    poses = " ".join(" ".join(c) for c in pilote.created[nom]["commands"])
    assert "download.docker.com/linux/ubuntu noble stable" in poses
    assert "linux/debian trixie" not in poses

    # Et le second amorçage ne fait toujours RIEN (§42.1).
    assert client.post(f"/v1/sparks/{nom}/bootstrap").json()["changed"] is False
