"""Tranche cgroup parente des Sparks, et son poids.

@spec docs/BACKLOG.md#SPK-29 · docs/DAT.md §32 (rendre la réservation CPU
      absolue), §32.1 (le mécanisme), §32.2 (le poids n'est pas une constante),
      §32.3 (la Forge garde une part), §32.4 (la tranche survit au redémarrage) ·
      §7.2 bis, §7.3 bis

Incus place chaque Spark à la RACINE de cgroup v2, frère des tranches de la Forge.
Le poids d'un Spark y est arbitré contre `system.slice` autant que contre les
autres Sparks : sa réservation n'est donc proportionnelle qu'entre Sparks.

Regrouper les Sparks sous une tranche parente corrige cela — à condition que la
tranche pèse **exactement ce que les Sparks ont acheté**. C'est ce que calcule ce
module.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

#: Nom de la tranche parente. Posée en unité systemd par l'installation : créée
#: à la main elle disparaît au redémarrage, et les Sparks retomberaient à la
#: racine sans que rien ne le signale (docs/DAT.md §32.4).
SLICE = "spark.slice"
CGROUP_ROOT = Path("/sys/fs/cgroup")

#: Tranches que systemd présente à la racine, chacune à `cpu.weight = 100`
#: (mesuré le 2026-08-19). Leur somme est le poids contre lequel la tranche des
#: Sparks est arbitrée.
HOST_SLICES = ("system.slice", "user.slice", "init.scope")
HOST_WEIGHT = 300

#: Bornes que le noyau accepte pour `cpu.weight` en cgroup v2.
WEIGHT_MIN = 1
WEIGHT_MAX = 10_000


class CgroupError(RuntimeError):
    """La tranche n'est pas dans l'état que le produit suppose."""


def raw_lxc(name: str) -> str:
    """Directive `raw.lxc` plaçant un Spark dans la tranche (§32.1).

    Mesuré : la loi de poids du §7.2 bis s'applique inchangée à l'intérieur, et
    `cpu.max` reste `max` — le burst du mode partagé est donc préservé.
    """
    return (
        f"lxc.cgroup.dir.container = {SLICE}/{name}\n"
        f"lxc.cgroup.dir.monitor = {SLICE}/monitor-{name}\n"
    )


@dataclass(frozen=True)
class SliceWeight:
    """Poids calculé, avec de quoi expliquer d'où il vient."""

    weight: int
    sold: float
    capacity: float
    reserve: float

    @property
    def share(self) -> float:
        """Part de la machine que la tranche obtiendra sous contention totale."""
        return self.weight / (self.weight + HOST_WEIGHT)


def slice_weight(sold: float, capacity: float, reserve: float) -> SliceWeight:
    """`W = H × f / (1 − f)`, avec `f = min(Σr, C − réserve) / C` (§32.2, §32.3).

    La réserve n'est pas une précaution : elle rend la loi **définie**. Sans
    elle, une machine entièrement vendue donne `f = 1` et un poids infini —
    la Forge n'ordonnancerait plus rien, pas même de quoi corriger la situation.

    Une constante à la place de ce calcul rendrait la réservation absolue pour un
    seul taux de remplissage, et fausse partout ailleurs.
    """
    if capacity <= 0:
        raise CgroupError("Capacité CPU nulle : le poids de la tranche n'a pas de sens.")
    if reserve < 0:
        raise CgroupError("La réserve CPU de la Forge ne peut pas être négative.")
    if reserve >= capacity:
        raise CgroupError(
            f"Réserve CPU ({reserve}) supérieure ou égale à la capacité "
            f"({capacity}) : plus rien ne serait allouable."
        )

    plafond = capacity - reserve
    vendu = max(0.0, min(sold, plafond))
    f = vendu / capacity

    if f <= 0:
        # Aucun Spark : la tranche ne doit pas peser plus que nécessaire, mais
        # elle doit exister et rester ordonnançable. Le minimum du noyau suffit.
        return SliceWeight(WEIGHT_MIN, vendu, capacity, reserve)

    brut = HOST_WEIGHT * f / (1 - f)
    return SliceWeight(
        max(WEIGHT_MIN, min(WEIGHT_MAX, round(brut))), vendu, capacity, reserve
    )


