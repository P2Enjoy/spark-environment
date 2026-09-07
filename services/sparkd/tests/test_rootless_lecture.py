"""@verifies docs/BACKLOG.md#SPK-94 · docs/DAT.md §42.2 ter (ce que le compte
            rootless doit pouvoir lire), §42.2 quater (le bandeau qu'on
            enterrait), §44.1 (le panneau indicateur), §44.10 (les permissions
            du briefing) · docs/SCHEMA.md §10 quinquies (docker_uid, docker_gid)

Le défaut que ces preuves gardent : en rootless, Compose tourne sous
`spark-docker` et lit `env_file:` CÔTÉ CLIENT. Les fichiers du §43 étaient posés
`0600 root:root` dans un `/etc/spark` en `0700` — le compte ne pouvait ni
traverser le dossier ni lire les fichiers, et la pile du locataire ne démarrait
pas, alors que la même pile fonctionne en enraciné.

C'est la leçon du §41.2 déplacée d'un cran : poser un fichier ne suffit pas, il
faut que celui qui doit le lire puisse le lire.

La seconde garde est la SYMÉTRIE : un Spark enraciné n'a pas de compte à qui
ouvrir, et ses fichiers doivent rester fermés. Une ouverture qui déborderait sur
l'enraciné élargirait la lecture des secrets sans que personne l'ait demandé.
"""

from __future__ import annotations

import json
import sqlite3

from fastapi.testclient import TestClient

from sparkd import bootstrap
from sparkd import briefing as briefing_service
from sparkd import environnement as env_service
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

CLE_PUBLIQUE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3f"
                "R0CvBnyFDMmDcrFbYT poste")


