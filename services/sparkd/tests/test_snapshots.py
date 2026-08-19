"""@verifies docs/BACKLOG.md#SPK-13 · docs/DAT.md §8.3, §19 · docs/SCHEMA.md §8

Le point de conception qui compte : restaurer un instantane ancien detruit tous
ceux pris depuis, et ce refus est CONSERVE par defaut. Une perte irreversible ne
se produit pas en silence.
"""

from __future__ import annotations

import pytest

from sparkd import migrations, snapshots
from sparkd.db import connect
from sparkd.incus import FakeIncus

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "s.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "incus_name,created_at,updated_at) VALUES ('S1','crm','images:debian/13',"
        "'shared',0.5,?,10000000,?,'crm','x','x')", (GIO, GIO))
    yield connection
    connection.close()


@pytest.fixture
def incus():
    faux = FakeIncus()
    faux.created["crm"] = {"name": "crm", "status": "Running"}
    return faux


def spark(db):
    return dict(db.execute("SELECT * FROM spark WHERE id='S1'").fetchone())


# --- creation ---------------------------------------------------------------

def test_creation(db, incus):
    s = snapshots.create(db, spark(db), "avant-deploiement", incus)
    assert s["incus_name"] == "avant-deploiement"
    assert s["stateful"] == 0        # docs/DAT.md §19.3
    assert incus.snapshots("crm")[0]["name"] == "avant-deploiement"


@pytest.mark.parametrize("nom", ["Majuscule", "-tiret", "tiret-", "avec_underscore", ""])
def test_nom_invalide_refuse(db, incus, nom):
    with pytest.raises(snapshots.SnapshotError, match="invalide"):
        snapshots.create(db, spark(db), nom, incus)


def test_doublon_refuse(db, incus):
    snapshots.create(db, spark(db), "a", incus)
    with pytest.raises(snapshots.SnapshotError, match="existe déjà"):
        snapshots.create(db, spark(db), "a", incus)


def test_spark_pas_encore_cree(db, incus):
    db.execute("UPDATE spark SET incus_name = NULL WHERE id='S1'")
    with pytest.raises(snapshots.SnapshotError, match="rien à capturer"):
        snapshots.create(db, spark(db), "a", incus)


def test_l_etat_n_est_jamais_demande(db, incus):
    """docs/DAT.md §19.3 — la capture memoire echoue sur cet hote."""
    snapshots.create(db, spark(db), "a", incus)
    assert incus.snapshots("crm")[0]["stateful"] is False


# --- LE point : le refus est conserve ---------------------------------------

def test_restaurer_un_ancien_est_REFUSE_par_defaut(db, incus):
    """docs/DAT.md §19.1 — une perte irreversible ne se produit pas en silence."""
    snapshots.create(db, spark(db), "ancien", incus)
    snapshots.create(db, spark(db), "recent", incus)
    with pytest.raises(snapshots.BlockedByNewer) as refus:
        snapshots.restore(db, spark(db), "ancien", incus)
    assert refus.value.blocking == ("recent",)
    assert "recent" in str(refus.value)
    # Rien n'a ete detruit.
    assert len(snapshots.listing(db, "S1")) == 2


def test_le_refus_nomme_ce_qui_bloque_et_la_sortie(db, incus):
    snapshots.create(db, spark(db), "ancien", incus)
    snapshots.create(db, spark(db), "b", incus)
    snapshots.create(db, spark(db), "c", incus)
    with pytest.raises(snapshots.BlockedByNewer) as refus:
        snapshots.restore(db, spark(db), "ancien", incus)
    message = str(refus.value)
    assert "2 instantané(s)" in message
    assert "b, c" in message
    assert "explicitement" in message


def test_le_refus_est_journalise(db, incus):
    snapshots.create(db, spark(db), "ancien", incus)
    snapshots.create(db, spark(db), "recent", incus)
    with pytest.raises(snapshots.BlockedByNewer):
        snapshots.restore(db, spark(db), "ancien", incus)
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='snapshot.restore' AND result='denied'"
    ).fetchone()
    assert ligne is not None


def test_restaurer_le_plus_recent_ne_demande_rien(db, incus):
    snapshots.create(db, spark(db), "ancien", incus)
    snapshots.create(db, spark(db), "recent", incus)
    resultat = snapshots.restore(db, spark(db), "recent", incus)
    assert resultat["destroyed"] == []
    assert len(snapshots.listing(db, "S1")) == 2


def test_l_acceptation_explicite_detruit_et_le_dit(db, incus):
    snapshots.create(db, spark(db), "ancien", incus)
    snapshots.create(db, spark(db), "recent", incus)
    resultat = snapshots.restore(db, spark(db), "ancien", incus,
                                 accept_losing_newer=True)
    assert resultat["destroyed"] == ["recent"]
    # Le registre ne garde pas ce qui n'existe plus : il mentirait sur ce qui
    # est restaurable.
    assert [s["incus_name"] for s in snapshots.listing(db, "S1")] == ["ancien"]
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='snapshot.restore' AND result='ok'"
    ).fetchone()
    assert "1 instantané(s) détruit(s)" in ligne["message"]


def test_restaurer_un_inconnu_refuse(db, incus):
    with pytest.raises(snapshots.SnapshotError, match="Aucun instantané"):
        snapshots.restore(db, spark(db), "fantome", incus)


# --- suppression ------------------------------------------------------------

def test_suppression(db, incus):
    snapshots.create(db, spark(db), "a", incus)
    snapshots.delete(db, spark(db), "a", incus)
    assert snapshots.listing(db, "S1") == []
    assert incus.snapshots("crm") == []


def test_supprimer_le_plus_recent_debloque_la_restauration(db, incus):
    """La sortie que le refus propose fonctionne reellement."""
    snapshots.create(db, spark(db), "ancien", incus)
    snapshots.create(db, spark(db), "recent", incus)
    snapshots.delete(db, spark(db), "recent", incus)
    assert snapshots.restore(db, spark(db), "ancien", incus)["destroyed"] == []


def test_la_suppression_du_spark_emporte_ses_instantanes(db, incus):
    snapshots.create(db, spark(db), "a", incus)
    db.execute("DELETE FROM spark WHERE id='S1'")
    assert db.execute("SELECT count(*) FROM snapshot").fetchone()[0] == 0
