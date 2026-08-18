"""Point d'entree de sparkd.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §5 (surface reseau) · README.md
      section « Variables d'environnement »
"""

from __future__ import annotations

import sys

from .app import create_app
from .config import ConfigError, load
from .db import connect
from .migrations import MigrationError, upgrade


def main(argv: list[str] | None = None) -> int:
    try:
        config = load()
    except ConfigError as error:
        print(f"sparkd : configuration refusee — {error}", file=sys.stderr)
        return 2

    # Le registre est migre avant que le service n'ouvre son port : servir sur
    # un schema en retard produirait des erreurs plus loin, moins lisibles.
    try:
        connection = connect(config.database)
        appliquees = upgrade(connection)
        connection.close()
        if appliquees:
            versions = ", ".join(f"{v:03d}" for v in appliquees)
            print(f"sparkd : migrations appliquees — {versions}")
    except MigrationError as error:
        print(f"sparkd : registre refuse — {error}", file=sys.stderr)
        return 3

    try:
        application = create_app(config)
    except MigrationError as error:
        print(f"sparkd : registre refuse — {error}", file=sys.stderr)
        return 3

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
