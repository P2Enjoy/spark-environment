#!/usr/bin/env bash
# Banc SPK-128 : la configuration de l'ingress, PRODUITE par `build_config`, posée
# sur un vrai Caddy à la version de la Forge. Aucune copie à la main : si le code
# change, c'est le code qui est mesuré.
#
# @verifies docs/BACKLOG.md#SPK-128 · docs/DAT.md §18.2 (protocoles déclarés,
#           route commune), §18.6 (l'ingress ne sert pas HTTP/3, et le dit)
#
# Ce que le banc établit, et qui ne se prouve pas sans Caddy :
#   1. plus aucune écoute UDP/443 ;
#   2. `alt-svc: clear`, SEUL, sur une route servie en HTTP/2 et en HTTP/1.1, et
#      sur le refus `404` ;
#   3. l'`Alt-Svc` de l'amont ne parvient pas au visiteur, ses autres en-têtes si ;
#   4. le passage À CHAUD, par `POST /load`, depuis la forme d'avant SPK-128 —
#      celle que la Forge sert tant qu'OP-27 n'est pas joué — ferme l'écoute UDP
#      et remplace l'annonce `h3` par `clear`, sans redémarrer Caddy.
#
# Trois conteneurs jetables (deux Caddy, un curl) sur un réseau Docker dédié,
# retirés en sortant. Ni navigateur, ni `sparkd`, ni console : ce n'est pas une
# épreuve lourde au sens de CLAUDE.md §15 bis, et il ne prend pas le verrou de
# `e2e/verrou.mjs`.
#
#   scripts/mesures-spk128.sh           # code 0 si tout est vert, 1 sinon
#
# Prérequis : Docker, et le venv de `sparkd` (`make sparkd-install`).
# Joué le 2026-09-30 : vert (docs/JOURNAL.md).
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "Aucun argument attendu (voir --help)." >&2
  exit 2
fi

RACINE="$(cd "$(dirname "$0")/.." && pwd)"
PY="$RACINE/services/sparkd/.venv/bin/python"
# La version de la Forge : docs/PROD_MIGRATIONS.md §1, ligne « Caddy ».
CADDY=caddy:2.6.2
CURL=curlimages/curl:8.11.1
RESEAU=mesure-spk128
DOMAINE=app.exemple.test
TRAVAIL="$(mktemp -d)"

retirer_le_banc() {
  docker rm -f spk128-ingress spk128-amont >/dev/null 2>&1 || true
  docker network rm "$RESEAU" >/dev/null 2>&1 || true
}
trap 'retirer_le_banc; rm -rf "$TRAVAIL"' EXIT
# Un banc interrompu laisse ses conteneurs : on repart d'un état connu.
retirer_le_banc

[[ -x "$PY" ]] || { echo "venv de sparkd absent : make sparkd-install" >&2; exit 2; }

# --- les deux configurations, depuis le code ---------------------------------
"$PY" - "$TRAVAIL" "$DOMAINE" <<'EOF'
import copy, json, sys, tempfile
from pathlib import Path
from sparkd import ingress, migrations
from sparkd.db import connect

travail, domaine = Path(sys.argv[1]), sys.argv[2]
connexion = connect(Path(tempfile.mkdtemp()) / "banc.db")
migrations.upgrade(connexion)
connexion.execute(
    "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
    "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
    "ipv4_address,created_at,updated_at) VALUES ('S1','banc','images:debian/13',"
    "'shared',0.5,1,1,1,'10.77.0.16','x','x')")
ingress.declare(connexion, "S1", domaine, 8080)
nouvelle = ingress.build_config(connexion)
serveur = nouvelle["apps"]["http"]["servers"][ingress.SERVER_NAME]

# Deux écarts, propres au BANC et à lui seul : l'amont est le conteneur témoin,
# et le certificat vient de l'autorité interne — le domaine n'existe pas.
for route in serveur["routes"]:
    for h in route["handle"]:
        if h["handler"] == "reverse_proxy":
            h["upstreams"] = [{"dial": "spk128-amont:8080"}]
nouvelle["apps"]["tls"] = {"automation": {"policies": [
    {"subjects": [domaine], "issuers": [{"module": "internal"}]}]}}
nouvelle["admin"] = {"listen": "0.0.0.0:2019"}

# La forme d'AVANT SPK-128 : sans `protocols`, sans route commune.
ancienne = copy.deepcopy(nouvelle)
s = ancienne["apps"]["http"]["servers"][ingress.SERVER_NAME]
s.pop("protocols", None)
s["routes"] = [r for r in s["routes"]
               if not any(h["handler"] == "headers" for h in r["handle"])]

