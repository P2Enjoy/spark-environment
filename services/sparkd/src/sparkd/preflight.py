"""Contrôles d'état du serveur, avant et après installation.

@spec docs/BACKLOG.md#SPK-26 · docs/DAT.md §31 (l'installation et sa
      vérification), §31.1 (une seule liste, employée deux fois), §31.2 (mesurer,
      nommer, remédier), §31.3 (lecture seule), §31.4 (ce qui doit être garanti)
      · §3.1, §8, §15, §16 · docs/PROD_MIGRATIONS.md

La même série sert AVANT l'installation — pour savoir ce qui manque — et APRÈS,
pour constater que le serveur est en état. Deux listes distinctes finiraient par
diverger, et c'est l'après qui deviendrait faux, parce qu'on ne le relit qu'en
cas de doute.

**Ce module ne modifie RIEN.** C'est ce qui le rend utilisable sur un serveur en
service : on peut le lancer sans se demander ce qu'il va faire. L'installation
est un script distinct (§31.3).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, NamedTuple

GIO = 1024**3

#: Le remède d'un pool absent, tel que le geste d'installation le pose (§8.5 bis).
#: Une consigne de réparation qui contredit le script d'installation apprend à se
#: méfier des deux — et depuis le 2026-09-02, le pool sur fichier est retiré :
#: proposer « incus storage create … size=200GiB » créerait une disposition que
#: le produit ne prend plus en charge.
REMEDE_POOL = ("SPARK_POOL_SOURCE=/dev/…,/dev/… scripts/creer-pool.sh "
               "— une Forge exige deux supports sur deux disques (docs/DAT.md §8.5)")

#: Version d'Incus sans laquelle AUCUN conteneur Docker ne démarre dans un Spark
#: (docs/DAT.md §3.1). Ce n'est pas une préférence de version.
INCUS_MINIMUM = (6, 19)

#: Plafond retenu pour l'ARC ZFS. Au-delà, la mémoire promise aux Sparks est
#: reprise par le cache sans prévenir (docs/DAT.md §16.1).
ARC_MAXIMUM = 16 * GIO

class Reglages(NamedTuple):
    """Ce que la vérification lit au lieu de le supposer (§8.5 bis).

    Le nom du pool, celui du jeu de données et celui du bridge viennent de la
    configuration du runtime. `SPARK_POOL_FILE_SIZE` a disparu avec le pool sur
    fichier (§8.5 révisé le 2026-09-02) : plus rien ne dimensionne un pool ici.
    """

    storage_pool: str
    storage_dataset: str
    network_bridge: str


def reglages(source: dict[str, str] | None = None) -> Reglages:
    """Relit la configuration à chaque appel : un contrôle n'est pas un service.

    Importé PARESSEUSEMENT : `preflight` doit rester lançable sur un hôte où
    `sparkd` n'est pas encore installé, et le §31.3 le veut sans effet de bord.
    """
    from .config import load

    brut = dict(os.environ if source is None else source)
    config = load({**brut, "SPARKD_DRIVER": brut.get("SPARKD_DRIVER", "fake")})
    return Reglages(
        storage_pool=config.storage_pool,
        storage_dataset=config.storage_dataset,
        network_bridge=config.network_bridge,
    )


OK = "ok"
ECHEC = "echec"
#: Ne pas avoir pu mesurer n'est PAS avoir mesuré une valeur fautive. Les
#: confondre ferait « corriger » un serveur correct (§31.2).
INCONNU = "inconnu"
#: SPK-55 · §48.2 : une surface inutile n'est pas une faille ouverte. La ranger
#: avec les échecs ferait refuser l'installation d'une Forge pour un détail, et
#: un préflight qui échoue pour un détail apprend à passer outre ses échecs.
#: Signalé, donc, et NON bloquant.
AVERTISSEMENT = "avertissement"


@dataclass(frozen=True)
class Verdict:
    """Résultat d'un contrôle : ce qu'on a relevé, et quoi faire (§31.2)."""

    code: str
    titre: str
    etat: str
    releve: str
    remede: str = ""

    @property
    def bloquant(self) -> bool:
        return self.etat == ECHEC


@dataclass
class Hote:
    """Accès en LECTURE SEULE à la Forge.

    Les lectures passent toutes par ici pour que les contrôles soient éprouvables
    avec des relevés injectés, sans serveur.
    """

    executer: Callable[[list[str]], str | None]
    lire: Callable[[str], str | None]
    presence: Callable[[str], bool] = field(default=lambda binaire: bool(shutil.which(binaire)))
    #: SPK-36 · docs/CONTINGENCE.md §4 : ce que le REGISTRE déclare, pour le
    #: confronter à ce qu'Incus connaît. Une couture de plus, au même titre que
    #: `executer` et `lire` — un contrôle doit s'éprouver sans serveur.
    #:
    #: Rend `None` quand le registre est illisible : « pas mesuré » n'est pas
    #: « mesuré fautif » (§31.2), et conclure sur une absence de réponse ferait
    #: signaler comme fantômes des Sparks bien vivants.
    declarations: Callable[[], list[dict] | None] = field(
        default=lambda: _declarations_locales())


def _declarations_locales(chemin: str | None = None) -> list[dict] | None:
    """Les Sparks qui DÉCLARENT une cellule, lus au registre en lecture seule.

    Le chemin par défaut est celui de la configuration du service. On n'écrit
    rien et on n'ouvre qu'en lecture : le préflight relève, il ne répare pas
    (§48.2), et un registre ouvert en écriture par un outil de diagnostic
    finirait par le modifier un jour de fatigue.
    """
    import sqlite3

    from .config import DEFAULT_DB

    fichier = chemin or os.environ.get("SPARKD_DB") or DEFAULT_DB
    if not os.path.exists(fichier):
        return None
    try:
        connexion = sqlite3.connect(f"file:{fichier}?mode=ro", uri=True, timeout=5)
        connexion.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in connexion.execute(
                "SELECT name, incus_name, state, cpu_reservation, "
                "memory_reservation_bytes FROM spark WHERE incus_name IS NOT NULL")]
        finally:
            connexion.close()
    except sqlite3.Error:
        return None


def hote_local() -> Hote:
    """Forge réelle. Aucune commande de ce module n'écrit."""

    def executer(commande: list[str]) -> str | None:
        try:
            rendu = subprocess.run(commande, capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            return None
        if rendu.returncode != 0:
            return None
        return rendu.stdout.strip()

    def lire(chemin: str) -> str | None:
        try:
            with open(chemin, encoding="utf-8") as fichier:
                return fichier.read().strip()
        except OSError:
            return None

    return Hote(executer=executer, lire=lire)


def _version(texte: str) -> tuple[int, ...] | None:
    trouve = re.search(r"(\d+)\.(\d+)", texte or "")
    return tuple(int(p) for p in trouve.groups()) if trouve else None


# --- les contrôles ----------------------------------------------------------


def incus_assez_recent(hote: Hote) -> Verdict:
    """docs/DAT.md §3.1 — condition de fonctionnement, pas préférence."""
    minimum = ".".join(str(p) for p in INCUS_MINIMUM)
    brut = hote.executer(["incus", "--version"])
    if brut is None:
        return Verdict("INC-VERSION", "Incus installé et assez récent", INCONNU,
                       "incus injoignable ou absent",
                       "Installer Incus depuis le dépôt amont Zabbly : "
                       "la version des dépôts Ubuntu (6.0) ne convient pas.")
    version = _version(brut)
    if version is None:
        return Verdict("INC-VERSION", "Incus installé et assez récent", INCONNU,
                       f"version illisible : {brut!r}", "")
    if version < INCUS_MINIMUM:
        return Verdict(
            "INC-VERSION", "Incus installé et assez récent", ECHEC,
            f"{brut} — attendu ≥ {minimum}",
            "Aucun conteneur Docker ne démarre dans un Spark sous cette version "
            "(CVE-2025-52881, docs/DAT.md §3.1). Passer au dépôt amont Zabbly.")
    return Verdict("INC-VERSION", "Incus installé et assez récent", OK, brut)


def pool_de_stockage(hote: Hote, nom: str | None = None) -> Verdict:
    """Le pool doit exister, porter des quotas et compresser (docs/DAT.md §8).

    Le NOM vient de la configuration, jamais d'un défaut de fonction (§8.5 bis) :
    vérifier une installation configurée autrement rendrait sinon un verdict qui
    ne parle pas d'elle — « pool « spark » absent » sur une Forge dont le pool
    s'appelle « tank » et fonctionne.
    """
    nom = nom or reglages().storage_pool
    brut = hote.executer(["incus", "storage", "show", nom])
    if brut is None:
        return Verdict("STO-POOL", f"Pool de stockage « {nom} »", ECHEC,
                       "absent", REMEDE_POOL)
    pilote = re.search(r"^driver:\s*(\S+)", brut, re.M)
    if not pilote or pilote.group(1) != "zfs":
        return Verdict("STO-POOL", f"Pool de stockage « {nom} »", ECHEC,
                       f"pilote {pilote.group(1) if pilote else 'inconnu'}, attendu zfs",
                       "Le quota, la copie sur écriture et les instantanés "
                       "supposent ZFS (docs/DAT.md §8).")
    # SPK-28 · §8.5 RÉVISÉ le 2026-09-02 : il n'y a plus qu'une disposition, le
    # miroir ZFS natif. Un pool posé sur fichier continue de FONCTIONNER — c'est
    # le même ZFS, et le produit ne casse pas ce qui tourne —, mais il n'est plus
    # une disposition prise en charge : ni créée, ni proposée. D'où un
    # AVERTISSEMENT, et non un échec : la machine marche, sa disposition est
    # sortie du périmètre, et ce qu'elle n'apporte pas est nommé.
    source = re.search(r"^\s*source:\s*(\S+)", brut, re.M)
    sur_fichier = bool(source and source.group(1).endswith(".img"))
    releve = f"zfs, source {source.group(1) if source else 'inconnue'}"
    if sur_fichier:
        return Verdict("STO-POOL", f"Pool de stockage « {nom} »", AVERTISSEMENT,
                       releve + " — pool sur fichier : disposition retirée du "
                       "produit le 2026-09-02, corruption silencieuse NON "
                       "couverte car le miroir est géré en dessous",
                       "Le pool fonctionne et n'est pas à recréer dans l'urgence. "
                       "Une migration vers un miroir natif suppose deux supports "
                       "libres sur deux disques (docs/DAT.md §8.5).")
    return Verdict("STO-POOL", f"Pool de stockage « {nom} »", OK,
                   releve + " — miroir ZFS natif")


def compression_active(hote: Hote, dataset: str | None = None) -> Verdict:
    """§8.5 bis : le jeu de données vient de la configuration, comme le pool."""
    dataset = dataset or reglages().storage_dataset
    brut = hote.executer(["zfs", "get", "-H", "-o", "value", "compression", dataset])
    if brut is None:
        return Verdict("STO-COMPRESSION", "Compression ZFS active", INCONNU,
                       "zfs injoignable", "")
    if brut in ("off", "-"):
        return Verdict("STO-COMPRESSION", "Compression ZFS active", ECHEC, brut,
                       f"zfs set compression=on {dataset}")
    return Verdict("STO-COMPRESSION", "Compression ZFS active", OK, brut)


def arc_plafonne(hote: Hote) -> Verdict:
    """docs/DAT.md §16 — un ARC non plafonné reprend la mémoire des Sparks."""
    brut = hote.lire("/sys/module/zfs/parameters/zfs_arc_max")
    if brut is None:
        return Verdict("MEM-ARC", "Plafond de l'ARC ZFS", INCONNU,
                       "zfs_arc_max illisible",
                       "Sans ce plafond, le registre surestime la mémoire "
                       "allouable (docs/DAT.md §16.2).")
    try:
        valeur = int(brut)
    except ValueError:
        return Verdict("MEM-ARC", "Plafond de l'ARC ZFS", INCONNU, brut, "")
    if valeur == 0:
        return Verdict("MEM-ARC", "Plafond de l'ARC ZFS", ECHEC,
                       "0 — ZFS applique son défaut, la moitié de la RAM",
                       f"echo {ARC_MAXIMUM} > /sys/module/zfs/parameters/zfs_arc_max "
                       "et poser la valeur dans /etc/modprobe.d/zfs.conf")
    if valeur > ARC_MAXIMUM:
        return Verdict("MEM-ARC", "Plafond de l'ARC ZFS", ECHEC,
                       f"{valeur / GIO:.1f} Gio — au-delà de {ARC_MAXIMUM / GIO:.0f} Gio",
                       "Abaisser zfs_arc_max : cette mémoire est retirée des Sparks.")
    return Verdict("MEM-ARC", "Plafond de l'ARC ZFS", OK, f"{valeur / GIO:.1f} Gio")


def paquets_coherents(hote: Hote) -> Verdict:
    """Le système de paquets est-il en état d'installer ? (docs/DAT.md §50.7.2)

    @spec docs/BACKLOG.md#SPK-84 · docs/DAT.md §50.7 (un `dpkg` incohérent est
          une panne du produit), §31.2 (« pas mesuré » n'est pas « mesuré sain »),
          §31.3 (un contrôle ne répare rien) · docs/AGENT_RUNBOOK.md §C.5

    Ce n'est pas de l'hygiène système : un `dpkg` incohérent fait échouer TOUTE
    installation, donc l'amorce d'une Forge (§50.4) comme l'amorçage de chaque
    Spark (§42). Mesuré le 2026-09-02 — `grub-pc` en `iF` sur un `/boot` en RAID
    — et le symptôme désignait à chaque fois le paquet qu'on demandait, jamais
    celui qui bloquait.

    Les `rc` ne comptent pas : c'est l'état normal d'un paquet retiré dont la
    configuration reste, et les signaler ferait crier au loup sur toute Forge.
    """
    brut = hote.executer(
        ["dpkg-query", "-W", "-f=${db:Status-Abbrev} ${binary:Package}\n"])
    if brut is None:
        return Verdict("PKG-DPKG", "Système de paquets cohérent", INCONNU,
                       "dpkg-query illisible",
                       "Sans cette lecture, on ne sait pas si une installation "
                       "aboutira — ni l'amorce d'une Forge, ni celle d'un Spark.")
    casses = []
    for ligne in brut.splitlines():
        etat, _, paquet = ligne.strip().partition(" ")
        if not paquet or etat in ("ii", "rc"):
            continue
        casses.append(f"{etat} {paquet.strip()}")
    if not casses:
        return Verdict("PKG-DPKG", "Système de paquets cohérent", OK,
                       "aucun paquet en défaut")
    return Verdict(
        "PKG-DPKG", "Système de paquets cohérent", ECHEC,
        ", ".join(casses[:6]) + (f" (+{len(casses) - 6})" if len(casses) > 6 else ""),
        "Tant que dpkg est incohérent, AUCUNE installation n'aboutit : ni "
        "l'amorce de cette Forge, ni l'amorçage d'un Spark. Reprendre par "
        "`sudo dpkg --configure -a` ; si c'est grub-pc sur un /boot en RAID, "
        "voir docs/AGENT_RUNBOOK.md §C.5.")


def bridge_prive(hote: Hote, nom: str | None = None) -> Verdict:
    nom = nom or reglages().network_bridge
    adresse = hote.executer(["incus", "network", "get", nom, "ipv4.address"])
    if not adresse:
        return Verdict("NET-BRIDGE", f"Bridge privé « {nom} »", ECHEC, "absent",
                       f"incus network create {nom} ipv4.address=10.77.0.1/24 "
                       "ipv4.nat=true")
    return Verdict("NET-BRIDGE", f"Bridge privé « {nom} »", OK, adresse)


def plage_dhcp_disjointe(hote: Hote, nom: str | None = None) -> Verdict:
    """docs/PROD_MIGRATIONS.md OP-02 — sinon dnsmasq distribue une adresse déjà promise."""
    nom = nom or reglages().network_bridge
    brut = hote.executer(["incus", "network", "get", nom, "ipv4.dhcp.ranges"])
    if not brut:
        return Verdict("NET-DHCP", "Plage DHCP disjointe du registre", ECHEC,
                       "aucune plage restreinte",
                       f"incus network set {nom} "
                       "ipv4.dhcp.ranges=10.77.0.240-10.77.0.254")
    return Verdict("NET-DHCP", "Plage DHCP disjointe du registre", OK, brut)


def caddy_administrable(hote: Hote) -> Verdict:
    """L'API d'administration doit répondre, et SUR LA BOUCLE LOCALE."""
    if not hote.presence("caddy"):
        return Verdict("ING-CADDY", "Caddy présent et administrable", ECHEC,
                       "binaire absent", "Installer Caddy.")
    reponse = hote.executer(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                             "http://127.0.0.1:2019/config/"])
    if reponse is None:
        return Verdict("ING-CADDY", "Caddy présent et administrable", INCONNU,
                       "API d'administration injoignable", "")
    if reponse != "200":
        return Verdict("ING-CADDY", "Caddy présent et administrable", ECHEC,
                       f"API d'administration → HTTP {reponse}",
                       "Vérifier que Caddy écoute sur 127.0.0.1:2019.")
    return Verdict("ING-CADDY", "Caddy présent et administrable", OK,
                   "API d'administration → 200 sur 127.0.0.1:2019")


