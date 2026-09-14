"""La configuration des canaux d'alerte hors bande, au REGISTRE.

@spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (deux canaux, réglés depuis un
      onglet), §47.3.1 (le gabarit et ses trois règles), §47.3.3 (toute
      modification demande un mot de passe), §35.3 (le mécanisme du mot de
      passe, réemployé tel quel), §43.3 (un secret ne vit qu'au coffre),
      §14.6 (zéro ne veut pas dire « tout va bien »)

**Pourquoi ce module existe.** La configuration vivait dans `SPARKD_NOTIFY_URL`
et `SPARKD_NOTIFY_TEMPLATE`. Une variable d'environnement se règle par un
redémarrage du service et ne se voit nulle part : un canal qu'on ne peut ni voir
ni éprouver depuis l'écran est un canal dont on ne sait pas s'il veille. C'est
exactement ce qui s'est produit le 2026-09-14 — le canal a été posé, il refusait
tout envoi, et il a fallu provoquer un geste sensible réel pour l'apprendre.

**Ce que ce module ne fait PAS.** Il ne poste rien : l'envoi reste dans
`notification.py`. Il ne chiffre rien : un secret ne vit qu'au coffre du §43.3,
et la colonne `smtp_password_secret` n'en porte que le NOM.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from hashlib import scrypt
from secrets import compare_digest, token_hex

from . import audit, notification
from .db import transaction

#: Les mêmes paramètres que la protection d'un Spark (§35.3). Les réemployer et
#: non les recopier : deux jeux de paramètres divergeraient un jour.
from .protection import DEFAULT_PARAMS


class CanalError(RuntimeError):
    """`422` — la configuration proposée est refusée, et le message dit pourquoi."""


class MotDePasseRefuse(CanalError):
    """`403` — le garde du §47.3.3 n'a pas reconnu le mot de passe."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _derive(mot: str, sel: str, params: dict) -> str:
    return scrypt(
        mot.encode("utf-8"), salt=bytes.fromhex(sel),
        n=int(params["n"]), r=int(params["r"]), p=int(params["p"]),
        dklen=int(params["dklen"]),
    ).hex()


def _ligne(connection: sqlite3.Connection) -> sqlite3.Row:
    ligne = connection.execute("SELECT * FROM notify_channels WHERE id = 1").fetchone()
    if ligne is None:  # pragma: no cover - la migration 016 la pose
        raise CanalError("La ligne de configuration des canaux est absente du registre.")
    return ligne


# --- lecture -----------------------------------------------------------------


def etat(connection: sqlite3.Connection) -> dict:
    """Ce que l'écran lit. **Aucun secret n'en sort** (§43.3).

    L'URL du webhook n'est pas rendue non plus : elle EST un secret — qui la
    détient écrit dans le salon. On rend de quoi savoir qu'elle est posée, et
    de quoi la reconnaître — son hôte —, jamais de quoi s'en servir.
    """
    l = _ligne(connection)
    url = (l["webhook_url"] or "").strip()
    return {
        "guard_set": l["guard_hash"] is not None,
        "guard_set_at": l["guard_set_at"],
        "webhook": {
            "enabled": bool(l["webhook_enabled"]),
            "configured": bool(url),
            # De quoi RECONNAÎTRE le canal sans pouvoir y écrire.
            "host": url.split("/")[2] if url.count("/") >= 2 else None,
            "template": l["webhook_template"],
            "template_unknown_fields": list(
                notification.champs_inconnus(l["webhook_template"] or "")),
        },
        "smtp": {
            "enabled": bool(l["smtp_enabled"]),
            "configured": bool((l["smtp_host"] or "").strip()),
            "host": l["smtp_host"], "port": l["smtp_port"], "tls": l["smtp_tls"],
            "username": l["smtp_username"], "from": l["smtp_from"], "to": l["smtp_to"],
            "password_set": bool(l["smtp_password_secret"]),
        },
        "updated_at": l["updated_at"], "updated_by": l["updated_by"],
    }


def webhook_actif(connection: sqlite3.Connection) -> tuple[str, str]:
    """L'URL et le gabarit à employer, ou `("", "")` si le canal ne veille pas.

    Un canal **désactivé** rend la même chose qu'un canal absent : le §47.3 veut
    qu'on garde une URL en la désactivant, sans avoir à la retaper.
    """
    l = _ligne(connection)
    if not l["webhook_enabled"]:
        return ("", "")
    return ((l["webhook_url"] or "").strip(), (l["webhook_template"] or "").strip())


