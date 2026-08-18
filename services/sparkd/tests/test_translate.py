"""@verifies docs/BACKLOG.md#SPK-08 · docs/DAT.md §7.2, §7.2 bis, §7.2 ter, §7.5, §7.6

La loi et les bornes eprouvees ici ont ete MESUREES sur l'hote, pas deduites. Ces
tests existent pour qu'une regression sur la traduction soit visible sans
mobiliser un hote Incus.

Le pool de reference est celui de la machine reelle : 4 coeurs physiques.
"""

from __future__ import annotations

import pytest

from sparkd.translate import (
    Manifest,
    TranslationError,
    allowance_percent,
    cpu_weight,
    quota_allowance,
    translate,
)

POOL = 4.0
SHARED = [0, 1, 2, 3, 4, 5, 6, 7]
GIO = 1024**3


def manifeste(**champs) -> Manifest:
    base = dict(
        name="crm-production", image="images:debian/13", cpu_mode="shared",
        cpu_reservation=0.5, memory_bytes=2 * GIO,
        network_burst_bps=100_000_000, storage_bytes=10 * GIO,
    )
    base.update(champs)
    return Manifest(**base)


# --- la loi mesuree ---------------------------------------------------------

@pytest.mark.parametrize("pct,priorite,poids", [
    (62, 5, 57), (13, 5, 8), (100, 5, 95), (100, 0, 90), (100, 10, 100),
    (25, 5, 20), (6, 5, 1),
])
def test_loi_du_poids(pct, priorite, poids):
    """cpu.weight = pct - 10 + priorite, mesure sur onze points."""
    assert cpu_weight(pct, priorite) == poids


def test_echelle_mille_preserve_la_resolution():
    """0,25 CPU sur 4 CPU : 62 % a l'echelle x1000, contre 6 % a l'echelle x100."""
    assert allowance_percent(0.25, POOL, 5) == 62
    assert cpu_weight(62, 5) == 57


def test_pourcentage_toujours_entier():
    """Incus refuse « 62.5% » : strconv.Atoi, mesure sur l'hote."""
    pct = allowance_percent(0.25, POOL, 5)
    assert isinstance(pct, int)


# --- le principe : refuser plutot qu'approximer -----------------------------

def test_reservation_trop_petite_refusee_pas_arrondie():
    """Arrondir vers le haut donnerait au Spark plus que ce qui est comptabilise."""
    with pytest.raises(TranslationError) as refus:
        allowance_percent(0.01, POOL, 5)
    message = str(refus.value)
    assert "poids d'ordonnancement nul ou negatif" in message.replace("é", "e").replace("è", "e")
    assert "Minimum admissible" in message


def test_le_plancher_depend_de_la_priorite():
    """poids = pct - 10 + priorite >= 1, donc pct >= 11 - priorite."""
    # A la priorite 10, le plancher tombe a 1 % : une reservation plus petite passe.
    assert allowance_percent(0.004, POOL, 10) == 1
    # A la priorite 0, il faut 11 %.
    with pytest.raises(TranslationError):
        allowance_percent(0.004, POOL, 0)


def test_plafond_trop_petit_refuse():
    """La plus petite tranche exprimable est 1ms/100ms, soit 0,01 CPU."""
    with pytest.raises(TranslationError, match="1ms"):
        quota_allowance(0.005)


def test_capacite_de_pool_nulle_refusee():
    with pytest.raises(TranslationError, match="topologie"):
        allowance_percent(0.5, 0, 5)


# --- forme temporelle -------------------------------------------------------

@pytest.mark.parametrize("plafond,attendu", [
    (0.5, "50ms/100ms"), (0.25, "25ms/100ms"), (2.0, "200ms/100ms"), (0.01, "1ms/100ms"),
])
def test_forme_temporelle(plafond, attendu):
    assert quota_allowance(plafond) == attendu


# --- les quatre modes -------------------------------------------------------

def test_mode_shared():
    c = translate(manifeste(cpu_mode="shared", cpu_reservation=0.5), SHARED, POOL)
    assert c.config["limits.cpu"] == "0,1,2,3,4,5,6,7"
    assert c.config["limits.cpu.allowance"] == "125%"
    assert c.config["limits.cpu.priority"] == "5"
    # Pas de plafond : le burst est reel (docs/DAT.md §7.3).
    assert "ms/" not in c.config["limits.cpu.allowance"]


def test_mode_capped_pose_un_plafond_dur_et_aucune_priorite():
    c = translate(manifeste(cpu_mode="capped", cpu_reservation=None, cpu_max=0.5), SHARED, POOL)
    assert c.config["limits.cpu.allowance"] == "50ms/100ms"
    assert "limits.cpu.priority" not in c.config


