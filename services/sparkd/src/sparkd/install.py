"""Installation autonome du paquet ``sparkd`` sur une Forge.

@spec docs/BACKLOG.md#SPK-66 · docs/DAT.md §40.4 ·
      docs/PROD_MIGRATIONS.md#OP-04

Le dépôt n'est volontairement pas une entrée de ce module. Une Forge reçoit le
paquet Python directement depuis la source publique ; les migrations et les
unités systemd sont des données de ce paquet. Les chemins d'installation ne
dépendent donc ni d'un ``git clone`` ni d'un ``rsync`` laissé sur l'hôte.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from typing import Callable

from . import __version__
from .build import commit_du_paquet


DEFAULT_STATE = Path("/var/lib/sparkd")
DEFAULT_SYSTEMD = Path("/etc/systemd/system")
UNIT_NAMES = ("spark.slice", "sparkd.service")


class InstallationError(RuntimeError):
    """L'installation s'arrête avec une cause actionnable."""


@dataclass(frozen=True)
class Paths:
    """Les seuls fichiers que l'installateur peut écrire.

    ``python`` est l'interpréteur qui vient de charger CE paquet. L'unité est
    rendue avec ce chemin précis, afin qu'une mise à jour ne puisse pas laisser
    systemd démarrer un venv différent de celui qu'elle vient de modifier.
    """

    prefix: Path
    state: Path
    systemd: Path
    python: Path

    @classmethod
    def installed(cls) -> "Paths":
        # Le binaire d'un venv est couramment un lien vers le Python système.
        # Le résoudre rendrait l'unité avec `/usr/bin/python…`, qui ne connaît
        # pas les dépendances du paquet que ce venv vient justement d'installer.
        # On conserve donc le chemin ABSOLU d'invocation, sans suivre le lien.
        python = Path(sys.executable).absolute()
        return cls(prefix=python.parent.parent.parent, state=DEFAULT_STATE,
                   systemd=DEFAULT_SYSTEMD, python=python)

    @property
    def build(self) -> Path:
        return self.prefix / "build.json"


Runner = Callable[[list[str]], None]
Healthcheck = Callable[[], bool]
Preflight = Callable[[], int]


def _run(command: list[str]) -> None:
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        joined = " ".join(command)
        raise InstallationError(f"commande échouée : {joined} ({error})") from error


def _healthz() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:9876/healthz", timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False


def _preflight() -> int:
    from .preflight import main

    return main([])


def packaged_unit(name: str) -> str:
    """Lit une unité DEPUIS le paquet installé, jamais depuis le dépôt."""
    if name not in UNIT_NAMES:
        raise ValueError(f"unité inconnue : {name}")
    return files("sparkd").joinpath("systemd", name).read_text(encoding="utf-8")


def _render_unit(name: str, python: Path) -> str:
    value = str(python)
    if not python.is_absolute() or "\n" in value:
        raise InstallationError("interpréteur du paquet invalide")
    content = packaged_unit(name)
    if name == "sparkd.service":
        directive = "ExecStart=@SPARKD_PYTHON@ -m sparkd"
        if content.count(directive) != 1:
            raise InstallationError("gabarit sparkd.service invalide")
        # Le marqueur peut être cité dans le commentaire explicatif de l'unité :
        # seule la directive systemd est une interpolation, jamais le commentaire.
        content = content.replace(directive, f"ExecStart={value} -m sparkd")
    return content


def _write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(mode)
    temporary.replace(path)


def write_build(paths: Paths, *, now: Callable[[], datetime] =
                lambda: datetime.now(timezone.utc)) -> None:
    """Écrit seulement ce que les métadonnées ne peuvent pas porter.

    Le commit ne vient plus d'une variable d'environnement : il est tiré de la
    version construite du paquet. ``build.json`` conserve la date et la source
    d'installation, utiles à l'exploitation, sans pouvoir faire mentir le
    paquet (``build.identity`` donne toujours priorité aux métadonnées).
    """
    payload = {
        "commit": commit_du_paquet(),
        "dirty": False,
        "installed_at": now().isoformat(timespec="seconds"),
        "installed_from": f"paquet sparkd {__version__}",
    }
    _write(paths.build, json.dumps(payload, ensure_ascii=False, indent=2) + "\n", 0o644)


def install(paths: Paths | None = None, *, runner: Runner = _run,
            healthcheck: Healthcheck = _healthz, preflight: Preflight = _preflight,
            uid: int | None = None, sleep: Callable[[float], None] = time.sleep,
            start: bool = True) -> None:
    """Pose les unités du paquet et démarre la build nouvellement installée.

    ``--no-start`` sert seulement à préparer une Forge dont les dépendances ne
    sont pas encore en place : SPK-68 posera Incus, le pool, le bridge et Caddy
    avant d'appeler la forme normale. Le comportement par défaut reste complet
    et équivaut à l'ancien script d'installation.
    """
    if (os.geteuid() if uid is None else uid) != 0:
        raise InstallationError("sparkd-install doit être lancé en root")
    paths = paths or Paths.installed()
    if not paths.python.is_absolute():
        raise InstallationError("interpréteur du paquet invalide")

    paths.prefix.mkdir(parents=True, exist_ok=True)
    paths.state.mkdir(parents=True, exist_ok=True)
    paths.state.chmod(0o750)
    write_build(paths)
    for name in UNIT_NAMES:
        _write(paths.systemd / name, _render_unit(name, paths.python), 0o644)

    runner(["systemctl", "daemon-reload"])
    runner(["systemctl", "start", "spark.slice"])

    # systemd ne délègue pas ces contrôleurs à une tranche vide. L'absence de la
    # possibilité d'écrire (conteneur de test, ancien noyau) reste visible au
    # préflight, qui est précisément chargé de le signaler.
    try:
        (Path("/sys/fs/cgroup/spark.slice") / "cgroup.subtree_control").write_text(
            "+cpu +cpuset +memory +io +pids\n", encoding="utf-8")
    except OSError:
        pass

    if not start:
        return

    runner(["systemctl", "enable", "sparkd"])
    runner(["systemctl", "restart", "sparkd"])
    for _ in range(20):
        if healthcheck():
            break
        sleep(1)
    else:
        raise InstallationError("sparkd ne répond pas sur 127.0.0.1:9876/healthz")

    if preflight() != 0:
        raise InstallationError("préflight rouge après installation")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Installe les unités du paquet sparkd")
    parser.add_argument("--no-start", action="store_true",
                        help="pose les unités sans démarrer le service")
    args = parser.parse_args(argv)
    try:
        install(start=not args.no_start)
    except InstallationError as error:
        print(f"sparkd-install : {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
