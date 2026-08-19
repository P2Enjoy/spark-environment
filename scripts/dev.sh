#!/usr/bin/env bash
# Pile de developpement : sparkd (pilote factice) + hote console.
#
# @spec docs/BACKLOG.md#SPK-23 · docs/DAT.md §28.1 (deux processus, aucun
#       service a orchestrer), §28.2 (le serveur local)
#
# Aucun demon Docker n'est requis : la pile n'a aucune dependance externe, et
# conteneuriser deux processus qui n'en ont pas en AJOUTERAIT une.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETAT="${SPARK_DEV_STATE:-$RACINE/.dev}"
export SPARKD_DB="${SPARKD_DB:-$ETAT/spark.db}"
export SPARKD_DRIVER=fake
export SPARKD_BIND="${SPARKD_BIND:-127.0.0.1:9876}"
export SPARK_CONSOLE_PORT="${SPARK_CONSOLE_PORT:-5173}"
export SPARK_CONSOLE_STATE="${SPARK_CONSOLE_STATE:-$ETAT/servers.json}"
PY="$RACINE/services/sparkd/.venv/bin/python"

mkdir -p "$ETAT"

# L'inventaire de la console pointe sur le sparkd local (§28.2). Il est ecrit a
# chaque demarrage : c'est un fichier de developpement, pas une preference.
PORT="${SPARKD_BIND##*:}"
cat > "$SPARK_CONSOLE_STATE" <<JSON
[{"name":"local","kind":"local","host":"127.0.0.1","port":$PORT}]
JSON

case "${1:-up}" in
  seed)
    exec "$PY" -m sparkd.seed
    ;;
  up)
    if [ ! -f "$SPARKD_DB" ]; then
      echo "Registre absent : application du seed."
      "$PY" -m sparkd.seed
    fi
    "$PY" -m sparkd &
    SPARKD_PID=$!
    trap 'kill $SPARKD_PID 2>/dev/null || true' EXIT INT TERM
    echo "sparkd    http://127.0.0.1:$PORT  (pilote factice, registre $SPARKD_DB)"
    echo "console   http://127.0.0.1:$SPARK_CONSOLE_PORT"
    cd "$RACINE/apps/webui" && node host/main.js
    ;;
  *)
    echo "usage : dev.sh [up|seed]" >&2; exit 2 ;;
esac