def _portee(adresse_ecoute: str) -> str:
    """Classe une adresse d'écoute : « locale », « privee » ou « exposee ».

    Une première version tenait pour exposé tout ce qui n'était pas `127.0.0.1`.
    Mesuré sur la Forge cible : elle dénonçait le port 53 de `dnsmasq`, lié à
    `10.77.0.1` — le côté PRIVÉ du bridge, que les Sparks doivent joindre pour
    leur DNS — et ne reconnaissait ni `127.0.0.53%lo` ni `127.0.0.54`, qui sont
    de la boucle locale. Le contrôle était faux, pas la Forge.

    Est exposé ce qui écoute sur un joker ou sur une adresse routable. Une
    adresse de boucle locale ou de réseau privé ne l'est pas.
    """
    hote_ecoute = adresse_ecoute.rsplit(":", 1)[0].strip("[]").split("%")[0]
    if hote_ecoute in ("0.0.0.0", "*", "::", ""):
        return "exposee"
    if hote_ecoute == "::1" or hote_ecoute.startswith("127."):
        return "locale"
    if hote_ecoute.startswith(("10.", "192.168.")):
        return "privee"
    if hote_ecoute.startswith("172."):
        second = hote_ecoute.split(".")[1] if "." in hote_ecoute[4:] + "." else ""
        try:
            return "privee" if 16 <= int(second) <= 31 else "exposee"
        except ValueError:
            return "exposee"
    return "exposee"


