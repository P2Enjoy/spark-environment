"""Le SLA des instantanés : prise automatique et rétention.

@spec docs/BACKLOG.md#SPK-182 · docs/DAT.md §74 (le contrat), §74.2 (la politique),
      §74.3 (la fréquence), §74.4 (le nom), §74.5 (la prise), §74.6 (la rétention),
      §74.7 (l'aperçu précède l'écriture), §74.8 (l'autorisation) ·
      docs/SCHEMA.md §8 ter

Une politique par Spark : une chaîne crontab lue en UTC, une rétention par âge
et/ou par nombre, un état actif ou suspendu. Le planificateur (`Planificateur`,
son propre fil, comme l'historien et le veilleur) prend les instantanés échus et
applique la rétention.

**Ce que ce module garantit, et qui est le sens de toute l'unité** : la
suppression automatique ne détruit que ce qui est à elle.

- elle ne considère que les instantanés d'origine `sla` — la provenance est une
  donnée du registre, jamais le nom ;
- elle garde **toujours le plus récent**, quoi qu'on lui demande ;
- une politique suspendue ne détruit rien ;
- enregistrer une rétention qui supprimerait des instantanés existants REFUSE
  tant que la requête ne porte pas `accept_deletion`, et nomme ce qui serait
  perdu (le §19.1 fait de même pour la restauration).

Le module ne lit pas l'horloge à sa place : chaque fonction prend `now`, ce qui
permet de rejouer des instants passés (le seed) et de prouver les cas limites
sans attendre.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone

from . import audit, cron, snapshots
from .db import transaction

#: Pas du planificateur, en secondes. Fixé par la décision (DAT §74.5), pas par un
#: réglage : le pas dit la précision d'une prise, et une configuration qu'on
#: pourrait pousser à zéro ferait tourner le fil à vide.
PAS = 30.0

#: Une occurrence qui échoue est reprise après ce délai, trois fois au plus, puis
#: abandonnée jusqu'à la suivante (DAT §74.5).
REPRISE_APRES = timedelta(minutes=5)
REPRISES_MAX = 3

#: La rétention est ré-appliquée à cette cadence pour une politique active, en plus
#: de chaque prise : un âge qui s'écoule n'attend pas la prise suivante (DAT §74.6).
PAS_RETENTION = 3600.0

#: Une occurrence échue depuis plus longtemps que deux pas est un RATTRAPAGE : c'est
#: qu'elle a été manquée (panne de `sparkd`), pas qu'elle vient d'arriver.
_TOLERANCE = timedelta(seconds=2 * PAS)

#: États où l'on ne capture pas : la cellule est en train de changer de nature.
ETATS_TRANSITOIRES = frozenset({"creating", "starting", "stopping", "deleting"})

ACTEUR = "sla"


class SlaError(RuntimeError):
    """Politique refusée, avec sa raison pour l'écran."""


class DeletionRequiresConfirmation(SlaError):
    """L'enregistrement supprimerait des instantanés, et la requête ne l'a pas accepté.

    Le refus nomme ce qui serait perdu (DAT §74.7). Même forme que
    `BlockedByNewer` (§19.1) : une perte irréversible ne se produit pas en silence.
    """

    def __init__(self, deletions: list[dict]):
        self.deletions = deletions
        noms = ", ".join(d["name"] for d in deletions)
        super().__init__(
            f"Cette rétention supprimerait {len(deletions)} instantané(s) : {noms}. "
            "Redemander en acceptant explicitement leur suppression.")


# --- le temps ------------------------------------------------------------------------

def maintenant() -> datetime:
    return datetime.now(timezone.utc)


def _iso(instant: datetime) -> str:
    return instant.astimezone(timezone.utc).isoformat(timespec="seconds")


def _lire_iso(texte: str) -> datetime:
    instant = datetime.fromisoformat(texte)
    return instant if instant.tzinfo else instant.replace(tzinfo=timezone.utc)


def nom_sla(instant: datetime) -> str:
    """`SLA_AAAAMMJJ-HHMMSS`, en UTC (DAT §74.4) : triable, sans deux-points."""
    return "SLA_" + instant.astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")


