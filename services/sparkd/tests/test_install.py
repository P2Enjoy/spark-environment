"""Preuves de l'installateur distribué avec le paquet sparkd."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from sparkd import cgroup, install


def paths(tmp_path: Path) -> install.Paths:
    python = tmp_path / "opt" / "sparkd" / "venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.touch()
    return install.Paths(prefix=python.parent.parent.parent,
                         state=tmp_path / "state",
                         systemd=tmp_path / "systemd", python=python)


def test_les_unites_sont_lues_depuis_le_paquet():
    """@verifies docs/BACKLOG.md#SPK-66

    Sans ces ressources, un ``pip install git+…`` réussirait mais ne pourrait
    jamais rendre le service persistant : ce serait une installation à moitié.
    """
    service = install.packaged_unit("sparkd.service")
    slice_ = install.packaged_unit("spark.slice")
    assert "@SPARKD_PYTHON@ -m sparkd" in service
    assert "CPUWeight=1" in slice_


def test_la_tranche_DELEGUE_ses_controleurs_par_Delegate():
    """@verifies docs/BACKLOG.md#SPK-71 · docs/DAT.md §32.4 ter

    MESURÉ le 2026-09-01 sur la Forge réinstallée : sans cette ligne, le
    `cgroup.subtree_control` de la tranche reste VIDE, les limites d'Incus ne
    s'appliquent pas dedans, et la réservation redevient proportionnelle en
    silence. `RUN-SLICE` rougit et `cloud-init` échoue en fin d'installation.

    Les trois contrôleurs de `cgroup.REQUIRED_CONTROLLERS` doivent y être : ce
    sont ceux sans lesquels le quota n'est pas applique.
    """
    slice_ = install.packaged_unit("spark.slice")
    ligne = [l for l in slice_.splitlines() if l.startswith("Delegate=")]
    assert len(ligne) == 1, "une seule directive Delegate=, sinon la derniere gagne"
    delegues = ligne[0].split("=", 1)[1].split()
    for controleur in cgroup.REQUIRED_CONTROLLERS:
        assert controleur in delegues, f"{controleur} doit etre delegue a la tranche"
    assert "io" in delegues and "pids" in delegues


def test_la_tranche_ne_s_appuie_plus_sur_un_Accounting_retire():
    """@verifies docs/BACKLOG.md#SPK-71 · docs/DAT.md §32.4 ter

    `CPUAccounting=` a été RETIRÉ de systemd 259, qui le journalise et l'ignore.
    Les deux autres n'ont jamais peuplé le `subtree_control` de la tranche —
    un `…Accounting=` active le contrôleur chez le PARENT. Les garder
    entretiendrait la croyance qui a produit le défaut, donc on prouve leur
    absence plutôt que de la constater un jour de panne.
    """
    slice_ = install.packaged_unit("spark.slice")
    directives = [l.split("=", 1)[0] for l in slice_.splitlines()
                  if l and not l.startswith("#") and "=" in l]
    for retiree in ("CPUAccounting", "MemoryAccounting", "IOAccounting"):
        assert retiree not in directives, f"{retiree}= ne delegue rien a la tranche"


def test_le_chemin_du_venv_n_est_pas_resolu_vers_le_python_systeme(monkeypatch):
    """@verifies docs/BACKLOG.md#SPK-66

    Les venvs Ubuntu lient souvent `bin/python` vers `/usr/bin/python3`. Le
    résoudre est un défaut de disponibilité : l'unité perd alors le paquet.
    """
    monkeypatch.setattr(install.sys, "executable", "/opt/sparkd/venv/bin/python")
    cible = install.Paths.installed()
    assert cible.python == Path("/opt/sparkd/venv/bin/python")
    assert cible.prefix == Path("/opt/sparkd")


def test_l_installateur_pose_les_unites_du_paquet_et_le_commit(monkeypatch, tmp_path):
    cible = paths(tmp_path)
    commandes: list[list[str]] = []
    jalons: list[tuple[str, str]] = []
    monkeypatch.setattr(install, "commit_du_paquet", lambda: "abc123def456")
    monkeypatch.setattr(install, "__version__", "0.post1.dev1+gabc123def456")

    install.install(cible, runner=commandes.append, healthcheck=lambda: True,
                    preflight=lambda: 0, uid=0, sleep=lambda _: None,
                    announce=lambda phase, state: jalons.append((phase, state)))

    service = (cible.systemd / "sparkd.service").read_text(encoding="utf-8")
    assert f"ExecStart={cible.python} -m sparkd" in service
    assert (cible.systemd / "spark.slice").is_file()
    assert commandes == [
        ["systemctl", "daemon-reload"],
        ["systemctl", "start", "spark.slice"],
        ["systemctl", "enable", "sparkd"],
        ["systemctl", "restart", "sparkd"],
    ]
    build = json.loads(cible.build.read_text(encoding="utf-8"))
    assert build["commit"] == "abc123def456"
    assert build["installed_from"] == "paquet sparkd 0.post1.dev1+gabc123def456"
    assert jalons == [
        ("units", "in_progress"), ("units", "done"),
        ("daemon_reload", "in_progress"), ("daemon_reload", "done"),
        ("restart", "in_progress"), ("restart", "done"),
        ("healthz", "in_progress"), ("healthz", "done"),
        ("preflight", "in_progress"), ("preflight", "done"),
    ]


def test_no_start_ne_fait_pas_passer_une_forge_incomplete_pour_prete(tmp_path):
    cible = paths(tmp_path)
    commandes: list[list[str]] = []
    called = False

    def preflight() -> int:
        nonlocal called
        called = True
        return 1

    install.install(cible, runner=commandes.append, healthcheck=lambda: False,
                    preflight=preflight, uid=0, sleep=lambda _: None, start=False)
    assert commandes == [["systemctl", "daemon-reload"], ["systemctl", "start", "spark.slice"]]
    assert called is False


def test_un_echec_de_preflight_empeche_le_faux_succes(tmp_path):
    with pytest.raises(install.InstallationError, match="préflight rouge"):
        install.install(paths(tmp_path), runner=lambda _: None, healthcheck=lambda: True,
                        preflight=lambda: 1, uid=0, sleep=lambda _: None)


def test_l_installateur_refuse_de_s_executer_sans_root(tmp_path):
    with pytest.raises(install.InstallationError, match="root"):
        install.install(paths(tmp_path), uid=1000)


def test_build_n_a_pas_besoin_d_une_variable_de_commit(monkeypatch, tmp_path):
    cible = paths(tmp_path)
    monkeypatch.setattr(install, "commit_du_paquet", lambda: "0123456789ab")
    monkeypatch.setattr(install, "__version__", "0.post1.dev1+g0123456789ab")
    install.write_build(cible, now=lambda: datetime(2026, 8, 21, tzinfo=timezone.utc))
    assert json.loads(cible.build.read_text(encoding="utf-8")) == {
        "commit": "0123456789ab",
        "dirty": False,
        "installed_at": "2026-08-21T00:00:00+00:00",
        "installed_from": "paquet sparkd 0.post1.dev1+g0123456789ab",
    }