def surface_reseau(hote: Hote) -> Verdict:
    """Seuls 22, 80 et 443 sont joignables depuis le réseau (docs/DAT.md §11).

    Ce qui écoute sur la boucle locale ou sur le bridge privé n'est pas exposé :
    `sparkd` et l'API d'administration de Caddy sont dans ce cas, et c'est
    précisément la propriété de sécurité du produit.
    """
    brut = hote.executer(["ss", "-lntH"])
    if brut is None:
        return Verdict("SEC-PORTS", "Surface réseau réduite à 22, 80, 443", INCONNU,
                       "ss injoignable", "")
    exposes = set()
    for ligne in brut.splitlines():
        colonnes = ligne.split()
        if len(colonnes) < 4:
            continue
        adresse = colonnes[3]
        if _portee(adresse) != "exposee":
            continue
        exposes.add(adresse.rsplit(":", 1)[-1])
    intrus = sorted(exposes - {"22", "80", "443"}, key=lambda p: int(p) if p.isdigit() else 0)
    if intrus:
        return Verdict("SEC-PORTS", "Surface réseau réduite à 22, 80, 443", ECHEC,
                       f"ports exposés en trop : {', '.join(intrus)}",
                       "Aucune API d'administration ne doit être joignable depuis "
                       "le réseau (docs/DAT.md §11).")
    return Verdict("SEC-PORTS", "Surface réseau réduite à 22, 80, 443", OK,
                   f"exposés : {', '.join(sorted(exposes)) or 'aucun'}")


