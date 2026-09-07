"""Historien d'usage : la mesure dans le temps.

@spec docs/BACKLOG.md#SPK-93 · docs/DAT.md §52 (l'historien), §52.2 (où il vit,
      deux traqueurs), §52.3 (ce qu'une ligne dit), §52.4 (deux causes à un
      trou), §52.5 (rétention), §52.6 (ré-échantillonnage au serveur), §52.7
      (l'agrégat de la Forge), §52.12 (le coût) · §20.1 (`null`, jamais `0`),
      §20.4 (un Spark arrêté) · docs/SCHEMA.md §10 sexies

Le §20 rend l'usage à l'instant où on le demande, et rien d'autre : une console
fermée ne mesure rien. Ce module prend les relevés quand personne ne regarde, les
conserve, et les rend ré-échantillonnés.

Il n'emploie PAS le `RateTracker` de la route `/usage`. Un compteur ne donne un
taux qu'entre deux lectures : deux consommateurs qui partageraient un traqueur
calculeraient chacun leur taux sur la fenêtre ouverte par l'autre, et les deux
seraient faux sans que rien ne le signale (§52.2).
"""

from __future__ import annotations

import math
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

from . import metrics as metrics_service
from .db import transaction
from .incus import IncusError, InstanceAbsente

#: Fenêtres offertes par les deux routes, en secondes. Une fenêtre libre
#: laisserait demander trente jours à une base qui en garde sept, et rendrait un
#: graphique aux trois quarts vide sans que rien ne dise pourquoi.
FENETRES: dict[str, int] = {
    "15m": 900,
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
}
FENETRE_DEFAUT = "1h"

#: Bornes du ré-échantillonnage (§52.6). Le plafond protège la console autant que
#: le serveur : personne ne lit une courbe de mille points sur un écran.
POINTS_DEFAUT = 240
POINTS_MAX = 1000

#: Points d'une micro-courbe, dans la répartition par Spark de l'écran de Forge
#: (SPK-DS-20). Une ligne de tableau haute de vingt pixels ne porte pas deux cent
#: quarante points : les rendre coûterait la bande passante d'un écran entier
#: pour une forme qu'on ne peut pas lire.
POINTS_MICRO = 60

#: Colonnes de mesure, dans l'ordre où elles sont écrites puis moyennées. Une
#: seule liste : ajouter une grandeur ne doit pas demander de la retrouver à
#: quatre endroits.
MESURES = ("cpu_used", "memory_bytes", "disk_bytes", "net_rx_bps", "net_tx_bps")

#: Nom publié de chaque colonne. Le stockage nomme la grandeur, l'API nomme ce
#: que l'écran trace.
PUBLIE = {
    "cpu_used": "cpu",
    "memory_bytes": "memory_bytes",
    "disk_bytes": "disk_bytes",
    "net_rx_bps": "rx_bps",
    "net_tx_bps": "tx_bps",
}

#: Grandeurs entières : un débit moyen en bits par seconde ne gagne rien à
#: porter des décimales, et une mémoire moyenne en fractions d'octet est une
#: précision inventée.
ENTIERS = ("memory_bytes", "disk_bytes", "net_rx_bps", "net_tx_bps")


class FenetreInvalide(ValueError):
    """Fenêtre ou nombre de points hors de ce que le produit offre."""


def maintenant() -> datetime:
    return datetime.now(timezone.utc)


