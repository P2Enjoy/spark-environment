"""La santé d'un Spark : sondes HTTPS et scripts, états, alertes à la transition.

@spec docs/BACKLOG.md#SPK-184 · docs/DAT.md §75 (le contrat), §75.2 (deux types de
      sonde), §75.3 (la sonde HTTPS : l'adresse est fixe), §75.4 (la cadence),
      §75.5 (le script), §75.6 (la machine à états), §75.7 (l'alerte : une
      transition, pas un relevé), §75.8 (le planificateur et l'API) ·
      docs/SCHEMA.md §8 quater

Une sonde est un type (`http` ou `script`), une cible, un résultat attendu, une
cadence en chaîne crontab (UTC, 5 minutes au plus serré), un seuil d'échecs
consécutifs et un ÉTAT. C'est l'état qui change — jamais un relevé qui alerte :
`health.down` quand le seuil est atteint, `health.up` quand la panne est levée,
une fois chacun (§75.7).

**Deux garanties qui font le sens de l'unité.**

- La sonde HTTPS ne peut viser que ce que l'ingress sert pour un **domaine que le
  Spark déclare** — jamais une adresse choisie par un locataire. La connexion va
  toujours à `127.0.0.1:443` (`SondesReelles.sante`) ; ce module refuse en amont tout
  ce qui n'est pas « un domaine non joker de ce Spark, un chemin, rien d'autre ».
- La sortie d'un script n'est **jamais** stockée ni envoyée : elle peut contenir un
  secret. Seul un motif court (`code de sortie 2`, `délai dépassé`) est gardé.

Le module ne lit pas l'horloge à sa place : chaque fonction prend `now`, ce qui
permet de rejouer des instants passés (le seed) et de prouver chaque cas limite.
"""

from __future__ import annotations

import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from secrets import token_hex
from urllib.parse import urlsplit

from . import audit, cron
from .db import transaction

#: Écart minimal entre deux relevés, en minutes (DAT §75.4) : « au 5 minutes près ».
ECART_MINUTES = 5
#: Délais, en secondes (DAT §75.3, §75.5). Constantes du code, pas des réglages.
DELAI_HTTP = 10.0
DELAI_SCRIPT = 60
#: Bornes (DAT §75.8).
MAX_SONDES = 20
MAX_RELEVES = 100
SEUIL_MIN, SEUIL_MAX = 1, 20
#: Taille d'un motif gardé : un message d'erreur, pas une sortie.
TAILLE_DETAIL = 200
#: Pas du planificateur et pool borné (DAT §75.8).
PAS = 30.0
POOL = 4
#: Combien de relevés l'écran lit pour sa frise.
RELEVES_LUS = 20

ACTEUR = "sante"
COMPTE_ROOTLESS = "spark-docker"

TYPES = ("http", "script")
ETATS = ("unknown", "healthy", "unstable", "down", "stopped")

NOM = re.compile(r"^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$")
#: Un chemin, et sa requête : des caractères d'URL, un `/` en tête, rien d'autre.
CHEMIN = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$")


class SanteError(RuntimeError):
    """Sonde refusée, avec sa raison pour l'écran."""


# --- le temps -------------------------------------------------------------------------

def maintenant() -> datetime:
    return datetime.now(timezone.utc)


def _iso(instant: datetime) -> str:
    return instant.astimezone(timezone.utc).isoformat(timespec="seconds")


def _lire_iso(texte: str) -> datetime:
    instant = datetime.fromisoformat(texte)
    return instant if instant.tzinfo else instant.replace(tzinfo=timezone.utc)


# --- la validation ----------------------------------------------------------------------

def _entier(valeur, nom: str, mini: int, maxi: int) -> int:
    if isinstance(valeur, bool) or not isinstance(valeur, int):
        raise SanteError(f"{nom} : un nombre entier est attendu.")
    if not mini <= valeur <= maxi:
        raise SanteError(f"{nom} : entre {mini} et {maxi}.")
    return valeur


