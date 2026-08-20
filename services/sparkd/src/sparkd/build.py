"""Identité de la build installée.

@spec docs/BACKLOG.md#SPK-53 · docs/DAT.md §40 (la build installée se nomme),
      §40.1 (un seul mécanisme), §40.2 (« inconnue » est une réponse)

Une Forge en production doit pouvoir dire QUEL code elle exécute. Sans cela,
« la correction est déployée » est une croyance : rien ne distingue une Forge à
jour d'une Forge oubliée depuis trois semaines.

Le fichier est écrit à l'INSTALLATION, par `scripts/install-serveur.sh`, et lu
au fil des requêtes. Il n'est jamais déduit à l'exécution : sortir un `git` d'un
service en production ferait dépendre sa réponse d'un dépôt qui n'a aucune raison
d'être là.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import __version__

#: Emplacement par défaut : à CÔTÉ du code, pas dans l'état. Le fichier décrit
#: ce qui est installé, pas ce que la Forge a fait depuis.
#: `sys.prefix` vaut « /opt/sparkd/venv » sur une Forge installée.
DEFAULT_NAME = "build.json"

INCONNUE = "inconnue"


def default_path() -> Path:
    return Path(sys.prefix).parent / DEFAULT_NAME


def identity(path: Path | None = None) -> dict[str, object]:
    """Ce que la Forge sait de sa propre build.

    Une build non estampillée rend `commit = None` et se DIT inconnue. Elle ne
    rend jamais une valeur plausible : « 0.0.0 » a exactement l'air d'une version
    et n'en est pas une (docs/DAT.md §40.2).
    """
    fichier = path or default_path()
    brut: dict[str, object] = {}
    try:
        brut = json.loads(fichier.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        brut = {}

    commit = brut.get("commit") or None
    if not isinstance(commit, str) or not commit.strip():
        commit = None

    return {
        "commit": commit,
        "committed_at": brut.get("committed_at") or None,
        "dirty": bool(brut.get("dirty", False)),
        "installed_at": brut.get("installed_at") or None,
        "installed_from": brut.get("installed_from") or None,
        "version": version_string(commit, bool(brut.get("dirty", False))),
    }


def version_string(commit: str | None, dirty: bool = False) -> str:
    """« 0.0.0+abc123 », ou « 0.0.0+inconnue ».

    La forme suit les versions locales de PEP 440 : la version du paquet reste
    lisible, et le commit voyage avec elle partout où la version est affichée.
    """
    if commit is None:
        return f"{__version__}+{INCONNUE}"
    suffixe = f"{commit}.sale" if dirty else commit
    return f"{__version__}+{suffixe}"