def remontee_vers_la_forge(hote: Hote, nom: str | None = None) -> Verdict:
    """Un Spark ne doit pas atteindre le `sshd` de sa Forge (§48.1).

    @spec docs/BACKLOG.md#SPK-55 · docs/DAT.md §48.1 (le sens du produit est à
          SENS UNIQUE), §48.2 (le préflight relève, il ne répare pas) ·
          §37.2, §37.3 (aucun chemin du produit ne part d'un Spark vers la Forge)

    MESURÉ le 2026-08-20 depuis un Spark en service : `10.77.0.1:9876` et
    `10.77.0.1:2019` sont injoignables — c'est la propriété attendue — mais
    `10.77.0.1:22` RÉPOND. La cause est nue : la chaîne `input` du bridge est en
    « policy accept », et le `sshd`, lui, se lie partout.

    **Ce qui ne doit PAS être fermé** est aussi important que ce qui doit l'être :
    un Spark garde son DNS — `dnsmasq` écoute sur l'adresse du bridge — et sa
    sortie internet, qui passe par le NAT du même bridge. Une règle qui fermerait
    tout rendrait chaque Spark muet : une panne, pas une protection. Le remède
    proposé ouvre donc explicitement le 53 avant de fermer le reste.
    """
    nom = nom or reglages().network_bridge
    politique = hote.executer(
        ["incus", "network", "get", nom, "ipv4.firewall"])
    regles = hote.executer(
        ["incus", "network", "get", nom, "user.spark.input_policy"])
    # Ni l'un ni l'autre : on ne SAIT PAS. Le §31.2 interdit de confondre « pas
    # mesuré » avec « mesuré fautif » — conclure ici ferait « corriger » une
    # Forge correcte.
    if politique is None and regles is None:
        return Verdict("NET-REMONTEE", "Un Spark n’atteint pas le sshd de la Forge",
                       INCONNU, f"réseau « {nom} » illisible", "")
    if (regles or "").strip().lower() in {"drop", "reject"}:
        return Verdict("NET-REMONTEE", "Un Spark n’atteint pas le sshd de la Forge",
                       OK, f"entrée du bridge en « {regles.strip().lower()} »")
    return Verdict(
        "NET-REMONTEE", "Un Spark n’atteint pas le sshd de la Forge", ECHEC,
        "l’entrée du bridge accepte tout : le port 22 de la Forge répond "
        "depuis le réseau des Sparks",
        f"Fermer l’entrée du bridge en LAISSANT le DNS et la sortie : "
        f"nft add rule inet filter input iifname \"{nom}\" udp dport 53 accept ; "
        f"nft add rule inet filter input iifname \"{nom}\" tcp dport 53 accept ; "
        f"nft add rule inet filter input iifname \"{nom}\" drop — "
        f"puis marquer l’état : incus network set {nom} user.spark.input_policy=drop")


