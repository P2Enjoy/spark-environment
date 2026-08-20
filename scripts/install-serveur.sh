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

echo "== 2 bis. Estampille de build =="
# docs/DAT.md §40 : une Forge doit pouvoir dire QUEL code elle execute. Le
# fichier est ecrit ICI, une fois, et lu au fil des requetes. Le runtime ne
# derive jamais cette valeur : sortir un « git » d'un service en production
# ferait dependre sa reponse d'un depot qui n'a aucune raison d'etre la.
#
# La source arrive souvent SANS « .git » (rsync du deploiement) : le hash est
# alors fourni par l'appelant. Une build non estampillee reste licite et se DIT
# inconnue (§40.2) — elle ne rend jamais une valeur plausible.
COMMIT="${SPARKD_BUILD_COMMIT:-}"
COMMIT_AT="${SPARKD_BUILD_AT:-}"
DIRTY="${SPARKD_BUILD_DIRTY:-false}"
if [ -z "$COMMIT" ] && git -C "$SOURCE" rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git -C "$SOURCE" rev-parse --short=12 HEAD)"
  COMMIT_AT="$(git -C "$SOURCE" log -1 --format=%cI)"
  if [ -n "$(git -C "$SOURCE" status --porcelain)" ]; then DIRTY=true; fi
fi
python3 - "$RACINE_INSTALL/build.json" "$COMMIT" "$COMMIT_AT" "$DIRTY" "${SPARKD_BUILD_FROM:-$(hostname):$SOURCE}" <<'ESTAMPILLE'
import json, sys
from datetime import datetime, timezone
chemin, commit, commit_at, dirty, depuis = sys.argv[1:6]
json.dump({
    "commit": commit or None,
    "committed_at": commit_at or None,
    "dirty": dirty == "true",
    "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "installed_from": depuis,
}, open(chemin, "w"), ensure_ascii=False, indent=2)
ESTAMPILLE
chmod 0644 "$RACINE_INSTALL/build.json"
echo "  build : ${COMMIT:-inconnue}${COMMIT:+ (dirty=$DIRTY)}"

echo "== 3. Unites systemd =="
# docs/DAT.md §32.4 : la tranche parente doit survivre a un redemarrage. Creee a
# la main, elle disparait, et la reservation redevient proportionnelle en silence.
install -m 0644 "$SOURCE/deploy/spark.slice" /etc/systemd/system/spark.slice
# docs/DAT.md §31.4 : « demarre » ne suffit pas, il faut « active au demarrage ».
install -m 0644 "$SOURCE/deploy/sparkd.service" "$UNITE"
systemctl daemon-reload
systemctl start spark.slice
# Les controleurs doivent etre delegues pour que les limites s'appliquent DANS
# la tranche : systemd ne le fait pas de lui-meme pour une tranche vide.
echo "+cpu +cpuset +memory +io +pids" > /sys/fs/cgroup/spark.slice/cgroup.subtree_control 2>/dev/null || true
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
