"""Ports publiés : ce qui ne parle pas HTTP.

@spec docs/BACKLOG.md#SPK-49 · docs/DAT.md §39 (les ports publiés),
      §39.1 (pourquoi deux mécanismes), §39.2 (un port public est une ressource
      de la Forge), §39.3 (ce qu'un port publié fait perdre),
      §39.4 (un device proxy d'Incus, pas du netfilter),
      §39.5 (le modèle et où vit l'unicité) · docs/SCHEMA.md §6 bis ·
      docs/BACKLOG.md#SPK-111 · docs/DAT.md §59.1 (un lien privé est un port
      publié dont la portée n'est pas Internet), §59.2 (l'unicité par portée,
      les réservés dans toute portée), §59.3 (le device proxy en nat=true sur
      la passerelle du réseau), §59.4 (les gestes et leurs refus)

Un serveur SMTP reçoit une connexion sur le port 25 sans qu'aucun nom ne soit
prononcé. Le proxy du §18 ne peut rien pour lui : le seul élément qui désigne le
Spark destinataire est le port sur lequel la connexion est arrivée.

Un **lien privé** (SPK-111) est le MÊME objet dont la portée est un réseau
privé du §58 : la Forge écoute sur son adresse à elle sur ce réseau, et relaie
vers le Spark — les membres joignent `<passerelle>:<port>`, et rien d'autre.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from secrets import token_hex

from . import audit
from . import reseaux
from .config import DEFAULT_RESERVED_PORTS
from .db import transaction

PROTOCOLS = ("tcp", "udp")

#: Préfixe du device posé sur l'instance. Le nom porte le port public, ce qui
#: rend l'appartenance lisible depuis `incus config show` sans consulter le
#: registre (§39.4).
DEVICE_PREFIX = "pub-"
#: SPK-111 · §59.3 : le device d'un lien privé porte le réseau ET le port —
#: `lnk-spn1-5432` —, pour la même lisibilité.
LINK_PREFIX = "lnk-"
#: La portée d'un port publié qui n'est pas un lien (§59.1).
INTERNET = "internet"
#: SPK-111 · §59.2 : dans un réseau privé, son résolveur et son DHCP occupent
#: 53 et 67 sur la passerelle — en plus des réservés de la Forge, que `sshd`
#: et le proxy tiennent sur TOUTES les adresses.
RESERVED_IN_NETWORK = {53: "le résolveur du réseau privé", 67: "le DHCP du réseau privé"}


class PortError(RuntimeError):
    """Publication refusée, ou pilote injoignable."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def device_name(public_port: int, interface: str | None = None) -> str:
    """`pub-<port>` sur Internet ; `lnk-<interface>-<port>` dans un réseau
    privé (§59.3) — deux familles que le pilote remplace ensemble (§39.4)."""
    if interface:
        return f"{LINK_PREFIX}{interface}-{public_port}"
    return f"{DEVICE_PREFIX}{public_port}"


def reserved(extra: tuple[int, ...] = (), *, in_network: bool = False) -> dict[int, str]:
    """Ports jamais attribuables, et la RAISON de chacun.

    Le refus nomme le service qui tient le port : « réservé » seul laisserait
    chercher pourquoi, et un exploitant qui ne sait pas ce qui occupe `443`
    essaiera de le libérer (§39.5). Dans un réseau privé, les réservés de la
    Forge le restent — `sshd` se lie sur toutes les adresses — et le résolveur
    du réseau ajoute les siens (§59.2).
    """
    liste = dict(DEFAULT_RESERVED_PORTS)
    for port in extra:
        liste.setdefault(port, "déclaré réservé sur cette Forge")
    if in_network:
        for port, raison in RESERVED_IN_NETWORK.items():
            liste.setdefault(port, raison)
    return liste


# --- lecture -----------------------------------------------------------------


_COLONNES = ("SELECT p.*, s.name AS spark_name, s.ipv4_address, s.state AS spark_state,"
             " n.name AS network_name, n.cidr AS network_cidr"
             " FROM published_port p JOIN spark s ON s.id = p.spark_id"
             " LEFT JOIN private_network n ON n.id = p.network_id")


def _decorer(row: sqlite3.Row) -> dict:
    """Un port publié tel que l'API le rend : sa portée par son NOM — `internet`
    ou le nom du réseau —, et pour un lien l'adresse que les membres emploient
    (§59.4), calculée du sous-réseau comme au §58.2."""
    port = dict(row)
    nom = port.pop("network_name", None)
    cidr = port.pop("network_cidr", None)
    if port.get("network_id"):
        port.update({"scope": nom, "network": nom,
                     "interface": reseaux.interface(cidr),
                     "gateway": reseaux.passerelle(cidr)})
        port["address"] = f"{port['gateway']}:{port['public_port']}"
    else:
        port.update({"scope": INTERNET, "network": None, "interface": None,
                     "gateway": None, "address": None})
    return port


def listing(connection: sqlite3.Connection) -> list[dict]:
    """Tous les ports publiés de la Forge, avec leur Spark — Internet d'abord,
    puis chaque réseau privé."""
    return [_decorer(r) for r in connection.execute(
        _COLONNES + " ORDER BY p.scope = 'internet' DESC, p.scope, p.public_port")]


