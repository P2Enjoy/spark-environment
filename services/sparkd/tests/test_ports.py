"""@verifies docs/BACKLOG.md#SPK-49 · docs/DAT.md §39 (les ports publiés),
            §39.2 (un port public est une ressource de la Forge), §39.4 (un
            device proxy, régénéré et non rapiécé), §39.5 (où vit l'unicité) ·
            docs/SCHEMA.md §6 bis

Ce que ces preuves gardent : l'unicité vient de la BASE, un refus NOMME ce qui
bloque, et un retrait fait réellement disparaître le device — sans quoi le port
resterait ouvert vers un service qui n'est plus là.
"""

from __future__ import annotations

import sqlite3

import pytest

from sparkd import migrations, ports
from sparkd.db import connect
from sparkd.incus import FakeIncus

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "p.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


@pytest.fixture
def pilote():
    return FakeIncus()


def poser_spark(db, ident, nom, adresse="10.77.0.16"):
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "ipv4_address,created_at,updated_at) VALUES (?,?,?,'shared',0.5,?,?,?,?,'x','x')",
        (ident, nom, "images:debian/13", GIO, 10_000_000, GIO, adresse))
    return {"id": ident, "name": nom}


# --- les refus, chacun nommant ce qui bloque (§39.2, §39.5) ------------------


def test_un_port_RESERVE_est_refuse_en_nommant_le_service_qui_le_tient(db, pilote):
    """« Réservé » seul laisserait chercher pourquoi, et un exploitant qui ne
    sait pas ce qui occupe 443 essaiera de le libérer."""
    spark = poser_spark(db, "S1", "mail")
    attendus = {22: "sshd", 80: "proxy", 443: "proxy"}
    for port, mot in attendus.items():
        with pytest.raises(ports.PortError) as leve:
            ports.publish(db, pilote, spark, port, 25)
        assert mot in str(leve.value), port
        assert "pas attribuable" in str(leve.value)


def test_la_liste_des_reserves_est_CONFIGURABLE(db, pilote):
    """Une Forge peut occuper d'autres ports : un superviseur, une sauvegarde,
    un service de l'hébergeur (§39.5)."""
    spark = poser_spark(db, "S1", "mail")
    ports.publish(db, pilote, spark, 9000, 9000)          # libre par défaut
    with pytest.raises(ports.PortError) as leve:
        ports.publish(db, pilote, spark, 9001, 9001, extra_reserved=(9001,))
    assert "9001" in str(leve.value)


def test_un_port_DEJA_PRIS_est_refuse_en_nommant_le_Spark_qui_le_detient(db, pilote):
    """Sans ce nom, l'exploitant doit parcourir la liste pour le retrouver."""
    poser_spark(db, "S1", "mail")
    autre = poser_spark(db, "S2", "base", "10.77.0.17")
    ports.publish(db, pilote, {"id": "S1", "name": "mail"}, 2525, 25)
    with pytest.raises(ports.PortError) as leve:
        ports.publish(db, pilote, autre, 2525, 5432)
    assert "mail" in str(leve.value)


def test_l_unicite_vient_de_la_BASE_et_pas_du_controle_lisible(db):
    """Le contrôle de `publish` rend un refus LISIBLE ; face à deux requêtes
    simultanées, seul l'index UNIQUE protège (§39.5). On l'éprouve en écrivant
    DIRECTEMENT, sans passer par le service."""
    poser_spark(db, "S1", "mail")
    poser_spark(db, "S2", "base", "10.77.0.17")
    db.execute("INSERT INTO published_port (id,public_port,spark_id,target_port,"
               "created_at) VALUES ('a',2525,'S1',25,'x')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO published_port (id,public_port,spark_id,target_port,"
                   "created_at) VALUES ('b',2525,'S2',5432,'x')")


def test_ports_hors_bornes_et_protocole_inconnu_refuses(db, pilote):
    spark = poser_spark(db, "S1", "mail")
    with pytest.raises(ports.PortError, match="hors bornes"):
        ports.publish(db, pilote, spark, 0, 25)
    with pytest.raises(ports.PortError, match="hors bornes"):
        ports.publish(db, pilote, spark, 2525, 70000)
    with pytest.raises(ports.PortError, match="Protocole"):
        ports.publish(db, pilote, spark, 2525, 25, protocol="sctp")


def test_la_suppression_d_un_spark_emporte_ses_ports(db, pilote):
    """Un port qui survivrait à son Spark serait un port ouvert vers rien."""
    spark = poser_spark(db, "S1", "mail")
    ports.publish(db, pilote, spark, 2525, 25)
    db.execute("DELETE FROM spark WHERE id = 'S1'")
    assert db.execute("SELECT count(*) FROM published_port").fetchone()[0] == 0


