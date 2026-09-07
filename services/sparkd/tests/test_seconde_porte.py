"""@verifies docs/BACKLOG.md#SPK-95 · docs/DAT.md §42.2 quater (la seconde
            porte), §37.4.9 (le compte de la session), §44.10 (les deux
            commandes de rebond) · §17.1 (un seul mécanisme, régénéré en entier)

Ce que ces preuves gardent : **root reste la porte administrative et le défaut.**
`spark-docker` s'AJOUTE, et seulement quand le relevé dit `rootless`. Remplacer
root serait un défaut — le briefing est `0600 root`, le dépannage donne un shell
root, et un amorçage à moitié raté est précisément le moment où il faut root.

La seconde garde est celle du §17.1 : le fichier est régénéré EN ENTIER des deux
côtés. Une clé révoquée qui survivrait dans celui qu'on oublie est exactement le
défaut que ce paragraphe existe pour empêcher — et c'est pourquoi le relevé juge
les DEUX portes au lieu d'une.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sparkd import bootstrap
from sparkd import briefing as briefing_service
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

CLE_PUBLIQUE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3f"
                "R0CvBnyFDMmDcrFbYT poste")
AUTRE_CLE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb3wOaLpVLQwZ5r0GkqPBIRr09Y"
             "s6dJ0kLDkAiKZnFq portable")


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
    return nom


def _accorder(client, nom, label, cle):
    deja = [c["label"] for c in client.get("/v1/ssh-keys").json()["keys"]]
    if label not in deja:
        assert client.post("/v1/ssh-keys", json={
            "label": label, "public_key": cle}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/ssh-keys/{label}").status_code == 200


def _fichiers(client, nom):
    return client.app.state.incus.created[nom]["files"]


# --- Les deux portes, et l'invariant du §17.1 -------------------------------


def test_un_spark_ROOTLESS_recoit_les_cles_sur_les_DEUX_comptes(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200

    fichiers = _fichiers(client, nom)
    assert sshkeys_root(fichiers) == fichiers[bootstrap.AUTHORIZED_KEYS_ROOTLESS]
    assert CLE_PUBLIQUE in fichiers[bootstrap.AUTHORIZED_KEYS_ROOTLESS]


def sshkeys_root(fichiers):
    return fichiers["/root/.ssh/authorized_keys"]


def test_un_spark_ENRACINE_n_ouvre_AUCUNE_seconde_porte(tmp_path):
    """Root reste seul là où il n'y a pas de compte de service. Poser un fichier
    dans un foyer inexistant n'ouvrirait rien et laisserait croire le
    contraire."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200

    assert bootstrap.AUTHORIZED_KEYS_ROOTLESS not in _fichiers(client, nom)


def test_un_RETRAIT_de_cle_retire_des_DEUX_cotes(tmp_path):
    """§17.1 : le fichier est régénéré EN ENTIER, et c'est ce qui fait qu'un
    retrait retire. Avec deux fichiers, une clé révoquée qui survivrait dans
    celui qu'on oublie est le défaut même que ce paragraphe empêche."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    _accorder(client, nom, "portable", AUTRE_CLE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    seconde = bootstrap.AUTHORIZED_KEYS_ROOTLESS
    assert AUTRE_CLE in _fichiers(client, nom)[seconde]

    assert client.delete(f"/v1/sparks/{nom}/ssh-keys/portable").status_code == 200
    fichiers = _fichiers(client, nom)
    assert AUTRE_CLE not in fichiers["/root/.ssh/authorized_keys"]
    assert AUTRE_CLE not in fichiers[seconde], "la clé a survécu dans la seconde porte"
    assert CLE_PUBLIQUE in fichiers[seconde]


def test_une_seconde_porte_VIDE_est_un_defaut_pas_des_cles_conformes(tmp_path):
    """Sans cela, l'écran afficherait « clés conformes » pendant que la porte de
    `spark-docker` n'est ouverte à personne — et un agent y enverrait sa session
    contre une porte que le produit vient de déclarer bonne (§42.10.4)."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    # La seconde porte disparaît de la cellule, sans que le registre change.
    pilote = client.app.state.incus
    pilote.created[nom]["runtime"]["cles_rootless"] = "absent"
    pilote._persist()

    ligne = next(item for item in client.get(f"/v1/sparks/{nom}/bootstrap").json()["items"]
                 if item["key"] == "cles")
    assert ligne["state"] == bootstrap.DEFECT
    assert bootstrap.COMPTE_ROOTLESS in ligne["detail"]


