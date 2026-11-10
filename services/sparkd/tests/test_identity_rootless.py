"""@verifies docs/BACKLOG.md#SPK-167 · docs/DAT.md §17.6 (pour QUEL compte le
            Spark présente son identité), §17.5 (la clé privée naît dans la
            cellule), §42.2 bis (le mode est une observation), §42.2 quater (le
            dossier du compte reste à root) · docs/manuel/M6-acces.md (Identité
            du Spark)

Ce que ces preuves gardent : **l'identité appartient au compte qui fait tourner
la pile.** Sur un Spark amorcé en rootless, c'est `spark-docker` — celui qui
clone et qui construit —, pas `root`. Posée sous `/root/.ssh`, la clé était
affichée par la console, copiée chez GitHub, et illisible pour le seul compte qui
devait s'en servir.

Trois étages, parce qu'aucun ne suffit seul :

- le doublon de pilote (rapide) vérifie QUEL chemin la route vise ;
- le vrai `sh` et le vrai `ssh-keygen` jouent le script de création, pour que sa
  logique (refus d'écraser, remplacement, reprise de la paire de root) soit
  éprouvée sur autre chose qu'un doublon qui la mimerait ;
- l'API, sur un Spark RÉELLEMENT amorcé en rootless, relie le tout au relevé
  d'amorçage dont le mode décide.

Le propriétaire réel des fichiers (`chown` vers un compte qui existe) ne peut pas
s'éprouver sans root : il l'est dans un conteneur Debian 13 par
`test_identite_rootless_conteneur_debian.py`.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sparkd import bootstrap, identity
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

PRIVEE_ROOT = "/root/.ssh/id_ed25519"
PRIVEE_COMPTE = "/home/spark-docker/.ssh/id_ed25519"

CLE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ1YQr7v3xVYQ8Vb5Wl0Zx8mS0F5Zt3n"
       "Qh7pQ2bK9tXe spark:crm")


class PiloteFactice:
    """Doublon minimal : il REND ce qu'on lui dit, et retient ce qu'on lui passe."""

    def __init__(self, reponses):
        self.reponses = list(reponses)
        self.appels: list[list[str]] = []

    def exec_capture(self, name, command):
        self.appels.append(command)
        return self.reponses.pop(0)


# --- Étage 1 : QUEL chemin la route vise -------------------------------------


def test_le_releve_rootless_lit_le_foyer_du_COMPTE_et_pas_celui_de_root():
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    vu = identity.relever(pilote, "cellule", rootless=True)
    assert f"{PRIVEE_COMPTE}.pub" in pilote.appels[0]
    assert PRIVEE_ROOT not in " ".join(pilote.appels[0])
    assert vu["path"] == PRIVEE_COMPTE


def test_le_releve_enracine_lit_toujours_root():
    pilote = PiloteFactice([(4, "", "")])
    vu = identity.relever(pilote, "cellule")
    assert f"{PRIVEE_ROOT}.pub" in pilote.appels[0]
    assert vu["path"] == PRIVEE_ROOT


def test_la_creation_rootless_vise_le_foyer_du_compte_et_le_NOMME():
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    identity.creer(pilote, "cellule", "crm", rootless=True)
    commande = pilote.appels[0]
    assert "/home/spark-docker/.ssh" in commande, "le dossier du compte"
    assert bootstrap.COMPTE_ROOTLESS in commande, "le compte qui reçoit la paire"
    assert "/root/.ssh" in commande, "la paire de root, candidate à la reprise (§17.6)"
    # Le nom de Spark reste un ARGUMENT, jamais interpolé dans le script (SPK-74).
    assert "spark:crm" in commande
    assert "crm" not in commande[2]


def test_la_creation_enracinee_ne_nomme_aucun_compte_et_ne_reprend_rien():
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    identity.creer(pilote, "cellule", "crm")
    commande = pilote.appels[0]
    assert "/root/.ssh" in commande
    assert "/home/spark-docker" not in " ".join(commande)
    assert bootstrap.COMPTE_ROOTLESS not in commande


def test_la_reprise_se_SIGNALE_et_n_est_pas_confondue_avec_un_echec():
    pilote = PiloteFactice([(identity.REPRISE, CLE + "\n", "")])
    cree = identity.creer(pilote, "cellule", "crm", rootless=True)
    assert cree["adopted"] is True
    assert cree["state"] == identity.PRESENTE
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    assert identity.creer(pilote, "cellule", "crm", rootless=True)["adopted"] is False


# --- Étage 2 : le vrai shell, le vrai ssh-keygen ------------------------------

pytestmark_shell = pytest.mark.skipif(
    shutil.which("sh") is None or shutil.which("ssh-keygen") is None,
    reason="le script de création a besoin de sh et de ssh-keygen sur cet hôte")


class Cellule:
    """Un foyer de ROOT et un foyer de COMPTE dans un dossier temporaire.

    `chown` est remplacé par un enregistreur : l'hôte de test n'est pas root et
    le compte `spark-docker` n'y existe pas. Le vrai `chown` est éprouvé dans
    un conteneur Debian (voir l'en-tête). Tout le reste — `sh`, `ssh-keygen`,
    `chmod`, `cp`, `rm`, `id` — est le vrai.
    """

    def __init__(self, racine: Path):
        self.racine = racine
        self.root_ssh = racine / "root" / ".ssh"
        self.compte_ssh = racine / "home" / "spark-docker" / ".ssh"
        self.journal = racine / "chown.log"
        bac = racine / "bin"
        bac.mkdir()
        (bac / "chown").write_text(
            f'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "{self.journal}"\n')
        (bac / "chown").chmod(0o755)
        self.bac = bac
        # Le compte de la cellule est l'utilisateur du test : `id -gn` répond.
        self.compte = _utilisateur()

    def chowns(self) -> list[str]:
        return self.journal.read_text().splitlines() if self.journal.exists() else []

    def jouer(self, *, rootless: bool, remplacer: bool = False,
              commentaire: str = "spark:crm"):
        dossier = self.compte_ssh if rootless else self.root_ssh
        reprise = str(self.root_ssh) if rootless else ""
        compte = self.compte if rootless else ""
        env = {**os.environ, "PATH": f"{self.bac}:{os.environ['PATH']}"}
        return subprocess.run(
            ["sh", "-c", identity.CREATION, "sh", str(dossier), compte, reprise,
             commentaire, "oui" if remplacer else "non"],
            capture_output=True, text=True, env=env, check=False)

    def poser_paire_root(self):
        """Ce que le défaut a laissé : une vraie paire sous `/root/.ssh`."""
        self.root_ssh.mkdir(parents=True)
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "spark:ancienne",
             "-f", str(self.root_ssh / "id_ed25519")],
            capture_output=True, check=True)


def _utilisateur() -> str:
    import getpass
    return getpass.getuser()


@pytest.fixture
def cellule(tmp_path):
    return Cellule(tmp_path)


def _droits(chemin: Path) -> int:
    return stat.S_IMODE(chemin.stat().st_mode)


@pytestmark_shell
def test_shell_rootless_pose_la_paire_chez_le_compte_avec_les_bons_droits(cellule):
    cree = cellule.jouer(rootless=True)
    assert cree.returncode == 0, cree.stderr
    privee = cellule.compte_ssh / "id_ed25519"
    assert privee.is_file()
    assert _droits(privee) == 0o600, "la clé privée n'est lisible que de son propriétaire"
    assert _droits(Path(f"{privee}.pub")) == 0o644
    assert cree.stdout.strip() == Path(f"{privee}.pub").read_text().strip()
    assert cree.stdout.startswith("ssh-ed25519 ")
    assert "spark:crm" in cree.stdout
    assert not (cellule.root_ssh / "id_ed25519").exists(), \
        "rien n'est posé sous root : c'était le défaut"


@pytestmark_shell
def test_shell_rootless_remet_la_paire_au_COMPTE_et_pas_a_root(cellule):
    cellule.jouer(rootless=True)
    lignes = cellule.chowns()
    privee = str(cellule.compte_ssh / "id_ed25519")
    chez_le_compte = [ligne for ligne in lignes if privee in ligne]
    assert chez_le_compte, f"aucun chown de la clé privée : {lignes}"
    assert chez_le_compte[-1].startswith(f"{cellule.compte}: "), chez_le_compte
    assert f"{privee}.pub" in chez_le_compte[-1], "la publique suit la privée"


@pytestmark_shell
def test_shell_rootless_dossier_absent_nait_a_root_et_groupe_du_compte_0750(cellule):
    """§42.2 quater : le dossier reste à root, sinon le compte pourrait supprimer
    et réécrire son propre `authorized_keys`."""
    assert not cellule.compte_ssh.exists()
    assert cellule.jouer(rootless=True).returncode == 0
    assert _droits(cellule.compte_ssh) == 0o750
    groupe = subprocess.run(["id", "-gn", cellule.compte], capture_output=True,
                            text=True, check=True).stdout.strip()
    assert f"root:{groupe} {cellule.compte_ssh}" in cellule.chowns()


@pytestmark_shell
def test_shell_rootless_ne_TOUCHE_pas_aux_droits_d_un_dossier_deja_pose(cellule):
    """La seconde porte (§42.2 quater) a déjà posé et ouvert ce dossier ; le
    redimensionner ici défairait ce qu'`_ouvrir_au_rootless` entretient."""
    cellule.compte_ssh.mkdir(parents=True)
    cellule.compte_ssh.chmod(0o710)
    assert cellule.jouer(rootless=True).returncode == 0
    assert _droits(cellule.compte_ssh) == 0o710
    assert not [ligne for ligne in cellule.chowns() if ligne.startswith("root:")], \
        "le dossier n'est ni re-propriétarisé ni re-groupé"


@pytestmark_shell
def test_shell_REFUSE_d_ecraser_et_la_cle_ne_change_pas(cellule):
    premiere = cellule.jouer(rootless=True)
    avant = (cellule.compte_ssh / "id_ed25519.pub").read_text()
    encore = cellule.jouer(rootless=True)
    assert encore.returncode == identity.DEJA, encore.stderr
    assert encore.stdout == ""
    assert (cellule.compte_ssh / "id_ed25519.pub").read_text() == avant
    assert premiere.stdout.strip() == avant.strip()


@pytestmark_shell
def test_shell_le_remplacement_fait_une_NOUVELLE_paire(cellule):
    cellule.jouer(rootless=True)
    avant = (cellule.compte_ssh / "id_ed25519.pub").read_text()
    remplace = cellule.jouer(rootless=True, remplacer=True)
    assert remplace.returncode == 0, remplace.stderr
    apres = (cellule.compte_ssh / "id_ed25519.pub").read_text()
    assert apres != avant
    assert _droits(cellule.compte_ssh / "id_ed25519") == 0o600


@pytestmark_shell
def test_shell_reprend_la_paire_de_root_SANS_la_changer_ni_la_retirer(cellule):
    """§17.6 : la clé est peut-être déjà posée chez GitHub. La régénérer
    l'invaliderait pour réparer un chemin."""
    cellule.poser_paire_root()
    ancienne = (cellule.root_ssh / "id_ed25519.pub").read_text()
    privee_root = (cellule.root_ssh / "id_ed25519").read_bytes()

    repris = cellule.jouer(rootless=True)
    assert repris.returncode == identity.REPRISE, repris.stderr
    assert repris.stdout.strip() == ancienne.strip(), "MÊME clé, même empreinte"
    assert (cellule.compte_ssh / "id_ed25519").read_bytes() == privee_root
    assert _droits(cellule.compte_ssh / "id_ed25519") == 0o600
    assert _droits(cellule.compte_ssh / "id_ed25519.pub") == 0o644
    # La copie de root n'est ni déplacée ni supprimée ni modifiée.
    assert (cellule.root_ssh / "id_ed25519.pub").read_text() == ancienne
    assert (cellule.root_ssh / "id_ed25519").read_bytes() == privee_root
    # …et elle est remise au compte.
    assert any(f"{cellule.compte}: " in ligne for ligne in cellule.chowns())


@pytestmark_shell
def test_shell_la_reprise_n_a_lieu_qu_UNE_fois(cellule):
    cellule.poser_paire_root()
    assert cellule.jouer(rootless=True).returncode == identity.REPRISE
    assert cellule.jouer(rootless=True).returncode == identity.DEJA


@pytestmark_shell
def test_shell_remplacer_ne_reprend_PAS_la_paire_de_root(cellule):
    """Demander un remplacement, c'est demander une clé neuve."""
    cellule.poser_paire_root()
    ancienne = (cellule.root_ssh / "id_ed25519.pub").read_text()
    neuf = cellule.jouer(rootless=True, remplacer=True)
    assert neuf.returncode == 0, neuf.stderr
    assert (cellule.compte_ssh / "id_ed25519.pub").read_text() != ancienne


@pytestmark_shell
def test_shell_une_paire_INCOMPLETE_sous_root_n_est_pas_reprise(cellule):
    cellule.poser_paire_root()
    (cellule.root_ssh / "id_ed25519.pub").unlink()
    neuf = cellule.jouer(rootless=True)
    assert neuf.returncode == 0, neuf.stderr
    assert neuf.stdout.startswith("ssh-ed25519 ")


@pytestmark_shell
def test_shell_enracine_est_INCHANGE_dossier_0700_aucun_chown(cellule):
    cree = cellule.jouer(rootless=False)
    assert cree.returncode == 0, cree.stderr
    assert (cellule.root_ssh / "id_ed25519").is_file()
    assert _droits(cellule.root_ssh) == 0o700
    assert _droits(cellule.root_ssh / "id_ed25519") == 0o600
    assert cellule.chowns() == [], "root garde ce qu'il a créé"
    assert not cellule.compte_ssh.exists()
    assert cellule.jouer(rootless=False).returncode == identity.DEJA


@pytestmark_shell
def test_shell_un_commentaire_hostile_ne_ferme_pas_la_quote(cellule):
    cree = cellule.jouer(rootless=True, commentaire="spark:x'; touch PWNED; '")
    assert cree.returncode == 0, cree.stderr
    assert not (Path.cwd() / "PWNED").exists()
    assert not (cellule.racine / "PWNED").exists()


@pytestmark_shell
def test_shell_le_compte_inconnu_est_une_ERREUR_dite_et_ne_pose_rien(cellule):
    """Un compte qui n'existe pas ne doit ni être inventé ni laisser une clé
    orpheline sous root (§18 : pas de succès simulé)."""
    env = {**os.environ, "PATH": f"{cellule.bac}:{os.environ['PATH']}"}
    perdu = subprocess.run(
        ["sh", "-c", identity.CREATION, "sh", str(cellule.compte_ssh),
         "compte-qui-n-existe-pas-xyz", "", "spark:crm", "non"],
        capture_output=True, text=True, env=env, check=False)
    assert perdu.returncode != 0
    assert not (cellule.compte_ssh / "id_ed25519").exists()


# --- Étage 3 : l'API, sur un Spark réellement amorcé -------------------------


def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "i.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _creer_spark(client, nom="crm"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def _amorcer(client, nom, *, rootless):
    reponse = client.post(f"/v1/sparks/{nom}/bootstrap",
                          json={"rootless": rootless})
    assert reponse.status_code == 200, reponse.text


def _identites_cellule(client, nom) -> dict:
    return client.app.state.incus.created[nom]["runtime"].get("identity_files", {})


def test_API_un_Spark_ROOTLESS_cree_son_identite_chez_le_compte(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=True)

    avant = client.get(f"/v1/sparks/{nom}/identity").json()
    assert avant["state"] == identity.ABSENTE
    assert avant["path"] == PRIVEE_COMPTE, "même la ligne « absente » dit où elle ira"

    cree = client.post(f"/v1/sparks/{nom}/identity", json={})
    assert cree.status_code == 201, cree.text
    corps = cree.json()
    assert corps["path"] == PRIVEE_COMPTE
    assert corps["adopted"] is False

    dans_la_cellule = _identites_cellule(client, nom)
    assert list(dans_la_cellule) == [PRIVEE_COMPTE], \
        "UNE paire, chez le compte — rien sous /root"
    assert dans_la_cellule[PRIVEE_COMPTE]["owner"] == bootstrap.COMPTE_ROOTLESS

    relu = client.get(f"/v1/sparks/{nom}/identity").json()
    assert relu["state"] == identity.PRESENTE
    assert relu["public_key"] == corps["public_key"], \
        "le relevé lit ce que la création a posé : le MÊME chemin"
    assert relu["path"] == PRIVEE_COMPTE


def test_API_un_Spark_ENRACINE_garde_root(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=False)
    cree = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    assert cree["path"] == PRIVEE_ROOT
    assert list(_identites_cellule(client, nom)) == [PRIVEE_ROOT]
    assert _identites_cellule(client, nom)[PRIVEE_ROOT]["owner"] == "root"


def test_API_un_Spark_jamais_amorce_garde_root(tmp_path):
    """Aucun relevé d'amorçage : pas de mode, donc pas de compte à qui donner."""
    client = _client(tmp_path)
    nom = _creer_spark(client)
    cree = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    assert cree["path"] == PRIVEE_ROOT


def test_API_le_refus_d_ecraser_vaut_aussi_en_rootless(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=True)
    premiere = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    encore = client.post(f"/v1/sparks/{nom}/identity", json={})
    assert encore.status_code == 409
    assert encore.json()["detail"]["error"] == "identity_exists"
    assert client.get(f"/v1/sparks/{nom}/identity").json()["public_key"] \
        == premiere["public_key"]


def test_API_le_remplacement_rootless_change_la_cle_DU_COMPTE(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=True)
    premiere = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    seconde = client.post(f"/v1/sparks/{nom}/identity", json={"replace": True})
    assert seconde.status_code == 201, seconde.text
    assert seconde.json()["public_key"] != premiere["public_key"]
    assert list(_identites_cellule(client, nom)) == [PRIVEE_COMPTE]


def test_API_une_identite_deja_posee_sous_root_est_REPRISE_par_le_compte(tmp_path):
    """L'état que le défaut a laissé : l'identité a été créée AVANT l'amorçage
    rootless (cellule vierge de Docker, donc amorçable), sous `/root`."""
    client = _client(tmp_path)
    nom = _creer_spark(client)
    ancienne = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    assert ancienne["path"] == PRIVEE_ROOT
    _amorcer(client, nom, rootless=True)

    # Lire n'écrit rien : pour le compte qui travaille, il n'y a pas d'identité.
    lue = client.get(f"/v1/sparks/{nom}/identity").json()
    assert lue["state"] == identity.ABSENTE
    assert lue["path"] == PRIVEE_COMPTE
    assert list(_identites_cellule(client, nom)) == [PRIVEE_ROOT], \
        "le relevé n'a rien écrit"

    repris = client.post(f"/v1/sparks/{nom}/identity", json={})
    assert repris.status_code == 201, repris.text
    corps = repris.json()
    assert corps["adopted"] is True
    assert corps["public_key"] == ancienne["public_key"], \
        "la MÊME clé : celle déjà posée chez le tiers reste valide"
    assert corps["fingerprint"] == ancienne["fingerprint"]
    assert corps["path"] == PRIVEE_COMPTE

    cellule = _identites_cellule(client, nom)
    assert set(cellule) == {PRIVEE_ROOT, PRIVEE_COMPTE}, "la copie de root reste"
    assert cellule[PRIVEE_ROOT]["owner"] == "root"
    assert cellule[PRIVEE_COMPTE]["owner"] == bootstrap.COMPTE_ROOTLESS

    relu = client.get(f"/v1/sparks/{nom}/identity").json()
    assert relu["state"] == identity.PRESENTE
    assert relu["public_key"] == ancienne["public_key"]

    # Un second geste est un refus, comme pour toute identité présente.
    assert client.post(f"/v1/sparks/{nom}/identity", json={}).status_code == 409


def test_API_le_journal_dit_la_reprise_et_ne_porte_que_l_empreinte(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    ancienne = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    _amorcer(client, nom, rootless=True)
    client.post(f"/v1/sparks/{nom}/identity", json={})

    journal = client.get("/v1/audit?action=spark.identity.create&limit=10").json()
    entrees = journal["entries"]
    reprise = [e for e in entrees if json.loads(e["payload"]).get("adopted") is True]
    assert reprise, [e["payload"] for e in entrees]
    assert "reprise" in reprise[0]["message"].lower()
    assert ancienne["fingerprint"] in reprise[0]["message"]
    assert ancienne["public_key"].split()[1] not in client.get("/v1/audit").text, \
        "§21.2 : jamais le corps d'une clé au journal"


def test_API_la_cle_privee_ne_sort_JAMAIS_en_rootless_non_plus(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=True)
    corps = client.post(f"/v1/sparks/{nom}/identity", json={}).text
    assert "PRIVATE KEY" not in corps.upper()
    assert "PRIVATE KEY" not in client.get(f"/v1/sparks/{nom}/identity").text.upper()


def test_API_une_ligne_ANTERIEURE_a_la_migration_vise_quand_meme_le_compte(tmp_path):
    """Le relevé d'amorçage d'avant la 015 dit `rootless` sans uid ni gid. Les
    FICHIERS restent fermés jusqu'au prochain amorçage (§44.4) — mais l'identité
    n'a pas besoin de l'uid : la cellule résout le compte par son nom. Viser
    `/root` ici reproduirait le défaut sur précisément les Sparks qui l'ont."""
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=True)
    with sqlite3.connect(tmp_path / "i.db") as base:
        base.execute("UPDATE spark_bootstrap_observation"
                     " SET docker_uid = NULL, docker_gid = NULL")
        base.commit()
    cree = client.post(f"/v1/sparks/{nom}/identity", json={}).json()
    assert cree["path"] == PRIVEE_COMPTE


def test_API_un_Spark_ARRETE_rootless_rend_indisponible_avec_le_chemin_du_compte(tmp_path):
    client = _client(tmp_path)
    nom = _creer_spark(client)
    _amorcer(client, nom, rootless=True)
    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 200
    vu = client.get(f"/v1/sparks/{nom}/identity").json()
    assert vu["state"] == identity.INDISPONIBLE
    assert vu["path"] == PRIVEE_COMPTE
