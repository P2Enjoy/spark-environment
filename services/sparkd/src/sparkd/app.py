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
from . import cores as core_pool
from .addressing import DHCP_RANGE, AddressPoolExhausted, usage
from .admission import HostNotConfigured, pools
from .config import Config
from .db import connect
from .incus import FakeIncus, IncusClient, IncusError, UnixSocketIncus
from .inventory import InventoryError, sync
from . import sparks as service
from . import ingress as ingress_service
from . import metrics as metrics_service
from . import snapshots as snapshot_service
from . import sshkeys
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
    app.state.rates = metrics_service.RateTracker()
    app.state.caddy = (
        ingress_service.FakeCaddy() if config.driver == "fake"
        else ingress_service.Caddy(config.caddy_admin)
    )

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
            connection_usage = connection
            adresses = usage(connection)
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
            "addresses": {
                "capacity": adresses.capacity,
                "used": adresses.used,
                "free": adresses.free,
                "dhcp_dynamic_range": DHCP_RANGE,
            },
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
                topology = sync(
                    connection, app.state.incus, config.storage_pool,
                    operating_margin=config.memory_reserve_bytes,
                )
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
            "memory_reserve_bytes": topology.memory_reserve_bytes,
            "memory_detail": topology.memory_detail,
            "network_total_bps": topology.network_total_bps,
            "storage_total_bytes": topology.storage_total_bytes,
        }

    def _redistribute(connection, redistribution) -> None:
        """Applique à Incus la reconfiguration des Sparks partagés.

        Le registre a déjà tout écrit dans une transaction (docs/DAT.md
        §7.4 ter) ; cette application-ci est faite Spark par Spark et n'est pas
        atomique. Si elle échoue en chemin, le registre reste la référence.
        """
        cpuset = ",".join(str(c) for c in redistribution.shared_cpus)
        for entree in redistribution.reconfigured:
            config = {"limits.cpu": cpuset}
            if entree["allowance"] is not None:
                config["limits.cpu.allowance"] = entree["allowance"]
            try:
                app.state.incus.update_instance_config(entree["name"], config)
            except IncusError:
                # Ne pas interrompre : les Sparks suivants doivent être
                # reconfigurés eux aussi. L'écart sera repris à la
                # réconciliation.
                continue

    def _apply_to_incus(connection, spark: dict) -> None:
        """Crée réellement l'instance, puis conclut la transition.

        Le registre a déjà sa ligne (docs/DAT.md §14.2) : ce qui suit ne peut
        donc plus laisser d'instance orpheline.
        """
        if spark["cpu_mode"] in ("dedicated", "shared-pinned"):
            deja = core_pool.dedicated_cpus(connection, spark["id"])
            if not deja:
                try:
                    redistribution = core_pool.carve(
                        connection, spark["id"], spark["cpu_cores"]
                    )
                except core_pool.CoreAllocationError as erreur:
                    service.finish(connection, spark["id"], success=False, error=str(erreur))
                    raise HTTPException(status_code=409, detail={
                        "error": "core_allocation_failed",
                        "message": str(erreur)}) from erreur
                _redistribute(connection, redistribution)
            epingles = core_pool.dedicated_cpus(connection, spark["id"])
        else:
            epingles = None

        cpus = core_pool.shared_cpus(connection)
        capacite = core_pool.shared_capacity(connection)
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
            ipv4_address=spark["ipv4_address"],
        )
        try:
            config = translate(manifest, cpus, capacite, dedicated_cpus=epingles)
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

    def _apply_keys(connection, spark: dict) -> None:
        """Réécrit `authorized_keys` dans le Spark depuis l'état voulu.

        Régénéré en entier, jamais complété : c'est ce qui fait qu'un retrait
        retire réellement (docs/DAT.md §17.1).
        """
        if not spark.get("incus_name"):
            return
        contenu = sshkeys.authorized_keys_content(connection, spark["id"])
        app.state.incus.push_file(
            spark["incus_name"], sshkeys.AUTHORIZED_KEYS, contenu, mode="0600"
        )

    def _reconcile_ingress(connection) -> None:
        """Régénère et applique la configuration de Caddy.

        Appelée à chaque changement de route ou d'adresse : la réconciliation
        est le mécanisme normal d'application, pas une réparation (§18.1).
        """
        ingress_service.reconcile(connection, app.state.caddy)

    @app.get("/v1/sparks/{name}/usage", tags=["metriques"])
    def spark_usage(name: str) -> dict:
        """Usage réel, comparé à ce qui est effectivement appliqué."""
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur

        if spark["state"] != "running" or not spark["incus_name"]:
            return {"spark": name, **metrics_service.stopped(spark)}

        try:
            etat = app.state.incus.instance_state(spark["incus_name"])
        except IncusError as erreur:
            raise HTTPException(status_code=502, detail={
                "error": "incus_failed", "message": str(erreur)}) from erreur

        taux = app.state.rates.observe(
            spark["id"], metrics_service.read_sample(etat)
        )
        return {"spark": name, **metrics_service.usage(spark, etat, taux)}

    @app.get("/v1/sparks/{name}/snapshots", tags=["instantanes"])
    def list_snapshots(name: str) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            snapshot_service.sync_sizes(connection, spark, app.state.incus)
            return {
                "snapshots": snapshot_service.listing(connection, spark["id"]),
                # docs/DAT.md §19.5 — la console ne doit jamais présenter un
                # instantané comme une sauvegarde.
                "note": (
                    "Un instantané vit dans le même pool que le Spark : il ne "
                    "protège ni de la perte du pool, ni de celle de la machine, "
                    "et consomme le quota disque du Spark."
                ),
            }

    @app.post("/v1/sparks/{name}/snapshots", tags=["instantanes"], status_code=201)
    def take_snapshot(name: str, body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                return snapshot_service.create(
                    connection, spark, body.get("name", ""), app.state.incus
                )
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except snapshot_service.SnapshotError as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "snapshot_refused", "message": str(erreur)}) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur

    @app.post("/v1/sparks/{name}/snapshots/{snapshot}/restore", tags=["instantanes"])
    def restore_snapshot(name: str, snapshot: str, body: dict = Body(default={})) -> dict:
        """Restaure. Refuse si des instantanés plus récents seraient détruits.

        L'acceptation de leur perte est un drapeau de CETTE requête, jamais une
        option de configuration : une configuration se pose une fois et s'oublie,
        alors que la perte se décide instantané par instantané (§19.1).
        """
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                return snapshot_service.restore(
                    connection, spark, snapshot, app.state.incus,
                    accept_losing_newer=bool((body or {}).get("accept_losing_newer")),
                )
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except snapshot_service.BlockedByNewer as refus:
                raise HTTPException(status_code=409, detail={
                    "error": "blocked_by_newer_snapshots",
                    "message": str(refus),
                    "blocking": list(refus.blocking),
                    "override": "Renvoyer avec {\"accept_losing_newer\": true}.",
                }) from refus
            except snapshot_service.SnapshotError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur

    @app.delete("/v1/sparks/{name}/snapshots/{snapshot}", tags=["instantanes"])
    def drop_snapshot(name: str, snapshot: str) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                snapshot_service.delete(connection, spark, snapshot, app.state.incus)
            except (service.NotFound, snapshot_service.SnapshotError) as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur
            return {"deleted": snapshot}

    @app.get("/v1/ingress", tags=["ingress"])
    def list_routes() -> dict:
        with registry() as connection:
            return {"routes": ingress_service.listing(connection)}

    @app.post("/v1/ingress", tags=["ingress"], status_code=201)
    def add_route(body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, body.get("spark", ""))
                route = ingress_service.declare(
                    connection, spark["id"], body.get("domain", ""),
                    int(body.get("port", 0)), bool(body.get("tls", True)),
                )
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except (ingress_service.IngressError, ValueError, TypeError) as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "route_refused", "message": str(erreur)}) from erreur
            try:
                _reconcile_ingress(connection)
            except ingress_service.IngressError as erreur:
                # La route est enregistrée ; l'écart reste visible par
                # applied_at (§18.5) plutôt que masqué par un succès simulé.
                raise HTTPException(status_code=502, detail={
                    "error": "caddy_unavailable",
                    "message": str(erreur),
                    "route": route["domain"],
                    "note": "Route enregistrée mais non appliquée.",
                }) from erreur
            return ingress_service.by_domain(connection, route["domain"])

    @app.delete("/v1/ingress/{domain}", tags=["ingress"])
    def remove_route(domain: str) -> dict:
        with registry() as connection:
            try:
                ingress_service.withdraw(connection, domain)
            except ingress_service.IngressError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            try:
                _reconcile_ingress(connection)
            except ingress_service.IngressError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "caddy_unavailable", "message": str(erreur)}) from erreur
            return {"withdrawn": domain}

    @app.post("/v1/ingress/reconcile", tags=["ingress"])
    def reconcile_routes() -> dict:
        """Reconstruit intégralement la configuration de Caddy depuis le registre."""
        with registry() as connection:
            try:
                return ingress_service.reconcile(connection, app.state.caddy)
            except ingress_service.IngressError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "caddy_unavailable", "message": str(erreur)}) from erreur

    @app.get("/v1/ssh-keys", tags=["cles"])
    def list_keys() -> dict:
        with registry() as connection:
            return {"keys": [
                {k: v for k, v in cle.items() if k != "public_key"}
                for cle in sshkeys.listing(connection)
            ]}

    @app.post("/v1/ssh-keys", tags=["cles"], status_code=201)
    def add_key(body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                cle = sshkeys.register(
                    connection, body.get("label", ""), body.get("public_key", "")
                )
            except sshkeys.SshKeyError as erreur:
                raise HTTPException(status_code=422, detail={
                    "error": "invalid_key", "message": str(erreur)}) from erreur
            return {k: v for k, v in cle.items() if k != "public_key"}

    @app.delete("/v1/ssh-keys/{label}", tags=["cles"])
    def remove_key(label: str) -> dict:
        with registry() as connection:
            try:
                concernes = sshkeys.forget(connection, label)
            except sshkeys.SshKeyError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            # Retirer du registre ne suffit pas : les Sparks doivent etre
            # reecrits, sinon la cle continue d'ouvrir la porte.
            for nom in concernes:
                try:
                    _apply_keys(connection, service.by_name(connection, nom))
                except (service.NotFound, IncusError):
                    continue
            return {"forgotten": label, "reconciled": concernes}

    @app.post("/v1/sparks/{name}/ssh-keys/{label}", tags=["cles"])
    def grant_key(name: str, label: str) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                sshkeys.grant(connection, spark["id"], label)
                _apply_keys(connection, spark)
            except (service.NotFound, sshkeys.SshKeyError) as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur
            return {"spark": name, "granted": label}

    @app.delete("/v1/sparks/{name}/ssh-keys/{label}", tags=["cles"])
    def revoke_key(name: str, label: str) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                sshkeys.revoke(connection, spark["id"], label)
                _apply_keys(connection, spark)
            except (service.NotFound, sshkeys.SshKeyError) as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur
            return {"spark": name, "revoked": label}

    @app.get("/v1/sparks/{name}/ssh-config", tags=["cles"])
    def ssh_config(name: str) -> dict:
        """Fragment de configuration SSH, par rebond sur l'hôte.

        Un Spark n'expose jamais 22 sur l'extérieur (docs/DAT.md §17.4).
        """
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            if not spark["ipv4_address"]:
                raise HTTPException(status_code=409, detail={
                    "error": "no_address",
                    "message": "Ce Spark n'a pas encore d'adresse."})
            return {
                "host": spark["name"],
                "hostname": spark["ipv4_address"],
                "config": (
                    f"Host {spark['name']}\n"
                    f"    HostName {spark['ipv4_address']}\n"
                    f"    User root\n"
                    f"    ProxyJump spark-host\n"
                ),
                "keys": [
                    {"label": k["label"], "fingerprint": k["fingerprint"]}
                    for k in sshkeys.desired_keys(connection, spark["id"])
                ],
            }

    @app.get("/v1/host/cores", tags=["hote"])
    def host_cores() -> dict:
        """Partage des cœurs entre pool commun et Sparks dédiés."""
        with registry() as connection:
            return core_pool.layout(connection)

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
            except AddressPoolExhausted as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "address_pool_exhausted", "message": str(erreur)}) from erreur
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
                if commande is Command.START:
                    # Le provisionnement exige une instance DEMARREE. Il installe
                    # openssh-server si besoin — environ deux minutes, mesuré —
                    # puis pose les clés voulues (docs/DAT.md §17.3).
                    try:
                        app.state.incus.exec_command(
                            apres["name"], sshkeys.PROVISION_SSHD
                        )
                        _apply_keys(connection, service.by_name(connection, name))
                    except IncusError:
                        # Le Spark tourne ; l'écart sera repris à la
                        # réconciliation plutôt que de faire échouer le démarrage.
                        pass
                    try:
                        _reconcile_ingress(connection)
                    except ingress_service.IngressError:
                        pass
                if commande is Command.RESTART:
                    service.command(connection, apres["id"], Command.START)
                    app.state.incus.set_instance_state(apres["name"], "start")
                    service.finish(connection, apres["id"], success=True)
            elif commande is Command.DELETE:
                try:
                    if apres["incus_name"]:
                        app.state.incus.delete_instance(apres["incus_name"])
                    if apres["cpu_mode"] in ("dedicated", "shared-pinned"):
                        # Les cœurs retournent au pool, et les Sparks partagés
                        # retrouvent un poids calculé sur la capacité élargie.
                        _redistribute(connection, core_pool.release(connection, apres["id"]))
                except IncusError as erreur:
                    service.finish(connection, apres["id"], success=False, error=str(erreur))
                    raise HTTPException(status_code=502, detail={
                        "error": "incus_failed", "message": str(erreur)}) from erreur
                service.finish(connection, apres["id"], success=True)
                # Le suivi de taux garde le relevé précédent : le conserver
                # ferait calculer un taux pour un Spark qui n'existe plus.
                app.state.rates.forget(apres["id"])
                # Les routes du Spark ont disparu avec lui (ON DELETE CASCADE) :
                # Caddy doit cesser de les servir.
                try:
                    _reconcile_ingress(connection)
                except ingress_service.IngressError:
                    pass
                return {"deleted": name}

            return service.by_name(connection, name)

    return app
