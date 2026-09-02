"""Amorcer un Spark : détecter d'abord, n'installer que les manques.

@spec docs/BACKLOG.md#SPK-54 · docs/BACKLOG.md#SPK-76 · docs/DAT.md §41 (ce que
      l'image ne donne pas), §42.9 (la famille de la cellule décide),
      §41.2 (Docker vient du dépôt AMONT, jamais de la distribution),
      §42.1 (détecter d'abord), §42.5 (exec_capture), §42.6 (la détection,
      exactement), §42.7 (le contrat d'API), §42.8 (ce que le journal reçoit) ·
      §37.3 (le chemin `incus exec`) · §21.2 (ce qui ne traverse pas le journal) ·
      docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.3 (versions du relevé) ·
      docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9.2 (l'architecture, que seul le
      relevé peut lire)

Le point qui décide de ce module : **détecter Docker présent ne suffit pas**. Un
`docker.io` de distribution est présent *et* inutilisable — son profil AppArmor
précède la médiation des sockets unix d'AppArmor 4, et tout ce qui appelle
`socketpair()` meurt (§41.2). La détection porte donc sur l'ORIGINE du paquet, et
un Docker de distribution est un DÉFAUT à corriger, pas un état acceptable.

Sans cela, l'amorçage déclarerait bon un Spark où aucune pile ne tournera.

Le second point, ajouté le 2026-09-02 (§42.9) : **rien ne vérifiait que la cellule
était bien une Debian 13**, alors que le catalogue du §33 en propose quatre. Le
dépôt amont dépend de la distribution ET de sa suite ; les figer en constantes
posait `linux/debian trixie` sur une Ubuntu `noble` — un dépôt qui RÉPOND, donc
un `apt-get update` qui réussit, et un `apt-get install` qui échoue ensuite sans
que rien n'ait prévenu. Un dépôt joignable n'est pas un dépôt juste.
"""

from __future__ import annotations

from typing import Any

#: Les trois états d'un élément (§42.7). Jamais deux : réduire à un booléen
#: rendrait le `docker.io` de distribution inexprimable.
PRESENT = "present"
ABSENT = "absent"
DEFECT = "defect"

#: Les distributions pour lesquelles Docker publie un dépôt amont (§42.9.2).
#: Ce n'est PAS la liste des distributions qui existent : c'est celle que le
#: §41.2 sait servir, et elle se lit dans l'URL du dépôt.
DEPOTS_AMONT = ("debian", "ubuntu")

#: La famille que l'amorçage sert. Une seule aujourd'hui, et elle est NOMMÉE :
#: un `None` implicite ferait passer « pas encore relevé » pour « pas servi ».
FAMILLE_APT = "apt"

#: Le `PATH` que le relevé pose lui-même (§42.9.1). C'était la seule raison
#: invoquée pour `bash -lc` — `sshd` vit dans `/usr/sbin` —, et l'écrire est plus
#: sûr que de l'attendre d'un profil de connexion qui varie d'une image à l'autre.
CHEMIN = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

