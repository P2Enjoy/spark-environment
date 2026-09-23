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

# SPK-100 · docs/DAT.md §53.4 : le repertoire d'etat est un ARGUMENT NOMME, et
# non une variable d'environnement. Il se lit alors dans la commande qui l'a
# employe et dans `--help` ; une variable ne laisse aucune trace de son passage.
ETAT="$RACINE/.dev"
COMMANDE=up

usage() {
  cat <<'AIDE'
dev.sh — pile de developpement : sparkd (pilote factice) + hote console.

  up                 Demarre les deux processus. Defaut.
  seed               Applique le seed et sort.
  --state <chemin>   Repertoire d'etat de la pile. Defaut : <depot>/.dev
  -h, --help         Affiche cette aide.
AIDE
}

# Un argument inconnu est REFUSE, jamais ignore : un reglage mal orthographie
# doit se voir tout de suite, et non au moment ou l'on cherche pourquoi rien n'a
# change (§53.4).
while [ $# -gt 0 ]; do
  case "$1" in
    --state)
      [ $# -ge 2 ] || { echo "--state attend un chemin." >&2; exit 2; }
      ETAT="$2"; shift 2 ;;
    --state=*) ETAT="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    # Une OPTION mal orthographiee est refusee ici, avant tout effet : c'est le
    # cas que le §53.4 vise — un reglage ignore en silence.
    -*) echo "Option inconnue : $1" >&2; usage >&2; exit 2 ;;
    # La COMMANDE reste validee par le `case` du bas, qui la refuse avec la meme
    # aide. Elle y arrive apres la fusion de l'inventaire, comportement que la
    # preuve du SPK-41 emploie et qui n'a rien a voir avec un levier cache.
    *) COMMANDE="$1"; shift ;;
  esac
done

[ -n "$ETAT" ] || { echo "--state ne peut pas etre vide." >&2; exit 2; }
export SPARKD_DB="${SPARKD_DB:-$ETAT/spark.db}"
export SPARKD_DRIVER=fake
export SPARKD_BIND="${SPARKD_BIND:-127.0.0.1:9876}"
export SPARK_CONSOLE_PORT="${SPARK_CONSOLE_PORT:-5173}"
export SPARK_CONSOLE_STATE="${SPARK_CONSOLE_STATE:-$ETAT/servers.json}"
PY="$RACINE/services/sparkd/.venv/bin/python"

mkdir -p "$ETAT"

# L'inventaire de la console pointe sur le sparkd local (§28.2). Il est ecrit a
# chaque demarrage : c'est un fichier de developpement, pas une preference.
#
# SPK-41 : forme COURANTE du fichier (§22.4.2), et DEUX serveurs.
#
# Un seul serveur ne montrerait ni le selecteur — le produit affiche alors le
# nom plutot qu'un controle mort — ni un tunnel ferme. Le second est declare par
# ALIAS, le genre que le §22.4 bis introduit, et il est deliberement injoignable :
# le catalogue doit montrer un serveur qu'on n'atteint pas, sinon l'ecran ne
# presenterait jamais que le cas heureux (CLAUDE.md §8).
PORT="${SPARKD_BIND##*:}"

# CORRECTION du 2026-08-21 : ce fichier etait REECRIT a chaque demarrage, donc
# tout serveur ajoute depuis la console disparaissait au redemarrage suivant. Le
# responsable devait les ressaisir a chaque fois.
#
# Les deux serveurs de developpement restent garantis — sans eux la pile ne
# montre ni le selecteur ni un tunnel ferme —, mais ils sont FUSIONNES dans
# l'inventaire existant au lieu de l'ecraser. Un fichier de developpement peut
# etre recree ; ce qu'un humain y a saisi, non.
python3 - "$SPARK_CONSOLE_STATE" "$PORT" <<'FUSION'
import json, sys
from pathlib import Path

chemin, port = Path(sys.argv[1]), int(sys.argv[2])
attendus = [
    {"name": "local", "kind": "local", "host": "127.0.0.1", "port": port},
    {"name": "recette", "kind": "alias", "sshHost": "spark-recette",
     "remotePort": 9876},
]

etat = {"version": 1, "current": "local", "servers": [], "anchors": {}}
try:
    lu = json.loads(chemin.read_text(encoding="utf-8"))
    if isinstance(lu, dict) and isinstance(lu.get("servers"), list):
        etat = lu
except (OSError, ValueError):
    pass   # fichier absent ou illisible : on repart du modele

# Les entrees du responsable sont conservees telles quelles ; seules celles que
# la pile garantit sont remises a jour — le port de `local` change avec
# SPARKD_BIND.
noms = {s.get("name") for s in attendus}
etat["servers"] = attendus + [s for s in etat["servers"] if s.get("name") not in noms]
if not any(s.get("name") == etat.get("current") for s in etat["servers"]):
    etat["current"] = "local"
etat.setdefault("anchors", {})
etat.setdefault("version", 1)
chemin.write_text(json.dumps(etat, ensure_ascii=False, indent=2) + "\n",
                  encoding="utf-8")
FUSION

case "$COMMANDE" in
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
    # SPK-117 · docs/DAT.md §62.1 : le lanceur, pour que la console se
    # redémarre depuis son avertissement.
    cd "$RACINE/apps/webui" && node host/lanceur.js
    ;;
  *)
    usage >&2; exit 2 ;;
esac
