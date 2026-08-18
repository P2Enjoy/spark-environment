"""Ordonnanceur des cœurs : découpe et restitution du pool dédié.

@spec docs/BACKLOG.md#SPK-06 · docs/DAT.md §7.4 (le pool dédié se découpe
      dynamiquement), §7.4 bis (ce que reconfigurer veut dire), §7.4 ter (choix
      et ordre), §7.5 (SMT) · docs/SCHEMA.md §3, §5

Le traducteur refuse de choisir les cœurs : c'est ici qu'ils sont alloués. La
séparation est délibérée — traduire est sans état, allouer ne l'est pas.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

from .db import transaction
from .translate import allowance_percent

SHARED_MODES = ("shared", "shared-pinned", "capped")


class CoreAllocationError(RuntimeError):
    """La découpe demandée n'est pas réalisable."""


@dataclass(frozen=True)
class Core:
    row_id: int
    socket_id: int
    core_id: int
    numa_node: int
    cpus: tuple[int, ...]
    spark_id: str | None


@dataclass(frozen=True)
class Redistribution:
    """Ce qu'il faut appliquer à Incus après une découpe ou une restitution."""

    shared_cpus: tuple[int, ...]
    shared_capacity: float
    dedicated_cpus: tuple[int, ...] = ()
    reconfigured: tuple[dict, ...] = field(default_factory=tuple)


def _cores(connection: sqlite3.Connection) -> list[Core]:
    lignes = connection.execute(
        """SELECT c.id, c.socket_id, c.core_id, c.numa_node, c.spark_id,
                  group_concat(t.cpu_id) AS cpus
           FROM cpu_core c LEFT JOIN cpu_thread t ON t.core_id = c.id
           GROUP BY c.id ORDER BY c.socket_id, c.core_id"""
    ).fetchall()
    return [
        Core(
            row_id=l["id"], socket_id=l["socket_id"], core_id=l["core_id"],
            numa_node=l["numa_node"],
            cpus=tuple(sorted(int(c) for c in (l["cpus"] or "").split(",") if c)),
            spark_id=l["spark_id"],
        )
        for l in lignes
    ]


def shared_cpus(connection: sqlite3.Connection) -> list[int]:
    """CPU logiques du pool partagé, frères compris."""
    return sorted(
        cpu for core in _cores(connection) if core.spark_id is None for cpu in core.cpus
    )


def shared_capacity(connection: sqlite3.Connection) -> float:
    """Capacité du pool partagé, en cœurs PHYSIQUES (docs/DAT.md §7.7)."""
    return float(sum(1 for core in _cores(connection) if core.spark_id is None))


def dedicated_cpus(connection: sqlite3.Connection, spark_id: str) -> list[int]:
    return sorted(
        cpu for core in _cores(connection) if core.spark_id == spark_id for cpu in core.cpus
    )


def _recompute_shared(connection: sqlite3.Connection, capacity: float) -> tuple[dict, ...]:
    """Recalcule le poids de chaque Spark partagé pour la nouvelle capacité.

    C'est la moitié du travail que le §7.4 laissait implicite : ne reconfigurer
    que le cpuset laisserait à chacun un poids calculé pour un pool qui n'existe
    plus (docs/DAT.md §7.4 bis).
    """
    marques = ", ".join("?" * len(SHARED_MODES))
    lignes = connection.execute(
        f"SELECT id, name, cpu_mode, cpu_reservation, cpu_priority FROM spark"
        f" WHERE cpu_mode IN ({marques}) ORDER BY name",
        SHARED_MODES,
    ).fetchall()

    resultats: list[dict] = []
    for ligne in lignes:
        entree = {"id": ligne["id"], "name": ligne["name"], "cpu_mode": ligne["cpu_mode"]}
        if ligne["cpu_mode"] == "capped":
            # Un plafond dur est absolu : il ne dépend pas de la capacité du pool.
            entree["allowance"] = None
        else:
            entree["allowance"] = (
                f"{allowance_percent(ligne['cpu_reservation'], capacity, ligne['cpu_priority'])}%"
            )
        resultats.append(entree)
    return tuple(resultats)