def _iso(instant: datetime) -> str:
    return instant.astimezone(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Le relevé
# --------------------------------------------------------------------------- #

def relever(connection: sqlite3.Connection, incus, rates) -> list[dict]:
    """Un tour de relevé, SANS écrire : rend les lignes à écrire.

    Une ligne par Spark déclaré, et le §52.3 en fixe le contenu :

    - Spark en marche : les mesures que le pilote rend, taux compris dès qu'une
      fenêtre existe. Mémoire et disque sont vraies dès la PREMIÈRE lecture —
      ce sont des grandeurs instantanées, pas des compteurs (§20.1) ;
    - Spark arrêté, en erreur ou transitoire : la ligne existe, ses mesures sont
      toutes `NULL`, et **aucun appel n'est fait au pilote**. Un Spark arrêté n'a
      pas un usage nul, il n'en a pas (§20.4) ;
    - Spark que le pilote ne sait pas mesurer — cellule absente, Incus
      injoignable : **aucune ligne**. C'est le cas « personne n'a relevé » du
      §52.4, et il est exact : personne n'a relevé. Écrire une ligne `running`
      sans mesure la ferait lire comme un premier relevé, c'est-à-dire comme une
      mesure en cours, ce qui serait faux.
    """
    horodatage = _iso(maintenant())
    lignes: list[dict] = []

    for spark in connection.execute(
        "SELECT id, state, incus_name FROM spark ORDER BY name"
    ).fetchall():
        vide = {
            "spark_id": spark["id"],
            "sampled_at": horodatage,
            "state": spark["state"],
            "window_seconds": None,
            **{colonne: None for colonne in MESURES},
        }

        if spark["state"] != "running" or not spark["incus_name"]:
            lignes.append(vide)
            continue

        try:
            etat = incus.instance_state(spark["incus_name"])
        except (InstanceAbsente, IncusError):
            # Le tic d'un Spark ne fait pas tomber celui des autres : une cellule
            # perdue est un fait sur elle, pas une panne de la supervision.
            continue

        taux = rates.observe(spark["id"], metrics_service.read_sample(etat))
        memoire, disque = metrics_service.instantanees(etat)
        lignes.append({
            **vide,
            "window_seconds": taux["window_seconds"],
            "cpu_used": taux["cpu"],
            "memory_bytes": memoire,
            "disk_bytes": disque,
            "net_rx_bps": taux["network_rx_bps"],
            "net_tx_bps": taux["network_tx_bps"],
        })

    return lignes


def ecrire(connection: sqlite3.Connection, lignes: list[dict]) -> None:
    """Écrit un tour de relevé. Une transaction pour tous les Sparks (§52.12)."""
    if not lignes:
        return
    with transaction(connection):
        connection.executemany(
            "INSERT INTO metric_sample (spark_id, sampled_at, state, "
            "window_seconds, cpu_used, memory_bytes, disk_bytes, net_rx_bps, "
            "net_tx_bps) VALUES (:spark_id, :sampled_at, :state, "
            ":window_seconds, :cpu_used, :memory_bytes, :disk_bytes, "
            ":net_rx_bps, :net_tx_bps)",
            lignes,
        )


def purger(connection: sqlite3.Connection, retention_secondes: float,
           reference: datetime | None = None) -> int:
    """Supprime ce qui a dépassé la rétention. Rend le nombre de lignes ôtées.

    Une rétention nulle DÉSACTIVE la purge (§52.5) : le registre croît alors sans
    limite, et c'est une décision d'exploitant, jamais un défaut. Elle ne doit
    surtout pas être lue comme « ne rien garder », ce qui viderait la table à
    chaque tic.
    """
    if retention_secondes <= 0:
        return 0
    limite = _iso((reference or maintenant()) - timedelta(seconds=retention_secondes))
    with transaction(connection):
        curseur = connection.execute(
            "DELETE FROM metric_sample WHERE sampled_at < ?", (limite,))
    return curseur.rowcount


def tic(connection: sqlite3.Connection, incus, rates,
        retention_secondes: float) -> dict:
    """Relève, écrit, purge. Le tour complet d'un tic."""
    lignes = relever(connection, incus, rates)
    ecrire(connection, lignes)
    return {"ecrites": len(lignes), "purgees": purger(connection, retention_secondes)}


# --------------------------------------------------------------------------- #
# La lecture
# --------------------------------------------------------------------------- #

def fenetre(nom: str | None, points: int | None, cadence: float) -> dict:
    """Valide la fenêtre demandée et calcule le pas de seau (§52.6).

    Le nombre de points est PLAFONNÉ pour qu'un seau ne soit jamais plus court
    que la cadence de relevé : demander 240 points sur 15 minutes donnerait des
    seaux de 3,75 s, dont cinq sur six seraient vides. La courbe deviendrait
    pointillée sans qu'aucune mesure ne manque, ce qui ferait chercher une panne
    inexistante.
    """
    nom = nom or FENETRE_DEFAUT
    if nom not in FENETRES:
        raise FenetreInvalide(
            f"Fenêtre « {nom} » inconnue. Attendu l'une de "
            f"{', '.join(FENETRES)}.")

    demandes = POINTS_DEFAUT if points is None else points
    if demandes < 1 or demandes > POINTS_MAX:
        raise FenetreInvalide(
            f"Le nombre de points doit tenir entre 1 et {POINTS_MAX}, reçu "
            f"{demandes}.")

    duree = FENETRES[nom]
    if cadence > 0:
        demandes = min(demandes, max(1, math.ceil(duree / cadence)))
    return {"nom": nom, "seconds": duree, "points": demandes,
            "bucket_seconds": duree / demandes}


def _seaux(lignes, debut: datetime, pas: float, points: int) -> list[dict]:
    """Range les relevés dans leurs seaux, et rend la MOYENNE de chacun.

    Un seau sans relevé rend `null` sur toutes ses grandeurs — jamais `0`, et
    jamais la valeur du seau précédent. Une interpolation ferait apparaître une
    continuité que rien n'a mesurée (§52.6, règle 1).

    Une grandeur peut manquer dans un seau qui en porte d'autres : un Spark
    arrêté n'a ni CPU ni mémoire mais garde son état, et un premier relevé a une
    mémoire sans taux. La moyenne se fait donc grandeur par grandeur, sur les
    seuls relevés qui la portent.
    """
    vides: list[dict] = [
        {"sommes": {c: 0.0 for c in MESURES},
         "compte": {c: 0 for c in MESURES},
         "releves": 0, "etats": set()}
        for _ in range(points)
    ]

    origine = debut.timestamp()
    for ligne in lignes:
        instant = datetime.fromisoformat(ligne["sampled_at"]).timestamp()
        index = int((instant - origine) // pas)
        # Les horodatages sont tronques a la seconde : un releve pris pendant la
        # seconde ou la fenetre se ferme retombe EXACTEMENT sur sa borne haute.
        # Le laisser filer ferait disparaitre le dernier point a chaque
        # rafraichissement — le seul que l'ecran regarde vraiment.
        if index == points:
            index = points - 1
        if not 0 <= index < points:
            continue
        seau = vides[index]
        seau["releves"] += 1
        seau["etats"].add(ligne["state"])
        for colonne in MESURES:
            valeur = ligne[colonne]
            if valeur is not None:
                seau["sommes"][colonne] += valeur
                seau["compte"][colonne] += 1

    rendus: list[dict] = []
    for index, seau in enumerate(vides):
        point = {
            "at": _iso(debut + timedelta(seconds=index * pas)),
            "samples": seau["releves"],
            "states": sorted(seau["etats"]),
        }
        for colonne in MESURES:
            compte = seau["compte"][colonne]
            if compte == 0:
                point[PUBLIE[colonne]] = None
            elif colonne in ENTIERS:
                point[PUBLIE[colonne]] = round(seau["sommes"][colonne] / compte)
            else:
                point[PUBLIE[colonne]] = round(seau["sommes"][colonne] / compte, 4)
        rendus.append(point)
    return rendus


def serie(connection: sqlite3.Connection, spark_id: str, debut: datetime,
          pas: float, points: int) -> list[dict]:
    """Série ré-échantillonnée d'un Spark."""
    fin = debut + timedelta(seconds=pas * points)
    lignes = connection.execute(
        "SELECT sampled_at, state, cpu_used, memory_bytes, disk_bytes, "
        "net_rx_bps, net_tx_bps FROM metric_sample "
        "WHERE spark_id = ? AND sampled_at >= ? AND sampled_at <= ? "
        "ORDER BY sampled_at",
        (spark_id, _iso(debut), _iso(fin)),
    ).fetchall()
    return _seaux(lignes, debut, pas, points)


def agregat(connection: sqlite3.Connection, debut: datetime, pas: float,
            points: int) -> list[dict]:
    """Somme de la Forge, seau par seau, avec le NOMBRE de Sparks sommés (§52.7).

    Les Sparks n'ont pas tous une mesure dans tous les seaux : un Spark créé à
    midi n'en a pas le matin. Une somme dont le nombre de termes varie change de
    marche sans que rien n'ait bougé dans la machine. En publiant `sparks`,
    l'écran peut nommer la marche au lieu de la faire lire comme un incident.
    """
    fin = debut + timedelta(seconds=pas * points)
    lignes = connection.execute(
        "SELECT spark_id, sampled_at, state, cpu_used, memory_bytes, "
        "disk_bytes, net_rx_bps, net_tx_bps FROM metric_sample "
        "WHERE sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at",
        (_iso(debut), _iso(fin)),
    ).fetchall()

    par_spark: dict[str, list] = {}
    for ligne in lignes:
        par_spark.setdefault(ligne["spark_id"], []).append(ligne)

    # La somme porte sur les MOYENNES de seau de chaque Spark, et non sur les
    # relevés bruts : deux Sparks relevés à des instants différents dans le même
    # seau compteraient sinon pour deux points d'une même courbe.
    series = {sid: _seaux(l, debut, pas, points) for sid, l in par_spark.items()}

    total: list[dict] = []
    for index in range(points):
        point = {
            "at": _iso(debut + timedelta(seconds=index * pas)),
            "sparks": 0,
            "samples": 0,
        }
        cumuls: dict[str, float | None] = {PUBLIE[c]: None for c in MESURES}
        compte_par_mesure = {PUBLIE[c]: 0 for c in MESURES}
        for points_spark in series.values():
            seau = points_spark[index]
            if seau["samples"] == 0:
                continue
            # `samples` compte TOUS les releves, y compris ceux d'un Spark
            # arrete : c'est ce qui distingue « il dormait » de « personne n'a
            # releve » (§52.4).
            point["samples"] += seau["samples"]
            porte = False
            for colonne in MESURES:
                nom = PUBLIE[colonne]
                if seau[nom] is None:
                    continue
                porte = True
                cumuls[nom] = (cumuls[nom] or 0) + seau[nom]
                compte_par_mesure[nom] += 1
            # `sparks` ne compte que ceux qui ont CONTRIBUE a la somme. Un Spark
            # arrete a bien une ligne, mais il n'ajoute rien : l'inclure ferait
            # annoncer « somme de 8 Sparks » sous une courbe qui n'en somme que
            # quatre, et le nombre n'expliquerait plus la marche qu'il existe
            # pour expliquer (§52.7).
            if porte:
                point["sparks"] += 1
        for colonne in MESURES:
            nom = PUBLIE[colonne]
            valeur = cumuls[nom]
            if valeur is None:
                point[nom] = None
            elif colonne in ENTIERS:
                point[nom] = round(valeur)
            else:
                point[nom] = round(valeur, 4)
        total.append(point)
    return total


def dernier_releve(connection: sqlite3.Connection,
                   spark_id: str | None = None) -> str | None:
    """Horodatage du dernier relevé écrit, ou `None` s'il n'y en a aucun.

    L'écran l'affiche pour que « la courbe s'arrête » se distingue de « la courbe
    est à zéro ». Une supervision qui a cessé de relever il y a deux heures doit
    se voir sans avoir à compter les points.
    """
    if spark_id is None:
        ligne = connection.execute(
            "SELECT MAX(sampled_at) AS dernier FROM metric_sample").fetchone()
    else:
        ligne = connection.execute(
            "SELECT MAX(sampled_at) AS dernier FROM metric_sample "
            "WHERE spark_id = ?", (spark_id,)).fetchone()
    return ligne["dernier"] if ligne else None


# --------------------------------------------------------------------------- #
# Le fil d'exécution
# --------------------------------------------------------------------------- #

class Historien(threading.Thread):
    """Le tic, sur son propre fil.

    Le fil est `daemon` : `sparkd` s'arrête sans l'attendre. Un relevé perdu à
    l'arrêt ne coûte qu'un point, quand un service qui refuse de s'arrêter coûte
    un déploiement.

    Il ouvre SA connexion au registre. SQLite interdit de partager une connexion
    entre fils, et la partager silencieusement produirait des erreurs qui
    n'apparaîtraient que sous charge.
    """

    def __init__(self, *, ouvrir, incus, interval: float, retention: float):
        super().__init__(name="sparkd-historien", daemon=True)
        self._ouvrir = ouvrir
        self._incus = incus
        self.interval = interval
        self.retention = retention
        self.rates = metrics_service.RateTracker()
        self._arret = threading.Event()
        #: Compte rendu du dernier tic, pour les preuves et le diagnostic.
        self.dernier: dict | None = None
        self.erreurs = 0

    @property
    def actif(self) -> bool:
        """Une cadence nulle désactive l'historien (§52.2)."""
        return self.interval > 0

    def arreter(self) -> None:
        self._arret.set()

    def un_tic(self) -> dict | None:
        """Un tic complet, sur une connexion à soi. Ne lève jamais.

        Une panne de relevé ne doit pas tuer le fil : la supervision cesserait
        alors silencieusement, et le trou qu'elle laisserait serait indiscernable
        d'un arrêt de `sparkd` (§52.4). On compte les erreurs, et on retente au
        tic suivant.
        """
        connection = self._ouvrir()
        try:
            self.dernier = tic(connection, self._incus, self.rates, self.retention)
            return self.dernier
        except Exception:
            self.erreurs += 1
            return None
        finally:
            connection.close()

    def run(self) -> None:
        if not self.actif:
            return
        while not self._arret.is_set():
            self.un_tic()
            self._arret.wait(self.interval)
