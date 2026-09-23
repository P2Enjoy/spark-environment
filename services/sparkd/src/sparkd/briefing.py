"""Le briefing lisible par un agent dans un Spark.

@spec docs/BACKLOG.md#SPK-60 · docs/DAT.md §44 (le briefing), §44.3 (ce qui ne
      doit pas y figurer), §44.4 (réécriture depuis l'état voulu), §44.5 (les
      pièges), §44.6 (donnée et non consigne), §44.8 (modèle unique) ·
      docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9 (le dossier de déploiement),
      §44.9.2 (ce qu'il porte de plus), §44.9.3 (ce qu'il ne porte jamais) ·
      docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.7 (une variable n'entre pas par
      la cellule) · docs/BACKLOG.md#SPK-104 · docs/DAT.md §54.5 (les notes en
      entier dans le dossier, nommées dans le briefing) · docs/BACKLOG.md#SPK-105
      · docs/DAT.md §55.7 (ce que le dossier doit dire du canal `.?`, et la
      consigne d'accès unique) · docs/BACKLOG.md#SPK-107 · docs/DAT.md §55.3.3
      (le vide est une DEMANDE, et l'étiquette l'explique) · docs/SCHEMA.md §10 quinquies
@spec docs/BACKLOG.md#SPK-112 · docs/DAT.md §44.2 bis (la pile sert « en HTTP
      simple »), §55.3.1 (le dernier mot d'une route règle son côté PUBLIC)

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

from . import bootstrap
from . import notes as notes_service
from . import suggestions as suggestions_service

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

#: SPK-94 · §44.10 : un agent qui entre par la seconde porte doit pouvoir lire le
#: texte qui lui explique où il est. Le §44.3 garantit qu'aucune VALEUR
#: d'environnement n'y figure — seulement des noms —, donc l'ouverture ne
#: divulgue rien que le compte ne puisse déjà atteindre.
#:
#: `/etc/motd` n'y est pas, et c'est délibéré : il est `0644` parce qu'il est
#: fait pour être lu par tout le monde. Le restreindre à un groupe le rendrait
#: invisible au moment précis où il sert — la connexion.
DOSSIERS_OUVERTS = ("/etc/spark",)
FICHIERS_OUVERTS = (FICHIER_JSON, FICHIER_MARKDOWN)

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
    # SPK-101 · §44.2 bis : ce piège-ci, seul, a fait croire à un agent réel qu'il
    # lui fallait DEMANDER un port pour être atteint. Il est vrai et incomplet :
    # il parle de ce qu'on crée, jamais de ce qui existe déjà.
    "Une route active est déjà un chemin complet : la Forge termine le TLS et vise votre port, aucun port publié n'est requis.",
    # SPK-105 · §55 : ce piège disait vrai avant le canal `.?`. Une route se
    # PROPOSE désormais depuis la cellule ; un port publié, non — c'est une
    # ressource de la Forge, partagée entre tous les Sparks (§55.3.2).
    "Rien ne s'expose depuis la cellule : une route se PROPOSE dans /etc/spark/routes.?, un port publié se demande au propriétaire.",
    "Un port SORTANT fermé vient de l'hébergeur : le plan de contrôle ne filtre que l'entrée vers la Forge.",
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
    # SPK-94 · §42.2 ter : l'identité NUMÉRIQUE du compte rootless, telle que la
    # cellule la donne. Le relevé ne la rend que lorsque le mode est `rootless`,
    # et on ne la garde qu'à cette condition : une identité conservée après une
    # bascule ferait poser un groupe au nom d'un compte qui ne sert plus.
    identite = bootstrap.identite_rootless(releve)
    if valeur["docker_mode"] != bootstrap.ROOTLESS:
        identite = {"uid": None, "gid": None}
    valeur["docker_uid"] = identite["uid"]
    valeur["docker_gid"] = identite["gid"]
    connection.execute(
        """INSERT INTO spark_bootstrap_observation (
               spark_id, observed_at, openssh_version, docker_version,
               compose_version, docker_mode, managed_items,
               os_id, os_suite, arch, docker_uid, docker_gid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(spark_id) DO UPDATE SET
               observed_at = excluded.observed_at,
               openssh_version = excluded.openssh_version,
               docker_version = excluded.docker_version,
               compose_version = excluded.compose_version,
               docker_mode = excluded.docker_mode,
               managed_items = excluded.managed_items,
               os_id = excluded.os_id,
               os_suite = excluded.os_suite,
               arch = excluded.arch,
               docker_uid = excluded.docker_uid,
               docker_gid = excluded.docker_gid""",
        (spark_id, valeur["observed_at"], valeur["openssh_version"],
         valeur["docker_version"], valeur["compose_version"],
         valeur["docker_mode"], json.dumps(geres, separators=(",", ":")),
         valeur["os_id"], valeur["os_suite"], valeur["arch"],
         valeur["docker_uid"], valeur["docker_gid"]),
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
        # SPK-94 · §42.2 ter. `None` hors mode rootless, et sur toute ligne
        # écrite avant la migration 015 : le relevé ne se reconstitue pas.
        "docker_uid": row["docker_uid"],
        "docker_gid": row["docker_gid"],
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


def _docker(bootstrap: dict[str, Any] | None,
            servi: bool = True) -> dict[str, Any]:
    """Le seul contexte Docker que le dernier relevé permet d'affirmer.

    Le UID du compte rootless appartient à la cellule : le briefing ne l'invente
    donc pas. Il expose le chemin stable avec son emplacement variable et nomme
    la source de ce UID. Un compte présent sans socket répondant a déjà été
    normalisé en ``None`` par le relevé d'amorçage (§42.2 bis).

    SPK-98 · §42.13 : `servi` distingue « pas encore relevé » de « n'en aura
    jamais ». Les deux rendaient `mode: None`, et un agent qui lit ce fichier ne
    pouvait pas savoir s'il devait amorcer ou renoncer.
    """
    if not servi:
        return {"mode": None, "user": None, "socket": None,
                "socket_uid_source": None, "supported": False}
    mode = bootstrap.get("docker_mode") if bootstrap else None
    if mode == "rootless":
        return {
            "mode": mode,
            "user": COMPTE_ROOTLESS,
            "socket": SOCKET_ROOTLESS,
            "socket_uid_source": f"id -u {COMPTE_ROOTLESS}",
            "supported": True,
        }
    if mode == "enracine":
        return {
            "mode": mode,
            "user": "root",
            "socket": SOCKET_ENRACINE,
            "socket_uid_source": None,
            "supported": True,
        }
    return {"mode": None, "user": None, "socket": None,
            "socket_uid_source": None, "supported": True}


#: SPK-101 · §44.2 ter : en rootless, un port privilégié ne s'ouvre pas dans la
#: cellule (§42). C'est le port CIBLE qui décide — celui qu'on écoute ici —,
#: jamais le port public : la Forge, elle, écoute `443` sans difficulté.
PORT_PRIVILEGIE = 1024


def _inservable(target_port: int | None, docker: dict[str, Any]) -> bool:
    """Cette cellule peut-elle seulement ouvrir ce port ? (§44.2 ter)

    Le calcul vit ICI et non dans chaque présentation : deux formules qui
    répondraient à la même question finiraient par ne plus s'accorder, et le
    §44.8 l'interdit déjà entre le JSON et le Markdown.
    """
    return bool(docker.get("mode") == "rootless"
                and target_port is not None and target_port < PORT_PRIVILEGIE)


def modele(spark: dict[str, Any], *, forge_public_address: str,
           routes: list[dict[str, Any]], ports: list[dict[str, Any]],
           environment: list[Any], bootstrap: dict[str, Any] | None,
           written_at: str | None = None,
           ingress_behaviour: dict[str, Any] | None = None,
           notes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Construit l'unique modèle public, sans aucune valeur d'environnement."""
    variables = sorted(entry.name for entry in environment if not entry.is_secret)
    secrets = sorted(entry.name for entry in environment if entry.is_secret)
    # SPK-101 · §44.2 ter : le relevé Docker est calculé AVANT les routes, parce
    # que c'est lui qui dit si cette cellule peut ouvrir le port qu'elles visent.
    docker_releve = _docker(bootstrap, servi=bool(spark.get("docker_enabled", 1)))
    modele_rendu: dict[str, Any] = {
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
        # SPK-102 · §44.2 quater : ce que l'ingress applique, CALCULÉ par lui
        # depuis la configuration qu'il pose (`ingress.comportement()`) et non
        # recopié ici. Une seconde description du même proxy divergerait, et
        # c'est la description que l'agent lirait.
        "ingress_behaviour": ingress_behaviour,
        "ingress": [
            {"domain": route["domain"], "target_port": route["target_port"],
             "tls": bool(route["tls"]), "enabled": bool(route["enabled"]),
             # §44.2 ter : le fait qui décide que cette route n'aboutira PAS.
             "blocked_by_rootless": _inservable(route["target_port"], docker_releve)}
            for route in routes if route["spark_id"] == spark["id"]
        ],
        "published_ports": [
            {"public_port": port["public_port"], "target_port": port["target_port"],
             "protocol": port["protocol"], "note": port["note"],
             "blocked_by_rootless": _inservable(port["target_port"], docker_releve)}
            for port in ports if port["spark_id"] == spark["id"]
        ],
        "environment": {
            "variables": variables,
            "secrets": secrets,
            "files": {"variables": FICHIER_VARIABLES, "secrets": FICHIER_SECRETS},
        },
        "bootstrap": bootstrap,
        "system": _systeme(bootstrap),
        # SPK-98 · §42.13 : la capacité vient du REGISTRE, où la création l'a
        # posée depuis la famille de l'image et où le relevé la corrige. Le
        # briefing doit répondre sur un Spark arrêté et jamais amorcé — c'est
        # justement l'état où l'on prépare un déploiement (§44.9).
        "docker": docker_releve,
        # SPK-98 : le piège du §41.2 — « Docker doit venir du dépôt amont » —
        # ne s'adresse qu'à qui peut en installer un. Sur une cellule sans
        # Docker, la mise en garde vit dans la section qui la concerne, et la
        # répéter ici la rendrait deux fois plus longue à lire pour rien.
        "pitfalls": [p for p in PIEGES
                     if spark.get("docker_enabled", 1) or "Docker" not in p],
        # SPK-104 · §44.8, §54.5 : les notes entrent dans le MODÈLE, comme tout
        # le reste. Le briefing les nomme, le dossier les porte en entier — deux
        # présentations d'une même donnée, jamais deux collectes.
        "notes": list(notes or []),
    }
    # SPK-95 · §42.2 quater : les PORTES ouvertes sur cette cellule. La règle vit
    # ici et non dans la console : « root toujours, spark-docker si le mode relevé
    # est rootless » est une décision du plan de contrôle, et la recopier à
    # l'écran ferait deux vérités qui divergeraient (§44.8).
    modele_rendu["access"] = {"accounts": comptes_du_spark(modele_rendu)}
    return modele_rendu


def _origine(route: dict[str, Any]) -> str:
    """L'origine PUBLIQUE d'une route (§44.2 quater).

    Le briefing donnait `(TLS, active)` — un fait — sans jamais dire ce qu'il
    implique pour la pile. Un agent réel a dû reconstruire seul que le schéma
    public était `https` et que la cellule ne voyait jamais de TLS, puis l'a
    écrit dans son propre dossier d'architecture.
    """
    return f"{'https' if route['tls'] else 'http'}://{route['domain']}"


def _lignes_ingress(model: dict[str, Any]) -> list[str]:
    """Ce que l'ingress applique, depuis ce que l'ingress a CALCULÉ (§44.2 quater).

    Rien n'est écrit en dur ici : `ingress.comportement()` inspecte la
    configuration réellement posée. Le jour où l'ingress gagnera un handler qui
    ajoute des en-têtes, ces lignes le diront sans qu'on y revienne.
    """
    vu = model.get("ingress_behaviour")
    if not vu:
        return []
    lignes = []
    if vu.get("forwarded_headers"):
        lignes.append(
            "- Ce que la pile reçoit du proxy : "
            + ", ".join(f"`{nom}`" for nom in vu["forwarded_headers"])
            + (" ; l'en-tête `Host` est celui que le visiteur a demandé."
               if vu.get("preserve_host") else "."))
        lignes.append(
            "- `X-Forwarded-Proto` porte le schéma de la connexion reçue par la "
            "Forge : `https` sur une route TLS.")
    if not vu.get("adds_headers"):
        lignes.append(
            "- L'ingress **n'ajoute aucun en-tête** — ni HSTS, ni CSP —, ne "
            "redirige aucun nom vers un autre et ne limite aucun débit. Ce qu'il "
            "fait, il le fait en entier : "
            + ", ".join(f"`{h}`" for h in vu.get("handlers", [])) + ".")
    return lignes


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


def _lignes_notes_nommees(model: dict[str, Any]) -> list[str]:
    """Les notes NOMMÉES, pour le briefing de la cellule (§54.5).

    Celui qui lit ce fichier est déjà dedans : les trois notes sont à trois
    lignes de commande de lui. Les y recopier créerait deux exemplaires du même
    texte dans la même machine, dont l'un vieillirait — et ce serait
    l'exemplaire réécrit par le plan de contrôle, c'est-à-dire celui qui a l'air
    officiel.
    """
    lignes = ["", "## Ce que ce Spark dit de lui-même", "",
              "Trois textes écrits par ceux qui connaissent l'application. Le "
              "plan de contrôle ne les vérifie pas : il les transporte.", ""]
    for note in model.get("notes") or []:
        etat = ("écrite" if note["written"] else "**pas encore écrite**")
        lignes.append(f"- `{note['path']}` — {note['expected']} ({etat})")
    lignes.extend([
        "",
        "    cat /etc/spark/notes/*.md",
        "",
        "Elles sont posées par le plan de contrôle depuis son registre : les "
        "éditer à la main n'a aucun effet durable. Pour en proposer une autre "
        "version, écrivez dans le fichier voisin en `.?` — voir ci-dessous.",
    ])
    return lignes


def _lignes_canal(model: dict[str, Any],
                  titre: str = "## Proposer un changement : le fichier `.?`"
                  ) -> list[str]:
    """Le canal `.?`, dit d'UNE seule façon pour les deux présentations (§55.7).

    Quatre points, et pas un de plus : ce qu'on peut proposer, la grammaire, le
    cycle de vie, et comment on apprend le sort de sa demande.
    """
    lignes = [
        "", titre, "",
        "Rien de ce que le plan de contrôle pose ici ne se modifie à la main : "
        "il réécrit tout depuis son registre. **À côté de chaque fichier, un "
        "voisin de même nom suffixé `.?` est le seul endroit où vous pouvez "
        "PROPOSER un changement.**", "",
    ]
    for paire in suggestions_service.PAIRES:
        effet = ("ajoute ou remplace"
                 if paire["nature"] == suggestions_service.ENTREES
                 else "remplace en entier")
        lignes.append(f"- `{paire['reel']}{suggestions_service.SUFFIXE}` — "
                      f"{paire['titre']} ; {effet}.")
    lignes.extend([
        "",
        "Grammaire : `NOM=valeur` pour les deux `.env`, "
        "`<domaine> <port écouté ici> [tls|clair]` pour les routes, du texte "
        "libre pour les trois notes. Chaque fichier porte son en-tête, qui le "
        "redit.",
        "",
        # SPK-112 · §55.3.1 : un agent a lu « servez en clair » comme une valeur
        # de la grammaire, et proposé `clair` pour un site public.
        "**Le dernier mot d'une route règle son côté PUBLIC, et lui seul** : "
        "omis ou `tls`, le site est servi en `https://`, avec un certificat ; "
        "`clair`, il est publié en `http://`, sans certificat. Votre pile écoute "
        "en HTTP simple dans les deux cas.",
        "",
        # SPK-107 · §55.3.3 : les DEUX gestes, montrés plutôt que décrits. Sans
        # eux, l'agent qui ignore une valeur invente un remplissage — accepté
        # sans être regardé, et la pile casse au démarrage suivant.
        "**Une valeur que vous ne connaissez pas se laisse VIDE** — `NOM=`. "
        "C'est une demande : le propriétaire devra la saisir lui-même pour "
        "l'importer. N'inventez pas de valeur de remplissage. Et une ligne `#` "
        "posée **juste au-dessus** d'une déclaration lui sert d'étiquette : une "
        f"seule ligne, {suggestions_service.ETIQUETTE_MAX} caractères, coupée "
        "au-delà.",
        "",
        "```dotenv",
        "# Clé d'API du fournisseur de facturation, à créer chez lui.",
        "BILLING_API_KEY=",
        "```",
        "",
        # Le texte ne décrit PAS l'écran du propriétaire : il décrit ce qui
        # arrive à la proposition. Nommer un écran ferait dépendre ce dossier
        # d'une interface qu'il ne connaît pas et qui change sans lui.
        "**Rien ne s'applique tout seul.** Le propriétaire du Spark relit votre "
        "proposition et l'accepte ou non — en tout ou en partie. Rien ne "
        "garantit qu'elle soit lue : n'en faites pas dépendre le démarrage de "
        "votre pile.",
        "",
        "**Tant que personne n'a tranché, votre fichier reste tel quel.** Quand "
        "une décision aura été prise, il redeviendra **vide** : c'est ainsi que "
        "vous l'apprendrez. Le fichier réel d'à côté vous dira laquelle — ce qui "
        "a été accordé y est, ce qui a été refusé n'y est pas.",
        "",
        "**Un refus du produit ne vide pas** : une valeur de secret dans une "
        "note, un nom hors grammaire, un domaine déjà pris laissent votre "
        "proposition intacte. Corrigez-la sur place.",
    ])
    if model["docker"].get("mode") == "rootless":
        # §55.6.1 : le seul des six dont la proposition est périssable.
        lignes.extend([
            "",
            f"**`{suggestions_service.FICHIER_SECRETS}{suggestions_service.SUFFIXE}` "
            "vit dans un tmpfs** : une proposition de secret disparaît au "
            "redémarrage de la cellule, sans avoir été lue. Redéposez-la.",
        ])
    return lignes


def _lignes_notes_entieres(model: dict[str, Any]) -> list[str]:
    """Les notes recopiées EN ENTIER, pour le dossier (§54.5).

    Celui qui lit ce texte n'est pas encore entré dans la cellule, et ne peut
    ouvrir aucun de ces fichiers : ils vivent derrière une clé accordée, un
    rebond et une cellule amorcée (§44.9.1). Les lui nommer ne servirait à rien.

    Elles viennent en tête, avant même la machine : « à quoi sert ce Spark »
    décide de tout ce qu'on lira ensuite. Une note absente est DITE — le §14.5
    veut que l'absence se nomme, et ici elle dit à l'agent qu'il est peut-être le
    premier à savoir quelque chose que personne n'a écrit.
    """
    lignes = [
        "", "## 2. Ce que ce Spark est, dit par ceux qui le connaissent", "",
        "Ces textes ne viennent pas du plan de contrôle : il les transporte sans "
        "les vérifier. Ils peuvent être périmés, comme toute documentation — "
        "c'est à leurs lecteurs de les corriger, et la section 7 dit comment.",
    ]
    for note in model.get("notes") or []:
        lignes.extend(["", f"### {note['title']} — {note['file']}", ""])
        if note["written"] and note["body"].strip():
            lignes.extend([
                f"> *Attendu ici : {note['expected']}*", "",
                "```markdown", note["body"], "```",
            ])
        else:
            lignes.append(
                f"*Personne n'a encore écrit cette note.* Elle est faite pour "
                f"porter : {note['expected']} Si vous l'apprenez en travaillant, "
                f"vous êtes bien placé pour l'écrire — voir la section 7.")
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
        # SPK-101 · §44.2 bis : le mécanisme AVANT la liste. Sans lui, un agent
        # lit une destination sans savoir qu'un chemin existe déjà, et croit
        # devoir en demander un. SPK-112 · §44.2 bis : « en HTTP simple », pas
        # « en clair » — le mot de la grammaire qui publie en `http://`.
        lines.append("- La Forge termine le TLS et fait suivre vers votre port : "
                     "servez en HTTP simple, sans certificat ; aucun port publié "
                     "n'est requis.")
        lines.extend(
            f"- {_origine(route)} → {route['target_port']} "
            f"({'active' if route['enabled'] else 'désactivée'})"
            + (" — **INSERVABLE ICI** : ce port est privilégié et cette cellule "
               "est rootless. Faites corriger le port cible depuis la console."
               if route["blocked_by_rootless"] else "")
            for route in model["ingress"]
        )
        lines.extend(_lignes_ingress(model))
    else:
        lines.append("- Aucune route déclarée.")
    lines.extend(["", "## Ports publiés"])
    if model["published_ports"]:
        lines.extend(
            f"- {port['protocol']} {port['public_port']} → {port['target_port']}" +
            (f" — {port['note']}" if port["note"] else "") +
            (" — **INSERVABLE ICI** : ce port cible est privilégié et cette "
             "cellule est rootless." if port["blocked_by_rootless"] else "")
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
    # SPK-98 · §42.13, SPK-DS-24 : sur une cellule dont l'image ne reçoit pas
    # Docker, cette section décrivait un sujet qui n'existe pas — et « Docker
    # n'a pas été relevé comme utilisable » envoyait amorcer pour rien.
    if not docker.get("supported", True):
        lines.extend([
            "", "## Docker",
            "- Cette cellule n'a pas Docker, et n'en aura pas : le dépôt "
            "officiel n'en publie aucun pour sa distribution.",
            "- N'installez pas celui de la distribution : son profil AppArmor "
            "refuse socketpair() sous imbrication, et les conteneurs meurent "
            "au démarrage.",
        ])
    else:
        lines.extend(["", "## Contexte Docker relevé"])
    if docker.get("supported", True) and docker["mode"] is None:
        lines.append("- Docker n'a pas été relevé comme utilisable.")
    elif not docker.get("supported", True):
        pass
    elif docker["mode"] == "rootless":
        lines.extend([
            "- Mode : rootless",
            f"- Compte : {docker['user']}",
            f"- Socket : {docker['socket']} (<uid> = {docker['socket_uid_source']})",
            # SPK-95 · §42.2 quater : depuis l'intérieur aussi, on doit savoir
            # qu'il existe une seconde porte — sinon on cherche à faire tourner
            # la pile en root, où Docker ne répond pas.
            f"- Ce compte accepte SSH avec les mêmes clés que {COMPTE_CELLULE} : "
            "entrez par lui pour lancer la pile, par root pour administrer.",
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
    lines.extend(_lignes_notes_nommees(model))
    lines.extend(_lignes_canal(model))
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
                 direct: bool = False, compte: str = COMPTE_CELLULE) -> str | None:
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
        return f"ssh -J {jump} {compte}@{adresse}"
    if direct and not jump:
        return f"ssh {compte}@{adresse}"
    return None


def comptes_du_spark(model: dict[str, Any]) -> list[dict[str, str]]:
    """Les portes ouvertes sur cette cellule, et ce que chacune sert (§42.2 quater).

    @spec docs/BACKLOG.md#SPK-95 · docs/DAT.md §42.2 quater, §44.10

    `root` toujours : c'est la porte administrative, et la seule qui répare une
    cellule dont le reste est cassé. `spark-docker` **seulement** si le relevé
    dit `rootless` — l'annoncer sur un Spark enraciné enverrait frapper à une
    porte qui n'existe pas, et l'annoncer parce qu'un compte existe
    contredirait le §42.2 bis, où le mode est une observation.
    """
    # `role` est COURT et `detail` explique. Les fondre donnait une option de
    # liste déroulante de cent caractères : mesuré à 390 px, le contrôle tirait
    # sa largeur intrinsèque de cette option et débordait de sa carte — le même
    # défaut que le §8.2 avait déjà corrigé pour les modales.
    portes = [{
        "user": COMPTE_CELLULE,
        "role": "administrer la cellule",
        "detail": "installer des paquets, écrire dans /srv, lire ce dossier, "
                  "réparer un amorçage",
    }]
    if model["docker"]["mode"] == "rootless":
        portes.append({
            "user": COMPTE_ROOTLESS,
            "role": "faire tourner la pile",
            "detail": "`docker` y répond sans incantation, et ce compte ne peut "
                      "pas casser la cellule",
        })
    return portes


def dossier(model: dict[str, Any], *, ssh_config: str | None = None,
            keys: list[dict[str, Any]] | None = None,
            jump: str | None = None, direct: bool = False) -> str:
    """Le dossier de déploiement, pour l'agent qui prépare depuis son poste.

    @spec docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9 (le dossier), §44.9.2 (ce
          qu'il porte de plus, dont le point 4 : quoi lire en arrivant), §44.9.3
          (ce qu'il ne porte jamais), §44.6 (une donnée, pas une consigne) ·
          docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.7 (le lot que l'agent rend),
          §44.9.6 (rédiger n'est pas écrire)

    TOUT ce qu'il écrit vient de `model`, plus l'accès SSH que la cellule ne
    porte pas. Il ne relit rien, ne mesure rien et n'invente rien : une seconde
    collecte de faits finirait par dire autre chose que la première (§44.8).
    """
    spark = model["spark"]
    env = model["environment"]
    docker = model["docker"]
    ressources = model["resources"]
    bootstrap = model["bootstrap"]
    portes = comptes_du_spark(model)
    commande = commande_ssh(model, jump, direct=direct)

    lignes = [
        f"# Dossier de déploiement — Spark « {spark['name']} »",
        "",
        f"Relevé écrit le {model['written_at']} par {model['written_by']}.",
        "",
        "Ce texte décrit **la cellule qui accueillera la pile**, telle que le plan "
        "de contrôle la connaît. Il énonce des faits, et les seules voies par "
        "lesquelles on agit sur cette cellule ; il ne décrit pas l'application à "
        "déployer, et ne prouve **aucune** autorisation : "
        f"{model['trust']}",
        "",
        "## 1. Entrer dans la cellule",
        "",
    ]
    if commande:
        # SPK-95 · §42.2 quater : une porte par compte, et chacune DIT à quoi
        # elle sert. Une seule ligne `ssh root@…` laissait deviner ; deux lignes
        # nommées ne laissent rien à deviner.
        for porte in portes:
            ligne = commande_ssh(model, jump, direct=direct, compte=porte["user"])
            if not ligne:
                continue
            lignes.extend([
                f"**{porte['user']}** — {porte['role']} : {porte['detail']}.", "",
                "```sh", ligne, "```", ""])
    else:
        lignes.extend([
            "La commande complète n'a pas pu être composée : la console n'a pas "
            "nommé par où l'on saute vers la Forge, ou ce Spark n'a pas encore "
            "d'adresse. Le fragment ci-dessous reste valable une fois l'alias de "
            "rebond défini dans le `~/.ssh/config` du poste.",
            "",
        ])
    if commande:
        # SPK-99 · §44.9.2 point 4 : le `motd` du §44.1 porte l'instruction de
        # lire le briefing, et il ne s'affiche QU'À l'ouverture d'un shell de
        # connexion. `ssh hôte 'commande'` n'en ouvre aucun — c'est la forme par
        # laquelle un agent entre. Sans cette ligne, il ignore que le fichier
        # existe. Même rebond validé que ci-dessus : rien de neuf n'entre dans
        # une ligne de commande.
        lignes.extend([
            "Lire le briefing de la cellule sans ouvrir de shell :", "",
            "```sh", f"{commande} 'cat {FICHIER_MARKDOWN}'", "```", ""])
    if ssh_config:
        lignes.extend(["Fragment `ssh_config` équivalent :", "", "```",
                       ssh_config.rstrip("\n"), "```", ""])
    lignes.extend([
        "- Comptes dans la cellule : " + ", ".join(
            f"`{porte['user']}`" for porte in portes) + ".",
        f"- Adresse privée : `{spark['private_ipv4'] or 'aucune'}` — joignable "
        "**uniquement** depuis la Forge, jamais depuis Internet.",
        "- **Le rebond est obligatoire** : un Spark n'expose jamais son port 22 sur "
        "l'extérieur. Viser l'adresse publique de la Forge ne mène pas ici.",
        f"- **Lisez `{FICHIER_MARKDOWN}` en arrivant** : c'est le même modèle que "
        "ce dossier, réécrit dans la cellule à chaque geste du plan de contrôle. "
        "`/etc/motd` le rappelle à la connexion — mais une commande d'une seule "
        "ligne n'ouvre aucun shell, et n'affiche donc aucun `motd`.",
        # SPK-105 · §55.7 : la consigne d'accès, écrite UNE fois, ici, au même
        # endroit que les commandes d'entrée. La répéter à chaque section la
        # ferait lire zéro fois ; l'omettre laisserait un agent conclure d'un
        # fichier réécrit puis restauré que la machine est cassée.
        "- **Ce que le plan de contrôle pose, il le RÉÉCRIT** depuis son "
        f"registre : `{FICHIER_VARIABLES}`, `{FICHIER_SECRETS}`, "
        f"`{suggestions_service.FICHIER_ROUTES}`, `{FICHIER_MARKDOWN}` et les "
        "trois notes. Les éditer à la main n'a aucun effet durable. **Tout ce "
        "qui vient de la cellule passe par le fichier `.?` voisin** (section 7)"
        + (", que `root` comme `spark-docker` peuvent écrire"
           if model["docker"].get("mode") == "rootless" else "")
        + ". Ni l'un ni l'autre ne décide : une variable, un secret, une route "
        "ou une note n'entrent que par la console.",
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

    lignes.extend(_lignes_notes_entieres(model))
    lignes.extend(["", "## 3. La machine"])
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
        # SPK-101 · §44.2 bis : où vivent les données. Un agent qui pose une base
        # de données sur ce disque a besoin de savoir qu'il n'y en a qu'un.
        "- **Un seul disque** : le système, vos images, vos volumes Docker et vos "
        "fichiers partagent le quota ci-dessus. Les volumes vivent sous le compte "
        "qui porte le démon ; `/run` est un tmpfs, et ce qu'on y écrit disparaît "
        "au redémarrage.",
        "",
        "## 4. Le moteur Docker",
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
    # SPK-101 · §44.2 bis : deux faits qu'aucune commande ne donne avant d'avoir
    # échoué — et qui décident de la forme de la pile.
    if docker["mode"] is not None:
        lignes.extend([
            "- **Le réseau sortant fonctionne** : l'amorçage a installé ses paquets "
            "par lui, et `docker pull` aboutit depuis cette cellule.",
            # SPK-102 · §44.2 quinquies : un agent réel a mesuré des ports SMTP
            # sortants fermés et a écrit « la cellule filtre ». Le produit ne
            # pose qu'une chaîne `input` (§48.1) ; la cause est ailleurs, et le
            # dire envoie la question au bon interlocuteur.
            "- **Le plan de contrôle ne filtre AUCUN port sortant.** Il ne pose "
            "qu'un filtre d'entrée, qui protège les services de la Forge. Un port "
            "sortant qui ne répond pas — 25, 465 et 587 sont les cas courants — "
            "est fermé par l'hébergeur, pas ici : c'est à lui qu'il faut le "
            "demander, ou employer les ports de repli qu'il publie.",
            "- **Le plan de contrôle ne démarre jamais votre pile.** Le démon, lui, "
            "repart au démarrage de la cellule — "
            + ("le compte rootless a son `linger`" if docker["mode"] == "rootless"
               else "`docker.service` est activé")
            + " —, donc ce que votre `docker-compose.yml` déclare dans `restart:` "
            "est honoré après un redémarrage.",
        ])

    lignes.extend([
        "",
        "## 5. Ce que la pile recevra",
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
        # SPK-99 · §44.9.7 : le cas ordinaire est qu'il en MANQUE une. L'agent
        # est root, les deux fichiers sont là, il les écrit — et le §43.2 les
        # régénère en entier au prochain geste, le tmpfs du §43.5.2 au prochain
        # démarrage. La pile marche, puis cesse de marcher, loin du geste.
        "### Il en manque une pour votre pile ?",
        "",
        "**Écrire dans ces deux fichiers depuis la cellule ne sert à rien.** Le "
        "plan de contrôle les régénère **en entier** depuis son registre à chaque "
        f"écriture, et `{FICHIER_SECRETS}` vit dans un tmpfs reposé à chaque "
        "démarrage. Une ligne ajoutée à la main disparaît — pas tout de suite, ce "
        "qui est pire : la pile marchera jusque-là.",
        "",
        "**Seul le propriétaire du Spark peut poser une variable**, depuis la "
        "console, qui n'est pas joignable d'ici. Mais vous pouvez lui DEMANDER, "
        "et la machine porte la demande à sa place.",
        "",
        # SPK-105 · §55.7 : le §44.9.7 demandait à l'agent de rédiger un bloc
        # dans sa réponse, à charge pour le propriétaire de le recopier. Le bloc
        # traversait une conversation, où une ligne se perd sans que personne ne
        # le voie. Le fichier, lui, ne perd rien.
        f"**Écrivez-les dans `{FICHIER_VARIABLES}{suggestions_service.SUFFIXE}` "
        f"— ou `{FICHIER_SECRETS}{suggestions_service.SUFFIXE}` pour ce qui doit "
        "être secret.** Le propriétaire les relira ligne par ligne et posera "
        "celles qu'il retient. La section 7 dit ce qui arrive ensuite à votre "
        "fichier.",
        "",
        "Si vous préférez le lui remettre de la main à la main, c'est le même "
        "texte, et il le collera dans **la fenêtre de ce Spark → Environnement → "
        "Importer un lot** :",
        "",
        "```dotenv",
        "# Ce que fait cette variable, en une ligne : c'est son étiquette.",
        "NOM_DE_VARIABLE=valeur",
        'AUTRE_VARIABLE="valeur avec des espaces"',
        "# Celle-ci, je ne peux pas la connaître : à vous de la poser.",
        "MOT_DE_PASSE_SMTP=",
        "```",
        "",
        "- Une ligne par variable, et **aucune valeur multiligne** : écrivez "
        "`\\n`.",
        # SPK-107 · §55.3.3 : le vide est une DEMANDE dans un `.?`. Collé à la
        # main, il vaut une valeur vide (§43.10.1) — la divergence est dans le
        # DAT, et ce texte ne promet donc rien de l'écran ici.
        "- **Une valeur laissée vide dans un fichier `.?` est une DEMANDE** : "
        "le propriétaire devra la saisir pour l'importer.",
        "- **Une ligne `#` collée juste au-dessus d'une déclaration lui sert "
        f"d'étiquette** — une ligne, {suggestions_service.ETIQUETTE_MAX} "
        "caractères — et s'affiche à côté d'elle quand il relit.",
        "- `$` est **littéral** : `A=$B` vaut `$B`, rien n'est substitué.",
        "- `#` n'ouvre un commentaire qu'en **début** de ligne.",
        "- Un import **ajoute et remplace** ; il ne retire jamais ce que le bloc "
        "ne nomme pas.",
        "- **Dites en clair, à côté du bloc, lesquelles sont des secrets.** Le "
        "produit ne le devine pas d'après le nom : c'est la personne qui importe "
        "qui coche, ligne par ligne. Par fichier, le chemin le dit déjà — ce qui "
        f"est dans `{FICHIER_SECRETS}{suggestions_service.SUFFIXE}` est proposé "
        "comme secret —, et le propriétaire garde le dernier mot.",
        "- Une ligne refusée est nommée avec son numéro avant que rien ne soit "
        "écrit ; c'est la console qui fait foi, pas cette liste.",
        "",
        "## 6. Le contrat que le `docker-compose.yml` doit respecter",
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
        # SPK-101 · §44.2 bis : le MÉCANISME d'abord. Un agent réel, lisant la
        # seule liste, a conclu qu'il devait faire publier un port et demander
        # que l'ingress y soit routé — une procédure entière pour un besoin qui
        # n'existe pas. Il ne lui manquait que la phrase qui suit.
        lignes.extend([
            "Ports que la pile doit **écouter dans la cellule**, parce qu'une "
            "route publique les vise déjà :", ""])
        lignes.extend(
            f"- **{_origine(route)}** "
            f"({'active' if route['enabled'] else 'désactivée'}) → la pile doit "
            f"écouter sur **{route['target_port']}**, en HTTP simple"
            + ("\n  - **Cette route n'aboutira pas en l'état.** Le port visé est "
               "privilégié (`< 1024`) et cette cellule est en Docker rootless, "
               "qui ne peut pas l'ouvrir. Il n'y a pas de contournement à "
               "chercher : demandez au propriétaire de **changer le port cible "
               "de la route** depuis la console, pour un port au-dessus de 1024."
               if route["blocked_by_rootless"] else "")
            for route in model["ingress"])
        lignes.extend([
            "",
            "**Une route active est un chemin complet.** La Forge tient un proxy "
            "unique qui écoute `443`, détient le certificat, **termine le TLS** et "
            "fait suivre vers l'adresse privée de ce Spark sur le port ci-dessus. "
            # SPK-112 · §44.2 bis : « en HTTP simple ». « En clair » est le mot
            # de la grammaire des routes qui publie un site en `http://`.
            "Votre pile sert donc **en HTTP simple** sur ce port : un certificat "
            "dans la pile ne servirait à rien.",
            "",
            "**Et elle ne demande aucun port publié.** Un port publié est le "
            "SECOND mécanisme, réservé à ce qui n'annonce aucun nom d'hôte — SMTP, "
            "Postgres, Redis, SSH, MQTT. Tout ce qui parle HTTP, HTTPS ou "
            "WebSocket passe par la route, sans rien demander de plus.",
            "",
            "**L'origine publique ci-dessus est celle que votre application doit "
            "connaître.** Une application qui l'ignore émet des URL en `http://` "
            "derrière un terminateur TLS — la panne la plus banale de cette "
            "architecture, et celle qui ne se voit qu'au premier lien envoyé.",
            "",
        ])
        # SPK-102 · §44.2 quater : CALCULÉ par l'ingress, jamais recopié ici.
        lignes.extend(_lignes_ingress(model))
        if model.get("ingress_behaviour") and not model["ingress_behaviour"].get(
                "adds_headers"):
            lignes.extend([
                "",
                "**Un proxy dans votre pile n'y changerait rien.** Il serait un "
                "second terminateur derrière le premier, et sur une cellule "
                "rootless il ne pourrait même pas démarrer : ni `443`, ni `80` "
                "pour un défi ACME. Ces protections se posent à l'ingress, du "
                "côté du propriétaire.",
            ])
        lignes.append("")
    else:
        lignes.extend(["Aucune route publique ne vise ce Spark : rien n'impose de "
                       "port d'écoute, et rien n'est servi sur un domaine. Une "
                       "route se demande au propriétaire ; elle suffit ensuite à "
                       "vous atteindre, TLS compris, sans port publié.", ""])
    if model["published_ports"]:
        lignes.append("Ports publiés sur la Forge, en plus des routes :")
        lignes.extend(
            f"- {port['protocol']} **{port['public_port']}** sur la Forge → "
            f"{port['target_port']} dans la cellule"
            + (f" — {port['note']}" if port["note"] else "")
            + ("\n  - **Ce port ne s'ouvrira pas ici** : sa cible est privilégiée "
               "(`< 1024`) et cette cellule est en Docker rootless. Faites "
               "changer le port cible depuis la console."
               if port["blocked_by_rootless"] else "")
            for port in model["published_ports"])
        lignes.append("")
    lignes.extend([
        "**Rien ne s'expose depuis l'intérieur.** Une route publique et un port "
        "publié se déclarent au plan de contrôle, injoignable depuis la cellule : "
        "vous ne pouvez pas les poser vous-même.",
        "",
        "Une **route**, vous pouvez la PROPOSER, et la section suivante dit "
        f"comment : `{suggestions_service.FICHIER_ROUTES}"
        f"{suggestions_service.SUFFIXE}`. Un **port publié**, non : c'est une "
        "ressource de la Forge, unique sur la machine et partagée entre tous les "
        "Sparks — celui-là se demande en toutes lettres à son propriétaire.",
    ])
    lignes.extend(_lignes_canal(
        model, "## 7. Proposer un changement : le fichier `.?`"))
    lignes.extend([
        "",
        "## 8. Pièges connus",
        "",
    ])
    lignes.extend(f"- {piege}" for piege in model["pitfalls"])
    lignes.extend([
        "",
        "## 9. Ce que ce dossier ne contient pas",
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
    """Le panneau indicateur à trois lignes, pas un second briefing.

    @spec docs/BACKLOG.md#SPK-94 · docs/DAT.md §44.1, §42.2 quater

    La troisième ligne est IMPÉRATIVE depuis SPK-94, et ce n'est pas une
    coquetterie de ton. « Briefing : /etc/spark/BRIEFING.md » nommait un chemin
    sans dire qu'il fallait l'ouvrir, sous une dizaine de lignes de bandeau de la
    distribution : ni un humain ni un agent n'y voyait une instruction. Le
    bandeau est tu par l'amorçage (§42.2 quater) et cette ligne dit quoi faire.

    Elle dit aussi CE QU'ON Y TROUVE : « lisez ce fichier » sans son contenu se
    remet à plus tard, et le §44.2 tient précisément à ce que l'agent apprenne
    ici ce qu'il ne peut pas déduire de la cellule.
    """
    return "\n".join((
        f"Spark : {model['spark']['name']}",
        f"Protection : {'armée' if model['spark']['protected'] else 'non armée'}",
        # SPK-98 · SPK-DS-24 : ne pas annoncer un « contexte Docker » à qui
        # entre dans une cellule qui n'en aura jamais. Trois lignes plus bas,
        # l'agent ouvrirait le fichier pour y chercher ce qu'on vient de lui
        # promettre.
        f"Lisez d'abord {FICHIER_MARKDOWN} : quotas réels, "
        + ("contexte Docker, " if model["docker"].get("supported", True) else "")
        + "variables d'environnement et pièges connus.",
        "",
    ))


def fichiers(model: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """Les trois projections et leurs permissions explicites (§44.8)."""
    return {
        FICHIER_JSON: (json_file(model), "0600"),
        FICHIER_MARKDOWN: (markdown(model), "0600"),
        FICHIER_MOTD: (motd(model), "0644"),
    }
