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

from . import familles
from .familles import CLES, COMPOSE, DEPOT, DOCKER, SSHD  # noqa: F401

#: Les trois états d'un élément (§42.7). Jamais deux : réduire à un booléen
#: rendrait le `docker.io` de distribution inexprimable.
PRESENT = "present"
ABSENT = "absent"
DEFECT = "defect"

#: SPK-98 · §42.11 : la table des familles a remplacé ces deux constantes. Elles
#: disaient « une seule doctrine, `apt` », ce qui a cessé d'être vrai le
#: 2026-09-08 : cinq familles sont servies, et trois d'entre elles n'ont pas de
#: dépôt Docker amont. Les distributions que Docker publie sont désormais un
#: champ de `familles.Famille`, lu depuis la cellule et non récité ici.
#:
#: `FAMILLE_APT` survit comme NOM de la famille historique, parce que le briefing
#: et les tests la nomment. Elle n'est plus « la » famille servie.
FAMILLE_APT = familles.FAMILLES["apt"].cle

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
#: SPK-94 · §42.2 ter — le relevé rend aussi l'identité NUMÉRIQUE du compte
#: rootless, et SEULEMENT quand le mode conclu est `rootless`. `useradd` ne
#: garantit aucun UID particulier, et c'est cette identité qui décide à qui les
#: fichiers d'environnement et le briefing sont ouverts. La lier au MODE plutôt
#: qu'à l'existence du compte applique le §42.2 bis : un compte présent sans
#: démon utilisable ne donne pas plus d'identité qu'il ne donne de mode.
#:
#: SPK-94 · §42.2 quater — et il constate si la distribution garde des scripts
#: `/etc/update-motd.d` actifs. Ce sont EUX, et non `/etc/motd`, qui écrivent le
#: bandeau « Welcome to Ubuntu… » : `pam_motd` les exécute AVANT le panneau du
#: §44.1, qui arrivait donc sous une dizaine de lignes que personne ne lit.
RELEVE = r"""
os_id=$(. /etc/os-release 2>/dev/null && echo "$ID")
os_suite=$(. /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME")
os_like=$(. /etc/os-release 2>/dev/null && echo "$ID_LIKE")
os_suite_amont=$(. /etc/os-release 2>/dev/null && echo "${DEBIAN_CODENAME:-$UBUNTU_CODENAME}")
[ -n "$os_suite_amont" ] || os_suite_amont=absent
arch=$(uname -m 2>/dev/null)
[ -n "$arch" ] || arch=absent
sshd=absent
for unite in ssh sshd; do
  etat=$(systemctl is-active "$unite" 2>/dev/null)
  if [ "$etat" = active ]; then sshd=active; break; fi
done
if [ "$sshd" != active ] && command -v rc-service >/dev/null 2>&1; then
  rc-service sshd status >/dev/null 2>&1 && sshd=active
fi
openssh_version=$(dpkg-query -W -f='${Version}' openssh-server 2>/dev/null \
                  || rpm -q --qf '%{VERSION}-%{RELEASE}' openssh-server 2>/dev/null \
                  || apk info -v openssh 2>/dev/null | head -1)
[ -n "$openssh_version" ] || openssh_version=absent
cles=$(sha256sum /root/.ssh/authorized_keys 2>/dev/null | cut -c1-64)
[ -n "$cles" ] || cles=absent
cles_rootless=$(sha256sum /home/spark-docker/.ssh/authorized_keys 2>/dev/null | cut -c1-64)
[ -n "$cles_rootless" ] || cles_rootless=absent
depot_ligne=$(grep -h '^deb' /etc/apt/sources.list.d/docker.list 2>/dev/null | head -1)
depot_distro=$(printf '%s' "$depot_ligne" | sed -n 's|.*download\.docker\.com/linux/\([a-z][a-z]*\).*|\1|p')
depot_suite=$(printf '%s' "$depot_ligne" | sed -n 's|.*download\.docker\.com/linux/[a-z][a-z]* \([^ ][^ ]*\).*|\1|p')
if [ -z "$depot_distro" ] && [ -f /etc/yum.repos.d/docker-ce.repo ]; then
  depot_distro=$(sed -n 's|.*download\.docker\.com/linux/\([a-z][a-z]*\)/.*|\1|p' \
                 /etc/yum.repos.d/docker-ce.repo | head -1)
fi
docker=$(docker --version 2>/dev/null | head -1)
[ -n "$docker" ] || docker=absent
docker_version=$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null \
                 || rpm -q --qf '%{VERSION}-%{RELEASE}' docker-ce 2>/dev/null)
[ -n "$docker_version" ] || docker_version=absent
origine=$(dpkg-query -W -f='${Package}' docker-ce 2>/dev/null \
          || rpm -q --qf 'docker-ce' docker-ce 2>/dev/null \
          || dpkg-query -W -f='${Package}' docker.io 2>/dev/null)
[ -n "$origine" ] || origine=absent
compose=$(docker compose version 2>/dev/null | head -1)
[ -n "$compose" ] || compose=absent
compose_version=$(dpkg-query -W -f='${Version}' docker-compose-plugin 2>/dev/null \
                  || rpm -q --qf '%{VERSION}-%{RELEASE}' docker-compose-plugin 2>/dev/null)
[ -n "$compose_version" ] || compose_version=absent
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
rootless_uid=absent
rootless_gid=absent
if [ "$mode" = rootless ]; then
  rootless_uid=$(id -u spark-docker 2>/dev/null)
  rootless_gid=$(id -g spark-docker 2>/dev/null)
  [ -n "$rootless_uid" ] || rootless_uid=absent
  [ -n "$rootless_gid" ] || rootless_gid=absent
fi
motd_distro=absent
if [ -d /etc/update-motd.d ]; then
  for script in /etc/update-motd.d/*; do
    if [ -f "$script" ] && [ -x "$script" ]; then motd_distro=present; break; fi
  done
fi
printf 'os_id=%s\nos_suite=%s\nos_suite_amont=%s\nos_like=%s\narch=%s\nsshd=%s\nopenssh_version=%s\ncles=%s\ncles_rootless=%s\ndepot_distro=%s\ndepot_suite=%s\ndocker=%s\ndocker_version=%s\norigine=%s\ncompose=%s\ncompose_version=%s\nmode=%s\nrootless_uid=%s\nrootless_gid=%s\nmotd_distro=%s\n' \
  "$os_id" "$os_suite" "$os_suite_amont" "$os_like" "$arch" \
  "$sshd" "$openssh_version" "$cles" "$cles_rootless" "$depot_distro" "$depot_suite" \
  "$docker" "$docker_version" "$origine" "$compose" "$compose_version" "$mode" \
  "$rootless_uid" "$rootless_gid" "$motd_distro"
"""

