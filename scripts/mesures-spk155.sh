#!/usr/bin/env bash
# Banc SPK-155 et SPK-156 : l'émetteur déclaré et le journal d'émission, PRODUITS
# par `build_config`, posés sur un vrai Caddy à la version de la Forge. Aucune
# copie à la main : si le code change, c'est le code qui est mesuré.
#
# @verifies docs/BACKLOG.md#SPK-155 · docs/DAT.md §18.3 (l'émetteur est déclaré :
#           Let's Encrypt, et lui seul), §18.2
# @verifies docs/BACKLOG.md#SPK-156 · docs/DAT.md §18.9.1 (le journal d'émission
#           que la configuration déclare), §18.9.2 (ce qui s'y lit)
#
# Ce que le banc établit, et qui ne se prouve pas sans Caddy :
#   1. la forme d'AVANT — sans émetteur déclaré — tente Let's Encrypt PUIS
#      ZeroSSL : c'est le repli constaté sur la Forge le 2026-10-11 ;
#   2. la forme produite est acceptée par `POST /load`, et `GET /config/` la rend
#      à l'identique — le contrôle ING-CONCORDE du préflight en dépend ;
#   3. elle ne tente plus qu'un émetteur, sous la clé de stockage
#      `acme-v02.api.letsencrypt.org-directory` — celle de l'émetteur par défaut,
#      donc celle des certificats déjà émis ;
#   4. Caddy écrit le journal d'émission dans le fichier déclaré, et le journal
#      par défaut reçoit toujours les mêmes lignes ;
#   5. l'analyse de `sparkd` lit ce fichier et rend l'échec du nom.
#
# Le nom servi est `essai.exemple.test` : Let's Encrypt refuse d'emblée un nom
# sous `.test`, sans validation ni limite consommée. Il faut donc l'accès à
# Internet pour que l'échec soit celui de l'autorité ; sans lui, l'échec est
# réseau, et les points 1 à 5 tiennent quand même — l'émetteur tenté est nommé
# dans la ligne, quelle que soit la cause.
#
# Deux conteneurs jetables, retirés en sortant. Ni navigateur, ni `sparkd`, ni
# console : ce n'est pas une épreuve lourde au sens de CLAUDE.md §15 bis, et il
# ne prend pas le verrou de `e2e/verrou.mjs`.
#
#   scripts/mesures-spk155.sh           # code 0 si tout est vert, 1 sinon
#
# Prérequis : Docker, et le venv de `sparkd` (`make sparkd-install`).
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
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
DOMAINE=essai.exemple.test
TRAVAIL="$(mktemp -d)"
# Le temps qu'une première tentative d'émission aboutisse à son échec.
ATTENTE=20

retirer_le_banc() {
  docker rm -f spk155-avant spk155-apres >/dev/null 2>&1 || true
}
trap 'retirer_le_banc; rm -rf "$TRAVAIL"' EXIT
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
# La forme produite, TELLE QUELLE : c'est elle qui est posée et relue.
nouvelle = ingress.build_config(connexion)
# La forme d'AVANT SPK-155 et SPK-156 : sans émetteur ni journal d'émission.
ancienne = copy.deepcopy(nouvelle)
ancienne.pop("logging")
ancienne["apps"].pop("tls")
(travail / "nouvelle.json").write_text(json.dumps(nouvelle))
(travail / "ancienne.json").write_text(json.dumps(ancienne))
print(f"journal déclaré : {ingress.JOURNAL_EMISSION}")
EOF

docker pull -q "$CADDY" >/dev/null
echec=0
ok() { echo "  ok    $1"; }
ko() { echo "  ÉCHEC $1"; echec=1; }

poser() {  # poser <conteneur> <fichier> : POST /load, depuis l'intérieur
  docker cp "$TRAVAIL/$2" "$1:/tmp/config.json"
  docker exec "$1" wget -qO- --header "Content-Type: application/json" \
    --post-file /tmp/config.json http://127.0.0.1:2019/load
}
emetteurs() {  # les émetteurs que Caddy a tentés, lus dans son journal par défaut
  docker logs "$1" 2>&1 | grep '"could not get certificate from issuer"' \
    | grep -o '"issuer":"[^"]*"' | sort -u | tr '\n' ' '
}

