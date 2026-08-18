"""Connexion SQLite du registre.

@spec docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §12.5 (Pragmas de connexion)

Toute connexion au registre passe par ici. C'est la seule facon de garantir que
les pragmas sont poses : SQLite les applique PAR CONNEXION, pas par base, et une
connexion ouverte ailleurs les perdrait silencieusement.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

PRAGMAS = (
    # SQLite n'active PAS les cles etrangeres par defaut, et le fait par
    # connexion. Sans cette ligne, un spark_id pointant vers rien s'insere sans
    # un mot. C'est la seule de ces directives qui touche la correction.
    "PRAGMA foreign_keys = ON",
    "PRAGMA journal_mode = WAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA synchronous = NORMAL",
)


def connect(database: str | Path) -> sqlite3.Connection:
    """Ouvre une connexion au registre, pragmas posés."""
    path = Path(database)
    if path.name != ":memory:" and path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(str(database), isolation_level=None)
    connection.row_factory = sqlite3.Row
    for pragma in PRAGMAS:
        connection.execute(pragma)
    return connection


@contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Transaction explicite : tout passe, ou rien.

    `isolation_level=None` désactive la gestion implicite de sqlite3, qui
    ouvrait des transactions à des moments difficiles à prévoir. On les ouvre
    donc ici, visiblement.
    """
    connection.execute("BEGIN")
    try:
        yield connection
    except Exception:
        connection.execute("ROLLBACK")
        raise
    connection.execute("COMMIT")


def statements(script: str) -> Iterator[str]:
    """Découpe un script SQL en instructions complètes.

    `sqlite3.executescript` ne peut pas servir ici : il **valide implicitement
    la transaction en cours** avant d'exécuter le script. Une migration lancée
    à travers lui ne serait donc pas atomique — une erreur au milieu laisserait
    les instructions précédentes committées, ce que `docs/SCHEMA.md` §12.3
    interdit explicitement.

    On découpe donc nous-mêmes, en s'appuyant sur l'analyseur lexical de SQLite
    (`complete_statement`) plutôt que sur un découpage naïf au point-virgule,
    qui casserait sur un `;` à l'intérieur d'une chaîne ou d'un trigger.
    """
    buffer = ""
    for line in script.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            candidate = buffer.strip()
            if _has_sql(candidate):
                yield candidate
            buffer = ""
    remainder = buffer.strip()
    if _has_sql(remainder):
        # Instruction non terminée : on la laisse remonter comme erreur SQLite
        # plutôt que de l'ignorer en silence.
        yield remainder


def _has_sql(chunk: str) -> bool:
    """Vrai si le fragment contient autre chose que des commentaires."""
    return any(
        line.strip() and not line.strip().startswith("--")
        for line in chunk.splitlines()
    )


def execute_script(connection: sqlite3.Connection, script: str) -> None:
    """Exécute un script SQL SANS rompre la transaction en cours."""
    for statement in statements(script):
        connection.execute(statement)
