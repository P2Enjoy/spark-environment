#!/usr/bin/env python3
"""Produit le schema de partitionnement et le cloud-init complets d'une Forge.

@spec docs/BACKLOG.md#SPK-158 · docs/DAT.md §66.2 a §66.4 (la decision, la regle
      de derivation, le cloud-init produit), §66.7 (les schemas par defaut des
      offres), §66.8 (le pool declare a l'hebergeur ; le JSON de partition versionne
      de chaque offre connue, le cloud-init produit a la demande), §8.5, §8.6 · README.md (« Commander une Forge ») ·
      scripts/README.md · deploy/cloud-init/offres/README.md ·
      docs/BACKLOG.md#SPK-159 (l'amorce dont le cloud-init porte le texte)

Trois sous-commandes. Les deux premieres partent du schema de partitionnement PAR
DEFAUT d'une offre — celui que la console de l'hebergeur affiche (« Reset to
default »), ou une offre CONNUE par son nom (deploy/cloud-init/offres/<offre>.json) :

    preparer-forge.py partitionnement --offre EM-B311X-SATA  > partitionnement.json
    preparer-forge.py cloud-init      --offre EM-B311X-SATA  > user-data.yaml
    preparer-forge.py partitionnement --defaut defaut.json   # une offre nouvelle

Le cloud-init EMBARQUE l'amorce : il se produit TOUJOURS a la demande, depuis l'amorce
courante, et n'est JAMAIS versionne — une copie evoluerait en retard sur le script.
La troisieme sous-commande ecrit, pour chaque offre connue, le seul JSON de partition,
versionne dans deploy/cloud-init/offres/forge/ (il ne depend que de la regle) :

    preparer-forge.py offres             # les (re)ecrit
    preparer-forge.py offres --verifier  # echoue si un fichier versionne est perime

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
#: Les schemas par defaut des offres, tels que l'hebergeur les affiche (DAT §66.7).
OFFRES = RACINE / "deploy" / "cloud-init" / "offres"

GIB = 1024 ** 3
#: Le systeme d'une Forge ; la Forge de validation en consomme 2,7 Gio (DAT §66.3).
RACINE_GIO_DEFAUT = 200
#: Le pool de la Forge : une convention du produit (le registre l'attend, l'amorce a
#: `POOL=spark`) — une preuve tient les deux ensemble (DAT §66.8).
NOM_POOL = "spark"
#: Les deux ecritures du drapeau « tout l'espace restant » : la console de
#: l'hebergeur emploie la premiere, le contrat de l'API la seconde (DAT §66.1).
CLES_RESTE = ("useAllAvailableSpace", "use_all_available_space")
#: Un support de pool finit dans une ligne YAML puis dans un script lance en root :
#: chemins surs seulement. A employer avec `fullmatch` — jamais `match` avec `$`, que
#: Python laisse passer devant une fin de ligne finale (« /dev/sda5\n »).
SUPPORT_SUR = re.compile(r"/dev/[A-Za-z0-9._/-]+")


class Refus(Exception):
    """Une entree que la commande refuse de transformer, dite avec ses mots."""


# --- La regle de derivation (DAT §66.3, §66.8) --------------------------------


def _drapeau(partition: dict) -> str | None:
    """La cle qui porte « tout l'espace restant » sur cette partition, si levee."""
    for cle in CLES_RESTE:
        if partition.get(cle) is True:
            return cle
    return None


def _support(disque: str, numero: int) -> str:
    """`/dev/sda` + 5 -> `/dev/sda5` ; `/dev/nvme0n1` + 5 -> `/dev/nvme0n1p5`."""
    return f"{disque}p{numero}" if disque[-1].isdigit() else f"{disque}{numero}"