#: Remède du contrôle SSH-X11. Il nomme le fragment que l'installation écrit
#: elle-même (`forge_install.phase_foundation`) et non le fichier principal :
#: une consigne qui contredit l'installateur apprend à se méfier des deux.
REMEDE_X11 = ("X11Forwarding no dans /etc/ssh/sshd_config.d/90-spark.conf, "
              "puis systemctl reload ssh")


def _x11_effectif(hote: Hote) -> bool | None:
    """Ce que `sshd` applique VRAIMENT, fragments et préséance compris.

    Rend `None` quand `sshd -T` n'a pas répondu — hôte sans `sshd`, binaire
    absent du chemin, ou appel sans les droits — pour que l'appelant retombe sur
    la lecture du fichier plutôt que de conclure sur un silence.
    """
    rendu = hote.executer(["sshd", "-T"])
    if rendu is None:
        return None
    valeur: bool | None = None
    for ligne in rendu.splitlines():
        mots = ligne.strip().split()
        if len(mots) >= 2 and mots[0].lower() == "x11forwarding":
            valeur = mots[1].lower() == "yes"
    return valeur


def _x11_du_fichier(hote: Hote) -> bool | None:
    """Repli : le seul `/etc/ssh/sshd_config`, sans ses fragments.

    La DERNIÈRE valeur lue fait foi alors que `sshd` retient la première. C'est
    délibérément plus SÉVÈRE : en repli on signale un fichier ambigu au lieu de
    le déclarer sain.
    """
    brut = hote.lire("/etc/ssh/sshd_config")
    if brut is None:
        return None
    actif = False
    for ligne in brut.splitlines():
        mots = ligne.strip().split()
        if len(mots) >= 2 and mots[0].lower() == "x11forwarding":
            actif = mots[1].lower() == "yes"
    return actif


