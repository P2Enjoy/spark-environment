"""@verifies docs/BACKLOG.md#SPK-23 · docs/DAT.md §28 (la pile et le seed),
           §28.3 (les mêmes chemins que l'application), §28.5 (ce qu'il
           démontre), §28.6 (rejouable à l'identique) · CLAUDE.md §8

Le seed est un CONTRAT maintenu : il doit démontrer chaque situation que les
écrans traitent. Un seed qui perd une fixture rend un écran inéprouvable sans
que rien ne le signale.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import seed as seed_module
from sparkd.app import create_app
from sparkd.config import load


@pytest.fixture
def config(tmp_path):
    return load({"SPARKD_DB": str(tmp_path / "seed.db"), "SPARKD_DRIVER": "fake"})


@pytest.fixture
def seede(config):
    seed_module.run(config)
    return TestClient(create_app(config))


def test_le_seed_produit_les_cinq_etats_annonces(seede):
    """§28.5 — chaque état que les écrans traitent doit exister quelque part."""
    etats = {s["name"]: s["state"] for s in seede.get("/v1/sparks").json()["sparks"]}
    assert etats == {
        "crm-production": "running",
        "boutique": "stopped",
        "postgres-dedie": "running",
        "analytics": "pending",
        "site-vitrine": "error",
    }


def test_l_etat_error_vient_du_vrai_chemin_d_erreur(seede):
    """§28.3 — pas une colonne remplie à la main.

    Un Spark en erreur porte `last_error` et a laissé un audit `error` : c'est
    la trace de `finish(success=False)`, donc du chemin qui aurait échoué en
    production.
    """
    spark = seede.get("/v1/sparks/site-vitrine").json()
    assert spark["last_error"], "un Spark en erreur doit dire POURQUOI"
    # Depuis SPK-32, une image invalide est refusee A LA CREATION : l'etat
    # `error` du seed vient donc de la seule injection de faute, ce qui eprouve
    # le vrai chemin d'erreur plutot qu'une reference impossible.
    assert "cgroup indisponible" in spark["last_error"]

    entrees = seede.get("/v1/audit?limit=500").json()["entries"]
    erreurs = [e for e in entrees if e["result"] == "error"]
    assert erreurs, "le chemin d'erreur doit avoir laissé sa trace"
    assert any(e["target_id"] == spark["id"] for e in erreurs)


def test_le_refus_d_admission_est_un_vrai_refus(seede):
    """§28.5 — le refus est produit par le contrôle d'admission, pas simulé."""
    refus = [e for e in seede.get("/v1/audit?limit=500").json()["entries"]
             if e["result"] == "denied" and e["action"] == "spark.create"]
    assert refus, "aucun refus de création au journal"
    # Le message chiffre ce qui manque : c'est la sortie du contrôle d'admission,
    # pas un texte écrit par le seed.
    assert any("Capacité insuffisante" in (e.get("message") or "") for e in refus)
    assert any("il manque" in (e.get("message") or "") for e in refus)
    # Le nom demandé ne figure PAS dans la trace : voir INC-02 du registre
    # d'incohérences. Le constat appartient à SPK-15, pas à cette unité.
    # Et le Spark refusé n'existe PAS : un refus qui laisserait une ligne
    # derrière lui aurait consommé de la capacité pour rien.
    assert seede.get("/v1/sparks/trop-gros").status_code == 404


def test_une_route_appliquee_et_une_qui_ne_l_est_pas(seede):
    """§18.5, §28.5 — sans les deux, le badge « non appliquée » est inéprouvable."""
    routes = {r["domain"]: r["applied_at"] for r in seede.get("/v1/ingress").json()["routes"]}
    assert routes["crm.example.com"], "la route nominale doit être appliquée"
    assert routes["analytics.example.com"] is None, (
        "il faut une route enregistrée mais non appliquée"
    )


