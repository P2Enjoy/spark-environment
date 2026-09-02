"""Le briefing lisible par un agent dans un Spark.

@spec docs/BACKLOG.md#SPK-60 · docs/DAT.md §44 (le briefing), §44.3 (ce qui ne
      doit pas y figurer), §44.4 (réécriture depuis l'état voulu), §44.5 (les
      pièges), §44.6 (donnée et non consigne), §44.8 (modèle unique) ·
      docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9 (le dossier de déploiement),
      §44.9.2 (ce qu'il porte de plus), §44.9.3 (ce qu'il ne porte jamais) ·
      docs/SCHEMA.md §10 quinquies

Le JSON est le MODELE et le Markdown une présentation de ce même modèle. Les
deux fichiers ne sont donc pas deux vérités qu'il faudrait garder en accord.

`dossier` est une TROISIEME présentation du même modèle, pour l'agent qui prépare
un déploiement depuis son poste (§44.9). Elle ne collecte aucun fait de son côté :
tout ce qu'elle écrit vient de `modele`, plus l'accès SSH que la cellule ne porte
pas et que seule la Forge connaît.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime
from typing import Any

FORMAT = "spark-briefing/v1"
WRITER = "sparkd, plan de contrôle"

FICHIER_MARKDOWN = "/etc/spark/BRIEFING.md"
FICHIER_JSON = "/etc/spark/briefing.json"
FICHIER_MOTD = "/etc/motd"
FICHIER_VARIABLES = "/etc/spark/env"
FICHIER_SECRETS = "/run/spark/secrets"
COMPTE_ROOTLESS = "spark-docker"
SOCKET_ROOTLESS = "/run/user/<uid>/docker.sock"
SOCKET_ENRACINE = "/var/run/docker.sock"

#: Le compte par lequel on entre dans une cellule. Le provisionnement du §17.3
#: pose les clés de `root`, et rien d'autre : nommer un autre compte ici
#: enverrait l'agent frapper à une porte qui n'existe pas.
COMPTE_CELLULE = "root"

#: L'alias de rebond du fragment `ssh_config` (§17.4). Il vit dans le
#: `~/.ssh/config` de l'exploitant : le plan de contrôle ne sait pas ce qu'il
#: désigne, et ne doit donc jamais prétendre le savoir.
ALIAS_REBOND = "spark-host"

#: Ce qu'une cible de rebond a le droit de contenir. Cette valeur entre dans une
#: LIGNE DE COMMANDE que quelqu'un collera dans un shell : tout ce qui n'est pas
#: un nom d'hôte, un compte ou un port y serait une injection. On refuse plutôt
#: que d'échapper — un dossier sans commande reste utilisable, une commande
#: piégée ne l'est pas.
REBOND_VALIDE = re.compile(r"^[A-Za-z0-9._~-]+(?:@[A-Za-z0-9._~-]+)?(?::[0-9]{1,5})?$")

PIEGES = (
    "Docker doit venir du dépôt amont : docker.io de la distribution échoue sous AppArmor.",
    "Un conteneur n'hérite pas du shell : attacher /etc/spark/env et /run/spark/secrets avec env_file:.",
    "/run est un tmpfs : son contenu, y compris les secrets, disparaît au redémarrage.",
    "Une route ou un port public se demande au plan de contrôle ; rien ne s'expose depuis la cellule.",
    "nproc et free décrivent la Forge : les quotas de ce briefing font foi pour cette cellule.",
)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _absent(value: str | None) -> str | None:
    """Traduit la sentinelle du relevé shell en absence JSON."""
    value = (value or "").strip()
    return None if not value or value == "absent" else value


def enregistrer_observation(connection: sqlite3.Connection, spark_id: str,
                            releve: dict[str, str], modifies: list[str]) -> dict[str, Any]:
    """Mémorise le relevé d'un amorçage, sans réécrire son auteur.

    `modifies` vient de ce passage précis de l'amorçage. Les composants déjà
    attribués à sparkd restent visibles lors d'un second passage idempotent,
    mais un composant seulement trouvé ne devient jamais « installé » après
    coup (§44.8).
    """
    ancienne = connection.execute(
        "SELECT managed_items FROM spark_bootstrap_observation WHERE spark_id = ?",
        (spark_id,)).fetchone()
    try:
        deja = set(json.loads(ancienne["managed_items"])) if ancienne else set()
    except (TypeError, json.JSONDecodeError):
        # Un registre que le produit ne sait pas relire ne mérite pas qu'on
        # invente des composants installés : on conserve seulement ce passage.
        deja = set()
    geres = sorted(deja | set(modifies))
    valeur = {
        "spark_id": spark_id,
        "observed_at": _now(),
        "openssh_version": _absent(releve.get("openssh_version")),
        "docker_version": _absent(releve.get("docker_version")),
        "compose_version": _absent(releve.get("compose_version")),
        "docker_mode": (releve.get("mode") if releve.get("mode") in
                        ("enracine", "rootless") else None),
        "managed_items": geres,
        # SPK-85 · §44.9.2 : ce que la cellule DISAIT d'elle-même ce jour-là.
        # Lisible d'ici, illisible depuis le poste qui prépare le déploiement.
        "os_id": _absent(releve.get("os_id")),
        "os_suite": _absent(releve.get("os_suite")),
        "arch": _absent(releve.get("arch")),
    }
    connection.execute(
        """INSERT INTO spark_bootstrap_observation (
               spark_id, observed_at, openssh_version, docker_version,
               compose_version, docker_mode, managed_items,
               os_id, os_suite, arch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(spark_id) DO UPDATE SET
               observed_at = excluded.observed_at,
               openssh_version = excluded.openssh_version,
               docker_version = excluded.docker_version,
               compose_version = excluded.compose_version,
               docker_mode = excluded.docker_mode,
               managed_items = excluded.managed_items,
               os_id = excluded.os_id,
               os_suite = excluded.os_suite,
               arch = excluded.arch""",
        (spark_id, valeur["observed_at"], valeur["openssh_version"],
         valeur["docker_version"], valeur["compose_version"],
         valeur["docker_mode"], json.dumps(geres, separators=(",", ":")),
         valeur["os_id"], valeur["os_suite"], valeur["arch"]),
    )
    return valeur


def observation(connection: sqlite3.Connection, spark_id: str) -> dict[str, Any] | None:
    """Rend le dernier relevé d'amorçage, ou `None` s'il n'existe pas."""
    row = connection.execute(
        "SELECT * FROM spark_bootstrap_observation WHERE spark_id = ?", (spark_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        managed = json.loads(row["managed_items"])
    except (TypeError, json.JSONDecodeError):
        managed = []
    return {
        "observed_at": row["observed_at"],
        "openssh_version": row["openssh_version"],
        "docker_version": row["docker_version"],
        "compose_version": row["compose_version"],
        "docker_mode": row["docker_mode"],
        "managed_items": sorted(str(item) for item in managed),
        # Une ligne écrite avant la migration 013 n'a jamais porté ces valeurs.
        # `None` les rend telles qu'elles sont — absentes —, et le rendu les
        # nomme « non relevé » plutôt que de les inventer (§44.9.4).
        "os_id": row["os_id"],
        "os_suite": row["os_suite"],
        "arch": row["arch"],
    }


def _cpu(spark: dict[str, Any]) -> dict[str, Any]:
    """Rend le quota CPU ET le référentiel qui lui donne un sens (§44.2)."""
    mode = spark["cpu_mode"]
    if mode in ("shared", "shared-pinned"):
        semantic = (
            "Réservation garantie sous contention ; le Spark peut dépasser ce "
            "plancher quand la Forge est libre."
        )
        value = spark["cpu_reservation"]
    elif mode == "capped":
        semantic = "Plafond CPU appliqué par le noyau."
        value = spark["cpu_max"]
    else:
        semantic = "Cœurs physiques dédiés à ce Spark."
        value = spark["cpu_cores"]
    return {"mode": mode, "value": value, "semantic": semantic}


def _systeme(bootstrap: dict[str, Any] | None) -> dict[str, str | None] | None:
    """La distribution et l'architecture relevées à l'amorçage (§44.9.2).

    `None` quand aucun amorçage n'a eu lieu, et quand un amorçage antérieur à la
    migration 013 n'a rien retenu : dans les deux cas, le produit ne SAIT pas, et
    le §14.6 du design system veut que cela se dise autrement qu'un blanc.
    """
    if not bootstrap:
        return None
    valeurs = {cle: bootstrap.get(cle) for cle in ("os_id", "os_suite", "arch")}
    if not any(valeurs.values()):
        return None
    return valeurs


def _docker(bootstrap: dict[str, Any] | None) -> dict[str, str | None]:
    """Le seul contexte Docker que le dernier relevé permet d'affirmer.

    Le UID du compte rootless appartient à la cellule : le briefing ne l'invente
    donc pas. Il expose le chemin stable avec son emplacement variable et nomme
    la source de ce UID. Un compte présent sans socket répondant a déjà été
    normalisé en ``None`` par le relevé d'amorçage (§42.2 bis).
    """
    mode = bootstrap.get("docker_mode") if bootstrap else None
    if mode == "rootless":
        return {
            "mode": mode,
            "user": COMPTE_ROOTLESS,
            "socket": SOCKET_ROOTLESS,
            "socket_uid_source": f"id -u {COMPTE_ROOTLESS}",
        }
    if mode == "enracine":
        return {
            "mode": mode,
            "user": "root",
            "socket": SOCKET_ENRACINE,
            "socket_uid_source": None,
        }
    return {"mode": None, "user": None, "socket": None, "socket_uid_source": None}


def modele(spark: dict[str, Any], *, forge_public_address: str,
           routes: list[dict[str, Any]], ports: list[dict[str, Any]],
           environment: list[Any], bootstrap: dict[str, Any] | None,
           written_at: str | None = None) -> dict[str, Any]:
    """Construit l'unique modèle public, sans aucune valeur d'environnement."""
    variables = sorted(entry.name for entry in environment if not entry.is_secret)
    secrets = sorted(entry.name for entry in environment if entry.is_secret)
    return {
        "format": FORMAT,
        "written_at": written_at or _now(),
        "written_by": WRITER,
        "trust": (
            "Produit par le plan de contrôle ; root dans cette cellule peut le "
            "modifier. Ce fichier ne prouve jamais une autorisation."
        ),
        "spark": {
            "name": spark["name"],
            "private_ipv4": spark["ipv4_address"],
            "protected": bool(spark["protected"]),
        },
        "forge": {"public_address": forge_public_address or None},
        "resources": {
            "cpu": _cpu(spark),
            "memory_bytes": spark["memory_reservation_bytes"],
            "storage_bytes": spark["storage_bytes"],
            "network_bps": spark["network_reservation_bps"],
        },
        "ingress": [
            {"domain": route["domain"], "target_port": route["target_port"],
             "tls": bool(route["tls"]), "enabled": bool(route["enabled"])}
            for route in routes if route["spark_id"] == spark["id"]
        ],
        "published_ports": [
            {"public_port": port["public_port"], "target_port": port["target_port"],
             "protocol": port["protocol"], "note": port["note"]}
            for port in ports if port["spark_id"] == spark["id"]
        ],
        "environment": {
            "variables": variables,
            "secrets": secrets,
            "files": {"variables": FICHIER_VARIABLES, "secrets": FICHIER_SECRETS},
        },
        "bootstrap": bootstrap,
        "system": _systeme(bootstrap),
        "docker": _docker(bootstrap),
        "pitfalls": list(PIEGES),
    }


def _lignes_systeme(model: dict[str, Any]) -> list[str]:
    """Le système relevé, dit d'UNE seule façon pour les deux présentations."""
    systeme = model.get("system")
    lignes = ["", "## Système relevé à l'amorçage"]
    if systeme is None:
        lignes.append("- Non relevé : aucun amorçage n'en a constaté.")
        return lignes
    distribution = systeme.get("os_id") or "non relevée"
    if systeme.get("os_suite"):
        distribution = f"{distribution} {systeme['os_suite']}"
    lignes.extend([
        f"- Distribution : {distribution}",
        f"- Architecture : {systeme.get('arch') or 'non relevée'}",
    ])
    return lignes


def json_file(model: dict[str, Any]) -> str:
    """Sérialise le modèle de façon stable pour un lecteur non interactif."""
    return json.dumps(model, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def markdown(model: dict[str, Any]) -> str:
    """Présente TOUS les faits du modèle, sans en rajouter ni en retirer."""
    spark = model["spark"]
    bootstrap = model["bootstrap"]
    docker = model["docker"]
    resource = model["resources"]
    forge = model["forge"]["public_address"] or "inconnue du plan de contrôle"
    lines = [
        f"# Briefing du Spark {spark['name']}",
        "",
        f"Écrit le : {model['written_at']}",
        f"Auteur : {model['written_by']}",
        f"Confiance : {model['trust']}",
        "",
        "## Identité et accès",
        f"- IPv4 privée : {spark['private_ipv4']}",
        f"- Adresse publique de la Forge : {forge}",
        f"- Protection : {'armée' if spark['protected'] else 'non armée'}",
        "",
        "## Quotas qui font foi",
        f"- CPU ({resource['cpu']['mode']}) : {resource['cpu']['value']} — {resource['cpu']['semantic']}",
        f"- Mémoire : {resource['memory_bytes']} octets",
        f"- Disque : {resource['storage_bytes']} octets",
        f"- Réseau : {resource['network_bps']} bit/s",
        "",
        "## Ingress",
    ]
    if model["ingress"]:
        lines.extend(
            f"- {route['domain']} → {route['target_port']} ({'TLS' if route['tls'] else 'sans TLS'}, {'active' if route['enabled'] else 'désactivée'})"
            for route in model["ingress"]
        )
    else:
        lines.append("- Aucune route déclarée.")
    lines.extend(["", "## Ports publiés"])
    if model["published_ports"]:
        lines.extend(
            f"- {port['protocol']} {port['public_port']} → {port['target_port']}" +
            (f" — {port['note']}" if port["note"] else "")
            for port in model["published_ports"]
        )
    else:
        lines.append("- Aucun port publié.")
    env = model["environment"]
    lines.extend([
        "", "## Environnement injecté",
        f"- Variables ordinaires ({env['files']['variables']}) : " +
        (", ".join(env["variables"]) or "aucune"),
        f"- Secrets ({env['files']['secrets']}) : " +
        (", ".join(env["secrets"]) or "aucun"),
        "- Les valeurs ne sont pas recopiées ici.",
    ])
    lines.extend(_lignes_systeme(model))
    lines.extend(["", "## Contexte Docker relevé"])
    if docker["mode"] is None:
        lines.append("- Docker n'a pas été relevé comme utilisable.")
    elif docker["mode"] == "rootless":
        lines.extend([
            "- Mode : rootless",
            f"- Compte : {docker['user']}",
            f"- Socket : {docker['socket']} (<uid> = {docker['socket_uid_source']})",
        ])
    else:
        lines.extend([
            "- Mode : enraciné",
            f"- Compte : {docker['user']}",
            f"- Socket : {docker['socket']}",
        ])
    lines.extend([
        "",
        "## Amorçage relevé",
    ])
    if bootstrap is None:
        lines.append("- Amorçage jamais relevé : aucune version n'est prétendue fraîche.")
    else:
        lines.extend([
            f"- Observé le : {bootstrap['observed_at']}",
            f"- openssh-server : {bootstrap['openssh_version'] or 'absent'}",
            f"- docker-ce : {bootstrap['docker_version'] or 'absent'}",
            f"- docker-compose-plugin : {bootstrap['compose_version'] or 'absent'}",
            f"- Mode Docker : {bootstrap['docker_mode'] or 'absent'}",
            "- Modifiés par sparkd : " +
            (", ".join(bootstrap["managed_items"]) or "aucun lors des relevés connus"),
            "- Pour les autres paquets : dpkg-query -W",
        ])
    lines.extend(["", "## Pièges connus"])
    lines.extend(f"- {pitfall}" for pitfall in model["pitfalls"])
    return "\n".join(lines) + "\n"



def _octets(valeur: int | None) -> str:
    """Une taille qualifiée par son unité ET par sa valeur exacte (§1.5 bis).

    L'unité lisible sert à dimensionner ; les octets servent à écrire une
    configuration. Ne rendre que les seconds obligerait à compter les
    puissances de deux, ne rendre que la première ferait perdre l'exactitude.
    """
    if valeur is None:
        return "non défini"
    for seuil, unite in ((1024 ** 3, "Gio"), (1024 ** 2, "Mio"), (1024, "Kio")):
        if valeur >= seuil:
            quotient = valeur / seuil
            rendu = (f"{quotient:.0f}" if quotient == int(quotient)
                     else f"{quotient:.2f}".rstrip("0").rstrip("."))
            return f"{rendu} {unite} ({valeur} octets)"
    return f"{valeur} octets"


def _debit(valeur: int | None) -> str:
    """Un débit dit dans l'unité où il se commande, et en bits par seconde."""
    if valeur is None:
        return "non défini"
    if valeur >= 1_000_000:
        quotient = valeur / 1_000_000
        rendu = (f"{quotient:.0f}" if quotient == int(quotient)
                 else f"{quotient:.2f}".rstrip("0").rstrip("."))
        return f"{rendu} Mbit/s ({valeur} bit/s)"
    return f"{valeur} bit/s"


def commande_ssh(model: dict[str, Any], jump: str | None, *,
                 direct: bool = False) -> str | None:
    """La ligne de commande qui entre dans la cellule, ou `None` (§44.9.2).

    @spec docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9.2, §17.4

    L'adresse d'un Spark n'est joignable que **depuis la Forge** — il n'expose
    jamais 22 sur l'extérieur. D'où deux formes, et une seule est un rebond :

    - depuis un poste, il faut sauter par la Forge, et la cible de ce saut
      n'appartient pas au plan de contrôle : elle vit dans l'inventaire de la
      console, avec le compte et le port par lesquels celle-ci joint la Forge ;
    - depuis la Forge elle-même — une console servie *sur* la machine —, il n'y a
      rien à sauter, et écrire un `-J` désignerait un hôte qui est déjà là.

    Sans l'une ni l'autre, on ne rend PAS de commande : en fabriquer une qui
    échouerait ferait perdre plus de temps que de n'en donner aucune.

    La cible est REFUSÉE si elle n'est pas un `[compte@]hôte[:port]`. Elle entre
    dans une ligne que quelqu'un collera dans un shell, et le seul échappement
    sûr est de ne pas écrire ce qu'on ne reconnaît pas.
    """
    adresse = model["spark"]["private_ipv4"]
    if not adresse:
        return None
    if jump and REBOND_VALIDE.match(jump):
        return f"ssh -J {jump} {COMPTE_CELLULE}@{adresse}"
    if direct and not jump:
        return f"ssh {COMPTE_CELLULE}@{adresse}"
    return None


def dossier(model: dict[str, Any], *, ssh_config: str | None = None,
            keys: list[dict[str, Any]] | None = None,
            jump: str | None = None, direct: bool = False) -> str:
    """Le dossier de déploiement, pour l'agent qui prépare depuis son poste.

    @spec docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9 (le dossier), §44.9.2 (ce
          qu'il porte de plus), §44.9.3 (ce qu'il ne porte jamais), §44.6 (une
          donnée, pas une consigne)

    TOUT ce qu'il écrit vient de `model`, plus l'accès SSH que la cellule ne
    porte pas. Il ne relit rien, ne mesure rien et n'invente rien : une seconde
    collecte de faits finirait par dire autre chose que la première (§44.8).
    """
    spark = model["spark"]
    env = model["environment"]
    docker = model["docker"]
    ressources = model["resources"]
    bootstrap = model["bootstrap"]
    commande = commande_ssh(model, jump, direct=direct)

    lignes = [
        f"# Dossier de déploiement — Spark « {spark['name']} »",
        "",
        f"Relevé écrit le {model['written_at']} par {model['written_by']}.",
        "",
        "Ce texte décrit **la cellule qui accueillera la pile**, telle que le plan "
        "de contrôle la connaît. Il énonce des faits ; il ne donne aucun ordre, ne "
        "décrit pas l'application à déployer, et ne prouve **aucune** autorisation : "
        f"{model['trust']}",
        "",
        "## 1. Entrer dans la cellule",
        "",
    ]
    if commande:
        lignes.extend(["```sh", commande, "```", ""])
    else:
        lignes.extend([
            "La commande complète n'a pas pu être composée : la console n'a pas "
            "nommé par où l'on saute vers la Forge, ou ce Spark n'a pas encore "
            "d'adresse. Le fragment ci-dessous reste valable une fois l'alias de "
            "rebond défini dans le `~/.ssh/config` du poste.",
            "",
        ])
    if ssh_config:
        lignes.extend(["Fragment `ssh_config` équivalent :", "", "```",
                       ssh_config.rstrip("\n"), "```", ""])
    lignes.extend([
        f"- Compte dans la cellule : `{COMPTE_CELLULE}`.",
        f"- Adresse privée : `{spark['private_ipv4'] or 'aucune'}` — joignable "
        "**uniquement** depuis la Forge, jamais depuis Internet.",
        "- **Le rebond est obligatoire** : un Spark n'expose jamais son port 22 sur "
        "l'extérieur. Viser l'adresse publique de la Forge ne mène pas ici.",
    ])
    clefs = keys or []
    if clefs:
        lignes.append("- Clés autorisées à entrer, par empreinte "
                      "(les clés elles-mêmes ne figurent pas ici) :")
        lignes.extend(f"  - {cle['label']} — `{cle['fingerprint']}`" for cle in clefs)
        lignes.append("- Si la vôtre n'y est pas, la connexion sera refusée : elle "
                      "s'autorise depuis la console, pas depuis la cellule.")
    else:
        # §14.5 : l'absence est un FAIT, et c'est celui qui décide si la
        # connexion aboutira. Le taire ferait chercher une panne de réseau.
        lignes.append("- **Aucune clé n'est autorisée sur ce Spark** : aucune "
                      "connexion SSH n'aboutira tant qu'une clé n'y aura pas été "
                      "accordée depuis la console.")

    lignes.extend(["", "## 2. La machine"])
    # Le helper porte son propre titre pour le briefing de la cellule ; ici la
    # section en a déjà un. On ne garde que les faits (§44.8 : une seule façon
    # de les dire, deux façons de les titrer).
    lignes.extend(_lignes_systeme(model)[2:])
    lignes.extend([
        f"- CPU ({ressources['cpu']['mode']}) : {ressources['cpu']['value']} — "
        f"{ressources['cpu']['semantic']}",
        f"- Mémoire : {_octets(ressources['memory_bytes'])}",
        f"- Disque : {_octets(ressources['storage_bytes'])}",
        f"- Réseau : {_debit(ressources['network_bps'])}",
        "- `nproc` et `free` décrivent la **Forge**, pas cette cellule : les quotas "
        "ci-dessus font foi.",
        "",
        "## 3. Le moteur Docker",
    ])
    if docker["mode"] is None:
        lignes.append("- Aucun Docker utilisable n'a été relevé. Une pile Compose "
                      "n'y démarrera pas en l'état.")
    else:
        lignes.extend([
            f"- Mode : {'rootless' if docker['mode'] == 'rootless' else 'enraciné'}",
            f"- Compte : `{docker['user']}`",
            f"- Socket : `{docker['socket']}`" + (
                f" — `<uid>` s'obtient par `{docker['socket_uid_source']}`"
                if docker["socket_uid_source"] else ""),
        ])
        if docker["mode"] == "rootless":
            lignes.append("- En rootless, **aucun port sous 1024** ne se publie "
                          "dans la cellule.")
    if bootstrap:
        lignes.extend([
            f"- Versions relevées le {bootstrap['observed_at']} : "
            f"openssh-server {bootstrap['openssh_version'] or 'absent'}, "
            f"docker-ce {bootstrap['docker_version'] or 'absent'}, "
            f"docker-compose-plugin {bootstrap['compose_version'] or 'absent'}.",
        ])
    else:
        lignes.append("- Amorçage jamais relevé : aucune version n'est prétendue "
                      "fraîche, et rien ne garantit que Docker soit présent.")

    lignes.extend([
        "",
        "## 4. Ce que la pile recevra",
        "",
        f"- Variables ordinaires, dans `{env['files']['variables']}` : "
        + (", ".join(f"`{nom}`" for nom in env["variables"]) or "aucune"),
        f"- Secrets, dans `{env['files']['secrets']}` : "
        + (", ".join(f"`{nom}`" for nom in env["secrets"]) or "aucun"),
        "- **Les valeurs ne sont pas dans ce texte** et n'ont pas à y être : la pile "
        "les lit dans ces deux fichiers, au démarrage.",
        "- Les deux fichiers sont posés par le plan de contrôle. Poser une variable "
        "ne redémarre rien : la pile lira la nouvelle valeur au démarrage suivant.",
        "",
        "## 5. Le contrat que le `docker-compose.yml` doit respecter",
        "",
        "Ce ne sont pas des suggestions : ce sont les seules lignes que cette "
        "cellule impose, et que rien d'autre ne peut vous apprendre.",
        "",
        "```yaml",
        "services:",
        "  <votre service>:",
        "    env_file:",
        f"      - {env['files']['variables']}",
        f"      - {env['files']['secrets']}",
        "```",
        "",
        "Sans ces deux lignes, **aucune** variable injectée n'atteint le conteneur : "
        "un conteneur n'hérite pas de l'environnement de la cellule.",
        "",
    ])
    if model["ingress"]:
        lignes.append("Ports que la pile doit **écouter dans la cellule**, parce "
                      "qu'une route publique les vise déjà :")
        lignes.extend(
            f"- `{route['domain']}` ({'TLS' if route['tls'] else 'sans TLS'}, "
            f"{'active' if route['enabled'] else 'désactivée'}) → la pile doit "
            f"écouter sur **{route['target_port']}**"
            for route in model["ingress"])
        lignes.append("")
    else:
        lignes.extend(["Aucune route publique ne vise ce Spark : rien n'impose de "
                       "port d'écoute, et rien n'est servi sur un domaine.", ""])
    if model["published_ports"]:
        lignes.append("Ports publiés sur la Forge, en plus des routes :")
        lignes.extend(
            f"- {port['protocol']} **{port['public_port']}** sur la Forge → "
            f"{port['target_port']} dans la cellule"
            + (f" — {port['note']}" if port["note"] else "")
            for port in model["published_ports"])
        lignes.append("")
    lignes.extend([
        "**Rien ne s'expose depuis l'intérieur.** Une route publique et un port "
        "publié se déclarent au plan de contrôle, injoignable depuis la cellule : "
        "il faut les DEMANDER, on ne peut pas les poser soi-même.",
        "",
        "## 6. Pièges connus",
        "",
    ])
    lignes.extend(f"- {piege}" for piege in model["pitfalls"])
    lignes.extend([
        "",
        "## 7. Ce que ce dossier ne contient pas",
        "",
        "- **Aucune valeur de secret, aucune clé privée.** Elles ne traversent "
        "jamais ce texte, quel qu'en soit le destinataire.",
        "- **Aucune liste de paquets prétendue à jour** : les versions ci-dessus sont "
        "celles du dernier amorçage, à sa date. Pour l'état frais, exécuter la "
        "commande dans la cellule — `dpkg-query -W`, `docker ps`, `df -h`.",
        "- **Rien des autres Sparks**, ni de l'intérieur de la Forge.",
    ])
    return "\n".join(lignes) + "\n"


def motd(model: dict[str, Any]) -> str:
    """Le panneau indicateur à trois lignes, pas un second briefing."""
    return "\n".join((
        f"Spark : {model['spark']['name']}",
        f"Protection : {'armée' if model['spark']['protected'] else 'non armée'}",
        f"Briefing : {FICHIER_MARKDOWN}",
        "",
    ))


def fichiers(model: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """Les trois projections et leurs permissions explicites (§44.8)."""
    return {
        FICHIER_JSON: (json_file(model), "0600"),
        FICHIER_MARKDOWN: (markdown(model), "0600"),
        FICHIER_MOTD: (motd(model), "0644"),
    }
