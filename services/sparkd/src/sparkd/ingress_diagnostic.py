"""Le diagnostic en direct d'une route : ce que Caddy et le TLS disent MAINTENANT.

@spec docs/BACKLOG.md#SPK-130 · docs/DAT.md §18.7 (chaque badge dit ce qui a été
      relevé à l'instant, par le composant qui peut le savoir), §18.5
      (`applied_at` date un geste, il ne décrit pas Caddy)

Deux relevés par route, et aucun souvenir :

- **Caddy** : la configuration VIVANTE porte-t-elle la route, vers la cible du
  registre ? Puis une requête réelle sur la boucle locale, dont on ne lit que le
  statut ;
- **certificat** : une poignée de main TLS réelle sur `127.0.0.1:443`, le nom en
  SNI, vérifiée comme un navigateur la vérifie.

Sonder par la boucle locale isole chaque couche : ni l'un ni l'autre ne dépend
du DNS, qui a son propre badge, relevé par la console.

Rien ici n'écrit, et rien ne se journalise (§36.7) : c'est une lecture.

@spec docs/BACKLOG.md#SPK-156 · docs/DAT.md §18.9 (pourquoi un certificat ne
      vient pas : ce que Caddy dit de ses tentatives, lu dans son journal
      d'émission, nom par nom, depuis le dernier succès) — `ReleveEmission`,
      `analyser_emission`, `SondesReelles.emission`, `SondesFactices.emission`
      et leur emploi par `diagnostiquer`.
"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
import sqlite3
import ssl
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

from . import ingress

#: Chaque sonde a son délai : une pile lente ne retient pas la page (§18.7).
DELAI_SECONDES = 3.0
#: La sonde se nomme, pour qu'un exploitant la reconnaisse dans ses journaux.
USER_AGENT = "sparkd-diagnostic"
#: Caddy renouvelle au dernier tiers de la validité — trente jours pour un
#: certificat de quatre-vingt-dix. Sous quatorze, le renouvellement échoue
#: depuis deux semaines au moins (§18.7).
SEUIL_EXPIRATION_JOURS = 14
#: Les statuts que Caddy rend quand la cible `adresse:port` ne répond pas.
STATUTS_PILE_MUETTE = frozenset({502, 504})


#: SPK-156 · §18.9.2 : la fin du journal d'émission qu'on relit. Des semaines de
#: tentatives n'atteignent pas ce volume ; la rotation de Caddy borne le fichier
#: à 5 Mio.
LECTURE_MAX_OCTETS = 1024 * 1024

#: Les messages de Caddy 2.6.2 qui structurent une émission — relevés dans son
#: journal sur la Forge le 2026-10-11. `tls.renew` emploie les mêmes.
DEBUTS = frozenset({"obtaining certificate", "renewing certificate"})
SUCCES = frozenset({"certificate obtained successfully",
                    "certificate renewed successfully"})
VALIDATION_REFUSEE = "challenge failed"
EMETTEUR_EN_ECHEC = "could not get certificate from issuer"
NOUVEL_ESSAI = "will retry"

#: Le nom lisible d'une autorité, d'après la clé que Caddy donne à son émetteur.
#: Une clé inconnue est rendue telle quelle (§14.7 du design system).
AUTORITES = {
    "acme-v02.api.letsencrypt.org-directory": "Let's Encrypt",
    "acme-staging-v02.api.letsencrypt.org-directory": "Let's Encrypt (test)",
    "acme.zerossl.com-v2-DV90": "ZeroSSL",
}

#: L'échéance d'une limite de débit, dans le message de l'autorité.
LIMITE = re.compile(r"rateLimited.*?retry after (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC")


def _maintenant() -> datetime:
    return datetime.now(timezone.utc)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def _adresse_jointe(erreur: str) -> str | None:
    """L'adresse que l'autorité a jointe, quand son erreur commence par elle.

    Let's Encrypt écrit « 163.172.156.76: Connection refused » : la tête avant le
    premier « : » suivi d'une espace. Une phrase (« DNS problem: … ») n'est pas une
    adresse, et une adresse IPv6 contient elle-même des deux-points.
    """
    tete, separateur, _ = erreur.partition(": ")
    if not separateur:
        return None
    try:
        return str(ipaddress.ip_address(tete.strip("[]")))
    except ValueError:
        return None


def _concerne(evenement: dict, domaine: str) -> bool:
    """L'événement désigne-t-il ce nom ? « will retry » n'a pas d'`identifier` :
    son message commence par « [<nom>] »."""
    return (evenement.get("identifier") == domaine
            or str(evenement.get("error", "")).startswith(f"[{domaine}]"))


def analyser_emission(evenements: Iterable[dict], domaine: str) -> dict:
    """Ce que Caddy a rencontré en émettant le certificat de ce nom (§18.9.2).

    Seuls comptent les événements POSTÉRIEURS au dernier succès : un échec suivi
    d'un succès est une histoire close. Rien n'est reformulé : les erreurs et les
    dates sont celles des lignes.
    """
    siens = sorted((e for e in evenements if _concerne(e, domaine)),
                   key=lambda e: e.get("ts", 0.0))
    if not siens:
        return {"state": "none"}
    succes = [i for i, e in enumerate(siens) if e.get("msg") in SUCCES]
    apres = siens[succes[-1] + 1:] if succes else siens
    echecs = [e for e in apres
              if e.get("msg") in (VALIDATION_REFUSEE, EMETTEUR_EN_ECHEC, NOUVEL_ESSAI)]
    if not echecs:
        if succes:
            return {"state": "ok", "obtained_at": _iso(siens[succes[-1]]["ts"])}
        return {"state": "pending"}

    debuts = [e for e in apres if e.get("msg") in DEBUTS]
    dernier_debut = debuts[-1]["ts"] if debuts else None
    essais = [e for e in apres if e.get("msg") == NOUVEL_ESSAI]
    prochaine = None
    if essais and "retrying_in" in essais[-1] and (
            dernier_debut is None or essais[-1]["ts"] >= dernier_debut):
        # Annoncée APRÈS la dernière tentative : sinon, une tentative est en cours
        # et le délai annoncé est déjà écoulé.
        prochaine = _iso(essais[-1]["ts"] + float(essais[-1]["retrying_in"]))

    # Par type, la DERNIÈRE validation refusée depuis le dernier succès, datée :
    # une tentative limitée en débit n'en tente aucune, et l'adresse jointe vient
    # alors d'une tentative précédente — sa date le dit.
    validations: dict[str, dict] = {}
    for e in apres:
        if e.get("msg") == VALIDATION_REFUSEE:
            erreur = str(e.get("error", ""))
            validations[e.get("challenge_type", "")] = {
                "type": e.get("challenge_type"), "at": _iso(e["ts"]),
                "address": _adresse_jointe(erreur), "error": erreur}

    emetteurs: dict[str, dict] = {}
    for e in apres:
        if e.get("msg") == EMETTEUR_EN_ECHEC:
            cle = str(e.get("issuer", ""))
            emetteurs[cle] = {"issuer": cle, "name": AUTORITES.get(cle, cle),
                              "at": _iso(e["ts"]), "error": str(e.get("error", ""))}

    limite = None
    plus_recente = max(emetteurs.values(), key=lambda i: i["at"], default=None)
    for emetteur in sorted(emetteurs.values(), key=lambda i: i["at"], reverse=True):
        if emetteur["at"] != plus_recente["at"]:
            break
        trouve = LIMITE.search(emetteur["error"])
        if trouve:
            limite = datetime.strptime(trouve.group(1), "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc).isoformat(timespec="seconds")
            break

    return {
        "state": "failing",
        "since": _iso(echecs[0]["ts"]),
        "last_attempt_at": _iso(dernier_debut if dernier_debut is not None
                                else echecs[-1]["ts"]),
        "next_retry_at": prochaine,
        "challenges": sorted(validations.values(), key=lambda v: v["at"]),
        "issuers": sorted(emetteurs.values(), key=lambda i: i["issuer"]),
        "rate_limited_until": limite,
    }


@dataclass
class ReleveEmission:
    """Le journal d'émission, lu UNE fois par diagnostic (§18.9.2)."""

    readable: bool
    reason: str | None = None
    evenements: list[dict] = field(default_factory=list)

    def pour(self, domaine: str) -> dict:
        return analyser_emission(self.evenements, domaine)


