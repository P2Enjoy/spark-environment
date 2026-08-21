"""Le magasin d'environnement d'un Spark : variables et secrets.

@spec docs/BACKLOG.md#SPK-58 · docs/DAT.md §43 (l'environnement d'un Spark),
      §43.3 (la différence est DÉCLARÉE, jamais devinée), §43.4 (ce que
      « secret » ne veut PAS dire), §43.5.1 (qui déchiffre), §43.6 (général
      d'abord, surcharge ensuite), §43.9 (le contrat vérifiable) ·
      docs/SCHEMA.md §10 ter

Ce module tient le MAGASIN, et rien d'autre : il ne pose aucun fichier dans une
cellule. La matérialisation est la tranche suivante du §43.9.6, et les séparer
garde ici une seule question — que vaut l'environnement d'un Spark — de celle
de savoir où l'écrire.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets as _alea
import sqlite3
import stat
from base64 import b64decode, b64encode
from dataclasses import dataclass
from datetime import UTC, datetime

from secrets import token_hex

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import audit

#: §43.9.1 : la grammaire du shell. Un nom qui ne s'exporte pas produirait un
#: fichier qu'`env_file:` refuse, et la panne se lirait chez le locataire, loin
#: du geste qui l'a causée.
NOM = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")

#: Longueur de l'empreinte rendue à l'écran (§43.9.3).
EMPREINTE = 12

#: AES-256 : 32 octets de clé, 12 octets de nonce.
TAILLE_CLE = 32
TAILLE_NONCE = 12

PORTEES = ("forge", "spark")


class EnvError(ValueError):
    """Geste d'environnement refusé."""


class CleError(RuntimeError):
    """La clé de chiffrement est inutilisable, et cela ne se contourne pas."""


def _maintenant() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def charger_cle(chemin: str) -> bytes:
    """Rend la clé de la Forge, en la CRÉANT si elle manque (§43.9.2).

    Créer ce qui manque et refuser ce qui est cassé ne sont pas la même
    politique, et les confondre coûterait tous les secrets : une clé absente est
    une Forge neuve, une clé illisible ou de mauvaise taille est un incident. La
    fabriquer par-dessus rendrait les secrets existants indéchiffrables **en
    silence** — le pire des cas, puisque le registre continuerait de prétendre
    les porter.
    """
    if os.path.exists(chemin):
        try:
            with open(chemin, "rb") as f:
                brut = f.read()
        except OSError as erreur:
            raise CleError(
                f"La clé de chiffrement « {chemin} » existe mais ne se lit pas : "
                f"{erreur}. Les secrets d'environnement restent inaccessibles "
                "tant que ce n'est pas réglé."
            ) from erreur
        # Le fichier porte les 32 octets BRUTS, et rien d'autre. Accepter aussi
        # une forme encodée obligerait à deviner laquelle on lit, et un fichier
        # corrompu passerait pour l'autre forme.
        if len(brut) != TAILLE_CLE:
            raise CleError(
                f"La clé de chiffrement « {chemin} » fait {len(brut)} octets au "
                f"lieu de {TAILLE_CLE}. Elle n'est PAS remplacée : la remplacer "
                "rendrait tous les secrets déjà écrits indéchiffrables."
            )
        return brut

    cle = _alea.token_bytes(TAILLE_CLE)
    try:
        dossier = os.path.dirname(chemin)
        if dossier:
            os.makedirs(dossier, exist_ok=True)
        # `0600` posé à la CRÉATION et non après : entre les deux, la clé serait
        # lisible par tous, et une seconde suffit.
        fd = os.open(chemin, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                     stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "wb") as f:
            f.write(cle)
    except OSError as erreur:
        # Un refus du système ne doit pas remonter en trace : l'appelant a
        # besoin de savoir que les SECRETS sont indisponibles, pas de lire un
        # errno au milieu d'une pile.
        raise CleError(
            f"La clé de chiffrement « {chemin} » n'a pas pu être créée : "
            f"{erreur}. Les secrets d'environnement restent indisponibles."
        ) from erreur
    return cle


def chiffrer(cle: bytes, nom: str, valeur: str) -> str:
    """Chiffre une valeur en AES-256-GCM, le NOM en donnée associée (§43.9.2).

    Lier le nom au chiffré n'est pas une précaution de principe : sans lui, un
    chiffré déplacé d'une variable à une autre se déchiffrerait, et un registre
    modifiable permettrait de servir `STRIPE_API_KEY` sous le nom `LOG_LEVEL`.
    """
    nonce = _alea.token_bytes(TAILLE_NONCE)
    scelle = AESGCM(cle).encrypt(nonce, valeur.encode("utf-8"), nom.encode("utf-8"))
    return b64encode(nonce + scelle).decode("ascii")


