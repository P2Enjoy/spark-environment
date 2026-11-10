"""Preuves de l'amorce cloud-init d'une Forge.

@verifies docs/BACKLOG.md#SPK-73 · docs/DAT.md §50.4-§50.6 (l'executeur ferme),
          §8.2 (le pool s'adopte au rejeu) · README.md (rejeu de l'amorce) ·
          docs/BACKLOG.md#SPK-157 · docs/DAT.md §65.3 (les options IPv4 rejetees
          des le premier demarrage) · docs/BACKLOG.md#SPK-159 · docs/DAT.md §66.2
          points 5 a 7, §66.4, §66.5 (les reglages en arguments nommes ; le pool
          cree seulement sur --pool-source, par creer-pool.sh)

Le script vivait auparavant SEULEMENT sur la machine, produit par le `user_data`
du serveur : ni versionne, ni relisible en revue, ni testable. Ces preuves
existent pour qu'il ne puisse plus repartir a la derive sans qu'on le voie.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[3]
AMORCE = RACINE / "deploy" / "cloud-init" / "spark-amorce.sh"


def source() -> str:
    return AMORCE.read_text(encoding="utf-8")


def code() -> str:
    """Le script SANS ses commentaires : ce que la machine execute vraiment.

    Les commentaires citent legitimement des chemins que le script ne doit pas
    toucher — dire « on ne touche jamais spark.db » est precisement ce qu'on
    veut lire. Les confondre avec du code ferait echouer la preuve sur sa propre
    documentation.
    """
    return "\n".join(l for l in source().splitlines()
                      if not l.lstrip().startswith("#"))


def test_l_amorce_est_versionnee_et_executable():
    assert AMORCE.is_file(), "l'amorce doit vivre au depot, pas seulement sur la Forge"
    assert source().startswith("#!/bin/sh"), "interprete explicite"


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_l_amorce_passe_le_VRAI_parseur_sh():
    """Un releve positif ne doit pas pouvoir coexister avec un script casse.

    Relire un shell a l'oeil laisse passer exactement ce qui casse a 3 h du
    matin sur une machine neuve, quand plus personne ne peut la reparer.
    """
    rendu = subprocess.run(["sh", "-n", str(AMORCE)], capture_output=True, text=True)
    assert rendu.returncode == 0, rendu.stderr


def test_l_amorce_ne_formate_RIEN_elle_meme_et_n_appelle_jamais_zpool_create():
    """Le creer ou le formater detruirait les Sparks d'une Forge en service : c'est
    precisement ce qu'un rejeu ne doit JAMAIS faire (SPK-73).

    Depuis SPK-159 l'amorce peut CREER le pool, mais jamais elle-meme : elle appelle
    `creer-pool.sh`, qui refuse un support deja ecrit, et seulement sur demande
    explicite (`--pool-source`, prouve plus bas). Le plan transmis a l'executeur
    reste une REUTILISATION : quand il est joue, le pool existe.
    """
    texte = code()
    assert "zpool import" in texte, "le pool s'importe s'il n'est pas monte"
    assert '"kind": "reuse"' in texte
    assert '"destructive": False' in texte
    for destructeur in ("zpool create", "mkfs", "sgdisk", "wipefs", "parted",
                        "zpool destroy", "zpool labelclear"):
        assert destructeur not in texte, f"l'amorce ne doit jamais appeler {destructeur}"


def test_l_amorce_est_IDEMPOTENTE_sur_chacun_de_ses_gestes():
    """Chaque pose couteuse est gardee : SPK-73 en fait un contrat.

    Sans ces gardes, un rejeu recreerait un venv, reimporterait un pool deja
    monte, ou redemanderait a Incus un stockage qu'il connait deja.
    """
    texte = source()
    assert re.search(r'zpool list "\$POOL" >/dev/null 2>&1 \|\| zpool import', texte)
    assert re.search(r'^if ! pool_present; then$', texte, re.M), \
        "un pool present ou importable n'est JAMAIS recree"
    assert re.search(r'incus storage show "\$POOL" >/dev/null 2>&1 \\\n\s*\|\| incus storage create', texte)
    assert re.search(r'\[ -x /opt/sparkd/venv/bin/python \] \|\| python3 -m venv', texte)


def test_l_amorce_ne_touche_JAMAIS_le_registre_des_Sparks():
    """Le rejeu remet l'installation d'aplomb, pas le registre.

    `spark.db` porte les Sparks declares. Un amorcage qui l'effacerait
    transformerait une reparation en perte de production.
    """
    texte = code()
    assert "spark.db" not in texte
    assert "/var/lib/sparkd" not in texte


def test_l_empreinte_du_depot_amont_est_VERIFIEE_avant_confiance():
    """Incus vient d'un depot tiers : la cle se verifie, elle ne se suppose pas."""
    texte = source()
    assert "4EFC590696CB15B87C73A3AD82CC8797C838DCFD" in texte
    empreinte = texte.index("4EFC590696CB15B87C73A3AD82CC8797C838DCFD")
    installation = texte.index("apt-get install -y incus")
    assert empreinte < installation, "verifier APRES avoir installe ne verifie rien"


