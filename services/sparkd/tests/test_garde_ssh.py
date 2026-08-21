"""@verifies docs/BACKLOG.md#SPK-61 · docs/DAT.md §46.1 (« restrict » est un faux
            ami, et « command= » est la seule fermeture), §46.3 (le dépannage est
            le seul chemin cassé), §46.4 (contrat FERMÉ : ce qui est accepté, et
            rien d'autre) · §37.3 (le dépannage par « incus exec »)

Ce que ces preuves gardent, et c'est LE point de l'unité : **un shell interactif
est refusé**, et rien d'autre que le dépannage ne passe.

Le VRAI script est exécuté, jamais une reformulation de sa logique : `incus` est
doublé sur le `PATH`, ce qui laisse la garde intacte et lui fait croire qu'elle
tourne sur la Forge. C'est le motif de `test_creer_pool.py`, et celui du
`SPARK_TERMINAL_COMMAND` (§37.4.2 bis) — on remplace la commande, pas le
mécanisme.

Aucune cellule n'est touchée : le doublon d'`incus` écrit ce qu'on lui a demandé.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[3]
GARDE = RACINE / "scripts" / "garde-ssh.sh"
#: Ce que la console lance réellement pour le dépannage (§37.3). Le chemin est
#: cité ici pour que la preuve croisée du bas de fichier ait une source.
TERMINAL_JS = RACINE / "apps" / "webui" / "host" / "terminal.js"


@pytest.fixture()
def forge(tmp_path):
    """Une Forge de doublon : un `incus` sur le `PATH`, et rien d'autre."""
    binaires = tmp_path / "bin"
    binaires.mkdir()
    trace = tmp_path / "incus-appele"
    faux = binaires / "incus"
    faux.write_text(
        "#!/bin/sh\n"
        f'printf "%s\\n" "$*" > {trace}\n'
        'echo "incus a lancé: $*"\n'
    )
    faux.chmod(0o755)
    return {"path": f"{binaires}:{os.environ['PATH']}", "trace": trace}


def appeler(forge, commande=None):
    """Ce que `sshd` fait : il pose `SSH_ORIGINAL_COMMAND` et lance la garde."""
    env = {"PATH": forge["path"]}
    if commande is not None:
        env["SSH_ORIGINAL_COMMAND"] = commande
    return subprocess.run([str(GARDE)], env=env, capture_output=True,
                          text=True, timeout=20)


# --- Ce qui passe, et c'est le seul cas -------------------------------------

def test_le_depannage_passe_et_lance_bien_incus(forge):
    vu = appeler(forge, "incus exec crm-production -- /bin/bash")
    assert vu.returncode == 0, vu.stderr
    # La commande n'est pas seulement acceptée : elle est LANCÉE, et avec les
    # mots qu'on lui a donnés. Une garde qui accepterait sans lancer casserait
    # le §37.3 aussi sûrement qu'un refus.
    assert forge["trace"].read_text().strip() == "exec crm-production -- /bin/bash"


# --- LE POINT DE L'UNITÉ : le shell interactif est refusé -------------------

def test_une_session_SANS_commande_est_refusee(forge):
    """§45.3 : tant que la clé ouvre un shell, tout facteur est un guichet fermé
    à côté d'une porte ouverte. C'est la raison d'être de cette garde."""
    vu = appeler(forge, None)
    assert vu.returncode != 0
    assert not forge["trace"].exists(), "rien n'a été lancé"


def test_une_commande_VIDE_est_refusee_comme_une_absence(forge):
    # `sshd` pose la variable vide dans certains cas ; la confondre avec « pas de
    # commande » est exactement ce qu'il faut faire, et il faut le prouver.
    vu = appeler(forge, "")
    assert vu.returncode != 0
    assert not forge["trace"].exists()


# --- Ce qui est refusé, et qui était la porte ouverte du §46.1 --------------

