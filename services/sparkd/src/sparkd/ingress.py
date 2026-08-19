"""Ingress : routes publiques et réconciliation de Caddy.

@spec docs/BACKLOG.md#SPK-12 · docs/DAT.md §9 (Ingress), §18 (Réconciliation),
      §18.1 (on régénère), §18.4 (unicité) · docs/SCHEMA.md §6

On régénère la configuration entière, on ne la rapièce pas. Une configuration
rapiécée diverge ; une configuration régénérée ne le peut pas.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from secrets import token_hex

import httpx

from . import audit
from .db import transaction

SERVER_NAME = "spark"

#: Un nom d'hôte, éventuellement avec un joker de premier niveau.
DOMAIN = re.compile(
    r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.IGNORECASE
)


class IngressError(RuntimeError):
    """Route refusée, ou Caddy injoignable."""


@dataclass
class Caddy:
    """Client de l'API d'administration, sur la boucle locale (docs/DAT.md §5)."""

    admin_url: str = "http://127.0.0.1:2019"
    timeout: float = 10.0

    def load(self, config: dict) -> None:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                reponse = client.post(f"{self.admin_url}/load", json=config)
                reponse.raise_for_status()
        except httpx.HTTPError as erreur:
            raise IngressError(
                f"Caddy injoignable ou configuration refusée ({self.admin_url}) : "
                f"{erreur}"
            ) from erreur

    def current(self) -> dict:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                reponse = client.get(f"{self.admin_url}/config/")
                reponse.raise_for_status()
                return reponse.json() or {}
        except httpx.HTTPError as erreur:
            raise IngressError(f"Caddy injoignable : {erreur}") from erreur


@dataclass
class FakeCaddy:
    """Caddy factice, pour éprouver la génération sans démon."""

    config: dict | None = None
    fail: bool = False

    def load(self, config: dict) -> None:
        if self.fail:
            raise IngressError("Caddy factice en échec, sur demande.")
        self.config = config

    def current(self) -> dict:
        return self.config or {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _audit(connection, actor, action, target, payload, result, message) -> None:
    audit.record(connection, actor, action, result, message,
                 target_type="ingress_route", target_id=target, payload=payload)


def declare(
    connection: sqlite3.Connection, spark_id: str, domain: str, port: int,
    tls: bool = True, actor: str | None = None,
) -> dict:
    """Déclare une route. L'unicité du domaine est portée par la base."""
    nom = domain.strip().lower()
    if not DOMAIN.match(nom):
        raise IngressError(
            f"Domaine « {domain} » invalide. Attendu un nom d'hôte complet, "
            "par exemple « crm.example.com »."
        )
    if not 1 <= port <= 65535:
        raise IngressError(f"Port {port} hors bornes.")

    identifiant = token_hex(12)
    with transaction(connection):
        existante = connection.execute(
            "SELECT r.domain, s.name FROM ingress_route r"
            " JOIN spark s ON s.id = r.spark_id WHERE r.domain = ?", (nom,)
        ).fetchone()
        if existante:
            raise IngressError(
                f"Le domaine « {nom} » est déjà routé vers le Spark "
                f"« {existante['name']} »."
            )
        connection.execute(
            "INSERT INTO ingress_route (id, domain, spark_id, target_port, tls, enabled)"
            " VALUES (?, ?, ?, ?, ?, 1)",
            (identifiant, nom, spark_id, port, 1 if tls else 0),
        )
        _audit(connection, actor, "ingress.declare", identifiant,
               {"domain": nom, "spark_id": spark_id, "port": port, "tls": tls},
               "ok", f"{nom} → port {port}.")
    return get(connection, identifiant)


def get(connection: sqlite3.Connection, route_id: str) -> dict:
    row = connection.execute(
        "SELECT * FROM ingress_route WHERE id = ?", (route_id,)
    ).fetchone()
    if row is None:
        raise IngressError(f"Aucune route d'identifiant « {route_id} ».")
    return dict(row)


def by_domain(connection: sqlite3.Connection, domain: str) -> dict:
    row = connection.execute(
        "SELECT * FROM ingress_route WHERE domain = ?", (domain.strip().lower(),)
    ).fetchone()
    if row is None:
        raise IngressError(f"Aucune route pour « {domain} ».")
    return dict(row)


