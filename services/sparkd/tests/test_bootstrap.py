"""@verifies docs/BACKLOG.md#SPK-54 · docs/DAT.md §41.2 (Docker vient du dépôt
            AMONT), §42.1 (détecter d'abord, n'installer que les manques),
            §42.5 (exec_capture, et le code de sortie qui n'est pas une erreur),
            §42.6 (ce que la détection exécute), §42.7 (le contrat d'API),
            §42.8 (ce que le journal reçoit) · §35 (un Spark protégé)

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
        "sshd": "active", "cles": "absent", "depot": "absent",
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
        "sshd": "active", "cles": "absent", "depot": "present",
        "docker": "Docker version 29.7.2", "origine": "docker-ce",
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
    depot = bootstrap.script_pour("depot")[-1]
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
    _poser_runtime(client, nom, sshd="active", depot="present",
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
    _poser_runtime(client, nom, sshd="active", depot="present",
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
    """Là, en revanche, c'est bien une panne : il n'y a rien où exécuter."""
    client = _client(tmp_path)
    from sparkd.incus import IncusError  # noqa: PLC0415

    with pytest.raises(IncusError):
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
    assert "dockerd-rootless-setuptool" in lances
    assert "enable-linger" in lances
    # Deux démons sur la même cellule se disputeraient stockage et réseaux.
    assert "systemctl disable --now docker.service" in lances


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
