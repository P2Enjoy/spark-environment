"""@verifies docs/BACKLOG.md#SPK-155 · docs/DAT.md §18.3 (l'émetteur est déclaré :
Let's Encrypt, et lui seul), §18.2 (la forme de la configuration)

Constaté le 2026-10-11 sur la Forge : sans émetteur déclaré, Caddy 2.6.2 se
replie sur ZeroSSL, qui refuse chaque tentative (`caddy_legacy_user_removed`).
La configuration posée déclare donc UN émetteur ACME, sans autorité nommée — celle
par défaut de Caddy, Let's Encrypt en production. Le comportement sur le binaire
réel est mesuré par `scripts/mesures-spk155.sh`.
"""

from __future__ import annotations

import pytest

from sparkd import ingress, migrations
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "e.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def poser_spark(db, ident, nom, adresse="10.77.0.16"):
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "ipv4_address,created_at,updated_at) VALUES (?,?,?,'shared',0.5,?,?,?,?,'x','x')",
        (ident, nom, "images:debian/13", GIO, 10_000_000, GIO, adresse))


def _emetteurs(config: dict) -> list[dict]:
    politiques = config["apps"]["tls"]["automation"]["policies"]
    assert len(politiques) == 1, "une seule politique, pour tous les noms"
    assert "subjects" not in politiques[0], "elle vaut pour tout nom servi"
    return politiques[0]["issuers"]


def test_un_seul_emetteur_acme_sans_autorite_nommee(db):
    """Pas de ZeroSSL : un seul émetteur, ACME, à l'autorité par défaut — Let's
    Encrypt en production, sous la clé de stockage des certificats déjà émis."""
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    assert _emetteurs(ingress.build_config(db)) == [{"module": "acme"}]


def test_l_emetteur_est_declare_meme_sans_route(db):
    """Constant (§18.2) : il ne dépend d'aucune route, et une Forge neuve le porte
    dès sa première réconciliation."""
    assert _emetteurs(ingress.build_config(db)) == [{"module": "acme"}]


def test_la_reconciliation_pose_l_emetteur(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    faux = ingress.FakeCaddy()
    ingress.reconcile(db, faux)
    assert _emetteurs(faux.config) == [{"module": "acme"}]


def test_le_retrait_d_une_route_garde_l_emetteur(db):
    """La configuration posée AVANT de retirer (§18.8) est une configuration
    complète : elle ne doit pas rendre ZeroSSL aux autres routes."""
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    ingress.declare(db, "S1", "autre.example.com", 8080)
    faux = ingress.FakeCaddy()
    ingress.retirer(db, faux, "crm.example.com")
    assert _emetteurs(faux.config) == [{"module": "acme"}]


def test_le_preflight_attend_l_emetteur(tmp_path):
    """ING-CONCORDE compare la configuration vivante à celle du registre, à
    l'égalité stricte (§51.5) : l'attendue doit porter l'émetteur, sans quoi une
    Forge à jour serait déclarée non conforme."""
    from sparkd import preflight

    chemin = tmp_path / "p.db"
    connexion = connect(chemin)
    migrations.upgrade(connexion)
    connexion.close()
    attendue = preflight._configuration_attendue_locale(str(chemin))
    assert _emetteurs(attendue) == [{"module": "acme"}]
