"""@verifies docs/BACKLOG.md#SPK-97 · docs/DAT.md §43.10 (coller un lot),
             §43.10.2 (le secret reste DÉCLARÉ), §43.10.3 (une route de lot,
             ses quatre garanties et ses refus), §43.3 (une valeur secrète
             n'apparaît nulle part), §43.6 (un lot de Forge ne descend pas seul),
             §43.9.5 bis (les Sparks protégés sont nommés avant) ·
             docs/SCHEMA.md §12.3 (la transaction)

Ce que ces preuves gardent en propre : **un lot passe en entier ou pas du
tout**. Un import à moitié posé ferait démarrer une pile à moitié configurée, et
c'est le mode de panne qui ne se voit pas — d'où la preuve d'atomicité, faite en
cassant volontairement la troisième écriture.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import environnement as env
from sparkd import migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "import.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id, name, image, state, cpu_mode, cpu_reservation, "
        "memory_reservation_bytes, network_reservation_bps, storage_bytes, "
        "created_at, updated_at) VALUES "
        "('S1', 'boutique', 'images:debian/13', 'stopped', 'shared', 0.5, "
        "1073741824, 100000000, 10737418240, '2026-09-08', '2026-09-08')")
    yield connection
    connection.close()


@pytest.fixture
def cle(tmp_path):
    return env.charger_cle(str(tmp_path / "k" / "secret.key"))


def _noms(connection, scope="forge"):
    return [r["name"] for r in connection.execute(
        "SELECT name FROM env_entry WHERE scope = ? ORDER BY name", (scope,))]


# --- le magasin (§43.10.3) --------------------------------------------------

def test_un_lot_ecrit_toutes_ses_entrees_et_nomme_celles_qu_il_REMPLACE(db, cle):
    """Le remplacement est la seule conséquence destructive du geste : il est
    relevé AVANT la première écriture, sans quoi plus rien ne le distingue."""
    env.poser(db, cle, "forge", None, "SMTP_HOST", "ancien.exemple.fr")

    lot = env.importer(db, cle, "forge", None, [
        ("SMTP_HOST", "mail.exemple.fr", False),
        ("SMTP_PORT", "587", False),
        ("SMTP_PASSWORD", "s3cr3t", True),
    ])

    assert lot.remplacees == ("SMTP_HOST",)
    assert [e.name for e in lot.entrees] == ["SMTP_HOST", "SMTP_PORT", "SMTP_PASSWORD"]
    assert _noms(db) == ["SMTP_HOST", "SMTP_PASSWORD", "SMTP_PORT"]
    valeurs = {e.name: e.value for e in env.lister(db)}
    assert valeurs["SMTP_HOST"] == "mail.exemple.fr"
    # §43.3 : la valeur d'un secret n'est pas rendue, même par le geste qui vient
    # de l'écrire.
    assert valeurs["SMTP_PASSWORD"] is None
    resolu = env.resoudre(db, cle, "S1")
    assert resolu["secrets"] == {} and resolu["variables"] == {}, (
        "un lot écrit au catalogue ne descend nulle part de lui-même (§43.6)")


def test_un_lot_VIDE_est_refuse_plutot_que_reussi_sans_rien_faire(db, cle):
    with pytest.raises(env.EnvError) as refus:
        env.importer(db, cle, "forge", None, [])
    assert refus.value.code == "empty_import"


def test_TOUS_les_noms_fautifs_sont_nommes_et_rien_n_est_ecrit(db, cle):
    """On corrige un lot en une fois. Nommer le premier fautif seul coûterait
    autant d'allers-retours que le lot a de fautes."""
    with pytest.raises(env.EnvError) as refus:
        env.importer(db, cle, "forge", None, [
            ("BON", "1", False),
            ("AVEC-TIRET", "2", False),
            ("2_CHIFFRE_EN_TETE", "3", False),
        ])
    assert refus.value.code == "invalid_name"
    assert "AVEC-TIRET" in str(refus.value)
    assert "2_CHIFFRE_EN_TETE" in str(refus.value)
    assert _noms(db) == [], "un lot refusé n'écrit AUCUNE de ses entrées"


