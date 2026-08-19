"""Clés SSH : enregistrement, association et application dans les Sparks.

@spec docs/BACKLOG.md#SPK-11 · docs/DAT.md §17 (Accès SSH aux Sparks),
      §17.1 (pourquoi pas cloud-init), §17.2 (ce qui est stocké) ·
      docs/SCHEMA.md §7

Un seul mécanisme, à la création comme au changement : `authorized_keys` est
**réécrit en entier** depuis l'état voulu du registre. C'est ce qui garantit
qu'un retrait retire réellement — un mécanisme qui ajoute ne retire jamais.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from secrets import token_hex

from .db import transaction

AUTHORIZED_KEYS = "/root/.ssh/authorized_keys"

#: Types acceptés. Ed25519 d'abord, c'est le défaut raisonnable aujourd'hui.
KEY_TYPES = (
    "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com",
)
_LIGNE = re.compile(r"^(?P<type>[a-z0-9@.\-]+)\s+(?P<corps>[A-Za-z0-9+/=]+)(?:\s+(?P<note>.*))?$")


class SshKeyError(ValueError):
    """Clé refusée. Le message est destiné à l'exploitant."""


@dataclass(frozen=True)
class PublicKey:
    key_type: str
    body: str
    comment: str

    @property
    def line(self) -> str:
        return f"{self.key_type} {self.body}" + (f" {self.comment}" if self.comment else "")

    @property
    def fingerprint(self) -> str:
        """Empreinte OpenSSH : `SHA256:` + base64 sans remplissage.

        La même que rend `ssh-keygen -lf` : une empreinte maison obligerait à
        traduire mentalement à chaque vérification (docs/DAT.md §17.2).
        """
        brut = base64.b64decode(self.body)
        condensat = hashlib.sha256(brut).digest()
        return "SHA256:" + base64.b64encode(condensat).decode().rstrip("=")


def parse(text: str) -> PublicKey:
    """Analyse une clé publique, ou refuse en disant pourquoi."""
    nettoye = " ".join(text.strip().split())
    if not nettoye:
        raise SshKeyError("Clé vide.")
    if "PRIVATE KEY" in nettoye.upper():
        raise SshKeyError(
            "Ceci est une clé PRIVÉE. Seules les clés publiques sont acceptées — "
            "celle qui se termine par « .pub »."
        )
    match = _LIGNE.match(nettoye)
    if not match:
        raise SshKeyError(
            "Format non reconnu. Une clé publique s'écrit « <type> <corps> "
            "[commentaire] », par exemple « ssh-ed25519 AAAAC3... poste »."
        )
    key_type = match.group("type")
    if key_type not in KEY_TYPES:
        raise SshKeyError(
            f"Type de clé « {key_type} » non accepté. Acceptés : "
            + ", ".join(KEY_TYPES)
        )
    try:
        decode = base64.b64decode(match.group("corps"), validate=True)
    except Exception:
        raise SshKeyError("Corps de clé illisible : ce n'est pas du base64 valide.") from None
    if not decode.startswith(len(key_type).to_bytes(4, "big") + key_type.encode()):
        raise SshKeyError(
            f"Le corps de la clé ne correspond pas au type annoncé « {key_type} »."
        )
    return PublicKey(key_type, match.group("corps"), match.group("note") or "")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _audit(connection, actor, action, target, payload, result, message) -> None:
    connection.execute(
        "INSERT INTO audit_log (ts, actor, action, target_type, target_id,"
        " payload, result, message) VALUES (?, ?, ?, 'ssh_key', ?, ?, ?, ?)",
        (_now(), actor, action, target, json.dumps(payload), result, message),
    )


def register(
    connection: sqlite3.Connection, label: str, text: str, actor: str = "responsable"
) -> dict:
    """Enregistre une clé publique."""
    if not label.strip():
        raise SshKeyError("Une clé doit porter un libellé, pour qu'on sache la retirer.")
    cle = parse(text)
    identifiant = token_hex(12)
    with transaction(connection):
        if connection.execute("SELECT 1 FROM ssh_key WHERE label = ?", (label,)).fetchone():
            raise SshKeyError(f"Un libellé « {label} » existe déjà.")
        if connection.execute(
            "SELECT 1 FROM ssh_key WHERE fingerprint = ?", (cle.fingerprint,)
        ).fetchone():
            raise SshKeyError(
                f"Cette clé est déjà enregistrée ({cle.fingerprint})."
            )
        connection.execute(
            "INSERT INTO ssh_key (id, label, public_key, fingerprint, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (identifiant, label, cle.line, cle.fingerprint, _now()),
        )
        # Le corps de la cle n'entre PAS au journal (docs/DAT.md §17.2).
        _audit(connection, actor, "sshkey.register", identifiant,
               {"label": label, "fingerprint": cle.fingerprint}, "ok",
               f"Clé « {label} » enregistrée ({cle.fingerprint}).")
    return get(connection, identifiant)


