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

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

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
    dossier = os.path.dirname(chemin)
    if dossier:
        os.makedirs(dossier, exist_ok=True)
    # `0600` posé à la CRÉATION et non après : entre les deux, la clé serait
    # lisible par tous, et une seconde suffit.
    fd = os.open(chemin, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                 stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "wb") as f:
        f.write(cle)
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
