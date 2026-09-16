"""@verifies docs/BACKLOG.md#SPK-105 · docs/DAT.md §55 (la règle sans exception),
             §55.3 (les six paires), §55.3.1 (`/etc/spark/routes`), §55.4 (une
             suggestion n'est pas une écriture), §55.5 (consulter ne consomme
             pas), §55.5.1 (comment l'agent apprend le sort de sa demande),
             §55.5.2 (l'empreinte relue), §55.6 (permissions), §55.8 (la surface)
             · docs/BACKLOG.md#SPK-107 · docs/DAT.md §55.3.3 (le vide est une
             DEMANDE, et l'étiquette l'explique), §55.7 (ce que l'en-tête doit
             dire) · §18.4 (l'unicité du domaine) · §54.6 (la garde des secrets)

Le point de ces preuves est ce qui N'ARRIVE PAS : un fichier consulté qui reste,
une proposition en attente qu'aucune projection n'écrase, un refus du produit qui
ne consomme rien. Chacun de ces trois cas détruirait, s'il tournait mal, le
travail de quelqu'un qui n'est pas là pour s'en plaindre.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import notes, suggestions
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

SECRET = "mot-de-passe-de-recette-9d8c7b6a"


@pytest.fixture
def client(tmp_path):
    c = TestClient(create_app(load({
        "SPARKD_DB": str(tmp_path / "sugg.db"), "SPARKD_DRIVER": "fake",
    })))
    assert c.post("/v1/forge/sync").status_code in (200, 201)
    return c


def creer(client, nom="atelier", *, demarrer=True):
    reponse = client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO,
        "storage_bytes": 5 * GIO, "network_bps": 10_000_000,
    })
    assert reponse.status_code == 201, reponse.text
    if demarrer:
        assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
        assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def fichiers(client, nom):
    return client.app.state.incus.created[nom].get("files", {})


def deposer(client, nom, kind, texte):
    """Ce que fait un agent dans la cellule : il ÉCRIT dans le `.?`.

    Il garde l'en-tête posé par le produit et écrit dessous — c'est le geste
    naturel, et celui que `sans_entete` doit savoir défaire.
    """
    client.app.state.incus.push_file(
        nom, suggestions.chemin(kind), suggestions.entete(kind) + texte)


def lire(client, nom, kind=None):
    rendu = client.get(f"/v1/sparks/{nom}/suggestions")
    assert rendu.status_code == 200, rendu.text
    corps = rendu.json()
    if kind is None:
        return corps
    return next(s for s in corps["suggestions"] if s["kind"] == kind)


# --- les `.?` sont posés, et vides ------------------------------------------


def test_les_six_paires_sont_posees_VIDES_des_la_creation(client):
    """§55.5 : c'est ce qui rend le mécanisme découvrable d'un `ls`, et ce qui
    permet au groupe d'y écrire sans droit sur le répertoire (§55.6)."""
    nom = creer(client)
    poses = fichiers(client, nom)

    for kind in suggestions.NATURES:
        chemin = suggestions.chemin(kind)
        assert chemin in poses, f"« {kind} » doit exister avant qu'on l'écrive"
        assert chemin.endswith(".?")
        # Posé vide veut dire : rien que l'en-tête. Le produit ne fait pas de
        # différence entre un fichier absent et un fichier sans texte (§55.5).
        assert suggestions.vide(kind, poses[chemin])

    vues = lire(client, nom)
    assert vues["cell_read"] is True
    assert [s["kind"] for s in vues["suggestions"]] == list(suggestions.NATURES)
    assert all(s["present"] is False for s in vues["suggestions"])
    assert all(s["sha256"] is None for s in vues["suggestions"])


