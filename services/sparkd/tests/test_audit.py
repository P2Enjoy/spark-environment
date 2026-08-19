"""@verifies docs/BACKLOG.md#SPK-15 · docs/DAT.md §21 · docs/SCHEMA.md §9

La Definition of Done demande UNE chose : prouver qu'aucune cle ni secret
n'atteint le journal. Le test decisif n'est pas celui du filtre pris isolement —
c'est celui qui exerce l'API reelle avec des secrets et FOUILLE ensuite toute la
table.
"""

from __future__ import annotations

import pytest

from sparkd import audit, migrations
from sparkd.db import connect

CLE_PRIVEE = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----"
CLE_PUBLIQUE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3f"
                "SF4BkFEV5LL5Sl2XoT poste")


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "a.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


# --- un seul chemin d'ecriture (§21.1) --------------------------------------

def test_aucun_module_n_ecrit_directement_dans_audit_log():
    """Un filtre pose a cinq endroits sera oublie au sixieme."""
    from pathlib import Path
    source = Path(__file__).resolve().parent.parent / "src" / "sparkd"
    coupables = [
        f.name for f in source.glob("*.py")
        if f.name != "audit.py" and "INSERT INTO audit_log" in f.read_text()
    ]
    assert coupables == []


# --- caviardage par nom de champ (§21.3) ------------------------------------

@pytest.mark.parametrize("champ", [
    "password", "db_password", "secret", "client_secret", "token", "api_key",
    "apiKey", "credential", "authorization", "passphrase", "private_key",
    "public_key", "key",
])
def test_les_champs_sensibles_sont_caviardes(champ):
    assert audit.redact({champ: "valeur-en-clair"})[champ] == audit.REDACTED


@pytest.mark.parametrize("champ", ["label", "domain", "name", "spark_id", "port", "monkey"])
def test_les_champs_anodins_sont_conserves(champ):
    """Caviarder tout ne serait pas un journal."""
    assert audit.redact({champ: "valeur"})[champ] == "valeur"


def test_on_caviarde_sans_supprimer():
    """docs/DAT.md §21.2 — savoir qu'un secret a transite compte."""
    filtre = audit.redact({"label": "poste", "public_key": CLE_PUBLIQUE})
    assert "public_key" in filtre                 # la cle reste visible
    assert filtre["public_key"] == audit.REDACTED
    assert filtre["label"] == "poste"


# --- caviardage par forme de valeur (§21.3) ---------------------------------

def test_une_cle_privee_sous_un_nom_anodin_est_attrapee():
    """Le second filet : un nom anodin ne doit pas suffire a passer."""
    assert audit.redact({"note": CLE_PRIVEE})["note"] == audit.REDACTED


def test_une_cle_publique_sous_un_nom_anodin_est_attrapee():
    assert audit.redact({"commentaire": CLE_PUBLIQUE})["commentaire"] == audit.REDACTED


def test_un_en_tete_authorization_est_attrape():
    assert audit.redact({"trace": "Authorization: Bearer abc123"})["trace"] == audit.REDACTED


# --- recursion --------------------------------------------------------------

def test_le_filtre_descend_dans_les_structures():
    charge = {"spark": {"config": {"db_password": "s3cr3t"}, "name": "crm"},
              "cles": [{"private_key": "x"}, {"label": "ok"}]}
    filtre = audit.redact(charge)
    assert filtre["spark"]["config"]["db_password"] == audit.REDACTED
    assert filtre["spark"]["name"] == "crm"
    assert filtre["cles"][0]["private_key"] == audit.REDACTED
    assert filtre["cles"][1]["label"] == "ok"


def test_une_structure_trop_profonde_est_tronquee():
    charge = valeur = {}
    for _ in range(20):
        valeur["suite"] = {}
        valeur = valeur["suite"]
    assert audit.TRUNCATED in str(audit.redact(charge))


# --- bornage (§21.4) --------------------------------------------------------

def test_un_payload_enorme_est_tronque_en_le_disant():
    """Tronquer en silence ferait croire a une trace complete."""
    import json
    texte = audit.prepare_payload({"config": {"routes": ["x" * 100] * 200}})
    rendu = json.loads(texte)
    assert rendu["truncated"] is True
    assert rendu["original_bytes"] > audit.MAX_PAYLOAD_BYTES


def test_un_payload_normal_n_est_pas_touche():
    import json
    assert json.loads(audit.prepare_payload({"a": 1})) == {"a": 1}


# --- ecriture ---------------------------------------------------------------

def test_le_message_aussi_passe_par_le_filtre(db):
    """Un message est compose a la main, donc susceptible d'interpoler."""
    audit.record(db, "resp", "test", "ok", f"clé reçue : {CLE_PRIVEE}")
    ligne = db.execute("SELECT * FROM audit_log").fetchone()
    assert "BEGIN OPENSSH" not in ligne["message"]


def test_un_resultat_inconnu_est_refuse(db):
    with pytest.raises(ValueError, match="inconnu"):
        audit.record(db, "resp", "test", "peut-etre", "x")


def test_listing_le_plus_recent_d_abord(db):
    for i in range(3):
        audit.record(db, "resp", f"a{i}", "ok", f"m{i}")
    assert [l["action"] for l in audit.listing(db)] == ["a2", "a1", "a0"]


def test_listing_filtrable(db):
    audit.record(db, "resp", "spark.create", "ok", "x")
    audit.record(db, "resp", "spark.delete", "denied", "y")
    assert len(audit.listing(db, result="denied")) == 1
    assert len(audit.listing(db, action="spark.")) == 2