def test_mode_dedicated_epingle_les_freres_smt():
    """docs/DAT.md §7.5 : un coeur dedie n'est pas un CPU logique."""
    c = translate(
        manifeste(cpu_mode="dedicated", cpu_reservation=None, cpu_cores=1),
        SHARED, POOL, dedicated_cpus=[3, 7],
    )
    assert c.config["limits.cpu"] == "3,7"
    # Incus deconseille de combiner epinglage exclusif et quota temporel.
    assert "limits.cpu.allowance" not in c.config


def test_mode_dedicated_refuse_sans_coeurs_attribues():
    with pytest.raises(TranslationError, match="ordonnanceur du registre"):
        translate(manifeste(cpu_mode="dedicated", cpu_reservation=None), SHARED, POOL)


def test_mode_shared_pinned_cumule_epinglage_et_poids():
    c = translate(
        manifeste(cpu_mode="shared-pinned", cpu_reservation=0.5),
        SHARED, POOL, dedicated_cpus=[0, 4],
    )
    assert c.config["limits.cpu"] == "0,4"
    assert c.config["limits.cpu.allowance"] == "125%"


def test_mode_inconnu_refuse():
    with pytest.raises(TranslationError, match="Mode CPU inconnu"):
        translate(manifeste(cpu_mode="turbo"), SHARED, POOL)


@pytest.mark.parametrize("priorite", [-1, 11])
def test_priorite_hors_bornes_refusee(priorite):
    """Bornes 0..10 confirmees par la mesure."""
    with pytest.raises(TranslationError, match="hors bornes"):
        translate(manifeste(cpu_priority=priorite), SHARED, POOL)


# --- securite, memoire, reseau, stockage ------------------------------------

def test_nesting_et_idmap_isole_toujours_poses():
    c = translate(manifeste(), SHARED, POOL)
    assert c.config["security.nesting"] == "true"
    assert c.config["security.idmap.isolated"] == "true"
    # Jamais privilegie : ce serait renoncer au modele d'isolation.
    assert "security.privileged" not in c.config


def test_memoire():
    c = translate(manifeste(memory_bytes=16 * GIO, memory_enforce="soft", memory_swap=True), SHARED, POOL)
    assert c.config["limits.memory"] == str(16 * GIO)
    assert c.config["limits.memory.enforce"] == "soft"
    assert c.config["limits.memory.swap"] == "true"


def test_reseau_est_un_plafond():
    c = translate(manifeste(network_burst_bps=500_000_000), SHARED, POOL)
    assert c.devices["eth0"]["limits.max"] == "500000000"


def test_stockage():
    c = translate(manifeste(storage_bytes=40 * GIO, storage_io_priority=8), SHARED, POOL)
    assert c.devices["root"]["size"] == str(40 * GIO)


def test_priorite_disque_est_une_option_d_instance_pas_de_peripherique():
    """Mesure : Incus rejette « Invalid device option limits.disk.priority ».

    L'override d'un peripherique etant atomique, la poser au mauvais endroit
    faisait echouer AUSSI le quota « size » : le Spark repartait avec le pool
    entier. C'est le genre de defaut qu'aucun test sur pilote factice ne trouve.
    """
    c = translate(manifeste(storage_io_priority=8), SHARED, POOL)
    assert c.config["limits.disk.priority"] == "8"
    assert "limits.disk.priority" not in c.devices["root"]


def test_vm_change_le_type_d_instance():
    """docs/DAT.md §3 : le modele porte « vm » des le premier jour."""
    assert translate(manifeste(runtime="vm"), SHARED, POOL).instance_type == "virtual-machine"


# --- charge utile ------------------------------------------------------------

def test_charge_utile_rattache_reseau_et_pool():
    payload = translate(manifeste(), SHARED, POOL).as_payload("sparkbr0", "spark")
    assert payload["name"] == "crm-production"
    assert payload["type"] == "container"
    assert payload["devices"]["eth0"]["network"] == "sparkbr0"
    assert payload["devices"]["root"]["pool"] == "spark"
    assert payload["source"]["alias"] == "debian/13"


# --- reference d'image ------------------------------------------------------

def test_le_depot_n_est_pas_un_prefixe_d_alias():
    """Mesure 2026-08-19 : l'API rejette « images:debian/13 ».

    « images: » est un raccourci de la LIGNE DE COMMANDE. Passe tel quel a
    l'API, il fait echouer la creation de l'instance.
    """
    from sparkd.translate import split_image
    serveur, alias = split_image("images:debian/13")
    assert alias == "debian/13"
    assert serveur == "https://images.linuxcontainers.org"


def test_depot_par_defaut_si_absent():
    from sparkd.translate import split_image
    assert split_image("debian/13")[1] == "debian/13"


def test_depot_inconnu_refuse():
    from sparkd.translate import split_image
    with pytest.raises(TranslationError, match="inconnu"):
        split_image("mondepot:debian/13")


def test_charge_utile_separe_depot_et_alias():
    payload = translate(manifeste(), SHARED, POOL).as_payload("sparkbr0", "spark")
    assert payload["source"]["alias"] == "debian/13"
    assert payload["source"]["server"] == "https://images.linuxcontainers.org"
