"""Les projets : ranger les Sparks, sans rien leur faire.

@spec docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.1 (une étiquette : un Spark dans
      zéro, un ou plusieurs projets ; supprimer un projet ne touche aucun Spark ;
      la protection ne s'y applique pas), §61.2 (au registre ; nom de 1 à 40
      caractères, unique sans égard à la casse), §61.3 (la surface d'API et le
      journal) · docs/SCHEMA.md §10 octies

Rien ici n'appelle le pilote, ne projette dans une cellule ni ne lit la
protection : un projet n'atteint pas le Spark. C'est ce qui rend légitime
qu'un Spark protégé se range comme un autre (§61.1).
"""

from __future__ import annotations

import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any

from . import audit
from .db import transaction

#: §61.2 : le nom est libre, mais tient dans un onglet.
LONGUEUR_MAX = 40


class ProjetError(RuntimeError):
    """Le geste est refusé, et la raison se lit."""


class ProjetIntrouvable(ProjetError):
    """Aucun projet de cet identifiant."""


class NomPris(ProjetError):
    """Un autre projet porte déjà ce nom, à la casse près."""


class NomInvalide(ProjetError):
    """Le nom est vide, trop long, ou porte un caractère de contrôle."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _audit(connection, action, target_type, target_id, payload, message):
    audit.record(connection, None, action, "ok", message,
                 target_type=target_type, target_id=target_id, payload=payload)


def normaliser(nom: object) -> str:
    """Le nom tel qu'il sera rangé : bords blancs retirés, puis validé (§61.2).

    Un caractère de contrôle est refusé : il ne se voit pas dans un onglet, et
    deux noms qui ne diffèrent que par lui seraient indiscernables à l'œil.
    """
    if not isinstance(nom, str):
        raise NomInvalide("Le nom d'un projet est un texte.")
    nom = nom.strip()
    if not nom:
        raise NomInvalide("Le nom d'un projet ne peut pas être vide.")
    if len(nom) > LONGUEUR_MAX:
        raise NomInvalide(
            f"Le nom d'un projet tient en {LONGUEUR_MAX} caractères ; celui-ci en compte {len(nom)}.")
    if any(ord(c) < 32 or ord(c) == 127 for c in nom):
        raise NomInvalide("Le nom d'un projet ne peut pas contenir de caractère de contrôle.")
    return nom


def _verifier_libre(connection: sqlite3.Connection, nom: str, sauf: str | None = None) -> None:
    """Unique SANS ÉGARD À LA CASSE (§61.2) — `casefold`, et pas seulement
    l'ASCII que replie `COLLATE NOCASE`."""
    replie = nom.casefold()
    for row in connection.execute("SELECT id, name FROM project"):
        if row["id"] != sauf and row["name"].casefold() == replie:
            raise NomPris(f"Un projet « {row['name']} » existe déjà.")


def _sparks_de(connection: sqlite3.Connection, project_id: str) -> list[str]:
    return [r["name"] for r in connection.execute(
        "SELECT s.name FROM spark_project sp JOIN spark s ON s.id = sp.spark_id"
        " WHERE sp.project_id = ? ORDER BY s.name", (project_id,))]


