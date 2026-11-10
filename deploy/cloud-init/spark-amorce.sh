#!/bin/sh
# Amorce d'une Forge, jouee par cloud-init au premier demarrage.
#
# @spec docs/BACKLOG.md#SPK-73, docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4-§50.6
#       (l'executeur ferme), §8.2 (la paire dediee livree par le schema JSON),
#       §3.1 (Incus >= 6.19) · README.md (schema de partitionnement, rejeu de
#       l'amorce) · docs/AGENT_RUNBOOK.md §A · docs/BACKLOG.md#SPK-135,
#       docs/DAT.md §5.3 bis (NET_MBIT : le debit declare) ·
#       docs/BACKLOG.md#SPK-157, docs/DAT.md §65.3 (les options IPv4 rejetees
#       des le premier demarrage : CVE-2026-98432) ·
#       docs/BACKLOG.md#SPK-159, docs/DAT.md §66.2 points 5 a 7, §66.4 (les
#       reglages en arguments nommes ; le pool cree sur demande explicite)
#
# La machine est livree avec le schema de partitionnement que produit
# `scripts/preparer-forge.py` : sda5 et sdb5 sont nues et AUCUN pool n'existe
# (DAT §66.1). Au premier demarrage, cloud-init donne --pool-source : l'amorce cree
# alors le pool, par /opt/creer-pool.sh, qui refuse tout support deja ecrit. Sans
# cet argument — le rejeu manuel —, elle n'a jamais cree et ne cree rien : elle
# adopte ce qu'elle trouve. Ce script ne FORMATE rien lui-meme.
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

# Conventions du produit, pas des proprietes de la machine : le registre attend le
# pool « spark » et l'adressage 10.77.0.1/24 de « sparkbr0 » (DAT §66.2 point 5).
POOL=spark
BRIDGE=sparkbr0
MEM_RESERVE_GIB=2     # reserve memoire de la Forge, hors ARC
CPU_RESERVE=0.5       # coeurs que la Forge garde pour elle

# Reglages d'installation : des ARGUMENTS NOMMES, lus dans la commande et dans
# --help, jamais une variable d'environnement ni un texte a editer (CLAUDE.md §3).
POOL_SOURCE=""        # --pool-source : vide, l'amorce ne cree aucun pool
ARC_GIB=16            # --arc-gib : plafond ARC ZFS, soustrait de la memoire allouable
NET_MBIT=""           # --net-mbit : vide, le debit est mesure (DAT §5.3 bis)

usage() {
  cat <<'USAGE'
Usage : spark-amorce.sh [--pool-source SUPPORT,SUPPORT] [--arc-gib N] [--net-mbit N]

  --pool-source A,B  les DEUX supports du miroir ZFS, un par disque,
                     ex. /dev/nvme0n1p5,/dev/nvme1n1p5.
                     Donne : si aucun pool « spark » ne peut etre importe, il est
                     cree par /opt/creer-pool.sh, qui refuse un support non vide.
                     Absent (le rejeu) : le pool est seulement adopte, jamais cree.
  --arc-gib N        plafond de l'ARC ZFS en Gio, retire de la memoire allouable
                     aux Sparks. Defaut 16, regle pour une machine de 94 Gio.
  --net-mbit N       debit du lien en Mbit/s, SEULEMENT si la carte n'en annonce
                     aucun (virtio). Absent : le debit est mesure.
  --help             affiche cette aide.
USAGE
}

# Un refus precede TOUTE ecriture : rien n'est lu ni pose avant que les arguments
# soient valides, et --help n'ecrit rien.
refuser() {
  echo "amorce: $1" >&2
  echo "amorce: voir --help." >&2
  exit 2
}
entier_positif() {
  case "$2" in ''|*[!0-9]*) refuser "$1 attend un entier, recu : « $2 »" ;; esac
  [ "$2" -ge 1 ] || refuser "$1 doit etre superieur ou egal a 1, recu : $2"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --pool-source|--arc-gib|--net-mbit)
      [ $# -ge 2 ] || refuser "$1 attend une valeur"
      case "$1" in
        --pool-source) POOL_SOURCE=$2 ;;
        --arc-gib)     entier_positif "$1" "$2"; ARC_GIB=$2 ;;
        --net-mbit)    entier_positif "$1" "$2"; NET_MBIT=$2 ;;
      esac
      shift 2 ;;
    *) refuser "argument inconnu : $1" ;;
  esac
