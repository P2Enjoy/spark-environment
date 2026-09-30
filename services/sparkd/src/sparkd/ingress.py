"""Ingress : routes publiques et réconciliation de Caddy.

@spec docs/BACKLOG.md#SPK-12 · docs/DAT.md §9 (Ingress), §18 (Réconciliation),
      §18.1 (on régénère), §18.4 (unicité) · docs/SCHEMA.md §6
@spec docs/BACKLOG.md#SPK-48 · docs/DAT.md §18.3 bis (le joker de premier
      niveau, ses trois bornes, et la préséance du plus spécifique)
@spec docs/BACKLOG.md#SPK-77 · docs/DAT.md §38.8.4 (le rapprochement d'un nom
      DNS avec les routes se fait ICI, jamais dans la console)
@spec docs/BACKLOG.md#SPK-89 · docs/DAT.md §18.3 ter (la cible d'une route se
      corrige, elle ne se refait pas) · §18.5 (l'écart reste visible)
@spec docs/BACKLOG.md#SPK-128 · docs/DAT.md §18.2 (protocoles déclarés, route
      commune), §18.6 (l'ingress ne sert pas HTTP/3, et le dit)
@spec docs/BACKLOG.md#SPK-141 · docs/DAT.md §18.8 (une route ne sort du registre
      qu'une fois Caddy confirmé)

On régénère la configuration entière, on ne la rapièce pas. Une configuration
rapiécée diverge ; une configuration régénérée ne le peut pas.
"""

from __future__ import annotations

import copy
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

#: SPK-128 · §18.6 : les protocoles que l'ingress SERT, déclarés. Laisser Caddy
#: choisir, c'est recevoir HTTP/3 par défaut : Caddy 2.6.2 écoute alors UDP/443
#: et l'annonce sur chaque réponse, alors que la poignée de main n'aboutit pas —
#: mesuré le 2026-09-30. Chaque visiteur payait l'attente de son repli.
PROTOCOLES = ("h1", "h2")

#: Un nom d'hôte, éventuellement avec un joker de premier niveau (§18.3 bis).
DOMAIN = re.compile(
    r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.IGNORECASE
)

#: Un nom d'hôte SANS joker. Sert à nommer précisément la borne enfreinte.
STRICT = re.compile(
    r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.IGNORECASE
)


def is_wildcard(domain: str) -> bool:
    """Le domaine porte-t-il le joker de premier niveau ?"""
    return domain.startswith("*.")


def covers(pattern: str, domain: str) -> bool:
    """`pattern` sert-il `domain` ? (§18.3 bis)

    Un joker couvre **un seul niveau** : `*.monapi.fr` sert `api.monapi.fr`, et
    ne sert PAS `a.b.monapi.fr`. C'est la règle du DNS et celle de Caddy ; en
    adopter une autre ferait diverger ce que le produit affiche de ce que le
    trafic fait réellement.
    """
    if pattern == domain:
        return True
    if not is_wildcard(pattern) or is_wildcard(domain):
        return False
    suffixe = pattern[1:]                      # « .monapi.fr »
    if not domain.endswith(suffixe):
        return False
    tete = domain[: -len(suffixe)]
    return bool(tete) and "." not in tete


def specificity(domain: str) -> tuple[int, int, str]:
    """Clé de tri : le plus SPÉCIFIQUE d'abord (§18.3 bis).

    Caddy retient la PREMIÈRE route dont le filtre correspond. Trier par ordre
    alphabétique — ce que faisait le listing — plaçait `*.monapi.fr` avant
    `api.monapi.fr`, parce que « * » précède les lettres : le joker gagnait, à
    l'exact inverse de la règle. Mesuré.

    Un nom exact passe donc avant tout joker ; entre deux jokers, le plus long
    d'abord, puisqu'il couvre moins de noms.
    """
    return (1 if is_wildcard(domain) else 0, -len(domain), domain)


