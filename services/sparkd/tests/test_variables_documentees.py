"""Aucune variable d'environnement ne vit hors des fichiers d'exemple.

@verifies docs/BACKLOG.md#SPK-100 · docs/DAT.md §53 (aucune option cachée),
          §53.1 (les quatre cases d'un réglage) · CLAUDE.md §3 (règle non
          négociable : aucune exception ne sera tolérée)

Cette preuve BALAIE LE DÉPÔT. C'est délibéré : la règle ne tient pas par la
vigilance de qui relit un diff — huit leviers non documentés avaient traversé
trois semaines de relectures —, elle tient parce qu'une variable oubliée rend
cette suite rouge.

Le critère est la LECTURE : tout ce que le code interroge dans son
environnement, quel que soit le langage et quel que soit le périmètre. Le
fichier d'exemple et la documentation doivent tous deux la nommer, faute de quoi
elle est un levier que personne ne peut trouver.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[3]

#: Les trois grammaires par lesquelles le dépôt lit son environnement.
LECTURES = (
    re.compile(r"process\.env\.(SPARKD?_[A-Z0-9_]+)"),
    re.compile(r"process\.env\[['\"](SPARKD?_[A-Z0-9_]+)['\"]\]"),
    re.compile(r"os\.environ(?:\.get)?[\(\[]['\"](SPARKD?_[A-Z0-9_]+)['\"]"),
    re.compile(r"source\.get\(['\"](SPARKD?_[A-Z0-9_]+)['\"]"),
    re.compile(r"\$\{(SPARKD?_[A-Z0-9_]+)(?::-[^}]*)?\}"),
)

#: Où l'on cherche. Les fichiers de test en sont exclus : ils POSENT des
#: variables pour éprouver ce qui les lit, et exiger qu'un environnement de test
#: soit documenté comme un réglage du produit ferait du bruit, pas une garantie.
SOURCES = (
    ("services/sparkd/src", (".py",)),
    ("apps/webui/host", (".js",)),
    ("apps/webui/src", (".js",)),
    ("scripts", (".sh",)),
    ("e2e", (".mjs",)),
)

EXEMPLES = (".env.example", "services/sparkd/sparkd.env.example")

#: Les documents où une variable doit AUSSI se trouver. Le fichier d'exemple dit
#: comment la poser ; le README dit à quoi elle sert et ce qu'elle vaut par
#: défaut. L'un ne remplace pas l'autre.
DOCUMENTS = ("README.md",)


def _fichiers():
    for dossier, suffixes in SOURCES:
        base = RACINE / dossier
        if not base.exists():
            continue
        for chemin in sorted(base.rglob("*")):
            if (chemin.is_file() and chemin.suffix in suffixes
                    and ".test." not in chemin.name
                    and not chemin.name.startswith("test_")):
                yield chemin


def variables_lues() -> dict[str, list[str]]:
    """Chaque variable lue, et par quels fichiers — le message doit le dire."""
    trouvees: dict[str, list[str]] = {}
    for chemin in _fichiers():
        texte = chemin.read_text(encoding="utf-8", errors="replace")
        for motif in LECTURES:
            for nom in motif.findall(texte):
                trouvees.setdefault(nom, []).append(
                    str(chemin.relative_to(RACINE)))
    return trouvees


def _contenu(noms: tuple[str, ...]) -> str:
    return "\n".join((RACINE / nom).read_text(encoding="utf-8")
                     for nom in noms if (RACINE / nom).exists())


@pytest.fixture(scope="module")
def lues() -> dict[str, list[str]]:
    trouvees = variables_lues()
    # Garde-fou du garde-fou : un balayage qui ne trouve plus rien passerait
    # silencieusement, et c'est exactement ainsi qu'une preuve cesse de prouver.
    assert len(trouvees) >= 10, (
        "le balayage ne trouve presque plus de variables : les motifs ou les "
        f"chemins ont dérivé du dépôt ({sorted(trouvees)})")
    return trouvees


def test_toute_variable_lue_figure_dans_un_fichier_d_exemple(lues):
    """CLAUDE.md §3 : le fichier d'exemple est l'inventaire COMPLET, commenté."""
    exemples = _contenu(EXEMPLES)
    absentes = {nom: sorted(set(ou)) for nom, ou in lues.items()
                if nom not in exemples}
    assert absentes == {}, (
        "ces variables sont lues par le code et ne figurent dans aucun fichier "
        f"d'exemple ({', '.join(EXEMPLES)}) :\n"
        + "\n".join(f"  {nom} — lue par {', '.join(ou)}"
                    for nom, ou in sorted(absentes.items()))
        + "\nAjoutez-les avec un commentaire, ou supprimez le levier.")


def test_toute_variable_lue_est_documentee(lues):
    """Le fichier d'exemple dit comment poser ; le README dit à quoi ça sert."""
    documents = _contenu(DOCUMENTS)
    absentes = {nom: sorted(set(ou)) for nom, ou in lues.items()
                if nom not in documents}
    assert absentes == {}, (
        "ces variables sont lues par le code et ne sont nommées dans aucun "
        f"document ({', '.join(DOCUMENTS)}) :\n"
        + "\n".join(f"  {nom} — lue par {', '.join(ou)}"
                    for nom, ou in sorted(absentes.items())))


