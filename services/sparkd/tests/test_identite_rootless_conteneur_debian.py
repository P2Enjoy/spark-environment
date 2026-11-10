"""@verifies docs/BACKLOG.md#SPK-167 · docs/DAT.md §17.6 (pour QUEL compte le
            Spark présente son identité), §17.5 (la clé privée naît dans la
            cellule), §42.2 quater (le dossier du compte reste à root) ·
            CLAUDE.md §15 (les composants critiques ne sont pas remplacés par des
            mocks), §16

Ce que cette preuve garde et qu'aucun doublon ne peut garder : **le compte
`spark-docker` se sert réellement de la clé.** Dans un conteneur Debian 13, avec un
vrai compte, un vrai `chown`, un vrai `sshd` qui joue le rôle du tiers (GitHub) et
un vrai client `ssh` lancé SOUS CE COMPTE :

- le défaut est reproduit — la paire sous `/root/.ssh` est illisible pour lui et
  son authentification est refusée ;
- avec le correctif, la paire de root est REPRISE par le compte : même empreinte,
  et le tiers, dont la liste de clés n'a pas bougé, l'accepte ;
- le compte lit son identité mais ne peut ni la supprimer ni réécrire son
  `authorized_keys` (le dossier reste à root, §42.2 quater) ;
- une création neuve, le refus d'écraser et le remplacement donnent les mêmes
  propriétaires et les mêmes droits.

Les scripts joués sont `identity.CREATION` et le `chown` du système, tels quels.

**Ce que ce n'est PAS : une cellule Incus.** C'est un conteneur Docker : ni
`systemd`, ni idmap Incus, ni démon Docker rootless dans le compte. Il éprouve la
logique du script et les droits du système de fichiers, pas l'amorçage rootless ni
le chemin `incus exec` — ceux-là restent à prouver sur une Forge réelle ou sur le
banc `make forge-vm` (DAT §28.7, OP-42).

Elle est ignorée — avec sa raison — sur un poste sans Docker, ou sans accès à
l'image ou à ses paquets : c'est une limite de l'hôte de test, pas un verdict.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

from sparkd import identity

IMAGE = "debian:13-slim"

#: Le script joué EN ROOT dans la cellule. Il imprime des lignes `clé=valeur`
#: que le test lit : une assertion sur du texte libre se casserait à la première
#: reformulation d'un message d'`ssh`.
SCENARIO = r"""
set -u
export DEBIAN_FRONTEND=noninteractive
if ! { apt-get update -qq && apt-get install -y -qq openssh-client openssh-server; } >/dev/null 2>&1; then
  echo "setup=IMPOSSIBLE"; exit 0
fi
set -e
cat > /creation.sh <<'FIN_DU_SCRIPT_DE_CREATION'
@@CREATION@@
FIN_DU_SCRIPT_DE_CREATION

useradd -m -s /bin/bash spark-docker
useradd -m -s /bin/bash deploy
mkdir -p /run/sshd /home/spark-docker/.ssh /home/deploy/.ssh
chmod 700 /home/deploy/.ssh; chown deploy:deploy /home/deploy/.ssh
# La seconde porte du §42.2 quater, telle que sparkd la laisse.
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fR0CvBnyFDMmDcrFbYT poste" \
  > /home/spark-docker/.ssh/authorized_keys
chown root:spark-docker /home/spark-docker/.ssh /home/spark-docker/.ssh/authorized_keys
chmod 750 /home/spark-docker/.ssh; chmod 640 /home/spark-docker/.ssh/authorized_keys
/usr/sbin/sshd -p 2222 -o ListenAddress=127.0.0.1
sleep 1

# Le tiers (« GitHub ») n'accepte QUE la clé qu'on lui a posée.
poser_chez_le_tiers() {
  cp "$1" /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys
}
# Le Spark, sous le compte rootless, se présente au tiers avec son identité PAR DÉFAUT.
se_presenter() {
  runuser -u spark-docker -- ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -p 2222 deploy@127.0.0.1 id -un 2>/dev/null || echo REFUSE
}
fiche() { stat -c '%U:%G %a' "$1"; }

