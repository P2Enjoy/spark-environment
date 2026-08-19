"""@verifies docs/BACKLOG.md#SPK-34 · docs/DAT.md §35.1, §35.2, §35.3, §35.4,
             §35.5 · docs/SCHEMA.md §4.1

Ce que ces tests protegent, c'est la promesse du §35.1 : la protection arrete le
geste ACCIDENTEL. Elle est donc appliquee cote runtime, pas dans l'interface —
sinon elle ne protegerait pas du cas le plus frequent, le script.
"""

from __future__ import annotations

import json

import pytest

from sparkd import migrations, protection
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "spark.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO forge (id, hostname, cpu_threads_total, cpu_cores_total,"
        " memory_total_bytes, storage_total_bytes, network_total_bps)"
        " VALUES (1, 'h', 8, 4, ?, ?, 1000000000)", (94 * GIO, 5 * GIO * 1024))
    yield connection
    connection.close()


def poser(db, nom="crm"):
    db.execute(
        "INSERT INTO spark (id, name, state, image, cpu_mode, cpu_reservation,"
        " memory_reservation_bytes, network_reservation_bps, storage_bytes,"
        " created_at, updated_at) VALUES (?, ?, 'stopped', 'images:debian/13',"
        " 'shared', 0.5, ?, 10000000, ?, '2026-08-19', '2026-08-19')",
        (f"S-{nom}", nom, GIO, 10 * GIO))
    return nom


# --- armer et lever ---------------------------------------------------------

def test_un_spark_naît_non_protege(db):
    """La migration n'arme RIEN retroactivement (docs/SCHEMA.md §4.1)."""
    nom = poser(db)
    assert protection.is_protected(db, nom) is False
    assert protection.status(db, nom)["protected_at"] is None


def test_armer_puis_lever_avec_le_meme_mot_de_passe(db):
    nom = poser(db)
    etat = protection.arm(db, nom, "correct horse")
    assert etat["protected"] is True and etat["protected_at"] is not None
    assert protection.is_protected(db, nom) is True

    protection.disarm(db, nom, "correct horse")
    assert protection.is_protected(db, nom) is False


def test_le_mot_de_passe_n_est_jamais_stocke_en_clair(db):
    """§35.3. Le registre garde une empreinte, un sel PAR SPARK, et les
    parametres de cout A COTE d'elle."""
    nom = poser(db)
    protection.arm(db, nom, "correct horse")
    ligne = db.execute("SELECT * FROM spark WHERE name = ?", (nom,)).fetchone()

    for colonne in ("protection_hash", "protection_salt", "protection_params"):
        assert "correct horse" not in str(ligne[colonne])
    assert len(ligne["protection_salt"]) == 32, "16 octets de sel"
    params = json.loads(ligne["protection_params"])
    assert set(params) == {"n", "r", "p", "dklen"}
    # Le contenu ENTIER de la ligne ne doit pas porter le secret.
    assert "correct horse" not in " ".join(str(v) for v in ligne)


def test_le_sel_est_tire_PAR_SPARK(db):
    """Un sel commun rendrait deux Sparks au meme mot de passe reconnaissables a
    leur empreinte identique (docs/SCHEMA.md §4.1)."""
    a, b = poser(db, "un"), poser(db, "deux")
    protection.arm(db, a, "meme secret")
    protection.arm(db, b, "meme secret")
    lignes = {r["name"]: r for r in db.execute("SELECT * FROM spark")}
    assert lignes[a]["protection_salt"] != lignes[b]["protection_salt"]
    assert lignes[a]["protection_hash"] != lignes[b]["protection_hash"]


def test_un_mot_de_passe_errone_laisse_la_protection_ARMEE(db):
    nom = poser(db)
    protection.arm(db, nom, "le bon")
    with pytest.raises(protection.BadProtectionPassword):
        protection.disarm(db, nom, "le mauvais")
    assert protection.is_protected(db, nom) is True, "un echec ne desarme rien"


def test_lever_un_spark_non_protege_est_refuse(db):
    nom = poser(db)
    with pytest.raises(protection.BadProtectionPassword):
        protection.disarm(db, nom, "peu importe")


def test_armer_deux_fois_est_refuse(db):
    nom = poser(db)
    protection.arm(db, nom, "un")
    with pytest.raises(protection.ProtectionError):
        protection.arm(db, nom, "deux")


def test_rearmer_accepte_un_AUTRE_mot_de_passe(db):
    """§35.4 : le produit ne retient pas l'ancien pour le proposer."""
    nom = poser(db)
    protection.arm(db, nom, "premier")
    protection.disarm(db, nom, "premier")
    protection.arm(db, nom, "second")
    with pytest.raises(protection.BadProtectionPassword):
        protection.disarm(db, nom, "premier")
    protection.disarm(db, nom, "second")
    assert protection.is_protected(db, nom) is False