def lire_journal_emission(chemin: Path) -> ReleveEmission:
    """La fin du journal, décodée ligne par ligne.

    Un fichier absent n'est pas une erreur : Caddy ne l'écrit qu'au premier
    événement d'émission. Toute autre impossibilité se DIT — un journal illisible
    n'est pas une absence d'échec. La première ligne d'une lecture qui commence
    au milieu du fichier est coupée : elle est écartée, comme toute ligne qui
    n'est pas un objet JSON.
    """
    try:
        with open(chemin, "rb") as fichier:
            fichier.seek(0, 2)
            taille = fichier.tell()
            debut = max(0, taille - LECTURE_MAX_OCTETS)
            fichier.seek(debut)
            brut = fichier.read()
    except FileNotFoundError:
        return ReleveEmission(readable=True)
    except OSError as erreur:
        return ReleveEmission(readable=False,
                              reason=erreur.strerror or str(erreur) or type(erreur).__name__)
    lignes = brut.decode("utf-8", errors="replace").splitlines()
    if debut > 0:
        lignes = lignes[1:]
    evenements = []
    for ligne in lignes:
        try:
            evenement = json.loads(ligne)
        except ValueError:
            continue
        if isinstance(evenement, dict) and isinstance(evenement.get("ts"), (int, float)):
            evenements.append(evenement)
    return ReleveEmission(readable=True, evenements=evenements)


