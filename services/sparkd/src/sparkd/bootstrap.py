"""Amorcer un Spark : détecter d'abord, n'installer que les manques.

@spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §41 (ce que l'image ne donne pas),
      §41.2 (Docker vient du dépôt AMONT, jamais de la distribution),
      §42.1 (détecter d'abord), §42.5 (exec_capture), §42.6 (la détection,
      exactement), §42.7 (le contrat d'API), §42.8 (ce que le journal reçoit) ·
      §37.3 (le chemin `incus exec`) · §21.2 (ce qui ne traverse pas le journal) ·
      docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.3 (versions du relevé)

Le point qui décide de ce module : **détecter Docker présent ne suffit pas**. Un
`docker.io` de distribution est présent *et* inutilisable — son profil AppArmor
précède la médiation des sockets unix d'AppArmor 4, et tout ce qui appelle
`socketpair()` meurt (§41.2). La détection porte donc sur l'ORIGINE du paquet, et
un Docker de distribution est un DÉFAUT à corriger, pas un état acceptable.

Sans cela, l'amorçage déclarerait bon un Spark où aucune pile ne tournera.
"""

from __future__ import annotations

from typing import Any

#: Les trois états d'un élément (§42.7). Jamais deux : réduire à un booléen
#: rendrait le `docker.io` de distribution inexprimable.
PRESENT = "present"
ABSENT = "absent"
DEFECT = "defect"

#: Distribution de la Forge. Le dépôt amont de Docker publie par nom de version.
SUITE = "trixie"

#: Le relevé du §42.6. Une seule commande, elle n'écrit RIEN, et elle rend une
#: ligne `clé=valeur` par élément — lisible à l'œil au débogage comme au journal.
#:
#: L'empreinte des clés est TRONQUÉE à 64 caractères et ne sert qu'à comparer :
#: le §21.2 interdit qu'une clé publique entière traverse le journal.
RELEVE = r"""
sshd=$(systemctl is-active ssh 2>/dev/null || echo absent)
openssh_version=$(dpkg-query -W -f='${Version}' openssh-server 2>/dev/null || echo absent)
cles=$(sha256sum /root/.ssh/authorized_keys 2>/dev/null | cut -c1-64 || echo absent)
depot=$([ -f /etc/apt/sources.list.d/docker.list ] && echo present || echo absent)
docker=$(docker --version 2>/dev/null | head -1 || echo absent)
docker_version=$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || echo absent)
origine=$(dpkg-query -W -f='${Package}' docker-ce 2>/dev/null \
          || dpkg-query -W -f='${Package}' docker.io 2>/dev/null || echo absent)
compose=$(docker compose version 2>/dev/null | head -1 || echo absent)
compose_version=$(dpkg-query -W -f='${Version}' docker-compose-plugin 2>/dev/null || echo absent)
mode=$(systemctl is-active docker 2>/dev/null >/dev/null && echo enracine \
       || (id spark-docker >/dev/null 2>&1 && echo rootless || echo absent))
printf 'sshd=%s\nopenssh_version=%s\ncles=%s\ndepot=%s\ndocker=%s\ndocker_version=%s\norigine=%s\ncompose=%s\ncompose_version=%s\nmode=%s\n' \
  "$sshd" "$openssh_version" "$cles" "$depot" "$docker" "$docker_version" "$origine" "$compose" "$compose_version" "$mode"
"""

#: Le compte de service du mode rootless. Un nom FIXE : il sert de signal à la
#: détection, et le laisser choisir rendrait le mode illisible d'un amorçage à
#: l'autre (§42.2 bis).
COMPTE_ROOTLESS = "spark-docker"

#: Les deux modes du §42.2 bis. `None` quand Docker est absent ou vient de la
#: distribution : on n'attribue pas un mode à ce qui ne tourne pas.
ENRACINE = "enracine"
ROOTLESS = "rootless"

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
    """Enveloppe un script dans un shell de connexion.

    `bash -lc` et non `sh -c` : le `PATH` d'une cellule fraîche ne porte pas
    `/usr/sbin`, où vit `sshd`, tant qu'un shell de connexion ne l'a pas posé.
    """
    return ["bash", "-lc", script]


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


