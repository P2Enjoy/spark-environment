"""Sauvegarde et restauration du registre.

@spec docs/BACKLOG.md#SPK-36 · docs/CONTINGENCE.md §2 (perte ou corruption du
      registre), §2.2 (pourquoi une copie de fichier ne suffit pas) ·
      docs/DAT.md §36.9 (la chaîne d'intégrité) · §31.3 (lire n'est pas réparer)

**Le point qui décide de ce module.** Le registre est en mode WAL (`db.py`).
MESURÉ le 2026-08-20, pendant qu'une connexion écrivait :

    500 lignes écrites
    cp reg.db copie.db   → la copie s'ouvre SANS ERREUR et contient 490 lignes
    Connection.backup()  → 500 lignes

Dix lignes perdues en silence, et une copie qui ne se plaint pas. C'est le pire
mode de panne d'une sauvegarde : elle restaure, elle ne signale rien, et il
manque ce qu'on venait chercher. Les transactions validées vivent dans le fichier
`-wal` tant qu'aucun point de contrôle n'a eu lieu.

D'où l'API de sauvegarde en ligne, qui prend un instantané cohérent sans arrêter
le service.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import audit
from .config import DEFAULT_DB
from .db import connect

#: Suffixes que SQLite pose à côté du registre en mode WAL. Laissés en place lors
#: d'une restauration, ils seraient REJOUÉS par-dessus le fichier restauré.
ANNEXES = ("-wal", "-shm")


class SauvegardeError(Exception):
    """Ce qui empêche de sauvegarder ou de restaurer, dit en clair."""


def horodatage(maintenant=None) -> str:
    """`AAAAMMJJ-HHMMSS` en UTC. Un nom de fichier trié est un nom lisible."""
    instant = maintenant or datetime.now(timezone.utc)
    return instant.strftime("%Y%m%d-%H%M%S")


def verifier(chemin: Path) -> dict:
    """Ouvre le fichier et le CONTRÔLE. Ne modifie rien (§31.3).

    Deux contrôles, et ils ne disent pas la même chose : `integrity_check` porte
    sur la structure SQLite, la chaîne d'audit sur le contenu du journal. Une
    base structurellement saine peut porter une chaîne rompue, et l'inverse.
    """
    connexion = connect(chemin)
    try:
        structure = connexion.execute("PRAGMA integrity_check").fetchone()[0]
        chaine = audit.verify_chain(connexion)
    finally:
        connexion.close()
    return {"structure": structure, "chaine": chaine}


def _refuser_si_douteux(chemin: Path, vu: dict, quoi: str) -> None:
    if vu["structure"] != "ok":
        raise SauvegardeError(
            f"{quoi} « {chemin} » : integrity_check rend « {vu['structure']} ». "
            "Une base structurellement abîmée ne se restaure pas : elle "
            "remplacerait un problème par un problème plus difficile à voir.")
    if not vu["chaine"].get("intact"):
        rupture = vu["chaine"].get("break")
        raise SauvegardeError(
            f"{quoi} « {chemin} » : la chaîne du journal d'audit est ROMPUE "
            f"({rupture}). Le registre est peut-être utilisable, mais son journal "
            "ne prouve plus rien — et c'est précisément ce qu'on relit après un "
            "incident (docs/DAT.md §36).")


def sauvegarder(source: Path, destination: Path, maintenant=None) -> Path:
    """Prend un instantané COHÉRENT du registre, service en marche.

    La sauvegarde est VÉRIFIÉE avant que la fonction rende la main : une
    sauvegarde qu'on n'ouvre pas est une sauvegarde qu'on croit avoir.
    """
    source = Path(source)
    if not source.exists():
        raise SauvegardeError(f"Aucun registre à « {source} ».")

    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    fichier = destination / f"spark-{horodatage(maintenant)}.db"

    origine = connect(source)
    try:
        copie = sqlite3.connect(str(fichier))
        try:
            # L'API de sauvegarde en ligne : elle traverse le WAL, là où une
            # copie de fichier le laisse derrière (§2.2).
            origine.backup(copie)
        finally:
            copie.close()
    finally:
        origine.close()

    vu = verifier(fichier)
    if vu["structure"] != "ok" or not vu["chaine"].get("intact"):
        # On RETIRE la copie douteuse. La garder ferait croire qu'une sauvegarde
        # existe, ce qui est pire que de n'en avoir aucune.
        fichier.unlink(missing_ok=True)
        _refuser_si_douteux(fichier, vu, "La sauvegarde produite")
    return fichier


def restaurer(fichier: Path, vers: Path, maintenant=None) -> Path:
    """Remet un registre sauvegardé en place.

    Le registre remplacé est DÉPLACÉ, jamais écrasé : celui qu'on remplace est
    parfois moins abîmé qu'on ne le croyait, et on ne s'en aperçoit qu'après.
    """
    fichier = Path(fichier)
    vers = Path(vers)
    if not fichier.exists():
        raise SauvegardeError(f"Aucune sauvegarde à « {fichier} ».")

    _refuser_si_douteux(fichier, verifier(fichier), "La sauvegarde")

    remplace = None
    if vers.exists():
        remplace = vers.with_name(f"{vers.name}.remplace-{horodatage(maintenant)}")
        vers.rename(remplace)
        # Les annexes de l'ANCIEN registre partent avec lui : laissées en place,
        # SQLite les rejouerait par-dessus le registre restauré.
        for suffixe in ANNEXES:
            annexe = vers.with_name(vers.name + suffixe)
            if annexe.exists():
                annexe.rename(remplace.with_name(remplace.name + suffixe))

    vers.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(fichier, vers)
    return remplace


def _sparkd_tourne(bind: str = "127.0.0.1:9876") -> bool:
    """`sparkd` répond-il ? Restaurer sous un service actif laisserait DEUX
    vérités : celle du fichier et celle des connexions déjà ouvertes."""
    import socket

    hote, _, port = bind.rpartition(":")
    try:
        with socket.create_connection((hote or "127.0.0.1", int(port)), timeout=1):
            return True
    except OSError:
        return False


def main(argv: list[str] | None = None) -> int:
    analyseur = argparse.ArgumentParser(
        prog="sparkd.sauvegarde",
        description="Sauvegarde et restauration du registre (docs/CONTINGENCE.md §2).")
    analyseur.add_argument("destination", nargs="?",
                           help="répertoire où écrire la sauvegarde")
    analyseur.add_argument("--registre", default=DEFAULT_DB,
                           help=f"registre source (défaut : {DEFAULT_DB})")
    analyseur.add_argument("--restaurer", metavar="FICHIER",
                           help="restaure ce fichier au lieu de sauvegarder")
    analyseur.add_argument("--vers", default=DEFAULT_DB,
                           help="registre à remplacer lors d'une restauration")
    analyseur.add_argument("--bind", default="127.0.0.1:9876",
                           help="où sparkd écoute, pour vérifier qu'il est arrêté")
    args = analyseur.parse_args(sys.argv[1:] if argv is None else argv)

    try:
        if args.restaurer:
            if _sparkd_tourne(args.bind):
                print(f"sparkd répond sur {args.bind} : arrêtez-le avant de "
                      "restaurer, sinon deux vérités coexisteraient — celle du "
                      "fichier et celle des connexions ouvertes.", file=sys.stderr)
                return 2
            remplace = restaurer(Path(args.restaurer), Path(args.vers))
            print(f"Restauré : {args.restaurer} → {args.vers}")
            if remplace:
                print(f"  l'ancien registre est conservé : {remplace}")
            print("  vérifiez ensuite : python3 -m sparkd.preflight, puis "
                  "GET /v1/audit/verify (docs/CONTINGENCE.md §2.5).")
            return 0

        if not args.destination:
            analyseur.error("nommez un répertoire de destination, "
                            "ou employez --restaurer.")
        fichier = sauvegarder(Path(args.registre), Path(args.destination))
        vu = verifier(fichier)
        print(f"Sauvegardé : {fichier} ({fichier.stat().st_size} octets)")
        print(f"  structure : {vu['structure']}")
        print(f"  journal   : {vu['chaine']['length']} entrée(s), "
              f"chaîne {'intacte' if vu['chaine']['intact'] else 'ROMPUE'}")
        return 0
    except SauvegardeError as erreur:
        print(str(erreur), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
