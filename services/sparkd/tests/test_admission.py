"""@verifies docs/BACKLOG.md#SPK-05, docs/BACKLOG.md#SPK-30 ·
             docs/DAT.md §7.3, §7.3 bis, §7.7,
             §8.8.2 regle 4 (la marge de metadonnees est comptee au pool)

La Definition of Done nomme quatre cas limites — pool exactement plein,
dépassement d'une unité, surengagement > 1, réserve Forge — et exige un refus qui
nomme la ressource fautive et la capacité restante. Ces tests les éprouvent tous,
et surtout les REFUS : un admission control qui n'a jamais dit non n'a rien prouvé.

La Forge de référence est la machine réellement mesurée le 2026-08-18 : 4 cœurs
physiques, 94 Gio, 1 Gbit/s, 5,4 Tio.
"""

from __future__ import annotations

import pytest

from sparkd import migrations
from sparkd.admission import (
    DEFAULT_METADATA_MARGIN,
    HostNotConfigured,
    Request,
    Resource,
    admit,
    pools,
)
from sparkd.db import connect

GIO = 1024**3
TIO = 1024**4


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def poser_hote(db, **overrides):
    valeurs = {
        "id": 1, "hostname": "spark-experiment",
        "cpu_threads_total": 8, "cpu_cores_total": 4,
        "memory_total_bytes": 94 * GIO,
        "storage_total_bytes": 5 * TIO,
        "network_total_bps": 1_000_000_000,
        "memory_reserve_bytes": 0, "storage_reserve_bytes": 0,
        "overcommit_cpu": 1.0, "overcommit_memory": 1.0, "overcommit_network": 1.0,
    }
    valeurs.update(overrides)
    colonnes = ", ".join(valeurs)
    db.execute(f"INSERT INTO forge ({colonnes}) VALUES ({', '.join('?' * len(valeurs))})",
               tuple(valeurs.values()))


_compteur = [0]


def poser_spark(db, cpu_mode="shared", state="running", **champs):
    _compteur[0] += 1
    n = _compteur[0]
    valeurs = {
        "id": f"S{n}", "name": f"spark-{n}", "state": state,
        "image": "images:debian/13", "cpu_mode": cpu_mode,
        "cpu_reservation": None, "cpu_max": None, "cpu_cores": None,
        "memory_reservation_bytes": GIO,
        "network_reservation_bps": 10_000_000,
        "storage_bytes": 10 * GIO,
        "created_at": "2026-08-18T00:00:00+00:00",
        "updated_at": "2026-08-18T00:00:00+00:00",
    }
    valeurs.update(champs)
    colonnes = ", ".join(valeurs)
    db.execute(f"INSERT INTO spark ({colonnes}) VALUES ({', '.join('?' * len(valeurs))})",
               tuple(valeurs.values()))
    # RENDU depuis SPK-57 : le compteur est global au module, et écrire « S1 »
    # dans une preuve la rendrait dépendante de l'ordre d'exécution.
    return valeurs["id"]


def demande(**champs):
    base = {
        "cpu_mode": "shared", "cpu_reservation": 0.5,
        "memory_bytes": GIO, "network_bps": 10_000_000, "storage_bytes": 10 * GIO,
    }
    base.update(champs)
    return Request(**base)


# --- prealable --------------------------------------------------------------

def test_rien_n_est_admis_sans_capacite_relevee(db):
    with pytest.raises(HostNotConfigured):
        admit(db, demande())


# --- capacite ---------------------------------------------------------------

def test_capacite_comptee_en_coeurs_physiques_pas_en_threads(db):
    """DAT §7.7 : le SMT entrelace l'execution, il n'ajoute pas de capacite."""
    poser_hote(db)  # 4 coeurs, 8 threads
    assert pools(db).cpu.capacity == 4.0


def test_reserve_hote_soustraite(db):
    poser_hote(db, memory_reserve_bytes=16 * GIO, storage_reserve_bytes=100 * GIO)
    etat = pools(db)
    assert etat.memory.capacity == (94 - 16) * GIO
    assert etat.storage.capacity == 5 * TIO - 100 * GIO


def test_surengagement_multiplie_la_capacite(db):
    poser_hote(db, overcommit_cpu=2.0, overcommit_memory=1.5)
    etat = pools(db)
    assert etat.cpu.capacity == 8.0
    assert etat.memory.capacity == 94 * GIO * 1.5


def test_stockage_jamais_surengage(db):
    """DAT §7.7 : un pool de stockage sature est une panne dure."""
    poser_hote(db, overcommit_cpu=4.0)
    assert pools(db).storage.overcommit == 1.0