def carve(
    connection: sqlite3.Connection, spark_id: str, cores_wanted: int
) -> Redistribution:
    """Retire `cores_wanted` cœurs physiques entiers du pool partagé.

    Les cœurs de plus petit indice libres sont retenus : une découpe reproduite
    sur un parc identique donne le même résultat, donc se vérifie
    (docs/DAT.md §7.4 ter).
    """
    if cores_wanted < 1:
        raise CoreAllocationError("Un Spark dédié demande au moins un cœur.")

    tous = _cores(connection)
    libres = [c for c in tous if c.spark_id is None]
    if len(libres) < cores_wanted:
        raise CoreAllocationError(
            f"{cores_wanted} cœurs demandés, {len(libres)} libres sur "
            f"{len(tous)} au total. Libérer un Spark dédié, ou en demander moins."
        )

    choisis = libres[:cores_wanted]
    restants = float(len(libres) - cores_wanted)

    if restants <= 0:
        marques = ", ".join("?" * len(SHARED_MODES))
        partages = connection.execute(
            f"SELECT count(*) AS n FROM spark WHERE cpu_mode IN ({marques})", SHARED_MODES
        ).fetchone()["n"]
        if partages:
            raise CoreAllocationError(
                f"Cette découpe ne laisserait aucun cœur au pool partagé, où "
                f"{partages} Spark(s) s'exécutent. Ils n'auraient plus où tourner."
            )

    with transaction(connection):
        # 1. rétrécir : le pool partagé perd ses cœurs AVANT que le Spark dédié
        #    ne les prenne, pour qu'ils ne se les partagent jamais.
        for core in choisis:
            connection.execute(
                "UPDATE cpu_core SET pool = 'dedicated', spark_id = ? WHERE id = ?",
                (spark_id, core.row_id),
            )
            connection.execute(
                "INSERT OR IGNORE INTO spark_cpu_pin (spark_id, core_id) VALUES (?, ?)",
                (spark_id, core.row_id),
            )
        # 2. recalculer les poids pour la capacité qui reste.
        reconfigures = _recompute_shared(connection, restants) if restants > 0 else ()

    return Redistribution(
        shared_cpus=tuple(shared_cpus(connection)),
        shared_capacity=restants,
        dedicated_cpus=tuple(cpu for core in choisis for cpu in core.cpus),
        reconfigured=reconfigures,
    )


def release(connection: sqlite3.Connection, spark_id: str) -> Redistribution:
    """Rend au pool partagé les cœurs d'un Spark dédié."""
    with transaction(connection):
        # 1. libérer avant d'élargir : symétrique de la découpe.
        connection.execute("DELETE FROM spark_cpu_pin WHERE spark_id = ?", (spark_id,))
        connection.execute(
            "UPDATE cpu_core SET pool = 'shared', spark_id = NULL WHERE spark_id = ?",
            (spark_id,),
        )
        capacite = shared_capacity(connection)
        # 2. recalculer pour la capacité élargie.
        reconfigures = _recompute_shared(connection, capacite) if capacite > 0 else ()

    return Redistribution(
        shared_cpus=tuple(shared_cpus(connection)),
        shared_capacity=capacite,
        reconfigured=reconfigures,
    )


def layout(connection: sqlite3.Connection) -> dict:
    """Vue du partage des cœurs, pour la console et les preuves."""
    tous = _cores(connection)
    return {
        "physical_cores": len(tous),
        "shared": {
            "cores": [c.core_id for c in tous if c.spark_id is None],
            "cpus": shared_cpus(connection),
            "capacity": shared_capacity(connection),
        },
        "dedicated": [
            {"core_id": c.core_id, "cpus": list(c.cpus), "spark_id": c.spark_id}
            for c in tous if c.spark_id is not None
        ],
    }