# Le gabarit `user-data.yaml` n'existe plus (SPK-158) : le cloud-init est PRODUIT
# par `scripts/preparer-forge.py`, et ses preuves — le script embarque, la ligne
# `runcmd` — sont dans test_preparer_forge.py.


# --- SPK-84 · prevenir le grub-pc casse (docs/DAT.md §50.7.1) --------------
#
# @verifies docs/BACKLOG.md#SPK-84 · docs/DAT.md §50.7.1


def test_les_gardes_ne_sont_PAS_eprouvables_en_processus_ici():
    """Ce que ces preuves NE font pas, et pourquoi c'est dit plutôt que masqué.

    Les gardes de `preparer_grub_sur_raid` lisent des chemins ABSOLUS —
    `/sys/firmware/efi`, `/sys/block/<md>/slaves` — qu'on ne peut pas simuler
    dans le processus de test. Deux preuves de comportement ont d'abord été
    écrites ici ; toutes deux étaient vertes sans rien garder :

    - celle de la garde EFI passait parce que le poste de développement EST en
      EFI : la fonction sortait à la première ligne, et la preuve aurait viré au
      rouge sur une machine BIOS sans que le code ait changé ;
    - celle de la garde RAID doublait `grub-probe` par une fonction shell, or
      `dash` refuse un nom de fonction à tiret. Le script échouait en erreur de
      syntaxe, et l'absence de pose était lue comme un succès.

    Ce qui garde donc réellement cette unité : les assertions de SOURCE
    ci-dessous, et la mesure faite sur la Forge réelle — écritures neutralisées,
    la fonction y a retrouvé d'elle-même les deux disques du RAID
    (`docs/JOURNAL.md`, 2026-09-02).
    """
    fonction = re.search(r"^preparer_grub_sur_raid\(\) \{.*?^\}", source(), re.S | re.M)
    assert fonction, "la fonction de preparation doit exister dans l'amorce"


def test_la_pose_est_CONDITIONNELLE_et_DERIVEE_dans_le_script():
    """Les deux propriétés qui font la correction, lues dans le code lui-même :
    sans la garde EFI ni la garde RAID, la pose deviendrait une régression ;
    sans la dérivation, une Forge en NVMe serait rendue non amorçable."""
    corps = code()
    assert "/sys/firmware/efi" in corps, "la garde EFI"
    assert "/dev/md*" in corps, "la garde RAID"
    assert "slaves" in corps, "les disques se DEDUISENT des membres du RAID"
    assert "/dev/disk/by-id" in corps, "identifiant stable entre deux demarrages"
    assert "/dev/sda" not in corps, "aucun disque ecrit en dur"
    assert "/dev/sdb" not in corps, "aucun disque ecrit en dur"


def test_la_preparation_precede_le_PREMIER_apt():
    """Tout l'objet de l'unite : posee apres, elle ne previendrait rien, le
    premier apt-get install ayant deja echoue sous set -eu."""
    corps = code()
    assert corps.index("preparer_grub_sur_raid\n") < corps.index("apt-get update")


def test_la_preparation_est_IDEMPOTENTE():
    """SPK-73 : un second passage de l'amorce ne doit rien changer. Poser une
    reponse debconf deja posee est sans effet — mais elle ne doit pas etre
    AJOUTEE a une liste, ce qui la ferait croitre a chaque rejeu."""
    corps = code()
    assert corps.count("debconf-set-selections") == 1
    assert ">>" not in corps.split("preparer_grub_sur_raid()")[1].split("}")[0], \
        "la reponse se POSE, elle ne s'ajoute pas"


