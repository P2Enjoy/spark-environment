"""L'identité SSH que le Spark PRÉSENTE — le sens inverse de `sshkeys`.

@spec docs/BACKLOG.md#SPK-74 · docs/BACKLOG.md#SPK-167 · docs/DAT.md §17.5
      (l'identité présentée), §17.6 (pour QUEL compte), §17.2 (ce qui n'est
      jamais stocké), §42.2 bis (le mode est une observation), §42.2 quater (le
      dossier du compte reste à root), §42.5 (exec_capture), §14.6 du design
      system (zéro, en cours et indisponible sont trois états)

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

**L'identité appartient au compte qui fait tourner la pile (SPK-167, §17.6).**
Sur un Spark amorcé en rootless, c'est `spark-docker` — celui qui clone et qui
construit —, pas `root`. Elle était posée sous `/root/.ssh` pour tous : la console
l'affichait, l'exploitant la collait chez GitHub, et le seul compte censé s'en
servir ne pouvait ni traverser `/root` (`0700`) ni lire une clé `0600 root`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .bootstrap import COMPTE_ROOTLESS, DOSSIER_SSH_ROOTLESS
from .sshkeys import SshKeyError, parse

#: Le nom de fichier de l'identité. FIXE, parce qu'un client SSH le lit par défaut
#: dans le `~/.ssh` de CELUI QUI L'EXÉCUTE : le rendre configurable obligerait à
#: écrire un `~/.ssh/config` que le locataire n'attend pas.
NOM_CLE = "id_ed25519"


@dataclass(frozen=True)
class Emplacement:
    """Où vit l'identité d'un Spark, et à QUEL compte elle appartient (§17.6).

    `compte` vaut `None` pour `root` : aucun `chown` n'est alors nécessaire, et
    c'est ce qui garde le chemin enraciné strictement identique à celui de SPK-74.
    """

    dossier: str
    compte: str | None

    @property
    def privee(self) -> str:
        return f"{self.dossier}/{NOM_CLE}"

    @property
    def publique(self) -> str:
        return f"{self.privee}.pub"


#: Enraciné — ou aucun relevé d'amorçage : pas de mode, donc pas de compte à qui
#: donner quoi que ce soit (§42.2 bis).
EMPLACEMENT_ROOT = Emplacement("/root/.ssh", None)

#: Rootless. Le dossier est celui de la seconde porte (§42.2 quater) et reste
#: `root:spark-docker 0750` : le compte lit son identité, mais ne peut ni la
#: supprimer, ni la remplacer, ni réécrire son propre `authorized_keys`.
EMPLACEMENT_ROOTLESS = Emplacement(DOSSIER_SSH_ROOTLESS, COMPTE_ROOTLESS)


def emplacement(rootless: bool) -> Emplacement:
    """L'emplacement de l'identité pour ce mode, et rien d'autre.

    Le mode est celui du DERNIER RELEVÉ D'AMORÇAGE — l'appelant le lit au
    registre, comme la seconde porte —, jamais l'existence du compte : un compte
    créé par une pose interrompue ne dit pas que le démon rootless tourne
    (§42.2 bis).
    """
    return EMPLACEMENT_ROOTLESS if rootless else EMPLACEMENT_ROOT


#: Conservés pour ce qui nomme encore le chemin enraciné (§17.5).
CHEMIN_PRIVEE = EMPLACEMENT_ROOT.privee
CHEMIN_PUBLIQUE = EMPLACEMENT_ROOT.publique

#: Les trois états du §14.6, et il en faut bien trois. « Absente » et
#: « illisible » demandent deux gestes opposés : créer, ou démarrer le Spark.
PRESENTE = "presente"
ABSENTE = "absente"
INDISPONIBLE = "indisponible"

#: Code de sortie choisi pour « elle existe déjà ». Distinct de 1, que rend
#: n'importe quel échec de shell : les confondre ferait dire « déjà présente »
#: sur une cellule où `ssh-keygen` manque.
DEJA = 3

#: Code de sortie choisi pour « la paire de root a été reprise » (§17.6). Ce n'est
#: PAS un échec, et ce n'est pas tout à fait un succès ordinaire non plus : la
#: clé rendue est celle qui existait déjà, donc celle que le tiers connaît, et le
#: journal doit pouvoir le dire. La stdout porte la clé publique, comme à 0.
REPRISE = 5

#: Relevé. N'écrit RIEN — on doit pouvoir regarder sans créer (§42.1).
#: `$1` porte le chemin de la clé PUBLIQUE : lu par défaut dans `/root`, dans le
#: foyer du compte en rootless.
RELEVE = """
if [ -f "$1" ]; then cat "$1"; else exit 4; fi
"""

#: Création, jouée EN ROOT dans la cellule.
#:
#: `$1` dossier SSH de l'identité · `$2` compte qui la reçoit (vide pour root) ·
#: `$3` dossier SSH de root d'où reprendre une paire (vide hors rootless) ·
#: `$4` commentaire · `$5` « oui » pour remplacer.
#:
#: Tout passe en ARGUMENT et rien par interpolation : un nom de Spark n'a pas à
#: pouvoir fermer une quote, et les chemins sont ainsi les mêmes que ceux que la
#: preuve joue dans un dossier temporaire.
#:
#: `ssh-keygen` tourne en root parce que le dossier du compte lui est fermé en
#: écriture (§42.2 quater) ; la paire est REMISE au compte ensuite. La clé privée
#: naît bien dans la cellule et n'en sort pas (§17.5).
#:
#: Un dossier de compte qui existe déjà n'est PAS retouché : la seconde porte l'a
#: posé et `_ouvrir_au_rootless` l'entretient. Le refaire ici le défairait.
CREATION = f"""
set -eu
umask 077
dossier=$1; compte=$2; reprise=$3; commentaire=$4; remplacer=$5
privee=$dossier/{NOM_CLE}
publique=$privee.pub
if [ -n "$compte" ]; then
  id "$compte" >/dev/null
