#!/bin/sh
# @spec docs/BACKLOG.md#SPK-61 · docs/DAT.md §46 (la clé restreinte du
#       responsable), §46.1 (« restrict » ne ferme pas l'exécution), §46.2 (la
#       condition serveur), §46.5 (ce que « permitopen » doit couvrir) ·
#       docs/PROD_MIGRATIONS.md (l'opération qui la pose)
#
# Produit la ligne « authorized_keys » de la clé d'accès du responsable.
#
# Pourquoi un script plutôt qu'une ligne à recopier : une ligne d'
# `authorized_keys` recopiée à la main est une ligne où l'on oublie une virgule,
# et une virgule oubliée y ouvre une porte EN SILENCE — `sshd` n'avertit de rien,
# la clé fonctionne, et la restriction qu'on croit avoir posée n'existe pas.
#
# Le script n'ÉCRIT nulle part et ne touche à aucune machine : il rend la ligne
# sur la sortie standard. Poser une ligne sur une Forge est un geste humain
# (`CLAUDE.md` §9), et le contrat de déploiement dit comment.

set -eu

usage() {
  cat >&2 <<'AIDE'
Usage : cle-restreinte.sh <clé-publique> [port-sparkd] [chemin-de-la-garde]

  <clé-publique>        chemin d'un fichier .pub, ou la clé elle-même
  [port-sparkd]         port d'écoute de sparkd sur la Forge      (défaut 9876)
  [chemin-de-la-garde]  où garde-ssh.sh est posé SUR LA FORGE
                        (défaut /usr/local/sbin/spark-garde-ssh)

Rend sur la sortie standard la ligne à ajouter au ~/.ssh/authorized_keys de la
Forge. N'écrit rien nulle part.

Rappel MESURÉ (docs/DAT.md §46.2) : sans « AllowTcpForwarding local » dans le
sshd_config de la Forge, cette ligne donne une console EN PANNE et non une
console protégée.
AIDE
  exit 2
}

[ $# -ge 1 ] || usage

source=$1
# « ${2-...} » et non « ${2:-...} » : le premier distingue un argument ABSENT
# d'un argument VIDE, le second les confond. Mesuré par la preuve : avec la
# forme confondante, « cle-restreinte.sh <clé> "" » rendait silencieusement une
# ligne sur le port par défaut — on croit avoir posé un port, on en obtient un
# autre, et la console ne joint plus sparkd sans que rien ne l'ait dit.
port=${2-9876}
garde=${3-/usr/local/sbin/spark-garde-ssh}

if [ -f "$source" ]; then
  cle=$(cat "$source")
else
  cle=$source
fi

# On refuse une clé PRIVÉE plutôt que de la recopier dans un fichier qui sera
# affiché, collé et parfois versionné (`CLAUDE.md` §11). Le message ne montre
# rien de ce qu'il a lu.
case "$cle" in
  *'PRIVATE KEY'*)
    echo "Ceci est une clé PRIVÉE. authorized_keys ne porte que des clés publiques." >&2
    exit 1 ;;
  ssh-*|ecdsa-*|sk-*) ;;
  *)
    echo "Ceci ne ressemble pas à une clé publique OpenSSH." >&2
    exit 1 ;;
esac

case "$port" in
  ''|*[!0-9]*) echo "Le port de sparkd doit être un entier." >&2; exit 1 ;;
esac

# Le chemin de la garde entre entre les guillemets de « command= » : un chemin
# qui en porte lui-même refermerait l'option et ouvrirait ce qui suit.
case "$garde" in
  ''|*'"'*|*' '*) echo "Le chemin de la garde doit être un chemin simple, sans espace ni guillemet." >&2; exit 1 ;;
esac

# L'ordre des options n'est pas indifférent : « restrict » pose tous les refus,
# et ce qui suit les rouvre un à un. Écrit dans l'autre sens, « restrict »
# annulerait « port-forwarding » (§46.1).
#
# « permitopen="*:22" » et non un motif d'adresse : MESURÉ, OpenSSH n'interprète
# aucun motif sur l'adresse d'un permitopen, et une ligne par Spark ferait
# tomber la console à chaque création (§46.5).
printf 'restrict,port-forwarding,permitopen="127.0.0.1:%s",permitopen="*:22",command="%s" %s\n' \
  "$port" "$garde" "$cle"
