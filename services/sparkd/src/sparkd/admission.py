"""Admission control et comptabilité des pools de la Forge.

@spec docs/BACKLOG.md#SPK-05, docs/BACKLOG.md#SPK-30 · docs/DAT.md §7.3
      (invariant), §7.3 bis (ce que l'invariant ne garantit pas), §7.7 (ce qui
      compte et contre quoi), §8.8.2 règle 4 (la marge de métadonnées est
      comptée au pool) · docs/SCHEMA.md §2 (host), §4 (spark)

Le registre — et non le noyau — produit la garantie de réservation. Le noyau
n'applique que des proportions ; c'est l'invariant

    Σ réservations ≤ capacité × surengagement

maintenu ici qui rend ces proportions signifiantes.

Portée exacte de cette garantie, à ne pas surestimer NI SOUS-ESTIMER : depuis
SPK-29 et l'arbitrage du 2026-08-21 (DAT §32.2), la réservation est un
**plancher** — garanti sous contention totale, dépassé dès qu'une tranche de la
Forge est au repos. Ce module compte donc ce qui est VENDU ; ce que la machine
rend ensuite est le fait de la tranche parente, pas de l'admission.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from enum import Enum

# Le mode « capped » consomme son PLAFOND, pas zéro : un Spark plafonné à
# 0,5 CPU peut réellement consommer 0,5 CPU en permanence (DAT §7.7).
CPU_POOL_MODES = ("shared", "shared-pinned", "capped")

#: Marge de métadonnées par défaut (docs/DAT.md §8.8.3), en octets. Elle est
#: réellement prise sur le pool : la compter ferait promettre au registre ce
#: qu'il n'a pas — même raisonnement qu'au §8.5 pour l'ARC.
DEFAULT_METADATA_MARGIN = 64 * 1024 * 1024


class Resource(str, Enum):
    CPU = "cpu"
    MEMORY = "memory"
    NETWORK = "network"
    STORAGE = "storage"


UNITS = {
    Resource.CPU: "CPU",
    Resource.MEMORY: "octets",
    Resource.NETWORK: "bit/s",
    Resource.STORAGE: "octets",
}


class HostNotConfigured(RuntimeError):
    """La capacité de la Forge n'a pas encore été relevée."""


@dataclass(frozen=True)
class Shortfall:
    """Une ressource qui manque, avec de quoi décider quoi faire."""

    resource: Resource
    requested: float
    available: float
    capacity: float
    allocated: float
    overcommit: float

    @property
    def missing(self) -> float:
        return self.requested - self.available

    def __str__(self) -> str:
        unite = UNITS[self.resource]
        texte = (
            f"{self.resource.value} : {_fmt(self.requested)} {unite} demandés, "
            f"{_fmt(self.available)} disponibles "
            f"(capacité {_fmt(self.capacity)}, alloué {_fmt(self.allocated)}"
        )
        if self.overcommit != 1.0:
            texte += f", surengagement ×{self.overcommit:g}"
        return texte + f") — il manque {_fmt(self.missing)} {unite}"


@dataclass(frozen=True)
class Decision:
    """Verdict d'admission. Toujours motivé, y compris en cas de refus."""

    admitted: bool
    shortfalls: tuple[Shortfall, ...] = ()

    def __bool__(self) -> bool:
        return self.admitted

    @property
    def reason(self) -> str:
        if self.admitted:
            return "admis"
        return "Capacité insuffisante — " + " ; ".join(str(s) for s in self.shortfalls)


@dataclass(frozen=True)
class Request:
    """Demande de ressources, exprimée dans les unités du modèle."""

    cpu_mode: str
    memory_bytes: int
    network_bps: int
    storage_bytes: int
    cpu_reservation: float | None = None
    cpu_max: float | None = None
    cpu_cores: int | None = None

    @property
    def cpu_pool_demand(self) -> float:
        """Ce que la demande prend au pool CPU partagé (DAT §7.7)."""
        if self.cpu_mode == "capped":
            return self.cpu_max or 0.0
        if self.cpu_mode in ("shared", "shared-pinned"):
            return self.cpu_reservation or 0.0
        return 0.0  # dedicated : réduit la capacité, ne consomme pas de réservation

    @property
    def dedicated_cores(self) -> int:
        return self.cpu_cores or 0 if self.cpu_mode == "dedicated" else 0