#: Le relevé du §42.6. Une seule commande, elle n'écrit RIEN, et elle rend une
#: ligne `clé=valeur` par élément — lisible à l'œil au débogage comme au journal.
#:
#: L'empreinte des clés est TRONQUÉE à 64 caractères et ne sert qu'à comparer :
#: le §21.2 interdit qu'une clé publique entière traverse le journal.
#:
#: SPK-76 · §42.9.8 — chaque ligne construite par un PIPELINE se garde ensuite
#: par `[ -n "$x" ] || x=absent`. Un `|| echo absent` accroché à un pipeline ne
#: se déclenche jamais : c'est le code de sa DERNIÈRE commande qui compte, et
#: `head` comme `cut` réussissent sur une entrée vide. Une commande absente
#: rendait donc la chaîne VIDE, que le jugement lisait comme « présent ».
RELEVE = r"""
os_id=$(. /etc/os-release 2>/dev/null && echo "$ID")
os_suite=$(. /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME")
os_like=$(. /etc/os-release 2>/dev/null && echo "$ID_LIKE")
arch=$(uname -m 2>/dev/null)
[ -n "$arch" ] || arch=absent
sshd=$(systemctl is-active ssh 2>/dev/null || echo absent)
openssh_version=$(dpkg-query -W -f='${Version}' openssh-server 2>/dev/null || echo absent)
cles=$(sha256sum /root/.ssh/authorized_keys 2>/dev/null | cut -c1-64)
[ -n "$cles" ] || cles=absent
depot_ligne=$(grep -h '^deb' /etc/apt/sources.list.d/docker.list 2>/dev/null | head -1)
depot_distro=$(printf '%s' "$depot_ligne" | sed -n 's|.*download\.docker\.com/linux/\([a-z][a-z]*\).*|\1|p')
depot_suite=$(printf '%s' "$depot_ligne" | sed -n 's|.*download\.docker\.com/linux/[a-z][a-z]* \([^ ][^ ]*\).*|\1|p')
docker=$(docker --version 2>/dev/null | head -1)
[ -n "$docker" ] || docker=absent
docker_version=$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || echo absent)
origine=$(dpkg-query -W -f='${Package}' docker-ce 2>/dev/null \
          || dpkg-query -W -f='${Package}' docker.io 2>/dev/null || echo absent)
compose=$(docker compose version 2>/dev/null | head -1)
[ -n "$compose" ] || compose=absent
compose_version=$(dpkg-query -W -f='${Version}' docker-compose-plugin 2>/dev/null || echo absent)
rootless=absent
if id spark-docker >/dev/null 2>&1; then
  uid=$(id -u spark-docker)
  if runuser -u spark-docker -- env XDG_RUNTIME_DIR=/run/user/$uid \
          DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus \
          systemctl --user is-active docker.service >/dev/null 2>&1 \
     && runuser -u spark-docker -- env XDG_RUNTIME_DIR=/run/user/$uid \
          DOCKER_HOST=unix:///run/user/$uid/docker.sock docker info >/dev/null 2>&1; then
    rootless=active
  fi
fi
mode=$(systemctl is-active docker.service >/dev/null 2>&1 && echo enracine \
       || ([ "$rootless" = active ] && echo rootless || echo absent))
printf 'os_id=%s\nos_suite=%s\nos_like=%s\narch=%s\nsshd=%s\nopenssh_version=%s\ncles=%s\ndepot_distro=%s\ndepot_suite=%s\ndocker=%s\ndocker_version=%s\norigine=%s\ncompose=%s\ncompose_version=%s\nmode=%s\n' \
  "$os_id" "$os_suite" "$os_like" "$arch" \
  "$sshd" "$openssh_version" "$cles" "$depot_distro" "$depot_suite" \
  "$docker" "$docker_version" "$origine" "$compose" "$compose_version" "$mode"
"""

#: Le compte de service du mode rootless. Un nom FIXE : il sert de signal à la
#: détection, et le laisser choisir rendrait le mode illisible d'un amorçage à
#: l'autre (§42.2 bis).
COMPTE_ROOTLESS = "spark-docker"

#: Les deux modes du §42.2 bis. `None` quand Docker est absent ou vient de la
#: distribution : on n'attribue pas un mode à ce qui ne tourne pas.
ENRACINE = "enracine"
ROOTLESS = "rootless"

#: Les raisons d'un `defect` sur le moteur (§42.9.9). Clés STABLES : la reprise
#: dure — purger `docker-ce` avant de le reposer — se décidait en cherchant une
#: tournure dans le message affiché, si bien que reformuler une phrase changeait
#: ce que l'amorçage installe.
PAQUET_DISTRIBUTION = "paquet_distribution"   # `docker.io` (§41.2)
DEPOT_ETRANGER = "depot_etranger"             # `docker-ce` d'une autre suite (§42.9.4)
MOTEUR_MUET = "moteur_muet"                   # paquet posé, moteur sans réponse (§42.9.8)

#: Les deux raisons qui exigent de RETIRER `docker-ce` avant de le reposer.
#: `docker.io` n'en fait pas partie : il porte un autre nom de paquet, et le
#: script le purge de toute façon.
REPRISES_DURES = (DEPOT_ETRANGER, MOTEUR_MUET)

#: L'ordre compte : le dépôt avant Docker, Docker avant Compose.
ELEMENTS = ("sshd", "cles", "depot", "docker", "compose")

LIBELLES = {
    "sshd": "serveur SSH",
    "cles": "clés d'accès",
    "depot": "dépôt Docker amont",
    "docker": "moteur Docker",
    "compose": "greffon Compose",
    # Ne figure pas dans le relevé ordinaire : cette ligne n'apparaît que dans
    # le compte rendu d'une reprise rootless interrompue (§42.2 bis).
    "rootless": "démon Docker rootless",
}


def _shell(script: str) -> list[str]:
    """Enveloppe un script dans un shell POSIX, `PATH` posé (§42.9.1).

    `sh -c` et non plus `bash -lc`. Le motif d'origine — le `PATH` d'une cellule
    fraîche ne porte pas `/usr/sbin`, où vit `sshd` — reste vrai, mais exiger
    `bash` faisait échouer le RELEVÉ lui-même sur une cellule qui n'en a pas :
    Incus refusait « Command not found » avant que le produit n'ait pu nommer la
    distribution qu'il venait constater. **Un diagnostic qui exige ce qu'il vient
    diagnostiquer ne diagnostique rien.**

    Poser le `PATH` explicitement répond au motif d'origine sans la dépendance,
    et vaut sur les trois familles.
    """
    return ["sh", "-c", f"export PATH={CHEMIN}\n{script}"]


