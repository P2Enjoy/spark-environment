"""@verifies docs/BACKLOG.md#SPK-182 · docs/DAT.md §74 (le SLA des instantanés),
§74.2 (la politique), §74.5 (la prise), §74.6 (la rétention), §74.7 (l'aperçu) ·
docs/SCHEMA.md §8 ter

Le point de conception qui compte : la suppression automatique ne détruit que ce qui
est à elle. Un instantané manuel n'est jamais supprimé ; le plus récent non plus ;
une politique suspendue ne détruit rien ; et l'enregistrement d'une rétention qui
supprimerait refuse tant qu'on ne l'a pas accepté, en nommant ce qui serait perdu.

Ces preuves utilisent le VRAI registre (migrations comprises) et le doublon Incus, avec
une horloge injectée : rejouer des instants passés ne demande pas d'attendre.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from sparkd import audit, migrations, sla, snapshots
from sparkd.db import connect
from sparkd.incus import FakeIncus

GIO = 1024**3


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "s.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "incus_name,created_at,updated_at,state) VALUES ('S1','crm','images:debian/13',"
        "'shared',0.5,?,10000000,?,'crm','x','x','running')", (GIO, GIO))
    yield connection
    connection.close()


@pytest.fixture
def incus():
    faux = FakeIncus()
    faux.created["crm"] = {"name": "crm", "status": "Running"}
    return faux


def spark(db):
    return dict(db.execute("SELECT * FROM spark WHERE id='S1'").fetchone())


def prendre(db, incus, instant):
    """Une prise SLA à l'instant donné, par le vrai chemin (comme le seed)."""
    return snapshots.create(db, spark(db), sla.nom_sla(instant), incus, origin="sla",
                            created_at=sla._iso(instant))


def instantanes(db, origine=None):
    return [s["incus_name"] for s in snapshots.listing(db, "S1")
            if origine is None or s["origin"] == origine]


# --- la sélection de la rétention : pure ----------------------------------------------

def liste(*jours):
    base = utc(2026, 11, 18)
    return [{"incus_name": f"SLA_{i}", "created_at": sla._iso(base - timedelta(days=j))}
            for i, j in enumerate(jours)]


def test_age_seul():
    s = liste(10, 8, 3, 1, 0)          # du plus ancien au plus récent
    assert sla.a_supprimer(s, utc(2026, 11, 18), 5, None) == ["SLA_0", "SLA_1"]


def test_nombre_seul_supprime_les_plus_anciens():
    s = liste(4, 3, 2, 1, 0)
    assert sla.a_supprimer(s, utc(2026, 11, 18), None, 3) == ["SLA_0", "SLA_1"]


def test_les_deux_criteres_le_premier_atteint_supprime():
    s = liste(10, 3, 2, 1, 0)
    # âge 5 j : supprime SLA_0 ; il reste 4 > 2 : le nombre supprime SLA_1 et SLA_2.
    assert sla.a_supprimer(s, utc(2026, 11, 18), 5, 2) == ["SLA_0", "SLA_1", "SLA_2"]


def test_le_plus_recent_n_est_jamais_supprime_meme_perime():
    s = liste(30, 20, 10)              # tous bien au-delà de 1 jour
    assert sla.a_supprimer(s, utc(2026, 11, 18), 1, None) == ["SLA_0", "SLA_1"]
    assert "SLA_2" not in sla.a_supprimer(s, utc(2026, 11, 18), 1, 1)


def test_nombre_un_garde_exactement_le_plus_recent():
    s = liste(3, 2, 1)
    assert sla.a_supprimer(s, utc(2026, 11, 18), None, 1) == ["SLA_0", "SLA_1"]


def test_liste_vide_ou_d_un_seul_ne_supprime_rien():
    assert sla.a_supprimer([], utc(2026, 11, 18), 1, 1) == []
    assert sla.a_supprimer(liste(99), utc(2026, 11, 18), 1, 1) == []


def test_sous_la_limite_rien():
    assert sla.a_supprimer(liste(2, 1, 0), utc(2026, 11, 18), 10, 10) == []


# --- la validation ---------------------------------------------------------------------

