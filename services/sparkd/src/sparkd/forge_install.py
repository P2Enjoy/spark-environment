"""Exécuteur fermé et idempotent d'installation d'une Forge distante.

@spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.3-§50.6 ·
      docs/PROD_MIGRATIONS.md

Le navigateur ne fournit jamais une commande. Il fournit le plan versionné du
§50.4 ; ce module revalide chaque valeur et chaque invariant sur la Forge avant
d'écrire. Sa sortie est exclusivement une suite d'événements JSON bornés.
"""

from __future__ import annotations

import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import __version__
from . import install as package_install
from .preflight import INCUS_MINIMUM, verifier


GIB = 1024**3
NAME = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
PHASES = ("access", "dependencies", "storage", "foundation", "control", "verification")
ZABBLY_FINGERPRINT = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD"
ZABBLY_KEY = "https://pkgs.zabbly.com/key.asc"


class ForgeInstallationError(RuntimeError):
    """Le plan ou l'état réel interdit de poursuivre."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Events:
    def __init__(self, output: Callable[[str], None] = print):
        self.output = output

    def emit(self, phase: str, status: str, message: str,
             result: object | None = None) -> None:
        event: dict[str, object] = {
            "date": _now(), "phase": phase, "status": status, "message": message,
        }
        if result is not None:
            event["result"] = result
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        if self.output is print:
            print(line, flush=True)
        else:
            self.output(line)


def _run(command: list[str], *, timeout: int = 120, input_text: str | None = None,
         check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, input=input_text, capture_output=True,
                                text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        raise ForgeInstallationError(f"commande système impossible : {command[0]}") from error
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        suffix = f" — {detail[-1][:240]}" if detail else ""
        raise ForgeInstallationError(f"{command[0]} a refusé l'opération{suffix}")
    return result


def _number(value: object, label: str, *, zero: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ForgeInstallationError(f"{label} doit être un nombre")
    number = float(value)
    if not math.isfinite(number) or number < 0 or (not zero and number == 0):
        raise ForgeInstallationError(f"{label} doit être {'positif ou nul' if zero else 'positif'}")
    return number


def _name(value: object, label: str) -> str:
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise ForgeInstallationError(f"{label} est invalide")
    return value


def _memory_total() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) * 1024
    raise ForgeInstallationError("la mémoire totale n'a pas pu être relue")


def _architecture(value: str) -> str:
    aliases = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}
    return aliases.get(value.lower(), value.lower())


def validate_envelope(envelope: object) -> dict[str, Any]:
    if not isinstance(envelope, dict) or set(envelope) - {"plan", "confirmation"}:
        raise ForgeInstallationError("l'enveloppe d'installation est invalide")
    plan = envelope.get("plan")
    if not isinstance(plan, dict) or plan.get("version") != 1:
        raise ForgeInstallationError("seul le plan d'installation version 1 est accepté")
    if set(plan) != {"version", "system", "storage", "config", "phases"}:
        raise ForgeInstallationError("le contrat du plan version 1 n'est pas respecté")
    system = plan.get("system")
    storage = plan.get("storage")
    config = plan.get("config")
    phases = plan.get("phases")
    if not isinstance(system, dict) or not isinstance(storage, dict) or not isinstance(config, dict):
        raise ForgeInstallationError("le plan est incomplet")
    if set(system) != {"os", "architecture"}:
        raise ForgeInstallationError("le contrat système du plan est invalide")
    if set(config) != {"poolName", "bridgeName", "cpuReserve", "memoryReserveGib",
                      "arcMaxGib", "reservedPorts"}:
        raise ForgeInstallationError("le contrat de configuration du plan est invalide")
    if (not isinstance(phases, list) or any(
            not isinstance(phase, dict) or set(phase) != {"id", "label", "status"}
            for phase in phases) or [phase["id"] for phase in phases] != list(PHASES)):
        raise ForgeInstallationError("la liste fermée des phases est invalide")

    pool = _name(config.get("poolName"), "le nom du pool")
    bridge = _name(config.get("bridgeName"), "le nom du bridge")
    cpu_reserve = _number(config.get("cpuReserve"), "la réserve CPU", zero=True)
    memory_reserve = _number(config.get("memoryReserveGib"), "la réserve mémoire", zero=True)
    arc_max = _number(config.get("arcMaxGib"), "le plafond ARC")
    ports = config.get("reservedPorts")
    if not isinstance(ports, list) or any(
            isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535
            for port in ports):
        raise ForgeInstallationError("la liste des ports réservés est invalide")
    if len(set(ports)) != len(ports):
        raise ForgeInstallationError("la liste des ports réservés contient un doublon")
    if (memory_reserve + arc_max) * GIB >= _memory_total():
        raise ForgeInstallationError("la réserve et l'ARC ne laissent aucune mémoire aux Sparks")

    if storage.get("poolName") != pool or storage.get("driver") != "zfs":
        raise ForgeInstallationError("le stockage ne correspond pas à la configuration")
    kind = storage.get("kind")
    confirmation = envelope.get("confirmation")
    if kind == "reuse":
        if set(storage) != {"kind", "poolName", "driver", "destructive"} or storage.get("destructive") is not False:
            raise ForgeInstallationError("le contrat de réutilisation est invalide")
        if confirmation not in (None, ""):
            raise ForgeInstallationError("une réutilisation ne demande aucune confirmation destructive")
    elif kind == "adopt":
        # §50.3 : le zpool existe, Incus l'ignore. Le declarer — et l'importer
        # d'abord s'il ne l'est pas — n'ecrit sur aucune donnee, donc n'exige
        # aucune confirmation destructive. C'est l'etat d'une machine dont l'OS
        # a ete reinstalle en conservant ses disques.
        if set(storage) != {"kind", "poolName", "driver", "zpool", "imported", "destructive"}:
            raise ForgeInstallationError("le contrat d'adoption est invalide")
        if storage.get("destructive") is not False:
            raise ForgeInstallationError("une adoption n'est jamais destructive")
        if not isinstance(storage.get("imported"), bool):
            raise ForgeInstallationError("l'état d'importation du zpool est invalide")
        _name(storage.get("zpool"), "le nom du zpool")
        if confirmation not in (None, ""):
            raise ForgeInstallationError("une adoption ne demande aucune confirmation destructive")
    elif kind == "native":
        if set(storage) != {"kind", "poolName", "driver", "devices", "destructive"}:
            raise ForgeInstallationError("le contrat du miroir natif est invalide")
        devices = storage.get("devices")
        if (not isinstance(devices, list) or len(devices) != 2 or len(set(devices)) != 2
                or any(not isinstance(d, str) or not re.fullmatch(r"/dev/[A-Za-z0-9._+-]+", d)
                       for d in devices) or storage.get("destructive") is not True):
            raise ForgeInstallationError("les deux périphériques natifs sont invalides")
        if confirmation != "EFFACER " + " ".join(devices):
            raise ForgeInstallationError("la confirmation ne répète pas les deux périphériques effacés")
    else:
        # §8.5 revise : il n'y a plus de pool sur fichier. Un plan qui en
        # demanderait un vient d'une console anterieure a la decision du
        # 2026-09-02 ; le refuser vaut mieux que de creer une disposition que le
        # produit ne prend plus en charge.
        raise ForgeInstallationError(
            "la disposition de stockage est inconnue : seuls la reutilisation, "
            "l'adoption d'un zpool existant et le miroir natif sont acceptes")

    expected_os = str(system.get("os") or "").lower()
    os_release = Path("/etc/os-release").read_text(encoding="utf-8").lower()
    if "ubuntu" not in os_release or (expected_os and "ubuntu" not in expected_os):
        raise ForgeInstallationError("le système relu n'est pas l'Ubuntu du diagnostic")
    expected_arch = str(system.get("architecture") or "")
    if not expected_arch or _architecture(expected_arch) != _architecture(platform.machine()):
        raise ForgeInstallationError("l'architecture a changé depuis le diagnostic")
    if os.geteuid() != 0:
        raise ForgeInstallationError("l'installation doit être exécutée en root")
    return plan


def _incus_version() -> tuple[int, int] | None:
    result = _run(["incus", "--version"], check=False)
    match = re.search(r"(\d+)\.(\d+)", result.stdout)
    return tuple(map(int, match.groups())) if result.returncode == 0 and match else None


def phase_dependencies() -> dict[str, object]:
    required = ("incus", "zfs", "python3", "caddy", "nft")
    missing = [binary for binary in required if shutil.which(binary) is None]
    if not missing and (_incus_version() or (0, 0)) >= INCUS_MINIMUM:
        return {"changed": False, "incus": ".".join(map(str, _incus_version() or ())) }

    _run(["apt-get", "update"], timeout=900)
    _run(["apt-get", "install", "-y", "ca-certificates", "curl", "gnupg"], timeout=900)
    key = Path("/etc/apt/keyrings/zabbly.asc")
    key.parent.mkdir(parents=True, exist_ok=True)
    try:
        payload = urllib.request.urlopen(ZABBLY_KEY, timeout=30).read()
    except (urllib.error.URLError, TimeoutError) as error:
        raise ForgeInstallationError("la clé du dépôt Incus est injoignable") from error
    temporary = key.with_name(".zabbly.asc.tmp")
    temporary.write_bytes(payload)
    fingerprints = _run(["gpg", "--show-keys", "--with-colons", str(temporary)]).stdout
    found = {line.split(":")[9] for line in fingerprints.splitlines() if line.startswith("fpr:")}
    if ZABBLY_FINGERPRINT not in found:
        temporary.unlink(missing_ok=True)
        raise ForgeInstallationError("l'empreinte de la clé du dépôt Incus est inattendue")
    temporary.replace(key)
    release: dict[str, str] = {}
    for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            release[k] = v.strip('"')
    source = Path("/etc/apt/sources.list.d/zabbly-incus-stable.sources")
    _atomic_write(source, "\n".join((
        "Enabled: yes", "Types: deb", "URIs: https://pkgs.zabbly.com/incus/stable",
        f"Suites: {release.get('VERSION_CODENAME', '')}", "Components: main",
        f"Architectures: {_run(['dpkg', '--print-architecture']).stdout.strip()}",
        "Signed-By: /etc/apt/keyrings/zabbly.asc", "")), 0o644)
    _run(["apt-get", "update"], timeout=900)
    _run(["apt-get", "install", "-y", "incus", "zfsutils-linux", "python3", "python3-venv",
          "python3-pip", "caddy", "nftables", "curl"], timeout=1800)
    version = _incus_version()
    if version is None or version < INCUS_MINIMUM:
        raise ForgeInstallationError("Incus reste plus ancien que 6.19 après installation")
    return {"changed": True, "incus": ".".join(map(str, version))}


def _atomic_write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(mode)
    temporary.replace(path)


def _atomic_write_if_changed(path: Path, content: str, mode: int) -> bool:
    try:
        if path.read_text(encoding="utf-8") == content and (path.stat().st_mode & 0o777) == mode:
            return False
    except OSError:
        pass
    _atomic_write(path, content, mode)
    return True


def _zpool_importe(nom: str) -> bool:
    """Le zpool est-il DEJA importe ? `zpool list` ne voit que ceux qui le sont."""
    resultat = _run(["zpool", "list", "-H", "-o", "name"], check=False)
    if resultat.returncode:
        return False
    return nom in resultat.stdout.split()


def _zpools_importables() -> set[str]:
    """`zpool import` SANS argument ne fait que lister : il n'importe rien."""
    resultat = _run(["zpool", "import"], check=False, timeout=300)
    if resultat.returncode:
        return set()
    return {
        ligne.split(":", 1)[1].strip()
        for ligne in resultat.stdout.splitlines()
        if ligne.strip().startswith("pool:")
    }


