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

import base64
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
from . import build
from .inventory import InventoryError, sync
from . import sparks as service
from . import ingress as ingress_service
from . import ports as ports_service
from . import signature as signature_service
from . import notification as notification_service
from . import audit as audit_service
from . import bootstrap as bootstrap_service
from . import briefing as briefing_service
from . import metrics as metrics_service
from . import snapshots as snapshot_service
from . import protection as protection_service
from . import environnement as env_service
from . import sshkeys
from .lifecycle import Command
from .migrations import applied, upgrade, verify
from .translate import Manifest, TranslationError, translate


def _nom_de_la_forge(config: Config) -> str:
    """Le nom d'hôte relevé, pour les messages hors bande (SPK-62, §47.4).

    Une Forge jamais relevée n'en a pas : on rend une chaîne vide plutôt que de
    faire échouer le démarrage. Le canal est un confort, pas une condition de
    service (§47.5).
    """
    try:
        connection = connect(config.database)
    except Exception:  # noqa: BLE001 - le démarrage ne tombe pas pour un nom
        return ""
    try:
        ligne = connection.execute(
            "SELECT hostname FROM forge WHERE id = 1").fetchone()
        return (ligne["hostname"] if ligne and ligne["hostname"] else "")
    except Exception:  # noqa: BLE001 - idem
        return ""
    finally:
        connection.close()


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

        # SPK-40 · §36.10 : la signature entre au MÊME endroit que l'acteur, et
        # pour la même raison — ce qui est posé à quatorze endroits est oublié au
        # quinzième.
        #
        # Une requête NON signée passe : refuser ferait de ce mécanisme un
        # contrôle d'accès, ce que le §45.4 dit qu'il n'est pas. Une signature
        # PRÉSENTE et invalide est refusée, parce que l'inscrire ferait mentir le
        # journal (§36.10.4).
        if not signature_service.entete_present(requete.headers):
            with audit_service.acting_as(declare, audit_service.HUMAN):
                return await appeler_suivant(requete)

        acteur = audit_service.normalize_actor(declare)
        try:
            signature, octets = signature_service.lire_entetes(requete.headers)
            if not signature_service.decrit_bien(
                    octets, method=requete.method,
                    path=requete.url.path, actor=acteur):
                raise signature_service.SignatureError(
                    "Les octets signés ne décrivent pas cette requête : la "
                    "signature porterait sur autre chose.", "octets_etrangers")
            signature_service.verifier(
                octets, signature, acteur, config.allowed_signers)
        except signature_service.SignatureError as refus:
            return JSONResponse(status_code=422, content={"detail": {
                "error": refus.motif, "message": str(refus)}})

        with audit_service.acting_as(declare, audit_service.HUMAN), \
                audit_service.signed_with(
                    signature,
                    base64.b64encode(octets).decode("ascii"),
                    signature_service.VERSION):
            return await appeler_suivant(requete)

    app.state.config = config
    app.state.schema_versions = check_registry(config)
    app.state.incus = make_client(config)
    app.state.rates = metrics_service.RateTracker()
    # SPK-62 · docs/DAT.md §47.1 : le canal hors bande est posé sur `audit`, qui
    # est le SEUL chemin vers le journal. S'accrocher à la console laisserait
    # sortir sans un mot les gestes faits en la contournant.
    #
    # Le nom de la Forge sert quand plusieurs écrivent dans le même canal :
    # « un Spark a été supprimé » sans dire OÙ est une alerte inexploitable
    # (§47.4). Il est lu au démarrage ; une Forge jamais relevée n'en a pas, et
    # une chaîne vide vaut mieux qu'un plantage au démarrage.
    app.state.notify = notification_service.Canal(
        url=config.notify_url, forge=_nom_de_la_forge(config))
    audit_service.set_canal(app.state.notify)
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
    def healthz() -> dict[str, object]:
        """Le processus repond. Ne dit rien de ses dependances.

        Il dit en revanche QUELLE build il execute (docs/DAT.md §40) : c'est la
        premiere chose que la console lit en se connectant, et la seule qui
        permette de distinguer une Forge a jour d'une Forge oubliee.
        """
        empreinte = build.identity()
        return {"status": "ok", "version": empreinte["version"], "build": empreinte}

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
        """Capacité de la Forge et état des pools.

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
            # docs/DAT.md §40.3 : l'ecran de la Forge doit pouvoir dire si la
            # pile est a jour SANS second appel.
            "build": build.identity(),
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
            # SPK-62 · docs/DAT.md §47.6 : l'échec du canal hors bande est DIT.
            # `configured: false` ne veut PAS dire « tout va bien » : les
            # compteurs valent alors zéro parce que rien n'est surveillé, et
            # l'écran doit le dire autrement (§14.6).
            "notify": app.state.notify.etat(),
            # docs/DAT.md §7.3 bis, §32.2 : la reservation est un PLANCHER
            # depuis l'arbitrage du 2026-08-21. Ni « garantie absolue », ni
            # « non garantie » — les deux seraient faux.
            # docs/DAT.md §32.2 : arbitrage du 2026-08-21. La reservation est un
            # PLANCHER — tenu sous contention totale, depasse des qu'une tranche
            # de la Forge est au repos. Mesure du 2026-08-21 : 47,9 % obtenus
            # pour 47,4 % predits. La valeur est LUE par l'ecran (§27.6).
            "reservation_guarantee": "floor_under_contention",
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

    def _refus_cellule_perdue(spark: dict, *, en_panne: bool = False) -> HTTPException:
        """Le refus qui NOMME la perte d'une cellule (docs/DAT.md §12.1.4).

        @spec docs/BACKLOG.md#SPK-67 · docs/DAT.md §12.1.4 (ce que le contrat
              exige des appelants), §14.6 · docs/CONTINGENCE.md §4.5

        Une seule réponse pour tout le produit, et c'est délibéré : `409`,
        `cellule_absente`, le nom du Spark et les deux issues. Un exploitant n'a
        pas à apprendre une réponse différente par écran pour un seul et même
        incident.

        `en_panne` distingue la seule route qui fait davantage : celle du cycle
        de vie, qui a posé un état transitoire AVANT d'appeler le pilote et doit
        donc le refermer. Les autres ne touchent à aucun état — elles refusent
        et n'écrivent rien —, et leur message ne doit donc pas annoncer un
        changement qui n'a pas eu lieu (DESIGN_SYSTEM.md §1.3).

        Le message nomme les gestes comme la CONSOLE les nomme — « Reprendre »,
        « Supprimer » — et non comme l'API les appelle : vu à l'écran le
        2026-08-21, un message qui dit « retry » envoie chercher un bouton qui
        n'existe pas sous ce nom (§1.5 bis). Les noms d'API restent lisibles
        dans `allowed_commands`.

        Il ne reprend jamais la phrase du pilote : elle porte un chemin de l'API
        d'Incus, que le §20 de `CLAUDE.md` interdit d'exposer et qui ne
        diagnostique rien de plus que le nom déjà présent. Elle reste attachée à
        l'exception chaînée, donc au journal du service.
        """
        # Le message ne nomme un BOUTON que là où ce bouton est certain d'être
        # affiché. Vu à l'écran le 2026-08-21 : sur un Spark « arrêté », l'écran
        # offre « Démarrer » et « Supprimer » — pas « Reprendre », qui n'apparaît
        # qu'en panne. Un refus qui envoie chercher « Reprendre » fait donc
        # chercher un bouton absent, exactement la faute que ce même message
        # avait commise dans l'autre sens la veille (§1.5 bis).
        #
        # Le cycle de vie, lui, VIENT de mettre le Spark en panne : les deux
        # boutons y sont garantis, et les nommer est ce qui aide le plus.
        if en_panne:
            suite = ("Le Spark passe en panne. Deux issues, toutes deux par le "
                     "produit : « Reprendre » reconstruit la cellule, "
                     "« Supprimer » rend sa place au pool.")
        else:
            suite = ("Ce geste est impossible tant qu'elle n'est pas là. Depuis "
                     "l'écran du Spark, la cellule peut être reconstruite, ou "
                     "le Spark supprimé pour rendre sa place au pool.")
        raison = (
            f"La cellule du Spark « {spark['name']} » a disparu : Incus ne la "
            f"connaît plus. {suite}")
        return HTTPException(status_code=409, detail={
            "error": "cellule_absente", "message": raison})

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
        # SPK-58 · §43.7 : l'environnement est posé DÈS la création, de sorte
        # qu'un `env_file:` du locataire ne casse pas sa pile au premier
        # démarrage en désignant un fichier qui n'existe pas encore.
        try:
            _apply_env(connection, service.get(connection, spark["id"]))
        except (IncusError, InstanceAbsente, env_service.CleError):
            # L'instance existe : ne pas faire échouer sa création. L'écart sera
            # repris au prochain démarrage, qui repose les fichiers (§43.5.2).
            pass
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

    def _apply_env(connection, spark: dict) -> None:
        """Pose les fichiers d'environnement dans le Spark (SPK-58, §43.2).

        Régénérés EN ENTIER depuis l'état voulu, jamais complétés : c'est ce qui
        fait qu'un retrait retire réellement. Même mécanisme et même motif
        qu'`authorized_keys` — deux mécanismes qui écrivent le même état
        finissent par diverger (§17.1).

        Le fichier des secrets vit dans un **tmpfs** (§43.5.2), il est donc
        reposé à chaque démarrage : c'est ce qui empêche une restauration
        d'instantané de ressusciter un secret révoqué.
        """
        if not spark.get("incus_name"):
            return
        cle = env_service.charger_cle(config.secret_key_file)
        for chemin, contenu in env_service.fichiers(
                connection, cle, spark["id"]).items():
            app.state.incus.push_file(
                spark["incus_name"], chemin, contenu, mode="0600")
        # SPK-60 · §44.4 : une variable posee change le briefing lui-meme
        # (ses NOMS, jamais ses valeurs). Le faire dans le meme chemin evite
        # qu'une nouvelle route d'environnement oublie la seconde projection.
        _apply_briefing(connection, spark)

    def _apply_briefing(connection, spark: dict) -> None:
        """Projette le briefing unique dans une cellule déjà amorcée.

        @spec docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.1 (le panneau), §44.4
              (réécriture), §44.8 (modèle unique) · docs/SCHEMA.md §10 quinquies

        Une cellule sans relevé d'amorçage n'a pas encore de briefing à
        prétendre : elle peut ne pas avoir sshd et Docker. Dès que l'observation
        existe, tout le contenu est régénéré depuis le registre.
        """
        if not spark.get("incus_name"):
            return
        releve = briefing_service.observation(connection, spark["id"])
        if releve is None:
            return
        model = briefing_service.modele(
            spark,
            forge_public_address=config.forge_public_address,
            routes=ingress_service.listing(connection),
            ports=ports_service.listing(connection),
            environment=env_service.lister(connection, spark["id"]),
            bootstrap=releve,
        )
        for chemin, (contenu, mode) in briefing_service.fichiers(model).items():
            app.state.incus.push_file(spark["incus_name"], chemin, contenu, mode=mode)

    def _rattraper_briefing(connection, spark: dict) -> None:
        """Rafraîchit sans annuler un registre déjà écrit (§44.8)."""
        try:
            _apply_briefing(connection, spark)
        except (IncusError, InstanceAbsente, env_service.CleError):
            # Une projection en retard est reprise au démarrage. Annuler une
            # route ou une protection déjà écrite créerait deux vérités.
            pass

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
        except InstanceAbsente as erreur:
            raise _refus_cellule_perdue(spark) from erreur
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
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
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
                rendu = snapshot_service.restore(
                    connection, spark, snapshot, app.state.incus,
                    accept_losing_newer=bool((body or {}).get("accept_losing_newer")),
                )
                # SPK-58 · §43.2 : une restauration ramène l'ANCIEN fichier
                # d'environnement dans la cellule. L'état voulu reprend donc la
                # main derrière, comme pour les clés — sans quoi le registre et
                # la cellule diraient deux choses différentes, et c'est la
                # cellule qui gagnerait.
                try:
                    _apply_env(connection, service.by_name(connection, name))
                except (IncusError, InstanceAbsente, env_service.CleError):
                    pass
                return rendu
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
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
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
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
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
                rendu = protection_service.arm(connection, name,
                                                   str(body.get("password", "")))
                _rattraper_briefing(connection, service.by_name(connection, name))
                return rendu
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
                rendu = protection_service.disarm(
                    connection, name, str((body or {}).get("password", "")))
                _rattraper_briefing(connection, service.by_name(connection, name))
                return rendu
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

    #: SPK-43 · §37.4.6 : les seules actions qu'un appelant EXTÉRIEUR peut
    #: inscrire. Ce sont celles que la console est seule à pouvoir constater —
    #: la session de terminal ne passe pas par `sparkd`. Toute autre action
    #: serait un appelant se faisant passer pour le runtime.
    #: `spark.rescue_exec` est DISTINCTE de `spark.terminal_open`, et c'est le
    #: point du §37.3 : le dépannage passe par `incus exec`, donc par le plan de
    #: contrôle en root chez le locataire. Confondre les deux dans une même
    #: action rendrait impossible ce que le §37.3 demande — relever combien de
    #: fois cette voie a servi. La fermeture reste commune : ce qui doit se
    #: compter, c'est l'emprunt du chemin, pas sa sortie.
    #: SPK-45 · §37.7.4 : les quatre gestes de cycle de vie. QUATRE actions et
    #: non une seule, pour la raison exacte qui a séparé `spark.rescue_exec` de
    #: `spark.terminal_open` — ce qui doit se compter, c'est le GESTE.
    #: « Combien de conteneurs a-t-on tués ce mois-ci » doit se répondre par un
    #: filtre sur l'action, pas par la lecture des charges.
    ACTIONS_DECLARABLES = ("spark.terminal_open", "spark.terminal_close",
                           "spark.rescue_exec",
                           "spark.container_start", "spark.container_stop",
                           "spark.container_restart", "spark.container_kill",
                           #: SPK-45 · §37.4.7 : entrer dans la cellule d'un
                           #: locataire et entrer dans un de ses conteneurs ne
                           #: sont pas le même pouvoir. « Combien de fois est-on
                           #: entré dans un conteneur » doit se répondre par un
                           #: filtre, pas en lisant les charges.
                           "spark.container_terminal_open",
                           "spark.container_terminal_close",
                           #: SPK-69 · §40.6 : l'hôte console est seul à voir
                           #: le paquet changer pendant que sparkd s'arrête.
                           #: Ces deux traces nomment ce pouvoir de Forge sans
                           #: ouvrir une action arbitraire au navigateur.
                           "forge.sparkd_update", "forge.sparkd_rollback")

    #: Clés admises dans la charge. Un champ libre deviendrait le dépôt de
    #: secrets en clair que le §37.5 interdit précisément.
    #: `container` (§37.7.4) : la cible reste le SPARK — c'est lui qui est
    #: protégé, facturé et retrouvé —, et le nom du conteneur entre ici.
    CLES_DECLARABLES = ("path", "reason", "duration_seconds", "container",
                        "previous_commit", "target_commit")

    #: SPK-45 · §37.7.4 : un geste REFUSÉ se journalise comme refusé. Ne
    #: journaliser que les succès laisserait invisible une tentative répétée sur
    #: un Spark protégé — exactement ce qu'un journal existe pour montrer.
    #: Deux valeurs, pas un champ libre : le résultat est une information de
    #: journal, pas un message.
    RESULTATS_DECLARABLES = ("ok", "denied")

    @app.post("/v1/audit", tags=["audit"], status_code=201)
    def declare_audit(body: dict = Body(...)) -> dict:
        """Inscrit au journal un geste que `sparkd` ne peut pas constater.

        Porte ÉTROITE (docs/DAT.md §37.4.6) : liste blanche d'actions, acteur
        pris de l'en-tête et non du corps, charge bornée à des clés connues.
        """
        action = str(body.get("action", ""))
        if action not in ACTIONS_DECLARABLES:
            raise HTTPException(status_code=422, detail={
                "error": "action_refused",
                "message": f"L'action « {action} » ne peut pas être déclarée de "
                           f"l'extérieur. Admises : {', '.join(ACTIONS_DECLARABLES)}."})
        brut = body.get("payload") or {}
        if not isinstance(brut, dict):
            raise HTTPException(status_code=422, detail={
                "error": "payload_refused", "message": "La charge doit être un objet."})
        resultat = str(body.get("result", "ok"))
        if resultat not in RESULTATS_DECLARABLES:
            raise HTTPException(status_code=422, detail={
                "error": "result_refused",
                "message": f"Le résultat « {resultat} » n'est pas déclarable. "
                           f"Admis : {', '.join(RESULTATS_DECLARABLES)}."})
        inconnues = sorted(set(brut) - set(CLES_DECLARABLES))
        if inconnues:
            raise HTTPException(status_code=422, detail={
                "error": "payload_refused",
                "message": f"Clés refusées : {', '.join(inconnues)}. "
                           f"Admises : {', '.join(CLES_DECLARABLES)}."})
        with registry() as connection:
            # L'acteur vient du CONTEXTE — l'en-tête posé par l'hôte console
            # (§21.6.2) —, jamais du corps. Laisser une requête choisir son
            # identité au journal la rendrait triviale à falsifier.
            entree = audit_service.record(
                connection, None, action, resultat,
                str(body.get("message", ""))[:500],
                target_type=str(body.get("target_type", "spark")),
                target_id=str(body.get("target_id", "")) or None,
                payload={k: brut[k] for k in CLES_DECLARABLES if k in brut},
            )
        return {"recorded": action, "entry": entree}

    @app.get("/v1/audit", tags=["audit"])
    def audit_trail(limit: int = 100, result: str | None = None,
                    action: str | None = None, actor: str | None = None,
                    actor_class: str | None = None,
                    since: str | None = None,
                    with_signature: bool = False) -> dict:
        """Journal d'audit. Les valeurs sensibles y sont déjà caviardées.

        Un filtre inconnu est REFUSÉ, jamais ignoré (docs/DAT.md §36.8.2) : un
        filtre ignoré rend une liste plus large que demandée, que l'exploitant
        lira comme un résultat filtré. C'est la pire des deux erreurs.

        SPK-40 · §36.10.7 : chaque entrée dit si elle est signée ; la signature
        elle-même ne vient qu'avec `with_signature`, parce qu'elle ne sert qu'à
        qui vérifie et pèse quelques centaines d'octets par ligne.
        """
        with registry() as connection:
            try:
                return {"entries": audit_service.listing(
                    connection, limit=limit, result=result, action=action,
                    actor=actor, actor_class=actor_class, since=since,
                    avec_signature=with_signature,
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
                _rattraper_briefing(connection, service.by_name(connection, spark["name"]))
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
                if cible is not None:
                    _rattraper_briefing(connection, service.by_name(connection, cible["name"]))
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
                _rattraper_briefing(connection, service.by_name(connection, spark["name"]))
                raise HTTPException(status_code=502, detail={
                    "error": "driver_unavailable",
                    "message": str(erreur),
                    "port": port["public_port"],
                    "note": "Port enregistré mais non appliqué.",
                }) from erreur
            _rattraper_briefing(connection, service.by_name(connection, spark["name"]))
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
                _rattraper_briefing(
                    connection, service.by_name(connection, vise["spark_name"]))
                raise HTTPException(status_code=502, detail={
                    "error": "driver_unavailable", "message": str(erreur),
                    "note": "Port retiré du registre mais pas encore refermé.",
                }) from erreur
            _rattraper_briefing(
                connection, service.by_name(connection, vise["spark_name"]))
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

    # --- SPK-58 · l'environnement (docs/DAT.md §43.9.5) --------------------

    def _rendu_env(entree) -> dict:
        """Ce que l'API rend d'une entrée. La valeur d'un SECRET n'y est jamais.

        Il n'existe aucune route qui révèle un secret : on le remplace, ou on le
        retire (§43.3). Une route de révélation, même protégée, finirait par être
        appelée par un outil branché sur l'API.
        """
        return {
            "name": entree.name, "is_secret": entree.is_secret,
            "value": entree.value, "fingerprint": entree.fingerprint,
            "scope": entree.scope, "origin": entree.origin,
            "updated_at": entree.updated_at,
            # SPK-64 : sur une entree du CATALOGUE, combien de Sparks l'ont
            # cochee. `0` dit qu'elle ne descend nulle part — sans ce compte, une
            # entree definie ressemble a une entree active, et l'on croit avoir
            # pose une valeur qu'aucune cellule ne recoit.
            "selected_by": entree.selected_by,
        }

    def _cle_de_forge():
        try:
            return env_service.charger_cle(config.secret_key_file)
        except env_service.CleError as erreur:
            raise HTTPException(status_code=503, detail={
                "error": "secret_key_unavailable", "message": str(erreur)}) from erreur

    def _sparks_cibles_du_catalogue(connection, nom: str) -> list[dict]:
        """Les Sparks qui ont choisi cette entrée précise du catalogue.

        Depuis SPK-64, une entrée de Forge n'atteint pas tous les Sparks : elle
        ne change que ceux dont la sélection référence cette entrée. Réemployer
        ici la liste entière des Sparks protégés ferait demander une confirmation
        pour une cellule que le geste ne touche pas.
        """
        return [dict(r) for r in connection.execute(
            "SELECT spark.id, spark.name, spark.incus_name, spark.protected_at"
            " FROM spark"
            " JOIN env_selection selection ON selection.spark_id = spark.id"
            " JOIN env_entry entry ON entry.id = selection.entry_id"
            " WHERE entry.scope = 'forge' AND entry.name = ?"
            " ORDER BY spark.name", (nom,))]

    def _garde_de_forge(connection, body: dict, geste: str,
                         cibles: list[dict]) -> None:
        """Informer, puis accepter — la convention du produit (§43.9.5 bis).

        Un refus ferme gèlerait toute la Forge dès qu'un seul Spark est protégé,
        et l'exploitant lèverait alors la protection pour contourner : cela
        protégerait moins, pas plus. Le refus par défaut sert à ce qu'on ne
        touche pas un Spark gelé SANS LE SAVOIR.
        """
        proteges = [spark["name"] for spark in cibles if spark["protected_at"] is not None]
        if proteges and not bool((body or {}).get("accept_protected")):
            raise HTTPException(status_code=409, detail={
                "error": "protected_sparks_affected",
                "message": (
                    f"{geste} au niveau de la Forge touche "
                    f"{len(proteges)} Spark(s) protégé(s) : {', '.join(proteges)}. "
                    "Aucune protection ne sera levée."
                ),
                "protected_sparks": proteges,
                "override": "Renvoyer avec {\"accept_protected\": true}.",
            })

    def _reposer_cibles_du_catalogue(connection, cibles: list[dict]) -> None:
        """Repose l'entrée modifiée chez les seuls Sparks qui l'avaient choisie.

        Un Spark injoignable n'interrompt pas les autres : l'écart sera repris à
        son prochain démarrage (§43.5.2). Les cibles sont relevées AVANT une
        suppression du catalogue, dont la cascade retire ensuite les sélections.
        """
        for spark in cibles:
            if not spark["incus_name"]:
                continue
            try:
                _apply_env(connection, service.get(connection, spark["id"]))
            except (IncusError, InstanceAbsente, env_service.CleError, service.NotFound):
                continue

    @app.get("/v1/env", tags=["environnement"])
    def list_forge_env() -> dict:
        """Le catalogue de la Forge, sélectionné Spark par Spark (§43.6)."""
        with registry() as connection:
            return {"env": [_rendu_env(e) for e in env_service.lister(connection)]}

    @app.put("/v1/env/{name}", tags=["environnement"])
    def set_forge_env(name: str, body: dict = Body(...)) -> dict:
        """Pose ou remplace une entrée de la Forge.

        `PUT` et non `POST`, le nom dans le CHEMIN : le geste est idempotent —
        « cette variable vaut ceci » — et rejouer la requête doit donner le même
        état, pas une seconde entrée (§43.9.5).
        """
        with registry() as connection:
            cibles = _sparks_cibles_du_catalogue(connection, name)
            _garde_de_forge(connection, body, f"Poser « {name} »", cibles)
            try:
                entree = env_service.poser(
                    connection, _cle_de_forge(), "forge", None, name,
                    str((body or {}).get("value", "")),
                    secret=bool((body or {}).get("secret")))
            except env_service.EnvError as erreur:
                raise HTTPException(status_code=422, detail={
                    "error": "invalid_name", "message": str(erreur)}) from erreur
            # §43.2 : le registre écrit, la cellule suit. Sans cela, les deux
            # diraient deux choses différentes jusqu'au prochain démarrage.
            _reposer_cibles_du_catalogue(connection, cibles)
            return _rendu_env(entree)

    @app.delete("/v1/env/{name}", tags=["environnement"])
    def unset_forge_env(name: str, body: dict = Body(default={})) -> dict:
        with registry() as connection:
            cibles = _sparks_cibles_du_catalogue(connection, name)
            _garde_de_forge(connection, body, f"Retirer « {name} »", cibles)
            retire = env_service.retirer(connection, "forge", None, name)
            _reposer_cibles_du_catalogue(connection, cibles)
            # §14.5 : ne pas trouver n'est pas une erreur — l'état voulu est
            # « cette variable n'est pas définie », et il est atteint.
            return {"name": name, "removed": retire}

    @app.get("/v1/sparks/{name}/env", tags=["environnement"])
    def list_spark_env(name: str) -> dict:
        """Le jeu RÉSOLU du Spark, avec l'origine de chaque valeur (§43.9.4)."""
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            return {"spark": name, "env": [
                _rendu_env(e) for e in env_service.lister(connection, spark["id"])]}

    @app.put("/v1/sparks/{name}/env/{variable}", tags=["environnement"])
    def set_spark_env(name: str, variable: str, body: dict = Body(...)) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                # §35.2 : le verrou porte sur l'objet, et poser une variable est
                # une écriture qui LE vise. Le geste de Forge, lui, suit la
                # convention du §43.9.5 bis.
                protection_service.ensure_writable(connection, name, "env")
                entree = env_service.poser(
                    connection, _cle_de_forge(), "spark", spark["id"], variable,
                    str((body or {}).get("value", "")),
                    secret=bool((body or {}).get("secret")))
                _apply_env(connection, service.by_name(connection, name))
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except env_service.EnvError as erreur:
                raise HTTPException(status_code=422, detail={
                    "error": "invalid_name", "message": str(erreur)}) from erreur
            except (IncusError, InstanceAbsente, env_service.CleError):
                # Le registre est écrit ; la cellule sera rattrapée au prochain
                # démarrage. Le geste n'échoue pas pour autant (§43.5.2).
                pass
            return _rendu_env(entree)

    # --- SPK-64 · la selection (docs/DAT.md §43.6 revise) -------------------
    #
    # Le catalogue de la Forge ne descend plus tout seul. Il descend ou on le
    # COCHE. Sans cela, poser un secret une fois a la Forge le deposait en clair
    # dans toutes les cellules, y compris celles qui n'en avaient aucun usage.

    @app.post("/v1/sparks/{name}/env/selection/{variable}", tags=["environnement"])
    def select_spark_env(name: str, variable: str) -> dict:
        """Fait descendre une entree du catalogue dans CE Spark."""
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                # §35.2 : cocher est une ecriture qui VISE ce Spark — elle change
                # ce que sa cellule recoit.
                protection_service.ensure_writable(connection, name, "env")
                entree = env_service.cocher(connection, spark["id"], variable)
                try:
                    _apply_env(connection, service.by_name(connection, name))
                except (IncusError, InstanceAbsente, env_service.CleError):
                    # Meme regle qu'a la pose : le registre est ecrit, la cellule
                    # sera rattrapee au prochain demarrage (§43.5.2).
                    pass
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            except env_service.EnvError as erreur:
                # L'entree n'est pas au catalogue : il n'y a rien a faire
                # descendre. C'est un 404 et non un 422 — ce qui manque est
                # l'entree, pas la forme de la demande.
                raise HTTPException(status_code=404, detail={
                    "error": "unknown_entry", "message": str(erreur)}) from erreur
            return _rendu_env(entree)

    @app.delete("/v1/sparks/{name}/env/selection/{variable}", tags=["environnement"])
    def deselect_spark_env(name: str, variable: str) -> dict:
        """Cesse de faire descendre une entree. La valeur QUITTE la cellule.

        Le retrait effectif vient de `_apply_env`, qui reecrit les fichiers en
        entier depuis l'etat voulu (§43.2). Decocher sans reappliquer laisserait
        la valeur en place et ferait croire a une revocation qui n'a pas eu lieu.
        """
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                protection_service.ensure_writable(connection, name, "env")
                decoche = env_service.decocher(connection, spark["id"], variable)
                try:
                    _apply_env(connection, service.by_name(connection, name))
                except (IncusError, InstanceAbsente, env_service.CleError):
                    pass
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            # §14.5 : ne pas trouver n'est pas une erreur. L'etat voulu — « cette
            # entree ne descend pas ici » — est atteint dans les deux cas.
            return {"spark": name, "name": variable, "selected": False,
                    "changed": decoche}

    @app.delete("/v1/sparks/{name}/env/{variable}", tags=["environnement"])
    def unset_spark_env(name: str, variable: str) -> dict:
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                protection_service.ensure_writable(connection, name, "env")
                retire = env_service.retirer(
                    connection, "spark", spark["id"], variable)
                try:
                    _apply_env(connection, service.by_name(connection, name))
                except (IncusError, InstanceAbsente, env_service.CleError):
                    pass
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
            return {"spark": name, "name": variable, "removed": retire}

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

    def _cellule_ou_refus(connection, name: str) -> dict:
        """Le Spark, s'il est amorçable. Sinon le refus NOMMÉ du §42.7.

        @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §42.7
        """
        try:
            spark = service.by_name(connection, name)
        except service.NotFound as erreur:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "message": str(erreur)}) from erreur
        # §37.2 : le signal d'une cellule est `incus_name`, renseigné SEULEMENT
        # après une application réussie. Ce n'est pas l'adresse, attribuée dès
        # l'écriture au registre.
        if not spark.get("incus_name"):
            raise HTTPException(status_code=409, detail={
                "error": "spark_not_reachable",
                "message": f"« {name} » n'a pas encore de cellule : il est déclaré, "
                           "ses ressources sont réservées, mais rien ne tourne. "
                           "Créez-le avant de l'amorcer."})
        if spark.get("state") != "running":
            raise HTTPException(status_code=409, detail={
                "error": "spark_not_running",
                "message": f"« {name} » n'est pas en marche. L'amorçage exécute "
                           "des commandes DANS la cellule : elle doit tourner."})
        return spark

    def _lire_amorcage(connection, spark: dict) -> tuple[dict[str, str], list[dict]]:
        """Le relevé brut et son jugement, lus une seule fois (§42.6)."""
        brut = bootstrap_service.releve_brut(app.state.incus, spark["incus_name"])
        voulu = sshkeys.authorized_keys_content(connection, spark["id"])
        return brut, bootstrap_service.juger(brut, bootstrap_service.empreinte(voulu))

    def _relever_amorcage(connection, spark: dict) -> list[dict]:
        """Le relevé du §42.6, jugé selon le §42.1."""
        return _lire_amorcage(connection, spark)[1]

    @app.get("/v1/sparks/{name}/bootstrap", tags=["amorcage"])
    def read_bootstrap(name: str) -> dict:
        """Relevé de l'amorçage. N'écrit RIEN (docs/DAT.md §42.7).

        @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §42.1, §42.6, §42.7

        Deux routes plutôt qu'une, et la séparation n'est pas décorative : on
        peut regarder sans agir. Faire de la détection l'effet de bord d'une
        écriture obligerait à amorcer pour savoir s'il y a lieu d'amorcer.
        """
        with registry() as connection:
            spark = _cellule_ou_refus(connection, name)
            try:
                vus = _relever_amorcage(connection, spark)
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "bootstrap_failed", "message": str(erreur)}) from erreur
            return {"spark": name, "reachable": True, "items": vus,
                    "complete": bootstrap_service.complet(vus)}

    @app.post("/v1/sparks/{name}/bootstrap", tags=["amorcage"], status_code=200)
    def run_bootstrap(name: str, body: dict = Body(default={})) -> dict:
        """Amorce ce qui MANQUE, et rien d'autre (docs/DAT.md §42.1, §42.7).

        @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §41.2, §42.1, §42.3, §42.8

        Un second amorçage ne fait rien et le dit. Un geste qui réinstallerait
        « au cas où » redémarrerait le démon Docker du locataire, donc sa
        production, pour rien.
        """
        with registry() as connection:
            spark = _cellule_ou_refus(connection, name)
            # §35 : l'amorçage installe des paquets et redémarre des services
            # chez le locataire. C'est exactement ce que la protection arrête,
            # et elle se lève par son geste distinct — jamais au passage.
            protection_service.ensure_writable(connection, name, "bootstrap")
            # §42.2 : enraciné par DÉFAUT. L'option porte sur ce geste, pas sur
            # le Spark : elle n'est pas stockée au registre, la vérité étant dans
            # la cellule (§42.2 bis).
            mode = (bootstrap_service.ROOTLESS if bool((body or {}).get("rootless"))
                    else bootstrap_service.ENRACINE)
            try:
                brut_avant, avant = _lire_amorcage(connection, spark)
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "bootstrap_failed", "message": str(erreur)}) from erreur

            # §42.2 bis : basculer un Docker en place déplacerait le démon sous un
            # autre compte, et avec lui la production du locataire. On refuse, on
            # ne bascule pas.
            try:
                bootstrap_service.verifier_mode(avant, mode)
            except bootstrap_service.ModeConflit as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "bootstrap_mode_conflict", "message": str(erreur),
                    "requested": mode,
                    "installed": next((v.get("mode") for v in avant
                                       if v["key"] == "docker"), None),
                }) from erreur

            try:
                a_faire = bootstrap_service.manques(avant)
                reprise_rootless = bootstrap_service.reprise_rootless(avant, mode)
                actions = list(a_faire)
                for cle in a_faire:
                    if cle == "cles":
                        _apply_keys(connection, spark)
                        continue
                    commande = bootstrap_service.script_pour(
                        cle, rootless=mode == bootstrap_service.ROOTLESS)
                    if commande:
                        code, _, _ = app.state.incus.exec_capture(
                            spark["incus_name"], commande)
                        # §42.5 : un code non nul est acceptable pour une
                        # DÉTECTION, jamais pour l'installation elle-même.
                        if code:
                            raise bootstrap_service.BootstrapFailed(
                                f"L'installation de « {cle} » a échoué (code {code}).")
                if reprise_rootless:
                    code, _, _ = app.state.incus.exec_capture(
                        spark["incus_name"], bootstrap_service.script_rootless())
                    if code:
                        raise bootstrap_service.BootstrapFailed(
                            f"La reprise rootless a échoué (code {code}).")
                    actions.append("rootless")
                # §44.3, §44.8 : le briefing ne devine pas les versions depuis
                # un vieux texte. Le relevé initial suffit si l'amorçage n'a
                # rien fait; après une écriture, on le rejoue pour dater l'état
                # qu'elle a effectivement produit.
                if actions:
                    brut_final, apres = _lire_amorcage(connection, spark)
                else:
                    brut_final, apres = brut_avant, avant
                if reprise_rootless:
                    bootstrap_service.verifier_reprise_rootless(apres)
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "bootstrap_failed", "message": str(erreur)}) from erreur
            except bootstrap_service.BootstrapFailed as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "bootstrap_failed", "message": str(erreur)}) from erreur

            lignes = bootstrap_service.compte_rendu(avant, apres, actions)
            briefing_service.enregistrer_observation(
                connection, spark["id"], brut_final, actions)
            _rattraper_briefing(connection, service.by_name(connection, name))
            # §42.8 : un amorçage qui ne change RIEN est quand même journalisé.
            # Savoir que quelqu'un a demandé le geste et que rien n'était à faire
            # est une information ; son absence ferait croire qu'il n'a pas été
            # tenté.
            audit_service.record(
                connection, None, "spark.bootstrap", "ok",
                bootstrap_service.message(name, actions, mode),
                target_type="spark", target_id=spark["id"],
                # §42.2 bis : le mode figure au journal MÊME quand rien n'a été
                # fait. C'est ce qu'on cherchera le jour où une pile ne démarre
                # pas, et il ne se retrouve nulle part ailleurs.
                payload={"path": "incus_exec", "changed": bool(actions),
                         "mode": mode, "items": actions},
            )
            return {"spark": name, "path": "incus_exec", "mode": mode,
                    "changed": bool(actions), "items": lignes,
                    "complete": bootstrap_service.complet(apres)}

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
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
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
            except InstanceAbsente as erreur:
                raise _refus_cellule_perdue(spark) from erreur
            except IncusError as erreur:
                raise HTTPException(status_code=502, detail={
                    "error": "incus_failed", "message": str(erreur)}) from erreur
            return {"spark": name, "revoked": label}

    @app.get("/v1/sparks/{name}/ssh-config", tags=["cles"])
    def ssh_config(name: str) -> dict:
        """Fragment de configuration SSH, par rebond sur la Forge.

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

    @app.patch("/v1/sparks/{name}", tags=["sparks"])
    def resize_spark(name: str, body: dict = Body(...)) -> dict:
        """Ajuste les quotas d'un Spark existant (SPK-57, docs/DAT.md §49).

        Trois refus, et ils ne se confondent pas :

        - `423 Locked` — le verrou porte sur l'objet, et redimensionner est une
          écriture. La protection se lève d'abord (§35.2, §49.5). Le code est
          celui que le produit emploie DÉJÀ pour un Spark protégé : en inventer
          un second ferait traiter le même refus de deux façons dans la console ;
        - `409 admission_refused` — « il n'y a pas la place sur la Forge » ;
        - `409 shrink_refused` — « ce que vous voulez retirer est UTILISÉ dans la
          cellule ». Les mélanger enverrait l'exploitant libérer de la place là
          où le problème n'est pas (§49.3).

        L'usage réel de la cellule est relevé AVANT d'agir : sans lui, les refus
        de rétrécissement ne peuvent pas être prononcés, et le produit
        accepterait de livrer des processus à l'OOM killer.
        """
        with registry() as connection:
            try:
                spark = service.by_name(connection, name)
                protection_service.ensure_writable(connection, name, "resize")
                usage = _usage_de_la_cellule(spark)
                apres = service.resize(
                    connection, name, body or {},
                    metadata_margin=config.storage_metadata_margin_bytes,
                    usage=usage,
                )
                # L'ALLOCATION A CHANGÉ, et deux choses en dépendent. La
                # portée de SPK-57 les nomme toutes les deux, et ni l'une ni
                # l'autre n'était faite — MESURÉ le 2026-08-21 sur la Forge de
                # validation, où `spark.slice` pesait **1** après un aller-retour
                # de mode : la promesse centrale du produit était rompue par un
                # simple redimensionnement.
                _suivre_l_allocation(connection, apres)
                # §49.2 : le registre est écrit, la cellule vient ENSUITE. Le
                # champ `applied` dit laquelle des trois situations on est —
                # posé, promis mais pas posé, ou rien à poser.
                pose, motif = _poser_les_quotas(connection, apres)
                rendu = service.decorate(apres)
                rendu["applied"] = pose
                if motif:
                    rendu["apply_error"] = motif
                _rattraper_briefing(connection, service.by_name(connection, name))
                return rendu
            except service.NotFound as erreur:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "message": str(erreur)}) from erreur
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
            except service.ShrinkRefused as refus:
                raise HTTPException(status_code=409, detail={
                    "error": "shrink_refused",
                    "message": str(refus),
                    "resource": refus.ressource,
                    "requested": refus.demande,
                    "in_use": refus.occupe,
                }) from refus
            except service.SparkError as erreur:
                raise HTTPException(status_code=409, detail={
                    "error": "refused", "message": str(erreur)}) from erreur

    def _suivre_l_allocation(connection, spark: dict) -> None:
        """Ce qui doit suivre un changement d'allocation (SPK-57, §7.4 bis, §32.2).

        Deux effets, et la portée de l'unité les nomme tous les deux :

        - **les cœurs ÉPINGLÉS suivent le mode.** Passer de `dedicated` à
          `shared` REND des cœurs au pool commun ; l'inverse en prend. Sans cela,
          un Spark passé en dédié n'aurait aucun cœur, et un Spark qui en sort
          garderait les siens marqués pris — de la capacité perdue que rien ne
          rendrait ;
        - **le poids de la tranche suit la somme des réservations** (§32.2). Le
          poids n'est pas une constante : il vaut `H × f / (1 − f)`. MESURÉ le
          2026-08-21 : après un aller-retour `shared` → `capped` → `shared`, la
          tranche de la Forge de validation pesait **1** au lieu de la vingtaine
          que la loi prescrit. La réservation ne valait plus rien.

        Un échec d'allocation de cœurs n'annule PAS le redimensionnement : le
        registre est déjà écrit (§14.2), et l'écart se voit à la carte des cœurs.
        """
        epingle = spark["cpu_mode"] in ("dedicated", "shared-pinned")
        deja = core_pool.dedicated_cpus(connection, spark["id"])
        try:
            if epingle and len(deja) != (spark["cpu_cores"] or 0):
                # Le nombre a changé, ou rien n'était épinglé : on rend puis on
                # reprend. Reprendre sans rendre laisserait les anciens cœurs
                # marqués pris.
                if deja:
                    _redistribute(connection, core_pool.release(connection, spark["id"]))
                _redistribute(connection,
                              core_pool.carve(connection, spark["id"], spark["cpu_cores"]))
            elif not epingle and deja:
                _redistribute(connection, core_pool.release(connection, spark["id"]))
        except core_pool.CoreAllocationError:
            # L'admission a déjà dit que la place existe ; si le découpage
            # échoue quand même, le registre reste écrit et la carte des cœurs
            # (§27.4) montre l'écart. Faire échouer ici défairait un quota déjà
            # accordé.
            pass
        _reponderer_la_tranche(connection)

    def _poser_les_quotas(connection, spark: dict) -> tuple[bool | None, str | None]:
        """Pose sur la cellule les quotas que le registre vient d'écrire (§49.2).

        Rend `(True, None)`, `(False, motif)` ou `(None, None)` quand il n'y a
        RIEN à poser — Spark sans cellule. Les trois ne se confondent pas
        (§14.6) : « rien à poser » n'est pas un échec, et « promis » n'est pas
        « en vigueur ».

        **Un échec ne défait PAS le registre.** Annuler ferait perdre
        l'admission déjà accordée et rouvrirait la course que la transaction du
        §14.2 vient de fermer. L'écart est DIT, pas rattrapé en silence.
        """
        if not spark.get("incus_name"):
            return None, None
        cpus = core_pool.shared_cpus(connection)
        capacite = core_pool.shared_capacity(connection)
        epingles = (core_pool.dedicated_cpus(connection, spark["id"])
                    if spark["cpu_mode"] == "dedicated" else None)
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
            traduit = translate(
                manifest, cpus, capacite, dedicated_cpus=epingles,
                metadata_margin=app.state.config.storage_metadata_margin_bytes,
            )
            # LE DISQUE D'ABORD, LA CONFIGURATION ENSUITE, et l'ordre n'est
            # pas indifférent — MESURÉ sur la Forge de validation le
            # 2026-08-21 (docs/DAT.md §8.8.1) :
            #
            #   sur un dataset SATURÉ, écrire la configuration ÉCHOUE
            #   (« backup.yaml: disk quota exceeded ») tandis qu'agrandir le
            #   device RÉUSSIT et libère aussitôt la place.
            #
            # L'ordre inverse laissait donc un Spark plein INADMINISTRABLE —
            # exactement la situation que la marge de métadonnées (§8.8) existe
            # pour empêcher, et qu'elle n'empêche pas, le locataire pouvant
            # remplir la marge.
            #
            # La taille ne vit pas dans la configuration mais dans le device
            # `root` : poser la seule configuration laissait le registre à
            # 12 Gio et Incus à 10, la route répondant pourtant `applied: true`.
            devices = traduit.as_payload(config_network, config_pool)["devices"]
            app.state.incus.update_root_size(
                spark["incus_name"], devices["root"]["size"])
            app.state.incus.update_instance_config(
                spark["incus_name"], traduit.config)
        except (TranslationError, IncusError, KeyError) as erreur:
            return False, str(erreur)
        return True, None

    def _usage_de_la_cellule(spark: dict) -> dict | None:
        """Ce que la cellule occupe RÉELLEMENT (§49.3).

        Deux grandeurs, et elles ne se relèvent pas dans les mêmes conditions :

        - la **mémoire** ne se relève que sur une cellule EN MARCHE. Une cellule
          arrêtée n'en occupe aucune ; refuser sur un chiffre périmé interdirait
          un rétrécissement légitime ;
        - le **disque** se relève quel que soit l'état, parce qu'un Spark arrêté
          occupe toujours son jeu de données. C'est `disk.root.usage`, la même
          grandeur que la section *Ressources* affiche, instantanés compris —
          le quota porte sur le jeu entier (§49.3).

        Rend `None` quand rien n'est mesurable — Spark sans cellule, ou runtime
        muet. C'est une RÉPONSE, pas une panne : sans mesure, les refus de
        rétrécissement ne sont simplement pas prononcés, et l'unité le dit plutôt
        que d'inventer une occupation (§31.2).
        """
        if not spark.get("incus_name"):
            return None
        try:
            etat = app.state.incus.instance_state(spark["incus_name"]) or {}
        except IncusError:
            return None

        releve: dict[str, int] = {}
        if spark.get("state") == "running":
            memoire = (etat.get("memory") or {}).get("usage")
            if memoire:
                releve["memory_bytes"] = memoire
        disque = ((etat.get("disk") or {}).get("root") or {}).get("usage")
        if disque:
            releve["storage_bytes"] = disque
        return releve or None

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

    def _cellule_perdue(connection, spark: dict, erreur: Exception) -> HTTPException:
        """Conclut la transition en PANNE, et rend le refus qui nomme la perte.

        @spec docs/BACKLOG.md#SPK-36 · docs/CONTINGENCE.md §4 (l'entrée fantôme),
              §4.5 (la reconstruction) · docs/DAT.md §14.6 (une cellule absente ne
              vaut PAS démarrage réussi), §14.3, §14.5, §33.3

        Mesuré sur la Forge de validation le 2026-08-21 : sans cela,
        `InstanceAbsente` — qui n'hérite PAS d'`IncusError` — s'échappait de la
        route. `finish` n'était alors jamais appelé, et le Spark restait
        STABLEMENT dans son état transitoire, `allowed_commands` vide : plus
        rien n'était possible depuis la console, ni reconstruire ni supprimer.

        L'état visé est « error » parce que c'est le SEUL d'où les deux remèdes
        annoncés par le contrôle REG-FANTOME sont offerts : « retry », qui
        refait la cellule, et « delete », qui rend la place (§14.5).

        À la différence de la suppression, on ne fait pas ici de l'absence une
        réussite : la ligne SURVIT, et un succès de façade laisserait un fantôme
        silencieux au registre — précisément ce que le §4 rend impossible.
        """
        refus = _refus_cellule_perdue(spark, en_panne=True)
        # La raison est PERSISTÉE : elle doit rester lisible sur la fiche du
        # Spark, et pas seulement au moment du geste (§14.6).
        service.finish(connection, spark["id"], success=False,
                       error=refus.detail["message"])
        return refus

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
                except InstanceAbsente as erreur:
                    raise _cellule_perdue(connection, apres, erreur) from erreur
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
                        # SPK-58 · §43.5.2 : le fichier des secrets vit dans un
                        # tmpfs, il DISPARAÎT à l'arrêt de la cellule. Le
                        # reposer ici n'est pas une précaution : sans cela, un
                        # Spark redémarré perdrait ses secrets.
                        _apply_env(connection, service.by_name(connection, name))
                    except (IncusError, InstanceAbsente, env_service.CleError):
                        # Le Spark tourne ; l'écart sera repris à la
                        # réconciliation plutôt que de faire échouer le démarrage.
                        pass
                    try:
                        _reconcile_ingress(connection)
                    except ingress_service.IngressError:
                        pass
                if commande is Command.RESTART:
                    # Le second appel au pilote vivait HORS de toute garde : une
                    # panne y coinçait le Spark en « starting » aussi sûrement
                    # que la première.
                    service.command(connection, apres["id"], Command.START)
                    try:
                        app.state.incus.set_instance_state(apres["name"], "start")
                    except InstanceAbsente as erreur:
                        raise _cellule_perdue(connection, apres, erreur) from erreur
                    except IncusError as erreur:
                        service.finish(connection, apres["id"], success=False,
                                       error=str(erreur))
                        raise HTTPException(status_code=502, detail={
                            "error": "incus_failed", "message": str(erreur)}) from erreur
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