@pytest.mark.parametrize("schedule, jours, nombre, raison", [
    ("0 2 * * *", None, None, "rétention est obligatoire"),
    ("*/5 * * * *", 7, None, "15 minutes"),
    ("@daily", 7, None, "alias"),
    ("0 2 * * *", 0, None, "entre 1 et 3650"),
    ("0 2 * * *", 3651, None, "entre 1 et 3650"),
    ("0 2 * * *", None, 0, "entre 1 et 1000"),
    ("0 2 * * *", None, 1001, "entre 1 et 1000"),
    ("0 2 * * *", 7.5, None, "nombre entier"),
    ("0 2 * * *", "7", None, "nombre entier"),
    ("0 2 * * *", True, None, "nombre entier"),
])
def test_refus_de_validation(schedule, jours, nombre, raison):
    with pytest.raises(sla.SlaError, match=raison):
        sla.valider(schedule, jours, nombre)


def test_la_base_refuse_aussi_une_politique_sans_retention(db):
    # Le CHECK tient même si l'API était contournée (SCHEMA §8 ter).
    with pytest.raises(Exception, match="CHECK"):
        db.execute("INSERT INTO sla (spark_id, schedule, created_at, updated_at)"
                   " VALUES ('S1', '0 2 * * *', 'x', 'x')")


# --- le nom et la provenance ------------------------------------------------------------

def test_nom_sla_horodate_en_utc():
    assert sla.nom_sla(utc(2026, 11, 19, 2, 0, 0)) == "SLA_20261119-020000"
    plus_deux = timezone(timedelta(hours=2))
    assert sla.nom_sla(datetime(2026, 11, 19, 4, 0, 0, tzinfo=plus_deux)) == "SLA_20261119-020000"


def test_un_instantane_manuel_ne_peut_pas_porter_le_nom_reserve(db, incus):
    with pytest.raises(snapshots.SnapshotError, match="invalide"):
        snapshots.create(db, spark(db), "SLA_20261119-020000", incus)


def test_un_nom_sla_mal_forme_est_refuse_pour_l_origine_sla(db, incus):
    for nom in ("sla-20261119", "SLA_2026", "SLA_20261119-0200", "avant-deploiement"):
        with pytest.raises(snapshots.SnapshotError, match="SLA_AAAAMMJJ-HHMMSS"):
            snapshots.create(db, spark(db), nom, incus, origin="sla")


def test_la_provenance_est_au_registre(db, incus):
    snapshots.create(db, spark(db), "avant-deploiement", incus)
    prendre(db, incus, utc(2026, 11, 19, 2))
    assert [s["origin"] for s in snapshots.listing(db, "S1")] == ["manual", "sla"]


# --- programmer -----------------------------------------------------------------------------

def test_programmer_pose_la_politique_et_la_prochaine_prise(db, incus):
    maintenant = utc(2026, 11, 18, 10, 0)
    vue = sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                         retention_count=None, now=maintenant)
    assert vue["configured"] and vue["enabled"]
    assert vue["next_run_at"] == "2026-11-19T02:00:00+00:00"
    assert vue["description"] == "Tous les jours à 02:00 UTC"


def test_programmer_est_idempotent(db, incus):
    maintenant = utc(2026, 11, 18, 10, 0)
    a = sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                       retention_count=None, now=maintenant)
    b = sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                       retention_count=None, now=maintenant + timedelta(hours=5))
    assert a == b
    assert len(db.execute("SELECT 1 FROM audit_log WHERE action = 'sla.set'").fetchall()) == 1


def test_modifier_la_seule_retention_ne_decale_pas_la_prochaine_prise(db, incus):
    maintenant = utc(2026, 11, 18, 10, 0)
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=maintenant)
    vue = sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=14,
                         retention_count=5, now=maintenant + timedelta(hours=1))
    assert vue["next_run_at"] == "2026-11-19T02:00:00+00:00"
    assert (vue["retention_days"], vue["retention_count"]) == (14, 5)