@dataclass(frozen=True)
class Pool:
    """État d'une ressource : ce qui existe, ce qui est pris, ce qui reste."""

    resource: Resource
    capacity: float
    allocated: float
    overcommit: float = 1.0

    @property
    def available(self) -> float:
        return self.capacity - self.allocated


@dataclass(frozen=True)
class Pools:
    cpu: Pool
    memory: Pool
    network: Pool
    storage: Pool
    dedicated_cores: int = 0
    physical_cores: int = 0

    def as_dict(self) -> dict[str, dict[str, float]]:
        return {
            pool.resource.value: {
                "capacity": pool.capacity,
                "allocated": pool.allocated,
                "available": pool.available,
                "overcommit": pool.overcommit,
            }
            for pool in (self.cpu, self.memory, self.network, self.storage)
        }


def _fmt(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.4g}"


def _host_row(connection: sqlite3.Connection) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM forge WHERE id = 1").fetchone()
    if row is None:
        raise HostNotConfigured(
            "La capacité de la Forge n'est pas encore relevée : aucune ligne dans "
            "« host ». Rien ne peut être admis tant qu'on ignore ce qui existe."
        )
    return row


def pools(
    connection: sqlite3.Connection,
    metadata_margin: int = DEFAULT_METADATA_MARGIN,
    sauf: str | None = None,
) -> Pools:
    """Photographie des pools : capacité, alloué, disponible.

    Tous les Sparks du registre comptent, quel que soit leur état (DAT §7.7) :
    la ressource n'est rendue qu'à la disparition de la ligne.

    `sauf` EXCLUT un Spark du calcul de l'alloué (SPK-57, §49.1). Il sert au
    redimensionnement : un Spark qui existe est déjà compté, et lui demander
    8 Gio alors qu'il en a 6 ne prend au pool que 2 Gio. Rejouer l'admission sur
    la demande entière refuserait des agrandissements tenables — et refuserait
    même de RÉTRÉCIR un Spark sur une Forge saturée, ce qui est absurde : rendre
    de la mémoire ne peut pas manquer de mémoire.

    Le paramètre nomme un Spark à NE PAS COMPTER, jamais une valeur à retrancher.
    La différence se voit dans le refus rendu : les chiffres restent ceux que
    l'exploitant a saisis, là où une soustraction ferait lire « il manque 2 Gio
    sur une demande de 2 Gio » à qui en demande 8 (§49.1).

    L'alloué du pool de stockage inclut la **marge de métadonnées** de chaque
    Spark (§8.8.2 règle 4) : elle est posée sur le jeu de données, donc réellement
    prise. Sur trente Sparks à 64 Mio elle coûte 1,9 Gio — négligeable en valeur,
    mais la comptabilité du §7.7 ne connaît pas le négligeable.
    """
    host = _host_row(connection)

    # L'exclusion est un fragment de clause, ajouté aux TROIS relevés : n'en
    # oublier qu'un rendrait un pool cohérent et un autre faux, et le refus
    # mélangerait les deux comptabilités.
    exclusion = " AND id != ?" if sauf else ""
    hors = (sauf,) if sauf else ()

    marques = ", ".join("?" * len(CPU_POOL_MODES))
    cpu_alloue = connection.execute(
        f"""SELECT COALESCE(SUM(
                CASE cpu_mode WHEN 'capped' THEN cpu_max ELSE cpu_reservation END
            ), 0) AS total
            FROM spark WHERE cpu_mode IN ({marques}){exclusion}""",
        (*CPU_POOL_MODES, *hors),
    ).fetchone()["total"]

    # Les cœurs DÉDIÉS aussi : passer de « dedicated » à « shared » rend des
    # cœurs physiques au pool partagé, donc augmente sa CAPACITÉ. Sans cette
    # exclusion, la Forge évaluerait la nouvelle demande contre un pool encore
    # amputé des cœurs qu'on lui rend (§49.1).
    coeurs_dedies = connection.execute(
        "SELECT COALESCE(SUM(cpu_cores), 0) AS total FROM spark "
        f"WHERE cpu_mode = 'dedicated'{exclusion}",
        hors,
    ).fetchone()["total"]

    autres = connection.execute(
        f"""SELECT COALESCE(SUM(memory_reservation_bytes), 0)  AS memoire,
                   COALESCE(SUM(network_reservation_bps), 0)   AS reseau,
                   COALESCE(SUM(storage_bytes), 0)             AS stockage,
                   COUNT(*)                                    AS nombre
            FROM spark WHERE 1=1{exclusion}""",
        hors,
    ).fetchone()
    # Le registre stocke la taille VENDUE (§8.8.2 règle 1) ; la marge est une
    # valeur dérivée, ajoutée ici plutôt que dupliquée en base.
    stockage_alloue = autres["stockage"] + metadata_margin * autres["nombre"]

    # La capacité CPU se compte en cœurs physiques : le SMT entrelace
    # l'exécution, il n'ajoute pas de capacité (DAT §7.7).
    coeurs_partages = max(0, host["cpu_cores_total"] - coeurs_dedies)

    return Pools(
        cpu=Pool(
            Resource.CPU,
            coeurs_partages * host["overcommit_cpu"],
            cpu_alloue,
            host["overcommit_cpu"],
        ),
        memory=Pool(
            Resource.MEMORY,
            max(0, host["memory_total_bytes"] - host["memory_reserve_bytes"])
            * host["overcommit_memory"],
            autres["memoire"],
            host["overcommit_memory"],
        ),
        network=Pool(
            Resource.NETWORK,
            host["network_total_bps"] * host["overcommit_network"],
            autres["reseau"],
            host["overcommit_network"],
        ),
        # Le stockage n'a pas de surengagement : un pool saturé est une panne
        # dure, pas de la lenteur (DAT §7.7).
        storage=Pool(
            Resource.STORAGE,
            max(0, host["storage_total_bytes"] - host["storage_reserve_bytes"]),
            stockage_alloue,
            1.0,
        ),
        dedicated_cores=coeurs_dedies,
        physical_cores=host["cpu_cores_total"],
    )


