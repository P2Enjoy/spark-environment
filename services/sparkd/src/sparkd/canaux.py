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
et la colonne `smtp_password_secret` porte le mot de passe SMTP SCELLÉ (AES-256-GCM,
clé de la Forge) — jamais en clair, et jamais dans le catalogue du §43, dont les
entrées de portée Forge sont proposées aux Sparks (DAT §47.3.2 point 4).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from hashlib import scrypt
from secrets import compare_digest, token_hex

from . import audit, environnement, notification
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


#: Le nom lié au chiffré comme donnée associée (§47.3.2 point 4) : un chiffré déplacé
#: vers une autre colonne ne se déchiffrerait pas.
NOM_SECRET_SMTP = "notify.smtp.password"


def sceller(cle: bytes, mot_de_passe: str) -> str:
    """Le mot de passe SMTP, scellé avec la clé de la Forge."""
    return environnement.chiffrer(cle, NOM_SECRET_SMTP, mot_de_passe)


def smtp_actif(connection: sqlite3.Connection,
               cle: "bytes | Callable[[], bytes] | None") -> tuple["notification.ReglageSmtp | None", bool]:
    """Le réglage à employer, et si son mot de passe est ILLISIBLE.

    `(None, False)` si le canal est désactivé ou incomplet : même chose qu'absent, comme
    pour le webhook. `illisible` vaut vrai quand un mot de passe est au registre mais ne
    se déchiffre pas (clé indisponible ou changée) : le canal se dit alors mal configuré,
    plutôt que d'essayer sans compte et d'échouer sans dire pourquoi (§14.6).
    """
    l = _ligne(connection)
    if not l["smtp_enabled"]:
        return (None, False)
    hote = (l["smtp_host"] or "").strip()
    if not (hote and l["smtp_port"] and l["smtp_from"] and l["smtp_to"]):
        return (None, False)
    try:
        destinataires = notification.adresses_valides(l["smtp_to"])
    except ValueError:
        return (None, False)
    compte = (l["smtp_username"] or "").strip() or None
    mot, illisible = None, False
    if compte and l["smtp_password_secret"]:
        try:
            # La clé ne se charge que s'il y a un secret à ouvrir : charger la clé CRÉE le fichier
            # au premier usage, et une Forge sans SMTP n'a pas à en acquérir une au démarrage.
            valeur_cle = cle() if callable(cle) else cle
            if valeur_cle is None:
                raise environnement.CleError("clé indisponible")
            mot = environnement.dechiffrer(valeur_cle, NOM_SECRET_SMTP, l["smtp_password_secret"])
        except (environnement.CleError, ValueError):
            illisible = True
    elif compte:
        illisible = True
    return (notification.ReglageSmtp(
        host=hote, port=int(l["smtp_port"]), tls=l["smtp_tls"] or "starttls",
        sender=l["smtp_from"], recipients=destinataires, username=compte, password=mot,
    ), illisible)


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

#: SPK-62 · §47.3.2 point 4 : le mot de passe SMTP se POSE par ce champ, mais ne se LIT jamais.
#: Il n'est pas une colonne : il est scellé, puis rangé dans `smtp_password_secret`.
CHAMP_SECRET = "smtp_password"


def regler(connection: sqlite3.Connection, mot: str, changements: dict,
           actor: str | None = None, *, cle: bytes | None = None) -> dict:
    """Modifie la configuration. Exige le mot de passe du §47.3.3.

    **Le gabarit est vérifié À L'ENREGISTREMENT**, jamais à l'envoi : c'est la
    première des trois règles non négociables du §47.3.1, et c'est elle qui
    évite que la panne se découvre le jour de l'incident.
    """
    inconnus = [c for c in changements if c not in CHAMPS and c != CHAMP_SECRET]
    if inconnus:
        raise CanalError(
            f"Champs inconnus, refusés : {', '.join(sorted(inconnus))}. "
            f"Les champs réglables sont : {', '.join(CHAMPS)}, {CHAMP_SECRET}.")

    gabarit = changements.get("webhook_template")
    if gabarit:
        mauvais = notification.champs_inconnus(str(gabarit))
        if mauvais:
            raise CanalError(
                f"Le gabarit nomme un champ que l'alerte ne publie pas : "
                f"{', '.join(mauvais)}. Champs disponibles : "
                f"{', '.join(notification.CHAMPS)}.")

    # SPK-62 · §47.3.2 : le SMTP est validé EN ENTIER, à l'enregistrement — jamais le jour de l'incident.
    changements = _valider_smtp(connection, changements, cle)

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
            payload={"champs": sorted(
                CHAMP_SECRET if c == "smtp_password_secret" else c for c in changements)})
    return etat(connection)


