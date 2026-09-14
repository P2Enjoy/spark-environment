"""@verifies docs/BACKLOG.md#SPK-104 · docs/DAT.md §54 (les trois notes), §54.2
             (ce que chacune est censée contenir), §54.4 (le registre écrit, la
             cellule reçoit), §54.6 (la garde des secrets), §54.7 (l'en-tête),
             §54.8 (permissions), §54.9 (la surface d'API) · §35.2 (le verrou) ·
             §21.4 (le journal ne porte pas le texte) · docs/SCHEMA.md §10 septies

Le point de ces preuves n'est pas qu'un texte fasse l'aller-retour : c'est que
les DEUX états vides ne se confondent pas, que la garde nomme la variable sans
jamais rendre sa valeur, et qu'une note écrite dans la cellule à la main n'ait
aucun effet durable — ce qui est la règle de tout le reste du produit depuis
qu'elle n'a plus d'exception (§54.4).
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from sparkd import notes
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

SECRET = "mot-de-passe-de-recette-9d8c7b6a"


@pytest.fixture
def client(tmp_path):
    c = TestClient(create_app(load({
        "SPARKD_DB": str(tmp_path / "notes.db"), "SPARKD_DRIVER": "fake",
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


def ecrire(client, nom, note_id, texte, revision=0):
    return client.put(f"/v1/sparks/{nom}/notes/{note_id}",
                      json={"body": texte, "revision": revision})


# --- les trois états, et les deux vides qui ne se confondent pas -------------


def test_les_trois_notes_existent_AVANT_qu_on_ecrive_et_se_disent_non_ecrites(client):
    """§54.9, §14.6 : « personne n'a encore écrit » n'est pas « texte vide ».

    Les deux rendent une chaîne vide ; seul `written` les sépare, et c'est lui
    qui décide de ce que l'écran affiche — un appel à écrire, ou un texte.
    """
    nom = creer(client)
    rendu = client.get(f"/v1/sparks/{nom}/notes")
    assert rendu.status_code == 200, rendu.text
    trois = rendu.json()["notes"]

    assert [n["id"] for n in trois] == ["readme", "contributors", "install"], (
        "l'ordre est celui du §54.2 — du plus général au plus technique —, "
        "jamais celui de la base")
    for note in trois:
        assert note["written"] is False
        assert note["body"] == "" and note["revision"] == 0
        assert note["origin"] is None
        # §54.2 : ce que la note est CENSÉE contenir voyage avec elle. C'est la
        # consigne de conformité, et l'écran ne doit pas la réécrire de son côté.
        assert note["expected"]
        assert note["path"].startswith(notes.DOSSIER)

    # Aucune NOTE n'est posée tant que personne n'a écrit : un fichier ne
    # portant que l'en-tête du produit ferait croire à un texte rédigé.
    poses = [c for c in fichiers(client, nom) if c.startswith(notes.DOSSIER)]
    assert not [c for c in poses if not c.endswith(".?")]
    # SPK-105 · §55.5 : leurs `.?`, en revanche, SONT posés dès la création.
    # C'est ce qui rend le mécanisme découvrable d'un `ls`, sans qu'on ait eu à
    # le lire quelque part.
    assert len(poses) == 3


def test_une_note_VIDE_enregistree_n_est_pas_une_note_jamais_ecrite(client):
    """Le pendant du test précédent, et la raison pour laquelle `written` existe."""
    nom = creer(client)
    assert ecrire(client, nom, "install", "").status_code == 200

    vues = {n["id"]: n for n in client.get(f"/v1/sparks/{nom}/notes").json()["notes"]}
    assert vues["install"]["written"] is True
    assert vues["install"]["body"] == "" and vues["install"]["revision"] == 1
    assert vues["readme"]["written"] is False


# --- le registre écrit, la cellule reçoit (§54.4) ---------------------------


def test_la_note_enregistree_est_POSEE_dans_la_cellule_avec_son_entete(client):
    nom = creer(client)
    texte = "# Keycloak\n\nSSO de la maison. Le realm `p2enjoy` fait autorité."
    rendu = ecrire(client, nom, "readme", texte)
    assert rendu.status_code == 200, rendu.text
    assert rendu.json()["projected"] is True

    pose = fichiers(client, nom)[notes.chemin("readme")]
    assert texte in pose
    # §54.7 : l'en-tête dit ce que le fichier est censé contenir, qu'il est une
    # PROJECTION, et qu'aucun secret ne s'y écrit. Les trois s'y lisent.
    assert pose.startswith(notes.MARQUEUR)
    assert "aucun effet durable" in pose
    assert "AUCUN SECRET" in pose
    assert "README" in pose.split(notes.FIN_ENTETE)[0]
    # §54.8 : posée fermée. L'ouverture au groupe rootless est un second geste,
    # et elle ne s'applique qu'à une cellule dont le relevé dit `rootless`.
    assert client.app.state.incus.created[nom]["file_modes"][
        notes.chemin("readme")] == "0600"


def test_l_entete_ne_s_EMPILE_pas_quand_le_texte_lui_revient(client):
    """§54.7 : retiré à la lecture.

    Le fichier `.?` du §55 est souvent une COPIE du fichier réel dont on n'a
    changé que le corps. Sans ce retrait, chaque aller-retour ajouterait un
    en-tête, et le texte finirait noyé sous ses propres avertissements.
    """
    nom = creer(client)
    assert ecrire(client, nom, "readme", "Le texte.").status_code == 200
    pose = fichiers(client, nom)[notes.chemin("readme")]

    assert notes.sans_entete(pose) == "Le texte."
    # Deux fois de suite : la fonction est idempotente sur un texte déjà nettoyé.
    assert notes.sans_entete(notes.sans_entete(pose)) == "Le texte."


def test_ecrire_la_note_A_LA_MAIN_dans_la_cellule_n_a_aucun_effet_durable(client):
    """§54.4 : la règle sans exception, éprouvée là où elle se découvre.

    C'est le mode de panne que le §44.9.7 a mesuré sur un agent réel, pour
    `/etc/spark/env` : la ligne écrite à la main disparaît, pas tout de suite,
    ce qui est pire. Les notes suivent désormais la MÊME règle que tout le
    reste — et c'est ce que l'en-tête annonce.
    """
    nom = creer(client)
    assert ecrire(client, nom, "install", "Version du registre.").status_code == 200

    # Un agent réécrit le fichier depuis la cellule.
    client.app.state.incus.push_file(
        nom, notes.chemin("install"), "Version écrite à la main.")
    assert "à la main" in fichiers(client, nom)[notes.chemin("install")]

    # Le registre n'en sait rien, et ne doit rien en savoir.
    vues = {n["id"]: n for n in client.get(f"/v1/sparks/{nom}/notes").json()["notes"]}
    assert vues["install"]["body"] == "Version du registre."

    # Et la première projection venue la réécrit : ici, un simple redémarrage.
    assert client.post(f"/v1/sparks/{nom}/stop").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    assert "à la main" not in fichiers(client, nom)[notes.chemin("install")]
    assert "Version du registre." in fichiers(client, nom)[notes.chemin("install")]


def test_un_Spark_sans_cellule_garde_sa_note_au_registre(client):
    """§54.9 : la route répond sur un Spark qui n'a pas de cellule.

    C'est justement l'état où l'on prépare un déploiement (§44.9.4), et le
    geste ne doit pas échouer parce que la projection n'a pas pu avoir lieu.
    """
    nom = creer(client, "sans-cellule", demarrer=False)
    rendu = ecrire(client, nom, "contributors", "Les sources sont sur le dépôt.")
    assert rendu.status_code == 200, rendu.text
    assert rendu.json()["projected"] is False, (
        "sans cellule, rien n'est posé — et le geste le DIT au lieu de le taire")
    assert client.get(f"/v1/sparks/{nom}/notes").json()["notes"][1]["body"] == (
        "Les sources sont sur le dépôt.")


def test_le_BRIEFING_nomme_les_notes_et_ne_ment_pas_sur_celles_qui_existent(client):
    """§54.5 et §44.4 : le briefing NOMME les trois notes — celui qui le lit est
    déjà dans la cellule, à trois lignes de commande d'elles.

    Et il dit lesquelles sont écrites : une note posée sans reprojeter le
    briefing laisserait le fichier annoncer « pas encore écrite » sur un texte
    qui vient d'arriver à côté de lui.
    """
    from sparkd import briefing

    nom = creer(client)
    assert client.post(f"/v1/sparks/{nom}/bootstrap").status_code == 200
    vu = fichiers(client, nom)[briefing.FICHIER_MARKDOWN]
    assert notes.chemin("readme") in vu
    assert "pas encore écrite" in vu

    assert ecrire(client, nom, "readme", "# Keycloak").status_code == 200
    vu = fichiers(client, nom)[briefing.FICHIER_MARKDOWN]
    assert notes.chemin("readme") in vu
    # §54.5 : le briefing les NOMME, il ne les recopie pas. Deux exemplaires du
    # même texte dans la même machine en feraient vieillir un — celui réécrit
    # par le plan de contrôle, c'est-à-dire celui qui a l'air officiel.
    assert "# Keycloak" not in vu
    assert vu.count("pas encore écrite") == 2, (
        "les DEUX autres restent non écrites, et celle qu'on vient d'écrire "
        "cesse de l'être")


# --- la révision : un enregistrement périmé est refusé, pas écrasé ----------


def test_un_enregistrement_PERIME_est_refuse_et_rend_le_texte_courant(client):
    """§54.9 : le `409` est le seul moment où le produit peut dire qu'un texte
    allait être perdu. Il doit donc MONTRER celui qui allait l'être."""
    nom = creer(client)
    assert ecrire(client, nom, "readme", "Premier", revision=0).status_code == 200
    assert ecrire(client, nom, "readme", "Deuxième", revision=1).status_code == 200

    refus = ecrire(client, nom, "readme", "Écrit depuis un onglet en retard",
                   revision=1)
    assert refus.status_code == 409, refus.text
    detail = refus.json()["detail"]
    assert detail["error"] == "stale_revision"
    assert detail["current"]["body"] == "Deuxième", (
        "le refus rend la note COURANTE : sans elle, il n'est qu'un obstacle")
    assert detail["current"]["revision"] == 2

    # Et rien n'a été écrit.
    assert client.get(f"/v1/sparks/{nom}/notes").json()["notes"][0]["body"] == "Deuxième"