def test_l_entete_dit_ce_qu_on_attend_la_et_ce_qui_arrivera(client):
    """§55.7 : à quoi il sert, quelle grammaire, quel effet, et qu'il redeviendra
    vide. Sans le dernier point, l'agent qui revient croit avoir été ignoré."""
    nom = creer(client)
    poses = fichiers(client, nom)

    variables = poses[suggestions.chemin("variables")]
    assert "AJOUTÉ ou REMPLACE" in variables
    assert "redeviendra VIDE" in variables
    assert "n'applique rien" in variables
    assert "/etc/spark/env" in variables, "il nomme le fichier réel d'à côté"
    # Chaque ligne est un commentaire : la grammaire du §43.10.1 l'ignore, donc
    # un agent peut écrire dessous sans rien supprimer.
    entete = variables.split(suggestions.FIN_DIESE)[0]
    assert all(l.startswith("#") for l in entete.splitlines() if l)

    readme = poses[suggestions.chemin("readme")]
    assert "REMPLACE le texte en entier" in readme
    assert readme.startswith("<!-- "), "une note est du Markdown, pas du shell"

    # §55.6.1 : le seul des six dont la proposition est périssable. Le taire
    # ferait chercher un refus qui n'a pas eu lieu.
    assert "TMPFS" in poses[suggestions.chemin("secrets")]
    assert "TMPFS" not in variables


def test_l_entete_des_deux_env_dit_le_VIDE_et_l_ETIQUETTE(client):
    """SPK-107 · §55.3.3, §55.7 : le taire laisserait l'agent inventer une valeur
    de remplissage — acceptée sans être regardée, et la pile casse au démarrage
    suivant. Les quatre autres paires n'en parlent pas : une route incomplète est
    refusée, et un texte n'a pas de valeur à demander."""
    nom = creer(client)
    poses = fichiers(client, nom)

    for kind in ("variables", "secrets"):
        entete = poses[suggestions.chemin(kind)]
        assert "Laissez-la VIDE" in entete
        assert "N'inventez pas une valeur de remplissage." in entete
        assert "JUSTE AU-DESSUS" in entete
        assert str(suggestions.ETIQUETTE_MAX) in entete
        # L'exemple est DANS le bloc de commentaires : il ne doit pas se lire
        # comme une proposition déjà déposée.
        assert suggestions.vide(kind, entete), "l'en-tête seul vaut absence"

    for kind in ("routes", "readme"):
        assert "Laissez-la VIDE" not in poses[suggestions.chemin(kind)]


def test_le_fichier_REEL_des_routes_est_pose_et_relu_a_chaque_changement(client):
    """§55.3.1 : il manquait. Une cellule ne pouvait lire les routes qui la
    visent qu'en analysant `BRIEFING.md`, une présentation faite pour être lue.

    Et il porte la MÊME grammaire que sa proposition : l'agent lit et écrit la
    même chose (§43.10.1).
    """
    nom = creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200
    vu = fichiers(client, nom)[suggestions.FICHIER_ROUTES]
    assert "Aucune route ne vise ce Spark" in vu

    assert client.post("/v1/ingress", json={
        "spark": nom, "domain": "sso.exemple.test", "port": 8080,
        "tls": True}).status_code in (201, 502)
    vu = fichiers(client, nom)[suggestions.FICHIER_ROUTES]
    assert "sso.exemple.test 8080 tls" in vu
    assert "Aucune route" not in vu

    assert client.delete("/v1/ingress/sso.exemple.test").status_code == 200
    assert "sso.exemple.test" not in fichiers(client, nom)[
        suggestions.FICHIER_ROUTES]


# --- consulter ne consomme pas (§55.5) --------------------------------------