#: Le compte de service du mode rootless. Un nom FIXE : il sert de signal à la
#: détection, et le laisser choisir rendrait le mode illisible d'un amorçage à
#: l'autre (§42.2 bis).
COMPTE_ROOTLESS = "spark-docker"

#: SPK-95 · §42.2 quater : la SECONDE porte. Root reste la porte administrative
#: et le défaut ; celle-ci n'est offerte que lorsque le relevé dit `rootless`.
#:
#: Le fichier reste écrit par `root` : le §17.1 veut un seul écrivain, et un
#: compte qui pourrait réécrire ses propres clés sortirait du registre.
FOYER_ROOTLESS = f"/home/{COMPTE_ROOTLESS}"
DOSSIER_SSH_ROOTLESS = f"{FOYER_ROOTLESS}/.ssh"
AUTHORIZED_KEYS_ROOTLESS = f"{DOSSIER_SSH_ROOTLESS}/authorized_keys"

#: SPK-95 · §42.2 quater : les deux chemins que la seconde porte doit OUVRIR au
#: compte, mesuré le 2026-09-07 sur la Forge de test. `sshd` lit
#: `authorized_keys` APRÈS avoir pris les droits du compte visé : posé
#: `0600 root:root` par `push_file`, il lui est illisible et la porte ne s'ouvre
#: jamais — « Permission denied (publickey) », sans autre explication côté
#: client. Le dossier compte autant que le fichier : sans bit `x` pour le
#: groupe, `sshd` ne le traverse pas.
#:
#: Root garde la propriété — c'est ce qui empêche le compte de service de se
#: réécrire ses propres accès — et le groupe n'obtient que la lecture.
CHEMINS_SECONDE_PORTE = ((DOSSIER_SSH_ROOTLESS,), (AUTHORIZED_KEYS_ROOTLESS,))

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
#:
#: SPK-98 · §42.12 : c'est l'ordre COMPLET, celui d'une famille qui reçoit tout.
#: Ce qu'une cellule reçoit vraiment se lit dans `elements_de()`, qui la borne à
#: sa famille. Garder la liste complète ici sert aux appelants qui parlent de
#: l'ordre — jamais à décider ce qu'une cellule doit avoir.
ELEMENTS = familles.AVEC_DOCKER

