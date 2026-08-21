#!/bin/sh
# @spec docs/BACKLOG.md#SPK-61 · docs/DAT.md §46 (la clé restreinte du
#       responsable), §46.1 (« restrict » est un faux ami), §46.3 (le dépannage
#       est le seul chemin que « command= » casse), §46.4 (ce que la garde
#       accepte, et ce qu'elle refuse) · §37.3 (le dépannage par « incus exec »)
#       · docs/DAT.md §45.3 (le préalable qui décide de tout)
#
# La garde posée en « command= » sur la clé d'accès du responsable.
#
# MESURÉ le 2026-08-21 (§46.1) : « restrict » ne désactive PAS l'exécution d'une
# commande. Une clé restreinte au seul sens de « restrict » lit encore tout le
# registre de la Forge. Seul « command= » ferme cette porte — et il la ferme
# aussi pour le dépannage du §37.3, qui est une session avec commande. Cette
# garde est la seule voie qui préserve les quatre chemins du produit.
#
# Le tunnel (§22) et le rebond (§37.2) ne passent PAS ici : ce sont des canaux
# « direct-tcpip », auxquels « command= » ne s'applique pas. MESURÉ.
#
# CONTRAT FERMÉ : on n'accepte que des formes ÉNUMÉRÉES. Filtrer par motifs
# interdits laisserait passer ce qu'on n'a pas prévu ; énumérer laisse passer
# trop peu — ce qui se voit et se corrige — plutôt que trop, ce qui ne se voit
# pas.
#
# Ce que cette garde n'est PAS : une frontière contre qui détient déjà « root »
# sur la Forge. Le §35.1 l'assume pour la protection, le §45.2 pour le poste
# compromis. Elle réduit ce qu'une clé volée donne ; elle ne rend pas la Forge
# inviolable.

set -eu
# Sans « -f », l'expansion de « $SSH_ORIGINAL_COMMAND » ci-dessous ferait du
# GLOBBING : « incus exec * -- /bin/bash » se développerait sur les fichiers du
# répertoire courant, et la garde validerait des mots qu'on ne lui a pas envoyés.
set -f

#: Les shells que le §37.3 lance réellement. La liste est FERMÉE, et une preuve
#: garde qu'elle coïncide avec ce que la console demande — les laisser diverger
#: rendrait le dépannage inutilisable le jour où l'un des deux change.
SHELLS_ADMIS='/bin/bash'

#: Longueur maximale d'un nom de Spark (« sparkd.sparks.NAME »).
NOM_MAX=63

# Le refus est BAVARD vers l'exploitant de la Forge et MUET vers le client :
# décrire la grammaire acceptée à qui n'y a pas droit lui apprend à la
# contourner. Le détail part au journal système quand « logger » existe ; à
# défaut il est perdu, ce qui est préférable à l'envoyer au client.
refuser() {
  if command -v logger >/dev/null 2>&1; then
    logger -t spark-garde -p auth.warning \
      "refus: ${SSH_ORIGINAL_COMMAND:-<session interactive>}" || true
  fi
  echo "Cette clé n'autorise pas cette commande." >&2
  exit 1
}

# Aucune commande : c'est une demande de SHELL INTERACTIF, et c'est exactement ce
# que l'unité existe pour refuser (§45.3).
[ -n "${SSH_ORIGINAL_COMMAND:-}" ] || refuser

# shellcheck disable=SC2086 # le découpage en mots est VOULU, et « set -f » le borne.
set -- $SSH_ORIGINAL_COMMAND

# La seule forme admise : « incus exec <nom> -- <shell> » (§37.3, § 46.4).
[ $# -eq 5 ] || refuser
[ "$1" = 'incus' ] || refuser
[ "$2" = 'exec' ] || refuser
[ "$4" = '--' ] || refuser

nom=$3
# Le motif de « sparkd.sparks.NAME », vérifié sans dépendance externe : une garde
# lancée à chaque connexion ne doit rien appeler qu'elle puisse ne pas trouver.
case "$nom" in
  '' | -* | *- ) refuser ;;
  *[!a-z0-9-]* ) refuser ;;
esac
[ "${#nom}" -le "$NOM_MAX" ] || refuser

admis=1
for shell in $SHELLS_ADMIS; do
  [ "$5" = "$shell" ] && admis=0
done
[ "$admis" -eq 0 ] || refuser

# Les mots sont validés un à un : on les passe tels quels, jamais réassemblés en
# une chaîne qu'un interpréteur relirait.
exec incus exec "$nom" -- "$5"
