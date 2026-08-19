#!/usr/bin/env python3
"""Écrit ou vérifie le contrat d'API.

@spec docs/BACKLOG.md#SPK-17 · docs/DAT.md §23.2
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "sparkd" / "src"))

from sparkd import contract  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "check":
        ok, message = contract.check()
        print(message)
        return 0 if ok else 1
    chemin = contract.write()
    print(f"Contrat écrit : {chemin}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
