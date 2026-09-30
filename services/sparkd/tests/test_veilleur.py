"""@verifies docs/BACKLOG.md#SPK-133 · docs/DAT.md §43.5.3 (un seul chemin
« après démarrage » ; le veilleur des démarrages et le PID d'init ;
`spark.cell_started`, événement du runtime ; une panne ne l'arrête pas),
§43.5.2 (le fichier des secrets vit dans un tmpfs)

Le défaut que ces preuves gardent, signalé par le responsable le 2026-09-30 :
« le fichier de secrets ne se recrée pas si on redémarre le Spark ». Le geste
*Redémarrer* relançait la cellule sans rien reposer, et aucun démarrage que
`sparkd` n'avait pas commandé ne reposait jamais rien. La pile du locataire ne
le découvrait qu'à sa création suivante, faute du fichier qu'`env_file:` exige.

Elles tiennent sur un doublon Incus FIDÈLE sur ce point : `/run` y est vidé à
l'arrêt, comme le tmpfs réel, et chaque démarrage y change le PID d'init. Un
doublon qui garderait `/run` rendrait vertes des preuves que le vrai hôte fait
échouer.
"""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from sparkd import veilleur as veilleur_service
from sparkd.app import create_app
from sparkd.config import load
from sparkd.incus import FakeIncus

GIO = 1024**3
SECRETS = "/run/spark/secrets"
SECRET = "sk_live_ne_doit_fuir_nulle_part"


def _app(tmp_path):
    return create_app(load({"SPARKD_DB": str(tmp_path / "b.db"),
                            "SPARKD_DRIVER": "fake"}))


def _client(tmp_path):
    client = TestClient(_app(tmp_path))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _spark_demarre(client, nom="helo"):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    assert client.put(f"/v1/sparks/{nom}/env/SMTP_PASSWORD", json={
        "value": SECRET, "secret": True}).status_code == 200
    return nom


def _fichiers(client, nom) -> dict:
    return client.app.state.incus.created[nom].get("files", {})


def _journal(client, action):
    lignes = client.get("/v1/audit", params={"limit": 200}).json()
    lignes = lignes.get("entries", lignes) if isinstance(lignes, dict) else lignes
    return [ligne for ligne in lignes if ligne["action"] == action]


# --- Le PID d'init : ce que la cellule dit d'elle-même (§43.5.3) ------------

@pytest.mark.parametrize("etat", [None, {}, {"pid": 0}, {"pid": -1},
                                  {"pid": "1234"}, {"pid": True}])
def test_un_etat_sans_PID_utilisable_ne_dit_rien(etat):
    """Une cellule arrêtée rend `0`. Le comparer à un PID connu ferait croire à
    un démarrage, et reposerait dans une cellule qui ne tourne pas."""
    assert veilleur_service.pid_d_init(etat) is None


def test_le_PID_d_init_se_lit_dans_l_etat_de_l_instance():
    assert veilleur_service.pid_d_init({"status": "Running", "pid": 4242}) == 4242


def test_le_doublon_change_de_PID_a_chaque_demarrage_et_vide_run_a_l_arret():
    """La fidélité du doublon est la condition de toutes les preuves ci-dessous."""
    incus = FakeIncus()
    incus.create_instance({"name": "c", "source": {"alias": "debian/13"}})
    incus.push_file("c", SECRETS, "A=1\n")
    incus.push_file("c", "/etc/spark/env", "B=2\n")
    avant = incus.instance_state("c")["pid"]

    incus.set_instance_state("c", "stop")
    assert incus.instance_state("c")["pid"] == 0
    assert SECRETS not in incus.created["c"]["files"], "le tmpfs ne survit pas"
    assert "/etc/spark/env" in incus.created["c"]["files"], "le jeu de données, si"

    incus.set_instance_state("c", "start")
    apres = incus.instance_state("c")["pid"]
    assert apres and apres != avant

    incus.demarrer_hors_produit("c")
    assert incus.instance_state("c")["pid"] not in (avant, apres)


# --- Un seul chemin « après démarrage » (§43.5.3) ---------------------------

def test_REDEMARRER_repose_le_fichier_des_secrets(tmp_path):
    """LE défaut signalé. Rouge sur le code d'avant : *Redémarrer* avait son
    propre chemin, qui ne reposait rien."""
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    assert SECRET in _fichiers(client, nom)[SECRETS]

    assert client.post(f"/v1/sparks/{nom}/restart").status_code == 200

    assert SECRET in _fichiers(client, nom).get(SECRETS, ""), (
        "après *Redémarrer*, le fichier des secrets doit être là")


def test_DEMARRER_apres_un_arret_repose_le_fichier_des_secrets(tmp_path):
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 200
    assert SECRETS not in _fichiers(client, nom)

    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200

    assert SECRET in _fichiers(client, nom)[SECRETS]


def test_un_demarrage_du_PRODUIT_n_est_pas_repose_une_seconde_fois(tmp_path):
    """Le chemin « après démarrage » dit au veilleur le PID qu'il a servi."""
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    veilleur = client.app.state.veilleur
    assert client.post(f"/v1/sparks/{nom}/restart").status_code == 200

    compte = veilleur.un_passage()

    assert compte["reposes"] == []
    assert _journal(client, veilleur_service.ACTION) == []


# --- Le veilleur : les démarrages que `sparkd` n'a pas commandés ------------