# --- la validation -------------------------------------------------------------------

def valider(schedule: str, retention_days, retention_count) -> cron.Horaire:
    """Refuse avec la raison, ou rend l'horaire analysé.

    Au moins une rétention, dans l'API comme dans la base (DAT §74.2) : un SLA sans
    borne remplirait le quota du Spark (§19.4).
    """
    try:
        horaire = cron.analyser(schedule)
    except cron.ErreurCron as erreur:
        raise SlaError(str(erreur)) from erreur
    if retention_days is None and retention_count is None:
        raise SlaError(
            "Une rétention est obligatoire : un nombre de jours, un nombre "
            "d'instantanés, ou les deux. Sans elle, les instantanés s'accumuleraient "
            "dans le quota du Spark.")
    for nom, valeur, mini, maxi in (("jours", retention_days, 1, 3650),
                                    ("instantanés", retention_count, 1, 1000)):
        if valeur is None:
            continue
        if isinstance(valeur, bool) or not isinstance(valeur, int):
            raise SlaError(f"Rétention en {nom} : un nombre entier est attendu.")
        if not mini <= valeur <= maxi:
            raise SlaError(f"Rétention en {nom} : entre {mini} et {maxi}.")
    return horaire


# --- la rétention : une fonction pure -----------------------------------------------

def a_supprimer(snapshots_sla: list[dict], maintenant_: datetime,
                retention_days: int | None, retention_count: int | None) -> list[str]:
    """Les noms que la rétention supprimerait. Pure : ne lit ni ne supprime rien.

    `snapshots_sla` ne contient que des instantanés d'origine `sla`, du plus ancien
    au plus récent (l'ordre d'insertion, comme `snapshots.listing`).

    - **le plus récent n'est jamais supprimé**, quoi qu'il arrive : une rétention de
      un jour et un `sparkd` arrêté trois jours ne doivent pas laisser un Spark sans
      aucun point de retour ;
    - **par âge** : ceux antérieurs à maintenant moins `retention_days` ;
    - **par nombre** : s'il en reste plus que `retention_count`, les plus anciens
      jusqu'à l'atteindre ;
    - quand les deux sont posées, le premier critère atteint supprime.
    """
    if len(snapshots_sla) <= 1:
        return []
    plus_recent = snapshots_sla[-1]
    sortie: set[str] = set()
    if retention_days is not None:
        limite = maintenant_ - timedelta(days=retention_days)
        for s in snapshots_sla[:-1]:
            if _lire_iso(s["created_at"]) < limite:
                sortie.add(s["incus_name"])
    if retention_count is not None:
        restants = [s for s in snapshots_sla if s["incus_name"] not in sortie]
        exces = len(restants) - retention_count
        for s in restants:
            if exces <= 0 or s is plus_recent:
                break
            sortie.add(s["incus_name"])
            exces -= 1
    return [s["incus_name"] for s in snapshots_sla if s["incus_name"] in sortie]


# --- le registre ----------------------------------------------------------------------

def lire(connection: sqlite3.Connection, spark_id: str) -> dict | None:
    ligne = connection.execute("SELECT * FROM sla WHERE spark_id = ?", (spark_id,)).fetchone()
    return None if ligne is None else dict(ligne)


def _instantanes_sla(connection: sqlite3.Connection, spark_id: str) -> list[dict]:
    return [s for s in snapshots.listing(connection, spark_id) if s["origin"] == "sla"]


def vue(connection: sqlite3.Connection, spark: dict) -> dict:
    """Ce que l'API rend : la politique, sa phrase lisible, ce qu'elle tient."""
    instantanes = _instantanes_sla(connection, spark["id"])
    tailles = [s["size_bytes"] for s in instantanes]
    tenus = {
        "count": len(instantanes),
        # Une taille inconnue n'est pas zéro (§14.6) : la somme n'est rendue que si
        # chacune est connue.
        "size_bytes": (sum(tailles) if tailles and all(t is not None for t in tailles) else None),
    }
    ligne = lire(connection, spark["id"])
    if ligne is None:
        return {"configured": False, "snapshots": tenus}
    ligne["enabled"] = bool(ligne["enabled"])
    ligne["description"] = cron.decrire(cron.analyser(ligne["schedule"]))
    return {"configured": True, **{k: v for k, v in ligne.items() if k != "spark_id"},
            "snapshots": tenus}