def _cible_http(connection: sqlite3.Connection, spark: dict, cible) -> str:
    """`https://<domaine du Spark>/<chemin>`, normalisée, ou un refus qui dit pourquoi.

    **Un domaine, un chemin, rien d'autre** (DAT §75.3) : ni identifiant, ni port, ni
    fragment, ni schéma autre qu'`https`. Et le domaine doit être celui d'une route
    **non joker de ce Spark**, lue au registre : un joker pourrait être capté par la
    route plus spécifique d'un autre Spark, et la sonde jugerait le mauvais.
    """
    if not isinstance(cible, str) or not cible.strip():
        raise SanteError("La cible est vide : https://<domaine d'une route du Spark>/<chemin>.")
    cible = cible.strip()
    try:
        morceaux = urlsplit(cible)
        port = morceaux.port
    except ValueError as erreur:
        raise SanteError(f"Adresse illisible : {erreur}.") from erreur
    if morceaux.scheme != "https":
        raise SanteError("Seul https:// est admis.")
    if morceaux.username is not None or morceaux.password is not None:
        raise SanteError("Aucun identifiant dans l'adresse.")
    if port is not None:
        raise SanteError("Aucun port : la sonde vise le 443 de l'ingress.")
    if morceaux.fragment:
        raise SanteError("Aucun fragment dans l'adresse.")
    domaine = (morceaux.hostname or "").lower()
    if not domaine:
        raise SanteError("Aucun domaine dans l'adresse.")
    if "*" in domaine:
        raise SanteError(
            "Un joker ne désigne aucune adresse : choisissez un domaine précis d'une route.")
    chemin = (morceaux.path or "/") + (f"?{morceaux.query}" if morceaux.query else "")
    if not CHEMIN.match(chemin) or len(chemin) > 500:
        raise SanteError("Chemin invalide : des caractères d'URL, en commençant par « / ».")
    route = connection.execute(
        "SELECT tls FROM ingress_route WHERE spark_id = ? AND domain = ?",
        (spark["id"], domaine)).fetchone()
    if route is None:
        raise SanteError(
            f"« {domaine} » n'est pas une route de ce Spark : une sonde ne peut viser "
            "que ses propres domaines.")
    if not route["tls"]:
        raise SanteError(
            f"« {domaine} » est servie en clair (sans TLS) : une sonde HTTPS ne peut pas "
            "lui répondre. Activez le TLS de la route, ou sondez-la par un script.")
    return f"https://{domaine}{chemin}"


def valider(connection: sqlite3.Connection, spark: dict, definition: dict) -> dict:
    """Une définition de sonde, normalisée — ou `SanteError` avec la raison."""
    if not isinstance(definition, dict):
        raise SanteError("La définition d'une sonde est un objet.")
    nom = definition.get("name")
    if not isinstance(nom, str) or not NOM.match(nom):
        raise SanteError(
            "Nom invalide : minuscules, chiffres et tirets, 42 caractères au plus, "
            "sans tiret aux extrémités.")
    kind = definition.get("kind")
    if kind not in TYPES:
        raise SanteError(f"Type « {kind} » inconnu : {' ou '.join(TYPES)}.")
    seuil = _entier(definition.get("threshold"), "Seuil d'échecs", SEUIL_MIN, SEUIL_MAX)
    try:
        horaire = cron.analyser(definition.get("schedule"), ecart_minimal=ECART_MINUTES)
    except cron.ErreurCron as erreur:
        raise SanteError(f"Cadence : {erreur}") from erreur

    if kind == "http":
        attendu = _entier(definition.get("expected"), "Statut attendu", 100, 599)
        cible = _cible_http(connection, spark, definition.get("target"))
    else:
        attendu = _entier(definition.get("expected"), "Code de sortie attendu", 0, 255)
        cible = definition.get("target")
        if not isinstance(cible, str) or not cible.strip():
            raise SanteError("La commande est vide.")
        cible = cible.strip()
        if len(cible) > 2000 or any(c in cible for c in "\n\r\x00"):
            raise SanteError(
                "Commande invalide : une seule ligne, 2000 caractères au plus.")

    autres = connection.execute(
        "SELECT COUNT(*) FROM health_check WHERE spark_id = ? AND name != ?",
        (spark["id"], nom)).fetchone()[0]
    if autres >= MAX_SONDES:
        raise SanteError(f"Un Spark porte au plus {MAX_SONDES} sondes.")
    return {"name": nom, "kind": kind, "target": cible, "expected": attendu,
            "schedule": horaire.source, "threshold": seuil}