def _pool_driver(pool: str) -> str | None:
    result = _run(["incus", "storage", "show", pool], check=False)
    if result.returncode:
        return None
    match = re.search(r"^driver:\s*(\S+)", result.stdout, re.MULTILINE)
    return match.group(1) if match else ""


def phase_storage(plan: dict[str, Any]) -> dict[str, object]:
    storage = plan["storage"]
    pool = storage["poolName"]
    existing = _pool_driver(pool)
    changed = False
    if existing is not None:
        if existing != "zfs":
            raise ForgeInstallationError(f"le pool « {pool} » existe avec un pilote autre que ZFS")
    elif storage["kind"] == "reuse":
        raise ForgeInstallationError(f"le pool ZFS « {pool} » à réutiliser n'existe plus")
    elif storage["kind"] == "adopt":
        # Le zpool est relu ICI, pas repris du plan : entre le diagnostic et
        # l'ecriture, il a pu etre importe par ailleurs.
        zpool = storage["zpool"]
        if not _zpool_importe(zpool):
            if zpool not in _zpools_importables():
                raise ForgeInstallationError(
                    f"le zpool « {zpool} » n'est ni importé ni importable")
            _run(["zpool", "import", zpool], timeout=900)
            if not _zpool_importe(zpool):
                raise ForgeInstallationError(f"l'importation du zpool « {zpool} » a échoué")
        _run(["incus", "storage", "create", pool, "zfs", f"source={zpool}"], timeout=900)
        changed = True
    else:
        devices = storage["devices"]
        for device in devices:
            if not Path(device).is_block_device():
                raise ForgeInstallationError(f"le périphérique {device} n'est plus un disque bloc")
            signatures = _run(["wipefs", "--noheadings", "--output", "TYPE", device], check=False)
            if signatures.returncode or signatures.stdout.strip():
                raise ForgeInstallationError(f"le périphérique {device} n'est plus vide")
        _run(["zpool", "create", "-f", pool, "mirror", *devices], timeout=900)
        _run(["incus", "storage", "create", pool, "zfs", f"source={pool}"], timeout=900)
        changed = True

    compression = _run(["zfs", "get", "-H", "-o", "value", "compression", pool],
                       check=False).stdout.strip()
    if compression in {"", "off", "-"}:
        _run(["zfs", "set", "compression=on", pool])
        changed = True
    arc = int(float(plan["config"]["arcMaxGib"]) * GIB)
    zfs_config = Path("/etc/modprobe.d/zfs.conf")
    lines = zfs_config.read_text(encoding="utf-8").splitlines() if zfs_config.exists() else []
    rendered: list[str] = []
    found_arc = False
    for line in lines:
        if re.match(r"^\s*options\s+zfs(?:\s|$)", line):
            tokens = line.split()
            options = [token for token in tokens[2:] if not token.startswith("zfs_arc_max=")]
            if not found_arc:
                options.append(f"zfs_arc_max={arc}")
                found_arc = True
            rendered.append(" ".join(["options", "zfs", *options]))
        else:
            rendered.append(line)
    if not found_arc:
        rendered.append(f"options zfs zfs_arc_max={arc}")
    changed = _atomic_write_if_changed(
        zfs_config, "\n".join(rendered) + "\n", 0o644) or changed
    arc_runtime = Path("/sys/module/zfs/parameters/zfs_arc_max")
    if arc_runtime.read_text(encoding="utf-8").strip() != str(arc):
        arc_runtime.write_text(f"{arc}\n", encoding="utf-8")
        changed = True
    return {"changed": changed, "pool": pool, "arcMaxBytes": arc}