def _valider_smtp(connection: sqlite3.Connection, changements: dict,
                  cle: bytes | None) -> dict:
    """Normalise les champs SMTP et valide la configuration RÉSULTANTE (§47.3.2).

    Rend les `changements` prêts à écrire : `smtp_password` y devient la colonne
    `smtp_password_secret`, scellée. Lève `CanalError` en disant quoi corriger.
    """
    if not any(c.startswith("smtp_") for c in changements):
        return dict(changements)
    sortie = dict(changements)
    courant = _ligne(connection)

    def valeur(nom: str):
        return sortie[nom] if nom in sortie else courant[nom]

    # --- chaque champ posé est vérifié en lui-même, activé ou non -----------------------
    if "smtp_host" in sortie:
        hote = str(sortie["smtp_host"] or "").strip()
        if hote and not notification.HOTE.match(hote):
            raise CanalError(f"« {hote} » n'est pas un nom d'hôte : ni schéma, ni chemin, ni port ici.")
        sortie["smtp_host"] = hote or None
    if "smtp_port" in sortie:
        brut = sortie["smtp_port"]
        if brut in (None, ""):
            sortie["smtp_port"] = None
        else:
            try:
                port = int(brut)
            except (TypeError, ValueError):
                raise CanalError(f"Le port « {brut} » n'est pas un nombre.") from None
            if not 1 <= port <= 65535:
                raise CanalError(f"Le port {port} n'existe pas : il va de 1 à 65535.")
            sortie["smtp_port"] = port
    if "smtp_tls" in sortie:
        mode = str(sortie["smtp_tls"] or "").strip()
        if mode and mode not in notification.MODES_TLS:
            raise CanalError(f"Le mode TLS « {mode} » est inconnu : "
                             f"{', '.join(notification.MODES_TLS)}.")
        sortie["smtp_tls"] = mode or None
    if "smtp_username" in sortie:
        sortie["smtp_username"] = str(sortie["smtp_username"] or "").strip() or None
    if "smtp_from" in sortie:
        expediteur = str(sortie["smtp_from"] or "").strip()
        if expediteur:
            try:
                if len(notification.adresses_valides(expediteur)) != 1:
                    raise ValueError("une seule adresse d'envoi")
            except ValueError as erreur:
                raise CanalError(f"Adresse d'envoi refusée : {erreur}.") from None
        sortie["smtp_from"] = expediteur or None
    if "smtp_to" in sortie:
        destinataires = str(sortie["smtp_to"] or "").strip()
        if destinataires:
            try:
                notification.adresses_valides(destinataires)
            except ValueError as erreur:
                raise CanalError(f"Destinataires refusés : {erreur}.") from None
        sortie["smtp_to"] = destinataires or None
    if "smtp_enabled" in sortie:
        sortie["smtp_enabled"] = 1 if sortie["smtp_enabled"] else 0

    # --- le mot de passe : posé, conservé, ou effacé avec le compte ---------------------
    nouveau = str(changements.get(CHAMP_SECRET) or "")
    sortie.pop(CHAMP_SECRET, None)
    compte = valeur("smtp_username")
    if "smtp_username" in sortie and not sortie["smtp_username"]:
        # Pas de compte : pas d'authentification, donc rien à garder (§47.3.2 point 3).
        sortie["smtp_password_secret"] = None
    elif nouveau:
        if cle is None:
            raise CanalError("La clé de chiffrement de la Forge est indisponible : le mot de "
                             "passe SMTP ne peut pas être enregistré.")
        sortie["smtp_password_secret"] = sceller(cle, nouveau)

    # --- la configuration résultante ----------------------------------------------------
    mode = valeur("smtp_tls")
    compte = valeur("smtp_username")
    secret = sortie["smtp_password_secret"] if "smtp_password_secret" in sortie \
        else courant["smtp_password_secret"]
    if compte and mode == "none":
        raise CanalError("Un mot de passe ne part pas en clair : un compte exige le mode "
                         "starttls ou tls. Retirez le compte, ou choisissez un mode chiffré.")
    if valeur("smtp_enabled"):
        manque = [libelle for nom, libelle in (
            ("smtp_host", "le serveur"), ("smtp_port", "le port"), ("smtp_tls", "le mode TLS"),
            ("smtp_from", "l'adresse d'envoi"), ("smtp_to", "la ou les adresses de destination"))
            if not valeur(nom)]
        if manque:
            raise CanalError(f"Le canal SMTP ne peut pas veiller : il manque {', '.join(manque)}.")
        if compte and not secret:
            raise CanalError("Un compte est renseigné sans mot de passe : saisissez-le, ou "
                             "retirez le compte.")
    return sortie


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
