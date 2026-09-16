"""Le fichier `.?` : le seul canal par lequel la cellule propose.

@spec docs/BACKLOG.md#SPK-105, docs/BACKLOG.md#SPK-107 · docs/DAT.md §55 (la
      règle), §55.3 (les six paires), §55.3.1 (`/etc/spark/routes`), §55.3.3 (le
      vide est une DEMANDE, et l'étiquette l'explique), §55.4 (ce que la
      frontière ne change pas), §55.5 (consulter ne consomme pas), §55.5.2
      (l'empreinte relue), §55.6 (permissions), §55.7 (les en-têtes), §55.8 (la
      surface d'API) · docs/DAT.md §43.10.1 (la grammaire, qui vit dans la
      console)

**La règle du produit, en deux lignes** : tout fichier que le plan de contrôle
pose dans une cellule est régénéré en entier depuis le registre, et l'écrire à la
main n'a aucun effet durable. À côté de chacun, un fichier de même nom suffixé
`.?` est le seul endroit où la cellule peut PROPOSER un changement.

**Ce module n'analyse rien.** Il lit, il pose, il vide. La grammaire du §43.10.1
existe déjà une seule fois, dans `env-import.js`, et le §43.10.3 pose que le
serveur ne reçoit jamais le texte collé mais des entrées structurées. En écrire
un second analyseur ici ferait deux grammaires pour le même fichier, qui
divergeraient (§55.8).
"""

from __future__ import annotations

import hashlib
import sqlite3
from typing import Any, Callable

from . import notes as notes_service

#: Le suffixe. Il se lit « et si ? » et se tape sans réfléchir. Le fichier réel
#: et sa proposition se lisent alors d'un même regard dans un `ls` — c'est
#: précisément ce dont l'agent a besoin pour savoir si sa demande a été accordée
#: (§55.5.1).
SUFFIXE = ".?"

#: Le fichier NOUVEAU du §55.3.1. Les cinq autres fichiers réels existaient
#: déjà ; celui-là manquait, et son absence se voyait : une cellule ne pouvait
#: lire les routes qui la visent qu'en analysant `BRIEFING.md`, c'est-à-dire une
#: présentation faite pour être lue.
FICHIER_ROUTES = "/etc/spark/routes"
FICHIER_VARIABLES = "/etc/spark/env"
FICHIER_SECRETS = "/run/spark/secrets"

#: Les deux syntaxes de commentaire dont le produit a besoin : `#` pour les trois
#: fichiers de configuration, un commentaire HTML pour les notes. Un en-tête
#: écrit dans la mauvaise syntaxe serait lu comme une entrée par la grammaire du
#: fichier qu'il accompagne.
DIESE = "diese"
HTML = "html"

#: SPK-105 · §55.3 : les six paires. `nature` décide de ce que l'acceptation
#: fait — ajouter et remplacer entrée par entrée, ou remplacer un texte en
#: entier. Un texte n'a pas d'entrées : le proposer par fragments demanderait une
#: grammaire de fusion que personne ne sait écrire sans se tromper.
ENTREES = "entrees"
TEXTE = "texte"

PAIRES: tuple[dict[str, Any], ...] = (
    {
        "kind": "variables",
        "reel": FICHIER_VARIABLES,
        "nature": ENTREES,
        "commentaire": DIESE,
        "titre": "Variables d'environnement souhaitées",
        "attendu": "NOM=valeur, une par ligne. Ces variables seront posées en "
                   "clair et lisibles dans la cellule.",
    },
    {
        "kind": "secrets",
        "reel": FICHIER_SECRETS,
        "nature": ENTREES,
        "commentaire": DIESE,
        "titre": "Secrets souhaités",
        "attendu": "NOM=valeur, une par ligne. Le propriétaire décide, ligne "
                   "par ligne, de ce qui est réellement enregistré comme secret.",
    },
    {
        "kind": "routes",
        "reel": FICHIER_ROUTES,
        "nature": ENTREES,
        "commentaire": DIESE,
        "titre": "Routes publiques souhaitées",
        "attendu": "<domaine> <port écouté DANS la cellule> [tls|clair], une par "
                   "ligne. Le port public ne se choisit pas : la Forge écoute "
                   "443 et fait suivre.",
    },
    {
        "kind": "readme",
        "reel": notes_service.chemin("readme"),
        "nature": TEXTE,
        "commentaire": HTML,
        "note": "readme",
        "titre": "Remplacement du README",
        "attendu": notes_service.definition("readme")["attendu"],
    },
    {
        "kind": "contributors",
        "reel": notes_service.chemin("contributors"),
        "nature": TEXTE,
        "commentaire": HTML,
        "note": "contributors",
        "titre": "Remplacement du CONTRIBUTORS",
        "attendu": notes_service.definition("contributors")["attendu"],
    },
    {
        "kind": "install",
        "reel": notes_service.chemin("install"),
        "nature": TEXTE,
        "commentaire": HTML,
        "note": "install",
        "titre": "Remplacement de l'INSTALL",
        "attendu": notes_service.definition("install")["attendu"],
    },
)

