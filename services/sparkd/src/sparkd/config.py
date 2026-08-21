"""Configuration de sparkd, lue depuis l'environnement.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §5 (Topologie physique et surface reseau),
      §8.8.3 (la marge de metadonnees et pourquoi elle est configurable),
      §11 (Securite), §44.8 (adresse publique du briefing) · README.md section
      « Variables d'environnement »

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
#: SPK-58 · §43.9.2 : la cle qui chiffre les secrets d'environnement. Elle vit
#: A COTE DU REGISTRE, et son defaut se DERIVE donc du chemin de celui-ci : un
#: chemin absolu code en dur ferait chercher la cle dans /var/lib/sparkd alors
#: que le registre est ailleurs — en developpement, en test, sur une seconde
#: Forge. Elle est CREEE si elle manque, jamais REECRITE (docs/DAT.md §43.9.2).
SECRET_KEY_NAME = "secret.key"
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
#: Marge posee AU-DESSUS de la taille vendue de chaque Spark (docs/DAT.md §8.8).
#: Mesure le 2026-08-18 : disque plein, Incus ne peut plus ecrire `backup.yaml`,
#: qui vit DANS le jeu de donnees contingente, et toute reconfiguration echoue —
#: y compris l'agrandissement qui debloquerait la situation. Le fichier pese
#: quelques kibioctets ; le defaut est large de trois ordres de grandeur parce
#: qu'une marge trop juste rendrait le remede intermittent, donc pire qu'absent.
DEFAULT_STORAGE_METADATA_MARGIN = "64MiB"
DEFAULT_LOG_LEVEL = "info"

DRIVERS = ("incus", "fake")

#: Ports que le système de la Forge occupe, et qui ne sont donc jamais
#: attribuables à un Spark (docs/DAT.md §39.5). Le refus NOMME le service qui
#: tient le port : « réservé » seul laisserait chercher pourquoi.
DEFAULT_RESERVED_PORTS: dict[int, str] = {
    22: "le sshd de la Forge, seule porte du système",
    80: "le proxy, qui sert les routes publiques en clair",
    443: "le proxy, qui sert les routes publiques en TLS",
}
LOG_LEVELS = ("debug", "info", "warning", "error")


def _parse_reserved_ports(raw: str) -> tuple[int, ...]:
    """Ports réservés SUPPLÉMENTAIRES, en plus de ceux du produit.

    Une Forge peut occuper d'autres ports que ceux du système du produit — un
    superviseur, une sauvegarde, un service de l'hébergeur. La liste est donc
    un paramètre et non une constante (docs/DAT.md §39.5).
    """
    ports: list[int] = []
    for morceau in raw.replace(";", ",").split(","):
        morceau = morceau.strip()
        if not morceau:
            continue
        try:
            valeur = int(morceau)
        except ValueError as erreur:
            raise ConfigError(
                f"SPARKD_RESERVED_PORTS : « {morceau} » n'est pas un entier."
            ) from erreur
        if not 1 <= valeur <= 65535:
            raise ConfigError(
                f"SPARKD_RESERVED_PORTS : le port {valeur} est hors bornes.")
        ports.append(valeur)
    return tuple(sorted(set(ports)))


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
    storage_dataset: str
    #: SPK-40 · §36.10.5 : le fichier `allowed_signers` d'OpenSSH. Il ne porte que
    #: des clés PUBLIQUES — le §11 garde les privées sur le poste. Absent ou
    #: vide, la vérification se DÉSACTIVE au lieu de tomber en panne.
    allowed_signers: str
    #: SPK-62 · §47.3 : l'URL du canal hors bande. VIDE, la fonction se DÉSACTIVE
    #: et ce n'est pas une panne (§14.5) — une Forge sans canal fonctionne
    #: exactement comme avant.
    notify_url: str
    #: SPK-60 · §44.8 : une adresse PUBLIQUE est un fait de configuration. Elle
    #: n'est jamais devinee depuis l'IP privee de la cellule ni via un service
    #: externe ; vide, le briefing dit qu'elle est inconnue.
    forge_public_address: str
    #: SPK-58 · §43.9.2 : le fichier de la cle de chiffrement des secrets.
    secret_key_file: str
    memory_reserve_bytes: int
    cpu_reserve: float
    storage_metadata_margin_bytes: int
    reserved_ports: tuple[int, ...]

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


def _cle_par_defaut(source) -> str:
    """Le chemin de la cle : celui donne, sinon a cote du registre."""
    pose = source.get("SPARKD_SECRET_KEY_FILE")
    if pose:
        return pose
    return os.path.join(
        os.path.dirname(source.get("SPARKD_DB", DEFAULT_DB)) or ".",
        SECRET_KEY_NAME)


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

    try:
        marge = parse_size(
            source.get("SPARKD_STORAGE_METADATA_MARGIN", DEFAULT_STORAGE_METADATA_MARGIN)
        )
    except ValueError as erreur:
        raise ConfigError(f"SPARKD_STORAGE_METADATA_MARGIN : {erreur}") from None
    # Zero est ACCEPTE : il restaure le comportement d'avant SPK-30, pour un
    # pilote qui n'ecrirait pas ses metadonnees dans le jeu de donnees
    # contingente. C'est un choix d'exploitant, pas un defaut (§8.8.3).
    if marge < 0:
        raise ConfigError("SPARKD_STORAGE_METADATA_MARGIN ne peut pas être négatif.")

    pool = source.get("SPARKD_STORAGE_POOL", DEFAULT_STORAGE_POOL)
    return Config(
        host=host,
        port=port,
        database=source.get("SPARKD_DB", DEFAULT_DB),
        incus_socket=source.get("SPARKD_INCUS_SOCKET", DEFAULT_INCUS_SOCKET),
        caddy_admin=source.get("SPARKD_CADDY_ADMIN", DEFAULT_CADDY_ADMIN),
        driver=driver,
        log_level=log_level,
        storage_pool=pool,
        # SPK-28 · docs/DAT.md §8.5 bis : le jeu de donnees SUIT le pool par
        # defaut. Sur une installation ordinaire ils portent le meme nom, et les
        # desynchroniser en silence ferait verifier la compression d'un jeu de
        # donnees qui n'est pas celui du pool.
        storage_dataset=source.get("SPARKD_STORAGE_DATASET", "") or pool,
        allowed_signers=source.get("SPARKD_ALLOWED_SIGNERS", ""),
        secret_key_file=_cle_par_defaut(source),
        notify_url=source.get("SPARKD_NOTIFY_URL", "").strip(),
        forge_public_address=source.get("SPARKD_FORGE_PUBLIC_ADDRESS", "").strip(),
        memory_reserve_bytes=reserve,
        cpu_reserve=cpu_reserve,
        storage_metadata_margin_bytes=marge,
        reserved_ports=_parse_reserved_ports(
            source.get("SPARKD_RESERVED_PORTS", "")),
    )