# --- A. le défaut : la paire sous /root/.ssh -------------------------------------
mkdir -p /root/.ssh; chmod 700 /root/.ssh
ssh-keygen -t ed25519 -N '' -C spark:crm -f /root/.ssh/id_ed25519 >/dev/null
chmod 600 /root/.ssh/id_ed25519
poser_chez_le_tiers /root/.ssh/id_ed25519.pub
if runuser -u spark-docker -- ssh-keygen -y -f /root/.ssh/id_ed25519 >/dev/null 2>&1
  then echo "A_lecture_par_le_compte=oui"; else echo "A_lecture_par_le_compte=non"; fi
echo "A_connexion=$(se_presenter)"
echo "A_empreinte=$(ssh-keygen -lf /root/.ssh/id_ed25519.pub | cut -d' ' -f2)"

# --- B. le correctif : la paire de root est reprise par le compte -----------------
set +e
sh /creation.sh /home/spark-docker/.ssh spark-docker /root/.ssh spark:crm non >/tmp/b.pub
echo "B_code=$?"
set -e
echo "B_privee=$(fiche /home/spark-docker/.ssh/id_ed25519)"
echo "B_publique=$(fiche /home/spark-docker/.ssh/id_ed25519.pub)"
echo "B_dossier=$(fiche /home/spark-docker/.ssh)"
echo "B_authorized_keys=$(fiche /home/spark-docker/.ssh/authorized_keys)"
echo "B_root_inchangee=$(fiche /root/.ssh/id_ed25519)"
echo "B_empreinte=$(ssh-keygen -lf /home/spark-docker/.ssh/id_ed25519.pub | cut -d' ' -f2)"
if runuser -u spark-docker -- ssh-keygen -y -f /home/spark-docker/.ssh/id_ed25519 >/dev/null 2>&1
  then echo "B_lecture_par_le_compte=oui"; else echo "B_lecture_par_le_compte=non"; fi
echo "B_connexion=$(se_presenter)"
if runuser -u spark-docker -- rm -f /home/spark-docker/.ssh/id_ed25519 2>/dev/null
  then echo "B_suppression_par_le_compte=oui"; else echo "B_suppression_par_le_compte=non"; fi
if runuser -u spark-docker -- sh -c 'echo x > /home/spark-docker/.ssh/authorized_keys' 2>/dev/null
  then echo "B_reecriture_des_acces=oui"; else echo "B_reecriture_des_acces=non"; fi
test -f /home/spark-docker/.ssh/id_ed25519 && echo "B_toujours_la=oui"

