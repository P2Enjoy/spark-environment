"""Configuration de sparkd, lue depuis l'environnement.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §5 (Topologie physique et surface reseau),
      §11 (Securite) · README.md section « Variables d'environnement »

La garde d'adresse d'ecoute implemente une invariante de securite du produit,
pas une preference de configuration : « aucune API d'administration n'est
joignable depuis le reseau » (docs/DAT.md §5). Elle est donc appliquee ici, au
demarrage, et non laissee a la vigilance de l'exploitant.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass

DEFAULT_BIND = "127.0.0.1:9876"
DEFAULT_DB = "/var/lib/sparkd/spark.db"
DEFAULT_INCUS_SOCKET = "/var/lib/incus/unix.socket"
DEFAULT_CADDY_ADMIN = "http://127.0.0.1:2019"
DEFAULT_DRIVER = "incus"
DEFAULT_STORAGE_POOL = "spark"
DEFAULT_MEMORY_RESERVE = "2GiB"
#: Part de processeur que l'hote garde pour lui. Elle rend DEFINIE la loi de
#: poids du §32.2 : sans elle, une machine entierement vendue donnerait un poids
#: infini a la tranche des Sparks, et l'hote n'ordonnancerait plus rien — pas
#: meme de quoi corriger la situation (docs/DAT.md §32.3).
DEFAULT_CPU_RESERVE = 0.5
DEFAULT_LOG_LEVEL = "info"

DRIVERS = ("incus", "fake")
LOG_LEVELS = ("debug", "info", "warning", "error")


class ConfigError(ValueError):
    """Configuration refusee. Le service ne demarre pas."""


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    database: str
    incus_socket: str
    caddy_admin: str
    driver: str
    log_level: str
    storage_pool: str
    memory_reserve_bytes: int
    cpu_reserve: float

    @property
    def bind(self) -> str:
        return f"{self.host}:{self.port}"


def _parse_bind(raw: str) -> tuple[str, int]:
    if ":" not in raw:
        raise ConfigError(
            f"SPARKD_BIND doit avoir la forme « hote:port », recu {raw!r}."
        )
    host, _, port_text = raw.rpartition(":")
    host = host.strip("[]")
    if not host:
        raise ConfigError("SPARKD_BIND doit nommer une adresse d'ecoute explicite.")
    try:
        port = int(port_text)
    except ValueError:
        raise ConfigError(
            f"SPARKD_BIND : port illisible dans {raw!r}."
        ) from None
    if not 1 <= port <= 65535:
        raise ConfigError(f"SPARKD_BIND : port hors bornes ({port}).")
    return host, port


def _require_loopback(host: str) -> None:
    """Refuse toute adresse routable.

    L'absence d'API d'administration exposee au reseau est une propriete de
    securite du produit (docs/DAT.md §5). Un demarrage sur une adresse routable
    la detruirait silencieusement : on echoue bruyamment a la place.
    """
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # Un nom d'hote peut resoudre n'importe ou, y compris ailleurs demain.
        if host in ("localhost", "ip6-localhost"):
            return
        raise ConfigError(
            f"SPARKD_BIND : {host!r} n'est pas une adresse de boucle locale. "
            "sparkd ne doit jamais etre joignable depuis le reseau "
            "(docs/DAT.md §5)."
        ) from None
    if not address.is_loopback:
        raise ConfigError(
            f"SPARKD_BIND : {host} est une adresse routable. sparkd ne doit "
            "jamais etre joignable depuis le reseau (docs/DAT.md §5). Utiliser "
            "un tunnel SSH pour l'administration a distance."
        )


def load(env: dict[str, str] | None = None) -> Config:
    """Construit la configuration, ou echoue avec un message exploitable."""
    source = os.environ if env is None else env

    host, port = _parse_bind(source.get("SPARKD_BIND", DEFAULT_BIND))
    _require_loopback(host)

    driver = source.get("SPARKD_DRIVER", DEFAULT_DRIVER)
    if driver not in DRIVERS:
        raise ConfigError(
            f"SPARKD_DRIVER : {driver!r} inconnu, attendu l'un de {DRIVERS}."
        )

    log_level = source.get("SPARKD_LOG_LEVEL", DEFAULT_LOG_LEVEL).lower()
    if log_level not in LOG_LEVELS:
        raise ConfigError(
            f"SPARKD_LOG_LEVEL : {log_level!r} inconnu, attendu l'un de {LOG_LEVELS}."
        )

    from .hostmem import parse_size

    try:
        reserve = parse_size(source.get("SPARKD_MEMORY_RESERVE", DEFAULT_MEMORY_RESERVE))
    except ValueError as erreur:
        raise ConfigError(f"SPARKD_MEMORY_RESERVE : {erreur}") from None
    if reserve < 0:
        raise ConfigError("SPARKD_MEMORY_RESERVE ne peut pas être négatif.")

    try:
        cpu_reserve = float(source.get("SPARKD_CPU_RESERVE", DEFAULT_CPU_RESERVE))
    except (TypeError, ValueError):
        raise ConfigError(
            f"SPARKD_CPU_RESERVE : {source.get('SPARKD_CPU_RESERVE')!r} n'est pas "
            "un nombre de cœurs."
        ) from None
    if cpu_reserve < 0:
        raise ConfigError("SPARKD_CPU_RESERVE ne peut pas être négatif.")

    return Config(
        host=host,
        port=port,
        database=source.get("SPARKD_DB", DEFAULT_DB),
        incus_socket=source.get("SPARKD_INCUS_SOCKET", DEFAULT_INCUS_SOCKET),
        caddy_admin=source.get("SPARKD_CADDY_ADMIN", DEFAULT_CADDY_ADMIN),
        driver=driver,
        log_level=log_level,
        storage_pool=source.get("SPARKD_STORAGE_POOL", DEFAULT_STORAGE_POOL),
        memory_reserve_bytes=reserve,
        cpu_reserve=cpu_reserve,
    )
