"""@verifies docs/BACKLOG.md#SPK-09, #SPK-05 · docs/DAT.md §14.2, §14.3, §7.7

C'est ici que l'admission control cesse d'etre un module sans appelant : la
creation d'un Spark le traverse, et un refus laisse une trace.
"""

from __future__ import annotations

import pytest

from sparkd import images, migrations, sparks
from sparkd.db import connect
from sparkd.incus import FakeIncus
from sparkd.inventory import sync
from sparkd.lifecycle import Command, State

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    sync(connection, FakeIncus(), "spark")  # hote : 4 coeurs, 98 Gio, 192 Gio
    # Depuis SPK-32, la creation n'accepte qu'une image du catalogue VERIFIEE
    # (docs/DAT.md §33.2). Le releve factice publie exactement les references
    # pre-renseignees, sans reseau sortant.
    images.seed_defaults(connection)
    images.verify(connection, fetch=images.fake_fetch)
    yield connection
    connection.close()


def spec(**champs) -> sparks.SparkSpec:
    base = dict(
        name="crm-production", image="images:debian/13", cpu_mode="shared",
        cpu_reservation=0.5, memory_bytes=2 * GIO,
        network_bps=100_000_000, storage_bytes=10 * GIO,
    )
    base.update(champs)
    return sparks.SparkSpec(**base)


# --- creation ---------------------------------------------------------------

def test_creation_ecrit_la_ligne_en_pending(db):
    """docs/DAT.md §14.2 : le registre s'ecrit AVANT Incus."""
    spark = sparks.create(db, spec())
    assert spark["state"] == State.PENDING.value
    assert spark["name"] == "crm-production"
    # Rien n'a ete cree dans Incus : c'est deliberé.
    assert spark["incus_name"] is None


def test_creation_consomme_la_capacite(db):
    avant = sparks.__dict__  # marqueur inutile, lisibilite
    from sparkd.admission import pools
    assert pools(db).cpu.allocated == 0
    sparks.create(db, spec(cpu_reservation=1.5))
    assert pools(db).cpu.allocated == 1.5


def test_nom_deja_pris_refuse(db):
    sparks.create(db, spec())
    with pytest.raises(sparks.SparkError, match="existe deja".replace("deja", "déjà")):
        sparks.create(db, spec())


@pytest.mark.parametrize("nom", ["Majuscule", "-tiret-devant", "tiret-derriere-", "avec_underscore", ""])
def test_nom_invalide_refuse(db, nom):
    with pytest.raises(sparks.SparkError, match="invalide"):
        sparks.create(db, spec(name=nom))


# --- admission control : l'appelant existe enfin ----------------------------

def test_creation_refusee_faute_de_capacite(db):
    sparks.create(db, spec(name="gros", cpu_reservation=3.5))
    with pytest.raises(sparks.AdmissionRefused) as refus:
        sparks.create(db, spec(name="trop", cpu_reservation=1.0))
    assert "cpu" in str(refus.value)
    assert "il manque" in str(refus.value)


def test_le_refus_d_admission_est_journalise(db):
    """Un refus se journalise au meme titre qu'un succes."""
    sparks.create(db, spec(name="gros", cpu_reservation=3.5))
    with pytest.raises(sparks.AdmissionRefused):
        sparks.create(db, spec(name="trop", cpu_reservation=1.0))
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.create' AND result='denied'"
    ).fetchone()
    assert ligne is not None
    assert "cpu" in ligne["message"]


def test_un_refus_ne_laisse_aucune_ligne(db):
    sparks.create(db, spec(name="gros", cpu_reservation=3.5))
    with pytest.raises(sparks.AdmissionRefused):
        sparks.create(db, spec(name="trop", cpu_reservation=1.0))
    assert [s["name"] for s in sparks.listing(db)] == ["gros"]


# --- commandes --------------------------------------------------------------

def test_parcours_complet(db):
    s = sparks.create(db, spec())
    ident = s["id"]
    assert sparks.command(db, ident, Command.APPLY)["state"] == "creating"
    assert sparks.finish(db, ident, success=True)["state"] == "stopped"
    assert sparks.command(db, ident, Command.START)["state"] == "starting"
    assert sparks.finish(db, ident, success=True)["state"] == "running"
    assert sparks.command(db, ident, Command.STOP)["state"] == "stopping"
    assert sparks.finish(db, ident, success=True)["state"] == "stopped"


