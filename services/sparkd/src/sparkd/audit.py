"""Journal d'audit : point de passage unique et filtrage.

@spec docs/BACKLOG.md#SPK-15 · docs/DAT.md §21 (Journal d'audit),
      §21.1 (un seul chemin), §21.2 (on caviarde), §21.3 (ce qui est reconnu),
      §21.6 (qui a agi : l'acteur et sa classe), §36.9 (la chaine d'integrite) ·
      docs/BACKLOG.md#SPK-37, docs/BACKLOG.md#SPK-38,
      §21.4 (un payload n'est pas un dépotoir) · docs/SCHEMA.md §9

Aucun autre module n'écrit dans `audit_log`. Un filtre posé à cinq endroits sera
oublié au sixième, et l'oubli ne se verra pas — un journal qui contient trop
ressemble à un journal qui fonctionne.
"""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from hashlib import sha256

from .db import transaction

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

#: Les deux classes du §36.4, rendues verifiables (docs/DAT.md §21.6.1).
HUMAN = "human"
RUNTIME = "runtime"
CLASSES = (HUMAN, RUNTIME)

#: Ce que vaut `actor` quand rien ne l'etablit. PAS « responsable » : affirmer
#: une identite que rien n'etablit est un mensonge, l'ignorance n'en est pas un
#: (docs/DAT.md §21.6.2).
UNKNOWN_ACTOR = "inconnu"

#: Ce que porte `prev_hash` sur la PREMIERE ligne (docs/DAT.md §36.9.1).
#: Une constante litterale, et non la chaine vide : celle-ci se confond avec
#: « colonne oubliee », et la confusion tomberait precisement sur la ligne qui
#: ancre tout le reste.
GENESIS = "GENESE"

#: Champs entrant dans l'empreinte, TRIES, et eux seuls (§36.9.2).
#:
#: `id` n'y figure PAS : il est attribue par la base, et un `ROLLBACK` en
#: consomme sans ecrire. Le faire entrer dans l'empreinte ferait dependre
#: celle-ci d'un compteur que le produit ne controle pas.
CHAINED_FIELDS = (
    "action", "actor", "actor_class", "message", "payload",
    "prev_hash", "result", "target_id", "target_type", "ts",
)

#: Une ligne de point de controle est un DEPART LEGITIME, pas une rupture
#: (§36.9.4). La purge n'est pas livree, mais la verification la connait deja :
#: l'ignorer obligerait a modifier la verification le jour de la purge,
#: c'est-a-dire au pire moment.
CHECKPOINT_ACTION = "audit.checkpoint"

#: Borne de l'identite declaree. Elle arrive d'un en-tete HTTP, donc de
#: l'exterieur : sans borne, une valeur de plusieurs kibioctets entrerait au
#: journal a chaque ligne.
MAX_ACTOR = 200

#: Contexte de la requête en cours. Il vaut `None` hors requête — au démarrage,
#: dans une réconciliation, dans un test.
#:
#: Pourquoi un contexte plutôt que quatorze paramètres à faire descendre : c'est
#: l'argument du §21.1, appliqué à l'acteur. Un paramètre à passer à quatorze
#: endroits sera oublié au quinzième, et l'oubli ne se verra pas — le journal
#: dira « responsable » avec aplomb. Ici, l'omission est IMPOSSIBLE : ce qui
#: n'est pas déclaré vaut `inconnu` et `runtime`.
_REQUETE: ContextVar[tuple[str, str] | None] = ContextVar("acteur_requete", default=None)


@contextmanager
def acting_as(actor: str, actor_class: str = HUMAN):
    """Déclare l'acteur de la requête en cours (docs/DAT.md §21.6.2).

    L'hôte console pose son identité dans un en-tête ; le service l'installe ici
    pour la durée de la requête, et toute écriture au journal la reprend.
    """
    if actor_class not in CLASSES:
        raise ValueError(f"Classe « {actor_class} » inconnue, attendu {CLASSES}.")
    jeton = _REQUETE.set((normalize_actor(actor), actor_class))
    try:
        yield
    finally:
        _REQUETE.reset(jeton)


@contextmanager
def as_runtime(actor: str = "sparkd"):
    """Déclare un ÉVÉNEMENT DU RUNTIME (docs/DAT.md §36.4).

    À ouvrir dans les recalculs globaux — réconciliation de l'ingress,
    redistribution des cœurs, relevés. Ils sont souvent DÉCLENCHÉS par une
    requête humaine, mais ils ne sont pas demandés par elle : sans cette
    déclaration ils hériteraient du contexte et le journal ferait croire qu'une
    personne les a réclamés.
    """
    with acting_as(actor, RUNTIME):
        yield