def test_le_meme_nom_deux_fois_est_refuse_le_serveur_ne_choisit_pas(db, cle):
    with pytest.raises(env.EnvError) as refus:
        env.importer(db, cle, "forge", None, [
            ("SMTP_HOST", "un", False), ("SMTP_HOST", "deux", False)])
    assert refus.value.code == "duplicate_name"
    assert "SMTP_HOST" in str(refus.value)
    assert _noms(db) == []


def test_une_ecriture_qui_casse_au_MILIEU_du_lot_n_en_laisse_aucune(db, cle, monkeypatch):
    """La garantie n° 1 du §43.10.3, prouvée et non supposée.

    La validation des noms passe : la panne est donc APRÈS le point où le lot est
    accepté, exactement là où une écriture partielle serait possible."""
    vrai = env.poser
    appels = {"n": 0}

    def casse_au_troisieme(*args, **nommes):
        appels["n"] += 1
        if appels["n"] == 3:
            raise RuntimeError("le registre s'est dérobé")
        return vrai(*args, **nommes)

    monkeypatch.setattr(env, "poser", casse_au_troisieme)
    with pytest.raises(RuntimeError):
        env.importer(db, cle, "forge", None, [
            ("UN", "1", False), ("DEUX", "2", False), ("TROIS", "3", False)])
    assert _noms(db) == [], "les deux premières écritures doivent être annulées"


def test_le_journal_porte_le_GESTE_avec_les_noms_et_AUCUNE_valeur(db, cle):
    env.importer(db, cle, "forge", None, [
        ("SMTP_HOST", "mail.exemple.fr", False),
        ("SMTP_PASSWORD", "mot-de-passe-tres-reconnaissable", True),
    ])
    lignes = [dict(r) for r in db.execute("SELECT * FROM audit_log")]
    gestes = [l for l in lignes if l["action"] == "env.import"]
    assert len(gestes) == 1, "un import est UN geste, en plus des écritures"
    assert "SMTP_HOST" in gestes[0]["payload"] and "SMTP_PASSWORD" in gestes[0]["payload"]
    entier = "\n".join(str(v) for l in lignes for v in l.values())
    assert "mot-de-passe-tres-reconnaissable" not in entier
    assert "mail.exemple.fr" not in entier, (
        "le journal ne porte AUCUNE valeur, pas même celle d'une variable "
        "ordinaire (§43.3)")


def test_un_lot_de_SPARK_vaut_immediatement_pour_lui(db, cle):
    env.importer(db, cle, "spark", "S1", [("APP_ENV", "production", False),
                                          ("APP_KEY", "base64:xxx", True)])
    resolu = env.resoudre(db, cle, "S1")
    assert resolu["variables"] == {"APP_ENV": "production"}
    assert resolu["secrets"] == {"APP_KEY": "base64:xxx"}, (
        "un secret importé se déchiffre pour la cellule, et seulement pour elle")


# --- les routes (§43.10.3) --------------------------------------------------

@pytest.fixture
def client(tmp_path):
    app = create_app(load({"SPARKD_DB": str(tmp_path / "api.db"),
                           "SPARKD_DRIVER": "fake"}))
    c = TestClient(app)
    c.post("/v1/forge/sync")
    c.app_pour_les_tests = app
    return c


def _creer(client, nom="boutique"):
    reponse = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "network_bps": 10_000_000, "storage_bytes": 10 * GIO})
    assert reponse.status_code == 201, reponse.text
    client.post(f"/v1/sparks/{nom}/apply")
    return nom