def test_commande_interdite_refusee_et_journalisee(db):
    s = sparks.create(db, spec())
    with pytest.raises(sparks.SparkError, match="impossible"):
        sparks.command(db, s["id"], Command.START)
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.start' AND result='denied'"
    ).fetchone()
    assert ligne is not None


def test_echec_mene_a_error_et_retient_la_cause(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    apres = sparks.finish(db, s["id"], success=False, error="image introuvable")
    assert apres["state"] == "error"
    assert apres["last_error"] == "image introuvable"


def test_reprise_apres_error(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.finish(db, s["id"], success=False, error="panne")
    repris = sparks.command(db, s["id"], Command.RETRY)
    assert repris["state"] == "creating"
    # La reprise efface la cause precedente.
    assert repris["last_error"] is None


# --- suppression et restitution ---------------------------------------------

def test_la_ressource_n_est_rendue_qu_a_la_disparition(db):
    """docs/DAT.md §14.4."""
    from sparkd.admission import pools
    s = sparks.create(db, spec(cpu_reservation=2.0))
    sparks.command(db, s["id"], Command.DELETE)
    # En « deleting », le Spark compte encore.
    assert pools(db).cpu.allocated == 2.0
    assert sparks.finish(db, s["id"], success=True) is None
    assert pools(db).cpu.allocated == 0.0


def test_suppression_ratee_ne_perd_pas_le_spark(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.DELETE)
    apres = sparks.finish(db, s["id"], success=False, error="volume occupe")
    assert apres["state"] == "error"


# --- reconciliation au demarrage (§14.3) ------------------------------------

def test_creation_interrompue_revient_a_pending(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    resultats = sparks.reconcile_all(db, presence={})  # rien dans Incus
    assert resultats[0]["to"] == "pending"
    assert sparks.get(db, s["id"])["state"] == "pending"


def test_creation_aboutie_avant_l_arret_passe_a_stopped(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.reconcile_all(db, presence={"crm-production": (True, False)})
    assert sparks.get(db, s["id"])["state"] == "stopped"


def test_suppression_aboutie_retire_la_ligne(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.DELETE)
    sparks.reconcile_all(db, presence={})
    assert sparks.listing(db) == []


def test_un_etat_stable_n_est_pas_touche(db):
    s = sparks.create(db, spec())
    assert sparks.reconcile_all(db, presence={}) == []
    assert sparks.get(db, s["id"])["state"] == "pending"


def test_chaque_reconciliation_est_tracee(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.reconcile_all(db, presence={})
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.reconcile'"
    ).fetchone()
    assert ligne is not None and ligne["message"]


# --- adressage (SPK-10) -----------------------------------------------------

def test_la_creation_attribue_une_adresse(db):
    """@verifies docs/DAT.md §15.1 — le registre attribue, avant Incus."""
    s = sparks.create(db, spec())
    assert s["ipv4_address"] == "10.77.0.16"


def test_deux_sparks_n_obtiennent_pas_la_meme_adresse(db):
    a = sparks.create(db, spec(name="premier"))
    b = sparks.create(db, spec(name="second"))
    assert a["ipv4_address"] != b["ipv4_address"]
    assert b["ipv4_address"] == "10.77.0.17"


def test_l_adresse_est_rendue_a_la_suppression(db):
    from sparkd.lifecycle import Command
    a = sparks.create(db, spec(name="premier"))
    sparks.command(db, a["id"], Command.DELETE)
    sparks.finish(db, a["id"], success=True)
    # La plus petite libre redevient celle qui vient d'etre rendue.
    assert sparks.create(db, spec(name="repris"))["ipv4_address"] == a["ipv4_address"]


def test_l_adresse_figure_au_journal_d_audit(db):
    sparks.create(db, spec())
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='spark.create' AND result='ok'"
    ).fetchone()
    assert "10.77.0.16" in ligne["message"]


# --- le runtime publie ce qui est possible (SPK-19, docs/DAT.md §24.1) ------

def test_le_spark_porte_les_commandes_possibles(db):
    """La console ne doit pas rederiver la machine a etats."""
    s = sparks.create(db, spec())
    assert s["allowed_commands"] == ["apply", "delete"]
    assert s["transient"] is False


def test_les_commandes_suivent_l_etat(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    sparks.finish(db, s["id"], success=True)
    assert sparks.get(db, s["id"])["allowed_commands"] == ["delete", "start"]
    sparks.command(db, s["id"], Command.START)
    sparks.finish(db, s["id"], success=True)
    assert sparks.get(db, s["id"])["allowed_commands"] == ["delete", "restart", "stop"]


def test_un_etat_transitoire_n_accepte_AUCUNE_commande(db):
    """L'ecran doit le dire, plutot que d'afficher des boutons morts."""
    s = sparks.create(db, spec())
    apres = sparks.command(db, s["id"], Command.APPLY)
    assert apres["allowed_commands"] == []
    assert apres["transient"] is True


def test_un_spark_en_erreur_propose_reprise_et_suppression(db):
    s = sparks.create(db, spec())
    sparks.command(db, s["id"], Command.APPLY)
    apres = sparks.finish(db, s["id"], success=False, error="panne")
    assert apres["allowed_commands"] == ["delete", "retry"]


def test_la_liste_porte_aussi_les_commandes(db):
    sparks.create(db, spec())
    assert "allowed_commands" in sparks.listing(db)[0]


def test_les_commandes_publiees_sont_celles_qui_passent(db):
    """La liste n'est pas decorative : ce qu'elle annonce doit fonctionner."""
    s = sparks.create(db, spec())
    for nom in sparks.get(db, s["id"])["allowed_commands"]:
        if nom == "delete":
            continue          # on ne supprime pas au milieu du test
        sparks.command(db, s["id"], Command(nom))   # ne doit pas lever


# --- SPK-57 · redimensionner un Spark (docs/DAT.md §49) ---------------------


def test_agrandir_la_memoire_ecrit_le_registre(db):
    """§49.2 : le registre d'abord, Incus ensuite. Rien n'est posé sur la
    cellule ici — un quota sur la cellule sans ligne au registre serait une
    ressource prise que l'admission ne voit pas."""
    sparks.create(db, spec())
    apres = sparks.resize(db, "crm-production", {"memory_reservation_bytes": 4 * GIO})
    assert apres["memory_reservation_bytes"] == 4 * GIO
    # Relu depuis le registre, pas depuis la valeur rendue.
    assert sparks.by_name(db, "crm-production")["memory_reservation_bytes"] == 4 * GIO


def test_agrandir_est_ADMIS_alors_que_la_meme_demande_a_neuf_ne_le_serait_pas(db):
    """§49.1 : le Spark visé est DÉJÀ compté. C'est le point qui décide de toute
    l'unité, et il se montre en comparant les deux chemins."""
    sparks.create(db, spec(memory_bytes=6 * GIO))
    # Une création de 7 Gio échouerait : 6 sont déjà pris sur les ~7,35 Gio
    # allouables de la Forge factice (mesuré, et non les 98 que le commentaire
    # de la fixture annonce).
    with pytest.raises(sparks.AdmissionRefused):
        sparks.create(db, spec(name="second", memory_bytes=7 * GIO))
    # Le MÊME chiffre passe en redimensionnement, puisque le Spark rend ses 6.
    apres = sparks.resize(db, "crm-production", {"memory_reservation_bytes": 7 * GIO})
    assert apres["memory_reservation_bytes"] == 7 * GIO


def test_RETRECIR_passe_meme_sur_une_forge_saturee(db):
    """Rendre de la mémoire ne peut pas manquer de mémoire (§49.1)."""
    sparks.create(db, spec(memory_bytes=7 * GIO))
    apres = sparks.resize(db, "crm-production", {"memory_reservation_bytes": 2 * GIO})
    assert apres["memory_reservation_bytes"] == 2 * GIO


def test_une_demande_qui_ne_tient_PAS_est_refusee_et_journalisee(db):
    sparks.create(db, spec())
    with pytest.raises(sparks.AdmissionRefused):
        sparks.resize(db, "crm-production", {"memory_reservation_bytes": 900 * GIO})
    # Le registre n'a pas bougé : un refus ne laisse rien derrière lui.
    assert sparks.by_name(db, "crm-production")["memory_reservation_bytes"] == 2 * GIO
    # …et le refus laisse sa TRACE, hors transaction (§21.1).
    trace = db.execute(
        "SELECT result FROM audit_log WHERE action = 'spark.resize' "
        "ORDER BY id DESC LIMIT 1").fetchone()
    assert trace["result"] == "denied"


# --- §49.3 · rétrécir n'est pas agrandir ------------------------------------


def test_descendre_la_memoire_SOUS_L_USAGE_est_refuse(db):
    """L'OOM killer tuerait des processus dans la cellule. Le refus porte la
    mesure qui le motive."""
    sparks.create(db, spec(memory_bytes=4 * GIO))
    with pytest.raises(sparks.ShrinkRefused) as refus:
        sparks.resize(db, "crm-production", {"memory_reservation_bytes": GIO},
                      usage={"memory_bytes": 3 * GIO})
    assert refus.value.ressource == "memory"
    assert refus.value.occupe == 3 * GIO
    assert "OOM" in str(refus.value)


def test_descendre_le_DISQUE_sous_l_occupation_est_refuse(db):
    sparks.create(db, spec(storage_bytes=50 * GIO))
    with pytest.raises(sparks.ShrinkRefused) as refus:
        sparks.resize(db, "crm-production", {"storage_bytes": 10 * GIO},
                      usage={"storage_bytes": 30 * GIO})
    assert refus.value.ressource == "storage"
    assert "perdrait des données" in str(refus.value)


def test_un_refus_de_RETRECISSEMENT_n_est_PAS_un_refus_d_admission(db):
    """§49.3 : les confondre enverrait l'exploitant libérer de la place sur la
    Forge alors que le problème est DANS la cellule."""
    sparks.create(db, spec(memory_bytes=4 * GIO))
    with pytest.raises(sparks.ShrinkRefused) as refus:
        sparks.resize(db, "crm-production", {"memory_reservation_bytes": GIO},
                      usage={"memory_bytes": 3 * GIO})
    assert not isinstance(refus.value, sparks.AdmissionRefused)


def test_SANS_usage_les_refus_de_retrecissement_ne_sont_pas_prononces(db):
    """Ils portent sur ce que le RUNTIME mesure. Sans mesure, on ne les invente
    pas : le §49.3 les fonde sur une occupation relevée, pas supposée."""
    sparks.create(db, spec(memory_bytes=4 * GIO))
    apres = sparks.resize(db, "crm-production", {"memory_reservation_bytes": GIO})
    assert apres["memory_reservation_bytes"] == GIO


def test_agrandir_au_dessus_de_l_usage_reste_admis(db):
    sparks.create(db, spec(memory_bytes=4 * GIO))
    apres = sparks.resize(db, "crm-production", {"memory_reservation_bytes": 6 * GIO},
                          usage={"memory_bytes": 3 * GIO})
    assert apres["memory_reservation_bytes"] == 6 * GIO


# --- §49.5 · ce que le geste refuse toujours --------------------------------


def test_un_spark_TRANSITOIRE_ne_se_redimensionne_pas(db):
    """§14.3 : un quota écrit pendant une transition le serait sur un état qui
    n'existe déjà plus."""
    sparks.create(db, spec())  # naît en « pending », qui est transitoire ? non
    db.execute("UPDATE spark SET state = 'creating' WHERE name = 'crm-production'")
    with pytest.raises(sparks.SparkError) as refus:
        sparks.resize(db, "crm-production", {"memory_reservation_bytes": 4 * GIO})
    assert "transition" in str(refus.value)


def test_un_champ_qui_n_est_PAS_un_quota_est_refuse(db):
    """§49.2 : le nom, l'image et l'adresse privée sont des IDENTITÉS."""
    sparks.create(db, spec())
    for champ in ("name", "image", "ipv4_address", "state"):
        with pytest.raises(sparks.SparkError) as refus:
            sparks.resize(db, "crm-production", {champ: "x"})
        assert "ne se redimensionnent pas" in str(refus.value), champ


def test_une_demande_VIDE_est_refusee(db):
    # Écrire une ligne d'audit pour un geste qui ne change rien apprendrait à
    # ignorer le journal.
    sparks.create(db, spec())
    with pytest.raises(sparks.SparkError):
        sparks.resize(db, "crm-production", {})


def test_un_spark_INCONNU_rend_NotFound(db):
    with pytest.raises(sparks.NotFound):
        sparks.resize(db, "fantome", {"memory_reservation_bytes": GIO})


def test_le_geste_est_JOURNALISE_avec_ce_qui_a_change(db):
    sparks.create(db, spec())
    sparks.resize(db, "crm-production", {"memory_reservation_bytes": 4 * GIO},
                  actor="console/prod")
    trace = db.execute(
        "SELECT actor, result, message FROM audit_log "
        "WHERE action = 'spark.resize' ORDER BY id DESC LIMIT 1").fetchone()
    assert trace["result"] == "ok"
    assert trace["actor"] == "console/prod"
    # Le message NOMME le Spark : « des quotas ont changé » serait inexploitable.
    assert "crm-production" in trace["message"]
