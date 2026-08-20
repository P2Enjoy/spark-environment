"""@verifies docs/BACKLOG.md#SPK-36 · docs/CONTINGENCE.md §2 (perte ou corruption
            du registre), §2.2 (pourquoi une copie de fichier ne suffit pas),
            §2.4 (restaurer) · docs/DAT.md §36.9 (la chaîne d'intégrité)

Ce que ces preuves gardent, et c'est LE point de l'unité : **une copie de fichier
d'une base en mode WAL perd des lignes en silence**, et la copie s'ouvre sans se
plaindre. Mesuré le 2026-08-20 — 490 lignes sur 500.

C'est le pire mode de panne d'une sauvegarde : elle restaure, elle ne signale
rien, et il manque ce qu'on venait chercher. La première preuve ci-dessous rejoue
cette mesure, pour qu'une future « optimisation » qui remplacerait l'API de
sauvegarde par un `shutil.copy` rougisse immédiatement.
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest

from sparkd import audit, migrations, sauvegarde
from sparkd.db import connect, transaction


def _registre(chemin: Path, entrees: int = 40):
    """Un VRAI registre : le schéma vient des migrations, pas d'un CREATE TABLE
    écrit ici. Un schéma recopié divergerait, et c'est justement ce que la
    restauration doit rendre fidèlement."""
    connexion = connect(chemin)
    migrations.upgrade(connexion)
    for i in range(entrees):
        audit.record(connexion, None, "spark.create", "ok", f"création {i}",
                     target_type="spark", target_id=f"spark-{i}")
    return connexion


def _compter(connexion) -> int:
    return connexion.execute("SELECT count(*) FROM audit_log").fetchone()[0]


# --- LE POINT QUI DÉCIDE : le WAL et la copie qui ment ----------------------


def test_une_COPIE_DE_FICHIER_perd_des_lignes_en_silence(tmp_path):
    """MESURÉ : la copie s'ouvre SANS ERREUR, et il manque des lignes.

    Cette preuve n'éprouve pas le produit : elle éprouve la RAISON du produit.
    Sans elle, quelqu'un remplacera un jour l'API de sauvegarde par un
    `shutil.copy` — c'est plus court, cela paraît marcher, et le défaut ne se
    verra que le jour de la restauration.
    """
    source = tmp_path / "reg.db"
    connexion = connect(source)
    with transaction(connexion) as c:
        c.execute("CREATE TABLE t (i INT)")
    for i in range(500):
        connexion.execute("INSERT INTO t VALUES (?)", (i,))

    naive = tmp_path / "copie-naive.db"
    shutil.copy(source, naive)
    try:
        lues = sqlite3.connect(naive).execute("SELECT count(*) FROM t").fetchone()[0]
    except sqlite3.OperationalError:
        # Selon ce qui est resté dans le WAL, la copie peut même ne pas porter la
        # TABLE. C'est la même perte, en pire — et toujours sans un mot tant
        # qu'on n'a pas essayé de lire.
        lues = None
    assert lues != 500, (
        "la copie naïve devrait perdre ce qui vit encore dans le WAL ; si elle "
        "ne perd plus rien, la raison de ce module a changé et "
        "docs/CONTINGENCE.md §2.2 doit être revu")

    # L'API de sauvegarde, elle, traverse le WAL. Ce registre-ci n'a pas de
    # journal — `sauvegarder` le refusera donc —, mais la copie qu'elle produit
    # AVANT de refuser porte bien les 500 lignes : c'est ce qu'on mesure.
    copie = tmp_path / "par-api.db"
    origine = sqlite3.connect(source)
    cible = sqlite3.connect(copie)
    origine.backup(cible)
    cible.close(); origine.close()
    assert sqlite3.connect(copie).execute(
        "SELECT count(*) FROM t").fetchone()[0] == 500


# --- La sauvegarde VÉRIFIE ce qu'elle écrit ---------------------------------


def test_la_sauvegarde_porte_la_MEME_chaine_que_l_original(tmp_path):
    """Une sauvegarde dont le journal ne se vérifie plus ne prouve rien."""
    origine = _registre(tmp_path / "reg.db")
    attendue = audit.verify_chain(origine)
    origine.close()

    fichier = sauvegarde.sauvegarder(tmp_path / "reg.db", tmp_path / "sauv")
    vu = sauvegarde.verifier(fichier)
    assert vu["structure"] == "ok"
    assert vu["chaine"]["intact"] is True
    assert vu["chaine"]["head"] == attendue["head"]
    assert vu["chaine"]["length"] == attendue["length"]


def test_le_nom_du_fichier_est_DATÉ_et_se_trie(tmp_path):
    from datetime import datetime, timezone

    _registre(tmp_path / "reg.db")
    instant = datetime(2026, 8, 20, 21, 47, 41, tzinfo=timezone.utc)
    fichier = sauvegarde.sauvegarder(tmp_path / "reg.db", tmp_path / "sauv",
                                     maintenant=instant)
    assert fichier.name == "spark-20260820-214741.db"


def test_un_registre_ABSENT_le_dit_au_lieu_d_ecrire_un_fichier_vide(tmp_path):
    with pytest.raises(sauvegarde.SauvegardeError, match="Aucun registre"):
        sauvegarde.sauvegarder(tmp_path / "nexistepas.db", tmp_path / "sauv")
    assert not (tmp_path / "sauv").exists() or not list((tmp_path / "sauv").iterdir())


# --- La restauration refuse ce qu'elle ne peut pas garantir ------------------


def test_une_sauvegarde_dont_la_CHAINE_est_rompue_ne_se_restaure_pas(tmp_path):
    """Le registre serait peut-être utilisable ; son journal ne prouverait plus
    rien — et c'est précisément ce qu'on relit après un incident."""
    _registre(tmp_path / "reg.db")
    fichier = sauvegarde.sauvegarder(tmp_path / "reg.db", tmp_path / "sauv")

    # On casse une ligne du journal DANS la sauvegarde, hors du produit. Le
    # verrou d'écriture du 005 est désactivé le temps de le faire : c'est un
    # adversaire qui a déjà root que l'on simule, comme dans
    # `test_journal_chaine.py`.
    abimee = connect(fichier)
    abimee.execute("DROP TRIGGER audit_log_immuable_update")
    abimee.execute("UPDATE audit_log SET message = 'récrit' WHERE id = 2")
    abimee.close()

    cible = tmp_path / "cible.db"
    with pytest.raises(sauvegarde.SauvegardeError, match="chaîne du journal"):
        sauvegarde.restaurer(fichier, cible)
    assert not cible.exists(), "rien ne doit avoir été posé"


def test_le_registre_remplacé_est_DÉPLACÉ_jamais_écrasé(tmp_path):
    """Celui qu'on remplace est parfois moins abîmé qu'on ne le croyait, et on
    ne s'en aperçoit qu'après."""
    _registre(tmp_path / "reg.db")
    fichier = sauvegarde.sauvegarder(tmp_path / "reg.db", tmp_path / "sauv")

    cible = tmp_path / "en-place.db"
    ancien = connect(cible)
    with transaction(ancien) as c:
        c.execute("CREATE TABLE marque (m TEXT)")
        c.execute("INSERT INTO marque VALUES ('ancien registre')")
    ancien.close()

    remplace = sauvegarde.restaurer(fichier, cible)
    assert remplace is not None and remplace.exists()
    assert connect(remplace).execute(
        "SELECT m FROM marque").fetchone()[0] == "ancien registre"
    # …et la cible porte bien le contenu restauré.
    assert _compter(connect(cible)) == 40


def test_les_annexes_WAL_de_l_ancien_registre_partent_AVEC_lui(tmp_path):
    """Laissées en place, SQLite les rejouerait par-dessus le registre restauré.

    C'est le défaut qui rendrait la restauration silencieusement inutile : le
    fichier serait bien celui de la sauvegarde, et son contenu celui d'avant.
    """
    _registre(tmp_path / "reg.db")
    fichier = sauvegarde.sauvegarder(tmp_path / "reg.db", tmp_path / "sauv")

    cible = tmp_path / "en-place.db"
    vivant = connect(cible)
    with transaction(vivant) as c:
        c.execute("CREATE TABLE marque (m TEXT)")
    vivant.execute("INSERT INTO marque VALUES ('non reversé')")
    assert cible.with_name(cible.name + "-wal").exists(), "le WAL doit exister"

    sauvegarde.restaurer(fichier, cible)
    for suffixe in sauvegarde.ANNEXES:
        assert not cible.with_name(cible.name + suffixe).exists(), suffixe


def test_une_sauvegarde_ABSENTE_le_dit(tmp_path):
    with pytest.raises(sauvegarde.SauvegardeError, match="Aucune sauvegarde"):
        sauvegarde.restaurer(tmp_path / "rien.db", tmp_path / "cible.db")


# --- Le va-et-vient complet -------------------------------------------------


def test_sauvegarder_puis_RESTAURER_rend_exactement_ce_qui_avait_été_pris(tmp_path):
    """L'exercice que la DoD réclame, joué ici : c'est la restauration qui
    compte, pas la sauvegarde."""
    origine = _registre(tmp_path / "reg.db")
    avant = audit.verify_chain(origine)
    entrees = _compter(origine)

    fichier = sauvegarde.sauvegarder(tmp_path / "reg.db", tmp_path / "sauv")

    # La vie continue APRÈS la sauvegarde : ces écritures doivent être perdues,
    # et c'est le §2.6 — on perd l'intervalle, ni plus ni moins.
    audit.record(origine, None, "spark.delete", "ok", "après la sauvegarde",
                 target_type="spark", target_id="spark-1")
    origine.close()

    sauvegarde.restaurer(fichier, tmp_path / "reg.db")
    restaure = connect(tmp_path / "reg.db")
    apres = audit.verify_chain(restaure)
    assert apres["intact"] is True
    assert apres["head"] == avant["head"], "la tête est celle de la sauvegarde"
    assert apres["length"] == avant["length"], "l’écriture d’après est perdue"
    assert _compter(restaure) == entrees


def test_un_fichier_SANS_JOURNAL_est_nommé_au_lieu_de_lever_une_erreur_brute(tmp_path):
    """Trouvé par la preuve du WAL, et c'était un vrai défaut.

    Un fichier SQLite valide qui ne porte pas `audit_log` n'est pas un registre
    Spark — ou c'en est un tronqué. Laisser remonter l'erreur de SQLite ferait
    chercher une panne du produit là où le fichier est simplement le mauvais.
    """
    autre = tmp_path / "pas-un-registre.db"
    c = sqlite3.connect(autre)
    c.execute("CREATE TABLE autre (x INT)")
    c.commit(); c.close()

    vu = sauvegarde.verifier(autre)
    assert vu["structure"] == "ok", "le fichier est structurellement sain"
    assert vu["chaine"]["intact"] is False
    assert "journal illisible" in vu["chaine"]["break"]

    # Et la restauration le REFUSE, avec un message qui parle du journal.
    with pytest.raises(sauvegarde.SauvegardeError, match="chaîne du journal"):
        sauvegarde.restaurer(autre, tmp_path / "cible.db")
    assert not (tmp_path / "cible.db").exists()
