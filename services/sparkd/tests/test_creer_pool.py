"""@verifies docs/BACKLOG.md#SPK-28 · docs/DAT.md §8.5 (UNE disposition),
            §8.5 bis (aucune valeur codée en dur, et le refus d'écraser)
            · docs/BACKLOG.md#SPK-159 · docs/DAT.md §66.1 point 6 (la forme de
            la source du miroir, telle que Incus la décrit)

Ce que ces preuves gardent : **le script ne détruit rien sans le dire**, et il
n'invente aucune valeur.

Le VRAI script est exécuté, jamais une copie ni une reformulation de sa logique :
`id`, `incus` et `wipefs` sont doublés sur le `PATH`, ce qui laisse le script
intact et lui fait croire qu'il est root sur une machine à lui. C'est le même
motif que `SPARK_TERMINAL_COMMAND` (§37.4.2 bis) — on remplace la commande, pas
le mécanisme.

Aucun périphérique n'est touché : le doublon d'`incus` se contente d'écrire ce
qu'on lui a demandé.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "creer-pool.sh"

#: Deux périphériques bloc RÉELS de la machine de test. Le contrôle `[ -b … ]`
#: du script est une primitive du shell : elle ne se double pas par le `PATH`,
#: et lui donner des chemins inventés éprouverait le mauvais refus.
#:
#: Rien n'est écrit dessus, et rien n'en est lu : `incus` et `wipefs` sont
#: doublés. Ce sont des NOMS que le script doit accepter comme des
#: périphériques, pas des cibles.
BLOCS = [p for p in ("/dev/loop0", "/dev/loop1", "/dev/ram0", "/dev/ram1")
         if Path(p).exists()]

besoin_de_blocs = pytest.mark.skipif(
    len(BLOCS) < 2,
    reason="cette machine n'expose pas deux périphériques bloc à nommer")


def _doublons(tmp_path: Path, *, pool_existe: bool = False,
              signatures: dict[str, str] | None = None) -> Path:
    """Un `PATH` où `id`, `incus` et `wipefs` sont des doublons."""
    binaire = tmp_path / "bin"
    binaire.mkdir()
    journal = tmp_path / "appels.txt"

    (binaire / "id").write_text("#!/bin/sh\necho 0\n")
    (binaire / "incus").write_text(
        "#!/bin/sh\n"
        f'echo "incus $*" >> "{journal}"\n'
        # `storage show` décide si le pool existe déjà.
        'case "$1 $2" in\n'
        f'  "storage show") {"exit 0" if pool_existe else "exit 1"} ;;\n'
        'esac\n'
        "exit 0\n")
    # `wipefs` sans `-a` LIT les signatures : c'est ce que le script emploie.
    lignes = "\n".join(
        f'  "{p}") echo "{v}" ;;' for p, v in (signatures or {}).items())
    (binaire / "wipefs").write_text(
        "#!/bin/sh\n"
        'for a in "$@"; do case "$a" in --noheadings) shift ;; esac; done\n'
        'case "$1" in\n'
        f"{lignes}\n"
        "esac\n"
        "exit 0\n")
    for f in binaire.iterdir():
        f.chmod(0o755)
    return binaire


def _lancer(tmp_path: Path, env: dict[str, str], **doublons):
    binaire = _doublons(tmp_path, **doublons)
    complet = {**os.environ, "PATH": f"{binaire}:{os.environ['PATH']}", **env}
    vu = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True,
                        env=complet)
    appels = (tmp_path / "appels.txt")
    return vu, (appels.read_text() if appels.exists() else "")


# --- Ce que le script REFUSE de faire ---------------------------------------


def test_un_pool_DEJA_EN_PLACE_n_est_pas_recree(tmp_path):
    """Recréer « au cas où » détruirait les Sparks qui vivent dessus."""
    vu, appels = _lancer(tmp_path, {}, pool_existe=True)
    assert vu.returncode == 0
    assert "existe deja" in vu.stdout
    assert "storage create" not in appels


@besoin_de_blocs
def test_un_SEUL_peripherique_est_refuse(tmp_path):
    """Sans miroir, ZFS détecte la corruption silencieuse mais ne la répare pas.

    Accepter un périphérique unique livrerait une disposition qui porte le nom
    de « native » sans en donner la protection.
    """
    vu, appels = _lancer(tmp_path, {"SPARK_POOL_SOURCE": BLOCS[0]})
    assert vu.returncode == 2
    assert "exige DEUX" in vu.stderr
    assert "storage create" not in appels



@besoin_de_blocs
def test_un_peripherique_NON_VIDE_est_refuse_AVANT_d_ecrire(tmp_path):
    """§8.5 bis : on refuse d'écraser, on ne le constate pas après.

    Le script REFUSE et montre ce qu'il a trouvé. Un message qui dirait
    seulement « refusé » ferait recommencer sans savoir quoi effacer.
    """
    vu, appels = _lancer(
        tmp_path,
        {"SPARK_POOL_SOURCE": ",".join(BLOCS[:2])},
        signatures={BLOCS[0]: "ext4"})
    assert vu.returncode == 2
    assert "DETRUIRAIT" in vu.stderr
    assert BLOCS[0] in vu.stderr
    assert "storage create" not in appels


def test_un_chemin_qui_n_est_PAS_un_peripherique_bloc_est_refuse(tmp_path):
    vu, appels = _lancer(tmp_path, {"SPARK_POOL_SOURCE": "/etc/hostname,/etc/hosts"})
    assert vu.returncode == 2
    assert "n'est pas un peripherique bloc" in vu.stderr
    assert "storage create" not in appels


# --- UNE seule disposition (§8.5 révisé le 2026-09-02) ----------------------


def test_SANS_source_le_geste_REFUSE_au_lieu_de_creer_sur_fichier(tmp_path):
    """Le pool sur fichier est retiré : l'absence de source ne bascule plus.

    Un défaut qui glisse en silence vers une disposition retirée serait
    exactement ce que le §8.5 bis interdit. Le refus nomme le remède, qui est en
    amont de ce script : commander la machine partitionnée, ou lui ajouter un
    disque.
    """
    vu, appels = _lancer(tmp_path, {})
    assert vu.returncode == 2
    assert "SPARK_POOL_SOURCE est obligatoire" in vu.stderr
    assert "deux disques" in vu.stderr
    assert "storage create" not in appels, "aucun pool n'est créé sans supports"


@besoin_de_blocs
def test_le_nom_et_le_pilote_restent_CONFIGURABLES(tmp_path):
    """Aucune de ces valeurs ne reste codée en dur (§8.5 bis)."""
    vu, appels = _lancer(tmp_path, {
        "SPARK_POOL_NAME": "tank",
        "SPARK_POOL_DRIVER": "btrfs",
        "SPARK_POOL_SOURCE": ",".join(BLOCS[:2])})
    assert vu.returncode == 0, vu.stderr
    # Le nom et le pilote sont ceux demandés. La `source` d'un autre pilote que
    # `zfs` n'est PAS éprouvée ici : la forme du miroir est celle de ZFS (SPK-159,
    # DAT §66.1 point 6), et l'asserter pour btrfs ferait de ce doublon la
    # référence d'une forme que personne n'a vue accepter.
    assert "incus storage create tank btrfs source=" in appels


@besoin_de_blocs
def test_le_miroir_NATIF_sur_deux_peripheriques_VIDES(tmp_path):
    """La seule disposition : deux supports nommés, et rien d'autre."""
    vu, appels = _lancer(tmp_path, {"SPARK_POOL_SOURCE": ",".join(BLOCS[:2])})
    assert vu.returncode == 0, vu.stderr
    # La forme que DÉCRIT Incus (reference/storage_zfs, relue le 2026-11-10) :
    # « To specify a vdev type, use an `=` sign between the vdev type and the block
    # devices », les périphériques séparés par des virgules. L'ancienne forme,
    # `source=mirror /dev/a /dev/b`, était assertée ici contre ce doublon : une
    # preuve dont la référence est l'objet qu'elle garde (SPK-159, DAT §66.1
    # point 6). Éprouvée sur un Incus réel par le banc de redémarrage
    # (`mirror-0`, 2026-11-10) : ce doublon n'en est plus la seule référence.
    assert (f"incus storage create spark zfs "
            f"source=mirror={BLOCS[0]},{BLOCS[1]}\n") in appels
    # …et elle dit ce qu'elle apporte en propre.
    assert "reparee" in vu.stdout


