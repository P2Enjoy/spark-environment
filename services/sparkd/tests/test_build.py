"""L'identité de la build installée.

RÉVISÉ le 2026-08-21 par SPK-66 : la version vient désormais des MÉTADONNÉES DU
PAQUET, dérivées du dépôt à la construction (§40.4). Ces preuves isolent donc le
fichier d'estampille en neutralisant `__version__` — sans quoi elles
mesureraient le paquet installé, et non ce qu'elles prétendent mesurer.

@verifies docs/BACKLOG.md#SPK-53 · docs/DAT.md §40 (la build installée se
          nomme), §40.1 (un seul mécanisme : le fichier posé à l'installation),
          §40.2 (« inconnue » est une réponse, pas un défaut)
"""

import json
from pathlib import Path

import pytest

from sparkd import build


@pytest.fixture(autouse=True)
def _sans_metadonnees(monkeypatch):
    """Neutralise la version du paquet pour éprouver le FICHIER seul.

    Les métadonnées priment sur lui (§40.4) : sans cette neutralisation, chaque
    preuve ci-dessous lirait le commit du paquet installé et passerait quoi qu'il
    arrive au fichier.
    """
    monkeypatch.setattr(build, "__version__", "0.0.0")


def test_build_absente_se_dit_inconnue(tmp_path: Path):
    """Une build non estampillée ne doit pas rendre une valeur plausible."""
    empreinte = build.identity(tmp_path / "build.json")
    assert empreinte["commit"] is None
    assert empreinte["version"].endswith("+inconnue")


def test_build_illisible_se_dit_inconnue(tmp_path: Path):
    """Un fichier corrompu vaut « inconnue », jamais une exception au démarrage."""
    fichier = tmp_path / "build.json"
    fichier.write_text("{ceci n'est pas du JSON", encoding="utf-8")
    assert build.identity(fichier)["commit"] is None


def test_build_estampillee_porte_le_commit(tmp_path: Path):
    fichier = tmp_path / "build.json"
    fichier.write_text(json.dumps({
        "commit": "abc123def456",
        "committed_at": "2026-08-20T15:31:28+02:00",
        "dirty": False,
        "installed_at": "2026-08-20T13:40:00Z",
        "installed_from": "poste:/home/x/spark-environment",
    }), encoding="utf-8")
    empreinte = build.identity(fichier)
    assert empreinte["commit"] == "abc123def456"
    assert empreinte["version"].endswith("+abc123def456")
    assert empreinte["dirty"] is False
    assert empreinte["installed_from"].endswith("spark-environment")


def test_un_arbre_sale_le_dit(tmp_path: Path):
    """Déployer un arbre modifié est licite ; le taire ne l'est pas."""
    fichier = tmp_path / "build.json"
    fichier.write_text(json.dumps({"commit": "abc123", "dirty": True}), encoding="utf-8")
    empreinte = build.identity(fichier)
    assert empreinte["dirty"] is True
    assert empreinte["version"].endswith("+abc123.sale")


def test_le_commit_vient_des_METADONNEES_du_paquet(monkeypatch, tmp_path):
    """@verifies docs/BACKLOG.md#SPK-66 · docs/DAT.md §40.4

    Ce que cette preuve garde : **le commit ne peut plus être oublié.** L'ancienne
    estampille demandait qu'on passe une variable à l'installation ; une Forge est
    apparue en « inconnue » le 2026-08-21 parce que quelqu'un l'avait omise.
    """
    monkeypatch.setattr(build, "__version__", "0.post1.dev561+g9761d83c2.d20260821")

    # Aucun fichier d'estampille : les métadonnées suffisent, seules.
    empreinte = build.identity(tmp_path / "build.json")
    assert empreinte["commit"] == "9761d83c2"
    assert empreinte["version"] == "0.post1.dev561+g9761d83c2.d20260821"


def test_les_METADONNEES_priment_sur_un_fichier_perime(monkeypatch, tmp_path):
    """Un fichier posé par une installation antérieure ne doit pas faire mentir
    un paquet réinstallé depuis. C'est le sens de la préséance."""
    monkeypatch.setattr(build, "__version__", "0.post1.dev561+g9761d83c2.d20260821")
    fichier = tmp_path / "build.json"
    fichier.write_text(json.dumps({"commit": "aaaaaaaaa", "installed_from": "poste"}),
                       encoding="utf-8")

    empreinte = build.identity(fichier)
    assert empreinte["commit"] == "9761d83c2", "le paquet fait foi"
    assert empreinte["installed_from"] == "poste", "le fichier garde ce qu'il seul sait"


def test_la_version_ne_dit_pas_DEUX_FOIS_le_commit(monkeypatch, tmp_path):
    """Mesuré : sans garde, on obtenait « …+g9761d83c2.d20260821+9761d83c2 » —
    un numéro qui dit deux fois la même chose et ne se compare plus à rien."""
    monkeypatch.setattr(build, "__version__", "0.post1.dev561+g9761d83c2.d20260821")
    rendu = build.identity(tmp_path / "absent.json")["version"]
    assert rendu.count("9761d83c2") == 1