def covering(connection: sqlite3.Connection, domain: str,
             exclude_spark: str | None = None) -> dict | None:
    """La route JOKER d'un autre Spark qui servait déjà ce nom, s'il y en a une.

    §18.3 bis : la déclaration réussit, mais l'écran doit NOMMER le Spark dont
    elle prend le pas. Un exploitant qui déclare `admin.monapi.fr` doit savoir
    qu'il vient de détourner une adresse qui partait ailleurs — le silence ici
    produirait une panne cherchée pendant des heures du mauvais côté.
    """
    if is_wildcard(domain):
        return None
    candidates = [
        dict(r) for r in connection.execute(
            "SELECT r.domain, r.spark_id, s.name AS spark_name FROM ingress_route r"
            " JOIN spark s ON s.id = r.spark_id"
            " WHERE r.domain LIKE '*.%' AND r.enabled = 1"
        )
        if covers(r["domain"], domain) and r["spark_id"] != exclude_spark
    ]
    candidates.sort(key=lambda r: specificity(r["domain"]))
    return candidates[0] if candidates else None


def match(connection: sqlite3.Connection, domains: list[str]) -> dict:
    """Pour chaque nom, la route qui le SERT, ou `None` (§38.8.4).

    La console relève dans le DNS les noms qui pointent vers la Forge et doit
    savoir lesquels sont servis. Elle ne fait pas ce rapprochement elle-même :
    `covers` doit rester identique à ce que fait Caddy, et une seconde
    implémentation en JavaScript divergerait à la première correction. Le
    désaccord se solderait par un nom déclaré perdu alors qu'il est servi —
    c'est-à-dire par une suppression fausse.

    Une route DÉSACTIVÉE ne sert rien : Caddy ne la porte pas. La compter ici
    ferait passer pour servi un nom qui rend une erreur.

    La clé rendue est le nom TEL QU'IL A ÉTÉ DEMANDÉ : l'appelant a relevé ses
    noms dans une zone et doit pouvoir s'y retrouver sans refaire la
    normalisation.
    """
    routes = [
        dict(r) for r in connection.execute(
            "SELECT r.domain, s.name AS spark_name FROM ingress_route r"
            " JOIN spark s ON s.id = r.spark_id WHERE r.enabled = 1"
        )
    ]
    resultat: dict = {}
    for brut in domains:
        nom = str(brut).strip().lower().rstrip(".")
        servantes = [r for r in routes if covers(r["domain"], nom)]
        servantes.sort(key=lambda r: specificity(r["domain"]))
        resultat[brut] = (
            {"domain": servantes[0]["domain"], "spark_name": servantes[0]["spark_name"]}
            if servantes else None
        )
    return resultat


class IngressError(RuntimeError):
    """Route refusée, ou Caddy injoignable."""


class RetraitNonConfirme(IngressError):
    """Caddy n'a pas confirmé qu'il ne sert plus la route : elle reste (§18.8)."""


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
        # SPK-130 · §18.7 : un Caddy injoignable ne répond à RIEN — ni à la
        # pose, ni à la lecture de sa configuration vivante.
        if self.fail:
            raise IngressError("Caddy factice en échec, sur demande.")
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
        # §18.3 bis : le refus NOMME la borne enfreinte. « invalide » seul
        # laisserait chercher entre une faute de frappe et une règle du produit.
        if "*" in nom:
            raise IngressError(
                f"Domaine « {domain} » invalide. Un joker ne vaut qu'en TÊTE et "
                "sur UN seul niveau : « *.monapi.fr » est accepté, "
                "« *.*.monapi.fr », « api.*.monapi.fr » et « *.fr » ne le sont pas."
            )
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
        # §18.3 bis : relevé AVANT l'insertion, sinon la route qu'on ajoute
        # figurerait parmi les candidates et se couvrirait elle-même.
        prise = covering(connection, nom, exclude_spark=spark_id)
        connection.execute(
            "INSERT INTO ingress_route (id, domain, spark_id, target_port, tls, enabled)"
            " VALUES (?, ?, ?, ?, ?, 1)",
            (identifiant, nom, spark_id, port, 1 if tls else 0),
        )
        _audit(connection, actor, "ingress.declare", identifiant,
               {"domain": nom, "spark_id": spark_id, "port": port, "tls": tls,
                **({"supersedes": prise["domain"],
                    "supersedes_spark": prise["spark_name"]} if prise else {})},
               "ok",
               f"{nom} → port {port}."
               + (f" Prend le pas sur « {prise['domain']} », servi par le Spark "
                  f"« {prise['spark_name']} »." if prise else ""))
    route = get(connection, identifiant)
    if prise:
        route["supersedes"] = {"domain": prise["domain"],
                               "spark_name": prise["spark_name"]}
    return route


