"""Métriques d'usage d'un Spark.

@spec docs/BACKLOG.md#SPK-14 · docs/DAT.md §20 (Métriques d'usage),
      §20.1 (compteurs), §20.2 (seule eth0), §20.3 (à quoi ça se compare),
      §20.4 (un Spark arrêté) · §7.3 bis, §7.6

Un compteur n'est pas un taux. Ce module conserve le relevé précédent pour
produire un taux **accompagné de sa fenêtre** — un taux sans fenêtre n'est pas
interprétable — et rend `null` tant qu'aucune fenêtre n'existe.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

#: Interface rattachée au bridge privé. Les `docker0` et `br-*` que Docker crée
#: DANS le Spark portent du trafic interne qui ne sort jamais (docs/DAT.md §20.2).
PRIVATE_IFACE = "eth0"

#: En deçà, le taux est trop bruité pour valoir mieux que rien.
MIN_WINDOW_SECONDS = 0.5


@dataclass(frozen=True)
class Sample:
    """Relevé brut, horodaté par l'appelant."""

    at: float
    cpu_ns: int
    rx_bytes: int
    tx_bytes: int


@dataclass
class RateTracker:
    """Garde le relevé précédent de chaque Spark, pour en tirer un taux.

    L'état vit en mémoire : une métrique perdue au redémarrage n'a aucune
    conséquence, alors que la persister ferait calculer un taux sur une fenêtre
    incluant un arrêt — donc faux.
    """

    previous: dict[str, Sample] = field(default_factory=dict)

    def observe(self, spark_id: str, sample: Sample) -> dict:
        precedent = self.previous.get(spark_id)
        self.previous[spark_id] = sample

        if precedent is None:
            return _unknown("Premier relevé : aucune fenêtre de mesure.")

        fenetre = sample.at - precedent.at
        if fenetre < MIN_WINDOW_SECONDS:
            return _unknown(
                f"Fenêtre trop courte ({fenetre:.2f} s) pour un taux fiable."
            )
        if sample.cpu_ns < precedent.cpu_ns or sample.rx_bytes < precedent.rx_bytes:
            # Les compteurs repartent de zéro au redémarrage de l'instance :
            # la différence serait négative, donc absurde.
            return _unknown("Compteurs réinitialisés : le Spark a redémarré.")

        return {
            "window_seconds": round(fenetre, 2),
            "cpu": round((sample.cpu_ns - precedent.cpu_ns) / (fenetre * 1e9), 4),
            "network_rx_bps": round((sample.rx_bytes - precedent.rx_bytes) * 8 / fenetre),
            "network_tx_bps": round((sample.tx_bytes - precedent.tx_bytes) * 8 / fenetre),
        }

    def forget(self, spark_id: str) -> None:
        self.previous.pop(spark_id, None)


def _unknown(raison: str) -> dict:
    """Taux indisponible. `null`, jamais `0` (docs/DAT.md §20.1)."""
    return {
        "window_seconds": None,
        "cpu": None,
        "network_rx_bps": None,
        "network_tx_bps": None,
        "unavailable": raison,
    }


def read_sample(state: dict, now: float | None = None) -> Sample:
    """Extrait les compteurs d'un état Incus, sans additionner les bridges Docker."""
    interfaces = state.get("network") or {}
    privee = (interfaces.get(PRIVATE_IFACE) or {}).get("counters") or {}
    return Sample(
        at=time.monotonic() if now is None else now,
        cpu_ns=int((state.get("cpu") or {}).get("usage") or 0),
        rx_bytes=int(privee.get("bytes_received") or 0),
        tx_bytes=int(privee.get("bytes_sent") or 0),
    )


def usage(spark: dict, state: dict, rates: dict) -> dict:
    """Assemble l'usage d'un Spark, comparé à ce qui est RÉELLEMENT appliqué."""
    memoire = state.get("memory") or {}
    disque = ((state.get("disk") or {}).get("root")) or {}

    mem_usage = memoire.get("usage")
    disk_usage = disque.get("usage")

    reservation = spark.get("cpu_reservation")
    if spark.get("cpu_mode") == "capped":
        reservation = spark.get("cpu_max")

    plafonne = spark.get("cpu_mode") == "capped"
    utilise = rates["cpu"]
    return {
        "state": state.get("status", "Unknown"),
        "cpu": {
            "used": utilise,
            "reservation": reservation,
            # docs/DAT.md §7.3 bis, §32.2 : la reservation est un PLANCHER
            # depuis l'arbitrage du 2026-08-21. Ni « garantie absolue », ni
            # « non garantie » — les deux seraient faux.
            # docs/DAT.md §32.2, arbitrage du 2026-08-21 : plancher, pas
            # proportion. Meme valeur qu'au §27.6, publiee au meme titre.
            "guarantee": "floor_under_contention",
            # docs/DAT.md §20.3 bis : consommer au-delà de la réservation est
            # NORMAL en mode partagé — c'est du burst, pas un dépassement. Une
            # jauge rouge sur « 1,99 / 0,5 » signalerait un défaut inexistant.
            "capped": plafonne,
            "burst": (
                None if utilise is None or reservation is None
                else round(max(0.0, utilise - reservation), 4)
            ),
            "over_limit": (
                bool(plafonne and utilise is not None and reservation is not None
                     and utilise > reservation * 1.05)
            ),
        },
        "memory": {
            "used_bytes": mem_usage,
            "limit_bytes": spark.get("memory_reservation_bytes"),
            "ratio": _ratio(mem_usage, spark.get("memory_reservation_bytes")),
        },
        "disk": {
            "used_bytes": disk_usage,
            "limit_bytes": spark.get("storage_bytes"),
            "ratio": _ratio(disk_usage, spark.get("storage_bytes")),
            "note": "Inclut les instantanés du Spark.",
        },
        "network": {
            "rx_bps": rates["network_rx_bps"],
            "tx_bps": rates["network_tx_bps"],
            # docs/DAT.md §20.3 : on compare au PLAFOND, jamais à la
            # réservation, que le noyau ne garantit pas.
            "limit_bps": spark.get("network_burst_bps"),
            "reservation_bps": spark.get("network_reservation_bps"),
            "note": (
                "La réservation sert à la comptabilité ; seul le plafond est "
                "appliqué par le noyau."
            ),
        },
        "window_seconds": rates["window_seconds"],
        "unavailable": rates.get("unavailable"),
    }


def stopped(spark: dict) -> dict:
    """Un Spark arrêté n'a pas un usage nul : il n'en a pas (docs/DAT.md §20.4)."""
    return {
        "state": spark.get("state", "stopped"),
        "cpu": None,
        "memory": None,
        "disk": None,
        "network": None,
        "window_seconds": None,
        "unavailable": (
            "Spark arrêté : aucune métrique d'exécution. Son disque reste "
            "occupé et sa place reste comptabilisée."
        ),
    }


def _ratio(used, limit) -> float | None:
    if used is None or not limit:
        return None
    return round(used / limit, 4)
