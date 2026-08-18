"""@verifies docs/BACKLOG.md#SPK-10 · docs/DAT.md §15.2, §15.3

Le plan d'adressage est une regle metier, pas un detail : une plage qui deborde
silencieusement finit par recouvrir la passerelle ou le DHCP, et la panne se
manifeste alors tres loin de sa cause.
"""

from __future__ import annotations

import ipaddress

import pytest

from sparkd import addressing, migrations
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "a.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def poser(db, ident, adresse):
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "ipv4_address,created_at,updated_at) VALUES (?,?,?,'shared',0.1,?,?,?,?,'x','x')",
        (ident, f"s-{ident}", "images:debian/13", GIO, 10_000_000, GIO, adresse),
    )


# --- plan d'adressage -------------------------------------------------------

def test_la_plage_du_registre_ne_touche_ni_la_passerelle_ni_le_dhcp():
    assert addressing.GATEWAY < addressing.FIRST
    assert addressing.LAST < addressing.DHCP_FIRST


def test_capacite_annoncee():
    assert addressing.capacity() == 224


def test_la_plage_dhcp_est_disjointe():
    """Sans cette disjonction, dnsmasq pourrait attribuer une adresse promise."""
    assert addressing.DHCP_RANGE == "10.77.0.240-10.77.0.254"
    assert not addressing.is_managed("10.77.0.247")


@pytest.mark.parametrize("adresse,gere", [
    ("10.77.0.1", False),    # passerelle
    ("10.77.0.15", False),   # infrastructure
    ("10.77.0.16", True),    # premiere du registre
    ("10.77.0.239", True),   # derniere du registre
    ("10.77.0.240", False),  # DHCP
    ("pas-une-ip", False),
])
def test_appartenance_a_la_plage(adresse, gere):
    assert addressing.is_managed(adresse) is gere


# --- attribution ------------------------------------------------------------

def test_premiere_attribution(db):
    assert addressing.allocate(db) == "10.77.0.16"


def test_attribution_deterministe_la_plus_petite_libre(db):
    poser(db, "1", "10.77.0.16")
    poser(db, "2", "10.77.0.18")
    # Le trou est repris avant de continuer.
    assert addressing.allocate(db) == "10.77.0.17"


def test_recreer_dans_un_parc_inchange_rend_la_meme_adresse(db):
    """docs/DAT.md §15.3 : les notes de l'exploitant restent vraies."""
    premiere = addressing.allocate(db)
    poser(db, "1", premiere)
    db.execute("DELETE FROM spark WHERE id='1'")
    assert addressing.allocate(db) == premiere


def test_epuisement_refuse_en_le_nommant(db):
    for index, valeur in enumerate(range(int(addressing.FIRST), int(addressing.LAST) + 1)):
        poser(db, str(index), str(ipaddress.IPv4Address(valeur)))
    with pytest.raises(addressing.AddressPoolExhausted) as refus:
        addressing.allocate(db)
    message = str(refus.value)
    assert "epuisee" in message.replace("é", "e")
    assert "224" in message


def test_l_epuisement_ne_deborde_jamais(db):
    """Deborder recouvrirait la passerelle ou le DHCP."""
    for index, valeur in enumerate(range(int(addressing.FIRST), int(addressing.LAST) + 1)):
        poser(db, str(index), str(ipaddress.IPv4Address(valeur)))
    with pytest.raises(addressing.AddressPoolExhausted):
        addressing.allocate(db)
    # Aucune adresse hors plage n'a ete inventee.
    assert all(addressing.is_managed(str(a)) for a in addressing.taken(db))


def test_usage(db):
    poser(db, "1", "10.77.0.16")
    u = addressing.usage(db)
    assert u.capacity == 224 and u.used == 1 and u.free == 223