def update(
    connection: sqlite3.Connection, domain: str, port: int, tls: bool,
    actor: str | None = None,
) -> dict:
    """Corrige la CIBLE d'une route : son port et son TLS (§18.3 ter).

    Ni le domaine ni le Spark : le domaine identifie la route et porte l'unicité
    (§18.4) ; déplacer une route d'un Spark à un autre change qui répond sans que
    l'exploitant du premier l'apprenne, et ce geste-là doit se voir dans le
    journal des deux — il se fait en retirant et en déclarant.

    `applied_at` retombe à zéro : tant que Caddy n'a pas repris la configuration,
    la route est enregistrée mais NON APPLIQUÉE, et l'écran doit pouvoir le dire
    (§18.5). Un succès annoncé avant la reprise ferait chercher la panne du
    mauvais côté.
    """
    nom = domain.strip().lower()
    if not 1 <= port <= 65535:
        raise IngressError(f"Port {port} hors bornes.")
    with transaction(connection):
        avant = connection.execute(
            "SELECT * FROM ingress_route WHERE domain = ?", (nom,)
        ).fetchone()
        if avant is None:
            raise IngressError(f"Aucune route pour « {nom} ».")
        if avant["target_port"] == port and bool(avant["tls"]) == bool(tls):
            # Rien à corriger : ne pas réécrire, ne pas remettre `applied_at` à
            # zéro, ne pas inscrire au journal une correction qui n'a rien
            # changé. Un journal qui compte des non-événements se lit moins bien.
            return dict(avant)
        connection.execute(
            "UPDATE ingress_route SET target_port = ?, tls = ?, applied_at = NULL"
            " WHERE id = ?",
            (port, 1 if tls else 0, avant["id"]),
        )
        _audit(connection, actor, "ingress.update", avant["id"],
               {"domain": nom,
                "port_avant": avant["target_port"], "port": port,
                "tls_avant": bool(avant["tls"]), "tls": bool(tls)},
               "ok",
               # L'AVANT et l'APRÈS : une entrée qui ne dirait que la nouvelle
               # valeur ne permettrait pas de savoir ce qu'on a corrigé.
               f"{nom} : port {avant['target_port']} → {port}"
               + ("" if bool(avant["tls"]) == bool(tls)
                  else f", TLS {'oui' if avant['tls'] else 'non'}"
                       f" → {'oui' if tls else 'non'}") + ".")
    return by_domain(connection, nom)


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
    """Toutes les routes, chaque joker portant ce qui lui est SOUSTRAIT.

    §18.3 bis : dire la surcharge au moment où on la crée ne suffit pas — ce
    message passe une fois, et l'exploitant du Spark porteur du joker ne l'a
    peut-être jamais lu. C'est aussi l'information qui manque au diagnostic :
    sans elle, on cherche dans la configuration du Spark porteur, où il n'y a
    rien à trouver.
    """
    routes = [
        dict(r) for r in connection.execute(
            "SELECT r.*, s.name AS spark_name, s.ipv4_address"
            " FROM ingress_route r JOIN spark s ON s.id = r.spark_id"
            " ORDER BY r.domain"
        )
    ]
    exactes = [r for r in routes if not is_wildcard(r["domain"]) and r["enabled"]]
    for route in routes:
        if not is_wildcard(route["domain"]):
            continue
        # Une route DÉSACTIVÉE ne prend le pas sur rien. Et un nom exact du MÊME
        # Spark n'est pas une surcharge : c'est le même exploitant qui affine sa
        # propre route, et l'afficher serait du bruit.
        route["superseded_by"] = [
            {"domain": e["domain"], "spark_name": e["spark_name"]}
            for e in exactes
            if e["spark_id"] != route["spark_id"] and covers(route["domain"], e["domain"])
        ]
    return routes