def juger(brut: dict[str, str], cles_voulues: str | None = None) -> list[dict[str, Any]]:
    """Traduit le relevé en états, dans l'ordre du §42.1.

    `cles_voulues` est l'empreinte tronquée des clés que le REGISTRE veut voir
    (§17.1). Elle est comparée, jamais affichée en entier.
    """
    vus: list[dict[str, Any]] = []

    actif = brut.get("sshd", "absent")
    vus.append({
        "key": "sshd", "label": LIBELLES["sshd"],
        "state": PRESENT if actif == "active" else ABSENT,
        "detail": actif,
    })

    empreinte = brut.get("cles", "absent")
    if empreinte == "absent":
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

    depot = brut.get("depot", "absent")
    vus.append({
        "key": "depot", "label": LIBELLES["depot"],
        "state": PRESENT if depot == "present" else ABSENT,
        "detail": "sources.list.d/docker.list" if depot == "present" else "absent",
    })

    # LE point de l'unité (§41.2) : l'origine, pas la présence.
    origine = brut.get("origine", "absent")
    version = brut.get("docker", "absent")
    if origine == "docker-ce":
        etat_docker, detail_docker = PRESENT, version
    elif origine == "docker.io":
        etat_docker = DEFECT
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
                "state": etat_docker, "detail": detail_docker, "mode": mode})

    compose = brut.get("compose", "absent")
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

APT = "export DEBIAN_FRONTEND=noninteractive\n"

SCRIPTS = {
    "sshd": APT + (
        "apt-get update -qq\n"
        "apt-get install -y -qq openssh-server ca-certificates curl\n"
        "systemctl enable --now ssh\n"
    ),
    "depot": APT + (
        "install -m 0755 -d /etc/apt/keyrings\n"
        "curl -fsSL https://download.docker.com/linux/debian/gpg "
        "-o /etc/apt/keyrings/docker.asc\n"
        "chmod a+r /etc/apt/keyrings/docker.asc\n"
        'echo "deb [arch=$(dpkg --print-architecture) '
        'signed-by=/etc/apt/keyrings/docker.asc] '
        f'https://download.docker.com/linux/debian {SUITE} stable" '
        "> /etc/apt/sources.list.d/docker.list\n"
        "apt-get update -qq\n"
    ),
    # §41.2 : `docker.io` est RETIRÉ avant d'installer `docker-ce`. Les laisser
    # cohabiter ne réparerait rien — c'est le profil AppArmor du paquet de la
    # distribution qui casse, et il resterait posé.
    "docker": APT + (
        "apt-get purge -y -qq docker.io docker-doc docker-compose podman-docker "
        "containerd runc 2>/dev/null || true\n"
        "apt-get install -y -qq docker-ce docker-ce-cli containerd.io\n"
        # Mesuré sur un Spark à 2 Gio : `dpkg` a échoué une fois en « Broken
        # pipe » au dépaquetage. `--configure -a` a suffi (AGENT_RUNBOOK §C.3).
        "dpkg --configure -a\n"
        "systemctl enable --now docker\n"
    ),
    "compose": APT + "apt-get install -y -qq docker-compose-plugin\n",
}


#: Le mode ROOTLESS (§42.2, §42.2 bis). Il s'ajoute à l'installation enracinée
#: plutôt que de la remplacer : `docker-ce` fournit le binaire et le paquet
#: `-rootless-extras` l'outil d'installation par compte.
#:
#: `enable-linger` n'est pas une précaution : sans lui, le démon du compte meurt
#: à la fin de sa session, ce qui donnerait une cellule qui marche jusqu'au
#: premier redémarrage — et cela ne se verrait qu'alors.
SCRIPT_ROOTLESS = APT + (
    # `machinectl` ne fait PAS partie de l'image Debian minimale : l'omettre
    # installe les paquets puis échoue juste avant le service utilisateur.
    "apt-get install -y -qq docker-ce-rootless-extras uidmap dbus-user-session systemd-container\n"
    f"id {COMPTE_ROOTLESS} >/dev/null 2>&1 || "
    f"useradd -m -s /bin/bash {COMPTE_ROOTLESS}\n"
    f"loginctl enable-linger {COMPTE_ROOTLESS}\n"
    # Le démon enraciné est ARRÊTÉ : deux démons sur la même cellule se
    # disputeraient le stockage et les réseaux.
    "systemctl disable --now docker.service docker.socket 2>/dev/null || true\n"
    f"machinectl shell {COMPTE_ROOTLESS}@ /usr/bin/env "
    "XDG_RUNTIME_DIR=/run/user/$(id -u %s) dockerd-rootless-setuptool.sh install\n"
    % COMPTE_ROOTLESS
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


def script_pour(cle: str, cles_publiques: str = "", rootless: bool = False) -> list[str] | None:
    """Le geste de réparation d'un élément, ou `None` s'il n'en a pas.

    Les clés font exception : elles ne s'installent pas, elles se réécrivent
    depuis le registre — et par `push_file`, pas par un script (§17.1).
    """
    if cle == "cles":
        return None
    script = SCRIPTS.get(cle)
    if script and cle == "docker" and rootless:
        script = script + SCRIPT_ROOTLESS
    return _shell(script) if script else None


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