def by_public_port(connection: sqlite3.Connection, public_port: int,
                   network_id: str | None = None) -> dict:
    """Un port DANS sa portée (§59.2) : le `5432` d'un réseau n'est pas celui
    d'Internet."""
    row = connection.execute(
        _COLONNES + " WHERE p.public_port = ? AND p.scope = ?",
        (public_port, network_id or INTERNET)).fetchone()
    if row is None:
        ou = " dans ce réseau" if network_id else ""
        raise PortError(f"Aucun port publié « {public_port} »{ou}.")
    return _decorer(row)


def links_for_network(connection: sqlite3.Connection, network_id: str) -> list[dict]:
    """Les liens qu'un réseau porte (§59.4)."""
    return [_decorer(r) for r in connection.execute(
        _COLONNES + " WHERE p.network_id = ? ORDER BY p.public_port", (network_id,))]


def consumable_for(connection: sqlite3.Connection, spark_id: str) -> list[dict]:
    """Les liens qu'un Spark peut JOINDRE : ceux des réseaux dont il est
    membre, avec l'adresse à employer (§59.4)."""
    return [_decorer(r) for r in connection.execute(
        "SELECT p.*, s.name AS spark_name, s.ipv4_address, s.state AS spark_state,"
        " n.name AS network_name, n.cidr AS network_cidr"
        " FROM private_network_member m"
        " JOIN published_port p ON p.network_id = m.network_id"
        " JOIN spark s ON s.id = p.spark_id"
        " JOIN private_network n ON n.id = m.network_id"
        " WHERE m.spark_id = ? ORDER BY n.name, p.public_port", (spark_id,))]


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
        if port["network_id"]:
            # SPK-111 · §59.3 : la Forge écoute sur SON adresse dans le réseau,
            # et `nat=true` conserve l'adresse source du membre — MESURÉ le
            # 2026-09-18 : le service exposé lit `10.78.1.16`, pas la Forge.
            carte[device_name(port["public_port"], port["interface"])] = {
                "type": "proxy", "nat": "true",
                "listen": f"{port['protocol']}:{port['gateway']}:{port['public_port']}",
                "connect": f"{port['protocol']}:{port['ipv4_address']}:{port['target_port']}",
            }
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
    network: dict | None = None,
) -> dict:
    """Publie un port de la Forge vers un Spark — sur Internet, ou, avec
    `network`, dans ce réseau privé : un lien privé (§59.1).

    L'unicité du port public est portée par la BASE (§39.5), DANS sa portée
    (§59.2). Les contrôles
    ci-dessous servent à rendre un refus LISIBLE, pas à garantir l'unicité :
    face à deux requêtes simultanées, seul l'index `UNIQUE` protège.
    """
    if protocol not in PROTOCOLS:
        raise PortError(
            f"Protocole « {protocol} » inconnu : attendu {' ou '.join(PROTOCOLS)}.")
    for valeur, quoi in ((public_port, "public"), (target_port, "du Spark")):
        if not 1 <= valeur <= 65535:
            raise PortError(f"Port {quoi} {valeur} hors bornes : 1 à 65535.")

    interdits = reserved(extra_reserved, in_network=network is not None)
    if public_port in interdits:
        raise PortError(
            f"Le port {public_port} est tenu par {interdits[public_port]}. "
            "Il n'est pas attribuable à un Spark."
        )

    scope = network["id"] if network else INTERNET
    portee = f"dans le réseau « {network['name']} »" if network else "de la Forge"
    identifiant = token_hex(12)
    with transaction(connection):
        pris = connection.execute(
            "SELECT s.name FROM published_port p JOIN spark s ON s.id = p.spark_id"
            " WHERE p.public_port = ? AND p.scope = ?", (public_port, scope)
        ).fetchone()
        if pris:
            # §39.2 : un conflit NOMME le Spark qui détient déjà le port. Sans
            # ce nom, l'exploitant doit parcourir la liste pour le retrouver.
            raise PortError(
                f"Le port {public_port} est déjà publié vers le Spark "
                f"« {pris['name']} » {portee}."
            )
        connection.execute(
            "INSERT INTO published_port (id, public_port, spark_id, target_port,"
            " protocol, note, created_at, scope, network_id)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (identifiant, public_port, spark["id"], target_port, protocol,
             note.strip(), _now(), scope, network["id"] if network else None),
        )
        audit.record(
            connection, actor, "port.publish", "ok",
            f"Port {public_port}/{protocol} {portee} → {spark['name']}:{target_port}.",
            target_type="published_port", target_id=identifiant,
            payload={"public_port": public_port, "target_port": target_port,
                     "protocol": protocol, "spark": spark["name"],
                     "scope": network["name"] if network else INTERNET},
        )
    return by_public_port(connection, public_port, network["id"] if network else None)


def withdraw(connection: sqlite3.Connection, public_port: int,
             actor: str | None = None, network_id: str | None = None) -> dict:
    """Retire la publication, dans sa portée. L'appelant REFERME ensuite (§39.2)."""
    port = by_public_port(connection, public_port, network_id)
    portee = f" du réseau « {port['network']} »" if network_id else ""
    with transaction(connection):
        connection.execute("DELETE FROM published_port WHERE id = ?", (port["id"],))
        audit.record(
            connection, actor, "port.withdraw", "ok",
            f"Port {public_port}{portee} retiré du Spark « {port['spark_name']} ».",
            target_type="published_port", target_id=port["id"],
            payload={"public_port": public_port, "spark": port["spark_name"],
                     "scope": port["scope"]},
        )
    return port


def mark_applied(connection: sqlite3.Connection, spark_id: str) -> None:
    with transaction(connection):
        connection.execute(
            "UPDATE published_port SET applied_at = ? WHERE spark_id = ?",
            (_now(), spark_id),
        )