NATURES = tuple(paire["kind"] for paire in PAIRES)

#: Les dossiers que la projection ouvre au groupe rootless, et les fichiers
#: qu'elle y rend INSCRIPTIBLES (§55.6). `/etc/spark` et `/run/spark` sont déjà
#: ouverts par l'environnement ; on les redit ici parce qu'une projection de
#: suggestions peut avoir lieu sans projection d'environnement.
DOSSIERS_OUVERTS = ("/etc/spark", "/run/spark", notes_service.DOSSIER)

#: SPK-107 · §55.3.3 : la longueur d'une étiquette, telle que l'en-tête
#: l'ANNONCE. La coupure, elle, a lieu dans la console, où vit la grammaire
#: (§55.8) : ce module ne lit toujours rien de ce que la cellule écrit.
ETIQUETTE_MAX = 120

MARQUEUR = "spark:suggestion"
FIN_DIESE = "# --- fin du bloc posé par sparkd, écrivez ci-dessous ---"
FIN_HTML = "-->"


class SuggestionError(ValueError):
    """Un geste refusé, avec le code que l'API rendra."""

    def __init__(self, message: str, code: str = "invalid_suggestion") -> None:
        super().__init__(message)
        self.code = code


class SuggestionPerimee(SuggestionError):
    """L'empreinte relue ne correspond plus au fichier (§55.5.2).

    L'agent a réécrit sa proposition entre le moment où la console l'a affichée
    et celui où le propriétaire a tranché. Appliquer le contenu COURANT ferait
    écrire au registre un texte que personne n'a lu.
    """

    def __init__(self, message: str, courante: dict[str, Any]) -> None:
        super().__init__(message, "stale_suggestion")
        self.courante = courante


def definition(kind: str) -> dict[str, Any]:
    """La définition d'une paire, ou un refus nommé."""
    for paire in PAIRES:
        if paire["kind"] == kind:
            return paire
    raise SuggestionError(
        f"« {kind} » n'est pas une nature de proposition : les six sont "
        + ", ".join(NATURES) + ".", "unknown_kind")


def chemin(kind: str) -> str:
    """Le chemin du fichier `.?`, voisin du fichier réel (§55.5.1)."""
    return definition(kind)["reel"] + SUFFIXE


def empreinte(texte: str) -> str:
    """SHA-256 du CORPS, en-tête exclu (§55.5.2).

    Sur le corps et non sur le fichier : l'en-tête est réécrit par le produit et
    peut changer d'une version à l'autre. Une empreinte prise sur le fichier
    entier ferait alors périmer toutes les propositions en attente le jour d'une
    mise à jour, pour un texte que personne n'a touché.
    """
    return hashlib.sha256(_normaliser(texte).encode("utf-8")).hexdigest()


def _normaliser(texte: str | None) -> str:
    if not texte:
        return ""
    return texte.replace("\r\n", "\n").replace("\r", "\n").rstrip(" \t\n")


