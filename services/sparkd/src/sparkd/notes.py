"""Les trois notes d'un Spark : ce qu'on écrit pour celui qui arrivera après.

@spec docs/BACKLOG.md#SPK-104 · docs/DAT.md §54 (les trois notes), §54.2 (trois
      destinataires), §54.3 (ce qu'une note est), §54.4 (le registre écrit, la
      cellule propose), §54.6 (la garde des secrets), §54.7 (l'en-tête), §54.8
      (permissions), §54.9 (la surface d'API) · docs/SCHEMA.md §10 septies

Une note est une **projection**, comme tout ce que le plan de contrôle pose dans
une cellule (§17.1, §43.2, §44.4). L'écrire à la main dans la cellule n'a aucun
effet durable ; ce qui vient de la cellule passe par le fichier `.?` du §55.

C'est une décision révisée le 2026-09-14 : la première rédaction du §54 en
faisait les seuls fichiers à double sens du produit, avec réconciliation et
quarantaine. Le canal unique du §55 a rendu tout cela inutile — et le produit n'a
plus aucune exception à sa règle.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from . import audit

#: Le dossier des notes. Un dossier se nomme d'une phrase — « vos notes sont dans
#: /etc/spark/notes/ » — là où trois fichiers dispersés en demandent trois, et
#: qu'on ne retient pas (§54.2).
DOSSIER = "/etc/spark/notes"

#: 64 Kio par note (§54.9). Ce n'est pas une limite de stockage : c'est la taille
#: au-delà de laquelle un dossier collé dans une conversation cesse d'être lu en
#: entier par son destinataire.
TAILLE_MAX = 64 * 1024

#: §54.6 : en deçà, on ne cherche pas. Un secret de trois caractères rendrait la
#: moitié des textes français impossibles à enregistrer, et une valeur si courte
#: n'a de toute façon aucune confidentialité à protéger.
PLANCHER_SECRET = 8

ORIGINE_CONSOLE = "console"
ORIGINE_SUGGESTION = "suggestion"

#: Les trois notes, leur fichier et ce que chacune est CENSÉE contenir (§54.2).
#: `attendu` n'est pas une décoration : il est écrit dans l'en-tête du fichier et
#: dans le dossier pour un LLM, parce qu'un agent qui range ses notes
#: d'intégration dans `CONTRIBUTORS.md` les met là où personne ne les cherchera.
NOTES: tuple[dict[str, str], ...] = (
    {
        "id": "readme",
        "fichier": "README.md",
        "titre": "README",
        "attendu": "Ce qu'est ce Spark et à quoi il sert : le service qu'il "
                   "porte, son rôle, ce qui dépend de lui.",
        "lecteur": "quiconque ouvre la fenêtre de ce Spark ou entre dans la cellule",
    },
    {
        "id": "contributors",
        "fichier": "CONTRIBUTORS.md",
        "titre": "CONTRIBUTORS",
        "attendu": "Comment ce Spark est CONFIGURÉ : d'où viennent les sources, "
                   "où vivent les fichiers de configuration, où sont déployés "
                   "les artefacts, où se lisent les variables — de quoi entrer "
                   "et agir sans avoir à tout redécouvrir.",
        "lecteur": "celui qui entre dans la cellule pour agir",
    },
    {
        "id": "install",
        "fichier": "INSTALL.md",
        "titre": "INSTALL",
        "attendu": "Comment s'interfacer avec ce que ce Spark EXPOSE : points "
                   "d'entrée, routes, jetons, formats d'échange — ce qu'un "
                   "logiciel tiers doit savoir pour l'intégrer.",
        "lecteur": "un tiers, qui n'entrera jamais dans la cellule",
    },
)

IDENTIFIANTS = tuple(note["id"] for note in NOTES)

#: Le marqueur qui ouvre l'en-tête posé par le produit (§54.7). Il est RETIRÉ à
#: la lecture : sans cela, un texte repris depuis la cellule l'empilerait.
MARQUEUR = "<!-- spark:note"
FIN_ENTETE = "-->"

#: SPK-105 · §55 : le suffixe du fichier par lequel la cellule propose. Il est
#: DÉFINI ici, et non importé de `suggestions`, pour que la dépendance aille dans
#: un seul sens — `suggestions` connaît les notes, l'inverse ferait un cycle.
SUFFIXE_SUGGESTION = ".?"

#: §54.8 : la note se LIT par la seconde porte, et s'écrit par le registre. Le
#: dossier suit le régime du §44.10 ; le `.?` qui fait face à chaque note est
#: ouvert en écriture par le §55, et non ici.
DOSSIERS_OUVERTS = (DOSSIER,)


class NoteError(ValueError):
    """Une écriture refusée, avec le code que l'API rendra."""

    def __init__(self, message: str, code: str = "invalid_note") -> None:
        super().__init__(message)
        self.code = code


