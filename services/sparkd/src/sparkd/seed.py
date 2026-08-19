"""Données de démonstration de la pile de développement.

@spec docs/BACKLOG.md#SPK-23 · docs/DAT.md §28 (la pile et le seed),
      §28.3 (les mêmes chemins que l'application), §28.5 (ce qu'il démontre),
      §28.6 (rejouable à l'identique) · CLAUDE.md §8

Le seed appelle les **routes HTTP de `sparkd`**, jamais du SQL direct. Un seed
qui écrit des lignes en base peut produire des états que l'application est
incapable d'atteindre : les écrans seraient alors éprouvés contre des situations
qui n'existent pas, et les vrais défauts resteraient invisibles.

Conséquence assumée : le seed ne crée que ce que le produit sait créer. Un refus
d'admission y est un vrai `409` du contrôle d'admission, et l'état `error` d'un
Spark est obtenu en faisant réellement échouer le pilote — pas en écrivant
« error » dans une colonne.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

from .app import create_app
from .config import Config, load

GIO = 1024**3
MIO = 1024**2
MBIT = 1_000_000

# L'hôte factice annonce 4 CPU, 5,4 Gio allouables, 192,8 Gio de disque et
# 1 Gbit/s — mesuré, pas supposé. Les fixtures sont dimensionnées pour y TENIR :
# un seed qui demande plus que la machine ne porte s'arrête au milieu et laisse
# des écrans vides. Somme : 1,5 CPU partagé + 1 cœur dédié, 4,5 Gio, 80 Gio,
# 500 Mbit/s.


class SeedError(RuntimeError):
    """Le seed n'a pas pu produire ce qu'il annonce."""


def _attendu(reponse, *codes: int, quoi: str):
    """Un appel du seed qui ne rend pas ce qu'on attend ARRÊTE le seed.

    Un seed qui poursuit après un refus inattendu produit un jeu de données
    partiel que rien ne signale, et les captures prises dessus mentent.
    """
    if reponse.status_code not in codes:
        raise SeedError(
            f"{quoi} : attendu {codes}, reçu {reponse.status_code} — "
            f"{reponse.text[:300]}"
        )
    return reponse


def wipe(config: Config) -> None:
    """Repart d'un registre neuf (§28.6).

    Un seed qui s'ajoute à un état existant produit des captures différentes à
    chaque exécution, et une capture qui change sans que le produit change ne
    prouve plus rien.
    """
    base = Path(config.database)
    for chemin in (base, Path(f"{base}.incus.json"), Path(f"{base}-wal"), Path(f"{base}-shm")):
        chemin.unlink(missing_ok=True)
    base.parent.mkdir(parents=True, exist_ok=True)


def populate(client: TestClient, incus, caddy) -> dict[str, int]:
    """Produit les fixtures du §28.5. Rend un décompte de ce qui a été créé."""
    compte = {"sparks": 0, "routes": 0, "cles": 0, "instantanes": 0, "refus": 0}

    # La capacité de l'hôte doit être connue avant toute admission.
    _attendu(client.post("/v1/host/sync"), 200, quoi="relevé de topologie")

    def creer(corps: dict, *, appliquer: bool = True, demarrer: bool = True) -> dict:
        nom = corps["name"]
        rendu = _attendu(client.post("/v1/sparks", json=corps), 201,
                         quoi=f"création de « {nom} »").json()
        compte["sparks"] += 1
        if appliquer:
            _attendu(client.post(f"/v1/sparks/{nom}/apply"), 200,
                     quoi=f"application de « {nom} »")
        if demarrer:
            _attendu(client.post(f"/v1/sparks/{nom}/start"), 200,
                     quoi=f"démarrage de « {nom} »")
        return rendu

    # --- Spark nominal : l'écran liste et l'écran détail dans leur cas normal.
    creer({"name": "crm-production", "image": "images:debian/13", "cpu_mode": "shared",
           "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 10 * GIO,
           "network_bps": 100 * MBIT})

    # --- Spark arrêté : « Arrêté — aucune mesure d'exécution » (§20.1).
    creer({"name": "boutique", "image": "images:debian/13", "cpu_mode": "shared",
           "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 20 * GIO,
           "network_bps": 100 * MBIT}, demarrer=False)

    # --- Spark en mode dédié : la carte des cœurs du §27.4 a de quoi montrer.
    creer({"name": "postgres-dedie", "image": "images:debian/13", "cpu_mode": "dedicated",
           "cpu_cores": 1, "memory_bytes": 1536 * MIO, "storage_bytes": 40 * GIO,
           "network_bps": 200 * MBIT})

    # --- Spark « pending » : déclaré, pas encore appliqué. Il porte aussi la
    # route non appliquée ci-dessous, parce qu'il n'a pas encore d'adresse.
    creer({"name": "analytics", "image": "images:debian/13", "cpu_mode": "capped",
           "cpu_max": 0.25, "memory_bytes": 512 * MIO, "storage_bytes": 5 * GIO,
           "network_bps": 50 * MBIT}, appliquer=False, demarrer=False)

    # --- Spark en ERREUR, atteint par le VRAI chemin d'erreur (§28.3).
    # On fait échouer le pilote sur le démarrage : la route appelle alors
    # `finish(success=False)`, qui pose l'état `error`, renseigne `last_error`
    # et journalise un audit `error`. Rien n'est écrit à la main.
    creer({"name": "site-vitrine", "image": "images:debian/99", "cpu_mode": "shared",
           "cpu_reservation": 0.25, "memory_bytes": 512 * MIO, "storage_bytes": 5 * GIO,
           "network_bps": 50 * MBIT}, demarrer=False)
    incus.fail_next["set_instance_state"] = (
        "image « images:debian/99 » introuvable dans le dépôt"
    )
    _attendu(client.post("/v1/sparks/site-vitrine/start"), 502,
             quoi="échec de démarrage attendu de « site-vitrine »")

    # --- Refus d'admission RÉEL : un vrai 409 du contrôle d'admission (§28.5).
    refus = _attendu(
        client.post("/v1/sparks", json={
            "name": "trop-gros", "image": "images:debian/13", "cpu_mode": "shared",
            "cpu_reservation": 0.5, "memory_bytes": 512 * GIO,
            "storage_bytes": 10 * GIO, "network_bps": 100 * MBIT}),
        409, quoi="refus d'admission attendu")
    if refus.json().get("detail", {}).get("error") != "admission_refused":
        raise SeedError("le refus attendu n'est pas un refus d'admission")
    compte["refus"] += 1

    # --- Routes : une appliquée, une NON appliquée (§18.5).
    _attendu(client.post("/v1/ingress", json={
        "spark": "crm-production", "domain": "crm.example.com",
        "port": 8080, "tls": True}), 201, quoi="route « crm.example.com »")
    compte["routes"] += 1

    # Le mécanisme réel d'une route non appliquée est un CADDY INJOIGNABLE au
    # moment de la déclaration (§18.5) : la route entre au registre, la
    # configuration n'est pas chargée, et `applied_at` reste vide. On rend donc
    # Caddy indisponible le temps de cette seule déclaration.
    #
    # Une première version déclarait cette route sur un Spark « pending » en
    # supposant qu'il n'avait pas encore d'adresse. Mesuré : l'adresse est
    # attribuée dès la CRÉATION (§15.1), la route était donc servie et
    # `applied_at` renseigné. La vérification finale l'a montré.
    caddy.fail = True
    try:
        _attendu(client.post("/v1/ingress", json={
            "spark": "analytics", "domain": "analytics.example.com",
            "port": 3000, "tls": False}), 502,
            quoi="route non appliquée attendue « analytics.example.com »")
        compte["routes"] += 1
    finally:
        caddy.fail = False
    # Aucun appel suivant ne doit réconcilier l'ingress, sans quoi la route
    # serait appliquée et la fixture disparaîtrait.

    # --- Clés : deux au registre, accordées à un seul Spark. « boutique » et
    # « analytics » n'en reçoivent aucune : l'absence nommée du §26.4.
    # Ces clés sont de VRAIES clés publiques ed25519 au format de fil OpenSSH :
    # le registre valide le base64 et calcule l'empreinte, un corps décoratif
    # serait refusé. Aucune clé privée correspondante n'existe — le motif d'octets
    # est construit, pas dérivé d'un secret — et aucun secret n'entre au dépôt.
    cles = {
        "poste-responsable":
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER",
        "ci-deploiement":
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
    }
    for label, publique in cles.items():
        _attendu(client.post("/v1/ssh-keys", json={"label": label, "public_key": publique}),
                 201, quoi=f"enregistrement de la clé « {label} »")
        compte["cles"] += 1
    _attendu(client.post("/v1/sparks/crm-production/ssh-keys/poste-responsable"), 200,
             quoi="attribution de la clé au CRM")

    # --- Instantanés : un ancien puis un plus récent, pour que le refus de
    # restauration du §19.1 soit atteignable depuis l'interface.
    for nom in ("avant-deploiement", "apres-migration"):
        _attendu(client.post("/v1/sparks/crm-production/snapshots", json={"name": nom}),
                 201, quoi=f"instantané « {nom} »")
        compte["instantanes"] += 1

    return compte


def verify(client: TestClient) -> None:
    """Vérifie que le seed a produit ce que le §28.5 annonce.

    Un seed qui échoue à moitié laisserait des écrans vides sans que rien ne le
    signale : ce contrôle transforme un jeu de données incomplet en erreur.
    """
    etats = {s["name"]: s["state"] for s in client.get("/v1/sparks").json()["sparks"]}
    attendus = {"crm-production": "running", "boutique": "stopped",
                "postgres-dedie": "running", "analytics": "pending",
                "site-vitrine": "error"}
    for nom, etat in attendus.items():
        if etats.get(nom) != etat:
            raise SeedError(f"« {nom} » devrait être « {etat} », il est « {etats.get(nom)} »")

    routes = client.get("/v1/ingress").json()["routes"]
    if not any(r["applied_at"] for r in routes):
        raise SeedError("aucune route appliquée")
    if not any(not r["applied_at"] for r in routes):
        raise SeedError("aucune route non appliquée : le badge du §18.5 serait invisible")

    resultats = {e["result"] for e in client.get("/v1/audit?limit=500").json()["entries"]}
    for attendu in ("ok", "denied", "error"):
        if attendu not in resultats:
            raise SeedError(f"le journal d'audit ne porte aucun « {attendu} »")

    if len(client.get("/v1/sparks/crm-production/snapshots").json()["snapshots"]) < 2:
        raise SeedError("moins de deux instantanés : le refus du §19.1 serait inatteignable")


def run(config: Config | None = None) -> dict[str, int]:
    """Recrée le registre et le peuple. Rejouable à l'identique (§28.6)."""
    config = config or load()
    if config.driver != "fake":
        raise SeedError(
            f"Le seed ne s'applique qu'au pilote factice, pas à « {config.driver} ». "
            "Peupler un hôte réel depuis un script de démonstration n'est pas "
            "prévu et ne doit pas l'être."
        )
    wipe(config)
    app = create_app(config)
    client = TestClient(app)
    compte = populate(client, app.state.incus, app.state.caddy)
    verify(client)
    return compte


def main(argv: list[str] | None = None) -> int:
    try:
        compte = run()
    except SeedError as erreur:
        print(f"seed : {erreur}", file=sys.stderr)
        return 1
    print(
        f"seed appliqué : {compte['sparks']} Sparks, {compte['routes']} routes, "
        f"{compte['cles']} clés, {compte['instantanes']} instantanés, "
        f"{compte['refus']} refus d'admission réel."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