def _network_exists(name: str) -> bool:
    return _run(["incus", "network", "show", name], check=False).returncode == 0


def _ensure_device(profile: str, device: str, kind: str,
                   properties: dict[str, str]) -> bool:
    shown = _run(["incus", "profile", "device", "show", profile]).stdout
    if re.search(rf"^{re.escape(device)}:\s*$", shown, re.MULTILINE):
        changed = False
        for key, value in properties.items():
            current = _run(
                ["incus", "profile", "device", "get", profile, device, key],
                check=False,
            ).stdout.strip()
            if current != value:
                _run(["incus", "profile", "device", "set", profile, device, key, value])
                changed = True
        return changed
    else:
        arguments = ["incus", "profile", "device", "add", profile, device, kind]
        arguments.extend(f"{key}={value}" for key, value in properties.items())
        _run(arguments)
        return True


def phase_foundation(plan: dict[str, Any]) -> dict[str, object]:
    bridge = plan["config"]["bridgeName"]
    pool = plan["config"]["poolName"]
    created = not _network_exists(bridge)
    if created:
        _run(["incus", "network", "create", bridge, "ipv4.address=10.77.0.1/24",
              "ipv4.nat=true", "ipv4.dhcp.ranges=10.77.0.240-10.77.0.254",
              "ipv6.address=none"])
    else:
        for key, value in (("ipv4.address", "10.77.0.1/24"), ("ipv4.nat", "true"),
                           ("ipv4.dhcp.ranges", "10.77.0.240-10.77.0.254")):
            current = _run(["incus", "network", "get", bridge, key],
                           check=False).stdout.strip()
            if current != value:
                _run(["incus", "network", "set", bridge, key, value])
                created = True
    if _run(["incus", "profile", "show", "default"], check=False).returncode:
        _run(["incus", "profile", "create", "default"])
        created = True
    created = _ensure_device(
        "default", "root", "disk", {"path": "/", "pool": pool}) or created
    created = _ensure_device(
        "default", "eth0", "nic", {"network": bridge}) or created
    caddy_enabled = _run(
        ["systemctl", "is-enabled", "--quiet", "caddy"], check=False).returncode == 0
    caddy_active = _run(
        ["systemctl", "is-active", "--quiet", "caddy"], check=False).returncode == 0
    if not caddy_enabled or not caddy_active:
        _run(["systemctl", "enable", "--now", "caddy"])
        created = True

    policy = _run(["incus", "network", "get", bridge, "user.spark.input_policy"],
                  check=False).stdout.strip().lower()
    if policy not in {"drop", "reject"}:
        rules = f"""table inet spark_filter {{
  chain input {{
    type filter hook input priority 10; policy accept;
    iifname \"{bridge}\" ct state established,related accept
    iifname \"{bridge}\" udp dport {{ 53, 67 }} accept
    iifname \"{bridge}\" tcp dport 53 accept
    iifname \"{bridge}\" ip protocol icmp accept
    iifname \"{bridge}\" ip6 nexthdr ipv6-icmp accept
    iifname \"{bridge}\" drop
  }}
}}
"""
        _atomic_write(Path("/etc/sparkd/firewall.nft"), rules, 0o644)
        unit = """[Unit]
Description=Filtrage du bridge privé Spark
After=incus.service
Before=sparkd.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet spark_filter
ExecStart=/usr/sbin/nft -f /etc/sparkd/firewall.nft
ExecReload=/usr/sbin/nft -f /etc/sparkd/firewall.nft

[Install]
WantedBy=multi-user.target
"""
        _atomic_write(Path("/etc/systemd/system/spark-firewall.service"), unit, 0o644)
        _run(["systemctl", "daemon-reload"])
        _run(["systemctl", "enable", "--now", "spark-firewall.service"])
        _run(["incus", "network", "set", bridge, "user.spark.input_policy=drop"])

    ssh_changed = _atomic_write_if_changed(
        Path("/etc/ssh/sshd_config.d/90-spark.conf"), "X11Forwarding no\n", 0o644)
    if ssh_changed:
        _run(["sshd", "-t"])
        ssh_unit = "ssh.service" if _run(
            ["systemctl", "cat", "ssh.service"], check=False).returncode == 0 else "sshd.service"
        _run(["systemctl", "reload", ssh_unit])
    return {
        "changed": created or policy not in {"drop", "reject"} or ssh_changed,
        "bridge": bridge,
    }