fi
if [ -z "$compte" ]; then
  mkdir -p "$dossier"
  chmod 700 "$dossier"
elif [ ! -d "$dossier" ]; then
  mkdir -p "$dossier"
  chown "root:$(id -gn "$compte")" "$dossier"
  chmod 750 "$dossier"
fi
existe=non
if [ -f "$privee" ] || [ -f "$publique" ]; then existe=oui; fi
if [ "$existe" = oui ] && [ "$remplacer" != oui ]; then exit {DEJA}; fi
rm -f "$privee" "$publique"
code=0
if [ "$existe" = non ] && [ "$remplacer" != oui ] && [ -n "$reprise" ] \
   && [ -f "$reprise/{NOM_CLE}" ] && [ -f "$reprise/{NOM_CLE}.pub" ]; then
  cp "$reprise/{NOM_CLE}" "$privee"
  cp "$reprise/{NOM_CLE}.pub" "$publique"
  code={REPRISE}
else
  ssh-keygen -t ed25519 -N '' -C "$commentaire" -f "$privee" >/dev/null 2>&1
fi
chmod 600 "$privee"
chmod 644 "$publique"
if [ -n "$compte" ]; then
  chown "$compte:" "$privee" "$publique"
fi
cat "$publique"
exit "$code"
"""


class IdentityError(RuntimeError):
    """Refus actionnable. Le message est destiné à l'exploitant."""


def commentaire(spark_name: str) -> str:
    """Ce que la clé publique portera en clair, et qu'on relira chez GitHub.

    Le nom du Spark, préfixé : dans une liste de clés de déploiement, « crm »
    seul ne dit pas d'où vient la clé.
    """
    return f"spark:{spark_name}"


def _publique(sortie: str, lieu: Emplacement) -> dict[str, Any]:
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
            "key_type": cle.key_type, "path": lieu.privee}


def _vide(etat: str, lieu: Emplacement) -> dict[str, Any]:
    """Un état sans clé : `path` dit quand même OÙ elle vivra (§17.6)."""
    return {"state": etat, "public_key": None, "fingerprint": None,
            "comment": None, "key_type": None, "path": lieu.privee}


def relever(driver, incus_name: str, *, rootless: bool = False) -> dict[str, Any]:
    """État de l'identité, sans jamais rien écrire.

    Un Spark arrêté rend `INDISPONIBLE` et non `ABSENTE`. C'est le §14.6 pris à
    la lettre : fondre les deux ferait créer une seconde identité en croyant
    réparer la première, et invaliderait la clé déjà posée chez le tiers.

    `rootless` désigne le compte qui fait tourner la pile (§17.6). Sur un Spark
    rootless dont seule `root` porte une identité, le relevé rend `ABSENTE` : c'est
    exact pour le compte qui travaille, et la reprise est un geste de `creer`, pas
    un effet de bord d'une lecture.
    """
    lieu = emplacement(rootless)
    code, sortie, _ = driver.exec_capture(
        incus_name, ["sh", "-c", RELEVE, "sh", lieu.publique])
    if code == 4:
        return _vide(ABSENTE, lieu)
    if code != 0:
        return _vide(INDISPONIBLE, lieu)
    return _publique(sortie, lieu)


def creer(driver, incus_name: str, spark_name: str, *,
          remplacer: bool = False, rootless: bool = False) -> dict[str, Any]:
    """Fait naître l'identité DANS la cellule et rend sa partie publique.

    `remplacer` est refusé par défaut, et ce n'est pas une précaution de
    principe : régénérer invalide la clé de déploiement déjà posée chez le
    tiers, le dépôt cesse d'être clonable, et rien sur la Forge ne le sait
    (§17.5).

    `rootless` désigne le compte qui reçoit la paire (§17.6). Sans remplacement,
    sur un compte qui n'a pas d'identité alors que `root` en porte une, la paire
    de `root` est REPRISE telle quelle : c'est l'état qu'a laissé le défaut de
    SPK-167, et sa clé est peut-être déjà posée chez un tiers. `adopted` le dit.
    """
    lieu = emplacement(rootless)
    reprise = EMPLACEMENT_ROOT.dossier if lieu.compte else ""
    code, sortie, erreur = driver.exec_capture(
        incus_name,
        ["sh", "-c", CREATION, "sh", lieu.dossier, lieu.compte or "", reprise,
         commentaire(spark_name), "oui" if remplacer else "non"],
    )
    if code == DEJA:
        raise IdentityError(
            "Ce Spark a déjà une identité. La remplacer invalide la clé de "
            "déploiement déjà posée chez le tiers : demander explicitement le "
            "remplacement."
        )
    if code not in (0, REPRISE):
        detail = (erreur or sortie or "").strip().splitlines()
        raise IdentityError(
            "La cellule n'a pas pu créer l'identité"
            + (f" : {detail[-1]}" if detail else " et n'a rien dit.")
        )
    return {**_publique(sortie, lieu), "adopted": code == REPRISE}
