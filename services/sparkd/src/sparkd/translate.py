"""Traduction d'un manifeste Spark en configuration Incus.

@spec docs/BACKLOG.md#SPK-08 · docs/DAT.md §7.2 (les quatre modes CPU),
      §7.2 bis (allowance → poids), §7.2 ter (rendu exact des valeurs),
      §7.5 (SMT), §7.6 (mémoire, réseau, stockage),
      §8.8 (la marge de métadonnées) · docs/BACKLOG.md#SPK-30 · docs/SCHEMA.md §4

Ce module est la frontière entre le vocabulaire du produit — « 0,5 CPU
partagé » — et celui d'Incus. Il ne parle à personne : il transforme. C'est
délibéré, parce que c'est ce qui le rend éprouvable sans hôte.

Principe directeur, hérité du §7.2 ter : **quand une valeur ne peut pas être
rendue fidèlement, on refuse au lieu d'approximer**. Une approximation
silencieuse ferait diverger le registre de la machine.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import cgroup

# Loi mesurée sur onze points (docs/DAT.md §7.2 bis) :
#     cpu.weight = allowance_pct − 10 + limits.cpu.priority
# Le noyau refuse un poids nul ou négatif, d'où le plancher.
WEIGHT_OFFSET = 10
MIN_WEIGHT = 1

# L'échelle ×1000 préserve la résolution des petites réservations là où ×100
# les écrase (docs/DAT.md §7.2 bis).
ALLOWANCE_SCALE = 1000

# La forme temporelle s'exprime en millisecondes entières sur une période de
# 100 ms (docs/DAT.md §7.2 ter).
QUOTA_PERIOD_MS = 100

#: Marge de métadonnées par défaut, en octets (docs/DAT.md §8.8.3). Elle vit ici
#: pour que le traducteur reste éprouvable sans configuration ; l'exploitant la
#: règle par `SPARKD_STORAGE_METADATA_MARGIN`, et `app.py` la passe alors.
DEFAULT_METADATA_MARGIN = 64 * 1024 * 1024


def quota_bytes(storage_bytes: int, metadata_margin: int = DEFAULT_METADATA_MARGIN) -> int:
    """Quota à POSER sur le jeu de données, à partir de la taille VENDUE.

    Le registre stocke la taille vendue et elle seule (§8.8.2 règle 1) : le quota
    est une valeur dérivée, recalculée ici à chaque traduction. Stocker les deux
    ferait deux vérités à tenir d'accord.

    Mesuré le 2026-08-18 : posé exactement à la taille vendue, un Spark saturé
    empêche Incus d'écrire `backup.yaml` — qui vit DANS le jeu de données
    contingenté — et toute reconfiguration échoue, y compris l'agrandissement qui
    le débloquerait. La marge garde la place de ces écritures.

    Une marge nulle rend exactement la taille vendue : c'est le comportement
    d'avant SPK-30, et il reste atteignable (§8.8.3).
    """
    if metadata_margin < 0:
        raise TranslationError(
            f"Marge de métadonnées négative : {metadata_margin} octets."
        )
    return storage_bytes + metadata_margin

#: Dépôts d'images connus. Une référence « images:debian/13 » nomme un dépôt et
#: un alias ; « images: » est un raccourci de la LIGNE DE COMMANDE, que l'API
#: rejette — mesuré le 2026-08-19. Le traducteur les sépare donc explicitement.
IMAGE_REMOTES = {
    "images": "https://images.linuxcontainers.org",
    "ubuntu": "https://cloud-images.ubuntu.com/releases",
    "ubuntu-daily": "https://cloud-images.ubuntu.com/daily",
}
DEFAULT_REMOTE = "images"


def split_image(reference: str) -> tuple[str, str]:
    """Sépare « dépôt:alias » en URL de serveur et alias.

    L'API d'Incus attend `alias = "debian/13"` et l'URL du serveur à part. Lui
    passer « images:debian/13 » fait échouer la création : le dépôt n'est pas
    un préfixe d'alias.
    """
    if ":" in reference:
        depot, _, alias = reference.partition(":")
    else:
        depot, alias = DEFAULT_REMOTE, reference
    if not alias:
        raise TranslationError(f"Référence d'image vide : {reference!r}.")
    serveur = IMAGE_REMOTES.get(depot)
    if serveur is None:
        connus = ", ".join(sorted(IMAGE_REMOTES))
        raise TranslationError(
            f"Dépôt d'images inconnu : « {depot} ». Connus : {connus}."
        )
    return serveur, alias


class TranslationError(ValueError):
    """La demande ne peut pas être rendue fidèlement en configuration Incus."""


@dataclass(frozen=True)
class Manifest:
    """Ce que le produit décrit, dans ses propres unités."""

    name: str
    image: str
    cpu_mode: str
    memory_bytes: int
    network_burst_bps: int
    storage_bytes: int
    cpu_reservation: float | None = None
    cpu_max: float | None = None
    cpu_cores: int | None = None
    cpu_priority: int = 5
    memory_enforce: str = "hard"
    memory_swap: bool = False
    storage_io_priority: int = 5
    runtime: str = "container"
    ipv4_address: str | None = None


@dataclass(frozen=True)
class IncusConfig:
    """Ce qu'Incus attend, prêt à être posé."""

    name: str
    image: str
    config: dict[str, str]
    devices: dict[str, dict[str, str]]
    instance_type: str = "container"

    def as_payload(self, network: str, pool: str) -> dict[str, object]:
        """Corps de POST /1.0/instances."""
        devices = {nom: dict(valeurs) for nom, valeurs in self.devices.items()}
        devices.setdefault("eth0", {})["type"] = "nic"
        devices["eth0"]["network"] = network
        devices["eth0"]["name"] = "eth0"
        devices.setdefault("root", {})["type"] = "disk"
        devices["root"]["path"] = "/"
        devices["root"]["pool"] = pool
        serveur, alias = split_image(self.image)
        return {
            "name": self.name,
            "type": self.instance_type,
            "config": dict(self.config),
            "devices": devices,
            "source": {
                "type": "image",
                "protocol": "simplestreams",
                "server": serveur,
                "alias": alias,
            },
        }


