"""@verifies docs/BACKLOG.md#SPK-28 · docs/DAT.md §8.5 (les deux dispositions),
            §8.5 bis (aucune valeur codée en dur, et le refus d'écraser),
            §8.6 (le schéma par défaut livre le pool, et l'amorçage cloud-init)

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


# --- Les deux dispositions (§8.5) -------------------------------------------


def test_disposition_SUR_FICHIER_par_defaut(tmp_path):
    """Sans source nommée, c'est la disposition B — et la taille est la sienne."""
    vu, appels = _lancer(tmp_path, {})
    assert vu.returncode == 0, vu.stderr
    assert "incus storage create spark zfs size=200GiB" in appels
    # Elle DIT ce qu'elle ne couvre pas, au moment où on la crée.
    assert "corruption" in vu.stdout
    assert "n'est PAS couverte" in vu.stdout


def test_la_taille_le_nom_et_le_pilote_sont_CONFIGURABLES(tmp_path):
    """Aucune de ces valeurs ne reste codée en dur (§8.5 bis)."""
    vu, appels = _lancer(tmp_path, {
        "SPARK_POOL_NAME": "tank",
        "SPARK_POOL_DRIVER": "btrfs",
        "SPARK_POOL_FILE_SIZE": "1TiB"})
    assert vu.returncode == 0, vu.stderr
    assert "incus storage create tank btrfs size=1TiB" in appels


@besoin_de_blocs
def test_disposition_NATIVE_quand_deux_peripheriques_VIDES_sont_nommes(tmp_path):
    """`SPARK_POOL_SOURCE` DÉCIDE de la disposition : le renseigner EST le choix."""
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
            # Une partition dit SA taille, ou dit qu'elle prend le RESTE —
            # jamais les deux, jamais aucune : `size: 0` ne veut rien dire, et
            # une taille posée À CÔTÉ du drapeau serait une taille morte.
            if partition.get("use_all_available_space"):
                assert "size" not in partition, partition
            else:
                assert partition["size"] > 0

    for raid in schema["raids"]:
        assert raid["level"] in NIVEAUX_RAID
    for systeme in schema["filesystems"]:
        assert systeme["format"] in FORMATS


def test_la_DERNIERE_partition_remplit_le_disque_par_le_DRAPEAU():
    """Décision du 2026-08-30 : une somme totalisée ne vaut que pour UNE
    capacité de disque ; `use_all_available_space` rend le même schéma valable
    pour toutes. La preuve garde que le drapeau est porté par la dernière
    partition de chaque disque, et par elle SEULE : deux partitions qui
    demandent « tout le reste » ne veulent rien dire."""
    for disque in _schema_du_readme()["disks"]:
        partitions = disque["partitions"]
        assert partitions[-1].get("use_all_available_space") is True, (
            f"{disque['device']} doit finir par le drapeau de remplissage")
        for fixe in partitions[:-1]:
            assert not fixe.get("use_all_available_space"), fixe
            assert fixe["size"] > 0


def test_le_schema_LIVRE_le_pool_sur_la_paire():
    """C'est tout l'objet du schéma par défaut (§8.6, disposition A).

    Le pool est déclaré à l'hébergeur : la machine arrive avec son miroir ZFS,
    au NOM QUE LE PRODUIT LIT PAR DÉFAUT — un pool livré sous un autre nom
    serait invisible du plan de contrôle. La paire reste absente des RAID `md`
    et des systèmes de fichiers : son miroir appartient à ZFS, sans quoi `md`
    reproduirait exactement le problème que ZFS résout.
    """
    from sparkd import config

    schema = _schema_du_readme()
    for disque in schema["disks"]:
        derniere = disque["partitions"][-1]
        assert derniere["number"] == 5, f"{disque['device']} doit porter 5 partitions"

    pools = (schema.get("zfs") or {}).get("pools")
    assert pools and len(pools) == 1, "le pool se déclare à l'hébergeur (§8.6)"
    pool = pools[0]
    assert pool["name"] == config.DEFAULT_STORAGE_POOL
    assert pool["type"] == "mirror"
    assert pool["devices"] == ["/dev/sda5", "/dev/sdb5"]

    engagees = {d for r in schema["raids"] for d in r["devices"]}
    engagees |= {f["device"] for f in schema["filesystems"]}
    for livre in pool["devices"]:
        assert livre not in engagees, f"{livre} appartient au miroir ZFS, pas à md"