# --- le device, régénéré et non rapiécé (§39.4) -----------------------------


def test_publier_pose_un_device_proxy_lisible(db, pilote):
    spark = poser_spark(db, "S1", "mail")
    pilote.created["mail"] = {"name": "mail", "devices": {
        "eth0": {"type": "nic"}, "root": {"type": "disk"}}}
    ports.publish(db, pilote, spark, 2525, 25)
    ports.apply_devices(db, pilote, "mail", "S1")

    devices = pilote.created["mail"]["devices"]
    assert devices["pub-2525"] == {
        "type": "proxy",
        "listen": "tcp:0.0.0.0:2525",
        "connect": "tcp:10.77.0.16:25",
    }
    # Le nom porte le port : l'appartenance se lit sans consulter le registre.
    assert "2525" in "pub-2525"


def test_le_retrait_fait_DISPARAITRE_le_device(db, pilote):
    """LE cœur de l'unité : sans cela le port resterait ouvert vers un service
    qui n'est plus là — la surface offerte sans service derrière du §39.2."""
    spark = poser_spark(db, "S1", "mail")
    pilote.created["mail"] = {"name": "mail", "devices": {"eth0": {"type": "nic"}}}
    ports.publish(db, pilote, spark, 2525, 25)
    ports.apply_devices(db, pilote, "mail", "S1")
    assert "pub-2525" in pilote.created["mail"]["devices"]

    ports.withdraw(db, 2525)
    ports.apply_devices(db, pilote, "mail", "S1")
    assert "pub-2525" not in pilote.created["mail"]["devices"]


def test_les_devices_ETRANGERS_ne_sont_jamais_touches(db, pilote):
    """Remplacer la carte réseau ou le disque racine détruirait l'instance."""
    spark = poser_spark(db, "S1", "mail")
    pilote.created["mail"] = {"name": "mail", "devices": {
        "eth0": {"type": "nic", "network": "sparkbr0"},
        "root": {"type": "disk", "pool": "spark"}}}
    ports.publish(db, pilote, spark, 2525, 25)
    ports.apply_devices(db, pilote, "mail", "S1")
    ports.withdraw(db, 2525)
    ports.apply_devices(db, pilote, "mail", "S1")

    devices = pilote.created["mail"]["devices"]
    assert devices["eth0"] == {"type": "nic", "network": "sparkbr0"}
    assert devices["root"] == {"type": "disk", "pool": "spark"}


def test_un_spark_SANS_adresse_ne_recoit_aucun_device(db, pilote):
    """On déclare avant de créer : le port reste au registre, mais rien ne peut
    le servir tant qu'il n'y a pas d'adresse (§18.2, transposé)."""
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "created_at,updated_at) VALUES ('S9','neuf','images:debian/13','shared',"
        "0.5,?,?,?,'x','x')", (GIO, 10_000_000, GIO))
    ports.publish(db, pilote, {"id": "S9", "name": "neuf"}, 2525, 25)
    assert ports.devices_for(db, "S9") == {}


def test_une_panne_du_pilote_remonte_AVEC_son_motif(db, pilote):
    """Un « 502 » anonyme ferait chercher la panne au mauvais endroit."""
    spark = poser_spark(db, "S1", "mail")
    pilote.created["mail"] = {"name": "mail", "devices": {}}
    ports.publish(db, pilote, spark, 2525, 25)
    pilote.fail_next["set_publication_devices"] = "pilote injoignable"
    with pytest.raises(ports.PortError, match="pilote injoignable"):
        ports.apply_devices(db, pilote, "mail", "S1")
    # La ligne RESTE au registre, et `applied_at` reste vide : l'écart se voit.
    assert ports.by_public_port(db, 2525)["applied_at"] is None


# --- lecture -----------------------------------------------------------------


def test_le_listing_porte_le_Spark_et_son_adresse(db, pilote):
    spark = poser_spark(db, "S1", "mail")
    ports.publish(db, pilote, spark, 2525, 25, note="SMTP entrant")
    ligne = ports.listing(db)[0]
    assert ligne["spark_name"] == "mail"
    assert ligne["ipv4_address"] == "10.77.0.16"
    assert ligne["note"] == "SMTP entrant"
    assert ligne["protocol"] == "tcp"


def test_le_journal_porte_la_publication_et_le_retrait(db, pilote):
    spark = poser_spark(db, "S1", "mail")
    ports.publish(db, pilote, spark, 2525, 25)
    ports.withdraw(db, 2525)
    actions = [r["action"] for r in db.execute(
        "SELECT action FROM audit_log ORDER BY id")]
    assert "port.publish" in actions and "port.withdraw" in actions