def test_CONSULTER_ne_consomme_pas_la_proposition(client):
    """LA règle du §55.5, et la raison pour laquelle la disparition du fichier
    peut servir de signal (§55.5.1).

    Un fichier consommé à la lecture ferait disparaître une demande que personne
    n'a refusée — et son auteur n'aurait aucun moyen de le savoir.
    """
    nom = creer(client)
    deposer(client, nom, "variables", "REDIS_URL=redis://cache:6379\n")

    for _ in range(3):
        vue = lire(client, nom, "variables")
        assert vue["present"] is True
        assert vue["body"] == "REDIS_URL=redis://cache:6379"
        assert vue["sha256"]

    assert not suggestions.vide(
        "variables", fichiers(client, nom)[suggestions.chemin("variables")])


def test_une_projection_n_ECRASE_JAMAIS_une_proposition_en_attente(client):
    """§55.5 : écraser une proposition au premier geste venu détruirait
    exactement ce que cette unité existe pour transporter."""
    nom = creer(client)
    deposer(client, nom, "variables", "REDIS_URL=redis://cache:6379\n")

    # Trois gestes du plan de contrôle qui reposent des fichiers dans la cellule.
    assert client.put(f"/v1/sparks/{nom}/env/AUTRE", json={
        "value": "x", "secret": False}).status_code == 200
    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200

    assert lire(client, nom, "variables")["body"] == "REDIS_URL=redis://cache:6379"


def test_un_agent_qui_ecrit_SANS_l_entete_est_lu_quand_meme(client):
    """Un fichier écrit de zéro — `printf … > …` — est parfaitement valide.

    Exiger l'en-tête ferait échouer le geste le plus naturel, et l'agent
    n'aurait aucun message pour le lui dire.
    """
    nom = creer(client)
    client.app.state.incus.push_file(
        nom, suggestions.chemin("routes"), "api.exemple.test 3000 clair\n")
    assert lire(client, nom, "routes")["body"] == "api.exemple.test 3000 clair"


# --- accepter et refuser vident (§55.5) -------------------------------------


def test_ACCEPTER_ecrit_au_registre_ET_vide_le_fichier(client):
    nom = creer(client)
    deposer(client, nom, "variables",
            "REDIS_URL=redis://cache:6379\nLOG_LEVEL=debug\n")
    vue = lire(client, nom, "variables")

    rendu = client.post(f"/v1/sparks/{nom}/suggestions/variables/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"name": "REDIS_URL", "value": "redis://cache:6379",
                     "secret": False},
                    {"name": "LOG_LEVEL", "value": "debug", "secret": False}],
    })
    assert rendu.status_code == 200, rendu.text
    assert rendu.json()["cleared"] is True
    assert sorted(rendu.json()["imported"]) == ["LOG_LEVEL", "REDIS_URL"]

    # §55.5.1 : le `.?` redevenu vide DIT qu'une décision a été prise, et le
    # fichier réel d'à côté dit laquelle. Les deux se lisent d'un même regard.
    assert lire(client, nom, "variables")["present"] is False
    assert "REDIS_URL" in fichiers(client, nom)[suggestions.FICHIER_VARIABLES]


def test_une_acceptation_PARTIELLE_vide_quand_meme_tout(client):
    """§55.5 : ce qui n'a pas été retenu a été refusé, pas ajourné.

    Laisser le reliquat ferait revenir à chaque ouverture les lignes qu'on vient
    d'écarter, et l'écran finirait par être fermé sans être lu.
    """
    nom = creer(client)
    deposer(client, nom, "variables", "GARDEE=oui\nECARTEE=non\n")
    vue = lire(client, nom, "variables")

    rendu = client.post(f"/v1/sparks/{nom}/suggestions/variables/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"name": "GARDEE", "value": "oui", "secret": False}],
    })
    assert rendu.status_code == 200, rendu.text
    assert lire(client, nom, "variables")["present"] is False

    pose = fichiers(client, nom)[suggestions.FICHIER_VARIABLES]
    assert "GARDEE" in pose
    assert "ECARTEE" not in pose


