"""Les mises à jour du système de la Forge, relevées en lecture seule.

@spec docs/BACKLOG.md#SPK-171 · docs/DAT.md §70.5 (ce qui est relevé, d'où,
      et ce que l'absence veut dire) · §70.6 (les pools ZFS à mettre à niveau,
      montrés ici et proposés à l'installation) · §31.3 (lecture seule) ·
      docs/BACKLOG.md#SPK-181, docs/DAT.md §73 (appliquer les mises à jour
      choisies : `Application`, en fin de module)

Ce module ne lance ni `apt update`, ni `apt upgrade`, ni `do-release-upgrade` :
il lit ce que le système sait DÉJÀ — les listes d'apt rafraîchies par son propre
minuteur, les fichiers que le système pose quand un redémarrage est requis ou
qu'une version est disponible. Il date ce qu'il lit, pour que l'écran puisse dire
de quand date la liste (`DESIGN_SYSTEM.md` §6.13).

Toutes les lectures passent par `Lecteur`, pour s'éprouver sans machine.
"""

from __future__ import annotations

import fcntl
import os
import re
import subprocess
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

#: Plafond de paquets rendus : la liste reste lisible, et le NOMBRE réel est
#: toujours donné à côté (§70.5).
PAQUETS_MAX = 200

FICHIER_REDEMARRAGE = "/var/run/reboot-required"
FICHIER_REDEMARRAGE_PAQUETS = "/var/run/reboot-required.pkgs"
FICHIER_VERSION = "/var/lib/ubuntu-release-upgrader/release-upgrade-available"
APT_CHECK = "/usr/lib/update-notifier/apt-check"
TEMOINS_LISTE = ("/var/lib/apt/periodic/update-success-stamp", "/var/lib/apt/lists")


@dataclass
class Lecteur:
    """Accès en lecture seule. `executer` rend (code, sortie, erreur) ou `None`."""

    executer: Callable[[list[str]], tuple[int, str, str] | None]
    lire: Callable[[str], str | None]
    date_de: Callable[[str], float | None]
    presence: Callable[[str], bool] = field(default=lambda chemin: os.path.exists(chemin))


def lecteur_local() -> Lecteur:
    def executer(commande: list[str]) -> tuple[int, str, str] | None:
        try:
            vu = subprocess.run(commande, capture_output=True, text=True, timeout=60,
                                env={**os.environ, "LANG": "C", "LC_ALL": "C"})
        except (OSError, subprocess.SubprocessError):
            return None
        return vu.returncode, vu.stdout, vu.stderr

    def lire(chemin: str) -> str | None:
        try:
            with open(chemin, encoding="utf-8", errors="replace") as fichier:
                return fichier.read()
        except OSError:
            return None

    def date_de(chemin: str) -> float | None:
        try:
            return os.stat(chemin).st_mtime
        except OSError:
            return None

    return Lecteur(executer=executer, lire=lire, date_de=date_de)


def _iso(horodatage: float | None) -> str | None:
    if horodatage is None:
        return None
    return datetime.fromtimestamp(horodatage, timezone.utc).isoformat(timespec="seconds")


#: `apt list --upgradable` : « nom/suite version arch [upgradable from: ancienne] ».
_LIGNE_APT = re.compile(
    r"^(?P<nom>[^/\s]+)/(?P<suite>\S+)\s+(?P<version>\S+)\s+\S+\s+"
    r"\[upgradable from:\s*(?P<installee>[^\]]+)\]")


def paquets_en_attente(sortie: str) -> list[dict]:
    """Les paquets que `apt list --upgradable` propose, ceux de sécurité en tête."""
    paquets = []
    for ligne in sortie.splitlines():
        trouve = _LIGNE_APT.match(ligne.strip())
        if not trouve:
            continue
        suites = trouve["suite"].split(",")
        paquets.append({
            "nom": trouve["nom"], "installee": trouve["installee"].strip(),
            "proposee": trouve["version"], "suite": trouve["suite"],
            "securite": any(s.endswith("-security") for s in suites),
        })
    return sorted(paquets, key=lambda p: (not p["securite"], p["nom"]))


def compte_apt_check(erreur: str) -> tuple[int, int] | None:
    """`apt-check` écrit « N;M » (mises à jour ; dont sécurité) sur sa sortie d'erreur."""
    trouve = re.search(r"^(\d+);(\d+)\s*$", erreur.strip(), re.M)
    return (int(trouve[1]), int(trouve[2])) if trouve else None


def version_disponible(texte: str | None) -> dict:
    """Le fichier du motd de mise à niveau : vide, aucune ; sinon la version citée."""
    if texte is None:
        return {"connue": False, "disponible": None}
    trouve = re.search(r"New release '([^']+)' available", texte)
    return {"connue": True, "disponible": trouve[1] if trouve else None}


