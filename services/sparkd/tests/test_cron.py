"""@verifies docs/BACKLOG.md#SPK-182 · docs/DAT.md §74.3 (la fréquence : chaîne crontab
à cinq champs, lue en UTC, sémantique du jour, écart minimal de 15 minutes)

Ce que ces preuves verrouillent : chaque forme admise se lit comme cron la lit ; chaque
refus dit pourquoi ; le jour du mois et le jour de la semaine se combinent en « ou » ;
la prochaine occurrence est STRICTEMENT après l'instant donné, y compris aux limites
(fin de mois, année bissextile) ; deux prises ne peuvent pas être trop rapprochées.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from sparkd import cron
from sparkd.cron import ErreurCron, analyser


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


# --- les formes admises -----------------------------------------------------------

@pytest.mark.parametrize("texte, minutes, heures", [
    ("0 2 * * *", {0}, {2}),
    ("30 */6 * * *", {30}, {0, 6, 12, 18}),
    ("0 2,14 * * *", {0}, {2, 14}),
    ("15 9-11 * * *", {15}, {9, 10, 11}),
    ("0-30/15 3 * * *", {0, 15, 30}, {3}),
    ("0 0 * * *", {0}, {0}),
])
def test_formes_admises(texte, minutes, heures):
    h = analyser(texte)
    assert h.minutes == minutes and h.heures == heures


def test_les_blancs_multiples_sont_normalises():
    assert analyser("  0   2  * *  * ").source == "0 2 * * *"


def test_dimanche_vaut_zero_ou_sept():
    assert analyser("0 3 * * 0").semaine == {0}
    assert analyser("0 3 * * 7").semaine == {0}
    assert analyser("0 3 * * sun").semaine == {0}
    assert analyser("0 3 * * 0,7").semaine == {0}


def test_les_noms_de_mois_et_de_jours():
    assert analyser("0 3 1 jan,JUL *").mois == {1, 7}
    assert analyser("0 3 * * mon-fri").semaine == {1, 2, 3, 4, 5}


def test_etoile_de_semaine_ne_compte_pas_le_dimanche_deux_fois():
    assert analyser("0 3 * * *").semaine == {0, 1, 2, 3, 4, 5, 6}
    assert analyser("0 3 * * */2").semaine == {0, 2, 4, 6}


# --- les refus, avec leur raison -----------------------------------------------------

@pytest.mark.parametrize("texte, raison", [
    ("", "vide"),
    ("   ", "vide"),
    ("@daily", "alias"),
    ("@reboot", "alias"),
    ("0 2 * *", "Cinq champs"),
    ("0 2 * * * *", "Cinq champs"),
    ("60 2 * * *", "hors des bornes"),
    ("0 24 * * *", "hors des bornes"),
    ("0 2 0 * *", "hors des bornes"),
    ("0 2 * 13 *", "hors des bornes"),
    ("0 2 * * 8", "hors des bornes"),
    ("a 2 * * *", "valeur admise"),
    ("0 2 * * funday", "valeur admise"),
    ("5-1 2 * * *", "à rebours"),
    ("0 2 * * */0", "pas"),
    ("0 2 5/2 * *", "un pas ne s'applique"),
    ("0 2 , * *", "valeur admise"),
])
def test_refus_avec_raison(texte, raison):
    with pytest.raises(ErreurCron, match=raison):
        analyser(texte)


def test_une_date_impossible_est_refusee():
    with pytest.raises(ErreurCron, match="Aucune date"):
        analyser("0 0 31 2 *")
    with pytest.raises(ErreurCron, match="Aucune date"):
        analyser("0 0 30 feb *")


def test_un_29_fevrier_est_admis():
    assert analyser("0 0 29 2 *").prochaine(utc(2026, 3, 1)) == utc(2028, 2, 29)


# --- la sémantique du jour : « ou » quand les deux sont restreints --------------------

def test_jour_du_mois_et_de_la_semaine_se_combinent_en_ou():
    # « le 13 ou un vendredi » : 2026-11-13 est un vendredi ; 2026-11-06 aussi (un vendredi).
    h = analyser("0 3 13 * 5")
    assert h.convient_jour(utc(2026, 11, 6).date())    # vendredi, pas un 13
    assert h.convient_jour(utc(2026, 12, 13).date())   # un 13 (dimanche), pas un vendredi
    assert not h.convient_jour(utc(2026, 11, 7).date())


def test_une_etoile_ne_restreint_pas_et_le_et_suffit():
    assert analyser("0 3 13 * *").convient_jour(utc(2026, 12, 13).date())
    assert not analyser("0 3 13 * *").convient_jour(utc(2026, 12, 14).date())
    assert analyser("0 3 * * 5").convient_jour(utc(2026, 11, 6).date())


# --- la prochaine occurrence -----------------------------------------------------------

def test_prochaine_strictement_apres_l_instant():
    h = analyser("0 2 * * *")
    assert h.prochaine(utc(2026, 11, 18, 1, 59, 59)) == utc(2026, 11, 18, 2, 0)
    assert h.prochaine(utc(2026, 11, 18, 2, 0, 0)) == utc(2026, 11, 19, 2, 0)   # PAS la même
    assert h.prochaine(utc(2026, 11, 18, 2, 0, 30)) == utc(2026, 11, 19, 2, 0)


def test_prochaine_toutes_les_heures():
    h = analyser("0 * * * *")
    assert h.prochaine(utc(2026, 11, 18, 10, 30)) == utc(2026, 11, 18, 11, 0)
    assert h.prochaine(utc(2026, 11, 18, 23, 30)) == utc(2026, 11, 19, 0, 0)


def test_prochaine_passe_la_fin_du_mois_et_de_l_annee():
    assert analyser("0 3 1 * *").prochaine(utc(2026, 12, 31, 12)) == utc(2027, 1, 1, 3)
    assert analyser("0 3 31 * *").prochaine(utc(2026, 11, 18)) == utc(2026, 12, 31, 3)
    assert analyser("0 3 31 * *").prochaine(utc(2026, 12, 31, 3)) == utc(2027, 1, 31, 3)


def test_prochaine_jours_ouvres_saute_le_week_end():
    h = analyser("0 2 * * 1-5")
    # 2026-11-20 est un vendredi.
    assert h.prochaine(utc(2026, 11, 20, 2)) == utc(2026, 11, 23, 2)


def test_prochaine_ne_depend_pas_du_fuseau_de_l_entree():
    from datetime import timedelta
    plus_deux = timezone(timedelta(hours=2))
    h = analyser("0 2 * * *")
    # 03:30 à +02:00 = 01:30 UTC : la prochaine est 02:00 UTC le même jour.
    assert h.prochaine(datetime(2026, 11, 18, 3, 30, tzinfo=plus_deux)) == utc(2026, 11, 18, 2, 0)


def test_occurrences_croissantes():
    h = analyser("0 */6 * * *")
    sortie = h.occurrences(utc(2026, 11, 18, 0, 0), 4)
    assert sortie == [utc(2026, 11, 18, 6), utc(2026, 11, 18, 12), utc(2026, 11, 18, 18), utc(2026, 11, 19, 0)]


# --- l'écart minimal ----------------------------------------------------------------------

def test_ecart_minimal_refuse_trop_rapproche():
    for texte in ("* * * * *", "*/5 * * * *", "*/10 * * * *", "0,10 * * * *"):
        with pytest.raises(ErreurCron, match="15 minutes"):
            analyser(texte)


def test_ecart_minimal_admet_quinze_minutes_et_plus():
    assert analyser("*/15 * * * *").ecart_minimal() == 15
    assert analyser("0 * * * *").ecart_minimal() == 60
    assert analyser("0 2 * * *").ecart_minimal() == 1440


def test_ecart_minimal_voit_la_frontiere_de_minuit():
    # 23:55 puis 00:05 le lendemain : dix minutes d'écart à travers minuit.
    with pytest.raises(ErreurCron, match="15 minutes"):
        analyser("55,5 23,0 * * *")


def test_ecart_minimal_une_prise_tous_les_deux_jours_n_a_pas_de_frontiere():
    # Les 1er et 3 du mois : jamais deux jours consécutifs, donc pas d'écart de minuit.
    assert analyser("55 23,0 1,3 * *").ecart_minimal() >= 15


# --- la phrase lisible ----------------------------------------------------------------------

@pytest.mark.parametrize("texte, phrase", [
    ("0 * * * *", "Toutes les heures (UTC)"),
    ("15 * * * *", "Toutes les heures, à la minute 15 (UTC)"),
    ("0 */6 * * *", "Toutes les 6 heures (UTC)"),
    ("*/15 * * * *", "Toutes les 15 minutes (UTC)"),
    ("0 2 * * *", "Tous les jours à 02:00 UTC"),
    ("0 2,14 * * *", "Tous les jours à 02:00 et 14:00 UTC"),
    ("0 2 * * 1-5", "Du lundi au vendredi à 02:00 UTC"),
    ("0 3 * * 0", "Le dimanche à 03:00 UTC"),
    ("0 3 1 * *", "Le 1er du mois à 03:00 UTC"),
    ("0 3 1,15 * *", "Les 1er et 15 du mois à 03:00 UTC"),
    ("0 3 13 * 5", "Le vendredi ou le 13 du mois à 03:00 UTC"),
    ("0 3 * jan,jul *", "Tous les jours en janvier et juillet à 03:00 UTC"),
    ("0 */6 * * 1-5", "Toutes les 6 heures, du lundi au vendredi (UTC)"),
])
def test_phrase_lisible(texte, phrase):
    assert cron.decrire(analyser(texte)) == phrase


def test_phrase_pour_une_forme_inhabituelle_ne_s_invente_pas():
    assert "voir la chaîne" in cron.decrire(analyser("0,30 8-17 * * *"))
