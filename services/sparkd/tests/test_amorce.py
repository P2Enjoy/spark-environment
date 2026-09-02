"""Preuves de l'amorce cloud-init d'une Forge.

@verifies docs/BACKLOG.md#SPK-73 · docs/DAT.md §50.4-§50.6 (l'executeur ferme),
          §8.2 (le pool livre par le schema JSON s'adopte) · README.md (rejeu de
          l'amorce)

Le script vivait auparavant SEULEMENT sur la machine, produit par le `user_data`
du serveur : ni versionne, ni relisible en revue, ni testable. Ces preuves
existent pour qu'il ne puisse plus repartir a la derive sans qu'on le voie.
"""

from __future__ import annotations

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


def test_l_amorce_ADOPTE_le_pool_et_ne_le_formate_jamais():
    """Le pool est livre par le schema de partitionnement (§8.2).

    Le creer ou le formater detruirait les Sparks d'une Forge en service : c'est
    precisement ce qu'un rejeu ne doit JAMAIS faire.
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


def test_le_gabarit_cloud_init_depose_le_script_et_l_appelle():
    gabarit = (RACINE / "deploy" / "cloud-init" / "user-data.yaml").read_text(encoding="utf-8")
    assert gabarit.startswith("#cloud-config")
    assert "/opt/spark-amorce.sh" in gabarit
    assert "runcmd:" in gabarit


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