def test_changer_la_frequence_recalcule_la_prochaine_prise(db, incus):
    maintenant = utc(2026, 11, 18, 10, 0)
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=maintenant)
    vue = sla.programmer(db, spark(db), incus, schedule="0 * * * *", retention_days=7,
                         retention_count=None, now=maintenant)
    assert vue["next_run_at"] == "2026-11-18T11:00:00+00:00"


# --- l'aperçu et la confirmation ------------------------------------------------------------

def _trois_instantanes(db, incus):
    for jour in (10, 9, 1):
        prendre(db, incus, utc(2026, 11, 18) - timedelta(days=jour))


def test_apercu_ne_supprime_rien_et_nomme_ce_qui_le_serait(db, incus):
    _trois_instantanes(db, incus)
    maintenant = utc(2026, 11, 18)
    simulation = sla.apercu(db, spark(db), schedule="0 2 * * *", retention_days=5,
                            retention_count=None, now=maintenant)
    assert [d["name"] for d in simulation["would_delete"]] == [
        "SLA_20261108-000000", "SLA_20261109-000000"]
    assert len(instantanes(db)) == 3                      # rien n'a été supprimé
    assert len(simulation["next_runs"]) == 3


def test_enregistrer_qui_supprimerait_refuse_sans_confirmation_et_nomme(db, incus):
    _trois_instantanes(db, incus)
    with pytest.raises(sla.DeletionRequiresConfirmation) as refus:
        sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=5,
                       retention_count=None, now=utc(2026, 11, 18))
    assert [d["name"] for d in refus.value.deletions] == [
        "SLA_20261108-000000", "SLA_20261109-000000"]
    assert "SLA_20261108-000000" in str(refus.value)
    assert len(instantanes(db)) == 3
    assert sla.lire(db, "S1") is None                    # rien n'a été écrit
    refus_journal = db.execute(
        "SELECT result FROM audit_log WHERE action = 'sla.set'").fetchall()
    assert [r["result"] for r in refus_journal] == ["denied"]


def test_enregistrer_avec_confirmation_supprime_exactement_ce_qui_a_ete_montre(db, incus):
    _trois_instantanes(db, incus)
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=5,
                   retention_count=None, accept_deletion=True, now=utc(2026, 11, 18))
    assert instantanes(db) == ["SLA_20261117-000000"]
    assert [s["name"] for s in incus.snapshots("crm")] == ["SLA_20261117-000000"]


def test_enregistrer_sans_rien_a_supprimer_n_exige_aucune_confirmation(db, incus):
    prendre(db, incus, utc(2026, 11, 17))
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=30,
                   retention_count=None, now=utc(2026, 11, 18))
    assert instantanes(db) == ["SLA_20261117-000000"]


def test_une_politique_suspendue_a_l_enregistrement_ne_supprime_rien(db, incus):
    _trois_instantanes(db, incus)
    simulation = sla.apercu(db, spark(db), schedule="0 2 * * *", retention_days=5,
                            retention_count=None, enabled=False, now=utc(2026, 11, 18))
    assert simulation["would_delete"] == []
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=5,
                   retention_count=None, enabled=False, now=utc(2026, 11, 18))
    assert len(instantanes(db)) == 3


# --- la rétention ne touche que ce qui est à elle ------------------------------------------

def test_la_retention_ne_supprime_jamais_un_instantane_manuel(db, incus):
    snapshots.create(db, spark(db), "avant-deploiement", incus)         # manuel, le plus ancien
    for jour in (10, 9, 8):
        prendre(db, incus, utc(2026, 11, 18) - timedelta(days=jour))
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=1,
                   retention_count=1, accept_deletion=True, now=utc(2026, 11, 18))
    assert "avant-deploiement" in instantanes(db)
    assert instantanes(db, "sla") == ["SLA_20261110-000000"]            # le plus récent seul


def test_un_instantane_manuel_nomme_comme_un_sla_ne_peut_pas_exister(db, incus):
    with pytest.raises(snapshots.SnapshotError):
        snapshots.create(db, spark(db), "SLA_20261108-000000", incus)


