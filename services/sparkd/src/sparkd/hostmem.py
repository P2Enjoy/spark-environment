"""Mémoire réellement allouable de la Forge.

@spec docs/BACKLOG.md#SPK-03 · docs/DAT.md §16 (La réserve de la Forge),
      §16.2 (lire le plafond, ne jamais le supposer), §5.2

Trois consommateurs doivent être connus du registre avant qu'il promette quoi
que ce soit : ce que le noyau ne gère pas, ce que l'ARC peut prendre, et ce que
la Forge consomme pour lui-même.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

MEMINFO = Path("/proc/meminfo")
ARC_MAX = Path("/sys/module/zfs/parameters/zfs_arc_max")
#: Consommation INSTANTANÉE de l'ARC. Le plafond dit ce que ZFS PEUT prendre ;
#: ce fichier dit ce qu'il prend. Mesuré le 2026-08-19 (docs/DAT.md §13.12) :
#: sous charge l'ARC atteint son plafond et ne le dépasse pas — la réserve du
#: §16.1 est donc à la fois nécessaire et suffisante. Une mesure ponctuelle
#: répond une fois ; l'exposer rend la vérification permanente.
ARC_STATS = Path("/proc/spl/kstat/zfs/arcstats")

DEFAULT_RESERVE = 2 * 1024**3

_SUFFIXES = {
    "": 1, "B": 1,
    "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3, "TIB": 1024**4,
    "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4,
}
_TAILLE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*$")


class MemoryReadError(RuntimeError):
    """Impossible de connaître la mémoire de la Forge. Mieux vaut échouer."""


def parse_size(value: str | int) -> int:
    """« 2GiB » → octets. Refuse plutôt que d'interpréter au hasard."""
    if isinstance(value, int):
        return value
    match = _TAILLE.match(str(value))
    if not match:
        raise ValueError(f"Taille illisible : {value!r}.")
    nombre, suffixe = match.groups()
    facteur = _SUFFIXES.get(suffixe.upper())
    if facteur is None:
        raise ValueError(
            f"Suffixe inconnu : {suffixe!r}. Connus : "
            + ", ".join(s for s in sorted(_SUFFIXES) if s)
        )
    return int(float(nombre) * facteur)


def kernel_memory_total(meminfo: Path | None = None) -> int:
    """`MemTotal`, ce que le noyau peut réellement allouer.

    Et non le total physique rapporté par Incus : l'écart — 4 Gio sur la Forge de
    validation — est réservé par le micrologiciel et le noyau, et aucun
    processus ne l'obtiendra jamais (docs/DAT.md §5.2).
    """
    chemin = meminfo or MEMINFO
    try:
        for ligne in chemin.read_text().splitlines():
            if ligne.startswith("MemTotal:"):
                return int(ligne.split()[1]) * 1024
    except OSError as erreur:
        raise MemoryReadError(f"{chemin} illisible : {erreur}") from erreur
    raise MemoryReadError(f"{chemin} ne contient pas « MemTotal ».")


@dataclass(frozen=True)
class ArcCeiling:
    bytes: int
    known: bool
    detail: str


def arc_ceiling(total_memory: int, path: Path | None = None) -> ArcCeiling:
    """Plafond de l'ARC ZFS.

    On ne suppose JAMAIS un ARC nul : c'est l'hypothèse qui a fait promettre au
    registre un cinquième de mémoire en trop (docs/DAT.md §16.2).
    """
    chemin = path or ARC_MAX
    try:
        brut = chemin.read_text().strip()
    except OSError:
        return ArcCeiling(
            bytes=0, known=False,
            detail=(
                f"{chemin} illisible : plafond de l'ARC inconnu. La réserve ne "
                "retient que la marge d'exploitation ; si ZFS tourne, le pool "
                "mémoire est surestimé."
            ),
        )
    try:
        valeur = int(brut)
    except ValueError:
        return ArcCeiling(0, False, f"{chemin} illisible : {brut!r}.")

    if valeur == 0:
        # Un plafond non pose n'est pas un plafond absent : ZFS applique son
        # propre defaut, la moitie de la RAM (docs/DAT.md §16.2).
        moitie = total_memory // 2
        return ArcCeiling(
            moitie, True,
            "zfs_arc_max vaut 0 : ZFS applique son défaut, la moitié de la RAM.",
        )
    return ArcCeiling(valeur, True, "plafond de l'ARC lu sur le module ZFS.")


def arc_used(path: Path | None = None) -> int | None:
    """Ce que l'ARC consomme À CET INSTANT, ou `None` si on ne peut pas le lire.

    `None` n'est pas zéro : un ARC dont on ignore la taille n'est pas un ARC
    vide, et les confondre ferait croire la réserve inutile (docs/DAT.md §16.2,
    même raisonnement que pour le plafond).
    """
    try:
        contenu = (path or ARC_STATS).read_text()
    except OSError:
        return None
    for ligne in contenu.splitlines():
        colonnes = ligne.split()
        if len(colonnes) == 3 and colonnes[0] == "size":
            try:
                return int(colonnes[2])
            except ValueError:
                return None
    return None


@dataclass(frozen=True)
class HostMemory:
    total_bytes: int
    reserve_bytes: int
    arc_bytes: int
    operating_margin_bytes: int
    arc_known: bool
    detail: str
    #: Consommation instantanée de l'ARC. `None` = non mesurable.
    arc_used_bytes: int | None = None

    @property
    def allocatable_bytes(self) -> int:
        return max(0, self.total_bytes - self.reserve_bytes)


def measure(
    operating_margin: int = DEFAULT_RESERVE,
    meminfo: Path | None = None,
    arc_path: Path | None = None,
    arc_stats: Path | None = None,
) -> HostMemory:
    """Mémoire totale et réserve, prêtes à écrire dans `host`."""
    total = kernel_memory_total(meminfo)
    arc = arc_ceiling(total, arc_path)
    voulue = arc.bytes + operating_margin
    reserve = min(total, voulue)
    detail = arc.detail
    if voulue >= total:
        # Ne jamais annoncer « 0 allouable » sans dire pourquoi : l'exploitant
        # chercherait le defaut ailleurs pendant longtemps.
        detail = (
            f"Réserve demandée ({voulue} octets : ARC {arc.bytes} + marge "
            f"{operating_margin}) supérieure ou égale à la mémoire gérable par "
            f"le noyau ({total}). Plus rien n'est allouable : abaisser "
            "zfs_arc_max ou SPARKD_MEMORY_RESERVE. " + arc.detail
        )
    return HostMemory(
        total_bytes=total,
        reserve_bytes=reserve,
        arc_bytes=arc.bytes,
        arc_used_bytes=arc_used(arc_stats),
        operating_margin_bytes=operating_margin,
        arc_known=arc.known,
        detail=detail,
    )
