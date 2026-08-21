"""@verifies docs/BACKLOG.md#SPK-58 · docs/DAT.md §43.3 (la différence est
DÉCLARÉE), §43.5.2 (deux fichiers, pas un), §43.6 (général d'abord, surcharge
ensuite), §43.9.1 à §43.9.4 · docs/SCHEMA.md §10 ter

Ce que ces preuves gardent avant tout : **une valeur déclarée secrète
n'apparaît nulle part**. C'est la Definition of Done de l'unité, et elle se
vérifie en la CHERCHANT explicitement dans chaque sortie, pas en supposant que
le code la retient.
"""

from __future__ import annotations

import os
import sqlite3

import pytest

from sparkd import environnement as env
from sparkd import migrations
from sparkd.db import connect


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "env.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id, name, image, state, cpu_mode, cpu_reservation, "
        "memory_reservation_bytes, network_reservation_bps, storage_bytes, "
        "created_at, updated_at) VALUES "
        "('S1', 'boutique', 'images:debian/13', 'stopped', 'shared', 0.5, "
        "1073741824, 100000000, 10737418240, '2026-08-21', '2026-08-21')")
    yield connection
    connection.close()


@pytest.fixture
def cle(tmp_path):
    return env.charger_cle(str(tmp_path / "k" / "secret.key"))


# --- La clé (§43.9.2) ------------------------------------------------------


def test_la_cle_est_CREEE_si_elle_manque_et_en_0600(tmp_path):
    """Un runtime qui refuserait de démarrer faute d'une clé qu'il sait
    fabriquer ferait perdre un service pour rien."""
    chemin = str(tmp_path / "neuve" / "secret.key")
    cle = env.charger_cle(chemin)
    assert len(cle) == env.TAILLE_CLE
    assert oct(os.stat(chemin).st_mode & 0o777) == "0o600"


def test_la_cle_existante_n_est_JAMAIS_reecrite(tmp_path):
    """Deux appels rendent la MÊME clé. En fabriquer une seconde rendrait tous
    les secrets déjà écrits indéchiffrables, en silence."""
    chemin = str(tmp_path / "secret.key")
    assert env.charger_cle(chemin) == env.charger_cle(chemin)


def test_une_cle_de_MAUVAISE_TAILLE_est_une_erreur_franche(tmp_path):
    """Créer ce qui manque et refuser ce qui est cassé ne sont pas la même
    politique : la remplacer perdrait tous les secrets sans le dire."""
    chemin = tmp_path / "tronquee.key"
    chemin.write_bytes(b"trop court")
    with pytest.raises(env.CleError) as erreur:
        env.charger_cle(str(chemin))
    assert "n'est PAS remplacée" in str(erreur.value)
    assert chemin.read_bytes() == b"trop court", "le fichier est intact"


# --- Le chiffrement (§43.9.2) ---------------------------------------------


def test_un_chiffre_DEPLACE_sous_un_autre_nom_ne_se_dechiffre_pas(cle):
    """Le nom est la donnée associée. Sans ce lien, un registre modifiable
    permettrait de servir `STRIPE_API_KEY` sous le nom `LOG_LEVEL`."""
    chiffre = env.chiffrer(cle, "STRIPE_API_KEY", "sk_live_42")
    assert env.dechiffrer(cle, "STRIPE_API_KEY", chiffre) == "sk_live_42"
    with pytest.raises(env.CleError):
        env.dechiffrer(cle, "LOG_LEVEL", chiffre)


def test_deux_chiffres_de_la_MEME_valeur_different(cle):
    """Le nonce est tiré par valeur : deux chiffrés identiques trahiraient que
    deux Sparks portent le même secret, sans qu'on l'ait décidé."""
    assert env.chiffrer(cle, "A", "x") != env.chiffrer(cle, "A", "x")


def test_l_empreinte_est_un_HMAC_et_non_un_hachage_NU(cle, tmp_path):
    """@verifies docs/DAT.md §43.9.3

    Un préfixe de SHA-256 nu livrerait `changeme` par force brute en quelques
    secondes. L'empreinte doit donc DÉPENDRE de la clé."""
    import hashlib
    trace = env.empreinte(cle, "changeme")
    assert trace != hashlib.sha256(b"changeme").hexdigest()[:env.EMPREINTE]
    # Comparable sur la MÊME Forge, ce que le §43.3 demande...
    assert trace == env.empreinte(cle, "changeme")
    # ...et pas d'une Forge à l'autre.
    autre = env.charger_cle(str(tmp_path / "autre.key"))
    assert env.empreinte(autre, "changeme") != trace