# --- C. création neuve, refus d'écraser, remplacement -----------------------------
rm -f /root/.ssh/id_ed25519 /root/.ssh/id_ed25519.pub /home/spark-docker/.ssh/id_ed25519*
set +e
sh /creation.sh /home/spark-docker/.ssh spark-docker /root/.ssh spark:crm non >/dev/null; echo "C_creation=$?"
sh /creation.sh /home/spark-docker/.ssh spark-docker /root/.ssh spark:crm non >/dev/null; echo "C_second_appel=$?"
sh /creation.sh /home/spark-docker/.ssh spark-docker /root/.ssh spark:crm oui >/dev/null; echo "C_remplacement=$?"
set -e
echo "C_privee=$(fiche /home/spark-docker/.ssh/id_ed25519)"
echo "C_publique=$(fiche /home/spark-docker/.ssh/id_ed25519.pub)"
echo "C_empreinte=$(ssh-keygen -lf /home/spark-docker/.ssh/id_ed25519.pub | cut -d' ' -f2)"
poser_chez_le_tiers /home/spark-docker/.ssh/id_ed25519.pub
echo "C_connexion=$(se_presenter)"
echo "FIN=ok"
"""


def _docker_disponible() -> str | None:
    """La raison de ne pas jouer, ou `None` si on peut."""
    if shutil.which("docker") is None:
        return "docker n'est pas installé sur cet hôte"
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        return "le démon docker ne répond pas"
    if subprocess.run(["docker", "image", "inspect", IMAGE],
                      capture_output=True).returncode != 0:
        tire = subprocess.run(["docker", "pull", "-q", IMAGE], capture_output=True)
        if tire.returncode != 0:
            return f"l'image {IMAGE} n'est pas disponible et ne peut pas être tirée"
    return None


@pytest.fixture(scope="module")
def conteneur():
    raison = _docker_disponible()
    if raison:
        pytest.skip(raison)
    scenario = SCENARIO.replace("@@CREATION@@", identity.CREATION)
    fini = subprocess.run(
        # Le scénario est d'abord ÉCRIT dans la cellule : lu sur l'entrée standard,
        # le premier `ssh` venu en avalerait la suite.
        ["docker", "run", "--rm", "-i", IMAGE, "sh", "-c",
         "cat > /scenario.sh && sh /scenario.sh"],
        input=scenario, capture_output=True, text=True, timeout=300, check=False)
    mesures = dict(
        ligne.split("=", 1) for ligne in fini.stdout.splitlines() if "=" in ligne)
    if mesures.get("setup") == "IMPOSSIBLE":
        pytest.skip("les paquets openssh ne peuvent pas être installés dans la "
                    "conteneur d'épreuve (pas de réseau ?)")
    assert mesures.get("FIN") == "ok", (
        f"le scénario n'est pas allé au bout (code {fini.returncode}).\n"
        f"stdout :\n{fini.stdout}\nstderr :\n{fini.stderr[-2000:]}")
    return mesures


def test_A_le_DEFAUT_est_reproduit_le_compte_ne_peut_pas_lire_la_cle_de_root(conteneur):
    assert conteneur["A_lecture_par_le_compte"] == "non"
    assert conteneur["A_connexion"] == "REFUSE", \
        "le tiers connaît la clé, mais le compte qui clone ne peut pas la présenter"


def test_B_le_compte_SE_SERT_de_la_paire_reprise_et_le_tiers_l_accepte(conteneur):
    assert conteneur["B_code"] == str(identity.REPRISE)
    assert conteneur["B_lecture_par_le_compte"] == "oui"
    assert conteneur["B_connexion"] == "deploy", \
        "le tiers, dont la liste n'a PAS bougé, accepte le compte rootless"
    assert conteneur["B_empreinte"] == conteneur["A_empreinte"], \
        "la MÊME clé : celle déjà posée chez le tiers reste valide"


def test_B_la_paire_appartient_au_compte_avec_les_droits_de_ssh(conteneur):
    assert conteneur["B_privee"] == "spark-docker:spark-docker 600"
    assert conteneur["B_publique"] == "spark-docker:spark-docker 644"


def test_B_le_dossier_et_les_acces_restent_a_ROOT_et_la_copie_de_root_demeure(conteneur):
    """§42.2 quater : le compte lit, il ne se réécrit pas ses propres accès."""
    assert conteneur["B_dossier"] == "root:spark-docker 750"
    assert conteneur["B_authorized_keys"] == "root:spark-docker 640"
    assert conteneur["B_root_inchangee"] == "root:root 600"


def test_B_le_compte_ne_peut_NI_supprimer_son_identite_NI_reecrire_ses_acces(conteneur):
    assert conteneur["B_suppression_par_le_compte"] == "non"
    assert conteneur["B_reecriture_des_acces"] == "non"
    assert conteneur["B_toujours_la"] == "oui"


def test_C_creation_neuve_refus_d_ecraser_et_remplacement(conteneur):
    assert conteneur["C_creation"] == "0"
    assert conteneur["C_second_appel"] == str(identity.DEJA)
    assert conteneur["C_remplacement"] == "0"
    assert conteneur["C_privee"] == "spark-docker:spark-docker 600"
    assert conteneur["C_publique"] == "spark-docker:spark-docker 644"
    assert conteneur["C_empreinte"] != conteneur["B_empreinte"]
    assert conteneur["C_connexion"] == "deploy"
