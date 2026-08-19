"""L'interrupteur de protection d'un Spark.

@spec docs/BACKLOG.md#SPK-34 · docs/DAT.md §35 (les Sparks protégés), §35.1 (ce
      qu'elle protège et ce qu'elle ne protège pas), §35.2 (portée entière, et
      ses trois exceptions), §35.3 (le mot de passe), §35.4 (lever est un état),
      §35.5 (surface d'API) · docs/SCHEMA.md §4.1

Ce que la protection arrête : le geste **accidentel**. Le mauvais Spark
sélectionné, la ligne cliquée trop vite, le `curl` recopié d'un autre bocal, le
script d'astreinte lancé sur le mauvais nom.

Ce qu'elle n'arrête pas, et le produit ne prétendra jamais le contraire : un
opérateur hostile. Qui détient une clé SSH de l'hôte atteint `sparkd`, qui
détient `root` atteint le fichier du registre (§35.1). C'est un **garde-fou**,
pas un contrôle d'accès.

Elle est néanmoins appliquée côté runtime, et ce n'est pas contradictoire : une
protection que seule l'interface respecterait ne protégerait pas du cas le plus
fréquent — le script, pas l'humain.
"""

from __future__ import annotations

import hmac
import json
import sqlite3
from datetime import datetime, timezone
from hashlib import scrypt
from secrets import token_hex

from .audit import record as _audit

#: Paramètres de coût par défaut. Ils sont ÉCRITS À CÔTÉ de chaque empreinte
#: (docs/SCHEMA.md §4.1) : une empreinte posée avec ceux-ci reste vérifiable le
#: jour où le défaut change, sans invalider l'existant.
DEFAULT_PARAMS = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}

#: Les gestes que la protection refuse (§35.2). La liste est ENTIÈRE et non
#: négociée cas par cas : « on peut démarrer mais pas supprimer » obligerait à
#: justifier chaque exception et produirait exactement les surprises que
#: l'interrupteur est censé supprimer.
GESTES = {
    "command": "une commande de cycle de vie",
    "reconfigure": "une reconfiguration",
    "ingress": "une route publique",
    "ssh-key-grant": "l'octroi d'une clé",
    "snapshot": "un instantané",
}


class ProtectionError(RuntimeError):
    """Racine des refus de ce module."""


class SparkProtected(ProtectionError):
    """`423` — l'écriture vise un Spark protégé (§35.5).

    Le code est DISTINCT des refus d'admission et de transition, qui sont des
    `409` : confondre « impossible maintenant » et « verrouillé exprès » ferait
    chercher une cause qui n'existe pas.
    """

    def __init__(self, spark: str, geste: str) -> None:
        self.spark = spark
        self.geste = geste
        super().__init__(
            f"« {spark} » est protégé : {GESTES.get(geste, geste)} y est refusée. "
            "Lever la protection avec son mot de passe, puis recommencer."
        )


class BadProtectionPassword(ProtectionError):
    """`403` — mot de passe erroné, ou Spark non protégé.

    Le §35.1 assume que ce n'est pas un secret défendu contre un adversaire : la
    distinction est donc portée par le MESSAGE, sans être dissimulée.
    """


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(connection: sqlite3.Connection, name: str) -> sqlite3.Row:
    ligne = connection.execute(
        "SELECT id, name, protected_at, protection_hash, protection_salt,"
        " protection_params FROM spark WHERE name = ?", (name,)
    ).fetchone()
    if ligne is None:
        raise ProtectionError(f"Aucun Spark nommé « {name} ».")
    return ligne


def _derive(password: str, salt_hex: str, params: dict) -> str:
    return scrypt(
        password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
        n=int(params["n"]), r=int(params["r"]), p=int(params["p"]),
        dklen=int(params["dklen"]),
    ).hex()


# --- lecture -----------------------------------------------------------------


def is_protected(connection: sqlite3.Connection, name: str) -> bool:
    """`protected_at` FAIT FOI, jamais la présence d'une empreinte (§4.1)."""
    return _row(connection, name)["protected_at"] is not None


def protected_names(connection: sqlite3.Connection) -> list[str]:
    """Les Sparks protégés, nommés. C'est ce que la révocation doit annoncer."""
    return [
        r["name"] for r in connection.execute(
            "SELECT name FROM spark WHERE protected_at IS NOT NULL ORDER BY name"
        )
    ]