def deriver(defaut: object, racine_gio: int,
            declarer_zfs: bool = True) -> tuple[dict, list[str]]:
    """Le schema par defaut -> (le schema a fournir, les supports du pool).

    `root` est bornee, puis une partition prend le reste de chaque disque ; tout le
    reste est recopie tel quel. Par defaut cette partition est `zfs` et le schema
    DECLARE le pool miroir a l'hebergeur (DAT §66.8) ; sans cela (`declarer_zfs=False`)
    elle est `data`, aucun pool n'est declare et l'amorce le cree (repli, §66.2 point 6).
    Le schema d'entree n'est jamais modifie.
    """
    if not isinstance(defaut, dict) or not isinstance(defaut.get("disks"), list):
        raise Refus("le schema par defaut doit etre un objet JSON portant une liste « disks »")
    disques = defaut["disks"]
    if len(disques) < 2:
        raise Refus(f"une Forge exige deux disques (DAT §8.5) ; ce schema n'en porte que "
                    f"{len(disques)} — la machine n'est pas eligible")
    if defaut.get("zfs"):
        raise Refus("le schema donne declare deja un pool « zfs » — est-ce un schema deja derive "
                    "par cette commande ? Donnez le schema PAR DEFAUT de l'offre : la commande "
                    "declare elle-meme le pool (DAT §66.8)")

    schema = copy.deepcopy(defaut)
    supports: list[str] = []
    libelle = "zfs" if declarer_zfs else "data"
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
        if racine.get("label") in ("data", "zfs"):
            raise Refus(f"disque {nom} : la derniere partition est deja « {racine['label']} » — ce "
                        "schema est deja derive ; donnez le schema PAR DEFAUT de l'offre")
        if racine.get("label") != "root":
            raise Refus(f"disque {nom} : la partition qui prend le reste est « {racine.get('label')} », "
                        "pas « root » ; la commande ne borne que le systeme")

        cle = _drapeau(racine)
        racine["size"] = racine_gio * GIB
        racine[cle] = False
        numero = racine["number"] + 1
        partitions.append({"label": libelle, "number": numero, "size": 0, cle: True})
        supports.append(_support(nom, numero))

    engages = {d for r in schema.get("raids") or [] for d in r.get("devices", [])}
    engages |= {f.get("device") for f in schema.get("filesystems") or []}
    pris = [s for s in supports if s in engages]
    if pris:
        raise Refus(f"{', '.join(pris)} figure deja dans « raids » ou « filesystems » : le miroir "
                    "natif exige des peripheriques nus (DAT §8.5)")
    if declarer_zfs:
        # Le contrat de l'API (SDK baremetal/v1) : `zfs.pools[]` avec name, type, devices,
        # options, filesystem_options. Seuls les trois premiers s'ecrivent : le format des
        # chaines d'options n'est pas documente, et la cle de `filesystem_options` dans le
        # dialecte de la console est une deduction — une cle absente vaut une liste vide,
        # une cle devinee peut etre refusee (DAT §66.8).
        schema["zfs"] = {"pools": [{"name": NOM_POOL, "type": "mirror", "devices": list(supports)}]}
    return schema, supports


def partitionnement_texte(schema: dict) -> str:
    """Le JSON a coller : la meme mise en forme que la console (2 espaces)."""
    return json.dumps(schema, indent=2, ensure_ascii=False) + "\n"


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


# --- Le JSON de partition versionne de chaque offre connue (DAT §66.8) ----------


def produire_offres(dossier: Path = OFFRES,
                    racine_gio: int = RACINE_GIO_DEFAUT) -> dict[Path, str]:
    """Pour chaque `<offre>.json` du dossier : son schema pour la Forge, tel qu'il doit
    etre versionne dans `<dossier>/forge/<offre>.partitionnement.json`.

    Le cloud-init n'en fait PAS partie : il embarque l'amorce, qui evolue — une copie
    versionnee serait en retard sur elle (DAT §66.8). Il se produit a la demande.
    """
    produits: dict[Path, str] = {}
    for offre in sorted(dossier.glob("*.json")):
        try:
            schema, supports = deriver(json.loads(offre.read_text(encoding="utf-8")), racine_gio)
            _verifier_support(",".join(supports))
        except (Refus, json.JSONDecodeError) as erreur:
            raise Refus(f"{offre.name} : {erreur}") from erreur
        produits[dossier / "forge" / f"{offre.stem}.partitionnement.json"] = partitionnement_texte(schema)
    return produits


