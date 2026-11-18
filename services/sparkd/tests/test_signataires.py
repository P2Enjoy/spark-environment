"""Preuves de la pose des signataires autorisés par la console.

@verifies docs/BACKLOG.md#SPK-172 · docs/DAT.md §70.3 (la ligne posée,
          remplacée si la clé change, les autres gardées ; défaut de
          SPARKD_ALLOWED_SIGNERS) · §36.10.5 · §36.10.2 bis

Les clés sont produites par un VRAI `ssh-keygen`, et la dernière preuve fait
vérifier une signature par la Forge à travers le fichier posé : une ligne qui
aurait la bonne forme mais que `ssh-keygen -Y verify` ne lit pas serait rouge.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from sparkd import signataires, signature
from sparkd.config import DEFAULT_ALLOWED_SIGNERS, load
from sparkd.signataires import Refus, poser

pytestmark = pytest.mark.skipif(shutil.which("ssh-keygen") is None,
                                reason="ssh-keygen absent")


def _cle(dossier: Path, nom: str) -> str:
    subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", f"{nom}@poste",
                    "-f", str(dossier / nom)], capture_output=True, check=True)
    return (dossier / f"{nom}.pub").read_text("utf-8").strip()


def test_le_defaut_de_SPARKD_ALLOWED_SIGNERS_est_le_fichier_que_la_console_pose():
    assert DEFAULT_ALLOWED_SIGNERS == "/etc/sparkd/allowed_signers"
    assert load({"SPARKD_DRIVER": "fake"}).allowed_signers == DEFAULT_ALLOWED_SIGNERS
    # Une valeur posée l'emporte toujours.
    assert load({"SPARKD_DRIVER": "fake", "SPARKD_ALLOWED_SIGNERS": "/x"}).allowed_signers == "/x"


def test_la_premiere_pose_ecrit_la_ligne_sans_le_commentaire_de_la_cle(tmp_path):
    cle = _cle(tmp_path, "resp")
    fichier = tmp_path / "etc" / "allowed_signers"
    assert poser("console/spark-010", cle, fichier) == "pose"
    type_, b64 = cle.split()[:2]
    assert fichier.read_text() == f'console/spark-010 namespaces="spark-audit" {type_} {b64}\n'
    assert oct(fichier.stat().st_mode & 0o777) == "0o644"


def test_une_ligne_deja_juste_n_est_PAS_reecrite(tmp_path):
    cle = _cle(tmp_path, "resp")
    fichier = tmp_path / "allowed_signers"
    poser("console/spark-010", cle, fichier)
    avant = fichier.stat().st_mtime_ns
    assert poser("console/spark-010", cle, fichier) == "deja"
    assert fichier.stat().st_mtime_ns == avant


def test_une_cle_changee_REMPLACE_la_ligne_du_principal_et_garde_les_autres(tmp_path):
    ancienne, nouvelle, autre = (_cle(tmp_path, n) for n in ("a", "b", "c"))
    fichier = tmp_path / "allowed_signers"
    fichier.write_text("# posé à la main\n"
                       f'console/spark-experiment namespaces="spark-audit" {autre}\n'
                       f'console/spark-010 namespaces="spark-audit" {ancienne}\n')
    assert poser("console/spark-010", nouvelle, fichier) == "remplace"
    texte = fichier.read_text()
    assert "# posé à la main" in texte and "console/spark-experiment" in texte
    assert ancienne.split()[1] not in texte and nouvelle.split()[1] in texte
    assert texte.count("console/spark-010") == 1


@pytest.mark.parametrize("principal", [
    "spark-010", "console/", "console/Spark", "console/a b", "console/a,b",
    "console/a\nconsole/b", "humain/x"])
def test_un_principal_hors_forme_est_REFUSE(tmp_path, principal):
    with pytest.raises(Refus):
        poser(principal, _cle(tmp_path, "k"), tmp_path / "f")
    assert not (tmp_path / "f").exists()


@pytest.mark.parametrize("cle", [
    "", "AAAA", "ssh-ed25519", "ssh-dss AAAAB3", 'cert-authority ssh-ed25519 AAAA',
    "ssh-ed25519 AAAA;reboot", "ssh-ed25519 AAAA\nconsole/x ssh-ed25519 BBBB"])
def test_une_cle_hors_forme_est_REFUSEE(tmp_path, cle):
    with pytest.raises(Refus):
        poser("console/spark-010", cle, tmp_path / "f")


def test_la_ligne_posee_est_celle_que_la_Forge_VERIFIE(tmp_path):
    """Le contrat de bout en bout : la console signe, la Forge vérifie à travers
    le fichier posé, avec le principal du §36.10.2 bis."""
    _cle(tmp_path, "resp")
    fichier = tmp_path / "allowed_signers"
    poser("console/spark-010", (tmp_path / "resp.pub").read_text(), fichier)
    octets = b'{"action":"image.add"}'
    (tmp_path / "m").write_bytes(octets)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(tmp_path / "resp"),
                    "-n", signature.NAMESPACE, str(tmp_path / "m")],
                   capture_output=True, check=True)
    sig = (tmp_path / "m.sig").read_text()
    signature.verifier(octets, sig, "console/spark-010 key=SHA256:x", fichier)
    with pytest.raises(signature.SignatureError):
        signature.verifier(octets, sig, "console/autre", fichier)


def test_la_commande_rend_une_ligne_JSON_et_un_code(tmp_path, capsys):
    cle = _cle(tmp_path, "resp")
    fichier = tmp_path / "allowed_signers"
    assert signataires.main(["poser", "--principal", "console/spark-010",
                             "--cle", cle, "--fichier", str(fichier)]) == 0
    assert json.loads(capsys.readouterr().out)["etat"] == "pose"
    assert signataires.main(["poser", "--principal", "console/spark-010",
                             "--cle", "x", "--fichier", str(fichier)]) == 2
    assert json.loads(capsys.readouterr().out)["etat"] == "refus"