def test_POST_import_ecrit_le_lot_au_catalogue_sans_le_faire_descendre(client):
    _creer(client)
    vu = client.post("/v1/env/import", json={"entries": [
        {"name": "SMTP_HOST", "value": "mail.exemple.fr"},
        {"name": "SMTP_PORT", "value": "587"}]})
    assert vu.status_code == 200, vu.text
    assert vu.json()["written"] == 2 and vu.json()["replaced"] == []

    catalogue = client.get("/v1/env").json()["env"]
    assert {e["name"] for e in catalogue} == {"SMTP_HOST", "SMTP_PORT"}
    assert all(e["selected_by"] == 0 for e in catalogue), (
        "§43.6 : un lot importé ne descend nulle part de lui-même")
    assert client.get("/v1/sparks/boutique/env").json()["env"] == []


def test_POST_import_sur_un_Spark_atteint_sa_CELLULE_en_une_seule_repose(client):
    _creer(client)
    vu = client.post("/v1/sparks/boutique/env/import", json={"entries": [
        {"name": "APP_ENV", "value": "production"},
        {"name": "APP_KEY", "value": "sk_ne_doit_pas_sortir", "secret": True}]})
    assert vu.status_code == 200, vu.text

    rendu = client.get("/v1/sparks/boutique/env").json()["env"]
    assert {e["name"]: e["origin"] for e in rendu} == {
        "APP_ENV": "spark", "APP_KEY": "spark"}
    fichiers = (client.app_pour_les_tests.state.incus.created["boutique"]["files"])
    assert "production" in fichiers[env.FICHIER_VARIABLES]
    assert "sk_ne_doit_pas_sortir" in fichiers[env.FICHIER_SECRETS]
    # §43.5.2 : le secret ne va PAS dans le fichier persistant, ni dans le confort.
    assert "sk_ne_doit_pas_sortir" not in fichiers[env.FICHIER_VARIABLES]
    assert "sk_ne_doit_pas_sortir" not in fichiers[env.FICHIER_PROFIL]


def test_la_valeur_d_un_secret_IMPORTE_ne_sort_par_aucune_route(client):
    """§43.3 : l'import n'ouvre aucune voie de relecture. Cherchée, pas supposée."""
    _creer(client)
    client.post("/v1/sparks/boutique/env/import", json={"entries": [
        {"name": "APP_KEY", "value": "sk_ne_doit_pas_sortir", "secret": True}]})
    for route in ("/v1/env", "/v1/sparks/boutique/env",
                  "/v1/sparks/boutique", "/v1/audit"):
        vu = client.get(route)
        assert vu.status_code == 200, f"{route} : {vu.text}"
        assert "sk_ne_doit_pas_sortir" not in vu.text, route
    empreinte = [e for e in client.get("/v1/sparks/boutique/env").json()["env"]
                 if e["name"] == "APP_KEY"][0]
    assert empreinte["value"] is None and empreinte["fingerprint"]


@pytest.mark.parametrize("corps, code, statut", [
    ({"entries": []}, "empty_import", 422),
    ({"entries": [{"name": "AVEC-TIRET", "value": "x"}]}, "invalid_name", 422),
    ({"entries": [{"name": "A", "value": "1"}, {"name": "A", "value": "2"}]},
     "duplicate_name", 422),
    ({"entries": "SMTP_HOST=mail"}, "invalid_body", 422),
    ({"entries": [{"value": "sans nom"}]}, "invalid_body", 422),
])
def test_chaque_refus_du_lot_a_son_code(client, corps, code, statut):
    """§43.10.3 : chacun distinct. Un code unique obligerait l'écran à lire le
    message pour savoir quoi montrer."""
    vu = client.post("/v1/env/import", json=corps)
    assert vu.status_code == statut, vu.text
    assert vu.json()["detail"]["error"] == code
    assert client.get("/v1/env").json()["env"] == [], "un refus n'écrit rien"


def test_un_Spark_INCONNU_repond_404(client):
    vu = client.post("/v1/sparks/absent/env/import",
                     json={"entries": [{"name": "A", "value": "1"}]})
    assert vu.status_code == 404 and vu.json()["detail"]["error"] == "not_found"


