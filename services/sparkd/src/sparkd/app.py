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
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from . import __version__
from . import cores as core_pool
from .addressing import DHCP_RANGE, AddressPoolExhausted, usage
from .admission import HostNotConfigured, pools
from .config import Config
from . import cgroup as cgroup_service
from . import hostmem
from . import images as images_service
from .db import connect
from .incus import FakeIncus, IncusClient, IncusError, InstanceAbsente, UnixSocketIncus
from .inventory import InventoryError, sync
from . import sparks as service
from . import ingress as ingress_service
from . import ports as ports_service
from . import audit as audit_service
from . import metrics as metrics_service
from . import snapshots as snapshot_service
from . import protection as protection_service
from . import sshkeys
from .lifecycle import Command
from .migrations import applied, upgrade, verify
from .translate import Manifest, TranslationError, translate


def make_client(config: Config) -> IncusClient:
    """Choisit le pilote. Le factice sert au développement, jamais à conclure.

    Le factice reçoit un fichier d'état à côté du registre : sans lui, un Spark
    seedé « en marche » refuserait « Arrêter » après un redémarrage, la pile
    paraissant fonctionnelle jusqu'au premier geste (docs/DAT.md §28.4). Un
    registre en mémoire — ce que les tests utilisent — n'en reçoit aucun.
    """
    if config.driver == "fake":
        if config.database == ":memory:":
            return FakeIncus()
        return FakeIncus(state_path=Path(f"{config.database}.incus.json"))
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
    # SPK-37 · docs/DAT.md §21.6.2 : l'identité de l'appelant entre ICI, à la
    # frontière du service, et vaut pour toute écriture au journal produite
    # pendant la requête. Un seul endroit, comme le chemin d'écriture du §21.1 :
    # ce qui est posé à quatorze endroits est oublié au quinzième.
    @app.middleware("http")
    async def _porter_l_acteur(requete, appeler_suivant):
        # L'en-tête est DÉCLARATIF et le produit ne le présentera jamais comme
        # une preuve : qui atteint `sparkd` écrit ce qu'il veut dedans. C'est une
        # attribution ; la preuve viendra de la signature (SPK-40).
        declare = requete.headers.get("x-spark-actor")
        # Une lecture n'écrit rien : la classer serait sans effet, et la classer
        # `human` par défaut ferait porter cette classe aux recalculs qu'une
        # lecture peut déclencher. On n'ouvre le contexte que pour les méthodes
        # qui écrivent.
        if requete.method in ("GET", "HEAD", "OPTIONS"):
            return await appeler_suivant(requete)
        with audit_service.acting_as(declare, audit_service.HUMAN):
            return await appeler_suivant(requete)

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

    def _preparer_le_catalogue() -> None:
        """Pre-renseigne le catalogue, et le releve avec le pilote FACTICE.

        Le releve reel exige le reseau sortant (docs/DAT.md §33.3) ; le produit
        doit tenir sans (§28.1). Avec le pilote factice, on emploie donc un
        releve factice — comme `FakeIncus` et `FakeCaddy` —, qui publie
        exactement les references pre-renseignees. Une reference inventee y est
        `missing`, comme elle le serait sur le vrai depot.

        Avec le pilote reel, le catalogue reste `unknown` jusqu'au premier
        releve explicite : annoncer verifiee une image jamais relevee serait le
        succes simule que le produit refuse partout ailleurs.
        """
        connection = connect(config.database)
        try:
            images_service.seed_defaults(connection)
            if config.driver == "fake":
                images_service.verify(connection, fetch=images_service.fake_fetch)
        finally:
            connection.close()

    _preparer_le_catalogue()

    def _reponderer_au_demarrage() -> None:
        """Le poids de la tranche est un ETAT DE L'HOTE, pas du registre.

        Un redemarrage de l'hote repose la tranche a son poids d'unite : sans ce
        recalcul, il resterait faux jusqu'a la prochaine creation ou suppression.
        """
        connection = connect(config.database)
        try:
            _reponderer_la_tranche(connection)
        finally:
            connection.close()

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
        """Etat REEL des dependances necessaires au travail.

        Cette reponse etait figee : elle annoncait « degraded » et deux pilotes
        « non implementes » quoi qu'il arrive, ce qui datait de l'epoque ou ils ne
        l'etaient pas. Un endpoint de disponibilite qui rend toujours la meme
        chose ne distingue pas un serveur sain d'un serveur en panne — et c'est
        precisement de lui que depend la verification de deploiement
        (docs/DAT.md §31, docs/PROD_MIGRATIONS.md §5).

        Chaque dependance est donc SONDEE. Une sonde qui echoue rend la cause,
        jamais un « inconnu » muet : annoncer une disponibilite non verifiee
        serait un succes simule (CLAUDE.md §18), mais taire la cause d'une panne
        oblige a la rechercher ailleurs.
        """
        versions = app.state.schema_versions
        dependances: dict[str, str] = {
            "registry": "ready" if versions else "empty",
        }
        causes: list[str] = []

        try:
            app.state.incus.server_info()
            dependances["incus"] = "ready"
        except Exception as erreur:  # noqa: BLE001 — toute panne doit etre rendue
            dependances["incus"] = "unavailable"
            causes.append(f"incus : {erreur}")

        try:
            app.state.caddy.current()
            dependances["caddy"] = "ready"
        except Exception as erreur:  # noqa: BLE001
            dependances["caddy"] = "unavailable"
            causes.append(f"caddy : {erreur}")

        pret = all(etat == "ready" for etat in dependances.values())
        return {
            "status": "ready" if pret else "degraded",
            "driver": config.driver,
            "dependencies": dependances,
            "schema_version": versions[-1] if versions else None,
            "detail": "; ".join(causes) if causes else "Toutes les dependances repondent.",
        }

    @app.get("/v1/images", tags=["images"])
    def list_images() -> dict:
        """Catalogue complet, y compris ce qui n'est pas proposable.

        Une entree `missing` ou `unknown` reste visible : la faire disparaitre
        ferait croire qu'elle n'a jamais existe (docs/DAT.md §33.3).
        """
        with registry() as connection:
            entrees = images_service.listing(connection)
            return {
                "images": entrees,
                "selectable": [e["reference"] for e in entrees
                               if e["state"] == images_service.VERIFIED],
            }

    @app.post("/v1/images", tags=["images"], status_code=201)
    def add_image(body: dict = Body(...)) -> dict:
        """Ajoute une reference. Geste EXPLICITE, hors formulaire de creation."""
        with registry() as connection:
            try:
                return images_service.add(
                    connection, body.get("reference", ""), body.get("label", ""),
                    body.get("architecture", "amd64"),
                )
            except images_service.ImageError as erreur:
                raise HTTPException(status_code=422, detail={
                    "error": "invalid_image", "message": str(erreur)}) from erreur

    @app.post("/v1/images/verify", tags=["images"])
    def verify_images() -> dict:
        """Releve explicite et date (docs/DAT.md §33.3).

        Il n'a pas lieu a chaque ouverture d'un formulaire : cela rendrait la
        creation tributaire d'un service exterieur, alors que le produit tient
        sans reseau sortant une fois les images en cache.
        """
        with registry() as connection:
            return images_service.verify(connection)

    @app.get("/v1/forge", tags=["forge"])
    def host() -> dict[str, object]:
        """Capacité de l'hôte et état des pools.

        C'est ici que l'admission control devient observable : sans cette vue,
        rien ne permet de savoir pourquoi une création serait refusée.
        """
        with registry() as connection:
            try:
                etat = pools(connection, config.storage_metadata_margin_bytes)
            except HostNotConfigured as erreur:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "forge_not_synced",
                        "message": str(erreur),
                        "remedy": "POST /v1/forge/sync",
                    },
                ) from erreur
            row = connection.execute("SELECT * FROM forge WHERE id = 1").fetchone()
            connection_usage = connection
            adresses = usage(connection)
            # Compte DANS le bloc : le dict de reponse est construit apres la
            # fermeture de la connexion. Mesure — « Cannot operate on a closed
            # database » a la premiere requete.
            sparks_comptes = connection.execute(
                "SELECT COUNT(*) AS n FROM spark"
            ).fetchone()["n"]
        return {
            "hostname": row["hostname"],
            "cpu": {
                "cores_total": row["cpu_cores_total"],
                "threads_total": row["cpu_threads_total"],
                "cores_dedicated": etat.dedicated_cores,
            },
            "memory": {"total_bytes": row["memory_total_bytes"]},
            # docs/DAT.md §27.3 : la console doit pouvoir énoncer la soustraction
            # TERME À TERME. La somme seule ne dit pas laquelle des deux vannes
            # tourner — zfs_arc_max, ou SPARKD_MEMORY_RESERVE.
            "reserves": {
                "memory_bytes": row["memory_reserve_bytes"],
                "arc_bytes": row["memory_arc_bytes"],
                "margin_bytes": row["memory_margin_bytes"],
                "storage_bytes": row["storage_reserve_bytes"],
                # Marge de metadonnees PAR SPARK (docs/DAT.md §8.8). Elle est
                # publiee parce qu'elle grossit l'alloue du pool : invisible du
                # locataire, elle doit etre nommable par l'exploitant, sans quoi
                # l'ecart entre la somme des tailles vendues et l'alloue serait
                # inexplicable a l'ecran.
                "storage_metadata_margin_bytes": (
                    config.storage_metadata_margin_bytes
                ),
                # Ce que la marge coute REELLEMENT au pool a cet instant. Le
                # calcul se fait ici, ou le nombre de Sparks est connu : la
                # console enonce, elle ne recompose pas (§8.8.2).
                "storage_metadata_total_bytes": (
                    config.storage_metadata_margin_bytes * sparks_comptes
                ),
                # Le plafond est PERSISTÉ — il vient du relevé de topologie. La
                # consommation, elle, est lue À CHAQUE REQUÊTE : la stocker
                # présenterait une valeur périmée comme actuelle. `null` quand
                # elle n'est pas mesurable : ce n'est pas zéro (docs/DAT.md
                # §13.12, §16.2).
                "arc_used_bytes": hostmem.arc_used(),
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

    @app.post("/v1/forge/sync", tags=["forge"], status_code=200)
    def forge_sync() -> dict[str, object]:
        """Relève la topologie depuis Incus et l'écrit dans le registre."""
        try:
            with registry() as connection:
                topology = sync(
                    connection, app.state.incus, config.storage_pool,
                    operating_margin=config.memory_reserve_bytes,
                    metadata_margin=config.storage_metadata_margin_bytes,
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
            config = translate(
                manifest, cpus, capacite, dedicated_cpus=epingles,
                metadata_margin=app.state.config.storage_metadata_margin_bytes,
            )
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
        # SPK-49 · §39.4 : les ports déclarés AVANT la création s'ouvrent
        # maintenant. Sans ce geste, un port publié sur un Spark encore
        # `pending` ne s'ouvrirait jamais — il resterait au registre avec un
        # `applied_at` vide, sans que rien ne vienne jamais le combler.
        try:
            if ports_service.apply_devices(
                    connection, app.state.incus, spark["name"], spark["id"]) is not None:
                ports_service.mark_applied(connection, spark["id"])
        except ports_service.PortError:
            # L'instance existe : ne pas faire échouer sa création pour un port.
            # L'écart reste visible par `applied_at` (§39.5).
            pass

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

    def _reponderer_la_tranche(connection) -> None:
        """Recalcule le poids de la tranche parente (docs/DAT.md §32.2).

        Le poids doit valoir CE QUE LES SPARKS ONT ACHETE. Il se recalcule donc
        a chaque changement d'allocation : une constante rendrait la reservation
        absolue pour un seul taux de remplissage, et fausse partout ailleurs.

        Une tranche absente n'interrompt rien : c'est un hote non prepare, que le
        controle RUN-SLICE du preflight signale. Faire echouer la creation
        rendrait inutilisable un produit qui fonctionne — moins bien, mais qui
        fonctionne (§32.4).
        """
        try:
            etat = pools(connection, config.storage_metadata_margin_bytes)
        except HostNotConfigured:
            return
        # La delegation se reaffirme : systemd la repose a ses rechargements, et
        # une tranche sans controleurs parait correcte tout en n'appliquant rien.
        cgroup_service.ensure_delegation()
        cgroup_service.apply_weight(cgroup_service.slice_weight(
            sold=etat.cpu.allocated,
            capacity=float(etat.physical_cores or etat.cpu.capacity),
            reserve=config.cpu_reserve,
        ))

    _reponderer_au_demarrage()

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
                protection_service.ensure_writable(connection, name, "snapshot")
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
                protection_service.ensure_writable(connection, name, "snapshot")
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
                protection_service.ensure_writable(connection, name, "snapshot")
                snapshot_service.delete(connection, spark, snapshot, app.state.incus)
            except (service.NotFound, snapshot_service.SnapshotError) as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur
            return {"deleted": snapshot}

    # --- la protection (SPK-34, docs/DAT.md §35.5) --------------------------

    def _refus_protege(erreur: protection_service.SparkProtected) -> HTTPException:
        """423, et non 409. Confondre « impossible maintenant » et « verrouillé
        exprès » ferait chercher une cause qui n'existe pas (§35.5)."""
        return HTTPException(status_code=423, detail={
            "error": "spark_protected", "message": str(erreur),
            "spark": erreur.spark, "gesture": erreur.geste,
        })

    @app.exception_handler(protection_service.SparkProtected)
    def _protege(request, exc):  # noqa: ANN001 — signature imposée par Starlette
        refus = _refus_protege(exc)
        # ENVELOPPÉ dans « detail », comme toute autre erreur du produit : la
        # console lit `detail.error` partout, et une forme à part pour ce seul
        # refus l'obligerait à connaître l'exception.
        return JSONResponse(status_code=refus.status_code,
                            content={"detail": refus.detail})

    @app.get("/v1/sparks/{name}/protection", tags=["protection"])
    def read_protection(name: str) -> dict:
        """Un booléen et une date. JAMAIS l'empreinte, le sel ou les paramètres."""
        with registry() as connection:
            try:
                return protection_service.status(connection, name)
            except protection_service.ProtectionError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur

    @app.post("/v1/sparks/{name}/protection", tags=["protection"], status_code=200)
    def arm_protection(name: str, body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                return protection_service.arm(connection, name,
                                              str(body.get("password", "")))
            except protection_service.BadProtectionPassword as erreur:
                raise HTTPException(status_code=403, detail={
                    "error": "bad_protection_password",
                    "message": str(erreur)}) from erreur
            except protection_service.ProtectionError as erreur:
                # « Aucun Spark nommé » et « déjà protégé » ne sont pas le même
                # refus : le premier est un 404, le second un 409.
                introuvable = "Aucun Spark" in str(erreur)
                raise HTTPException(
                    status_code=404 if introuvable else 409,
                    detail={"error": "not_found" if introuvable else "already_protected",
                            "message": str(erreur)}) from erreur

    @app.delete("/v1/sparks/{name}/protection", tags=["protection"])
    def lift_protection(name: str, body: dict = Body(default={})) -> dict:
        """Lever DÉSARME durablement (§35.4). Il n'y a pas de fenêtre de temps."""
        with registry() as connection:
            try:
                return protection_service.disarm(connection, name,
                                                 str((body or {}).get("password", "")))
            except protection_service.BadProtectionPassword as erreur:
                raise HTTPException(status_code=403, detail={
                    "error": "bad_protection_password",
                    "message": str(erreur)}) from erreur
            except protection_service.ProtectionError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur

    @app.get("/v1/audit/verify", tags=["audit"])
    def verify_audit_chain() -> dict:
        """État de la chaîne d'intégrité (SPK-38, docs/DAT.md §36.9.5).

        C'est une LECTURE, mais elle est journalisée : le §36.7 en fait l'une des
        deux seules exceptions, avec l'ouverture d'un tunnel, parce qu'elle dit
        qui est venu vérifier et quand.

        Elle ne voit pas la troncature — une chaîne coupée à la fin reste valide.
        Seule l'ancre tenue par la console la détecte (§36.9.6), et la réponse
        porte donc `length` pour que la console puisse la comparer à ce qu'elle
        avait retenu.
        """
        with registry() as connection:
            etat = audit_service.verify_chain(connection)
            # La trace est écrite APRÈS la vérification, sinon elle ferait
            # partie de ce qu'elle vérifie et la tête publiée serait périmée.
            audit_service.record(
                connection, None, "audit.verify",
                "ok" if etat["intact"] else "denied",
                (f"Chaîne vérifiée : {etat['checked']} entrée(s), intacte."
                 if etat["intact"] else
                 f"Chaîne rompue à l'entrée {etat['break']['id']} "
                 f"({etat['break']['reason']})."),
                target_type="audit_log",
                payload={"checked": etat["checked"], "intact": etat["intact"]},
            )
            return etat

    @app.get("/v1/audit", tags=["audit"])
    def audit_trail(limit: int = 100, result: str | None = None,
                    action: str | None = None, actor: str | None = None,
                    actor_class: str | None = None,
                    since: str | None = None) -> dict:
        """Journal d'audit. Les valeurs sensibles y sont déjà caviardées.

        Un filtre inconnu est REFUSÉ, jamais ignoré (docs/DAT.md §36.8.2) : un
        filtre ignoré rend une liste plus large que demandée, que l'exploitant
        lira comme un résultat filtré. C'est la pire des deux erreurs.
        """
        with registry() as connection:
            try:
                return {"entries": audit_service.listing(
                    connection, limit=limit, result=result, action=action,
                    actor=actor, actor_class=actor_class, since=since,
                )}
            except ValueError as erreur:
                raise HTTPException(status_code=422, detail={
                    "error": "bad_filter", "message": str(erreur)}) from erreur

    @app.get("/v1/ingress", tags=["ingress"])
    def list_routes() -> dict:
        with registry() as connection:
            return {"routes": ingress_service.listing(connection)}

    @app.post("/v1/ingress", tags=["ingress"], status_code=201)
    def add_route(body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, body.get("spark", ""))
                protection_service.ensure_writable(connection, spark["name"], "ingress")
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
            relue = ingress_service.by_domain(connection, route["domain"])
            # SPK-48 · §18.3 bis : la relecture par domaine ne porte pas le
            # relevé du joker pris. On le rattache, sinon l'écran ne pourrait
            # pas NOMMER le Spark dont cette route prend le pas.
            if route.get("supersedes"):
                relue["supersedes"] = route["supersedes"]
            return relue

    @app.delete("/v1/ingress/{domain}", tags=["ingress"])
    def remove_route(domain: str) -> dict:
        with registry() as connection:
            try:
                # §35.2 : « en ajout COMME EN RETRAIT ». Le Spark visé se lit sur
                # la route, pas sur l'URL — c'est le domaine qui la désigne.
                vise = ingress_service.by_domain(connection, domain)
                cible = connection.execute(
                    "SELECT name FROM spark WHERE id = ?", (vise["spark_id"],)
                ).fetchone()
                if cible is not None:
                    protection_service.ensure_writable(connection, cible["name"], "ingress")
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

    # --- Ports publiés (SPK-49 · docs/DAT.md §39) ---------------------------

    @app.get("/v1/ports", tags=["ports"])
    def list_ports() -> dict:
        """Les ports publiés de la FORGE. C'est une liste de la machine, pas
        d'un Spark : un port public est une ressource unique sur la machine."""
        with registry() as connection:
            # Une LISTE, pas un dictionnaire indexé par le port : les clés JSON
            # sont des chaînes, et la forme rendue dépendrait alors du codage.
            return {
                "ports": ports_service.listing(connection),
                "reserved": [
                    {"port": port, "reason": raison}
                    for port, raison in sorted(
                        ports_service.reserved(app.state.config.reserved_ports).items())
                ],
            }

    @app.post("/v1/ports", tags=["ports"], status_code=201)
    def publish_port(body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, body.get("spark", ""))
                # §35 : la protection s'applique AVANT tout le reste.
                protection_service.ensure_writable(connection, spark["name"], "port")
                port = ports_service.publish(
                    connection, app.state.incus, spark,
                    int(body.get("public_port", 0)), int(body.get("target_port", 0)),
                    str(body.get("protocol", "tcp")), str(body.get("note", "")),
                    extra_reserved=app.state.config.reserved_ports,
                )
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except (ports_service.PortError, ValueError, TypeError) as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "port_refused", "message": str(erreur)}) from erreur
            try:
                pose = ports_service.apply_devices(
                    connection, app.state.incus, spark["name"], spark["id"])
                # `applied_at` n'est renseigné QUE si le pilote a réellement été
                # appelé : un Spark sans instance n'a rien à appliquer, et dater
                # l'application ferait croire à une publication effective.
                if pose is not None:
                    ports_service.mark_applied(connection, spark["id"])
            except ports_service.PortError as erreur:
                # La ligne est enregistrée ; l'écart reste visible par
                # `applied_at` plutôt que masqué par un succès simulé (§39.5).
                raise HTTPException(status_code=502, detail={
                    "error": "driver_unavailable",
                    "message": str(erreur),
                    "port": port["public_port"],
                    "note": "Port enregistré mais non appliqué.",
                }) from erreur
            return ports_service.by_public_port(connection, port["public_port"])

    @app.delete("/v1/ports/{public_port}", tags=["ports"])
    def withdraw_port(public_port: int) -> dict:
        with registry() as connection:
            try:
                vise = ports_service.by_public_port(connection, public_port)
                protection_service.ensure_writable(
                    connection, vise["spark_name"], "port")
                ports_service.withdraw(connection, public_port)
            except ports_service.PortError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            try:
                # On REFERME : la carte des devices est reconstruite sans celui
                # qu'on vient de retirer (§39.2, §39.4).
                ports_service.apply_devices(
                    connection, app.state.incus, vise["spark_name"], vise["spark_id"])
            except ports_service.PortError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "driver_unavailable", "message": str(erreur),
                    "note": "Port retiré du registre mais pas encore refermé.",
                }) from erreur
            return {"withdrawn": public_port}

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
    def remove_key(label: str, body: dict = Body(default={})) -> dict:
        """Révoquer n'est JAMAIS refusé par la protection (docs/DAT.md §35.2).

        Le jour où l'on retire l'accès d'une personne partie ou d'une clé qui a
        fui, un refus ne protégerait rien : il laisserait l'accès en place parce
        qu'un interrupteur a été oublié ailleurs. Ce serait transformer un
        garde-fou en vulnérabilité.

        Ce qui reste est le devoir d'INFORMER : le premier appel nomme les Sparks
        protégés touchés, le second porte `accept_protected` et aboutit. Aucun mot
        de passe n'est demandé, et aucune protection n'est levée. S'il n'y a aucun
        Spark protégé, il n'y a pas de refus du tout.
        """
        with registry() as connection:
            try:
                proteges = sshkeys.affected_sparks(connection, label, protected_only=True)
            except sshkeys.SshKeyError as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            if proteges and not bool((body or {}).get("accept_protected")):
                raise HTTPException(status_code=409, detail={
                    "error": "protected_sparks_affected",
                    "message": (
                        f"Révoquer « {label} » retire son accès à "
                        f"{len(proteges)} Spark(s) protégé(s) : "
                        f"{', '.join(proteges)}. Aucune protection ne sera levée."
                    ),
                    "protected_sparks": proteges,
                    "override": "Renvoyer avec {\"accept_protected\": true}.",
                })
            try:
                concernes = sshkeys.forget(connection, label,
                                           protected_affected=proteges)
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
                # §35.2 : OCTROYER se refuse. Revoquer, non — voir plus bas.
                protection_service.ensure_writable(connection, name, "ssh-key-grant")
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
    def revoke_key(name: str, label: str, body: dict = Body(default={})) -> dict:
        """Même mécanique que la révocation au registre (§35.5) : retirer un
        accès passe toujours, mais dit d'abord ce qu'il traverse."""
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            if (protection_service.is_protected(connection, name)
                    and not bool((body or {}).get("accept_protected"))):
                raise HTTPException(status_code=409, detail={
                    "error": "protected_sparks_affected",
                    "message": (
                        f"« {name} » est protégé. Révoquer « {label} » y retire "
                        "un accès ; aucune protection ne sera levée."
                    ),
                    "protected_sparks": [name],
                    "override": "Renvoyer avec {\"accept_protected\": true}.",
                })
            try:
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

    @app.get("/v1/forge/cores", tags=["forge"])
    def forge_cores() -> dict:
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
                spark = service.create(
                    connection, service.SparkSpec(**spec),
                    metadata_margin=config.storage_metadata_margin_bytes,
                )
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
            except images_service.ImageError as erreur:
                # docs/DAT.md §33.2 : refus rendu AVANT l'ecriture de la ligne,
                # comme un refus d'admission ordinaire.
                raise HTTPException(status_code=409, detail={
                    "error": "image_refused", "message": str(erreur)}) from erreur
            except service.SparkError as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "refused", "message": str(erreur)}) from erreur
            # L'allocation a change : le poids de la tranche doit suivre (§32.2).
            _reponderer_la_tranche(connection)
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
                # §35.2 : les commandes de cycle de vie visent CE Spark.
                protection_service.ensure_writable(connection, name, "command")
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
                # SPK-52 · §14.5 : une instance déjà absente vaut suppression
                # RÉUSSIE. Sans cela, un Spark dont l'instance a disparu hors du
                # produit restait indéfiniment au registre, pesait dans
                # l'admission, et le seul recours était d'ouvrir la base à la
                # main — ce que la console existe précisément pour éviter.
                instance_absente = False
                try:
                    if apres["incus_name"]:
                        try:
                            app.state.incus.delete_instance(apres["incus_name"])
                        except InstanceAbsente:
                            # ABSENCE RAPPORTÉE, et elle seule. Un pilote
                            # injoignable lève `IncusError` et reste une panne :
                            # ne pas pouvoir demander n'est pas savoir que ce
                            # n'est pas là (§33.3).
                            instance_absente = True
                    if apres["cpu_mode"] in ("dedicated", "shared-pinned"):
                        # Les cœurs retournent au pool, et les Sparks partagés
                        # retrouvent un poids calculé sur la capacité élargie.
                        _redistribute(connection, core_pool.release(connection, apres["id"]))
                except IncusError as erreur:
                    service.finish(connection, apres["id"], success=False, error=str(erreur))
                    raise HTTPException(status_code=502, detail={
                        "error": "incus_failed", "message": str(erreur)}) from erreur
                if instance_absente:
                    # L'écart n'est PAS caché : un `delete` ordinaire et un
                    # `delete` sur une instance disparue ne se lisent pas pareil
                    # au journal (§14.5).
                    audit_service.record(
                        connection, None, "spark.delete", "ok",
                        f"Spark « {name} » retiré du registre alors que le pilote "
                        "rapportait son instance ABSENTE. La ligne pesait dans "
                        "l'admission sans que rien ne lui corresponde.",
                        target_type="spark", target_id=apres["id"],
                        payload={"instance_absente": True,
                                 "incus_name": apres["incus_name"]},
                    )
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
                # La ressource est rendue : la tranche doit peser moins (§32.2).
                _reponderer_la_tranche(connection)
                return {"deleted": name}

            return service.by_name(connection, name)

    return app