def x11_sans_usage(hote: Hote) -> Verdict:
    """`X11Forwarding` est ouvert sans que le produit s'en serve (§48.2).

    @spec docs/BACKLOG.md#SPK-55, docs/BACKLOG.md#SPK-72 · docs/DAT.md §48.2

    AVERTISSEMENT et non échec, et le motif est écrit : ce n'est pas une faille
    ouverte, c'est une surface qui ne sert à rien. Refuser l'installation d'une
    Forge pour cela serait disproportionné, et un préflight qui échoue pour un
    détail apprend à passer outre ses échecs.

    **Le contrôle lit la configuration EFFECTIVE** (SPK-72, corrigé le
    2026-09-01). Il lisait `/etc/ssh/sshd_config` seul et signalait donc `yes`
    sur une Forge où `sshd -T` répond `no` : l'installation écrit sa règle dans
    `/etc/ssh/sshd_config.d/90-spark.conf`, tandis que le fichier principal garde
    le `X11Forwarding yes` de la distribution. Le contrôle ignorait précisément
    le fichier que l'installateur pose, et ne pouvait JAMAIS passer au vert sur
    une Forge correctement installée. Le coût d'un faux positif n'est pas son
    verdict : c'est qu'un préflight qui ment sur un contrôle apprend à passer
    outre les treize autres.
    """
    actif = _x11_effectif(hote)
    source = "sshd -T"
    if actif is None:
        actif = _x11_du_fichier(hote)
        source = "/etc/ssh/sshd_config, repli — sshd -T muet"
    if actif is None:
        return Verdict("SSH-X11", "X11Forwarding inutile est désactivé", INCONNU,
                       "ni sshd -T ni sshd_config n’ont répondu", "")
    if actif:
        return Verdict("SSH-X11", "X11Forwarding inutile est désactivé", AVERTISSEMENT,
                       f"X11Forwarding yes ({source}) — le produit n’ouvre "
                       "jamais de fenêtre", REMEDE_X11)
    return Verdict("SSH-X11", "X11Forwarding inutile est désactivé", OK,
                   f"désactivé ({source})")