class OSNonServi(RuntimeError):
    """L'amorçage ne sait pas servir cette distribution (§42.9.5).

    @spec docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.5

    Ce n'est PAS une panne, et c'est tout l'objet du type : une cellule Alpine
    qui répond parfaitement n'a rien de cassé. Elle est hors de ce que le §41.2
    sait faire, et le refus se rend en `409` comme les autres refus du §42.7.

    Distincte de `BootstrapFailed`, qui rend `502` : confondre « je ne sais pas
    faire ça » avec « ça a raté » ferait chercher une panne là où il n'y en a
    pas — exactement ce que le refus d'Incus « Command not found » a fait perdre
    au responsable.
    """


def identite(brut: dict[str, str]) -> dict[str, str]:
    """Ce que la cellule dit d'elle-même, normalisé (§42.9.1).

    Rendre un dictionnaire plutôt qu'un tuple : ce bloc voyage jusqu'à l'API
    (§42.7) et se lit à l'écran. `family` vaut `None` tant qu'on ne sait pas —
    « pas relevé » n'est pas « pas servi ».
    """
    os_id = brut.get("os_id", "").strip().lower()
    suite = brut.get("os_suite", "").strip().lower()
    parents = [m.strip().lower() for m in brut.get("os_like", "").split() if m.strip()]
    servie = os_id in DEPOTS_AMONT or any(p in DEPOTS_AMONT for p in parents)
    return {
        "id": os_id, "suite": suite, "like": " ".join(parents),
        "family": FAMILLE_APT if servie else (None if not os_id else os_id),
    }


def servie(brut: dict[str, str]) -> bool:
    """L'amorçage sait-il servir cette cellule ? (§42.9.5)"""
    return identite(brut)["family"] == FAMILLE_APT


def cible_apt(brut: dict[str, str]) -> tuple[str, str]:
    """Le dépôt amont de CETTE cellule : (distribution, suite) — §42.9.2.

    @spec docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.2

    Remplace les constantes `linux/debian` et `trixie`. Une dérivée est servie
    par son parent quand `ID_LIKE` le nomme, ce que Docker documente lui-même.

    **Sans `VERSION_CODENAME`, on refuse au lieu de deviner.** Poser une suite
    fausse est précisément le défaut que cette unité corrige : `download.docker.com`
    répondrait, `apt-get update` réussirait, et l'échec n'arriverait qu'à
    l'installation — trop tard pour être compris.
    """
    vue = identite(brut)
    os_id, parents = vue["id"], vue["like"].split()
    distribution = (os_id if os_id in DEPOTS_AMONT
                    else next((p for p in parents if p in DEPOTS_AMONT), None))
    if distribution is None:
        raise OSNonServi(
            f"L'amorçage ne sait pas servir « {os_id or 'distribution inconnue'} ». "
            "Il installe SSH et Docker sur les distributions de la famille Debian "
            "— Debian et Ubuntu —, dont il pose le dépôt Docker officiel. Cette "
            "cellule tourne et reste utilisable : vous pouvez y entrer par la "
            "console et l'équiper vous-même.")
    if not vue["suite"]:
        raise OSNonServi(
            f"La cellule se déclare « {os_id} » mais ne nomme pas sa version "
            "(`VERSION_CODENAME` absent d'`/etc/os-release`). L'amorçage ne "
            "devine pas une suite : un dépôt Docker posé sur la mauvaise version "
            "répond quand même, et l'erreur n'apparaîtrait qu'à l'installation.")
    return distribution, vue["suite"]


def origine_paquet(version: str) -> str | None:
    """La suite que la VERSION d'un paquet amont nomme (§42.9.4).

    Docker estampille l'origine dans la version : `5:29.7.2-1~debian.13~trixie`
    contre `5:29.7.2-1~ubuntu.24.04~noble`. C'est ce qui permet de voir qu'un
    `docker-ce` par ailleurs présent vient du dépôt d'une AUTRE distribution.

    Rend `None` quand la version ne porte pas cette marque : le §33.3 s'applique
    ici aussi — ne pas savoir n'est pas savoir que c'est faux, et un paquet
    reconstruit localement ne doit pas être déclaré défectueux sur un doute.
    """
    if not version or "~" not in version:
        return None
    return version.rsplit("~", 1)[-1].strip().lower() or None


def releve_brut(driver: Any, incus_name: str) -> dict[str, str]:
    """Exécute le relevé du §42.6 et rend ses lignes, telles quelles.

    Un code de sortie non nul n'est pas une erreur (§42.5) : le relevé emploie
    des commandes qui échouent quand la chose est absente, et c'est la réponse
    qu'on cherche.
    """
    _, sortie, _ = driver.exec_capture(incus_name, _shell(RELEVE))
    lignes: dict[str, str] = {}
    for ligne in sortie.splitlines():
        if "=" not in ligne:
            continue
        cle, _, valeur = ligne.partition("=")
        lignes[cle.strip()] = valeur.strip()
    return lignes


