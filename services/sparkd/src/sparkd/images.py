"""Catalogue d'images système, et son relevé.

@spec docs/BACKLOG.md#SPK-32 · docs/BACKLOG.md#SPK-92 · docs/DAT.md §33 (le
      catalogue d'images), §33.2 (tenu par le registre), §33.3 (la vérification
      est un relevé, et ce que l'alias porte), §33.4 (ce que le catalogue n'est
      pas), §33.5 (l'écran de création), §33.6 (le dépôt se lit en direct et le
      catalogue se coche), §33.7 (retirer une entrée) · §42.9.6 (annoncer
      l'amorçabilité) · docs/SCHEMA.md · §14.2

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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from secrets import token_hex

import httpx

from . import audit
from . import familles as table_familles
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
#:
#: SPK-98 · §33.3 bis — **cette liste était une SECONDE table, et elle
#: contredisait la première.** Elle lisait le préfixe de l'alias et ne connaissait
#: que `debian` et `ubuntu` ; le relevé, lui, lit `ID_LIKE` dans la cellule. Le
#: catalogue affichait donc « amorçage non pris en charge » sur `mint/wilma`,
#: `kali/current` et `devuan/daedalus`, que l'amorçage acceptait. Deux réponses
#: opposées à la même question dans le même produit.
#:
#: Le catalogue consulte désormais la table du §42.11, celle-là même que
#: l'amorçage consulte. Il n'y a plus qu'un endroit où la réponse est écrite.


def famille_presumee(alias: str) -> str | None:
    """La famille PRÉSUMÉE de cet alias — `debian/13` → `apt` (§42.14).

    Présumée, et le mot compte (§33.3) : c'est tout ce qu'on a avant qu'une
    cellule existe. La vérité reste ce que la cellule déclare dans
    `/etc/os-release`, et c'est le §42.9 qui décide, lui seul.
    """
    trouvee = table_familles.de_alias(alias)
    return trouvee.cle if trouvee else None


def capacites_de_alias(alias: str) -> dict[str, bool]:
    """Ce que le produit sait faire d'une image de cet alias (§42.14).

    Calculée à la LECTURE, jamais stockée en colonne : une doctrine qui s'ajoute
    — Docker sur Alpine, le jour où il sera mesuré — doit changer la réponse de
    toutes les entrées existantes sans migration, et une copie figée au registre
    serait fausse dès le lendemain.
    """
    return table_familles.capacites(
        table_familles.de_alias(alias),
        table_familles.identifiant_de_alias(alias))


def amorcable(alias: str) -> bool:
    """Une doctrine existe-t-elle pour cet alias ? (§42.9.6, §42.14)

    SPK-98 : ce prédicat signifiait « famille `apt` », donc « aura Docker ». Il
    signifie désormais « l'amorçage sait quoi en faire », ce qui rend une Alpine
    amorçable — elle recevra `sshd` et ses clés. Ce qu'elle n'aura pas se lit
    dans `capacites()`, qui le dit élément par élément au lieu de tout réduire à
    un oui-ou-non.
    """
    return table_familles.de_alias(alias) is not None


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
class Publication:
    """Ce qu'un dépôt publie sous un alias, à l'instant de la lecture (§33.6).

    Le dépôt donne `os`, `release_title`, `arch` et `variant` par produit : le
    libellé lisible se DÉRIVE donc de ce qu'il publie, au lieu d'être inventé.
    `debian/13` rend « Debian 13 « trixie » », qui est exactement la forme des
    entrées pré-renseignées.

    Les architectures sont retenues parce que l'alias n'en porte pas (§33.3) :
    un alias peut n'exister que pour `arm64`, et écrire « amd64 » sans regarder
    serait une déclaration de plus.
    """

    alias: str
    os: str
    release: str
    variante: str
    architectures: frozenset[str]

    @property
    def famille(self) -> str:
        return self.alias.split("/", 1)[0]

    @property
    def version(self) -> str | None:
        """`debian/13` → « 13 ». `archlinux`, à publication continue → None."""
        morceaux = self.alias.split("/")
        return morceaux[1] if len(morceaux) > 1 else None

    def libelle(self, variante: bool = False) -> str:
        """Le nom lisible, dérivé de ce que le dépôt publie — jamais inventé."""
        systeme = self.os or self.famille.capitalize()
        version = self.version or self.release or ""
        nom = f"{systeme} {version}".strip()
        if self.release and self.release != version:
            nom += f" « {self.release} »"
        if variante and self.variante:
            nom += f" ({self.variante})"
        return nom


@dataclass(frozen=True)
class Catalogue:
    """Alias publiés par un dépôt, à un instant donné."""

    aliases: frozenset[str]
    produits: int
    #: alias -> ce que le dépôt en dit. Vide pour un relevé qui n'a servi qu'à
    #: trancher present/absent : `verify` n'a besoin que de `aliases`.
    publications: dict[str, Publication] = field(default_factory=dict)


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

    # Un alias couvre plusieurs produits — une architecture chacun (§33.3) —, on
    # accumule donc leurs architectures au lieu de garder le dernier vu.
    vus: dict[str, dict] = {}
    for produit in produits.values():
        for nom in (produit.get("aliases") or "").split(","):
            nom = nom.strip()
            if not nom:
                continue
            entree = vus.setdefault(nom, {"arch": set(), "produit": produit})
            entree["arch"].add(produit.get("arch") or "")

    publications = {
        nom: Publication(
            alias=nom,
            os=(v["produit"].get("os") or "").strip(),
            release=(v["produit"].get("release_title")
                     or v["produit"].get("release") or "").strip(),
            variante=(v["produit"].get("variant") or "").strip(),
            architectures=frozenset(a for a in v["arch"] if a),
        )
        for nom, v in vus.items()
    }
    return Catalogue(frozenset(publications), len(produits), publications)


#: Ce que le dépôt FACTICE publie (docs/DAT.md §28.1, CLAUDE.md §8).
#:
#: Il ne se limite pas aux quatre références pré-renseignées, et c'est délibéré :
#: un dépôt factice qui ne publierait que ce que le catalogue tient déjà rendrait
#: la liste à cocher **vide**, et la pile de développement ne saurait pas
#: démontrer l'unité. Le seed est un contrat, il doit couvrir les états livrés.
#:
#: Il reproduit donc aussi les formes de doublon mesurées le 2026-09-07 sur le
#: vrai dépôt — nom de code, variante par défaut, variante nommée — de sorte que
#: le regroupement du §33.6 s'éprouve **sans réseau sortant**.
FAKE_PUBLICATIONS = (
    # alias, système, publication, variant
    ("debian/13", "Debian", "trixie", "default"),
    ("debian/13/default", "Debian", "trixie", "default"),
    ("debian/13/cloud", "Debian", "trixie", "cloud"),
    ("debian/trixie", "Debian", "trixie", "default"),
    ("debian/12", "Debian", "bookworm", "default"),
    ("debian/11", "Debian", "bullseye", "default"),
    ("ubuntu/24.04", "Ubuntu", "noble", "default"),
    ("ubuntu/noble", "Ubuntu", "noble", "default"),
    ("ubuntu/22.04", "Ubuntu", "jammy", "default"),
    ("alpine/3.21", "Alpine", "3.21", "default"),
    ("alpine/3.22", "Alpine", "3.22", "default"),
    ("archlinux", "Archlinux", "current", "default"),
    ("archlinux/cloud", "Archlinux", "current", "cloud"),
)


def fake_fetch(url: str, client=None) -> Catalogue:
    """Relevé factice, pour la pile de développement et les tests.

    Au même titre que `FakeIncus` et `FakeCaddy` : le produit doit tenir **sans
    réseau sortant** (docs/DAT.md §28.1). Il publie un dépôt réduit mais de même
    FORME que le vrai, de sorte qu'une référence inventée y soit `missing` comme
    elle le serait chez le dépôt.

    Il ne prouve jamais qu'une image existe réellement : cela exige le dépôt.
    """
    publications = {
        alias: Publication(
            alias=alias, os=systeme, release=release, variante=variante,
            architectures=frozenset({"amd64", "arm64"}),
        )
        for alias, systeme, release, variante in FAKE_PUBLICATIONS
    }
    # Un alias couvre ses architectures : le compte de produits est celui d'un
    # dépôt, pas celui des alias.
    return Catalogue(frozenset(publications), len(publications) * 2, publications)


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


# --- lire le dépôt en direct (§33.6) -----------------------------------------


def _cle_de_version(version: str | None) -> tuple:
    """Trie « 24.04 » après « 22.04 », et « 9 » après « 10 » correctement.

    Un tri purement lexical placerait `debian/9` avant `debian/10`, ce qui se lit
    comme une régression de version.
    """
    if not version:
        return (0,)
    morceaux = []
    for bout in version.replace("-", ".").split("."):
        morceaux.append((1, int(bout)) if bout.isdigit() else (0, bout))
    return tuple(morceaux)


def grouper(publications: dict[str, Publication]) -> list[dict]:
    """Range 229 alias en 59 lignes lisibles, sans en perdre un seul (§33.6).

    Trois doublons coexistent dans ce que le dépôt publie, et aucun ne se voit
    sans regarder les données. Mesuré le 2026-09-07 :

    1. **la variante par défaut redit la base.** `debian/13` et
       `debian/13/default` désignent les MÊMES produits ;
    2. **le nom de code redit le numéro.** `debian/trixie` et `debian/13` aussi,
       de même que `ubuntu/noble` et `ubuntu/24.04` ;
    3. **certaines variantes sont composées.** `freebsd/14.4/ufs` porte le variant
       `default+ufs` : reconnaître une variante à « le dernier segment est le
       variant » la manquerait, et l'afficherait comme une version à part.

    D'où le critère retenu, qui ne dépend que du jeu d'alias : **un alias dont le
    parent est lui-même publié est une variante**, rattachée à la base dont elle
    descend — par préfixe, car `archlinux/current/cloud` pend sous
    `archlinux/current`, qui est déjà une variante d'`archlinux`. Le reste est une
    base. Les bases qui décrivent la même chose — même famille, même publication,
    même variant — sont ensuite fondues, en gardant celle qui ne répète pas le
    nom de code ; les autres deviennent des **synonymes**, retenus parce qu'on
    cherche « noble » aussi souvent que « 24.04 ».
    """
    tous = set(publications)
    bases = [alias for alias in sorted(tous)
             if "/" not in alias or alias.rsplit("/", 1)[0] not in tous]
    socles = set(bases)

    groupes: dict[tuple, list[str]] = {}
    for alias in bases:
        p = publications[alias]
        groupes.setdefault((p.famille, p.release, p.variante), []).append(alias)

    retenues: list[tuple[str, list[str]]] = []
    for candidats in groupes.values():
        if len(candidats) > 1:
            # Celle qui ne répète pas le nom de code, puis la plus courte.
            release = publications[candidats[0]].release
            preferes = [a for a in candidats
                        if release not in a.split("/")] or candidats
        else:
            preferes = candidats
        gardee = sorted(preferes, key=lambda a: (len(a), a))[0]
        retenues.append((gardee, [a for a in candidats if a != gardee]))

    # Les descendants se prennent par PRÉFIXE, et non de parent à enfant :
    # `archlinux/current/cloud` pend sous `archlinux/current`, qui est lui-même
    # une variante d'`archlinux`. S'arrêter au premier niveau le perdrait.
    return [
        (gardee, synonymes,
         sorted(a for a in tous
                if a not in socles
                and any(a.startswith(base + "/") for base in [gardee, *synonymes])))
        for gardee, synonymes in retenues
    ]


def depot_listing(
    connection: sqlite3.Connection,
    fetch=fetch_remote,
    remote: str = "images",
) -> dict:
    """Ce que le dépôt publie MAINTENANT, groupé pour être lisible (§33.6).

    La lecture est directe, sans table intermédiaire : mesuré le 2026-09-07,
    l'index et le catalogue pèsent 1,13 Mio pour ~1,3 s, **côté sparkd** — la
    console ne reçoit que le groupement. Une table de listing coûterait un
    schéma, une migration et une question de fraîcheur pour économiser cela sur
    un geste rare.
    """
    url = REMOTES.get(remote)
    if url is None:
        raise ImageError(
            f"Le dépôt « {remote} » est inconnu du produit. "
            f"Connus : {', '.join(sorted(REMOTES))}."
        )

    catalogue = fetch(url)
    deja = {e["reference"] for e in listing(connection)}
    lu_le = _now()

    def entree(alias: str, variante: bool = False) -> dict:
        publication = catalogue.publications[alias]
        reference = f"{remote}:{alias}"
        return {
            "reference": reference,
            "alias": alias,
            "libelle": publication.libelle(variante=variante),
            "variante": publication.variante,
            "architectures": sorted(publication.architectures),
            # Une entrée déjà tenue n'est pas une entrée à ajouter : la modale
            # la montre cochée et inerte, elle ne sert pas à retirer (§33.6).
            "au_catalogue": reference in deja,
        }

    def preferee(alias: list[str], sous: str) -> str:
        """Parmi des alias synonymes, celui qui se lit le mieux.

        On garde ce qui vit sous la base retenue — `debian/13/cloud` plutôt que
        `debian/trixie/cloud` —, puis le plus court.
        """
        return sorted(alias, key=lambda a: (not a.startswith(sous + "/"),
                                            len(a), a))[0]

    par_famille: dict[str, list[dict]] = {}
    for gardee, synonymes, descendants in grouper(catalogue.publications):
        publication = catalogue.publications[gardee]

        # Les descendants des bases fondues suivent la base retenue : sans cela,
        # `debian/trixie/cloud` disparaîtrait sans que rien ne le dise.
        soeurs = descendants

        # Une variante qui porte le variant de la base la REDIT : `debian/13`,
        # `debian/13/default` et `debian/trixie/default` sont trois noms d'une
        # seule image. Elles rejoignent les synonymes de la ligne, elles ne
        # disparaissent pas.
        redites = [a for a in soeurs
                   if catalogue.publications[a].variante == publication.variante]

        # Le reste se regroupe par variant : `debian/13/cloud` et
        # `debian/trixie/cloud` sont la même image sous deux noms.
        par_variante: dict[str, list[str]] = {}
        for alias in soeurs:
            variante = catalogue.publications[alias].variante
            if variante != publication.variante:
                par_variante.setdefault(variante, []).append(alias)

        lignes_variantes = []
        for alias in par_variante.values():
            retenue = preferee(alias, gardee)
            vue_variante = entree(retenue, variante=True)
            vue_variante["synonymes"] = sorted(a for a in alias if a != retenue)
            lignes_variantes.append(vue_variante)

        ligne = entree(gardee)
        ligne["version"] = publication.version
        ligne["synonymes"] = sorted([*synonymes, *redites])
        ligne["variantes"] = sorted(lignes_variantes,
                                    key=lambda v: v["variante"] or v["alias"])
        par_famille.setdefault(publication.famille, []).append(ligne)

    familles = [
        {
            "famille": famille,
            # §42.9.6 : ce que l'amorçage sait faire de cette famille. On le DIT
            # ici comme à la création — annonce, jamais filtre.
            "amorcable": amorcable(famille),
            # SPK-98 · §42.14 : et la table de ce qu'elle reçoit, parce qu'un
            # booléen ne dit plus rien d'utile depuis qu'une famille peut être
            # servie sans avoir Docker.
            "capacites": capacites_de_alias(famille),
            "versions": sorted(lignes,
                               key=lambda v: _cle_de_version(v["version"]),
                               reverse=True),
        }
        for famille, lignes in sorted(par_famille.items())
    ]

    return {
        "remote": remote,
        "url": url,
        "read_at": lu_le,
        "produits": catalogue.produits,
        "alias": len(catalogue.publications),
        "familles": familles,
    }


def add_selection(
    connection: sqlite3.Connection,
    references: list[str],
    fetch=fetch_remote,
    remote: str = "images",
    actor: str | None = None,
) -> dict:
    """Ajoute en LOT des références cochées, reconfirmées par le serveur (§33.6).

    L'entrée naît `verified`, ce qui abolit le double pas « ajouter puis
    relever ». Mais l'état ne vient PAS du navigateur : on relit le dépôt ici et
    l'on date `verified_at` de **cette** lecture. Accepter l'état déclaré par le
    client serait le succès simulé que le `DESIGN_SYSTEM.md` §1.3 interdit — et
    le §33.3 avec lui : l'état vient du relevé, jamais d'une déclaration.

    C'est un lot parce que la preuve est commune : cocher dix entrées ne coûte
    qu'une lecture, là où dix ajouts en coûteraient dix.
    """
    demandees = [r.strip() for r in references if r and r.strip()]
    if not demandees:
        raise ImageError("Aucune image cochée.")

    url = REMOTES.get(remote)
    if url is None:
        raise ImageError(
            f"Le dépôt « {remote} » est inconnu du produit. "
            f"Connus : {', '.join(sorted(REMOTES))}."
        )

    catalogue = fetch(url)
    horodatage = _now()

    # Toutes les références sont confrontées AVANT d'écrire quoi que ce soit :
    # un lot à moitié posé serait plus difficile à comprendre qu'un refus.
    inconnues: list[str] = []
    a_poser: list[tuple[str, str]] = []
    for reference in dict.fromkeys(demandees):
        depot, _, alias = reference.partition(":")
        if depot != remote or not alias or alias not in catalogue.aliases:
            inconnues.append(reference)
        else:
            a_poser.append((reference, alias))

    if inconnues:
        raise ImageError(
            "Le dépôt ne publie pas : " + ", ".join(f"« {r} »" for r in inconnues)
            + ". La lecture a peut-être vieilli — rouvrir la liste."
        )

    ajoutees: list[dict] = []
    ignorees: list[str] = []
    with transaction(connection):
        for reference, alias in a_poser:
            if by_reference(connection, reference):
                # Cochée entre-temps par quelqu'un d'autre : ce n'est pas une
                # erreur, l'entrée est là et c'est ce qui était voulu.
                ignorees.append(reference)
                continue
            publication = catalogue.publications.get(alias)
            architectures = publication.architectures if publication else frozenset()
            identifiant = token_hex(12)
            connection.execute(
                "INSERT INTO image_catalog (id, reference, label, remote, alias,"
                " architecture, state, detail, is_default, created_at, verified_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (identifiant, reference,
                 publication.libelle() if publication else alias,
                 remote, alias,
                 # L'architecture n'est pas dans l'alias (§33.3) : on retient ce
                 # que le dépôt publie, plutôt que d'écrire « amd64 » sans avoir
                 # regardé.
                 "amd64" if "amd64" in architectures
                 else (sorted(architectures)[0] if architectures else "amd64"),
                 VERIFIED,
                 f"relevé sur {catalogue.produits} produits publiés",
                 horodatage, horodatage),
            )
            _audit(connection, actor, "image.add", "ok",
                   f"Image « {reference} » ajoutée au catalogue depuis le dépôt, "
                   "vérifiée par la même lecture.",
                   target_type="image", target_id=identifiant,
                   payload={"reference": reference, "source": "depot"})
            ajoutees.append(by_reference(connection, reference))

    return {"verified_at": horodatage, "added": ajoutees, "skipped": ignorees}


def by_id(connection: sqlite3.Connection, identifiant: str) -> dict | None:
    ligne = connection.execute(
        "SELECT * FROM image_catalog WHERE id = ?", (identifiant,)
    ).fetchone()
    return dict(ligne) if ligne else None


def remove(
    connection: sqlite3.Connection,
    identifiant: str,
    actor: str | None = None,
) -> dict:
    """Retire une entrée du catalogue, avec ses deux refus (§33.7).

    Le premier refus ne protège pas l'intégrité : `ensure_selectable` n'est
    appelé qu'à la CRÉATION (§14.2), jamais à la reprise, donc un Spark existant
    tourne très bien sans son entrée. Il protège la **lisibilité** — le catalogue
    est ce qui explique sur quoi tourne une cellule, et le retirer pendant qu'un
    Spark s'en réclame ferait croire que cette origine n'a jamais existé, ce que
    le §33.3 interdit déjà pour une entrée `missing`.
    """
    entree = by_id(connection, identifiant)
    if entree is None:
        raise ImageError("Cette image n'est pas au catalogue.")

    # L'entrée par défaut est examinée EN PREMIER, et l'ordre porte du sens :
    # son refus est structurel — personne ne peut la retirer aujourd'hui —, là
    # où la liste des Sparks décrit une situation qui, elle, peut changer.
    # Nommer d'abord les Sparks laisserait croire qu'en les supprimant on
    # débloquerait le retrait, ce qui est faux.
    if entree["is_default"]:
        raise ImageError(
            f"« {entree['reference']} » est l'image proposée par défaut à la "
            "création. Le produit n'offre pas encore de geste pour en désigner "
            "une autre : elle n'est donc pas retirable."
        )

    porteurs = [
        r["name"]
        for r in connection.execute(
            "SELECT name FROM spark WHERE image = ? ORDER BY name",
            (entree["reference"],),
        )
    ]
    if porteurs:
        raise ImageError(
            f"« {entree['reference']} » est employée par "
            + ", ".join(porteurs)
            + ". Retirer l'entrée effacerait ce qui explique sur quoi "
            "ces Sparks tournent."
        )

    with transaction(connection):
        connection.execute("DELETE FROM image_catalog WHERE id = ?", (identifiant,))
        _audit(connection, actor, "image.remove", "ok",
               f"Image « {entree['reference']} » retirée du catalogue.",
               target_type="image", target_id=identifiant,
               payload={"reference": entree["reference"]})
    return entree
