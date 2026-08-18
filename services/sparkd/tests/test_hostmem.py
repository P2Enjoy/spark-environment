"""@verifies docs/BACKLOG.md#SPK-03 · docs/DAT.md §16 (La réserve de l'hôte)

On ne suppose JAMAIS un ARC nul : c'est l'hypothese qui a fait promettre au
registre un cinquieme de memoire en trop.
"""

from __future__ import annotations

import pytest

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