def test_une_revision_absente_est_refusee_comme_une_revision_fausse(client):
    """Omettre la révision ne doit pas valoir « écrase sans regarder »."""
    nom = creer(client)
    refus = client.put(f"/v1/sparks/{nom}/notes/readme", json={"body": "x"})
    assert refus.status_code == 409
    assert refus.json()["detail"]["error"] == "stale_revision"


# --- la garde des secrets (§54.6) -------------------------------------------


def test_un_texte_portant_la_valeur_d_un_secret_est_REFUSE_en_nommant_la_variable(client):
    """§54.6 : le refus nomme la VARIABLE, jamais la valeur.

    Le message part à l'écran et peut être recopié dans un rapport. Y remettre
    la valeur reproduirait exactement la fuite qu'on refuse.
    """
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/SMTP_PASSWORD", json={
        "value": SECRET, "secret": True}).status_code == 200

    refus = ecrire(client, nom, "install",
                   f"Pour s'y connecter : mot de passe {SECRET}, port 587.")
    assert refus.status_code == 422, refus.text
    detail = refus.json()["detail"]
    assert detail["error"] == "secret_in_note"
    assert "SMTP_PASSWORD" in detail["message"]
    assert SECRET not in detail["message"], (
        "le refus ne doit JAMAIS rendre la valeur qu'il vient de reconnaître")

    # Rien n'est écrit, et rien n'est posé dans la cellule.
    assert client.get(f"/v1/sparks/{nom}/notes").json()["notes"][2]["written"] is False
    assert notes.chemin("install") not in fichiers(client, nom)