@dataclass
class SondesReelles:
    """Les sondes de la Forge : une requête et une poignée de main, sur la boucle."""

    hote: str = "127.0.0.1"
    port_https: int = 443
    port_http: int = 80
    #: Le contexte d'une vérification DE NAVIGATEUR : autorités du système, nom.
    #: Une couture pour les preuves, qui font confiance à leur propre autorité.
    contexte_verifie: Callable[[], ssl.SSLContext] = ssl.create_default_context
    maintenant: Callable[[], datetime] = _maintenant
    #: SPK-156 · §18.9.1 : le journal que la configuration posée déclare. Une
    #: couture pour les preuves, qui lisent un fichier à elles.
    journal_emission: Path = Path(ingress.JOURNAL_EMISSION)
    nature: str = field(default="real", init=False)

    def emission(self) -> ReleveEmission:
        """Ce que Caddy a écrit de ses tentatives d'émission (§18.9)."""
        return lire_journal_emission(self.journal_emission)

    def http(self, domaine: str, tls: bool) -> dict:
        """Le statut que rend l'ingress pour ce nom — rien d'autre n'est lu."""
        port = self.port_https if tls else self.port_http
        try:
            brut = socket.create_connection((self.hote, port), timeout=DELAI_SECONDES)
        except OSError as erreur:
            return {"status": None, "error": str(erreur) or type(erreur).__name__}
        try:
            if tls:
                # Le certificat a son propre relevé : ici, on veut le statut
                # MÊME derrière un certificat invalide.
                contexte = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                contexte.check_hostname = False
                contexte.verify_mode = ssl.CERT_NONE
                flux = contexte.wrap_socket(brut, server_hostname=domaine)
            else:
                flux = brut
        except (OSError, ssl.SSLError) as erreur:
            brut.close()
            return {"status": None, "error": str(erreur) or type(erreur).__name__}
        try:
            with flux:
                flux.sendall(
                    f"GET / HTTP/1.1\r\nHost: {domaine}\r\nUser-Agent: {USER_AGENT}\r\n"
                    "Connection: close\r\n\r\n".encode("ascii"))
                with flux.makefile("rb") as lecture:
                    ligne = lecture.readline(256).decode("latin-1").strip()
        except (OSError, ssl.SSLError) as erreur:
            return {"status": None, "error": str(erreur) or type(erreur).__name__}
        trouve = re.match(r"HTTP/\d(?:\.\d)? (\d{3})", ligne)
        if not trouve:
            return {"status": None, "error": f"réponse illisible : {ligne[:80]!r}"}
        return {"status": int(trouve.group(1)), "error": None}

    def certificat(self, domaine: str) -> dict:
        """Ce qu'un navigateur penserait du certificat servi pour ce nom."""
        try:
            with socket.create_connection((self.hote, self.port_https),
                                          timeout=DELAI_SECONDES) as brut:
                with self.contexte_verifie().wrap_socket(
                        brut, server_hostname=domaine) as flux:
                    certificat = flux.getpeercert()
        except ssl.SSLCertVerificationError as erreur:
            # La raison de la vérification, TELLE QUELLE (§18.7).
            return {"state": "invalid", "reason": erreur.verify_message or str(erreur)}
        except ssl.SSLError as erreur:
            # Une alerte pendant la poignée de main : Caddy n'a aucun certificat
            # pour ce nom — l'émission n'a pas eu lieu.
            return {"state": "missing", "reason": erreur.reason or str(erreur)}
        except OSError as erreur:
            return {"state": "unreachable", "reason": str(erreur) or type(erreur).__name__}
        echeance = datetime.fromtimestamp(
            ssl.cert_time_to_seconds(certificat["notAfter"]), tz=timezone.utc)
        emetteur = dict(paire[0] for paire in certificat.get("issuer", ()))
        jours = (echeance - self.maintenant()).days
        return {
            "state": "expiring" if jours < SEUIL_EXPIRATION_JOURS else "valid",
            "issuer": emetteur.get("organizationName") or emetteur.get("commonName"),
            "not_after": echeance.isoformat(timespec="seconds"),
            "days_left": jours,
            "reason": None,
        }


