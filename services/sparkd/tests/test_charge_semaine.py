"""@verifies docs/BACKLOG.md#SPK-188 · docs/DAT.md §76.3 bis (la charge de la semaine : 672 tranches de
15 minutes, du lundi 00:00 UTC, débuts de prise calculés d'après les fréquences ; `busiest` : cinq au
plus, le plus tôt à égalité, aucune tranche vide), §76.5 (on compte des débuts, pas des durées)

Fonction pure : aucune horloge, aucun registre — l'instant est un argument, comme pour le planificateur.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sparkd import sla

# Le jeudi 2026-11-19 : sa semaine ISO commence le lundi 2026-11-16.
JEUDI = datetime(2026, 11, 19, 14, 7, tzinfo=timezone.utc)
LUNDI = "2026-11-16T00:00:00+00:00"


def indices(semaine):
    return [i for i, n in enumerate(semaine["slots"]) if n]


def test_une_semaine_fait_672_tranches_et_commence_le_lundi_a_minuit_utc():
    s = sla.charge_semaine([], JEUDI)
    assert len(s["slots"]) == 672 and s["slot_minutes"] == 15
    assert s["start"] == LUNDI
    assert (s["peak"], s["busy_slots"], s["busiest"]) == (0, 0, [])


def test_un_dimanche_soir_appartient_encore_a_la_semaine_qui_a_commence_le_lundi():
    dimanche = datetime(2026, 11, 22, 23, 59, tzinfo=timezone.utc)
    assert sla.charge_semaine([], dimanche)["start"] == LUNDI
    lundi_suivant = datetime(2026, 11, 23, 0, 0, tzinfo=timezone.utc)
    assert sla.charge_semaine([], lundi_suivant)["start"] == "2026-11-23T00:00:00+00:00"


def test_tous_les_jours_a_deux_heures_charge_sept_tranches():
    s = sla.charge_semaine([("alpha", "0 2 * * *")], JEUDI)
    assert indices(s) == [d * 96 + 8 for d in range(7)]       # 02:00 = la 9ᵉ tranche du jour
    assert s["peak"] == 1 and s["busy_slots"] == 7


def test_un_jour_de_la_semaine_ne_charge_qu_une_tranche():
    s = sla.charge_semaine([("alpha", "0 3 * * 0")], JEUDI)    # le dimanche, 03:00
    assert indices(s) == [6 * 96 + 12]


def test_la_tranche_est_le_quart_d_heure_qui_contient_la_prise():
    assert indices(sla.charge_semaine([("a", "30 2 * * 1")], JEUDI)) == [10]       # lundi 02:30
    assert indices(sla.charge_semaine([("a", "45 2 * * 1")], JEUDI)) == [11]
    assert indices(sla.charge_semaine([("a", "59 23 * * 1")], JEUDI)) == [95]       # dernière du lundi
    assert indices(sla.charge_semaine([("a", "0 0 * * 1")], JEUDI)) == [0]          # première du lundi


def test_deux_politiques_a_la_meme_minute_s_empilent_et_se_nomment():
    s = sla.charge_semaine([("bravo", "0 2 * * *"), ("alpha", "0 2 * * *")], JEUDI)
    assert s["peak"] == 2
    assert s["slots"][8] == 2 and s["busiest"][0]["sparks"] == ["alpha", "bravo"]


def test_une_heure_sur_deux_ou_toutes_les_heures_chargent_chaque_heure_pleine():
    s = sla.charge_semaine([("alpha", "0 * * * *")], JEUDI)
    assert s["busy_slots"] == 168 and s["peak"] == 1


def test_une_frequence_mensuelle_ne_charge_que_la_semaine_qui_contient_le_jour():
    assert indices(sla.charge_semaine([("a", "0 3 1 * *")], JEUDI)) == []            # la semaine du 16 novembre
    decembre = datetime(2026, 12, 2, 9, 0, tzinfo=timezone.utc)                        # sa semaine contient le mardi 1ᵉʳ
    assert indices(sla.charge_semaine([("a", "0 3 1 * *")], decembre)) == [1 * 96 + 12]


def test_les_plus_chargees_sont_cinq_au_plus_les_plus_precoces_a_egalite_sans_tranche_vide():
    politiques = [("alpha", "0 1,2,3,4,5,6 * * *"), ("bravo", "0 4 * * 1")]
    s = sla.charge_semaine(politiques, JEUDI)
    chargees = s["busiest"]
    assert len(chargees) == 5
    assert chargees[0] == {"index": 4 * 4, "at": "2026-11-16T04:00:00+00:00", "count": 2,
                           "sparks": ["alpha", "bravo"]}
    assert all(c["count"] >= 1 for c in chargees)
    # ensuite les tranches à 1 prise, la plus précoce d'abord
    assert [c["index"] for c in chargees[1:]] == [4, 8, 12, 20]
    assert s["peak"] == 2


def test_la_somme_des_tranches_est_le_nombre_de_prises_prevues():
    s = sla.charge_semaine([("a", "0 2,14 * * *"), ("b", "*/30 * * * 1")], JEUDI)
    assert sum(s["slots"]) == 7 * 2 + 48


def test_chaque_tranche_chargee_nomme_ses_sparks_les_autres_n_ont_pas_d_entree():
    s = sla.charge_semaine([("bravo", "0 2 * * *"), ("alpha", "0 2 * * 1")], JEUDI)
    assert s["sparks_by_slot"]["8"] == ["alpha", "bravo"]            # lundi 02:00
    assert s["sparks_by_slot"][str(96 + 8)] == ["bravo"]              # mardi 02:00
    assert len(s["sparks_by_slot"]) == s["busy_slots"] == 7
    assert "9" not in s["sparks_by_slot"]