def test_la_garde_ne_regarde_pas_les_valeurs_TROP_COURTES(client):
    """§54.6 : le plancher de huit caractères.

    Sans lui, un secret valant `prod` rendrait impossible d'écrire le mot
    « prod » dans un README — et la garde serait contournée par celui qu'elle
    gêne, ce qui est pire que de ne pas l'avoir.
    """
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/ENVIRONNEMENT", json={
        "value": "prod", "secret": True}).status_code == 200
    assert ecrire(client, nom, "readme",
                  "Cette cellule sert la prod.").status_code == 200


def test_une_variable_ORDINAIRE_ne_ferme_pas_le_texte(client):
    """La garde ne vise que les secrets : une valeur de variable ordinaire est
    déjà lisible partout, et la refuser bloquerait des textes légitimes."""
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/BASE_URL", json={
        "value": "https://sso.exemple.test", "secret": False}).status_code == 200
    assert ecrire(client, nom, "install",
                  "Point d'entrée : https://sso.exemple.test").status_code == 200


def test_la_garde_couvre_les_secrets_de_la_FORGE_qui_descendent_ici(client):
    """Un secret coché depuis le catalogue atteint la cellule comme les autres
    (§43.6) : la garde le connaît donc aussi, sans quoi elle aurait un trou par
    lequel passe exactement la moitié des secrets d'un Spark."""
    nom = creer(client)
    assert client.put("/v1/env/REGISTRY_TOKEN", json={
        "value": SECRET, "secret": True}).status_code == 200
    assert client.post(
        f"/v1/sparks/{nom}/env/selection/REGISTRY_TOKEN").status_code == 200

    refus = ecrire(client, nom, "contributors", f"Jeton du dépôt : {SECRET}")
    assert refus.status_code == 422
    assert "REGISTRY_TOKEN" in refus.json()["detail"]["message"]