(travail / "nouvelle.json").write_text(json.dumps(nouvelle))
(travail / "ancienne.json").write_text(json.dumps(ancienne))
# L'amont témoin : il émet son propre Alt-Svc, comme la cellule du SSO.
(travail / "amont.json").write_text(json.dumps({
    "admin": {"disabled": True},
    "apps": {"http": {"servers": {"amont": {"listen": [":8080"], "routes": [
        {"handle": [{"handler": "static_response", "status_code": 200,
                     "headers": {"Alt-Svc": ["h3=\":9999\""], "X-Amont": ["oui"]},
                     "body": "amont\n"}]}]}}}}}))
print(f"configuration produite par build_config : protocols={serveur.get('protocols', 'absent : défaut de Caddy')}")
EOF

docker pull -q "$CADDY" >/dev/null
docker pull -q "$CURL" >/dev/null
docker network create "$RESEAU" >/dev/null
docker run -d --name spk128-amont --network "$RESEAU" \
  -v "$TRAVAIL/amont.json:/c.json:ro" "$CADDY" caddy run --config /c.json >/dev/null
docker run -d --name spk128-ingress --network "$RESEAU" \
  -v "$TRAVAIL/ancienne.json:/c.json:ro" -v "$TRAVAIL/nouvelle.json:/nouvelle.json:ro" \
  "$CADDY" caddy run --config /c.json >/dev/null

ECHECS=0
verdict() {  # verdict <libellé> <obtenu> <attendu>
  if [[ "$2" == "$3" ]]; then echo "  ok     $1 : $2"
  else echo "  ÉCHEC  $1 : obtenu « $2 », attendu « $3 »"; ECHECS=$((ECHECS + 1)); fi
}
udp443() {
  docker exec spk128-ingress sh -c 'netstat -lnu 2>/dev/null | grep -cE ":443\b"' || true
}
entetes() {  # entetes <options curl…> : en-têtes de réponse, en minuscules
  local ip
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' spk128-ingress)"
  docker run --rm --network "$RESEAU" "$CURL" -sk -o /dev/null -D - \
    --resolve "$DOMAINE:443:$ip" "$@" | tr -d '\r' | tr 'A-Z' 'a-z'
}
valeurs_alt_svc() { grep '^alt-svc:' | sed 's/^alt-svc: //' | paste -sd'|' -; }
attendre_caddy() {
  for _ in $(seq 1 30); do
    if [[ -n "$(entetes "https://$DOMAINE/" 2>/dev/null | head -1)" ]]; then return 0; fi
    sleep 1
  done
  echo "Caddy ne répond pas." >&2; exit 1
}
attendre_caddy

echo "== forme d'avant SPK-128 (celle que la Forge sert jusqu'à OP-27)"
verdict "écoute UDP/443" "$(udp443)" "1"
verdict "alt-svc, route servie" "$(entetes "https://$DOMAINE/" | valeurs_alt_svc)" 'h3=":443"; ma=2592000'

echo "== POST /load de la forme produite, à chaud"
docker exec spk128-ingress sh -c \
  'wget -q -O /dev/null --header "Content-Type: application/json" --post-file /nouvelle.json http://127.0.0.1:2019/load' \
  && echo "  ok     /load accepté"
sleep 2

echo "== forme produite par build_config"
verdict "écoute UDP/443" "$(udp443)" "0"
H2="$(entetes "https://$DOMAINE/")"
verdict "protocole, route servie" "$(head -1 <<<"$H2" | awk '{print $1, $2}')" "http/2 200"
verdict "alt-svc, route servie, HTTP/2" "$(valeurs_alt_svc <<<"$H2")" "clear"
verdict "en-tête de l'amont transmis" "$(grep -c '^x-amont: oui' <<<"$H2")" "1"
H1="$(entetes --http1.1 "https://$DOMAINE/")"
verdict "alt-svc, route servie, HTTP/1.1" "$(valeurs_alt_svc <<<"$H1")" "clear"
REFUS="$(docker run --rm --network "$RESEAU" "$CURL" -s -o /dev/null -D - \
  -H 'Host: inconnu.exemple.test' http://spk128-ingress/ | tr -d '\r' | tr 'A-Z' 'a-z')"
verdict "refus, domaine non routé" "$(head -1 <<<"$REFUS" | awk '{print $2}')" "404"
verdict "alt-svc, refus 404" "$(valeurs_alt_svc <<<"$REFUS")" "clear"

if [[ $ECHECS -gt 0 ]]; then echo "ROUGE : $ECHECS écart(s)."; exit 1; fi
echo "VERT : la configuration produite ne sert ni n'annonce HTTP/3, et pose Alt-Svc: clear."
