#!/usr/bin/env bash
# Cree le pool de stockage d'une Forge, dans l'une des DEUX dispositions.
#
# @spec docs/BACKLOG.md#SPK-28 · docs/DAT.md §8.5 (les deux dispositions),
#       §8.5 bis (aucune valeur codee en dur), §8.6 (la disposition visee) ·
#       README.md · docs/PROD_MIGRATIONS.md
#
# Ce script CREE. La verification est ailleurs, en lecture seule (§31.3) :
#
#     /opt/sparkd/venv/bin/python -m sparkd.preflight
#
# Il est IDEMPOTENT : si le pool existe deja, il ne le touche pas et le dit.
# Recreer « au cas ou » detruirait les Sparks qui vivent dessus.
set -euo pipefail

NOM="${SPARK_POOL_NAME:-spark}"
PILOTE="${SPARK_POOL_DRIVER:-zfs}"
SOURCE="${SPARK_POOL_SOURCE:-}"
TAILLE="${SPARK_POOL_FILE_SIZE:-200GiB}"

if [ "$(id -u)" -ne 0 ]; then
  echo "creer-pool.sh doit etre lance en root." >&2
  exit 2
fi

if ! command -v incus >/dev/null 2>&1; then
  echo "incus est absent : installez-le avant de creer un pool." >&2
  exit 2
fi

# --- Le pool existe deja ----------------------------------------------------
# Le silence serait pire que le refus : on ne saurait pas si le pool en place
# est celui qu'on voulait.
if incus storage show "$NOM" >/dev/null 2>&1; then
  echo "Le pool « $NOM » existe deja. Rien n'est touche."
  incus storage show "$NOM" | sed -n '1,12p'
  exit 0
fi

# --- Disposition A : miroir natif sur peripheriques dedies ------------------
if [ -n "$SOURCE" ]; then
  IFS=',' read -r -a PERIPHERIQUES <<< "$SOURCE"
  if [ "${#PERIPHERIQUES[@]}" -lt 2 ]; then
    echo "SPARK_POOL_SOURCE nomme ${#PERIPHERIQUES[@]} peripherique(s)." >&2
    echo "Un miroir en exige DEUX : sans miroir, ZFS detecte la corruption" >&2
    echo "silencieuse mais ne la repare pas (docs/DAT.md §8.5)." >&2
    exit 2
  fi

  # On REFUSE d'ecrire sur un peripherique non vide, plutot que de le constater
  # apres (§8.5 bis). `wipefs` ne modifie rien sans `-a` : il LIT les signatures.
  for p in "${PERIPHERIQUES[@]}"; do
    if [ ! -b "$p" ]; then
      echo "« $p » n'est pas un peripherique bloc." >&2
      exit 2
    fi
    if [ -n "$(wipefs --noheadings "$p" 2>/dev/null)" ]; then
      echo "« $p » porte deja un systeme de fichiers ou une table :" >&2
      wipefs "$p" >&2
      echo "Creer le pool dessus DETRUIRAIT ces donnees. Refus." >&2
      echo "Effacez-le deliberement si c'est bien ce que vous voulez." >&2
      exit 2
    fi
  done

  echo "== Pool « $NOM », disposition NATIVE en miroir =="
  echo "   pilote      : $PILOTE"
  echo "   miroir sur  : ${PERIPHERIQUES[*]}"
  incus storage create "$NOM" "$PILOTE" source="mirror ${PERIPHERIQUES[*]}"
  echo "Cree. ZFS gere le miroir : la corruption silencieuse est detectee ET reparee."
  exit 0
fi

# --- Disposition B : pool sur fichier ---------------------------------------
echo "== Pool « $NOM », disposition SUR FICHIER =="
echo "   pilote : $PILOTE"
echo "   taille : $TAILLE"
incus storage create "$NOM" "$PILOTE" size="$TAILLE"
echo "Cree. Quotas, copie sur ecriture et instantanes actifs."
echo "A savoir : le miroir reste gere par ce qui est dessous, donc la corruption"
echo "silencieuse n'est PAS couverte (docs/DAT.md §8.5)."
