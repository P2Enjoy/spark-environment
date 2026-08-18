"""Moteur de migrations du registre.

@spec docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §10 (schema_migration), §11 (Retour
      arriere), §12 (Mecanique des migrations)

Le moteur applique les fichiers `migrations/NNN_intitule.sql` dans l'ordre
numerique, chacun dans une transaction unique qui englobe l'enregistrement de sa
version. Il refuse de servir une base dont le schema reel n'est plus celui que
le code croit — voir `verify`.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .db import execute_script, transaction

# Les fichiers SQL vivent DANS le paquet : places a cote du depot, ils ne
# suivaient pas l'installation, et sparkd demarrait sans aucune migration.
MIGRATIONS_DIR = Path(__file__).resolve().parent / "schema"

_FILENAME = re.compile(r"^(\d{3})_([a-z0-9_]+)\.sql$")
_UP = "-- @up"
_DOWN = "-- @down"
_IRREVERSIBLE = "-- IRREVERSIBLE:"

SCHEMA_MIGRATION_DDL = """
CREATE TABLE IF NOT EXISTS schema_migration (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT    NOT NULL,
    checksum   TEXT    NOT NULL
)
"""


class MigrationError(RuntimeError):
    """Le registre ne peut pas etre migre, ou son etat est incoherent."""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path
    up: str
    down: str
    checksum: str

    @property
    def reversible(self) -> bool:
        return _IRREVERSIBLE not in self.down


def _split(text: str, path: Path) -> tuple[str, str]:
    lines = text.splitlines()
    up_at = down_at = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == _UP:
            up_at = index
        elif stripped == _DOWN:
            down_at = index
    if up_at is None:
        raise MigrationError(f"{path.name} : marqueur « {_UP} » absent.")
    if down_at is None:
        raise MigrationError(
            f"{path.name} : marqueur « {_DOWN} » absent. Une migration sans "
            "retour arriere doit le declarer explicitement "
            f"({_IRREVERSIBLE} <raison>), pas l'omettre."
        )
    if down_at < up_at:
        raise MigrationError(f"{path.name} : « {_DOWN} » precede « {_UP} ».")
    return (
        "\n".join(lines[up_at + 1 : down_at]).strip(),
        "\n".join(lines[down_at + 1 :]).strip(),
    )


def discover(directory: Path | None = None) -> list[Migration]:
    """Lit les migrations du depot, triees par version."""
    folder = MIGRATIONS_DIR if directory is None else directory
    if not folder.is_dir():
        # Ne JAMAIS rendre une liste vide ici. Un dossier absent est une erreur
        # d'installation ; la traiter comme « aucune migration » ferait demarrer
        # sparkd sans schema, et chaque requete echouerait ensuite sans que rien
        # ne designe la cause. Mesure vecue au premier deploiement.
        raise MigrationError(
            f"Dossier de migrations introuvable : {folder}. L'installation de "
            "sparkd est incomplete."
        )

    found: dict[int, Migration] = {}
    for path in sorted(folder.iterdir()):
        if path.suffix != ".sql":
            continue
        match = _FILENAME.match(path.name)
        if match is None:
            raise MigrationError(
                f"{path.name} : nom invalide, attendu « NNN_intitule.sql » "
                "(docs/SCHEMA.md §12.1)."
            )
        version = int(match.group(1))
        if version in found:
            raise MigrationError(
                f"Version {version:03d} portee par deux fichiers : "
                f"{found[version].path.name} et {path.name}."
            )
        raw = path.read_bytes()
        up, down = _split(raw.decode("utf-8"), path)
        if not up:
            raise MigrationError(f"{path.name} : section « {_UP} » vide.")
        found[version] = Migration(
            version=version,
            name=match.group(2),
            path=path,
            up=up,
            down=down,
            checksum=hashlib.sha256(raw).hexdigest(),
        )
    return [found[version] for version in sorted(found)]


def applied(connection: sqlite3.Connection) -> dict[int, str]:
    """Versions enregistrees dans la base, version -> checksum."""
    connection.execute(SCHEMA_MIGRATION_DDL)
    rows = connection.execute(
        "SELECT version, checksum FROM schema_migration ORDER BY version"
    ).fetchall()
    return {row["version"]: row["checksum"] for row in rows}


def verify(connection: sqlite3.Connection, directory: Path | None = None) -> None:
    """Refuse une base dont le schema reel n'est plus celui du code.

    Les trois refus du §12.4 disent la meme chose sous trois formes : continuer
    produirait des erreurs plus loin, plus difficiles a rattacher a leur cause.
    """
    known = {m.version: m for m in discover(directory)}
    recorded = applied(connection)

    for version, checksum in recorded.items():
        migration = known.get(version)
        if migration is None:
            raise MigrationError(
                f"La migration {version:03d} est enregistree dans la base mais "
                "son fichier est absent du depot : cette base a ete migree par "
                "un autre code que celui-ci."
            )
        if migration.checksum != checksum:
            raise MigrationError(
                f"La migration {version:03d} ({migration.path.name}) a ete "
                "modifiee apres son application. Le schema reel n'est plus "
                "celui que decrit le depot."
            )

    if recorded:
        highest = max(recorded)
        trous = [v for v in known if v < highest and v not in recorded]
        if trous:
            raise MigrationError(
                "Trou dans la sequence : les migrations "
                f"{', '.join(f'{v:03d}' for v in sorted(trous))} precedent la "
                f"version appliquee {highest:03d} sans avoir ete appliquees. "
                "Deux historiques divergents ont probablement ete fusionnes."
            )


def pending(connection: sqlite3.Connection, directory: Path | None = None) -> list[Migration]:
    recorded = applied(connection)
    return [m for m in discover(directory) if m.version not in recorded]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def upgrade(connection: sqlite3.Connection, directory: Path | None = None) -> list[int]:
    """Applique les migrations en attente. Rend les versions appliquees."""
    verify(connection, directory)
    done: list[int] = []
    for migration in pending(connection, directory):
        with transaction(connection):
            execute_script(connection, migration.up)
            connection.execute(
                "INSERT INTO schema_migration (version, applied_at, checksum) "
                "VALUES (?, ?, ?)",
                (migration.version, _now(), migration.checksum),
            )
        done.append(migration.version)
    return done


def downgrade(connection: sqlite3.Connection, directory: Path | None = None) -> list[int]:
    """Retire la derniere migration appliquee.

    Le retour arriere est refuse plutot qu'execute a moitie lorsque la migration
    se declare irreversible (docs/SCHEMA.md §12.1).
    """
    recorded = applied(connection)
    if not recorded:
        return []
    version = max(recorded)
    known = {m.version: m for m in discover(directory)}
    migration = known.get(version)
    if migration is None:
        raise MigrationError(
            f"Retour arriere impossible : le fichier de la migration "
            f"{version:03d} est absent du depot."
        )
    if not migration.reversible:
        raise MigrationError(
            f"La migration {version:03d} ({migration.path.name}) se declare "
            "irreversible. Le retour arriere est refuse plutot qu'execute a "
            "moitie."
        )
    with transaction(connection):
        execute_script(connection, migration.down)
        connection.execute("DELETE FROM schema_migration WHERE version = ?", (version,))
    return [version]
