"""Ports publiés : ce qui ne parle pas HTTP.

@spec docs/BACKLOG.md#SPK-49 · docs/DAT.md §39 (les ports publiés),
      §39.1 (pourquoi deux mécanismes), §39.2 (un port public est une ressource
      de la Forge), §39.3 (ce qu'un port publié fait perdre),
      §39.4 (un device proxy d'Incus, pas du netfilter),
      §39.5 (le modèle et où vit l'unicité) · docs/SCHEMA.md §6 bis

Un serveur SMTP reçoit une connexion sur le port 25 sans qu'aucun nom ne soit
prononcé. Le proxy du §18 ne peut rien pour lui : le seul élément qui désigne le
Spark destinataire est le port sur lequel la connexion est arrivée.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from secrets import token_hex

from . import audit
from .config import DEFAULT_RESERVED_PORTS
from .db import transaction

PROTOCOLS = ("tcp", "udp")

#: Préfixe du device posé sur l'instance. Le nom porte le port public, ce qui
#: rend l'appartenance lisible depuis `incus config show` sans consulter le
#: registre (§39.4).
DEVICE_PREFIX = "pub-"


class PortError(RuntimeError):
    """Publication refusée, ou pilote injoignable."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def device_name(public_port: int) -> str:
    return f"{DEVICE_PREFIX}{public_port}"


def reserved(extra: tuple[int, ...] = ()) -> dict[int, str]:
    """Ports jamais attribuables, et la RAISON de chacun.

    Le refus nomme le service qui tient le port : « réservé » seul laisserait
    chercher pourquoi, et un exploitant qui ne sait pas ce qui occupe `443`
    essaiera de le libérer (§39.5).
    """
    liste = dict(DEFAULT_RESERVED_PORTS)
    for port in extra:
        liste.setdefault(port, "déclaré réservé sur cette Forge")
    return liste


# --- lecture -----------------------------------------------------------------


def listing(connection: sqlite3.Connection) -> list[dict]:
    """Tous les ports publiés de la Forge, avec leur Spark."""
    return [
        dict(r) for r in connection.execute(
            "SELECT p.*, s.name AS spark_name, s.ipv4_address, s.state AS spark_state"
            " FROM published_port p JOIN spark s ON s.id = p.spark_id"
            " ORDER BY p.public_port"
        )
    ]


def by_public_port(connection: sqlite3.Connection, public_port: int) -> dict:
    row = connection.execute(
        "SELECT p.*, s.name AS spark_name, s.ipv4_address"
        " FROM published_port p JOIN spark s ON s.id = p.spark_id"
        " WHERE p.public_port = ?", (public_port,)
    ).fetchone()
    if row is None:
        raise PortError(f"Aucun port publié « {public_port} ».")
    return dict(row)


def for_spark(connection: sqlite3.Connection, spark_id: str) -> list[dict]:
    return [p for p in listing(connection) if p["spark_id"] == spark_id]


# --- la carte des devices (§39.4) --------------------------------------------


def devices_for(connection: sqlite3.Connection, spark_id: str) -> dict[str, dict]:
    """Carte COMPLÈTE des devices de publication d'un Spark, depuis le registre.

    On régénère, on ne rapièce pas — la règle du §18.1, pour la même raison :
    `PATCH` fusionne et ne sait donc pas RETIRER un device. Un retrait rapiécé
    laisserait un port ouvert vers un service qui n'est plus là, ce qui est
    exactement la surface offerte sans service derrière que le §39.2 interdit.
    """
    carte: dict[str, dict] = {}
    for port in for_spark(connection, spark_id):
        if not port["ipv4_address"]:
            # Un Spark sans adresse n'a rien à servir : le port reste au
            # registre — on déclare avant de créer — mais aucun device n'est
            # posé, comme au §18.2 pour une route.
            continue
        carte[device_name(port["public_port"])] = {
            "type": "proxy",
            "listen": f"{port['protocol']}:0.0.0.0:{port['public_port']}",
            "connect": f"{port['protocol']}:{port['ipv4_address']}:{port['target_port']}",
        }
    return carte


def has_instance(connection: sqlite3.Connection, spark_id: str) -> bool:
    """Le Spark a-t-il une instance à configurer ?

    Le signal est `incus_name`, renseigné SEULEMENT après une application
    réussie — c'est déjà ce que `_apply_keys` emploie pour la même question.

    Ce n'est PAS l'adresse : elle est attribuée dès l'écriture au registre
    (§15.1), bien avant que le pilote ne porte quoi que ce soit. Mesuré : s'y
    fier faisait échouer la publication en 502 « Instance absente » sur un Spark
    parfaitement normal, encore `pending`.
    """
    row = connection.execute(
        "SELECT incus_name FROM spark WHERE id = ?", (spark_id,)
    ).fetchone()
    return bool(row and row["incus_name"])


