#!/usr/bin/env bash
# Mesure 6 de SPK-111 sur une Forge réelle, sur les DEUX CELLULES D'ESSAI créées
# par le produit — jamais sur une cellule de locataire. Réversible : le réseau
# privé et l'adhésion sont créés puis défaits PAR LE PRODUIT ; les deux devices
# `proxy`, les deux serveurs de mesure et la règle nft provisoire sont retirés.
#
# @verifies docs/BACKLOG.md#SPK-111 · docs/DAT.md §59.3 (nat=true et la règle
#           ct status dnat), §59.6 (la mesure due) ·
#           docs/EXPLORATION_RESEAU_PRIVE.md §6 (mesure 6)
#
# Ce que la mesure décide : un device `proxy` en `nat=true` écoutant sur
# l'adresse de la Forge d'un bridge privé traduit-il le flux ; le `drop` du §58
# en `forward` le bloque-t-il tant que `ct status dnat accept` n'est pas posée ;
# la posée, le flux passe-t-il, et SEUL ce flux ; le Spark exposé lit-il
# l'adresse du membre ; et `udp` ?
#
# Se joue SUR la Forge, l'entrée standard libre — `incus exec` attache stdin et
# lirait le script lui-même :
#   ssh <compte>@<forge> 'cat > /tmp/m.sh && bash /tmp/m.sh' < scripts/mesures-spk111.sh
# Les cellules n'ont ni curl ni nc : les sondes sont en python3.
set +e
A=essai-a; B=essai-b; IPA=10.77.0.18; API=http://127.0.0.1:9876
ex() { sudo -n incus exec "$1" -- sh -c "$2" 2>&1 </dev/null; }
http() { ex "$1" "python3 -c \"import urllib.request
try:
  print(urllib.request.urlopen('$2', timeout=6).status)
except Exception as e:
  print('ERR', getattr(e, 'code', None) or type(e).__name__)\""; }
tcp() { ex "$1" "python3 -c \"import socket
s = socket.socket(); s.settimeout(4)
try:
  s.connect(('$2', $3)); print('OUVERT')
except Exception as e:
  print('FERME', type(e).__name__)\""; }
lit() { curl -s $API/v1/networks/mesure | python3 -c "import sys, json; d = json.load(sys.stdin); print($1)"; }

echo "=== M6.0 · le réseau privé et le membre, par le produit"
curl -s -X POST $API/v1/networks -H 'content-type: application/json' \
  -d '{"name":"mesure","note":"mesure 6 de SPK-111"}' \
  | python3 -c 'import sys, json; d = json.load(sys.stdin); print("réseau", d["name"], d["cidr"], d["interface"], "passerelle", d["gateway"])'
GW=$(lit 'd["gateway"]'); IFACE=$(lit 'd["interface"]')
curl -s -X POST $API/v1/networks/mesure/members -H 'content-type: application/json' -d "{\"spark\":\"$B\"}" \
  | python3 -c 'import sys, json; d = json.load(sys.stdin); print("membre", d.get("ipv4_address"), "configurée", d.get("cell_configured"), d.get("cell_note", ""))'
IPB=$(lit 'd["members"][0]["ipv4_address"]')
sleep 2
echo "B sur $IFACE : $(ex $B "ip -4 -o addr show $IFACE | awk '{print \$4}'")"

echo "=== M6.1 · un service dans A, un device proxy nat=true posé à la main"
ex $A "cd /tmp && (nohup python3 -m http.server 8080 --bind 0.0.0.0 >/tmp/srv.log 2>&1 &) ; sleep 1; echo 'serveur 8080 lancé'"
sudo -n incus config device add $A lnk-mesure-8080 proxy nat=true listen=tcp:$GW:8080 connect=tcp:$IPA:8080 \
  && echo "device tcp : posé" || echo "device tcp : REFUSÉ"
echo "--- ce qu'Incus a posé (table inet incus, 8080) :"
sudo -n nft list table inet incus 2>/dev/null | grep -n "8080" | head -6

echo "=== M6.2 · SANS règle ct status dnat : le drop du §58 en forward tient-il ?"
echo "B → $GW:8080 : $(http $B http://$GW:8080/)   [attendu : ERR — iifname spn* drop]"

echo "=== M6.3 · AVEC ct status dnat accept (insérée en tête, provisoire)"
sudo -n nft insert rule inet spark_filter forward ct status dnat accept && echo "règle : insérée"
echo "B → $GW:8080 : $(http $B http://$GW:8080/)   [attendu : 200]"
echo "B → $GW:8081, port non lié : $(tcp $B $GW 8081)   [attendu : FERME]"
echo "B → $IPA:8080, l'eth0 de A : $(tcp $B $IPA 8080)   [attendu : FERME — isolation]"
echo "B → $GW:22, le sshd de la Forge par spn : $(tcp $B $GW 22)   [attendu : FERME]"
echo "--- l'adresse source vue par A (journal du serveur) :"
ex $A "tail -2 /tmp/srv.log"

echo "=== M6.4 · udp"
ex $A "cat > /tmp/udp.py <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('0.0.0.0', 9090))
d, a = s.recvfrom(64)
open('/tmp/udp.log', 'w').write(d.decode() + ' de ' + a[0] + chr(10)); s.sendto(b'pong', a)
PY
(nohup python3 /tmp/udp.py >/dev/null 2>&1 &); sleep 1; echo 'serveur udp 9090 lancé'"
sudo -n incus config device add $A lnk-mesure-9090 proxy nat=true listen=udp:$GW:9090 connect=udp:$IPA:9090 \
  && echo "device udp : posé" || echo "device udp : REFUSÉ"
ex $B "python3 -c \"import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(4); s.sendto(b'ping', ('$GW', 9090))
try:
  print('B reçoit', s.recvfrom(64)[0].decode())
except Exception as e:
  print('B sans réponse', type(e).__name__)\""
echo "A a reçu : $(ex $A 'cat /tmp/udp.log 2>/dev/null || echo rien')   [attendu : ping de $IPB]"

echo "=== M6.5 · tout défaire"
sudo -n incus config device remove $A lnk-mesure-8080 >/dev/null && echo "device tcp : retiré"
sudo -n incus config device remove $A lnk-mesure-9090 >/dev/null && echo "device udp : retiré"
ex $A "pkill -f 'http.server 8080'; pkill -f /tmp/udp.py; rm -f /tmp/srv.log /tmp/udp.py /tmp/udp.log; echo 'serveurs et fichiers : retirés'"
H=$(sudo -n nft -a list chain inet spark_filter forward | awk '/ct status dnat accept/ {print $NF}')
[ -n "$H" ] && sudo -n nft delete rule inet spark_filter forward handle "$H" && echo "règle provisoire : retirée"
curl -s -X DELETE $API/v1/networks/mesure/members/$B -o /dev/null -w "détache B : %{http_code}\n"
curl -s -X DELETE $API/v1/networks/mesure -o /dev/null -w "supprime le réseau : %{http_code}\n"
echo "forward : $(sudo -n nft list chain inet spark_filter forward | grep -c drop) drop(s), $(sudo -n nft list chain inet spark_filter forward | grep -c 'ct status dnat') règle(s) dnat   [attendu : 3, 0]"
echo "réseaux : $(sudo -n incus network list -f csv -c n | tr '\n' ' ')"
echo "devices de A : $(sudo -n incus config device list $A | tr '\n' ' ')"