# --- Le magasin (§43.9.1) --------------------------------------------------


def test_un_secret_n_est_JAMAIS_rendu_ni_journalise(db, cle):
    """@verifies docs/BACKLOG.md#SPK-58 (Definition of Done)

    La preuve centrale de l'unité : on CHERCHE la valeur dans chaque sortie."""
    env.poser(db, cle, "spark", "S1", "DATABASE_URL",
              "postgres://u:hunter2@db/x", secret=True)

    rendu = env.lister(db, "S1")
    assert [e.name for e in rendu] == ["DATABASE_URL"]
    assert rendu[0].value is None, "la valeur d'un secret n'est jamais rendue"
    assert rendu[0].fingerprint, "mais son empreinte l'est, pour comparer"

    # Ni dans le journal, ni caviardée, ni en morceaux.
    #
    # `str(sqlite3.Row)` ne rend PAS son contenu : une première version de cette
    # preuve cherchait le secret dans « <sqlite3.Row object at 0x…> » et passait
    # sans rien regarder. On aplatit donc les colonnes.
    journal = " ".join(
        str(v) for r in db.execute("SELECT * FROM audit_log").fetchall()
        for v in tuple(r))
    assert "hunter2" not in journal
    assert "postgres://" not in journal
    assert "DATABASE_URL" in journal, "le NOM y est, avec le geste et sa date"

    # Ni dans la table, en clair.
    ligne = db.execute("SELECT * FROM env_entry").fetchone()
    assert ligne["value"] is None and "hunter2" not in str(ligne["value_enc"])


def test_la_base_REFUSE_une_ligne_secrete_portant_sa_valeur_en_clair(db):
    """§43.9.1 : la cohérence est tenue par la BASE, pas par le code appelant.
    Un module qui l'oublierait produirait exactement la fuite à empêcher."""
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO env_entry (id, scope, spark_id, name, is_secret, value, "
            "updated_at) VALUES ('x', 'spark', 'S1', 'TOKEN', 1, 'en-clair', 'n')")


def test_un_nom_qui_ne_s_EXPORTE_pas_est_refuse(db, cle):
    """Un nom hors grammaire du shell produirait un fichier qu'`env_file:`
    refuse, et la panne se lirait chez le locataire, loin de sa cause."""
    for mauvais in ("2FOIS", "AVEC-TIRET", "avec espace", "", "ACCENTUÉ"):
        with pytest.raises(env.EnvError):
            env.poser(db, cle, "spark", "S1", mauvais, "x")


def test_une_entree_de_FORGE_ne_vise_aucun_Spark(db, cle):
    """Une entrée « forge » rattachée à un Spark serait héritée par tous et
    supprimée avec un seul."""
    with pytest.raises(env.EnvError):
        env.poser(db, cle, "forge", "S1", "TZ", "Europe/Paris")
    with pytest.raises(env.EnvError):
        env.poser(db, cle, "spark", None, "TZ", "Europe/Paris")


def test_reposer_le_meme_nom_REMPLACE_au_lieu_de_doubler(db, cle):
    env.poser(db, cle, "spark", "S1", "TZ", "UTC")
    env.poser(db, cle, "spark", "S1", "TZ", "Europe/Paris")
    rendu = env.lister(db, "S1")
    assert len(rendu) == 1 and rendu[0].value == "Europe/Paris"


def test_une_variable_devient_secret_et_sa_valeur_en_clair_DISPARAIT(db, cle):
    """Déclarer secret après coup doit retirer la valeur du registre, sans quoi
    la déclaration ne servirait à rien."""
    env.poser(db, cle, "spark", "S1", "TOKEN", "en-clair")
    env.poser(db, cle, "spark", "S1", "TOKEN", "secret-42", secret=True)
    ligne = db.execute("SELECT * FROM env_entry").fetchone()
    assert ligne["value"] is None and ligne["is_secret"] == 1


def test_retirer_ce_qui_n_existe_pas_n_est_PAS_une_erreur(db, cle):
    """§14.5 : l'état voulu est « cette variable n'est pas définie », et il est
    atteint dans les deux cas."""
    assert env.retirer(db, "spark", "S1", "ABSENTE") is False
    env.poser(db, cle, "spark", "S1", "PRESENTE", "x")
    assert env.retirer(db, "spark", "S1", "PRESENTE") is True
    assert env.lister(db, "S1") == []