# --- le garde du §47.3.3 -----------------------------------------------------


def exiger(connection: sqlite3.Connection, mot: str) -> None:
    """Le garde. **Le premier usage POSE le mot de passe** au lieu de refuser.

    Motif : un garde qu'il faut armer par un geste séparé ne l'est jamais. Le
    premier réglage d'un canal est aussi celui qui décide qui pourra le couper.
    """
    l = _ligne(connection)
    if l["guard_hash"] is None:
        if not mot:
            raise MotDePasseRefuse(
                "Aucun mot de passe n'est encore fixé pour les canaux d'alerte. "
                "Celui que vous donnez ici sera le mot de passe, et il sera "
                "exigé pour toute modification ultérieure.")
        sel = token_hex(16)
        params = dict(DEFAULT_PARAMS)
        connection.execute(
            "UPDATE notify_channels SET guard_hash = ?, guard_salt = ?,"
            " guard_params = ?, guard_set_at = ? WHERE id = 1",
            (_derive(mot, sel, params), sel, json.dumps(params), _now()))
        return
    attendu = l["guard_hash"]
    if not mot or not compare_digest(
            _derive(mot, l["guard_salt"], json.loads(l["guard_params"])), attendu):
        raise MotDePasseRefuse(
            "Mot de passe refusé : la configuration des canaux n'est pas modifiée.")


# --- écriture ----------------------------------------------------------------

#: Ce qu'un appelant a le droit de poser, et RIEN d'autre. Une liste fermée :
#: accepter un champ inconnu en silence laisserait croire qu'il a été pris.
CHAMPS = ("webhook_enabled", "webhook_url", "webhook_template",
          "smtp_enabled", "smtp_host", "smtp_port", "smtp_tls",
          "smtp_username", "smtp_from", "smtp_to")


def regler(connection: sqlite3.Connection, mot: str, changements: dict,
           actor: str | None = None) -> dict:
    """Modifie la configuration. Exige le mot de passe du §47.3.3.

    **Le gabarit est vérifié À L'ENREGISTREMENT**, jamais à l'envoi : c'est la
    première des trois règles non négociables du §47.3.1, et c'est elle qui
    évite que la panne se découvre le jour de l'incident.
    """
    inconnus = [c for c in changements if c not in CHAMPS]
    if inconnus:
        raise CanalError(
            f"Champs inconnus, refusés : {', '.join(sorted(inconnus))}. "
            f"Les champs réglables sont : {', '.join(CHAMPS)}.")

    gabarit = changements.get("webhook_template")
    if gabarit:
        mauvais = notification.champs_inconnus(str(gabarit))
        if mauvais:
            raise CanalError(
                f"Le gabarit nomme un champ que l'alerte ne publie pas : "
                f"{', '.join(mauvais)}. Champs disponibles : "
                f"{', '.join(notification.CHAMPS)}.")

    avant = etat(connection)
    # Le mot de passe est vérifié DANS la transaction qui écrit : sans cela, le
    # premier usage poserait le garde même si l'écriture échouait ensuite.
    with transaction(connection):
        exiger(connection, mot)
        colonnes = ", ".join(f"{c} = ?" for c in changements)
        if colonnes:
            connection.execute(
                f"UPDATE notify_channels SET {colonnes}, updated_at = ?,"
                " updated_by = ? WHERE id = 1",
                (*changements.values(), _now(), actor))
        audit.record(
            connection, actor, "notify.configure", "ok",
            _resume(avant, changements),
            target_type="forge", target_id="notify",
            # §47.4 : ni l'URL, ni un mot de passe n'entrent dans la charge.
            # Un champ qu'on n'écrit pas au journal ne fuit pas par le journal.
            payload={"champs": sorted(changements)})
    return etat(connection)


def _resume(avant: dict, changements: dict) -> str:
    """La phrase du journal. Elle dit ce qui a CHANGÉ, jamais les valeurs."""
    dits = []
    for canal, cle in (("webhook", "webhook_enabled"), ("SMTP", "smtp_enabled")):
        if cle in changements:
            etait = avant[canal.lower() if canal == "webhook" else "smtp"]["enabled"]
            devient = bool(changements[cle])
            if etait != devient:
                dits.append(f"canal {canal} {'activé' if devient else 'DÉSACTIVÉ'}")
    reste = [c for c in changements if not c.endswith("_enabled")]
    if reste:
        dits.append(f"réglages modifiés : {', '.join(sorted(reste))}")
    return "Configuration des canaux d'alerte : " + ("; ".join(dits) or "aucun changement") + "."