def test_un_spark_a_ses_cles_et_un_autre_n_en_a_aucune(seede):
    """§26.4, §28.5 — l'absence nommée doit être atteignable à l'écran."""
    avec = seede.get("/v1/sparks/crm-production/ssh-config").json()["keys"]
    assert [c["label"] for c in avec] == ["poste-responsable"]
    assert seede.get("/v1/sparks/boutique/ssh-config").json()["keys"] == []
    # Le registre commun porte plus de clés que n'en a le Spark : sans cela,
    # la liste déroulante « accorder une clé » serait toujours vide.
    assert len(seede.get("/v1/ssh-keys").json()["keys"]) > len(avec)


def test_deux_instantanes_rendent_le_refus_de_restauration_atteignable(seede):
    """§19.1, §28.5 — restaurer le plus ancien doit être refusé."""
    instantanes = seede.get("/v1/sparks/crm-production/snapshots").json()["snapshots"]
    assert [s["incus_name"] for s in instantanes] == ["avant-deploiement", "apres-migration"]

    refus = seede.post("/v1/sparks/crm-production/snapshots/avant-deploiement/restore",
                       json={})
    assert refus.status_code == 409
    detail = refus.json()["detail"]
    assert detail["error"] == "blocked_by_newer_snapshots"
    assert detail["blocking"] == ["apres-migration"]


def test_un_spark_dedie_retire_des_coeurs_du_pool(seede):
    """§27.4, §28.5 — la carte des cœurs doit avoir quelque chose à montrer."""
    cores = seede.get("/v1/host/cores").json()
    assert cores["dedicated"], "aucun cœur dédié : la carte serait uniforme"
    assert len(cores["shared"]["cores"]) == cores["physical_cores"] - len(cores["dedicated"])


def test_le_journal_couvre_les_trois_resultats(seede):
    """§21, §28.5 — les trois badges du journal doivent être éprouvables."""
    resultats = {e["result"] for e in seede.get("/v1/audit?limit=500").json()["entries"]}
    assert {"ok", "denied", "error"} <= resultats


def test_le_seed_est_rejouable_a_l_identique(config):
    """§28.6 — une capture qui change sans que le produit change ne prouve rien."""
    def photographie() -> list[tuple]:
        client = TestClient(create_app(config))
        return sorted(
            (s["name"], s["state"], s["ipv4_address"])
            for s in client.get("/v1/sparks").json()["sparks"]
        )

    seed_module.run(config)
    premiere = photographie()
    seed_module.run(config)
    assert photographie() == premiere


def test_le_seed_refuse_un_pilote_reel(tmp_path):
    """Peupler un hôte RÉEL depuis un script de démonstration n'est pas prévu.

    Le refus vient du seed lui-même, pas d'une consigne : une commande de
    développement lancée par mégarde contre la production doit échouer.
    """
    reel = load({"SPARKD_DB": str(tmp_path / "x.db"), "SPARKD_DRIVER": "incus"})
    with pytest.raises(seed_module.SeedError, match="pilote factice"):
        seed_module.run(reel)


def test_le_seed_repart_d_un_registre_neuf(config, seede):
    """§28.6 — il ne complète pas un état existant.

    On crée un Spark hors seed, puis on rejoue : il doit avoir disparu. Sinon
    les captures dériveraient au fil des exécutions.
    """
    GIO = 1024**3
    cree = seede.post("/v1/sparks", json={
        "name": "intrus", "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.1, "memory_bytes": 128 * 1024**2,
        "storage_bytes": GIO, "network_bps": 10_000_000})
    assert cree.status_code == 201

    seed_module.run(config)
    apres = TestClient(create_app(config))
    assert apres.get("/v1/sparks/intrus").status_code == 404


def test_le_seed_s_arrete_plutot_que_de_produire_un_jeu_partiel(config, monkeypatch):
    """Un seed qui poursuit après un refus inattendu laisse des écrans vides.

    Les captures prises dessus mentiraient, et rien ne le signalerait.
    """
    original = seed_module.populate

    def tronque(client, incus, caddy):
        original(client, incus, caddy)
        # On retire une fixture APRÈS coup : la vérification doit mordre.
        client.delete("/v1/ingress/analytics.example.com")
        return {"sparks": 0, "routes": 0, "cles": 0, "instantanes": 0, "refus": 0}

    monkeypatch.setattr(seed_module, "populate", tronque)
    with pytest.raises(seed_module.SeedError, match="route non appliquée"):
        seed_module.run(config)
