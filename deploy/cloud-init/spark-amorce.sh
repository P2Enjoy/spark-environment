#!/bin/sh
# Amorce d'une Forge, jouee par cloud-init au premier demarrage.
#
# @spec docs/BACKLOG.md#SPK-73, docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4-§50.6
#       (l'executeur ferme), §8.2 (la paire dediee livree par le schema JSON),
#       §3.1 (Incus >= 6.19) · README.md (schema de partitionnement, rejeu de
#       l'amorce) · docs/AGENT_RUNBOOK.md §A
#
# La machine est livree avec le schema de partitionnement du README : sda5 et
# sdb5 sont nues, le zpool est cree par le geste paramétré ou deja present.
# Ce script n'en FORMATE aucun : il adopte ce qu'il trouve.
#
# IDEMPOTENT, et c'est un contrat, pas un effet de bord (SPK-73). Un second
# passage remet d'aplomb ce qui a derive et NE REINITIALISE PAS les Sparks :
#   - le pool est adopte, jamais recree (`kind: reuse`, `destructive: false`) ;
#   - `sparkd.install` ne touche jamais /var/lib/sparkd/spark.db ;
#   - les migrations de schema sont additives.
# Le rejeu passe par ce script — `sudo /opt/spark-amorce.sh` — et JAMAIS par
# cloud-init : `runcmd` ne s'execute qu'une fois par instance, et
# `cloud-init clean` effacerait l'etat et les journaux de la premiere pose.
set -eu
POOL=spark            # nom du zpool livre par le schema
BRIDGE=sparkbr0       # bridge prive des Sparks
ARC_GIB=16            # plafond ARC ZFS, soustrait de la memoire allouable
MEM_RESERVE_GIB=2     # reserve memoire de la Forge, hors ARC
CPU_RESERVE=0.5       # coeurs que la Forge garde pour elle
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git python3-venv

# Incus >= 6.19 : depot amont Zabbly, empreinte verifiee AVANT toute confiance.
# Le paquet de la distribution est trop ancien pour l'imbrication (docs/DAT.md
# §3.1) : sous Incus 6.0.0, aucun conteneur Docker ne demarre dans un Spark.
curl -fsSL https://pkgs.zabbly.com/key.asc -o /run/zabbly.asc
gpg --show-keys --with-colons /run/zabbly.asc | grep '^fpr:' \
  | grep -q '4EFC590696CB15B87C73A3AD82CC8797C838DCFD'
install -D -m 0644 /run/zabbly.asc /etc/apt/keyrings/zabbly.asc
cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
apt-get update -q
apt-get install -y incus zfsutils-linux

# Le pool livre par l'hebergeur : l'importer si besoin, puis le confier a Incus.
# Aucune creation, aucun formatage — le pool s'adopte.
modprobe zfs
zpool list "$POOL" >/dev/null 2>&1 || zpool import -f "$POOL"
incus storage show "$POOL" >/dev/null 2>&1 \
  || incus storage create "$POOL" zfs "source=$POOL"

# Paquet sparkd, sans checkout du depot sur la Forge (runbook §A.2).
[ -x /opt/sparkd/venv/bin/python ] || python3 -m venv /opt/sparkd/venv
/opt/sparkd/venv/bin/pip install --upgrade \
  "git+https://github.com/P2Enjoy/spark-environment.git@main#subdirectory=services/sparkd"

# L'executeur du produit joue le reste, a l'identique de la console : Caddy,
# nftables, ARC, bridge, durcissement SSH, unites systemd, puis preflight,
# /healthz, /readyz et releve de topologie.
/opt/sparkd/venv/bin/python - "$POOL" "$BRIDGE" "$CPU_RESERVE" \
  "$MEM_RESERVE_GIB" "$ARC_GIB" <<'PY'
import json, platform, subprocess, sys
pool, bridge, cpu, mem, arc = sys.argv[1:6]
plan = {
    "version": 1,
    "system": {"os": "ubuntu", "architecture": platform.machine()},
    "storage": {"kind": "reuse", "poolName": pool, "driver": "zfs",
                "destructive": False},
    "config": {"poolName": pool, "bridgeName": bridge,
               "cpuReserve": float(cpu), "memoryReserveGib": float(mem),
               "arcMaxGib": float(arc), "reservedPorts": [22, 80, 443]},
    "phases": [{"id": p, "label": p, "status": "pending"} for p in (
        "access", "dependencies", "storage", "foundation",
        "control", "verification")],
}
run = subprocess.run(
    [sys.executable, "-m", "sparkd.forge_install"],
    input=json.dumps({"plan": plan, "confirmation": ""}), text=True)
sys.exit(run.returncode)
PY