def test_un_texte_trop_long_est_refuse_avec_sa_borne(client):
    nom = creer(client)
    refus = ecrire(client, nom, "readme", "a" * (notes.TAILLE_MAX + 1))
    assert refus.status_code == 422
    assert refus.json()["detail"]["error"] == "too_long"
    assert "64 Kio" in refus.json()["detail"]["message"]


# --- le verrou et le journal ------------------------------------------------


def test_un_Spark_PROTEGE_refuse_l_enregistrement_d_une_note(client):
    """§35.2 : le verrou ne fait pas d'exception pour les écritures qu'on juge
    anodines. Une note est une écriture qui vise ce Spark."""
    nom = creer(client)
    assert client.post(f"/v1/sparks/{nom}/protection",
                       json={"password": "secret"}).status_code == 200

    refus = ecrire(client, nom, "readme", "x")
    assert refus.status_code == 423
    detail = refus.json()["detail"]
    assert detail["error"] == "spark_protected" and detail["gesture"] == "note"

    # La LECTURE reste possible : le §35.2 porte sur les écritures.
    assert client.get(f"/v1/sparks/{nom}/notes").status_code == 200


def test_le_journal_retient_le_geste_SANS_le_texte(client):
    """§21.4 : un payload n'est pas un dépotoir, et une note peut porter
    n'importe quoi — y compris ce qu'on vient de refuser d'y mettre ailleurs."""
    nom = creer(client)
    texte = "Ce texte ne doit pas entrer au journal."
    assert ecrire(client, nom, "readme", texte).status_code == 200

    entrees = [e for e in client.get("/v1/audit").json()["entries"]
               if e["action"] == "spark.note.set"]
    assert entrees, "une écriture de note se journalise comme toute écriture"
    trace = entrees[0]
    charge = json.loads(trace["payload"])
    assert charge["note"] == "readme"
    assert charge["revision"] == 1
    assert charge["origin"] == "console"
    assert charge["length"] == len(texte)
    assert texte not in str(trace)


def test_une_note_inconnue_est_refusee_en_nommant_les_trois(client):
    nom = creer(client)
    refus = client.put(f"/v1/sparks/{nom}/notes/changelog",
                       json={"body": "x", "revision": 0})
    assert refus.status_code == 422
    message = refus.json()["detail"]["message"]
    assert refus.json()["detail"]["error"] == "unknown_note"
    for identifiant in notes.IDENTIFIANTS:
        assert identifiant in message


def test_un_Spark_supprime_emporte_ses_notes(client):
    """SCHEMA §10 septies : la cascade suit le §14.4."""
    nom = creer(client)
    assert ecrire(client, nom, "readme", "à jeter").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/delete").status_code == 200

    recree = creer(client, nom)
    assert client.get(f"/v1/sparks/{recree}/notes").json()["notes"][0][
        "written"] is False, (
        "un Spark qui reprend un nom libéré ne doit pas hériter des notes du "
        "précédent")


# --- le dossier pour un LLM (§54.5, §55.7) ----------------------------------


def _dossier(client, nom):
    rendu = client.get(f"/v1/sparks/{nom}/briefing?jump=forge")
    assert rendu.status_code == 200, rendu.text
    return rendu.json()["markdown"]


def test_le_dossier_porte_les_trois_notes_EN_ENTIER(client):
    """§54.5 : celui qui lit ce texte n'est pas encore entré dans la cellule.

    Il ne peut ouvrir aucun de ces fichiers — ils vivent derrière une clé
    accordée, un rebond et une cellule amorcée (§44.9.1). Les lui nommer ne
    servirait à rien.
    """
    nom = creer(client)
    assert ecrire(client, nom, "readme", "# Keycloak\n\nLe SSO.").status_code == 200
    assert ecrire(client, nom, "install", "OIDC : /realms/x").status_code == 200

    vu = _dossier(client, nom)
    assert "# Keycloak" in vu and "Le SSO." in vu
    assert "OIDC : /realms/x" in vu
    # §14.5 : une note absente est DITE. Elle apprend à l'agent qu'il est
    # peut-être le premier à savoir quelque chose que personne n'a écrit.
    assert "Personne n'a encore écrit cette note" in vu
    # Et ce que chacune est CENSÉE porter voyage avec elle (§54.2).
    assert "d'où viennent les sources" in vu