def admit(
    connection: sqlite3.Connection,
    request: Request,
    metadata_margin: int = DEFAULT_METADATA_MARGIN,
    sauf: str | None = None,
) -> Decision:
    """Décide si la demande tient dans ce qui reste.

    `sauf` sert au REDIMENSIONNEMENT (SPK-57, §49.1) : le Spark visé est rendu au
    pool avant que sa nouvelle demande n'y soit évaluée. C'est « rendre d'abord,
    admettre ensuite », et non « admettre le delta » — les chiffres du refus
    restent ainsi ceux que l'exploitant a saisis.

    Toutes les ressources sont évaluées, et non seulement la première qui
    manque : corriger une demande pour se heurter à la suivante est une perte de
    temps évitable (DAT §7.7).

    La demande de stockage évaluée est celle qui sera réellement posée : taille
    vendue **plus** marge de métadonnées (§8.8.2 règle 4). Le refus reste un refus
    sur `storage`, dans la forme du §7.7 : il n'existe pas de refus « marge ».
    """
    etat = pools(connection, metadata_margin, sauf=sauf)
    manques: list[Shortfall] = []

    def controle(pool: Pool, demande: float) -> None:
        if demande > pool.available:
            manques.append(
                Shortfall(
                    resource=pool.resource,
                    requested=demande,
                    available=pool.available,
                    capacity=pool.capacity,
                    allocated=pool.allocated,
                    overcommit=pool.overcommit,
                )
            )

    # Un Spark dédié retire des cœurs du pool partagé : il doit rester assez de
    # cœurs libres ET les Sparks partagés déjà admis doivent continuer à tenir
    # dans le pool réduit.
    if request.dedicated_cores:
        coeurs_libres = etat.physical_cores - etat.dedicated_cores
        capacite_restante = (
            max(0, coeurs_libres - request.dedicated_cores) * etat.cpu.overcommit
        )
        if request.dedicated_cores > coeurs_libres or etat.cpu.allocated > capacite_restante:
            manques.append(
                Shortfall(
                    resource=Resource.CPU,
                    requested=float(request.dedicated_cores),
                    available=float(max(0, coeurs_libres)),
                    capacity=float(etat.physical_cores),
                    allocated=etat.cpu.allocated,
                    overcommit=etat.cpu.overcommit,
                )
            )
    else:
        controle(etat.cpu, request.cpu_pool_demand)

    controle(etat.memory, request.memory_bytes)
    controle(etat.network, request.network_bps)
    controle(etat.storage, request.storage_bytes + metadata_margin)

    return Decision(admitted=not manques, shortfalls=tuple(manques))