def _merge_environment(updates: dict[str, str]) -> bool:
    path = Path("/etc/sparkd/sparkd.env")
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(updates)
    seen: set[str] = set()
    rendered: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else ""
        if key in updates:
            if key not in seen:
                rendered.append(f"{key}={updates[key]}")
                seen.add(key)
            pending.pop(key, None)
        else:
            rendered.append(line)
    rendered.extend(f"{key}={value}" for key, value in sorted(pending.items()))
    return _atomic_write_if_changed(path, "\n".join(rendered) + "\n", 0o640)


def phase_control(plan: dict[str, Any]) -> dict[str, object]:
    config = plan["config"]
    extra_ports = sorted(set(config["reservedPorts"]) - {22, 80, 443})
    environment_changed = _merge_environment({
        "SPARKD_STORAGE_POOL": config["poolName"],
        "SPARKD_STORAGE_DATASET": config["poolName"],
        "SPARKD_NETWORK_BRIDGE": config["bridgeName"],
        "SPARKD_MEMORY_RESERVE": f"{float(config['memoryReserveGib']):g}GiB",
        "SPARKD_CPU_RESERVE": f"{float(config['cpuReserve']):g}",
        "SPARKD_RESERVED_PORTS": ",".join(map(str, extra_ports)),
    })
    paths = package_install.Paths.installed()
    units_match = all(
        (paths.systemd / name).exists()
        and (paths.systemd / name).read_text(encoding="utf-8")
        == package_install._render_unit(name, paths.python)
        for name in package_install.UNIT_NAMES
    )
    active = _run(
        ["systemctl", "is-active", "--quiet", "sparkd"], check=False).returncode == 0
    try:
        running_version = _json_request("/healthz").get("version") if active else None
    except ForgeInstallationError:
        running_version = None
    if not environment_changed and units_match and active and running_version == __version__:
        return {"changed": False, "version": __version__,
                "environment": "/etc/sparkd/sparkd.env"}
    try:
        package_install.install(
            paths=paths,
            runner=lambda command: _run(command), preflight=lambda: 0,
            announce=lambda _phase, _state: None,
        )
    except package_install.InstallationError as error:
        raise ForgeInstallationError(str(error)) from error
    return {"changed": True, "version": __version__,
            "environment": "/etc/sparkd/sparkd.env"}