def juger(brut: dict[str, str], cles_voulues: str | None = None,
          cles_accordees: int | None = None) -> list[dict[str, Any]]:
    """Traduit le relevé en états, dans l'ordre du §42.1.

    `cles_voulues` est l'empreinte tronquée des clés que le REGISTRE veut voir
    (§17.1). Elle est comparée, jamais affichée en entier.

    `cles_accordees` est le NOMBRE de clés que le registre accorde. Il décide de
    ce qu'une correspondance veut dire (§42.10.4) : deux vides correspondent, et
    la ligne concluait `present` sur une cellule que personne ne peut atteindre.
    """
    vus: list[dict[str, Any]] = []

    actif = brut.get("sshd", "absent")
    vus.append({
        "key": "sshd", "label": LIBELLES["sshd"],
        "state": PRESENT if actif == "active" else ABSENT,
        "detail": actif,
    })

    empreinte = brut.get("cles", "absent") or "absent"
    if cles_accordees == 0:
        # §42.10.4 : le registre n'accorde RIEN. Le fichier de la cellule a beau
        # correspondre — deux vides correspondent —, la cellule est fermée à tout
        # le monde. La dire « en place » faisait conclure « joignable en SSH » à
        # l'écran sur un Spark que nul n'atteint.
        etat_cles = ABSENT
        detail_cles = ("aucune clé n'est accordée à ce Spark : personne ne peut "
                       "s'y connecter, même une fois le serveur SSH installé")
    elif empreinte == "absent":
        etat_cles, detail_cles = ABSENT, "aucun fichier authorized_keys"
    elif cles_voulues is None:
        # Le registre ne dit pas ce qu'il veut : on constate la présence sans
        # prétendre juger la conformité (§14.6 — « inconnu » n'est pas « bon »).
        etat_cles, detail_cles = PRESENT, "présentes, conformité non vérifiée"
    elif empreinte == cles_voulues:
        etat_cles, detail_cles = PRESENT, "conformes au registre"
    else:
        # Ni absentes ni bonnes : c'est exactement ce que `defect` nomme.
        etat_cles, detail_cles = DEFECT, "différentes de ce que le registre déclare"
    vus.append({"key": "cles", "label": LIBELLES["cles"],
                "state": etat_cles, "detail": detail_cles})

    # §42.9.3 : un `docker.list` présent peut nommer une AUTRE distribution que
    # la cellule. C'est le cas mesuré sur l'Ubuntu du responsable, et rien ne
    # s'en plaignait : le dépôt Debian répond, donc `apt-get update` réussissait.
    # La comparaison porte donc sur ce que le fichier DIT, pas sur son existence.
    pose = (brut.get("depot_distro", "").strip().lower(),
            brut.get("depot_suite", "").strip().lower())
    try:
        attendu = cible_apt(brut)
    except OSNonServi:
        # La cellule n'est pas servie : on ne prétend pas juger son dépôt. Le
        # refus se fait en amont (§42.9.5), il n'a pas à se répéter ligne à ligne.
        attendu = None
    if not pose[0]:
        etat_depot, detail_depot = ABSENT, "absent"
    elif attendu is None:
        etat_depot, detail_depot = PRESENT, f"{pose[0]} {pose[1]}".strip()
    elif pose == attendu:
        etat_depot, detail_depot = PRESENT, f"{pose[0]} {pose[1]}"
    else:
        etat_depot = DEFECT
        detail_depot = (
            f"pointe « {pose[0]} {pose[1]} » alors que la cellule est une "
            f"« {attendu[0]} {attendu[1]} ». Le dépôt répond, mais ses paquets "
            "ne sont pas ceux de cette distribution.")
    vus.append({"key": "depot", "label": LIBELLES["depot"],
                "state": etat_depot, "detail": detail_depot})

    # LE point de l'unité (§41.2) : l'origine, pas la présence.
    origine = brut.get("origine", "absent") or "absent"
    version = brut.get("docker", "absent") or "absent"
    # §42.9.9 : la RAISON du défaut voyage à part, en clé stable. Elle décidait
    # jusqu'ici d'une reprise plus dure — purger `docker-ce` —, et cette décision
    # se prenait en cherchant une tournure dans le message en PROSE. Reformuler
    # une phrase aurait silencieusement changé ce que l'amorçage installe.
    raison_docker = None
    if origine == "docker-ce" and version == "absent":
        # §42.9.8, MESURÉ sur la Forge de test le 2026-09-02 : `dpkg` connaît
        # `docker-ce`, et `docker --version` ne répond RIEN. C'est l'état que
        # laisse une installation interrompue — le paquet est dépaqueté, pas
        # configuré —, exactement celle que le dépôt faux du §42.9.3 provoque.
        #
        # Le déclarer « présent » était le pire des cas : l'amorçage réparait le
        # dépôt puis SAUTAIT le moteur, en le croyant en place, et laissait la
        # cellule inutilisable. La présence du paquet ne prouve pas le moteur —
        # c'est la leçon du §41.2, appliquée à l'installation inachevée.
        etat_docker, raison_docker = DEFECT, MOTEUR_MUET
        detail_docker = (
            "le paquet « docker-ce » est installé mais le moteur ne répond pas : "
            "`docker --version` ne rend rien. L'installation n'est pas allée à "
            "son terme, et rien ne tournera tant qu'elle ne sera pas reprise.")
    elif origine == "docker-ce":
        # §42.9.4 : `docker-ce` ne suffit plus. Un paquet du dépôt Debian posé
        # sur une Ubuntu porte sa suite dans sa version, et il est là SANS être
        # celui qui convient — même leçon qu'au §41.2, un cran plus haut.
        marque = origine_paquet(brut.get("docker_version", ""))
        if attendu is not None and marque is not None and marque != attendu[1]:
            etat_docker, raison_docker = DEFECT, DEPOT_ETRANGER
            detail_docker = (
                f"{version} — paquet « {marque} », posé depuis le dépôt d'une "
                f"autre distribution que cette cellule « {attendu[1]} ». "
                "L'installation de ses dépendances échoue, et le moteur reste "
                "incomplet.")
        else:
            etat_docker, detail_docker = PRESENT, version
    elif origine == "docker.io":
        etat_docker, raison_docker = DEFECT, PAQUET_DISTRIBUTION
        detail_docker = (
            f"{version} — paquet « docker.io » de la distribution. Son profil "
            "AppArmor refuse socketpair() sous imbrication : les conteneurs "
            "démarrent puis meurent."
        )
    else:
        etat_docker, detail_docker = ABSENT, "absent"
    # §42.2 bis : le mode est une OBSERVATION, pas une préférence. Il dit ce qui
    # EST. Un Docker absent ou de distribution n'en a pas : lui en attribuer un
    # ferait croire à un choix là où il n'y a rien qui tourne.
    releve_mode = brut.get("mode", "absent")
    mode = releve_mode if (etat_docker == PRESENT
                           and releve_mode in (ENRACINE, ROOTLESS)) else None
    vus.append({"key": "docker", "label": LIBELLES["docker"],
                "state": etat_docker, "detail": detail_docker, "mode": mode,
                "reason": raison_docker})

    # §42.9.8 : même garde. `docker compose version` muet ne prouve pas un
    # greffon — il prouve qu'il n'y a rien pour répondre.
    compose = brut.get("compose", "absent") or "absent"
    vus.append({
        "key": "compose", "label": LIBELLES["compose"],
        "state": ABSENT if compose == "absent" else PRESENT,
        "detail": compose,
    })
    return vus


