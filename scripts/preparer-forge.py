#!/usr/bin/env python3
"""Produit le schema de partitionnement et le cloud-init complets d'une Forge.

@spec docs/BACKLOG.md#SPK-158 · docs/DAT.md §66.2 a §66.4 (la decision, la regle
      de derivation, le cloud-init produit), §8.5, §8.6 · README.md (« Obtenir
      d'emblee une machine partitionnee ») · scripts/README.md ·
      docs/BACKLOG.md#SPK-159 (l'amorce dont le cloud-init porte le texte)

Deux sous-commandes, qui lisent le schema de partitionnement PAR DEFAUT de
l'offre — celui que la console de l'hebergeur affiche (« Reset to default ») :

    preparer-forge.py partitionnement --defaut defaut.json  > partitionnement.json
    preparer-forge.py cloud-init      --defaut defaut.json  > user-data.yaml

La sortie est sur la SORTIE STANDARD, prete a coller ; ce que la commande a
decide, et la taille produite, sont sur la sortie d'erreur. Un refus sort avec le
code 2, un message, et RIEN sur la sortie standard.

Aucune dependance hors de la bibliotheque standard, aucune variable d'environnement
(CLAUDE.md §3) : tout se lit dans la commande et dans `--help`.
"""

from __future__ import annotations

import argparse
import base64
import copy
import gzip
import json
import re
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
AMORCE = RACINE / "deploy" / "cloud-init" / "spark-amorce.sh"
CREER_POOL = RACINE / "scripts" / "creer-pool.sh"

GIB = 1024 ** 3
#: Le systeme d'une Forge ; la Forge de validation en consomme 2,7 Gio (DAT §66.3).
RACINE_GIO_DEFAUT = 200
#: Les deux ecritures du drapeau « tout l'espace restant » : la console de
#: l'hebergeur emploie la premiere, le contrat de l'API la seconde (DAT §66.1).
CLES_RESTE = ("useAllAvailableSpace", "use_all_available_space")
#: Un support de pool finit dans une ligne YAML puis dans un script lance en root :
#: chemins surs seulement. A employer avec `fullmatch` — jamais `match` avec `$`, que
#: Python laisse passer devant une fin de ligne finale (« /dev/sda5\n »).
SUPPORT_SUR = re.compile(r"/dev/[A-Za-z0-9._/-]+")


class Refus(Exception):
    """Une entree que la commande refuse de transformer, dite avec ses mots."""


# --- La regle de derivation (DAT §66.3) ---------------------------------------


def _drapeau(partition: dict) -> str | None:
    """La cle qui porte « tout l'espace restant » sur cette partition, si levee."""
    for cle in CLES_RESTE:
        if partition.get(cle) is True:
            return cle
    return None


def _support(disque: str, numero: int) -> str:
    """`/dev/sda` + 5 -> `/dev/sda5` ; `/dev/nvme0n1` + 5 -> `/dev/nvme0n1p5`."""
    return f"{disque}p{numero}" if disque[-1].isdigit() else f"{disque}{numero}"


def deriver(defaut: object, racine_gio: int) -> tuple[dict, list[str]]:
    """Le schema par defaut -> (le schema a fournir, les supports du pool).

    `root` est bornee, une partition `data` prend le reste, sur chaque disque ; tout
    le reste est recopie tel quel. Le schema d'entree n'est jamais modifie.
    """
    if not isinstance(defaut, dict) or not isinstance(defaut.get("disks"), list):
        raise Refus("le schema par defaut doit etre un objet JSON portant une liste « disks »")
    disques = defaut["disks"]
    if len(disques) < 2:
        raise Refus(f"une Forge exige deux disques (DAT §8.5) ; ce schema n'en porte que "
                    f"{len(disques)} — la machine n'est pas eligible")
    if defaut.get("zfs"):
        raise Refus("le schema par defaut declare deja un pool « zfs » : l'hebergeur le creerait "
                    "et laisserait sur les supports une signature que creer-pool.sh refuse "
                    "d'ecraser (DAT §8.6) ; la Forge cree son pool elle-meme")

    schema = copy.deepcopy(defaut)
    supports: list[str] = []
    for disque in schema["disks"]:
        nom = disque.get("device") if isinstance(disque, dict) else None
        partitions = disque.get("partitions") if isinstance(disque, dict) else None
        if not isinstance(nom, str) or not nom.startswith("/dev/") \
                or not isinstance(partitions, list) or not partitions:
            raise Refus("chaque disque doit porter un « device » /dev/… et une liste « partitions »")
        if not all(isinstance(p, dict) and isinstance(p.get("number"), int) for p in partitions):
            raise Refus(f"disque {nom} : chaque partition doit porter un « number » entier")

        restantes = [p for p in partitions if _drapeau(p)]
        if len(restantes) != 1:
            raise Refus(f"disque {nom} : {len(restantes)} partition(s) prennent « tout l'espace "
                        f"restant » ({' / '.join(CLES_RESTE)}) ; il en faut exactement une, celle "
                        "du systeme — est-ce bien le schema PAR DEFAUT de l'offre, et non un "
                        "schema deja derive ?")
        racine = restantes[0]
        if racine["number"] != max(p["number"] for p in partitions):
            raise Refus(f"disque {nom} : la partition « {racine.get('label')} » qui prend le reste "
                        "n'est pas la derniere ; aucune partition ne peut lui succeder")
        if racine.get("label") == "data":
            raise Refus(f"disque {nom} : la derniere partition est deja « data » — ce schema est "
                        "deja derive ; donnez le schema PAR DEFAUT de l'offre")
        if racine.get("label") != "root":
            raise Refus(f"disque {nom} : la partition qui prend le reste est « {racine.get('label')} », "
                        "pas « root » ; la commande ne borne que le systeme")

        cle = _drapeau(racine)
        racine["size"] = racine_gio * GIB
        racine[cle] = False
        numero = racine["number"] + 1
        partitions.append({"label": "data", "number": numero, "size": 0, cle: True})
        supports.append(_support(nom, numero))

    engages = {d for r in schema.get("raids") or [] for d in r.get("devices", [])}
    engages |= {f.get("device") for f in schema.get("filesystems") or []}
    pris = [s for s in supports if s in engages]
    if pris:
        raise Refus(f"{', '.join(pris)} figure deja dans « raids » ou « filesystems » : le miroir "
                    "natif exige des peripheriques nus (DAT §8.5)")
    return schema, supports