# --- Les deux niveaux (§43.6, §43.9.4) -------------------------------------


def test_la_surcharge_se_fait_NOM_PAR_NOM_et_l_origine_est_dite(db, cle):
    """@verifies docs/DAT.md §43.6, §43.9.4

    Surcharger `SMTP_HOST` ne doit pas faire perdre le `SMTP_PORT` hérité."""
    env.poser(db, cle, "forge", None, "SMTP_HOST", "relais.forge")
    env.poser(db, cle, "forge", None, "SMTP_PORT", "587")
    env.poser(db, cle, "spark", "S1", "SMTP_HOST", "relais.boutique")
    env.poser(db, cle, "spark", "S1", "APP_NAME", "boutique")

    rendu = {e.name: e for e in env.lister(db, "S1")}
    assert rendu["SMTP_HOST"].value == "relais.boutique"
    assert rendu["SMTP_HOST"].origin == "overridden", "la valeur de la Forge est MASQUÉE"
    assert rendu["SMTP_PORT"].value == "587" and rendu["SMTP_PORT"].origin == "forge"
    assert rendu["APP_NAME"].origin == "spark"


def test_le_jeu_de_la_FORGE_se_lit_seul(db, cle):
    env.poser(db, cle, "forge", None, "TZ", "Europe/Paris")
    env.poser(db, cle, "spark", "S1", "APP_NAME", "boutique")
    assert [e.name for e in env.lister(db)] == ["TZ"]


def test_supprimer_un_Spark_emporte_ses_entrees_pas_celles_de_la_Forge(db, cle):
    """La cascade suit celle des routes : une variable qui survivrait à son
    Spark serait une valeur que plus rien ne consomme."""
    env.poser(db, cle, "forge", None, "TZ", "UTC")
    env.poser(db, cle, "spark", "S1", "APP_NAME", "boutique")
    db.execute("DELETE FROM spark WHERE id = 'S1'")
    restantes = db.execute("SELECT name FROM env_entry").fetchall()
    assert [r["name"] for r in restantes] == ["TZ"]


# --- La résolution vers les DEUX fichiers (§43.5.2) ------------------------


def test_les_secrets_vont_dans_le_fichier_VOLATIL_les_variables_dans_l_autre(db, cle):
    """@verifies docs/DAT.md §43.5.2

    C'est le partage qui justifie le second fichier : ce qui vit dans `/run`
    n'entre dans aucun instantané, donc une restauration ne ressuscite pas un
    secret révoqué."""
    env.poser(db, cle, "forge", None, "TZ", "Europe/Paris")
    env.poser(db, cle, "spark", "S1", "DATABASE_URL", "postgres://secret", secret=True)

    rendu = env.resoudre(db, cle, "S1")
    assert rendu["variables"] == {"TZ": "Europe/Paris"}
    assert rendu["secrets"] == {"DATABASE_URL": "postgres://secret"}


def test_un_secret_HERITE_de_la_Forge_arrive_dans_la_cellule(db, cle):
    """La surcharge du §43.6 vaut pour les secrets comme pour le reste."""
    env.poser(db, cle, "forge", None, "SMTP_PASSWORD", "du-relais", secret=True)
    assert env.resoudre(db, cle, "S1")["secrets"] == {"SMTP_PASSWORD": "du-relais"}


def test_une_variable_du_Spark_MASQUE_un_secret_de_la_Forge(db, cle):
    """§43.9.4 : la ligne retenue décide du FICHIER de destination. Le contraire
    ferait chercher une valeur dans un fichier où elle n'est pas."""
    env.poser(db, cle, "forge", None, "TOKEN", "secret-de-la-forge", secret=True)
    env.poser(db, cle, "spark", "S1", "TOKEN", "ordinaire")
    rendu = env.resoudre(db, cle, "S1")
    assert rendu["variables"] == {"TOKEN": "ordinaire"}
    assert rendu["secrets"] == {}


# --- L'écriture dans le fichier (§43.9.7, MESURÉ sur Compose v5.1.4) --------


def test_une_valeur_contenant_un_DOLLAR_est_echappee():
    """@verifies docs/DAT.md §43.9.7

    MESURÉ : sans échappement, `abc$def` arrive comme `abc` dans le conteneur —
    Compose substitue, et la variable étant inconnue, la fin disparaît. Un mot
    de passe serait tronqué en silence."""
    assert env.citer("abc$def") == '"abc\\$def"'