#: SPK-102 · §44.2 quater : ce que CHAQUE handler fait subir à une requête.
#:
#: **Mesuré sur la Forge réelle le 2026-09-14**, avec le binaire qui y sert —
#: Caddy 2.6.2 —, en rejouant la forme exacte de la configuration ci-dessous
#: contre un amont qui rend ce qu'il reçoit. Ce n'est donc pas une lecture de
#: documentation : c'est ce que cette Forge fait.
#:
#: La table est indexée par NOM DE HANDLER, et le briefing la consulte à partir
#: des handlers réellement posés (`comportement()`). Le jour où l'ingress
#: gagnera un handler `headers`, le briefing le dira de lui-même — c'est
#: précisément ce que « calculé, jamais écrit en dur » veut dire.
EFFETS_HANDLER = {
    "reverse_proxy": {
        "transmet": ("X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"),
        "preserve_host": True,
        # SPK-128 · §18.6 : mesuré le 2026-09-30 sur Caddy 2.6.2 — la cellule du
        # SSO rendait `Alt-Svc: clear`, et le visiteur ne l'a jamais reçu.
        "retire": ("Alt-Svc",),
    },
    # Ce que `headers` pose ne vit pas dans cette table : il se LIT dans sa
    # configuration (`response.set`), là où un ajout le changerait.
    "headers": {},
    "static_response": {},
}

#: Les en-têtes qui PROTÈGENT. En poser un à l'ingress rend fausse la phrase
#: « aucun en-tête de sécurité » du briefing, qui disparaît donc d'elle-même ;
#: `Alt-Svc` n'en est pas un, et ne la fait pas disparaître (§44.2 quater).
ENTETES_DE_SECURITE = frozenset({
    "Strict-Transport-Security", "Content-Security-Policy", "X-Frame-Options",
    "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy",
})


def _route_commune() -> dict | None:
    """La route qui pose `Alt-Svc: clear` sur chaque réponse (§18.6).

    Sans filtre et non terminale : elle vaut pour toute requête, puis la
    première route qui correspond sert — le refus `404` compris. `deferred`
    pose l'en-tête au moment d'écrire la réponse, donc après tout le reste.

    Elle suit `PROTOCOLES` et rien d'autre : `clear` est vrai tant que HTTP/3
    n'est pas servi, et le jour où il le serait, elle disparaît du même geste.
    Une date de retrait serait une échéance à oublier.
    """
    if "h3" in PROTOCOLES:
        return None
    return {"handle": [{
        "handler": "headers",
        "response": {"set": {"Alt-Svc": ["clear"]}, "deferred": True},
    }]}


#: Route terminale : sans elle, Caddy rend « 200 » et un corps vide pour TOUT
#: domaine non routé — mesuré le 2026-08-19. La Forge répondrait alors pour des
#: noms qu'il ne sert pas, et une erreur de pointage DNS resterait invisible au
#: lieu de se voir immédiatement (docs/DAT.md §18.2).
ROUTE_REFUS = {
    "handle": [{
        "handler": "static_response",
        "status_code": 404,
        "headers": {"Content-Type": ["text/plain; charset=utf-8"]},
        "body": "Aucun Spark ne sert ce domaine.\n",
    }],
}


