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

from fastapi import Body, FastAPI, HTTPException

from . import __version__
from .admission import HostNotConfigured, pools
from .config import Config
from .db import connect
from .incus import FakeIncus, IncusClient, IncusError, UnixSocketIncus
from .inventory import InventoryError, sync
from . import sparks as service
from .lifecycle import Command
from .migrations import applied, upgrade, verify
from .translate import Manifest, TranslationError, translate


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

    def _reconcile_at_startup() -> list[dict]:
        """Les états transitoires ne survivent pas au démarrage (§14.3)."""
        try:
            presence = {
                i["name"]: (True, i.get("status") == "Running")
                for i in app.state.incus.instances()
            }
        except IncusError:
            # Incus injoignable : ne rien conclure vaut mieux que conclure faux.
            return []
        connection = connect(config.database)
        try:
            return service.reconcile_all(connection, presence)
        finally:
            connection.close()

    app.state.reconciliations = _reconcile_at_startup()

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

    def _shared_cpuset(connection) -> tuple[list[int], float]:
        """CPU du pool partagé, et sa capacité en cœurs physiques."""
        cpus = [
            r["cpu_id"] for r in connection.execute(
                "SELECT t.cpu_id FROM cpu_thread t JOIN cpu_core c ON c.id = t.core_id"
                " WHERE c.pool = 'shared' ORDER BY t.cpu_id"
            )
        ]
        capacite = pools(connection).cpu.capacity
        return cpus, capacite

    def _apply_to_incus(connection, spark: dict) -> None:
        """Crée réellement l'instance, puis conclut la transition.

        Le registre a déjà sa ligne (docs/DAT.md §14.2) : ce qui suit ne peut
        donc plus laisser d'instance orpheline.
        """
        cpus, capacite = _shared_cpuset(connection)
        manifest = Manifest(
            name=spark["name"], image=spark["image"], cpu_mode=spark["cpu_mode"],
            memory_bytes=spark["memory_reservation_bytes"],
            network_burst_bps=spark["network_burst_bps"],
            storage_bytes=spark["storage_bytes"],
            cpu_reservation=spark["cpu_reservation"], cpu_max=spark["cpu_max"],
            cpu_cores=spark["cpu_cores"], cpu_priority=spark["cpu_priority"],
            memory_enforce=spark["memory_enforce"],
            memory_swap=bool(spark["memory_swap"]),
            storage_io_priority=spark["storage_io_priority"],
            runtime=spark["runtime"],
        )
        try:
            config = translate(manifest, cpus, capacite)
            app.state.incus.create_instance(
                config.as_payload(config_network, config_pool)
            )
        except (TranslationError, IncusError) as erreur:
            service.finish(connection, spark["id"], success=False, error=str(erreur))
            raise HTTPException(status_code=422, detail={
                "error": "apply_failed", "message": str(erreur)}) from erreur
        connection.execute(
            "UPDATE spark SET incus_name = ? WHERE id = ?", (spark["name"], spark["id"])
        )
        service.finish(connection, spark["id"], success=True)

    config_network = "sparkbr0"
    config_pool = config.storage_pool

    @app.get("/v1/sparks", tags=["sparks"])
    def list_sparks() -> dict[str, object]:
        with registry() as connection:
            return {"sparks": service.listing(connection)}

    @app.post("/v1/sparks", tags=["sparks"], status_code=201)
    def create_spark(spec: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                spark = service.create(connection, service.SparkSpec(**spec))
            except TypeError as erreur:
                raise HTTPException(status_code=422, detail={
                    "error": "bad_request", "message": str(erreur)}) from erreur
            except service.AdmissionRefused as refus:
                raise HTTPException(status_code=409, detail={
                    "error": "admission_refused",
                    "message": refus.decision.reason,
                    "shortfalls": [
                        {"resource": m.resource.value, "requested": m.requested,
                         "available": m.available, "missing": m.missing}
                        for m in refus.decision.shortfalls
                    ],
                }) from refus
            except service.SparkError as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "refused", "message": str(erreur)}) from erreur
            return spark

    @app.get("/v1/sparks/{name}", tags=["sparks"])
    def get_spark(name: str) -> dict:
        with registry() as connection:
            try:
                return service.by_name(connection, name)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur

    @app.post("/v1/sparks/{name}/{action}", tags=["sparks"])
    def command_spark(name: str, action: str) -> dict:
        try:
            commande = Command(action)
        except ValueError as erreur:
            raise HTTPException(status_code=404, detail={
                "error": "unknown_command",
                "message": f"Commande « {action} » inconnue.",
                "known": sorted(c.value for c in Command)}) from erreur

        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                apres = service.command(connection, spark["id"], commande)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except service.SparkError as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "transition_refused", "message": str(erreur)}) from erreur

            if commande in (Command.APPLY, Command.RETRY):
                _apply_to_incus(connection, apres)
            elif commande in (Command.START, Command.STOP, Command.RESTART):
                incus_action = "start" if commande is Command.START else "stop"
                try:
                    app.state.incus.set_instance_state(apres["name"], incus_action)
                except IncusError as erreur:
                    service.finish(connection, apres["id"], success=False, error=str(erreur))
                    raise HTTPException(status_code=502, detail={
                        "error": "incus_failed", "message": str(erreur)}) from erreur
                service.finish(connection, apres["id"], success=True)
                if commande is Command.RESTART:
                    service.command(connection, apres["id"], Command.START)
                    app.state.incus.set_instance_state(apres["name"], "start")
                    service.finish(connection, apres["id"], success=True)
            elif commande is Command.DELETE:
                try:
                    if apres["incus_name"]:
                        app.state.incus.delete_instance(apres["incus_name"])
                except IncusError as erreur:
                    service.finish(connection, apres["id"], success=False, error=str(erreur))
                    raise HTTPException(status_code=502, detail={
                        "error": "incus_failed", "message": str(erreur)}) from erreur
                service.finish(connection, apres["id"], success=True)
                return {"deleted": name}

            return service.by_name(connection, name)

    return app