def listing(connection: sqlite3.Connection) -> list[dict]:
    return [
        dict(r) for r in connection.execute(
            "SELECT r.*, s.name AS spark_name, s.ipv4_address"
            " FROM ingress_route r JOIN spark s ON s.id = r.spark_id"
            " ORDER BY r.domain"
        )
    ]


def withdraw(connection: sqlite3.Connection, domain: str,
             actor: str | None = None) -> None:
    route = by_domain(connection, domain)
    with transaction(connection):
        connection.execute("DELETE FROM ingress_route WHERE id = ?", (route["id"],))
        _audit(connection, actor, "ingress.withdraw", route["id"],
               {"domain": route["domain"]}, "ok", f"{route['domain']} retiré.")


def build_config(connection: sqlite3.Connection) -> dict:
    """Construit la configuration COMPLÈTE de Caddy depuis le registre.

    Seules les routes actives d'un Spark ayant une adresse sont émises : une
    route déclarée sur un Spark encore `pending` existe — on déclare avant de
    créer — mais rien ne peut la servir (docs/DAT.md §18.2).
    """
    routes = []
    for route in listing(connection):
        if not route["enabled"] or not route["ipv4_address"]:
            continue
        routes.append({
            "match": [{"host": [route["domain"]]}],
            "handle": [{
                "handler": "reverse_proxy",
                # L'amont vient du REGISTRE, jamais d'une découverte par Docker
                # ou par étiquettes (docs/DAT.md §18.2, §2).
                "upstreams": [{"dial": f"{route['ipv4_address']}:{route['target_port']}"}],
            }],
        })

    # Route terminale : sans elle, Caddy rend « 200 » et un corps vide pour
    # TOUT domaine non routé — mesuré le 2026-08-19. L'hôte répondrait alors
    # pour des noms qu'il ne sert pas, et une erreur de pointage DNS resterait
    # invisible au lieu de se voir immédiatement (docs/DAT.md §18.2).
    routes.append({
        "handle": [{
            "handler": "static_response",
            "status_code": 404,
            "headers": {"Content-Type": ["text/plain; charset=utf-8"]},
            "body": "Aucun Spark ne sert ce domaine.\n",
        }],
    })

    serveur: dict = {"listen": [":80", ":443"], "routes": routes}
    en_clair = [r["domain"] for r in listing(connection) if not r["tls"] and r["enabled"]]
    if en_clair:
        # Une route en clair est explicitement soustraite à la gestion
        # automatique du TLS, sans quoi Caddy tenterait d'émettre un
        # certificat que personne n'a demandé (docs/DAT.md §18.3).
        serveur["automatic_https"] = {"skip": sorted(en_clair)}

    return {"apps": {"http": {"servers": {SERVER_NAME: serveur}}}}


def reconcile(connection: sqlite3.Connection, caddy, actor: str = "sparkd") -> dict:
    """Régénère et applique. C'est le mécanisme NORMAL, pas une réparation."""
    # §36.4 : c'est un ÉVÉNEMENT DU RUNTIME. Souvent déclenché par une
    # requête humaine, il n'est pas demandé par elle — sans cette
    # déclaration le journal ferait croire qu'une personne l'a réclamé.
    with audit.as_runtime(actor or "sparkd"):
        config = build_config(connection)
        # On compte les routes SERVIES : la route terminale de refus n'en est pas
        # une, et l'annoncer fausserait le nombre que lit l'exploitant.
        nb = sum(
            1 for r in config["apps"]["http"]["servers"][SERVER_NAME]["routes"]
            if "match" in r
        )
        try:
            caddy.load(config)
        except IngressError as erreur:
            with transaction(connection):
                _audit(connection, actor, "ingress.reconcile", None,
                       {"routes": nb}, "error", str(erreur))
            raise
        with transaction(connection):
            connection.execute(
                "UPDATE ingress_route SET applied_at = ? WHERE enabled = 1"
                " AND spark_id IN (SELECT id FROM spark WHERE ipv4_address IS NOT NULL)",
                (_now(),),
            )
            _audit(connection, actor, "ingress.reconcile", None,
                   {"routes": nb}, "ok", f"{nb} route(s) appliquée(s).")
        return {"routes": nb, "config": config}