docker run -d --name spk155-avant "$CADDY" caddy run >/dev/null
docker run -d --name spk155-apres "$CADDY" caddy run >/dev/null
sleep 2

echo "1. la forme d'avant se replie sur ZeroSSL"
poser spk155-avant ancienne.json
echo "2. la forme produite est acceptée"
if poser spk155-apres nouvelle.json; then ok "POST /load rend 200"; else ko "POST /load refusé"; fi
docker exec spk155-apres wget -qO- http://127.0.0.1:2019/config/ > "$TRAVAIL/relue.json"
if "$PY" -c "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); sys.exit(0 if a==b else 1)" \
    "$TRAVAIL/nouvelle.json" "$TRAVAIL/relue.json"; then
  ok "GET /config/ rend la configuration posée, à l'identique"
else
  ko "GET /config/ diffère de la configuration posée"
fi

sleep "$ATTENTE"
avant="$(emetteurs spk155-avant)"
apres="$(emetteurs spk155-apres)"
echo "   émetteurs tentés, forme d'avant  : ${avant:-aucun}"
echo "   émetteurs tentés, forme produite : ${apres:-aucun}"
[[ "$avant" == *zerossl* ]] && ok "la forme d'avant tente ZeroSSL" \
  || ko "la forme d'avant n'a pas tenté ZeroSSL (attente trop courte ?)"

echo "3. un seul émetteur, sous la clé des certificats déjà émis"
[[ "$apres" == '"issuer":"acme-v02.api.letsencrypt.org-directory" ' ]] \
  && ok "Let's Encrypt seul, clé acme-v02.api.letsencrypt.org-directory" \
  || ko "émetteurs inattendus : ${apres:-aucun}"

echo "4. le journal d'émission, et le journal par défaut"
docker exec spk155-apres cat /var/log/caddy/emission-tls.log > "$TRAVAIL/emission.log" 2>/dev/null || true
lignes_fichier="$(grep -c "\"identifier\":\"$DOMAINE\"" "$TRAVAIL/emission.log" || true)"
lignes_defaut="$(docker logs spk155-apres 2>&1 | grep -E '"logger":"(tls\.obtain|tls\.renew|http\.acme_client)"' \
  | grep -c "\"identifier\":\"$DOMAINE\"" || true)"
[[ "$lignes_fichier" -gt 0 ]] && ok "$lignes_fichier ligne(s) du nom dans le fichier déclaré" \
  || ko "le fichier déclaré ne porte aucune ligne du nom"
[[ "$lignes_defaut" -ge "$lignes_fichier" && "$lignes_defaut" -gt 0 ]] \
  && ok "le journal par défaut les porte toujours ($lignes_defaut)" \
  || ko "le journal par défaut a perdu des lignes ($lignes_defaut contre $lignes_fichier)"
autres="$(grep -vcE '"logger":"(tls\.obtain|tls\.renew|http\.acme_client)"' "$TRAVAIL/emission.log" || true)"
[[ "$autres" -eq 0 ]] && ok "le fichier ne retient que les trois enregistreurs" \
  || ko "$autres ligne(s) d'autres enregistreurs dans le fichier"

echo "5. l'analyse de sparkd lit le fichier"
"$PY" - "$TRAVAIL/emission.log" "$DOMAINE" <<'EOF' || echec=1
import sys
from pathlib import Path
from sparkd.ingress_diagnostic import SondesReelles
releve = SondesReelles(journal_emission=Path(sys.argv[1])).emission()
e = releve.pour(sys.argv[2])
noms = sorted(i["name"] for i in e.get("issuers", []))
print(f"   état : {e['state']} · émetteurs : {noms}")
if releve.readable and e["state"] == "failing" and noms == ["Let's Encrypt"]:
    print("  ok    échec rendu, Let's Encrypt nommé, aucun autre émetteur")
else:
    print("  ÉCHEC l'analyse ne rend pas l'échec attendu")
    sys.exit(1)
EOF

if [[ $echec -eq 0 ]]; then echo "VERT"; else echo "ROUGE"; fi
exit $echec