def test_REFUSER_vide_sans_rien_ecrire(client):
    nom = creer(client)
    deposer(client, nom, "variables", "JAMAIS=posee\n")
    vue = lire(client, nom, "variables")

    rendu = client.post(f"/v1/sparks/{nom}/suggestions/variables/reject",
                        json={"sha256": vue["sha256"]})
    assert rendu.status_code == 200, rendu.text
    assert rendu.json()["cleared"] is True
    assert lire(client, nom, "variables")["present"] is False
    assert "JAMAIS" not in fichiers(client, nom)[suggestions.FICHIER_VARIABLES]


def test_accepter_et_refuser_se_distinguent_AU_JOURNAL(client):
    """Les deux vident le fichier ; ils ne disent pas la même chose. Sans cette
    distinction, on ne pourrait plus savoir si une demande a été examinée et
    écartée, ou accordée."""
    nom = creer(client)
    deposer(client, nom, "variables", "A=1\n")
    client.post(f"/v1/sparks/{nom}/suggestions/variables/reject",
                json={"sha256": lire(client, nom, "variables")["sha256"]})

    actions = [e["action"] for e in client.get("/v1/audit").json()["entries"]]
    assert "spark.suggestion.reject" in actions
    assert "spark.suggestion.apply" not in actions


def test_le_journal_ne_porte_AUCUNE_valeur_proposee(client):
    """§21.4 : `secrets.?` porte des valeurs en clair par construction. Le
    journal en retient la nature et le compte, jamais le contenu."""
    nom = creer(client)
    deposer(client, nom, "secrets", f"SMTP_PASSWORD={SECRET}\n")
    vue = lire(client, nom, "secrets")
    assert client.post(f"/v1/sparks/{nom}/suggestions/secrets/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"name": "SMTP_PASSWORD", "value": SECRET, "secret": True}],
    }).status_code == 200

    trace = client.get("/v1/audit").text
    assert "spark.suggestion.apply" in trace
    assert SECRET not in trace


# --- l'empreinte relue (§55.5.2) --------------------------------------------


def test_une_proposition_REECRITE_entre_temps_est_refusee(client):
    """§55.5.2 : appliquer le contenu courant ferait écrire au registre un texte
    que personne n'a lu."""
    nom = creer(client)
    deposer(client, nom, "variables", "A=1\n")
    vue = lire(client, nom, "variables")

    # L'agent réécrit pendant que le propriétaire réfléchit.
    deposer(client, nom, "variables", "A=1\nB=2\n")

    refus = client.post(f"/v1/sparks/{nom}/suggestions/variables/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"name": "A", "value": "1", "secret": False}],
    })
    assert refus.status_code == 409, refus.text
    detail = refus.json()["detail"]
    assert detail["error"] == "stale_suggestion"
    assert detail["current"]["body"] == "A=1\nB=2", (
        "le refus MONTRE ce qu'on allait accorder sans l'avoir lu")

    # Rien n'a été écrit, et le fichier n'a pas été vidé.
    assert "A=" not in fichiers(client, nom)[suggestions.FICHIER_VARIABLES]
    assert lire(client, nom, "variables")["present"] is True


def test_un_refus_porte_lui_aussi_l_empreinte_relue(client):
    """Refuser sans avoir lu est aussi grave qu'accepter sans avoir lu : on
    jette le travail de quelqu'un."""
    nom = creer(client)
    deposer(client, nom, "variables", "A=1\n")
    refus = client.post(f"/v1/sparks/{nom}/suggestions/variables/reject",
                        json={"sha256": "0" * 64})
    assert refus.status_code == 409
    assert lire(client, nom, "variables")["present"] is True


def test_accepter_une_proposition_ABSENTE_est_refuse(client):
    nom = creer(client)
    refus = client.post(f"/v1/sparks/{nom}/suggestions/routes/apply",
                        json={"sha256": "0" * 64, "entries": []})
    assert refus.status_code == 422
    assert refus.json()["detail"]["error"] == "no_suggestion"


# --- un refus du PRODUIT ne consomme pas (§55.5) ----------------------------


