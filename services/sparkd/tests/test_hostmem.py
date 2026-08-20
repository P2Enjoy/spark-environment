"""@verifies docs/BACKLOG.md#SPK-03 · docs/DAT.md §16 (La réserve de la Forge)

On ne suppose JAMAIS un ARC nul : c'est l'hypothese qui a fait promettre au
registre un cinquieme de memoire en trop.
"""

from __future__ import annotations

import pytest

from sparkd import hostmem
from sparkd.hostmem import (
    MemoryReadError,
    arc_ceiling,
    kernel_memory_total,
    measure,
    parse_size,
)


@pytest.mark.parametrize("texte,octets", [
    ("2GiB", 2 * 1024**3), ("512MiB", 512 * 1024**2), ("1TiB", 1024**4),
    ("1GB", 10**9), ("1024", 1024), ("0", 0), (4096, 4096),
])
def test_lecture_des_tailles(texte, octets):
    assert parse_size(texte) == octets


@pytest.mark.parametrize("texte", ["deux gigas", "2Gx", "", "GiB"])
def test_taille_illisible_refusee(texte):
    with pytest.raises(ValueError):
        parse_size(texte)


def test_memtotal_lu_sur_meminfo(tmp_path):
    f = tmp_path / "meminfo"
    f.write_text("MemFree: 12 kB\nMemTotal:       98810556 kB\n")
    assert kernel_memory_total(f) == 98810556 * 1024


def test_meminfo_absent_echoue(tmp_path):
    """Mieux vaut echouer que retenir une memoire inventee."""
    with pytest.raises(MemoryReadError):
        kernel_memory_total(tmp_path / "absent")


def test_arc_lu_sur_le_module(tmp_path):
    f = tmp_path / "arc"; f.write_text("17179869184\n")
    c = arc_ceiling(100 * 1024**3, f)
    assert c.bytes == 16 * 1024**3 and c.known is True


def test_arc_illisible_n_est_pas_un_arc_nul(tmp_path):
    """docs/DAT.md §16.2 — l'inconnu se signale, il ne se suppose pas."""
    c = arc_ceiling(100 * 1024**3, tmp_path / "absent")
    assert c.known is False
    assert "surestime" in c.detail.replace("é", "e")


def test_arc_a_zero_signifie_la_moitie_de_la_ram(tmp_path):
    """Un plafond non pose n'est pas un plafond absent : ZFS prend la moitie."""
    f = tmp_path / "arc"; f.write_text("0\n")
    c = arc_ceiling(100 * 1024**3, f)
    assert c.bytes == 50 * 1024**3 and c.known is True


def test_mesure_complete(tmp_path):
    mem = tmp_path / "meminfo"; mem.write_text("MemTotal: 98810556 kB\n")
    arc = tmp_path / "arc"; arc.write_text(str(16 * 1024**3))
    m = measure(operating_margin=2 * 1024**3, meminfo=mem, arc_path=arc)
    assert m.total_bytes == 98810556 * 1024
    assert m.reserve_bytes == 18 * 1024**3
    assert m.allocatable_bytes == m.total_bytes - 18 * 1024**3


# --- consommation instantanee de l'ARC (docs/DAT.md §13.12) -----------------


def test_arc_used_lit_la_ligne_size_des_arcstats(tmp_path):
    stats = tmp_path / "arcstats"
    stats.write_text(
        "name                            type data\n"
        "hits                               4 123456\n"
        "size                               4 17179869184\n"
        "c_max                              4 17179869184\n"
    )
    assert hostmem.arc_used(stats) == 17179869184


def test_arc_used_rend_None_et_non_zero_quand_zfs_est_absent(tmp_path):
    """`None` n'est pas zero : un ARC dont on ignore la taille n'est pas vide.

    Les confondre ferait croire la reserve du §16.1 inutile.
    """
    assert hostmem.arc_used(tmp_path / "inexistant") is None


def test_arc_used_rend_None_sur_un_fichier_illisible(tmp_path):
    stats = tmp_path / "arcstats"
    stats.write_text("size 4 pas-un-nombre\n")
    assert hostmem.arc_used(stats) is None
    stats.write_text("aucune ligne size ici\n")
    assert hostmem.arc_used(stats) is None


def test_measure_porte_la_consommation_de_l_arc(tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:       98765432 kB\n")
    arc_max = tmp_path / "arc_max"
    arc_max.write_text(str(16 * 1024**3))
    stats = tmp_path / "arcstats"
    stats.write_text("size 4 1610612736\n")

    mesure = hostmem.measure(meminfo=meminfo, arc_path=arc_max, arc_stats=stats)
    assert mesure.arc_bytes == 16 * 1024**3, "le PLAFOND"
    assert mesure.arc_used_bytes == 1610612736, "et ce qu'il en occupe"
    # Le plafond est ce qui est reserve ; la consommation ne change pas le calcul.
    assert mesure.reserve_bytes == 16 * 1024**3 + hostmem.DEFAULT_RESERVE
