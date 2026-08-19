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


---

## 2026-08-18 — SPK-01 close : squelette du monorepo et runtime sparkd

**Unité de la session** : SPK-01, première `[~]` du plan comportant du code à
livrer. Sa spécification existait déjà (DAT §10) et couvrait ce qu'il fallait
écrire : elle n'a pas été réécrite.

**Livré.** Espace de travail conforme au DAT §10 — `apps/webui`,
`services/sparkd`, `packages/contract`, `deploy`, `scripts` — avec un `Makefile`
comme point d'entrée reproductible. `services/sparkd` porte du code réel :
`config.py` refuse toute adresse d'écoute routable, `app.py` expose `/healthz` et
`/readyz` distincts, `/readyz` déclarant ses dépendances `unknown` tant que les
pilotes n'existent pas plutôt que d'annoncer une disponibilité que rien ne prouve.

**Vérifié.** 19 tests unitaires verts, dont les refus (`0.0.0.0`, adresse
publique, bridge privé, nom d'hôte, ports malformés). À l'exécution réelle :
`SPARKD_BIND=0.0.0.0:9876` sort en code 2 avec un message exploitable, la boucle
locale sert les deux sondes, et `ss` montre `LISTEN 127.0.0.1:9876` seulement.
Campagne complète verte : `make sparkd-test`, `pnpm -r test`, `pnpm -r build`,
`pnpm -r typecheck`.

**Non vérifié, et nommé comme tel.** La preuve d'écoute a été conduite sur le
poste de développement, pas depuis l'extérieur du serveur cible : elle ne dit
donc rien de la surface réseau réelle de l'hôte. SPK-07 passe à `[~]` avec ce
reste explicite.

**Écarté à dessein.** `apps/webui` et `packages/contract` sont déclarés sans
source. `CLAUDE.md` §4 impose la lecture intégrale de `docs/DESIGN_SYSTEM.md`
avant toute écriture d'interface ; cette lecture appartient à l'unité qui
construit l'interface, pas au squelette. Poser des composants d'attente aurait
livré un écran que personne n'a spécifié.

**Corrigé au passage.** Le `.gitignore` était un gabarit C++ hérité d'un autre
projet et ignorait `Makefile` : il aurait silencieusement écarté le point
d'entrée du dépôt. Remplacé par un fichier adapté au monorepo.

**Où reprendre.** SPK-03 — installation d'Incus, du pool et du bridge sur
l'hôte — est déjà faite en pratique sur le serveur de validation et attend d'être
consignée comme telle. La prochaine unité de construction est **SPK-04**,
migrations et registre SQLite, dont la spécification existe (`docs/SCHEMA.md`) et
qui ne dépend d'aucune décision en attente. SPK-28, le repartitionnement, reste
suspendu à un arbitrage du responsable.


---

## 2026-08-18 — SPK-04 close : registre SQLite, migrations et vérification au démarrage

**Unité** : SPK-04, désignée par l'entrée précédente. Sa spécification existait
(`docs/SCHEMA.md`) et n'a pas été réécrite ; seule la **mécanique** des
migrations manquait — nommage des fichiers, séparation `up`/`down`, checksum,
transaction, refus au démarrage, pragmas — et a été ajoutée en §12 puis
committée avant la première ligne de code.

**Livré.** `migrations/001_socle_registre.sql` crée les douze tables. Les règles
du modèle sont portées par la base et pas seulement écrites : cohérence des
quatre modes CPU, unicité du domaine, un cœur dédié n'appartenant qu'à un seul
Spark, rafale jamais inférieure à la réservation, et refus d'une clé privée dans
`ssh_key`. Le moteur (`migrations.py`) applique, vérifie et redescend ; le point
d'entrée migre avant d'ouvrir le port et sort en code 3 si le registre a dérivé.

**Défaut trouvé par les tests, corrigé à la cause.** `sqlite3.executescript`
**valide implicitement la transaction en cours**. Une migration lancée à travers
lui n'aurait donc pas été atomique, contrairement à ce que §12.3 exige : une
erreur au milieu aurait laissé les instructions précédentes committées, et le
schéma à moitié migré sans trace. Le découpage passe désormais par
`sqlite3.complete_statement`, qui s'appuie sur l'analyseur lexical de SQLite
plutôt que sur un découpage au point-virgule — lequel casserait sur un `;` dans
une chaîne ou un trigger. À retenir : la garantie d'atomicité de ce moteur tient
à ce détail.

**Preuve révisée, pas contournée.** `test_readyz_ne_pretend_pas_etre_pret`
exigeait que toutes les dépendances soient `unknown`. Le registre existant
désormais, continuer à le déclarer inconnu serait le mensonge que ce test
cherche à empêcher. Le motif est écrit dans le fichier de test.

**Vérifié.** 59 tests verts. Au démarrage réel : création et migration au premier
lancement, rien de rejoué au second, et sortie en code 3 sur checksum falsifié.
Campagne complète verte.

**Où reprendre.** **SPK-05**, admission control et comptabilité des pools, dont
la spécification existe (`docs/DAT.md` §7.3 et §7.3 bis) et qui s'appuie
directement sur les tables `host`, `cpu_core` et `spark` livrées ici. Attention :
le DAT §7.3 bis établit que la réservation n'est proportionnelle qu'entre Sparks
et pas absolue — l'admission control doit être écrit en le sachant, et SPK-29
reste ouverte. SPK-28 reste suspendue à un arbitrage du responsable.


---

## 2026-08-18 — SPK-05 : admission control livré, mais sans appelant

**Unité** : SPK-05, désignée par l'entrée précédente. Sa spécification existait
(`docs/DAT.md` §7.3 et §7.3 bis). Deux points que le code ne pouvait pas deviner
manquaient et ont été ajoutés en §7.7 puis committés avant la première ligne de
code : ce que consomme chaque mode CPU, et quels états de Spark comptent.

**Deux décisions qui méritent d'être retenues.**

`capped` consomme son **plafond**, pas zéro. Un Spark plafonné à 0,5 CPU peut
réellement consommer 0,5 CPU en permanence ; ne pas le provisionner reviendrait à
distribuer une capacité déjà prise. C'est le seul mode où la grandeur comptée
n'est pas une réservation.

**Tous les états comptent**, `stopped`, `error` et `deleting` compris. Un Spark
arrêté garde son disque, un Spark en erreur sera repris. Traiter l'un de ces
états comme de la capacité libre ferait admettre un nouveau Spark dans une place
qu'un simple redémarrage reprendrait — et le refus tomberait alors au pire
moment, sur le Spark qui existait déjà.

**Livré.** `admission.py` : photographie des pools (capacité, alloué,
disponible), et décision motivée. Le refus nomme **toutes** les ressources
fautives, avec demandé, restant, alloué et surengagement. Un Spark dédié est
refusé s'il asphyxierait les Sparks partagés déjà admis — retirer des cœurs
réduit le pool pour tout le monde.

**Vérifié.** 84 tests verts, dont 25 dédiés à cette unité. Campagne complète
verte.

**Non vérifié, et c'est pourquoi SPK-05 reste `[~]`.** Le module n'a **aucun
appelant** : ni HTTP, ni console. Rien ne le prouve depuis un parcours réel, et
un admission control jamais appelé ne protège rien. L'exposition appartient à
SPK-07, son usage à SPK-09.

**Où reprendre.** **SPK-07**, `sparkd` : inventaire de l'hôte. Elle est déjà
`[~]`, elle donne son appelant à l'admission control, et elle porte la dette
explicite d'une preuve d'écoute conduite depuis l'extérieur du serveur. Elle a
besoin de peupler la table `host` depuis `incus info --resources`, ce que le
serveur de validation permet déjà. SPK-28 reste suspendue à un arbitrage.


---

## 2026-08-18 — SPK-07 close : inventaire de l'hôte, prouvé sur la machine réelle

**Unité** : SPK-07, désignée par l'entrée précédente. Spécification complétée
avant de coder, **après mesure sur l'hôte** : DAT §5.1 à §5.3.

**Livré.** `sparkd` parle à Incus par l'API REST sur la socket Unix, jamais en
lançant le binaire. `POST /v1/host/sync` relève la topologie et la trace ;
`GET /v1/host` expose les pools. L'admission control livré en SPK-05 a enfin un
appelant.

**Prouvé sur l'hôte réel** — `spark-experiment`, Incus 7.3 : 4 cœurs / 8 threads,
frères `(0,4) (1,5) (2,6) (3,7)` écrits dans le registre, 105 226 698 752 octets
de RAM, 1 Gbit/s, 207 030 845 440 octets pour le pool. Et surtout, **le scan
depuis l'extérieur**, la dette explicite que portait cette unité : pendant que le
service tournait et servait sur `127.0.0.1:9876`, le port est **refusé** depuis le
poste de développement, comme `8443`, `2019`, `80` et `443`. Seul `22` est ouvert.

**Quatre défauts, tous invisibles en local, tous révélés par le déploiement.**
C'est l'enseignement de la session : une suite verte sur le poste de
développement ne dit rien de ce qui s'installe.

1. **`httpx` déclaré en dépendance de développement** alors que le client Incus
   l'importe au runtime. Indétectable en local, où pytest l'installe de toute
   façon.
2. **Les migrations ne suivaient pas l'installation.** Les fichiers SQL vivaient
   à côté du paquet ; installés, ils disparaissaient. Ils vivent désormais dans
   `src/sparkd/schema/`, déclarés en `package-data`.
3. **`discover` rendait une liste vide quand le dossier manquait.** C'est la
   pire forme d'échec : `sparkd` démarrait « normalement », puis chaque requête
   renvoyait 500 sans que rien ne désigne la cause. Un dossier absent est une
   erreur d'installation, désormais signalée comme telle.
4. **`/1.0/resources` ne porte aucun nom d'hôte.** Sa clé `system` décrit le
   matériel — châssis, micrologiciel, numéros de série. Le relevé rendait
   « inconnu ». Le nom vient de `/1.0`. Les numéros de série ne sont ni stockés
   ni journalisés.

**Deux défauts trouvés par les tests, corrigés à la cause.** Une connexion SQLite
est liée à son thread et FastAPI sert les gestionnaires synchrones dans un pool
de threads : la connexion partagée sur `app.state` cassait au premier appel. Le
partage est supprimé — une connexion par requête — plutôt que rendu tolérable.
Et `create_app` supposait des tables que seul le point d'entrée créait : la
responsabilité était coupée en deux et l'application inutilisable seule.

**Vérifié.** 103 tests verts, campagne complète verte, et les preuves sur hôte
réel ci-dessus.

**Où reprendre.** **SPK-08**, pilote Incus : traduction du manifeste Spark. Sa
spécification est écrite et mesurée (DAT §7.2, §7.2 bis, §7.7), le client Incus
et le registre existent, et la loi `cpu.weight = pct − 10 + priorité` est établie.
C'est l'unité qui rend un Spark réellement créable. SPK-29 et SPK-28 restent
ouvertes.


---

## 2026-08-18 — SPK-08 close : le manifeste Spark se traduit, et la traduction tient

**Unité** : SPK-08, désignée par l'entrée précédente. Spécification complétée
après mesure — DAT §7.2 ter — puis committée avant la première ligne de code.

**Ce que la mesure a imposé.** Incus refuse ce qui n'est pas entier :
`limits.cpu.allowance = 62.5%` échoue sur `strconv.Atoi`, `0.5ms/100ms` est
rejeté, et `1%` fait échouer la pose du cgroup. Les bornes `0..10` de la priorité
sont confirmées. D'où un plancher `allowance_pct ≥ 11 − priorité`, soit 6 % à la
priorité par défaut.

Le principe retenu, et appliqué partout dans le traducteur : **quand une valeur
ne peut pas être rendue fidèlement, on refuse au lieu d'approximer**. Arrondir
une réservation trop petite vers le haut donnerait au Spark davantage que ce qui
lui a été comptabilisé, et l'invariant du §7.3 cesserait d'être vrai.

**Livré.** `translate.py` transforme le vocabulaire du produit en celui d'Incus :
quatre modes CPU, mémoire, réseau, stockage, `security.nesting` et
`security.idmap.isolated` toujours posés, `security.privileged` jamais. Le module
ne parle à personne — c'est ce qui le rend éprouvable sans hôte.

**Le défaut que seule l'application réelle pouvait trouver.**
`limits.disk.priority` est une option **d'instance**, pas de périphérique. Posée
sur le disque, Incus rejette `Invalid device option` — et comme l'override d'un
périphérique est **atomique**, le quota `size` du même appel ne s'appliquait pas
non plus. Le Spark repartait avec le pool entier, 193 Gio au lieu de 10, sans que
rien ne le signale. Aucun test sur pilote factice ne pouvait le voir : c'est
précisément la raison d'être de la seconde moitié de la Definition of Done.

**Vérifié sur l'hôte.** `incus config show` rend exactement la configuration
produite. Le noyau applique `cpu.weight = 120`, soit `125 − 10 + 5` — la loi
mesurée se vérifie de bout en bout, du manifeste au cgroup. `cpu.max = max`, donc
le burst est réel. Le locataire voit 2 Gio de RAM et 10 Gio de disque, et l'idmap
du Spark (`1131072`) est disjoint de celui de son voisin (`1065536`) : le
cloisonnement des UID est visible, pas seulement déclaré.

135 tests verts, campagne complète verte.

**Où reprendre.** **SPK-09**, cycle de vie : create, start, stop, restart,
delete. Tout ce dont elle a besoin existe — registre, admission control,
inventaire, traducteur. C'est l'unité qui relie enfin ces pièces en un geste
utilisateur : créer un Spark. Elle appellera l'admission control avant d'écrire,
ce qui lèvera la réserve de SPK-05. SPK-06 (choix des cœurs dédiés), SPK-29 et
SPK-28 restent ouvertes.


---

## 2026-08-19 — SPK-09 close : un Spark se crée, tourne et se rend

**Unité** : SPK-09. Son entrée de backlog ne citait aucune spécification, et les
**transitions** n'étaient écrites nulle part — seuls les états l'étaient. Le
DAT §14 a donc été écrit et committé avant la première ligne de code.

**Prouvé de bout en bout sur l'hôte réel**, par HTTP : création → `pending`,
`apply` → instance Incus créée, `start` → `running` avec `10.77.0.138` sur le
bridge privé, `stop`, `delete` → instance disparue et **capacité intégralement
rendue** (`alloué=0`, `dispo=4.0`). Le noyau applique `cpu.weight=120`,
`memory.max=2 Gio` ; le locataire voit 2 Gio de RAM et 10 Gio de disque.

**SPK-05 est close du même coup.** L'admission control avait été livré sans
appelant ; il en a un désormais, et le refus a été prouvé sur la machine :
« 9 CPU demandés, 3.5 disponibles (capacité 4, alloué 0.5) — il manque 5.5 CPU »,
en `409`, journalisé.

**Deux décisions de conception qui méritent d'être retenues.**

Le registre s'écrit **avant** Incus, et l'ordre n'est pas symétrique. Mourir
entre les deux laisse au pire une ligne sans instance : le registre surestime
l'occupation, ce qui est visible et réconciliable. L'inverse laisserait une
instance sans ligne, consommant des ressources réelles que la comptabilité
ignore — et le refus tomberait plus tard sur un locataire innocent. Entre
surestimer et sous-estimer, on surestime toujours.

Un redémarrage n'est pas un état : c'est `running → stopping → stopped →
starting → running`. Le modéliser autrement cacherait la fenêtre pendant
laquelle le Spark est réellement arrêté.

**Trois défauts, corrigés à la cause.**

1. **Le refus d'admission était journalisé DANS la transaction**, donc annulé par
   le rollback. La trace disparaissait précisément quand elle sert — et c'est
   exactement ce que le commentaire du code prétendait éviter. Trouvé par les
   tests.
2. **Le client Incus n'attendait pas ses opérations asynchrones.** On aurait
   conclu au succès avant que quoi que ce soit ne soit fait.
3. **`images:` est un raccourci de la ligne de commande, pas un préfixe
   d'alias.** Passé tel quel à l'API, il fait échouer la création. Le traducteur
   sépare désormais dépôt et alias. Défaut invisible en local, révélé par la
   première création réelle.

**Vérifié.** 231 tests verts, campagne complète verte, et le parcours réel
ci-dessus.

**Où reprendre.** **SPK-10**, réseau privé et adressage stable. Les Sparks
obtiennent déjà une IP par DHCP sur `sparkbr0` — `10.77.0.138` ci-dessus — mais
rien ne garantit qu'ils la retrouvent au redémarrage, et le registre ne la
stocke pas encore : `ipv4_address` reste NULL. C'est le préalable de l'ingress
(SPK-12), qui a besoin d'une adresse stable pour pointer dessus. SPK-06, SPK-29
et SPK-28 restent ouvertes.


---

## 2026-08-19 — SPK-10 close : adresse stable et plafond réseau mesuré

**Unité** : SPK-10. Son entrée de backlog ne citait aucune spécification et la
politique d'adressage n'était écrite nulle part. Le DAT §15 a été écrit **après
mesure sur l'hôte**, puis committé avant la première ligne de code.

**Ce que la mesure a établi.** Incus accepte `ipv4.address` sur le périphérique
NIC, inscrit une entrée statique dans son dnsmasq, conserve l'adresse au
redémarrage, et **refuse lui-même un doublon**. `ipv4.dhcp.ranges` restreint la
distribution dynamique : une instance non épinglée reçoit alors `10.77.0.247`,
tandis qu'un Spark épinglé sur `10.77.0.50` — hors plage — garde la sienne.

**Décision.** Le registre attribue, Incus applique. L'ingress a besoin de
l'adresse **avant** que l'instance existe — une route se déclare sur un Spark
encore arrêté —, et laisser Incus attribuer ferait découvrir une collision au
moment de l'application, alors que la ligne est déjà écrite et la capacité
comptabilisée. La vérification d'unicité d'Incus reste une seconde ligne de
défense, pas la première.

L'attribution est **déterministe** : la plus petite adresse libre. Ce n'est pas
une commodité, c'est ce qui la rend prévisible et donc vérifiable — recréer un
Spark dans un parc inchangé rend la même adresse, et les notes de l'exploitant
restent vraies. L'épuisement est refusé en le nommant, jamais contourné en
débordant : déborder recouvrirait la passerelle ou le DHCP, et la panne se
manifesterait très loin de sa cause.

**Les deux moitiés de la DoD, prouvées sur l'hôte.** `10.77.0.16` attribuée avant
toute instance, conservée à travers un redémarrage du Spark et un `incus restart`
direct. Et le plafond réseau **mesuré par transfert réel** — iperf3, 10 s :
95,6 Mbit/s sous un plafond de 100 Mbit/s, puis 478 Mbit/s après relèvement à
500 Mbit/s. Le plafond mord et s'ajuste à chaud.

**Une mesure écartée parce qu'elle ne prouvait rien.** Le premier essai de débit,
avec `nc`, a rendu « 20 Mio en 0,0 s, soit 23 616 Mbit/s ». Ce n'est pas un
résultat, c'est un transfert qui n'a pas eu lieu. Rejoué avec iperf3. À retenir :
un chiffre absurde est plus honnête qu'un chiffre plausible et faux — encore
faut-il le regarder.

**Vérifié.** 252 tests verts, campagne complète verte.

**Où reprendre.** **SPK-12**, ingress Caddy — elle a maintenant ce qui lui
manquait : une adresse privée stable à laquelle adosser une route
`domaine → spark → port`. Caddy n'est pas encore installé sur l'hôte. **SPK-11**
(clés SSH) est l'autre suite naturelle et ne dépend de rien de bloqué. SPK-06,
SPK-29 et SPK-28 restent ouvertes.


---

## 2026-08-19 — SPK-03 close : le registre cesse de promettre l'ARC

**Unité** : SPK-03, première `[ ]` dans l'ordre du plan. Le journal précédent
désignait SPK-12 et SPK-11, mais deux unités les précèdent au plan et §4.2 fait
foi. SPK-03 était presque entière : ne manquait que le report de `zfs_arc_max`
dans `host.memory_reserve_bytes` — et ce « seul » point était un défaut de
comptabilité sur la promesse centrale du produit.

**Le défaut, chiffré.** Le registre annonçait **98,0 Gio allouables avec une
réserve à zéro**, alors que l'ARC ZFS était plafonné à 16 Gio qu'il peut prendre
à tout instant, sans prévenir. Un cinquième du pool était promis en trop.

**Un second écart, découvert en mesurant le premier.** `memory.total` d'Incus est
la RAM **physique** : 105 226 698 752 octets, soit 98,0 Gio de barrettes, quand
`/proc/meminfo` rend `MemTotal` à 94,2 Gio. Les 4 Gio d'écart sont réservés par
le micrologiciel et le noyau — aucun processus ne les obtiendra jamais. Promettre
le total physique, c'est promettre de la mémoire qui n'existe pas. Le registre
retient désormais `MemTotal`.

**Résultat sur l'hôte** : `94,2 − (16 ARC + 2 marge) = 76,2 Gio` réellement
allouables, contre 98,0 annoncés auparavant. L'admission control refuse
maintenant sur la bonne capacité — une demande de 80 Gio est rejetée avec
« 81 854 656 512 disponibles ».

**Trois règles posées, toutes contre une supposition silencieuse.** Un ARC
illisible ne vaut pas zéro : la réserve retombe sur la marge et le relevé est
journalisé en `denied`. Un `zfs_arc_max` à `0` ne vaut pas zéro non plus — ZFS
applique son défaut, la moitié de la RAM, et c'est cette moitié qui est retenue.
Et une réserve qui avale toute la mémoire le **dit**, au lieu d'annoncer
« 0 allouable » sans explication, ce qui ferait chercher le défaut ailleurs
longtemps.

**Deux preuves révisées, non contournées.** « `memory.total` nul fait échouer le
relevé » n'a plus lieu d'être puisque la mémoire ne vient plus d'Incus ; le cas
vérifie désormais que la valeur d'Incus n'influence plus rien. Et la fixture fige
`MemTotal` autant que l'ARC : sans cela les tests mesuraient la RAM et la
présence de ZFS sur la machine qui les exécute, pas le produit.

**Vérifié.** 273 tests verts, campagne complète verte, et le relevé réel
ci-dessus.

**Où reprendre.** **SPK-06**, allocation des cœurs dédiés et découpe dynamique du
pool — désormais la première `[ ]` du plan. Tout ce qu'elle demande est établi :
la topologie et les frères SMT sont dans le registre, la reconfiguration du
cpuset à chaud est mesurée non disruptive, et le traducteur refuse volontairement
de choisir les cœurs en attendant cet ordonnanceur. SPK-29 et SPK-28 restent
ouvertes.


---

## 2026-08-19 — SPK-06 close : le pool de cœurs se découpe et se rend, à chaud

**Unité** : SPK-06, désignée par le journal et première `[ ]` du plan.

**Ce que la spécification laissait implicite, et qui était l'essentiel.** Le §7.4
disait de reconfigurer le cpuset des Sparks partagés. Mais le poids dépend de la
capacité du pool : `allowance_pct = réservation / capacité × 1000`. Retirer des
cœurs change la capacité, donc le pourcentage de chacun. Ne reconfigurer que le
cpuset aurait laissé à chaque Spark un poids calculé pour un pool qui n'existe
plus — une réservation de 0,5 CPU sur un pool passé de 4 à 2 cœurs aurait valu la
moitié de ce qui a été vendu. Le §7.4 bis a été écrit et committé avant de coder.

**Prouvé sur l'hôte, et c'est net.** Un Spark partagé à 0,5 CPU tourne avec
`cpuset 0-7`, poids 120. Découpe de deux cœurs dédiés : le pool tombe à
`CPU 2,3,6,7`, le dédié prend `0,1,4,5` — frères SMT emportés ensemble —, et le
partagé passe à `cpuset 2-3,6-7`, poids **245**, soit `250 %`. Sa réservation
absolue est préservée alors que le pool a été divisé par deux. Restitution :
retour exact à l'état initial. **Aucun redémarrage** dans les deux sens :
`uptime` 8,4 → 16,1 → 20,4 s.

**Une décision d'ordre qui compte.** Rétrécir le pool partagé **avant**
d'épingler le Spark dédié, et libérer **avant** d'élargir à la restitution. Faire
l'inverse ferait brièvement partager les mêmes cœurs entre le dédié et les
partagés — exactement ce que « dédié » promet d'éviter.

**Un refus qui tombe plus tôt qu'attendu, et c'est mieux.** Une preuve postulait
qu'une découpe impossible serait refusée à l'application. En pratique l'admission
control l'attrape dès la **création** : l'exploitant est refusé avant qu'une
ligne soit écrite, plutôt que de se retrouver plus tard avec un Spark en erreur.
La preuve a été révisée pour vérifier ce comportement, le garde-fou de la découpe
restant éprouvé pour le cas où le pool change entre création et application.

**Détail technique à ne pas redécouvrir** : la reconfiguration d'Incus se fait en
`PATCH`, jamais en `PUT`. Un `PUT` remplacerait la configuration entière et
effacerait tout ce qu'on ne renvoie pas.

**Dette assumée.** Le choix des cœurs ignore NUMA. L'hôte de validation n'a qu'un
nœud : une règle qu'on ne peut pas éprouver ne s'implémente pas. Notée au
§7.4 ter.

**Vérifié.** 294 tests verts, campagne complète verte.

**Où reprendre.** **SPK-11**, clés SSH et injection cloud-init — première `[ ]`
du plan désormais, et elle ne dépend de rien de bloqué. Elle rend les Sparks
réellement utilisables : aujourd'hui on les crée et on les démarre, mais on ne
peut pas y entrer pour y déployer une pile Compose. Ensuite **SPK-12**, l'ingress
Caddy, qui a maintenant l'adresse stable qu'il lui fallait. SPK-29 et SPK-28
restent ouvertes.


---

## 2026-08-19 — SPK-11 close : on entre enfin dans un Spark

**Unité** : SPK-11. Sa spécification — `docs/SCHEMA.md` §7 — annonçait une
injection des clés **par cloud-init**. La mesure l'a écartée, et le document a été
corrigé avant de coder.

**Pourquoi cloud-init ne convenait pas.** L'image `images:debian/13` n'embarque ni
cloud-init ni sshd ; `cloud-init.ssh-keys.*` n'existe pas dans Incus 7.3
(`Unknown configuration key`) ; mais la raison décisive est ailleurs :
**cloud-init ne s'exécute qu'au premier démarrage**. Retirer une clé d'un Spark
existant lui est structurellement hors de portée — or c'est précisément ce que la
Definition of Done demande de prouver. Une conception fondée dessus aurait eu
besoin d'un second mécanisme pour le retrait, et deux mécanismes écrivant le même
état finissent par diverger.

**Décision : un seul mécanisme.** `authorized_keys` est **régénéré en entier**
depuis l'état voulu du registre, par l'API de fichiers d'Incus, à la création
comme à chaque changement. Régénérer plutôt qu'ajouter n'est pas un détail de
mise en œuvre : un mécanisme qui ajoute ne retire jamais.

**La DoD, prouvée depuis le poste.** Un Spark créé et démarré par `sparkd` seul —
sans intervention manuelle — reçoit `openssh-server`, voit l'authentification par
mot de passe désactivée, et reçoit les clés voulues. Puis :

```
ssh -J ubuntu@<hôte> root@10.77.0.16   →  connecté, hôte « neuf », root
DELETE /v1/sparks/neuf/ssh-keys/poste-admin
ssh -J ubuntu@<hôte> root@10.77.0.16   →  Permission denied (publickey)
```

Le port 22 du Spark reste injoignable depuis l'extérieur : c'est une adresse
privée, et l'accès passe par le rebond.

**Un jeu d'essai fautif, et ce qu'il a révélé.** Une seconde clé de test avait été
inventée à la main ; elle a été refusée par le contrôle de cohérence entre le type
annoncé et le corps de la clé. Le contrôle avait raison, le jeu d'essai avait
tort. Remplacé par une vraie clé produite par `ssh-keygen` — et l'occasion de
vérifier que l'empreinte calculée par `sparkd` est **identique** à celle de
`ssh-keygen -lf`, ce qu'un test compare désormais réellement.

**Vérifié.** 321 tests verts, campagne complète verte.

**Où reprendre.** **SPK-12**, ingress Caddy. C'est la dernière pièce qui manque
pour qu'un Spark serve du trafic public : l'adresse privée est stable (SPK-10),
on peut y entrer déployer une pile Compose (SPK-11), il reste à router un domaine
vers elle. Caddy n'est pas encore installé sur l'hôte. SPK-29 et SPK-28 restent
ouvertes.


---

## 2026-08-19 — SPK-12 : la chaîne complète sert du trafic

**Unité** : SPK-12. Caddy installé sur l'hôte, API d'administration sur
`127.0.0.1:2019` seulement. Le DAT §18 a été écrit après mesure, avant de coder.
Le renvoi du backlog vers « DAT §8 », périmé depuis une renumérotation, a été
corrigé au passage.

**La chaîne entière fonctionne**, et c'est la première fois : un Spark créé par
`sparkd`, provisionné, hébergeant une pile Compose ordinaire (nginx), servi
publiquement par domaine. `site.exemple.test → 10.77.0.16:8080` rend `HTTP 200`
et le contenu du Spark. Le retrait de la route fait cesser le trafic.

**Décision : on régénère, on ne rapièce pas.** La configuration entière de Caddy
est reconstruite depuis le registre et posée d'un geste. Rapiécer route par route
laisserait subsister les routes d'un Spark supprimé pendant que `sparkd`
s'arrêtait, et rien ne distinguerait cet état d'un fonctionnement normal.
Régénérer rend la dérive **impossible plutôt qu'improbable** — et fait de la
réconciliation le mécanisme normal d'application, pas une réparation.

**Le défaut que la mesure a révélé.** Sans route terminale, Caddy rend `200` avec
un corps vide pour **tout** domaine non routé. L'hôte répondait donc au nom de
domaines qu'il ne sert pas, et une erreur de pointage DNS restait invisible au
lieu de se manifester tout de suite. Une route terminale sans filtre rend
désormais `404` et le dit en clair. Elle vient après les routes nommées, sans
quoi elle les masquerait — et elle est exclue du compte annoncé à l'exploitant,
qui compte les routes *servies*.

**Ce qui n'est pas prouvé, et pourquoi l'unité reste `[~]`.** L'émission d'un
certificat TLS suppose un domaine résolvant vers cet hôte. Ce n'est pas une
propriété que le produit contrôle — elle dépend du DNS —, et je ne dispose pas
d'un tel domaine. Seul le routage HTTP par nom d'hôte est vérifié. L'affirmer
autrement serait annoncer une preuve non faite.

**Vérifié.** 351 tests verts, campagne complète verte.

**Où reprendre.** Clore SPK-12 demande un domaine réel pointant vers
`51.158.54.202` — une action du responsable. En attendant, **SPK-13**,
instantanés et restauration de cellule, est la première `[ ]` du plan et ne
dépend de rien de bloqué. SPK-29 et SPK-28 restent ouvertes.


---

## 2026-08-19 — SPK-13 close : la cellule entière revient

**Unité** : SPK-13. Le DAT §19 a été écrit après mesure, avant de coder.

**Prouvé sur l'hôte, et c'est l'argument du §8.3 qui se vérifie.** Une cellule
cassée volontairement — fichier réécrit, `/srv/site` supprimé, **images Docker
effacées** — puis restaurée : les trois sont revenus à l'identique, le Spark
restant `RUNNING`. Le retour des images Docker est précisément ce qu'une
sauvegarde applicative vers S3 ne restaure pas.

**La décision de conception.** ZFS rembobine : restaurer un point ancien détruit
tout ce qui a été capturé depuis, et Incus refuse plutôt que de le faire en
silence. Ce refus est **conservé comme défaut**. `sparkd` le relaie en nommant
les instantanés qui bloquent et la sortie, et l'acceptation de la perte est un
drapeau de **la requête**, jamais une option de configuration : une configuration
se pose une fois et s'oublie, alors que la perte se décide instantané par
instantané.

**Le défaut sérieux que les tests ont trouvé.** Les instantanés étaient triés par
`created_at, id`. Deux instantanés pris dans la même seconde partagent leur
horodatage, et l'identifiant est aléatoire : **l'ordre chronologique était donc
arbitraire**. Or c'est cet ordre qui décide lesquels une restauration détruit —
s'y tromper aurait détruit les mauvais, irréversiblement. Le tri se fait
désormais sur l'ordre d'insertion. À retenir : un tri « à peu près bon » sur une
opération destructrice ne l'est pas.

**Deux limites mesurées, et assumées.** L'instantané **avec état** n'est pas
disponible : CRIU est construit sans le support de nftables et la capture échoue.
Le produit ne proposera pas l'option tant qu'elle n'aura pas été mesurée
fonctionnelle — offrir un bouton qui échoue à l'usage vaut moins que ne pas
l'offrir. Et un instantané **consomme le quota du Spark**, grossissant à mesure
que celui-ci s'en écarte : l'interface doit le dire plutôt que de laisser
découvrir la chose par un disque plein.

**Vérifié.** 372 tests verts, campagne complète verte.

**Où reprendre.** **SPK-14**, métriques d'usage et état temps réel — première
`[ ]` du plan, sans dépendance bloquée. Elle donne à la console de quoi montrer
la consommation réelle face aux quotas, ce que plusieurs unités ont laissé en
dette d'affichage. SPK-12 attend un domaine réel, SPK-29 et SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-14 close : mesurer sans mentir

**Unité** : SPK-14. Son entrée de backlog ne citait aucune spécification ; le
DAT §20 a été écrit après mesure, avant de coder.

**Ce que la mesure impose.** `cpu.usage` et les compteurs réseau sont
**cumulés**, pas des taux : deux relevés à trois secondes d'intervalle donnent
`0,0010 CPU`, qu'aucune lecture unique n'aurait produit. `sparkd` conserve donc
le relevé précédent, calcule le taux et **publie la fenêtre** — un taux sans sa
fenêtre n'est pas interprétable.

Au premier relevé il n'y a pas de fenêtre : le taux vaut `null`, **jamais `0`**.
Zéro est une valeur plausible, donc indétectable ; l'annoncer serait affirmer une
mesure non faite. Mémoire et disque, eux, sont instantanés et disponibles dès le
premier appel.

**Un piège écarté.** Le relevé énumère `docker0` et les `br-*` que Docker crée
*dans* le Spark. Ce trafic ne traverse jamais le bridge de l'hôte : l'additionner
ferait apparaître une consommation réseau là où rien n'a quitté la cellule, et
d'autant plus faussement que la pile du locataire est bavarde entre ses propres
conteneurs. Seule l'interface privée est comptée.

**La découverte de la session.** Un Spark réservant `0,5 CPU`, chargé par deux
boucles sur un hôte au repos, consomme **1,996 CPU** — quatre fois sa
réservation. Ce n'est pas un dépassement : `cpu.max` reste à `max` en mode
partagé, et « hors contention, un Spark consomme tout ce qui traîne » (§7.1). La
réservation est un droit d'ordonnancement sous contention, pas un plafond.

Conséquence, portée au §20.3 bis et implémentée : l'API distingue `burst` de
`over_limit`, ce dernier n'existant qu'en mode `capped`, seul mode où un plafond
est réellement posé. Sans cette distinction, une jauge afficherait « 1,99 / 0,5 »
en rouge et chaque exploitant signalerait le même faux défaut.

**Une règle d'affichage de plus.** L'usage réseau se compare au **plafond**,
jamais à la réservation : le noyau ne garantit aucun débit, et « 40 Mbit/s sur
100 réservés » laisserait croire à une garantie inexistante.

**Vérifié.** 391 tests verts, campagne complète verte, et les relevés réels
ci-dessus.

**Où reprendre.** **SPK-15**, journal d'audit et filtrage des secrets — première
`[ ]` du plan. Le journal est déjà écrit par toutes les unités livrées ; il reste
à l'exposer et surtout à **prouver** qu'aucune clé ni secret n'y atteint, ce que
sa Definition of Done exige explicitement. SPK-12 attend un domaine, SPK-29 et
SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-15 close : le journal ne fuit pas, et reste lisible

**Unité** : SPK-15. Le DAT §21 a été écrit avant de coder.

**Le vrai sujet n'était pas le filtre.** Cinq modules écrivaient chacun leur
`INSERT INTO audit_log`, avec un payload composé à la main. Un filtre posé à cinq
endroits sera oublié au sixième — et l'oubli ne se verrait pas, puisqu'un journal
qui contient trop ressemble à un journal qui fonctionne. Toute écriture passe
désormais par une fonction unique, et **un test lit les sources** pour vérifier
qu'aucun autre fichier ne mentionne cette table. C'est ce qui rend l'omission
impossible plutôt qu'improbable.

**Deux décisions de filtrage.** On caviarde plutôt qu'on ne supprime : savoir
qu'un secret a transité par un appel n'est pas la même chose que ne rien savoir.
Et `public_key` est caviardée comme le reste — une clé publique n'est pas un
secret, mais distinguer `public_key` de `private_key` par un préfixe est le genre
de finesse qui se retourne le jour où quelqu'un nomme un champ `user_key`.

Le nom du champ est le signal principal, parce qu'il est choisi par le
développeur alors que la valeur peut prendre n'importe quelle forme. La forme de
la valeur — bloc PEM, en-tête `Authorization`, clé SSH — sert de second filet
pour ce qu'un nom anodin laisserait passer. Le message y passe aussi, étant
composé à la main donc susceptible d'interpoler.

**Un payload n'est pas un dépotoir.** Le journal de l'ingress écrivait la
configuration Caddy **entière**. Ce n'était plus une trace mais une copie —
coûteuse, illisible, et prête à emporter le premier secret ajouté à cette
configuration. Le payload est borné, et la troncature est dite.

**La preuve.** Elle n'éprouve pas le filtre isolément : elle exerce l'API réelle
avec des secrets à chaque endroit qui en accepte, puis **fouille toute la
table**. Sur l'hôte : 17 entrées, aucun corps de clé, aucun en-tête PEM, aucun
contenu de clé privée. Un test complémentaire vérifie l'inverse — que le journal
reste **lisible** : empreintes, noms de Sparks et actions y demeurent. Caviarder
tout ne serait pas un journal.

**Vérifié.** 426 tests verts, campagne complète verte.

**Où reprendre.** Le lot 2, le runtime serveur, est **entièrement livré**. La
suite est le **lot 3, la console locale**, dont la première unité est **SPK-16**,
l'hôte console et les tunnels SSH. Attention : à partir de SPK-18 l'interface
entre en jeu, et `CLAUDE.md` §4 impose alors la lecture **intégrale** de
`docs/DESIGN_SYSTEM.md` — 1585 lignes — avant toute écriture. SPK-16 et SPK-17
n'en relèvent pas encore. SPK-12 attend un domaine, SPK-29 et SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-16 close : le poste parle au serveur, et le dit quand il ne peut plus

**Unité** : SPK-16, première du lot 3. Le DAT §22 a été écrit avant de coder.

**Deux décisions de conception.**

Le binaire `ssh` du système, pas une bibliothèque. Le poste du responsable a déjà
une configuration SSH — agent, clés, `ProxyJump`, parfois une clé matérielle — que
le binaire honore sans que le produit ait à la connaître. Une bibliothèque les
réimplémenterait mal, et le premier exploitant avec un bastion serait bloqué par
un outil censé lui simplifier la vie.

Et surtout : **un tunnel vivant se prouve à travers lui, pas à côté**. Un
processus `ssh` mort se voit tout de suite ; un processus **figé** ne se voit pas —
il vit, la socket locale accepte, et chaque requête attend indéfiniment. C'est le
cas dangereux, parce qu'il ressemble au bon. La supervision interroge donc
`/healthz` à travers le tunnel, et un test le vérifie sur un faux `ssh` vivant
mais muet.

**Prouvé depuis le poste vers le serveur réel** : tunnel `ready` sur un port
attribué par le système, `sparkd` joint à travers lui — `spark-experiment`,
4 cœurs, 76,2 Gio allouables, Spark `site (running)`. Puis le processus `ssh` tué
sous les pieds : `502 tunnel_unavailable`, avec le motif, l'âge de la dernière
réponse et la mise en garde contre l'affichage de données périmées.

**Le défaut que seule la preuve réelle pouvait produire.** La première sonde
courait plus vite que l'établissement du tunnel : `ssh` met un instant à
s'authentifier et à ouvrir la redirection, et sonder une seule fois juste après
l'avoir lancé mesure sa vitesse de démarrage, pas sa santé. Le tunnel était
déclaré rompu alors qu'il se connectait. La sonde factice, elle, répondait
toujours instantanément — aucun test unitaire ne pouvait le voir. L'ouverture
attend désormais, dans une fenêtre bornée, et abandonne tout de suite si `ssh`
s'est arrêté.

**Deux refus plutôt que deux silences.** Un champ qui ressemble à un secret dans
l'inventaire est refusé, pas filtré : l'auteur doit savoir qu'il en a copié un,
pour le retirer de là où il l'a pris. Et un inventaire illisible échoue au lieu
de repartir vide, ce qui ferait croire à la perte des serveurs.

**Vérifié.** 426 tests Python et 36 tests Node, campagne complète verte.

**Où reprendre.** **SPK-17**, le contrat d'API partagé — dernière unité avant que
l'interface entre en jeu. Elle ne relève pas encore du design system. À partir de
**SPK-18**, `CLAUDE.md` §4 impose la lecture **intégrale** de
`docs/DESIGN_SYSTEM.md` — 1585 lignes — avant toute écriture touchant l'UI, et
cette lecture doit être budgétée dans la session. SPK-12 attend un domaine,
SPK-29 et SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-17 : le contrat est committé, la dérive est détectable

**Unité** : SPK-17. Le DAT §23 a été écrit avant de coder.

**Pourquoi un fichier plutôt qu'une réponse HTTP.** `sparkd` produit son OpenAPI
à l'exécution, mais cela ne suffit pas. La console doit se construire **sans
qu'un `sparkd` tourne** — un développeur qui ne peut pas compiler sans démarrer
le serveur finira par ne plus vérifier ses types du tout. Et surtout, un contrat
qui n'existe qu'à l'exécution **ne se relit pas** : committé, un changement d'API
apparaît dans le diff, au moment de la revue ; non committé, il se découvre en
production par une console qui appelle un champ disparu.

**La dérive se détecte en régénérant**, exactement comme le checksum des
migrations : on ne fait pas confiance à la discipline pour maintenir deux choses
en accord, on rend le désaccord détectable. Vérifié en provoquant une **vraie**
dérive — une route ajoutée sans régénération fait sortir `make contract-check` en
code 1, avec le diff et la marche à suivre.

Point qui aurait tué la vérification s'il avait été négligé : **la génération doit
être déterministe**. Clés triées, indentation fixe, saut de ligne final. Sans
cela le contrôle échouerait à chaque exécution et serait désactivé dans la
semaine — un contrôle qu'on désactive ne protège de rien.

**Les types sont dérivés, jamais écrits.** 1183 lignes produites par
`openapi-typescript` depuis l'OpenAPI. Une déclaration manuelle diverge dès la
première modification, et la divergence se découvre chez l'utilisateur.

**Ce que je ne peux pas prouver, et pourquoi l'unité reste `[~]`.** La CI est
écrite, mais **jamais exécutée** : je ne peux ni la déclencher ni observer son
résultat depuis ici. « Dérive détectée en CI » reste donc une intention. La
détection elle-même est prouvée en local ; son exécution automatique ne l'est
pas, et l'affirmer serait annoncer une preuve non faite.

**Vérifié.** 432 tests Python, 42 tests Node, campagne complète verte.

**Où reprendre.** **SPK-18**, l'écran liste des Sparks — et c'est là que
l'interface entre en jeu. `CLAUDE.md` §4 impose la lecture **intégrale** de
`docs/DESIGN_SYSTEM.md`, 1585 lignes, **avant** toute écriture touchant l'UI.
Cette lecture est le premier geste de la session suivante, pas un préalable à
expédier : elle conditionne tout ce qui sera écrit ensuite. SPK-12 attend un
domaine, SPK-29 et SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-18 close : le premier écran, et ce que les captures ont trouvé

**Unité** : SPK-18, première unité d'interface. La session a commencé par la
lecture **intégrale** de `docs/DESIGN_SYSTEM.md`, 1585 lignes, comme
`CLAUDE.md` §4 l'impose — puis par l'écriture de `docs/DESIGN_SYSTEM_APP.md`,
avant la moindre ligne d'interface.

**Les tokens sont calculés, pas déclarés.** Le §14.1 exige que la conformité AA
soit mesurée. Elle l'a été : la couleur pleine de `success`, `accent` et `danger`
donne 3,71, 1,53 et 3,19 sur sa propre déclinaison douce — insuffisant. Les
`*-on-soft` retenus atteignent 4,60, 4,54 et 4,51.

**Ce que les captures ont trouvé, et qu'aucun test ne voyait.** C'est
l'enseignement de la session, et il valide littéralement le §13.2 :

1. le séparateur décimal était un **point** dans une interface entièrement
   francophone ;
2. « 2.0 sur 0.50 CPU réservés » juxtaposait deux précisions dans une même
   phrase ;
3. un nom de Spark long **élargissait sa colonne** et faisait replier toutes les
   autres — une seule donnée inhabituelle dégradait tout le tableau ;
4. les mesures se coupaient en deux lignes, « 86 Mio / 8,0 Gio » se lisant alors
   comme deux valeurs ;
5. au mobile, le tableau était coupé **sans aucune indication qu'il défilait**,
   ce que le §14.2 interdit explicitement : du contenu non signalé est
   fonctionnellement caché.

Aucun de ces cinq défauts n'aurait été détecté par les 25 tests de la vue, qui
étaient pourtant tous verts. « Une interface qui passe ses tests peut encore être
visuellement incorrecte » — le §13.2 le dit, et la session vient de le vérifier.

**Un sixième défaut, trouvé à la campagne.** Le script `test` de la console ne
lançait que les tests de l'hôte : les 25 tests de composants n'entraient pas dans
la campagne. Des tests hors campagne ne protègent rien — ils passent, et
personne ne le sait.

**Deux règles de produit portées à l'écran.** Le burst n'est jamais rouge : la
part au-delà de la réservation utilise `accent` et se nomme « burst », `danger`
étant réservé au dépassement réel, qui n'existe qu'en mode `capped`. Et les trois
absences de mesure — arrêté, en cours, indisponible — ont des textes distincts,
jamais un blanc.

**Vérifié.** 432 tests Python, 67 tests Node, campagne complète verte, et six
captures observées.

**Où reprendre.** **SPK-19**, l'écran détail d'un Spark. Le design system est
désormais lu et son extension écrite : les sessions d'interface suivantes n'ont
plus à rouvrir les 1585 lignes, seulement l'extension et les sections
concernées. SPK-12 attend un domaine, SPK-17 une exécution de CI, SPK-29 et
SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-19 close : le runtime dit ce qui est possible

**Unité** : SPK-19. Son entrée n'était qu'un **titre** — ni spécification, ni
Definition of Done. Les deux ont été écrites avant de coder, avec le DAT §24.

**La décision de conception.** La console doit savoir quelles commandes proposer.
Réimplémenter la table des transitions de son côté aurait signifié maintenir la
même règle dans deux langages, avec la certitude qu'elles divergeraient — et
`DESIGN_SYSTEM.md` §14.9 comme `CLAUDE.md` §10 disent la même chose : l'interface
n'est jamais l'autorité.

Le runtime publie donc `allowed_commands`, dérivé de la table même qui applique
le refus. Un test passe à la vue un état **inventé** pour prouver qu'elle ne
redérive rien.

Conséquence visible : un Spark `running` n'affiche que « Redémarrer, Arrêter,
Supprimer » — pas de « Démarrer », **même désactivé**. Et un état `creating`
n'affiche **aucun bouton** : il explique qu'une opération est en cours et
qu'aucune commande n'est acceptée, plutôt que d'exposer quatre boutons morts.

**Deux défauts trouvés par l'observation des captures**, une fois de plus
invisibles aux 42 tests alors verts :

1. `allowed_commands` étant publié **par ordre alphabétique**, « Supprimer »
   arrivait en tête. L'action la plus dangereuse était la plus proéminente et la
   première atteinte au clavier. L'ordre d'affichage suit désormais l'intention —
   réparatrices, puis courantes, puis destructive — et non l'alphabet.
2. Le journal affichait `ok`, `denied`, `error` : des valeurs techniques brutes
   arrivées jusqu'à l'écran, ce que le §14.7 interdit. Elles sont traduites, avec
   un repli neutre pour une valeur inconnue.

**Un détail de typographie qui n'en était pas un.** Les textes utilisaient
l'apostrophe droite, échappée en `&#39;` dans le HTML. Le design system emploie
partout l'apostrophe typographique, qui ne s'échappe pas. Les textes visibles ont
été convertis.

**Vérifié.** 438 tests Python, 84 tests Node, contrat sans dérive, campagne
complète verte, et cinq captures observées.

**Où reprendre.** **SPK-20**, la création d'un Spark avec aperçu d'admission —
le premier écran qui **écrit**. Sa DoD existe déjà et exige que le refus vienne
de `sparkd`, jamais d'un contrôle uniquement côté interface. SPK-12 attend un
domaine, SPK-17 une exécution de CI, SPK-29 et SPK-28 un arbitrage.
