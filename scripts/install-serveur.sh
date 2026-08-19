#!/usr/bin/env bash
# Installe sparkd comme service sur l'hote cible.
#
# @spec docs/BACKLOG.md#SPK-26 · docs/DAT.md §31 (l'installation et sa
#       verification), §31.3 (l'installation est SEPAREE de la verification) ·
#       docs/PROD_MIGRATIONS.md OP-04
#
# Ce script INSTALLE. La verification est ailleurs, en lecture seule :
#
#     python3 -m sparkd.preflight
#
# La separation est deliberee : un outil qui verifie et repare finit par reparer
# ce qu'on voulait seulement constater.
#
# Il est IDEMPOTENT : le relancer sur un serveur deja installe met a jour le code
# et l'unite, sans rien detruire. Le registre n'est jamais efface.
set -euo pipefail

RACINE_INSTALL="${SPARKD_PREFIX:-/opt/sparkd}"
ETAT="${SPARKD_STATE_DIR:-/var/lib/sparkd}"
UNITE="/etc/systemd/system/sparkd.service"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-serveur.sh doit etre lance en root." >&2
  exit 2
fi

echo "== 1. Verification prealable =="
# On ne s'installe pas sur un serveur dont les conditions ne sont pas reunies :
# le service demarrerait et echouerait a la premiere operation.
if [ -x "$RACINE_INSTALL/venv/bin/python" ]; then
  "$RACINE_INSTALL/venv/bin/python" -m sparkd.preflight || true
else
  echo "  (premiere installation : la verification suivra le deploiement)"
fi

echo "== 2. Code =="
install -d -m 0755 "$RACINE_INSTALL"
install -d -m 0750 "$ETAT"
if [ ! -d "$RACINE_INSTALL/venv" ]; then
  python3 -m venv "$RACINE_INSTALL/venv"
fi
"$RACINE_INSTALL/venv/bin/pip" install --quiet --upgrade pip
"$RACINE_INSTALL/venv/bin/pip" install --quiet "$SOURCE/services/sparkd"

echo "== 3. Unite systemd =="
# docs/DAT.md §31.4 : « demarre » ne suffit pas, il faut « active au demarrage ».
install -m 0644 "$SOURCE/deploy/sparkd.service" "$UNITE"
systemctl daemon-reload
systemctl enable sparkd
systemctl restart sparkd

echo "== 4. Verification finale =="
# Le registre migre au demarrage de sparkd : on lui laisse le temps de repondre
# avant de conclure, plutot que de conclure trop tot.
for _ in $(seq 1 20); do
  curl -sf http://127.0.0.1:9876/healthz >/dev/null 2>&1 && break
  sleep 1
done
"$RACINE_INSTALL/venv/bin/python" -m sparkd.preflight