# --- la machine à états : une fonction pure ------------------------------------------------

def transition(etat: str, echecs: int, seuil: int, ok: bool) -> tuple[str, int]:
    """L'état et le compteur d'échecs après UN relevé.

    - un succès remet le compteur à zéro : `healthy` ;
    - un échec l'incrémente ; tant qu'il est sous le seuil, `unstable` — visible,
      **sans alerte** ; au seuil, `down`.

    Pure : ne lit rien, n'écrit rien, ne décide d'aucune alerte (`evenement`).
    """
    if ok:
        return "healthy", 0
    echecs += 1
    return ("down" if echecs >= seuil else "unstable"), echecs


def etait_alerte(etat: str, echecs: int, seuil: int) -> bool:
    """La panne avait-elle DÉJÀ été annoncée ?

    Une sonde `stopped` garde son compteur : si elle s'est arrêtée alors qu'elle était
    en panne, l'alerte est partie, et le rétablissement doit encore la lever (§75.6).
    """
    return etat == "down" or (etat == "stopped" and echecs >= seuil)


def evenement(ancienne_alerte: bool, nouvel_etat: str) -> str | None:
    """`down`, `up` ou `None` : l'alerte que CETTE transition justifie, une seule."""
    if nouvel_etat == "down" and not ancienne_alerte:
        return "down"
    if nouvel_etat == "healthy" and ancienne_alerte:
        return "up"
    return None


# --- les deux exécuteurs --------------------------------------------------------------------

def _court(texte: str) -> str:
    texte = " ".join(str(texte).split())
    return texte if len(texte) <= TAILLE_DETAIL else texte[:TAILLE_DETAIL - 1] + "…"


def releve_http(sondes, domaine: str, chemin: str, attendu: int) -> dict:
    """Une requête par la boucle locale. Rend `{ok, latency_ms, detail}`."""
    rendu = sondes.sante(domaine, chemin, DELAI_HTTP)
    latence = rendu.get("latency_ms")
    if rendu.get("error"):
        return {"ok": False, "latency_ms": latence, "detail": _court(rendu["error"])}
    if rendu.get("status") != attendu:
        return {"ok": False, "latency_ms": latence,
                "detail": f"HTTP {rendu.get('status')} (attendu {attendu})"}
    return {"ok": True, "latency_ms": latence, "detail": None}


def commande_script(spark: dict, commande: str) -> list[str]:
    """La commande Incus d'un script : dans la cellule, sous le compte de la pile.

    Le compte n'est pas un choix de la ligne (DAT §75.5) : `root` sur un Spark
    enraciné, le compte rootless sur un Spark rootless — c'est ce qui permet à un
    script d'atteindre le socket Docker, comme le fait l'amorçage. La commande est
    passée en ARGUMENT d'un `sh -c` fixe : le texte de l'agent n'est jamais
    interpolé dans un script du produit. `timeout` coupe au-delà de 60 secondes.
    """
    base = ["timeout", "-k", "5", str(DELAI_SCRIPT)]
    if spark.get("docker_mode") == "rootless":
        enveloppe = (
            f"uid=$(id -u {COMPTE_ROOTLESS}) || exit 125; "
            f"exec runuser -u {COMPTE_ROOTLESS} -- env XDG_RUNTIME_DIR=/run/user/$uid "
            'DOCKER_HOST=unix:///run/user/$uid/docker.sock sh -c "$1"')
        return base + ["sh", "-c", enveloppe, "sante", commande]
    return base + ["sh", "-c", commande]


def releve_script(incus, spark: dict, commande: str, attendu: int) -> dict:
    """Un script dans la cellule. **Seul le code de sortie est lu** : jamais la sortie."""
    debut = time.monotonic()

    def latence() -> int:
        return int((time.monotonic() - debut) * 1000)

    try:
        code, _sortie, _erreurs = incus.exec_capture(
            spark["incus_name"], commande_script(spark, commande))
    except Exception as erreur:  # noqa: BLE001 — la cellule n'a pas répondu : c'est un échec
        return {"ok": False, "latency_ms": latence(),
                "detail": _court(f"cellule injoignable : {erreur}")}
    if code == attendu:
        return {"ok": True, "latency_ms": latence(), "detail": None}
    if code in (124, 137):
        detail = f"délai dépassé ({DELAI_SCRIPT} s)"
    elif code in (125, 126, 127):
        detail = f"commande non exécutable (code {code})"
    else:
        detail = f"code de sortie {code} (attendu {attendu})"
    return {"ok": False, "latency_ms": latence(), "detail": detail}