def apply_devices(connection: sqlite3.Connection, client, spark_name: str,
                  spark_id: str) -> int | None:
    """Pose sur l'instance la carte complète des devices de publication.

    Rend `None` quand il n'y a **rien à configurer** : un Spark encore `pending`
    n'a pas d'instance chez le pilote. On déclare avant de créer — c'est voulu,
    c'est la règle du §18.2 pour une route —, le port reste au registre et son
    `applied_at` reste vide, ce qui rend l'écart visible au lieu d'inventer une
    panne du pilote.

    Mesuré : appeler le pilote quand même faisait rendre « Instance absente », et
    la publication échouait en 502 sur un Spark parfaitement normal.
    """
    if not has_instance(connection, spark_id):
        return None
    carte = devices_for(connection, spark_id)
    try:
        client.set_publication_devices(spark_name, carte)
    except Exception as erreur:  # noqa: BLE001 — toute panne du pilote doit être rendue
        raise PortError(
            f"Le pilote a refusé d'appliquer les ports de « {spark_name} » : {erreur}"
        ) from erreur
    return len(carte)


# --- écriture ----------------------------------------------------------------


def publish(
    connection: sqlite3.Connection, client, spark: dict,
    public_port: int, target_port: int, protocol: str = "tcp",
    note: str = "", actor: str | None = None,
    extra_reserved: tuple[int, ...] = (),
) -> dict:
    """Publie un port de la Forge vers un Spark.

    L'unicité du port public est portée par la BASE (§39.5). Les contrôles
    ci-dessous servent à rendre un refus LISIBLE, pas à garantir l'unicité :
    face à deux requêtes simultanées, seul l'index `UNIQUE` protège.
    """
    if protocol not in PROTOCOLS:
        raise PortError(
            f"Protocole « {protocol} » inconnu : attendu {' ou '.join(PROTOCOLS)}.")
    for valeur, quoi in ((public_port, "public"), (target_port, "du Spark")):
        if not 1 <= valeur <= 65535:
            raise PortError(f"Port {quoi} {valeur} hors bornes : 1 à 65535.")

    interdits = reserved(extra_reserved)
    if public_port in interdits:
        raise PortError(
            f"Le port {public_port} est tenu par {interdits[public_port]}. "
            "Il n'est pas attribuable à un Spark."
        )

    identifiant = token_hex(12)
    with transaction(connection):
        pris = connection.execute(
            "SELECT s.name FROM published_port p JOIN spark s ON s.id = p.spark_id"
            " WHERE p.public_port = ?", (public_port,)
        ).fetchone()
        if pris:
            # §39.2 : un conflit NOMME le Spark qui détient déjà le port. Sans
            # ce nom, l'exploitant doit parcourir la liste pour le retrouver.
            raise PortError(
                f"Le port {public_port} est déjà publié vers le Spark "
                f"« {pris['name']} »."
            )
        connection.execute(
            "INSERT INTO published_port (id, public_port, spark_id, target_port,"
            " protocol, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (identifiant, public_port, spark["id"], target_port, protocol,
             note.strip(), _now()),
        )
        audit.record(
            connection, actor, "port.publish", "ok",
            f"Port {public_port}/{protocol} de la Forge → {spark['name']}:{target_port}.",
            target_type="published_port", target_id=identifiant,
            payload={"public_port": public_port, "target_port": target_port,
                     "protocol": protocol, "spark": spark["name"]},
        )
    return by_public_port(connection, public_port)


def withdraw(connection: sqlite3.Connection, public_port: int,
             actor: str | None = None) -> dict:
    """Retire la publication. L'appelant REFERME ensuite (§39.2)."""
    port = by_public_port(connection, public_port)
    with transaction(connection):
        connection.execute("DELETE FROM published_port WHERE id = ?", (port["id"],))
        audit.record(
            connection, actor, "port.withdraw", "ok",
            f"Port {public_port} retiré du Spark « {port['spark_name']} ».",
            target_type="published_port", target_id=port["id"],
            payload={"public_port": public_port, "spark": port["spark_name"]},
        )
    return port


def mark_applied(connection: sqlite3.Connection, spark_id: str) -> None:
    with transaction(connection):
        connection.execute(
            "UPDATE published_port SET applied_at = ? WHERE spark_id = ?",
            (_now(), spark_id),
        )
