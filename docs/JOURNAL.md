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


---

## 2026-08-18 — Installation d'Incus et première campagne de mesures

### Ce qui a été mis en place

Sur décision du responsable, pool de stockage **sur fichier**, à titre provisoire :

```
incus 6.0.0 + zfsutils-linux 2.2.2 (module chargé)
pool ZFS « spark » → /var/lib/incus/disks/spark.img, 200 Gio creux
bridge « sparkbr0 » → 10.77.0.1/24, NAT actif
profil default → root sur le pool, eth0 sur le bridge
premier Spark « spark-test » → 10.77.0.27
```

Traduction appliquée au Spark de test, telle que la spécifie le DAT §7 :
`security.nesting=true`, `security.idmap.isolated=true`, `limits.cpu=0-7`,
`limits.cpu.allowance=13%`, `limits.cpu.priority=5`, `limits.memory=2GiB`
(`hard`, sans swap), disque racine `size=10GiB`, NIC `limits.max=100Mbit`.

Détail d'outillage à ne pas redécouvrir : `incus init` **lit son YAML sur l'entrée
standard**. Lancé dans un script lui-même acheminé par `ssh … bash -s`, il avale le
script et échoue sur `cannot unmarshal !!str`. Toute invocation d'`incus` dans un
script piloté à distance doit rediriger son entrée : `exec </dev/null` en tête de
script, ou `</dev/null` sur chaque appel.

### Ce que la mesure a confirmé

- **Reconfiguration du cpuset à chaud.** `limits.cpu` de `0-7` à `0-5` sur un Spark
  en marche : `cpuset.cpus` suit immédiatement, l'`uptime` du conteneur progresse
  sans discontinuité (118,77 → 120,05 s), `nproc` interne passe de 8 à 6. La découpe
  dynamique du pool dédié est donc non disruptive — c'était l'hypothèse la plus
  risquée de l'architecture, elle tient.
- **Topologie SMT.** `incus info --resources` rapporte `Core 0 → threads id 0, id 4`,
  exactement comme `/sys`. La règle « allouer des cœurs entiers, frères inclus » est
  validée par la mesure.
- **Cloisonnement des UID/GID.** `volatile.idmap.base=1065536`, table du conteneur
  `0 1065536 65536`.
- **Plafond réseau.** `limits.max=100Mbit` pose une classe `htb` `rate 100Mbit
  ceil 100Mbit` : plafond strict, aucune réservation, comme annoncé.
- **Mémoire.** `memory.max=2147483648`, `memory.swap.max=0`, et lxcfs présente bien
  2 Gio à l'intérieur.
- **Docker dans le Spark.** Docker 29.7.2 et Compose v5.5.0 installés et fonctionnels
  dans un conteneur **non privilégié** à idmap isolé. Docker choisit `overlayfs`
  au-dessus du rootfs ZFS, pilote cgroup `systemd`, cgroup v2, `cgroupns` actif.
  `docker run hello-world` s'exécute.

### Ce que la mesure a infirmé, et qui corrige la spécification

**1. `allowance` et `priority` ne sont pas deux réglages indépendants.** La loi,
établie sur onze points, est :

```
cpu.weight = allowance_pct − 10 + limits.cpu.priority
```

`cpu.max` reste à `max` : le burst est bien réel. Mais présenter la réservation
comme « la part » et la priorité comme « l'arbitrage » était faux — c'est le même
bouton. Le DAT §7.2 bis est corrigé.

**2. La mise à l'échelle du poids était inutilisable.** Sur un pool de 4 CPU,
`réservation / capacité × 100` donne :

```
0,5  CPU → 12,5 % → poids 8
0,25 CPU →  6,25 %→ poids 1     plus aucune résolution
0,2  CPU →  5 %   → poids 0     REFUSÉ : « setting cgroup item for the container failed »
```

Le refus est explicite, ce qui est heureux. `2000 %` étant accepté (poids 1995),
le facteur passe à 1000. Corrigé au DAT §7.2 bis.

**3. L'invariant d'admission control ne garantissait pas ce qu'il prétendait.** Un
Spark n'est pas placé sous un parent qui lui serait réservé : Incus le crée à la
**racine** de cgroup v2, frère des tranches de l'hôte.

