"""Catalogue d'images système, et son relevé.

@spec docs/BACKLOG.md#SPK-32 · docs/DAT.md §33 (le catalogue d'images),
      §33.2 (tenu par le registre), §33.3 (la vérification est un relevé),
      §33.4 (ce que le catalogue n'est pas), §33.5 (l'écran de création) ·
      docs/SCHEMA.md · §14.2

`spark.image` était un texte libre : le seul contrôle portait sur le dépôt, pas
sur l'alias. `images:debian/31` passait donc tous les contrôles locaux, la ligne
du registre était écrite, la ressource comptée, et le refus ne venait qu'à
`apply`. Une faute de frappe coûtait une ligne morte et une part de pool
immobilisée.

**Le catalogue rend cette erreur connaissable avant d'écrire quoi que ce soit.**

Ce n'est pas un registry (§33.4) : il ne stocke, ne construit et ne publie aucune
image. Il tient une liste de références *système*.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from secrets import token_hex

import httpx

from . import audit
from .audit import record as _audit
from .db import transaction

VERIFIED = "verified"
MISSING = "missing"
UNKNOWN = "unknown"

#: Dépôts connus, et l'URL de leur index simplestreams. Le catalogue ne vérifie
#: que ce qu'il sait interroger : un dépôt absent d'ici rend `unknown`, jamais
#: `missing` — ne pas savoir n'est pas savoir que ce n'est pas là (§33.3).
REMOTES = {
    "images": "https://images.linuxcontainers.org",
}

#: Références pré-renseignées. Elles ne sont PAS marquées vérifiées d'avance :
#: l'état vient du relevé, jamais d'une déclaration.
DEFAULTS = (
    ("images:debian/13", "Debian 13 « trixie »", "images", "debian/13", True),
    ("images:debian/12", "Debian 12 « bookworm »", "images", "debian/12", False),
    ("images:ubuntu/24.04", "Ubuntu 24.04 LTS", "images", "ubuntu/24.04", False),
    ("images:alpine/3.21", "Alpine 3.21", "images", "alpine/3.21", False),
)


#: SPK-76 · §42.9.6 : ce que l'amorçage sait servir, dit PAR le catalogue.
#: Le §33 propose une image, le §42 sait ou non l'amorcer, et les deux ne se
#: parlaient pas — c'est ce silence qui a produit `alpine-demo`.
#:
#: Ce n'est **pas** un filtre : l'entrée reste choisissable. Le produit sert des
#: cellules, pas seulement des cellules amorçables, et un locataire qui sait ce
#: qu'il fait peut vouloir une Alpine. Mais l'écran de création le DIT avant, au
#: lieu de le laisser découvrir à l'amorçage.
FAMILLES_AMORCABLES = ("debian", "ubuntu")


def amorcable(alias: str) -> bool:
    """L'amorçage sait-il équiper une cellule issue de cet alias ? (§42.9.6)

    La vérité reste ce que la CELLULE déclare dans `/etc/os-release` : c'est le
    §42.9 qui décide, et lui seul. Ceci n'est qu'une annonce faite avant la
    création, sur la seule information qu'on ait alors — le nom de l'image.
    """
    return (alias or "").split("/", 1)[0].strip().lower() in FAMILLES_AMORCABLES


class ImageError(RuntimeError):
    """La référence demandée n'est pas utilisable."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- lecture -----------------------------------------------------------------


def listing(connection: sqlite3.Connection) -> list[dict]:
    """Tout le catalogue, y compris ce qui n'est pas proposable.

    Une entrée `missing` ou `unknown` reste **visible** : la faire disparaître
    ferait croire qu'elle n'a jamais existé (§33.3).
    """
    return [
        dict(r)
        for r in connection.execute(
            "SELECT * FROM image_catalog ORDER BY is_default DESC, label"
        )
    ]


def selectable(connection: sqlite3.Connection) -> list[dict]:
    """Ce que la création accepte : les entrées vérifiées, et elles seules."""
    return [e for e in listing(connection) if e["state"] == VERIFIED]


