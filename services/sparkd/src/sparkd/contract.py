"""Production du contrat d'API.

@spec docs/BACKLOG.md#SPK-17 · docs/DAT.md §23 (Le contrat d'API),
      §23.1 (un fichier committé), §23.2 (la dérive se détecte en régénérant)

La génération est **déterministe** : clés triées, indentation fixe, saut de ligne
final. Sans cela la vérification de dérive échouerait à chaque exécution, et
serait désactivée dans la semaine.
"""

from __future__ import annotations

import json
from pathlib import Path

CONTRACT_PATH = (
    Path(__file__).resolve().parents[4] / "packages" / "contract" / "openapi" / "sparkd.json"
)


def build() -> dict:
    """Rend le schéma OpenAPI de l'application, sans démarrer de serveur."""
    import tempfile

    from .app import create_app
    from .config import load

    with tempfile.TemporaryDirectory() as dossier:
        app = create_app(load({
            "SPARKD_DB": str(Path(dossier) / "contract.db"),
            "SPARKD_DRIVER": "fake",
        }))
        return app.openapi()


def serialize(schema: dict) -> str:
    """Sérialisation stable. Deux exécutions rendent le même octet."""
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write(path: Path | None = None) -> Path:
    cible = path or CONTRACT_PATH
    cible.parent.mkdir(parents=True, exist_ok=True)
    cible.write_text(serialize(build()), encoding="utf-8")
    return cible


def check(path: Path | None = None) -> tuple[bool, str]:
    """Compare le contrat committé à ce que le code produit.

    On ne fait pas confiance à la discipline pour maintenir deux choses en
    accord : on rend le désaccord détectable (docs/DAT.md §23.2).
    """
    cible = path or CONTRACT_PATH
    attendu = serialize(build())
    if not cible.exists():
        return False, (
            f"Contrat absent : {cible}. Le régénérer avec « make contract » et "
            "le committer."
        )
    actuel = cible.read_text(encoding="utf-8")
    if actuel == attendu:
        return True, "Le contrat committé correspond au code."

    from difflib import unified_diff

    ecart = list(unified_diff(
        actuel.splitlines(), attendu.splitlines(),
        fromfile="committé", tofile="produit par le code", lineterm="", n=1,
    ))
    return False, (
        "Le contrat committé ne correspond plus au code. Régénérer avec "
        "« make contract » et committer le résultat avec le changement d'API.\n"
        + "\n".join(ecart[:40])
    )