def dechiffrer(cle: bytes, nom: str, chiffre: str) -> str:
    """Rend la valeur en clair. C'est `sparkd` qui déchiffre, et lui seul (§43.5.1)."""
    brut = b64decode(chiffre, validate=True)
    try:
        clair = AESGCM(cle).decrypt(brut[:TAILLE_NONCE], brut[TAILLE_NONCE:],
                                    nom.encode("utf-8"))
    except InvalidTag as erreur:
        raise CleError(
            f"Le secret « {nom} » ne se déchiffre pas : la clé de la Forge n'est "
            "pas celle qui l'a écrit, ou le registre a été modifié."
        ) from erreur
    return clair.decode("utf-8")


def empreinte(cle: bytes, valeur: str) -> str:
    """Un HMAC, JAMAIS un hachage nu (§43.9.3).

    Un préfixe de SHA-256 nu livrerait les secrets faibles — `admin`,
    `changeme`, un jeton court — par force brute en quelques secondes, la
    fonction étant publique et sans clé. Avec la clé de la Forge, l'empreinte
    reste comparable entre deux Sparks de la même Forge, ce que le §43.3
    demande, et ne se retourne pas.
    """
    return hmac.new(cle, valeur.encode("utf-8"), hashlib.sha256).hexdigest()[:EMPREINTE]


@dataclass(frozen=True)
class Entree:
    """Ce que l'API rend d'une entrée. La valeur d'un secret n'y est PAS."""

    name: str
    is_secret: bool
    #: `None` pour un secret : il n'est jamais rendu, ni en lecture, ni en
    #: aperçu, ni dans un export (§43.3).
    value: str | None
    fingerprint: str | None
    scope: str
    #: `forge`, `spark` ou `overridden` (§43.9.4).
    origin: str
    updated_at: str


def _valider(nom: str) -> str:
    if not NOM.match(nom or ""):
        raise EnvError(
            f"« {nom} » n'est pas un nom de variable exportable : il faut une "
            "lettre ou un souligné, puis des lettres, chiffres et soulignés "
            "(docs/DAT.md §43.9.1)."
        )
    return nom


def poser(connection: sqlite3.Connection, cle: bytes, scope: str, spark_id: str | None,
          nom: str, valeur: str, *, secret: bool = False,
          actor: str | None = None) -> Entree:
    """Écrit une entrée, ou remplace celle qui porte déjà ce nom.

    Le geste entre au journal SANS la valeur — jamais, même caviardée, même
    pour une variable ordinaire (§43.3). Seul le nom y figure, avec le geste et
    sa date : c'est ce qui rend le journal partageable.
    """
    if scope not in PORTEES:
        raise EnvError(f"Portée inconnue : {scope!r}.")
    if (scope == "forge") != (spark_id is None):
        raise EnvError(
            "Une entrée de la Forge ne vise aucun Spark, et une entrée de Spark "
            "en vise un : les deux ne se mélangent pas (docs/DAT.md §43.9.1).")
    _valider(nom)

    chiffre = chiffrer(cle, nom, valeur) if secret else None
    trace = empreinte(cle, valeur) if secret else None
    quand = _maintenant()

    ou = "spark_id IS NULL" if spark_id is None else "spark_id = ?"
    args = [scope] if spark_id is None else [scope, spark_id]
    existante = connection.execute(
        f"SELECT id FROM env_entry WHERE scope = ? AND {ou} AND name = ?",
        (*args, nom)).fetchone()

    if existante:
        connection.execute(
            "UPDATE env_entry SET is_secret = ?, value = ?, value_enc = ?, "
            "fingerprint = ?, updated_at = ? WHERE id = ?",
            (int(secret), None if secret else valeur, chiffre, trace, quand,
             existante["id"]))
    else:
        connection.execute(
            "INSERT INTO env_entry (id, scope, spark_id, name, is_secret, value, "
            "value_enc, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (token_hex(8), scope, spark_id, nom, int(secret),
             None if secret else valeur, chiffre, trace, quand))

    audit.record(
        connection, actor, "env.set", "ok",
        f"{'Secret' if secret else 'Variable'} « {nom} » "
        f"{'remplacé' if existante else 'posé'} "
        f"({'la Forge' if scope == 'forge' else 'ce Spark'}).",
        target_type="spark" if spark_id else "forge", target_id=spark_id,
        # AUCUNE valeur, et pas même caviardée : ce qui n'entre pas ne fuit pas.
        payload={"name": nom, "scope": scope, "is_secret": secret})

    return Entree(name=nom, is_secret=secret, value=None if secret else valeur,
                  fingerprint=trace, scope=scope, origin=scope, updated_at=quand)


