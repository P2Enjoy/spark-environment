"""L'unité qui porte Caddy sur la Forge : `caddy-api.service`, et rien d'autre.

@spec docs/BACKLOG.md#SPK-129 · docs/DAT.md §51.5 (ce qui doit reprendre seul :
      Caddy porté par `caddy-api.service`, `caddy.service` masqué, reprise sur
      panne, une seule fonction appelée par l'exécuteur ET par `sparkd.install`)
      · §18.1 (le produit pilote Caddy par son API)

Mesuré le 2026-09-30 dans les journaux du démarrage du 2026-09-14 :
`caddy.service` repart de `/etc/caddy/Caddyfile` — un serveur de fichiers par
défaut, aucune route — et écrase au passage sa sauvegarde automatique. Deux
heures sans ingress. Le paquet livre `caddy-api.service`, dont `--resume` repart
de la dernière configuration posée : c'est l'unité d'un Caddy piloté par API.

Le module suit la forme de `pare_feu` : `ecrire` pose le fichier du produit par
comparaison, `aligner` ne passe une commande que si l'état relevé l'exige. Une
pose sur une Forge déjà alignée ne passe AUCUNE commande — l'installation
rejouée ne coupe pas l'ingress.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

#: L'unité livrée par le paquet pour une configuration par API.
UNITE = "caddy-api.service"
#: L'unité d'une configuration par fichier : masquée, pour que ni un démarrage,
#: ni le script d'un paquet mis à jour, ni un `systemctl restart caddy` tapé par
#: habitude ne remettent le `Caddyfile` en service.
UNITE_FICHIER = "caddy.service"
CHEMIN_COMPLEMENT = Path("etc/systemd/system") / f"{UNITE}.d" / "spark.conf"

#: Aucune des deux unités livrées ne relance un Caddy tombé. Un complément, et
#: pas une copie de l'unité : le paquet reste maître du reste de sa définition.
TEXTE_COMPLEMENT = """# Posé par sparkd (docs/DAT.md §51.5) : un Caddy tombé se relance.
[Service]
Restart=on-failure
RestartSec=2s
"""

Executeur = Callable[[list[str]], object]
#: Rend la sortie standard d'une commande de LECTURE, sans lever.
Lecteur = Callable[[list[str]], str]


def _ecrire_si_change(chemin: Path, contenu: str, mode: int) -> bool:
    try:
        if (chemin.read_text(encoding="utf-8") == contenu
                and (chemin.stat().st_mode & 0o777) == mode):
            return False
    except OSError:
        pass
    chemin.parent.mkdir(parents=True, exist_ok=True)
    temporaire = chemin.with_name(f".{chemin.name}.tmp")
    temporaire.write_text(contenu, encoding="utf-8")
    temporaire.chmod(mode)
    temporaire.replace(chemin)
    return True


def ecrire(*, racine: Path = Path("/")) -> bool:
    """Pose le complément d'unité s'il diffère. N'exécute rien."""
    return _ecrire_si_change(racine / CHEMIN_COMPLEMENT, TEXTE_COMPLEMENT, 0o644)


def etat(lire: Lecteur) -> dict[str, str]:
    """L'état des deux unités, relevé par `systemctl show`.

    Pas `is-enabled` : il sort en erreur pour une unité masquée, et un lecteur
    qui ignore les codes d'erreur ne distinguerait plus « masquée » de « absente ».
    `show` rend toujours sa valeur — vide pour une unité inconnue.
    """
    def valeur(unite: str, propriete: str) -> str:
        return (lire(["systemctl", "show", "-p", propriete, "--value", unite]) or "").strip()

    return {
        "fichier": valeur(UNITE_FICHIER, "UnitFileState"),
        "api": valeur(UNITE, "UnitFileState"),
        "api_actif": valeur(UNITE, "ActiveState"),
    }


def aligne(releve: dict[str, str]) -> bool:
    """Caddy est-il porté comme le §51.5 l'exige ?"""
    return (releve["fichier"] == "masked" and releve["api"] == "enabled"
            and releve["api_actif"] == "active")


def aligner(executer: Executeur, lire: Lecteur, *, complement_change: bool,
            daemon_recharge: bool = False) -> list[list[str]]:
    """Passe les commandes que l'état relevé exige, et rien d'autre.

    L'ORDRE compte : `caddy.service` est arrêté avant que `caddy-api.service`
    démarre, les deux écoutent `:80` et `:443`. `caddy-api` repart alors de la
    sauvegarde que `caddy.service` tenait — la dernière configuration posée par
    `sparkd` sur une Forge en service ; celle du `Caddyfile` sur une Forge neuve,
    que la réconciliation du démarrage de `sparkd` remplace aussitôt.

    Un complément changé sur une unité déjà active ne la redémarre PAS :
    `Restart=` vaut dès le `daemon-reload`, et redémarrer couperait l'ingress
    pour rien.
    """
    commandes: list[list[str]] = []
    if complement_change and not daemon_recharge:
        commandes.append(["systemctl", "daemon-reload"])
    releve = etat(lire)
    if releve["fichier"] != "masked":
        if releve["fichier"] == "enabled":
            commandes.append(["systemctl", "disable", UNITE_FICHIER])
        # `mask --now` arrête l'unité ET la rend indémarrable, en un geste.
        commandes.append(["systemctl", "mask", "--now", UNITE_FICHIER])
    if releve["api"] != "enabled" or releve["api_actif"] != "active":
        commandes.append(["systemctl", "enable", "--now", UNITE])
    for commande in commandes:
        executer(commande)
    return commandes