def test_une_APOSTROPHE_ne_casse_pas_le_fichier_entier():
    """MESURÉ : l'idiome du shell `'ab'\\''cd'` fait ÉCHOUER la lecture du
    fichier entier, donc une seule apostrophe dans un mot de passe viderait
    tout l'environnement de la pile. Les guillemets doubles la laissent
    passer."""
    assert env.citer("ab'cd") == '"ab\'cd"'


def test_les_GUILLEMETS_et_la_BARRE_sont_echappes():
    assert env.citer('ab"cd') == '"ab\\"cd"'
    assert env.citer("a\\b") == '"a\\\\b"'


def test_l_ordre_des_echappements_ne_DOUBLE_pas_les_barres():
    """La barre oblique s'échappe EN PREMIER : la traiter en dernier doublerait
    celles que les autres échappements viennent d'introduire."""
    assert env.citer('a\\"b') == '"a\\\\\\"b"'


def test_les_BLANCS_de_tete_et_de_fin_sont_conserves():
    """MESURÉ : sans guillemets, Compose les ROGNE. Un mot de passe finissant
    par une espace serait alors faux."""
    assert env.citer("  garde  ") == '"  garde  "'


def test_les_caracteres_de_CONTROLE_sont_rendus_par_leur_echappement():
    assert env.citer("a\nb") == '"a\\nb"'
    assert env.citer("a\tb") == '"a\\tb"'


# --- Les trois fichiers (§43.1, §43.5.2) -----------------------------------


def test_les_secrets_ne_sont_PAS_dans_le_fichier_qui_entre_en_INSTANTANE(db, cle):
    """@verifies docs/DAT.md §43.5.2, §43.9.7

    C'est le point qui justifie la séparation : `/etc/spark/env` et
    `/etc/profile.d/spark-env.sh` vivent sur le jeu de données, donc DANS les
    instantanés. Un secret qui s'y trouverait ressusciterait à la première
    restauration ancienne, en silence."""
    env.poser(db, cle, "forge", None, "TZ", "Europe/Paris")
    env.poser(db, cle, "spark", "S1", "STRIPE_API_KEY", "sk_live_42", secret=True)

    rendu = env.fichiers(db, cle, "S1")

    assert "sk_live_42" not in rendu[env.FICHIER_VARIABLES]
    assert "sk_live_42" not in rendu[env.FICHIER_PROFIL]
    assert "sk_live_42" in rendu[env.FICHIER_SECRETS], "il est bien LIVRÉ, ailleurs"
    assert "TZ" in rendu[env.FICHIER_VARIABLES]


def test_le_fichier_de_confort_emploie_la_grammaire_du_SHELL(db, cle):
    """§43.9.7 : deux consommateurs, deux grammaires. L'idiome `'\\''` que
    Compose REFUSE est exactement celui qu'il faut au shell."""
    env.poser(db, cle, "spark", "S1", "MSG", "l'accent")
    rendu = env.fichiers(db, cle, "S1")
    assert "export MSG='l'\\''accent'\n" in rendu[env.FICHIER_PROFIL]
    assert 'MSG="l\'accent"\n' in rendu[env.FICHIER_VARIABLES]


def test_un_RETRAIT_retire_vraiment_du_fichier(db, cle):
    """Le fichier est régénéré EN ENTIER, jamais complété (§43.2). C'est ce qui
    distingue « retiré » de « laissé là »."""
    env.poser(db, cle, "spark", "S1", "OBSOLETE", "x")
    assert "OBSOLETE" in env.fichiers(db, cle, "S1")[env.FICHIER_VARIABLES]
    env.retirer(db, "spark", "S1", "OBSOLETE")
    assert "OBSOLETE" not in env.fichiers(db, cle, "S1")[env.FICHIER_VARIABLES]


def test_les_fichiers_ANNONCENT_qu_ils_sont_ecrits_par_le_produit(db, cle):
    """Un fichier modifié à la main serait écrasé sans prévenir. Il le dit."""
    rendu = env.fichiers(db, cle, "S1")
    for chemin in (env.FICHIER_VARIABLES, env.FICHIER_SECRETS, env.FICHIER_PROFIL):
        assert "Écrit par sparkd" in rendu[chemin]
    assert "CONFORT" in rendu[env.FICHIER_PROFIL], "et le confort dit sa limite"