def test_un_texte_de_note_portant_un_SECRET_est_refuse_SANS_etre_consomme(client):
    """§54.6 et §55.5 : c'est ce qui permet à son auteur de corriger.

    Vider le fichier ici lui ferait croire que sa note a été refusée pour une
    raison qu'il ne connaîtra jamais — et il la redéposerait à l'identique.
    """
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/SMTP_PASSWORD", json={
        "value": SECRET, "secret": True}).status_code == 200
    deposer(client, nom, "install", f"Se connecter avec {SECRET}.")
    vue = lire(client, nom, "install")

    refus = client.post(f"/v1/sparks/{nom}/suggestions/install/apply", json={
        "sha256": vue["sha256"], "body": vue["body"]})
    assert refus.status_code == 422, refus.text
    assert refus.json()["detail"]["error"] == "secret_in_note"
    assert "SMTP_PASSWORD" in refus.json()["detail"]["message"]
    assert SECRET not in refus.json()["detail"]["message"]

    assert lire(client, nom, "install")["present"] is True, (
        "un refus du produit NE consomme PAS : l'auteur doit pouvoir corriger")


def test_un_nom_hors_grammaire_est_refuse_SANS_etre_consomme(client):
    """§43.9.1 : le contrôle est celui du produit, pas un contrôle inventé ici.
    Une suggestion n'ouvre aucun chemin d'écriture qui lui soit propre."""
    nom = creer(client)
    deposer(client, nom, "variables", "2MAUVAIS=x\n")
    vue = lire(client, nom, "variables")

    refus = client.post(f"/v1/sparks/{nom}/suggestions/variables/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"name": "2MAUVAIS", "value": "x", "secret": False}],
    })
    assert refus.status_code == 422
    assert "2MAUVAIS" in refus.json()["detail"]["message"]
    assert lire(client, nom, "variables")["present"] is True


def test_un_domaine_DEJA_PRIS_par_un_autre_Spark_est_refuse_sans_consommer(client):
    """§18.4 : l'unicité appartient à la base, et une suggestion ne la contourne
    pas. C'est la condition pour que « une suggestion n'affaiblit rien » soit
    vrai et pas seulement affirmé."""
    premier = creer(client, "premier")
    second = creer(client, "second")
    assert client.post("/v1/ingress", json={
        "spark": premier, "domain": "pris.exemple.test", "port": 8080,
        "tls": True}).status_code in (201, 502)

    deposer(client, second, "routes", "pris.exemple.test 3000 tls\n")
    vue = lire(client, second, "routes")
    refus = client.post(f"/v1/sparks/{second}/suggestions/routes/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"domain": "pris.exemple.test", "port": 3000, "tls": True}],
    })
    assert refus.status_code == 409, refus.text
    assert refus.json()["detail"]["error"] == "route_refused"
    assert lire(client, second, "routes")["present"] is True


# --- les routes : ajouter, et CORRIGER --------------------------------------


def test_une_route_suggeree_est_POSEE_et_atteint_le_fichier_reel(client):
    nom = creer(client)
    deposer(client, nom, "routes", "sso.exemple.test 8080 tls\n")
    vue = lire(client, nom, "routes")

    rendu = client.post(f"/v1/sparks/{nom}/suggestions/routes/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"domain": "sso.exemple.test", "port": 8080, "tls": True}],
    })
    assert rendu.status_code == 200, rendu.text
    assert client.get("/v1/ingress").json()["routes"][0]["domain"] == "sso.exemple.test"
    # §55.5.1 : le fichier réel dit ce qui a été accordé.
    assert "sso.exemple.test 8080 tls" in fichiers(client, nom)[
        suggestions.FICHIER_ROUTES]
    assert lire(client, nom, "routes")["present"] is False


