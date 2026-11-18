"""Poser la ligne d'une console dans `allowed_signers`, sans geste manuel.

@spec docs/BACKLOG.md#SPK-172 · docs/DAT.md §70.3 (par qui, quand, comment) ·
      §36.10.5 (où vivent les clés autorisées) · §36.10.2 bis (le principal)

La console est seule à connaître le principal (`console/<serveur>`) et la clé
publique qui signe pour ce serveur. Elle appelle ce module par SSH, en root,
à la première ouverture du tunnel :

    python -m sparkd.signataires poser --principal console/<serveur> \\
        --cle '<type> <base64>'

Le module revalide les deux valeurs — la console l'a fait, mais ce qui s'exécute
en root ne fait confiance à personne —, remplace la ligne du MÊME principal si
la clé a changé, garde toutes les autres, et écrit de façon atomique. Il rend
une ligne JSON : `{"etat": "deja" | "pose" | "remplace", "fichier": …}`.

Une ligne déjà juste n'est pas réécrite : le geste est rejoué à chaque
démarrage de la console, et il ne doit rien coûter quand il n'y a rien à faire.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from .config import DEFAULT_ALLOWED_SIGNERS
from .signature import NAMESPACE

#: Le principal que la console déclare : `console/<nom de l'inventaire>`. Le nom
#: suit la forme que l'inventaire de la console accepte, sans espace ni virgule
#: — un principal d'`allowed_signers` n'en porte pas (§36.10.2 bis).
PRINCIPAL = re.compile(r"^console/[a-z0-9][a-z0-9._-]{0,62}$")

#: Une clé publique OpenSSH : un type connu, puis du base64. Rien d'autre — un
#: commentaire ou une option glissés ici deviendraient des options de la ligne.
CLE = re.compile(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|"
                 r"sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)"
                 r" [A-Za-z0-9+/]+={0,3}$")


class Refus(ValueError):
    """Une valeur que le module refuse d'écrire."""


def ligne_de(principal: str, cle: str) -> str:
    """La ligne exacte, telle que `ssh-keygen -Y verify` la lit (§36.10.5)."""
    if not PRINCIPAL.fullmatch(principal or ""):
        raise Refus(f"principal invalide : {principal!r} (attendu console/<serveur>)")
    brute = str(cle or "").strip()
    # Une seule ligne : couper au premier champ un texte qui en porterait deux
    # poserait la première ET tairait le reste. On refuse.
    if "\n" in brute or "\r" in brute:
        raise Refus("clé publique invalide : une seule ligne attendue")
    # Le commentaire d'un fichier .pub (« nom@poste ») est retiré : il ne sert
    # pas à la vérification, et il n'a pas à être écrit sur la Forge.
    cle = " ".join(brute.split()[:2])
    if not CLE.fullmatch(cle):
        raise Refus("clé publique invalide : attendu « <type> <base64> », sans commentaire")
    return f'{principal} namespaces="{NAMESPACE}" {cle}'


def _principal_de(ligne: str) -> str | None:
    champs = ligne.split()
    if not champs or ligne.lstrip().startswith("#"):
        return None
    return champs[0]


def poser(principal: str, cle: str, fichier: str | Path = DEFAULT_ALLOWED_SIGNERS) -> str:
    """Pose la ligne de ce principal. Rend `deja`, `pose` ou `remplace`."""
    voulue = ligne_de(principal, cle)
    chemin = Path(fichier)
    existantes = chemin.read_text("utf-8").splitlines() if chemin.exists() else []
    gardees = [l for l in existantes if _principal_de(l) != principal]
    du_principal = [l for l in existantes if _principal_de(l) == principal]
    if du_principal == [voulue]:
        return "deja"
    etat = "remplace" if du_principal else "pose"
    contenu = "\n".join([*gardees, voulue]) + "\n"
    chemin.parent.mkdir(parents=True, exist_ok=True)
    descripteur, temporaire = tempfile.mkstemp(dir=chemin.parent, prefix=f".{chemin.name}.")
    try:
        with os.fdopen(descripteur, "w", encoding="utf-8") as sortie:
            sortie.write(contenu)
        os.chmod(temporaire, 0o644)
        os.replace(temporaire, chemin)
    except BaseException:
        Path(temporaire).unlink(missing_ok=True)
        raise
    return etat


def main(argv: list[str] | None = None) -> int:
    lecteur = argparse.ArgumentParser(
        prog="python -m sparkd.signataires",
        description="Pose la ligne d'une console dans allowed_signers (docs/DAT.md §70.3).")
    actions = lecteur.add_subparsers(dest="action", required=True)
    pose = actions.add_parser("poser", help="pose ou remplace la ligne d'un principal")
    pose.add_argument("--principal", required=True, help="console/<serveur>")
    pose.add_argument("--cle", required=True, help="clé PUBLIQUE : « <type> <base64> »")
    pose.add_argument("--fichier", default=DEFAULT_ALLOWED_SIGNERS,
                      help=f"fichier allowed_signers (défaut : {DEFAULT_ALLOWED_SIGNERS})")
    args = lecteur.parse_args(argv)
    try:
        etat = poser(args.principal, args.cle, args.fichier)
    except Refus as refus:
        print(json.dumps({"etat": "refus", "message": str(refus)}, ensure_ascii=False))
        return 2
    except OSError as erreur:
        print(json.dumps({"etat": "echec", "message": f"écriture impossible : {erreur.strerror}"},
                         ensure_ascii=False))
        return 1
    print(json.dumps({"etat": etat, "fichier": str(args.fichier)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