def sparkd_survit_au_redemarrage(hote: Hote) -> Verdict:
    """§31.4 — le manque relevé le 2026-08-19.

    `is-active` ne suffit pas : un `sparkd` lancé à la main depuis une session
    `ssh` est « actif » et disparaît pourtant au premier redémarrage. Les Sparks
    continueraient de tourner sans que rien ne les administre, et la panne ne se
    découvrirait qu'à la première opération.
    """
    active = hote.executer(["systemctl", "is-active", "sparkd"])
    enabled = hote.executer(["systemctl", "is-enabled", "sparkd"])
    if enabled == "enabled" and active == "active":
        return Verdict("RUN-SPARKD", "sparkd survit à un redémarrage", OK,
                       "unité systemd active et activée au démarrage")
    if enabled == "enabled":
        return Verdict("RUN-SPARKD", "sparkd survit à un redémarrage", ECHEC,
                       f"unité activée au démarrage mais état « {active or 'inconnu'} »",
                       "systemctl start sparkd")
    return Verdict("RUN-SPARKD", "sparkd survit à un redémarrage", ECHEC,
                   f"aucune unité activée (is-enabled : {enabled or 'absent'}, "
                   f"is-active : {active or 'absent'})",
                   "Poser l'unité systemd : scripts/install-serveur.sh")


#: Ce qui FAIT TENIR la delegation (docs/DAT.md §32.4 ter). Nomme ici pour que
#: le remede du preflight designe le vrai mecanisme, et non l'ecriture directe
#: qu'un `daemon-reload` defait aussitot.
UNITE_DELEGATION = "spark-delegation.service"

REMEDE_DELEGATION = (f"systemctl enable --now {UNITE_DELEGATION} — l'ecriture "
                     "directe dans cgroup.subtree_control est defaite au premier "
                     "daemon-reload (mesure).")


def tranche_des_sparks(hote: Hote) -> Verdict:
    """docs/DAT.md §32.4, §32.4 ter — sinon la reservation redevient proportionnelle.

    Le piege est qu'une tranche absente ne casse RIEN de visible : les Sparks
    demarrent, tournent, et leur reservation cesse simplement d'etre absolue.
    C'est pourquoi elle se controle plutot que de se constater a l'usage.

    Le controle regarde DEUX choses, et il le faut : les controleurs presents
    maintenant, et ce qui les y maintiendra. MESURE le 2026-09-01 — des
    controleurs ecrits a la main disparaissent au premier `daemon-reload`. Une
    tranche verte sur le seul relevé du fichier serait donc verte a l'instant du
    controle et fausse une minute plus tard, ce qui est pire que rouge.
    """
    etat = hote.executer(["systemctl", "is-enabled", "spark.slice"])
    delegation = hote.executer(["systemctl", "is-enabled", UNITE_DELEGATION])
    controleurs = hote.lire("/sys/fs/cgroup/spark.slice/cgroup.subtree_control")
    if controleurs is None:
        return Verdict("RUN-SLICE", "Tranche parente des Sparks", ECHEC,
                       "/sys/fs/cgroup/spark.slice absente",
                       "Poser les unites : python -m sparkd.install")
    manquants = [c for c in ("cpu", "cpuset", "memory") if c not in controleurs.split()]
    if manquants:
        return Verdict("RUN-SLICE", "Tranche parente des Sparks", ECHEC,
                       f"controleurs delegues : {controleurs.strip()!r} — "
                       f"manque {' '.join(manquants)}",
                       "Les limites ne s'appliquent pas dans la tranche. "
                       + REMEDE_DELEGATION)
    if etat not in ("enabled", "static", "enabled-runtime"):
        return Verdict("RUN-SLICE", "Tranche parente des Sparks", ECHEC,
                       f"presente mais is-enabled = {etat or 'absent'}",
                       "Creee a la main, elle disparait au redemarrage et la "
                       "reservation redevient proportionnelle en silence.")
    if delegation not in ("enabled", "static", "enabled-runtime"):
        return Verdict("RUN-SLICE", "Tranche parente des Sparks", ECHEC,
                       f"controleurs {controleurs.strip()}, mais "
                       f"{UNITE_DELEGATION} est {delegation or 'absente'} : "
                       "rien ne les maintiendra",
                       REMEDE_DELEGATION)
    return Verdict("RUN-SLICE", "Tranche parente des Sparks", OK,
                   f"presente, controleurs {controleurs.strip()}, {etat}, "
                   f"delegation {delegation}")


