"""Journal d'audit : point de passage unique et filtrage.

@spec docs/BACKLOG.md#SPK-15 · docs/DAT.md §21 (Journal d'audit),
      §21.1 (un seul chemin), §21.2 (on caviarde), §21.3 (ce qui est reconnu),
      §21.4 (un payload n'est pas un dépotoir) · docs/SCHEMA.md §9

Aucun autre module n'écrit dans `audit_log`. Un filtre posé à cinq endroits sera
oublié au sixième, et l'oubli ne se verra pas — un journal qui contient trop
ressemble à un journal qui fonctionne.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

REDACTED = "[caviardé]"
TRUNCATED = "[tronqué]"

#: Taille maximale du payload sérialisé. Un journal sert à reconstituer qui a
#: fait quoi, pas à rejouer l'état du système (docs/DAT.md §21.4).
MAX_PAYLOAD_BYTES = 4096
MAX_DEPTH = 6

#: Le nom du champ est le signal le plus fiable : il est choisi par le
#: développeur, alors que la valeur peut prendre n'importe quelle forme.
SENSITIVE_NAME = re.compile(
    r"password|secret|token|credential|authorization|passphrase|private|"
    r"api[_-]?key|(^|[_-])key([_-]|$)|public_key",
    re.IGNORECASE,
)

#: Second filet, pour ce qu'un nom anodin laisserait passer.
SENSITIVE_VALUE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|^Authorization:\s"
    r"|^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-ssh-\S+)\s+[A-Za-z0-9+/=]{20,}",
    re.IGNORECASE | re.MULTILINE,
)

RESULTS = ("ok", "denied", "error")


def looks_sensitive(name: str | None, value: object) -> bool:
    if name and SENSITIVE_NAME.search(str(name)):
        return True
    return isinstance(value, str) and bool(SENSITIVE_VALUE.search(value))


def redact(value: object, name: str | None = None, depth: int = 0) -> object:
    """Caviarde en place, en gardant les clés visibles (docs/DAT.md §21.2)."""
    if depth > MAX_DEPTH:
        return TRUNCATED
    if looks_sensitive(name, value):
        return REDACTED
    if isinstance(value, dict):
        return {k: redact(v, k, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v, name, depth + 1) for v in value]
    return value


def prepare_payload(payload: object) -> str | None:
    """Caviarde puis borne. Rend le JSON prêt à écrire."""
    if payload is None:
        return None
    filtre = redact(payload)
    texte = json.dumps(filtre, ensure_ascii=False, default=str)
    if len(texte.encode("utf-8")) <= MAX_PAYLOAD_BYTES:
        return texte
    # Tronquer en le DISANT : un payload amputé en silence ferait croire à une
    # trace complète.
    return json.dumps(
        {
            "truncated": True,
            "original_bytes": len(texte.encode("utf-8")),
            "preview": texte[:512],
        },
        ensure_ascii=False,
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def record(
    connection: sqlite3.Connection,
    actor: str,
    action: str,
    result: str,
    message: str,
    target_type: str | None = None,
    target_id: str | None = None,
    payload: object = None,
) -> None:
    """Écrit une entrée. **Seul** chemin vers `audit_log` (docs/DAT.md §21.1).

    N'ouvre pas de transaction : l'appelant décide si la trace doit vivre ou
    mourir avec son opération. Un refus, lui, se journalise hors transaction —
    sinon le rollback l'emporterait, et c'est exactement la trace qui sert.
    """
    if result not in RESULTS:
        raise ValueError(f"Résultat « {result} » inconnu, attendu {RESULTS}.")
    connection.execute(
        "INSERT INTO audit_log (ts, actor, action, target_type, target_id,"
        " payload, result, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            _now(), actor, action, target_type, target_id,
            prepare_payload(payload), result,
            # Le message aussi passe par le filtre : il est composé à la main,
            # donc susceptible d'interpoler une valeur sensible.
            str(redact(message, "message")) if looks_sensitive(None, message) else message,
        ),
    )


def listing(
    connection: sqlite3.Connection,
    limit: int = 100,
    result: str | None = None,
    action: str | None = None,
) -> list[dict]:
    """Entrées les plus récentes d'abord."""
    conditions, parametres = [], []
    if result:
        conditions.append("result = ?")
        parametres.append(result)
    if action:
        conditions.append("action LIKE ?")
        parametres.append(f"{action}%")
    ou = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    parametres.append(max(1, min(limit, 1000)))
    return [
        dict(r) for r in connection.execute(
            f"SELECT * FROM audit_log{ou} ORDER BY id DESC LIMIT ?", parametres
        )
    ]
