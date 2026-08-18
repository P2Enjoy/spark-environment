"""Point d'entree de sparkd.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §5 (surface reseau) · README.md
      section « Variables d'environnement »
"""

from __future__ import annotations

import sys

from .app import create_app
from .config import ConfigError, load
from .migrations import MigrationError


def main(argv: list[str] | None = None) -> int:
    try:
        config = load()
    except ConfigError as error:
        print(f"sparkd : configuration refusee — {error}", file=sys.stderr)
        return 2

    # create_app migre le registre et verifie sa concordance avant de servir :
    # servir sur un schema en retard ou derive produirait des erreurs plus loin,
    # moins rattachables a leur cause.
    try:
        application = create_app(config)
    except MigrationError as error:
        print(f"sparkd : registre refuse — {error}", file=sys.stderr)
        return 3
    versions = application.state.schema_versions
    print(f"sparkd : registre en version {versions[-1]:03d}" if versions
          else "sparkd : registre vide")

    import uvicorn

    uvicorn.run(
        application,
        host=config.host,
        port=config.port,
        log_level=config.log_level,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
