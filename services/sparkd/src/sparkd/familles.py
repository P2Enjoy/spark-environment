"""La table des familles : ce que chaque distribution sait recevoir.

@spec docs/BACKLOG.md#SPK-98 · docs/DAT.md §42.11 (l'amorçage sert par élément),
      §42.11 bis (les défauts que la campagne a trouvés), §42.9.2 bis (la suite
      d'une dérivée se LIT), §42.12 (le contrat d'API), §42.14 (le catalogue
      publie une table) · docs/DESIGN_SYSTEM_APP.md SPK-DS-24

Ce module ne contient **aucune** logique d'amorçage : il tient la table, et rien
d'autre. C'est délibéré, et c'est le point de l'unité.

L'amorçage posait une seule question — « est-ce que je sers cette famille ? » —
et répondait par oui ou par non. La campagne du 2026-09-08 a montré que cette
question en cachait deux, et qu'elles n'ont pas la même réponse : sur une cellule
Alpine, le produit avait **déjà** posé l'environnement, les secrets et les clés,
et il ne lui manquait que le `sshd` qui aurait ouvert la porte que ces clés
venaient de garnir.

Une famille déclare donc, élément par élément, ce qu'elle reçoit. Ajouter Void,
Gentoo ou Alt demain sera une **entrée de plus dans cette table**, pas une
branche de plus dans le code — et l'entrée ne s'écrit qu'après avoir été mesurée
sur une cellule réelle. Chaque ligne ci-dessous l'a été.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: Les éléments qu'une famille peut recevoir, dans l'ordre où ils se posent :
#: le dépôt avant Docker, Docker avant Compose. L'ordre est celui du §42.1 et il
#: n'est pas décoratif — Compose est un paquet du dépôt qu'on vient d'ajouter.
SSHD = "sshd"
CLES = "cles"
DEPOT = "depot"
DOCKER = "docker"
COMPOSE = "compose"

#: Ce que reçoit une famille qui n'a pas de dépôt Docker amont. Les clés viennent
#: du registre par `push_file` : elles ne dépendent d'aucune distribution, ce que
#: la campagne a constaté avant même d'avoir une doctrine (§42.11).
SANS_DOCKER = (SSHD, CLES)
AVEC_DOCKER = (SSHD, CLES, DEPOT, DOCKER, COMPOSE)

#: Ce que reçoit une cellule dont AUCUNE doctrine ne connaît la famille — une
#: Busybox, qui n'a ni `/etc/os-release` ni gestionnaire de paquets.
#:
#: Les clés y figurent, et c'est le fait fondateur de l'unité : elles sont
#: écrites par `incus file push` depuis le registre, sans qu'aucun paquet ne soit
#: posé. Une cellule qu'on ne sait pas équiper peut donc quand même recevoir ses
#: accès — ce qui ne sert à rien tant qu'aucun `sshd` n'écoute, mais reste vrai,
#: et le relevé doit dire ce qui est vrai.
SANS_FAMILLE = (CLES,)


@dataclass(frozen=True)
class Famille:
    """Une doctrine mesurée. Jamais une doctrine supposée.

    `os_ids` liste les `ID` d'`/etc/os-release` que cette famille sert
    directement ; `ID_LIKE` y rattache les dérivées (§42.9.2). Les deux listes
    sont distinctes à dessein : une dérivée peut être servie par son parent pour
    le gestionnaire de paquets sans l'être pour le dépôt Docker, et c'est
    exactement le cas de Kali et de Devuan (§42.9.2 bis).
    """

    cle: str
    os_ids: tuple[str, ...]
    #: Les paquets que la commande d'installation pose pour ouvrir SSH.
    paquets_ssh: tuple[str, ...]
    #: Le nom du service SSH tel que le gestionnaire de services le connaît.
    #: `ssh` sur Debian, `sshd` partout ailleurs — les confondre laisse un
    #: `enable` sans effet et une porte fermée.
    service_ssh: str
    #: `systemd` ou `openrc`. Il décide de la commande d'activation, jamais
    #: l'inverse : une cellule sans systemd n'a pas de `systemctl` à appeler.
    services: str
    #: `apt`, `dnf`, `zypper`, `pacman`, `apk` — le nom du gestionnaire, qui sert
    #: aussi de clé de famille.
    paquets: str
    #: Ce que Docker publie POUR CETTE FAMILLE : `{identifiant lu → distribution
    #: du dépôt amont}`. Vide quand Docker n'en publie aucun — ce n'est PAS un
    #: manque à combler, c'est un fait sur le dépôt de Docker, et le §41.2
    #: interdit de le remplacer par le paquet de la distribution.
    #:
    #: La clé est l'`ID` que la cellule déclare. Une distribution ABSENTE de ce
    #: dictionnaire n'a pas de Docker.
    depot_docker: dict[str, str] = field(default_factory=dict)
    #: Ce qu'un `ID_LIKE` autorise à conclure, ce qui n'est PAS la même chose.
    #:
    #: La distinction est née d'une mesure. Oracle Linux et Amazon Linux
    #: déclarent `ID_LIKE=fedora` tout en étant des RHEL : leur `$releasever`
    #: vaut « 9 » ou « 2023 », que le dépôt Fedora — qui publie 24 à 43 — ne
    #: connaît pas. Lire leur `ID_LIKE` comme une autorisation aurait posé un
    #: dépôt qui répond et n'a pas leurs paquets, c'est-à-dire exactement le
    #: défaut du §42.9.2 bis, une troisième fois.
    #:
    #: Un `ID_LIKE` ne vaut donc que là où une cellule l'a montré. Tant qu'aucune
    #: ne l'a fait, la distribution reçoit SSH et pas Docker — annoncer l'inverse
    #: serait deviner.
    depot_docker_parents: dict[str, str] = field(default_factory=dict)
    #: Les dérivées que cette famille sert par `ID_LIKE`.
    parents: tuple[str, ...] = ()
    elements: tuple[str, ...] = field(default=SANS_DOCKER)


#: MESURÉES sur la Forge de test le 2026-09-08, cellule par cellule, et
#: vérifiées sur leur RÉSULTAT — `sshd` actif, puis connexion depuis le poste
#: avec la clé du registre. Pas sur un code de retour (§42.5).
FAMILLES: dict[str, Famille] = {
    "apt": Famille(
        cle="apt",
        os_ids=("debian", "ubuntu"),
        # `ca-certificates` et `curl` ne sont plus ici par hasard : le dépôt en a
        # besoin et les posait par effet de bord de cette ligne (§42.9.2 ter).
        # Ils y restent parce qu'ils servent aussi au locataire, mais le dépôt ne
        # compte plus dessus.
        paquets_ssh=("openssh-server", "ca-certificates", "curl"),
        service_ssh="ssh",
        services="systemd",
        paquets="apt",
        # L'ordre compte : une dérivée d'Ubuntu déclare `ubuntu debian`, et
        # c'est `ubuntu` qui la sert. Mettre `debian` d'abord enverrait Linux
        # Mint chercher ses paquets chez Debian.
        # `linuxmint` y figure parce qu'une cellule Mint l'a MONTRÉ : elle
        # publie `UBUNTU_CODENAME=noble`, donc sa suite amont est lisible. Kali
        # et Devuan n'y sont pas, pour la raison inverse — mesurée elle aussi.
        depot_docker={"debian": "debian", "ubuntu": "ubuntu",
                      "linuxmint": "ubuntu"},
        # L'ordre compte : une dérivée d'Ubuntu déclare « ubuntu debian », et
        # c'est `ubuntu` qui la sert. Mettre `debian` d'abord enverrait Linux
        # Mint chercher ses paquets chez Debian.
        depot_docker_parents={"ubuntu": "ubuntu", "debian": "debian"},
        elements=AVEC_DOCKER,
    ),
    "apk": Famille(
        cle="apk",
        os_ids=("alpine",),
        paquets_ssh=("openssh",),
        service_ssh="sshd",
        services="openrc",
        paquets="apk",
        # Docker ne publie AUCUN dépôt amont pour Alpine, et le paquet vient de
        # la distribution — ce que le §41.2 refuse depuis qu'un `docker.io`
        # mesuré s'est révélé présent et inutilisable.
        elements=SANS_DOCKER,
    ),
    "dnf": Famille(
        cle="dnf",
        os_ids=("fedora", "centos", "rhel"),
        paquets_ssh=("openssh-server",),
        service_ssh="sshd",
        services="systemd",
        paquets="dnf",
        # MESURÉ sur Almalinux 9 : `docker-ce 29.8.0-1.el9` depuis
        # `linux/centos`, `nginx:alpine` qui démarre sous AppArmor et seccomp
        # actifs. La doctrine du §41.2 s'étend à la famille RHEL sans aucun
        # contournement.
        depot_docker={"centos": "centos", "rhel": "centos",
                      "almalinux": "centos", "rocky": "centos",
                      "fedora": "fedora"},
        # `centos` et `rhel` seulement : voir la note du champ. `fedora` n'y est
        # PAS, précisément parce qu'Oracle et Amazon Linux s'en réclament.
        depot_docker_parents={"centos": "centos", "rhel": "centos"},
        parents=("rhel", "centos", "fedora"),
        elements=AVEC_DOCKER,
    ),
    "zypper": Famille(
        cle="zypper",
        os_ids=("opensuse", "opensuse-tumbleweed", "opensuse-leap", "sles"),
        # `openssh`, et non `openssh-server` : le premier essai a rendu 104,
        # « paquet introuvable ». Le nom du paquet est une mesure, pas une
        # convention qu'on transpose d'une famille à l'autre.
        paquets_ssh=("openssh",),
        service_ssh="sshd",
        services="systemd",
        paquets="zypper",
        # Docker publie `linux/sles`, qui n'est pas openSUSE. Tant qu'on ne l'a
        # pas mesuré sur une cellule, la famille n'a pas de Docker.
        parents=("opensuse", "suse"),
        elements=SANS_DOCKER,
    ),
    "pacman": Famille(
        cle="pacman",
        os_ids=("arch", "archlinux"),
        paquets_ssh=("openssh",),
        service_ssh="sshd",
        services="systemd",
        paquets="pacman",
        elements=SANS_DOCKER,
    ),
}

#: Les `ID` d'`/etc/os-release` que la campagne a relevés et rattachés à une
#: famille par leur `ID_LIKE`. La table sert à documenter ce qui a été VU, pas à
#: décider : c'est `ID_LIKE` lu dans la cellule qui décide, toujours.
#:
#: `openEuler` figure ici parce qu'il ne déclare aucun `ID_LIKE` alors qu'il est
#: une RHEL au sens du gestionnaire de paquets — sans cette ligne, il tomberait
#: en famille inconnue pour un champ absent de son fichier.
RATTACHEMENTS = {
    "almalinux": "dnf", "rocky": "dnf", "ol": "dnf", "amzn": "dnf",
    "openeuler": "dnf",
    "devuan": "apt", "kali": "apt", "linuxmint": "apt", "raspbian": "apt",
}


def de_identite(os_id: str, parents: tuple[str, ...] = ()) -> Famille | None:
    """La famille de cette cellule, ou `None` si aucune doctrine ne la sert.

    L'ordre des trois lectures n'est pas indifférent :

    1. l'`ID` lui-même, parce qu'une Debian est sa propre référence ;
    2. le rattachement explicite, pour les distributions qui ne déclarent pas
       d'`ID_LIKE` alors qu'elles appartiennent clairement à une famille —
       `openEuler` est le cas mesuré ;
    3. `ID_LIKE`, qui sert les dérivées.

    Rendre `None` plutôt que de lever : « je ne sais pas servir » est une
    réponse que l'appelant doit pouvoir lire sans se protéger d'une exception,
    et le relevé (§42.7) doit répondre même là où l'amorçage refusera.
    """
    identifiant = (os_id or "").strip().lower()
    if not identifiant:
        return None
    for famille in FAMILLES.values():
        if identifiant in famille.os_ids:
            return famille
    rattachee = RATTACHEMENTS.get(identifiant)
    if rattachee is not None:
        return FAMILLES[rattachee]
    for parent in parents:
        parent = (parent or "").strip().lower()
        for famille in FAMILLES.values():
            if parent in famille.os_ids or parent in famille.parents:
                return famille
    return None


def de_alias(alias: str) -> Famille | None:
    """La famille PRÉSUMÉE d'un alias du dépôt — `debian/13` → `apt`.

    @spec docs/DAT.md §42.14, §33.3

    C'est tout ce qu'on a avant qu'une cellule existe, et le §33.3 s'applique :
    une présomption n'est pas un relevé. La vérité reste ce que la cellule
    déclare (§42.9), et le catalogue ne fait qu'annoncer.

    Le nom d'un alias est celui de la distribution, pas son `ID` : `mint/wilma`
    donne `mint`, quand la cellule dira `linuxmint`. Les deux orthographes sont
    donc essayées — sans quoi le catalogue et le relevé se contrediraient, ce
    qu'ils faisaient jusqu'au 2026-09-08 (§33.3 bis).
    """
    return de_identite(identifiant_de_alias(alias))


def identifiant_de_alias(alias: str) -> str:
    """L'`ID` que la cellule DIRA, déduit du nom de l'alias (§42.14).

    `mint/wilma` donne `linuxmint`, `oracle/9` donne `ol`. Sans cette traduction,
    le catalogue et le relevé parlent de deux choses différentes — ce qu'ils
    faisaient jusqu'au 2026-09-08 (§33.3 bis).
    """
    nom = (alias or "").split("/", 1)[0].strip().lower()
    return ALIAS_VERS_ID.get(nom, nom)


#: Les alias du dépôt dont le nom diffère de l'`ID` que la cellule déclare.
#: Relevé sur la Forge le 2026-09-08, en comparant les deux pour chacune des 24
#: familles publiées : ce sont les seules qui divergent.
ALIAS_VERS_ID = {
    "mint": "linuxmint",
    "oracle": "ol",
    "amazonlinux": "amzn",
    "archlinux": "arch",
    "rockylinux": "rocky",
    "voidlinux": "void",
    "alt": "altlinux",
}


def depot_connu(famille: Famille | None, identifiant: str = "",
                parents: tuple[str, ...] = ()) -> bool:
    """Docker publie-t-il un dépôt pour CETTE distribution ? (§42.11, §42.14)

    Appartenir à une famille qui a Docker ne suffit pas, et c'est le fait que la
    campagne a établi trois fois : Kali et Devuan sont des `apt` dont la suite
    n'existe pas chez Docker ; Oracle et Amazon Linux sont des `dnf` qui se
    déclarent `fedora` en portant un `$releasever` de RHEL. Répondre par famille
    leur annonçait un Docker qu'aucun geste ne poserait.
    """
    if famille is None or DOCKER not in famille.elements:
        return False
    identifiant = (identifiant or "").strip().lower()
    if identifiant in famille.depot_docker:
        return True
    return any((p or "").strip().lower() in famille.depot_docker_parents
               for p in parents)


def capacites(famille: Famille | None, identifiant: str = "",
              parents: tuple[str, ...] = ()) -> dict[str, bool]:
    """Ce que le produit sait faire de cette famille (§42.12, §42.14).

    `env` vaut `true` **partout**, y compris sans famille : c'est le fait que la
    campagne a établi, et il est la raison d'être de cette table. Les variables,
    les secrets et les clés passent par `incus file push`, qui ne dépend d'aucune
    distribution — c'est précisément pour cela que refuser une famille en bloc
    privait la cellule de ce qu'on savait pourtant lui donner.

    `identity` et `terminal` suivent `ssh` sans s'y confondre : la première a
    besoin d'`ssh-keygen`, le second du chemin normal du §37.2. Les fondre ferait
    disparaître les deux le jour où l'une des deux cesserait de dépendre de
    l'autre.
    """
    sert = famille is not None
    docker = depot_connu(famille, identifiant, parents)
    return {
        "env": True,
        "ssh": sert,
        "identity": sert,
        "terminal": sert,
        "docker": docker,
        # Compose est un paquet du dépôt Docker : sans dépôt, pas de greffon.
        # Le déduire plutôt que de le déclarer évite qu'une famille annonce un
        # Compose sans moteur, ce qui ne veut rien dire.
        "compose": docker and bool(famille and COMPOSE in famille.elements),
    }