class NoteObsolete(NoteError):
    """La révision éditée a été dépassée (§54.9).

    Porte la note courante : un refus qui ne montre pas ce qui allait être perdu
    n'est qu'un obstacle.
    """

    def __init__(self, message: str, courante: dict[str, Any]) -> None:
        super().__init__(message, "stale_revision")
        self.courante = courante


def definition(note_id: str) -> dict[str, str]:
    """La définition d'une note, ou un refus nommé."""
    for note in NOTES:
        if note["id"] == note_id:
            return note
    raise NoteError(
        f"« {note_id} » n'est pas une note : les trois notes d'un Spark sont "
        + ", ".join(IDENTIFIANTS) + ".", "unknown_note")


def chemin(note_id: str) -> str:
    """Le chemin du fichier dans la cellule."""
    return f"{DOSSIER}/{definition(note_id)['fichier']}"


def _maintenant() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def normaliser(texte: str | None) -> str:
    """La forme CANONIQUE d'une note, stockée et projetée.

    Les fins de ligne sont ramenées à `\\n` et la queue est rognée : un texte
    rendu par un éditeur en CRLF et le même texte écrit ici sont le même texte,
    et le produit ne doit pas les compter pour deux.
    """
    if not texte:
        return ""
    return texte.replace("\r\n", "\n").replace("\r", "\n").rstrip(" \t\n")


def entete(note_id: str) -> str:
    """L'en-tête que le produit pose en tête du fichier (§54.7).

    Trois points, et aucun n'est décoratif :

    1. ce que ce fichier est censé contenir — la consigne de conformité. Un
       agent qui écrit ses notes d'intégration dans `CONTRIBUTORS.md` les met là
       où personne ne les cherchera ;
    2. que ce fichier est une PROJECTION : l'écrire à la main ne sert à rien,
       exactement comme `/etc/spark/env` et `/run/spark/secrets` (§44.9.7). Le
       dire ici évite le mode de panne que le §44.9.7 a mesuré sur un agent réel
       — la pile marche, puis cesse de marcher, loin du geste ;
    3. qu'aucun secret ne s'y écrit, parce que ce texte est fait pour être copié
       vers un modèle tiers, et que le produit refuse celui qui en porte un.
    """
    note = definition(note_id)
    return "\n".join((
        f"{MARQUEUR}:{note['id']}",
        f"{note['titre']} — {note['attendu']}",
        "",
        "CE FICHIER EST POSÉ PAR LE PLAN DE CONTRÔLE, depuis son registre, et",
        "réécrit en entier à chaque changement.",
        "",
        "L'éditer ici n'a aucun effet durable : la prochaine écriture du plan de",
        "contrôle écrase ce que vous aurez mis — comme pour /etc/spark/env et",
        "/run/spark/secrets.",
        "",
        f"POUR LA MODIFIER DEPUIS LA CELLULE, écrivez votre version dans le",
        f"fichier voisin « {chemin(note_id)}{SUFFIXE_SUGGESTION} » : c'est une",
        "PROPOSITION de remplacement intégral, que le propriétaire du Spark",
        "relira et acceptera ou non. Rien ne s'applique tout seul.",
        "",
        "N'Y ÉCRIVEZ AUCUN SECRET : ce texte est fait pour être copié vers un",
        "modèle tiers. Le plan de contrôle refuse un texte portant la valeur d'un",
        "secret qu'il connaît, et ne le republie nulle part.",
        "",
        "Ce bloc est écrit par sparkd ; ce qui suit est le texte de la note.",
        FIN_ENTETE,
        "",
    ))