def test_l_amorce_rejette_les_options_ipv4_avant_le_premier_apt():
    """@verifies docs/BACKLOG.md#SPK-157 · docs/DAT.md §65.3 (CVE-2026-98432)

    Une Forge neuve est exposee des son premier demarrage ; sparkd ne pose son
    pare-feu que plusieurs minutes plus tard. L'amorce pose les MEMES tables que
    `pare_feu`, mot pour mot : deux textes, une seule regle, et ce test les
    tient ensemble."""
    from sparkd import pare_feu

    texte = code()
    assert pare_feu.OPTIONS_IPV4 in source(), "l'amorce porte exactement les tables de pare_feu"
    assert "nft -f -" in texte
    assert texte.index("nft -f -") < texte.index("apt-get update"), "avant le premier apt"


# --- SPK-159 · les reglages en arguments nommes, le pool sur demande ---------
#
# @verifies docs/BACKLOG.md#SPK-159 · docs/DAT.md §66.2 points 5 a 7, §66.4

#: Tout ce que l'amorce appelle et qui ECRIT quelque part. Doubles sur le PATH,
#: ils journalisent leur appel : un refus ou une aide qui en provoque un est rouge.
ECRIVAINS = ("nft", "apt-get", "apt", "curl", "gpg", "install", "modprobe", "zpool",
             "incus", "python3", "dpkg-query", "debconf-set-selections",
             "debconf-communicate", "grub-probe", "pip", "git", "tee", "mkdir")


def _doublons(tmp_path: Path, noms=ECRIVAINS) -> tuple[Path, Path]:
    binaire = tmp_path / "bin"
    binaire.mkdir()
    journal = tmp_path / "appels.txt"
    for nom in noms:
        f = binaire / nom
        f.write_text(f'#!/bin/sh\necho "{nom} $*" >> "{journal}"\nexit 0\n')
        f.chmod(0o755)
    return binaire, journal


def _lancer_amorce(tmp_path: Path, *argv: str):
    """Le VRAI script, lance avec des doubles sur le PATH : il ne peut rien ecrire."""
    binaire, journal = _doublons(tmp_path)
    env = {**os.environ, "PATH": f"{binaire}:{os.environ['PATH']}"}
    vu = subprocess.run(["sh", str(AMORCE), *argv], capture_output=True, text=True, env=env)
    return vu, (journal.read_text() if journal.exists() else "")


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_l_aide_nomme_les_trois_reglages_et_n_ecrit_RIEN(tmp_path):
    """Un reglage d'installation se LIT dans `--help` (CLAUDE.md §3), et l'aide
    est sans effet : la lancer ne doit pas poser un pare-feu."""
    vu, appels = _lancer_amorce(tmp_path, "--help")
    assert vu.returncode == 0, vu.stderr
    for nom in ("--pool-source", "--arc-gib", "--net-mbit"):
        assert nom in vu.stdout, f"{nom} doit figurer dans l'aide"
    assert appels == "", f"--help ne doit rien appeler, a appele : {appels}"


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
@pytest.mark.parametrize("argv, attendu", [
    (["--arc-gib"], "attend une valeur"),
    (["--arc-gib", "0"], "superieur ou egal a 1"),
    (["--arc-gib", "abc"], "attend un entier"),
    (["--arc-gib", "16;reboot"], "attend un entier"),
    (["--net-mbit", "-5"], "attend un entier"),
    (["--pool-source", "/dev/sda5"], "deux chemins /dev"),
    (["--pool-source", "sda5,sdb5"], "deux chemins /dev"),
    (["--pool-source", "/dev/sda5;rm -rf /,/dev/sdb5"], "deux chemins /dev"),
    (["--pool-source", "/dev/a5,/dev/b5 /dev/c5"], "deux chemins /dev"),
    # `grep -q` reussit des qu'UNE ligne convient : sans garde sur le saut de ligne,
    # une premiere ligne valide laissait passer tout ce qui suit.
    (["--pool-source", "/dev/a5,/dev/b5\nreboot"], "deux chemins /dev"),
    (["--pool-source", "/dev/a5,/dev/b5\n"], "deux chemins /dev"),
    (["--pool-source", "reboot\n/dev/a5,/dev/b5"], "deux chemins /dev"),
    (["--inconnu"], "argument inconnu"),
    (["perdu"], "argument inconnu"),
])
def test_un_argument_invalide_est_refuse_AVANT_toute_ecriture(tmp_path, argv, attendu):
    """Un refus precede TOUT appel qui ecrit — la valeur d'`--pool-source` finit
    dans un script lance en root, donc elle est validee avant de servir."""
    vu, appels = _lancer_amorce(tmp_path, *argv)
    assert vu.returncode == 2, (vu.returncode, vu.stderr)
    assert attendu in vu.stderr
    assert appels == "", f"un refus ne doit rien appeler, a appele : {appels}"