def canonical(ligne: dict) -> bytes:
    """Sérialisation CANONIQUE d'une entrée (docs/DAT.md §36.9.2).

    C'est le premier piège du §36.5, et il ne se rattrape pas : une vérification
    qui échouerait un an plus tard sans qu'aucune ligne n'ait bougé détruirait la
    confiance dans le dispositif entier. La forme est donc figée — JSON, clés
    triées, séparateurs sans espace, `ensure_ascii`, UTF-8.

    Une valeur absente est sérialisée `null`, jamais omise : omettre une clé
    produirait deux octets différents pour deux lignes équivalentes.

    Toute évolution de cette forme est une RUPTURE de compatibilité, et se traite
    par une nouvelle version portée par un point de contrôle — jamais par un
    changement en place.
    """
    retenu = {champ: ligne.get(champ) for champ in CHAINED_FIELDS}
    return json.dumps(retenu, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def entry_hash(ligne: dict) -> str:
    """Empreinte d'une entrée, `prev_hash` compris.

    C'est ce chaînage qui rend une modification détectable : changer une ligne
    change son empreinte, donc invalide toutes les suivantes.
    """
    return sha256(canonical(ligne)).hexdigest()


def head(connection: sqlite3.Connection) -> tuple[str, int]:
    """Empreinte de la dernière ligne, et longueur de la chaîne.

    L'ordre suivi est celui des `id`. Une ligne antérieure à la migration porte
    une empreinte vide ; la tête vaut alors `GENESIS`, ce qui fait commencer la
    chaîne là où elle peut réellement être prouvée (docs/SCHEMA.md §9.2).
    """
    ligne = connection.execute(
        "SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1"
    ).fetchone()
    longueur = connection.execute(
        "SELECT COUNT(*) AS n FROM audit_log WHERE entry_hash <> ''"
    ).fetchone()["n"]
    if ligne is None or not ligne["entry_hash"]:
        return GENESIS, longueur
    return ligne["entry_hash"], longueur


def current_actor() -> tuple[str, str]:
    """L'acteur en vigueur : celui de la requête, ou le runtime lui-même."""
    return _REQUETE.get() or ("sparkd", RUNTIME)


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


def normalize_actor(actor: object) -> str:
    """Ce qui entre au journal comme identité (docs/DAT.md §21.6.2).

    L'identité arrive d'un en-tête HTTP, donc de l'extérieur : elle est bornée,
    dépouillée de ses sauts de ligne — un journal dont une ligne peut en
    fabriquer d'autres n'est plus lisible — et remplacée par `inconnu` quand
    elle est vide.

    Elle n'est PAS une preuve, et rien ici ne prétend le contraire : qui atteint
    `sparkd` écrit ce qu'il veut dans cet en-tête. C'est une attribution ; la
    preuve viendra de la signature (SPK-40).
    """
    texte = " ".join(str(actor or "").split())
    # ASCII imprimable seulement. Un en-tete HTTP ne transporte pas d'accent —
    # mesure : une valeur accentuee fait echouer la requete a l'encodage, avant
    # d'atteindre le service. Ce qui arriverait par un autre transport est
    # ecarte ici plutot que journalise tel quel.
    texte = "".join(c for c in texte if " " <= c <= "~")
    if not texte:
        return UNKNOWN_ACTOR
    return texte[:MAX_ACTOR]


def record(
    connection: sqlite3.Connection,
    actor: str | None,
    action: str,
    result: str,
    message: str,
    target_type: str | None = None,
    target_id: str | None = None,
    payload: object = None,
    actor_class: str | None = None,
) -> None:
    """Écrit une entrée. **Seul** chemin vers `audit_log` (docs/DAT.md §21.1).

    N'ouvre pas de transaction : l'appelant décide si la trace doit vivre ou
    mourir avec son opération. Un refus, lui, se journalise hors transaction —
    sinon le rollback l'emporterait, et c'est exactement la trace qui sert.

    `actor` et `actor_class` sont résolus ainsi (docs/DAT.md §21.6) :

    - ce que l'appelant passe EXPLICITEMENT l'emporte. C'est ce qui permet à un
      recalcul déclenché par une requête — réconciliation, repondération — de se
      déclarer `runtime` alors qu'une personne est à l'origine de l'appel : le
      §36.4 les classe ainsi, et le contraire ferait croire qu'un humain les a
      demandés ;
    - sinon, l'acteur de la requête en cours, s'il y en a une ;
    - sinon `sparkd` / `runtime`.

    Ce défaut n'est pas une commodité : une écriture qui oublie de se déclarer
    perd une attribution au lieu d'en fabriquer une (docs/SCHEMA.md §9.1).
    """
    if result not in RESULTS:
        raise ValueError(f"Résultat « {result} » inconnu, attendu {RESULTS}.")
    contexte_acteur, contexte_classe = current_actor()
    if actor is None:
        actor = contexte_acteur
    if actor_class is None:
        actor_class = contexte_classe
    if actor_class not in CLASSES:
        raise ValueError(f"Classe « {actor_class} » inconnue, attendu {CLASSES}.")
    ligne = {
        "ts": _now(),
        "actor": normalize_actor(actor),
        "actor_class": actor_class,
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "payload": prepare_payload(payload),
        "result": result,
        # Le message aussi passe par le filtre : il est composé à la main,
        # donc susceptible d'interpoler une valeur sensible.
        "message": (str(redact(message, "message"))
                    if looks_sensitive(None, message) else message),
    }

    # §36.9.3 : la tête se LIT et la ligne s'ÉCRIT sous une même transaction,
    # sinon deux écritures s'intercalent et la chaîne fourche. SQLite n'a qu'un
    # écrivain, ce qui aide, mais ne dispense pas de l'atomicité.
    #
    # Quand une transaction est DÉJÀ ouverte, on n'en ouvre pas une seconde :
    # `record()` n'en ouvrait aucune, et c'est ce qui permet à un refus d'être
    # journalisé HORS transaction — sans quoi le `ROLLBACK` emporterait la trace,
    # exactement le cas où elle sert (§21.1).
    if connection.in_transaction:
        _inserer_chaine(connection, ligne)
    else:
        with transaction(connection):
            _inserer_chaine(connection, ligne)


def _inserer_chaine(connection: sqlite3.Connection, ligne: dict) -> None:
    """Chaîne la ligne à la tête courante, puis l'insère."""
    ligne["prev_hash"], _ = head(connection)
    connection.execute(
        "INSERT INTO audit_log (ts, actor, actor_class, action, target_type,"
        " target_id, payload, result, message, prev_hash, entry_hash)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            ligne["ts"], ligne["actor"], ligne["actor_class"], ligne["action"],
            ligne["target_type"], ligne["target_id"], ligne["payload"],
            ligne["result"], ligne["message"], ligne["prev_hash"],
            entry_hash(ligne),
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


def verify_chain(connection: sqlite3.Connection) -> dict:
    """Parcourt la chaîne et désigne la PREMIÈRE rupture (docs/DAT.md §36.9.5).

    @spec docs/BACKLOG.md#SPK-38 · docs/DAT.md §36.1, §36.5, §36.9.5

    Elle s'arrête à la première : signaler les suivantes serait du bruit, une
    ligne modifiée invalidant mécaniquement toute la suite. Lister mille alertes
    ferait manquer la seule qui compte.

    `reason` distingue deux constats qui n'ont pas la même cause :
    `entry_hash` dit que la ligne ELLE-MÊME a été récrite, `prev_hash` dit qu'une
    ligne a été RETIRÉE OU INSÉRÉE avant elle.

    Ce qu'elle NE fait PAS : contrôler la continuité des `id`. Un trou est normal
    — `AUTOINCREMENT` en consomme à chaque `ROLLBACK`, et le §21 journalise
    délibérément certains refus hors transaction. Une alerte fausse est la
    meilleure façon de faire ignorer les vraies (§36.5).

    Ce qu'elle NE PEUT PAS voir : la troncature. Une chaîne coupée à la fin reste
    parfaitement valide. Seule l'ancre tenue par la console la détecte (§36.9.6).
    """
    attendu = GENESIS
    parcourues = 0
    rupture = None

    for ligne in connection.execute("SELECT * FROM audit_log ORDER BY id"):
        entree = dict(ligne)
        # Les lignes antérieures à la migration ne sont pas chaînées : on les
        # traverse sans les juger (docs/SCHEMA.md §9.2).
        if not entree["entry_hash"]:
            continue
        parcourues += 1

        if entree["prev_hash"] != attendu:
            rupture = {"id": entree["id"], "reason": "prev_hash",
                       "ts": entree["ts"], "action": entree["action"]}
            break
        if entry_hash(entree) != entree["entry_hash"]:
            rupture = {"id": entree["id"], "reason": "entry_hash",
                       "ts": entree["ts"], "action": entree["action"]}
            break

        # Un point de contrôle est un DÉPART LÉGITIME, pas une rupture (§36.9.4).
        attendu = entree["entry_hash"]

    tete, longueur = head(connection)
    return {
        "checked": parcourues,
        "head": None if tete == GENESIS else tete,
        "length": longueur,
        "intact": rupture is None,
        "verified_at": _now(),
        "break": rupture,
    }