def pools_a_niveau(sortie: str) -> list[dict]:
    """Les pools que `zpool upgrade` liste, avec leurs fonctionnalités à activer.

    @spec docs/BACKLOG.md#SPK-176 · docs/DAT.md §70.6

    Une fonctionnalité marquée `(*)` ne s'active pas par `zpool upgrade` : elle
    est rendue à part et ne compte pas.
    """
    if "POOL  FEATURE" not in sortie:
        return []
    pools: list[dict] = []
    for ligne in sortie.split("POOL  FEATURE", 1)[1].splitlines():
        if not ligne.strip() or set(ligne.strip()) == {"-"}:
            continue
        if not ligne[0].isspace():
            pools.append({"pool": ligne.strip(), "fonctionnalites": [], "manuelles": []})
        elif pools:
            nom = ligne.strip()
            if nom.endswith("(*)"):
                pools[-1]["manuelles"].append(nom[:-3])
            else:
                pools[-1]["fonctionnalites"].append(nom)
    return [p for p in pools if p["fonctionnalites"]]


def releve(lecteur: Lecteur) -> dict:
    """Le relevé de `GET /v1/forge/systeme` (docs/DAT.md §70.5)."""
    os_release = lecteur.lire("/etc/os-release") or ""
    nom = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', os_release, re.M)
    noyau = lecteur.executer(["uname", "-r"])

    apt = lecteur.executer(["apt", "list", "--upgradable"])
    paquets = paquets_en_attente(apt[1]) if apt and apt[0] == 0 else []
    total, securite = len(paquets), None
    if lecteur.presence(APT_CHECK):
        compte = lecteur.executer([APT_CHECK])
        lu = compte_apt_check(compte[2]) if compte else None
        if lu:
            total, securite = lu
    elif paquets:
        securite = sum(1 for p in paquets if p["securite"])

    liste = next((d for d in (lecteur.date_de(t) for t in TEMOINS_LISTE) if d is not None), None)

    requis = lecteur.presence(FICHIER_REDEMARRAGE)
    demandeurs = (lecteur.lire(FICHIER_REDEMARRAGE_PAQUETS) or "").split() if requis else []

    zpool = lecteur.executer(["zpool", "upgrade"])
    return {
        "source": "hote",
        "releve_a": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "os": nom[1] if nom else None,
        "noyau": noyau[1].strip() if noyau and noyau[0] == 0 else None,
        "mises_a_jour": {
            "total": total, "securite": securite,
            "paquets": paquets[:PAQUETS_MAX], "paquets_rendus": min(len(paquets), PAQUETS_MAX),
            "liste_relue_a": _iso(liste),
        },
        "redemarrage": {"requis": requis, "paquets": sorted(set(demandeurs))},
        "version": version_disponible(lecteur.lire(FICHIER_VERSION)),
        "zfs": {"a_niveau": pools_a_niveau(zpool[1]) if zpool and zpool[0] == 0 else []},
    }


#: Le relevé de DÉMONSTRATION du pilote factice (§70.5) : il porte un exemplaire
#: de chaque cas que l'écran sait dire, et `source: "fake"`, que l'écran affiche.
RELEVE_FACTICE = {
    "source": "fake",
    "os": "Ubuntu 26.04.1 LTS",
    "noyau": "7.0.0-43-generic",
    "mises_a_jour": {
        "total": 3, "securite": 1,
        "paquets": [
            {"nom": "openssl", "installee": "3.5.2-1ubuntu1", "proposee": "3.5.2-1ubuntu1.1",
             "suite": "resolute-security", "securite": True},
            {"nom": "incus", "installee": "1:7.6-ubuntu26.04-202611101420",
             "proposee": "1:7.7-ubuntu26.04-202611171032", "suite": "resolute",
             "securite": False},
            {"nom": "linux-image-generic", "installee": "7.0.0-43.43",
             "proposee": "7.0.0-44.44", "suite": "resolute-updates", "securite": False},
        ],
        "paquets_rendus": 3,
        "liste_relue_a": "2026-11-18T07:34:00+00:00",
    },
    "redemarrage": {"requis": True, "paquets": ["linux-image-7.0.0-44-generic"]},
    "version": {"connue": True, "disponible": "26.10"},
    "zfs": {"a_niveau": [{"pool": "spark",
                          "fonctionnalites": ["fast_dedup", "longname", "physical_rewrite"],
                          "manuelles": ["dynamic_gang_header"]}]},
}


def releve_factice() -> dict:
    return {**RELEVE_FACTICE, "releve_a": datetime.now(timezone.utc).isoformat(timespec="seconds")}


# --- SPK-181 · DAT §73 : appliquer les mises à jour choisies -----------------
#
# @spec docs/BACKLOG.md#SPK-181 · docs/DAT.md §73.2 (refus 422 et 409, travail en
#       arrière-plan, une seule application à la fois, état borné) · §70.5

#: Un nom de paquet Debian, et rien d'autre : ni option, ni espace, ni `=version`.
NOM_PAQUET = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,127}$")
PAQUETS_PAR_APPLICATION = 500
LIGNES_GARDEES = 40
OCTETS_GARDES = 8 * 1024
VERROU_DPKG = "/var/lib/dpkg/lock-frontend"