@besoin_de_blocs
def test_la_source_du_miroir_ne_contient_AUCUN_espace(tmp_path):
    """La `source` est UN mot dans la forme décrite par Incus — type de vdev, `=`,
    périphériques séparés par des virgules —, sans espace. Le doublon journalise
    `$*` : un espace dans la valeur trahit l'ancienne forme, que le premier test
    ne distinguerait pas d'une simple coupure de ligne."""
    vu, appels = _lancer(tmp_path, {"SPARK_POOL_SOURCE": ",".join(BLOCS[:2])})
    assert vu.returncode == 0, vu.stderr
    creation = next(l for l in appels.splitlines() if l.startswith("incus storage create"))
    source = [m for m in creation.split() if m.startswith("source=")]
    assert source == [f"source=mirror={BLOCS[0]},{BLOCS[1]}"], creation


# --- Le schéma de partitionnement : ses preuves sont dans test_preparer_forge.py --
#
# Elles relisaient le JSON du README. Depuis SPK-158 le README ne porte plus de
# JSON : une commande le produit (docs/DAT.md §66), et les mêmes propriétés — forme
# de l'API, paire libre, système en miroir — sont gardées sur sa SORTIE.


def test_le_REMEDE_du_preflight_DESIGNE_le_geste_qui_existe():
    """Une consigne de réparation qui contredit le geste d'installation apprend
    à se méfier des deux.

    Le remède vit en Python, le geste en shell ; rien d'autre qu'une preuve ne
    peut les tenir ensemble. Depuis le retrait du pool sur fichier, le remède ne
    doit surtout plus proposer « incus storage create … size= » : cela créerait
    la disposition qu'on vient de retirer.
    """
    from sparkd import preflight

    assert "creer-pool.sh" in preflight.REMEDE_POOL
    assert "SPARK_POOL_SOURCE" in preflight.REMEDE_POOL
    assert "size=" not in preflight.REMEDE_POOL
    assert "SPARK_POOL_SOURCE" in SCRIPT.read_text("utf-8")