def verifier_offres(dossier: Path = OFFRES,
                    racine_gio: int = RACINE_GIO_DEFAUT) -> list[str]:
    """Les ecarts entre ce qui est versionne et ce que la commande produit aujourd'hui :
    un fichier absent, perime, ou sans offre — un cloud-init pre-compile traine dans
    `forge/` est « sans offre ». Vide : tout est a jour."""
    attendus = produire_offres(dossier, racine_gio)
    ecarts = []
    for chemin, texte in attendus.items():
        if not chemin.is_file():
            ecarts.append(f"absent : {chemin.relative_to(dossier)}")
        elif chemin.read_text(encoding="utf-8") != texte:
            ecarts.append(f"perime : {chemin.relative_to(dossier)}")
    forge = dossier / "forge"
    if forge.is_dir():
        for chemin in sorted(forge.iterdir()):
            if chemin not in attendus:
                ecarts.append(f"sans offre : {chemin.relative_to(dossier)}")
    return ecarts


def ecrire_offres(dossier: Path = OFFRES, racine_gio: int = RACINE_GIO_DEFAUT) -> list[Path]:
    produits = produire_offres(dossier, racine_gio)
    for chemin, texte in produits.items():
        chemin.parent.mkdir(parents=True, exist_ok=True)
        chemin.write_text(texte, encoding="utf-8")
    return list(produits)


# --- La ligne de commande ------------------------------------------------------


def _resoudre_offre(nom: str) -> Path:
    """`EM-B311X-SATA` -> deploy/cloud-init/offres/EM-B311X-SATA.json."""
    connues = sorted(f.stem for f in OFFRES.glob("*.json"))
    if not re.fullmatch(r"[A-Za-z0-9._-]+", nom) or nom not in connues:
        raise Refus(f"offre inconnue « {nom} » ; offres versionnees : {', '.join(connues)} — pour "
                    "une offre nouvelle, --defaut avec le JSON relevé à la console")
    return OFFRES / f"{nom}.json"


def _source_defaut(args: argparse.Namespace, accepte_pool_source: bool = False) -> str | None:
    """Le fichier du schema par defaut : `--offre` (par son nom) OU `--defaut` (un chemin)."""
    donnes = [n for n, v in (("--offre", args.offre), ("--defaut", args.defaut)) if v]
    pool = accepte_pool_source and getattr(args, "pool_source", None)
    if len(donnes) + bool(pool) != 1:
        raise Refus("donnez " + ("--offre (une offre versionnee), --defaut (un schema par defaut) "
                                  "OU --pool-source" if accepte_pool_source else
                                  "--offre (une offre versionnee) OU --defaut (un schema par defaut)")
                    + " — un seul, ni les deux ni aucun")
    if args.offre:
        return str(_resoudre_offre(args.offre))
    return args.defaut


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
    racine = argparse.ArgumentParser(add_help=False)
    racine.add_argument(
        "--racine-gio", metavar="N", type=_entier_positif, default=RACINE_GIO_DEFAUT,
        help=f"taille de la partition systeme « root » en Gio (defaut {RACINE_GIO_DEFAUT} : la "
             "Forge de validation en consomme 2,7) ; la partition du pool prend tout le reste")
    commun = argparse.ArgumentParser(add_help=False, parents=[racine])
    commun.add_argument(
        "--offre", metavar="NOM",
        help="une offre CONNUE, par son nom (EM-B311X-SATA) : son schema par defaut est "
             "deploy/cloud-init/offres/<NOM>.json")
    commun.add_argument(
        "--defaut", metavar="FICHIER",
        help="le schema de partitionnement PAR DEFAUT d'une offre nouvelle, tel que la console "
             "de l'hebergeur l'affiche (« Reset to default ») ; « - » lit l'entree standard")

    parseur = argparse.ArgumentParser(
        prog="preparer-forge.py",
        description="Produit le schema de partitionnement et le cloud-init complets d'une Forge, "
                    "prets a coller dans la console de l'hebergeur (DAT §66).")
    sous = parseur.add_subparsers(dest="commande", required=True, metavar="COMMANDE")

    part = sous.add_parser(
        "partitionnement", parents=[commun], help="ecrit le JSON a coller dans la console",
        description="Derive du schema par defaut de l'offre le schema POUR LA FORGE : « root » est "
                    "bornee, une partition « zfs » prend le reste de chaque disque et le schema "
                    "DECLARE le pool miroir « spark » a l'hebergeur ; tout le reste est conserve. "
                    "La commande ne connait pas la capacite des disques : la console de "
                    "l'hebergeur controle que les tailles tiennent.")
    part.add_argument(
        "--sans-zfs", action="store_true",
        help="REPLI : ne declare pas le pool a l'hebergeur. La partition reste « data » et "
             "l'amorce cree le pool au premier demarrage. A employer si la console refuse la "
             "section « zfs » (son acceptation n'est pas verifiee, DAT §66.8)")

    cloud = sous.add_parser(
        "cloud-init", parents=[commun], help="ecrit le user-data complet a coller dans la console",
        description="Ecrit le cloud-init complet : l'amorce et creer-pool.sh embarques tels quels, "
                    "et l'amorce lancee avec les supports du pool. Les supports se deduisent du "
                    "schema par defaut (--offre ou --defaut) ou se donnent (--pool-source). Le meme "
                    "cloud-init sert que le pool soit declare a l'hebergeur ou non. Il embarque "
                    "l'amorce COURANTE : produit a la demande, jamais versionne.")
    cloud.add_argument(
        "--pool-source", metavar="A,B",
        help="les DEUX supports du miroir, a la place de --offre et de --defaut (ex. /dev/sda5,/dev/sdb5)")
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

    offres = sous.add_parser(
        "offres", parents=[racine],
        help="(re)ecrit le JSON de partition de chaque offre connue",
        description="Pour chaque deploy/cloud-init/offres/<offre>.json (le schema ORIGINAL de "
                    "l'hebergeur), ecrit dans deploy/cloud-init/offres/forge/ le schema pour la "
                    "Forge (<offre>.partitionnement.json), pret a coller. Le cloud-init n'est PAS "
                    "versionne : il embarque l'amorce, qui evolue ; il se produit a la demande "
                    "(cloud-init --offre <NOM>).")
    offres.add_argument(
        "--verifier", action="store_true",
        help="n'ecrit rien : sort en code 2 si un fichier versionne est absent, perime, ou sans "
             "offre — un changement de l'amorce, de creer-pool.sh ou de la regle oblige a "
             "regenerer")
    return parseur


