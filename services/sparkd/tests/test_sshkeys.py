"""@verifies docs/BACKLOG.md#SPK-11 · docs/DAT.md §17 · docs/SCHEMA.md §7

Le point qui compte : « authorized_keys » est REGENERE depuis l'etat voulu, pas
complete. Un mecanisme qui ajoute ne retire jamais, et la DoD exige de prouver
qu'un retrait refuse l'acces.
"""

from __future__ import annotations

import pytest

from sparkd import migrations, sshkeys
from sparkd.db import connect

# Cle publique reelle du poste d'administration.
CLE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fSF4BkF"
       "EV5LL5Sl2XoT contact@p2enjoy.studio")
# Seconde cle REELLE, produite par ssh-keygen : une cle inventee ne passerait
# pas le controle de coherence entre le type annonce et le corps — ce qui est
# precisement le role de ce controle.
AUTRE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDgbvnxmxNR44ykrI0UZeEb8zVwN40SHYqVn3JLz+L5v ci".strip()
GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "k.db")
    migrations.upgrade(connection)
    connection.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "created_at,updated_at) VALUES ('S1','crm','images:debian/13','shared',0.5,"
        "?,10000000,?,'x','x')", (GIO, GIO))
    yield connection
    connection.close()


# --- analyse et empreinte ---------------------------------------------------

def test_empreinte_identique_a_ssh_keygen():
    """docs/DAT.md §17.2 — sinon il faudrait traduire mentalement a chaque fois."""
    cle = sshkeys.parse(CLE)
    assert cle.fingerprint.startswith("SHA256:")
    assert "=" not in cle.fingerprint          # base64 sans remplissage
    assert cle.key_type == "ssh-ed25519"
    assert cle.comment == "contact@p2enjoy.studio"


def test_une_cle_privee_est_refusee_explicitement():
    """docs/SCHEMA.md §7 — et le message dit quoi fournir a la place."""
    with pytest.raises(sshkeys.SshKeyError, match="PRIVÉE"):
        sshkeys.parse("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----")


@pytest.mark.parametrize("texte,motif", [
    ("", "vide"),
    ("n'importe quoi", "Format"),
    ("ssh-dss AAAAB3Nz", "non accepté"),
    ("ssh-ed25519 pas-du-base64!!", "Format"),
])
def test_clefs_invalides_refusees(texte, motif):
    with pytest.raises(sshkeys.SshKeyError, match=motif):
        sshkeys.parse(texte)


def test_le_corps_doit_correspondre_au_type_annonce():
    """Une cle ed25519 annoncee comme rsa serait acceptee sans ce controle."""
    corps = sshkeys.parse(CLE).body
    with pytest.raises(sshkeys.SshKeyError, match="ne correspond pas"):
        sshkeys.parse(f"ssh-rsa {corps}")


def test_espaces_superflus_tolerés():
    assert sshkeys.parse("  ssh-ed25519   " + sshkeys.parse(CLE).body + "  ").key_type == "ssh-ed25519"


# --- enregistrement ---------------------------------------------------------

def test_enregistrement(db):
    cle = sshkeys.register(db, "poste", CLE)
    assert cle["label"] == "poste"
    assert cle["fingerprint"].startswith("SHA256:")


def test_libelle_obligatoire(db):
    with pytest.raises(sshkeys.SshKeyError, match="libellé"):
        sshkeys.register(db, "  ", CLE)


def test_libelle_en_double_refuse(db):
    sshkeys.register(db, "poste", CLE)
    with pytest.raises(sshkeys.SshKeyError, match="existe déjà"):
        sshkeys.register(db, "poste", AUTRE)


def test_meme_cle_sous_un_autre_nom_refusee(db):
    """Sinon on croirait avoir retire un acces en n'en retirant qu'un alias."""
    sshkeys.register(db, "poste", CLE)
    with pytest.raises(sshkeys.SshKeyError, match="déjà enregistrée"):
        sshkeys.register(db, "autre-nom", CLE)


def test_le_corps_de_la_cle_n_entre_pas_au_journal(db):
    """docs/DAT.md §17.2 — un journal n'a pas a repeter la cle."""
    cle = sshkeys.register(db, "poste", CLE)
    ligne = db.execute("SELECT * FROM audit_log ORDER BY id DESC").fetchone()
    assert cle["fingerprint"] in ligne["message"]
    assert sshkeys.parse(CLE).body not in ligne["message"]
    assert sshkeys.parse(CLE).body not in (ligne["payload"] or "")


# --- fichier authorized_keys ------------------------------------------------

def test_fichier_vide_quand_aucune_cle(db):
    contenu = sshkeys.authorized_keys_content(db, "S1")
    assert "ssh-ed25519" not in contenu
    assert "régénéré" in contenu   # l'avertissement reste


def test_le_fichier_contient_la_cle_accordee(db):
    sshkeys.register(db, "poste", CLE)
    sshkeys.grant(db, "S1", "poste")
    contenu = sshkeys.authorized_keys_content(db, "S1")
    assert sshkeys.parse(CLE).line in contenu
    assert "# poste — SHA256:" in contenu


def test_la_revocation_RETIRE_du_fichier(db):
    """Le coeur de l'unite : regenerer, pas completer."""
    sshkeys.register(db, "poste", CLE)
    sshkeys.grant(db, "S1", "poste")
    assert "ssh-ed25519" in sshkeys.authorized_keys_content(db, "S1")
    sshkeys.revoke(db, "S1", "poste")
    assert "ssh-ed25519" not in sshkeys.authorized_keys_content(db, "S1")


def test_oublier_une_cle_la_retire_de_tous_les_sparks(db):
    sshkeys.register(db, "poste", CLE)
    sshkeys.grant(db, "S1", "poste")
    concernes = sshkeys.forget(db, "poste")
    assert concernes == ["crm"]
    assert "ssh-ed25519" not in sshkeys.authorized_keys_content(db, "S1")


def test_le_fichier_avertit_qu_il_est_regenere(db):
    """Une modification manuelle sera ecrasee : il faut le dire dans le fichier."""
    assert "écrasée" in sshkeys.authorized_keys_content(db, "S1")


def test_deux_cles_ordonnees_par_libelle(db):
    sshkeys.register(db, "b-poste", CLE)
    sshkeys.register(db, "a-ci", AUTRE)
    sshkeys.grant(db, "S1", "b-poste")
    sshkeys.grant(db, "S1", "a-ci")
    contenu = sshkeys.authorized_keys_content(db, "S1")
    assert contenu.index("a-ci") < contenu.index("b-poste")


def test_accorder_deux_fois_est_sans_effet(db):
    sshkeys.register(db, "poste", CLE)
    sshkeys.grant(db, "S1", "poste")
    sshkeys.grant(db, "S1", "poste")
    assert sshkeys.authorized_keys_content(db, "S1").count("ssh-ed25519") == 1


def test_empreinte_concordante_avec_ssh_keygen(tmp_path):
    """L'empreinte affichee doit etre celle que l'exploitant verra ailleurs."""
    import shutil, subprocess
    if not shutil.which("ssh-keygen"):
        pytest.skip("ssh-keygen absent")
    chemin = tmp_path / "k"
    subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "t",
                    "-f", str(chemin), "-q"], check=True)
    pub = (tmp_path / "k.pub").read_text()
    attendue = subprocess.run(["ssh-keygen", "-lf", str(tmp_path / "k.pub")],
                              capture_output=True, text=True).stdout.split()[1]
    assert sshkeys.parse(pub).fingerprint == attendue
