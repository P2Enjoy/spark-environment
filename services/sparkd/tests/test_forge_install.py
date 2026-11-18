"""Preuves de l'exécuteur fermé d'installation, joué avec des commandes doublées.

@verifies docs/BACKLOG.md#SPK-170 · docs/DAT.md §70.2 (un zpool importable qui
          n'est pas sain n'est jamais importé, par la console non plus) · §50.3
          (l'adoption d'un zpool existant)

Aucune de ces preuves ne touche la machine : `_run` est remplacé par un double
qui rend, commande par commande, la sortie qu'une Forge rendrait, et qui
journalise chaque appel. Une écriture se lit donc dans le journal.
"""

from __future__ import annotations

import subprocess

import pytest

from sparkd import forge_install
from sparkd.forge_install import ForgeInstallationError

#: Forme de `zpool import` sans argument, pour le pool qu'une installation ratée
#: avait laissé sur `spark-010` le 2026-11-18.
IMPORTABLE_DEGRADE = """\
   pool: spark
     id: 1234567890
  state: DEGRADED
 action: The pool can be imported despite missing or damaged devices.
 config:

\tspark       DEGRADED
\t  mirror-0  DEGRADED
\t    sda5    ONLINE
\t    sdb5    FAULTED
"""
IMPORTABLE_SAIN = IMPORTABLE_DEGRADE.replace("DEGRADED", "ONLINE").replace("FAULTED", "ONLINE")


class Machine:
    """Le double de `_run` : une table commande → (code, sortie), et un journal."""

    def __init__(self, reponses: dict[str, tuple[int, str]]):
        self.reponses = reponses
        self.appels: list[str] = []

    def __call__(self, command, *, timeout=120, input_text=None, check=True):
        ligne = " ".join(command)
        self.appels.append(ligne)
        code, sortie = self.reponses.get(ligne, (0, ""))
        if check and code:
            raise ForgeInstallationError(f"{command[0]} a refusé l'opération")
        return subprocess.CompletedProcess(command, code, sortie, "")


def _plan_adoption() -> dict:
    return {"storage": {"kind": "adopt", "poolName": "spark", "driver": "zfs",
                        "zpool": "spark", "imported": False, "destructive": False},
            "config": {"arcMaxGib": 16}}


def _machine(liste_importable: str) -> Machine:
    return Machine({
        "incus storage show spark": (1, ""),
        "zpool list -H -o name": (0, ""),
        "zpool import": (0, liste_importable),
    })


def test_l_adoption_d_un_zpool_importable_DEGRADE_est_REFUSEE_sans_rien_ecrire(monkeypatch):
    machine = _machine(IMPORTABLE_DEGRADE)
    monkeypatch.setattr(forge_install, "_run", machine)
    with pytest.raises(ForgeInstallationError) as refus:
        forge_install.phase_storage(_plan_adoption())
    message = str(refus.value)
    assert "DEGRADED" in message and "n'est pas importé" in message
    assert "sudo zpool import -f spark" in message and "wipefs" in message
    assert "zpool import spark" not in machine.appels, "aucune importation"
    assert not any(a.startswith("incus storage create") for a in machine.appels)


def test_l_adoption_d_un_zpool_importable_SAIN_l_importe_puis_le_declare(monkeypatch):
    machine = _machine(IMPORTABLE_SAIN)
    importe = {"fait": False}

    def run(command, **kw):
        ligne = " ".join(command)
        if ligne == "zpool import spark":
            importe["fait"] = True
        if ligne == "zpool list -H -o name" and importe["fait"]:
            machine.appels.append(ligne)
            return subprocess.CompletedProcess(command, 0, "spark\n", "")
        return machine(command, **kw)

    monkeypatch.setattr(forge_install, "_run", run)
    # Le reste de la phase (compression, ARC) n'est pas l'objet de cette preuve.
    monkeypatch.setattr(forge_install, "_atomic_write_if_changed", lambda *a, **k: False)
    monkeypatch.setattr(forge_install.Path, "read_text", lambda self, **k: "17179869184")
    monkeypatch.setattr(forge_install.Path, "exists", lambda self: False)
    forge_install.phase_storage(_plan_adoption())
    assert "zpool import spark" in machine.appels or importe["fait"]
    assert "incus storage create spark zfs source=spark" in machine.appels


def test_l_etat_importable_se_lit_pool_par_pool(monkeypatch):
    """Deux pools importables : on lit l'état de CELUI qu'on adopte."""
    autre = IMPORTABLE_SAIN.replace("pool: spark", "pool: tank")
    monkeypatch.setattr(forge_install, "_run", Machine({"zpool import": (0, autre + IMPORTABLE_DEGRADE)}))
    assert forge_install._etat_importable("tank") == "ONLINE"
    assert forge_install._etat_importable("spark") == "DEGRADED"
    assert forge_install._etat_importable("absent") is None