def registre_sans_fantome(hote: Hote) -> Verdict:
    """Aucune ligne du registre ne déclare une cellule qui n'existe pas.

    @spec docs/BACKLOG.md#SPK-36 · docs/CONTINGENCE.md §4 (l'entrée fantôme),
          §4.2 (ce qu'elle coûte), §4.4 (ce que ce contrôle dit et ne dit pas) ·
          docs/DAT.md §32.2 (le poids suit la somme des réservations) ·
          §48.2 (le préflight relève, il ne répare pas)

    **Le défaut est SILENCIEUX, et c'est ce qui le rend durable.** Une ligne
    fantôme consomme de l'allocation réelle — l'admission compte ce que le
    registre déclare — et fait donc peser la tranche parente plus lourd qu'elle
    ne devrait. MESURÉ sur la Forge de validation : une réservation fantôme de
    1,0 CPU sur 4 faisait passer le poids de **43 à 180**, quatre fois trop.

    L'écart joue en faveur des Sparks vivants, qui obtiennent PLUS que ce qu'ils
    ont acheté. Personne ne s'en plaint, donc personne ne le voit : la Forge est
    restée mal pondérée deux jours en rendant « 0 bloquant ».

    Ce contrôle RELÈVE. Le geste reste au responsable, parce que supprimer une
    ligne détruit une déclaration d'intention, et que la bonne réponse est
    parfois de RECONSTRUIRE la cellule plutôt que d'effacer la ligne.
    """
    declarees = hote.declarations()
    # §31.2 : registre illisible, on ne SAIT PAS. Conclure ici ferait signaler
    # comme fantômes tous les Sparks d'une Forge dont on n'a pas pu lire l'état.
    if declarees is None:
        return Verdict("REG-FANTOME", "Aucune cellule déclarée n’est absente",
                       INCONNU, "registre illisible", "")

    brut = hote.executer(["incus", "list", "--format", "csv", "-c", "n"])
    if brut is None:
        return Verdict("REG-FANTOME", "Aucune cellule déclarée n’est absente",
                       INCONNU, "Incus injoignable", "")

    vivantes = {ligne.strip() for ligne in brut.splitlines() if ligne.strip()}
    fantomes = [s for s in declarees if s["incus_name"] not in vivantes]
    if not fantomes:
        return Verdict("REG-FANTOME", "Aucune cellule déclarée n’est absente", OK,
                       f"{len(declarees)} cellule(s) déclarée(s), toutes présentes")

    # Le CHIFFRE, pas seulement le nom : sans lui on ne sait pas s'il faut agir
    # aujourd'hui ou la semaine prochaine (§4.4).
    cpu = sum(float(s["cpu_reservation"] or 0) for s in fantomes)
    memoire = sum(int(s["memory_reservation_bytes"] or 0) for s in fantomes)
    noms = ", ".join(sorted(s["name"] for s in fantomes))
    return Verdict(
        "REG-FANTOME", "Aucune cellule déclarée n’est absente", ECHEC,
        f"{len(fantomes)} ligne(s) déclarent une cellule absente : {noms} — "
        f"{cpu:g} CPU et {memoire} octets comptés pour rien",
        "Supprimer le Spark par le produit — une instance déjà absente vaut "
        "suppression réussie (SPK-52) — OU le reconstruire si sa ligne doit "
        "vivre. L'allocation et le poids de la tranche suivent d'eux-mêmes. "
        "Sauvegarder le registre d'abord (docs/CONTINGENCE.md §2.3).")


CONTROLES: tuple[Callable[[Hote], Verdict], ...] = (
    incus_assez_recent,
    paquets_coherents,
    pool_de_stockage,
    compression_active,
    arc_plafonne,
    bridge_prive,
    plage_dhcp_disjointe,
    caddy_administrable,
    surface_reseau,
    remontee_vers_la_forge,
    x11_sans_usage,
    sparkd_survit_au_redemarrage,
    tranche_des_sparks,
    registre_sans_fantome,
)


def verifier(hote: Hote | None = None) -> list[Verdict]:
    """Exécute toute la série. N'écrit rien (§31.3)."""
    hote = hote or hote_local()
    return [controle(hote) for controle in CONTROLES]


def rendu_texte(verdicts: list[Verdict]) -> str:
    symboles = {OK: "  ok  ", ECHEC: "ECHEC ", INCONNU: "  ?   ",
                AVERTISSEMENT: " note "}
    lignes = []
    for v in verdicts:
        lignes.append(f"[{symboles[v.etat]}] {v.code:<16} {v.titre}")
        lignes.append(f"                          relevé : {v.releve}")
        if v.etat != OK and v.remede:
            lignes.append(f"                          remède : {v.remede}")
    bloquants = [v for v in verdicts if v.bloquant]
    lignes.append("")
    lignes.append(
        f"{len(verdicts)} contrôles — {len(bloquants)} bloquant(s), "
        f"{sum(1 for v in verdicts if v.etat == AVERTISSEMENT)} signalé(s), "
        f"{sum(1 for v in verdicts if v.etat == INCONNU)} non mesuré(s)."
    )
    return "\n".join(lignes)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    verdicts = verifier()
    if "--json" in argv:
        print(json.dumps([v.__dict__ for v in verdicts], ensure_ascii=False, indent=2))
    else:
        print(rendu_texte(verdicts))
    return 1 if any(v.bloquant for v in verdicts) else 0


if __name__ == "__main__":
    raise SystemExit(main())