#: Ce qu'une entrée du parc reprend de la vue d'un SLA (§74.9) : la MÊME vue, jamais un second
#: modèle. `attempts`, `created_at`, `updated_at` n'aident pas à répondre à « qu'est-ce qui va mal ? ».
_CHAMPS_PARC = ("schedule", "description", "enabled", "next_run_at", "last_run_at", "last_status",
                "last_error", "retention_days", "retention_count", "snapshots")
_RANG_PARC = {"failing": 0, "active": 1, "suspended": 2}


def etat_parc(vue_sla: dict) -> str:
    """`suspended` | `failing` | `active` : exclusifs. Une politique suspendue ne tourne pas, quoi
    qu'elle ait rendu la dernière fois ; une politique qui n'a jamais tourné est active (§76.5)."""
    if not vue_sla["enabled"]:
        return "suspended"
    return "failing" if vue_sla.get("last_status") == "error" else "active"


#: La grille de la charge (DAT §76.3 bis) : des tranches de 15 minutes, du lundi 00:00 UTC.
TRANCHE_MINUTES = 15
TRANCHES_PAR_JOUR = 24 * 60 // TRANCHE_MINUTES
TRANCHES_PAR_SEMAINE = 7 * TRANCHES_PAR_JOUR
PLUS_CHARGEES = 5


def debut_de_semaine(now: datetime) -> datetime:
    """Le lundi 00:00 UTC de la semaine ISO qui contient `now`."""
    jour = now.astimezone(timezone.utc).date()
    lundi = jour - timedelta(days=jour.weekday())
    return datetime(lundi.year, lundi.month, lundi.day, tzinfo=timezone.utc)


def charge_semaine(politiques: list[tuple[str, str]], now: datetime) -> dict:
    """Les prises PRÉVUES de la semaine, rangées par tranche de 15 minutes.

    @spec docs/BACKLOG.md#SPK-188 · docs/DAT.md §76.3 bis (la charge est calculée d'après les
          fréquences, pas observée), §76.5 (on compte des débuts de prise, pas des durées)

    `politiques` : des couples (nom du Spark, chaîne crontab) des SLA qui PRENNENT. Pour chaque jour de
    la semaine que la fréquence retient — `convient_jour`, la sémantique même du planificateur — chaque
    heure × minute de la chaîne est une prise. Pure : l'instant est un argument.
    """
    debut = debut_de_semaine(now)
    tranches = [0] * TRANCHES_PAR_SEMAINE
    noms: list[set[str]] = [set() for _ in range(TRANCHES_PAR_SEMAINE)]
    for nom, chaine in politiques:
        horaire = cron.analyser(chaine)
        for decalage in range(7):
            if not horaire.convient_jour((debut + timedelta(days=decalage)).date()):
                continue
            for heure in sorted(horaire.heures):
                for minute in sorted(horaire.minutes):
                    rang = decalage * TRANCHES_PAR_JOUR + (heure * 60 + minute) // TRANCHE_MINUTES
                    tranches[rang] += 1
                    noms[rang].add(nom)
    chargees = sorted((i for i, n in enumerate(tranches) if n), key=lambda i: (-tranches[i], i))
    return {
        "start": _iso(debut), "slot_minutes": TRANCHE_MINUTES, "slots": tranches,
        "peak": max(tranches), "busy_slots": sum(1 for n in tranches if n),
        "busiest": [{"index": i, "at": _iso(debut + timedelta(minutes=TRANCHE_MINUTES * i)),
                     "count": tranches[i], "sparks": sorted(noms[i])}
                    for i in chargees[:PLUS_CHARGEES]],
        # Qui prend dans une tranche donnée, pour TOUTES les tranches chargées : le survol du graphe
        # les nomme. Les clés sont les rangs en texte (JSON) ; une tranche vide n'a pas d'entrée.
        "sparks_by_slot": {str(i): sorted(noms[i]) for i in chargees},
    }