def test_le_dossier_dit_par_ou_l_on_PROPOSE_et_ce_qui_arrive_ensuite(client):
    """§55.7 : les quatre points, et pas un de plus.

    Sans la seconde moitié — « voici où déposer ce que vous souhaitez » —, la
    première se lit comme une impasse, et un agent devant une impasse invente
    (§44.2 ter).
    """
    nom = creer(client)
    vu = _dossier(client, nom)

    # 1. les six paires, avec leur effet
    for chemin in ("/etc/spark/env.?", "/run/spark/secrets.?",
                   "/etc/spark/routes.?", "/etc/spark/notes/README.md.?",
                   "/etc/spark/notes/CONTRIBUTORS.md.?",
                   "/etc/spark/notes/INSTALL.md.?"):
        assert chemin in vu, chemin
    assert "ajoute ou remplace" in vu and "remplace en entier" in vu
    # 2. la grammaire
    assert "NOM=valeur" in vu
    assert "<domaine> <port écouté ici> [tls|clair]" in vu
    # 3. le cycle de vie, et qu'il ne promet rien
    assert "Rien ne s'applique tout seul" in vu
    assert "Rien ne garantit qu'elle soit lue" in vu
    assert "redeviendra **vide**" in vu
    # 4. comment on apprend le sort de sa demande, sans accusé de réception
    assert "Le fichier réel d'à côté vous dira laquelle" in vu
    # Et le refus qui NE consomme pas, sans quoi l'auteur redéposerait à
    # l'identique un texte que le produit vient de refuser.
    assert "Un refus du produit ne vide pas" in vu


def test_le_dossier_ecrit_la_consigne_d_acces_UNE_SEULE_FOIS(client):
    """§55.7 : « écrite une fois, au même endroit que les commandes d'entrée ».

    La répéter à chaque section la ferait lire zéro fois ; l'omettre laisserait
    un agent conclure d'un fichier réécrit puis restauré que la machine est
    cassée.
    """
    nom = creer(client)
    vu = _dossier(client, nom)
    assert vu.count("il le RÉÉCRIT") == 1
    # Elle est dans la section d'entrée, pas ailleurs : c'est là qu'on la lit.
    entree = vu.split("## 2.")[0]
    assert "il le RÉÉCRIT" in entree
    assert "n'entrent que par la console" in entree


def test_AUCUNE_valeur_de_secret_n_entre_dans_le_dossier_augmente(client):
    """§44.9.3, rejoué sur un dossier qui porte désormais du texte libre.

    Un dossier est copié dans une conversation avec un modèle tiers — c'est sa
    raison d'être, et c'est le pire trajet possible pour un secret. La garde du
    §54.6 empêche qu'une note en porte ; cette preuve vérifie que le texte
    ASSEMBLÉ n'en porte pas davantage.
    """
    nom = creer(client)
    assert client.put(f"/v1/sparks/{nom}/env/SMTP_PASSWORD", json={
        "value": SECRET, "secret": True}).status_code == 200
    assert client.put(f"/v1/sparks/{nom}/env/BASE_URL", json={
        "value": "https://sso.exemple.test", "secret": False}).status_code == 200
    assert ecrire(client, nom, "readme", "Le SSO, servi sur "
                  "https://sso.exemple.test").status_code == 200

    vu = _dossier(client, nom)
    assert SECRET not in vu
    assert "SMTP_PASSWORD" in vu, "le NOM y est, et c'est le but"
    # Une valeur NON secrète n'est pas davantage exportée par le produit : elle
    # n'y figure que parce que l'auteur de la note l'y a mise lui-même.
    assert vu.count("https://sso.exemple.test") == 1


# --- la forme canonique -----------------------------------------------------


def test_les_fins_de_ligne_et_la_queue_sont_normalisees(client):
    """§54.4 : un texte rendu en CRLF et le même texte sont le MÊME texte.

    Sans cela, un éditeur de la cellule et la console compteraient pour deux ce
    qui n'est qu'une convention de fichier.
    """
    assert notes.normaliser("a\r\nb\r\n\n\n") == "a\nb"
    assert notes.normaliser(None) == ""
    assert notes.normaliser("  \n") == ""