def test_armer_sans_mot_de_passe_est_refuse(db):
    nom = poser(db)
    with pytest.raises(protection.BadProtectionPassword):
        protection.arm(db, nom, "")
    assert protection.is_protected(db, nom) is False


def test_lever_reste_un_ETAT_et_non_une_fenetre_de_temps(db):
    """§35.4 : desarmer est durable. Rien ne rearme tout seul — ni une relecture,
    ni une reconnexion. Le contraire rendrait le produit dependant de l'heure."""
    nom = poser(db)
    protection.arm(db, nom, "x")
    protection.disarm(db, nom, "x")
    for _ in range(5):
        assert protection.is_protected(db, nom) is False


# --- la barriere (§35.2) ----------------------------------------------------

@pytest.mark.parametrize("geste", sorted(protection.GESTES))
def test_toute_ecriture_visant_un_spark_protege_est_refusee(db, geste):
    """La regle est volontairement ENTIERE. Une liste partielle obligerait a
    justifier chaque cas et produirait les surprises que l'interrupteur supprime."""
    nom = poser(db)
    protection.ensure_writable(db, nom, geste)      # desarme : rien ne bloque
    protection.arm(db, nom, "x")
    with pytest.raises(protection.SparkProtected) as refus:
        protection.ensure_writable(db, nom, geste)
    # Le refus NOMME le Spark et le geste (§35.5).
    assert nom in str(refus.value)
    assert protection.GESTES[geste] in str(refus.value)


def test_la_protection_d_un_spark_n_atteint_pas_les_autres(db):
    protege, libre = poser(db, "protege"), poser(db, "libre")
    protection.arm(db, protege, "x")
    protection.ensure_writable(db, libre, "command")
    with pytest.raises(protection.SparkProtected):
        protection.ensure_writable(db, protege, "command")


def test_les_sparks_proteges_se_NOMMENT(db):
    """C'est ce que la revocation d'une cle doit annoncer avant d'aboutir (§35.2)."""
    a, b, c = poser(db, "alpha"), poser(db, "beta"), poser(db, "gamma")
    assert protection.protected_names(db) == []
    protection.arm(db, c, "x")
    protection.arm(db, a, "x")
    assert protection.protected_names(db) == ["alpha", "gamma"], "triés, nommés"


# --- le journal (§21, §35.3) ------------------------------------------------

def _journal(db):
    return [dict(r) for r in db.execute("SELECT * FROM audit_log ORDER BY id")]


def test_aucun_mot_de_passe_n_atteint_le_journal(db):
    """§35.3 : le journal enregistre la TENTATIVE, son resultat et sa date,
    jamais sa valeur."""
    nom = poser(db)
    protection.arm(db, nom, "correct horse battery")
    with pytest.raises(protection.BadProtectionPassword):
        protection.disarm(db, nom, "tentative ratee")
    protection.disarm(db, nom, "correct horse battery")

    entier = json.dumps(_journal(db), ensure_ascii=False)
    assert "correct horse battery" not in entier
    assert "tentative ratee" not in entier


def test_les_deux_transitions_et_les_echecs_sont_journalises(db):
    """§35.4 : les deux transitions portent leur acteur et leur date."""
    nom = poser(db)
    protection.arm(db, nom, "x", actor="responsable")
    with pytest.raises(protection.BadProtectionPassword):
        protection.disarm(db, nom, "faux")
    protection.disarm(db, nom, "x")

    lignes = _journal(db)
    assert [(l["action"], l["result"]) for l in lignes] == [
        ("spark.protect", "ok"),
        ("spark.unprotect", "denied"),
        ("spark.unprotect", "ok"),
    ]
    assert all(l["actor"] and l["ts"] for l in lignes)


def test_il_n_y_a_PAS_de_verrouillage_apres_N_echecs(db):
    """§35.3 : un compte a rebours ne generait que le responsable legitime.
    C'est la trace qui a de la valeur, pas l'entrave."""
    nom = poser(db)
    protection.arm(db, nom, "bon")
    for _ in range(10):
        with pytest.raises(protection.BadProtectionPassword):
            protection.disarm(db, nom, "faux")
    protection.disarm(db, nom, "bon")     # le bon mot de passe passe TOUJOURS
    assert protection.is_protected(db, nom) is False
    denies = [l for l in _journal(db) if l["result"] == "denied"]
    assert len(denies) == 10, "chaque tentative laisse sa trace"