LIBELLES = {
    "sshd": "serveur SSH",
    "cles": "clés d'accès",
    "depot": "dépôt Docker amont",
    "docker": "moteur Docker",
    "compose": "greffon Compose",
    # Ne figure pas dans le relevé ordinaire : cette ligne n'apparaît que dans
    # le compte rendu d'une reprise rootless interrompue (§42.2 bis).
    "rootless": "démon Docker rootless",
    # Même statut : pas un sixième élément de la détection, une action de plus
    # rendue quand le bandeau de la distribution a été tu (§42.2 quater).
    #
    # La ligne nomme le PANNEAU du produit, pas le bandeau qu'on retire, et ce
    # n'est pas un choix de style : les cinq éléments emploient `present` pour
    # « c'est bon ». Nommer le bandeau aurait rendu la seule ligne où `absent`
    # est le succès, et l'écran aurait affiché « absent » à côté d'« installé ».
    "motd": "panneau d'accueil du Spark",
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


def _vue_brute(brut: dict[str, str]) -> dict[str, str]:
    """L'identité SANS les capacités.

    Elle existe pour une raison précise : `identite` a besoin de savoir si le
    dépôt Docker résout, et `cible_apt` a besoin de l'identité. Les faire
    s'appeler l'une l'autre les ferait tourner en rond — mesuré, et sans appel.
    Ce bloc-ci ne dépend de rien d'autre que du relevé.
    """
    os_id = brut.get("os_id", "").strip().lower()
    suite = brut.get("os_suite", "").strip().lower()
    parents = [m.strip().lower() for m in brut.get("os_like", "").split() if m.strip()]
    famille = familles.de_identite(os_id, tuple(parents))
    return {
        "id": os_id, "suite": suite, "like": " ".join(parents),
        "family": famille.cle if famille else None,
    }


def identite(brut: dict[str, str]) -> dict[str, str]:
    """Ce que la cellule dit d'elle-même, normalisé (§42.9.1).

    @spec docs/BACKLOG.md#SPK-98 · docs/DAT.md §42.11

    Rendre un dictionnaire plutôt qu'un tuple : ce bloc voyage jusqu'à l'API
    (§42.7) et se lit à l'écran. `family` vaut `None` tant qu'on ne sait pas —
    « pas relevé » n'est pas « pas servi ».

    SPK-98 : `family` ne vaut plus « `apt` ou l'`ID` brut ». Elle nomme la
    doctrine qui sert cette cellule — `apt`, `apk`, `dnf`, `zypper`, `pacman` —
    ou `None` quand aucune ne la sert. Rendre l'`ID` comme s'il était une famille
    laissait croire à une doctrine « alpine » qui n'existait pas.
    """
    vue = dict(_vue_brute(brut))
    famille = famille_de(brut)
    # §42.12 : ce que le produit sait faire de cette cellule. Il voyage avec
    # l'identité parce qu'il en découle entièrement, et que les deux se lisent
    # ensemble à l'écran comme dans un dossier de déploiement.
    vue["capabilities"] = familles.capacites(
        famille, vue["id"], tuple(vue["like"].split()))
    # SPK-98 · §42.9.2 bis : appartenir à une famille qui a Docker ne suffit pas
    # — encore faut-il qu'un dépôt réponde POUR CETTE CELLULE. Kali est une
    # `apt`, et sa suite « kali-rolling » n'existe pas chez Docker. La capacité
    # se lit donc sur la résolution réelle du dépôt, sans quoi l'écran offrirait
    # un Docker que l'amorçage refuserait ensuite (§1.4 du design system).
    if vue["capabilities"]["docker"] and not _depot_resout(brut):
        vue["capabilities"]["docker"] = False
        vue["capabilities"]["compose"] = False
    return vue


def _depot_resout(brut: dict[str, str]) -> bool:
    """Un dépôt Docker amont existe-t-il POUR CETTE cellule ? (§42.9.2 bis)

    Appartenir à une famille qui a Docker ne suffit pas. Kali est une `apt`, et
    sa suite « kali-rolling » n'est publiée nulle part : lui annoncer Docker
    ferait offrir à l'écran un geste que l'amorçage refuserait ensuite, ce que le
    §1.4 du design system interdit.
    """
    try:
        cible_apt(brut)
    except OSNonServi:
        return False
    return True


def famille_de(brut: dict[str, str]) -> "familles.Famille | None":
    """La doctrine qui sert cette cellule, ou `None`. Point d'entrée unique."""
    os_id = brut.get("os_id", "").strip().lower()
    parents = tuple(m.strip().lower() for m in brut.get("os_like", "").split()
                    if m.strip())
    return familles.de_identite(os_id, parents)


def elements_de(brut: dict[str, str]) -> tuple[str, ...]:
    """Les éléments que CETTE cellule reçoit (§42.12).

    Une famille sans Docker ne rend pas `depot: absent` : elle ne rend pas de
    ligne `depot` du tout. Décrire un manque qu'aucun geste ne comblera est le
    contraire du §14.5 du design system — une absence se nomme une fois, pour ce
    qu'elle est.
    """
    famille = famille_de(brut)
    if famille is None:
        return familles.SANS_FAMILLE
    if DOCKER in famille.elements and not _depot_resout(brut):
        # Une `apt` dont le dépôt ne résout pas — Kali, Devuan — reçoit ce qu'une
        # famille sans Docker reçoit. Les éléments suivent la CAPACITÉ, pas
        # l'appartenance : c'est la cellule qui décide, pas son étiquette.
        return familles.SANS_DOCKER
    return famille.elements


def docker_servi(brut: dict[str, str]) -> bool:
    """Cette cellule peut-elle recevoir Docker du dépôt amont ? (§42.12)"""
    return DOCKER in elements_de(brut)


def servie(brut: dict[str, str]) -> bool:
    """Une doctrine existe-t-elle pour cette cellule ? (§42.9.5)

    SPK-98 : ce prédicat signifiait « famille `apt` ». Il signifie désormais
    « une doctrine existe », ce qui rend une Alpine `supported: true` — car
    l'amorçage sait quoi en faire, même sans Docker.
    """
    return famille_de(brut) is not None


def identite_rootless(brut: dict[str, str]) -> dict[str, int | None]:
    """L'identité numérique du compte rootless, telle que la cellule la donne.

    @spec docs/BACKLOG.md#SPK-94 · docs/DAT.md §42.2 ter

    Elle décide à qui les fichiers d'environnement et le briefing sont ouverts.
    Le relevé ne la rend que lorsque le mode conclu est `rootless` ; ici on se
    contente de la lire, sans jamais la déduire d'autre chose. Rendre `None` sur
    une valeur illisible plutôt que de tomber : une identité qu'on ne comprend
    pas ne doit pas décider d'un `chown`.
    """
    def entier(cle: str) -> int | None:
        valeur = (brut.get(cle) or "").strip()
        if not valeur or valeur == "absent":
            return None
        try:
            nombre = int(valeur)
        except ValueError:
            return None
        # Un UID négatif n'existe pas, et `0` serait root : ni l'un ni l'autre
        # ne désigne le compte de service. Les refuser évite d'ouvrir un fichier
        # au nom d'une identité que le relevé n'a pas vraiment lue.
        return nombre if nombre > 0 else None

    return {"uid": entier("rootless_uid"), "gid": entier("rootless_gid")}


def motd_a_taire(brut: dict[str, str]) -> bool:
    """La distribution garde-t-elle un bandeau d'accueil actif ? (§42.2 quater)"""
    return (brut.get("motd_distro") or "absent").strip() == "present"


def cible_apt(brut: dict[str, str]) -> tuple[str, str]:
    """Le dépôt amont de CETTE cellule : (distribution, suite) — §42.9.2.

    @spec docs/BACKLOG.md#SPK-76 · docs/BACKLOG.md#SPK-98 ·
          docs/DAT.md §42.9.2, §42.9.2 bis

    Remplace les constantes `linux/debian` et `trixie`. Une dérivée est servie
    par son parent quand `ID_LIKE` le nomme, ce que Docker documente lui-même.

    **SPK-98 — la suite d'une dérivée se LIT, elle ne se recopie pas.** Reprendre
    `VERSION_CODENAME` tel quel donnait `linux/debian kali-rolling`, un dépôt qui
    répond sur sa racine et n'a pas de `Release` : mesuré sur la Forge, avec un
    `supported: true` rendu juste avant. Le champ juste est `DEBIAN_CODENAME` ou
    `UBUNTU_CODENAME`, que la dérivée publie **pour cela**. Mint le publie
    (`noble`) ; Kali et Devuan ne publient rien, et là on refuse.

    **Sans suite lisible, on refuse au lieu de deviner.** Poser une suite fausse
    est précisément le défaut que cette fonction corrige : `download.docker.com`
    répondrait, `apt-get update` échouerait, et l'erreur n'apparaîtrait qu'à
    l'installation — trop tard pour être comprise.
    """
    vue = _vue_brute(brut)
    os_id = vue["id"]
    famille = famille_de(brut)
    if famille is None or not famille.depot_docker:
        nommee = os_id or "cette distribution"
        raise OSNonServi(
            f"L'amorçage ne pose pas de dépôt Docker sur « {nommee} » : Docker "
            "n'en publie aucun pour elle. La cellule reçoit tout le reste — "
            "serveur SSH, clés, variables et briefing — et reste parfaitement "
            "utilisable.")

    # La distribution est celle que Docker publie POUR cette cellule. L'`ID`
    # d'abord, parce qu'une Debian est sa propre référence ; puis `ID_LIKE`,
    # parcouru dans l'ordre de la TABLE et non dans celui du fichier — une
    # Almalinux déclare « rhel centos fedora » et c'est `centos` qui a été
    # éprouvé sur elle (§42.11).
    parents = vue["like"].split()
    # Une distribution est sa propre référence quand la famille la sert
    # NATIVEMENT. Mint figure au dictionnaire des dépôts — sa suite amont est
    # lisible — et reste pourtant une dérivée : sa propre suite, « wilma »,
    # n'existe pas chez Docker.
    derivee = os_id not in famille.os_ids
    distribution = famille.depot_docker.get(os_id)
    if distribution is None:
        distribution = next(
            (cible for lu, cible in famille.depot_docker_parents.items()
             if lu in parents), None)
    if distribution is None:
        raise OSNonServi(
            f"« {os_id or 'cette distribution'} » appartient à la famille "
            f"« {famille.cle} », mais aucun dépôt Docker amont ne lui "
            "correspond : ni son nom ni ce qu'elle déclare dans `ID_LIKE` n'est "
            "publié par Docker. Elle reçoit le serveur SSH, ses clés, ses "
            "variables et son briefing ; elle n'aura pas Docker.")

    suite = _suite_amont(brut, vue, derivee, famille)
    return distribution, suite


def _suite_amont(brut: dict[str, str], vue: dict[str, str], derivee: bool,
                 famille: "familles.Famille") -> str:
    """La suite que le dépôt amont publie pour cette cellule (§42.9.2 bis).

    Les familles RPM n'ont pas de suite : `dnf` résout `$releasever` lui-même, et
    lui en imposer une reviendrait à figer la version de la cellule dans un
    fichier de dépôt. La chaîne vide dit cela, et le script du dépôt s'en sert
    pour choisir sa forme.
    """
    if famille.paquets != "apt":
        return ""
    if not derivee:
        # Une Debian est sa propre référence : lui chercher un parent serait
        # absurde, et `VERSION_CODENAME` est exactement ce que Docker publie.
        if not vue["suite"]:
            raise OSNonServi(
                f"La cellule se déclare « {vue['id']} » mais ne nomme pas sa "
                "version (`VERSION_CODENAME` absent d'`/etc/os-release`). "
                "L'amorçage ne devine pas une suite : un dépôt Docker posé sur "
                "la mauvaise version répond quand même, et l'erreur "
                "n'apparaîtrait qu'à l'installation.")
        return vue["suite"]

    amont = (brut.get("os_suite_amont") or "").strip().lower()
    if amont and amont != "absent":
        return amont
    raise OSNonServi(
        f"« {vue['id']} » est une dérivée de « {famille.cle} », mais elle ne dit "
        "pas à quelle version amont elle correspond : ni `DEBIAN_CODENAME` ni "
        f"`UBUNTU_CODENAME` dans son `/etc/os-release`. Sa propre suite — "
        f"« {vue['suite'] or 'non nommée'} » — n'existe pas chez Docker, et la "
        "poser donnerait un dépôt qui répond sans avoir de paquets. Cette "
        "cellule reçoit le serveur SSH, ses clés, ses variables et son "
        "briefing ; elle n'aura pas Docker.")


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
    # SPK-98 · §42.12 : le relevé ne rend QUE les éléments de cette famille. Une
    # ligne « absent » sur un élément qu'aucun geste ne posera n'est pas une
    # information, c'est un manque qu'on invente.
    servis = elements_de(brut)

    if SSHD in servis:
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
    # SPK-95 · §42.2 quater : en rootless, la SECONDE porte compte autant que la
    # première. Ne juger que `/root` afficherait « clés conformes » pendant que
    # `spark-docker` est fermé ou périmé — un agent enverrait alors sa session
    # contre une porte que le produit vient de déclarer bonne. Le jugement ne
    # peut que DESCENDRE ici : une seconde porte en ordre ne rachète pas une
    # première qui ne l'est pas.
    if brut.get("mode") == ROOTLESS and etat_cles == PRESENT:
        seconde = brut.get("cles_rootless", "absent") or "absent"
        if seconde == "absent":
            etat_cles = DEFECT
            detail_cles = (
                f"posées pour root, absentes pour « {COMPTE_ROOTLESS} » : la "
                "seconde porte de ce Spark rootless n'est ouverte à personne")
        elif cles_voulues is not None and seconde != cles_voulues:
            etat_cles = DEFECT
            detail_cles = (
                f"celles de « {COMPTE_ROOTLESS} » diffèrent de ce que le "
                "registre déclare : une clé retirée peut y survivre")
    vus.append({"key": "cles", "label": LIBELLES["cles"],
                "state": etat_cles, "detail": detail_cles})

    # SPK-98 · §42.12 : une famille sans Docker ne rend AUCUNE ligne Docker. Pas
    # « absent » — ce qui décrirait un manque qu'aucun geste ne comblera —, pas
    # de ligne du tout. Le §14.5 du design system veut qu'une absence soit nommée
    # une fois, pour ce qu'elle est ; elle l'est dans le panneau d'amorçage, qui
    # dit que cette image n'a pas de dépôt amont.
    if DEPOT not in servis:
        return vus

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

#: SPK-98 · §42.11 : attendre que la cellule RÉSOLVE avant de poser quoi que ce
#: soit. Mesuré sur Arch : `pacman -Sy` lancé aussitôt après `start` rend
#: « Could not resolve host », et la même commande réussit quelques secondes plus
#: tard — `systemd-resolved` n'avait pas fini de s'établir. Rendre un échec là
#: enverrait chercher une panne de réseau qui n'existe pas.
#:
#: La sonde vise la passerelle du bridge (§10), pas un nom extérieur : on
#: constate que le résolveur RÉPOND, pas qu'Internet va bien. Vingt essais d'une
#: seconde, puis on continue quand même — un amorçage ne doit pas s'arrêter sur
#: une sonde, il doit s'arrêter sur ce qu'il n'a pas réussi à poser.
ATTENDRE_RESOLUTION = (
    "i=0\n"
    "while [ $i -lt 20 ]; do\n"
    "  getent hosts download.docker.com >/dev/null 2>&1 && break\n"
    "  getent hosts deb.debian.org >/dev/null 2>&1 && break\n"
    "  i=$((i + 1)); sleep 1\n"
    "done\n"
)

#: L'en-tête commun à toute pose. `set -e` d'abord (§42.9.7), puis l'attente.
def _prelude(famille: "familles.Famille") -> str:
    entete = "set -e\n"
    if famille.paquets == "apt":
        entete += "export DEBIAN_FRONTEND=noninteractive\n"
    return entete + ATTENDRE_RESOLUTION


#: Les commandes de chaque famille, MESURÉES le 2026-09-08 (§42.11). Deux
#: gabarits par famille : installer des paquets, activer un service. Tout le
#: reste de ce module s'écrit à partir de ces deux-là.
#:
#: `%s` porte la liste des paquets ; l'activation porte le nom du service, qui
#: diffère d'une famille à l'autre — `ssh` sur Debian, `sshd` ailleurs. Les
#: confondre laisse un `enable` sans effet et une porte fermée.
INSTALLER = {
    "apt": "apt-get update -qq\napt-get install -y -qq %s\n",
    # `-q` et non `-y -q` seul : `dnf` demande confirmation sans `-y`, et rend 1
    # sur une entrée fermée — un refus qu'on lirait comme une panne réseau.
    "dnf": "dnf install -y -q %s\n",
    # `refresh` est requis sur une image fraîche : sans lui, `install` rend 104
    # « paquet introuvable » alors que le paquet existe. Mesuré.
    "zypper": ("zypper --non-interactive refresh\n"
               "zypper --non-interactive install -y %s\n"),
    # `--needed` rend le script rejouable : sans lui, un second amorçage
    # réinstallerait ce qui est déjà là (§42.1).
    "pacman": "pacman -Sy --noconfirm --needed %s\n",
    "apk": "apk add --no-cache %s\n",
}

ACTIVER = {
    "systemd": "systemctl enable --now %s\n",
    # OpenRC : deux commandes, et l'ordre compte — `add` inscrit au niveau
    # d'exécution pour les redémarrages, `start` allume maintenant. N'en faire
    # qu'une donnerait une cellule joignable jusqu'au premier redémarrage, ce
    # qui ne se verrait qu'alors.
    "openrc": "rc-update add %s default\nrc-service %s start\n",
}


def script_ssh(famille: "familles.Famille") -> str:
    """Poser et allumer le serveur SSH de CETTE famille (§42.11).

    @spec docs/BACKLOG.md#SPK-98 · docs/DAT.md §42.11

    C'est le seul élément que toutes les familles servies reçoivent, et c'est
    l'objet de l'unité : une cellule à qui l'on pose des clés sans jamais poser
    de serveur SSH n'est pas « équipable soi-même », c'est un accès qu'on a
    préparé et qu'on n'ouvre pas.
    """
    paquets = " ".join(famille.paquets_ssh)
    activation = ACTIVER[famille.services]
    if famille.services == "openrc":
        activation = activation % (famille.service_ssh, famille.service_ssh)
    else:
        activation = activation % famille.service_ssh
    return _prelude(famille) + INSTALLER[famille.paquets] % paquets + activation


def script_depot(distribution: str, suite: str,
                 famille: "familles.Famille | None" = None) -> str:
    """Pose le dépôt amont de CETTE distribution (§42.9.2, §42.11).

    @spec docs/BACKLOG.md#SPK-76 · docs/BACKLOG.md#SPK-98 ·
          docs/DAT.md §41.2, §42.9.2, §42.9.2 ter

    C'était une constante : `linux/debian` et `trixie`, quelle que soit la
    cellule. Le fichier est RÉÉCRIT et non complété — un dépôt défectueux au sens
    du §42.9.3 doit disparaître, pas cohabiter avec le bon.

    **SPK-98 — l'élément installe ce dont il a besoin.** `curl` n'était posé
    qu'en passant, par la ligne du serveur SSH. Sur une image qui porte déjà un
    `sshd` actif — Kali, mesuré —, cette ligne ne s'exécute jamais, et le dépôt
    partait sans `curl` : l'amorçage rendait « Command not found », un refus qui
    ne nomme ni la commande, ni l'élément, ni la cause. Une dépendance obtenue
    par effet de bord n'est pas une dépendance satisfaite.
    """
    famille = famille or familles.FAMILLES["apt"]
    if famille.paquets == "dnf":
        return _depot_rpm(distribution, famille)
    return (
        _prelude(famille)
        + INSTALLER[famille.paquets] % "ca-certificates curl"
        + "install -m 0755 -d /etc/apt/keyrings\n"
        f"curl -fsSL https://download.docker.com/linux/{distribution}/gpg "
        "-o /etc/apt/keyrings/docker.asc\n"
        "chmod a+r /etc/apt/keyrings/docker.asc\n"
        'echo "deb [arch=$(dpkg --print-architecture) '
        'signed-by=/etc/apt/keyrings/docker.asc] '
        f'https://download.docker.com/linux/{distribution} {suite} stable" '
        "> /etc/apt/sources.list.d/docker.list\n"
        "apt-get update -qq\n"
    )


def _depot_rpm(distribution: str, famille: "familles.Famille") -> str:
    """Le dépôt amont d'une famille RPM (§42.11).

    **Le fichier est écrit, et non demandé à `dnf config-manager`.** Ce n'est pas
    une préférence : la sous-commande a changé de forme entre `dnf` 4 et `dnf` 5
    — `--add-repo <url>` d'un côté, `addrepo --from-repofile=<url>` de l'autre —,
    et Almalinux 9 comme Fedora 43 figurent l'une et l'autre au catalogue. Écrire
    le fichier donne le MÊME dépôt sur les deux, et rejoue la règle du §42.9.3 :
    réécrit en entier, jamais complété.

    `$releasever` n'est pas interpolé ici : c'est `dnf` qui le résout, et c'est
    exactement ce qu'on veut — une cellule ne doit pas figer sa propre version
    dans un fichier de dépôt.
    """
    base = f"https://download.docker.com/linux/{distribution}"
    return (
        _prelude(famille)
        + "cat > /etc/yum.repos.d/docker-ce.repo <<'FIN_DEPOT'\n"
        "[docker-ce-stable]\n"
        "name=Docker CE Stable\n"
        f"baseurl={base}/$releasever/$basearch/stable\n"
        "enabled=1\n"
        "gpgcheck=1\n"
        f"gpgkey={base}/gpg\n"
        "FIN_DEPOT\n"
        # `makecache` échoue si le dépôt ne répond pas : c'est le contrôle qu'on
        # veut ici, et non à l'installation du moteur, où la cause serait perdue
        # au milieu de la résolution des dépendances.
        "dnf makecache -q\n"
    )


def script_docker(purger_ce: bool = False,
                  famille: "familles.Famille | None" = None) -> str:
    """Pose `docker-ce`, en retirant d'abord ce qui l'empêcherait de servir.

    @spec docs/BACKLOG.md#SPK-76 · docs/BACKLOG.md#SPK-98 ·
          docs/DAT.md §41.2, §42.9.4, §42.9.7, §42.11

    `docker.io` est TOUJOURS purgé (§41.2) : les laisser cohabiter ne réparerait
    rien, c'est son profil AppArmor qui casse et il resterait posé.

    `purger_ce` ne se déclenche que sur le défaut du §42.9.4 — un `docker-ce`
    venu du dépôt d'une autre distribution. `apt` ne remplace pas de lui-même un
    paquet de même nom dont la version est plus haute que celle du bon dépôt.
    La purge ne touche PAS `/var/lib/docker` : les images et les volumes du
    locataire survivent, seul le démon redémarre.
    """
    famille = famille or familles.FAMILLES["apt"]
    if famille.paquets == "dnf":
        # Aucun équivalent de `docker.io` côté RPM : la distribution y publie
        # `moby-engine`, qui porte un autre nom et ne se substitue pas au paquet
        # amont. Rien à purger, donc rien qui prétende purger.
        return (
            _prelude(famille)
            + INSTALLER["dnf"] % "docker-ce docker-ce-cli containerd.io"
            + "systemctl enable --now docker\n"
        )
    purge = "docker.io docker-doc docker-compose podman-docker containerd runc"
    if purger_ce:
        purge = "docker-ce docker-ce-cli " + purge
    return _prelude(famille) + (
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


#: Taire le bandeau de la distribution (§42.2 quater).
#:
#: `pam_motd` exécute les scripts d'`/etc/update-motd.d` AVANT `/etc/motd`. Les
#: trois lignes du §44.1 — celles qui nomment le Spark et renvoient au briefing —
#: arrivaient donc sous une dizaine de lignes de documentation de la
#: distribution, ce qui explique qu'un agent qui atterrit ne comprenne pas qu'il
#: doit lire le briefing.
#:
#: On retire le bit d'exécution ; on ne SUPPRIME rien. Le geste se défait d'une
#: commande, et le §42.4 reste tenu : l'amorçage ne devient pas un gestionnaire
#: de configuration parce qu'il fait taire un bandeau devant le panneau que le
#: produit écrit déjà lui-même.
#:
#: Sans `set -e` : le dossier peut disparaître entre le relevé et la pose, et un
#: bandeau qu'on n'a pas pu taire ne justifie pas de déclarer l'amorçage en échec.
SCRIPT_MOTD = (
    "if [ -d /etc/update-motd.d ]; then\n"
    "  chmod -x /etc/update-motd.d/* 2>/dev/null || true\n"
    "fi\n"
)


def script_motd() -> list[str]:
    """Le geste qui fait taire le bandeau de la distribution (§42.2 quater)."""
    return _shell(SCRIPT_MOTD)


#: Les droits que le compte rootless doit trouver (§42.2 ter). Deux chiffres,
#: pas un : un dossier a besoin du bit `x` pour être traversé, un fichier ne doit
#: pas devenir exécutable.
MODE_DOSSIER_OUVERT = "0750"
MODE_FICHIER_OUVERT = "0640"


def script_ouverture(gid: int, dossiers: tuple[str, ...],
                     fichiers: tuple[str, ...]) -> list[str]:
    """Ouvre au groupe du compte rootless ce que sparkd vient de poser (§42.2 ter).

    @spec docs/BACKLOG.md#SPK-94 · docs/DAT.md §42.2 ter

    **Pourquoi une commande et non l'écriture de fichier elle-même.** L'API de
    fichiers d'Incus crée un dossier ; elle ne le MODIFIE pas. Le pilote avale
    d'ailleurs délibérément l'erreur « existe déjà » (§12.1.2), si bien qu'un
    `/etc/spark` déjà posé en `0700 root:root` garderait ses droits quel que
    soit l'en-tête envoyé. Poser les droits à l'écriture ne marcherait donc que
    sur une cellule vierge — c'est-à-dire jamais, puisque l'amorçage rootless
    arrive après la création.

    Chaque ligne est gardée par une existence : `/run/spark` vit sur un tmpfs
    (§43.5.2) et peut ne pas être là entre deux démarrages, et un `chgrp` sur un
    chemin absent ferait échouer une projection qui n'a rien de fautif.

    `gid` est un ENTIER relevé dans la cellule, jamais un nom : le groupe
    primaire de `spark-docker` s'appelle comme lui sur Debian, et cela n'a rien
    d'universel.
    """
    lignes = ["set -e"]
    for dossier in dossiers:
        lignes.append(
            f"if [ -d {dossier} ]; then chgrp {int(gid)} {dossier}; "
            f"chmod {MODE_DOSSIER_OUVERT} {dossier}; fi")
    for fichier in fichiers:
        lignes.append(
            f"if [ -f {fichier} ]; then chgrp {int(gid)} {fichier}; "
            f"chmod {MODE_FICHIER_OUVERT} {fichier}; fi")
    return _shell("\n".join(lignes) + "\n")


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
    brut = brut or {}
    famille = famille_de(brut)
    if famille is None:
        # §42.9.5 : aucune doctrine. Le refus est rendu en amont ; ici, on ne
        # fabrique surtout pas une commande « par défaut » qui poserait des
        # paquets Debian sur une distribution qu'on ne connaît pas.
        return None
    if cle == "cles":
        return None
    if cle == "sshd":
        return _shell(script_ssh(famille))
    if cle == "depot":
        distribution, suite = cible_apt(brut)
        return _shell(script_depot(distribution, suite, famille))
    if cle == "docker":
        script = script_docker(purger_ce, famille)
        # §42.2 : le rootless n'existe que pour la famille `apt` — c'est la seule
        # dont le contrat de reprise a été mesuré (§42.2 bis). L'ajouter ailleurs
        # poserait des paquets qui n'existent pas sous ce nom.
        if rootless and famille.paquets == "apt":
            script += SCRIPT_ROOTLESS
        return _shell(script)
    if cle == "compose":
        return _shell(_prelude(famille)
                      + INSTALLER[famille.paquets] % "docker-compose-plugin")
    return None


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
                 agis: list[str],
                 motd_present: bool | None = None) -> list[dict[str, Any]]:
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
    if "motd" in agis:
        # §42.2 quater : même statut que `rootless`. Pas un sixième élément de la
        # détection — une action de plus, rendue seulement quand elle a eu lieu.
        #
        # Le sort se lit dans le relevé qui SUIT la pose, jamais dans le fait
        # d'avoir lancé la commande : `chmod` sur un dossier en lecture seule
        # réussirait sans rien taire, et le compte rendu annoncerait un silence
        # qui n'existe pas (§1.3 du design system, appliqué au serveur).
        tu = motd_present is False
        lignes.append({
            "key": "motd", "label": LIBELLES["motd"],
            # `defect` et non `absent` : le panneau EST là — le produit l'écrit à
            # chaque projection —, il est simplement enterré. C'est exactement ce
            # que `defect` nomme depuis le §41.2 : présent et inutilisable.
            "state": PRESENT if tu else DEFECT,
            "detail": ("le bandeau de la distribution ne s'affiche plus : le "
                       "panneau du Spark arrive seul") if tu else
                      ("des scripts d'/etc/update-motd.d s'affichent encore "
                       "avant lui et l'enterrent"),
            "action": "amorcé", "outcome": "installé" if tu else "échoué",
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