@dataclass
class SondesFactices:
    """Les doubles du pilote factice (§28, §18.7) : déterministes, et déclarés.

    Au même titre que `FakeIncus`, ils gardent leur état dans un fichier à côté
    du registre, pour que ce que le seed a déclaré survive au démarrage de la
    pile de développement. Sans scénario, un nom répond `200` et présente un
    certificat valide de l'autorité factice. La réponse porte `probes: "fake"`,
    et l'écran le dit : ce ne sont pas des relevés.
    """

    state_path: Path | None = None
    maintenant: Callable[[], datetime] = _maintenant
    nature: str = field(default="fake", init=False)
    scenarios: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.state_path and self.state_path.exists():
            self.scenarios = json.loads(self.state_path.read_text(encoding="utf-8"))

    def poser(self, domaine: str, *, http: dict | None = None,
              certificat: dict | None = None,
              emission: list[dict] | None = None) -> None:
        """Déclare ce que les sondes rendront pour ce nom.

        SPK-156 · §18.9.3 : `emission` est une suite d'ÉVÉNEMENTS de Caddy, à la
        forme de son journal, datés par `il_y_a_minutes` plutôt que par `ts` ; un
        `{dans_minutes:N}` dans un message devient une heure UTC à N minutes. Ils
        passent par la même analyse que le journal de la Forge.
        """
        scenario = self.scenarios.setdefault(domaine, {})
        if http is not None:
            scenario["http"] = http
        if certificat is not None:
            scenario["certificat"] = certificat
        if emission is not None:
            scenario["emission"] = emission
        if self.state_path:
            self.state_path.write_text(json.dumps(self.scenarios, indent=2) + "\n",
                                       encoding="utf-8")

    def http(self, domaine: str, tls: bool) -> dict:
        return dict(self.scenarios.get(domaine, {}).get(
            "http", {"status": 200, "error": None}))

    def emission(self) -> ReleveEmission:
        """Les événements déclarés, datés par rapport à cette lecture."""
        maintenant = self.maintenant()

        def dater(evenement: dict) -> dict:
            date = dict(evenement)
            minutes = date.pop("il_y_a_minutes", 0)
            date["ts"] = (maintenant - timedelta(minutes=minutes)).timestamp()
            if isinstance(date.get("error"), str):
                date["error"] = re.sub(
                    r"\{dans_minutes:(\d+)\}",
                    lambda m: (maintenant + timedelta(minutes=int(m.group(1))))
                    .strftime("%Y-%m-%d %H:%M:%S"),
                    date["error"])
            return date

        return ReleveEmission(readable=True, evenements=[
            dater(e) for scenario in self.scenarios.values()
            for e in scenario.get("emission", [])])

    def certificat(self, domaine: str) -> dict:
        scenario = self.scenarios.get(domaine, {}).get("certificat")
        if scenario and scenario.get("state") not in ("valid", "expiring"):
            return {"reason": None, **scenario}
        jours = (scenario or {}).get("days_left", 60)
        echeance = self.maintenant() + timedelta(days=jours)
        return {
            "state": "expiring" if jours < SEUIL_EXPIRATION_JOURS else "valid",
            "issuer": "Autorité factice du pilote de développement",
            "not_after": echeance.isoformat(timespec="seconds"),
            "days_left": jours,
            "reason": None,
        }