def entete(kind: str) -> str:
    """Le bloc que le produit pose en tête de chaque `.?` (§55.7).

    Il dit, pour ce fichier-là : à quoi il sert, quelle grammaire il attend, si
    la proposition ajoute et remplace ou remplace en entier, que rien ne
    s'applique sans un geste du propriétaire, et qu'il redeviendra vide quand une
    décision aura été prise.

    Il est RETIRÉ à la lecture : sans cela, la première acceptation écrirait
    l'avertissement du produit dans le registre.
    """
    paire = definition(kind)
    effet = ("Ce qui est écrit ici est AJOUTÉ ou REMPLACE, entrée par entrée. "
             "Rien n'est jamais retiré."
             if paire["nature"] == ENTREES else
             "Ce qui est écrit ici REMPLACE le texte en entier.")
    corps = [
        f"{MARQUEUR}:{paire['kind']} — {paire['titre']}",
        "",
        paire["attendu"],
        effet,
        "",
        f"Ce fichier PROPOSE ; il n'applique rien. Le fichier voisin "
        f"« {paire['reel']} » est",
        "posé par le plan de contrôle depuis son registre : l'éditer à la main",
        "n'a aucun effet durable. Écrivez ici : le propriétaire du Spark relira",
        "votre proposition, et l'acceptera ou non.",
        "",
        "Tant que personne ne l'a ouverte, elle reste. Quand elle aura été",
        "acceptée ou refusée, ce fichier redeviendra VIDE — c'est ainsi que vous",
        f"saurez qu'une décision a été prise, et « {paire['reel']} » vous dira",
        "laquelle. Rien ne garantit qu'elle soit lue : n'en faites pas dépendre",
        "le démarrage de votre pile.",
    ]
    if paire["kind"] in ("variables", "secrets"):
        # SPK-107 · §55.7 : le taire laisserait inventer une valeur de
        # remplissage, que le propriétaire accepte sans la regarder et qui casse
        # la pile au démarrage suivant.
        corps.extend([
            "",
            "VOUS NE CONNAISSEZ PAS UNE VALEUR ? Laissez-la VIDE — « NOM= ».",
            "C'est une DEMANDE : le propriétaire devra la saisir lui-même pour",
            "l'importer. N'inventez pas une valeur de remplissage.",
            "",
            "Une ligne « # … » posée JUSTE AU-DESSUS d'une déclaration lui sert",
            f"d'étiquette et s'affiche à côté d'elle : une seule ligne, "
            f"{ETIQUETTE_MAX} caractères,",
            "coupée au-delà. Une ligne vide entre les deux rompt le lien.",
            "",
            "    # Clé d'API du fournisseur de facturation, à créer chez lui.",
            "    BILLING_API_KEY=",
        ])
    if paire["kind"] == "secrets":
        # §55.6.1 : le seul des six dont la proposition est périssable. Le taire
        # ferait chercher un refus qui n'a pas eu lieu.
        corps.extend([
            "",
            "CE FICHIER VIT DANS UN TMPFS : votre proposition disparaît au",
            "redémarrage de la cellule, sans avoir été lue. Redéposez-la.",
        ])
    if paire["commentaire"] == DIESE:
        return "".join(f"# {ligne}\n" if ligne else "#\n" for ligne in corps) \
            + FIN_DIESE + "\n"
    return "<!-- " + "\n".join(corps) + "\n" + FIN_HTML + "\n"


def sans_entete(kind: str, brut: str | None) -> str:
    """Retire le bloc du produit et rend le CORPS de la proposition.

    Reconnu par sa fin, et non par une égalité au texte que nous aurions écrit :
    un auteur qui corrige une faute dans le bloc, ou une version du produit qui
    reformule l'avertissement, ne doit pas faire prendre l'en-tête pour du texte.
    """
    texte = _normaliser(brut)
    if not texte:
        return ""
    fin = FIN_DIESE if definition(kind)["commentaire"] == DIESE else FIN_HTML
    if MARQUEUR not in texte.split(fin)[0]:
        # Pas notre bloc : on ne coupe rien. Un fichier écrit de zéro par un
        # agent, sans l'en-tête, est parfaitement valide.
        return texte
    coupure = texte.find(fin)
    if coupure < 0:
        return texte
    return _normaliser(texte[coupure + len(fin):].lstrip("\n"))


def vide(kind: str, brut: str | None) -> bool:
    """« Aucune proposition » : fichier absent, ou n'ayant que l'en-tête.

    Les deux valent la même chose pour le produit (§55.5) : ce qui distingue une
    proposition d'une absence est du TEXTE, pas l'existence d'un fichier.
    """
    return not sans_entete(kind, brut)