def charge_des_prises(autres: list[tuple[str, str]], prises: list[datetime], now: datetime) -> dict:
    """Le taux d'occupation des tranches où tombent des prises candidates (SPK-189, DAT §74.14).

    @spec docs/BACKLOG.md#SPK-189 · docs/DAT.md §74.14 (les AUTRES SLA, jamais le candidat ; débuts de prise ;
          taux relatif à la tranche la plus chargée de la semaine), §76.3 bis (la même tranche de 15 minutes)

    `autres` : les couples (nom du Spark, chaîne crontab) des SLA qui PRENNENT, celui du Spark qu'on édite exclu.
    Pour chaque prise candidate : combien de ces SLA prennent dans la même tranche de 15 minutes **ce jour-là** —
    `convient_jour`, la sémantique du planificateur, jour de mois et de semaine compris —, et lesquels. Le taux est
    `others / peak`, borné à 1 ; il vaut 0 quand personne d'autre ne prend (et `peak` vaut alors 0 : jamais de division
    par zéro). Pure : l'instant est un argument.
    """
    pic = charge_semaine(autres, now)["peak"]
    horaires = [(nom, cron.analyser(chaine)) for nom, chaine in autres]
    rendu = []
    for prise in prises:
        minute_du_jour = prise.hour * 60 + prise.minute
        debut_minutes = minute_du_jour - minute_du_jour % TRANCHE_MINUTES
        debut = prise.replace(hour=debut_minutes // 60, minute=debut_minutes % 60, second=0, microsecond=0)
        noms: set[str] = set()
        nombre = 0
        for nom, horaire in horaires:
            if not horaire.convient_jour(prise.date()):
                continue
            for heure in horaire.heures:
                for minute in horaire.minutes:
                    if debut_minutes <= heure * 60 + minute < debut_minutes + TRANCHE_MINUTES:
                        nombre += 1
                        noms.add(nom)
        rendu.append({
            "at": _iso(prise), "slot_start": _iso(debut),
            "slot_end": _iso(debut + timedelta(minutes=TRANCHE_MINUTES)),
            "others": nombre, "sparks": sorted(noms),
            "rate": round(min(1.0, nombre / pic), 3) if pic else 0.0,
        })
    return {"slot_minutes": TRANCHE_MINUTES, "peak": pic, "runs": rendu}


def politiques_des_autres(connection: sqlite3.Connection, spark_id: str) -> list[tuple[str, str]]:
    """Les SLA qui PRENNENT sur la Forge, sauf celui de ce Spark (sa politique en place est celle qu'on remplace).

    Un SLA suspendu ne prend rien et ne charge rien (DAT §76.3 bis) ; actif ou en échec, il prend.
    """
    return [(r["name"], r["schedule"]) for r in connection.execute(
        "SELECT spark.name AS name, sla.schedule AS schedule FROM sla JOIN spark ON spark.id = sla.spark_id"
        " WHERE sla.enabled = 1 AND sla.spark_id != ? ORDER BY spark.name", (spark_id,))]


def parc(connection: sqlite3.Connection, sparks: list[dict], now: datetime | None = None) -> dict:
    """Le SLA de TOUTE la Forge, lu dans le registre et nulle part ailleurs.

    @spec docs/BACKLOG.md#SPK-188 · docs/DAT.md §76.3 (l'agrégation se fait ici, pas dans la console),
          §76.2 (aucune cellule, aucune écriture), §76.5

    Les trois états sont exclusifs et additifs : `configured = active + failing + suspended`. La
    taille cumulée est `None` dès qu'une taille tenue est inconnue — une somme partielle n'est pas un
    total (DESIGN_SYSTEM §14.6) — et vaut 0 quand le SLA ne tient rien : alors c'est un zéro vrai.
    """
    entrees, sans = [], []
    compte = {"active": 0, "failing": 0, "suspended": 0}
    nombre, taille = 0, 0
    for spark in sparks:
        lue = vue(connection, spark)
        if not lue["configured"]:
            sans.append(spark["name"])
            continue
        etat = etat_parc(lue)
        compte[etat] += 1
        tenus = lue["snapshots"]
        nombre += tenus["count"]
        if tenus["count"]:
            taille = None if (taille is None or tenus["size_bytes"] is None) else taille + tenus["size_bytes"]
        entrees.append({"spark": spark["name"], "state": etat, **{c: lue[c] for c in _CHAMPS_PARC}})
    entrees.sort(key=lambda e: (_RANG_PARC[e["state"]], e["spark"]))
    # Un SLA suspendu ne prend rien : il ne charge pas la semaine (§76.3 bis).
    prennent = [(e["spark"], e["schedule"]) for e in entrees if e["state"] != "suspended"]
    return {
        "summary": {"sparks": len(sparks), "configured": len(entrees), **compte,
                    "snapshots_count": nombre, "snapshots_size_bytes": taille},
        "sparks": entrees,
        "without": sorted(sans),
        "week": charge_semaine(prennent, now or maintenant()),
    }


def _audit(connection, action, spark, message, payload, result="ok") -> None:
    audit.record(connection, None, action, result, message,
                 target_type="sla", target_id=spark["id"], payload=payload)


# --- l'aperçu : la simulation qui précède l'écriture ---------------------------------

def apercu(connection: sqlite3.Connection, spark: dict, *, schedule: str,
           retention_days, retention_count, enabled: bool = True,
           now: datetime | None = None) -> dict:
    """Ce que la politique proposée ferait, SANS rien écrire (DAT §74.7).

    Une politique suspendue ne supprime rien : l'aperçu le dit en rendant une liste
    vide, ce que l'enregistrement fera réellement.
    """
    now = now or maintenant()
    horaire = valider(schedule, retention_days, retention_count)
    existants = _instantanes_sla(connection, spark["id"])
    noms = a_supprimer(existants, now, retention_days, retention_count) if enabled else []
    par_nom = {s["incus_name"]: s for s in existants}
    prises = horaire.occurrences(now, 3)
    return {
        "schedule": horaire.source,
        "description": cron.decrire(horaire),
        "next_runs": [_iso(o) for o in prises],
        # SPK-189 · §74.14 : où tombent ces prises, face aux SLA des AUTRES Sparks.
        "load": charge_des_prises(politiques_des_autres(connection, spark["id"]), prises, now),
        "would_delete": [
            {"name": n, "created_at": par_nom[n]["created_at"],
             "size_bytes": par_nom[n]["size_bytes"]} for n in noms],
    }


# --- les gestes du propriétaire ---------------------------------------------------------

def programmer(connection: sqlite3.Connection, spark: dict, incus, *, schedule: str,
               retention_days, retention_count, enabled: bool = True,
               accept_deletion: bool = False, now: datetime | None = None) -> dict:
    """Pose ou modifie la politique. Refuse de supprimer sans l'avoir fait accepter.

    Idempotent : la même politique, enregistrée deux fois, ne bouge ni sa prochaine
    prise ni son état. La protection du Spark est vérifiée par l'appelant (§74.8).
    """
    now = now or maintenant()
    simulation = apercu(connection, spark, schedule=schedule,
                        retention_days=retention_days, retention_count=retention_count,
                        enabled=enabled, now=now)
    if simulation["would_delete"] and not accept_deletion:
        refus = DeletionRequiresConfirmation(simulation["would_delete"])
        # Un refus se journalise HORS transaction : c'est la trace qui sert.
        _audit(connection, "sla.set", spark, str(refus),
               {"spark": spark["name"], "would_delete": [d["name"] for d in simulation["would_delete"]]},
               result="denied")
        raise refus

    normalisee = simulation["schedule"]
    existante = lire(connection, spark["id"])
    prochaine = _iso(cron.analyser(normalisee).prochaine(now)) if enabled else None
    with transaction(connection):
        if existante is None:
            connection.execute(
                "INSERT INTO sla (spark_id, enabled, schedule, retention_days, retention_count,"
                " next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (spark["id"], int(enabled), normalisee, retention_days, retention_count,
                 prochaine, _iso(now), _iso(now)))
            verbe = "posée"
        else:
            horaire_change = existante["schedule"] != normalisee
            reprise = enabled and not existante["enabled"]
            identique = (not horaire_change and bool(existante["enabled"]) == enabled
                         and existante["retention_days"] == retention_days
                         and existante["retention_count"] == retention_count)
            if identique:
                return vue(connection, spark)
            # La prochaine prise ne se recalcule que si la fréquence change ou si l'on
            # reprend : modifier la seule rétention ne décale pas la prochaine prise.
            if not enabled:
                suivante = None
            elif horaire_change or reprise or not existante["next_run_at"]:
                suivante = prochaine
            else:
                suivante = existante["next_run_at"]
            connection.execute(
                "UPDATE sla SET enabled = ?, schedule = ?, retention_days = ?,"
                " retention_count = ?, next_run_at = ?, attempts = 0, updated_at = ?"
                " WHERE spark_id = ?",
                (int(enabled), normalisee, retention_days, retention_count, suivante,
                 _iso(now), spark["id"]))
            verbe = "modifiée"
        _audit(connection, "sla.set",
               spark, f"Politique SLA de « {spark['name']} » {verbe} : {normalisee}, "
               f"rétention {_texte_retention(retention_days, retention_count)}.",
               {"spark": spark["name"], "schedule": normalisee, "enabled": enabled,
                "retention_days": retention_days, "retention_count": retention_count})

    # La rétention s'applique dès l'enregistrement, et c'est ce que l'aperçu a montré.
    if enabled:
        purger(connection, spark, incus, now)
    return vue(connection, spark)