def sans_entete(brut: str | None) -> str:
    """Retire l'en-tête du produit, s'il ouvre le fichier (§54.7).

    Reconnu par son MARQUEUR de tête, et non par une égalité au texte que nous
    aurions écrit : un auteur qui corrige une faute dans le bloc ne doit pas se
    retrouver avec deux en-têtes empilés.

    Sert à la reprise d'une note proposée depuis la cellule (§55) : le fichier
    `.?` est souvent une COPIE du fichier réel, en-tête compris, dont on n'a
    changé que le corps.
    """
    texte = normaliser(brut)
    if not texte.startswith(MARQUEUR):
        return texte
    coupure = texte.find(FIN_ENTETE)
    if coupure < 0:
        # Un en-tête ouvert et jamais fermé n'est pas le nôtre : on ne coupe
        # rien plutôt que d'avaler tout le fichier.
        return texte
    return normaliser(texte[coupure + len(FIN_ENTETE):].lstrip("\n"))


def contenu_fichier(note_id: str, corps: str) -> str:
    """Ce qui est réellement posé dans la cellule : l'en-tête, puis le texte."""
    return entete(note_id) + normaliser(corps) + "\n"


def secret_present(texte: str, secrets: dict[str, str]) -> str | None:
    """Le NOM du secret dont la valeur figure dans ce texte, ou `None` (§54.6).

    Les valeurs entrent ici et n'en sortent JAMAIS : la fonction rend un nom de
    variable, et rien d'autre. Le §43.5.1 tient — ce qui est déchiffré part vers
    la cellule, ou ne sort pas.

    Comparaison LITTÉRALE, casse comprise, au-dessus du plancher. Une garde qui
    devine refuse un jour un texte innocent, et ce jour-là elle est désactivée
    par celui qu'elle gêne.
    """
    if not texte:
        return None
    for nom in sorted(secrets):
        valeur = secrets[nom]
        if valeur and len(valeur) >= PLANCHER_SECRET and valeur in texte:
            return nom
    return None


def _ligne(note_id: str, rangee: sqlite3.Row | None) -> dict[str, Any]:
    """Une note rendue, écrite ou non.

    Une note JAMAIS ÉCRITE n'a pas de ligne au registre (SCHEMA §10 septies) :
    elle est rendue vide en révision 0. « Personne n'a encore écrit » n'est pas
    « quelqu'un a écrit une chaîne vide », et l'écran les distingue (§14.6).
    """
    note = definition(note_id)
    commun = {
        "id": note["id"], "file": note["fichier"], "title": note["titre"],
        "expected": note["attendu"], "path": chemin(note["id"]),
    }
    if rangee is None:
        return {**commun, "body": "", "revision": 0, "origin": None,
                "updated_at": None, "written": False}
    return {**commun, "body": rangee["body"], "revision": int(rangee["revision"]),
            "origin": rangee["origin"], "updated_at": rangee["updated_at"],
            "written": True}


def lire(connection: sqlite3.Connection, spark_id: str,
         note_id: str) -> dict[str, Any]:
    """Une note, telle que le registre la porte — la seule vérité (§54.4)."""
    rangee = connection.execute(
        "SELECT * FROM spark_note WHERE spark_id = ? AND note_id = ?",
        (spark_id, definition(note_id)["id"])).fetchone()
    return _ligne(note_id, rangee)


def lister(connection: sqlite3.Connection, spark_id: str) -> list[dict[str, Any]]:
    """Les trois notes, dans l'ordre du §54.2 — jamais dans celui de la base."""
    return [lire(connection, spark_id, note["id"]) for note in NOTES]


def _valider(texte: str, secrets: dict[str, str]) -> str:
    """Les deux refus qui valent pour TOUTE entrée au registre (§54.6, §54.9).

    L'ordre compte : la taille avant la garde, puisque la garde est la seule à
    manipuler des valeurs déchiffrées et qu'un texte hors bornes n'a pas à les
    approcher.
    """
    corps = normaliser(texte)
    if len(corps.encode("utf-8")) > TAILLE_MAX:
        raise NoteError(
            f"Ce texte dépasse {TAILLE_MAX // 1024} Kio. Au-delà, le dossier "
            "collé à un agent cesse d'être lu en entier.", "too_long")
    fautif = secret_present(corps, secrets)
    if fautif:
        # §54.6 : on nomme la VARIABLE, jamais la valeur. Le message est lu à
        # l'écran et peut être recopié ; y remettre la valeur reproduirait
        # exactement la fuite qu'on refuse.
        raise NoteError(
            f"Ce texte contient la valeur du secret « {fautif} ». Une note est "
            "faite pour être copiée vers un modèle tiers : elle ne peut pas "
            "porter un secret. Retirez la valeur et nommez la variable à la "
            "place.", "secret_in_note")
    return corps