def manques(vus: list[dict[str, Any]]) -> list[str]:
    """Les éléments sur lesquels l'amorçage doit agir.

    `defect` en fait partie : un `docker.io` présent est un défaut à corriger, et
    des clés qui ne correspondent plus au registre doivent être réécrites.
    """
    return [v["key"] for v in vus if v["state"] in (ABSENT, DEFECT)]


def complet(vus: list[dict[str, Any]]) -> bool:
    return not manques(vus)


# --- Ce qui s'exécute pour réparer, élément par élément ----------------------
#
# Chaque script est INDÉPENDANT et rejouable. Un amorçage n'exécute que ceux dont
# l'élément manque : réinstaller « au cas où » redémarrerait le démon Docker du
# locataire, donc sa production, pour rien (§42.1).

APT = "set -e\nexport DEBIAN_FRONTEND=noninteractive\n"

#: Ce qui borne la sortie d'erreur rendue à qui a demandé le geste (§42.9.7).
#: Elle ne traverse PAS le journal d'audit : le §42.8 l'interdit, et une sortie
#: d'`apt` nomme les paquets du locataire.
LIGNES_ERREUR = 12
CARACTERES_ERREUR = 1500

SCRIPTS = {
    "sshd": APT + (
        "apt-get update -qq\n"
        "apt-get install -y -qq openssh-server ca-certificates curl\n"
        "systemctl enable --now ssh\n"
    ),
    "compose": APT + "apt-get install -y -qq docker-compose-plugin\n",
}