def comportement(connection: sqlite3.Connection) -> dict:
    """Ce que l'ingress applique RÉELLEMENT, lu dans la configuration qu'il pose.

    @spec docs/BACKLOG.md#SPK-102 · docs/DAT.md §44.2 quater (ce que l'ingress
          n'ajoute pas), §18.2 (la configuration vient du registre)

    @spec docs/BACKLOG.md#SPK-128 · docs/DAT.md §18.6, §44.2 quater (l'en-tête
          posé, HTTP/3, et ce que le proxy retire, lus au même endroit)

    On inspecte la configuration CONSTRUITE plutôt qu'une liste tenue à la main :
    deux descriptions du même proxy finiraient par diverger, et c'est la
    description — pas le proxy — que l'agent lirait.

    La route terminale de refus est écartée : elle ne sert aucun Spark. La route
    commune, elle, vaut pour chaque route servie — mais seulement s'il y en a
    une : ne rien servir n'est pas « servir avec un en-tête ».
    """
    config = build_config(connection)
    serveur = config["apps"]["http"]["servers"][SERVER_NAME]
    servies = [r for r in serveur["routes"] if "match" in r]
    communes = [r for r in serveur["routes"]
                if "match" not in r and r != ROUTE_REFUS]
    appliquees = communes + servies if servies else []
    handlers = sorted({h["handler"] for route in appliquees for h in route["handle"]})
    effets = [EFFETS_HANDLER.get(nom, {}) for nom in handlers]
    transmis: list[str] = []
    retires: list[str] = []
    for effet in effets:
        transmis.extend(effet.get("transmet", ()))
        retires.extend(effet.get("retire", ()))
    poses = {
        nom: ", ".join(valeurs)
        for route in appliquees for h in route["handle"] if h["handler"] == "headers"
        for nom, valeurs in h.get("response", {}).get("set", {}).items()
    }
    return {
        "handlers": handlers,
        "forwarded_headers": sorted(set(transmis)),
        "preserve_host": any(e.get("preserve_host") for e in effets),
        # §44.2 quater : ce que l'ingress N'AJOUTE PAS est ce qui décide si une
        # pile a besoin d'un proxy à elle. On le CALCULE, donc il cesse d'être
        # vrai le jour où il cesse de l'être.
        "response_headers": dict(sorted(poses.items())),
        "security_headers": sorted(nom for nom in poses if nom in ENTETES_DE_SECURITE),
        "stripped_headers": sorted(set(retires)),
        # §18.6 : une propriété du SERVEUR, vraie qu'une route existe ou non.
        "protocols": list(serveur["protocols"]),
    }


def build_config(connection: sqlite3.Connection, exclure: str | None = None) -> dict:
    """Construit la configuration COMPLÈTE de Caddy depuis le registre.

    Seules les routes actives d'un Spark ayant une adresse sont émises : une
    route déclarée sur un Spark encore `pending` existe — on déclare avant de
    créer — mais rien ne peut la servir (docs/DAT.md §18.2).

    `exclure` construit la configuration SANS une route encore au registre :
    c'est celle qu'on pose avant de la retirer (SPK-141, §18.8).
    """
    # §18.6 : la route commune d'abord — sans filtre et non terminale, elle ne
    # sert rien et ne décide d'aucune préséance, elle pose un en-tête et passe.
    commune = _route_commune()
    routes = [commune] if commune else []
    # §18.3 bis : Caddy retient la PREMIÈRE route qui correspond. L'ordre est
    # donc la règle de préséance elle-même, pas une commodité d'affichage.
    servies = sorted((r for r in listing(connection) if r["domain"] != exclure),
                     key=lambda r: specificity(r["domain"]))
    for route in servies:
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

    # Le refus vient APRÈS les routes nommées, sans quoi il les masquerait. Une
    # copie : la constante sert aussi à le reconnaître (`comportement()`).
    routes.append(copy.deepcopy(ROUTE_REFUS))

    serveur: dict = {"listen": [":80", ":443"], "protocols": list(PROTOCOLES),
                     "routes": routes}
    en_clair = [r["domain"] for r in listing(connection)
                if not r["tls"] and r["enabled"] and r["domain"] != exclure]
    if en_clair:
        # Une route en clair est explicitement soustraite à la gestion
        # automatique du TLS, sans quoi Caddy tenterait d'émettre un
        # certificat que personne n'a demandé (docs/DAT.md §18.3).
        serveur["automatic_https"] = {"skip": sorted(en_clair)}

    return {"apps": {"http": {"servers": {SERVER_NAME: serveur}}}}


