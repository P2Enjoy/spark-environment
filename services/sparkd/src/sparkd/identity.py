"""L'identité SSH que le Spark PRÉSENTE — le sens inverse de `sshkeys`.

@spec docs/BACKLOG.md#SPK-74 · docs/DAT.md §17.5 (l'identité présentée),
      §17.2 (ce qui n'est jamais stocké), §42.5 (exec_capture), §14.6 du
      design system (zéro, en cours et indisponible sont trois états)

`sshkeys` décrit qui ENTRE dans un Spark : ses clés finissent dans
`authorized_keys`. Ce module décrit ce que le Spark présente quand il SORT — à
GitHub, en clé de déploiement, pour cloner un dépôt privé.

**La clé privée naît dans la cellule et n'en sort pas.** Rien ici ne la lit :
`ssh-keygen` s'exécute dans le Spark, et seule la partie publique remonte. Le
§17.2 est ainsi tenu par la construction — on ne demande rien au registre, donc
rien d'interdit ne peut y entrer.

**La cellule est la SEULE source.** Aucune copie au registre : elle divergerait
au premier `ssh-keygen` lancé à la main dans le Spark, et la console montrerait
alors une clé publique qui n'ouvre plus le dépôt, les deux côtés restant
individuellement cohérents (§17.5).
"""

from __future__ import annotations

from typing import Any

from .sshkeys import SshKeyError, parse

#: Chemin de l'identité dans la cellule. FIXE, parce qu'un client SSH le lit par
#: défaut : le rendre configurable obligerait à écrire un `~/.ssh/config` que le
#: locataire n'attend pas.
CHEMIN_PRIVEE = "/root/.ssh/id_ed25519"
CHEMIN_PUBLIQUE = f"{CHEMIN_PRIVEE}.pub"

#: Les trois états du §14.6, et il en faut bien trois. « Absente » et
#: « illisible » demandent deux gestes opposés : créer, ou démarrer le Spark.
PRESENTE = "presente"
ABSENTE = "absente"
INDISPONIBLE = "indisponible"

#: Code de sortie choisi pour « elle existe déjà ». Distinct de 1, que rend
#: n'importe quel échec de shell : les confondre ferait dire « déjà présente »
#: sur une cellule où `ssh-keygen` manque.
DEJA = 3

#: Relevé. N'écrit RIEN — on doit pouvoir regarder sans créer (§42.1).
RELEVE = f"""
if [ -f {CHEMIN_PUBLIQUE} ]; then cat {CHEMIN_PUBLIQUE}; else exit 4; fi
"""

#: Création. `$1` porte le commentaire, `$2` vaut « oui » pour remplacer.
#: Le commentaire passe en ARGUMENT et non par interpolation : un nom de Spark
#: n'a pas à pouvoir fermer une quote.
CREATION = f"""
set -eu
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ -f {CHEMIN_PRIVEE} ] || [ -f {CHEMIN_PUBLIQUE} ]; then
  if [ "$2" != oui ]; then exit {DEJA}; fi
  rm -f {CHEMIN_PRIVEE} {CHEMIN_PUBLIQUE}
fi
ssh-keygen -t ed25519 -N '' -C "$1" -f {CHEMIN_PRIVEE} >/dev/null 2>&1
chmod 600 {CHEMIN_PRIVEE}
cat {CHEMIN_PUBLIQUE}
"""


class IdentityError(RuntimeError):
    """Refus actionnable. Le message est destiné à l'exploitant."""


def commentaire(spark_name: str) -> str:
    """Ce que la clé publique portera en clair, et qu'on relira chez GitHub.

    Le nom du Spark, préfixé : dans une liste de clés de déploiement, « crm »
    seul ne dit pas d'où vient la clé.
    """
    return f"spark:{spark_name}"


def _publique(sortie: str) -> dict[str, Any]:
    """Traduit la ligne lue dans la cellule, ou refuse en disant pourquoi.

    La validation passe par `sshkeys.parse`, donc par le MÊME analyseur que les
    clés entrantes : deux analyseurs finiraient par accepter deux choses
    différentes, et l'empreinte affichée ici doit être celle que rend
    `ssh-keygen -lf` (§17.2).
    """
    try:
        cle = parse(sortie)
    except SshKeyError as erreur:
        raise IdentityError(
            f"La cellule n'a pas rendu une clé publique lisible : {erreur}"
        ) from erreur
    return {"state": PRESENTE, "public_key": cle.line,
            "fingerprint": cle.fingerprint, "comment": cle.comment,
            "key_type": cle.key_type, "path": CHEMIN_PRIVEE}


def relever(driver, incus_name: str) -> dict[str, Any]:
    """État de l'identité, sans jamais rien écrire.

    Un Spark arrêté rend `INDISPONIBLE` et non `ABSENTE`. C'est le §14.6 pris à
    la lettre : fondre les deux ferait créer une seconde identité en croyant
    réparer la première, et invaliderait la clé déjà posée chez le tiers.
    """
    code, sortie, _ = driver.exec_capture(incus_name, ["sh", "-c", RELEVE])
    if code == 4:
        return {"state": ABSENTE, "public_key": None, "fingerprint": None,
                "comment": None, "key_type": None, "path": CHEMIN_PRIVEE}
    if code != 0:
        return {"state": INDISPONIBLE, "public_key": None, "fingerprint": None,
                "comment": None, "key_type": None, "path": CHEMIN_PRIVEE}
    return _publique(sortie)


def creer(driver, incus_name: str, spark_name: str, *,
          remplacer: bool = False) -> dict[str, Any]:
    """Fait naître l'identité DANS la cellule et rend sa partie publique.

    `remplacer` est refusé par défaut, et ce n'est pas une précaution de
    principe : régénérer invalide la clé de déploiement déjà posée chez le
    tiers, le dépôt cesse d'être clonable, et rien sur la Forge ne le sait
    (§17.5).
    """
    code, sortie, erreur = driver.exec_capture(
        incus_name,
        ["sh", "-c", CREATION, "sh", commentaire(spark_name),
         "oui" if remplacer else "non"],
    )
    if code == DEJA:
        raise IdentityError(
            "Ce Spark a déjà une identité. La remplacer invalide la clé de "
            "déploiement déjà posée chez le tiers : demander explicitement le "
            "remplacement."
        )
    if code != 0:
        detail = (erreur or sortie or "").strip().splitlines()
        raise IdentityError(
            "La cellule n'a pas pu créer l'identité"
            + (f" : {detail[-1]}" if detail else " et n'a rien dit.")
        )
    return _publique(sortie)
