#!/usr/bin/env bash
# Mesures de SPK-109 sur une Forge réelle, sur DEUX CELLULES D'ESSAI créées par
# le produit — jamais sur une cellule de locataire. Réversible : tout ce qui est
# posé pour mesurer (route, adresse secondaire, table nft d'essai) est retiré ;
# seuls restent les deux drapeaux sur les cellules d'essai.
#
# @verifies docs/BACKLOG.md#SPK-109 · docs/DAT.md §57.2 (les deux étages),
#           §57.5 (les trois mesures) · docs/EXPLORATION_RESEAU_PRIVE.md §6
#
# Se joue SUR la Forge, l'entrée standard libre — `incus exec` attache stdin et
# lirait le script lui-même :
#   ssh <compte>@<forge> 'cat > /tmp/m.sh && bash /tmp/m.sh' < scripts/mesures-spk109.sh
# Joué le 2026-09-17 : les trois réponses sont oui (docs/JOURNAL.md).
set +e
A=essai-a; B=essai-b; IPA=10.77.0.18; IPB=10.77.0.19; GW=10.77.0.1
ex() { sudo -n incus exec "$1" -- sh -c "$2" 2>&1 </dev/null; }
http() { ex "$1" "if command -v curl >/dev/null; then curl -sS -m 8 -o /dev/null -w '%{http_code}' $2; else python3 -c \"import urllib.request,sys
try:
  print(urllib.request.urlopen('$2', timeout=8).status)
except Exception as e:
  print('ERR', getattr(e,'code',e))\"; fi"; }
echos() { ex "$1" "awk '\$1==\"Icmp:\"{if(!h){for(i=1;i<=NF;i++)if(\$i==\"InEchos\")c=i;h=1}else print \$c}' /proc/net/snmp"; }
veth() { sudo -n incus query "/1.0/instances/$1/state" | jq -r '.network.eth0.host_name'; }
pingok() { ex "$1" "ping -c2 -W1 $2 >/dev/null 2>&1 && echo JOINT || echo INJOIGNABLE"; }

echo "=== M0 · état initial"
echo "A→B : $(pingok $A $IPB) · B→A : $(pingok $B $IPA) · A→passerelle : $(pingok $A $GW)"
echo "veth A=$(veth $A) B=$(veth $B) · isolation : $(bridge -d link show | grep -o 'isolated [a-z]*' | sort | uniq -c | tr '\n' ' ')"

echo "=== M1 · security.port_isolation à chaud"
sudo -n incus config device set $A eth0 security.port_isolation=true && echo "set A : ok" || echo "set A : REFUSÉ"
sudo -n incus config device set $B eth0 security.port_isolation=true && echo "set B : ok" || echo "set B : REFUSÉ"
echo "drapeaux : $(bridge -d link show | grep -o 'isolated [a-z]*' | sort | uniq -c | tr '\n' ' ')"
echo "A→B : $(pingok $A $IPB) · B→A : $(pingok $B $IPA) · A→passerelle : $(pingok $A $GW)"
echo "A : DNS $(ex $A 'getent hosts deb.debian.org >/dev/null && echo ok || echo ECHEC') · internet $(http $A https://deb.debian.org/) · ingress $(http $A https://oauth.lelabs.tech/)"
echo "A→redaction-devis (locataire) : $(pingok $A 10.77.0.17)   [attendu : JOINT tant que le locataire n'est pas isolé]"

echo "=== M2 · le détour routé, et le drop en forward"
ex $A "ip route add $IPB/32 via $GW dev eth0" && echo "route A→B via passerelle : posée"
avant=$(echos $B); ex $A "ping -c3 -W1 $IPB >/dev/null 2>&1"; apres=$(echos $B)
echo "sans drop : InEchos de B $avant → $apres (delta $((apres-avant)))   [>0 = le détour livre les paquets]"
sudo -n nft -f - <<'NFT'
table inet spark_essai {
  chain forward {
    type filter hook forward priority filter + 10; policy accept;
    iifname "sparkbr0" oifname "sparkbr0" drop
  }
}
NFT
echo "table d'essai posée : $(sudo -n nft list table inet spark_essai | grep -c drop) règle(s) drop"
avant=$(echos $B); ex $A "ping -c3 -W1 $IPB >/dev/null 2>&1"; apres=$(echos $B)
echo "avec drop  : InEchos de B $avant → $apres (delta $((apres-avant)))   [0 = le drop survit à l'accept d'Incus]"
echo "A : internet toujours $(http $A https://deb.debian.org/) · ingress $(http $A https://oauth.lelabs.tech/)"
sudo -n nft delete table inet spark_essai; ex $A "ip route del $IPB/32 via $GW dev eth0"; echo "table et route retirées"

echo "=== M3 · security.ipv4_filtering et l'usurpation"
sudo -n nft -f - <<'NFT'
table inet spark_essai {
  chain input {
    type filter hook input priority filter - 5; policy accept;
    iifname "sparkbr0" ip saddr 10.77.0.19 icmp type echo-request counter
  }
}
NFT
cnt() { sudo -n nft list table inet spark_essai | grep -o 'packets [0-9]*' | awk '{print $2}'; }
ex $A "ip addr add $IPB/24 dev eth0" && echo "A porte aussi l'adresse de B"
c0=$(cnt); ex $A "ping -c3 -W1 -I $IPB $GW >/dev/null 2>&1"; c1=$(cnt)
echo "sans filtrage : paquets usurpés vus par la Forge $c0 → $c1 (delta $((c1-c0)))   [>0 = usurpation possible]"
sudo -n incus config device set $A eth0 security.ipv4_filtering=true && echo "set ipv4_filtering A : ok" || echo "set ipv4_filtering A : REFUSÉ"
c0=$(cnt); ex $A "ping -c3 -W1 -I $IPB $GW >/dev/null 2>&1"; c1=$(cnt)
echo "avec filtrage : paquets usurpés $c0 → $c1 (delta $((c1-c0)))   [0 = l'usurpation est fermée]"
echo "A légitime : passerelle $(pingok $A $GW) · internet $(http $A https://deb.debian.org/) · DNS $(ex $A 'getent hosts deb.debian.org >/dev/null && echo ok || echo ECHEC')"
ex $A "ip addr del $IPB/24 dev eth0"; sudo -n nft delete table inet spark_essai; echo "adresse et table retirées"
echo "config A : $(sudo -n incus config device get $A eth0 security.ipv4_filtering) / $(sudo -n incus config device get $A eth0 security.mac_filtering)"

echo "=== FIN DES MESURES : cellules d essai en place, drapeaux poses sur A (isolation+filtrage) et B (isolation)"