done
# Deux supports, des chemins /dev, des caracteres surs : la valeur finit dans un
# appel de script lance en root. Le `case` ecarte d'abord tout caractere hors liste,
# SAUT DE LIGNE compris : `grep -q` reussit des qu'UNE ligne convient, donc une
# premiere ligne valide laisserait passer tout ce qui la suit.
if [ -n "$POOL_SOURCE" ]; then
  case "$POOL_SOURCE" in
    *[!A-Za-z0-9._/,-]*) source_sure=non ;;
    *) printf '%s' "$POOL_SOURCE" \
         | grep -Eq '^/dev/[A-Za-z0-9._/-]+(,/dev/[A-Za-z0-9._/-]+)+$' \
         && source_sure=oui || source_sure=non ;;
  esac
  [ "$source_sure" = oui ] \
    || refuser "--pool-source attend deux chemins /dev separes par une virgule, recu : « $POOL_SOURCE »"
fi

export DEBIAN_FRONTEND=noninteractive

# SPK-157 · docs/DAT.md §65.3 — AVANT toute ecriture et tout apt. CVE-2026-98432 : un SYN IPv4
# porteur d'options atteint un use-after-free du noyau que la Forge partage avec
# ses Sparks. La machine est exposee des son premier demarrage, et sparkd ne pose
# son pare-feu que plusieurs minutes plus tard. Ces tables sont CELLES de
# `sparkd.pare_feu.OPTIONS_IPV4`, mot pour mot (une preuve unitaire les tient
# ensemble) ; rien n'est ecrit sur le disque : le fichier de sparkd les remplace
# ensuite, table pour table. Sans nft — image sans nftables —, on le dit et on
# continue : sparkd installe et pose le pare-feu plus loin.
if command -v nft >/dev/null 2>&1; then
  nft -f - <<'NFT'
add table ip spark_ipopts
delete table ip spark_ipopts
table ip spark_ipopts {
  chain prerouting {
    type filter hook prerouting priority raw; policy accept;
    ip hdrlength > 5 ip protocol tcp counter drop
  }
}
add table bridge spark_ipopts
delete table bridge spark_ipopts
table bridge spark_ipopts {
  chain prerouting {
    type filter hook prerouting priority -300; policy accept;
    ether type ip ip hdrlength > 5 ip protocol tcp counter drop
  }
}
NFT
else
  echo "amorce: nft absent — options IPv4 non filtrees jusqu'au pare-feu de sparkd"
fi

# SPK-84 · docs/DAT.md §50.7.1 · runbook §C.5 — AVANT le premier apt.
#
# Le postinst de grub-pc derive la cible de grub-install en retirant les chiffres
# finaux de « grub-probe -t device /boot ». Sur un /boot en RAID, /dev/md0 devient
# /dev/md, qui n existe pas : le paquet reste en iF, dpkg devient incoherent, et
# TOUTE installation echoue ensuite — a commencer par l apt-get install juste en
# dessous, sous set -eu, qui designerait ca-certificates et jamais GRUB.
#
# Conditionnel et derive, et les deux comptent : sur une Forge EFI ou a disque
# simple on n ecrit RIEN — grub-pc n y est pas concerne, et repondre a sa place
# serait une regression. Les disques se lisent dans les membres du RAID, jamais
# en dur : une Forge en NVMe presente /dev/nvme0n1, et un /dev/sda fige la
# rendrait non amorcable.
preparer_grub_sur_raid() {
  [ -d /sys/firmware/efi ] && return 0                      # EFI : hors sujet
  dpkg-query -W -f='${Status}' grub-pc 2>/dev/null | grep -q "install ok" || return 0
  command -v grub-probe >/dev/null 2>&1 || return 0

  boot_dev=$(grub-probe -t device /boot/ 2>/dev/null) || return 0
  case "$boot_dev" in /dev/md*) ;; *) return 0 ;; esac      # pas de RAID : rien a faire

  md=$(basename "$(readlink -f "$boot_dev")")
  disques=""
  for membre in /sys/block/"$md"/slaves/*; do
    [ -e "$membre" ] || continue
    # La partition membre (sda3) appartient a un disque (sda) : c est le disque
    # qui porte l amorce, jamais la partition.
    parent=$(basename "$(dirname "$(readlink -f "$membre")")")
    [ -b "/dev/$parent" ] || continue
    # Identifiant STABLE : un /dev/sdX peut changer de nom d un demarrage a
    # l autre, et une reponse debconf survit aux redemarrages.
    lien=$(find /dev/disk/by-id -lname "*/$parent" 2>/dev/null \
             | grep -v -- "-part" | grep -- "-" | sort | head -1)
    [ -n "$lien" ] || lien="/dev/$parent"
    case " $disques " in *" $lien "*) ;; *) disques="$disques $lien" ;; esac
  done
  [ -n "$disques" ] || return 0

  # Les DEUX disques : c est ce qui fait que la machine demarre encore quand
  # l un lache, ce pour quoi le RAID1 est la.
  liste=$(echo "$disques" | sed -e "s/^ //" -e "s/ /, /g")
  echo "amorce: grub-pc installera sur : $liste"
  printf 'grub-pc grub-pc/install_devices multiselect %s\n' "$liste" | debconf-set-selections
  echo "SET grub-pc/cloud_style_installation false" | debconf-communicate >/dev/null
}
preparer_grub_sur_raid

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