# --- Le cloud-init (DAT §66.4) -------------------------------------------------


def _entier_positif(valeur: str) -> int:
    try:
        n = int(valeur)
    except ValueError:
        n = 0
    if n < 1:
        raise argparse.ArgumentTypeError(f"un entier superieur ou egal a 1 est attendu, recu « {valeur} »")
    return n


def _verifier_support(liste: str) -> list[str]:
    supports = liste.split(",")
    if len(supports) < 2 or not all(SUPPORT_SUR.fullmatch(s) for s in supports):
        raise Refus("--pool-source attend au moins deux chemins /dev separes par une virgule, "
                    f"en caracteres surs (lettres, chiffres, . _ / -) ; recu « {liste} »")
    return supports


def _entree(chemin: str, script: str, compresser: bool = False) -> str:
    """Une entree de `write_files` : le script embarque, octet pour octet.

    Compresse (`gz+b64`, que cloud-init decode lui-meme), le contenu rendu est
    celui du script apres decompression : la taille change, pas le fichier pose.
    L'horodatage du gzip est fixe, donc la sortie reste reproductible.
    """
    if "\r" in script or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", script):
        raise Refus(f"{chemin} : caracteres de controle — il ne peut pas etre embarque tel quel")
    if not script.endswith("\n") or script.endswith("\n\n"):
        raise Refus(f"{chemin} : une seule fin de ligne en bout de fichier est attendue")
    if compresser:
        b64 = base64.b64encode(gzip.compress(script.encode("utf-8"), mtime=0)).decode("ascii")
        corps = "".join(f"      {b64[i:i + 76]}\n" for i in range(0, len(b64), 76))
        encodage = "gz+b64"
    else:
        corps = "".join(f"      {ligne}\n" if ligne else "\n" for ligne in script.split("\n")[:-1])
        encodage = "text/plain"
    return (f"  - path: {chemin}\n    permissions: '0755'\n    owner: root:root\n"
            f"    encoding: {encodage}\n    content: |\n{corps}")


def rendre_cloud_init(amorce: str, creer_pool: str, supports: list[str],
                      arc_gib: int | None, net_mbit: int | None,
                      compresser: bool = False) -> str:
    """Le YAML complet : deux fichiers deposes, une ligne `runcmd`."""
    options = ["--pool-source", ",".join(supports)]
    if arc_gib is not None:
        options += ["--arc-gib", str(arc_gib)]
    if net_mbit is not None:
        options += ["--net-mbit", str(net_mbit)]
    ligne = "/opt/spark-amorce.sh " + " ".join(options)
    return ("#cloud-config\n"
            "# Produit par scripts/preparer-forge.py : ne pas l'editer, relancer la commande.\n"
            "# L'amorce et creer-pool.sh sont embarques tels quels"
            + (" (compresses : gz+b64)" if compresser else "") + " ; `runcmd` ne joue qu'une fois\n"
            "# par instance, le rejeu passe par `sudo /opt/spark-amorce.sh` (README).\n"
            "\n"
            "write_files:\n"
            + _entree("/opt/spark-amorce.sh", amorce, compresser)
            + _entree("/opt/creer-pool.sh", creer_pool, compresser)
            + "\nruncmd:\n"
            f"  - '{ligne}'\n")


# --- La ligne de commande ------------------------------------------------------


def _lire_defaut(source: str) -> object:
    try:
        texte = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    except OSError as erreur:
        raise Refus(f"le schema par defaut est illisible : {erreur}") from erreur
    try:
        return json.loads(texte)
    except json.JSONDecodeError as erreur:
        raise Refus(f"le schema par defaut n'est pas du JSON valide (ligne {erreur.lineno}, "
                    f"colonne {erreur.colno}) : {erreur.msg}") from erreur