def _cibles_vivantes(vivante: dict) -> dict[str, str]:
    """Pour chaque nom que la configuration vivante filtre, la cible qu'elle vise."""
    cibles: dict[str, str] = {}
    serveurs = vivante.get("apps", {}).get("http", {}).get("servers", {})
    for serveur in serveurs.values():
        for route in serveur.get("routes", []):
            amonts = [amont.get("dial") for h in route.get("handle", [])
                      if h.get("handler") == "reverse_proxy"
                      for amont in h.get("upstreams", [])]
            for filtre in route.get("match", []):
                for nom in filtre.get("host", []):
                    # La PREMIÈRE route qui correspond sert (§18.3 bis).
                    cibles.setdefault(nom, amonts[0] if amonts else "")
    return cibles


def _etat_caddy(route: dict, cibles: dict[str, str] | None, sondes) -> dict:
    attendue = (f"{route['ipv4_address']}:{route['target_port']}"
                if route["ipv4_address"] else None)
    base = {"expected": attendue, "found": None, "status": None, "reason": None}
    if cibles is None:
        return {**base, "state": "unreachable"}
    if not route["enabled"] or not attendue:
        # Caddy ne DOIT pas la porter : ce n'est pas une panne (§18.2).
        return {**base, "state": "not_served",
                "reason": "route désactivée" if not route["enabled"]
                else "le Spark n'a pas d'adresse"}
    trouvee = cibles.get(route["domain"])
    if trouvee is None:
        return {**base, "state": "absent"}
    if trouvee != attendue:
        return {**base, "state": "other_target", "found": trouvee}
    if ingress.is_wildcard(route["domain"]):
        # Un joker ne désigne aucun nom précis : il n'y a rien à demander.
        return {**base, "state": "served", "found": trouvee,
                "reason": "joker : aucun nom précis à interroger"}
    reponse = sondes.http(route["domain"], bool(route["tls"]))
    if reponse["status"] is None:
        return {**base, "state": "probe_failed", "found": trouvee,
                "reason": reponse["error"]}
    etat = "silent_stack" if reponse["status"] in STATUTS_PILE_MUETTE else "served"
    return {**base, "state": etat, "found": trouvee, "status": reponse["status"]}


def _etat_certificat(route: dict, etat_caddy: dict, sondes) -> dict:
    if not route["tls"] or etat_caddy["state"] == "not_served":
        return {"state": "not_applicable"}
    if ingress.is_wildcard(route["domain"]):
        return {"state": "wildcard", "reason": "joker : aucun nom précis à présenter"}
    return sondes.certificat(route["domain"])


def diagnostiquer(connection: sqlite3.Connection, spark: str, caddy, sondes) -> dict:
    """Relève Caddy et le certificat de chaque route du Spark, maintenant."""
    routes = [r for r in ingress.listing(connection) if r["spark_name"] == spark]
    try:
        cibles = _cibles_vivantes(caddy.current())
        erreur_caddy = None
    except ingress.IngressError as erreur:
        cibles, erreur_caddy = None, str(erreur)
    # SPK-156 · §18.9.2 : le journal se lit une fois, pas une fois par route.
    emission = sondes.emission()

    def une(route: dict) -> tuple[str, dict]:
        caddy_ = _etat_caddy(route, cibles, sondes)
        releve = {"caddy": caddy_,
                  "certificate": _etat_certificat(route, caddy_, sondes)}
        # Une route en clair n'a rien à émettre ; une route que Caddy ne doit pas
        # porter non plus. Un journal illisible ne donne rien à personne : il se
        # dit une fois, dans `issuance_journal`.
        if emission.readable and route["tls"] and caddy_["state"] != "not_served":
            releve["issuance"] = emission.pour(route["domain"])
        return route["domain"], releve

    # Les routes se sondent ENSEMBLE : la page attend la plus lente, pas la somme.
    with ThreadPoolExecutor(max_workers=8) as executeur:
        releves = dict(executeur.map(une, routes))
    return {
        "spark": spark,
        "checked_at": _maintenant().isoformat(timespec="seconds"),
        "probes": sondes.nature,
        "caddy_reachable": cibles is not None,
        "caddy_error": erreur_caddy,
        "issuance_journal": {"readable": emission.readable, "reason": emission.reason},
        "routes": releves,
    }