def _ecrire(connection: sqlite3.Connection, spark_id: str, note_id: str,
            corps: str, origine: str) -> dict[str, Any]:
    """Écrit une révision. Elle AVANCE, quelle que soit l'origine."""
    courante = lire(connection, spark_id, note_id)
    connection.execute(
        """INSERT INTO spark_note (spark_id, note_id, body, revision, origin,
                                   updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(spark_id, note_id) DO UPDATE SET
               body = excluded.body,
               revision = excluded.revision,
               origin = excluded.origin,
               updated_at = excluded.updated_at""",
        (spark_id, note_id, corps, courante["revision"] + 1, origine,
         _maintenant()))
    ecrite = lire(connection, spark_id, note_id)
    audit.record(
        connection, None, "spark.note.set", "ok",
        f"Note « {definition(note_id)['titre']} » écrite "
        + ("depuis la console" if origine == ORIGINE_CONSOLE
           else "depuis une proposition de la cellule")
        + f" (révision {ecrite['revision']}).",
        target_type="spark", target_id=spark_id,
        # §21.4 : l'identifiant, la révision et la LONGUEUR, jamais le texte. Un
        # journal est fait pour être partagé, et une note peut porter n'importe
        # quoi.
        payload={"note": note_id, "revision": ecrite["revision"],
                 "origin": origine, "length": len(corps)})
    return ecrite


def enregistrer(connection: sqlite3.Connection, spark_id: str, note_id: str,
                corps: str, revision: int | None,
                secrets: dict[str, str]) -> dict[str, Any]:
    """Enregistre une note DEPUIS LA CONSOLE (§54.9).

    La **révision éditée** est obligatoire, et vérifiée avant tout le reste : un
    texte périmé ne mérite pas qu'on l'analyse, et l'écraser en silence perdrait
    ce qu'un autre onglet — ou une proposition acceptée entre-temps — venait
    d'écrire.
    """
    note = definition(note_id)
    courante = lire(connection, spark_id, note["id"])
    if revision is None or int(revision) != courante["revision"]:
        raise NoteObsolete(
            "Ce texte a changé depuis que vous l'avez ouvert : il est en "
            f"révision {courante['revision']}"
            + (f", écrite depuis {courante['origin']}" if courante["origin"] else "")
            + f", et vous enregistrez la {revision}. Rien n'a été écrit.",
            courante)
    return _ecrire(connection, spark_id, note["id"],
                   _valider(corps, secrets), ORIGINE_CONSOLE)


def accepter(connection: sqlite3.Connection, spark_id: str, note_id: str,
             corps: str, secrets: dict[str, str]) -> dict[str, Any]:
    """Écrit une note venue d'une PROPOSITION de la cellule (§55).

    Aucune révision n'est exigée : ce n'est pas un texte qu'on a ouvert dans un
    éditeur, c'est une proposition qu'on vient de relire à l'écran, et
    l'empreinte du §55.5.2 garantit déjà qu'elle n'a pas changé entre la
    relecture et l'accord.

    La garde du §54.6 s'applique, elle, sans nuance : un texte porteur d'un
    secret est refusé, et le §55.5 veut que sa proposition ne soit alors PAS
    consommée — son auteur peut ainsi la corriger.
    """
    # Le `.?` d'une note est souvent une COPIE du fichier réel dont on n'a changé
    # que le corps : l'agent ouvre README.md, le recopie, l'édite. Sans ce
    # retrait, l'avertissement du produit entrerait au registre, puis serait
    # reprojeté SOUS un second avertissement, et ainsi de suite.
    return _ecrire(connection, spark_id, definition(note_id)["id"],
                   _valider(sans_entete(corps), secrets), ORIGINE_SUGGESTION)


def a_projeter(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Les notes que la cellule doit recevoir.

    Une note jamais écrite n'y est pas : poser un fichier ne portant que
    l'en-tête du produit ferait croire à un texte que personne n'a rédigé.
    """
    return [note for note in notes if note["written"]]
