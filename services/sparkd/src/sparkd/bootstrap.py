"""Amorcer un Spark : détecter d'abord, n'installer que les manques.

@spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §41 (ce que l'image ne donne pas),
      §41.2 (Docker vient du dépôt AMONT, jamais de la distribution),
      §42.1 (détecter d'abord), §42.5 (exec_capture), §42.6 (la détection,
      exactement), §42.7 (le contrat d'API), §42.8 (ce que le journal reçoit) ·
      §37.3 (le chemin `incus exec`) · §21.2 (ce qui ne traverse pas le journal)

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
cles=$(sha256sum /root/.ssh/authorized_keys 2>/dev/null | cut -c1-64 || echo absent)
depot=$([ -f /etc/apt/sources.list.d/docker.list ] && echo present || echo absent)
docker=$(docker --version 2>/dev/null | head -1 || echo absent)
origine=$(dpkg-query -W -f='${Package}' docker-ce 2>/dev/null \
          || dpkg-query -W -f='${Package}' docker.io 2>/dev/null || echo absent)
compose=$(docker compose version 2>/dev/null | head -1 || echo absent)
printf 'sshd=%s\ncles=%s\ndepot=%s\ndocker=%s\norigine=%s\ncompose=%s\n' \
  "$sshd" "$cles" "$depot" "$docker" "$origine" "$compose"
"""

#: L'ordre compte : le dépôt avant Docker, Docker avant Compose.
ELEMENTS = ("sshd", "cles", "depot", "docker", "compose")

LIBELLES = {
    "sshd": "serveur SSH",
    "cles": "clés d'accès",
    "depot": "dépôt Docker amont",
    "docker": "moteur Docker",
    "compose": "greffon Compose",
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
    vus.append({"key": "docker", "label": LIBELLES["docker"],
                "state": etat_docker, "detail": detail_docker})

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


def script_pour(cle: str, cles_publiques: str = "") -> list[str] | None:
    """Le geste de réparation d'un élément, ou `None` s'il n'en a pas.

    Les clés font exception : elles ne s'installent pas, elles se réécrivent
    depuis le registre — et par `push_file`, pas par un script (§17.1).
    """
    if cle == "cles":
        return None
    script = SCRIPTS.get(cle)
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
        lignes.append({
            "key": cle, "label": vu["label"],
            "state": arrive["state"], "detail": arrive["detail"],
            "action": "aucune" if cle not in agis else "amorcé",
            "outcome": sort,
        })
    return lignes


def message(nom: str, agis: list[str]) -> str:
    """Ce que le journal lit (§42.8). Il NOMME ce qui a été installé."""
    if not agis:
        return (f"Amorçage demandé sur « {nom} » : rien à faire, "
                "la cellule était déjà complète.")
    quoi = ", ".join(LIBELLES.get(cle, cle) for cle in agis)
    return (f"Amorçage de « {nom} » par le plan de contrôle : {quoi}.")