def _executer(connection, incus, sondes, spark: dict, sonde: dict) -> dict:
    if sonde["kind"] == "http":
        morceaux = urlsplit(sonde["target"])
        domaine = morceaux.hostname or ""
        chemin = (morceaux.path or "/") + (f"?{morceaux.query}" if morceaux.query else "")
        # §75.3 : la route est relue à CHAQUE relevé. Retirée depuis, ce n'est plus un
        # domaine du Spark : la sonde ne part pas, et le dit.
        if connection.execute(
                "SELECT 1 FROM ingress_route WHERE spark_id = ? AND domain = ? AND tls = 1",
                (spark["id"], domaine)).fetchone() is None:
            return {"ok": False, "latency_ms": None,
                    "detail": f"« {domaine} » n'est plus une route de ce Spark"}
        return releve_http(sondes, domaine, chemin, sonde["expected"])
    return releve_script(incus, {**spark, "docker_mode": _mode_docker(connection, spark)},
                         sonde["target"], sonde["expected"])


def _mode_docker(connection: sqlite3.Connection, spark: dict) -> str | None:
    """Le mode Docker du Spark, lu dans l'observation d'amorçage — là où il vit.

    @spec docs/BACKLOG.md#SPK-184 · docs/DAT.md §75.5 (le compte n'est pas un choix de la ligne : `root`
          sur un Spark enraciné, le compte rootless sur un Spark rootless)

    `docker_mode` n'est PAS une colonne de la ligne `spark` : c'est `spark_bootstrap_observation`. Le lire
    sur la ligne rendait toujours `None`, donc un Spark rootless jouait ses scripts sous `root`, sans
    accès à son socket Docker — `docker ps` y sortait en code 1. Mesuré le 2026-11-18 sur la Forge
    réelle spark-010 ; les doublons passaient un dictionnaire où la clé avait été écrite à la main.
    `None` (jamais amorcé) vaut « enraciné » : le script part sous `root`, comme avant.
    """
    ligne = connection.execute(
        "SELECT docker_mode FROM spark_bootstrap_observation WHERE spark_id = ?",
        (spark["id"],)).fetchone()
    return ligne["docker_mode"] if ligne else None


# --- le registre ------------------------------------------------------------------------------

def _sonde(connection, spark_id: str, nom: str) -> dict | None:
    ligne = connection.execute(
        "SELECT * FROM health_check WHERE spark_id = ? AND name = ?", (spark_id, nom)).fetchone()
    return None if ligne is None else dict(ligne)


def _vue_sonde(connection, sonde: dict) -> dict:
    releves = [dict(r) for r in connection.execute(
        "SELECT run_at, ok, latency_ms, detail FROM health_result WHERE check_id = ?"
        " ORDER BY id DESC LIMIT ?", (sonde["id"], RELEVES_LUS))][::-1]
    for r in releves:
        r["ok"] = bool(r["ok"])
    vue = {k: v for k, v in sonde.items() if k not in ("id", "spark_id")}
    vue["enabled"] = bool(vue["enabled"])
    vue["description"] = cron.decrire(cron.analyser(sonde["schedule"], ecart_minimal=1))
    vue["results"] = releves
    return vue


def lister(connection: sqlite3.Connection, spark: dict) -> dict:
    """Les sondes d'un Spark, leur état, leurs derniers relevés. Ne lit que le registre."""
    lignes = [dict(r) for r in connection.execute(
        "SELECT * FROM health_check WHERE spark_id = ? ORDER BY name", (spark["id"],))]
    return {"checks": [_vue_sonde(connection, s) for s in lignes], "limit": MAX_SONDES}


def _audit(connection, action, spark, sonde, message, payload, result="ok") -> None:
    audit.record(connection, None, action, result, message,
                 target_type="health", target_id=sonde, payload=payload)


