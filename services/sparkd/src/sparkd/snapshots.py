"""Instantanés de cellule et restauration.

@spec docs/BACKLOG.md#SPK-13 · docs/DAT.md §8.3 (pourquoi), §19 (comment),
      §19.1 (le refus est conservé), §19.4 (le quota) · docs/SCHEMA.md §8

Un instantané rend l'état complet de la cellule — système, images Docker,
Compose, volumes, configuration — ce qu'une sauvegarde applicative ne restaure
pas. Il ne la remplace pas pour autant : il vit dans le même pool, et ne protège
ni de sa perte ni de celle de la machine.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from secrets import token_hex

from . import audit
from .db import transaction

#: Incus impose un nom simple ; on reste plus strict pour rester lisible.
NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class SnapshotError(RuntimeError):
    """Instantané refusé, ou restauration impossible."""


@dataclass(frozen=True)
class BlockedByNewer(SnapshotError):
    """Restaurer détruirait des instantanés plus récents.

    Le refus est délibéré (docs/DAT.md §19.1) : détruire sans prévenir tout ce
    qui a été capturé depuis est une surprise irréversible.
    """

    target: str
    blocking: tuple[str, ...]

    def __str__(self) -> str:
        liste = ", ".join(self.blocking)
        return (
            f"Restaurer « {self.target} » détruirait {len(self.blocking)} "
            f"instantané(s) pris depuis : {liste}. Les supprimer d'abord, ou "
            "redemander en acceptant explicitement leur perte."
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _audit(connection, actor, action, target, payload, result, message) -> None:
    audit.record(connection, actor, action, result, message,
                 target_type="snapshot", target_id=target, payload=payload)


def listing(connection: sqlite3.Connection, spark_id: str) -> list[dict]:
    """Instantanés d'un Spark, du plus ancien au plus récent.

    Le tri se fait sur `rowid`, l'ordre d'insertion, et non sur `created_at`
    puis `id`. Deux instantanés pris dans la même seconde partagent leur
    horodatage, et `id` est aléatoire : l'ordre aurait alors été **arbitraire**.
    Or c'est cet ordre qui décide lesquels une restauration détruit — s'y
    tromper détruirait les mauvais.
    """
    return [
        dict(r) for r in connection.execute(
            "SELECT * FROM snapshot WHERE spark_id = ? ORDER BY rowid",
            (spark_id,),
        )
    ]


def newer_than(connection: sqlite3.Connection, spark_id: str, name: str) -> list[str]:
    """Instantanés postérieurs à celui-ci — ceux que la restauration détruirait."""
    tous = listing(connection, spark_id)
    noms = [s["incus_name"] for s in tous]
    if name not in noms:
        raise SnapshotError(f"Aucun instantané « {name} » sur ce Spark.")
    return noms[noms.index(name) + 1:]


def create(
    connection: sqlite3.Connection, spark: dict, name: str,
    incus, actor: str | None = None,
) -> dict:
    """Prend un instantané. N'interrompt pas le Spark (docs/DAT.md §19.2)."""
    nom = name.strip()
    if not NAME.match(nom):
        # On refuse plutôt que de mettre en minuscules en silence : l'exploitant
        # a choisi une étiquette, la changer sous ses yeux est une surprise.
        raise SnapshotError(
            f"Nom « {name} » invalide : minuscules, chiffres et tirets, sans "
            "tiret aux extrémités."
        )
    if not spark.get("incus_name"):
        raise SnapshotError(
            f"Le Spark « {spark['name']} » n'existe pas encore dans Incus : il "
            "n'y a rien à capturer."
        )
    if any(s["incus_name"] == nom for s in listing(connection, spark["id"])):
        raise SnapshotError(f"Un instantané « {nom} » existe déjà sur ce Spark.")

    incus.create_snapshot(spark["incus_name"], nom)

    identifiant = token_hex(12)
    with transaction(connection):
        connection.execute(
            "INSERT INTO snapshot (id, spark_id, incus_name, created_at, stateful)"
            " VALUES (?, ?, ?, ?, 0)",
            (identifiant, spark["id"], nom, _now()),
        )
        _audit(connection, actor, "snapshot.create", identifiant,
               {"spark": spark["name"], "snapshot": nom}, "ok",
               f"Instantané « {nom} » de « {spark['name']} » pris.")
    return dict(connection.execute(
        "SELECT * FROM snapshot WHERE id = ?", (identifiant,)
    ).fetchone())


def restore(
    connection: sqlite3.Connection, spark: dict, name: str, incus,
    accept_losing_newer: bool = False, actor: str | None = None,
) -> dict:
    """Restaure la cellule. Refuse par défaut de détruire les plus récents."""
    nom = name.strip()
    plus_recents = newer_than(connection, spark["id"], nom)

    if plus_recents and not accept_losing_newer:
        refus = BlockedByNewer(target=nom, blocking=tuple(plus_recents))
        with transaction(connection):
            _audit(connection, actor, "snapshot.restore", nom,
                   {"spark": spark["name"], "blocking": plus_recents},
                   "denied", str(refus))
        raise refus

    incus.restore_snapshot(spark["incus_name"], nom, force=bool(plus_recents))

    with transaction(connection):
        if plus_recents:
            # Ils n'existent plus dans le pool : les garder au registre le
            # ferait mentir sur ce qui est restaurable.
            connection.executemany(
                "DELETE FROM snapshot WHERE spark_id = ? AND incus_name = ?",
                [(spark["id"], n) for n in plus_recents],
            )
        _audit(connection, actor, "snapshot.restore", nom,
               {"spark": spark["name"], "destroyed": plus_recents}, "ok",
               f"« {spark['name']} » restauré sur « {nom} »"
               + (f", {len(plus_recents)} instantané(s) détruit(s)." if plus_recents else "."))
    return {"spark": spark["name"], "restored": nom, "destroyed": plus_recents}


def delete(
    connection: sqlite3.Connection, spark: dict, name: str, incus,
    actor: str | None = None,
) -> None:
    nom = name.strip()
    ligne = connection.execute(
        "SELECT * FROM snapshot WHERE spark_id = ? AND incus_name = ?",
        (spark["id"], nom),
    ).fetchone()
    if ligne is None:
        raise SnapshotError(f"Aucun instantané « {nom} » sur ce Spark.")
    incus.delete_snapshot(spark["incus_name"], nom)
    with transaction(connection):
        connection.execute("DELETE FROM snapshot WHERE id = ?", (ligne["id"],))
        _audit(connection, actor, "snapshot.delete", ligne["id"],
               {"spark": spark["name"], "snapshot": nom}, "ok",
               f"Instantané « {nom} » supprimé.")


def sync_sizes(connection: sqlite3.Connection, spark: dict, incus) -> None:
    """Relève la taille réelle des instantanés depuis Incus.

    Elle n'est pas connue à la création : un instantané coûte d'abord zéro, puis
    grossit à mesure que le Spark s'en écarte (docs/DAT.md §19.4).
    """
    try:
        distants = {s["name"]: s for s in incus.snapshots(spark["incus_name"])}
    except Exception:
        return
    with transaction(connection):
        for ligne in listing(connection, spark["id"]):
            distant = distants.get(ligne["incus_name"])
            if distant and distant.get("size") is not None:
                connection.execute(
                    "UPDATE snapshot SET size_bytes = ? WHERE id = ?",
                    (distant["size"], ligne["id"]),
                )
