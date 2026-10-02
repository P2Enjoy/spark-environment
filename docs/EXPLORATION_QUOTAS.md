# Exploration — une réservation ET un plafond pour le CPU et la mémoire

**Statut : mesure faite, décision au responsable.** Unité SPK-143, ouverte le
2026-10-01 : « on inspecte la faisabilité sur la VM locale puis on avisera ». Le
disque en est sorti le même jour : « cela reste en dur ».

Ce document n'est pas une spécification. Il consigne ce qui a été **mesuré**,
comment, et ce qui ne l'a pas été, pour que la décision se prenne sur des faits.

---

## 0. Où, comment

- **Où** : la VM du banc de redémarrage (`make forge-vm`, DAT §51.5, §51.6),
  Ubuntu 26.04, Incus de la Forge réelle par le cloud-init du dépôt, 4 CPU,
  5,8 Gio.
- **Comment** : `make forge-vm ARGS="--carte virtio --epreuve mesures-quotas"`
  (`e2e/forge-vm/epreuves/mesures-quotas.mjs`), le 2026-10-01. Une cellule
  **jetable**, lancée par `incus launch` hors du registre — c'est une mesure des
  primitives d'Incus et du noyau, pas du produit. Les valeurs sont lues dans le
  cgroup de la cellule, côté Forge (`/sys/fs/cgroup/lxc.payload.<nom>/`).
- **Charge CPU** : deux boucles occupées dans la cellule, la consommation lue
  sur 5 s dans `cpu.stat`.
- **Pression mémoire** : un programme qui veut 700 Mio d'un coup, borné à 30 s.

## 1. CPU

| Réglage | `cpu.weight` | `cpu.max` | Sous charge (2 boucles) |
|---|---|---|---|
| réservation seule — `limits.cpu.allowance=50%` (le mode `shared`) | 50 | `max` | **2 CPU** — rien ne la limite |
| plafond seul — `limits.cpu.allowance=50ms/100ms` (le mode `capped`) | 100 (défaut) | `50000 100000` | **0,5 CPU** |
| **les deux** — `allowance=50%` + `raw.lxc: lxc.cgroup2.cpu.max=50000 100000` | **50** | **`50000 100000`** | **0,5 CPU** — le plafond tient |

**Ce qui est établi** : Incus n'a pas de clé qui porte une réservation ET un
plafond — `limits.cpu.allowance` est l'un ou l'autre. Mais les deux réglages du
noyau **coexistent** sur une même cellule quand le plafond passe par `raw.lxc`,
et le plafond s'applique.

**Ce qui ne l'est pas** :

- que le **poids** garde son effet sous contention quand un plafond est posé —
  il faudrait deux cellules en concurrence ; le noyau traite les deux réglages
  indépendamment, mais ce n'est pas mesuré ici ;
- la pose **à chaud** : `raw.lxc` ne s'applique qu'au démarrage de la cellule —
  changer ce plafond demanderait un redémarrage, à moins d'écrire le fichier du
  cgroup en direct, ce qu'Incus ne garderait pas ;
- le coût d'un `raw.lxc` : une clé brute, qu'Incus transmet sans la valider, et
  qu'un projet Incus restreint peut interdire.

## 2. Mémoire

| Réglage | `memory.low` | `memory.high` | `memory.max` | 700 Mio demandés |
|---|---|---|---|---|
| plafond dur — `limits.memory=512MiB`, `enforce=hard` | 0 | `max` | 512 Mio | **tué** par le noyau (code 137, `oom_kill`) |
| « souple » — `enforce=soft` | 0 | 512 Mio | `max` | **freiné jusqu'à l'arrêt** : rien n'aboutit en 30 s, 3 461 événements `high` |
| **les deux** — `enforce=hard` + `raw.lxc: lxc.cgroup2.memory.low=268435456` | **256 Mio** | `max` | **512 Mio** | tué (code 137) — le plafond tient |

**Ce qui est établi** :

- un **plancher garanti** (`memory.low`) et un **plafond** (`memory.max`)
  coexistent sur une même cellule, le plancher passant par `raw.lxc` ;
- le mode **« souple » d'Incus n'est pas une réserve qui déborde** : il pose
  `memory.high`, et une cellule qui le dépasse est **freinée**, pas servie. Sur
  une machine sans swap, le freinage va jusqu'au blocage. Le registre porte
  déjà `memory_enforce` (`hard` par défaut, accepté `soft` par l'API de
  création) : ce relevé dit ce que `soft` ferait vraiment.

**Ce qui ne l'est pas** : l'effet du plancher **sous pression de la Forge** —
c'est quand la machine entière manque de mémoire que `memory.low` protège une
cellule de la récupération ; il faudrait saturer la VM pour le voir.

## 3. Ce que le responsable a décidé, le 2026-10-03

1. **CPU** : « mesurer d'abord la concurrence » — SPK-145, avant toute décision
   sur un mode « réservation + plafond ».
2. **Mémoire** : « non, un seul plafond » — pas de plancher garanti.
3. **`memory_enforce=soft`** : « le retirer de l'API » — SPK-146.

## 4. Les questions telles qu'elles ont été posées

1. **CPU** : un mode « réservation + plafond » est techniquement posable
   (`raw.lxc`), au prix d'un redémarrage pour changer le plafond et d'une clé
   brute. Le veut-on, et faut-il d'abord mesurer le poids sous contention ?
2. **Mémoire** : un « plancher garanti + plafond » est posable de même. Utile
   seulement si l'on surengage la mémoire de la Forge (`overcommit_memory > 1`) :
   sans surengagement, la somme des plafonds tient déjà dans la machine, et le
   plancher ne protège de rien. Le veut-on ?
3. **`memory_enforce=soft`** : il fige une cellule plutôt que de la laisser
   déborder. Faut-il le retirer de l'API de création, ou le dire là où il se
   choisit ?