def test_une_route_DEJA_POSEE_sur_ce_Spark_se_CORRIGE(client):
    """§18.3 ter : la cible d'une route se corrige, elle ne se refait pas.
    Sans cela, proposer un port corrigé tomberait sur l'unicité du §18.4 et
    l'agent n'aurait aucun moyen de faire changer un port."""
    nom = creer(client)
    assert client.post("/v1/ingress", json={
        "spark": nom, "domain": "api.exemple.test", "port": 8080,
        "tls": True}).status_code in (201, 502)

    deposer(client, nom, "routes", "api.exemple.test 3000 tls\n")
    vue = lire(client, nom, "routes")
    rendu = client.post(f"/v1/sparks/{nom}/suggestions/routes/apply", json={
        "sha256": vue["sha256"],
        "entries": [{"domain": "api.exemple.test", "port": 3000, "tls": True}],
    })
    assert rendu.status_code == 200, rendu.text
    assert client.get("/v1/ingress").json()["routes"][0]["target_port"] == 3000


# --- une note acceptée entre au registre par le chemin du §54 ---------------


def test_une_note_suggeree_ecrit_la_note_et_se_dit_venue_d_une_suggestion(client):
    """§54.4 : l'origine distingue ce que la console a écrit de ce qu'elle a
    accordé. Les confondre ferait perdre qui a rédigé le texte."""
    nom = creer(client)
    deposer(client, nom, "readme", "# Keycloak\n\nLe SSO de la maison.")
    vue = lire(client, nom, "readme")

    rendu = client.post(f"/v1/sparks/{nom}/suggestions/readme/apply", json={
        "sha256": vue["sha256"], "body": vue["body"]})
    assert rendu.status_code == 200, rendu.text

    note = client.get(f"/v1/sparks/{nom}/notes").json()["notes"][0]
    assert note["body"] == "# Keycloak\n\nLe SSO de la maison."
    assert note["origin"] == "suggestion"
    assert note["revision"] == 1
    # Et elle est projetée : le fichier réel porte le texte accordé.
    assert "Le SSO de la maison." in fichiers(client, nom)[notes.chemin("readme")]
    assert lire(client, nom, "readme")["present"] is False


def test_une_note_RECOPIEE_depuis_son_fichier_reel_perd_l_entete_du_produit(client):
    """Le geste le plus naturel : ouvrir README.md, le recopier dans son `.?`,
    l'éditer. Sans retrait, l'avertissement du produit entrerait au registre,
    puis serait reprojeté SOUS un second avertissement, et ainsi de suite."""
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/notes/readme", json={
        "body": "Première version.", "revision": 0}).status_code == 200
    reel = fichiers(client, nom)[notes.chemin("readme")]
    assert reel.startswith(notes.MARQUEUR), "le fichier réel porte bien l'en-tête"

    # L'agent le recopie tel quel dans le `.?` et change le texte du dessous.
    client.app.state.incus.push_file(
        nom, suggestions.chemin("readme"),
        reel.replace("Première version.", "Seconde version."))
    vue = lire(client, nom, "readme")
    assert client.post(f"/v1/sparks/{nom}/suggestions/readme/apply", json={
        "sha256": vue["sha256"], "body": vue["body"]}).status_code == 200

    note = client.get(f"/v1/sparks/{nom}/notes").json()["notes"][0]
    assert note["body"] == "Seconde version."
    assert notes.MARQUEUR not in note["body"]
    # Et le fichier reprojeté ne porte qu'UN seul en-tête.
    assert fichiers(client, nom)[notes.chemin("readme")].count(notes.MARQUEUR) == 1


def test_l_entete_d_une_note_NOMME_le_fichier_par_lequel_on_la_change(client):
    """§54.7 : « par où passe une modification ». Un en-tête qui dit seulement
    « ça ne sert à rien d'écrire ici » laisse l'agent sans issue — et un agent
    sans issue invente (§44.2 ter)."""
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/notes/install", json={
        "body": "x", "revision": 0}).status_code == 200
    pose = fichiers(client, nom)[notes.chemin("install")]
    assert suggestions.chemin("install") in pose
    assert "PROPOSITION de remplacement intégral" in pose


