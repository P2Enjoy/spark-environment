"""L'identité de la build installée.

@verifies docs/BACKLOG.md#SPK-53 · docs/DAT.md §40 (la build installée se
          nomme), §40.1 (un seul mécanisme : le fichier posé à l'installation),
          §40.2 (« inconnue » est une réponse, pas un défaut)
"""

import json
from pathlib import Path

from sparkd import build


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
