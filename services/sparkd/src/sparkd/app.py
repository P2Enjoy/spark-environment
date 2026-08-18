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
        return {
            "status": "degraded",
            "driver": config.driver,
            "dependencies": {
                "incus": "unknown",
                "registry": "unknown",
                "caddy": "unknown",
            },
            "detail": "Pilotes non implementes : unites SPK-07 et SPK-08.",
        }

    return app