def test_le_systeme_reste_sur_un_RAID_en_MIROIR():
    """La disposition A réduit « / », elle ne le laisse pas sans redondance."""
    schema = _schema_du_readme()
    for raid in schema["raids"]:
        assert raid["level"] == "raid_level_1"
        assert len(raid["devices"]) == 2
    montages = {f["mountpoint"] for f in schema["filesystems"]}
    assert montages == {"/", "/boot"}


# --- Le cloud-init du README (§8.6) ------------------------------------------


def _cloud_init_du_readme() -> str:
    import re

    readme = (Path(__file__).resolve().parents[3] / "README.md").read_text("utf-8")
    bloc = re.search(r"```yaml\n(#cloud-config\n.*?)\n```", readme, re.S)
    assert bloc, "le README doit porter l'amorçage cloud-init (§8.6)"
    return bloc.group(1)


def _script_embarque(cloud_init: str) -> str:
    """Le shell sous `content: |`, désindenté comme cloud-init le posera."""
    lignes = cloud_init.splitlines()
    debut = next(i for i, l in enumerate(lignes) if l.strip() == "content: |") + 1
    corps = []
    for ligne in lignes[debut:]:
        if ligne.strip() and not ligne.startswith("      "):
            break
        corps.append(ligne[6:])
    return "\n".join(corps) + "\n"


def test_le_cloud_init_est_EXECUTABLE_et_dit_la_meme_chose_que_l_executeur():
    """Un amorçage qu'on copie-colle et qui casse à la première ligne ne sert à
    rien — et un amorçage qui contredit l'exécuteur du produit est pire.

    Le shell embarqué passe par `sh -n` et le Python embarqué par `ast.parse` :
    c'est la syntaxe de ce qui tournera réellement qui est tenue, pas une
    relecture à l'œil. Puis les valeurs qui doivent être CELLES DU PRODUIT le
    sont : l'empreinte de la clé Zabbly, la liste fermée des phases, le pool
    par défaut que `sparkd` lira, le plan `reuse` — le pool livré s'adopte, il
    ne se recrée pas — et le paquet pris dans `services/sparkd` du dépôt.
    """
    import ast
    import re

    from sparkd import config, forge_install

    cloud_init = _cloud_init_du_readme()
    assert cloud_init.startswith("#cloud-config")
    script = _script_embarque(cloud_init)

    verdict = subprocess.run(["sh", "-n"], input=script,
                             capture_output=True, text=True)
    assert verdict.returncode == 0, verdict.stderr

    heredoc = re.search(r"<<'PY'\n(.*?)\nPY\n", script, re.S)
    assert heredoc, "l'enveloppe du plan doit passer par un heredoc quoté"
    ast.parse(heredoc.group(1))

    assert forge_install.ZABBLY_FINGERPRINT in script
    assert re.search(rf"^POOL={config.DEFAULT_STORAGE_POOL}\b", script, re.M)
    assert "#subdirectory=services/sparkd" in script
    assert '"kind": "reuse"' in heredoc.group(1)
    assert '"sparkd.forge_install"' in heredoc.group(1)
    assert re.search(".*".join(forge_install.PHASES), heredoc.group(1), re.S), (
        "les phases doivent être la liste fermée de l'exécuteur")


def test_le_defaut_du_REMEDE_et_celui_du_SCRIPT_sont_le_MEME():
    """Une consigne de réparation qui contredit le script d'installation apprend
    à se méfier des deux.

    Les deux valeurs vivent à deux endroits — le remède est en Python, le geste
    en shell — et rien d'autre qu'une preuve ne peut les tenir ensemble.
    """
    from sparkd import preflight

    script = SCRIPT.read_text("utf-8")
    assert f'SPARK_POOL_FILE_SIZE:-{preflight.DEFAUT_TAILLE_FICHIER}' in script