def allowance_percent(reservation: float, pool_capacity: float, priority: int) -> int:
    """Pourcentage entier à poser, ou refus motivé.

    Le plancher dépend de la priorité : `poids = pct − 10 + priorité` doit rester
    au moins à 1 (docs/DAT.md §7.2 ter).
    """
    if pool_capacity <= 0:
        raise TranslationError(
            "Capacité du pool partagé nulle : aucun Spark partagé ne peut y être "
            "traduit. Relever la topologie de l'hôte d'abord."
        )
    plancher = WEIGHT_OFFSET + MIN_WEIGHT - priority
    pct = round(reservation / pool_capacity * ALLOWANCE_SCALE)
    if pct < plancher:
        minimum = plancher * pool_capacity / ALLOWANCE_SCALE
        raise TranslationError(
            f"Réservation {reservation:g} CPU trop petite pour être rendue "
            f"fidèlement sur un pool de {pool_capacity:g} CPU : elle donnerait un "
            f"poids d'ordonnancement nul ou négatif, que le noyau refuse. "
            f"Minimum admissible à la priorité {priority} : {minimum:.4g} CPU. "
            "Arrondir vers le haut donnerait au Spark plus que ce qui lui a été "
            "comptabilisé."
        )
    return pct


def cpu_weight(percent: int, priority: int) -> int:
    """Poids que le noyau appliquera. Sert aux preuves, pas à la configuration."""
    return percent - WEIGHT_OFFSET + priority


def quota_allowance(cpu_max: float) -> str:
    """Forme temporelle `<t>ms/100ms`, en millisecondes entières."""
    millisecondes = round(cpu_max * QUOTA_PERIOD_MS)
    if millisecondes < 1:
        raise TranslationError(
            f"Plafond {cpu_max:g} CPU trop petit pour être rendu : la plus petite "
            f"tranche exprimable est 1ms/{QUOTA_PERIOD_MS}ms, soit "
            f"{1 / QUOTA_PERIOD_MS:g} CPU. Plafonner à 1ms donnerait au Spark "
            "davantage que ce qui a été vendu."
        )
    return f"{millisecondes}ms/{QUOTA_PERIOD_MS}ms"


def _cpuset(cpu_ids: list[int]) -> str:
    """Liste de CPU logiques, sous la forme attendue par `limits.cpu`."""
    if not cpu_ids:
        raise TranslationError("Aucun CPU à attribuer : cpuset vide.")
    return ",".join(str(c) for c in sorted(cpu_ids))


