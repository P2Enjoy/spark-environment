"""@verifies docs/BACKLOG.md#SPK-29 · docs/DAT.md §32, §32.1 (le mécanisme),
           §32.2 (le poids n'est pas une constante), §32.3 (la réserve rend la
           loi définie), §32.4 · §7.2 bis

Le cœur : le poids de la tranche doit valoir CE QUE LES SPARKS ONT ACHETÉ. Une
constante rendrait la réservation absolue pour un seul taux de remplissage.
"""

from __future__ import annotations

import pytest

from sparkd import cgroup
from sparkd.cgroup import CgroupError, HOST_WEIGHT, slice_weight


# --- la loi de poids (docs/DAT.md §32.2) ------------------------------------


@pytest.mark.parametrize("vendu,attendu_part", [
    (1.0, 0.25),
    (2.0, 0.50),
    (3.0, 0.75),
    (3.5, 0.875),
])
def test_la_tranche_obtient_exactement_la_part_vendue(vendu, attendu_part):
    """Sur 4 cœurs : un Spark reservant r doit obtenir r/4 de la machine.

    C'est la DoD de l'unite, verifiee par le calcul avant de l'etre par la
    contention.
    """
    poids = slice_weight(sold=vendu, capacity=4.0, reserve=0.5)
    assert poids.share == pytest.approx(attendu_part, abs=0.005), (
        f"part obtenue {poids.share:.4f} pour {vendu} vendus sur 4"
    )


def test_les_poids_calcules_correspondent_au_tableau_du_DAT():
    assert slice_weight(1.0, 4.0, 0.5).weight == 100
    assert slice_weight(2.0, 4.0, 0.5).weight == 300
    assert slice_weight(3.5, 4.0, 0.5).weight == 2100


def test_une_constante_ne_pourrait_pas_convenir():
    """Le poids DOIT bouger avec l'allocation.

    Si une constante suffisait, deux taux de remplissage differents donneraient
    la meme valeur. Ce test echouerait alors, et c'est ce qu'on veut.
    """
    faible = slice_weight(0.5, 4.0, 0.5).weight
    fort = slice_weight(3.0, 4.0, 0.5).weight
    assert faible != fort
    assert fort > faible, "vendre plus doit peser plus"


# --- la reserve rend la loi definie (§32.3) ---------------------------------


def test_sans_reserve_une_machine_entierement_vendue_ferait_diverger_le_poids():
    """f -> 1 donne un poids infini : l'hote n'ordonnancerait plus rien.

    La reserve n'est donc pas une precaution, elle est ce qui rend la loi
    calculable. Ici on verifie qu'elle BORNE effectivement le resultat.
    """
    borne = slice_weight(sold=99.0, capacity=4.0, reserve=0.5)
    # Vendre 99 sur 4 est absurde ; la loi doit se comporter comme si l'on avait
    # vendu le maximum allouable, soit 3,5.
    assert borne.sold == 3.5
    assert borne.weight == slice_weight(3.5, 4.0, 0.5).weight
    assert borne.share < 1.0, "l'hote conserve toujours une part"


def test_l_hote_garde_au_moins_sa_reserve():
    """Quel que soit le remplissage, la part laissee a l'hote >= reserve/capacite."""
    for vendu in (0.0, 0.5, 1.0, 2.0, 3.0, 3.5, 10.0):
        poids = slice_weight(vendu, 4.0, 0.5)
        part_hote = 1 - poids.share
        assert part_hote >= 0.5 / 4.0 - 0.005, (
            f"{vendu} vendus laissent {part_hote:.3f} a l'hote"
        )


def test_une_reserve_superieure_a_la_capacite_est_refusee():
    with pytest.raises(CgroupError, match="plus rien ne serait allouable"):
        slice_weight(1.0, 4.0, 4.0)


def test_une_capacite_nulle_est_refusee_plutot_que_divisee():
    with pytest.raises(CgroupError, match="Capacité CPU nulle"):
        slice_weight(1.0, 0.0, 0.0)


def test_une_reserve_negative_est_refusee():
    with pytest.raises(CgroupError, match="négative"):
        slice_weight(1.0, 4.0, -1.0)


# --- cas limites -------------------------------------------------------------


def test_aucun_spark_donne_le_poids_minimal_et_non_zero():
    """La tranche doit rester ordonnancable meme vide : 0 est refuse par le noyau."""
    poids = slice_weight(0.0, 4.0, 0.5)
    assert poids.weight == cgroup.WEIGHT_MIN == 1