# --- ce que chaque mode consomme -------------------------------------------

def test_capped_consomme_son_plafond(db):
    """DAT §7.7 : on provisionne ce que le Spark PEUT prendre."""
    poser_hote(db)
    poser_spark(db, cpu_mode="capped", cpu_max=1.5)
    assert pools(db).cpu.allocated == 1.5


def test_dedicated_ne_consomme_pas_de_reservation_mais_reduit_la_capacite(db):
    poser_hote(db)
    poser_spark(db, cpu_mode="dedicated", cpu_cores=2)
    etat = pools(db)
    assert etat.cpu.allocated == 0.0
    assert etat.cpu.capacity == 2.0  # 4 coeurs - 2 dedies
    assert etat.dedicated_cores == 2


def test_shared_pinned_consomme_sa_reservation_sans_retirer_de_coeurs(db):
    poser_hote(db)
    poser_spark(db, cpu_mode="shared-pinned", cpu_reservation=0.5, cpu_cores=2)
    etat = pools(db)
    assert etat.cpu.allocated == 0.5
    assert etat.cpu.capacity == 4.0


# --- quels Sparks comptent --------------------------------------------------

@pytest.mark.parametrize("state", ["running", "stopped", "error", "deleting", "pending"])
def test_tous_les_etats_comptent(db, state):
    """DAT §7.7 : la ressource n'est rendue qu'a la disparition de la ligne."""
    poser_hote(db)
    poser_spark(db, state=state, cpu_reservation=1.0)
    assert pools(db).cpu.allocated == 1.0


def test_ressource_rendue_a_la_suppression(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=1.0)
    db.execute("DELETE FROM spark")
    assert pools(db).cpu.allocated == 0.0


# --- les cas limites de la DoD ---------------------------------------------

def test_pool_exactement_plein_admis(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.5)
    assert admit(db, demande(cpu_reservation=0.5)).admitted is True


def test_depassement_d_une_unite_refuse(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.5)
    decision = admit(db, demande(cpu_reservation=0.51))
    assert decision.admitted is False
    assert [m.resource for m in decision.shortfalls] == [Resource.CPU]


def test_surengagement_permet_ce_qui_serait_refuse_sans_lui(db):
    poser_hote(db, overcommit_cpu=2.0)
    poser_spark(db, cpu_reservation=4.0)
    assert admit(db, demande(cpu_reservation=3.0)).admitted is True


def test_reserve_hote_provoque_le_refus(db):
    poser_hote(db, memory_reserve_bytes=90 * GIO)
    decision = admit(db, demande(memory_bytes=10 * GIO))
    assert decision.admitted is False
    assert decision.shortfalls[0].resource is Resource.MEMORY


# --- la marge de metadonnees (SPK-30, §8.8.2 regle 4) -----------------------

MIO = 1024**2


def test_la_marge_entre_dans_l_alloue_du_pool(db):
    """Elle est POSEE sur le jeu de donnees, donc reellement prise.

    Un pool qui l'ignorerait promettrait ce qu'il n'a pas — meme raisonnement
    qu'au §8.5 pour l'ARC.
    """
    poser_hote(db)
    poser_spark(db, cpu_reservation=0.5, storage_bytes=10 * GIO)
    poser_spark(db, cpu_reservation=0.5, storage_bytes=20 * GIO)
    assert pools(db, 64 * MIO).storage.allocated == 30 * GIO + 2 * 64 * MIO


def test_marge_nulle_rend_l_ancienne_comptabilite(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=0.5, storage_bytes=10 * GIO)
    assert pools(db, 0).storage.allocated == 10 * GIO


def test_un_registre_vide_ne_reserve_aucune_marge(db):
    """La marge est PAR SPARK : sans Spark, elle ne coute rien."""
    poser_hote(db)
    assert pools(db, 64 * MIO).storage.allocated == 0


def test_ce_qui_tiendrait_tout_juste_sans_la_marge_est_refuse_avec_elle(db):
    """Le coeur de la regle 4. Sans elle, le registre admettrait un Spark que le
    pool ne peut pas porter, et la panne arriverait a l'ecriture."""
    poser_hote(db, storage_total_bytes=20 * GIO)
    poser_spark(db, cpu_reservation=0.5, storage_bytes=10 * GIO)   # + sa marge
    # Il reste 10 GiB moins DEUX marges : celle du Spark pose, celle du demande.
    exact = 10 * GIO - 2 * (64 * MIO)
    assert admit(db, demande(storage_bytes=exact), 64 * MIO).admitted is True
    refuse = admit(db, demande(storage_bytes=exact + 1), 64 * MIO)
    assert refuse.admitted is False
    # Il n'existe pas de refus « marge » : c'est un refus sur `storage`, dans la
    # forme du §7.7.
    assert [m.resource for m in refuse.shortfalls] == [Resource.STORAGE]