def test_une_seconde_porte_PERIMEE_est_un_defaut(tmp_path):
    """Une empreinte qui ne correspond plus au registre veut dire qu'une clé
    retirée peut y survivre. C'est un défaut, pas une conformité."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    pilote = client.app.state.incus
    pilote.created[nom]["runtime"]["cles_rootless"] = "a" * 64
    pilote._persist()

    ligne = next(item for item in client.get(f"/v1/sparks/{nom}/bootstrap").json()["items"]
                 if item["key"] == "cles")
    assert ligne["state"] == bootstrap.DEFECT
    assert "registre" in ligne["detail"]


def test_le_second_amorcage_rootless_ne_refait_RIEN(tmp_path):
    """La seconde porte ne doit pas rendre l'amorçage bavard : une fois posée,
    elle est conforme, et le §42.1 veut qu'on n'agisse que sur les manques."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    corps = client.post(f"/v1/sparks/{nom}/bootstrap", json={"rootless": True}).json()
    assert corps["changed"] is False
    assert corps["complete"] is True


# --- Ce que le briefing en dit (§44.10) -------------------------------------


def test_le_modele_declare_UNE_porte_en_enracine_et_DEUX_en_rootless(tmp_path):
    client = _client(tmp_path)
    enracine = _creer(client, "sans")
    _accorder(client, enracine, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{enracine}/bootstrap").status_code == 200
    rootless = _creer(client, "avec")
    _accorder(client, rootless, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{rootless}/bootstrap",
                       json={"rootless": True}).status_code == 200

    seuls = client.get(f"/v1/sparks/{enracine}/briefing").json()["model"]["access"]
    deux = client.get(f"/v1/sparks/{rootless}/briefing").json()["model"]["access"]
    assert [p["user"] for p in seuls["accounts"]] == ["root"]
    assert [p["user"] for p in deux["accounts"]] == ["root", bootstrap.COMPTE_ROOTLESS]
    # Chaque porte DIT à quoi elle sert : « root ou spark-docker » ne renseigne
    # personne (SPK-DS-21).
    assert all(p["role"] for p in deux["accounts"])


def test_le_dossier_donne_UNE_commande_de_rebond_PAR_porte(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200

    rendu = client.get(
        f"/v1/sparks/{nom}/briefing?jump=ubuntu@203.0.113.10").json()["markdown"]
    assert "ssh -J ubuntu@203.0.113.10 root@" in rendu
    assert f"ssh -J ubuntu@203.0.113.10 {bootstrap.COMPTE_ROOTLESS}@" in rendu
    # Et chacune dit à quoi elle sert, sans quoi il faudrait deviner.
    assert "administrer la cellule" in rendu
    assert "faire tourner la pile" in rendu


def test_un_spark_enracine_n_ANNONCE_pas_une_porte_qui_n_existe_pas(tmp_path):
    """L'annoncer enverrait frapper à une porte absente — et l'annoncer parce
    qu'un compte existe contredirait le §42.2 bis, où le mode est une
    observation."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200

    rendu = client.get(
        f"/v1/sparks/{nom}/briefing?jump=ubuntu@203.0.113.10").json()["markdown"]
    assert f"{bootstrap.COMPTE_ROOTLESS}@" not in rendu


def test_le_briefing_de_la_cellule_NOMME_la_seconde_porte(tmp_path):
    """Depuis l'intérieur aussi : sinon on cherche à faire tourner la pile en
    root, où Docker ne répond pas."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200

    texte = _fichiers(client, nom)[briefing_service.FICHIER_MARKDOWN]
    assert "Mode : rootless" in texte
    assert "mêmes clés" in texte


# --- La porte étroite du journal (§37.4.6, §37.4.9) -------------------------


def test_le_journal_ADMET_le_compte_mais_en_BORNE_la_valeur(tmp_path):
    """Le §37.4.6 refuse les clés inconnues parce qu'un champ libre deviendrait
    le dépôt de secrets en clair que le §37.5 interdit. Admettre `account` sans
    borner sa valeur n'aurait fermé la porte qu'à moitié — la console la borne
    déjà, mais elle n'est pas une autorité."""
    client = _client(tmp_path)
    nom = _creer(client)

    for compte in ("root", bootstrap.COMPTE_ROOTLESS):
        reponse = client.post("/v1/audit", json={
            "action": "spark.terminal_open", "result": "ok",
            "target_type": "spark", "target_id": nom,
            "message": f"Session ouverte, en {compte}.",
            "payload": {"path": "ssh", "account": compte}})
        assert reponse.status_code == 201, reponse.text

    refus = client.post("/v1/audit", json={
        "action": "spark.terminal_open", "result": "ok",
        "target_type": "spark", "target_id": nom, "message": "Session ouverte.",
        "payload": {"path": "ssh", "account": "mot-de-passe-en-clair"}})
    assert refus.status_code == 422
    assert refus.json()["detail"]["error"] == "payload_refused"


# --- Ce que la Forge de test a mesuré : la porte ne s'ouvrait pas -----------
#
# @verifies docs/BACKLOG.md#SPK-95 · docs/DAT.md §42.2 quater (les droits des
#           deux chemins de la seconde porte, mesurés le 2026-09-07), §42.2 ter
#           (la règle qu'ils appliquent), §17.1 (régénéré à chaque écriture)


def _ouvertures(client, nom):
    """Les commandes qui posent des droits, et elles seules."""
    return [" ".join(c) for c in client.app.state.incus.created[nom].get("commands", [])
            if "chgrp" in " ".join(c)]


def test_la_seconde_porte_est_OUVERTE_au_compte_sinon_sshd_ne_la_lit_pas(tmp_path):
    """Mesuré sur la Forge de test : la porte ne s'ouvrait JAMAIS.

    `sshd` lit `authorized_keys` après avoir pris les droits du compte visé.
    `push_file` posant le fichier `0600 root:root`, il rendait *Could not open
    user 'spark-docker' authorized keys … : Permission denied*, que le client
    présente en « Permission denied (publickey) » sans rien expliquer.

    Le dossier compte autant que le fichier : sans son bit `x` pour le groupe,
    `sshd` ne le traverse pas et le fichier reste inatteignable.
    """
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200

    ensemble = " ".join(_ouvertures(client, nom))
    dossier = bootstrap.AUTHORIZED_KEYS_ROOTLESS.rsplit("/", 1)[0]
    # Le GID est celui que la CELLULE a rendu, jamais une constante du produit.
    assert f"chgrp 1001 {dossier};" in ensemble, \
        "le dossier .ssh reste fermé : sshd ne le traversera pas"
    assert f"chgrp 1001 {bootstrap.AUTHORIZED_KEYS_ROOTLESS}" in ensemble, \
        "la clé de la seconde porte reste illisible pour sshd"


def test_un_CHANGEMENT_de_cle_ne_REFERME_pas_la_seconde_porte(tmp_path):
    """Le piège, et la raison pour laquelle la reprojection vit dans `_apply_keys`.

    Le §17.1 réécrit `authorized_keys` EN ENTIER à chaque ajout et à chaque
    retrait, par `push_file` — qui repose un fichier fermé. Ouvrir au seul
    amorçage donnerait une porte qui marche, puis cesse de marcher au premier
    changement de clé, sans geste apparent : exactement la panne que le §42.2 ter
    décrit.
    """
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200
    avant = len(_ouvertures(client, nom))

    # Un ajout, puis un retrait : les deux réécrivent le fichier.
    _accorder(client, nom, "portable", AUTRE_CLE)
    assert len(_ouvertures(client, nom)) > avant, \
        "un ajout de clé a reposé un fichier fermé sans le rouvrir"

    apres_ajout = len(_ouvertures(client, nom))
    assert client.delete(f"/v1/sparks/{nom}/ssh-keys/portable").status_code == 200
    assert len(_ouvertures(client, nom)) > apres_ajout, \
        "un retrait de clé a refermé la seconde porte"


def test_un_spark_ENRACINE_n_ouvre_toujours_RIEN(tmp_path):
    """La symétrie du §42.2 ter : sans compte de service, il n'y a personne à
    qui ouvrir, et déborder ici élargirait un accès que personne n'a demandé."""
    client = _client(tmp_path)
    nom = _creer(client)
    _accorder(client, nom, "poste", CLE_PUBLIQUE)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200

    ensemble = " ".join(_ouvertures(client, nom))
    assert bootstrap.FOYER_ROOTLESS not in ensemble