def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "b.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _creer(client, nom="helo"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    # La clé est au registre une seule fois : deux Sparks du même test la
    # partagent, et la réenregistrer serait refusé.
    deja = [c["label"] for c in client.get("/v1/ssh-keys").json()["keys"]]
    if "poste" not in deja:
        assert client.post("/v1/ssh-keys", json={
            "label": "poste", "public_key": CLE_PUBLIQUE}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/ssh-keys/poste").status_code == 200
    return nom


def _commandes(client, nom):
    """Les scripts réellement passés dans la cellule, à plat."""
    return [" ".join(c) for c in client.app.state.incus.created[nom].get("commands", [])]


def _ouvertures(client, nom):
    """Les commandes qui posent des droits, et elles seules."""
    return [c for c in _commandes(client, nom) if "chgrp" in c]


# --- L'identité du compte : relevée, jamais devinée (§42.2 ter) --------------


def test_l_identite_rootless_se_LIT_et_ne_se_deduit_pas():
    """Elle décide d'un `chgrp` : une valeur qu'on ne comprend pas ne doit pas
    décider à qui les secrets du locataire sont ouverts."""
    assert bootstrap.identite_rootless(
        {"rootless_uid": "1001", "rootless_gid": "1002"}) == {"uid": 1001, "gid": 1002}
    # « absent » est ce que le relevé écrit hors mode rootless (§42.2 bis).
    assert bootstrap.identite_rootless(
        {"rootless_uid": "absent", "rootless_gid": "absent"}) == {"uid": None, "gid": None}
    # Rien du tout : une cellule relevée par une build antérieure.
    assert bootstrap.identite_rootless({}) == {"uid": None, "gid": None}
    # `0` est root, et un négatif n'existe pas : ni l'un ni l'autre ne DÉSIGNE le
    # compte de service. Les accepter ouvrirait au nom d'une identité fausse.
    assert bootstrap.identite_rootless(
        {"rootless_uid": "0", "rootless_gid": "0"}) == {"uid": None, "gid": None}
    assert bootstrap.identite_rootless(
        {"rootless_uid": "-1", "rootless_gid": "-1"}) == {"uid": None, "gid": None}
    # Illisible : on rend « inconnu », on ne tombe pas. Le §33.3 vaut ici aussi.
    assert bootstrap.identite_rootless(
        {"rootless_uid": "mille", "rootless_gid": ""}) == {"uid": None, "gid": None}


def test_le_releve_rend_l_identite_et_le_bandeau_sans_rien_ecrire():
    """§42.6 : le relevé doit pouvoir tourner sur la production du locataire."""
    assert "rootless_uid=%s" in bootstrap.RELEVE
    assert "rootless_gid=%s" in bootstrap.RELEVE
    assert "motd_distro=%s" in bootstrap.RELEVE
    # L'identité n'est lue QUE dans le mode qui la rend utile (§42.2 bis).
    assert 'if [ "$mode" = rootless ]; then' in bootstrap.RELEVE
    for interdit in ("apt-get install", "systemctl enable", "rm ", "> /etc", "chmod"):
        assert interdit not in bootstrap.RELEVE, interdit


def test_le_bandeau_de_la_distribution_se_constate_avant_de_se_taire():
    assert bootstrap.motd_a_taire({"motd_distro": "present"}) is True
    assert bootstrap.motd_a_taire({"motd_distro": "absent"}) is False
    # Une build antérieure ne rendait pas la clé : ne rien savoir n'autorise pas
    # à agir dans la cellule du locataire.
    assert bootstrap.motd_a_taire({}) is False


# --- Le geste d'ouverture (§42.2 ter) ---------------------------------------


def test_l_ouverture_distingue_un_DOSSIER_d_un_FICHIER():
    """Un dossier a besoin du bit `x` pour être traversé ; un fichier ne doit
    pas devenir exécutable. Un mode unique casserait l'un des deux."""
    script = bootstrap.script_ouverture(4242, ("/etc/spark",), ("/etc/spark/env",))[-1]
    assert "chmod 0750 /etc/spark;" in script
    assert "chmod 0640 /etc/spark/env;" in script
    assert "chgrp 4242 /etc/spark;" in script


def test_l_ouverture_GARDE_chaque_chemin_par_son_existence():
    """`/run/spark` vit sur un tmpfs (§43.5.2) et peut ne pas être là entre deux
    démarrages. Un `chgrp` sur un chemin absent ferait échouer une projection
    qui n'a rien de fautif."""
    script = bootstrap.script_ouverture(
        1001, ("/etc/spark", "/run/spark"), ("/run/spark/secrets",))[-1]
    assert "if [ -d /etc/spark ]; then" in script
    assert "if [ -d /run/spark ]; then" in script
    assert "if [ -f /run/spark/secrets ]; then" in script


def test_le_dossier_systeme_profile_d_n_est_JAMAIS_referme_sur_un_groupe():
    """Notre fichier y vit, le dossier appartient au système. Lui imposer
    `0750` casserait la lecture des autres profils de la cellule."""
    assert "/etc/profile.d" not in env_service.DOSSIERS_OUVERTS
    assert env_service.FICHIER_PROFIL in env_service.FICHIERS_OUVERTS


def test_le_motd_reste_hors_de_l_ouverture_du_briefing():
    """§44.10 : il est `0644` parce qu'il est fait pour être lu par tout le
    monde. Le restreindre à un groupe le rendrait invisible au moment précis où
    il sert — la connexion."""
    assert briefing_service.FICHIER_MOTD not in briefing_service.FICHIERS_OUVERTS
    assert briefing_service.FICHIER_JSON in briefing_service.FICHIERS_OUVERTS
    assert briefing_service.FICHIER_MARKDOWN in briefing_service.FICHIERS_OUVERTS


# --- LE défaut, de bout en bout ---------------------------------------------


def test_un_amorcage_ROOTLESS_ouvre_les_fichiers_au_compte_qui_lance_la_pile(tmp_path):
    """LE défaut de l'unité. Sans cette ouverture, `docker compose` lancé sous
    `spark-docker` ne peut pas lire les deux `env_file:` que le briefing lui
    impose, et la pile du locataire ne démarre pas."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/SMTP_HOST",
                      json={"value": "smtp.exemple.test"}).status_code == 200

    reponse = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True})
    assert reponse.status_code == 200, reponse.text
    assert reponse.json()["mode"] == bootstrap.ROOTLESS

    ouvertures = _ouvertures(client, nom)
    assert ouvertures, "aucun droit posé : le compte rootless ne peut rien lire"
    ensemble = " ".join(ouvertures)
    # Le GID est celui que la CELLULE a rendu, pas une constante du produit.
    assert "chgrp 1001 /etc/spark/env" in ensemble
    assert "chgrp 1001 /run/spark/secrets" in ensemble
    assert f"chgrp 1001 {env_service.FICHIER_PROFIL}" in ensemble
    # Et le briefing, sans quoi un agent entré par la seconde porte ne pourrait
    # pas lire le texte qui lui explique où il est (§44.10).
    assert f"chgrp 1001 {briefing_service.FICHIER_MARKDOWN}" in ensemble
    assert f"chgrp 1001 {briefing_service.FICHIER_JSON}" in ensemble
    # Le dossier aussi : sans le bit `x`, les fichiers restent inatteignables.
    assert "chgrp 1001 /etc/spark;" in ensemble


def test_un_amorcage_ENRACINE_ne_touche_a_aucun_droit(tmp_path):
    """La symétrie compte autant que l'ouverture : un Spark enraciné n'a pas de
    compte à qui ouvrir. Déborder ici élargirait la lecture des secrets du
    locataire sans que personne l'ait demandé."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/SMTP_HOST",
                      json={"value": "smtp.exemple.test"}).status_code == 200

    reponse = client.post(f"/v1/sparks/{nom}/bootstrap")
    assert reponse.status_code == 200, reponse.text
    assert reponse.json()["mode"] == bootstrap.ENRACINE
    assert _ouvertures(client, nom) == []