def get(connection: sqlite3.Connection, key_id: str) -> dict:
    row = connection.execute("SELECT * FROM ssh_key WHERE id = ?", (key_id,)).fetchone()
    if row is None:
        raise SshKeyError(f"Aucune clé d'identifiant « {key_id} ».")
    return dict(row)


def by_label(connection: sqlite3.Connection, label: str) -> dict:
    row = connection.execute("SELECT * FROM ssh_key WHERE label = ?", (label,)).fetchone()
    if row is None:
        raise SshKeyError(f"Aucune clé nommée « {label} ».")
    return dict(row)


def listing(connection: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in connection.execute("SELECT * FROM ssh_key ORDER BY label")]


def forget(connection: sqlite3.Connection, label: str, actor: str = "responsable") -> list[str]:
    """Retire une clé du registre. Rend les Sparks à réconcilier."""
    cle = by_label(connection, label)
    concernes = [
        r["name"] for r in connection.execute(
            "SELECT s.name FROM spark s JOIN spark_ssh_key k ON k.spark_id = s.id"
            " WHERE k.ssh_key_id = ? ORDER BY s.name", (cle["id"],)
        )
    ]
    with transaction(connection):
        connection.execute("DELETE FROM ssh_key WHERE id = ?", (cle["id"],))
        _audit(connection, actor, "sshkey.forget", cle["id"],
               {"label": label, "fingerprint": cle["fingerprint"],
                "sparks": concernes}, "ok",
               f"Clé « {label} » retirée ; {len(concernes)} Spark(s) à réconcilier.")
    return concernes


def grant(connection: sqlite3.Connection, spark_id: str, label: str,
          actor: str = "responsable") -> None:
    cle = by_label(connection, label)
    with transaction(connection):
        connection.execute(
            "INSERT OR IGNORE INTO spark_ssh_key (spark_id, ssh_key_id) VALUES (?, ?)",
            (spark_id, cle["id"]),
        )
        _audit(connection, actor, "sshkey.grant", cle["id"],
               {"label": label, "spark_id": spark_id}, "ok",
               f"Clé « {label} » accordée.")


def revoke(connection: sqlite3.Connection, spark_id: str, label: str,
           actor: str = "responsable") -> None:
    cle = by_label(connection, label)
    with transaction(connection):
        connection.execute(
            "DELETE FROM spark_ssh_key WHERE spark_id = ? AND ssh_key_id = ?",
            (spark_id, cle["id"]),
        )
        _audit(connection, actor, "sshkey.revoke", cle["id"],
               {"label": label, "spark_id": spark_id}, "ok",
               f"Clé « {label} » révoquée.")


def desired_keys(connection: sqlite3.Connection, spark_id: str) -> list[dict]:
    """État VOULU des clés d'un Spark, dans l'ordre des libellés."""
    return [
        dict(r) for r in connection.execute(
            "SELECT k.* FROM ssh_key k JOIN spark_ssh_key j ON j.ssh_key_id = k.id"
            " WHERE j.spark_id = ? ORDER BY k.label", (spark_id,)
        )
    ]


def authorized_keys_content(connection: sqlite3.Connection, spark_id: str) -> str:
    """Contenu COMPLET du fichier, régénéré depuis l'état voulu.

    Régénérer plutôt qu'ajouter n'est pas un détail de mise en œuvre : c'est ce
    qui fait qu'un retrait retire, et que le Spark ne dérive pas de ce que le
    registre annonce (docs/DAT.md §17.1).
    """
    lignes = [
        "# Fichier régénéré par sparkd depuis le registre. Toute modification",
        "# manuelle sera écrasée à la prochaine réconciliation.",
    ]
    for cle in desired_keys(connection, spark_id):
        lignes.append(f"# {cle['label']} — {cle['fingerprint']}")
        lignes.append(cle["public_key"])
    return "\n".join(lignes) + "\n"


#: Provisionnement d'un Spark neuf (docs/DAT.md §17.3).
#: Le mot de passe est désactivé, y compris pour root : un Spark n'a pas de mot
#: de passe à deviner.
PROVISION_SSHD = [
    "sh", "-c",
    "command -v sshd >/dev/null 2>&1 || { "
    "DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1; "
    "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1; }; "
    "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/;"
    "s/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config; "
    "systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null; "
    "systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null",
]