def ensure_writable(connection: sqlite3.Connection, name: str, geste: str) -> None:
    """Barrière posée AVANT toute écriture visant ce Spark (§35.2).

    Elle ne s'applique pas aux recalculs globaux — redistribution des cœurs
    (§7.4 bis), repondération de la tranche (§32.2) : les bloquer ferait échouer
    la création d'un AUTRE Spark parce qu'un troisième est protégé, ce qui serait
    incompréhensible et faux. Ces recalculs n'altèrent ni sa configuration, ni
    son état, ni ses données, et ils n'appellent donc pas cette fonction.
    """
    if is_protected(connection, name):
        raise SparkProtected(name, geste)


# --- écriture ----------------------------------------------------------------


def arm(connection: sqlite3.Connection, name: str, password: str,
        actor: str | None = None) -> dict:
    """Arme la protection. Réarmer accepte un mot de passe DIFFÉRENT (§35.4).

    Le produit ne retient pas l'ancien pour le proposer.
    """
    if not password:
        raise BadProtectionPassword("Un mot de passe est requis pour armer la protection.")
    ligne = _row(connection, name)
    if ligne["protected_at"] is not None:
        raise ProtectionError(f"« {name} » est déjà protégé.")

    sel = token_hex(16)
    params = dict(DEFAULT_PARAMS)
    connection.execute(
        "UPDATE spark SET protected_at = ?, protection_hash = ?,"
        " protection_salt = ?, protection_params = ?, updated_at = ?"
        " WHERE id = ?",
        (_now(), _derive(password, sel, params), sel, json.dumps(params),
         _now(), ligne["id"]),
    )
    # Le mot de passe n'entre PAS dans la charge : le journal enregistre la
    # tentative, son résultat et sa date, jamais sa valeur (§35.3).
    _audit(connection, actor, "spark.protect", "ok",
           f"Protection armée sur « {name} ».",
           target_type="spark", target_id=ligne["id"], payload={"spark": name})
    return status(connection, name)


def disarm(connection: sqlite3.Connection, name: str, password: str,
           actor: str | None = None) -> dict:
    """Lève la protection, DURABLEMENT (§35.4).

    Pas de fenêtre de temps : un déverrouillage de quelques minutes rendrait le
    comportement du produit dépendant de l'heure, et pousserait à travailler vite
    pour « ne pas rater la fenêtre » — l'inverse du but recherché.

    Une tentative refusée est journalisée. Il n'y a PAS de verrouillage après N
    échecs (§35.3) : un compte à rebours ne gênerait que le responsable légitime,
    l'attaquant qu'il repousserait ayant déjà de quoi contourner la protection
    tout entière. C'est la trace qui a de la valeur ici, pas l'entrave.
    """
    ligne = _row(connection, name)
    if ligne["protected_at"] is None:
        _audit(connection, actor, "spark.unprotect", "denied",
               f"« {name} » n'est pas protégé.",
               target_type="spark", target_id=ligne["id"], payload={"spark": name})
        raise BadProtectionPassword(f"« {name} » n'est pas protégé.")

    params = json.loads(ligne["protection_params"])
    attendu = ligne["protection_hash"]
    # Comparaison à temps constant : elle ne coûte rien et évite d'écrire une
    # comparaison naïve qu'une relecture prendrait pour une négligence.
    if not hmac.compare_digest(_derive(password, ligne["protection_salt"], params), attendu):
        _audit(connection, actor, "spark.unprotect", "denied",
               f"Mot de passe refusé sur « {name} ».",
               target_type="spark", target_id=ligne["id"], payload={"spark": name})
        raise BadProtectionPassword(
            f"Mot de passe erroné : la protection de « {name} » reste armée."
        )

    connection.execute(
        "UPDATE spark SET protected_at = NULL, protection_hash = NULL,"
        " protection_salt = NULL, protection_params = NULL, updated_at = ?"
        " WHERE id = ?", (_now(), ligne["id"]),
    )
    _audit(connection, actor, "spark.unprotect", "ok",
           f"Protection levée sur « {name} ».",
           target_type="spark", target_id=ligne["id"], payload={"spark": name})
    return status(connection, name)


def status(connection: sqlite3.Connection, name: str) -> dict:
    """Ce que l'API publie : un booléen et une date, JAMAIS l'empreinte."""
    ligne = _row(connection, name)
    return {"name": name, "protected": ligne["protected_at"] is not None,
            "protected_at": ligne["protected_at"]}
