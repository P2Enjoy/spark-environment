"""@verifies docs/BACKLOG.md#SPK-01 · docs/DAT.md §4, §5

Les sondes d'etat sont distinctes a dessein : « readyz » ne doit pas annoncer
une disponibilite que rien ne prouve (CLAUDE.md §18, pas de succes simule).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect


def client(tmp_path=None):
    import tempfile
    base = tempfile.mkdtemp() + "/spark.db"
    return TestClient(create_app(load({"SPARKD_DB": base, "SPARKD_DRIVER": "fake"})))


def test_healthz_repond():
    reponse = client().get("/healthz")
    assert reponse.status_code == 200
    assert reponse.json()["status"] == "ok"


def test_readyz_rend_l_etat_REEL_de_chaque_dependance():
    """Revise le 2026-08-19, avec SPK-26. Deuxieme revision de cette preuve.

    Elle exigeait que Incus et Caddy s'annoncent « unknown », ce qui datait de
    l'epoque ou leurs pilotes n'existaient pas. Ils existent : continuer a exiger
    « unknown » figeait la reponse, et un endpoint de disponibilite qui rend
    toujours la meme chose ne distingue pas un serveur sain d'un serveur en
    panne. C'est pourtant de lui que depend la verification de deploiement
    (docs/DAT.md §31).

    Ce qui reste verifie est plus fort qu'avant : aucune dependance ne s'annonce
    prete sans avoir ete SONDEE.
    """
    corps = client().get("/readyz").json()
    assert set(corps["dependencies"]) == {"incus", "registry", "caddy"}
    # Le pilote factice repond : le declarer indisponible serait aussi faux que
    # de declarer pret un pilote muet.
    assert corps["dependencies"] == {"incus": "ready", "registry": "ready", "caddy": "ready"}
    assert corps["status"] == "ready"


def test_readyz_nomme_la_CAUSE_d_une_dependance_en_panne():
    """Taire la cause oblige a la rechercher ailleurs (docs/DAT.md §31.2)."""
    import tempfile

    application = create_app(load({"SPARKD_DB": tempfile.mkdtemp() + "/s.db",
                                   "SPARKD_DRIVER": "fake"}))

    class IncusMuet:
        def server_info(self):
            raise RuntimeError("socket /var/lib/incus/unix.socket absente")

    application.state.incus = IncusMuet()
    corps = TestClient(application).get("/readyz").json()

    assert corps["status"] == "degraded"
    assert corps["dependencies"]["incus"] == "unavailable"
    assert corps["dependencies"]["caddy"] == "ready", "une panne n'en invente pas une autre"
    assert "socket" in corps["detail"], "la cause doit etre rendue, pas seulement l'etat"


def test_openapi_expose_le_contrat():
    schema = client().get("/openapi.json").json()
    assert "/healthz" in schema["paths"]
    assert "/readyz" in schema["paths"]


def test_readyz_annonce_la_version_de_schema(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-04 · docs/SCHEMA.md §12.4"""
    from sparkd import migrations
    from sparkd.db import connect

    base = tmp_path / "spark.db"
    connexion = connect(base)
    migrations.upgrade(connexion)
    connexion.close()

    app = create_app(load({"SPARKD_DB": str(base), "SPARKD_DRIVER": "fake"}))
    corps = TestClient(app).get("/readyz").json()
    assert corps["dependencies"]["registry"] == "ready"
    # La version annoncee est la DERNIERE appliquee. Elle etait figee a 1 tant
    # qu'il n'existait qu'une migration ; 002 (part de l'ARC, SPK-22) l'a fait
    # avancer. L'attente suit desormais le registre plutot qu'un nombre ecrit.
    assert corps["schema_version"] == max(m.version for m in migrations.discover())


def test_demarrage_refuse_si_le_schema_a_derive(tmp_path, monkeypatch):
    """@verifies docs/SCHEMA.md §12.4 — sparkd refuse de servir une base derivee."""
    from sparkd import migrations
    from sparkd.db import connect

    base = tmp_path / "spark.db"
    connexion = connect(base)
    migrations.upgrade(connexion)
    # La base declare une migration dont le depot n'a pas le fichier.
    connexion.execute(
        "INSERT INTO schema_migration (version, applied_at, checksum)"
        " VALUES (99, '2026-08-18', 'inexistant')"
    )
    connexion.close()

    with pytest.raises(migrations.MigrationError, match="autre code"):
        create_app(load({"SPARKD_DB": str(base), "SPARKD_DRIVER": "fake"}))


# --- inventaire de l'hote (SPK-07) -----------------------------------------