def test_un_REBOOT_dans_la_cellule_est_repose_et_journalise(tmp_path):
    """`reboot` tapé dans la cellule, `incus restart` à la main : le fichier
    manque, et le passage suivant le repose."""
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    client.app.state.incus.demarrer_hors_produit(nom)
    assert SECRETS not in _fichiers(client, nom)

    compte = client.app.state.veilleur.un_passage()

    assert compte["reposes"] == [nom]
    assert compte["hors_produit"] == [nom]
    assert SECRET in _fichiers(client, nom)[SECRETS]
    [ligne] = _journal(client, veilleur_service.ACTION)
    assert ligne["actor_class"] == "runtime"
    assert "hors du produit" in ligne["message"]
    assert SECRET not in str(ligne), "le journal ne porte jamais un secret"


def test_le_passage_suivant_ne_repose_rien(tmp_path):
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    client.app.state.incus.demarrer_hors_produit(nom)
    client.app.state.veilleur.un_passage()

    assert client.app.state.veilleur.un_passage()["reposes"] == []
    assert len(_journal(client, veilleur_service.ACTION)) == 1


def test_le_REDEMARRAGE_DE_LA_FORGE_est_repose_sans_inventer_de_cause(tmp_path):
    """Un `sparkd` neuf ne connaît aucun PID : son premier passage repose tout.
    Il ne sait pas qui a démarré la cellule, et ne l'écrit donc pas."""
    avant = _client(tmp_path)
    nom = _spark_demarre(avant)
    # La Forge redémarre : la cellule aussi, et son tmpfs est perdu.
    avant.app.state.incus.demarrer_hors_produit(nom)

    apres = TestClient(_app(tmp_path))
    compte = apres.app.state.veilleur.un_passage()

    assert compte["reposes"] == [nom]
    assert compte["hors_produit"] == []
    assert SECRET in _fichiers(apres, nom)[SECRETS]
    assert _journal(apres, veilleur_service.ACTION) == []


def test_un_Spark_ARRETE_n_est_pas_touche(tmp_path):
    """Le produit n'écrit rien dans une cellule arrêtée (§43.5.3)."""
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 200

    compte = TestClient(_app(tmp_path)).app.state.veilleur.un_passage()

    assert compte["releves"] == 0 and compte["reposes"] == []


def test_un_depot_RATE_n_est_pas_retenu_et_se_retente(tmp_path):
    """Retenir le PID d'un dépôt raté laisserait le fichier manquant pour de
    bon ; le passage suivant doit retenter."""
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    veilleur = client.app.state.veilleur
    client.app.state.incus.demarrer_hors_produit(nom)
    client.app.state.incus.fail_next["push_file"] = "Incus indisponible"

    rate = veilleur.un_passage()
    assert rate["erreurs"] == 1 and rate["reposes"] == []
    assert veilleur.erreurs == 1

    assert veilleur.un_passage()["reposes"] == [nom]
    assert SECRET in _fichiers(client, nom)[SECRETS]


def test_une_panne_du_registre_ne_tue_pas_le_veilleur(tmp_path):
    """§52.4 : une panne qui tuerait le fil ferait cesser les dépôts sans que
    rien ne le dise. On compte, et le passage suivant retente."""
    def ouvrir():
        raise OSError("registre illisible")

    veilleur = veilleur_service.Veilleur(ouvrir=ouvrir, incus=FakeIncus(),
                                         reposer=lambda c, s: None)
    assert veilleur.un_passage() is None
    assert veilleur.un_passage() is None
    assert veilleur.erreurs == 2


def test_un_GESTE_en_cours_soustrait_le_Spark_au_veilleur(tmp_path):
    """Sans cette exclusion, un passage tombé entre le démarrage commandé et le
    PID noté journaliserait un démarrage « hors du produit » qui ne l'était pas."""
    client = _client(tmp_path)
    nom = _spark_demarre(client)
    spark_id = client.get(f"/v1/sparks/{nom}").json()["id"]
    veilleur = client.app.state.veilleur
    client.app.state.incus.demarrer_hors_produit(nom)
    comptes: list[dict] = []

    with veilleur.geste(spark_id):
        fil = threading.Thread(target=lambda: comptes.append(veilleur.un_passage()))
        fil.start()
        fil.join(timeout=10)

    assert not fil.is_alive(), "un passage n'attend jamais un geste"
    assert comptes[0]["reposes"] == []
    assert veilleur.un_passage()["reposes"] == [nom], "le geste fini, il reprend"


def test_le_veilleur_tourne_tant_que_sparkd_sert(tmp_path):
    with TestClient(_app(tmp_path)) as client:
        veilleur = client.app.state.veilleur
        assert veilleur.is_alive()
    veilleur.join(timeout=5)
    assert not veilleur.is_alive(), "il s'arrête avec sparkd"


# --- Le doublon, sûr entre fils (rapport d'incohérences du 2026-09-23) ------

def test_le_doublon_ne_perd_plus_d_ecriture_simultanee(tmp_path):
    """Six fils qui persistaient quinze fois rendaient 84 erreurs sur 90 : tous
    écrivaient dans le même fichier provisoire. Le veilleur écrit désormais
    pendant que les requêtes écrivent — la course deviendrait quotidienne."""
    incus = FakeIncus(state_path=tmp_path / "b.db.incus.json")
    incus.create_instance({"name": "c", "source": {"alias": "debian/13"}})
    erreurs: list[BaseException] = []

    def ecrire():
        for _ in range(15):
            try:
                incus.push_file("c", "/etc/spark/x", "y")
            except BaseException as erreur:  # noqa: BLE001 — on les COMPTE
                erreurs.append(erreur)

    fils = [threading.Thread(target=ecrire) for _ in range(6)]
    for fil in fils:
        fil.start()
    for fil in fils:
        fil.join()

    assert erreurs == []
    assert list(tmp_path.glob("*.tmp")) == [], "aucun fichier provisoire orphelin"