# Le pool : l'adopter s'il existe, le creer SEULEMENT sur demande explicite, puis
# le confier a Incus (docs/DAT.md §66.2 point 6).
#
# --pool-source est absent d'un rejeu (`sudo /opt/spark-amorce.sh`) : une Forge en
# service ne peut donc pas voir cette amorce ecrire sur un disque. Donne, il ne sert
# qu'a une machine sans pool, et la creation passe par creer-pool.sh, qui REFUSE un
# support portant deja une signature — y compris celle d'un pool non importe.
modprobe zfs
pool_present() {
  zpool list "$POOL" >/dev/null 2>&1 || zpool import -f "$POOL" >/dev/null 2>&1
}
if ! pool_present; then
  if [ -z "$POOL_SOURCE" ]; then
    echo "amorce: aucun pool « $POOL » n'est present ni importable, et --pool-source" >&2
    echo "amorce: n'est pas donne : sans cette demande explicite, l'amorce ne cree rien." >&2
    echo "amorce: creez le pool (scripts/creer-pool.sh) puis rejouez, ou donnez --pool-source." >&2
    exit 1
  fi
  [ -x /opt/creer-pool.sh ] \
    || refuser "/opt/creer-pool.sh est absent : le cloud-init de preparer-forge.py le depose"
  echo "amorce: aucun pool « $POOL » : creation par creer-pool.sh sur $POOL_SOURCE"
  SPARK_POOL_NAME="$POOL" SPARK_POOL_SOURCE="$POOL_SOURCE" /opt/creer-pool.sh
fi
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
  "$MEM_RESERVE_GIB" "$ARC_GIB" "$NET_MBIT" <<'PY'
import json, platform, subprocess, sys
pool, bridge, cpu, mem, arc, net = sys.argv[1:7]
plan = {
    "version": 1,
    "system": {"os": "ubuntu", "architecture": platform.machine()},
    "storage": {"kind": "reuse", "poolName": pool, "driver": "zfs",
                "destructive": False},
    "config": {"poolName": pool, "bridgeName": bridge,
               "cpuReserve": float(cpu), "memoryReserveGib": float(mem),
               "arcMaxGib": float(arc), "reservedPorts": [22, 80, 443],
               # SPK-135 : seulement s'il est pose — la cle est facultative.
               **({"networkCapacityMbit": int(net)} if net else {})},
    "phases": [{"id": p, "label": p, "status": "pending"} for p in (
        "access", "dependencies", "storage", "foundation",
        "control", "verification")],
}
run = subprocess.run(
    [sys.executable, "-m", "sparkd.forge_install"],
    input=json.dumps({"plan": plan, "confirmation": ""}), text=True)
sys.exit(run.returncode)
PY