def _nb_servies(config: dict) -> int:
    """Les routes SERVIES : la route terminale de refus n'en est pas une, et
    l'annoncer fausserait le nombre que lit l'exploitant."""
    return sum(1 for r in config["apps"]["http"]["servers"][SERVER_NAME]["routes"]
               if "match" in r)


def _dater_les_appliquees(connection: sqlite3.Connection, actor, nb: int) -> None:
    """Après une pose RÉUSSIE : chaque route servie reçoit sa date (§18.5).

    À appeler DANS une transaction, et sous `audit.as_runtime` : c'est un
    événement du runtime (§36.4).
    """
    connection.execute(
        "UPDATE ingress_route SET applied_at = ? WHERE enabled = 1"
        " AND spark_id IN (SELECT id FROM spark WHERE ipv4_address IS NOT NULL)",
        (_now(),),
    )
    _audit(connection, actor, "ingress.reconcile", None,
           {"routes": nb}, "ok", f"{nb} route(s) appliquée(s).")


def reconcile(connection: sqlite3.Connection, caddy, actor: str = "sparkd") -> dict:
    """Régénère et applique. C'est le mécanisme NORMAL, pas une réparation."""
    # §36.4 : c'est un ÉVÉNEMENT DU RUNTIME. Souvent déclenché par une
    # requête humaine, il n'est pas demandé par elle — sans cette
    # déclaration le journal ferait croire qu'une personne l'a réclamé.
    with audit.as_runtime(actor or "sparkd"):
        config = build_config(connection)
        nb = _nb_servies(config)
        try:
            caddy.load(config)
        except IngressError as erreur:
            with transaction(connection):
                _audit(connection, actor, "ingress.reconcile", None,
                       {"routes": nb}, "error", str(erreur))
            raise
        with transaction(connection):
            _dater_les_appliquees(connection, actor, nb)
        return {"routes": nb, "config": config}


def domaines_servis(config: dict) -> set[str]:
    """Les noms qu'une configuration de Caddy sert, lus dans ses `match`."""
    serveurs = (config or {}).get("apps", {}).get("http", {}).get("servers", {})
    return {hote for serveur in serveurs.values()
            for route in serveur.get("routes", []) for filtre in route.get("match", [])
            for hote in filtre.get("host", [])}


def retirer(connection: sqlite3.Connection, caddy, domain: str,
            actor: str | None = None) -> None:
    """Retire une route, une fois Caddy CONFIRMÉ (SPK-141, §18.8).

    @spec docs/BACKLOG.md#SPK-141 · docs/DAT.md §18.8

    L'ordre est la décision : poser la configuration SANS la route, RELIRE ce
    que Caddy sert, et seulement alors la retirer du registre. Retirer d'abord
    laissait, sur un Caddy injoignable, un registre sans la route et un proxy
    qui la servait encore. Une pose rendue `200` ne suffit pas : on relit.
    """
    route = by_domain(connection, domain)
    config = build_config(connection, exclure=route["domain"])
    try:
        caddy.load(config)
        encore = route["domain"] in domaines_servis(caddy.current())
        cause = (f"Caddy sert encore {route['domain']} après la pose : la route "
                 "reste au registre.") if encore else None
    except IngressError as erreur:
        cause = (f"{route['domain']} n'est pas retiré : Caddy n'a pas confirmé "
                 f"qu'il ne le sert plus ({erreur}). La route reste au registre.")
    if cause:
        with transaction(connection):
            _audit(connection, actor, "ingress.withdraw", route["id"],
                   {"domain": route["domain"]}, "error", cause)
        raise RetraitNonConfirme(cause)
    with transaction(connection):
        connection.execute("DELETE FROM ingress_route WHERE id = ?", (route["id"],))
        _audit(connection, actor, "ingress.withdraw", route["id"],
               {"domain": route["domain"]}, "ok", f"{route['domain']} retiré.")
        # Les routes qui restent sont celles que la pose vient de servir.
        with audit.as_runtime(actor or "sparkd"):
            _dater_les_appliquees(connection, actor, _nb_servies(config))