def test_chaque_variable_de_l_exemple_porte_un_COMMENTAIRE(lues):
    """Un nom sans explication n'est pas documenté : c'est une liste de courses.

    La règle du responsable exige le commentaire, pas seulement la présence. On
    vérifie donc qu'une ligne de commentaire précède immédiatement chaque
    variable — sa définition ou sa forme commentée.
    """
    for exemple in EXEMPLES:
        lignes = (RACINE / exemple).read_text(encoding="utf-8").splitlines()
        muettes = []
        for i, ligne in enumerate(lignes):
            declaration = re.match(r"^#?\s*(SPARKD?_[A-Z0-9_]+)=", ligne)
            if not declaration:
                continue
            # On remonte : les lignes qui précèdent doivent porter du commentaire
            # avant de rencontrer une ligne vide ou une autre déclaration.
            #
            # Une déclaration COMMENTÉE — la forme d'un exemple qu'on ne veut pas
            # poser par défaut — compte comme du commentaire : elle en est un.
            # Seule une déclaration active ferme le bloc.
            precedentes = []
            for avant in reversed(lignes[:i]):
                if re.match(r"^SPARKD?_[A-Z0-9_]+=", avant) or not avant.strip():
                    break
                precedentes.append(avant)
            explique = [l for l in precedentes
                        if l.lstrip().startswith("#")
                        and not re.match(r"^#\s*SPARKD?_[A-Z0-9_]+=", l.lstrip())]
            if not explique:
                muettes.append(declaration.group(1))
        assert muettes == [], (
            f"{exemple} : ces variables n'ont aucun commentaire au-dessus "
            f"d'elles — {', '.join(muettes)}")


def test_les_variables_SUPPRIMEES_ne_reviennent_pas(lues):
    """§53.2 : trois leviers ont été retirés parce que personne ne les posait.

    Les rétablir « pour rendre un module injectable » referait exactement le
    défaut que l'unité corrige — c'est le motif qui les avait produits.
    """
    retirees = {"SPARK_SSH_CONFIG", "SPARK_CONSOLE_ANCHORS",
                "SPARK_FORGE_INSTALL_STATE", "SPARKD_PREFIX", "SPARK_DEV_STATE"}
    revenues = sorted(retirees & set(lues))
    assert revenues == [], (
        f"ces leviers ont été retirés par le SPK-100 et sont relus : {revenues}. "
        "Le chemin se passe en PARAMÈTRE, et un réglage d'installation est un "
        "argument nommé (§53.2, §53.4).")
