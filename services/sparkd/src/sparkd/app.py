"""Application HTTP de sparkd.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §4 (Ce qui est reellement ecrit ici),
      §5 (Topologie physique et surface reseau)

Le squelette n'expose ici que les sondes d'etat. L'inventaire de l'hote, le
cycle de vie des Sparks et l'ingress appartiennent a leurs propres unites
(SPK-07 a SPK-12) et ne sont pas anticipes.

« readyz » se distingue de « healthz » a dessein : le processus peut repondre
alors que ses dependances — Incus, le registre — ne sont pas encore joignables.
Confondre les deux ferait declarer prete une instance incapable de travailler.
"""

from __future__ import annotations

from contextlib import contextmanager

from fastapi import FastAPI, HTTPException

from . import __version__
from .admission import HostNotConfigured, pools
from .config import Config
from .db import connect
from .incus import FakeIncus, IncusClient, IncusError, UnixSocketIncus
from .inventory import InventoryError, sync
from .migrations import applied, upgrade, verify


def make_client(config: Config) -> IncusClient:
    """Choisit le pilote. Le factice sert au développement, jamais à conclure."""
    if config.driver == "fake":
        return FakeIncus()
    return UnixSocketIncus(config.incus_socket)


def check_registry(config: Config) -> list[int]:
    """Prépare le registre et vérifie qu'il correspond au code.

    `docs/SCHEMA.md` §12.4 : sparkd refuse de servir une base dont le schéma
    réel n'est plus celui que le code croit. La vérification a lieu ici, avant
    que la moindre requête ne soit acceptée — plus tard, l'erreur serait
    découverte au milieu d'une opération et bien plus difficile à rattacher à sa
    cause.

    La connexion est refermée aussitôt : elle ne survit pas au démarrage. Voir
    `registry()` pour la raison.
    """
    connection = connect(config.database)
    try:
        # L'application migre elle-même : supposer des tables créées ailleurs
        # couperait la responsabilité en deux et rendrait `create_app`
        # inutilisable seule — ce que les tests ont montré immédiatement.
        upgrade(connection)
        verify(connection)
        return sorted(applied(connection))
    finally:
        connection.close()


def create_app(config: Config) -> FastAPI:
    app = FastAPI(
        title="sparkd",
        version=__version__,
        description=(
            "Runtime serveur du plan de controle Spark. Ecoute exclusivement "
            "sur la boucle locale."
        ),
    )
    app.state.config = config
    app.state.schema_versions = check_registry(config)
    app.state.incus = make_client(config)

    @contextmanager
    def registry():
        """Une connexion par requête, jamais une connexion partagée.

        Une connexion SQLite est liée au thread qui l'a créée, et FastAPI
        exécute les gestionnaires synchrones dans un pool de threads : une
        connexion posée sur `app.state` casserait dès le premier appel servi par
        un autre thread. Ouvrir par requête supprime le partage plutôt que de le
        rendre tolérable — le mode WAL rend les lecteurs concurrents peu
        coûteux.
        """
        connection = connect(config.database)
        try:
            yield connection
        finally:
            connection.close()

    @app.get("/healthz", tags=["etat"])
    def healthz() -> dict[str, str]:
        """Le processus repond. Ne dit rien de ses dependances."""
        return {"status": "ok", "version": __version__}

    @app.get("/readyz", tags=["etat"])
    def readyz() -> dict[str, object]:
        """Etat des dependances necessaires au travail reel.

        Tant que les pilotes ne sont pas ecrits (SPK-07, SPK-08), les
        dependances sont declarees « inconnues » plutot que « pretes ». Annoncer
        une disponibilite non verifiee serait un succes simule (CLAUDE.md §18).
        """
        versions = app.state.schema_versions
        return {
            "status": "degraded",
            "driver": config.driver,
            "dependencies": {
                "incus": "unknown",
                "registry": "ready" if versions else "empty",
                "caddy": "unknown",
            },
            "schema_version": versions[-1] if versions else None,
            "detail": "Pilotes Incus et Caddy non implementes : unites SPK-08 et SPK-12.",
        }

    @app.get("/v1/host", tags=["hote"])
    def host() -> dict[str, object]:
        """Capacité de l'hôte et état des pools.

        C'est ici que l'admission control devient observable : sans cette vue,
        rien ne permet de savoir pourquoi une création serait refusée.
        """
        with registry() as connection:
            try:
                etat = pools(connection)
            except HostNotConfigured as erreur:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "host_not_synced",
                        "message": str(erreur),
                        "remedy": "POST /v1/host/sync",
                    },
                ) from erreur
            row = connection.execute("SELECT * FROM host WHERE id = 1").fetchone()
        return {
            "hostname": row["hostname"],
            "cpu": {
                "cores_total": row["cpu_cores_total"],
                "threads_total": row["cpu_threads_total"],
                "cores_dedicated": etat.dedicated_cores,
            },
            "reserves": {
                "memory_bytes": row["memory_reserve_bytes"],
                "storage_bytes": row["storage_reserve_bytes"],
            },
            "pools": etat.as_dict(),
            "topology_synced_at": row["topology_synced_at"],
            # docs/DAT.md §7.3 bis : ne jamais présenter la réservation comme
            # une garantie absolue tant que SPK-29 n'est pas livrée.
            "reservation_guarantee": "proportional_between_sparks_only",
        }

    @app.post("/v1/host/sync", tags=["hote"], status_code=200)
    def host_sync() -> dict[str, object]:
        """Relève la topologie depuis Incus et l'écrit dans le registre."""
        try:
            with registry() as connection:
                topology = sync(connection, app.state.incus, config.storage_pool)
        except (IncusError, InventoryError) as erreur:
            raise HTTPException(
                status_code=503,
                detail={"error": "incus_unavailable", "message": str(erreur)},
            ) from erreur
        return {
            "hostname": topology.hostname,
            "cpu_cores_total": topology.cpu_cores_total,
            "cpu_threads_total": topology.cpu_threads_total,
            "memory_total_bytes": topology.memory_total_bytes,
            "network_total_bps": topology.network_total_bps,
            "storage_total_bytes": topology.storage_total_bytes,
        }

    return app