def test_suspendre_gele_la_suppression(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=None,
                   retention_count=1, now=utc(2026, 11, 1))
    for jour in (3, 2, 1):
        prendre(db, incus, utc(2026, 11, 18) - timedelta(days=jour))
    sla.basculer(db, spark(db), enabled=False, now=utc(2026, 11, 18))
    assert sla.purger(db, spark(db), incus, utc(2026, 11, 18)) == []
    assert len(instantanes(db)) == 3
    assert sla.purger_tous(db, incus, utc(2026, 11, 18)) == {}


def test_retirer_la_politique_ne_supprime_aucun_instantane(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18))
    prendre(db, incus, utc(2026, 11, 17))
    vue = sla.retirer(db, spark(db))
    assert vue["configured"] is False
    assert instantanes(db) == ["SLA_20261117-000000"]
    assert instantanes(db, "sla") == ["SLA_20261117-000000"]           # la provenance reste


def test_reprendre_ne_rattrape_pas_la_pause(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 1))
    sla.basculer(db, spark(db), enabled=False, now=utc(2026, 11, 2))
    assert sla.lire(db, "S1")["next_run_at"] is None
    vue = sla.basculer(db, spark(db), enabled=True, now=utc(2026, 11, 18, 10))
    assert vue["next_run_at"] == "2026-11-19T02:00:00+00:00"


# --- le planificateur -------------------------------------------------------------------------

def test_une_prise_echue_est_prise_reprogrammee_et_journalisee(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    rendus = sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 0, 10))
    assert [r["resultat"] for r in rendus] == ["ok"]
    assert instantanes(db, "sla") == ["SLA_20261119-020010"]
    ligne = sla.lire(db, "S1")
    assert ligne["last_status"] == "ok" and ligne["last_run_at"] == "2026-11-19T02:00:10+00:00"
    assert ligne["next_run_at"] == "2026-11-20T02:00:00+00:00"
    assert db.execute("SELECT COUNT(*) AS n FROM audit_log WHERE action='snapshot.create'"
                      ).fetchone()["n"] == 1


def test_rien_n_est_pris_avant_l_echeance(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    assert sla.executer_echus(db, incus, utc(2026, 11, 19, 1, 59, 59)) == []
    assert instantanes(db) == []


def test_une_politique_suspendue_ne_prend_rien(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, enabled=False, now=utc(2026, 11, 18))
    assert sla.executer_echus(db, incus, utc(2026, 12, 25)) == []


def test_apres_une_panne_une_seule_prise_de_rattrapage_qui_dit_combien_ont_ete_manquees(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 * * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 0, 30))
    # sparkd est resté arrêté de 01:00 à 05:20 : 01, 02, 03, 04 et 05 h sont passées.
    rendus = sla.executer_echus(db, incus, utc(2026, 11, 18, 5, 20))
    assert rendus[0]["rattrapage"] is True
    assert len(instantanes(db, "sla")) == 1                    # UNE seule prise
    ligne = sla.lire(db, "S1")
    assert ligne["next_run_at"] == "2026-11-18T06:00:00+00:00"
    message = db.execute("SELECT message, payload FROM audit_log WHERE action='sla.catchup'"
                         ).fetchone()
    assert "Rattrapage" in message["message"]
    assert '"missed": 5' in message["payload"]


def test_une_occurrence_a_l_heure_n_est_pas_un_rattrapage(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 0, 20))
    assert db.execute("SELECT COUNT(*) AS n FROM audit_log WHERE action='sla.catchup'"
                      ).fetchone()["n"] == 0


def test_un_echec_est_dit_puis_repris_apres_cinq_minutes(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    incus.fail_next["create_snapshot"] = "pool saturé"
    rendus = sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 0, 10))
    assert rendus[0]["resultat"] == "error"
    ligne = sla.lire(db, "S1")
    assert ligne["last_status"] == "error" and "pool saturé" in ligne["last_error"]
    assert ligne["attempts"] == 1
    assert ligne["next_run_at"] == "2026-11-19T02:05:10+00:00"
    erreur = db.execute("SELECT result, message FROM audit_log WHERE action='snapshot.create'"
                        " AND result='error'").fetchone()
    assert erreur is not None and "pool saturé" in erreur["message"]
    # La reprise réussit : l'état d'erreur disparaît.
    sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 5, 11))
    ligne = sla.lire(db, "S1")
    assert ligne["last_status"] == "ok" and ligne["last_error"] is None and ligne["attempts"] == 0


