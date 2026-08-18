# JOURNAL

Trace chronologique des décisions et investigations significatives.

---

## 2026-08-18 — Récupération de l'idée fondatrice et pose du socle

### Problème

Le dépôt `spark-environment` ne contenait que `CLAUDE.md`, un `docs/DESIGN_SYSTEM.md`,
un `docs/CloudWorker.md` recopié d'un autre projet et un `README.md` décrivant
`ollama.cpp`, sans rapport. L'idée du produit n'existait que dans une conversation
ChatGPT partagée par un lien.

### Observations

- Le lien de partage ne rend rien d'exploitable par une simple récupération HTTP :
  la page est une application cliente. Le contenu a été extrait de la charge utile
  turbo-stream embarquée dans la page, puis reconstruit par résolution des
  références d'index. 59 nœuds, 9 messages utiles.
- La conversation contient l'intégralité du modèle produit : la notion de Spark,
  le refus de Docker comme frontière d'isolation, le choix d'Incus, les modes CPU,
  l'ingress Caddy, le plan d'administration par tunnel SSH.

### Décision

Persister la transcription **verbatim** dans `docs/ORIGIN_CONVERSATION.md` avant
toute autre chose. Une idée fondatrice ne doit pas dépendre d'une URL externe qui
peut être révoquée.

Les faits techniques cités dans la conversation ont été **revérifiés directement**
dans la documentation Incus `main` le 2026-08-18, plutôt que repris de confiance :

- `limits.cpu` — « A number or a specific range of CPUs to expose to the instance. »
- `limits.cpu.allowance` — « specify either a percentage (`50%`) for a soft limit
  or a chunk of time (`25ms/100ms`) for a hard limit. »
- `limits.cpu.priority` — entier 0–10, arbitrage sous surengagement.
- `limits.memory.enforce` — `hard` ou `soft`, `soft` autorisant le dépassement
  quand l'hôte a de la mémoire disponible.
- `security.nesting` — bool, modifiable à chaud pour les conteneurs.
- `security.idmap.isolated` — « the idmap used for this instance is unique among
  instances that have this option set », conteneurs non privilégiés.
- NIC : `limits.ingress`, `limits.egress`, `limits.max`, `limits.priority`, en
  bit/s, pris en charge par les NIC `bridged`, `ovn` et `routed`.
- Disque : `size` « only supported for the `rootfs` (`/`) », `limits.read`,
  `limits.write`, `limits.max` en byte/s et/ou IOPS.
- `cloud-init.user-data` pour l'injection à l'initialisation.

Un écart avec la conversation : `cloud-init.ssh-keys` n'apparaît pas dans la page
de référence des options d'instance. **Décision** : l'injection des clés passe par
`cloud-init.user-data`, qui est documenté pour toutes les versions et couvre le
besoin. La question est close, pas laissée ouverte.

### Conséquences

- `docs/DAT.md`, `docs/SCHEMA.md`, `docs/BACKLOG.md` écrits et committés avant tout
  code, conformément à `CLAUDE.md` §5.
- Le DAT §13 liste sept hypothèses **non vérifiées** qui ne seront pas présentées
  comme acquises tant qu'une mesure sur l'hôte cible ne les aura pas tranchées.

---

## 2026-08-18 — Sémantique de la réservation CPU

### Problème

`limits.cpu.allowance` en pourcentage est une limite *souple* : c'est une part
relative entre instances partageant les mêmes CPU. Un poids relatif ne garantit
rien dans l'absolu. Or le produit vend « 0,5 CPU ».

### Solutions envisagées

1. Quota temporel dur (`50ms/100ms`) pour tous les Sparks. Garantit le plafond,
   mais interdit le burst et gaspille la capacité inutilisée — c'est exactement ce
   que le responsable voulait éviter.
2. Poids relatif seul. Autorise le burst, mais ne garantit rien sous contention.
3. Poids relatif **plus** admission control dans le registre.

### Décision