def rendre_routes(routes: list[dict[str, Any]], spark_id: str) -> str:
    """Rend `/etc/spark/routes` depuis le registre (§55.3.1).

    La MÊME grammaire que sa proposition, et c'est le point : l'agent lit et
    écrit la même chose. C'est l'argument du §43.10.1 — « l'import lit ce que le
    produit écrit » —, sans lequel le fichier posé par le produit serait la seule
    chose qu'on ne peut pas lui redonner.

    Une route DÉSACTIVÉE n'y figure pas : ce fichier dit ce qui atteint la
    cellule, et une route désactivée ne l'atteint pas. La console, elle, montre
    les deux — c'est là que la distinction sert.
    """
    lignes = [
        "# Les routes publiques qui visent ce Spark, telles que le plan de",
        "# contrôle les connaît. Posé par sparkd, réécrit à chaque changement.",
        "#",
        "# <domaine> <port écouté ICI> [tls|clair]",
        "#",
        "# La Forge termine le TLS et fait suivre vers le port ci-dessous :",
        "# servez en CLAIR, aucun port publié n'est requis.",
        "#",
        f"# Pour en demander une autre, écrivez dans « {FICHIER_ROUTES}{SUFFIXE} ».",
    ]
    visees = [r for r in routes if r["spark_id"] == spark_id and r["enabled"]]
    if not visees:
        lignes.append("#")
        lignes.append("# Aucune route ne vise ce Spark.")
    lignes.extend(
        f"{route['domain']} {route['target_port']} "
        f"{'tls' if route['tls'] else 'clair'}"
        for route in sorted(visees, key=lambda r: r["domain"]))
    return "\n".join(lignes) + "\n"


def lire(kind: str, lecteur: Callable[[str], str | None]) -> dict[str, Any]:
    """L'état d'une proposition, telle que la cellule la porte (§55.8)."""
    paire = definition(kind)
    brut = lecteur(chemin(kind))
    corps = sans_entete(kind, brut)
    return {
        "kind": paire["kind"],
        "nature": paire["nature"],
        "title": paire["titre"],
        "expected": paire["attendu"],
        "path": chemin(kind),
        "target": paire["reel"],
        "present": bool(corps),
        "body": corps,
        "sha256": empreinte(corps) if corps else None,
    }


def poser_manquants(lecteur: Callable[[str], str | None],
                    pousseur: Callable[[str, str], None]) -> list[str]:
    """Crée les `.?` absents, et NE TOUCHE À RIEN d'autre (§55.5).

    Deux raisons de les poser plutôt que d'attendre qu'on les crée :

    - ils rendent le mécanisme découvrable d'un simple `ls`, sans qu'on ait eu à
      le lire quelque part ;
    - ils permettent au compte de la seconde porte d'écrire dedans SANS que le
      répertoire lui soit ouvert en écriture (§55.6) — ouvrir le répertoire
      autoriserait à supprimer ou renommer `BRIEFING.md` et `env`.

    **Un `.?` qui porte déjà quelque chose n'est jamais écrasé.** Écraser une
    proposition en attente au premier geste venu détruirait exactement ce que
    cette unité existe pour transporter.
    """
    poses = []
    for paire in PAIRES:
        kind = paire["kind"]
        if not vide(kind, lecteur(chemin(kind))):
            continue
        pousseur(chemin(kind), entete(kind))
        poses.append(chemin(kind))
    return poses


def vider(kind: str, pousseur: Callable[[str, str], None]) -> None:
    """Remet le `.?` à son en-tête seul : une décision a été prise (§55.5).

    Vidé, et non supprimé : le fichier permanent est ce qui rend le mécanisme
    découvrable, et ce qui permet au groupe d'y écrire sans droit sur le
    répertoire.
    """
    pousseur(chemin(kind), entete(kind))


def exiger_fraiche(kind: str, lecteur: Callable[[str], str | None],
                   attendue: str | None) -> dict[str, Any]:
    """Refuse si le fichier a changé depuis la relecture (§55.5.2).

    Rend l'état courant avec le refus : le propriétaire doit pouvoir voir ce
    qu'il allait accorder sans l'avoir lu.
    """
    courante = lire(kind, lecteur)
    if not courante["present"]:
        raise SuggestionError(
            f"Il n'y a plus de proposition dans « {chemin(kind)} » : elle a été "
            "vidée ou reprise entre-temps. Rien n'a été fait.",
            "no_suggestion")
    if not attendue or attendue != courante["sha256"]:
        raise SuggestionPerimee(
            "Cette proposition a changé depuis que vous l'avez ouverte : "
            "quelqu'un l'a réécrite dans la cellule. Relisez-la avant de "
            "décider — rien n'a été fait.", courante)
    return courante