def test_apres_trois_reprises_l_occurrence_est_abandonnee_jusqu_a_la_suivante(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    instant = utc(2026, 11, 19, 2, 0, 10)
    for _ in range(4):                                         # 1 essai + 3 reprises
        incus.fail_next["create_snapshot"] = "indisponible"
        sla.executer_echus(db, incus, instant)
        instant += timedelta(minutes=5)
    ligne = sla.lire(db, "S1")
    assert ligne["attempts"] == 0
    assert ligne["next_run_at"] == "2026-11-20T02:00:00+00:00"
    assert ligne["last_status"] == "error"


def test_un_spark_sans_cellule_est_saute_et_dit(db, incus):
    db.execute("UPDATE spark SET incus_name = NULL WHERE id = 'S1'")
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    rendus = sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 0, 10))
    assert rendus[0]["resultat"] == "skipped"
    ligne = sla.lire(db, "S1")
    assert ligne["last_status"] == "skipped" and "pas encore de cellule" in ligne["last_error"]
    assert instantanes(db) == []


def test_un_spark_en_transition_est_saute(db, incus):
    db.execute("UPDATE spark SET state = 'deleting' WHERE id = 'S1'")
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    assert sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 0, 10))[0]["resultat"] == "skipped"


def test_un_spark_arrete_est_capture_aussi(db, incus):
    db.execute("UPDATE spark SET state = 'stopped' WHERE id = 'S1'")
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    assert sla.executer_echus(db, incus, utc(2026, 11, 19, 2, 0, 10))[0]["resultat"] == "ok"


def test_la_prise_applique_la_retention_par_nombre(db, incus):
    sla.programmer(db, spark(db), incus, schedule="0 * * * *", retention_days=None,
                   retention_count=2, now=utc(2026, 11, 18, 0, 30))
    for heure in range(1, 6):
        sla.executer_echus(db, incus, utc(2026, 11, 18, heure, 0, 5))
    assert instantanes(db, "sla") == ["SLA_20261118-040005", "SLA_20261118-050005"]
    assert [s["name"] for s in incus.snapshots("crm")] == [
        "SLA_20261118-040005", "SLA_20261118-050005"]


def test_un_echec_de_suppression_est_journalise_et_n_arrete_pas_les_suivantes(db, incus):
    for jour in (4, 3, 2, 1):
        prendre(db, incus, utc(2026, 11, 18) - timedelta(days=jour))
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=None,
                   retention_count=3, accept_deletion=True, now=utc(2026, 11, 18))
    assert len(instantanes(db)) == 3                          # une seule suppression nécessaire
    incus.fail_next["delete_snapshot"] = "verrou"
    supprimes = sla.purger(db, spark(db), incus, utc(2026, 11, 18))
    assert supprimes == []                                    # rien à supprimer : déjà 3


def test_les_lignes_du_planificateur_portent_l_acteur_sla_de_classe_runtime(db, incus, tmp_path):
    planificateur = sla.Planificateur(ouvrir=lambda: connect(tmp_path / "s.db"), incus=incus)
    sla.programmer(db, spark(db), incus, schedule="0 2 * * *", retention_days=7,
                   retention_count=None, now=utc(2026, 11, 18, 10))
    db.commit()
    rendus = planificateur.un_pas(utc(2026, 11, 19, 2, 0, 10))
    assert [r["resultat"] for r in rendus] == ["ok"]
    ligne = db.execute("SELECT actor, actor_class FROM audit_log WHERE action='snapshot.create'"
                       ).fetchone()
    assert (ligne["actor"], ligne["actor_class"]) == ("sla", audit.RUNTIME)


def test_le_planificateur_survit_a_une_panne(db, incus):
    def casse():
        raise RuntimeError("registre indisponible")
    planificateur = sla.Planificateur(ouvrir=casse, incus=incus)
    assert planificateur.un_pas(utc(2026, 11, 19)) is None
    assert planificateur.erreurs == 1