def test_host_refuse_avant_tout_releve(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.3"""
    app = create_app(load({"SPARKD_DB": str(tmp_path / "a.db"), "SPARKD_DRIVER": "fake"}))
    reponse = TestClient(app).get("/v1/forge")
    assert reponse.status_code == 409
    assert reponse.json()["detail"]["remedy"] == "POST /v1/forge/sync"


def test_sync_puis_host_expose_les_pools(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-07, #SPK-05 — l'admission control devient observable."""
    app = create_app(load({"SPARKD_DB": str(tmp_path / "b.db"), "SPARKD_DRIVER": "fake"}))
    client_http = TestClient(app)

    releve = client_http.post("/v1/forge/sync")
    assert releve.status_code == 200
    assert releve.json()["cpu_cores_total"] == 4

    corps = client_http.get("/v1/forge").json()
    assert corps["cpu"]["cores_total"] == 4
    assert corps["cpu"]["threads_total"] == 8
    assert corps["pools"]["cpu"]["capacity"] == 4.0
    assert corps["pools"]["cpu"]["available"] == 4.0
    assert corps["pools"]["network"]["capacity"] == 1_000_000_000
    # docs/DAT.md §7.3 bis : la garantie annoncee reste exacte.
    assert corps["reservation_guarantee"] == "floor_under_contention"


def test_host_expose_les_termes_de_la_reserve_memoire(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-22 · docs/DAT.md §16.1, §27.3 · docs/SCHEMA.md §11 bis

    La console doit pouvoir enoncer la soustraction TERME A TERME. La somme
    seule ne dit pas laquelle des deux vannes tourner -- zfs_arc_max, ou
    SPARKD_MEMORY_RESERVE.
    """
    app = create_app(load({"SPARKD_DB": str(tmp_path / "m.db"), "SPARKD_DRIVER": "fake"}))
    client_http = TestClient(app)
    client_http.post("/v1/forge/sync")

    corps = client_http.get("/v1/forge").json()
    total = corps["memory"]["total_bytes"]
    reserves = corps["reserves"]
    assert total > 0, "la memoire de la machine doit etre publiee"

    # Les deux termes doivent se recomposer exactement en la reserve annoncee :
    # une somme qui ne retombe pas juste ferait afficher un calcul faux.
    assert reserves["arc_bytes"] + reserves["margin_bytes"] == reserves["memory_bytes"]
    # Et la soustraction doit aboutir a la capacite reellement allouable.
    assert total - reserves["memory_bytes"] == corps["pools"]["memory"]["capacity"]


def test_host_publie_la_marge_de_metadonnees_unitaire_et_son_cout_total(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-30 · docs/DAT.md §8.8.2 (regle 4 et sa
    consequence d'affichage), §27.6 (la console LIT, elle ne pose pas en dur)

    La marge est invisible du locataire mais grossit l'alloue du pool. Un
    exploitant qui additionne les tailles vendues et lit un alloue superieur doit
    trouver l'explication a l'ecran. Deux termes : le REGLAGE (unitaire) et sa
    CONSEQUENCE (le total), calcule au serveur ou le nombre de Sparks est connu.
    """
    MIO = 1024**2
    GIO = 1024**3
    app = create_app(load({"SPARKD_DB": str(tmp_path / "mm.db"), "SPARKD_DRIVER": "fake",
                           "SPARKD_STORAGE_METADATA_MARGIN": "64MiB"}))
    client_http = TestClient(app)
    client_http.post("/v1/forge/sync")

    reserves = client_http.get("/v1/forge").json()["reserves"]
    assert reserves["storage_metadata_margin_bytes"] == 64 * MIO
    # Registre vide : la marge est PAR SPARK, elle ne coute encore rien.
    assert reserves["storage_metadata_total_bytes"] == 0

    for nom in ("un", "deux"):
        reponse = client_http.post("/v1/sparks", json={
            "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
            "cpu_reservation": 0.25, "memory_bytes": GIO,
            "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
        })
        assert reponse.status_code == 201, reponse.text

    corps = client_http.get("/v1/forge").json()
    assert corps["reserves"]["storage_metadata_total_bytes"] == 2 * 64 * MIO
    # Et le total publie est EXACTEMENT ce que l'alloue porte en plus des
    # tailles vendues : deux chiffres qui divergeraient rendraient l'ecran faux.
    assert corps["pools"]["storage"]["allocated"] == 2 * 10 * GIO + 2 * 64 * MIO


def test_une_marge_nulle_ne_coute_rien_au_pool(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-30 · docs/DAT.md §8.8.3

    Zero restaure le comportement d'avant l'unite. L'ecran n'a alors rien a
    expliquer, et l'alloue vaut exactement la somme des tailles vendues.
    """
    GIO = 1024**3
    app = create_app(load({"SPARKD_DB": str(tmp_path / "m0.db"), "SPARKD_DRIVER": "fake",
                           "SPARKD_STORAGE_METADATA_MARGIN": "0"}))
    client_http = TestClient(app)
    client_http.post("/v1/forge/sync")
    client_http.post("/v1/sparks", json={
        "name": "sans-marge", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    })
    corps = client_http.get("/v1/forge").json()
    assert corps["reserves"]["storage_metadata_margin_bytes"] == 0
    assert corps["reserves"]["storage_metadata_total_bytes"] == 0
    assert corps["pools"]["storage"]["allocated"] == 10 * GIO


# --- cycle de vie par HTTP (SPK-09) ----------------------------------------

def _app(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "c.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    return c


def _spec(**champs):
    base = {
        "name": "crm-production", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": 2 * 1024**3,
        "network_bps": 100_000_000, "storage_bytes": 10 * 1024**3,
    }
    base.update(champs)
    return base


def test_parcours_complet_par_http(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-09 — créer, appliquer, démarrer, arrêter, supprimer."""
    c = _app(tmp_path)

    cree = c.post("/v1/sparks", json=_spec())
    assert cree.status_code == 201 and cree.json()["state"] == "pending"

    assert c.post("/v1/sparks/crm-production/apply").json()["state"] == "stopped"
    assert c.post("/v1/sparks/crm-production/start").json()["state"] == "running"
    assert c.post("/v1/sparks/crm-production/stop").json()["state"] == "stopped"
    assert c.post("/v1/sparks/crm-production/delete").json() == {"deleted": "crm-production"}
    assert c.get("/v1/sparks").json()["sparks"] == []


def test_refus_d_admission_par_http_nomme_ce_qui_manque(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-05 — le refus arrive jusqu'à l'appelant."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="gros", cpu_reservation=3.5))
    refus = c.post("/v1/sparks", json=_spec(name="trop", cpu_reservation=1.0))
    assert refus.status_code == 409
    detail = refus.json()["detail"]
    assert detail["error"] == "admission_refused"
    assert detail["shortfalls"][0]["resource"] == "cpu"
    assert detail["shortfalls"][0]["missing"] > 0


def test_transition_interdite_par_http(tmp_path):
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    refus = c.post("/v1/sparks/crm-production/start")
    assert refus.status_code == 409
    assert "pending" in refus.json()["detail"]["message"]


def test_commande_inconnue(tmp_path):
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    r = c.post("/v1/sparks/crm-production/exploser")
    assert r.status_code == 404
    assert "apply" in r.json()["detail"]["known"]


def test_spark_inexistant(tmp_path):
    assert _app(tmp_path).get("/v1/sparks/fantome").status_code == 404


def test_la_capacite_reflete_les_sparks_crees(tmp_path):
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(cpu_reservation=1.5))
    pools = c.get("/v1/forge").json()["pools"]
    assert pools["cpu"]["allocated"] == 1.5
    assert pools["cpu"]["available"] == 2.5


# --- decoupe des coeurs dedies par HTTP (SPK-06) ---------------------------

def test_un_spark_dedie_decoupe_le_pool_et_reconfigure_les_partages(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-06 · docs/DAT.md §7.4 bis"""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="partage", cpu_reservation=0.5))
    c.post("/v1/sparks/partage/apply")

    avant = c.get("/v1/forge/cores").json()
    assert avant["shared"]["capacity"] == 4.0 and avant["dedicated"] == []

    c.post("/v1/sparks", json=_spec(
        name="postgres", cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    c.post("/v1/sparks/postgres/apply")

    apres = c.get("/v1/forge/cores").json()
    assert apres["shared"]["capacity"] == 2.0
    # Freres SMT emportes ensemble : coeurs 0 et 1 -> CPU 0,4 et 1,5.
    assert sorted(cpu for d in apres["dedicated"] for cpu in d["cpus"]) == [0, 1, 4, 5]
    assert apres["shared"]["cpus"] == [2, 3, 6, 7]


def test_la_suppression_d_un_dedie_rend_les_coeurs(tmp_path):
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(
        name="postgres", cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    c.post("/v1/sparks/postgres/apply")
    assert c.get("/v1/forge/cores").json()["shared"]["capacity"] == 2.0
    c.post("/v1/sparks/postgres/delete")
    rendu = c.get("/v1/forge/cores").json()
    assert rendu["shared"]["capacity"] == 4.0 and rendu["dedicated"] == []


def test_une_decoupe_impossible_est_refusee_des_la_CREATION(tmp_path):
    """Revise le 2026-08-19 : le refus tombe plus tot qu'anticipe, et c'est mieux.

    Ce cas attendait un refus au moment de l'application. En pratique
    l'admission control l'attrape des la creation, parce que retirer ces coeurs
    laisserait les Sparks partages deja admis sans capacite (docs/DAT.md §7.7).
    L'exploitant est donc refuse avant qu'une ligne soit ecrite, ce qui vaut
    mieux que d'echouer plus tard sur un Spark en erreur. La preuve est revisee
    pour verifier CE comportement, et le garde-fou de la decoupe reste eprouve
    dans test_cores.py — il couvre le cas ou le pool change entre la creation et
    l'application.
    """
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="p", cpu_reservation=0.5))
    c.post("/v1/sparks/p/apply")

    refus = c.post("/v1/sparks", json=_spec(
        name="glouton", cpu_mode="dedicated", cpu_reservation=None, cpu_cores=4))
    assert refus.status_code == 409
    assert refus.json()["detail"]["error"] == "admission_refused"

    # Aucune ligne ecrite, aucun coeur bouge.
    assert c.get("/v1/sparks/glouton").status_code == 404
    assert c.get("/v1/forge/cores").json()["shared"]["capacity"] == 4.0


def test_un_dedie_qui_tient_est_admis_puis_decoupe(tmp_path):
    """La contrepartie : ce qui tient dans la capacite restante passe."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="p", cpu_reservation=0.5))
    c.post("/v1/sparks/p/apply")
    cree = c.post("/v1/sparks", json=_spec(
        name="pg", cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    assert cree.status_code == 201
    c.post("/v1/sparks/pg/apply")
    assert c.get("/v1/forge/cores").json()["shared"]["capacity"] == 2.0


# --- cles SSH par HTTP (SPK-11) --------------------------------------------

_CLE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fSF4BkF"
        "EV5LL5Sl2XoT poste")


def test_le_corps_de_la_cle_n_est_jamais_renvoye(tmp_path):
    """@verifies docs/DAT.md §17.2 — l'API expose libellé et empreinte."""
    c = _app(tmp_path)
    cree = c.post("/v1/ssh-keys", json={"label": "poste", "public_key": _CLE})
    assert cree.status_code == 201
    assert "public_key" not in cree.json()
    assert cree.json()["fingerprint"].startswith("SHA256:")
    assert all("public_key" not in k for k in c.get("/v1/ssh-keys").json()["keys"])


def test_cle_invalide_refusee_avec_un_message_utile(tmp_path):
    c = _app(tmp_path)
    r = c.post("/v1/ssh-keys", json={"label": "x",
                                     "public_key": "-----BEGIN OPENSSH PRIVATE KEY-----"})
    assert r.status_code == 422
    assert "PRIVÉE" in r.json()["detail"]["message"]


def test_accorder_puis_revoquer_reecrit_le_fichier(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-11 — un retrait retire réellement."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/ssh-keys", json={"label": "poste", "public_key": _CLE})

    c.post("/v1/sparks/crm/ssh-keys/poste")
    fichiers = c.app.state.incus.created["crm"]["files"]
    assert "ssh-ed25519" in fichiers["/root/.ssh/authorized_keys"]

    c.delete("/v1/sparks/crm/ssh-keys/poste")
    assert "ssh-ed25519" not in c.app.state.incus.created["crm"]["files"][
        "/root/.ssh/authorized_keys"]


def test_oublier_une_cle_reecrit_tous_les_sparks_concernes(tmp_path):
    """Retirer du registre ne suffit pas : la clé ouvrirait encore la porte."""
    c = _app(tmp_path)
    for nom in ("a", "b"):
        c.post("/v1/sparks", json=_spec(name=nom))
        c.post(f"/v1/sparks/{nom}/apply")
    c.post("/v1/ssh-keys", json={"label": "poste", "public_key": _CLE})
    c.post("/v1/sparks/a/ssh-keys/poste")
    c.post("/v1/sparks/b/ssh-keys/poste")

    r = c.delete("/v1/ssh-keys/poste")
    assert sorted(r.json()["reconciled"]) == ["a", "b"]
    for nom in ("a", "b"):
        assert "ssh-ed25519" not in c.app.state.incus.created[nom]["files"][
            "/root/.ssh/authorized_keys"]


def test_le_fragment_ssh_passe_par_le_rebond(tmp_path):
    """@verifies docs/DAT.md §17.4 — aucun port SSH public."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    config = c.get("/v1/sparks/crm/ssh-config").json()
    assert "ProxyJump spark-host" in config["config"]
    assert "HostName 10.77.0.16" in config["config"]
    assert "Port 22" not in config["config"]


def test_le_demarrage_provisionne_sshd_et_pose_les_cles(tmp_path):
    """@verifies docs/DAT.md §17.3 — un Spark neuf doit être joignable."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/ssh-keys", json={"label": "poste", "public_key": _CLE})
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/sparks/crm/ssh-keys/poste")
    c.post("/v1/sparks/crm/start")

    instance = c.app.state.incus.created["crm"]
    commandes = " ".join(" ".join(cmd) for cmd in instance["commands"])
    assert "openssh-server" in commandes
    assert "PasswordAuthentication no" in commandes
    assert "ssh-ed25519" in instance["files"]["/root/.ssh/authorized_keys"]


# --- ingress par HTTP (SPK-12) ---------------------------------------------

def test_declarer_une_route_l_applique_a_chaud(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-12 · docs/DAT.md §18.1"""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    r = c.post("/v1/ingress", json={"spark": "crm", "domain": "crm.example.com", "port": 8080})
    assert r.status_code == 201 and r.json()["applied_at"] is not None

    routes = c.app.state.caddy.config["apps"]["http"]["servers"]["spark"]["routes"]
    assert routes[0]["handle"][0]["upstreams"][0]["dial"] == "10.77.0.16:8080"


def test_conflit_de_domaine_refuse_par_http(tmp_path):
    c = _app(tmp_path)
    for nom in ("a", "b"):
        c.post("/v1/sparks", json=_spec(name=nom))
        c.post(f"/v1/sparks/{nom}/apply")
    c.post("/v1/ingress", json={"spark": "a", "domain": "x.example.com", "port": 80})
    refus = c.post("/v1/ingress", json={"spark": "b", "domain": "x.example.com", "port": 80})
    assert refus.status_code == 409
    assert "déjà routé" in refus.json()["detail"]["message"]


def test_supprimer_un_spark_retire_ses_routes_de_caddy(tmp_path):
    """Les routes disparaissent avec le Spark ; Caddy doit cesser de les servir."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/ingress", json={"spark": "crm", "domain": "crm.example.com", "port": 8080})
    def servies():
        return [r for r in c.app.state.caddy.config["apps"]["http"]["servers"]["spark"]["routes"]
                if "match" in r]
    assert len(servies()) == 1
    c.post("/v1/sparks/crm/delete")
    assert servies() == []


def test_reconciliation_reconstruit_tout(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-12 — reconstruction complète depuis le registre."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/ingress", json={"spark": "crm", "domain": "crm.example.com", "port": 8080})
    c.app.state.caddy.config = {"apps": {"http": {"servers": {}}}}   # Caddy dérive
    r = c.post("/v1/ingress/reconcile")
    assert r.json()["routes"] == 1
    assert c.app.state.caddy.config["apps"]["http"]["servers"]["spark"]["routes"]


# --- instantanes par HTTP (SPK-13) -----------------------------------------

def test_instantane_puis_restauration(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-13"""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    assert c.post("/v1/sparks/crm/snapshots", json={"name": "avant"}).status_code == 201
    r = c.post("/v1/sparks/crm/snapshots/avant/restore")
    assert r.status_code == 200 and r.json()["restored"] == "avant"


def test_restaurer_un_ancien_est_refuse_avec_la_sortie(tmp_path):
    """@verifies docs/DAT.md §19.1 — la perte ne se produit pas en silence."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/sparks/crm/snapshots", json={"name": "ancien"})
    c.post("/v1/sparks/crm/snapshots", json={"name": "recent"})

    refus = c.post("/v1/sparks/crm/snapshots/ancien/restore")
    assert refus.status_code == 409
    detail = refus.json()["detail"]
    assert detail["blocking"] == ["recent"]
    assert "accept_losing_newer" in detail["override"]

    force = c.post("/v1/sparks/crm/snapshots/ancien/restore",
                   json={"accept_losing_newer": True})
    assert force.json()["destroyed"] == ["recent"]


def test_la_liste_rappelle_qu_un_instantane_n_est_pas_une_sauvegarde(tmp_path):
    """@verifies docs/DAT.md §19.5 — la distinction doit être explicite."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    note = c.get("/v1/sparks/crm/snapshots").json()["note"]
    assert "ne protège ni de la perte du pool" in note
    assert "quota" in note


# --- metriques par HTTP (SPK-14) -------------------------------------------

def test_usage_d_un_spark_arrete_n_est_pas_nul(tmp_path):
    """@verifies docs/DAT.md §20.4"""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")          # état « stopped »
    u = c.get("/v1/sparks/crm/usage").json()
    assert u["cpu"] is None and u["disk"] is None
    assert "disque reste" in u["unavailable"]


def test_le_premier_releve_ne_pretend_pas_connaitre_le_taux(tmp_path):
    """@verifies docs/DAT.md §20.1 — null, jamais 0."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/sparks/crm/start")
    u = c.get("/v1/sparks/crm/usage").json()
    assert u["cpu"]["used"] is None
    assert u["window_seconds"] is None
    # Mais memoire et disque, instantanes, sont bien la.
    assert u["memory"]["used_bytes"] > 0
    assert u["disk"]["used_bytes"] > 0


def test_l_usage_reseau_se_compare_au_plafond(tmp_path):
    """@verifies docs/DAT.md §20.3"""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="crm", network_burst_bps=500_000_000))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/sparks/crm/start")
    reseau = c.get("/v1/sparks/crm/usage").json()["network"]
    assert reseau["limit_bps"] == 500_000_000
    assert reseau["reservation_bps"] == 100_000_000
    assert "seul le plafond" in reseau["note"]


# --- journal d'audit (SPK-15) ----------------------------------------------

_CLE_PRIVEE = ("-----BEGIN OPENSSH PRIVATE KEY-----\n"
               "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n"
               "-----END OPENSSH PRIVATE KEY-----")


def test_AUCUN_secret_n_atteint_le_journal(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-15 — la preuve que la DoD exige.

    On exerce l'API RÉELLE avec des secrets, puis on fouille TOUTE la table.
    Éprouver le filtre isolément ne prouverait rien sur ce qui est réellement
    écrit.
    """
    c = _app(tmp_path)

    # Un parcours complet, avec des secrets à chaque endroit qui en accepte.
    c.post("/v1/ssh-keys", json={"label": "poste", "public_key": _CLE})
    c.post("/v1/ssh-keys", json={"label": "fuite", "public_key": _CLE_PRIVEE})  # refusé
    c.post("/v1/sparks", json=_spec(name="crm"))
    c.post("/v1/sparks/crm/apply")
    c.post("/v1/sparks/crm/ssh-keys/poste")
    c.post("/v1/sparks/crm/start")
    c.post("/v1/ingress", json={"spark": "crm", "domain": "crm.example.com", "port": 8080})
    c.post("/v1/sparks/crm/snapshots", json={"name": "avant"})
    c.delete("/v1/sparks/crm/ssh-keys/poste")
    c.post("/v1/sparks", json=_spec(name="trop", cpu_reservation=99.0))          # refusé

    entrees = c.get("/v1/audit", params={"limit": 1000}).json()["entries"]
    assert len(entrees) > 8, "le parcours doit avoir laissé des traces"

    journal = " ".join(
        f"{e['message']} {e.get('payload') or ''}" for e in entrees
    )
    # Le corps des clés, publique comme privée, ne doit apparaître nulle part.
    corps_public = _CLE.split()[1]
    assert corps_public not in journal
    assert "BEGIN OPENSSH PRIVATE KEY" not in journal
    assert "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU" not in journal


def test_le_journal_reste_lisible_malgre_le_filtrage(tmp_path):
    """Caviarder tout ne serait pas un journal."""
    c = _app(tmp_path)
    c.post("/v1/ssh-keys", json={"label": "poste", "public_key": _CLE})
    c.post("/v1/sparks", json=_spec(name="crm"))

    entrees = c.get("/v1/audit").json()["entries"]
    actions = {e["action"] for e in entrees}
    assert "sshkey.register" in actions and "spark.create" in actions
    # L'empreinte reste : elle identifie la clé sans la révéler.
    assert any("SHA256:" in (e["message"] or "") for e in entrees)
    # Et le nom du Spark aussi.
    assert any("crm" in (e["message"] or "") for e in entrees)


def test_les_refus_sont_journalises_comme_les_succes(tmp_path):
    """@verifies docs/SCHEMA.md §9 — c'est la trace qui manque toujours."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec(name="gros", cpu_reservation=3.5))
    c.post("/v1/sparks", json=_spec(name="trop", cpu_reservation=1.0))   # refusé
    refus = c.get("/v1/audit", params={"result": "denied"}).json()["entries"]
    assert len(refus) >= 1
    assert any("cpu" in (e["message"] or "") for e in refus)


# --- la tranche est repondere a chaque changement d'allocation (§32.2) -------


def test_creer_puis_supprimer_repondere_la_tranche(tmp_path, monkeypatch):
    """Le poids doit SUIVRE l'allocation, pas rester figé.

    On enregistre chaque poids applique : creer doit le faire monter, supprimer
    le faire redescendre. Une constante echouerait ici, et c'est l'objet du test.
    """
    from sparkd import cgroup

    appliques = []
    monkeypatch.setattr(
        "sparkd.app.cgroup_service.apply_weight",
        lambda poids, root=None: appliques.append(poids.weight) or True,
    )

    app = create_app(load({"SPARKD_DB": str(tmp_path / "w.db"),
                           "SPARKD_DRIVER": "fake"}))
    client_http = TestClient(app)
    client_http.post("/v1/forge/sync")
    appliques.clear()

    GIO = 1024**3
    cree = client_http.post("/v1/sparks", json={
        "name": "poids", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 1.0, "memory_bytes": GIO,
        "storage_bytes": GIO, "network_bps": 10_000_000})
    assert cree.status_code == 201
    assert appliques, "aucune reponderation a la creation"
    apres_creation = appliques[-1]
    assert apres_creation > cgroup.WEIGHT_MIN, "vendre doit peser"

    client_http.post("/v1/sparks/poids/apply")
    client_http.post("/v1/sparks/poids/delete")
    assert appliques[-1] < apres_creation, "rendre la ressource doit alleger"


def test_une_tranche_absente_n_empeche_pas_de_creer_un_spark(tmp_path):
    """§32.4 — c'est un hote non prepare, pas une erreur de creation.

    Sur cette machine il n'y a pas de /sys/fs/cgroup/spark.slice : la creation
    doit reussir malgre tout. Le manque se constate au preflight, pas en rendant
    le produit inutilisable.
    """
    app = create_app(load({"SPARKD_DB": str(tmp_path / "s.db"),
                           "SPARKD_DRIVER": "fake"}))
    client_http = TestClient(app)
    client_http.post("/v1/forge/sync")
    GIO = 1024**3
    rendu = client_http.post("/v1/sparks", json={
        "name": "sans-tranche", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO,
        "storage_bytes": GIO, "network_bps": 10_000_000})
    assert rendu.status_code == 201


# --- SPK-57 · la route de redimensionnement (docs/DAT.md §49) ---------------


def test_redimensionner_par_http_ecrit_le_nouveau_quota(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.2"""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    vu = c.patch("/v1/sparks/crm-production",
                 json={"memory_reservation_bytes": 4 * 1024**3})
    assert vu.status_code == 200
    assert vu.json()["memory_reservation_bytes"] == 4 * 1024**3
    # Relu par une AUTRE requête : la valeur rendue pourrait mentir.
    assert c.get("/v1/sparks/crm-production").json()["memory_reservation_bytes"] \
        == 4 * 1024**3


def test_un_spark_PROTEGE_refuse_le_redimensionnement(tmp_path):
    """§49.5, §35.2 : le verrou porte sur l'objet, et redimensionner est une
    écriture. La protection se lève d'abord, par un geste distinct."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/protection",
           json={"password": "protege-moi"})
    vu = c.patch("/v1/sparks/crm-production",
                 json={"memory_reservation_bytes": 4 * 1024**3})
    # 423 « Locked », et non 403 : c'est la convention que le produit emploie
    # déjà pour un Spark protégé. En inventer une seconde pour ce geste ferait
    # traiter le même refus de deux façons dans la console.
    assert vu.status_code == 423
    # Le quota n'a PAS bougé : un refus ne laisse rien derrière lui.
    assert c.get("/v1/sparks/crm-production").json()["memory_reservation_bytes"] \
        == 2 * 1024**3


def test_les_trois_refus_ne_portent_PAS_le_meme_code(tmp_path):
    """§49.3 : confondre « il n'y a pas la place » et « ce que vous voulez
    retirer est utilisé » enverrait l'exploitant libérer de la place sur la
    Forge alors que le problème est dans la cellule."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())

    trop = c.patch("/v1/sparks/crm-production",
                   json={"memory_reservation_bytes": 900 * 1024**3})
    assert trop.status_code == 409
    assert trop.json()["detail"]["error"] == "admission_refused"
    assert trop.json()["detail"]["shortfalls"], "le refus est CHIFFRÉ (§7.7)"

    identite = c.patch("/v1/sparks/crm-production", json={"name": "autre"})
    assert identite.status_code == 409
    assert identite.json()["detail"]["error"] == "refused"

    absent = c.patch("/v1/sparks/fantome", json={"memory_reservation_bytes": 1})
    assert absent.status_code == 404


def test_le_redimensionnement_est_ATTEIGNABLE_dans_le_contrat(tmp_path):
    """Une route absente du contrat n'existe pas pour la console, qui en dérive
    ses types (SPK-17)."""
    c = _app(tmp_path)
    chemins = c.get("/openapi.json").json()["paths"]
    assert "patch" in chemins["/v1/sparks/{name}"]


def test_le_quota_est_POSE_sur_la_cellule_apres_le_registre(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.2

    Le pire des cas que la DoD de l'unité nomme est « un quota changé au registre
    mais pas dans le noyau ». `applied` distingue « en vigueur » de « promis »."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    vu = c.patch("/v1/sparks/crm-production",
                 json={"memory_reservation_bytes": 4 * 1024**3})
    assert vu.status_code == 200
    assert vu.json()["applied"] is True
    assert "apply_error" not in vu.json()


def test_sans_CELLULE_il_n_y_a_RIEN_a_poser_et_ce_n_est_pas_un_echec(tmp_path):
    """§14.6 : « rien à poser » n'est ni un succès de pose ni un échec. Les
    confondre ferait chercher une panne sur un Spark encore en attente."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())  # naît sans cellule

    vu = c.patch("/v1/sparks/crm-production",
                 json={"memory_reservation_bytes": 4 * 1024**3})
    assert vu.status_code == 200
    assert vu.json()["applied"] is None
    # Le registre, lui, a bien été écrit.
    assert vu.json()["memory_reservation_bytes"] == 4 * 1024**3


def test_un_echec_de_POSE_ne_defait_PAS_le_registre_et_le_DIT(tmp_path):
    """§49.2 : annuler ferait perdre l'admission déjà accordée et rouvrirait la
    course que la transaction du §14.2 vient de fermer. Mais l'écart ne se tait
    pas — c'est ce qui distingue « en vigueur » de « promis »."""
    from sparkd.incus import IncusError

    app = create_app(load({"SPARKD_DB": str(tmp_path / "e.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    def refuser(name, config):
        raise IncusError("le noyau a refusé la nouvelle limite mémoire")

    app.state.incus.update_instance_config = refuser

    vu = c.patch("/v1/sparks/crm-production",
                 json={"memory_reservation_bytes": 4 * 1024**3})
    assert vu.status_code == 200, "le geste n'échoue pas : le registre est écrit"
    assert vu.json()["applied"] is False
    assert "refusé" in vu.json()["apply_error"]
    # Le registre porte bien la nouvelle valeur : on surestime l'occupation
    # plutôt que de la sous-estimer, comme à la création.
    assert c.get("/v1/sparks/crm-production").json()["memory_reservation_bytes"] \
        == 4 * 1024**3


def test_la_route_PRONONCE_le_refus_du_DISQUE_occupe(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.3

    Le refus du disque existait au service depuis le premier jour, mais la route
    ne relevait que la mémoire : il n'était donc jamais prononcé en production.
    Un refus prouvé mais inatteignable ne protège personne.
    """
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")  # la cellule existe, à l'arrêt

    # 534 981 632 octets occupés — relevé du runtime. On demande moins.
    vu = c.patch("/v1/sparks/crm-production", json={"storage_bytes": 256 * 1024**2})
    assert vu.status_code == 409
    detail = vu.json()["detail"]
    # Et surtout PAS `admission_refused` : le problème est dans la cellule, pas
    # sur la Forge. Les confondre enverrait libérer de la place au mauvais
    # endroit (§49.3).
    assert detail["error"] == "shrink_refused"
    assert detail["resource"] == "storage"
    assert detail["in_use"] == 534_981_632, "le refus porte l'occupation MESURÉE"
    assert detail["requested"] == 256 * 1024**2
    # Un refus ne laisse rien derrière lui.
    assert c.get("/v1/sparks/crm-production").json()["storage_bytes"] == 10 * 1024**3


def test_le_DISQUE_se_releve_a_l_ARRET_mais_pas_la_MEMOIRE(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.3

    La dissymétrie n'est pas un oubli : une cellule arrêtée n'occupe aucune
    mémoire — refuser sur un chiffre périmé interdirait un rétrécissement
    légitime — tandis qu'elle occupe toujours son jeu de données.
    """
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")
    assert c.get("/v1/sparks/crm-production").json()["state"] == "stopped"

    # Le runtime annonce 174 764 032 octets de mémoire employée. Le Spark étant
    # ARRÊTÉ, ce chiffre ne vaut rien, et descendre sous lui est ADMIS.
    vu = c.patch("/v1/sparks/crm-production",
                 json={"memory_reservation_bytes": 128 * 1024**2})
    assert vu.status_code == 200, vu.json()
    assert vu.json()["memory_reservation_bytes"] == 128 * 1024**2

    # Le disque, lui, est bien relevé sur ce MÊME Spark arrêté.
    refus = c.patch("/v1/sparks/crm-production", json={"storage_bytes": 256 * 1024**2})
    assert refus.status_code == 409
    assert refus.json()["detail"]["error"] == "shrink_refused"


def test_un_runtime_MUET_ne_prononce_AUCUN_refus_de_retrecissement(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.3, §31.2

    L'absence de mesure est une RÉPONSE, pas une panne — et surtout pas une
    occupation inventée. Le produit préfère ne pas prononcer un refus plutôt que
    de le fonder sur un chiffre qu'il n'a pas.
    """
    from sparkd.incus import IncusError

    app = create_app(load({"SPARKD_DB": str(tmp_path / "m.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    def muet(name):
        raise IncusError("l'état de l'instance est indisponible")

    app.state.incus.instance_state = muet

    vu = c.patch("/v1/sparks/crm-production", json={"storage_bytes": 256 * 1024**2})
    assert vu.status_code == 200, "sans mesure, le refus n'est pas prononcé"
    assert vu.json()["storage_bytes"] == 256 * 1024**2


# --- SPK-58 · la matérialisation dans la cellule (docs/DAT.md §43.2) --------


def _cellule(app, nom="crm-production"):
    """Les fichiers que le doublon a réellement reçus pour cette cellule."""
    return (app.state.incus.created.get(nom) or {}).get("files") or {}


def test_l_environnement_est_POSE_des_la_creation_de_la_cellule(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-58 · docs/DAT.md §43.7

    Posé DÈS la création, de sorte qu'un `env_file:` du locataire ne casse pas
    sa pile au premier démarrage en désignant un fichier qui n'existe pas."""
    from sparkd import environnement as env

    app = create_app(load({"SPARKD_DB": str(tmp_path / "e.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    fichiers = _cellule(app)
    assert env.FICHIER_VARIABLES in fichiers
    assert env.FICHIER_SECRETS in fichiers
    assert env.FICHIER_PROFIL in fichiers


def test_le_fichier_des_SECRETS_est_repose_a_chaque_DEMARRAGE(tmp_path):
    """@verifies docs/DAT.md §43.5.2

    Il vit dans un tmpfs : il DISPARAÎT à l'arrêt de la cellule. Sans cette
    repose, un Spark redémarré perdrait ses secrets."""
    from sparkd import environnement as env

    app = create_app(load({"SPARKD_DB": str(tmp_path / "d.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    # Un secret est posé APRÈS la création : sans repose au démarrage, il
    # n'atteindrait jamais la cellule.
    with connect(tmp_path / "d.db") as registre:
        cle = env.charger_cle(app.state.config.secret_key_file)
        spark = registre.execute(
            "SELECT id FROM spark WHERE name = 'crm-production'").fetchone()
        env.poser(registre, cle, "spark", spark["id"], "TOKEN", "sk_42", secret=True)
        registre.commit()
    # On efface ce que la cellule avait reçu : c'est ce que fait un tmpfs.
    app.state.incus.created["crm-production"]["files"].pop(env.FICHIER_SECRETS)

    c.post("/v1/sparks/crm-production/start")
    assert "sk_42" in _cellule(app)[env.FICHIER_SECRETS]


def test_une_RESTAURATION_ne_laisse_pas_l_ancien_environnement_en_place(tmp_path):
    """@verifies docs/DAT.md §43.2

    Une restauration ramène l'ANCIEN fichier dans la cellule. L'état voulu
    reprend la main derrière — sans quoi le registre et la cellule diraient deux
    choses différentes, et c'est la cellule qui gagnerait."""
    from sparkd import environnement as env

    app = create_app(load({"SPARKD_DB": str(tmp_path / "r.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")
    c.post("/v1/sparks/crm-production/snapshots", json={"name": "avant"})

    with connect(tmp_path / "r.db") as registre:
        cle = env.charger_cle(app.state.config.secret_key_file)
        spark = registre.execute(
            "SELECT id FROM spark WHERE name = 'crm-production'").fetchone()
        env.poser(registre, cle, "spark", spark["id"], "APRES_INSTANTANE", "oui")
        registre.commit()
    # Ce que la restauration ramènerait : un fichier d'AVANT.
    app.state.incus.created["crm-production"]["files"][env.FICHIER_VARIABLES] = "# ancien\n"

    vu = c.post("/v1/sparks/crm-production/snapshots/avant/restore")
    assert vu.status_code == 200, vu.json()
    assert "APRES_INSTANTANE" in _cellule(app)[env.FICHIER_VARIABLES]


# --- SPK-58 · les routes d'environnement (docs/DAT.md §43.9.5) -------------


def test_poser_une_variable_par_HTTP_et_la_relire_avec_son_ORIGINE(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-58 · docs/DAT.md §43.6, §43.9.4

    La surcharge se fait NOM PAR NOM : surcharger `SMTP_HOST` ne doit pas faire
    perdre le `SMTP_PORT` hérité."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())

    assert c.put("/v1/env/SMTP_HOST", json={"value": "relais.forge"}).status_code == 200
    c.put("/v1/env/SMTP_PORT", json={"value": "587"})
    c.put("/v1/sparks/crm-production/env/SMTP_HOST", json={"value": "relais.crm"})

    rendu = {e["name"]: e for e in
             c.get("/v1/sparks/crm-production/env").json()["env"]}
    assert rendu["SMTP_HOST"]["value"] == "relais.crm"
    assert rendu["SMTP_HOST"]["origin"] == "overridden"
    assert rendu["SMTP_PORT"]["value"] == "587"
    assert rendu["SMTP_PORT"]["origin"] == "forge"


def test_aucune_route_ne_REVELE_un_secret(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-58 (Definition of Done) · §43.3

    On cherche la valeur dans CHAQUE sortie de l'API, pas seulement dans celle
    qu'on soupçonne."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.put("/v1/sparks/crm-production/env/STRIPE_API_KEY",
          json={"value": "sk_live_42", "secret": True})

    pose = c.put("/v1/sparks/crm-production/env/AUTRE", json={"value": "x"})
    for reponse in (c.get("/v1/sparks/crm-production/env"), c.get("/v1/env"),
                    c.get("/v1/sparks/crm-production"), c.get("/v1/audit"), pose):
        assert "sk_live_42" not in reponse.text, reponse.url

    entree = next(e for e in c.get("/v1/sparks/crm-production/env").json()["env"]
                  if e["name"] == "STRIPE_API_KEY")
    assert entree["value"] is None and entree["is_secret"] is True
    assert entree["fingerprint"], "l'empreinte, elle, est rendue : elle compare"


def test_un_Spark_PROTEGE_refuse_l_ecriture_qui_LE_vise(tmp_path):
    """§35.2, §43.9.5 : le verrou porte sur l'objet, et poser une variable est
    une écriture. Le code est celui que le produit emploie déjà."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/protection", json={"password": "protege-moi"})

    assert c.put("/v1/sparks/crm-production/env/TZ",
                 json={"value": "UTC"}).status_code == 423
    assert c.delete("/v1/sparks/crm-production/env/TZ").status_code == 423
    assert c.get("/v1/sparks/crm-production/env").json()["env"] == [], \
        "un refus ne laisse rien derrière lui"


def test_un_geste_de_FORGE_informe_des_Sparks_geles_puis_aboutit(tmp_path):
    """@verifies docs/DAT.md §43.9.5 bis

    Informer, PUIS accepter — la convention que le produit emploie déjà pour la
    révocation d'une clé. Un refus ferme gèlerait toute la Forge dès qu'un seul
    Spark est protégé, et l'exploitant lèverait la protection pour contourner."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/protection", json={"password": "protege-moi"})

    premier = c.put("/v1/env/TZ", json={"value": "UTC"})
    assert premier.status_code == 409
    detail = premier.json()["detail"]
    assert detail["error"] == "protected_sparks_affected"
    assert detail["protected_sparks"] == ["crm-production"], "ils sont NOMMÉS"

    second = c.put("/v1/env/TZ", json={"value": "UTC", "accept_protected": True})
    assert second.status_code == 200
    assert c.get("/v1/env").json()["env"][0]["value"] == "UTC"


def test_sans_Spark_protege_un_geste_de_Forge_ne_demande_RIEN(tmp_path):
    """Le refus par défaut sert à ne pas toucher un Spark gelé sans le savoir.
    Sans Spark gelé, il n'a aucune raison d'être."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    assert c.put("/v1/env/TZ", json={"value": "UTC"}).status_code == 200


def test_un_nom_hors_grammaire_du_shell_est_refuse_en_422(tmp_path):
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    vu = c.put("/v1/sparks/crm-production/env/AVEC-TIRET", json={"value": "x"})
    assert vu.status_code == 422
    assert vu.json()["detail"]["error"] == "invalid_name"


def test_ecrire_par_HTTP_REPOSE_les_fichiers_dans_la_cellule(tmp_path):
    """@verifies docs/DAT.md §43.2

    C'est le « au changement ». Sans lui, le registre et la cellule diraient
    deux choses différentes jusqu'au prochain démarrage."""
    from sparkd import environnement as env

    app = create_app(load({"SPARKD_DB": str(tmp_path / "h.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    c.put("/v1/sparks/crm-production/env/APP_NAME", json={"value": "crm"})
    assert "APP_NAME" in _cellule(app)[env.FICHIER_VARIABLES]

    # Et un RETRAIT retire du fichier : il est régénéré en entier.
    c.delete("/v1/sparks/crm-production/env/APP_NAME")
    assert "APP_NAME" not in _cellule(app)[env.FICHIER_VARIABLES]


def test_une_variable_de_FORGE_descend_dans_la_cellule_du_Spark(tmp_path):
    """§43.6 : ce qui est posé au niveau général est hérité, et doit donc
    atteindre la cellule sans qu'on touche au Spark."""
    from sparkd import environnement as env

    app = create_app(load({"SPARKD_DB": str(tmp_path / "f.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    c.put("/v1/env/TZ", json={"value": "Europe/Paris"})
    assert 'TZ="Europe/Paris"' in _cellule(app)[env.FICHIER_VARIABLES]


def test_retirer_ce_qui_n_existe_pas_repond_sans_ERREUR(tmp_path):
    """§14.5 : l'état voulu est « cette variable n'est pas définie », et il est
    atteint dans les deux cas. Le rendu dit lequel s'est produit."""
    c = _app(tmp_path)
    c.post("/v1/sparks", json=_spec())
    vu = c.delete("/v1/sparks/crm-production/env/JAMAIS_POSEE")
    assert vu.status_code == 200 and vu.json()["removed"] is False


def test_les_routes_d_environnement_sont_au_CONTRAT(tmp_path):
    """Une route absente du contrat n'existe pas pour la console (SPK-17)."""
    c = _app(tmp_path)
    chemins = c.get("/openapi.json").json()["paths"]
    assert "get" in chemins["/v1/env"]
    assert {"put", "delete"} <= set(chemins["/v1/env/{name}"])
    assert "get" in chemins["/v1/sparks/{name}/env"]
    assert {"put", "delete"} <= set(chemins["/v1/sparks/{name}/env/{variable}"])


def test_la_taille_du_disque_est_posee_sur_le_DEVICE_pas_la_config(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.2

    DÉFAUT MESURÉ sur la Forge de validation le 2026-08-21, et cette preuve
    l'aurait attrapé : la route posait la seule CONFIGURATION de l'instance. Or
    la taille du disque vit dans le device `root`. Le registre passait donc à
    12 Gio, Incus restait à 10 — et la réponse disait `applied: true`.

    C'est exactement le pire des cas que la Definition of Done de l'unité nomme :
    « un quota changé au registre mais pas dans le noyau ». Le champ `applied`
    ne vaut que ce que la pose vaut.
    """
    app = create_app(load({"SPARKD_DB": str(tmp_path / "d.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    vu = c.patch("/v1/sparks/crm-production", json={"storage_bytes": 12 * 1024**3})
    assert vu.status_code == 200 and vu.json()["applied"] is True

    racine = app.state.incus.created["crm-production"]["devices"]["root"]
    # La marge de métadonnées s'ajoute au quota vendu (§30) : on vérifie que la
    # taille posée SUIT la demande, pas qu'elle lui est égale.
    assert int(racine["size"]) >= 12 * 1024**3
    assert int(racine["size"]) < 13 * 1024**3


def test_redimensionner_REPONDERE_la_tranche(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §32.2

    DÉFAUT MESURÉ sur la Forge de validation le 2026-08-21 : après un
    aller-retour `shared` → `capped` → `shared`, `spark.slice` pesait **1** au
    lieu de la vingtaine que la loi prescrit. Le poids n'est pas une constante,
    et le §32.2 dit qu'il se recalcule à chaque changement d'allocation —
    « création, suppression, REDIMENSIONNEMENT ». Le troisième manquait.

    Conséquence : un simple redimensionnement rompait la promesse centrale du
    produit, en silence.
    """
    from sparkd import cgroup

    app = create_app(load({"SPARKD_DB": str(tmp_path / "p.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())

    poses = []
    app.state  # le service est monté
    reel = cgroup.apply_weight
    try:
        cgroup.apply_weight = lambda poids: poses.append(poids)
        # On repart d'une liste vide pour ne compter QUE le redimensionnement.
        poses.clear()
        vu = c.patch("/v1/sparks/crm-production",
                     json={"cpu_reservation": 1.5})
        assert vu.status_code == 200, vu.json()
    finally:
        cgroup.apply_weight = reel

    assert poses, "le redimensionnement doit repondérer la tranche (§32.2)"


def test_quitter_le_mode_DEDIE_rend_ses_coeurs_au_pool(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-57 · docs/DAT.md §7.4 bis

    La portée de SPK-57 le dit : « passer de `dedicated` à `shared` rend des
    cœurs qu'il faut redistribuer ». Sans cela, la capacité partagée reste
    amputée de cœurs que plus personne n'emploie — de la ressource perdue que
    rien ne rendrait jamais.
    """
    from sparkd import cores as core_pool

    app = create_app(load({"SPARKD_DB": str(tmp_path / "c.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec(cpu_mode="dedicated", cpu_cores=1,
                                    cpu_reservation=None))
    c.post("/v1/sparks/crm-production/apply")

    with connect(tmp_path / "c.db") as registre:
        spark = registre.execute(
            "SELECT id FROM spark WHERE name = 'crm-production'").fetchone()
        assert core_pool.dedicated_cpus(registre, spark["id"]), "il a bien des cœurs"

    vu = c.patch("/v1/sparks/crm-production",
                 json={"cpu_mode": "shared", "cpu_reservation": 0.5,
                       "cpu_cores": None})
    assert vu.status_code == 200, vu.json()

    with connect(tmp_path / "c.db") as registre:
        assert core_pool.dedicated_cpus(registre, spark["id"]) == [], \
            "les cœurs sont RENDUS au pool commun"


def test_le_DISQUE_est_pose_AVANT_la_configuration(tmp_path):
    """@verifies docs/BACKLOG.md#SPK-30, #SPK-57 · docs/DAT.md §8.8.1

    MESURÉ sur la Forge de validation le 2026-08-21, sur un dataset SATURÉ :

        ecrire la configuration -> ECHEC (backup.yaml: disk quota exceeded)
        agrandir le device      -> REUSSIT, et la cellule respire aussitot

    `backup.yaml` est écrit par Incus À L'INTÉRIEUR du jeu de données
    contingenté. Poser la configuration en premier échoue donc précisément sur un
    Spark plein — c'est-à-dire dans le seul cas où l'agrandissement est urgent.

    L'ordre est le remède, et cette preuve le garde : un jour où l'on
    réorganisera cette fonction, rien d'autre ne dira que l'ordre compte.
    """
    app = create_app(load({"SPARKD_DB": str(tmp_path / "o.db"), "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.post("/v1/sparks", json=_spec())
    c.post("/v1/sparks/crm-production/apply")

    ordre = []
    app.state.incus.update_root_size = lambda *a, **k: ordre.append("disque")
    app.state.incus.update_instance_config = lambda *a, **k: ordre.append("config")

    assert c.patch("/v1/sparks/crm-production",
                   json={"storage_bytes": 12 * 1024**3}).status_code == 200
    assert ordre == ["disque", "config"], (
        "le disque se pose AVANT la configuration : l'inverse laisse un Spark "
        "plein inadministrable (§8.8.1)")