def test_les_arguments_sont_lus_AVANT_le_pare_feu_et_le_premier_apt():
    """Lire les arguments n'ecrit rien : c'est ce qui permet de refuser proprement
    et d'afficher l'aide sans toucher a la machine. Le pare-feu (SPK-157) reste
    pose avant tout apt."""
    texte = code()
    assert texte.index("while [ $# -gt 0 ]") < texte.index("nft -f -")
    assert texte.index("nft -f -") < texte.index("apt-get update")


def test_aucune_valeur_a_editer_a_la_main_ne_reste_pour_les_trois_reglages():
    """Le defaut de l'ARC est visible, et sa valeur vient de `--arc-gib`."""
    texte = code()
    assert re.search(r'^ARC_GIB=16\b', texte, re.M), "defaut documente : 16"
    assert re.search(r'^NET_MBIT=""', texte, re.M), "defaut : debit mesure"
    assert re.search(r'^POOL_SOURCE=""', texte, re.M), "defaut : aucun pool cree"
    for nom in ("POOL_SOURCE", "ARC_GIB", "NET_MBIT"):
        assert not re.search(rf'\$\{{{nom}:-', texte), f"{nom} : aucun defaut cache"
    assert '"$ARC_GIB"' in texte and '"$NET_MBIT"' in texte, "transmis a l'executeur"


