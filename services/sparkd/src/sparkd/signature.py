"""La signature d'un geste : forme canonique et vérification.

@spec docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.3 (où la signature est produite
      décide de ce qu'elle vaut), §36.4 (deux classes de lignes),
      §36.10 (le contrat), §36.10.2 (SSHSIG, mesuré), §36.10.3 (ce qui est
      signé), §36.10.4 (où la vérification a lieu), §36.10.5 (les clés
      autorisées) · §36.5 (les pièges de sérialisation)

**Ce que ce module N'EST PAS.** Ce n'est pas de l'authentification : la clé volée
signe, et l'arbitrage de SPK-35 (§45.4) l'a établi. Ce qu'une signature prouve,
c'est qu'un geste inscrit au journal a bien été DEMANDÉ, et n'a pas été fabriqué
par la Forge après coup.

Conséquence directe, et elle commande le contrat : **une requête non signée reste
acceptée**. Refuser faute de signature ferait de ce mécanisme un contrôle
d'accès. En revanche une signature PRÉSENTE et invalide est refusée — l'inscrire
ferait mentir le journal, qui affirmerait une preuve qu'il n'a pas.

**La vérification faite ici n'est pas la vraie.** Elle est faite par la machine
qu'on soupçonne : elle attrape l'erreur et le bruit, pas l'adversaire qui a root.
Qui audite rejoue la vérification AILLEURS, avec les octets et la signature que
le journal conserve — même principe que l'ancre du §36.2.
"""

from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from pathlib import Path

#: Version de la forme sérialisée du §36.10.3. Toute évolution est une RUPTURE et
#: se traite par une version nouvelle, jamais par un changement en place (§36.9.2).
VERSION = "sshsig-v1"

#: Espace de noms SSHSIG. Il n'est PAS décoratif : sans lui, une signature
#: produite par le responsable pour un autre usage — un commit, un courriel —
#: serait rejouable ici. MESURÉ : un espace de noms différent rend 255.
NAMESPACE = "spark-audit"

#: Champs retenus, et eux seuls (§36.10.3).
CHAMPS = ("action", "actor", "body", "method", "path", "ts")


class SignatureError(Exception):
    """Ce qui empêche de vérifier, dit en clair et sans le confondre avec un
    refus d'accès."""

    def __init__(self, message: str, motif: str):
        super().__init__(message)
        #: Le motif est stable ; le message est pour l'humain.
        self.motif = motif


def canonique(intention: dict) -> bytes:
    """Les octets du §36.10.3, figés.

    JSON, séparateurs sans espace, clés triées par ordre d'octets,
    `ensure_ascii`, UTF-8. Une valeur absente est sérialisée `null`, JAMAIS
    omise : omettre une clé produirait deux octets différents pour deux
    intentions équivalentes (§36.9.2).
    """
    retenu = {champ: intention.get(champ) for champ in CHAMPS}
    return json.dumps(retenu, sort_keys=True, ensure_ascii=True,
                      separators=(",", ":")).encode("utf-8")


def decrit_bien(octets: bytes, *, method: str, path: str, actor: str) -> bool:
    """Les octets signés décrivent-ils la requête REÇUE ?

    Sans ce contrôle, on signerait n'importe quoi et on l'attacherait à n'importe
    quel geste : la signature serait valide, et attachée à autre chose.
    """
    try:
        vu = json.loads(octets.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (vu.get("method") == method and vu.get("path") == path
            and vu.get("actor") == actor)


def _armure(signature: str) -> str:
    """Rend l'armure PEM si elle manque.

    L'en-tête voyage sur une ligne (§36.10.7) ; `ssh-keygen` exige l'armure.
    """
    propre = signature.strip()
    if propre.startswith("-----BEGIN SSH SIGNATURE-----"):
        return propre if propre.endswith("\n") else propre + "\n"
    corps = "".join(propre.split())
    lignes = [corps[i:i + 70] for i in range(0, len(corps), 70)]
    return ("-----BEGIN SSH SIGNATURE-----\n" + "\n".join(lignes)
            + "\n-----END SSH SIGNATURE-----\n")


def signataires(chemin: str | Path | None) -> Path | None:
    """Le fichier `allowed_signers`, s'il existe ET porte quelque chose.

    Absent ou vide, la fonction se DÉSACTIVE — elle ne tombe pas en panne
    (§36.10.5). Une signature qu'on ne peut rattacher à personne ne prouve rien.
    """
    if not chemin:
        return None
    fichier = Path(chemin)
    if not fichier.is_file() or not fichier.read_text("utf-8").strip():
        return None
    return fichier


def verifier(octets: bytes, signature: str, identite: str,
             allowed_signers: str | Path | None,
             *, executer=subprocess.run) -> None:
    """Vérifie une signature SSHSIG. Lève `SignatureError` si elle ne tient pas.

    MESURÉ sur OpenSSH 8.9p1 (§36.10.2) : `-Y verify` rend 0 quand tout tient, et
    255 sur un message altéré, une identité inconnue, un espace de noms différent
    ou une clé absente de la liste. Le code de sortie fait donc foi, et le
    message d'erreur d'OpenSSH est repris tel quel plutôt que reformulé — il
    nomme précisément lequel des quatre cas s'est produit.
    """
    fichier = signataires(allowed_signers)
    if fichier is None:
        raise SignatureError(
            "Aucun fichier de signataires autorisés n'est configuré sur cette "
            "Forge : une signature ne peut être rattachée à personne, et "
            "l'inscrire affirmerait une preuve qu'elle n'a pas. Réglez "
            "SPARKD_ALLOWED_SIGNERS, ou n'envoyez pas de signature.",
            "signataires_absents")

    with tempfile.TemporaryDirectory() as dossier:
        chemin_sig = Path(dossier) / "geste.sig"
        chemin_sig.write_text(_armure(signature), "utf-8")
        vu = executer(
            ["ssh-keygen", "-Y", "verify", "-f", str(fichier),
             "-I", identite, "-n", NAMESPACE, "-s", str(chemin_sig)],
            input=octets, capture_output=True, timeout=20)

    if vu.returncode != 0:
        detail = (vu.stderr or b"").decode("utf-8", "replace").strip()
        raise SignatureError(
            f"La signature de ce geste ne se vérifie pas : {detail or 'refusée'}. "
            "Elle n'est pas inscrite — un journal qui porte une signature "
            "invalide affirme une preuve qu'il n'a pas.",
            "signature_invalide")


def entete_present(entetes) -> bool:
    """Une signature accompagne-t-elle cette requête ?"""
    return bool(entetes.get("x-spark-signature"))


def lire_entetes(entetes) -> tuple[str, bytes]:
    """Extrait la signature et les octets signés d'une requête.

    Les octets VOYAGENT plutôt que d'être reconstruits (§36.10.7) : reconstruire
    supposerait que deux implémentations sérialisent à l'octet près, pour
    toujours — le premier piège du §36.5, doublé.
    """
    signature = (entetes.get("x-spark-signature") or "").strip()
    brut = (entetes.get("x-spark-signed") or "").strip()
    if not brut:
        raise SignatureError(
            "Une signature accompagne ce geste, mais pas les octets qu'elle "
            "couvre : il n'y a rien à vérifier. Envoyez X-Spark-Signed.",
            "octets_absents")
    try:
        octets = base64.b64decode(brut, validate=True)
    except Exception:
        raise SignatureError(
            "Les octets signés ne sont pas du base64 valide.",
            "octets_illisibles") from None
    return signature, octets
