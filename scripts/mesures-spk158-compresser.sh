#!/bin/sh
# Prouve que cloud-init DÉCODE le user-data compressé (`--compresser`) comme le
# user-data embarqué en clair : mêmes fichiers, octet pour octet, mêmes droits.
#
# @verifies docs/BACKLOG.md#SPK-158 · docs/DAT.md §66.9 (le cloud-init embarqué,
#           compressé gz+b64) · CLAUDE.md §15 (preuve par le vrai composant)
#
# Le seul écart entre `--embarquer` (joué sur la VM du banc, `make forge-vm`) et
# `--embarquer --compresser` est l'encodage `gz+b64` des fichiers déposés : c'est
# cloud-init qui les décode. Le VRAI cloud-init de la version visée (Ubuntu 26.04)
# est donc lancé dans un conteneur jetable, sur les deux sorties de la commande ;
# son module `write_files` dépose les scripts, puis on les compare.
#
# Usage : scripts/mesures-spk158-compresser.sh [--image IMAGE]
#   --image IMAGE  image Docker du système visé (défaut : ubuntu:26.04)
# Lecture seule pour le poste : rien n'est écrit hors d'un dossier temporaire.
set -eu

IMAGE=ubuntu:26.04
while [ $# -gt 0 ]; do
  case "$1" in
    --image) [ $# -ge 2 ] || { echo "--image attend une valeur" >&2; exit 2; }; IMAGE=$2; shift 2 ;;
    --help|-h) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "argument inconnu : $1 (voir --help)" >&2; exit 2 ;;
  esac
done

RACINE=$(cd "$(dirname "$0")/.." && pwd)
DOSSIER=$(mktemp -d)
trap 'rm -rf "$DOSSIER"' EXIT INT TERM

for mode in clair compresse; do
  [ "$mode" = compresse ] && extra=--compresser || extra=
  python3 "$RACINE/scripts/preparer-forge.py" cloud-init --embarquer $extra \
    --pool-source /dev/vdb,/dev/vdc > "$DOSSIER/user-data-$mode" 2>/dev/null
done
grep -q 'encoding: gz+b64' "$DOSSIER/user-data-compresse" \
  || { echo "ROUGE : le user-data compressé ne porte pas gz+b64" >&2; exit 1; }

docker run --rm --memory 1g -v "$DOSSIER:/seed:ro" "$IMAGE" sh -c '
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq cloud-init >/dev/null 2>&1
echo "cloud-init $(cloud-init --version 2>&1 | awk "{print \$2}")"
for mode in clair compresse; do
  rm -f /opt/spark-amorce.sh /opt/creer-pool.sh
  cloud-init schema --config-file /seed/user-data-$mode >/dev/null
  cloud-init single --name write_files --frequency always --file /seed/user-data-$mode >/dev/null 2>&1
  sh -n /opt/spark-amorce.sh       # #!/bin/sh
  bash -n /opt/creer-pool.sh       # #!/usr/bin/env bash
  /opt/spark-amorce.sh --help | grep -q -- --pool-source
  echo "$mode $(sha256sum /opt/spark-amorce.sh | cut -d" " -f1) $(stat -c %a /opt/spark-amorce.sh) $(sha256sum /opt/creer-pool.sh | cut -d" " -f1) $(stat -c %a /opt/creer-pool.sh)"
done' > "$DOSSIER/releve"

cat "$DOSSIER/releve"
clair=$(awk '$1 == "clair" { $1 = ""; print }' "$DOSSIER/releve")
compresse=$(awk '$1 == "compresse" { $1 = ""; print }' "$DOSSIER/releve")
if [ -n "$clair" ] && [ "$clair" = "$compresse" ]; then
  echo "VERT : cloud-init dépose les mêmes scripts, octet pour octet, droits compris"
else
  echo "ROUGE : les scripts déposés diffèrent entre les deux modes" >&2
  exit 1
fi