def script_depot(distribution: str, suite: str) -> str:
    """Pose le dépôt amont de CETTE distribution (§42.9.2).

    @spec docs/BACKLOG.md#SPK-76 · docs/DAT.md §41.2, §42.9.2

    C'était une constante : `linux/debian` et `trixie`, quelle que soit la
    cellule. Le fichier est RÉÉCRIT et non complété — un `docker.list` défectueux
    au sens du §42.9.3 doit disparaître, pas cohabiter avec le bon.
    """
    return APT + (
        "install -m 0755 -d /etc/apt/keyrings\n"
        f"curl -fsSL https://download.docker.com/linux/{distribution}/gpg "
        "-o /etc/apt/keyrings/docker.asc\n"
        "chmod a+r /etc/apt/keyrings/docker.asc\n"
        'echo "deb [arch=$(dpkg --print-architecture) '
        'signed-by=/etc/apt/keyrings/docker.asc] '
        f'https://download.docker.com/linux/{distribution} {suite} stable" '
        "> /etc/apt/sources.list.d/docker.list\n"
        "apt-get update -qq\n"
    )


def script_docker(purger_ce: bool = False) -> str:
    """Pose `docker-ce`, en retirant d'abord ce qui l'empêcherait de servir.

    @spec docs/BACKLOG.md#SPK-76 · docs/DAT.md §41.2, §42.9.4, §42.9.7

    `docker.io` est TOUJOURS purgé (§41.2) : les laisser cohabiter ne réparerait
    rien, c'est son profil AppArmor qui casse et il resterait posé.

    `purger_ce` ne se déclenche que sur le défaut du §42.9.4 — un `docker-ce`
    venu du dépôt d'une autre distribution. `apt` ne remplace pas de lui-même un
    paquet de même nom dont la version est plus haute que celle du bon dépôt.
    La purge ne touche PAS `/var/lib/docker` : les images et les volumes du
    locataire survivent, seul le démon redémarre.
    """
    purge = "docker.io docker-doc docker-compose podman-docker containerd runc"
    if purger_ce:
        purge = "docker-ce docker-ce-cli " + purge
    return APT + (
        f"apt-get purge -y -qq {purge} 2>/dev/null || true\n"
        # §42.9.7 : `set -e` interdit de poursuivre après un échec, mais la
        # reprise mesurée reste possible parce qu'elle est EXPLICITE. Sur un
        # Spark à 2 Gio, `dpkg` a échoué une fois en « Broken pipe » au
        # dépaquetage, et `--configure -a` a suffi (AGENT_RUNBOOK §C.3).
        # L'installation est alors REJOUÉE : sans cela, la reprise masquerait
        # l'échec au lieu de le réparer.
        "if ! apt-get install -y -qq docker-ce docker-ce-cli containerd.io; then\n"
        "  dpkg --configure -a\n"
        "  apt-get install -y -qq docker-ce docker-ce-cli containerd.io\n"
        "fi\n"
        "systemctl enable --now docker\n"
    )


#: Le mode ROOTLESS (§42.2, §42.2 bis). Il s'ajoute à l'installation enracinée
#: plutôt que de la remplacer : `docker-ce` fournit le binaire et le paquet
#: `-rootless-extras` l'outil d'installation par compte. `systemd-container`
#: reste une dépendance explicite du contrat de reprise Debian 13 (§42.2 bis),
#: même si la pose n'appelle jamais `machinectl shell` : elle passe par le bus
#: utilisateur avec `runuser`.
#:
#: `enable-linger` n'est pas une précaution : sans lui, le démon du compte meurt
#: à la fin de sa session, ce qui donnerait une cellule qui marche jusqu'au
#: premier redémarrage — et cela ne se verrait qu'alors.
SCRIPT_ROOTLESS = APT + (
    "apt-get install -y -qq docker-ce-rootless-extras uidmap dbus-user-session systemd-container\n"
    f"id {COMPTE_ROOTLESS} >/dev/null 2>&1 || "
    f"useradd -m -s /bin/bash {COMPTE_ROOTLESS}\n"
    f"loginctl enable-linger {COMPTE_ROOTLESS}\n"
    # Le démon enraciné est ARRÊTÉ : deux démons sur la même cellule se
    # disputeraient le stockage et les réseaux.
    "systemctl disable --now docker.service docker.socket 2>/dev/null || true\n"
    # `machinectl shell` a quitté sans créer d'unité sur la cellule réelle.
    # Le bus existe déjà grâce à linger; l'indiquer à `runuser` joint le BON
    # utilisateur et laisse l'outil Docker installer son unité systemd.
    f"uid=$(id -u {COMPTE_ROOTLESS})\n"
    f"gid=$(id -g {COMPTE_ROOTLESS})\n"
    "uid_map=$(awk 'NR == 1 {print $1 \":\" $3}' /proc/self/uid_map)\n"
    "gid_map=$(awk 'NR == 1 {print $1 \":\" $3}' /proc/self/gid_map)\n"
    "uid_map_start=${uid_map%%:*}; uid_map_count=${uid_map##*:}\n"
    "gid_map_start=${gid_map%%:*}; gid_map_count=${gid_map##*:}\n"
    "[ \"$uid_map_start\" = 0 ] && [ \"$gid_map_start\" = 0 ] || "
    "{ echo 'idmap Incus non delegable' >&2; exit 1; }\n"
    "subuid_start=$((uid + 1)); subuid_count=$((uid_map_count - subuid_start))\n"
    "subgid_start=$((gid + 1)); subgid_count=$((gid_map_count - subgid_start))\n"
    "[ \"$subuid_count\" -gt 0 ] && [ \"$subgid_count\" -gt 0 ] || "
    "{ echo 'idmap Incus insuffisant pour Docker rootless' >&2; exit 1; }\n"
    f"sed -i '/^{COMPTE_ROOTLESS}:/d' /etc/subuid /etc/subgid\n"
    f"printf '%s:%s:%s\\n' {COMPTE_ROOTLESS} \"$subuid_start\" \"$subuid_count\" >> /etc/subuid\n"
    f"printf '%s:%s:%s\\n' {COMPTE_ROOTLESS} \"$subgid_start\" \"$subgid_count\" >> /etc/subgid\n"
    f"runuser -u {COMPTE_ROOTLESS} -- env XDG_RUNTIME_DIR=/run/user/$uid "
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus "
    "dockerd-rootless-setuptool.sh install\n"
)


