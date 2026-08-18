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

from fastapi import FastAPI

from . import __version__
from .config import Config
from .db import connect
from .migrations import applied, verify


def open_registry(config: Config):
    """Ouvre le registre après avoir vérifié qu'il correspond au code.

    `docs/SCHEMA.md` §12.4 : sparkd refuse de servir une base dont le schéma
    réel n'est plus celui que le code croit. La vérification a lieu ici, avant
    que la moindre requête ne soit acceptée — plus tard, l'erreur serait
    découverte au milieu d'une opération et bien plus difficile à rattacher à sa
    cause.
    """
    connection = connect(config.database)
    try:
        verify(connection)
    except Exception:
        connection.close()
        raise
    return connection


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
    app.state.registry = open_registry(config)
    app.state.schema_versions = sorted(applied(app.state.registry))

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

    return app