class RefusApplication(ValueError):
    """Un refus que l'API rend tel quel : `code` 422 ou 409, et un message."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def commande_application(paquets: list[str]) -> list[str]:
    """La commande exacte (§73.2) : mettre à jour, jamais installer de nouveau."""
    return ["apt-get", "install", "-y", "--only-upgrade",
            "-o", "Dpkg::Options::=--force-confold", *paquets]


def valider(demandes: object, en_attente: set[str]) -> list[str]:
    """Les noms demandés, s'ils sont tous des mises à jour en attente (§73.2)."""
    if not isinstance(demandes, list) or not demandes:
        raise RefusApplication(422, "Aucun paquet n'est désigné.")
    if len(demandes) > PAQUETS_PAR_APPLICATION:
        raise RefusApplication(422, f"Au plus {PAQUETS_PAR_APPLICATION} paquets par application.")
    noms = []
    for nom in demandes:
        if not isinstance(nom, str) or not NOM_PAQUET.fullmatch(nom):
            raise RefusApplication(422, f"Nom de paquet invalide : {str(nom)[:60]!r}.")
        if nom not in en_attente:
            raise RefusApplication(
                422, f"« {nom} » n'est pas une mise à jour en attente sur cette Forge : "
                     "seul ce qui l'attend se met à jour.")
        if nom not in noms:
            noms.append(nom)
    return noms


def dpkg_verrouille(chemin: str = VERROU_DPKG) -> bool:
    """Le verrou d'apt est-il tenu (par `unattended-upgrades`, par exemple) ?"""
    try:
        with open(chemin, "a") as fichier:
            fcntl.lockf(fichier, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.lockf(fichier, fcntl.LOCK_UN)
        return False
    except BlockingIOError:
        return True
    except OSError:
        return False


def _executer_apt(commande: list[str]) -> tuple[int, str]:
    vu = subprocess.run(commande, capture_output=True, text=True, timeout=3600,
                        env={**os.environ, "DEBIAN_FRONTEND": "noninteractive",
                             "LANG": "C", "LC_ALL": "C"})
    return vu.returncode, (vu.stdout or "") + (vu.stderr or "")


class Application:
    """L'application en cours ou la dernière : une seule à la fois (§73.2).

    `executer` et `verrouille` sont des coutures : les preuves les remplacent,
    le pilote factice aussi. `fin` est appelé une fois le travail terminé, avec
    l'état final — c'est là que l'audit de l'issue s'écrit.
    """

    def __init__(self, *, executer=_executer_apt, verrouille=dpkg_verrouille,
                 fin=lambda etat: None, en_arriere_plan: bool = True):
        self._executer = executer
        self._verrouille = verrouille
        self._fin = fin
        self._fond = en_arriere_plan
        self._verrou = threading.Lock()
        self._etat: dict = {"etat": "aucune"}

    def etat(self) -> dict:
        with self._verrou:
            return dict(self._etat)

    def lancer(self, paquets: list[str], avant=lambda: None) -> dict:
        """`avant` s'exécute APRÈS les refus et AVANT le travail : c'est là que la
        demande s'inscrit au journal, jamais pour un geste refusé."""
        with self._verrou:
            if self._etat.get("etat") == "en_cours":
                raise RefusApplication(409, "Une application de mises à jour est déjà en cours.")
            if self._verrouille():
                raise RefusApplication(
                    409, f"Le gestionnaire de paquets est occupé ({VERROU_DPKG} est tenu, "
                         "par exemple par unattended-upgrades) : réessayer plus tard.")
            self._etat = {"etat": "en_cours", "paquets": list(paquets),
                          "debut": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "fin": None, "code": None, "sortie": ""}
            try:
                avant()
            except Exception:
                self._etat = {"etat": "aucune"}
                raise
        if self._fond:
            threading.Thread(target=self._travailler, args=(list(paquets),), daemon=True).start()
        else:
            self._travailler(list(paquets))
        return self.etat()

    def _travailler(self, paquets: list[str]) -> None:
        try:
            code, sortie = self._executer(commande_application(paquets))
        except Exception as erreur:  # le travail doit FINIR, et dire pourquoi
            code, sortie = -1, f"exécution impossible : {erreur}"
        lignes = deque((sortie or "").splitlines(), maxlen=LIGNES_GARDEES)
        texte = "\n".join(lignes)[-OCTETS_GARDES:]
        with self._verrou:
            self._etat.update({"etat": "terminee" if code == 0 else "echec", "code": code,
                               "sortie": texte,
                               "fin": datetime.now(timezone.utc).isoformat(timespec="seconds")})
            final = dict(self._etat)
        self._fin(final)


def en_attente_reel(lecteur: Lecteur) -> set[str]:
    """TOUS les noms en attente, sans le plafond d'affichage."""
    apt = lecteur.executer(["apt", "list", "--upgradable"])
    return {p["nom"] for p in paquets_en_attente(apt[1])} if apt and apt[0] == 0 else set()