def test_une_variable_posee_APRES_l_amorcage_rootless_est_ouverte_elle_aussi(tmp_path):
    """La projection ordinaire, pas seulement celle de l'amorçage. Sans cela,
    tout changement de variable refermerait ce que l'amorçage avait ouvert :
    les fichiers sont régénérés EN ENTIER à chaque fois (§43.2)."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    deja = len(_ouvertures(client, nom))

    assert client.put(f"/v1/sparks/{nom}/env/SMTP_PASSWORD",
                      json={"value": "secret", "secret": True}).status_code == 200
    assert len(_ouvertures(client, nom)) > deja


def test_l_identite_est_gardee_au_registre_et_SEULEMENT_en_rootless(tmp_path):
    """§42.2 bis : un compte présent sans démon utilisable ne donne pas plus
    d'identité qu'il ne donne de mode."""
    client = _client(tmp_path)
    rootless = _creer(client, "avec")
    assert client.post(f"/v1/sparks/{rootless}/bootstrap",
                       json={"rootless": True}).status_code == 200
    enracine = _creer(client, "sans")
    assert client.post(f"/v1/sparks/{enracine}/bootstrap").status_code == 200

    with sqlite3.connect(tmp_path / "b.db") as base:
        base.row_factory = sqlite3.Row
        lignes = {r["name"]: r for r in base.execute(
            "SELECT s.name, o.docker_mode, o.docker_uid, o.docker_gid"
            " FROM spark_bootstrap_observation o JOIN spark s ON s.id = o.spark_id")}
    assert lignes["avec"]["docker_mode"] == "rootless"
    assert lignes["avec"]["docker_uid"] == 1001
    assert lignes["avec"]["docker_gid"] == 1001
    assert lignes["sans"]["docker_mode"] == "enracine"
    assert lignes["sans"]["docker_uid"] is None
    assert lignes["sans"]["docker_gid"] is None


def test_une_ligne_ANTERIEURE_a_la_migration_ne_se_reconstitue_pas(tmp_path):
    """§44.4 : un relevé daté dit ce qu'il a vu à cette date. Sur une ligne
    écrite avant la 015, les fichiers restent fermés jusqu'au prochain amorçage
    — c'est le geste que l'OP-18 nomme, et non une identité inventée."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    with sqlite3.connect(tmp_path / "b.db") as base:
        base.execute("UPDATE spark_bootstrap_observation"
                     " SET docker_uid = NULL, docker_gid = NULL")
        base.commit()
    deja = len(_ouvertures(client, nom))

    assert client.put(f"/v1/sparks/{nom}/env/SMTP_HOST",
                      json={"value": "smtp.exemple.test"}).status_code == 200
    assert len(_ouvertures(client, nom)) == deja


# --- Le panneau que le bandeau enterrait (§42.2 quater) ---------------------


def test_l_amorcage_TAIT_le_bandeau_de_la_distribution_et_le_dit(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client)
    corps = client.post(f"/v1/sparks/{nom}/bootstrap").json()

    ligne = next(item for item in corps["items"] if item["key"] == "motd")
    assert ligne["outcome"] == "installé"
    # `present` comme les cinq éléments : la ligne nomme le PANNEAU du produit,
    # pas le bandeau retiré. L'inverse aurait affiché « absent » à côté
    # d'« installé » sur le seul cas où l'absence est le succès.
    assert ligne["state"] == bootstrap.PRESENT
    assert "panneau" in ligne["label"]
    assert "chmod -x /etc/update-motd.d" in " ".join(_commandes(client, nom))
    # §42.8 : le journal NOMME ce qui a été fait.
    audit = client.get("/v1/audit?action=spark.bootstrap").json()["entries"][0]
    assert "motd" in json.loads(audit["payload"])["items"]


def test_un_bandeau_deja_tu_ne_se_retait_pas(tmp_path):
    """§42.1 : n'agir que sur les manques. Un geste rejoué « au cas où » est
    exactement ce que cette section interdit."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200
    avant = len([c for c in _commandes(client, nom) if "chmod -x" in c])

    corps = client.post(f"/v1/sparks/{nom}/bootstrap").json()
    assert corps["changed"] is False
    assert not any(item["key"] == "motd" for item in corps["items"])
    assert len([c for c in _commandes(client, nom) if "chmod -x" in c]) == avant


def test_le_panneau_ORDONNE_de_lire_le_briefing_au_lieu_de_le_nommer(tmp_path):
    """§44.1 : « Briefing : <chemin> » nommait un fichier sans dire qu'il fallait
    l'ouvrir. Ni un humain ni un agent n'y voyait une instruction."""
    client = _client(tmp_path)
    nom = _creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200
    motd = client.app.state.incus.created[nom]["files"][briefing_service.FICHIER_MOTD]

    lignes = motd.splitlines()
    assert len(lignes) == 3, motd
    assert lignes[2].startswith("Lisez d'abord ")
    assert briefing_service.FICHIER_MARKDOWN in lignes[2]
    # Il dit aussi CE QU'ON Y TROUVE : « lisez ce fichier » sans son contenu se
    # remet à plus tard (§44.2).
    assert "quotas" in lignes[2] and "pièges" in lignes[2]