def test_le_refus_exprime_la_demande_REELLEMENT_posee(db):
    """§8.8.2 regle 4 : ce qu'on evalue est le quota qui sera pose, pas la taille
    vendue. Un manque exprime sur la taille vendue serait faux de la marge."""
    poser_hote(db, storage_total_bytes=5 * GIO)
    manque = admit(db, demande(storage_bytes=5 * GIO), 64 * MIO).shortfalls[0]
    assert manque.resource is Resource.STORAGE
    assert manque.requested == 5 * GIO + 64 * MIO


def test_la_marge_par_defaut_est_celle_du_DAT(db):
    """64 MiB (§8.8.3). Le defaut du module et celui de la configuration doivent
    rester la meme valeur : deux defauts qui divergent feraient compter le pool
    autrement que le traducteur ne pose."""
    from sparkd.config import DEFAULT_STORAGE_METADATA_MARGIN
    from sparkd.hostmem import parse_size
    from sparkd.translate import DEFAULT_METADATA_MARGIN as MARGE_TRADUCTEUR

    assert DEFAULT_METADATA_MARGIN == 64 * MIO
    assert MARGE_TRADUCTEUR == DEFAULT_METADATA_MARGIN
    assert parse_size(DEFAULT_STORAGE_METADATA_MARGIN) == DEFAULT_METADATA_MARGIN


# --- forme du refus ---------------------------------------------------------

def test_le_refus_nomme_la_ressource_et_ce_qui_reste(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.5)
    manque = admit(db, demande(cpu_reservation=1.0)).shortfalls[0]
    assert manque.resource is Resource.CPU
    assert manque.requested == 1.0
    assert manque.available == pytest.approx(0.5)
    assert manque.capacity == 4.0
    assert manque.allocated == 3.5
    assert manque.missing == pytest.approx(0.5)


def test_toutes_les_ressources_manquantes_sont_rapportees(db):
    """DAT §7.7 : corriger une demande pour se heurter a la suivante est evitable."""
    poser_hote(db)
    decision = admit(db, demande(
        cpu_reservation=99.0, memory_bytes=200 * GIO,
        network_bps=9_000_000_000, storage_bytes=99 * TIO,
    ))
    assert decision.admitted is False
    assert {m.resource for m in decision.shortfalls} == {
        Resource.CPU, Resource.MEMORY, Resource.NETWORK, Resource.STORAGE
    }


def test_le_message_de_refus_est_exploitable(db):
    poser_hote(db, overcommit_cpu=2.0)
    poser_spark(db, cpu_reservation=7.5)
    message = admit(db, demande(cpu_reservation=1.0)).reason
    assert "cpu" in message
    assert "surengagement" in message  # visible seulement s'il n'est pas a 1
    assert "il manque" in message


def test_decision_utilisable_comme_booleen(db):
    poser_hote(db)
    assert bool(admit(db, demande())) is True


# --- coeurs dedies ----------------------------------------------------------

def test_dedie_refuse_si_pas_assez_de_coeurs_libres(db):
    poser_hote(db)
    poser_spark(db, cpu_mode="dedicated", cpu_cores=3)
    decision = admit(db, demande(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    assert decision.admitted is False


def test_dedie_refuse_s_il_asphyxierait_les_sparks_partages(db):
    """Retirer des coeurs reduit le pool : les Sparks deja admis doivent y tenir."""
    poser_hote(db)
    poser_spark(db, cpu_reservation=3.0)
    decision = admit(db, demande(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2))
    assert decision.admitted is False
    assert decision.shortfalls[0].resource is Resource.CPU


def test_dedie_admis_si_la_place_existe(db):
    poser_hote(db)
    poser_spark(db, cpu_reservation=1.0)
    assert admit(db, demande(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=2)).admitted


# --- SPK-57 · l'admission d'un REDIMENSIONNEMENT (docs/DAT.md §49.1) ---------


def test_un_spark_exclu_rend_sa_memoire_au_pool(db):
    """§49.1 : un Spark qui existe est DÉJÀ compté. L'exclure rend ce qu'il
    occupe, et c'est ce qui permet d'admettre un agrandissement tenable."""
    poser_hote(db, memory_total_bytes=10 * GIO)
    cible = poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=6 * GIO)

    avant = pools(db)
    apres = pools(db, sauf=cible)
    assert avant.memory.allocated == 6 * GIO
    assert apres.memory.allocated == 0
    assert apres.memory.available == avant.memory.available + 6 * GIO


def test_agrandir_un_spark_qui_TIENT_est_admis(db):
    """8 Gio demandés sur une Forge de 10 par un Spark qui en occupe déjà 6 :
    l'agrandissement ne prend que 2 Gio, et il tient."""
    poser_hote(db, memory_total_bytes=10 * GIO)
    cible = poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=6 * GIO)
    demande = Request(cpu_mode="shared", cpu_reservation=0.5,
                      memory_bytes=8 * GIO, network_bps=10_000_000,
                      storage_bytes=10 * GIO)

    # Sans exclusion, la même demande est refusée : c'est le défaut que
    # l'exclusion existe pour éviter, et il faut le montrer.
    assert not admit(db, demande, metadata_margin=0).admitted
    assert admit(db, demande, metadata_margin=0, sauf=cible).admitted