def _texte_retention(jours, nombre) -> str:
    morceaux = []
    if jours is not None:
        morceaux.append(f"{jours} jour(s)")
    if nombre is not None:
        morceaux.append(f"{nombre} instantané(s) au plus")
    return " et ".join(morceaux)


def basculer(connection: sqlite3.Connection, spark: dict, *, enabled: bool,
             now: datetime | None = None) -> dict:
    """Suspend ou reprend. Suspendre gèle TOUT : plus de prise, plus de suppression.

    Reprendre repart de maintenant : les prises manquées pendant la pause ne sont
    pas rattrapées, c'est ce que « suspendu » voulait dire.
    """
    now = now or maintenant()
    ligne = lire(connection, spark["id"])
    if ligne is None:
        raise SlaError(f"Le Spark « {spark['name']} » n'a pas de SLA.")
    if bool(ligne["enabled"]) == enabled:
        return vue(connection, spark)
    suivante = _iso(cron.analyser(ligne["schedule"]).prochaine(now)) if enabled else None
    with transaction(connection):
        connection.execute(
            "UPDATE sla SET enabled = ?, next_run_at = ?, attempts = 0, updated_at = ?"
            " WHERE spark_id = ?", (int(enabled), suivante, _iso(now), spark["id"]))
        _audit(connection, "sla.resume" if enabled else "sla.suspend", spark,
               f"Politique SLA de « {spark['name']} » "
               f"{'reprise' if enabled else 'suspendue'}.",
               {"spark": spark["name"], "enabled": enabled})
    return vue(connection, spark)