class BootstrapFailed(RuntimeError):
    """Une commande d'installation a refusé de produire l'état voulu.

    @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §42.5 (le code non nul d'une
          installation échoue), §42.7 (bootstrap_failed)
    """


def reprise_rootless(vus: list[dict[str, Any]], voulu: str) -> bool:
    """Une demande rootless doit-elle reprendre le seul démon inachevé ?

    Un Docker CE présent sans mode ne vaut PAS un Docker enraciné : le service
    root est absent et aucun conteneur ne change donc de propriétaire. C'est le
    seul état où la reprise est sûre; `enracine` continue par `verifier_mode` à
    refuser toute bascule (§42.2 bis).
    """
    docker = next((vu for vu in vus if vu["key"] == "docker"), None)
    return bool(voulu == ROOTLESS and docker
                and docker["state"] == PRESENT and docker.get("mode") is None)


def script_rootless() -> list[str]:
    """La seule préparation à rejouer après une interruption (§42.2 bis)."""
    return _shell(SCRIPT_ROOTLESS)


def verifier_reprise_rootless(vus: list[dict[str, Any]]) -> None:
    """Refuse un compte rendu de succès sans démon utilisateur observable."""
    docker = next((vu for vu in vus if vu["key"] == "docker"), None)
    if docker and docker.get("mode") == ROOTLESS:
        return
    raise BootstrapFailed(
        "La reprise rootless a terminé sans démon utilisateur détectable. "
        "Aucun succès n'est inscrit : vérifiez le service de spark-docker."
    )


class ModeConflit(RuntimeError):
    """Le mode demandé n'est pas celui qui tourne (§42.2 bis).

    Ce n'est PAS une panne : c'est un refus, et il se rend en `409`.
    """


def verifier_mode(vus: list[dict[str, Any]], voulu: str) -> None:
    """Refuse de BASCULER un Docker déjà en place (§42.2 bis).

    @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §42.2 bis

    Basculer déplacerait le démon sous un autre compte, et avec lui les
    conteneurs, les volumes et les réseaux du locataire — sa production, sans
    qu'il l'ait demandé. Le §42.1 ne tolère déjà pas un redémarrage gratuit du
    démon ; une bascule est un ordre de grandeur au-dessus.

    Sur une cellule vierge, les deux modes sont ouverts : c'est le seul moment
    où le choix se fait sans rien casser.
    """
    docker = next((v for v in vus if v["key"] == "docker"), None)
    en_place = docker.get("mode") if docker else None
    if en_place is None or en_place == voulu:
        return
    lisible = {ENRACINE: "enraciné", ROOTLESS: "rootless"}
    raise ModeConflit(
        f"Ce Spark fait déjà tourner un Docker {lisible[en_place]}, et l'amorçage "
        f"a été demandé en {lisible[voulu]}. Basculer déplacerait le démon sous un "
        "autre compte, et avec lui les conteneurs, les volumes et les réseaux qui "
        "y tournent. L'amorçage ne le fait pas : il faudrait vider la cellule "
        "d'abord, ce qui est un geste du locataire et non de la console."
    )


def script_pour(cle: str, brut: dict[str, str] | None = None,
                rootless: bool = False, purger_ce: bool = False) -> list[str] | None:
    """Le geste de réparation d'un élément, ou `None` s'il n'en a pas.

    @spec docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.2

    Les clés font exception : elles ne s'installent pas, elles se réécrivent
    depuis le registre — et par `push_file`, pas par un script (§17.1).

    Le relevé est désormais un ARGUMENT : le dépôt amont se construit depuis la
    cellule, il ne se récite plus depuis une constante de module.
    """
    if cle == "cles":
        return None
    if cle == "depot":
        distribution, suite = cible_apt(brut or {})
        return _shell(script_depot(distribution, suite))
    if cle == "docker":
        script = script_docker(purger_ce)
        return _shell(script + SCRIPT_ROOTLESS if rootless else script)
    script = SCRIPTS.get(cle)
    return _shell(script) if script else None