def test_un_Spark_PROTEGE_refuse_le_lot_en_423(client):
    """§35.2 : le verrou porte sur l'objet, et importer est une écriture qui LE
    vise."""
    _creer(client)
    client.post("/v1/sparks/boutique/protection", json={"password": "gele"})
    vu = client.post("/v1/sparks/boutique/env/import",
                     json={"entries": [{"name": "A", "value": "1"}]})
    assert vu.status_code == 423, vu.text
    assert client.get("/v1/sparks/boutique/env").json()["env"] == []


def test_un_lot_de_FORGE_nomme_les_Sparks_proteges_puis_aboutit(client):
    """§43.9.5 bis : informer, puis accepter. Et UNE seule question pour tout le
    lot, quel que soit le nombre d'entrées cochées par le même Spark."""
    _creer(client)
    client.put("/v1/env/SMTP_HOST", json={"value": "ancien"})
    client.put("/v1/env/SMTP_PORT", json={"value": "25"})
    client.post("/v1/sparks/boutique/env/selection/SMTP_HOST")
    client.post("/v1/sparks/boutique/env/selection/SMTP_PORT")
    client.post("/v1/sparks/boutique/protection", json={"password": "gele"})

    lot = {"entries": [{"name": "SMTP_HOST", "value": "neuf.exemple.fr"},
                       {"name": "SMTP_PORT", "value": "587"},
                       {"name": "SMTP_USER", "value": "postier"}]}
    refus = client.post("/v1/env/import", json=lot)
    assert refus.status_code == 409, refus.text
    assert refus.json()["detail"]["error"] == "protected_sparks_affected"
    assert refus.json()["detail"]["protected_sparks"] == ["boutique"]
    assert client.get("/v1/env").json()["env"][0]["value"] == "ancien", (
        "un refus de la garde n'écrit rien")

    accepte = client.post("/v1/env/import", json={**lot, "accept_protected": True})
    assert accepte.status_code == 200, accepte.text
    assert sorted(accepte.json()["replaced"]) == ["SMTP_HOST", "SMTP_PORT"]
    assert client.get("/v1/sparks/boutique/protection").json()["protected"] is True, (
        "aucune protection n'est levée par le geste")
    fichiers = client.app_pour_les_tests.state.incus.created["boutique"]["files"]
    assert "neuf.exemple.fr" in fichiers[env.FICHIER_VARIABLES]


def test_un_lot_de_Forge_dont_AUCUNE_entree_n_est_cochee_ne_demande_rien(client):
    """La confirmation porte sur les destinataires, jamais sur un Spark protégé
    qui n'a pas choisi l'entrée (§43.9.5 bis)."""
    _creer(client)
    client.post("/v1/sparks/boutique/protection", json={"password": "gele"})
    vu = client.post("/v1/env/import",
                     json={"entries": [{"name": "TOUT_NEUF", "value": "1"}]})
    assert vu.status_code == 200, vu.text


# --- la symétrie avec l'écriture (§43.10.1, §43.9.7) ------------------------

def test_ce_que_citer_ECRIT_est_exactement_ce_que_l_analyseur_relit():
    """L'import lit ce que le produit écrit (§43.10.1).

    Ces littéraux sont épinglés des DEUX côtés : `env-import.test.js` recolle les
    mêmes lignes et attend les mêmes valeurs. Si l'encodage change d'un côté, un
    des deux fichiers rougit — sans quoi le fichier posé par le produit
    deviendrait la seule chose qu'on ne peut pas lui redonner, et personne ne
    s'en apercevrait avant de le tenter."""
    ecrites = [
        ("ab'cd", 'A="ab\'cd"'),
        ("ab$cd", r'A="ab\$cd"'),
        ('ab"cd', r'A="ab\"cd"'),
        ("a\\b", r'A="a\\b"'),
        ("  garde  ", 'A="  garde  "'),
        ("a\nb", r'A="a\nb"'),
    ]
    for valeur, ligne in ecrites:
        assert f"A={env.citer(valeur)}" == ligne, valeur