@pytest.mark.parametrize("commande", [
    # Le trou mesuré : avec « restrict » seul, celle-ci PASSAIT et lisait le
    # registre de la Forge (§46.1).
    "cat /var/lib/sparkd/spark.db",
    "sh -c 'cat /etc/shadow'",
    # `incus` sert à bien autre chose qu'à ouvrir un shell.
    "incus file pull cellule/etc/shadow -",
    "incus list",
    "incus exec crm-production -- /bin/sh",          # shell hors liste
    "incus exec crm-production -- cat /etc/shadow",  # ce n'est pas un shell
    "incus exec --user 0 crm -- /bin/bash",          # option avant le nom
    "incus exec crm-production /bin/bash",           # « -- » manquant
    "incus exec crm-production -- /bin/bash extra",  # un mot de trop
    "incus exec -- /bin/bash",                       # nom manquant
    "incus exec 'crm; rm -rf /' -- /bin/bash",       # injection par le nom
    "incus exec crm-production -- /bin/bash; id",    # injection par la fin
    "incus exec ../evasion -- /bin/bash",            # remontée de chemin
    "incus exec CRM -- /bin/bash",                   # casse : le motif est bas
    "incus exec -crm -- /bin/bash",                  # tiret en tête
    "incus exec crm- -- /bin/bash",                  # tiret en fin
])
def test_tout_le_reste_est_refuse(forge, commande):
    vu = appeler(forge, commande)
    assert vu.returncode != 0, f"« {commande} » aurait dû être refusée"
    assert not forge["trace"].exists(), f"« {commande} » a LANCÉ quelque chose"


def test_un_nom_trop_long_est_refuse(forge):
    vu = appeler(forge, f"incus exec {'a' * 64} -- /bin/bash")
    assert vu.returncode != 0
    assert not forge["trace"].exists()


def test_le_globbing_ne_developpe_rien(forge, tmp_path, monkeypatch):
    """Sans `set -f`, « * » se développerait sur les fichiers du répertoire
    courant et la garde validerait des mots qu'on ne lui a pas envoyés."""
    piege = tmp_path / "atelier"
    piege.mkdir()
    (piege / "crm-production").touch()
    monkeypatch.chdir(piege)
    vu = subprocess.run(
        [str(GARDE)], cwd=piege, capture_output=True, text=True, timeout=20,
        env={"PATH": forge["path"], "SSH_ORIGINAL_COMMAND": "incus exec * -- /bin/bash"})
    assert vu.returncode != 0
    assert not forge["trace"].exists()


# --- Ce que le refus dit, et ce qu'il ne dit pas -----------------------------

def test_le_refus_ne_DECRIT_PAS_la_grammaire_acceptee(forge):
    """§46.4 : décrire ce qui est accepté à qui n'y a pas droit lui apprend à le
    contourner. Le détail va au journal de la Forge, pas au client."""
    vu = appeler(forge, "cat /etc/shadow")
    sortie = vu.stdout + vu.stderr
    for indice in ("incus", "exec", "/bin/bash", "permitopen"):
        assert indice not in sortie, f"le refus souffle « {indice} » au client"
    assert sortie.strip(), "un refus muet ferait chercher une panne réseau"


# --- La preuve CROISÉE : la garde et la console parlent du même shell --------

def test_le_shell_admis_est_CELUI_que_la_console_lance():
    """Les deux listes vivent sur deux machines et dans deux langages. Les
    laisser diverger rendrait le dépannage inutilisable — et le §37.3 sert
    précisément quand le `sshd` d'un Spark est muet, c'est-à-dire au pire
    moment."""
    admis = [m for ligne in GARDE.read_text().splitlines()
             if ligne.startswith("SHELLS_ADMIS=")
             for m in ligne.split("'")[1].split()]
    console = TERMINAL_JS.read_text()
    for shell in admis:
        assert f"'{shell}'" in console, (
            f"la garde admet {shell}, que la console ne lance nulle part")
    # …et réciproquement : ce que la console lance doit être admis.
    assert "'/bin/bash'" in console
    assert "/bin/bash" in admis
