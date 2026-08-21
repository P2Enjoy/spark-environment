"""Le briefing lisible par un agent dans un Spark.

@spec docs/BACKLOG.md#SPK-60 · docs/DAT.md §44 (le briefing), §44.3 (ce qui ne
      doit pas y figurer), §44.4 (réécriture depuis l'état voulu), §44.5 (les
      pièges), §44.6 (donnée et non consigne), §44.8 (modèle unique) ·
      docs/SCHEMA.md §10 quinquies

Le JSON est le MODELE et le Markdown une présentation de ce même modèle. Les
deux fichiers ne sont donc pas deux vérités qu'il faudrait garder en accord.
"""

from __future__ import annotations

import json
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

PIEGES = (
    "Docker doit venir du dépôt amont : docker.io de la distribution échoue sous AppArmor.",
    "Un conteneur n'hérite pas du shell : attacher /etc/spark/env et /run/spark/secrets avec env_file:.",
    "/run est un tmpfs : son contenu, y compris les secrets, disparaît au redémarrage.",
    "Une route ou un port public se demande au plan de contrôle ; rien ne s'expose depuis la cellule.",
    "nproc et free décrivent la Forge : les quotas ci-dessous font foi pour cette cellule.",
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
    }
    connection.execute(
        """INSERT INTO spark_bootstrap_observation (
               spark_id, observed_at, openssh_version, docker_version,
               compose_version, docker_mode, managed_items)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(spark_id) DO UPDATE SET
               observed_at = excluded.observed_at,
               openssh_version = excluded.openssh_version,
               docker_version = excluded.docker_version,
               compose_version = excluded.compose_version,
               docker_mode = excluded.docker_mode,
               managed_items = excluded.managed_items""",
        (spark_id, valeur["observed_at"], valeur["openssh_version"],
         valeur["docker_version"], valeur["compose_version"],
         valeur["docker_mode"], json.dumps(geres, separators=(",", ":"))),
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
        "pitfalls": list(PIEGES),
    }


def json_file(model: dict[str, Any]) -> str:
    """Sérialise le modèle de façon stable pour un lecteur non interactif."""
    return json.dumps(model, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def markdown(model: dict[str, Any]) -> str:
    """Présente TOUS les faits du modèle, sans en rajouter ni en retirer."""
    spark = model["spark"]
    bootstrap = model["bootstrap"]
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