def retirer(connection: sqlite3.Connection, scope: str, spark_id: str | None,
            nom: str, actor: str | None = None) -> bool:
    """Retire une entrée. Rend `False` si elle n'existait pas.

    Ne pas trouver n'est pas une erreur : c'est l'état voulu qui compte, et
    l'état voulu est « cette variable n'est pas définie » dans les deux cas
    (§14.5).
    """
    ou = "spark_id IS NULL" if spark_id is None else "spark_id = ?"
    args = [scope] if spark_id is None else [scope, spark_id]
    curseur = connection.execute(
        f"DELETE FROM env_entry WHERE scope = ? AND {ou} AND name = ?",
        (*args, nom))
    if not curseur.rowcount:
        return False
    audit.record(
        connection, actor, "env.unset", "ok",
        f"Entrée « {nom} » retirée ({'la Forge' if scope == 'forge' else 'ce Spark'}).",
        target_type="spark" if spark_id else "forge", target_id=spark_id,
        payload={"name": nom, "scope": scope})
    return True


def _ligne(rangee: sqlite3.Row, origine: str) -> Entree:
    return Entree(
        name=rangee["name"], is_secret=bool(rangee["is_secret"]),
        value=None if rangee["is_secret"] else rangee["value"],
        fingerprint=rangee["fingerprint"], scope=rangee["scope"],
        origin=origine, updated_at=rangee["updated_at"])


def lister(connection: sqlite3.Connection, spark_id: str | None = None) -> list[Entree]:
    """L'environnement TEL QU'IL S'APPLIQUE, avec l'origine de chaque valeur.

    Sans `spark_id`, rend le seul jeu de la Forge. Avec, rend le jeu résolu :
    la surcharge se fait **nom par nom** (§43.6), jamais jeu par jeu — surcharger
    `SMTP_HOST` sur un Spark ne doit pas lui faire perdre le `SMTP_PORT` hérité.
    """
    forge = {r["name"]: r for r in connection.execute(
        "SELECT * FROM env_entry WHERE scope = 'forge' ORDER BY name")}
    if spark_id is None:
        return [_ligne(r, "forge") for r in forge.values()]

    propres = {r["name"]: r for r in connection.execute(
        "SELECT * FROM env_entry WHERE scope = 'spark' AND spark_id = ? ORDER BY name",
        (spark_id,))}

    resolu: list[Entree] = []
    for nom in sorted(set(forge) | set(propres)):
        if nom in propres:
            # `overridden` et `spark` ne se confondent pas : le premier dit qu'une
            # valeur de la Forge est MASQUÉE, donc qu'on la cherchera en vain là
            # où elle est écrite.
            resolu.append(_ligne(propres[nom], "overridden" if nom in forge else "spark"))
        else:
            resolu.append(_ligne(forge[nom], "forge"))
    return resolu


def resoudre(connection: sqlite3.Connection, cle: bytes, spark_id: str) -> dict[str, dict[str, str]]:
    """Le CONTENU des deux fichiers du §43.5.2, en clair, prêt à être posé.

    Deux jeux et non un : les secrets vont dans le fichier volatil de `/run`,
    qui n'entre dans aucun instantané. Avec les secrets dans le fichier
    persistant, restaurer un instantané ancien ressusciterait un secret révoqué,
    en silence, pendant que le registre le croirait remplacé.

    C'est ICI que les valeurs redeviennent lisibles, et nulle part ailleurs
    (§43.5.1) : ce que cette fonction rend part vers la cellule, jamais vers
    l'API ni vers l'écran.
    """
    variables: dict[str, str] = {}
    secrets: dict[str, str] = {}
    for entree in lister(connection, spark_id):
        rangee = connection.execute(
            "SELECT value, value_enc FROM env_entry WHERE scope = ? AND "
            + ("spark_id IS NULL" if entree.scope == "forge" else "spark_id = ?")
            + " AND name = ?",
            (entree.scope, entree.name) if entree.scope == "forge"
            else (entree.scope, spark_id, entree.name)).fetchone()
        if entree.is_secret:
            secrets[entree.name] = dechiffrer(cle, entree.name, rangee["value_enc"])
        else:
            variables[entree.name] = rangee["value"]
    return {"variables": variables, "secrets": secrets}


