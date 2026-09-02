"""@verifies docs/BACKLOG.md#SPK-28 · docs/DAT.md §8.5 (UNE disposition),
            §8.5 bis (aucune valeur codée en dur, et le refus d'écraser)

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
    assert (f"incus storage create tank btrfs "
            f"source=mirror {BLOCS[0]} {BLOCS[1]}") in appels


@besoin_de_blocs
def test_le_miroir_NATIF_sur_deux_peripheriques_VIDES(tmp_path):
    """La seule disposition : deux supports nommés, et rien d'autre."""
    vu, appels = _lancer(tmp_path, {"SPARK_POOL_SOURCE": ",".join(BLOCS[:2])})
    assert vu.returncode == 0, vu.stderr
    assert (f"incus storage create spark zfs "
            f"source=mirror {BLOCS[0]} {BLOCS[1]}") in appels
    # …et elle dit ce qu'elle apporte en propre.
    assert "reparee" in vu.stdout


# --- Le schéma de partitionnement du README (§8.6) --------------------------


def _schema_du_readme() -> dict:
    import json
    import re

    readme = (Path(__file__).resolve().parents[3] / "README.md").read_text("utf-8")
    bloc = re.search(r"```json\n(.*?)\n```", readme, re.S)
    assert bloc, "le README doit porter le schéma de partitionnement (SPK-28)"
    return json.loads(bloc.group(1))


# Énumérations fermées de `scaleway.baremetal.v1.Schema`. Un libellé inventé —
# « bios », « pool » — est refusé par l'hébergeur, et rien dans le dépôt ne le
# dirait avant la commande d'une machine.
LIBELLES = {
    "unknown_partition_label", "uefi", "legacy", "root",
    "boot", "swap", "data", "home", "raid", "zfs",
}
FORMATS = {"unknown_format", "fat32", "ext4", "swap", "zfs", "xfs"}
NIVEAUX_RAID = {
    "unknown_raid_level", "raid_level_0", "raid_level_1",
    "raid_level_5", "raid_level_6", "raid_level_10",
}


def test_le_schema_du_README_a_la_FORME_QUE_L_HEBERGEUR_ATTEND():
    """Un schéma qu'on copie-colle et que l'hébergeur refuse ne sert à rien.

    Il est relu depuis le README, pas depuis une copie : une copie divergerait,
    et c'est celle du README qui serait employée. La preuve tient la forme de
    `scaleway.baremetal.v1.Schema` — des LISTES, et des valeurs prises dans les
    énumérations — parce que c'est exactement ce qui avait été manqué : un objet
    indexé par périphérique se lit très bien et n'est jamais accepté.
    """
    schema = _schema_du_readme()
    assert set(schema) >= {"disks", "raids", "filesystems"}
    assert isinstance(schema["disks"], list)
    assert isinstance(schema["raids"], list)
    assert isinstance(schema["filesystems"], list)

    for disque in schema["disks"]:
        assert disque["device"].startswith("/dev/")
        numeros = [p["number"] for p in disque["partitions"]]
        assert numeros == list(range(1, len(numeros) + 1))
        for partition in disque["partitions"]:
            assert partition["label"] in LIBELLES, partition["label"]
            assert partition["size"] > 0

    for raid in schema["raids"]:
        assert raid["level"] in NIVEAUX_RAID
    for systeme in schema["filesystems"]:
        assert systeme["format"] in FORMATS


def test_les_partitions_REMPLISSENT_le_disque():
    """Une somme qui ne tombe pas juste laisse un reliquat inatteignable, ou
    fait refuser le schéma. La capacité est celle des disques de la Forge."""
    CAPACITE = 5_986_713_600_000
    for disque in _schema_du_readme()["disks"]:
        somme = sum(p["size"] for p in disque["partitions"])
        assert somme == CAPACITE, f"{disque['device']} totalise {somme}"


def test_le_schema_LAISSE_une_paire_de_partitions_LIBRE():
    """C'est tout l'objet du schéma (§8.6).

    Confier « sda5 » et « sdb5 » à `md` reproduirait exactement le problème que
    le miroir ZFS résout : `md` ne sait pas laquelle des deux copies est la
    bonne. Les confier à l'hébergeur via `zfs` serait pire encore : le pool
    existerait, `creer-pool.sh` verrait une signature et refuserait. La preuve
    garde donc qu'elles n'apparaissent NI dans un RAID, NI dans un système de
    fichiers, NI dans un pool.
    """
    schema = _schema_du_readme()
    for disque in schema["disks"]:
        derniere = disque["partitions"][-1]
        assert derniere["number"] == 5, f"{disque['device']} doit porter 5 partitions"

    assert schema.get("zfs") is None, "le pool ne se déclare PAS à l'hébergeur"

    engagees = {d for r in schema["raids"] for d in r["devices"]}
    engagees |= {f["device"] for f in schema["filesystems"]}
    for libre in ("/dev/sda5", "/dev/sdb5"):
        assert libre not in engagees, f"{libre} doit rester un périphérique NU"


def test_le_systeme_reste_sur_un_RAID_en_MIROIR():
    """Le schéma réduit « / », il ne le laisse pas sans redondance."""
    schema = _schema_du_readme()
    for raid in schema["raids"]:
        assert raid["level"] == "raid_level_1"
        assert len(raid["devices"]) == 2
    montages = {f["mountpoint"] for f in schema["filesystems"]}
    assert montages == {"/", "/boot"}


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