def translate(
    manifest: Manifest,
    shared_cpus: list[int],
    pool_capacity: float,
    dedicated_cpus: list[int] | None = None,
    metadata_margin: int = DEFAULT_METADATA_MARGIN,
) -> IncusConfig:
    """Traduit un manifeste. Refuse plutôt que d'approximer.

    `shared_cpus` est le cpuset partagé complet, `dedicated_cpus` les CPU
    logiques attribués — **frères SMT compris** (docs/DAT.md §7.5) — lorsque le
    mode l'exige.

    `metadata_margin` est posée AU-DESSUS de la taille vendue (§8.8.2 règle 2) :
    c'est le seul endroit du produit où la marge apparaît.
    """
    if not 0 <= manifest.cpu_priority <= 10:
        raise TranslationError(
            f"Priorité {manifest.cpu_priority} hors bornes : Incus n'accepte "
            "que 0 à 10 (mesuré)."
        )

    config: dict[str, str] = {
        # Docker doit pouvoir tourner dans le Spark : c'est l'objet du produit.
        "security.nesting": "true",
        # Le Spark vit dans la tranche parente, jamais a la racine de cgroup v2
        # (docs/DAT.md §32.1). A la racine, son poids serait arbitre contre
        # `system.slice` autant que contre les autres Sparks, et sa reservation
        # ne serait proportionnelle qu'entre Sparks.
        "raw.lxc": cgroup.raw_lxc(manifest.name),
        # Plages UID/GID disjointes entre Sparks (docs/DAT.md §11).
        "security.idmap.isolated": "true",
        "limits.memory": str(manifest.memory_bytes),
        "limits.memory.enforce": manifest.memory_enforce,
        "limits.memory.swap": "true" if manifest.memory_swap else "false",
        # `limits.disk.priority` est une option d'INSTANCE, pas de périphérique.
        # Posée sur le disque, Incus rejette « Invalid device option » — et,
        # l'override étant atomique, le quota `size` ne s'appliquait pas non
        # plus : le Spark repartait avec le pool entier. Mesuré le 2026-08-18.
        "limits.disk.priority": str(manifest.storage_io_priority),
    }

    if manifest.cpu_mode == "shared":
        if manifest.cpu_reservation is None:
            raise TranslationError("Mode « shared » sans réservation.")
        config["limits.cpu"] = _cpuset(shared_cpus)
        config["limits.cpu.allowance"] = f"{allowance_percent(manifest.cpu_reservation, pool_capacity, manifest.cpu_priority)}%"
        config["limits.cpu.priority"] = str(manifest.cpu_priority)

    elif manifest.cpu_mode == "capped":
        if manifest.cpu_max is None:
            raise TranslationError("Mode « capped » sans plafond.")
        config["limits.cpu"] = _cpuset(shared_cpus)
        config["limits.cpu.allowance"] = quota_allowance(manifest.cpu_max)

    elif manifest.cpu_mode == "dedicated":
        if not dedicated_cpus:
            raise TranslationError(
                "Mode « dedicated » sans CPU attribués. Le pilote ne choisit pas "
                "les cœurs : c'est l'ordonnanceur du registre qui les alloue, "
                "frères SMT compris."
            )
        # Pas d'« allowance » : Incus déconseille de combiner épinglage exclusif
        # et quota temporel, qui contraindraient inutilement l'ordonnanceur.
        config["limits.cpu"] = _cpuset(dedicated_cpus)

    elif manifest.cpu_mode == "shared-pinned":
        if manifest.cpu_reservation is None or not dedicated_cpus:
            raise TranslationError(
                "Mode « shared-pinned » exige une réservation ET des CPU imposés."
            )
        config["limits.cpu"] = _cpuset(dedicated_cpus)
        config["limits.cpu.allowance"] = f"{allowance_percent(manifest.cpu_reservation, pool_capacity, manifest.cpu_priority)}%"
        config["limits.cpu.priority"] = str(manifest.cpu_priority)

    else:
        raise TranslationError(f"Mode CPU inconnu : {manifest.cpu_mode!r}.")

    devices = {
        "root": {
            "type": "disk",
            "path": "/",
            # PAS la taille vendue : elle plus la marge de métadonnées (§8.8).
            # Le locataire ne verra jamais cette valeur — la console affiche ce
            # qu'on lui a vendu (§8.8.2 règle 3).
            "size": str(quota_bytes(manifest.storage_bytes, metadata_margin)),
        },
        "eth0": {
            "type": "nic",
            "name": "eth0",
            # Plafond strict : le noyau n'offre pas de réservation de bande
            # passante, seulement un plafond (docs/DAT.md §7.6).
            "limits.max": str(manifest.network_burst_bps),
        },
    }
    if manifest.ipv4_address:
        # Épinglage : c'est le registre qui a attribué, Incus ne fait
        # qu'appliquer (docs/DAT.md §15.1).
        devices["eth0"]["ipv4.address"] = manifest.ipv4_address

    return IncusConfig(
        name=manifest.name,
        image=manifest.image,
        config=config,
        devices=devices,
        instance_type="virtual-machine" if manifest.runtime == "vm" else "container",
    )