Option 3. La garantie n'est pas produite par le noyau mais par la comptabilité :

```
Σ réservations(Sparks partagés) ≤ capacité(pool partagé) × facteur_surengagement
```

Sous cet invariant, et avec un poids proportionnel à la réservation, un Spark
obtient au moins sa réservation en contention totale. Le surengagement devient un
réglage explicite au lieu d'un effet de bord.

Le mode `capped` reste disponible pour qui veut un plafond dur sans burst.

### Vérification à faire

La correspondance exacte pourcentage → poids d'ordonnancement dans Incus n'a pas
été lue dans le code source. Elle doit être mesurée par un test de contention
réel sur l'hôte (SPK-27, point 1). Tant que cette mesure n'existe pas,
l'invariant est un raisonnement, pas une preuve.

---

## 2026-08-18 — Réseau : ce qui est garanti et ce qui ne l'est pas

Les primitives NIC d'Incus n'offrent qu'un **plafond** de débit. Il n'existe pas
de réservation garantie de bande passante à ce niveau.

Décision : conserver `network.reservation` comme grandeur de comptabilité pour
l'admission control, et n'appliquer au NIC que `network.burst` via `limits.max`.
La console doit afficher cette différence explicitement plutôt que laisser croire
à une garantie. Toute autre présentation serait un succès simulé.

---

## 2026-08-18 — Langages du monorepo

`CLAUDE.md` §3 fixe Python pour les services backend et React/Vite pour l'interface.
La conversation d'origine suggérait « un très petit démon Go ou Rust » pour `sparkd`.

Décision : suivre la convention maison. Le travail réel de `sparkd` est de
l'orchestration de processus, de la comptabilité SQLite et du HTTP local ; rien
n'y est sensible à la latence au point de justifier l'écart. Le contrat d'API
partagé rend un remplacement ultérieur possible sans toucher à la console.

L'hôte local de la console reste en TypeScript avec la SPA, pour une seule chaîne
d'outillage et une seule commande de lancement côté poste.

---

## 2026-08-18 — Relevé de l'hôte cible

### Observations

Accès SSH obtenu sur `ubuntu@51.158.54.202` (`spark-experiment`), `sudo` sans mot
de passe. Relevé :

```
Machine    Dell PowerEdge R320
CPU        Xeon E5-1410 v2 @ 2.80 GHz — 1 socket, 4 cœurs, 8 threads
           frères SMT : cpu(0,4) cpu(1,5) cpu(2,6) cpu(3,7)
           1 nœud NUMA — VT-x présent
RAM        98 810 556 kio ≈ 94 Gio, 4 × 16 Gio DDR3-1600, aucun swap actif
DISQUES    2 × Toshiba MG08ADA600E 6 To, 7200 tr/min, ROTA=1
           md0 511 Mio → /boot ; md1 5,44 Tio ext4 → /
           md1 en resynchronisation : 3,1 %, ~469 min restantes
RÉSEAU     eno1 up 1000 Mbit/s ; eno2 down
SYSTÈME    Ubuntu 24.04.3, noyau 6.8.0-88, cgroup v2
PAQUETS    incus 6.0.0-1ubuntu0.3 et zfsutils-linux 2.2.2 disponibles
           btrfs-progs installé ; docker, caddy, incus, zfs absents
```

### Deux constats qui changent la spécification

**Le frèrage SMT est `(0,4)`, pas `(0,1)`.** La règle du DAT §7.5 — allouer des
cœurs physiques entiers, frères inclus — était un raisonnement ; elle est
maintenant confirmée par la mesure. Sur cette machine, `dedicated: 1 core` doit
produire `limits.cpu=0,4`. Un `limits.cpu=0` n'aurait donné aucune exclusivité.

