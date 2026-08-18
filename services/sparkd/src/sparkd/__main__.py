"""Point d'entree de sparkd.

@spec docs/BACKLOG.md#SPK-01 · docs/DAT.md §5 (surface reseau) · README.md
      section « Variables d'environnement »
"""

from __future__ import annotations

import sys

from .app import create_app
from .config import ConfigError, load


def main(argv: list[str] | None = None) -> int:
    try:
        config = load()
    except ConfigError as error:
        print(f"sparkd : configuration refusee — {error}", file=sys.stderr)
        return 2

    import uvicorn

    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        log_level=config.log_level,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