```
system.slice             cpu.weight = 100
user.slice               cpu.weight = 100
init.scope               cpu.weight = 100
lxc.monitor.spark-test   cpu.weight = 100
lxc.payload.spark-test   cpu.weight =   8   ← le Spark
```

Un Spark à poids 8 n'obtient donc pas 12,5 % de la machine sous contention, mais
`8 / (8 + 100 + 100 + 100 + …)`. L'admission control assure la proportionnalité
**entre Sparks**, pas la valeur absolue de la réservation. C'est la correction la
plus importante de cette campagne : elle touche la promesse centrale du produit.
Trois voies sont posées au DAT §7.3 bis, la seule qui rende la réservation
littéralement vraie étant de regrouper les Sparks sous un parent unique de poids
maîtrisé. Unité SPK-29 ouverte.

**4. Un Spark qui remplit son quota verrouille son administration.** `backup.yaml`
est écrit par Incus à l'intérieur du jeu de données contingenté :

```
Error: Failed to write backup file: … backup.yaml: disk quota exceeded
```

Toute reconfiguration devient impossible, y compris l'agrandissement qui
débloquerait la situation. Le registre devra poser le quota du jeu de données
au-dessus de la taille vendue, avec une marge de métadonnées invisible du
locataire. Unité SPK-30 ouverte.

### Un test qui ne prouvait rien, et pourquoi il faut le dire

La première vérification du quota écrivait `/dev/zero`. Elle a « réussi » à écrire
**20 Gio dans un Spark limité à 10 Gio** sans être refusée. Le quota n'était pas en
cause : la compression ZFS, active par défaut, avait absorbé les zéros — `used`
restait à 884 Kio. Rejoué avec `/dev/urandom`, le refus tombe exactement à 10 Gio
(`available = 0B`).

Deux enseignements. D'abord, un test qui passe sur des données dégénérées ne prouve
rien : sans le contre-test, cette campagne aurait conclu à un quota inopérant.
Ensuite et surtout, le quota porte sur les octets **stockés**, pas sur les octets
écrits — un Spark à 10 Gio peut contenir bien plus de 10 Gio de données
compressibles. Sémantique à assumer et à documenter, ou compression à désactiver
par jeu de données. Portée au DAT §8.7 et §13, point 13.

### ARC

Le `c_max` par défaut valait **47,12 Gio**, soit la moitié de la RAM — exactement la
collision annoncée avec la comptabilité mémoire. Plafonné à **16 Gio** sur décision
du responsable, les applications hébergées étant petites et liées statiquement, et
persisté dans `/etc/modprobe.d/zfs.conf`. Reste à vérifier en charge que l'ARC
demeure sous ce plafond, et que la valeur est bien soustraite via
`host.memory_reserve_bytes`.


---

## 2026-08-18 — Nesting Docker : un défaut amont, et une leçon sur la montée de version

### Le défaut

Avec Incus 6.0.0, la version des dépôts Ubuntu 24.04, **aucun** conteneur Docker ne
démarre dans un Spark :

```
open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied
```

Isolement de la cause, par élimination :

- le sysctl est **écrivable directement** dans le Spark (`echo 0 > …` réussit), donc
  ce n'est pas une restriction de montage ni de capacité ;
- l'échec touche **tout** conteneur — `nginx:alpine`, `traefik/whoami` — avec ou sans
  publication de port, donc ce n'est pas lié aux ports privilégiés ;
- `--security-opt apparmor=unconfined` **côté Docker** ne change rien, donc le profil
  fautif n'est pas `docker-default` ;
- `lxc.mount.auto=proc:rw sys:rw` ne change rien non plus ;
- rendre le **Spark** `unconfined` fait disparaître cette erreur — la cause est donc
  le profil AppArmor externe, celui qu'Incus applique au Spark.

Cause amont, confirmée par le suivi du projet : depuis le correctif de
CVE-2025-52881, `runc` ≥ 1.3 accède à ses sysctls via un montage procfs détaché, et
AppArmor interprète cet accès à `/proc/sys/...` comme un accès à `/sys/...` et le
refuse. Le défaut est connu, il touche Docker sous LXC/LXD/Incus, et le correctif
est annoncé dans Incus 6.19.

Rendre les Sparks `unconfined` serait un contournement : cela retirerait une couche
de défense qui fait partie du modèle d'isolation. Ce n'est pas la réponse retenue.

