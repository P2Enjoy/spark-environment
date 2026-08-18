"""Attribution des adresses du réseau privé.

@spec docs/BACKLOG.md#SPK-10 · docs/DAT.md §15 (Adressage du réseau privé),
      §15.2 (plan), §15.3 (attribution déterministe) · docs/SCHEMA.md §4

Le registre attribue, Incus épingle. L'ordre importe : l'ingress a besoin de
l'adresse avant que l'instance existe, et une collision découverte au moment de
l'application tomberait trop tard pour être utile.
"""

from __future__ import annotations

import ipaddress
import sqlite3
from dataclasses import dataclass

#: Plan du §15.2. La plage du registre s'arrête avant la plage DHCP dynamique,
#: qui appartient à ce qui n'est pas géré par le produit.
GATEWAY = ipaddress.IPv4Address("10.77.0.1")
FIRST = ipaddress.IPv4Address("10.77.0.16")
LAST = ipaddress.IPv4Address("10.77.0.239")

#: Confiée à `ipv4.dhcp.ranges` sur le réseau géré, pour que dnsmasq ne
#: distribue jamais dans la plage du registre.
DHCP_FIRST = ipaddress.IPv4Address("10.77.0.240")
DHCP_LAST = ipaddress.IPv4Address("10.77.0.254")

DHCP_RANGE = f"{DHCP_FIRST}-{DHCP_LAST}"


class AddressPoolExhausted(RuntimeError):
    """Plus une seule adresse libre dans la plage du registre."""


@dataclass(frozen=True)
class PoolUsage:
    capacity: int
    used: int

    @property
    def free(self) -> int:
        return self.capacity - self.used


def capacity() -> int:
    return int(LAST) - int(FIRST) + 1


def taken(connection: sqlite3.Connection) -> set[ipaddress.IPv4Address]:
    return {
        ipaddress.IPv4Address(row["ipv4_address"])
        for row in connection.execute(
            "SELECT ipv4_address FROM spark WHERE ipv4_address IS NOT NULL"
        )
    }


def usage(connection: sqlite3.Connection) -> PoolUsage:
    return PoolUsage(capacity=capacity(), used=len(taken(connection)))


def allocate(connection: sqlite3.Connection) -> str:
    """Rend la plus petite adresse libre, ou refuse en nommant l'épuisement.

    Le déterminisme n'est pas une commodité : il rend l'attribution prévisible,
    donc vérifiable. Recréer un Spark dans un parc inchangé rend la même adresse
    (docs/DAT.md §15.3).
    """
    occupees = taken(connection)
    candidate = FIRST
    while candidate <= LAST:
        if candidate not in occupees:
            return str(candidate)
        candidate += 1
    raise AddressPoolExhausted(
        f"Plage d'adresses épuisée : les {capacity()} adresses de {FIRST} à "
        f"{LAST} sont attribuées. Supprimer un Spark, ou élargir la plage — "
        "jamais déborder sur la passerelle ou la plage DHCP."
    )


def is_managed(address: str) -> bool:
    """Vrai si l'adresse appartient à la plage attribuée par le registre."""
    try:
        valeur = ipaddress.IPv4Address(address)
    except ValueError:
        return False
    return FIRST <= valeur <= LAST