def echec(cle: str, code: int, stderr: str = "") -> str:
    """Le message d'une pose ratée : le code ET sa cause (§42.9.7).

    @spec docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.7

    `code, _, _ = exec_capture(...)` jetait le `stderr` : le produit LISAIT la
    cause et la laissait tomber pour n'afficher qu'« a échoué (code 1) ». Un
    code de sortie sans cause n'est pas un diagnostic.

    La sortie est bornée par la fin — c'est là qu'`apt` écrit ce qui a bloqué,
    le début n'étant que des lignes de téléchargement.
    """
    tete = f"L'installation de « {LIBELLES.get(cle, cle)} » a échoué (code {code})."
    lignes = [l.rstrip() for l in (stderr or "").splitlines() if l.strip()]
    if not lignes:
        return tete + " La cellule n'a rien écrit sur sa sortie d'erreur."
    extrait = "\n".join(lignes[-LIGNES_ERREUR:])[-CARACTERES_ERREUR:]
    return f"{tete} La cellule a écrit :\n{extrait}"


def empreinte(contenu: str) -> str:
    """L'empreinte tronquée d'un `authorized_keys`, telle que le relevé la rend.

    `sha256sum` d'un FICHIER produit l'empreinte de ses octets ; on reproduit
    donc exactement cela, coupé à 64 caractères comme `cut -c1-64` (§42.6).
    Comparer sans tronquer des deux côtés donnerait un écart permanent.
    """
    import hashlib

    return hashlib.sha256(contenu.encode("utf-8")).hexdigest()[:64]


def compte_rendu(avant: list[dict[str, Any]], apres: list[dict[str, Any]],
                 agis: list[str]) -> list[dict[str, Any]]:
    """Le sort de CHAQUE ligne, jamais un verdict global (§42.7).

    Une ligne qu'on n'a pas touchée le dit — « inchangé » —, et une ligne qu'on a
    touchée dit si elle a abouti. Rendre un seul « succès » global laisserait
    croire que tout a été fait alors qu'on n'a agi que sur les manques.
    """
    final = {v["key"]: v for v in apres}
    lignes: list[dict[str, Any]] = []
    for vu in avant:
        cle = vu["key"]
        arrive = final.get(cle, vu)
        if cle not in agis:
            sort = "inchangé"
        elif arrive["state"] == PRESENT:
            sort = "installé"
        else:
            sort = "échoué"
        ligne = {
            "key": cle, "label": vu["label"],
            "state": arrive["state"], "detail": arrive["detail"],
            "action": "aucune" if cle not in agis else "amorcé",
            "outcome": sort,
        }
        # Le MODE traverse le compte rendu. Il était perdu ici : les lignes sont
        # reconstruites champ par champ, et `mode` n'en faisait pas partie — le
        # relevé le portait, l'amorçage ne le rendait pas. Trouvé par le parcours
        # E2E, qu'aucun test d'unité ne pouvait attraper puisqu'ils
        # interrogeaient le relevé (§42.2 bis).
        if "mode" in arrive:
            ligne["mode"] = arrive["mode"]
        lignes.append(ligne)
    if "rootless" in agis:
        # §42.2 bis : ce n'est pas un sixième élément de la détection. C'est la
        # seule action supplémentaire rendue quand une pose rootless a été
        # interrompue après Docker CE, avant son démon utilisateur.
        docker = next((vu for vu in apres if vu["key"] == "docker"), {})
        mode = docker.get("mode")
        lignes.append({
            "key": "rootless", "label": LIBELLES["rootless"],
            "state": PRESENT if mode == ROOTLESS else DEFECT,
            "detail": "service utilisateur détecté" if mode == ROOTLESS else "absent",
            "action": "amorcé", "outcome": "installé" if mode == ROOTLESS else "échoué",
            "mode": mode,
        })
    return lignes


def message(nom: str, agis: list[str], mode: str = ENRACINE) -> str:
    """Ce que le journal lit (§42.8). Il NOMME ce qui a été installé, et le mode.

    Le mode figure même quand rien n'a été fait : c'est ce qu'on cherchera le
    jour où une pile ne démarre pas (§42.2 bis).
    """
    lisible = {ENRACINE: "enraciné", ROOTLESS: "rootless"}.get(mode, mode)
    if not agis:
        return (f"Amorçage demandé sur « {nom} » en {lisible} : rien à faire, "
                "la cellule était déjà complète.")
    quoi = ", ".join(LIBELLES.get(cle, cle) for cle in agis)
    return (f"Amorçage de « {nom} » par le plan de contrôle, en {lisible} : {quoi}.")
