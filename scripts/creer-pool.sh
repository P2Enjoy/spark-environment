#!/usr/bin/env bash
# Cree le pool de stockage d'une Forge : un miroir ZFS natif, et rien d'autre.
#
# @spec docs/BACKLOG.md#SPK-28 · docs/DAT.md §8.5 (UNE disposition, revise le
#       2026-09-02), §8.5 bis (aucune valeur codee en dur), §8.6 (le schema de
#       partitionnement) · README.md · docs/PROD_MIGRATIONS.md
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

# --- Le miroir natif, seule disposition (DAT §8.5 revise le 2026-09-02) -----
#
# SPARK_POOL_SOURCE est OBLIGATOIRE. Vide, ce script creait autrefois un pool sur
# fichier : cette disposition est retiree, parce qu'elle n'apportait pas la
# protection contre la corruption silencieuse que le pool existe pour donner.
# Un defaut qui bascule en silence vers une disposition retiree serait exactement
# ce que le §8.5 bis interdit.
if [ -z "$SOURCE" ]; then
  echo "SPARK_POOL_SOURCE est obligatoire : nommez les DEUX supports du miroir." >&2
  echo "Exemple : SPARK_POOL_SOURCE=/dev/sda5,/dev/sdb5" >&2
  echo "Une Forge exige deux disques (docs/DAT.md §8.5). Il n'y a plus de pool" >&2
  echo "sur fichier : le remede est en amont, commander la machine partitionnee" >&2
  echo "selon le schema du README, ou lui ajouter un disque." >&2
  exit 2
fi

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

echo "== Pool « $NOM », miroir ZFS natif =="
echo "   pilote      : $PILOTE"
echo "   miroir sur  : ${PERIPHERIQUES[*]}"
incus storage create "$NOM" "$PILOTE" source="mirror ${PERIPHERIQUES[*]}"
echo "Cree. ZFS gere le miroir : la corruption silencieuse est detectee ET reparee."