def get(connection: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    row = connection.execute("SELECT * FROM project WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise ProjetIntrouvable(f"Aucun projet d'identifiant « {project_id} ».")
    return {"id": row["id"], "name": row["name"], "sparks": _sparks_de(connection, row["id"])}


def listing(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    """Les projets par ordre alphabétique — l'ordre des onglets (§61.4)."""
    rows = connection.execute("SELECT id, name FROM project").fetchall()
    rows.sort(key=lambda r: r["name"].casefold())
    return [{"id": r["id"], "name": r["name"], "sparks": _sparks_de(connection, r["id"])}
            for r in rows]


def par_spark(connection: sqlite3.Connection) -> dict[str, list[dict[str, str]]]:
    """Les projets de chaque Spark, pour `GET /v1/sparks` (§61.3)."""
    vus: dict[str, list[dict[str, str]]] = {}
    for r in connection.execute(
            "SELECT sp.spark_id, p.id, p.name FROM spark_project sp"
            " JOIN project p ON p.id = sp.project_id"):
        vus.setdefault(r["spark_id"], []).append({"id": r["id"], "name": r["name"]})
    for liste in vus.values():
        liste.sort(key=lambda p: p["name"].casefold())
    return vus


def create(connection: sqlite3.Connection, nom: object) -> dict[str, Any]:
    nom = normaliser(nom)
    identifiant = secrets.token_hex(12)
    with transaction(connection):
        _verifier_libre(connection, nom)
        try:
            connection.execute("INSERT INTO project (id, name, created_at) VALUES (?, ?, ?)",
                               (identifiant, nom, _now()))
        except sqlite3.IntegrityError as erreur:     # une création simultanée
            raise NomPris(f"Un projet « {nom} » existe déjà.") from erreur
        _audit(connection, "project.create", "project", identifiant, {"name": nom},
               f"projet « {nom} » créé")
    return get(connection, identifiant)


def rename(connection: sqlite3.Connection, project_id: str, nom: object) -> dict[str, Any]:
    nom = normaliser(nom)
    with transaction(connection):
        avant = get(connection, project_id)["name"]
        _verifier_libre(connection, nom, sauf=project_id)
        try:
            connection.execute("UPDATE project SET name = ? WHERE id = ?", (nom, project_id))
        except sqlite3.IntegrityError as erreur:
            raise NomPris(f"Un projet « {nom} » existe déjà.") from erreur
        _audit(connection, "project.rename", "project", project_id,
               {"from": avant, "to": nom}, f"projet « {avant} » renommé « {nom} »")
    return get(connection, project_id)


def delete(connection: sqlite3.Connection, project_id: str) -> list[str]:
    """Supprime le projet ; ses Sparks sont DÉSAFFECTÉS, jamais touchés (§61.1).

    Rend les Sparks désaffectés, que le journal garde aussi : c'est ce que la
    confirmation a nommé.
    """
    with transaction(connection):
        projet = get(connection, project_id)
        connection.execute("DELETE FROM project WHERE id = ?", (project_id,))
        _audit(connection, "project.delete", "project", project_id,
               {"name": projet["name"], "unassigned": projet["sparks"]},
               f"projet « {projet['name']} » supprimé ; Sparks désaffectés : "
               + (", ".join(projet["sparks"]) or "aucun"))
    return projet["sparks"]


def set_for_spark(connection: sqlite3.Connection, spark: dict[str, Any],
                  project_ids: object) -> list[dict[str, str]]:
    """Remplace les projets d'un Spark par cette liste (§61.3).

    Un identifiant inconnu refuse TOUT le geste : ranger à moitié laisserait
    croire que la liste envoyée est celle qui a été écrite.
    """
    if not isinstance(project_ids, list) or not all(isinstance(i, str) for i in project_ids):
        raise NomInvalide("« projects » est une liste d'identifiants de projet.")
    voulus = list(dict.fromkeys(project_ids))
    with transaction(connection):
        connus = {r["id"]: r["name"] for r in connection.execute("SELECT id, name FROM project")}
        inconnus = [i for i in voulus if i not in connus]
        if inconnus:
            raise ProjetIntrouvable(f"Projet(s) inconnu(s) : {', '.join(inconnus)}.")
        avant = sorted((connus[r["project_id"]] for r in connection.execute(
            "SELECT project_id FROM spark_project WHERE spark_id = ?", (spark["id"],))),
            key=str.casefold)
        connection.execute("DELETE FROM spark_project WHERE spark_id = ?", (spark["id"],))
        connection.executemany("INSERT INTO spark_project (spark_id, project_id) VALUES (?, ?)",
                               [(spark["id"], i) for i in voulus])
        apres = sorted((connus[i] for i in voulus), key=str.casefold)
        _audit(connection, "spark.projects.set", "spark", spark["id"],
               {"spark": spark["name"], "before": avant, "after": apres},
               f"« {spark['name']} » rangé dans : " + (", ".join(apres) or "aucun projet"))
    return par_spark(connection).get(spark["id"], [])