#: §43.1 et §43.5.2 : deux fichiers à chemins stables, désignés explicitement par
#: le locataire dans son `env_file:`. Le second vit dans un tmpfs, donc il
#: n'entre dans aucun instantané — c'est ce qui empêche une restauration de
#: ressusciter un secret révoqué.
FICHIER_VARIABLES = "/etc/spark/env"
FICHIER_SECRETS = "/run/spark/secrets"
#: Le confort du §43.1, nommé comme tel : il sert au `docker compose up` tapé à
#: la main, et n'existe PAS pour ce que systemd démarre (mesure D du §43.0).
FICHIER_PROFIL = "/etc/profile.d/spark-env.sh"


def citer(valeur: str) -> str:
    """Encode une valeur pour `env_file:` de Compose (§43.9.7, MESURÉ).

    L'analyseur de Compose n'est PAS littéral : sans guillemets, `abc$def`
    arrive comme `abc`, les guillemets sont retirés et les blancs de tête et de
    fin rognés. Un mot de passe contenant `$` serait donc tronqué en silence.

    L'apostrophe simple ne sauve pas : l'idiome `'ab'\\''cd'` fait échouer la
    lecture du FICHIER ENTIER, donc une seule apostrophe dans un mot de passe
    viderait tout l'environnement de la pile.

    L'ordre des remplacements compte : échapper la barre oblique en dernier
    doublerait celles que les autres échappements viennent d'introduire.
    """
    sortie = (valeur.replace("\\", "\\\\")
                    .replace('"', '\\"')
                    .replace("$", "\\$")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r")
                    .replace("\t", "\\t"))
    return f'"{sortie}"'


def _citer_shell(valeur: str) -> str:
    """Encode pour un script de SHELL — grammaire différente (§43.9.7).

    Le shell n'a pas d'échappement à l'intérieur d'apostrophes simples : on
    ferme, on insère un guillemet échappé, on rouvre. C'est exactement l'idiome
    que Compose refuse, et c'est pourquoi les deux fichiers ne partagent pas
    leur encodage.
    """
    return "'" + valeur.replace("'", "'\\''") + "'"


def _lignes(entete: str, valeurs: dict[str, str]) -> str:
    return entete + "".join(
        f"{nom}={citer(valeurs[nom])}\n" for nom in sorted(valeurs))


def fichiers(connection: sqlite3.Connection, cle: bytes,
             spark_id: str) -> dict[str, str]:
    """Le CONTENU des trois fichiers à poser, depuis l'état voulu.

    Régénérés EN ENTIER, jamais complétés : c'est ce qui fait qu'un retrait
    retire réellement (§43.2, comme `authorized_keys` au §17.1).
    """
    rendu = resoudre(connection, cle, spark_id)
    avis = ("# Écrit par sparkd depuis le registre. Toute modification à la main\n"
            "# sera perdue à la prochaine application (docs/DAT.md §43.2).\n")
    # Le fichier de confort ne porte AUCUN secret, et ce n'est pas une omission :
    # il vit dans `/etc`, donc sur le jeu de données, donc DANS les instantanés.
    # Y écrire les secrets annulerait exactement ce que le §43.5.2 protège — une
    # restauration ancienne ressusciterait un secret révoqué, par ce fichier-là.
    profil = (
        "# Écrit par sparkd. CONFORT seulement : ce fichier sert au shell de\n"
        "# connexion, et PAS à ce que systemd démarre (docs/DAT.md §43.0, D).\n"
        "# La garantie, c'est `env_file:` (docs/DAT.md §43.1).\n"
        "# Les SECRETS n'y sont pas : ce fichier entre dans les instantanés\n"
        "# (docs/DAT.md §43.5.2). Ils ne vivent que dans /run/spark/secrets.\n"
    ) + "".join(
        f"export {nom}={_citer_shell(v)}\n"
        for nom, v in sorted(rendu["variables"].items()))
    return {
        FICHIER_VARIABLES: _lignes(avis, rendu["variables"]),
        FICHIER_SECRETS: _lignes(avis, rendu["secrets"]),
        FICHIER_PROFIL: profil,
    }