def retirer(connection: sqlite3.Connection, spark: dict) -> dict:
    """Retire la politique. **Aucun instantané n'est supprimé** (DAT §74.2)."""
    if lire(connection, spark["id"]) is None:
        raise SlaError(f"Le Spark « {spark['name']} » n'a pas de SLA.")
    conserves = len(_instantanes_sla(connection, spark["id"]))
    with transaction(connection):
        connection.execute("DELETE FROM sla WHERE spark_id = ?", (spark["id"],))
        _audit(connection, "sla.remove", spark,
               f"Politique SLA de « {spark['name']} » retirée ; "
               f"{conserves} instantané(s) conservé(s).",
               {"spark": spark["name"], "kept": conserves})
    return vue(connection, spark)


# --- la rétention appliquée ----------------------------------------------------------

def purger(connection: sqlite3.Connection, spark: dict, incus,
           now: datetime | None = None) -> list[str]:
    """Applique la rétention d'un Spark. Rend les noms réellement supprimés.

    Une politique absente ou suspendue ne supprime rien. Un échec sur un
    instantané est journalisé et n'arrête pas les suivants. Les suppressions
    passent par `snapshots.delete` : même écriture, même journal, et — le jour où
    SPK-164 existera — la même garde sur la sauvegarde externe (DAT §74.9).
    """
    now = now or maintenant()
    ligne = lire(connection, spark["id"])
    if ligne is None or not ligne["enabled"]:
        return []
    noms = a_supprimer(_instantanes_sla(connection, spark["id"]), now,
                       ligne["retention_days"], ligne["retention_count"])
    supprimes: list[str] = []
    for nom in noms:
        try:
            snapshots.delete(connection, spark, nom, incus)
            supprimes.append(nom)
        except Exception as erreur:  # noqa: BLE001 — journalisé, les suivants continuent
            audit.record(connection, None, "snapshot.delete", "error",
                         f"Rétention SLA : « {nom} » n'a pas pu être supprimé : {erreur}",
                         target_type="snapshot", target_id=nom,
                         payload={"spark": spark["name"], "snapshot": nom})
    return supprimes


