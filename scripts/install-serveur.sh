#!/usr/bin/env bash
# Compatibilité pour une installation lancée DEPUIS un checkout local.
#
# @spec docs/BACKLOG.md#SPK-66 · docs/DAT.md §40.4
#
# Le chemin normal est désormais décrit dans docs/AGENT_RUNBOOK.md §A.2 : le
# paquet vient directement du dépôt public et aucun checkout ne reste sur la
# Forge. Ce petit relais conserve le geste local pour un développeur, mais ne
# porte plus les unités ni le code d'installation : c'est `sparkd.install`,
# emballé avec le paquet, qui en est l'unique source.
set -euo pipefail

PREFIX="${SPARKD_PREFIX:-/opt/sparkd}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-serveur.sh doit être lancé en root." >&2
  exit 2
fi

if [ ! -f "$SOURCE/services/sparkd/pyproject.toml" ]; then
  echo "checkout sparkd absent ; employer la procédure paquet du runbook A.2." >&2
  exit 2
fi

install -d -m 0755 "$PREFIX"
if [ ! -x "$PREFIX/venv/bin/python" ]; then
  python3 -m venv "$PREFIX/venv"
fi
"$PREFIX/venv/bin/pip" install --quiet --upgrade "$SOURCE/services/sparkd"
exec "$PREFIX/venv/bin/python" -m sparkd.install
