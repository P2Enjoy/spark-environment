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
import re
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


#: Le commit tel que setuptools-scm le pose dans la version locale : « +gABC123 ».
COMMIT_DANS_VERSION = re.compile(r"\+(?:[^.]*\.)*g([0-9a-f]{7,40})")


def commit_du_paquet() -> str | None:
    """Le commit lu dans les MÉTADONNÉES du paquet installé (docs/DAT.md §40.4).

    C'est la source qui ne s'oublie pas. L'estampille de fichier (§40.1) demandait
    qu'on passe une variable à l'installation ; une Forge est apparue en
    « inconnue » le 2026-08-21 parce que quelqu'un l'avait omise. Une version
    dérivée du dépôt à la construction ne peut pas être omise.
    """
    trouve = COMMIT_DANS_VERSION.search(__version__ or "")
    return trouve.group(1) if trouve else None


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

    # Les MÉTADONNÉES DU PAQUET priment sur le fichier : elles viennent de la
    # construction, donc du dépôt d'où l'on a installé, et personne ne peut les
    # omettre. Le fichier reste utile pour ce qu'elles ne portent pas — d'où et
    # quand l'installation a eu lieu.
    du_paquet = commit_du_paquet()
    if du_paquet:
        commit = du_paquet

    return {
        "commit": commit,
        "committed_at": brut.get("committed_at") or None,
        "dirty": bool(brut.get("dirty", False)),
        "installed_at": brut.get("installed_at") or None,
        "installed_from": brut.get("installed_from") or None,
        "version": version_string(commit, bool(brut.get("dirty", False))),
    }


def version_string(commit: str | None, dirty: bool = False) -> str:
    # Depuis §40.4, la version du paquet PORTE deja le commit. Le rajouter
    # produirait « …+g9761d83c2.d20260821+9761d83c2 » — un numero qui dit deux
    # fois la meme chose et qu'on ne peut plus comparer a rien.
    if commit and commit in (__version__ or ""):
        return f"{__version__}.sale" if dirty else __version__
    """« 0.0.0+abc123 », ou « 0.0.0+inconnue ».

    La forme suit les versions locales de PEP 440 : la version du paquet reste
    lisible, et le commit voyage avec elle partout où la version est affichée.
    """
    if commit is None:
        return f"{__version__}+{INCONNUE}"
    suffixe = f"{commit}.sale" if dirty else commit
    return f"{__version__}+{suffixe}"
