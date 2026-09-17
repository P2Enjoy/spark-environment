"""L'isolation réseau des Sparks : ce que porte l'`eth0`, et le geste qui l'applique au parc.

@spec docs/BACKLOG.md#SPK-109 · docs/DAT.md §57.2 (les deux étages : les clés
      de la NIC ici, le verrou `forward` dans `pare_feu`), §57.3 (la migration
      du parc : une opération explicite, un Spark protégé la refuse et reste
      visiblement « non encore isolé »), §57.5 (mesuré le 2026-09-17) ·
      docs/PROD_MIGRATIONS.md#OP-22

L'isolation n'est pas une donnée du registre : c'est la règle du produit, rendue
pour TOUS les Sparks par `translate`. L'état, lui, se lit dans Incus — jamais
dans une étiquette —, et c'est ce que ce module rend au dossier du Spark et à
l'écran de la Forge.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import audit
from . import protection as protection_service
from . import sparks as service
from .incus import IncusError, InstanceAbsente
from .translate import CLES_ISOLATION

INTERFACE = "eth0"


def manquantes(devices: dict[str, Any] | None) -> list[str]:
    """Les clés que l'`eth0` d'une instance ne porte pas. Vide = isolée."""
    nic = (devices or {}).get(INTERFACE) or {}
    return [cle for cle, valeur in CLES_ISOLATION.items()
            if str(nic.get(cle, "")).strip().lower() != valeur]


def _devices(instance: dict[str, Any]) -> dict[str, Any]:
    # Le vrai pilote rend les devices de l'instance ET ceux étendus des profils ;
    # le produit pose l'`eth0` sur l'instance, mais lire les deux ne coûte rien
    # et évite un faux « non isolé » sur une cellule configurée autrement.
    return instance.get("devices") or instance.get("expanded_devices") or {}


def etat_parc(connection: sqlite3.Connection, incus) -> dict[str, Any]:
    """L'état d'isolation de chaque Spark qui a une instance, lu dans Incus.

    Rend `readable: False` — et aucune liste — quand Incus ne répond pas : ne
    pas avoir lu n'est pas avoir lu « non isolé » (docs/DAT.md §31.2).
    """
    try:
        instances = {i.get("name"): i for i in incus.instances()}
    except IncusError as erreur:
        return {"readable": False, "error": str(erreur), "sparks": [],
                "isolated": 0, "pending": 0}
    lignes: list[dict[str, Any]] = []
    for spark in service.listing(connection):
        if not spark.get("incus_name"):
            continue
        instance = instances.get(spark["incus_name"])
        if instance is None:
            lignes.append({"name": spark["name"], "isolated": None, "missing": [],
                           "protected": bool(spark.get("protected")),
                           "reason": "cellule absente"})
            continue
        absentes = manquantes(_devices(instance))
        lignes.append({"name": spark["name"], "isolated": not absentes,
                       "missing": absentes, "protected": bool(spark.get("protected"))})
    return {
        "readable": True,
        "sparks": lignes,
        "isolated": sum(1 for l in lignes if l["isolated"] is True),
        "pending": sum(1 for l in lignes if l["isolated"] is False),
    }


def etat_spark(connection: sqlite3.Connection, incus, name: str) -> dict[str, Any]:
    """L'état d'UN Spark, pour son dossier. `isolated` vaut `None` quand rien
    n'a pu être lu — et la raison le dit."""
    spark = service.by_name(connection, name)
    if not spark.get("incus_name"):
        return {"name": name, "isolated": None, "missing": [],
                "reason": "aucune cellule : le Spark n’est pas encore appliqué"}
    try:
        instances = {i.get("name"): i for i in incus.instances()}
    except IncusError as erreur:
        return {"name": name, "isolated": None, "missing": [],
                "reason": f"Incus n’a pas répondu : {erreur}"}
    instance = instances.get(spark["incus_name"])
    if instance is None:
        return {"name": name, "isolated": None, "missing": [], "reason": "cellule absente"}
    absentes = manquantes(_devices(instance))
    return {"name": name, "isolated": not absentes, "missing": absentes}


def isoler_parc(connection: sqlite3.Connection, incus) -> dict[str, Any]:
    """Le geste « Isoler le parc » (§57.3) : pose les deux clés sur l'`eth0` de
    chaque Spark qui a une instance, une entrée d'audit par Spark.

    Un Spark protégé refuse le geste — c'est une écriture qui le vise (§35.2) —
    et reste « non encore isolé », visiblement, jusqu'à ce que sa protection
    soit levée. Une cellule absente ou un pilote muet ne font pas échouer les
    autres : chaque issue est rendue, nommée, et la suite continue. Un Spark
    qui porte DÉJÀ les deux clés n'est ni touché ni journalisé : il est compté
    à part, sans quoi « 7 isolés » se lirait sur un parc où un seul l'a été.
    """
    # Le vocabulaire des issues est celui du journal d'audit — `ok`, `denied`,
    # `error` — pour qu'une ligne de l'écran et une ligne du journal disent la
    # même chose avec le même mot.
    isoles: list[str] = []
    deja: list[str] = []
    refuses: list[dict[str, str]] = []
    echoues: list[dict[str, str]] = []
    try:
        instances = {i.get("name"): i for i in incus.instances()}
    except IncusError:
        # Sans lecture d'ensemble, on tente chaque Spark : c'est l'écriture
        # qui dira, Spark par Spark, ce qui a échoué.
        instances = {}
    for spark in service.listing(connection):
        if not spark.get("incus_name"):
            continue
        nom = spark["name"]
        instance = instances.get(spark["incus_name"])
        if instance is not None and not manquantes(_devices(instance)):
            deja.append(nom)
            continue
        try:
            protection_service.ensure_writable(connection, nom, "isolate")
        except protection_service.SparkProtected as erreur:
            refuses.append({"name": nom, "reason": str(erreur)})
            audit.record(connection, None, "spark.isolate", "denied", str(erreur),
                         target_type="spark", target_id=spark["id"],
                         payload={"keys": list(CLES_ISOLATION)})
            continue
        try:
            incus.update_device_config(spark["incus_name"], INTERFACE, dict(CLES_ISOLATION))
        except (IncusError, InstanceAbsente) as erreur:
            echoues.append({"name": nom, "reason": str(erreur)})
            audit.record(connection, None, "spark.isolate", "error", str(erreur),
                         target_type="spark", target_id=spark["id"],
                         payload={"keys": list(CLES_ISOLATION)})
            continue
        isoles.append(nom)
        audit.record(connection, None, "spark.isolate", "ok",
                     "eth0 isolée et anti-usurpation posée",
                     target_type="spark", target_id=spark["id"],
                     payload={"keys": list(CLES_ISOLATION)})
    return {"isolated": isoles, "already": deja, "denied": refuses, "error": echoues}