def slice_path(root: Path | None = None) -> Path:
    return (root or CGROUP_ROOT) / SLICE


def inspect(root: Path | None = None) -> dict[str, object]:
    """État RÉEL de la tranche. Ne modifie rien.

    Rend `present=False` plutôt que d'échouer : sur un poste de développement
    sans cgroup v2, l'absence de tranche est normale et n'est pas une panne.
    """
    chemin = slice_path(root)
    if not chemin.is_dir():
        return {"present": False, "weight": None, "controllers": []}
    try:
        poids = int((chemin / "cpu.weight").read_text().strip())
    except (OSError, ValueError):
        poids = None
    try:
        controleurs = (chemin / "cgroup.subtree_control").read_text().split()
    except OSError:
        controleurs = []
    return {"present": True, "weight": poids, "controllers": controleurs}


#: Contrôleurs sans lesquels les limites d'Incus ne s'appliqueraient pas DANS
#: la tranche (docs/DAT.md §32.1).
REQUIRED_CONTROLLERS = ("cpu", "cpuset", "memory")


def ensure_delegation(root: Path | None = None) -> list[str]:
    """Délègue les contrôleurs manquants à la tranche. Rend ceux qui ont été posés.

    Mesuré le 2026-08-19 : systemd crée la tranche mais n'y délègue que
    `hugetlb rdma misc`. Une écriture unique au moment de l'installation ne tient
    pas — le cgroup d'une tranche vide n'existe pas encore, et systemd repose
    l'état à ses propres rechargements.

    La délégation est donc **réaffirmée** par le runtime, qui possède déjà le
    poids de la tranche. Sans ces contrôleurs, la tranche existe et paraît
    correcte alors que les limites ne s'y appliquent pas : c'est exactement le
    genre de panne silencieuse que cette unité corrige.
    """
    chemin = slice_path(root)
    fichier = chemin / "cgroup.subtree_control"
    try:
        presents = fichier.read_text().split()
    except OSError:
        return []
    manquants = [c for c in REQUIRED_CONTROLLERS if c not in presents]
    if not manquants:
        return []
    try:
        fichier.write_text(" ".join(f"+{c}" for c in manquants))
    except OSError:
        return []
    return manquants


def apply_weight(poids: SliceWeight, root: Path | None = None,
                 run=subprocess.run) -> bool:
    """Pose le poids sur la tranche. Rend `False` si elle n'est pas là.

    **PAR systemd, jamais dans le fichier cgroup** (docs/DAT.md §32.4 bis).

    MESURÉ le 2026-08-21 sur la Forge de validation : écrire directement dans
    `cpu.weight` réussit, puis se défait au premier `daemon-reload` — systemd
    est l'autorité sur les propriétés de cgroup d'une unité, et l'unité porte
    `CPUWeight=1` comme point de départ. La promesse centrale du produit
    s'évaporait donc en silence, sans qu'aucun contrôle ne rougisse.

    `systemctl set-property` fait écrire systemd lui-même : il applique
    immédiatement ET réaffirme la valeur à chaque reconciliation, au lieu de
    l'écraser.

    L'écriture directe reste en REPLI, pour un hôte sans systemd — et seulement
    là. L'absence de tranche n'est pas une erreur du plan de contrôle : c'est une
    Forge qui n'a pas été préparée, et le contrôle `RUN-SLICE` du préflight la
    constate.
    """
    chemin = slice_path(root)
    if not chemin.is_dir():
        return False

    # `root` fourni signifie une racine de cgroup SIMULÉE : on n'appelle pas
    # systemd, qui ne connaît pas cette racine-là.
    if root is None and shutil.which("systemctl"):
        try:
            vu = run(["systemctl", "set-property", SLICE,
                      f"CPUWeight={poids.weight}"],
                     capture_output=True, timeout=15)
            if getattr(vu, "returncode", 1) == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            pass

    try:
        (chemin / "cpu.weight").write_text(str(poids.weight))
    except OSError:
        return False
    return True