# --- les gestes du propriétaire -----------------------------------------------------------------

def tester(connection: sqlite3.Connection, incus, sondes, spark: dict,
           definition: dict) -> dict:
    """Exécute une définition UNE fois, **sans rien écrire** (DAT §75.8).

    Ni compteur, ni état, ni relevé, ni alerte : c'est la simulation qui précède
    l'écriture. Un script exige une cellule en marche.
    """
    sonde = valider(connection, spark, definition)
    if sonde["kind"] == "script" and (spark["state"] != "running" or not spark.get("incus_name")):
        raise SanteError(
            "Le Spark n'est pas en marche : un script s'exécute dans sa cellule.")
    resultat = _executer(connection, incus, sondes, spark, sonde)
    return {**resultat, "kind": sonde["kind"], "target": sonde["target"],
            "expected": sonde["expected"]}


def poser(connection: sqlite3.Connection, spark: dict, definition: dict,
          now: datetime | None = None) -> dict:
    """Pose ou modifie une sonde. Idempotent. Le premier relevé part au pas suivant."""
    now = now or maintenant()
    sonde = valider(connection, spark, definition)
    existante = _sonde(connection, spark["id"], sonde["name"])
    with transaction(connection):
        if existante is None:
            identifiant = token_hex(12)
            connection.execute(
                "INSERT INTO health_check (id, spark_id, name, kind, target, expected,"
                " schedule, threshold, enabled, state, next_run_at, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unknown', ?, ?, ?)",
                (identifiant, spark["id"], sonde["name"], sonde["kind"], sonde["target"],
                 sonde["expected"], sonde["schedule"], sonde["threshold"], _iso(now),
                 _iso(now), _iso(now)))
            verbe = "posée"
        else:
            champs = ("kind", "target", "expected", "schedule", "threshold")
            if all(existante[c] == sonde[c] for c in champs):
                return _vue_sonde(connection, existante)
            # Ce qui est MESURÉ a changé : l'ancien état ne dit plus rien de la nouvelle
            # sonde. Changer seulement la cadence ou le seuil ne remet rien à zéro.
            mesure_change = any(existante[c] != sonde[c] for c in ("kind", "target", "expected"))
            suivante = existante["next_run_at"]
            if existante["schedule"] != sonde["schedule"] and existante["enabled"]:
                suivante = _iso(cron.analyser(
                    sonde["schedule"], ecart_minimal=ECART_MINUTES).prochaine(now))
            connection.execute(
                "UPDATE health_check SET kind = ?, target = ?, expected = ?, schedule = ?,"
                " threshold = ?, next_run_at = ?, updated_at = ?"
                + (", state = 'unknown', consecutive_failures = 0, state_since = NULL,"
                   " last_detail = NULL, last_latency_ms = NULL" if mesure_change else "")
                + " WHERE id = ?",
                (sonde["kind"], sonde["target"], sonde["expected"], sonde["schedule"],
                 sonde["threshold"], suivante, _iso(now), existante["id"]))
            verbe = "modifiée"
        _audit(connection, "health.set", spark, sonde["name"],
               f"Sonde « {sonde['name']} » de « {spark['name']} » {verbe} : "
               f"{sonde['kind']} {sonde['target']}.",
               {"spark": spark["name"], **sonde})
    return _vue_sonde(connection, _sonde(connection, spark["id"], sonde["name"]))