**Les pools réels sont plus petits que ceux de la conversation d'origine.** 94 Gio
au lieu de 256, 1 Gbit/s au lieu de 3, 5,4 Tio au lieu de 6 To, et surtout
**4 cœurs physiques**. Dédier un cœur coûte donc 25 % de la machine : le mode
partagé n'est pas un défaut commode, c'est le seul mode raisonnable ici, et
`dedicated` devient une exception à justifier. Le DAT et le README sont corrigés en
conséquence.

### Conséquences

SPK-02 passe à `[~]` : il ne reste que `incus info --resources`, qui exige Incus
installé. Le blocage humain est levé et la mention correspondante est retirée du
dépôt.

---

## 2026-08-18 — ZFS : la question posée n'était pas la bonne

### Problème

Le responsable met en doute l'utilité de ZFS, au motif que « toutes nos
applications ont déjà un ordonnanceur interne qui sauvegarde vers un S3 externe ».

### Observation

L'objection porte sur la sauvegarde, or ce n'est pas la fonction pour laquelle le
pool de stockage était retenu. Ses trois fonctions réelles sont :

1. **appliquer les quotas** — c'est la promesse « 10 Gio pris sur 5,4 Tio ». Sans
   pilote capable de quota, un Spark remplit le système de fichiers et emporte tous
   les autres ;
2. **cloner l'image de base à coût nul** — sans copie sur écriture, trente Sparks
   sont trente rootfs complets, sur des disques **mécaniques** : la création passe de
   quelques secondes à plusieurs minutes ;
3. **revenir en arrière sur la cellule entière** — système, images Docker, Compose,
   volumes, configuration.

Une sauvegarde applicative vers S3 protège les **données de l'application**. Elle
ne restaure ni le système du Spark, ni ses images, ni sa configuration. Les deux
mécanismes ne protègent pas la même chose et ne se substituent pas.

Relevé dans la documentation Incus : le pilote `dir` n'offre de quota que sur
ext4/XFS avec quotas de projet activés au niveau du système de fichiers, et n'a ni
copie sur écriture, ni clonage instantané, ni instantané optimisé. Il est écarté
sur disque mécanique.

### Décision

Le besoin d'un pool à quotas et à copie sur écriture est **confirmé**. Ce que la
sauvegarde externe rend effectivement superflu est retiré du périmètre : la
planification d'`incus export` comme voie de reprise, et toute réplication
`send`/`receive`. SPK-13 est réduit aux instantanés locaux.

Pilote retenu : **ZFS, en miroir natif**. Motifs : `refquota` exact, chemin le plus
éprouvé d'Incus, et sommes de contrôle avec réparation — sur des disques de 6 To
mécaniques, `md` RAID1 détecte une divergence mais ignore laquelle des deux copies
est la bonne, là où ZFS le sait. L'ARC transforme en outre 94 Gio de RAM en cache
de lecture devant du 7200 tr/min.

Contrepartie identifiée, et c'est la plus importante : **l'ARC consomme de la RAM
en dehors du registre**. Par défaut il peut prendre jusqu'à la moitié de la mémoire,
que l'admission control croirait allouable. `zfs_arc_max` sera donc posé
explicitement et sa valeur soustraite via `host.memory_reserve_bytes`. Un pool
mémoire qui ignore l'ARC promet ce qu'il n'a pas. Ajouté au DAT §13 comme septième
vérification.

Repli documenté : **btrfs** en `raid1`, dans le noyau et déjà installé, au prix
d'une comptabilité par `qgroups` dont le coût croît avec le nombre d'instantanés —
c'est-à-dire sur le mécanisme même dont dépend la promesse de quota.

### Conséquence bloquante

Les deux disques sont intégralement consommés par `md1`. Aucun périphérique bloc
n'est libre : un pool natif exige un repartitionnement, et `resize2fs` ne réduit pas
un système de fichiers racine monté. Deux voies possibles, réinstallation avec
partitionnement personnalisé ou réduction en mode rescue. Sur une machine vide
— 2,7 Go utilisés — la réinstallation est la voie la **moins** risquée. La décision
appartient au responsable : unité SPK-28.