def test_aucune_variable_d_environnement_n_est_lue_par_l_amorce():
    """CLAUDE.md §3 : aucune option cachee. L'amorce ne lit que ses arguments ;
    les seules variables qu'elle POSE sont celles de `creer-pool.sh`, deja
    documentees au README, et `DEBIAN_FRONTEND` pour apt."""
    texte = code()
    lues = set(re.findall(r'\$\{([A-Z][A-Z0-9_]*)[:}-]', texte))
    assert lues == set(), f"variable lue avec une valeur par defaut : {lues}"
    posees = set(re.findall(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=\S', texte, re.M))
    attendues = {"POOL", "BRIDGE", "MEM_RESERVE_GIB", "CPU_RESERVE", "POOL_SOURCE",
                 "ARC_GIB", "NET_MBIT", "DEBIAN_FRONTEND",
                 # affectations PAR APPEL des variables de creer-pool.sh (README)
                 "SPARK_POOL_NAME", "SPARK_POOL_SOURCE"}
    assert posees <= attendues, f"variable inattendue : {posees - attendues}"


# Le bloc du pool, extrait du VRAI script et joue avec des doubles : la moitie
# critique du contrat (« sans --pool-source, rien ne se cree »). Le script entier
# n'est pas jouable ici — il ecrirait dans /etc —, mais ce bloc l'est, et le
# banc de redemarrage (`make forge-vm`) le joue pour de vrai.

def _bloc_pool() -> tuple[str, str]:
    refuser = re.search(r"^refuser\(\) \{.*?^\}", source(), re.S | re.M)
    bloc = re.search(r"^modprobe zfs\n.*?(?=^incus storage show)", source(), re.S | re.M)
    assert refuser and bloc, "le bloc du pool doit etre repere dans l'amorce"
    return refuser.group(0), bloc.group(0)


def _jouer_bloc_pool(tmp_path: Path, *, present: bool, importable: bool,
                     pool_source: str, creer_pool_present: bool = True):
    refuser, bloc = _bloc_pool()
    binaire, journal = _doublons(tmp_path, noms=("modprobe",))
    # `zpool list` et `zpool import` : deux verdicts commandes par le test.
    (binaire / "zpool").write_text(
        "#!/bin/sh\n"
        f'echo "zpool $*" >> "{journal}"\n'
        f'case "$1" in list) exit {0 if present else 1} ;; import) exit {0 if importable else 1} ;; esac\n'
        "exit 0\n")
    (binaire / "zpool").chmod(0o755)
    creer = tmp_path / "creer-pool.sh"
    if creer_pool_present:
        creer.write_text(
            "#!/bin/sh\n"
            f'echo "creer-pool name=$SPARK_POOL_NAME source=$SPARK_POOL_SOURCE" >> "{journal}"\n')
        creer.chmod(0o755)
    programme = (f"set -eu\nPOOL=spark\nPOOL_SOURCE='{pool_source}'\n{refuser}\n"
                 + bloc.replace("/opt/creer-pool.sh", str(creer)) + "echo FIN\n")
    env = {**os.environ, "PATH": f"{binaire}:{os.environ['PATH']}"}
    vu = subprocess.run(["sh", "-c", programme], capture_output=True, text=True, env=env)
    return vu, (journal.read_text() if journal.exists() else "")


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_un_pool_PRESENT_n_est_jamais_recree_meme_avec_pool_source(tmp_path):
    vu, appels = _jouer_bloc_pool(tmp_path, present=True, importable=False,
                                  pool_source="/dev/x5,/dev/y5")
    assert vu.returncode == 0, vu.stderr
    assert "creer-pool" not in appels
    assert "FIN" in vu.stdout


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_un_pool_IMPORTABLE_est_adopte_et_non_recree(tmp_path):
    """Le pool d'une Forge en service qui n'est pas monte : on l'importe."""
    vu, appels = _jouer_bloc_pool(tmp_path, present=False, importable=True,
                                  pool_source="/dev/x5,/dev/y5")
    assert vu.returncode == 0, vu.stderr
    assert "zpool import -f spark" in appels
    assert "creer-pool" not in appels


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_SANS_pool_source_l_amorce_ne_cree_RIEN_et_le_dit(tmp_path):
    """Le rejeu manuel : l'argument est absent, donc aucune ecriture possible."""
    vu, appels = _jouer_bloc_pool(tmp_path, present=False, importable=False, pool_source="")
    assert vu.returncode == 1, (vu.returncode, vu.stderr)
    assert "creer-pool" not in appels
    assert "--pool-source" in vu.stderr and "ne cree rien" in vu.stderr
    assert "FIN" not in vu.stdout, "l'amorce s'arrete : pas de suite sans pool"


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_AVEC_pool_source_et_sans_pool_l_amorce_appelle_creer_pool_une_fois(tmp_path):
    vu, appels = _jouer_bloc_pool(tmp_path, present=False, importable=False,
                                  pool_source="/dev/x5,/dev/y5")
    assert vu.returncode == 0, vu.stderr
    assert appels.count("creer-pool") == 1
    assert "creer-pool name=spark source=/dev/x5,/dev/y5" in appels
    assert "FIN" in vu.stdout


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
def test_creer_pool_absent_est_un_refus_clair_pas_une_creation_ailleurs(tmp_path):
    vu, appels = _jouer_bloc_pool(tmp_path, present=False, importable=False,
                                  pool_source="/dev/x5,/dev/y5", creer_pool_present=False)
    assert vu.returncode == 2, (vu.returncode, vu.stderr)
    assert "est absent" in vu.stderr
    assert "creer-pool name" not in appels


def test_la_creation_ne_passe_que_par_creer_pool_et_sous_la_garde_de_pool_source():
    """Dans le texte : l'appel de `creer-pool.sh` est UNIQUE et n'est atteignable
    que si `--pool-source` est non vide. Une seconde porte vers la creation, ou un
    appel hors de la garde, ouvrirait le rejeu a une ecriture."""
    texte = code()
    # Une ligne qui EXECUTE le script — pas le test `-x`, pas un message, pas l'aide.
    appels = re.findall(r'^[ \t]*(?:SPARK_POOL_\w+="[^"]*"[ \t]+)*/opt/creer-pool\.sh[ \t]*$',
                        texte, re.M)
    assert len(appels) == 1, f"un seul appel de creer-pool.sh attendu : {appels}"
    garde = texte.index('[ -z "$POOL_SOURCE" ]')
    assert garde < texte.index(appels[0]), "l'appel vient apres la garde, jamais avant"
