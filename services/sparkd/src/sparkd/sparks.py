"""Service du cycle de vie des Sparks.

@spec docs/BACKLOG.md#SPK-09 · docs/DAT.md §14 (Cycle de vie), §14.2 (le registre
      s'écrit avant Incus), §7.7 (admission control) · docs/SCHEMA.md §4, §9

C'est ici que les pièces se rejoignent : admission control, registre, traducteur
et machine à états. Le module orchestre ; il ne réimplémente aucune de ces règles.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from secrets import token_hex

from .admission import Request, admit, pools
from .db import transaction
from .lifecycle import Command, State, TransitionError, next_state, reconcile, settle

NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class SparkError(RuntimeError):
    """Demande refusée. Le message est destiné à l'exploitant."""


class AdmissionRefused(SparkError):
    def __init__(self, decision) -> None:
        self.decision = decision
        super().__init__(decision.reason)


class NotFound(SparkError):
    pass


@dataclass(frozen=True)
class SparkSpec:
    """Ce que l'exploitant demande."""

    name: str
    image: str
    cpu_mode: str
    memory_bytes: int
    network_bps: int
    storage_bytes: int
    cpu_reservation: float | None = None
    cpu_max: float | None = None
    cpu_cores: int | None = None
    cpu_priority: int = 5
    memory_enforce: str = "hard"
    memory_swap: bool = False
    network_burst_bps: int | None = None
    storage_io_priority: int = 5
    runtime: str = "container"
    docker_enabled: bool = True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id() -> str:
    return token_hex(12)


def _audit(connection, actor, action, target_id, payload, result, message) -> None:
    connection.execute(
        "INSERT INTO audit_log (ts, actor, action, target_type, target_id,"
        " payload, result, message) VALUES (?, ?, ?, 'spark', ?, ?, ?, ?)",
        (_now(), actor, action, target_id, json.dumps(payload), result, message),
    )