def by_reference(connection: sqlite3.Connection, reference: str) -> dict | None:
    ligne = connection.execute(
        "SELECT * FROM image_catalog WHERE reference = ?", (reference,)
    ).fetchone()
    return dict(ligne) if ligne else None


def ensure_selectable(connection: sqlite3.Connection, reference: str) -> dict:
    """Refuse AVANT que la ligne du Spark ne soit écrite (§33.2, §14.2).

    C'est tout l'objet de l'unité : le refus arrive au moment où il ne coûte
    rien, au lieu d'arriver à `apply` en laissant un Spark en `error` dont les
    quotas restent engagés.
    """
    entree = by_reference(connection, reference)
    if entree is None:
        connues = [e["reference"] for e in selectable(connection)]
        raise ImageError(
            f"L'image « {reference} » n'est pas au catalogue. "
            + (f"Disponibles : {', '.join(connues)}." if connues
               else "Le catalogue ne contient aucune image vérifiée.")
        )
    if entree["state"] != VERIFIED:
        raise ImageError(
            f"L'image « {reference} » est au catalogue mais son dernier relevé "
            f"la donne « {entree['state']} »"
            + (f" ({entree['detail']})" if entree["detail"] else "")
            + ". Relever le catalogue avant de l'employer."
        )
    return entree


# --- écriture ----------------------------------------------------------------


def add(
    connection: sqlite3.Connection,
    reference: str,
    label: str,
    architecture: str = "amd64",
    actor: str | None = None,
) -> dict:
    """Ajoute une référence. Geste EXPLICITE, hors formulaire de création (§33.2).

    L'entrée naît `unknown` : elle ne devient utilisable qu'après un relevé. Une
    référence déclarée vérifiée par celui qui l'ajoute ne prouverait rien.
    """
    depot, _, alias = reference.partition(":")
    if not depot or not alias:
        raise ImageError(
            f"Référence « {reference} » illisible : forme attendue « dépôt:alias »."
        )
    if not label.strip():
        raise ImageError("Une image doit porter un libellé lisible.")

    identifiant = token_hex(12)
    with transaction(connection):
        if by_reference(connection, reference):
            raise ImageError(f"« {reference} » est déjà au catalogue.")
        connection.execute(
            "INSERT INTO image_catalog (id, reference, label, remote, alias,"
            " architecture, state, detail, is_default, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?)",
            (identifiant, reference, label.strip(), depot, alias,
             architecture, UNKNOWN, _now()),
        )
        _audit(connection, actor, "image.add", "ok",
               f"Image « {reference} » ajoutée au catalogue, à relever.",
               target_type="image", target_id=identifiant,
               payload={"reference": reference})
    return by_reference(connection, reference)


def seed_defaults(connection: sqlite3.Connection) -> int:
    """Pré-renseigne le catalogue. Idempotent, et n'écrase aucun relevé."""
    poses = 0
    with transaction(connection):
        for reference, label, depot, alias, defaut in DEFAULTS:
            if connection.execute(
                "SELECT 1 FROM image_catalog WHERE reference = ?", (reference,)
            ).fetchone():
                continue
            connection.execute(
                "INSERT INTO image_catalog (id, reference, label, remote, alias,"
                " architecture, state, detail, is_default, created_at)"
                " VALUES (?, ?, ?, ?, ?, 'amd64', ?, '', ?, ?)",
                (token_hex(12), reference, label, depot, alias, UNKNOWN,
                 1 if defaut else 0, _now()),
            )
            poses += 1
    return poses


# --- le relevé (§33.3) -------------------------------------------------------


@dataclass(frozen=True)
class Catalogue:
    """Alias publiés par un dépôt, à un instant donné."""

    aliases: frozenset[str]
    produits: int