def basculer(connection: sqlite3.Connection, spark: dict, nom: str, *, enabled: bool,
             now: datetime | None = None) -> dict:
    """Suspend ou reprend. Une sonde suspendue ne relève rien et garde son dernier état."""
    now = now or maintenant()
    sonde = _sonde(connection, spark["id"], nom)
    if sonde is None:
        raise SanteError(f"Le Spark « {spark['name']} » n'a pas de sonde « {nom} ».")
    if bool(sonde["enabled"]) == enabled:
        return _vue_sonde(connection, sonde)
    with transaction(connection):
        connection.execute(
            "UPDATE health_check SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            (int(enabled), _iso(now) if enabled else None, _iso(now), sonde["id"]))
        _audit(connection, "health.resume" if enabled else "health.suspend", spark, nom,
               f"Sonde « {nom} » de « {spark['name']} » {'reprise' if enabled else 'suspendue'}.",
               {"spark": spark["name"], "check": nom, "enabled": enabled})
    return _vue_sonde(connection, _sonde(connection, spark["id"], nom))


def retirer(connection: sqlite3.Connection, spark: dict, nom: str) -> dict:
    """Retire une sonde ; son historique disparaît avec elle."""
    sonde = _sonde(connection, spark["id"], nom)
    if sonde is None:
        raise SanteError(f"Le Spark « {spark['name']} » n'a pas de sonde « {nom} ».")
    with transaction(connection):
        connection.execute("DELETE FROM health_check WHERE id = ?", (sonde["id"],))
        _audit(connection, "health.remove", spark, nom,
               f"Sonde « {nom} » de « {spark['name']} » retirée.",
               {"spark": spark["name"], "check": nom})
    return lister(connection, spark)


# --- l'application d'un relevé ---------------------------------------------------------------------

def appliquer(connection: sqlite3.Connection, spark: dict, sonde: dict, resultat: dict,
              now: datetime) -> str | None:
    """Écrit un relevé, fait avancer l'état, émet l'alerte de la transition. Rend l'événement."""
    horaire = cron.analyser(sonde["schedule"], ecart_minimal=1)
    seuil = sonde["threshold"]
    ancien = sonde["state"]
    echecs = sonde["consecutive_failures"]
    deja_alerte = etait_alerte(ancien, echecs, seuil)
    if ancien == "stopped" and echecs < seuil:
        echecs = 0                                   # le compteur repart de zéro (§75.6)
    nouvel, echecs = transition(ancien, echecs, seuil, resultat["ok"])
    depuis = _iso(now) if nouvel != ancien or not sonde["state_since"] else sonde["state_since"]
    evenement_emis = evenement(deja_alerte, nouvel)

    with transaction(connection):
        connection.execute(
            "UPDATE health_check SET state = ?, consecutive_failures = ?, state_since = ?,"
            " last_run_at = ?, last_latency_ms = ?, last_detail = ?, next_run_at = ?,"
            " updated_at = ? WHERE id = ?",
            (nouvel, echecs, depuis, _iso(now), resultat.get("latency_ms"),
             resultat.get("detail"), _iso(horaire.prochaine(now)), _iso(now), sonde["id"]))
        connection.execute(
            "INSERT INTO health_result (check_id, run_at, ok, latency_ms, detail)"
            " VALUES (?, ?, ?, ?, ?)",
            (sonde["id"], _iso(now), int(resultat["ok"]), resultat.get("latency_ms"),
             resultat.get("detail")))
        # L'historique est borné À L'ÉCRITURE : les plus anciens relevés partent (§75.8).
        connection.execute(
            "DELETE FROM health_result WHERE check_id = ? AND id NOT IN ("
            " SELECT id FROM health_result WHERE check_id = ? ORDER BY id DESC LIMIT ?)",
            (sonde["id"], sonde["id"], MAX_RELEVES))
        if evenement_emis:
            charge = {"spark": spark["name"], "check": sonde["name"], "kind": sonde["kind"],
                      "since": depuis, "failures": echecs, "detail": resultat.get("detail")}
            if evenement_emis == "down":
                message = (f"Sonde « {sonde['name']} » du Spark « {spark['name']} » EN PANNE : "
                           f"{echecs} échec(s) consécutif(s)"
                           + (f" — {resultat['detail']}." if resultat.get("detail") else "."))
            else:
                message = (f"Sonde « {sonde['name']} » du Spark « {spark['name']} » "
                           "rétablie.")
            _audit(connection, f"health.{evenement_emis}", spark, sonde["id"], message, charge)
    return evenement_emis


def marquer_arrete(connection: sqlite3.Connection, sonde: dict, now: datetime) -> None:
    """Un Spark arrêté n'est pas malade : l'état devient `stopped`, rien ne s'alerte (§75.6)."""
    horaire = cron.analyser(sonde["schedule"], ecart_minimal=1)
    with transaction(connection):
        connection.execute(
            "UPDATE health_check SET state = 'stopped', state_since = ?, next_run_at = ?,"
            " updated_at = ? WHERE id = ?",
            (sonde["state_since"] if sonde["state"] == "stopped" else _iso(now),
             _iso(horaire.prochaine(now)), _iso(now), sonde["id"]))


def executer_une(connection: sqlite3.Connection, incus, sondes, sonde_id: str,
                 now: datetime) -> dict:
    """Un relevé échu : exécute la sonde, applique le résultat. Ne lève pas pour un échec."""
    ligne = connection.execute("SELECT * FROM health_check WHERE id = ?", (sonde_id,)).fetchone()
    if ligne is None or not ligne["enabled"]:
        return {"resultat": "ignore"}
    sonde = dict(ligne)
    spark = dict(connection.execute("SELECT * FROM spark WHERE id = ?",
                                    (sonde["spark_id"],)).fetchone())
    base = {"spark": spark["name"], "check": sonde["name"]}
    if spark["state"] != "running" or not spark.get("incus_name"):
        marquer_arrete(connection, sonde, now)
        return {**base, "resultat": "stopped"}
    resultat = _executer(connection, incus, sondes, spark, sonde)
    emis = appliquer(connection, spark, sonde, resultat, now)
    return {**base, "resultat": "ok" if resultat["ok"] else "echec", "evenement": emis,
            "detail": resultat.get("detail")}


def echues(connection: sqlite3.Connection, now: datetime) -> list[str]:
    return [r["id"] for r in connection.execute(
        "SELECT id FROM health_check WHERE enabled = 1 AND next_run_at IS NOT NULL"
        " AND next_run_at <= ? ORDER BY next_run_at", (_iso(now),))]


# --- le fil ----------------------------------------------------------------------------------------------

class Sante(threading.Thread):
    """Les relevés des sondes, sur leur propre fil, par un pool borné (DAT §75.8).

    Comme l'historien (§52), le veilleur (§43.5.3) et le planificateur du SLA (§74.5) :
    un fil `daemon`, qui ouvre SA connexion au registre — chaque travailleur du pool
    ouvre la sienne, SQLite interdit d'en partager une —, et qu'une panne n'arrête pas.

    **Quatre travailleurs** : une sonde de 10 secondes ne retarde pas les autres, et un
    Spark qui en porte vingt ne monopolise pas la Forge. Les écritures au journal
    portent l'acteur `sante`, de classe `runtime` ; ce sont les deux transitions de
    `notification.RUNTIME_NOTIFIABLES` qui, seules, partent hors bande.
    """

    def __init__(self, *, ouvrir, incus, sondes, pas: float = PAS, travailleurs: int = POOL):
        super().__init__(name="sparkd-sante", daemon=True)
        self._ouvrir = ouvrir
        self._incus = incus
        self._sondes = sondes
        self.pas = pas
        self._travailleurs = travailleurs
        self._arret = threading.Event()
        self.dernier: list[dict] | None = None
        self.erreurs = 0

    def arreter(self) -> None:
        self._arret.set()

    def _un_releve(self, sonde_id: str, now: datetime) -> dict:
        connection = self._ouvrir()
        try:
            with audit.acting_as(ACTEUR, audit.RUNTIME):
                return executer_une(connection, self._incus, self._sondes, sonde_id, now)
        finally:
            connection.close()

    def un_pas(self, now: datetime | None = None) -> list[dict] | None:
        """Un pas complet. Ne lève jamais : une panne est comptée et reprise au pas suivant."""
        now = now or maintenant()
        connection = None
        try:
            # Ouvrir est DANS le `try` : un registre momentanément indisponible ne doit
            # pas tuer le fil, et avec lui toutes les surveillances.
            connection = self._ouvrir()
            dues = echues(connection, now)
            connection.close()
            connection = None
            if not dues:
                self.dernier = []
                return []
            with ThreadPoolExecutor(max_workers=self._travailleurs) as pool:
                rendus = list(pool.map(lambda i: self._un_releve(i, now), dues))
            self.dernier = rendus
            return rendus
        except Exception:  # noqa: BLE001 — le fil survit, l'erreur est comptée
            self.erreurs += 1
            return None
        finally:
            if connection is not None:
                connection.close()

    def run(self) -> None:
        while not self._arret.is_set():
            self.un_pas()
            self._arret.wait(self.pas)