def _parseur() -> argparse.ArgumentParser:
    commun = argparse.ArgumentParser(add_help=False)
    commun.add_argument(
        "--defaut", metavar="FICHIER",
        help="le schema de partitionnement PAR DEFAUT de l'offre, tel que la console de "
             "l'hebergeur l'affiche (« Reset to default ») ; « - » lit l'entree standard")
    commun.add_argument(
        "--racine-gio", metavar="N", type=_entier_positif, default=RACINE_GIO_DEFAUT,
        help=f"taille de la partition systeme « root » en Gio (defaut {RACINE_GIO_DEFAUT} : la "
             "Forge de validation en consomme 2,7) ; « data » prend tout le reste")

    parseur = argparse.ArgumentParser(
        prog="preparer-forge.py",
        description="Produit le schema de partitionnement et le cloud-init complets d'une Forge, "
                    "prets a coller dans la console de l'hebergeur (DAT §66).")
    sous = parseur.add_subparsers(dest="commande", required=True, metavar="COMMANDE")

    sous.add_parser(
        "partitionnement", parents=[commun], help="ecrit le JSON a coller dans la console",
        description="Derive du schema par defaut de l'offre : « root » est bornee, une partition "
                    "« data » prend le reste de chaque disque, tout le reste est conserve. La "
                    "commande ne connait pas la capacite des disques : la console de l'hebergeur "
                    "controle que les tailles tiennent.")

    cloud = sous.add_parser(
        "cloud-init", parents=[commun], help="ecrit le user-data complet a coller dans la console",
        description="Ecrit le cloud-init complet : l'amorce et creer-pool.sh embarques tels quels, "
                    "et l'amorce lancee avec les supports du pool. Les supports se deduisent du "
                    "schema par defaut (--defaut) ou se donnent (--pool-source).")
    cloud.add_argument(
        "--pool-source", metavar="A,B",
        help="les DEUX supports du miroir, a la place de --defaut (ex. /dev/sda5,/dev/sdb5)")
    cloud.add_argument(
        "--arc-gib", metavar="N", type=_entier_positif,
        help="plafond de l'ARC ZFS en Gio, retire de la memoire allouable aux Sparks ; "
             "absent : l'amorce garde son defaut de 16, regle pour 94 Gio de RAM — "
             "A ADAPTER sur une machine qui en a moins")
    cloud.add_argument(
        "--compresser", action="store_true",
        help="embarque les deux scripts compresses (gz+b64, decodes par cloud-init) : environ 40 %% "
             "plus petit (mesure le 2026-11-10 : 11,5 Ko au lieu de 19 Ko), mais illisible a "
             "l'oeil. A employer si l'hebergeur refuse la taille du user-data (la limite n'est "
             "pas documentee)")
    cloud.add_argument(
        "--net-mbit", metavar="N", type=_entier_positif,
        help="debit du lien en Mbit/s, SEULEMENT si la carte n'en annonce aucun (virtio) ; "
             "absent : le debit est mesure")
    return parseur


def main(argv: list[str] | None = None) -> int:
    parseur = _parseur()
    args = parseur.parse_args(argv)
    try:
        if args.commande == "cloud-init":
            if bool(args.defaut) == bool(args.pool_source):
                raise Refus("donnez --defaut (les supports se deduisent) OU --pool-source, pas "
                            "les deux et pas aucun")
            if args.pool_source:
                supports = _verifier_support(args.pool_source)
            else:
                _, supports = deriver(_lire_defaut(args.defaut), args.racine_gio)
                _verifier_support(",".join(supports))
            sortie = rendre_cloud_init(AMORCE.read_text(encoding="utf-8"),
                                       CREER_POOL.read_text(encoding="utf-8"),
                                       supports, args.arc_gib, args.net_mbit, args.compresser)
            print(f"supports du pool : {','.join(supports)}", file=sys.stderr)
            print(f"user-data : {len(sortie.encode('utf-8'))} octets — la limite du champ "
                  "cloud-init chez l'hebergeur n'est pas documentee (DAT §66.4)", file=sys.stderr)
        else:
            if not args.defaut:
                raise Refus("--defaut est obligatoire : le schema par defaut de l'offre")
            schema, supports = deriver(_lire_defaut(args.defaut), args.racine_gio)
            sortie = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
            print(f"« root » bornee a {args.racine_gio} Gio, « data » prend le reste ; "
                  f"supports du pool : {','.join(supports)}", file=sys.stderr)
            print("la commande ne connait pas la capacite des disques : la console de l'hebergeur "
                  "controle les tailles", file=sys.stderr)
    except Refus as refus:
        print(f"preparer-forge.py : {refus}", file=sys.stderr)
        return 2
    sys.stdout.write(sortie)
    return 0


if __name__ == "__main__":
    sys.exit(main())