def test_RETRECIR_ne_peut_jamais_manquer_de_place(db):
    """Rendre de la mémoire ne peut pas manquer de mémoire. Sans exclusion, une
    Forge saturée refuserait de rétrécir — ce qui est absurde (§49.1)."""
    poser_hote(db, memory_total_bytes=10 * GIO)
    cible = poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=10 * GIO)
    demande = Request(cpu_mode="shared", cpu_reservation=0.5,
                      memory_bytes=4 * GIO, network_bps=10_000_000,
                      storage_bytes=10 * GIO)
    assert admit(db, demande, metadata_margin=0, sauf=cible).admitted


def test_le_refus_porte_les_chiffres_SAISIS_et_non_un_delta(db):
    """§49.1 : « il manque 2 Gio sur une demande de 2 Gio » à qui en demande 8
    serait un message exact sur des chiffres faux. On rend d'abord, on admet
    ensuite — jamais on ne soustrait."""
    poser_hote(db, memory_total_bytes=10 * GIO)
    cible = poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=6 * GIO)
    demande = Request(cpu_mode="shared", cpu_reservation=0.5,
                      memory_bytes=40 * GIO, network_bps=10_000_000,
                      storage_bytes=10 * GIO)
    decision = admit(db, demande, metadata_margin=0, sauf=cible)
    assert not decision.admitted
    manque = next(m for m in decision.shortfalls if m.resource is Resource.MEMORY)
    assert manque.requested == 40 * GIO, "le chiffre est celui qu'on a saisi"
    assert manque.available == 10 * GIO, "et le pool, celui que le Spark a rendu"


def test_un_spark_DEDIE_rend_ses_coeurs_a_la_capacite_partagee(db):
    """C'est là que la règle compte le plus : passer de « dedicated » à
    « shared » rend des cœurs PHYSIQUES, donc augmente la capacité du pool
    partagé. Sans exclusion, la Forge évaluerait la demande contre un pool
    encore amputé (§49.1)."""
    poser_hote(db)
    cible = poser_spark(db, cpu_mode="dedicated", cpu_cores=2)

    avant = pools(db)
    apres = pools(db, sauf=cible)
    assert avant.dedicated_cores == 2
    assert apres.dedicated_cores == 0
    assert apres.cpu.capacity > avant.cpu.capacity, "les cœurs reviennent au pool"


def test_l_exclusion_ne_touche_QUE_le_spark_nomme(db):
    """Un pool cohérent et un autre faux mélangeraient deux comptabilités dans
    le même refus : les trois relevés portent la même exclusion, et elle ne
    porte que sur l'identifiant donné."""
    poser_hote(db)
    cible = poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=3 * GIO,
                        storage_bytes=20 * GIO, network_reservation_bps=50_000_000)
    poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=5 * GIO,
                storage_bytes=30 * GIO, network_reservation_bps=70_000_000)
    apres = pools(db, sauf=cible, metadata_margin=0)
    assert apres.memory.allocated == 5 * GIO
    assert apres.storage.allocated == 30 * GIO
    assert apres.network.allocated == 70_000_000


def test_un_identifiant_INCONNU_n_exclut_rien(db):
    """Exclure un Spark qui n'existe pas ne doit pas silencieusement vider un
    pool : ce serait admettre n'importe quoi sur une faute de frappe."""
    poser_hote(db)
    cible = poser_spark(db, cpu_reservation=0.5, memory_reservation_bytes=3 * GIO)
    assert pools(db, sauf="S-inexistant").memory.allocated == 3 * GIO
    assert pools(db, sauf=None).memory.allocated == 3 * GIO
