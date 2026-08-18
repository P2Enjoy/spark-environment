"""Relevé de la capacité et de la topologie de l'hôte.

@spec docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.2 (ce qui est lu et où), §5.3 (le
      relevé est explicite) · docs/SCHEMA.md §2 (host), §3 (cpu_core, cpu_thread)

Le relevé n'est jamais implicite : c'est une opération nommée, datée et tracée.
La capacité de l'hôte est la base de tous les calculs d'admission ; la voir bouger
silencieusement rendrait des Sparks déjà admis non admissibles sans que personne
ne l'ait décidé.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .db import transaction
from .incus import IncusClient

MBIT = 1_000_000


class InventoryError(RuntimeError):
    """Le relevé est inexploitable : mieux vaut échouer que retenir un faux."""


@dataclass(frozen=True)
class Thread:
    cpu_id: int
    thread_index: int
    numa_node: int
    online: bool


@dataclass(frozen=True)
class Core:
    socket_id: int
    core_id: int
    numa_node: int
    threads: tuple[Thread, ...]


@dataclass(frozen=True)
class Topology:
    hostname: str
    cpu_threads_total: int
    memory_total_bytes: int
    network_total_bps: int
    storage_total_bytes: int
    cores: tuple[Core, ...]

    @property
    def cpu_cores_total(self) -> int:
        return len(self.cores)


def _require(value: Any, quoi: str) -> Any:
    if value in (None, 0, ""):
        raise InventoryError(
            f"Relevé inexploitable : {quoi} absent ou nul. Le registre ne "
            "retiendra pas une capacité fausse."
        )
    return value


def read_topology(client: IncusClient, pool: str) -> Topology:
    """Traduit la réponse d'Incus en topologie exploitable."""
    resources = client.resources()
    cpu = resources.get("cpu") or {}

    cores: list[Core] = []
    for socket in cpu.get("sockets") or []:
        socket_id = socket.get("socket", 0)
        for core in socket.get("cores") or []:
            threads = tuple(
                Thread(
                    cpu_id=t["id"],
                    thread_index=t.get("thread", 0),
                    numa_node=t.get("numa_node", 0),
                    online=bool(t.get("online", True)),
                )
                for t in core.get("threads") or []
            )
            if not threads:
                continue
            cores.append(
                Core(
                    socket_id=socket_id,
                    core_id=core.get("core", len(cores)),
                    numa_node=threads[0].numa_node,
                    threads=threads,
                )
            )
    if not cores:
        raise InventoryError("Relevé inexploitable : aucun cœur rapporté par Incus.")

    # `link_speed` est en Mbit/s (mesuré : 1000 pour un lien 1 Gbit/s), et les
    # ports non détectés n'ajoutent aucune capacité — docs/DAT.md §5.2.
    debit_mbit = 0
    for card in (resources.get("network") or {}).get("cards") or []:
        for port in card.get("ports") or []:
            if port.get("link_detected") and port.get("link_speed"):
                debit_mbit += int(port["link_speed"])

    espace = (client.storage_pool_resources(pool).get("space") or {}).get("total")

    return Topology(
        hostname=(resources.get("system") or {}).get("hostname") or "inconnu",
        # `cpu.total` compte les THREADS, jamais les cœurs — docs/DAT.md §5.2.
        cpu_threads_total=int(_require(cpu.get("total"), "cpu.total")),
        memory_total_bytes=int(_require((resources.get("memory") or {}).get("total"), "memory.total")),
        network_total_bps=int(_require(debit_mbit, "un port réseau détecté")) * MBIT,
        # La capacité de stockage est celle du POOL Incus, pas du disque.
        storage_total_bytes=int(_require(espace, f"l'espace du pool « {pool} »")),
        cores=tuple(cores),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sync(
    connection: sqlite3.Connection,
    client: IncusClient,
    pool: str,
    actor: str = "sparkd",
) -> Topology:
    """Écrit le relevé dans le registre, et le trace.

    Un relevé qui réduirait la capacité sous ce qui est déjà alloué est appliqué
    malgré tout — la réalité fait foi — mais journalisé en `denied` pour que
    l'écart reste visible (docs/DAT.md §5.3).
    """
    from .admission import pools as lire_pools

    topology = read_topology(client, pool)

    try:
        avant = lire_pools(connection)
        alloue = {
            "cpu": avant.cpu.allocated,
            "memory": avant.memory.allocated,
            "network": avant.network.allocated,
            "storage": avant.storage.allocated,
        }
    except Exception:
        alloue = {}

    with transaction(connection):
        connection.execute(
            """INSERT INTO host (
                   id, hostname, cpu_threads_total, cpu_cores_total,
                   memory_total_bytes, storage_total_bytes, network_total_bps,
                   topology_synced_at)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   hostname = excluded.hostname,
                   cpu_threads_total = excluded.cpu_threads_total,
                   cpu_cores_total = excluded.cpu_cores_total,
                   memory_total_bytes = excluded.memory_total_bytes,
                   storage_total_bytes = excluded.storage_total_bytes,
                   network_total_bps = excluded.network_total_bps,
                   topology_synced_at = excluded.topology_synced_at""",
            (
                topology.hostname,
                topology.cpu_threads_total,
                topology.cpu_cores_total,
                topology.memory_total_bytes,
                topology.storage_total_bytes,
                topology.network_total_bps,
                _now(),
            ),
        )

        # Les cœurs déjà attribués à un Spark ne sont pas effacés : la topologie
        # se relève, les allocations se conservent.
        attribues = {
            (row["socket_id"], row["core_id"]): row["spark_id"]
            for row in connection.execute(
                "SELECT socket_id, core_id, spark_id FROM cpu_core WHERE spark_id IS NOT NULL"
            )
        }
        connection.execute("DELETE FROM cpu_thread")
        connection.execute("DELETE FROM cpu_core")
        for index, core in enumerate(topology.cores, start=1):
            proprietaire = attribues.get((core.socket_id, core.core_id))
            connection.execute(
                "INSERT INTO cpu_core (id, socket_id, numa_node, core_id, pool, spark_id)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    index,
                    core.socket_id,
                    core.numa_node,
                    core.core_id,
                    "dedicated" if proprietaire else "shared",
                    proprietaire,
                ),
            )
            for thread in core.threads:
                connection.execute(
                    "INSERT INTO cpu_thread (cpu_id, core_id) VALUES (?, ?)",
                    (thread.cpu_id, index),
                )

        apres = lire_pools(connection)
        depassements = [
            nom
            for nom, pool_etat in (
                ("cpu", apres.cpu), ("memory", apres.memory),
                ("network", apres.network), ("storage", apres.storage),
            )
            if alloue.get(nom, 0) > pool_etat.capacity
        ]
        connection.execute(
            "INSERT INTO audit_log (ts, actor, action, target_type, target_id,"
            " payload, result, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                _now(), actor, "host.sync", "host", "1",
                json.dumps({
                    "cpu_cores": topology.cpu_cores_total,
                    "cpu_threads": topology.cpu_threads_total,
                    "memory_bytes": topology.memory_total_bytes,
                    "network_bps": topology.network_total_bps,
                    "storage_bytes": topology.storage_total_bytes,
                }),
                "denied" if depassements else "ok",
                (
                    "Capacité relevée inférieure à l'allocation en cours : "
                    + ", ".join(depassements)
                    + ". Le relevé est appliqué — la réalité fait foi — mais "
                      "l'écart doit être résorbé."
                ) if depassements else "Relevé de topologie appliqué.",
            ),
        )
    return topology


def sibling_cpus(connection: sqlite3.Connection, core_row_id: int) -> list[int]:
    """CPU logiques d'un cœur physique, frères SMT compris.

    C'est ce qui rend un cœur « dédié » réellement exclusif : attribuer le seul
    CPU 0 laisserait son frère 4 ordonnançable par d'autres (docs/DAT.md §7.5).
    """
    return [
        row["cpu_id"]
        for row in connection.execute(
            "SELECT cpu_id FROM cpu_thread WHERE core_id = ? ORDER BY cpu_id",
            (core_row_id,),
        )
    ]