def main(argv: list[str] | None = None) -> int:
    parseur = _parseur()
    args = parseur.parse_args(argv)
    try:
        if args.commande == "offres":
            sortie = ""
            if args.verifier:
                ecarts = verifier_offres(OFFRES, args.racine_gio)
                if ecarts:
                    raise Refus("les fichiers versionnes ne sont plus ceux que la commande produit : "
                                + " ; ".join(ecarts) + " — relancer « python3 scripts/preparer-forge.py "
                                "offres » et committer le resultat")
                print("les JSON de partition versionnes de chaque offre sont a jour", file=sys.stderr)
            else:
                for chemin in ecrire_offres(OFFRES, args.racine_gio):
                    print(f"ecrit : {chemin.relative_to(RACINE)}", file=sys.stderr)
        elif args.commande == "cloud-init":
            source = _source_defaut(args, accepte_pool_source=True)
            if args.pool_source:
                supports = _verifier_support(args.pool_source)
            else:
                _, supports = deriver(_lire_defaut(source), args.racine_gio)
                _verifier_support(",".join(supports))
            sortie = rendre_cloud_init(AMORCE.read_text(encoding="utf-8"),
                                       CREER_POOL.read_text(encoding="utf-8"),
                                       supports, args.arc_gib, args.net_mbit, args.compresser)
            print(f"supports du pool : {','.join(supports)}", file=sys.stderr)
            print(f"user-data : {len(sortie.encode('utf-8'))} octets — la limite du champ "
                  "cloud-init chez l'hebergeur n'est pas documentee (DAT §66.4)", file=sys.stderr)
        else:
            source = _source_defaut(args)
            declarer = not args.sans_zfs
            schema, supports = deriver(_lire_defaut(source), args.racine_gio, declarer)
            sortie = partitionnement_texte(schema)
            pool = (f"« zfs » prend le reste et le pool miroir « {NOM_POOL} » est declare a "
                    "l'hebergeur" if declarer else "« data » prend le reste, aucun pool n'est "
                    "declare (--sans-zfs : l'amorce le cree)")
            print(f"« root » bornee a {args.racine_gio} Gio, {pool} ; "
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