### La leçon opérationnelle, apprise dans l'incident

Incus a été porté de 6.0.0 à **7.3** depuis le dépôt amont, **alors qu'un Spark
tournait**. Résultat :

- le Spark est resté « RUNNING » mais `incus exec` a cessé de fonctionner —
  `Failed to retrieve PID of executing child process` ;
- ses `lxc.hook.stop` et `lxc.hook.post-stop` sortaient en 127, les chemins de
  l'ancienne version n'existant plus ;
- `incus stop --force` puis `incus delete --force` restaient bloqués, et l'arrêt du
  démon lui-même s'est figé en `deactivating`, la procédure d'arrêt attendant une
  instance qu'elle ne savait plus piloter.

Il a fallu tuer le démon, démonter les résidus sous `/var/lib/incus`, effacer l'état
et réinitialiser. Le pool ZFS et le bridge ont été recréés ; l'interface `sparkbr0`
avait survécu dans le noyau et empêchait la recréation du réseau tant qu'elle
n'était pas supprimée à la main.

**Conséquence pour le contrat de déploiement** : la version cible d'Incus s'installe
**avant** la création du moindre Spark. Une montée de version majeure ne se fait pas
sous des instances en marche ; elles s'arrêtent d'abord. Cette règle rejoint
`docs/PROD_MIGRATIONS.md`.

Détail à ne pas redécouvrir : une instance conserve le profil AppArmor produit **au
moment de son démarrage**. Redémarrer le démon ne le régénère pas — il faut arrêter
puis redémarrer l'instance.


---

## 2026-08-18 — Nesting Docker prouvé : le contrat central de l'architecture tient

### Résolution

Après remise à zéro de l'état d'Incus et recréation du Spark **sous 7.3**, le nesting
fonctionne, sans aucune concession sur l'isolation :

```
Incus                     7.3
Spark                     non privilégié
security.idmap.isolated   true        uid_map : 0 1065536 65536
AppArmor                  ACTIF       raw.lxc vide, aucun contournement
docker                    29.7.2      compose v5.5.0
docker compose up -d      Container demo-web-1 Started
docker ps                 nginx:alpine  Up  0.0.0.0:8080->80/tcp
curl depuis le Spark      HTTP 200
curl depuis l'HÔTE        HTTP 200    sur 10.77.0.38:8080
Storage Driver            overlayfs   Cgroup Version 2
```

Ce résultat est la **preuve du concept même du produit** : une pile Compose
ordinaire, non modifiée, tourne dans une cellule contingentée et cloisonnée, et se
laisse joindre depuis l'hôte sur son IP privée — c'est-à-dire exactement le point de
raccordement dont Caddy a besoin. La chaîne
`domaine → Spark → port` est donc réalisable telle que spécifiée.

SPK-31 passe à `[x]`. La version minimale d'Incus devient une contrainte de
déploiement : ≥ 6.19 selon l'annonce amont, 7.3 mesurée fonctionnelle, 6.0.0 mesurée
cassée.

### Ce que l'incident de montée de version a coûté, et ce qu'il apprend

Deux règles d'ordre en sont sorties, portées au contrat de déploiement :

1. la version cible d'Incus s'installe **avant** la création du moindre Spark ;
2. un Spark conserve le profil AppArmor produit **à son démarrage** — après une
   montée de version, il faut l'arrêter puis le redémarrer, redémarrer le démon ne
   suffit pas.

Un troisième détail : après réinitialisation, l'interface `sparkbr0` survit dans le
noyau et bloque la recréation du réseau géré tant qu'elle n'est pas supprimée à la
main.

### Deux faux problèmes, écartés

Pour mémoire, afin qu'ils ne soient pas reconsignés comme des défauts du produit :

- les paquets Docker sont restés en état `iU` — dépaquetés, non configurés — parce
  qu'un `apt-get` concurrent tenait le verrou `dpkg` dans le Spark. Le groupe
  `docker` n'était donc pas créé et `docker.socket` échouait sur
  `Failed to resolve group docker`. `dpkg --configure -a`, après libération du
  verrou, suffit. C'est un artefact du harnais de test, pas un fait sur Incus ;
- `incus init` **lit son YAML sur l'entrée standard** : dans un script acheminé par
  `ssh … bash -s`, il avale le script. Tout appel doit rediriger son entrée.