# --- le verrou et les refus de forme ----------------------------------------


def test_un_Spark_PROTEGE_refuse_les_DEUX_gestes(client):
    """§35.2 : accepter écrit au registre, refuser écrit dans la cellule. Les
    deux sont des écritures qui visent ce Spark."""
    nom = creer(client)
    deposer(client, nom, "variables", "A=1\n")
    vue = lire(client, nom, "variables")
    assert client.post(f"/v1/sparks/{nom}/protection",
                       json={"password": "secret"}).status_code == 200

    for geste in ("apply", "reject"):
        refus = client.post(f"/v1/sparks/{nom}/suggestions/variables/{geste}",
                            json={"sha256": vue["sha256"], "entries": [
                                {"name": "A", "value": "1", "secret": False}]})
        assert refus.status_code == 423, f"{geste} : {refus.status_code}"
        assert refus.json()["detail"]["gesture"] == "suggestion"


def test_une_nature_inconnue_est_refusee_en_nommant_les_six(client):
    nom = creer(client)
    refus = client.post(f"/v1/sparks/{nom}/suggestions/quotas/reject",
                        json={"sha256": "x"})
    assert refus.status_code == 422
    message = refus.json()["detail"]["message"]
    for nature in suggestions.NATURES:
        assert nature in message


def test_un_Spark_SANS_CELLULE_le_dit_au_lieu_de_pretendre(client):
    """§14.6 : « pas de cellule » n'est ni « aucune proposition » ni une panne."""
    nom = creer(client, "sans-cellule", demarrer=False)
    vues = lire(client, nom)
    assert vues["cell_read"] is False
    assert vues["suggestions"] == []

    refus = client.post(f"/v1/sparks/{nom}/suggestions/variables/reject",
                        json={"sha256": "x"})
    assert refus.status_code == 409
    assert refus.json()["detail"]["error"] == "no_instance"


def test_accepter_SANS_retenir_aucune_entree_envoie_vers_le_refus(client):
    """Les deux vident le fichier ; ils ne disent pas la même chose au journal
    (§55.5). Une acceptation vide serait un refus qui se fait passer pour un
    accord."""
    nom = creer(client)
    deposer(client, nom, "variables", "A=1\n")
    vue = lire(client, nom, "variables")
    refus = client.post(f"/v1/sparks/{nom}/suggestions/variables/apply", json={
        "sha256": vue["sha256"], "entries": []})
    assert refus.status_code == 422
    assert refus.json()["detail"]["error"] == "empty_apply"
    assert "Refuser" in refus.json()["detail"]["message"]
    assert lire(client, nom, "variables")["present"] is True


# --- la forme canonique ------------------------------------------------------


def test_l_empreinte_porte_sur_le_CORPS_et_non_sur_le_fichier(client):
    """§55.5.2 : l'en-tête est réécrit par le produit et peut changer d'une
    version à l'autre. Une empreinte prise sur le fichier entier ferait périmer
    toutes les propositions en attente le jour d'une mise à jour."""
    avec = suggestions.entete("variables") + "A=1\n"
    sans = "A=1\n"
    assert suggestions.sans_entete("variables", avec) == "A=1"
    assert suggestions.empreinte(suggestions.sans_entete("variables", avec)) == \
        suggestions.empreinte(suggestions.sans_entete("variables", sans))


def test_un_entete_seul_vaut_ABSENCE_de_proposition(client):
    for kind in suggestions.NATURES:
        assert suggestions.vide(kind, suggestions.entete(kind))
        assert suggestions.vide(kind, None)
        assert suggestions.vide(kind, "")
        assert not suggestions.vide(kind, suggestions.entete(kind) + "quelque chose")
