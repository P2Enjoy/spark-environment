"""Preuves de l'exécuteur fermé d'installation, joué avec des commandes doublées.

@verifies docs/BACKLOG.md#SPK-170 · docs/DAT.md §70.2 (un zpool importable qui
          n'est pas sain n'est jamais importé, par la console non plus) · §50.3
          (l'adoption d'un zpool existant) · docs/BACKLOG.md#SPK-176 · docs/DAT.md
          §70.6 (la mise à niveau ZFS, facultative et vérifiée)

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


# --- SPK-176 · §70.6 : la mise à niveau ZFS, facultative et demandée --------
#
# @verifies docs/BACKLOG.md#SPK-176 · docs/DAT.md §70.6 (la clé zfsUpgrade ;
#           relire avant, vérifier après)

ZPOOL_UPGRADE_A_FAIRE = "This system supports ZFS pool feature flags.\n\nPOOL  FEATURE\n---------------\nspark\n      longname\n"
ZPOOL_UPGRADE_FAIT = "This system supports ZFS pool feature flags.\n\nEvery feature flags pool has all supported and requested features enabled.\n"


def _enveloppe(storage: dict) -> dict:
    return {"plan": {"version": 1, "system": {"os": "ubuntu 26.04", "architecture": "x86_64"},
                     "storage": storage,
                     "config": {"poolName": "spark", "bridgeName": "sparkbr0", "cpuReserve": 0.5,
                                "memoryReserveGib": 2, "arcMaxGib": 16, "reservedPorts": [22, 80, 443]},
                     "phases": [{"id": p, "label": p, "status": "pending"}
                                for p in forge_install.PHASES]},
            "confirmation": ""}


REUSE = {"kind": "reuse", "poolName": "spark", "driver": "zfs", "destructive": False}


@pytest.mark.parametrize("valeur", [False, "true", 1, None])
def test_zfsUpgrade_ne_s_envoie_que_true(monkeypatch, valeur):
    monkeypatch.setattr(forge_install, "_memory_total", lambda: 64 * 1024**3)
    with pytest.raises(ForgeInstallationError, match="ne s'envoie que demandée"):
        forge_install.validate_envelope(_enveloppe({**REUSE, "zfsUpgrade": valeur}))


def test_zfsUpgrade_est_refuse_sur_un_pool_qu_on_cree(monkeypatch):
    monkeypatch.setattr(forge_install, "_memory_total", lambda: 64 * 1024**3)
    natif = {"kind": "native", "poolName": "spark", "driver": "zfs",
             "devices": ["/dev/sda5", "/dev/sdb5"], "destructive": True, "zfsUpgrade": True}
    with pytest.raises(ForgeInstallationError, match="rien à mettre à niveau"):
        forge_install.validate_envelope(_enveloppe(natif))


def test_zfsUpgrade_true_passe_la_liste_fermee_de_la_reutilisation(monkeypatch):
    """La clé est retirée avant la comparaison à la liste fermée : le refus qui
    suit, s'il y en a un, ne parle plus du stockage."""
    monkeypatch.setattr(forge_install, "_memory_total", lambda: 64 * 1024**3)
    try:
        forge_install.validate_envelope(_enveloppe({**REUSE, "zfsUpgrade": True}))
    except ForgeInstallationError as refus:
        assert "stockage" not in str(refus) and "réutilisation" not in str(refus) \
            and "ZFS" not in str(refus), refus


def test_la_mise_a_niveau_relit_lance_puis_VERIFIE(monkeypatch):
    sorties = iter([ZPOOL_UPGRADE_A_FAIRE, ZPOOL_UPGRADE_FAIT])
    machine = Machine({"incus storage get spark zfs.pool_name": (0, "spark\n")})

    def run(command, **kw):
        if command == ["zpool", "upgrade"]:
            machine.appels.append("zpool upgrade (liste)")
            return subprocess.CompletedProcess(command, 0, next(sorties), "")
        return machine(command, **kw)

    monkeypatch.setattr(forge_install, "_run", run)
    assert forge_install.mettre_a_niveau_zfs("spark") == {"zfsUpgrade": "fait", "zpool": "spark"}
    assert machine.appels == ["incus storage get spark zfs.pool_name", "zpool upgrade (liste)",
                              "zpool upgrade spark", "zpool upgrade (liste)"]


def test_un_pool_deja_a_niveau_n_est_pas_touche(monkeypatch):
    machine = Machine({"incus storage get spark zfs.pool_name": (0, "spark\n"),
                       "zpool upgrade": (0, ZPOOL_UPGRADE_FAIT)})
    monkeypatch.setattr(forge_install, "_run", machine)
    assert forge_install.mettre_a_niveau_zfs("spark")["zfsUpgrade"] == "deja"
    assert "zpool upgrade spark" not in machine.appels


def test_un_pool_encore_liste_apres_la_mise_a_niveau_est_un_ECHEC(monkeypatch):
    machine = Machine({"incus storage get spark zfs.pool_name": (0, "spark\n"),
                       "zpool upgrade": (0, ZPOOL_UPGRADE_A_FAIRE)})
    monkeypatch.setattr(forge_install, "_run", machine)
    with pytest.raises(ForgeInstallationError, match="encore des fonctionnalités"):
        forge_install.mettre_a_niveau_zfs("spark")


#: Sortie RÉELLE de `zpool upgrade` sur `spark-experiment`, le 2026-11-18 à 12:33,
#: APRÈS `zpool upgrade spark` : 11 fonctionnalités activées, seule reste une
#: fonctionnalité (*) que `zpool upgrade` n'active jamais.
ZPOOL_UPGRADE_APRES_REEL = """\
This system supports ZFS pool feature flags.

All pools are formatted using feature flags.


Some supported features are not enabled on the following pools. Once a
feature is enabled the pool may become incompatible with software
that does not support the feature. See zpool-features(7) for details.

Note that the pool 'compatibility' feature can be used to inhibit
feature upgrades.

Features marked with (*) are not applied automatically on upgrade, and
must be applied explicitly with zpool-set(7).

POOL  FEATURE
---------------
spark
      dynamic_gang_header(*)
"""


def test_un_pool_qui_ne_liste_plus_que_des_fonctionnalites_ETOILEES_est_a_niveau(monkeypatch):
    """Le faux échec de la Forge de test (DAT §70.6, révisé) : la mise à niveau
    avait réussi, et l'exécuteur l'a déclarée en échec à cause d'un (*)."""
    sorties = iter([ZPOOL_UPGRADE_A_FAIRE, ZPOOL_UPGRADE_APRES_REEL])
    machine = Machine({"incus storage get spark zfs.pool_name": (0, "spark\n")})

    def run(command, **kw):
        if command == ["zpool", "upgrade"]:
            return subprocess.CompletedProcess(command, 0, next(sorties), "")
        return machine(command, **kw)

    monkeypatch.setattr(forge_install, "_run", run)
    assert forge_install.mettre_a_niveau_zfs("spark") == {"zfsUpgrade": "fait", "zpool": "spark"}


def test_un_pool_qui_ne_liste_que_des_ETOILEES_n_est_pas_relance(monkeypatch):
    """La reprise de l'installation après ce faux échec ne relance rien."""
    machine = Machine({"incus storage get spark zfs.pool_name": (0, "spark\n"),
                       "zpool upgrade": (0, ZPOOL_UPGRADE_APRES_REEL)})
    monkeypatch.setattr(forge_install, "_run", machine)
    assert forge_install.mettre_a_niveau_zfs("spark")["zfsUpgrade"] == "deja"
    assert "zpool upgrade spark" not in machine.appels