def purger_tous(connection: sqlite3.Connection, incus,
                now: datetime | None = None) -> dict[str, list[str]]:
    """La rétention de toutes les politiques actives (cadence horaire)."""
    now = now or maintenant()
    rendu: dict[str, list[str]] = {}
    for ligne in connection.execute("SELECT spark_id FROM sla WHERE enabled = 1").fetchall():
        spark = connection.execute("SELECT * FROM spark WHERE id = ?",
                                   (ligne["spark_id"],)).fetchone()
        if spark is None:
            continue
        supprimes = purger(connection, dict(spark), incus, now)
        if supprimes:
            rendu[spark["name"]] = supprimes
    return rendu


# --- la prise ---------------------------------------------------------------------------

def _manquees(horaire: cron.Horaire, due: datetime, now: datetime) -> int:
    """Combien d'occurrences APRÈS celle qui est échue sont aussi passées."""
    n = 0
    courante = due
    while n < 1000:
        courante = horaire.prochaine(courante)
        if courante > now:
            break
        n += 1
    return n


def _maj(connection, spark_id, **champs) -> None:
    colonnes = ", ".join(f"{k} = ?" for k in champs)
    connection.execute(f"UPDATE sla SET {colonnes} WHERE spark_id = ?",
                       (*champs.values(), spark_id))


def executer_une(connection: sqlite3.Connection, incus, ligne: dict,
                 now: datetime) -> dict:
    """Une politique échue : prend l'instantané, reprogramme, applique la rétention."""
    spark = connection.execute("SELECT * FROM spark WHERE id = ?", (ligne["spark_id"],)).fetchone()
    horaire = cron.analyser(ligne["schedule"])
    rapport = {"spark": None if spark is None else spark["name"], "resultat": None}
    if spark is None:
        return {**rapport, "resultat": "absent"}
    spark = dict(spark)

    if not spark.get("incus_name") or spark["state"] in ETATS_TRANSITOIRES:
        raison = ("le Spark n'a pas encore de cellule" if not spark.get("incus_name")
                  else f"le Spark est en transition ({spark['state']})")
        with transaction(connection):
            _maj(connection, spark["id"], last_status="skipped", last_error=raison,
                 next_run_at=_iso(now + timedelta(seconds=PAS)), updated_at=_iso(now))
        return {**rapport, "resultat": "skipped", "raison": raison}

    due = _lire_iso(ligne["next_run_at"])
    rattrapage = ligne["attempts"] == 0 and now - due > _TOLERANCE
    manquees = _manquees(horaire, due, now) if rattrapage else 0
    nom = nom_sla(now)
    if any(s["incus_name"] == nom for s in snapshots.listing(connection, spark["id"])):
        # Deux prises dans la même seconde : rien à faire, la suivante arrive.
        with transaction(connection):
            _maj(connection, spark["id"], next_run_at=_iso(horaire.prochaine(now)),
                 updated_at=_iso(now))
        return {**rapport, "resultat": "deja_pris"}

    try:
        snapshots.create(connection, spark, nom, incus, origin="sla", created_at=_iso(now))
    except Exception as erreur:  # noqa: BLE001 — l'échec est dit, jamais tu (DAT §74.5)
        tentatives = ligne["attempts"] + 1
        abandon = tentatives > REPRISES_MAX
        suivante = horaire.prochaine(now) if abandon else now + REPRISE_APRES
        with transaction(connection):
            _maj(connection, spark["id"], last_run_at=_iso(now), last_status="error",
                 last_error=str(erreur), attempts=0 if abandon else tentatives,
                 next_run_at=_iso(suivante), updated_at=_iso(now))
            audit.record(connection, None, "snapshot.create", "error",
                         f"Prise SLA de « {spark['name']} » en échec : {erreur}",
                         target_type="sla", target_id=spark["id"],
                         payload={"spark": spark["name"], "snapshot": nom,
                                  "attempt": tentatives, "abandoned": abandon})
        return {**rapport, "resultat": "error", "erreur": str(erreur), "abandon": abandon}

    with transaction(connection):
        _maj(connection, spark["id"], last_run_at=_iso(now), last_status="ok",
             last_error=None, attempts=0, next_run_at=_iso(horaire.prochaine(now)),
             updated_at=_iso(now))
        if rattrapage:
            audit.record(connection, None, "sla.catchup", "ok",
                         f"Rattrapage SLA de « {spark['name']} » : « {nom} » pris, "
                         f"{manquees + 1} occurrence(s) échue(s) depuis {ligne['next_run_at']}.",
                         target_type="sla", target_id=spark["id"],
                         payload={"spark": spark["name"], "snapshot": nom,
                                  "due": ligne["next_run_at"], "missed": manquees + 1})
    supprimes = purger(connection, spark, incus, now)
    return {**rapport, "resultat": "ok", "snapshot": nom, "rattrapage": rattrapage,
            "supprimes": supprimes}