def test_le_poids_reste_dans_les_bornes_du_noyau():
    for vendu in (0.0, 0.001, 1.0, 3.4999, 3.5):
        p = slice_weight(vendu, 4.0, 0.5)
        assert cgroup.WEIGHT_MIN <= p.weight <= cgroup.WEIGHT_MAX


def test_une_reserve_minuscule_ne_fait_pas_deborder_le_poids():
    """Avec une reserve tres faible, le poids brut explose : il doit etre borne."""
    p = slice_weight(sold=1000.0, capacity=1000.0, reserve=0.001)
    assert p.weight == cgroup.WEIGHT_MAX


# --- la directive raw.lxc (§32.1) -------------------------------------------


def test_raw_lxc_place_la_charge_ET_le_moniteur_dans_la_tranche():
    directive = cgroup.raw_lxc("crm-production")
    assert "lxc.cgroup.dir.container = spark.slice/crm-production" in directive
    assert "lxc.cgroup.dir.monitor = spark.slice/monitor-crm-production" in directive


def test_raw_lxc_ne_touche_ni_au_poids_ni_au_plafond():
    """Le deplacement ne doit rien changer d'autre.

    Mesure du §32.1 : la loi du §7.2 bis s'applique inchangee dans la tranche et
    cpu.max reste `max`. Emettre ici une limite la contredirait.
    """
    directive = cgroup.raw_lxc("x")
    assert "cpu.weight" not in directive
    assert "cpu.max" not in directive


# --- lecture et ecriture de la tranche --------------------------------------


def test_inspect_rend_absente_plutot_que_d_echouer(tmp_path):
    """Sur un poste sans cgroup v2, l'absence est normale, pas une panne."""
    assert cgroup.inspect(tmp_path) == {"present": False, "weight": None, "controllers": []}


def test_inspect_lit_le_poids_et_les_controleurs(tmp_path):
    tranche = tmp_path / cgroup.SLICE
    tranche.mkdir()
    (tranche / "cpu.weight").write_text("300\n")
    (tranche / "cgroup.subtree_control").write_text("cpuset cpu io memory pids\n")
    etat = cgroup.inspect(tmp_path)
    assert etat["present"] is True
    assert etat["weight"] == 300
    assert "cpu" in etat["controllers"] and "cpuset" in etat["controllers"]


def test_apply_weight_ecrit_reellement(tmp_path):
    tranche = tmp_path / cgroup.SLICE
    tranche.mkdir()
    (tranche / "cpu.weight").write_text("100")
    assert cgroup.apply_weight(slice_weight(2.0, 4.0, 0.5), tmp_path) is True
    assert (tranche / "cpu.weight").read_text() == "300"


def test_apply_weight_rend_False_sans_faire_echouer_l_appelant(tmp_path):
    """Une tranche absente est un hote non prepare, pas une erreur de creation.

    La faire echouer ferait rater chaque creation de Spark sur un hote ou la
    tranche manque, alors que le produit fonctionne — moins bien, mais il
    fonctionne. Le manque se constate au preflight.
    """
    assert cgroup.apply_weight(slice_weight(1.0, 4.0, 0.5), tmp_path) is False


# --- la delegation se reaffirme (docs/DAT.md §32.1) -------------------------


def test_ensure_delegation_pose_les_controleurs_manquants(tmp_path):
    tranche = tmp_path / cgroup.SLICE
    tranche.mkdir()
    (tranche / "cgroup.subtree_control").write_text("hugetlb rdma misc\n")
    poses = cgroup.ensure_delegation(tmp_path)
    assert set(poses) == {"cpu", "cpuset", "memory"}
    assert (tranche / "cgroup.subtree_control").read_text() == "+cpu +cpuset +memory"


def test_ensure_delegation_ne_reecrit_pas_ce_qui_est_deja_la(tmp_path):
    tranche = tmp_path / cgroup.SLICE
    tranche.mkdir()
    (tranche / "cgroup.subtree_control").write_text("cpuset cpu io memory pids\n")
    assert cgroup.ensure_delegation(tmp_path) == []
    assert "cpuset cpu io memory pids" in (tranche / "cgroup.subtree_control").read_text()


def test_ensure_delegation_sans_tranche_ne_leve_pas(tmp_path):
    """Sur un poste sans cgroup v2, l'absence est normale."""
    assert cgroup.ensure_delegation(tmp_path) == []