def create(connection: sqlite3.Connection, spec: SparkSpec, actor: str = "responsable") -> dict:
    """Crée la ligne d'un Spark, après admission control.

    L'admission control et l'écriture se font dans **la même transaction**
    (docs/DAT.md §14.2). Sans cela, deux créations concurrentes passeraient
    toutes deux un contrôle qu'aucune n'a encore invalidé.

    Rien n'est créé dans Incus ici : le registre s'écrit d'abord. Entre
    surestimer et sous-estimer l'occupation, on surestime toujours.
    """
    if not NAME.match(spec.name):
        raise SparkError(
            f"Nom « {spec.name} » invalide : minuscules, chiffres et tirets, "
            "sans tiret aux extrémités, 63 caractères au plus."
        )

    demande = Request(
        cpu_mode=spec.cpu_mode,
        memory_bytes=spec.memory_bytes,
        network_bps=spec.network_bps,
        storage_bytes=spec.storage_bytes,
        cpu_reservation=spec.cpu_reservation,
        cpu_max=spec.cpu_max,
        cpu_cores=spec.cpu_cores,
    )

    spark_id = _new_id()
    refus = None
    with transaction(connection):
        if connection.execute(
            "SELECT 1 FROM spark WHERE name = ?", (spec.name,)
        ).fetchone():
            raise SparkError(f"Un Spark nommé « {spec.name} » existe déjà.")

        decision = admit(connection, demande)
        if not decision:
            # On SORT de la transaction avant de journaliser le refus. Écrire la
            # trace ici la ferait annuler par le rollback — et elle disparaîtrait
            # précisément quand elle sert. Rien n'est inséré sur ce chemin, donc
            # l'atomicité exigée au §14.2 reste entière.
            refus = decision
        else:
            connection.execute(
                """INSERT INTO spark (
                       id, name, state, runtime, image, cpu_mode, cpu_reservation,
                       cpu_max, cpu_cores, cpu_priority, memory_reservation_bytes,
                       memory_enforce, memory_swap, network_reservation_bps,
                       network_burst_bps, storage_bytes, storage_io_priority,
                       docker_enabled, created_at, updated_at)
                   VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    spark_id, spec.name, spec.runtime, spec.image, spec.cpu_mode,
                    spec.cpu_reservation, spec.cpu_max, spec.cpu_cores, spec.cpu_priority,
                    spec.memory_bytes, spec.memory_enforce, 1 if spec.memory_swap else 0,
                    spec.network_bps, spec.network_burst_bps or spec.network_bps,
                    spec.storage_bytes, spec.storage_io_priority,
                    1 if spec.docker_enabled else 0, _now(), _now(),
                ),
            )
            _audit(
                connection, actor, "spark.create", spark_id,
                {"name": spec.name, "cpu_mode": spec.cpu_mode,
                 "memory_bytes": spec.memory_bytes, "storage_bytes": spec.storage_bytes},
                "ok", f"Spark « {spec.name} » enregistré, en attente d'application.",
            )

    if refus is not None:
        with transaction(connection):
            _audit(
                connection, actor, "spark.create", spark_id,
                {"name": spec.name, "cpu_mode": spec.cpu_mode},
                "denied", refus.reason,
            )
        raise AdmissionRefused(refus)

    return get(connection, spark_id)


def get(connection: sqlite3.Connection, spark_id: str) -> dict:
    row = connection.execute("SELECT * FROM spark WHERE id = ?", (spark_id,)).fetchone()
    if row is None:
        raise NotFound(f"Aucun Spark d'identifiant « {spark_id} ».")
    return dict(row)


def by_name(connection: sqlite3.Connection, name: str) -> dict:
    row = connection.execute("SELECT * FROM spark WHERE name = ?", (name,)).fetchone()
    if row is None:
        raise NotFound(f"Aucun Spark nommé « {name} ».")
    return dict(row)


def listing(connection: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in connection.execute("SELECT * FROM spark ORDER BY name")]


def command(
    connection: sqlite3.Connection,
    spark_id: str,
    cmd: Command,
    actor: str = "responsable",
) -> dict:
    """Applique une commande, ou la refuse en nommant pourquoi."""
    spark = get(connection, spark_id)
    courant = State(spark["state"])
    try:
        vise = next_state(courant, cmd)
    except TransitionError as refus:
        with transaction(connection):
            _audit(
                connection, actor, f"spark.{cmd.value}", spark_id,
                {"state": courant.value}, "denied", str(refus),
            )
        raise SparkError(str(refus)) from refus

    with transaction(connection):
        connection.execute(
            "UPDATE spark SET state = ?, updated_at = ?, last_error = NULL WHERE id = ?",
            (vise.value, _now(), spark_id),
        )
        _audit(
            connection, actor, f"spark.{cmd.value}", spark_id,
            {"from": courant.value, "to": vise.value}, "ok",
            f"« {courant.value} » → « {vise.value} ».",
        )
    return get(connection, spark_id)


def finish(
    connection: sqlite3.Connection,
    spark_id: str,
    success: bool,
    error: str | None = None,
    actor: str = "sparkd",
) -> dict | None:
    """Conclut une opération transitoire.

    Une suppression réussie fait **disparaître la ligne** : c'est seulement là que
    la ressource est rendue (docs/DAT.md §14.4).
    """
    spark = get(connection, spark_id)
    courant = State(spark["state"])

    if courant is State.DELETING and success:
        with transaction(connection):
            connection.execute("DELETE FROM spark WHERE id = ?", (spark_id,))
            _audit(connection, actor, "spark.deleted", spark_id, {}, "ok",
                   f"Spark « {spark['name']} » supprimé, ressources rendues.")
        return None

    vise = settle(courant, success)
    with transaction(connection):
        connection.execute(
            "UPDATE spark SET state = ?, updated_at = ?, last_error = ? WHERE id = ?",
            (vise.value, _now(), error, spark_id),
        )
        _audit(
            connection, actor, "spark.settle", spark_id,
            {"from": courant.value, "to": vise.value}, "ok" if success else "error",
            error or f"« {courant.value} » → « {vise.value} ».",
        )
    return get(connection, spark_id)


def reconcile_all(
    connection: sqlite3.Connection,
    presence: dict[str, tuple[bool, bool]],
    actor: str = "sparkd",
) -> list[dict]:
    """Réconcilie les états transitoires avec la réalité d'Incus, au démarrage.

    `presence` associe le nom du Spark à `(existe, démarré)`. Un état transitoire
    retrouvé ici n'est pas une anomalie du produit : c'est la trace d'un arrêt.
    """
    resultats: list[dict] = []
    for spark in listing(connection):
        courant = State(spark["state"])
        if courant not in {State.CREATING, State.STARTING, State.STOPPING, State.DELETING}:
            continue
        existe, demarre = presence.get(spark["name"], (False, False))
        verdict = reconcile(courant, exists=existe, running=demarre)

        with transaction(connection):
            if verdict.state is None:
                connection.execute("DELETE FROM spark WHERE id = ?", (spark["id"],))
            elif verdict.state is not courant:
                connection.execute(
                    "UPDATE spark SET state = ?, updated_at = ? WHERE id = ?",
                    (verdict.state.value, _now(), spark["id"]),
                )
            _audit(
                connection, actor, "spark.reconcile", spark["id"],
                {"from": courant.value,
                 "to": verdict.state.value if verdict.state else None},
                "ok", verdict.reason,
            )
        resultats.append({
            "name": spark["name"], "from": courant.value,
            "to": verdict.state.value if verdict.state else None,
            "reason": verdict.reason,
        })
    return resultats
