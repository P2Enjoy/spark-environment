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

# SPK-100 · docs/DAT.md §53.4 : un ARGUMENT NOMMÉ, et non une variable
# d'environnement. Le préfixe se lit alors dans la commande qui l'a employé et
# dans `--help` ; une variable ne laisse aucune trace de son passage.
PREFIX=/opt/sparkd
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'AIDE'
install-serveur.sh — installe sparkd depuis un checkout local (root requis).

  --prefix <chemin>   Où poser le venv et le code. Défaut : /opt/sparkd
  -h, --help          Affiche cette aide.

Le chemin normal d'installation est décrit dans docs/AGENT_RUNBOOK.md §A.2.
AIDE
}

# Un argument inconnu est REFUSÉ, jamais ignoré : un réglage mal orthographié
# doit se voir tout de suite, et non au moment où l'on cherche pourquoi rien n'a
# changé (§53.4).
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -ge 2 ] || { echo "--prefix attend un chemin." >&2; exit 2; }
      PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argument inconnu : $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$PREFIX" ] || { echo "--prefix ne peut pas être vide." >&2; exit 2; }

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