def executer_echus(connection: sqlite3.Connection, incus,
                   now: datetime | None = None) -> list[dict]:
    """Toutes les politiques actives dont la prochaine prise est échue."""
    now = now or maintenant()
    lignes = [dict(r) for r in connection.execute(
        "SELECT * FROM sla WHERE enabled = 1 AND next_run_at IS NOT NULL"
        " AND next_run_at <= ? ORDER BY next_run_at", (_iso(now),))]
    return [executer_une(connection, incus, ligne, now) for ligne in lignes]


# --- le fil -------------------------------------------------------------------------------

class Planificateur(threading.Thread):
    """Les prises du SLA, sur leur propre fil (DAT §74.5).

    Comme l'historien (§52) et le veilleur (§43.5.3) : un fil `daemon`, qui ouvre SA
    connexion au registre (SQLite interdit d'en partager une entre fils), et qu'une
    panne n'arrête pas. Une panne de prise est comptée et reprise au pas suivant —
    la taire reviendrait à perdre des instantanés sans que rien ne le dise.

    Ses écritures au journal portent l'acteur `sla`, de classe `runtime` : personne
    ne les a demandées une à une (DAT §36.4).
    """

    def __init__(self, *, ouvrir, incus, pas: float = PAS):
        super().__init__(name="sparkd-sla", daemon=True)
        self._ouvrir = ouvrir
        self._incus = incus
        self.pas = pas
        self._arret = threading.Event()
        self._derniere_retention = 0.0
        self.dernier: list[dict] | None = None
        self.erreurs = 0

    def arreter(self) -> None:
        self._arret.set()

    def un_pas(self, now: datetime | None = None, *, retention: bool | None = None) -> list[dict] | None:
        """Un pas complet, sur une connexion à soi. Ne lève jamais."""
        now = now or maintenant()
        connection = None
        try:
            # Ouvrir la connexion est DANS le `try` : un registre momentanément
            # indisponible est une panne comptée et reprise au pas suivant, pas la
            # mort du fil — et avec elle de toutes les prises à venir.
            connection = self._ouvrir()
            with audit.acting_as(ACTEUR, audit.RUNTIME):
                rendus = executer_echus(connection, self._incus, now)
                horloge = now.timestamp()
                if retention or (retention is None
                                 and horloge - self._derniere_retention >= PAS_RETENTION):
                    purger_tous(connection, self._incus, now)
                    self._derniere_retention = horloge
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