def fetch_remote(url: str, client: httpx.Client | None = None) -> Catalogue:
    """Relève les alias publiés par un dépôt simplestreams.

    Mesuré le 2026-08-19 (§33.3) : la clé de produit porte le nom de CODE —
    `debian:trixie:amd64:default` — et l'alias vit dans un champ `aliases`
    séparé par des virgules. L'alias ne se déduit donc pas de la clé, et
    l'architecture n'y figure pas : `debian/13` renvoie aux quatre
    architectures publiées, `debian/13/amd64` n'existe pas.
    """
    ferme = client is None
    client = client or httpx.Client(timeout=30.0)
    try:
        index = client.get(f"{url}/streams/v1/index.json").raise_for_status().json()
        chemin = index["index"]["images"]["path"]
        produits = client.get(f"{url}/{chemin}").raise_for_status().json()["products"]
    finally:
        if ferme:
            client.close()

    alias: set[str] = set()
    for produit in produits.values():
        for nom in (produit.get("aliases") or "").split(","):
            nom = nom.strip()
            if nom:
                alias.add(nom)
    return Catalogue(frozenset(alias), len(produits))


def fake_fetch(url: str, client=None) -> Catalogue:
    """Relevé factice, pour la pile de développement et les tests.

    Au même titre que `FakeIncus` et `FakeCaddy` : le produit doit tenir **sans
    réseau sortant** (docs/DAT.md §28.1). Il publie exactement les alias
    pré-renseignés — ni plus, ni moins — de sorte qu'une référence inventée y soit
    `missing` comme elle le serait sur le vrai dépôt.

    Il ne prouve jamais qu'une image existe réellement : cela exige le dépôt.
    """
    return Catalogue(frozenset(alias for _, _, _, alias, _ in DEFAULTS), len(DEFAULTS))


def verify(
    connection: sqlite3.Connection,
    fetch=fetch_remote,
    actor: str = "sparkd",
) -> dict:
    """Relève tout le catalogue et date le résultat.

    Le relevé est **explicite** : il n'a pas lieu à chaque ouverture d'un
    formulaire, ce qui rendrait la création tributaire d'un service extérieur
    alors que le produit tient sans réseau sortant une fois les images en cache.

    Un dépôt injoignable rend `unknown`, **jamais** `missing` : ne pas savoir
    n'est pas savoir que ce n'est pas là (§33.3).
    """
    # §36.4 : ÉVÉNEMENT DU RUNTIME. Souvent déclenché par une requête humaine,
    # il n'est pas demandé par elle — sans cette déclaration le journal ferait
    # croire qu'une personne l'a réclamé.
    with audit.as_runtime(actor or "sparkd"):
        entrees = listing(connection)
        depots = {e["remote"] for e in entrees}
        releves: dict[str, Catalogue | str] = {}
        for depot in depots:
            url = REMOTES.get(depot)
            if url is None:
                releves[depot] = f"dépôt « {depot} » inconnu du produit"
                continue
            try:
                releves[depot] = fetch(url)
            except Exception as erreur:  # noqa: BLE001 — toute panne doit être rendue
                releves[depot] = f"dépôt injoignable : {erreur}"

        compte = {VERIFIED: 0, MISSING: 0, UNKNOWN: 0}
        horodatage = _now()
        with transaction(connection):
            for entree in entrees:
                releve = releves.get(entree["remote"])
                if isinstance(releve, Catalogue):
                    present = entree["alias"] in releve.aliases
                    etat = VERIFIED if present else MISSING
                    detail = (
                        f"relevé sur {releve.produits} produits publiés"
                        if present
                        else f"absent des {releve.produits} produits publiés"
                    )
                else:
                    etat, detail = UNKNOWN, str(releve)
                compte[etat] += 1
                connection.execute(
                    "UPDATE image_catalog SET state = ?, verified_at = ?, detail = ?"
                    " WHERE id = ?",
                    (etat, horodatage, detail, entree["id"]),
                )
            _audit(
                connection, actor, "image.verify", "ok",
                f"Catalogue relevé : {compte[VERIFIED]} vérifiée(s), "
                f"{compte[MISSING]} absente(s), {compte[UNKNOWN]} non relevée(s).",
                payload=compte,
            )
        return {"verified_at": horodatage, **compte}