def _json_request(path: str, method: str = "GET") -> dict[str, object]:
    request = urllib.request.Request(f"http://127.0.0.1:9876{path}", method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise ForgeInstallationError(f"{path} ne répond pas avec un JSON valide") from error
    if not isinstance(payload, dict):
        raise ForgeInstallationError(f"{path} ne rend pas un objet JSON")
    return payload


def phase_verification(plan: dict[str, Any]) -> dict[str, object]:
    names = {
        "SPARKD_STORAGE_POOL": plan["config"]["poolName"],
        "SPARKD_STORAGE_DATASET": plan["config"]["poolName"],
        "SPARKD_NETWORK_BRIDGE": plan["config"]["bridgeName"],
    }
    previous = {key: os.environ.get(key) for key in names}
    os.environ.update(names)
    try:
        verdicts = verifier()
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    blocking = [verdict.code for verdict in verdicts if verdict.bloquant]
    if blocking:
        raise ForgeInstallationError("le préflight reste rouge : " + ", ".join(blocking))
    health = _json_request("/healthz")
    if health.get("status") != "ok":
        raise ForgeInstallationError("healthz ne rend pas le statut ok")
    ready = _json_request("/readyz")
    if ready.get("status") != "ready":
        raise ForgeInstallationError("readyz ne rend pas le statut ready")
    topology = _json_request("/v1/forge/sync", "POST")
    return {
        "preflight": {"checks": len(verdicts), "blocking": blocking},
        "healthz": health, "readyz": ready, "topology": topology,
        "packageVersion": __version__,
    }


def execute(envelope: object, events: Events | None = None) -> None:
    events = events or Events()
    current = "access"
    try:
        events.emit(current, "running", "Relecture du plan et de la Forge")
        plan = validate_envelope(envelope)
        events.emit(current, "done", "Plan version 1 et Forge concordants",
                    {"architecture": _architecture(platform.machine())})
        steps = (
            ("dependencies", lambda: phase_dependencies(), "Dépendances conformes"),
            ("storage", lambda: phase_storage(plan), "Stockage et plafond ARC conformes"),
            ("foundation", lambda: phase_foundation(plan), "Socle réseau et durcissement conformes"),
            ("control", lambda: phase_control(plan), "Plan de contrôle installé"),
            ("verification", lambda: phase_verification(plan), "Recette finale réussie"),
        )
        for current, action, message in steps:
            events.emit(current, "running", message.replace(" conformes", " : vérification"))
            result = action()
            events.emit(current, "done", message, result)
    except ForgeInstallationError as error:
        events.emit(current, "failed", str(error))
        raise
    except Exception as error:  # noqa: BLE001 — arrêt structuré, jamais traceback vers la console
        events.emit(current, "failed", f"échec système pendant la phase {current}")
        raise ForgeInstallationError(f"échec système pendant la phase {current}") from error


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        Events().emit("access", "failed", "cet exécuteur n'accepte aucun argument")
        return 2
    try:
        envelope = json.load(sys.stdin)
        execute(envelope)
    except (ValueError, ForgeInstallationError):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
