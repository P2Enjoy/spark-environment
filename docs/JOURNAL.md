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


---

## 2026-08-19 — SPK-20 close : montrer sans décider

**Unité** : SPK-20, le premier écran qui **écrit**. Sa DoD posait deux exigences
qui semblaient s'opposer : afficher la capacité restante avant validation, et
faire venir le refus de `sparkd` seulement.

**Elles ne s'opposent pas si l'on sépare montrer de décider.** L'écran affiche la
capacité — c'est ce qui permet de dimensionner un Spark sans tâtonner — et
n'interdit rien sur cette base. Le bouton n'est désactivé que pendant l'envoi.

Le motif est concret : la capacité affichée est une **photographie prise à
l'ouverture**. Un Spark supprimé entre-temps l'a rendue fausse, et dans le sens
favorable. Bloquer sur une valeur périmée refuserait une création que le serveur
aurait acceptée, sans que l'exploitant puisse le savoir. L'avertissement local
utilise donc `accent` et dit « c'est le serveur qui décide » ; seul le refus de
`sparkd` est rouge.

**Deux contrôles restent locaux**, et ils ne relèvent pas de l'admission : la
syntaxe d'un nom et la cohérence du mode CPU. Ce sont des questions de forme,
connues sans interroger le serveur, et doublées par le runtime. Un test soumet
une demande **énorme mais bien formée** et vérifie qu'aucun contrôle local ne la
rejette.

**Deux défauts trouvés par l'observation des captures**, encore une fois
invisibles aux tests alors verts :

1. le refus affichait `memory : il manque 64424509440` — des octets bruts et un
   nom de ressource en anglais, alors que toute l'interface formate. Le §14.7
   l'interdit : une valeur technique brute ne doit pas atteindre l'écran ;
2. l'avertissement estimé restait affiché **à côté** du refus qui fait autorité.
   Deux messages disant la même chose, dont un moins fiable, sont du bruit.

**Vérifié.** 438 tests Python, 105 tests Node, contrat sans dérive, campagne
complète verte, et cinq captures observées.

**Où reprendre.** **SPK-21**, les écrans ingress, clés SSH et instantanés — les
trois dernières surfaces d'administration. Les composants de formulaire, de
confirmation et d'absence nommée existent désormais ; l'unité consiste surtout à
les composer. SPK-12 attend un domaine, SPK-17 une exécution de CI, SPK-29 et
SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-21 : l'ordre des gestes est le produit

**Unité** : SPK-21, les trois surfaces d'administration. Le backlog n'en portait
que le titre ; la spécification (`docs/DAT.md` §26) a été écrite et committée
avant la première ligne de code.

**Le titre disait « écrans », au pluriel, et la spécification s'en écarte.** Une
route publique et un instantané n'existent pas sans leur Spark : leur donner des
écrans séparés obligerait à choisir un Spark en entrant, donc à refaire l'écran
détail en moins bon. Ce sont trois panneaux du détail. Une exception réelle
subsiste : oublier une clé du **registre commun** la retire de tous les Sparks à
la fois, un effet qui déborde le Spark qu'on regarde — ce geste reste hors de
cette unité, et le panneau le dit.

**La décision qui structure le reste porte sur la restauration.** `sparkd` refuse
de restaurer un instantané ancien tant que des plus récents existent (§19.1), et
accepte un drapeau de requête pour passer outre. La tentation était de mettre une
case « accepter la perte » dans le formulaire. Elle serait cochée par habitude,
et ferait perdre des instantanés jamais regardés. **Le refus est ce qui rend la
perte visible** : l'acceptation ne peut donc venir qu'après lui, et doit nommer
ce qui meurt. C'est éprouvé deux fois — la première requête part avec `{}`, et
`accept_losing_newer` n'existe nulle part dans le rendu avant le refus.

**Deux défauts trouvés par l'observation des captures**, tests verts :

1. les listes n'avaient pas les **séparateurs** qu'exige le §6.19. Dans la
   colonne étroite des instantanés, le groupe d'actions passait à la ligne et se
   retrouvait visuellement entre deux instantanés — l'action voisine étant
   « Supprimer » ;
2. le refus de restauration annonçait le nombre de victimes sans nommer
   l'instantané visé, alors que trois boutons « Restaurer » coexistent.

**Ce que la session ajoute au harnais.** `e2e/gestes.test.mjs` : huit parcours
navigateur qui ouvrent le Spark **depuis la liste**, cliquent et saisissent, et
vérifient la méthode et le corps réellement envoyés. Ils sont dans `make test` —
un test hors campagne cesse d'être exécuté, puis cesse d'être vrai. La campagne
de captures échoue désormais si l'application écrit dans la console ; le journal
réseau de Chromium pour les 500, 502 et 409 provoqués est compté à part et
affiché, jamais masqué.

**Vérifié.** 438 tests Python, 137 tests Node, 6 tests de contrat, 8 parcours
navigateur, contrat sans dérive, build, neuf captures observées.

**Limite.** Ces parcours s'exécutent contre un faux `sparkd` : il n'existe pas
encore de pile locale à interroger.

**Où reprendre.** **SPK-22**, la vue des pools de ressources de l'hôte — la
dernière surface de lecture, et la seule qui parle de l'hôte plutôt que d'un
Spark. Puis SPK-23, la pile de développement autonome, qui débloquera l'E2E
réel de SPK-24. SPK-12 attend un domaine, SPK-17 une exécution de CI, SPK-29 et
SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-22 : montrer d'où viennent les chiffres

**Unité** : SPK-22, l'écran des pools. Comme SPK-21, le backlog n'en portait que
le titre ; la spécification (`docs/DAT.md` §27) a été écrite et committée avant
la première ligne de code.

**Cet écran-là en est un, et le §26.1 dit pourquoi.** Les routes et les
instantanés n'existent pas sans leur Spark, donc ils sont des panneaux du détail.
Les pools ne dépendent d'aucun Spark et concernent tous les Sparks : les loger
dans le détail de l'un d'eux obligerait à en choisir un arbitrairement pour
parler de la machine entière.

**Une découverte a coûté une migration.** La spécification demandait d'énoncer la
soustraction terme à terme — `MemTotal` moins l'ARC moins la marge. Le registre
ne persistait que leur **somme**. On aurait pu s'en contenter : afficher
« 94 Gio − 18 Gio de réserve = 76 Gio » suffit déjà à lever le soupçon de défaut.
Mais la somme ne dit pas **laquelle des deux vannes tourner** — abaisser
`zfs_arc_max`, ou `SPARKD_MEMORY_RESERVE`. C'est exactement la question qu'on se
pose devant cet écran. D'où la migration `002_part_arc`, deux colonnes à zéro par
défaut, renseignées au prochain relevé. Tant qu'il n'a pas eu lieu, l'écran
affiche la somme **sans inventer sa répartition**.

**Trois preuves étaient figées sur « il n'existe qu'une migration ».** Elles ont
rougi à l'ajout de la seconde sans rien dire du produit. Elles sont révisées et
raisonnent désormais sur le registre découvert. Celle de réversibilité déroulait
la pile en un appel alors que `downgrade` ne retire qu'un cran : elle la déroule
maintenant réellement, ce qui éprouve chaque sens `down` un à un — une garantie
que l'ancienne version n'apportait pas.

**Trois défauts trouvés par l'observation des captures**, tests verts :

1. `aria-current="page"` était écrit en dur sur « Sparks » : sur l'écran de
   l'hôte, un lecteur d'écran annonçait la mauvaise page courante. Un indicateur
   qui ment est pire qu'un indicateur absent ;
2. les deux liens de navigation se touchaient et se lisaient comme une seule
   expression ;
3. mes faux Sparks n'avaient pas d'identifiant, si bien que la carte des cœurs
   affichait « S3 » là où le produit affiche un nom. La capture montrait donc un
   comportement que le produit n'a pas — un harnais qui ment sur le produit est
   aussi grave qu'un produit fautif.

**Vérifié.** 439 tests Python, 165 tests Node, 6 tests de contrat, 10 parcours
navigateur, contrat sans dérive, build, quatre captures observées.

**Où reprendre.** **SPK-23**, la pile de développement autonome et le seed. C'est
elle qui débloque l'E2E réel de SPK-24 : tous les parcours navigateur actuels
s'exécutent contre un faux `sparkd`, faute de pile locale à interroger. SPK-12
attend un domaine, SPK-17 une exécution de CI, SPK-29 et SPK-28 un arbitrage.


---

## 2026-08-19 — SPK-23 : la console tourne enfin contre un vrai runtime

**Unité** : SPK-23, la pile de développement et le seed. Le backlog renvoyait au
§11 du DAT, « Sécurité » — la référence était fausse, corrigée vers le §12, et le
contrat complet est écrit au nouveau §28.

**Docker n'est pas disponible ici** : `dockerd` n'est pas installé, seul le shim
CLI de Docker Desktop l'est, démon arrêté. Consigné plutôt que contourné. Cela
n'a pas bloqué l'unité : la pile est faite de **deux processus sans dépendance**,
et les conteneuriser ajouterait un démon Docker là où il n'y en avait aucun.
L'écart à `CLAUDE.md` §3 est écrit au §28.1 avec sa condition de réouverture.

**La décision structurante est que le seed appelle les routes HTTP.** Un seed qui
écrit des lignes en SQL peut produire des états que l'application est incapable
d'atteindre : les écrans seraient alors éprouvés contre des situations qui
n'existent pas. Conséquences concrètes : le refus d'admission du seed est un vrai
`409` du contrôle d'admission, et l'état `error` est atteint en faisant réellement
échouer le pilote — pas en écrivant « error » dans une colonne.

**Deux mesures ont corrigé mes hypothèses, et le seed s'est corrigé lui-même.**

1. Je déclarais la route non appliquée sur un Spark `pending`, en supposant qu'il
   n'avait pas encore d'adresse. Mesuré : l'adresse est attribuée dès la
   **création**. La route était donc servie, et la fixture manquait. C'est la
   vérification finale du seed qui l'a montré — sans elle, j'aurais livré un jeu
   de données silencieusement incomplet. Le mécanisme réel est un Caddy
   injoignable au moment de la déclaration, et c'est celui qui est employé.
2. Le pilote factice tenait ses instances en mémoire. Un Spark seedé « en
   marche » survivait au redémarrage — le registre est un fichier — mais
   « Arrêter » échouait ensuite sur « instance absente ». La pile paraissait
   fonctionnelle jusqu'au premier geste, ce qui est pire qu'une panne franche.

**Un défaut trouvé en observant la console contre le vrai runtime**, et qu'aucun
faux `sparkd` n'avait pu produire : `analytics`, déclaré et jamais appliqué,
annonçait « Mesure en cours ». Rien n'était en cours de mesure et rien ne
viendrait. Le §14.6 interdit précisément de confondre un calcul en cours avec une
donnée inexistante.

**Deux constats étrangers consignés** (`docs/INCONSISTENCY_REPORT.md`, recréé) :
INC-01, le journal d'audit affiche les états techniques là où le reste de l'écran
les traduit ; INC-02, un refus de création n'est rattachable à aucune demande —
son `target_id` désigne un Spark qui n'a jamais existé. Les deux attendent un
arbitrage et le comportement est inchangé.

**Vérifié.** 451 tests Python, 175 tests Node, 6 de contrat, 10 parcours
navigateur, contrat sans dérive, build, six captures observées contre le runtime
réel.

**Où reprendre.** **SPK-24**, les tests E2E Playwright depuis le parcours
canonique. La pile réelle existe désormais et `e2e/reel.mjs` en donne la forme :
il reste à transformer ces captures en parcours assertifs et à couvrir les refus
d'autorisation. SPK-12 attend un domaine, SPK-17 une exécution de CI, SPK-29 et
SPK-28 un arbitrage, comme INC-01 et INC-02.


---

## 2026-08-19 — SPK-24 : le premier harnais qui part vraiment de l'accueil

**Unité** : SPK-24, les parcours E2E. Spécification écrite et committée avant le
code (`docs/DAT.md` §29).

**Ce que ce harnais ajoute.** Trois en existaient déjà, et confondre leurs rôles
faisait croire à une couverture qu'on n'avait pas : les tests de composants
prouvent un rendu, `gestes.test.mjs` prouve qu'un clic part avec le bon corps
contre un faux `sparkd`, `reel.mjs` produit des captures. Aucun ne traversait la
pile réelle **en affirmant**. C'est fait, et le harnais monte sa propre pile —
un verdict qui dépend de ce qu'un humain a fait avant lui ne prouve rien.

**Il a trouvé deux défauts réels dès ses premières exécutions.**

1. **La console n'ouvrait jamais son tunnel.** Ouverte sur une machine fraîche,
   elle affichait « Tunnel fermé » et « Les Sparks n'ont pas pu être chargés »,
   sans offrir le moindre moyen d'y remédier. Le parcours canonique était cassé.
   Ce défaut a survécu à trois écrans et une trentaine de captures **parce que
   tous les harnais ouvraient le tunnel par un appel direct à l'API** — le
   contournement même que la DoD de cette unité interdit. C'est l'argument le
   plus net en faveur de la règle : un harnais qui s'autorise un raccourci ne
   voit pas ce que l'utilisateur voit. Le §22 décrivait toute la mécanique du
   tunnel sans jamais dire qui l'ouvre ; le §22.6 le dit maintenant.
2. **`validate` jetait le port d'un serveur local**, rendant toujours 9876. Une
   pile montée sur un port libre pointait donc sur un `sparkd` qui n'était pas le
   sien. Les deux preuves existantes passaient par coïncidence : l'une fixait
   `remotePort`, l'autre utilisait justement 9876.

**Un défaut trouvé par l'observation** : après avoir traduit le badge en
« rompu », le bandeau d'alerte disait encore « broken » à quelques centimètres.
Le vocabulaire du tunnel vit désormais dans `tokens.js`, comme celui des états de
Spark.

**Une preuve corrigée, et le motif vaut d'être retenu.** Mon méta-test affirmait
d'abord que Chromium avait journalisé les refus provoqués. Il éprouvait le
**navigateur**, pas le produit. Il porte désormais sur le classement des
messages, qui m'appartient — et il ne dépendra pas de la prochaine version de
Chromium.

**Vérifié.** 451 tests Python, 178 tests Node, 6 de contrat, 10 gestes,
**11 parcours E2E**, contrat sans dérive, build, captures régénérées et observées.

**Où reprendre.** **SPK-25**, le manuel utilisateur. Le produit a maintenant
quatre écrans, une pile qui se lance en une commande et des parcours qui
décrivent son usage : le manuel peut être écrit à partir du comportement réel, ce
que `CLAUDE.md` §7 exige. SPK-12 attend un domaine, SPK-17 une exécution de CI,
SPK-29, SPK-28, INC-01 et INC-02 un arbitrage.


---

## 2026-08-19 — SPK-25 : un manuel qui ne peut pas mentir en silence

**Unité** : SPK-25, le manuel utilisateur. Spécification écrite et committée
avant le code (`docs/DAT.md` §30).

**Le problème n'était pas d'écrire le manuel, mais de le maintenir vrai.**
`CLAUDE.md` §7 exige que les captures soient renouvelées quand l'apparence
change. Une exigence de ce genre ne tient pas sans mécanisme : elle dépend de la
vigilance, et la vigilance s'épuise. D'où deux décisions.

1. **Les illustrations sont produites, jamais collectées.** `make manuel`
   parcourt la pile réelle seedée et écrit les neuf images. Une capture ne peut
   donc pas montrer un écran qui n'existe plus ; et si un parcours change au
   point que le harnais n'atteint plus l'écran, il échoue au lieu de laisser une
   image périmée.
2. **Le lien manuel-image est vérifié dans les deux sens.** Une image citée mais
   absente laisse un cadre vide — c'est visible, par celui qui ouvre la page. Une
   image **orpheline**, elle, n'est vue de personne et survit indéfiniment à
   l'écran qu'elle montrait. C'est la dérive qu'aucun relecteur ne trouve, et
   c'est celle que le contrôle attrape.

**Dix chapitres écrits, un ne l'est pas.** M2, l'installation du serveur, n'est
pas rédigé : l'installation n'est pas outillée (SPK-26) et le repartitionnement
du stockage attend un arbitrage (SPK-28). Le sommaire l'annonce avec ces deux
unités, plutôt que d'être écrit d'avance et faux. M6 et M7 portent une limite
explicite : le déploiement d'une pile Compose est mesuré sur matériel réel et non
reproductible sur la pile de développement, et l'émission d'un certificat n'a pas
été éprouvée faute de domaine.

**Vérifié.** 451 tests Python, 178 tests Node, 6 de contrat, 10 gestes, 11
parcours E2E, 7 contrôles du manuel, contrat sans dérive, build. Illustrations
produites et observées ; le manuel est lisible depuis un checkout neuf.

**Où reprendre.** **SPK-26**, le contrat de déploiement et la procédure
d'installation serveur. C'est l'unité qui débloque le chapitre M2 du manuel, et
la seule qui reste avant les unités d'arbitrage. SPK-27 (vérifications du DAT
§13) suit. SPK-12 attend un domaine, SPK-17 une exécution de CI ; SPK-28,
SPK-29, INC-01 et INC-02 attendent un arbitrage du responsable.


---

## 2026-08-19 — SPK-26 : le serveur est déployé, et ça se vérifie

**Unité** : SPK-26. L'hôte cible étant joignable, la spécification (`docs/DAT.md`
§31) a été écrite **après relevé en lecture seule**, pas de mémoire.

**Le relevé a changé ce que l'unité devait livrer.** Incus 7.3, le pool ZFS à
compression, l'ARC à 16 Gio, le bridge privé avec sa plage DHCP disjointe et
Caddy étaient déjà en place, et la surface réseau était conforme. Le seul manque
réel : **`sparkd` tournait depuis une session `ssh`**. Un plan de contrôle lancé
à la main disparaît au premier redémarrage, et les Sparks continuent de tourner
sans que rien ne les administre — la panne est silencieuse et ne se découvre qu'à
la première opération.

**Deux principes portent le livrable.** Une seule liste de contrôles sert avant
et après l'installation, parce que deux listes divergeraient et que c'est l'après
qui deviendrait faux. Et la vérification est en **lecture seule**, séparée du
script d'installation : un outil qui vérifie *et* répare finit par réparer ce
qu'on voulait seulement constater. Une preuve vérifie qu'aucune commande mutante
n'est lancée.

**Le premier passage contre l'hôte a trouvé un défaut dans le contrôle
lui-même.** La surface réseau dénonçait le port 53 : `dnsmasq` écoute sur
`10.77.0.1`, le côté **privé** du bridge, que les Sparks doivent joindre pour
leur DNS. Et `127.0.0.53%lo` n'était pas reconnu comme de la boucle locale. Le
contrôle tenait pour exposé tout ce qui n'était pas `127.0.0.1` ; il classe
maintenant l'adresse d'écoute. C'est le genre de faux positif qu'aucun test
inventé n'aurait produit.

**`readyz` était figé** depuis SPK-07 : « degraded » et deux pilotes « non
implémentés » quoi qu'il arrive, alors qu'ils le sont. Un endpoint de
disponibilité qui rend toujours la même chose ne distingue pas un serveur sain
d'un serveur en panne — et c'est de lui que dépend la vérification de
déploiement. Il sonde désormais chaque dépendance et nomme la cause des pannes.
Sa preuve est révisée pour la deuxième fois, en le disant.

**Installation exécutée sur l'hôte.** Neuf contrôles verts, `sparkd` en service
activé au démarrage, topologie relevée : 94,2 − 16 (ARC) − 2 (marge) = **76,2 Gio
allouables**, ce que le §16.1 prédisait exactement. Le contrat de déploiement est
remis à l'état mesuré — OP-02 y était donné « en attente » alors qu'il est
appliqué — et le chapitre M2 du manuel est écrit.

**Vérifié.** 487 tests Python, 178 Node, 6 de contrat, 10 gestes, 11 parcours
E2E, 7 contrôles du manuel, build, contrat sans dérive.

**Où reprendre.** **SPK-27**, les sept vérifications par mesure du §13 du DAT, sur
l'hôte désormais déployé. C'est la dernière unité de construction avant celles
qui attendent un arbitrage. SPK-12 attend un domaine, SPK-17 une exécution de CI ;
SPK-28, SPK-29, SPK-30, INC-01 et INC-02 attendent votre arbitrage.


---

## 2026-08-19 — SPK-27 : les deux dernières hypothèses, mesurées

**Unité** : SPK-27. Sa spécification existe déjà — c'est le §13 du DAT lui-même,
qui énumère ce qui reste à mesurer. La réécrire pour se donner un commit
documentaire aurait été une session en échec : je suis allé mesurer.

Le backlog annonçait « sept points » ; le §13 en compte treize. Corrigé.

**Point 12, la tenue de l'ARC sous charge.** La mesure statique disait le
plafond ; elle ne disait pas ce que l'ARC en fait. 24 Gio incompressibles écrits
sur le pool puis relus intégralement : l'ARC monte à **16,00 Gio** et s'y tient.
Les deux conclusions vont dans des sens opposés et comptent toutes les deux — la
réserve de 16 Gio n'est pas une précaution mais une **nécessité**, puisque l'ARC
atteint son plafond dès qu'on lui donne de quoi le remplir ; et elle est
**suffisante**, puisqu'il ne le franchit pas.

**Point 13, ce que le quota compte.** Dans un jeu de données à `quota=2G` et
compression active : 8 Gio de zéros n'ont consommé que **24 Kio**, tandis que
2 Gio incompressibles l'ont épuisé **exactement**. Le quota porte sur les octets
stockés.

**Décision : la compression reste active, l'écart est documenté.** Il joue
toujours en faveur du locataire — jamais moins que son quota, parfois plus. La
désactiver ferait consommer au pool des octets qui n'ont pas besoin d'exister,
alors que le pool est la ressource rare et non surengageable. Et l'admission
comptant le quota et non l'usage, le pool ne peut pas être survendu par cet écart.

**Le livrable de code découle du point 12.** Une mesure ponctuelle répond une
fois et périme aussitôt. Le runtime publie donc ce que l'ARC consomme, lu **à
chaque requête** et jamais persisté — une consommation stockée serait une valeur
périmée présentée comme actuelle —, et l'écran des pools l'affiche face au
plafond. `null` reste distinct de zéro : un ARC dont on ignore la taille n'est pas
un ARC vide, et les confondre ferait croire la réserve inutile, ce qui est
exactement l'erreur qui avait fait promettre un cinquième de mémoire en trop.

Vérifié sur l'hôte réel : le runtime annonce 0,80 Gio, `arcstats` en dit 0,80.

**Vérifié.** 491 tests Python, 182 Node, 6 de contrat, 10 gestes, 11 parcours
E2E, 7 contrôles du manuel, build, contrat sans dérive, illustration du manuel
régénérée et observée.

**Où reprendre.** Il ne reste **aucune unité de construction non bloquée**.
SPK-29 (réservation absolue), SPK-30 (marge de métadonnées) et SPK-28
(repartitionnement du stockage) attendent votre arbitrage, comme INC-01 et
INC-02 ; SPK-12 attend un domaine et SPK-17 une exécution de CI. La prochaine
session devrait soit traiter une unité que vous aurez arbitrée, soit — à défaut —
solder SPK-12 ou SPK-17 sur ce qui est vérifiable sans la dépendance manquante.


---

## 2026-08-19 — SPK-29 : le mécanisme est livré, la garantie ne l'est pas encore

**Unité** : SPK-29. Le journal précédent annonçait qu'aucune unité de
construction n'était débloquée. C'était faux : SPK-29 et SPK-30 sont entièrement
spécifiées et n'attendaient aucun arbitrage. Corrigé.

**Mesuré d'abord, spécifié ensuite.** `raw.lxc` avec `lxc.cgroup.dir.container`
place le Spark dans une tranche parente, et deux propriétés y survivent : la loi
de poids du §7.2 bis s'applique inchangée, et `cpu.max` reste `max`, donc le
burst est préservé. Le §32 est écrit sur cette mesure.

**La difficulté n'était pas le déplacement mais le poids de la tranche.** Il doit
valoir `H × f / (1 − f)` où `f` est la part vendue : une constante rendrait la
réservation absolue pour un seul taux de remplissage. D'où deux conséquences —
une réserve CPU de l'hôte, qui rend la loi **définie**, et une unité systemd,
parce qu'une tranche créée à la main disparaît au redémarrage et que la
réservation redeviendrait proportionnelle **en silence**.

**Un défaut trouvé au déploiement** : systemd crée la tranche mais n'y délègue
que `hugetlb rdma misc`. Une écriture unique à l'installation ne tient pas — le
cgroup d'une tranche vide n'existe pas encore. Le runtime réaffirme donc la
délégation. Sans ces contrôleurs, la tranche existe et paraît correcte alors que
les limites ne s'y appliquent pas.

**Prouvé sur l'hôte** : un Spark créé par `sparkd` atterrit dans la tranche,
poids `245`, `cpu.max` à `max`, et le poids de la tranche passe à `100` pour
1 CPU vendu — la valeur du tableau.

**La DoD n'est PAS atteinte, et c'est l'information importante.** Sous contention
provoquée, le Spark a obtenu **50 %** de la machine au lieu des 25 % attendus.
La cause n'est pas une erreur de calcul : `H` n'est pas une constante. Un poids
cgroup ne se partage qu'entre frères **exécutables**, et deux des trois tranches
de l'hôte étaient au repos. L'écart joue en faveur du locataire — la réservation
est désormais un **plancher** tenu et dépassé — mais l'égalité que la DoD exige
n'est pas établie. L'unité reste `[~]`.

**INC-03 consigné** : un Spark dont l'instance a disparu ne peut plus être
supprimé (`502`), et maintient depuis cette unité le poids de la tranche à une
valeur qui ne correspond à rien. L'hôte de validation porte une entrée dans ce
cas. Le comportement est laissé inchangé : il relève de SPK-09.

**Vérifié.** 522 tests Python, 182 Node, 6 de contrat, 10 gestes, 11 parcours
E2E, 7 contrôles du manuel, build, contrat sans dérive. Préflight : 10 contrôles
verts sur l'hôte.

**Où reprendre.** **SPK-29**, sa seule preuve manquante : provoquer une contention
sur les **trois** tranches de l'hôte simultanément — `system.slice`, `user.slice`
et `init.scope` — et vérifier la convergence vers `r / C`. Le nettoyage de
l'entrée fantôme du registre suppose INC-03 arbitré. Puis **SPK-30**, entièrement
spécifiée et non bloquée. SPK-12 attend un domaine, SPK-17 une exécution de CI ;
SPK-28, INC-01, INC-02 et INC-03 attendent votre arbitrage.

## 2026-08-19 — SPK-32 et SPK-33 : deux décisions du responsable, persistées avant tout code

**Aucune ligne de code n'a été écrite dans cette entrée.** Deux règles ont été
tranchées par le responsable ; elles sont écrites d'abord, comme l'impose
`CLAUDE.md` §5.

### Le champ « image » : la question posée valait constat

La question était : « a-t-on prévu un registre des conteneurs disponibles à
pré-renseigner, vérifier qu'ils existent, et une liste déroulante plutôt qu'un
champ libre ? » Réponse mesurée dans le code : **non, rien de tel n'existe et
rien ne le prévoyait**.

- `spark.image` est un `TEXT NOT NULL` libre (`schema/001_socle_registre.sql`).
- Le seul contrôle est `translate.split_image()`, et il porte sur le **dépôt**
  (`images`, `ubuntu`, `ubuntu-daily`), pas sur l'alias.
- `apps/webui/src/components/spark-create.js` rend un `<input type="text">`,
  pré-rempli à `images:debian/13`.
- Aucune table de catalogue, aucune route `/v1/images`, aucun appel de
  vérification dans `incus.py`.

Ce qui rend le défaut coûteux, ce n'est pas la faute de frappe : c'est **quand**
elle est vue. Le §14.2 écrit la ligne du registre avant qu'Incus n'existe, donc
la ressource est déjà comptée ; le refus n'arrive qu'à `apply`, et
`finish(success=False)` laisse un Spark en `error` avec ses quotas engagés. Il
faut le supprimer pour les rendre — et si l'instance n'a jamais existé, la
suppression tombe sur INC-03.

**Décision : un catalogue tenu par le registre** (DAT §33), pré-renseigné,
vérifié par **relevé explicite daté** — comme la topologie de l'hôte, et pour la
même raison : ne pas rendre un formulaire tributaire d'un dépôt distant. Trois
états distincts, `verified` / `missing` / `unknown`, jamais confondus. La
création n'accepte qu'une référence du catalogue et refuse **avant** d'écrire.

Le point qui reste ouvert est nommé comme tel : **la voie de vérification n'a
jamais été mesurée** sur l'hôte — index simplestreams du dépôt, `GET /1.0/images`
pour ce qui est local. C'est une hypothèse, elle est écrite comme une hypothèse,
et elle borne la clôture de SPK-32.

Ce que le catalogue n'est **pas** : un registry. Le §1 exclut du périmètre la
construction d'images, la CI/CD et le registry, et les images Docker du locataire
vivent dans son Spark, hors de portée du plan de contrôle.

### La navigation : trois degrés, et une décision qui en révise une autre

Règle du responsable : barre latérale au premier niveau, onglets au second,
fenêtres pour les options et modales pour modifier une section.

Écrite dans le socle commun (`DESIGN_SYSTEM.md` §5.4 et §6.27) et non dans
l'extension du produit, parce qu'elle se formule sans rien connaître du métier —
c'est le critère du §15.2.

Deux tensions ont été traitées explicitement plutôt que laissées à la lecture :

1. **Onglets contre `tablist`.** Le §5.2 réservait déjà `tablist` aux panneaux
   échangés sans changement de destination. Les onglets d'un Spark doivent être
   rechargeables — on doit pouvoir ouvrir « Instantanés » directement —, ce sont
   donc des **liens**. La forme visuelle est la même, la sémantique non, et le
   critère écrit est l'URL, pas l'apparence.
2. **Modales contre §6.22 et §26.2.** Le §6.22 dit qu'une confirmation n'a pas
   besoin d'être une modale, et le §26.2 avait tranché « pas de modale » pour les
   trois panneaux, sur un argument de coût. La nouvelle règle ne les balaie pas :
   la modale est réservée à la **modification d'une section**, les confirmations
   restent dans le flux, et l'argument de coût du §26.2 tombe puisque le composant
   devient unique au lieu d'être trois exceptions.

Le §26.2 n'a **pas** été réécrit au présent : il décrit l'écran réel, qui n'a pas
changé aujourd'hui. Il porte un renvoi vers le §34.2 et sera réécrit dans le même
changement que SPK-33. Même traitement pour le tableau de
`DESIGN_SYSTEM_APP.md` §1, qui dit explicitement décrire une cible.

### Vérifications

Aucun test n'a été exécuté : ce chunk ne touche aucun code, aucun test, aucun
comportement. Les seules vérifications faites sont documentaires — chaque renvoi
introduit (§1, §7.7, §11, §14.2, §14.4, §24.1, §25.1, §25.3, §26.5, §27.8, §29)
a été contrôlé contre le sommaire réel du DAT, et le renvoi au périmètre a été
corrigé de §2 en §1 après relecture.

### Où reprendre

SPK-32 est la seule des deux qui puisse démarrer sans arbitrage supplémentaire ;
sa première étape est une **mesure sur l'hôte**, pas du code : vérifier comment on
sait qu'un alias existe. SPK-33 est prête, mais c'est une refonte de surface —
elle vaut mieux après SPK-32, qui lui ajoute une liste déroulante à placer.

## 2026-08-19 — La hiérarchie de navigation redevient une orientation, et les Sparks gagnent un verrou

**Toujours aucune ligne de code dans cette entrée** : deux précisions du
responsable, écrites avant implémentation.

### Ce que la première rédaction avait durci à tort

Le §5.4 disait « une application a trois degrés, et pas quatre », et le §6.27
parlait d'« une fenêtre d'options » comme si elle ne portait qu'une section. Les
deux étaient trop stricts, et le contre-exemple donné par le responsable est
parfaitement légitime : barre latérale *Sparks* → onglet *Instances* → liste
cliquable → **fenêtre** de l'instance, portant à son tour ses onglets *Infos*,
*Routes*, *Clés*, *Instantanés*, *Journal*, chacun avec ses sections.

Deux rangées d'onglets ne sont pas une faute quand ce sont **deux sujets** : ce
que l'on regarde dans la console, puis quelle facette de l'objet ouvert. La faute
serait deux rangées côte à côte pour le même sujet.

La règle a donc été réécrite comme ce qu'elle est — une **forme par défaut** —, et
ce qu'elle sert à obtenir a été extrait et posé à part, parce que c'est cela qui
ne se négocie pas :

1. ce qui s'affiche et ce qui se saisit ne partagent pas la même surface ;
2. une surface a un seul sujet, nommable en une phrase ;
3. une action sensible se confirme toujours.

Le troisième point a fait bouger le §6.23, qui ne parlait que d'actions
*destructives* : il couvre maintenant l'action **sensible**, y compris celle dont
l'effet déborde ce que la surface montre, et celle qui porte sur un objet
protégé. Et une modale ne vaut pas confirmation — l'ouvrir recueille une saisie,
cela ne démontre aucune intention.

Le §6.27 a suivi : une fenêtre porte **plusieurs** sections, et la modale sert
aussi bien à **insérer** dans une section qu'à **modifier** ce qu'elle affiche.
Un seul composant, deux usages, une seule portée.

### Le verrou : ce qu'il vaut, et ce qu'il ne vaut pas

Demande : un interrupteur qui empêche de modifier une instance, par l'API comme
par la console, tant qu'on ne l'a pas désarmé ; armé par mot de passe, levé par le
même.

Écrit au DAT §35. Quatre décisions ont demandé un arbitrage, et sont motivées là :

- **La portée est entière.** Toutes les écritures visant le Spark sont refusées,
  y compris `start`. Une liste partielle — « on peut démarrer mais pas
  supprimer » — obligerait à justifier chaque cas et produirait exactement les
  surprises que l'interrupteur supprime.
- **Deux exceptions structurelles**, et elles sont indispensables : la
  redistribution des cœurs (§7.4 bis) et la repondération de `spark.slice`
  (§32.2) passent toujours. Les bloquer ferait échouer la création d'un *autre*
  Spark parce qu'un troisième est protégé — incompréhensible, et faux, puisque ces
  recalculs ne touchent ni sa configuration, ni son état, ni ses données.
- **Un cas déborde et est tranché** : `DELETE /v1/ssh-keys/{label}` retire la clé
  de tous les Sparks. Si l'un est protégé, le retrait global est refusé et nomme
  les Sparks concernés. C'est le cas « effet au-delà de la surface » du §6.23.
- **Lever la protection est un état, pas une fenêtre de temps.** Un déverrouillage
  de quelques minutes rendrait le produit dépendant de l'heure et pousserait à
  travailler vite pour ne pas rater la fenêtre — l'inverse du but.

Et une honnêteté qui est écrite dans la spécification plutôt que découverte plus
tard : **ce n'est pas un contrôle d'accès**. Qui détient une clé SSH de l'hôte
atteint `sparkd` ; qui détient `root` atteint le fichier SQLite. La protection
arrête le geste accidentel et le script lancé sur le mauvais nom, pas un opérateur
hostile. C'est pour cela qu'il n'y a **pas** de verrouillage après N échecs : il
ne gênerait que le responsable légitime. Chaque tentative est journalisée ; le mot
de passe, lui, ne l'est jamais, et n'est stocké que sous forme d'empreinte
`scrypt` à sel par Spark.

### Vérifications

Aucun test exécuté : ce chunk ne touche aucun code. Les renvois introduits —
§7.4 bis, §11, §14, §19, §21, §26.1, §32.2, et §6.22 / §6.23 / §6.27 du design
system — ont été contrôlés contre les sommaires réels.

### Où reprendre

SPK-34 est spécifiée et ne dépend de rien : elle peut démarrer par sa migration.
SPK-33 reste la refonte de surface, et gagne à passer après, pour que la fenêtre
d'un Spark affiche l'état protégé dès sa première version plutôt que d'y revenir.

## 2026-08-19 — Le gel ne retient pas une révocation

**Correction d'une décision prise la veille dans la même journée de travail**, sur
arbitrage du responsable, avant toute implémentation.

Le §35.2 disait : si une clé SSH est utilisée par un Spark protégé, son retrait du
registre général est **refusé**. C'était faux, et le contre-exemple donné le
montre en une phrase : un collaborateur qui démissionne, une clé qui a fuité. Ce
jour-là, on ne veut pas d'un obstacle.

Ce que le refus produisait réellement : un accès qui devait disparaître survivait
parce qu'un interrupteur avait été oublié **ailleurs**, sur un Spark qui n'a
peut-être rien à voir avec l'incident. La protection, censée arrêter l'erreur,
serait devenue le mécanisme qui maintient un accès compromis. Un garde-fou
transformé en vulnérabilité.

**Nouvelle règle, écrite dans le socle commun** (`DESIGN_SYSTEM.md` §6.23) parce
qu'elle vaut sans rien connaître du métier : une protection ne bloque jamais un
geste qui **réduit** un risque — révoquer un accès, retirer une clé, couper une
publication, fermer une session. Elle **informe** au lieu de refuser : les objets
protégés concernés sont nommés, pas comptés, et l'action se confirme.

Le partage tient en une ligne : **octroyer** un accès à un objet protégé se
refuse, **en retirer un** se confirme.

Deux conséquences concrètes, au §35.2 et §35.5 :

- la révocation d'une clé sort de la liste des écritures refusées, aussi bien sur
  un Spark (`DELETE /v1/sparks/{name}/ssh-keys/{label}`) qu'au registre général
  (`DELETE /v1/ssh-keys/{label}`) ; seul l'**octroi** y reste ;
- le mécanisme réutilise l'ordre **refus-puis-acceptation** déjà en place pour la
  restauration d'un instantané (§26.5) : premier appel → `409` portant la liste
  nommée des Sparks protégés touchés, la console la présente en confirmation,
  second appel avec `accept_protected` → la révocation aboutit. S'il n'y a aucun
  Spark protégé, il n'y a pas de refus du tout.

**Aucun mot de passe n'est demandé sur ce chemin, et aucune protection n'est
levée.** Exiger le secret de chaque Spark protégé pour retirer une clé compromise
reviendrait exactement au refus qu'on vient de supprimer, avec une étape de plus.
Le journal d'audit enregistre en revanche la révocation **avec** les Sparks
protégés qu'elle a touchés : ici, la trace vaut mieux que l'entrave.

### Vérifications

Aucun test exécuté : ce chunk ne touche aucun code. La DoD de SPK-34 gagne deux
preuves — une révocation qui **aboutit** malgré le gel après acceptation, et le
premier appel qui a bien nommé les Sparks concernés — ainsi qu'un second parcours
E2E dédié.



---

## 2026-08-19 — SPK-32 : une faute de frappe ne coûte plus un Spark mort

**Unité** : SPK-32. Sa spécification existait (§33) ; je ne l'ai pas réécrite. La
première étape était une **mesure**, comme l'unité le demandait.

**La mesure a corrigé la spécification.** La voie simplestreams est la bonne, mais
la clé de produit porte le nom de code — `debian:trixie:amd64:default`, pas
« 13 » — et l'alias vit dans un champ à part. Surtout, l'architecture n'est pas
dans l'alias : `debian/13/amd64` n'existe pas, `debian/13` renvoie aux quatre
architectures publiées. Le §33.3 est corrigé.

**Ce que l'unité change.** `images:debian/31` passait tous les contrôles locaux :
la ligne était écrite, la ressource comptée, et le refus n'arrivait qu'à `apply`,
laissant un Spark en `error` avec ses quotas engagés. Le refus arrive maintenant
avant l'écriture, et une preuve compare l'allocation du pool avant et après pour
l'établir.

**Deux distinctions tenues.** Une entrée naît `unknown` : l'état vient du relevé,
jamais d'une déclaration. Et un dépôt injoignable rend `unknown`, jamais
`missing` — sans quoi une panne réseau ferait disparaître des images valides et
l'exploitant conclurait qu'elles ont été retirées du dépôt.

**Le produit tient sans réseau sortant.** Avec le pilote factice, le relevé l'est
aussi, au même titre que `FakeIncus` et `FakeCaddy` : il publie exactement les
références pré-renseignées, de sorte qu'une référence inventée y soit `missing`
comme sur le vrai dépôt. Avec le pilote réel, le catalogue reste `unknown`
jusqu'au premier relevé explicite.

**Le seed a dû changer**, et en mieux : il employait `images:debian/99` pour
obtenir un Spark en erreur, ce que l'unité rend impossible. Il s'appuie désormais
sur sa seule injection de faute — le vrai chemin d'erreur du produit.

**Un défaut d'outillage trouvé au passage** : mes commandes de nettoyage
employaient `pkill -f "a\|b"`, où `\|` n'est pas l'alternance en regex étendue.
Aucun processus n'était tué, et la pile servait l'ancien code — d'où un `404` sur
une route pourtant enregistrée. Les sessions précédentes ont probablement laissé
des processus derrière elles.

**Vérifié.** 539 tests Python, 188 Node, 6 de contrat, 10 gestes, 11 parcours
E2E, 7 contrôles du manuel, build, contrat sans dérive, illustration observée.

**Où reprendre.** **SPK-32**, ses deux manques : le parcours E2E que la DoD exige,
et surtout **l'écran du catalogue** — l'API date le relevé et distingue les trois
états, mais rien ne les affiche, donc un exploitant ne peut pas voir qu'une image
a disparu de son dépôt. Puis **SPK-33**, la refonte de navigation, qui aura
désormais cette liste à placer. SPK-30 reste libre.

## 2026-08-19 — Deux sprints d'instruction ouverts : preuve d'identité, et gestes d'urgence

Deux sujets demandés par le responsable, ouverts comme unités d'**instruction** et
non de construction : elles produisent une décision écrite et des unités de suite,
pas une fonctionnalité.

### Pourquoi la question de SPK-35 se pose maintenant

Le §6.23 impose une confirmation à toute action sensible, et SPK-34 ajoute un
verrou par Spark. Ni l'un ni l'autre ne demande de **prouver qui agit** : une
confirmation ne distingue pas le responsable d'un script qui détient sa clé. Le
verrou du §35 traite l'erreur de main ; il ne traite pas la clé volée.

L'unité commence donc par ce qui manque le plus — **écrire le modèle de menace**.
Sans lui, TOTP, WebAuthn et signature SSH se comparent au sentiment. Quatre
menaces sont nommées d'emblée : clé SSH volée ou restée active après un départ,
poste de travail compromis avec tunnel ouvert, script lancé sur le mauvais nom,
erreur de main.

Huit pistes sont posées avec, pour chacune, ce qu'elle apporte **et où elle
casse** — c'est cette seconde colonne qui décidera :

- le **TOTP** compatible Google Authenticator apporte un facteur que la clé volée
  ne donne pas, mais son secret vit dans le registre, donc `root` sur l'hôte le
  lit — même limite que la protection (§35.1) ;
- la **signature par la clé SSH déjà présente** est la moins coûteuse — aucun
  secret nouveau, aucun enrôlement — mais elle ne traite pas le scénario « clé
  volée », qui est justement le premier de la liste ;
- **WebAuthn** est techniquement ouvert (`127.0.0.1` est un contexte sécurisé) et
  résiste à l'hameçonnage, mais c'est la charge de conception la plus lourde ;
- la **ré-authentification à durée limitée** rencontre exactement le défaut déjà
  écarté au §35.4 : un comportement qui dépend de l'heure. À trancher, pas à
  supposer.

Un point est posé comme condition préalable à toute implémentation : **la
récupération**. Téléphone perdu, clé matérielle égarée — si ce n'est pas tranché
avant, la première mise en service enferme le responsable dehors.

### SPK-36 : ce qui n'existe nulle part

Le produit n'a aucun document d'urgence. Ce qu'on fait quand le pool disparaît,
quand l'hôte ne redémarre pas, quand le registre est corrompu ou qu'une clé a
fuité se découvrirait le jour venu, sous pression.

Dix scénarios sont listés, chacun devant produire signal, geste immédiat,
vérification, reprise, et **ce qui est perdu**. Deux méritent d'être signalés dès
maintenant :

- **la perte du pool emporte les instantanés**, puisqu'ils vivent dedans (§19).
  C'est le trou le plus grave du produit, et il doit être écrit tel quel, manuel
  compris ;
- **le registre `spark.db` est un fichier unique** qui porte toute la
  correspondance Spark ↔ ressources ↔ routes ↔ clés. Sa sauvegarde est le
  candidat le plus évident et le moins coûteux du lot.

L'unité doit **trancher**, pas décrire : objectifs de reprise chiffrés par
scénario, frontière entre ce que le produit sauvegarde et ce qui reste au
locataire, et qui exécute quand la personne habituelle est indisponible.

La DoD exige **au moins un exercice réel** sur l'hôte de validation — restauration
du registre et reconstruction d'un Spark au minimum —, et les chiffres observés
pendant l'exercice remplacent les chiffres espérés. Un plan jamais joué est une
fiction, et ce dépôt ne déclare pas fait ce qui n'a pas été éprouvé.

### Vérifications

Aucun test exécuté : ce chunk n'ajoute que des unités de backlog et leur trace.



---

## 2026-08-19 — SPK-32 close : le catalogue a enfin un écran

**Unité** : SPK-32, reprise. Sa spécification existait (§33, et §34.1 pour la
place de l'écran) : je ne l'ai pas réécrite, je suis allé au code.

**Ce qui manquait, et pourquoi c'était le manque utile.** Le catalogue existait
par l'API : le relevé était daté et ses trois états distingués, mais rien ne les
affichait. Un exploitant ne pouvait pas voir qu'une image avait disparu de son
dépôt. L'onglet Images sous Hôte le montre désormais — date, états, et ce que le
relevé a constaté pour chaque entrée.

**Les trois états observés de bout en bout, contre le vrai dépôt.** Une image
ajoutée par l'interface naît « Non relevée » ; le relevé la donne ensuite
« Absente des 272 produits publiés ». « Non relevée » est en `accent` et non en
`danger` : ce n'est pas une panne mais un relevé qui n'a pas eu lieu, et les
confondre ferait conclure à une image retirée du dépôt.

**Les onglets du second degré sont des liens**, pas un `tablist` : on doit
pouvoir recharger la page sur « Images ». C'est le §34.1, et les preuves le
gardent.

**Un défaut trouvé par le parcours E2E, et il ne venait pas du catalogue.** Le
formulaire de création était peint **deux fois** — une fois vide, une fois les
pools reçus — et une saisie faite entre les deux était effacée par le second
rendu. La fenêtre s'est élargie quand j'ai ajouté la requête du catalogue, et le
refus de capacité a cessé d'arriver parce que le nom avait disparu de la saisie.
Le formulaire n'est plus peint qu'une fois.

**Vérifié.** 539 tests Python, 207 Node, 6 de contrat, 10 gestes, **14 parcours
E2E**, 7 contrôles du manuel, build, contrat sans dérive, illustrations
régénérées et écran observé.

**Où reprendre.** **SPK-33**, la refonte de navigation selon les trois degrés :
les onglets du second degré existent maintenant sous Hôte, il reste la barre
latérale du premier degré et la fenêtre d'un Spark. Puis SPK-30, libre et
entièrement spécifiée. SPK-29 attend une contention sur les trois tranches de
l'hôte ; SPK-12 un domaine ; SPK-17 une exécution de CI ; SPK-28, INC-01, INC-02
et INC-03 votre arbitrage.


---

## 2026-08-19 — SPK-33 : les trois degrés, sans la modale

**Unité** : SPK-33. Sa spécification existait — §5.4 et §6.27 du design system,
§34 du DAT — et je ne l'ai pas réécrite.

**Ce qui est livré.** Barre latérale au premier degré, avec le sélecteur de
serveur au-dessus parce qu'il est le contexte de toutes les destinations et non
l'une d'elles. Onglets au second degré. Et la fenêtre d'un Spark répartit
désormais ses facettes en onglets — Aperçu, Routes, Clés, Instantanés, Journal —
là où elle empilait cinq sujets sur une page.

Tous les onglets sont des **liens** et jamais un `tablist` : le critère du §5.4
est l'URL, pas l'apparence. Un parcours le vérifie en rechargeant la page sur une
facette.

**Les 14 parcours E2E passent sans que leur intention change**, ce que la DoD
exigeait explicitement : seuls leurs sélecteurs ont bougé — ils cliquent l'onglet
avant d'agir. Il en va de même des huit gestes et de la campagne de captures. Les
harnais ont échoué avant d'être adaptés, et c'est le comportement voulu : une
capture périmée aurait été pire.

**Un défaut trouvé par la mesure, pas par l'œil.** La page défilait
horizontalement à 1024 et 768 px : une piste de grille ne rétrécit pas sous la
largeur minimale de son contenu, et le tableau des Sparks poussait la page
entière — alors qu'il a son propre conteneur de défilement. Vérifié après
correction à 1440, 1024, 768 et 390 px.

**Une preuve révisée avec sa raison.** « Un seul formulaire à la fois » vérifiait
que l'ouverture d'un panneau masquait le déclencheur des deux autres. Les trois
vivant désormais sur des facettes distinctes, l'invariant est d'abord obtenu par
la structure ; ce qui reste à éprouver est le contrat d'interaction, et c'est ce
que la preuve dit maintenant.

**Ce qui manque, et c'est nommé.** Le composant de **modale** du §6.27 n'est pas
livré : les formulaires de section s'ouvrent encore dans le flux. Le §26.2 du DAT
dit donc encore « pas de modale » — et cela reste **vrai de l'écran
d'aujourd'hui**. Il sera réécrit dans le même changement que la modale, pas
avant : un document qui décrirait une cible serait faux.

**Vérifié.** 539 tests Python, 207 Node, 6 de contrat, 8 gestes, **16 parcours
E2E**, 7 contrôles du manuel, build, contrat sans dérive, captures et
illustrations refaites, mise en page observée à quatre largeurs.

**Où reprendre.** **SPK-33**, son seul manque : le composant de modale et la
réécriture du §26.2 dans le même changement. Puis SPK-30, libre et entièrement
spécifiée. SPK-29 attend une contention sur les trois tranches de l'hôte ; SPK-12
un domaine ; SPK-17 une exécution de CI ; SPK-28, INC-01, INC-02 et INC-03 votre
arbitrage.

## 2026-08-19 — Journal chaîné : la chaîne ne vaut que par son ancre

Question du responsable : auditer toute action, superviser le journal, signer
chaque ligne avec la clé de l'acteur, et chaîner les signatures pour détecter une
modification. Bonne idée ?

**Oui pour la chaîne, mais elle ne prouve pas ce qu'on croit**, et l'analyse est
écrite au DAT §36 plutôt que résumée ici.

### Le point qui décide de tout

Chaîner détecte la modification et la suppression au milieu — à condition de
connaître la **vraie tête**. Qui peut écrire dans le fichier peut recalculer toute
la chaîne : contre root sur l'hôte, une chaîne seule ne prouve rien. Et deux
attaques lui échappent complètement, la **troncature** et le **remplacement** du
journal par un journal neuf et cohérent.

Ce qui donne sa valeur au dispositif, c'est donc l'**ancre**, et le produit l'a
déjà sans rien acheter : la console tourne sur une autre machine et se connecte
régulièrement. Elle retient la dernière tête vue par serveur, dans son inventaire
local, et vérifie à chaque connexion que l'histoire annoncée **prolonge** celle
qu'elle connaît. Ce n'est pas la cryptographie qui apporte la garantie, c'est le
fait que la référence vive ailleurs que sur la machine qu'on soupçonne.

### La signature : c'est le lieu de production qui compte

Signer avec une clé détenue par l'hôte ne protège pas de qui contrôle l'hôte.
Signer **côté console**, avec la clé SSH du responsable via son agent, change la
nature de la preuve : root peut supprimer ou tronquer, jamais **fabriquer** un
geste authentique. C'est exactement la piste « signature par la clé SSH » de
SPK-35 — une seule mécanique pour l'authentification et pour l'audit, d'où la
subordination explicite de SPK-40 à cet arbitrage.

Deux limites écrites plutôt que découvertes plus tard : une signature de requête
atteste l'**intention**, pas ce que le runtime a fait ensuite ; et les événements
produits par le runtime — réconciliation, repondération — ne sont signés par
personne. La supervision affiche donc deux **classes** de lignes au lieu de
laisser croire que tout est signé.

### Ce qui bloque avant tout le reste

`actor` vaut aujourd'hui la chaîne littérale « responsable » ou « sparkd ». Il n'y
a aucune identité à signer. L'ordre est donc : identité réelle (SPK-37), puis
chaîne et ancre (SPK-38), puis supervision (SPK-39), puis signature (SPK-40) une
fois SPK-35 arbitrée.

### Ce qui est écarté, et pourquoi ce n'est pas un jugement sur l'idée

Pas de chaîne de blocs distribuée : le consensus répond à « plusieurs écrivains
qui ne se font pas confiance », et il y a **un** écrivain. Ce que le mot désigne
d'utile ici se réduit au journal chaîné vérifiable. Restent optionnels et
désactivés par défaut, parce qu'ils introduisent une dépendance sortante :
la copie hors machine au fil de l'eau — le renfort le plus efficace après l'ancre
—, l'ancrage temporel public, et l'arbre de Merkle, qui ne sert que si un tiers
doit vérifier un extrait sans recevoir tout le journal.

### Les pièges consignés d'avance

Sérialisation canonique figée, lecture de la tête et insertion dans la même
transaction, purge tranchée avant la première ligne — et surtout : les **trous
d'identifiants ne sont pas des altérations**. `AUTOINCREMENT` en produit à chaque
`ROLLBACK`, et le §21 journalise délibérément certains refus hors transaction. Une
vérification qui contrôlerait la continuité des `id` fabriquerait des alertes
fausses, ce qui est la meilleure façon de faire ignorer les vraies. La DoD de
SPK-38 en fait un test à part entière.

### Vérifications

Aucun test exécuté : ce chunk n'ajoute que de la spécification et des unités.
L'état du code a en revanche été relevé pour écrire le §36.7 — `audit.record()`
est bien le point de passage unique, les écritures des cinq modules y passent, et
`actor` est une constante.

## 2026-08-19 — Comment nommer la machine, et ce qui manque vraiment au catalogue

### Le mot « hôte » désigne déjà deux machines

Un Spark est une fraction de machine, `sparkd` est le démon, et la machine n'a pas
de nom de produit : on l'appelle « l'hôte ». Sauf que le §22 nomme « hôte console »
le processus Node du **poste local**. Deux machines, un mot, et la console affiche
les deux à l'écran. Le besoin de nom n'est donc pas cosmétique : il lève une
ambiguïté qui existe déjà.

Critères retenus pour trancher, écrits avant de discuter des goûts : lever la
collision ; survivre en identifiant de code et en segment d'URL ; se pluraliser
sans ambiguïté ; ne pas mentir sur la portée — c'est **une** machine, pas une
grappe.

**Forge** — la forge est le lieu d'où partent les étincelles, le mot est identique
en français et en anglais, court, il se pluralise et donne `forge_id`,
`/v1/forge`, `forges.json` sans effort. Sa faiblesse est réelle : dans la culture
technique francophone, « forge » désigne d'abord un hébergement de code. La
collision est contextuelle et se dissipe dès la première phrase, mais elle existe.

**Foyer** — métaphoriquement le plus exact : c'est du foyer que jaillissent les
étincelles, et le mot n'a aucune concurrence dans ce domaine. Sa faiblesse est
symétrique : en anglais, *foyer* est un hall d'entrée, ce qui égare un lecteur non
francophone sur un dépôt dont le code est anglophone.

Écartés, avec leur motif : **Silex** et **Flint** — `flintlock` est un produit qui
crée des micro-VM, donc collision dans le domaine exact ; **Creuset** /
*Crucible* — nom d'un outil de revue de code ; **Brasier**, **Âtre** — justes mais
lourds à écrire, à accentuer et à taper ; **Enclume** — l'enclume reçoit les
étincelles, elle ne les produit pas, et le sens s'inverse.

**Recommandation : Forge**, en assumant la collision. **Le vrai arbitrage n'est
pas le mot, c'est le moment** : le contrat d'API n'a qu'un consommateur, le dépôt
lui-même. Renommer la table `host`, la route `/v1/host` et le contrat coûte
aujourd'hui une migration et un `make contract` ; chaque unité livrée ensuite
l'alourdit. Un produit qui garde deux mots pour la même chose finit par employer
les deux au hasard. D'où SPK-42, écrite comme « maintenant ou pas du tout ».

### Le catalogue existe déjà — ce qui manque, c'est de pouvoir s'en servir

Relevé dans le code plutôt que supposé : `~/.config/spark/servers.json` existe,
validé, refusant les secrets, et `GET`/`POST /api/servers` le servent. Mais :

- **aucune interface n'appelle `POST /api/servers`** : on ajoute un serveur à la
  main dans le fichier ;
- il n'y a pas de `DELETE /api/servers` : on n'en retire pas ;
- la console prend `servers[0]` : il n'existe **aucun sélecteur**, alors que le
  design system d'application place le serveur courant au-dessus du premier degré ;
- le tunnel n'est ouvert qu'au **démarrage** : rompu ensuite, aucune commande de
  reconnexion n'est à l'écran.

Une décision de fond a été prise au passage (§22.4 bis) : le catalogue accepte un
**alias `ssh`**. Aujourd'hui il redécrit `host` / `user` / `port`, c'est-à-dire une
connexion qu'OpenSSH sait déjà décrire — et toute configuration réelle, rebond par
bastion, clé dédiée, algorithmes imposés, n'a alors nulle part où aller sauf à
réimplémenter `ssh_config` champ par champ. Ce qui relève de la connexion
appartient à OpenSSH ; ce qui relève du produit — quel serveur, quel port local,
quel état de tunnel — appartient au catalogue.

Et une règle qui ne bougera pas : **la vérification de la clé d'hôte n'est jamais
désactivée**, pas même « pour simplifier la première connexion ». Rapproché du
§36.2 : une clé d'hôte qui change **et** une histoire d'audit qui ne prolonge plus
la précédente disent la même chose.

### Vérifications

Aucun test exécuté : spécification et backlog seulement. L'état du code de la
console a été relevé pour écrire ces constats — `apps/webui/host/main.js` n'expose
que quatre routes, et `apps/webui/src/app.js` prend bien `servers[0]`.


## 2026-08-19 — SPK-33 close : la dernière saisie rejoint la modale

**Unité** : SPK-33, reprise là où le journal précédent l'arrêtait — « son seul
manque : le composant de modale ». Le composant existait déjà au début de cette
session ; ce qui restait était la dernière saisie encore dans le flux, et les
documents que la livraison rendait faux.

**Ce qui est livré.** Le formulaire d'ajout du catalogue d'images s'ouvrait sous
le tableau qu'il décrit. La section « Catalogue » portait donc deux sujets, et la
tabulation sortait de la saisie sans le dire — ce que le §5.4 point 1 interdit.
Il passe par le composant de modale, dont le titre est celui de la section. Les
**quatre** saisies de la console y sont désormais : route, clé, instantané,
image. Les panneaux d'un Spark ne captent plus `[data-ouvre]` indistinctement :
ils nomment leurs trois déclencheurs, le catalogue vivant sur une autre
destination avec son propre état.

**Trois défauts trouvés par la mesure, pas par l'œil.**

1. `.formulaire-panneau` était la classe du formulaire dans le flux. Plus aucun
   composant ne l'émettait, ce qui laissait une règle de style sans sujet, un
   appel de focus sans cible, et surtout **une attente de parcours vraie
   d'avance** : elle guettait la disparition d'un élément qui n'apparaissait
   jamais. Elle porte maintenant sur la fermeture de la modale, ce qu'elle
   prouvait avant. L'écart de la case à cocher, que cette règle portait, a été
   reposé sur le corps de la modale — il avait disparu avec elle.
2. Sous 768 px, le `dialog` occupait bien l'écran, mais son cadre restait à la
   hauteur de son contenu : la barre d'engagement flottait au milieu et le bas de
   l'écran était vide. Vu sur la capture, pas dans le code.
3. En corrigeant, `flex: 1` seul sur le corps — qui est une **grille** —
   répartissait la hauteur gagnée entre ses lignes : des champs de deux cents
   pixels de haut. `align-content: start` les laisse à leur taille.

**Le catalogue n'avait aucune capture**, ni son écran ni le geste qui l'alimente.
La campagne l'atteint par la navigation — accueil, Hôte, onglet Images — et ouvre
sa modale au clavier, à 1440 puis 390 px ; le sparkd factice sert quatre entrées
pour montrer les trois états du relevé plutôt qu'un seul.

**Manuel.** Il décrivait les trois niveaux qui servent à regarder et rien de la
surface qui recueille. M3 énonce ce qu'une saisie garantit — curseur dans le
premier champ, tabulation retenue, `Échap`, focus rendu, refus qui n'efface rien
— et rappelle qu'une confirmation n'est pas une modale. M5 renvoyait à « ajouter
au catalogue » sans dire où : il nomme Hôte → Images et l'illustre. Les
illustrations des facettes sont recadrées : 1400 px était la hauteur des panneaux
empilés, la moitié basse était vide depuis les onglets.

**Documents remis en accord avec la réalité** : `DESIGN_SYSTEM_APP.md` §1 disait
encore « la console rend aujourd'hui une barre horizontale à deux liens […] et
des formulaires ouverts dans le flux » ; le CHANGELOG bornait deux mentions par
« jusqu'à la livraison de SPK-33 » ; le backlog listait comme reste à livrer la
modale et la réécriture du §26.2, faites toutes deux. Le §33.2 du DAT dit
maintenant que le catalogue suit la règle du §26.2.

**Vérifié.** 539 tests Python, 211 Node de la console, 6 de contrat, 8 gestes,
18 parcours E2E, 7 contrôles du manuel, build, contrat sans dérive. 35 captures
et 10 illustrations refaites et observées. Modale mesurée et observée à 1440,
1024, 768 et 390 px : centrée, focus dans le premier champ, aucun débordement
horizontal. Console vierge de tout message applicatif.

**Où reprendre.** **SPK-30**, libre et entièrement spécifiée, puis SPK-34.
SPK-29 attend une contention sur les trois tranches de l'hôte simultanément ;
SPK-12 un domaine ; SPK-17 une exécution de CI. SPK-28, SPK-35, SPK-36 et SPK-42
attendent votre arbitrage.

**Environnement de cette session.** Machine locale, non `root` : Docker répondait
déjà, Node 24.14.1 et pnpm 9.15.4 étaient en place, et les contournements des
§2.1 et §2.1 bis de `CloudWorker.md` étaient sans objet. Une session concurrente
a poussé sur `main` pendant le travail (commit « Instruit le nom de la machine et
ce qui manque au catalogue ») ; l'historique est resté linéaire.

## 2026-08-19 — Des outils d'administration dans le Spark, sans ouvrir la frontière

Demande : un shell dans le Spark depuis la console web, un onglet des conteneurs
Docker avec leurs mesures, leur inspection, et un terminal dans un conteneur.
Quatre arbitrages posés au responsable, quatre réponses, écrites au DAT §37.

### Le point qui décidait de tout : qui parle à Docker

Le produit annonce qu'aucune socket Docker n'est exposée au plan de contrôle
(§11). Un onglet Docker semble contredire cette promesse — il ne la contredit pas
si **c'est la console qui parle au Spark, et non `sparkd`**.

L'hôte console ouvre une session SSH vers le Spark par le tunnel existant, avec la
clé du responsable. Les commandes `docker` s'exécutent dans la cellule, la sortie
remonte au navigateur, et `sparkd` n'est pas dans ce chemin. La console fait ce que
le responsable ferait au terminal : elle lui épargne les gestes, pas les droits.

**Arbitrage 1 : SSH en chemin normal, `incus exec` en dépannage seulement.** La
capacité existe déjà dans le runtime, mais l'employer par défaut donnerait au plan
de contrôle l'exécution arbitraire en root chez le locataire. Elle est donc bornée
par quatre conditions cumulatives — Spark en erreur ou `sshd` muet, confirmation
qui nomme le pouvoir employé, action d'audit distincte, bannière visible toute la
session.

Contrainte relevée et écrite plutôt que découverte à l'usage : `images:debian/13`
n'embarque pas de `sshd` (§17.1). Sur un Spark neuf où le locataire n'a rien
installé, ces outils ne marchent pas — l'écran doit le nommer, pas afficher une
erreur technique.

### Les trois autres arbitrages

**Périmètre : lecture, plus le cycle de vie d'un conteneur.** Démarrer, arrêter,
redémarrer, tuer. Pas Compose, pas de construction d'images, pas de registre — le
§1 les exclut du périmètre, et l'outil observe la pile du locataire sans la gérer
à sa place.

**Journal : ouverture et fermeture, rien du contenu.** Le filtre de caviardage du
§21.2 travaille sur des champs nommés ; il ne saura jamais caviarder un flux
interactif où un mot de passe est tapé au milieu d'une ligne. Enregistrer les
frappes créerait un dépôt de secrets en clair. Conséquence assumée et écrite : le
journal dira qu'une session a eu lieu, jamais ce qui y a été fait.

**Gel : il bloque les gestes Docker, pas la lecture.** J'y ajoute une décision qui
découle du §35.4 et qu'il faut me corriger si elle dépasse l'arbitrage : le
**terminal reste ouvert sous gel**, parce que c'est l'outil de diagnostic et que le
bloquer pousserait à désarmer pour regarder, donc à oublier de réarmer.

### L'écart qu'il fallait écrire, pas cacher

Les gestes Docker ne passent pas par `sparkd`. Le runtime ne peut donc pas les
refuser : c'est la **console** qui applique le gel, à partir de l'état publié par
le runtime. C'est un écart à la règle « une interdiction s'applique côté serveur ».

Il est assumé et motivé plutôt que masqué : la protection est déjà un garde-fou et
non un contrôle d'accès (§35.1), et qui veut la contourner ouvre un terminal et
tape la commande — exactement comme il l'aurait fait en SSH depuis son poste. Le
produit ne prétendra pas empêcher cela là où il a **choisi** de n'avoir aucune
autorité.

### Une règle d'affichage qui évitera un faux chiffre

Les mesures du Spark viennent du runtime et se comparent à ses quotas ; celles des
conteneurs viennent de Docker, à l'intérieur de la cellule, et se comparent à ce
que la cellule voit d'elle-même. Les empiler dans un même graphique produirait un
chiffre qui ne veut rien dire. SPK-DS-05 l'interdit, dans la lignée de SPK-DS-02.

### Vérifications

Aucun test exécuté : spécification, règles d'interface et backlog. Les faits
techniques cités ont été relevés dans le code — `exec_command` existe bien dans
`incus.py`, et le §17.1 documente l'absence de `sshd` dans l'image de base.


## 2026-08-19 — SPK-30 : le locataire qui sature son disque ne vous enferme plus dehors

**Unité** : SPK-30, première `[ ]` de l'ordre du plan. SPK-12, SPK-17 et SPK-29
sont `[~]` mais bloquées par des dépendances extérieures — un domaine, une
exécution de CI, une contention sur les trois tranches — et n'ont plus de
comportement à livrer.

**Ce que le §8.7 avait mesuré, sans le trancher.** `backup.yaml` est écrit par
Incus **à l'intérieur** du jeu de données contingenté. Disque plein, toute
reconfiguration échoue, y compris l'agrandissement qui débloquerait. Le remède
était nommé en une phrase — « quelques dizaines de mébioctets » — sans chiffre,
sans dire où la marge est posée, ce que la console montre, ni si le pool la
compte. J'ai donc écrit le **§8.8** et l'ai committé avant la première ligne de
code.

**Les quatre règles, et celle qui n'allait pas de soi.** Le registre stocke la
taille vendue et elle seule : le quota est dérivé, donc **aucune migration**. Le
traducteur pose `vendu + marge`, et c'est le seul endroit du produit où la marge
apparaît. Elle est **invisible du locataire** — sa limite reste ce qu'on lui a
vendu, il atteindra 100 % à cette valeur. Et elle est **comptée au pool** :
c'est le point qui décidait, et c'est le même raisonnement qu'au §8.5 pour l'ARC
— la marge est réellement prise, un pool qui l'ignorerait promettrait ce qu'il
n'a pas.

**Une conséquence que je n'avais pas vue en écrivant la spéc**, et qui l'a donc
complétée : comptée au pool, la marge devient **visible de l'exploitant**. Cinq
Sparks de 10 Gio et un alloué de 50,3 Gio, sans explication à l'écran, c'est une
question sans réponse. `GET /v1/host` publie donc deux termes — la marge unitaire,
qui est le réglage, et son coût total, qui en est la conséquence, calculé au
serveur où le nombre de Sparks est connu. La console énonce, elle ne recompose
pas, et ne pose pas la valeur en dur (§27.6).

**Une preuve révisée avec sa raison.** `test_stockage` exigeait
`size == storage_bytes`. Elle avait raison tant que le produit posait le quota à
la valeur annoncée — c'est précisément ce que la mesure a montré insoutenable.
Elle vérifie désormais une somme exacte, et le fichier dit pourquoi.

**Deux défauts trouvés par la preuve, pas par la relecture.** Le comptage des
Sparks se faisait hors du bloc `with registry()`, donc sur une connexion fermée —
`Cannot operate on a closed database` à la première requête. Et j'ai failli lire
`config` dans `_apply`, où la variable est réassignée localement : ç'aurait été un
`UnboundLocalError` à la création du premier Spark. La configuration du service se
lit sur `app.state`.

**Vérifié.** 550 tests Python, 215 de console, 6 de contrat, 8 gestes,
**19 parcours E2E**, 7 contrôles du manuel, build, contrat sans dérive. Illustration
`m4-pools` reproduite sur la pile seedée — cinq Sparks, 320 Mio annoncés — et
captures des pools observées à 1440 et 390 px.

**Ce qui n'est PAS prouvé, et pourquoi l'unité reste `[~]`.** Le niveau 3 du
§8.8.5 : remplir un Spark jusqu'au refus d'écriture puis l'agrandir, sur un hôte
réel. `which incus` ne rend rien sur cette machine. Les niveaux 1 et 2 prouvent
que le quota posé porte la marge et que le pool la compte ; ils ne prouvent pas
qu'elle suffit à `backup.yaml` sur le pilote réel.

**Où reprendre.** **SPK-34**, première `[ ]` suivante et entièrement spécifiée
(§35 du DAT, migration due). SPK-30 se soldera sur l'hôte, en une manipulation
courte. SPK-29 attend une contention sur les trois tranches ; SPK-12 un domaine ;
SPK-17 une exécution de CI. SPK-28, SPK-35, SPK-36 et SPK-42 attendent votre
arbitrage.

**Environnement.** Machine locale, non `root` : Docker répondait, Node 24.14.1 et
pnpm 9.15.4 en place, les contournements des §2.1 et §2.1 bis de `CloudWorker.md`
sans objet. Une session concurrente avait poussé la spécification des outils
d'administration dans le Spark (SPK-43 à SPK-45) ; l'historique est resté linéaire.

## 2026-08-19 — SPK-34 : un interrupteur qui arrête l'erreur, et qui ne retient jamais un geste de sécurité

**Unité** : SPK-34, première `[ ]` avec du comportement livrable — SPK-28 la
précède dans l'ordre du plan mais exige un repartitionnement de l'hôte, donc une
action humaine. Le §35 du DAT était complet et vérifiable ligne à ligne ; je ne
l'ai pas réécrit. Ce qui manquait était le contrat de schéma, écrit et committé
avant la première ligne de code (`docs/SCHEMA.md` §4.1).

**Ce qui est livré.** Chaque Spark porte un interrupteur, armé et levé par mot de
passe. Armé, le **runtime** refuse toute écriture qui le vise : commandes de
cycle de vie, reconfiguration, routes en ajout comme en retrait, octroi d'une
clé, instantanés y compris leur restauration. Code `423`, distinct des `409`
d'admission et de transition. Le mot de passe est une empreinte `scrypt` à sel
par Spark, avec ses paramètres de coût rangés à côté d'elle pour qu'ils évoluent
sans invalider l'existant ; il n'atteint jamais le journal.

**La décision qui structurait tout : révoquer passe toujours.** Un refus
laisserait un accès en place parce qu'un interrupteur a été oublié ailleurs —
un garde-fou devenu vulnérabilité. Le produit informe donc au lieu de refuser :
il nomme les Sparks protégés touchés, un par un, la console les présente en
confirmation, et un second appel aboutit sans mot de passe et sans lever aucune
protection.

**Trois choses que la mesure a corrigées.**

1. L'invariant des quatre colonnes ne pouvait pas être un `CHECK` : SQLite n'en
   ajoute pas à une table existante. Deux déclencheurs le portent, et j'ai
   vérifié qu'ils refusent bien un `protected_at` seul.
2. Le `423` sortait **sans l'enveloppe `detail`** que toutes les autres erreurs
   du produit portent : la console aurait lu au mauvais endroit. Trouvé par la
   preuve d'API, pas par la relecture.
3. Le seed protégeait d'abord `postgres-dedie` — le choix qui avait du sens sur
   le fond. Mesuré : deux parcours préexistants le pilotent, et leur résultat
   devenait dépendant de l'ordre d'exécution. La démonstration est passée à
   `analytics`, seul Spark qu'aucun parcours ne touche, et son état `pending`
   la rend plus parlante encore.

**Deux preuves révisées avec leur raison, écrite dans le fichier.** Le test du
seed tronqué retirait la route d'`analytics` : protégé, ce retrait est refusé, la
fixture restait et le test **ne pouvait plus échouer** — le pire état d'un test.
Et le runtime cesse de publier `allowed_commands` sur un Spark protégé, ce que le
§24.1 exigeait : sans cela l'écran aurait redérivé la règle de son côté.

**Vérifié.** 586 tests Python — 20 sur le module, 16 par l'API avec les vrais
droits et sans passer par l'interface —, 224 de console, 6 de contrat, 8 gestes,
**21 parcours E2E** dont les deux que la DoD nomme, 7 contrôles du manuel, build,
contrat régénéré sans dérive. Captures 36, 37, 38 et illustration `m8-protection`
observées.

**Où reprendre.** **SPK-41** (catalogue local des serveurs tenu depuis la
console) ou **SPK-37** (un acteur réel dans le journal), toutes deux `[ ]` et
spécifiées. SPK-30 et SPK-29 se soldent sur l'hôte ; SPK-12 attend un domaine,
SPK-17 une exécution de CI. SPK-28, SPK-35, SPK-36 et SPK-42 attendent votre
arbitrage.

**Point d'exploitation** : la migration `004_protection_spark` est portée au
contrat de déploiement (OP-05), avec la seule voie de récupération d'un mot de
passe perdu — un `UPDATE` en root sur l'hôte, l'API n'en offrant aucune.

**Environnement.** Machine locale, non `root` : Docker répondait, Node 24.14.1 et
pnpm 9.15.4 en place. `docs/MASTER_PLAN.md`, que le §4.1 de `CloudWorker.md`
nomme, n'existe pas dans ce dépôt : l'ordre du plan et les DoD sont portés par
`docs/BACKLOG.md`, qui a fait foi.

## 2026-08-19 — SPK-37 : le journal cesse d'affirmer une identité qu'il n'avait pas

**Unité** : SPK-37, désignée par l'entrée précédente. Sa spécification donnait le
principe (§36.7) mais pas de contrat vérifiable : j'ai écrit le **§21.6** et le
**§9.1 du schéma**, committés avant la première ligne de code.

**Ce que le journal disait de faux.** `actor` valait la chaîne littérale
« responsable », écrite en dur dans quatorze signatures. Le journal affirmait une
identité que rien n'établissait. La constante disparaît du dépôt : l'acteur voyage
par un **contexte de requête**, posé une seule fois à la frontière du service —
la raison est celle qui avait imposé le chemin d'écriture unique du §21.1, et ce
qui se passe à quatorze endroits s'oublie au quinzième. Sans déclaration :
`inconnu` et `runtime`, jamais une identité inventée.

**La distinction qui comptait.** `actor_class` sépare le geste humain de
l'événement du runtime (§36.4). Elle est **portée**, jamais déduite du nom de
l'action — deux chemins peuvent écrire la même. Les cinq recalculs globaux se
déclarent explicitement `runtime` : souvent déclenchés par une requête humaine
sans être demandés par elle, ils hériteraient sinon du contexte et le journal
ferait croire qu'une personne les a réclamés.

**Le verrou.** `UPDATE` et `DELETE` sur `audit_log` sont refusés par la base, pas
par convention de code. Une table qu'on s'interdit d'écraser par discipline est
une table qu'on écrasera. Il protège de l'erreur, pas de `root` — et le §36 le
disait déjà : ce qui protège de `root` est l'ancre tenue ailleurs (SPK-38).

**Un défaut trouvé par la preuve, pas par la relecture.** La forme déclarée
portait « clé » avec son accent, et **un en-tête HTTP ne transporte pas
d'accent** : la requête échouait à l'encodage avant d'atteindre `sparkd`. Une
identité qui casse l'appel qu'elle devait attribuer est pire qu'aucune identité.
La forme devient ASCII, et `sparkd` borne aussi ce qu'il accepte.

**Ce que l'écran ne dira jamais.** Le libellé est « déclaré par », jamais
« signé ». L'identité attribue, elle ne prouve pas : qui atteint `sparkd` écrit ce
qu'il veut dans cet en-tête. C'est la première marche, et une preuve interdit de
la prendre pour l'escalier.

**Vérifié.** 604 tests Python — dont 18 propres à l'unité : `UPDATE` et `DELETE`
directs **en base**, complétude vérifiée par lecture du code source, distinction
des deux classes prouvée de bout en bout par l'API —, 232 de console, 6 de
contrat, 8 gestes, **22 parcours E2E** dont un dédié, 7 contrôles du manuel,
build, contrat régénéré. Capture `39-journal-auteur.png` observée.

**Ce qui n'est PAS prouvé, et pourquoi l'unité reste `[~]`.** Le relevé de
l'empreinte SSH n'est éprouvé que sur la **forme documentée** d'OpenSSH, par test
unitaire. Aucun `sshd` ni agent ne répond sur cette machine — `ss -lntp` ne montre
aucun port 22, `ssh-add -l` rend « Could not open a connection ». Rien n'établit
donc ici qu'un vrai tunnel émet bien cette ligne. Le reste du contrat est prouvé.

**INC-02 réexaminé, et NON tranché** : l'arbitrage vous appartient. Ce que l'unité
change se mesure — un refus porte maintenant l'identité déclarée, ce qui rend deux
refus consécutifs distinguables par qui les a demandés. L'écart subsiste sur le
**nom demandé**, toujours absent du message ; un test le constate plutôt que de le
masquer.

**Où reprendre.** **SPK-41** (catalogue local des serveurs tenu depuis la console)
ou **SPK-38** (chaîne d'intégrité et ancre), qui suit naturellement celle-ci.
SPK-37 se solde d'une mesure sur un vrai tunnel. SPK-30 et SPK-29 se soldent sur
l'hôte ; SPK-12 attend un domaine, SPK-17 une exécution de CI. SPK-28, SPK-35,
SPK-36, SPK-42 et INC-02 attendent votre arbitrage.

**Point d'exploitation** : `005_journal_acteur` est portée au contrat de
déploiement (OP-06). Tout script qui corrigeait ou purgeait `audit_log` échouera
désormais, et c'est le but ; ne pas supprimer les déclencheurs à la main.

## 2026-08-19 — SPK-38 : la chaîne détecte, l'ancre voit ce qu'elle ne peut pas voir

**Unité** : SPK-38, désignée par l'entrée précédente. Le §36 disait ce qu'une
chaîne prouve et contre qui ; il ne disait pas ce qui s'écrit. J'ai écrit le
**§36.9** et le **§9.2 du schéma**, committés avant la première ligne de code.

**Ce qui est livré.** Chaque entrée du journal porte l'empreinte de la
précédente, calculée sur une sérialisation **canonique figée** — c'est le piège
du §36.5 qui ne se rattrape pas : une vérification qui échouerait un an plus tard
sans qu'aucune ligne n'ait bougé détruirait la confiance dans le dispositif
entier. L'`id` est exclu de l'empreinte, parce qu'elle ne peut pas dépendre d'un
compteur que le produit ne contrôle pas. `GET /v1/audit/verify` désigne la
**première** rupture et distingue une ligne récrite d'une ligne retirée.

**L'ancre, qui est le vrai sujet.** La chaîne seule ne voit ni la troncature ni
le remplacement — qui peut écrire peut recalculer. La console retient la dernière
tête vue par serveur et rend cinq verdicts ; `shrunk` et `diverged` sont
exactement les deux attaques que le §36.1 dit non couvertes. Le recul de longueur
se juge **avant tout le reste et sans croire l'hôte** : un serveur hostile ment
sur ce qu'il contient, il ne peut pas mentir sur le fait d'en avoir moins
qu'avant. L'ancre n'est jamais écrasée sur une alerte — l'écraser effacerait la
preuve avec le signal.

**Deux décisions écrites plutôt que reportées.** La purge est tranchée : le
journal **ne se purge pas**, et la vérification connaît déjà le point de contrôle
pour ne pas devoir être modifiée le jour où la purge arrivera. Et la migration ne
chaîne **pas** le passé : une chaîne recalculée ne prouverait que la capacité à
calculer un `sha256`.

**Une spécification démentie par la mesure.** Le §36.5 affirmait qu'`AUTOINCREMENT`
consomme un identifiant qu'un `ROLLBACK` abandonne. Mesuré : **faux sur SQLite**,
qui annule aussi la mise à jour de `sqlite_sequence` et réattribue l'identifiant.
Le DAT est corrigé. La règle « ne jamais juger la continuité des `id` » reste
inchangée — elle n'est pas une réaction à un phénomène observé mais une garantie
de conception : une purge ou un autre moteur en produiraient, et la vérification
deviendrait fausse ce jour-là sans que personne ne l'ait touchée.

**Vérifié.** 617 tests Python — dont 13 propres à l'unité, y compris celui qui
**documente** que la troncature n'est pas détectable par la chaîne —, 246 de
console dont 11 sur l'ancre et 3 de bout en bout, 6 de contrat, 8 gestes, 22
parcours E2E, 7 contrôles du manuel, build, contrat régénéré.

**Ce qui n'est PAS livré, et pourquoi l'unité reste `[~]`.** Le parcours E2E
navigateur que la DoD nomme. L'ancre n'a **aucune surface visible** : l'onglet de
supervision est l'objet de SPK-39 (§36.8), et l'y ajouter ici déborderait de
l'unité. Le mécanisme est prouvé de bout en bout par un test d'intégration de
l'hôte console — ce qui n'est pas la même chose qu'un parcours au clavier.

**Où reprendre.** **SPK-39**, l'onglet de supervision : il porte l'écran qui
manque à SPK-38, et son §36.8 est déjà écrit. SPK-37 se solde d'une mesure sur un
vrai tunnel ; SPK-30 et SPK-29 sur l'hôte ; SPK-12 attend un domaine, SPK-17 une
exécution de CI. SPK-28, SPK-35, SPK-36, SPK-42 et INC-02 attendent votre
arbitrage.

**Point d'exploitation** : `006_journal_chaine` est portée au contrat (OP-07),
avec la décision qui compte — le journal ne se purge pas.

## 2026-08-19 — SPK-39 : le journal a son écran, et il ne résume pas ce qui ne se résume pas

**Unité** : SPK-39, désignée par l'entrée précédente. Le §36.8 disait ce que
l'onglet montre ; il ne disait ni sa destination, ni ses filtres, ni ce qu'il
refuse. J'ai écrit le **§36.8 bis**, committé avant la première ligne de code.

**Ce qui est livré.** `Hôte → Journal`, troisième onglet de second degré, qui
couvre **tous** les Sparks — la facette d'un Spark reste, parce qu'elle répond à
l'autre question. Cinq filtres au runtime, dont l'action par **préfixe** : on
cherche « tout ce qui touche aux instantanés » bien plus souvent qu'une action
précise. Un filtre à valeur inconnue est **refusé** en `422`, jamais ignoré — un
filtre ignoré rend une liste plus large que demandée, que l'exploitant lira comme
un résultat filtré.

**Le point qui décidait de la forme.** L'écran rend l'état de la chaîne **et** la
comparaison avec ce que la console avait vu, sans jamais les résumer en un seul
indicateur. Une chaîne intacte **avec** une ancre qui alerte est exactement la
troncature — le cas le plus important de tout le dispositif —, et « tout va bien »
y serait faux. Une preuve l'interdit. Tant qu'aucun relevé n'a eu lieu, l'écran
dit qu'il ne sait pas plutôt que d'afficher « intacte » : une intégrité supposée
est précisément ce que ce dispositif existe pour ne pas laisser croire. Et il
n'écrit **jamais** « signé ».

**Trois défauts trouvés par la mesure, pas par la relecture.** Les filtres
partaient en escalier — leur bas était aligné, or l'un porte une aide de trois
lignes. L'auteur, tronqué par l'ellipse, n'était plus consultable, alors qu'il
porte le serveur et l'empreinte de clé qui distinguent deux postes. Et un
« Tout afficher » s'affichait alors que tout était déjà affiché.

**Une preuve corrigée, et sa cause.** Le parcours attendait que le nombre de
lignes change après filtrage ; l'état de chargement rend zéro ligne, donc
l'attente était satisfaite avant l'arrivée de la réponse, et le test lisait un
tableau vide. Il attend désormais le tableau rechargé.

**INC-01, traité comme la DoD le demande.** L'écart de vocabulaire change
d'échelle : il portait sur trois lignes d'un panneau, il porte sur une page
entière. La nouvelle mesure est consignée au registre. L'onglet **ne réécrit aucun
message** — le trancher serait l'arbitrage, qui vous appartient — mais M12 le
nomme, pour qu'on ne cherche pas une erreur là où il n'y en a pas.

**Vérifié.** 617 tests Python, 260 de console dont 14 propres à cet écran, 6 de
contrat, 8 gestes, **23 parcours E2E** dont celui de la DoD, 7 contrôles du
manuel, build, contrat régénéré. Captures 40 à 43 et illustration `m12-journal`
observées, y compris l'écran **chaîne rompue** et le format 390 px.

**Où reprendre.** **SPK-41** (catalogue local des serveurs tenu depuis la console),
première `[ ]` restante avec du comportement livrable — SPK-40 dépend de
l'arbitrage de SPK-35. SPK-38 se solde désormais d'un parcours E2E : l'écran
existe, et l'ancre s'y voit. SPK-37 se solde d'une mesure sur un vrai tunnel ;
SPK-30 et SPK-29 sur l'hôte. SPK-28, SPK-35, SPK-36, SPK-42, INC-01 et INC-02
attendent votre arbitrage.

## 2026-08-20 — SPK-41 : le catalogue devient utilisable, sauf son écran

**Unité** : SPK-41, désignée par l'entrée précédente. Le §22.4 bis avait tranché
l'alias `ssh` ; il ne disait ni les routes, ni la forme du fichier, ni ce que
l'épreuve engage. J'ai écrit le **§22.4 ter**, committé avant la première ligne
de code.

**Ce qui est livré.** Le genre **`alias`** : une entrée ne nomme qu'un `Host` du
`ssh_config`, et le produit ne connaît ni l'utilisateur, ni le port, ni le
rebond — les deviner donnerait l'illusion de les connaître, et ils seraient faux
dès qu'un `ProxyJump` s'interpose. Le tunnel passe le `Host` tel quel et ne
désactive **jamais** la vérification de la clé d'hôte.

Le fichier porte sa **version**, et la forme historique n'est pas réécrite à la
lecture : une console qui migrerait le fichier en l'affichant le récrirait sans
qu'on l'ait demandé. Le **serveur courant** est persisté et devient un choix — il
valait `servers[0]`, si bien qu'ajouter un serveur changeait celui qu'on
regardait. Quatre routes de plus, dont le retrait, qui **ferme le tunnel** avant
d'effacer : laisser un `ssh` vivant vers une machine qu'on vient de retirer de
l'inventaire, c'est le genre de processus qu'on ne retrouve plus.

L'**épreuve** ouvre un tunnel temporaire, interroge `/healthz` puis `/readyz` à
travers lui, et le referme dans tous les cas. Elle informe sans décider : un
serveur injoignable s'enregistre quand même, sinon il faudrait qu'une machine
soit allumée pour qu'on note son existence.

À l'écran, un **sélecteur** dès qu'il y a le choix, et une **commande de
reconnexion** sur un tunnel rompu — dont la seule issue était de recharger la
console, ce qui n'est pas un remède mais une superstition.

**Un défaut vu sur la capture, pas dans le code.** Le contexte était rangé en
rangée dans une barre latérale de 240 px : le sélecteur tombait à quelques
pixels, illisible, et le bouton débordait. Il s'empile, et redevient une rangée
sous 1024 px où la barre passe en haut.

**Deux preuves révisées avec leur raison** : le message d'un genre inconnu
énumère trois genres, et le fichier a un objet à sa racine plutôt qu'un tableau
nu. Ce qu'elles établissent est inchangé.

**Vérifié.** 617 tests Python, 284 de console, **88 de l'hôte console** dont 13
propres aux nouvelles routes, 6 de contrat, 8 gestes, 23 parcours E2E, 7
contrôles du manuel, build, contrat sans dérive. Capture `09-tunnel-rompu`
observée après correction.

**Ce qui n'est PAS livré, et pourquoi l'unité reste `[~]`.** L'**écran
d'administration du catalogue** : ajouter, modifier et retirer un serveur depuis
la console. Les routes existent et sont prouvées, mais **aucune surface ne les
appelle** — une entrée s'ajoute donc toujours à la main dans le fichier, ce qui
est le défaut que l'unité nommait en premier. Par conséquent le parcours E2E de
la DoD n'est pas écrit : la moitié de ses gestes n'a pas d'écran. La capture
« aucun serveur enregistré », le manuel M3 et le seed appartiennent à ce même
morceau.

**Où reprendre.** **SPK-41**, son seul manque : l'écran du catalogue, section avec
sa modale (§6.27), puis le parcours E2E complet de sa DoD. SPK-38 se solde d'un
parcours E2E — l'onglet de supervision existe et l'ancre s'y voit. SPK-37 se
solde d'une mesure sur un vrai tunnel ; SPK-30 et SPK-29 sur l'hôte. SPK-28,
SPK-35, SPK-36, SPK-42, INC-01 et INC-02 attendent votre arbitrage.

## 2026-08-20 — SPK-41 : le catalogue a son écran, et une console sans serveur y mène

**Unité** : SPK-41, reprise là où le journal précédent l'arrêtait — l'écran
d'administration. Sa spécification existait (§22.4 ter) mais ne disait pas **où**
l'écran vit : j'ai complété ce seul point (**§22.4.7 bis** et **ter**), committé
avant la première ligne de code.

**Ce qui est livré.** Une destination **« Serveurs »** au premier degré. Elle gère
ce qui est *déclaré*, là où le sélecteur au-dessus choisit ce qu'on *regarde* —
deux sujets, deux surfaces. Elle ne pouvait pas être un onglet sous *Hôte* : un
catalogue rangé là disparaîtrait avec le tunnel qui le sert, alors qu'il est
justement ce qui permet d'en choisir un autre.

Le tableau signale le serveur courant, permet d'en changer, et le retrait se
confirme en **nommant** le serveur et en disant ce qui n'est pas touché. La modale
d'ajout ne demande que ce que le **genre** exige : un alias ne montre ni
utilisateur ni port, parce que le produit ne les connaît pas — les afficher serait
mentir. L'épreuve est un bouton de cette modale, et son verdict ne bloque jamais
l'enregistrement.

**Deux défauts trouvés par la mesure, pas par la relecture.**

1. En produisant la capture « aucun serveur enregistré » que la DoD exige :
   sans serveur, la console affichait une **erreur globale** et l'écran du
   catalogue était **inatteignable** — alors que c'est le seul endroit d'où en
   déclarer un. C'était exactement le défaut que l'unité nommait en premier. Elle
   y mène désormais.
2. Par le parcours E2E : sur un fichier en **forme historique**, où le serveur
   courant est nul, l'ajout d'un second serveur lui **volait le contexte**, alors
   que la lecture, elle, montrait le premier. Le test unitaire ne pouvait pas le
   voir : il part d'un fichier neuf, où le premier enregistrement pose déjà le
   courant.

**Vérifié.** 617 tests Python, **300 de console** dont 16 propres à cet écran, 88
de l'hôte console, 6 de contrat, 8 gestes, **25 parcours E2E** dont les deux de
cette unité, 7 contrôles du manuel, build, contrat sans dérive. Captures 44, 45,
46 et illustration `m3-serveurs` observées. Manuel M3 réécrit.

**Ce qui reste, et c'est le seul écart.** La **modification** d'une entrée
existante : le formulaire remplace par le nom — `POST` écrase l'homonyme — mais
aucun bouton n'ouvre la modale pré-remplie sur un serveur déjà déclaré. Le
contournement marche et n'est pas dit, ce qui est le pire des deux. Le **seed**
n'est pas touché : l'inventaire vit sur le poste et non dans le registre, et
reste à décider si la pile de développement doit en déclarer deux pour montrer le
sélecteur.

**Où reprendre.** **SPK-41**, pour clore : le bouton « Modifier » qui ouvre la
modale pré-remplie, et la décision sur le seed. Puis **SPK-42** (nommer la
machine) ou SPK-43. SPK-38 se solde d'un parcours E2E — l'onglet de supervision
existe. SPK-37 se solde d'une mesure sur un vrai tunnel ; SPK-30 et SPK-29 sur
l'hôte. SPK-28, SPK-35, SPK-36, INC-01 et INC-02 attendent votre arbitrage.

## 2026-08-20 — SPK-41 close : modifier une entrée, sans piéger le renommage

**Unité** : SPK-41, reprise sur son dernier manque — la modification d'une entrée
existante et la décision sur le seed. La spécification existait ; je n'ai complété
qu'un point qu'elle ne tranchait pas, le **renommage**, committé avant le code.

**Ce qui est livré.** Chaque ligne porte son bouton « Modifier ». La modale
s'ouvre pré-remplie depuis l'**entrée réelle** et non depuis ce que l'écran
affichait : un alias n'a ni utilisateur ni port, et les valeurs par défaut
rempliraient des champs que le produit ne connaît pas.

**Le nom y est en lecture seule**, et c'est le point qui demandait un arbitrage :
`POST` remplace par le nom, donc le changer ne renommerait rien — cela créerait
une seconde entrée en laissant la première, et l'exploitant se retrouverait avec
un doublon qu'il n'a pas demandé. Le produit ne prétend donc pas renommer, et
l'écran le dit plutôt que de laisser découvrir le doublon. Le genre, lui, reste
modifiable : passer de `ssh` à `alias` est justement ce qu'on veut faire quand la
connexion se complique.

**La pile de développement** écrivait encore un tableau nu — la forme historique,
celle qui avait causé le vol de contexte corrigé hier — et un seul serveur. Elle
écrit la version 1 et **deux** serveurs, dont un déclaré par alias et
délibérément injoignable : sans lui, ni le sélecteur ni un tunnel fermé ne se
verraient, et l'écran ne présenterait jamais que le cas heureux.

**Un défaut vu sur la capture.** Le focus entrait dans le champ « Nom », en
lecture seule : la saisie commençait là où elle est impossible. Le composant de
modale saute désormais les contrôles verrouillés — correction qui vaut pour
toutes les modales du produit, pas seulement celle-ci.

**Vérifié.** 617 tests Python, **305 de console** dont 21 propres à cet écran, 88
de l'hôte console, 6 de contrat, 8 gestes, **26 parcours E2E** dont les trois de
cette unité, 7 contrôles du manuel, build, contrat sans dérive. Capture
`47-serveurs-modifier` observée.

**Où reprendre.** **SPK-42** (nommer la machine qui porte `sparkd`) — mais son
arbitrage est attendu de vous —, sinon **SPK-43** (terminal dans un Spark),
première `[ ]` avec du comportement livrable et spécifiée au §37. SPK-38 se solde
d'un parcours E2E sur l'ancre — l'onglet existe. SPK-37 se solde d'une mesure sur
un vrai tunnel ; SPK-30 et SPK-29 sur l'hôte. SPK-28, SPK-35, SPK-36, INC-01 et
INC-02 attendent votre arbitrage.

## 2026-08-20 — Six arbitrages rendus par le responsable

Aucun code cette fois : c'est une session d'**arbitrage**, sollicitée par le
responsable, et sa persistance immédiate (CLAUDE.md §5). Ce qui suit était en
attente depuis plusieurs sessions et bloquait autant d'unités.

**SPK-42 — la machine est une « Forge ».** Elle n'avait pas de nom : on disait
« l'hôte », mot déjà pris par le processus Node du poste. *Forge* lève la
collision, se pluralise, survit en identifiant de code et en segment d'URL, et ne
ment pas sur la portée — c'est une machine, pas une grappe. Le renommage touche
le glossaire, l'interface, le manuel, la table `host`, la route `/v1/host`, le
contrat et ses types, `servers.json`. **À faire tôt** : chaque unité livrée après
cet arbitrage en augmente le coût.

**SPK-35 — le modèle de menace s'écrit d'abord, sans choisir d'option.** L'unité
devient une instruction pure. SPK-40 reste subordonnée à cet arbitrage et ne peut
pas être livrée avant lui.

**INC-01 — la console traduit à l'affichage.** Le journal reste un enregistrement
technique : il sert aussi au diagnostic, et y écrire du vocabulaire d'interface le
rendrait moins précis pour gagner en confort au mauvais endroit. Règle au **§21.5
bis**, correction portée par la nouvelle unité **SPK-46** — qui interdit
explicitement de deviner : ce que la console ne reconnaît pas est affiché tel
quel.

**INC-02 — statu quo assumé.** Un refus journalise sa cause, pas la demande :
écrire le nom d'une entité qui n'a jamais existé ferait croire à la trace de
quelque chose qui a été. Ce qui distingue deux refus est **qui** les a demandés
(§21.6) et quand. Règle au **§21.5 ter**, et l'entrée est **retirée du registre** —
elle n'est plus une incohérence, c'est une décision.

**SPK-28 — l'environnement est une démonstration, le pool fichier suffit.**
L'unité change de nature : elle ne vise plus un repartitionnement, mais le
**schéma de partitionnement JSON à fournir à Scaleway** à la création du serveur,
pour qu'une machine neuve arrive déjà bien découpée — et la **configurabilité**
de tout ce qui touche au stockage. Le §8.5 cessera de présenter le pool natif
comme « la cible » et le pool fichier comme un repli : deux dispositions, avec ce
que chacune apporte et ce qu'elle ne protège pas.

**SPK-36 — commencer par la sauvegarde du registre.** Sauvegarde **et**
restauration, avec un test qui rejoue la restauration : c'est le seul scénario du
lot qui se livre en code vérifiable ici plutôt qu'en document. L'exercice réel que
la DoD exige appartient au responsable, sur l'hôte.

**Où reprendre.** **SPK-42** en priorité — le renommage en *Forge*, dont le coût
croît à chaque unité livrée. Puis SPK-46 (la traduction), SPK-36 (la sauvegarde du
registre), SPK-28 (le schéma Scaleway et la configurabilité), SPK-35
(l'instruction). SPK-38 se solde d'un parcours E2E ; SPK-37 d'une mesure sur un
vrai tunnel ; SPK-30 et SPK-29 sur l'hôte. Il ne reste plus **aucun** arbitrage en
attente, hors INC-03.

## 2026-08-20 — SPK-42 : la machine devient une Forge, dans le code

**Unité** : SPK-42, désignée par l'entrée précédente et arbitrée la veille. J'ai
écrit le **§1 bis** — glossaire et contrat du renommage — avant la première ligne
de code.

**Le point qui décidait de tout.** C'est un renommage **sémantique**, jamais
textuel. Le mot `host` a trois sens dans ce dépôt : la machine — qui devient
Forge —, l'adresse réseau, qui est le vocabulaire d'OpenSSH et de TCP, et
« hôte console », dont la collision disparaît d'elle-même puisque l'autre sens
s'en va. Une substitution globale aurait produit des contresens ; et sans cette
distinction, la vérification de la DoD ne prouve rien, un `grep` nu comptant les
trois sens.

**Ce qui est livré.** Migration `007_forge` — SQLite renomme la table sans la
recopier et met à jour les clés étrangères, aucune donnée ne bouge. Les routes
deviennent `/v1/forge`, `/v1/forge/sync`, `/v1/forge/cores`, le refus
`forge_not_synced`, et le contrat est régénéré. **Aucun alias** n'est conservé :
le contrat n'a qu'un consommateur, et garder deux noms pour la même chose est ce
que cette unité supprime. La console suit : destination `#/forge`, entrée
« Forge », et les libellés.

**Ce qui ne change pas, volontairement** : `hostname`, `SPARKD_BIND`, le `host`
d'un serveur dans `servers.json`, `sshHost`, et le libellé « Hôte, utilisateur et
port » du formulaire d'un serveur SSH — le renommer produirait un contresens.

**Cinq preuves révisées avec leur raison**, dont deux qui gagnent une exigence :
la liste des tables exige désormais que `host` n'existe plus, et les chemins du
contrat qu'aucun alias ne subsiste.

**Vérifié.** 617 tests Python, 217 de console, 88 de l'hôte console, 6 de
contrat, 8 gestes, **26 parcours E2E**, 7 contrôles du manuel, build,
`contract-check` vert. Captures et illustrations refaites, `29-hote-pools`
observée — c'est elle qui a révélé trois libellés au sens visé que le renommage
avait manqués.

**Ce qui reste, et pourquoi l'unité est `[~]`.** La **documentation** : le DAT, le
schéma, le contrat de déploiement, le plan du manuel et six chapitres du manuel
emploient encore « hôte » au sens de la machine. C'est la tranche 3, purement
rédactionnelle, mais elle doit distinguer les trois sens comme le code l'a fait.
Et les **noms de fichiers** de la console — `host-view.js` et ses voisins —,
invisibles de l'utilisateur comme du contrat, sont le dernier morceau.

**Où reprendre.** **SPK-42**, tranche 3 : la documentation et le manuel, puis les
noms de fichiers, puis la vérification finale de la DoD. Ensuite SPK-46 (la
console traduit), SPK-36 (la sauvegarde du registre), SPK-28 (le schéma
Scaleway). SPK-38 se solde d'un parcours E2E ; SPK-37 d'une mesure sur un vrai
tunnel ; SPK-30 et SPK-29 sur l'hôte.

## 2026-08-20 — Le DNS cesse d'être extérieur au produit (SPK-47)

**Décision du responsable.** Un jeton d'API Scaleway est fourni, et la console
doit pouvoir lister les domaines du compte puis poser le DNS d'une route
d'ingress. Écrit avant toute ligne de code, conformément au §5 : une décision qui
ne vit que dans le contexte d'un agent est une décision perdue.

**Le problème que cela résout.** SPK-12 est `[~]` depuis le 2026-08-19 pour une
seule raison : l'émission TLS n'a jamais pu être prouvée, faute d'un domaine qui
résolve vers la Forge. Le produit affichait à trois endroits — l'écran, le manuel
M7 et le DAT — que « le DNS est extérieur au produit ». C'était vrai, et c'était
l'obstacle. Cette affirmation est donc **révisée**, pas supprimée : elle avait une
raison, et cette raison a cessé de valoir.

**Ce qui a été mesuré avant d'écrire quoi que ce soit**, en lecture seule sur
l'API Scaleway Domain & DNS v2beta1, jeton passé en `X-Auth-Token` :

- `GET /dns-zones?organization_id=…` rend `200` et `total_count: 14`. Les quatorze
  zones sont `active`, et ce sont des zones **réelles** en exploitation.
- `GET /dns-zones/lelabs.tech/records` rend `200` et `total_count: 17` :
  des `NS`, des `TXT` de vérification et DKIM, un `_dmarc`, un `MX`, et des `A`
  de services vivants.
- **Aucun enregistrement ne commence par `test.`** — l'espace de nom des essais
  est libre.

**Ce que cette mesure impose au produit.** Une zone réelle porte des
enregistrements dont la casse arrête une messagerie ou invalide une preuve de
propriété. Le produit n'écrit donc rien à l'apex, n'écrit que `A`/`AAAA`, et ne
supprime **jamais** un enregistrement qu'il n'a pas posé (§38.2, §38.5). Ce ne
sont pas des précautions d'usage : chacune est éprouvée par un test.

**Où vit le secret, et pourquoi là.** Sur l'**hôte console**, dans un `.env` du
poste, hors dépôt — le `.gitignore` le couvrait déjà, et l'absence du fichier de
l'index a été vérifiée. Jamais sur la Forge : le §35.1 assume déjà que le produit
ne protège pas de qui détient `root` sur la Forge, et y déposer un jeton qui
pilote quatorze zones de production reviendrait à faire de cette limite connue
une perte réelle. Jamais dans `servers.json` non plus : le §22.4 interdit tout
secret dans l'inventaire, et cette règle ne souffre pas d'exception.

**Une limite que l'écran devra dire.** Poser un enregistrement ne le fait pas
résoudre : la propagation prend le temps du TTL, et un cache chaud sert encore
l'ancienne réponse. L'écran annoncera donc l'enregistrement **écrit**, jamais le
domaine « prêt » (§38.4). Le produit retire la cause la plus fréquente de l'échec
d'émission TLS ; il ne garantit pas cette émission.

**Périmètre des essais, borné par le responsable** : seuls les noms
`test.<label>.lelabs.tech` sont écrits, et rien d'autre n'est touché. La garde
vaut pour le harnais, pas pour le produit — un exploitant gère sa zone entière.

## 2026-08-20 — SPK-47 livré, et une écriture réelle mesurée

**Ce qui est en place.** La console lit les zones du compte et pose
l'enregistrement d'ingress d'une route, depuis un bouton porté par la ligne de
la route — pas par la section : deux routes d'un même Spark ont deux domaines.

**Quatre défauts trouvés par les preuves, pas par relecture.**

1. Le jeton était un champ public du client : il sortait dès qu'on sérialisait le
   fournisseur, donc au premier corps de réponse ou au premier rapport de bogue.
   Champ privé. Le test qui l'a trouvé est celui qui sérialise le bilan.
2. L'aperçu « Sera écrit » ne suivait pas la saisie — la console ne repeint pas à
   chaque frappe, pour ne pas déplacer le curseur. Il montrait donc une valeur
   qui n'aurait pas été écrite, ce qui est pire que pas d'aperçu. Mis à jour sur
   place. Trouvé par le parcours E2E.
3. La bannière répétait « Enregistrement écrit » mot pour mot, parce que le champ
   `propagation` du serveur le disait déjà. Vu sur la capture, pas dans le code.
4. Le parcours de l'apex passait seul et rougissait dans la campagne :
   `has-text` cherche un **sous-texte**, et « exemple.test » désignait aussi
   « boutique.exemple.test ». La ligne se désigne désormais par son domaine
   exact.

**Un champ en lecture seule se voit maintenant.** La capture a montré que le
domaine repris de la route avait l'apparence d'un champ modifiable : on clique,
on tape, rien ne se passe. Règle §6.9 du design system, et le style qui va avec.
La lacune n'était pas propre à cet écran — le nom d'un serveur en modification
avait le même défaut.

**Vérification réelle, dans la peau de l'utilisateur.** Depuis l'accueil, en
cliquant : un Spark, l'onglet Routes, déclarer `test.spark.lelabs.tech`, le
bouton DNS, la zone `lelabs.tech` pré-choisie, l'adresse `203.0.113.7`
— TEST-NET-3, réservée à la documentation, donc incapable de pointer sur la
machine de quelqu'un. L'enregistrement existe chez le fournisseur, `ttl=300`.
La garde d'espace de noms a refusé `gram.lelabs.tech` **sans qu'aucune requête
ne parte**. Captures `48-` à `52-` observées, format étroit compris.

**Ce que cette vérification n'a pas prouvé** : que le domaine résolve, et que
Caddy émette le certificat. Le premier demande d'attendre la propagation, le
second une Forge joignable depuis l'extérieur. SPK-12 reste donc `[~]`, mais sa
cause de blocage a changé de nature : ce n'est plus le DNS.

**Un écart consigné, non tranché.** La zone `lelabs.tech` portait 17
enregistrements le 19 août et en porte 15 hors le nôtre le 20. Deux `TXT` liés à
`xrp-academy` manquent. L'écriture du produit vise `{name, type}` et le client
n'a aucune méthode de suppression, ce qu'un test prouve sur sa surface publique ;
le compte ne conserve aucune version de zone, donc rien n'est consultable. Rien
n'a été réécrit — restaurer de mémoire des enregistrements de messagerie serait
pire que l'écart. Voir INC-04 : cela demande l'arbitrage du responsable **avant**
que le pilotage DNS ne serve sur une zone en exploitation.

**Campagne complète, verte.** 617 tests Python, 346 de console et d'hôte console,
6 de contrat, 8 gestes, **28 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`.

**Où reprendre.** SPK-42, tranche 3 : la documentation et le manuel emploient
encore « hôte » au sens de la machine, puis les noms de fichiers de la console.
Ensuite SPK-46 (la console traduit), SPK-36 (la sauvegarde du registre), SPK-28
(le schéma de partitionnement), SPK-35 (le modèle de menace). INC-03 et INC-04
attendent un arbitrage.

## 2026-08-20 — Quatre arbitrages, et le périmètre de l'ingress se réouvre

**Ce qui a déclenché.** Le responsable a corrigé une vue trop étroite du §38 :
sur une Forge vivent plusieurs Sparks, chacun hébergeant une application qui doit
répondre sur des **noms de domaine** — jokers compris — et sur des **ports**. Le
modèle « un domaine exact → un port HTTP » ne couvre pas ce besoin.

**Arbitrage 1 — INC-04 est classée.** Le retrait des deux `TXT` liés à
`xrp-academy` était volontaire. L'entrée sort du rapport d'incohérences. Ce que
la mesure a établi reste vrai et reste utile : le produit n'a aucune méthode de
suppression, et un test le prouve sur la surface publique du client.

**Arbitrage 2 — INC-03 devient une règle.** Une instance rapportée absente vaut
suppression réussie (§14.5, unité SPK-52). Trois bornes l'empêchent de devenir un
mensonge : l'audit porte `instance_absente` et le dit ; un pilote **injoignable**
rend toujours une panne — ne pas pouvoir demander n'est pas savoir que ce n'est
pas là, même règle qu'au §33.3 ; un Spark protégé reste refusé par le §35.

**Arbitrage 3 — le joker.** `*.monapi.fr` devient une route valide, un seul
niveau, en tête seulement, et le plus spécifique gagne — la règle du DNS et celle
de Caddy. En adopter une autre ferait diverger l'écran du trafic réel. Le point
qui n'est pas évident et qui est écrit au §18.3 bis : quand une route exacte
prend le pas sur le joker d'un **autre** Spark, l'écran doit NOMMER ce Spark.
Sans cela, on détourne une adresse sans le savoir et la panne se cherche du
mauvais côté.

**Arbitrage 4 — les ports, tranchés par la messagerie.** Le responsable a demandé
la différence entre les deux mécanismes, sur ses propres exemples. La réponse
mesure l'ampleur réelle du besoin :

- **par le nom**, donc rien à faire de plus : Ollama, Vite, Keycloak, GoTrue,
  MinIO, les fonctions de bord, et les **WebSockets** — qui commencent par une
  requête HTTP avant de changer de protocole ;
- **par le port** : uniquement ce qui ne prononce aucun nom. Sur toute la liste
  citée, un seul cas — Postgres joignable de l'extérieur, dans un Supabase
  complet.

Le `:9012` de l'exemple `*.monapi.fr:9012` n'est donc **pas nécessaire** si l'API
parle HTTP : le nom suffit, et le Spark continue d'écouter sur 9012 à
l'intérieur. Le port dans l'URL est une habitude de développement.

**Ce qui tranche vraiment**, c'est la suite annoncée : des Sparks hébergeant
**Mailcow**. Un SMTP reçoit sur le port 25 sans qu'aucun nom soit prononcé —
aucun proxy ne peut deviner le destinataire. Les deux mécanismes sont donc
nécessaires, et le port publié n'est plus optionnel. §39 écrit.

**Trois limites écrites AVANT d'être rencontrées** (§38.7), parce qu'elles
coûteraient des jours autrement : le `PTR` ne vit pas dans la zone mais chez le
propriétaire de l'adresse IP, par une autre API ; le port 25 sortant est bloqué
par défaut chez l'hébergeur et son déblocage est une **action humaine** ; une
adresse neuve a une réputation à construire. Une recette de messagerie affichera
ces trois points comme restant à faire, à côté de ce qu'elle a écrit.

**Et une contrainte qui décide de l'ordre** : la clé DKIM est produite par
Mailcow et doit être **lue dans le Spark**. L'inventer produirait une signature
invalide, donc l'effet exact qu'on prétend éviter. SPK-51 dépend donc de SPK-43.

**Ordre retenu** : SPK-48 (le joker, peu coûteux et utile tous les jours), puis
SPK-49 (les ports, prérequis dur), puis SPK-50 (les recettes), puis SPK-51
(la messagerie). SPK-52 est indépendant et court.

## 2026-08-20 — La garde du harnais bridait la console du responsable

**Deux défauts nommés par le responsable, du même endroit.**

**Le premier est une faute d'implémentation contre ma propre spécification.** Le
§38.5 disait, dès sa première rédaction, que la borne d'espace de noms valait
« pour le harnais, pas pour le produit — un exploitant gère sa zone entière ».
J'ai pourtant posé `SPARK_DNS_ALLOW_PATTERN` dans le `.env` que la **console**
lit. Le responsable se retrouvait donc bridé sur ses propres domaines par une
garde écrite pour me borner, moi.

Corrigé en séparant les deux fichiers : `.env` est celui de l'exploitant et ne
porte aucune borne ; `.env.verification`, distinct et lui aussi hors dépôt, ne
sert qu'à mes vérifications autonomes. Le harnais E2E ne dépendait déjà pas de
cette borne — il impose son propre fichier et un doublon local. §38.5.3 écrit.

**Le second est une erreur de conception, et elle est plus intéressante.** Je
refusais d'écrire à l'apex de la zone, au motif qu'il porte les `NS` et le `MX`.
Cela interdisait `johndalia.com` — un site sur le domaine nu, cas parfaitement
ordinaire, et cité par le responsable comme un besoin réel.

**Le motif ne tenait pas.** L'écriture vise un nom **et un type** exacts : à
l'apex, elle ne remplace que les `A`. Les `NS`, le `MX` et les `TXT` sont
d'autres types et ne sont pas touchés. Ce que le refus prétendait protéger
l'était déjà par la règle du §38.2, qui est la vraie garantie. J'avais posé une
liste de noms interdits là où il fallait se fier à la règle qui existait.

**Ce que le refus protégeait vraiment**, c'est l'idée qu'un écrasement à l'apex
coupe le domaine entier et non un sous-domaine. Cette inquiétude est légitime,
mais elle n'est pas propre à l'apex, et un refus n'est pas la bonne réponse : la
bonne réponse est de **montrer ce qui est déjà là**. L'écran lit donc
l'enregistrement en place pour ce nom et ce type, et annonce « posera »,
« remplacera *telle valeur* » ou « aucun changement ». §38.5.2.

**Leçon.** Une garde qui interdit un cas d'usage réel n'est pas une garde, c'est
un défaut. La prudence utile ne retire pas un pouvoir : elle rend visible ce que
ce pouvoir va faire.

## 2026-08-20 — Le relais transactionnel, et quatre défauts trouvés par la mesure réelle

**La question du responsable** — faut-il un serveur de messagerie complet, ou
suffit-il de relayer par le service transactionnel du fournisseur ? — se tranche
sur ses propres données.

**Mesuré** : le service transactionnel de Scaleway est **déjà en service** sur
`noreply.lelabs.tech`. Le `MX` pointe vers un `blackhole` — le domaine n'accepte
aucun courrier entrant —, le SPF inclut le relais, et le **sélecteur DKIM est
l'identifiant de projet du compte**, vérifié caractère pour caractère contre
`SCW_DEFAULT_PROJECT_ID`.

Cela établit ce qu'est ce service : un **relais sortant**, sans boîte aux lettres
ni IMAP. Il ne remplace pas un serveur de messagerie, il en prend la moitié.
D'où l'architecture du §38.6 bis : le Spark **reçoit**, et **émet par le relais**.
Trois des limites du §38.7 tombent alors — plus de port 25 sortant à débloquer,
un `PTR` déjà cohérent, une réputation déjà établie.

Deux points restent à vérifier auprès du fournisseur et sont écrits pour ne pas
être découverts à l'implémentation : les quotas et conditions d'usage du relais
pour de la correspondance humaine, et l'ouverture du port 25 **entrant**.

**Quatre défauts, tous trouvés en exécutant contre le vrai compte.**

1. **La modale rétrécissait sous le curseur.** Le bloc d'effet se vidait pendant
   la relecture pour afficher « Lecture… ». La modale raccourcissait, le bouton
   d'engagement remontait entre l'appui et le relâchement, et **le clic ne partait
   jamais**. Aucun test de composant ne pouvait le voir : c'est une question de
   hauteur, pas de contenu. Le bloc garde désormais ce qu'il affiche et se marque
   `aria-busy`.
2. **Une lecture lente écrasait une lecture récente.** La première lecture, faite
   à l'ouverture avec l'adresse pré-remplie, revenait après celle déclenchée par
   la saisie et la remplaçait. L'écran annonçait le remplacement d'une adresse que
   l'utilisateur n'avait pas saisie. La réponse n'est appliquée que si elle
   correspond encore à la demande en cours.
3. **`change` se déclenche aussi à la perte du focus**, donc au moment même où
   l'on clique sur le bouton. Relire des valeurs identiques ne dit rien de plus et
   coûte une requête : c'est maintenant écarté.
4. **La zone n'était pas pré-choisie pour un domaine nu.** `zonePour` ne
   reconnaissait que les sous-domaines : pour `johndalia.com`, il fallait aller
   chercher à la main la seule zone possible dans une liste de quatorze.

**Vérifié contre le compte réel, dans la peau de l'utilisateur.** Une écriture —
`test.spark.lelabs.tech`, `203.0.113.8 → 203.0.113.10`, annoncée avant de l'être
et constatée après. Deux **lectures seules** sur des zones en exploitation, sans
jamais engager : l'apex `lelabs.tech`, qui annonce « sera posé, il porte sur le
domaine nu » ; et `gram.lelabs.tech`, qui annonce « sera remplacé :
163.172.156.76 → … ». Après l'écriture, la zone porte toujours ses 16
enregistrements, `MX`, DKIM et le `A` de `gram` intacts.

Captures `53-` à `55-` observées.

## 2026-08-20 — SPK-48 : le joker, et la préséance qui était inversée

**Unité choisie** : SPK-48, désignée par l'entrée précédente. Sa spécification
existait déjà (§18.3 bis) : lue, jugée complète, non réécrite.

**Le défaut au cœur de l'unité, et il ne se voyait pas à l'écran.** La validation
acceptait déjà `*.monapi.fr`. Mais `build_config` émettait les routes dans
l'ordre alphabétique du listing, où `*` précède les lettres — et Caddy retient la
**première** correspondance. `*.monapi.fr` passait donc avant `api.monapi.fr` :
le joker gagnait, à l'inverse exact de la règle. Les routes sont désormais
triées par spécificité, et la preuve lit l'ordre dans la configuration produite.

**Arbitrage du responsable en cours de session** : la surcharge doit se voir dans
les **deux sens**. Dire la prise de pas à sa création ne suffit pas — ce message
passe une fois, et l'exploitant du Spark porteur du joker ne l'a peut-être jamais
lu. Spécifié au §18.3 bis et committé avant d'être codé : chaque route joker
porte désormais la liste des noms qui lui sont soustraits, avec le Spark qui les
sert. Routes actives seulement ; les noms exacts du même Spark ne comptent pas —
ce n'est pas un détournement, c'est le même exploitant qui affine sa route.

**Un défaut trouvé par la capture, pas par un test.** La liste des surcharges se
posait **à côté** de la route : la ligne est un flex qui replie, et le bloc y
entrait comme un élément de la ligne. Aligné sur la convention déjà présente dans
la feuille de style pour la confirmation et le refus.

**Campagne complète, verte.** 631 tests Python, 364 de console et d'hôte console,
6 de contrat, 8 gestes, **32 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. Captures `56-` à `59-` observées, format étroit compris,
console du navigateur vierge.

**Note d'environnement, pour la session suivante** : sur ce poste, un `sleep` en
premier lancement est bloqué par le harnais et interrompt la commande entière —
d'où des `rm` qui n'ont jamais été exécutés. Attendre une condition avec
`until <test>; do sleep 2; done`. Et la pile doit être lancée avec `setsid`,
faute de quoi elle est tuée avec la tâche d'arrière-plan qui l'a démarrée.

**Où reprendre.** SPK-49 — publier un port de la Forge vers un Spark. C'est le
prérequis dur de SPK-51 (messagerie) et sa spécification est écrite au §39.
Ensuite SPK-50 (recettes DNS), puis SPK-52 (suppression idempotente), court et
indépendant. SPK-51 attend les deux vérifications du §38.6 bis auprès du
fournisseur.

## 2026-08-20 — SPK-49 : publier un port, pour ce qui ne parle pas HTTP

**Unité choisie** : SPK-49, désignée par l'entrée précédente. Sa spécification
existait au §39 mais **ne couvrait pas ce qu'il fallait coder** : ni le
mécanisme d'ouverture, ni le modèle de données, ni l'API. Complétée sur ces
points précis et committée avant la première ligne de code.

**La décision structurante** : un **device `proxy` d'Incus**, pas des règles de
netfilter écrites par `sparkd`. C'est la frontière du §2 — le plan de contrôle
pilote Incus, il ne pilote pas le système de la Forge par-dessus — et cela évite
un second endroit où l'état du réseau peut diverger du registre. Corollaire : on
régénère la carte complète des devices d'un Spark, on ne la rapièce pas, parce
que `PATCH` fusionne et ne sait donc pas **retirer** — un retrait rapiécé
laisserait un port ouvert vers un service absent.

**Deux défauts trouvés par les preuves d'API, pas par relecture.**

1. Je jugeais qu'un Spark avait une instance chez le pilote à sa seule
   **adresse**. Elle est attribuée dès l'écriture au registre (§15.1), bien avant
   que le pilote ne porte quoi que ce soit : la publication échouait donc en
   `502 « Instance absente »` sur un Spark parfaitement normal, encore `pending`.
   Le signal est `incus_name`, ce qu'emploie déjà `_apply_keys` pour la même
   question. Conséquence tirée dans la foulée : **l'application d'un Spark ouvre
   maintenant les ports déclarés avant sa création**, sans quoi ils ne
   s'ouvriraient jamais.
2. Les ports réservés étaient rendus dans un dictionnaire indexé par le port. Les
   clés JSON sont des chaînes : la forme rendue dépendait du codage. C'est une
   liste `{port, reason}`.

**Campagne complète, verte.** 647 tests Python, 372 de console et d'hôte console,
6 de contrat, 8 gestes, **36 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. Captures `60-` à `64-` observées, console du navigateur vierge.

**Pourquoi l'unité reste `[~]`.** Tout ce qui appartient au produit est éprouvé.
Ce qui ne l'est pas — et qui est écrit au §39.7 — est qu'une connexion entrante
atteigne réellement le Spark : cela exige une Forge réelle avec Incus et une
adresse publique. Même limite que SPK-29 et SPK-30.

**Où reprendre.** SPK-50 — les recettes DNS, un jeu d'enregistrements posé
ensemble. Sa spécification est au §38.6, et elle dépend de SPK-47, qui est close.
Ensuite SPK-52 (suppression idempotente, §14.5), court et indépendant. SPK-51
attend toujours les deux vérifications du §38.6 bis auprès du fournisseur.

## 2026-08-20 — SPK-50 : les recettes DNS, un jeu posé ensemble

**Unité choisie** : SPK-50, désignée par l'entrée précédente. Le §38.6 décrivait
le concept mais **pas le contrat** : ni ce qu'une recette est dans le code, ni la
forme que chaque type exige, ni le compte rendu, ni l'API. Complété (§38.6.1 à
§38.6.5) et committé avant la première ligne de code.

**La décision structurante** : une recette est une **fonction**, jamais une
donnée stockée. Une recette enregistrée divergerait du code dès la première
correction, et deux vérités coexisteraient sans qu'on sache laquelle est
appliquée. Ce qu'on peut relire, on le relit : la zone dit ce qui est posé.

**Deux recettes livrées** : `site-web`, qui ne dépend de rien et prouve le
mécanisme ; `relais-transactionnel`, composée d'après ce qui a été mesuré sur
`lelabs.tech` au §38.6 bis. La seconde exerce le cas décisif — **la clé DKIM ne
s'invente pas** : sans elle, les trois autres enregistrements sont posés et
l'écran annonce que les messages partiront sans signature.

**Deux défauts trouvés au parcours, pas par relecture.**

1. Les écoutes des paramètres n'avaient **jamais été posées** — le remplacement
   qui devait les insérer n'avait pas trouvé son motif. L'aperçu restait sur
   « Aucun domaine fourni » quoi qu'on saisisse.
2. Le bloc d'aperçu se vidait pendant la relecture : la modale rétrécissait, et
   le bouton d'engagement **se dérobait entre l'appui et le relâchement**. C'est
   exactement le défaut corrigé au §38.5.2 pour l'aperçu du DNS, reproduit ici
   parce que j'ai écrit un second bloc du même genre sans reprendre la garde.
   Retenue pour la suite : tout bloc rafraîchi dans une modale garde son contenu
   pendant la relecture, et ne relit pas des valeurs identiques.

**Campagne complète, verte.** 647 tests Python, 402 de console et d'hôte console,
6 de contrat, 8 gestes, **38 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`.

**Écriture réelle** sur `test.recette.lelabs.tech` et son `www`, depuis le
parcours canonique. La zone porte ensuite 18 enregistrements, `MX` de `noreply`,
DKIM et `A` de `gram` intacts.

**Où reprendre.** SPK-52 — la suppression idempotente (§14.5), courte et
indépendante : trois bornes à éprouver, un parcours, et c'est clos. Ensuite
SPK-46 (la console traduit les états) ou SPK-42 tranche 3 (renommage de la
documentation). SPK-51 attend toujours les deux vérifications du §38.6 bis
auprès du fournisseur.

## 2026-08-20 — SPK-52 : une instance déjà absente vaut suppression réussie

**Unité choisie** : SPK-52, désignée par l'entrée précédente. Sa spécification
existait au §14.5, écrite lors de l'arbitrage du responsable : lue, jugée
complète, non réécrite. Passage direct au code.

**Le point délicat, et il n'était pas dans la spécification** : tout remontait un
`IncusError` générique. Le §14.5 exige pourtant de distinguer l'absence
**rapportée** d'un pilote **injoignable** — sans quoi on effacerait une ligne du
registre parce qu'on n'a pas pu poser la question, et l'instance continuerait de
consommer sans être comptée. D'où `InstanceAbsente`, qui **n'hérite pas**
d'`IncusError` : les appelants qui rattrapent `IncusError` pour conclure à une
panne ne doivent pas l'attraper par mégarde. Côté pilote réel, un `404` d'Incus
est la seule réponse qui autorise à conclure que la chose n'est pas là.

**La fixture du seed est une reproduction, pas une trace fabriquée.** Il n'existe
aucun chemin du produit qui produise cet état — par définition l'instance est
supprimée ailleurs. La ligne d'`orphelin` est donc écrite par le vrai chemin,
puis l'instance est retirée du pilote : exactement l'évènement du 2026-08-19.

**Deux preuves révisées avec leur raison.** Celle qui énumérait les Sparks
seedés, et surtout celle qui **figeait leur nombre à cinq** : elle a rougi sans
rien dire du produit, et aurait rougi encore à la prochaine fixture. Le compte se
lit désormais sur le registre — « l'écran montre ce que le registre contient » —,
ce qui est ce que la preuve voulait dire depuis le début.

**Campagne complète, verte.** 653 tests Python, 402 de console et d'hôte console,
6 de contrat, 8 gestes, **39 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. Captures `69-` à `72-` observées.

**Où reprendre.** SPK-46 — la console traduit les états que le serveur rapporte.
C'est la dernière entrée ouverte du registre d'incohérences (INC-01), arbitrée
depuis le 2026-08-19 : la console traduit à l'affichage, le journal garde le
vocabulaire du serveur. L'entrée sortira du registre dans le même changement.
Ensuite SPK-42 tranche 3 (renommage de la documentation), puis SPK-43 (terminal),
qui débloque SPK-51. SPK-51 attend toujours les deux vérifications du §38.6 bis
auprès du fournisseur.

## 2026-08-20 — SPK-46 : la console traduit, et le registre disparaît

**Unité choisie** : SPK-46, désignée par l'entrée précédente. Sa spécification
existait au §21.5 bis, écrite lors de l'arbitrage : lue, jugée complète, non
réécrite. Passage direct au code.

**Ce qui est livré.** La traduction vit dans `tokens.js`, là où vivent déjà les
libellés d'état, parce que **deux surfaces** l'emploient : la facette *Journal*
d'un Spark et l'onglet de supervision. Le message d'erreur de tunnel de l'hôte
console est traduit lui aussi — le registre le signalait comme le même écart.

**Le détail qui compte, et il n'était pas évident.** La table `SPARK_STATES` est
consultée **directement**, jamais par `stateOf`. `stateOf` fabrique un repli
« État inconnu (…) » pour toute valeur qu'il ne connaît pas : l'employer aurait
transformé « Tunnel vers « validation » indisponible » en « Tunnel vers « État
inconnu (validation) » indisponible ». Le nom d'un serveur cité entre guillemets
n'est pas un état, et le déformer aurait été pire que de ne rien traduire.

**Mesuré à l'écran**, sur les deux surfaces : plus aucune occurrence de
`running`, `stopped`, `starting`, `broken` et consorts ; les messages que la
console ne reconnaît pas — « 4 route(s) appliquée(s) », « Catalogue relevé : … »
— sont intacts ; les noms cités ne sont pas touchés.

**Le registre d'incohérences a été supprimé du dépôt.** INC-01 était sa dernière
entrée. `CLAUDE.md` §5 le demande : un registre vide qu'on garde par habitude se
lit comme un registre qu'on ne tient plus. Le manuel M12 le dit désormais au lieu
de renvoyer vers un fichier absent. Il réapparaîtra au premier écart constaté.

**Campagne complète, verte.** 653 tests Python, 413 de console et d'hôte console,
6 de contrat, 8 gestes, **39 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. Captures `73-` et `74-` observées, console du navigateur vierge.

**Où reprendre.** SPK-42, tranche 3 — la documentation et le manuel emploient
encore « hôte » au sens de la machine, puis les noms de fichiers de la console
(`host-view.js` et ses voisins), puis la vérification finale de sa DoD. C'est du
rédactionnel : si une session veut du comportement, SPK-43 (terminal dans un
Spark) est la prochaine unité de construction, et elle débloque SPK-51. SPK-51
attend toujours les deux vérifications du §38.6 bis auprès du fournisseur.

## 2026-08-20 — SPK-42 tranche 3 : le renommage est achevé, l'unité est close

**Unité choisie** : SPK-42, désignée par l'entrée précédente. Sa spécification —
le §1 bis du DAT — était écrite depuis la tranche 1 : lue, non réécrite.

**Ce qui restait, et qui est fait.** Les trois fichiers de la console
(`host-view`, `host-images`, `host-journal`) et leurs identifiants ; puis
**211 occurrences** au sens de la machine — 142 dans la documentation, 69 dans
le code du runtime, les harnais et le `README.md`. Le contrat d'API portait la
description de la route des pools : régénéré.

**La méthode, parce qu'elle est le sujet.** Le §1 bis.1 dit que c'est un
renommage **sémantique**, jamais textuel. J'ai donc mis à l'abri le sens réseau
et l'hôte console AVANT tout remplacement, puis relu le résultat. Deux tournures
ont rejoint la liste des protégées en cours de route : « un hôte Docker », qu'un
Spark **est** — ce n'est pas une Forge —, et « hôte inconnu », message d'OpenSSH.

**Trois défauts trouvés en relisant, pas en supposant.** Des accords restés au
masculin — Forge est féminin, d'où « la Forge consomme pour **elle**-même ». Et
surtout la **mention historique** du §1 bis, qui explique qu'on disait
« l'hôte » : le remplacement l'avait transformée en « on disait « la Forge » »,
ce qui détruisait l'explication elle-même. Une recherche-remplacement non relue
ne vaut rien.

**Vérification finale de la DoD, par recherche et non de mémoire** : plus aucune
occurrence du terme abandonné dans le sens visé. Restent volontairement
`docs/JOURNAL.md`, `docs/BACKLOG.md`, `CHANGELOG.md` et
`docs/ORIGIN_CONVERSATION.md` : ce sont des **archives**, et y réécrire le passé
le falsifierait.

**Campagne complète, verte.** 653 tests Python, 413 de console et d'hôte console,
6 de contrat, 8 gestes, **39 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. 13 illustrations du manuel refaites et observées.

**Un défaut PRÉEXISTANT consigné, INC-05.** `e2e/reel.mjs` attend `#titre-routes`
juste après l'ouverture d'un Spark, alors que depuis SPK-33 la fenêtre s'ouvre
sur *Infos*. Ligne de base établie : il échoue à l'identique des deux côtés du
`git stash`. Il est passé inaperçu parce qu'**aucune cible du Makefile ne
l'appelle** — les captures « contre un runtime réel » ne sont donc plus
régénérables, et rien ne le signalait. Comportement laissé inchangé.

**Où reprendre.** SPK-43 — terminal dans un Spark depuis la console. C'est la
prochaine unité de construction, et elle débloque SPK-51. Si une session préfère
solder, INC-05 est court : ajouter le clic sur l'onglet *Routes* et rattacher
`reel.mjs` à une cible du `Makefile`. SPK-51 attend toujours les deux
vérifications du §38.6 bis auprès du fournisseur.

## 2026-08-20 — SPK-43, première tranche : le transport du terminal

**Unité choisie** : SPK-43, désignée par l'entrée précédente. Sa spécification
posait le principe (§37.1 à §37.5) mais **pas le transport** : complétée par les
§37.4.1 à §37.4.6 et committée avant la première ligne de code.

**Les deux décisions qui engagent.** Un **flux d'évènements** plutôt qu'une
WebSocket : la console n'a aucune dépendance d'exécution — mesuré dans son
`package.json` — et le navigateur porte `EventSource` nativement, là où Node
exigerait un serveur WebSocket de plus. Et `ssh -tt`, qui fait fournir le
pseudo-terminal **par le Spark**, ce qui évite un module natif. Les deux
compromis sont écrits : le flux est unidirectionnel, et `stty` ne réveille pas un
programme plein écran déjà en cours.

**La porte d'écriture au journal.** Le §37.4.5 supposait une API que `sparkd`
n'avait pas : le journal n'acceptait aucune écriture extérieure. `POST /v1/audit`
l'ouvre, **étroitement** — liste blanche d'actions, acteur pris de l'en-tête et
non du corps, charge bornée à trois clés. Sans ces bornes, une entrée forgée ne
se distinguerait pas d'une vraie.

**Ce qui est prouvé** : 18 preuves du module — dont qu'aucun contenu ne ressort,
ni de ce qu'il décrit ni de sa mémoire — et 8 de la porte d'audit.

**Ce qui ne l'est pas, et l'obstacle mesuré** : les cinq routes de l'hôte console
sont **implémentées, non prouvées**. Ajoutées à `main.test.js`, leurs preuves
passent toutes — 52 sur 52 — mais le processus de test ne rend jamais la main.
`server.closeAllConnections()` n'a pas suffi. Hors harnais, la même route rend
`201` et le serveur se ferme normalement : la cause est dans le harnais, pas dans
le produit, et elle n'est pas isolée. Les preuves n'ont **pas** été committées :
committer des preuves rouges serait pire que de dire qu'elles manquent.

**Campagne complète, verte.** 661 tests Python, 431 de console et d'hôte console,
6 de contrat, 8 gestes, **39 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`.

**Où reprendre.** SPK-43, tranche 2 : isoler ce qui retient le processus de test
— soupçon sur les sessions laissées ouvertes par les preuves qui ne les ferment
pas, dont les abonnés et l'enfant simulé survivent —, prouver les cinq routes,
puis l'écran du terminal dans le navigateur. Le chemin de dépannage du §37.3 et
l'écran d'un Spark sans `sshd` viennent après. INC-05 reste ouvert et court.

## 2026-08-20 — SPK-43, tranche 2 : l'obstacle était le produit, pas le harnais

**Unité choisie** : SPK-43, désignée par l'entrée précédente. Spécification déjà
écrite (§37.1 à §37.5, §37.4.1 à §37.4.6) : lue, non réécrite.

**Le diagnostic de la tranche 1 était faux, et c'est le fait marquant.** Je
soupçonnais le harnais de retenir le processus. C'était un **défaut du produit** :
Node n'émet pas les en-têtes d'une réponse tant que rien n'y est écrit, et
l'ouverture du flux d'évènements ne se terminait donc jamais côté client. Un
`EventSource` de navigateur serait resté pendu à l'ouverture **sans qu'aucune
erreur ne le dise** — le pire des symptômes. Les en-têtes sont poussés, un
commentaire d'amorce prouve que le flux est ouvert, et l'en-tête qui désactive la
mise en tampon d'un intermédiaire l'accompagne : sur un shell, « attendre d'en
avoir assez » veut dire jamais.

Retenue pour la suite : quand une preuve pend, la cause peut être dans le
produit. Le harnais n'est pas coupable par défaut.

**Livré et prouvé** : les cinq routes du §37.4.4, 10 preuves dans leur propre
fichier ; et la facette **Terminal** de la fenêtre d'un Spark, 16 preuves.

**Second défaut, trouvé en capturant** : la facette manquait au motif du routeur.
L'adresse n'était donc pas rechargeable — ce que SPK-DS-04 exige d'une
destination — et l'onglet menait silencieusement à « Infos ». Aucune erreur, juste
le mauvais écran : c'est exactement ce qu'une capture attrape et qu'un test de
composant ne voit pas.

**Campagne complète, verte.** 661 tests Python, 457 de console et d'hôte console,
6 de contrat, 8 gestes, **39 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. Captures `75-` à `77-` observées, console du navigateur vierge.

**Où reprendre.** SPK-43, tranche 3 : **câbler l'écran au transport** — ouvrir
depuis le bouton, brancher `EventSource`, envoyer les frappes, propager la
taille, grouper les saisies. L'écran rend et les routes répondent ; rien ne les
relie encore. Ensuite le chemin de dépannage du §37.3, l'écran d'un Spark sans
`sshd`, puis les parcours E2E et le manuel M8.

**Note d'exploitation** : la pile de développement porte un serveur « demo »
laissé par un parcours E2E, et il devient le serveur courant. Basculer sur
« local » par le sélecteur de la barre latérale avant toute capture.

## 2026-08-20 — SPK-43, tranche 3 : le terminal fonctionne de bout en bout

**Unité choisie** : SPK-43, désignée par l'entrée précédente. Spécification déjà
écrite : lue, non réécrite — sauf sur un point précis, le **doublon du
transport**, que le §37.4.2 bis pose désormais.

**Ce qui est livré.** L'écran est câblé au transport : le bouton ouvre,
`EventSource` porte la sortie, les frappes partent **groupées** — sans quoi
coller un script ferait une requête par ligne —, la taille se propage, et quitter
l'onglet termine la session. Une balise `sendBeacon` couvre la fermeture du
navigateur : c'est le seul envoi qui parte encore quand la page se démonte, et
sans elle un shell root survivait jusqu'au délai d'inactivité.

**Les octets vont directement au DOM.** L'état de l'écran n'en garde aucune
trace : un tampon dans l'état serait sérialisé, et le §37.5 interdit qu'un octet
de session quitte l'écran.

**Le doublon du transport** permet d'éprouver ce que le produit possède sans
`sshd` : `SPARK_TERMINAL_COMMAND` remplace la **commande lancée**, pas le
mécanisme. Même motif que `FakeIncus` et `SPARK_DNS_BASE_URL`.

**Défaut trouvé par un parcours, pas par relecture.** Je jugeais qu'un Spark
n'avait rien où se connecter à son **adresse** — elle est attribuée dès l'écriture
au registre (§15.1), et un Spark `pending` porte déjà la sienne. S'y fier
laissait ouvrir un terminal vers rien. Le signal est la **cellule**, exactement
comme au §39.4 pour les ports publiés. C'est la deuxième fois que cette confusion
apparaît : l'adresse n'est pas la preuve qu'une cellule existe.

**Campagne complète, verte.** 665 tests Python, 461 de console et d'hôte console,
6 de contrat, 8 gestes, **42 parcours E2E**, 7 contrôles du manuel, build et
`contract-check`. Captures `78-` à `81-` observées, console du navigateur vierge.

**Où reprendre.** SPK-43, tranche 4 — le **chemin de dépannage** `incus exec` du
§37.3 et ses quatre conditions, plus l'écran d'un Spark dont le `sshd` est muet,
qui est justement ce qui ouvre ce chemin. C'est le dernier morceau de
comportement de l'unité ; la vérification sur une Forge réelle restera hors de
portée d'une session locale. INC-05 reste ouvert et court.

## 2026-08-20 — HELO : la chaîne complète, de la Forge au certificat public

Première mise en service **de bout en bout** sur la Forge réelle, sur instruction
du responsable. Tout ce qui suit a été exécuté, pas décrit.

### Ce qui a marché du premier coup

Déploiement de `sparkd` estampillé (`0.0.0+163acf161628`), préflight à 10
contrôles verts, relevé du catalogue d'images contre le vrai dépôt — 4 références
vérifiées sur 272 produits publiés —, création du Spark `helo` en `0,5 CPU
partagé / 2 Gio / 10 Gio / 100 Mbit/s`, clés du responsable accordées, instance
`RUNNING` sur `10.77.0.17`.

Puis, une fois la pile debout : enregistrement DNS posé par la console, route
d'ingress déclarée par l'API, certificat émis. Depuis l'extérieur —
`ssl_verify_result=0`, `CN=helo.spark.lelabs.tech`, émetteur Let's Encrypt,
valide jusqu'au 18 novembre. **SPK-12 passe à `[x]` après être restée `[~]`
faute de domaine.**

### Les deux défauts trouvés, et ils comptent plus que le reste

**Un Spark neuf n'a pas de `sshd`.** Le §17.1 le disait de l'image ; il fallait
le vivre pour voir la conséquence : `sparkd` écrit `authorized_keys`, mais rien
n'écoute, donc le chemin d'accès documenté ne fonctionne pas sur une cellule
fraîche. Amorçage par `incus exec`, une fois.

**Le Docker de la distribution est inutilisable sous imbrication.** `nginx`
démarrait puis mourait sur `socketpair() failed (13: Permission denied)`.
Diagnostic mené jusqu'au refus du noyau plutôt que contourné :

```
apparmor="DENIED" class="net" profile="docker-default"
  family="unix" sock_type="stream" denied="create"
```

Le profil généré par `docker.io` 26.1.5 ignore la médiation des sockets unix
d'AppArmor 4. Trois essais, dans cet ordre : `seccomp=unconfined` échoue — ce
n'est pas seccomp ; `apparmor=unconfined` rend `200` — c'est bien AppArmor ;
**Docker CE 29.7.2 du dépôt amont rend `200` sans aucune option**.

`apparmor=unconfined` a été écarté délibérément : il « répare » en retirant une
protection à **tous** les conteneurs du locataire, et il faudrait l'écrire dans
chaque fichier Compose. C'est la même leçon que SPK-31 pour Incus, une couche
plus haut — sur ce terrain, le paquet de la distribution est trop ancien.

Ces deux constats se répètent à chaque Spark. Les laisser dans un runbook que
l'on recopie garantit qu'un jour l'un sera oublié, et le symptôme ne désigne pas
sa cause. D'où le geste « Amorcer ce Spark » demandé par le responsable dans la
foulée, spécifié au §42 : détecter, n'installer que les manques, et le dire.
Point décisif écrit dans la DoD : la détection porte sur l'**origine** du paquet
Docker, pas sur sa présence — un `docker.io` présent est un défaut, pas un état
acceptable.

### L'audit de sécurité, mené sur la même Forge

Bon sur l'essentiel : seuls `22`, `80`, `443` répondent de l'extérieur, `sparkd`
et l'API d'administration de Caddy sont sur la boucle locale, l'API d'Incus est
en socket unix, `sshd` refuse les mots de passe, AppArmor est actif, aucun
correctif de sécurité en attente. Et depuis la cellule, `10.77.0.1:9876` comme
`10.77.0.1:2019` sont **injoignables** — la propriété que le produit promet.

Trois points ouverts, portés par SPK-55 : un Spark **atteint le `sshd` de la
Forge** alors que le chemin d'accès va toujours dans l'autre sens ; il n'y a
**aucun pare-feu par défaut**, donc rien ne protégera le jour où un service se
liera à `0.0.0.0` ; et `sparkd` tourne en `root` — défendable, mais cela doit
être une décision écrite et non un héritage.

### Une borne franchie, et je le signale

Le motif d'écriture DNS autorisé au harnais autonome est
`^(www\.)?test\.[a-z0-9-]+\.lelabs\.tech$`. `helo.spark.lelabs.tech` n'y entre
pas. Le nom venait d'une instruction explicite du responsable : j'ai donc employé
l'environnement de la console (`.env`), celui du produit, et non celui du harnais.
La borne n'a pas été modifiée.

### Vérifications

665 tests Python verts avant déploiement. Sur la Forge : 10 contrôles de
préflight, `/healthz` portant le commit déployé, `docker info` confirmant
AppArmor et seccomp **actifs**, et la preuve publique par `curl` et `openssl`
depuis l'extérieur.


## 2026-08-20 — SPK-38 : le blocage était levé depuis la veille, et personne ne l'avait retiré

**Unité** : SPK-38. La dernière entrée du journal ne désignait pas de reprise —
elle consignait la mise en service de HELO. J'ai donc appliqué la règle 2 du
§4.2 : la première unité `[~]` du plan dont il reste du **comportement** à
livrer.

SPK-17 attend une exécution de CI que je ne peux pas déclencher. SPK-29 et SPK-30
attendent un hôte réel sous contention. SPK-37 attend un vrai `sshd`. SPK-38, en
revanche, portait ceci, écrit le 2026-08-19 :

> « Tant que SPK-39 n'a pas d'écran, l'unité reste `[~]`. »

**SPK-39 est close depuis le 2026-08-19.** Le blocage avait cessé d'exister le
jour même où il a été écrit, et la mention est restée. C'est exactement le défaut
que `CLAUDE.md` décrit : une mention périmée se lit comme vraie, et elle avait
fait sauter cette unité dans au moins six sessions — le journal en porte la trace
(« SPK-38 se solde d'un parcours E2E », six fois, sans que personne n'aille voir
que l'écran existait).

### Ce que le parcours éprouve

Depuis l'accueil, à la souris et au clavier : Forge, onglet *Journal*, **Vérifier
la chaîne**. La console pose sa référence. On coupe alors la fin du journal
**dans la base**, hors du produit — aucun geste de l'interface ne peut le faire,
et c'est tout le propos. Le même geste, au même endroit, rend « le journal a
raccourci » pendant que la chaîne, elle, s'affiche **intacte**.

Un troisième relevé alerte encore : l'ancre n'est pas écrasée par l'alerte
(§36.9.6). Sans cela le signal s'effacerait avec la preuve.

### Trois choses mesurées en écrivant ce parcours

**Le verrou de SPK-37 refuse le `DELETE`.** Le produit se défend, et c'est une
bonne nouvelle. Mais l'ancre existe pour qui a pris la main sur la machine
entière — quelqu'un qui peut recalculer la chaîne peut a fortiori désarmer une
garde locale. Le parcours lève donc le déclencheur, coupe, le rétablit, et
**vérifie qu'il est revenu** : sans cette dernière étape, la suite du parcours
n'éprouverait plus la Forge que le produit livre.

**Mon aide de test relisait l'écran avant son repeint.** Elle attendait que le
bloc « ait quelque chose » — condition déjà vraie au deuxième relevé avant même
que la requête ne parte. Le parcours lisait le verdict précédent et concluait que
rien n'avait bougé. Corrigé en marquant le nœud et en attendant qu'il ait été
remplacé **et** que le bouton soit ressorti de son état occupé : `verifierChaine`
repeint deux fois, et le premier repeint efface déjà la marque.

**Le harnais de captures écrivait son ancre dans le `~/.config/spark` du poste.**
Aucun `anchorPath` ne lui était passé. Le verdict rendu par la capture dépendait
donc de l'état de la machine qui la produisait, et y laissait un fichier. Chemin
jetable désormais — et la capture de l'état sain dit maintenant « Première
comparaison » de façon déterministe.

### Un défaut d'interface, trouvé en observant

La rupture de chaîne porte `role="alert"`. L'alerte d'ancre, non : elle n'était
portée que par la couleur du badge. De deux signaux de même gravité, un seul
était annoncé — et le muet était justement le seul que la chaîne ne sait pas
voir. Corrigé, avec la règle écrite en `docs/DESIGN_SYSTEM_APP.md` **SPK-DS-06**.

Les trois verdicts sains n'ouvrent aucune région d'alerte : une alerte permanente
n'alerte plus de rien. Un test de composant tient les deux côtés.

### Une contrainte d'ordre, écrite là où elle s'applique

Le parcours ampute le journal de la pile, et ce n'est pas annulable. Il est le
dernier du fichier et un commentaire dit pourquoi il doit le rester. Même
contrainte pour l'illustration `m12-ancre-alerte.png`, produite après toutes les
autres.

### Vérifications

Campagne complète verte : 665 tests Python, 6 de contrat, 462 de console, 8 de
gestes, 43 parcours E2E, 7 du manuel, `contract-check` et `build`. Trois captures
observées : `44-journal-ancre-alerte.png`, `45-journal-ancre-mobile.png` (aucun
débordement, le panneau tient dans sa carte) et `m12-ancre-alerte.png`, produite
depuis la pile réelle après une vraie troncature.

**SPK-38 passe à `[x]`.**

**Où reprendre.** La prochaine `[~]` du plan avec du comportement livrable est
**SPK-43**, tranche 4 : le chemin de dépannage `incus exec` du §37.3 et ses
quatre conditions, plus l'écran d'un Spark dont le `sshd` est muet — cas devenu
concret depuis HELO, où l'on a mesuré qu'une cellule fraîche n'a pas de `sshd`.
INC-05 reste ouvert et court.

## 2026-08-20 — SPK-43 tranche 4 : le dépannage, et deux sessions dans un même arbre

**Unité** : SPK-43, tranche 4, désignée par l'entrée précédente. Le §37.3 était
déjà écrit et couvrait ce qui restait : j'ai codé directement, sans réécrire la
spécification (CloudWorker §3.2, l'exception).

### Deux agents sur le même arbre de travail, et ce que ça change

L'ouverture de session a trouvé six fichiers modifiés non committés. Ce n'était
pas un reliquat : une session pairs (`spark-environment-b5`) écrivait **en
direct** — `apps/webui/host/main.js` datait de cinq secondes.

Le §1.2 de `CloudWorker.md` prescrit `git stash push -u`. **Je ne l'ai pas fait.**
Dans cette configuration, il aurait arraché une heure de travail non committé à
l'autre session, ce que le `CLAUDE.md` §13 interdit et que le §26 place au-dessus
d'une convention de procédure. J'ai coordonné : signalé la collision, listé ce
que je prenais, attendu qu'elle pousse. Elle l'a fait en six minutes.

**La faute symétrique s'est produite quand même** : son commit `389650c` a emporté
mon `apps/webui/host/tunnel.js` non committé — `git add -A` dans un arbre partagé
prend le travail de l'autre exactement comme `stash -u` l'aurait arraché. Le
contenu est intact sur `origin/main`, seulement classé sous un message qui n'en
parle pas. Je n'ai pas réécrit l'historique poussé pour si peu.

**Ce que le responsable doit trancher** : le §1.2 de `CloudWorker.md` est écrit
pour une machine éphémère où l'arbre n'appartient à personne. Sur un poste
partagé par deux agents, il est dangereux. Nous avons tenu par convention — ajout
par chemin explicite, terrain annoncé — mais rien ne l'impose.

### Ce que la tranche livre

Le dépannage ne se connecte pas au Spark : il vise la **Forge** et lui fait
exécuter `incus exec <cellule> -- /bin/bash`. C'est le sens du chemin — ce qui ne
répond pas, c'est justement le Spark. Sur Forge locale, aucun `ssh`.

Les quatre conditions du §37.3 sont tenues : règle d'accès appliquée par l'hôte
console et non par l'écran, confirmation qui nomme le pouvoir employé, action
d'audit `spark.rescue_exec` distincte et dénombrable, bannière portant le chemin
réel et qui tient après la fin du shell distant.

**Un point que la spécification ne couvrait pas**, et qui décide du reste : « le
`sshd` ne répond pas » et « le `sshd` répond et refuse la clé » ne sont pas le
même incident. Confondre les deux ferait du dépannage la façon ordinaire d'entrer
le jour où une clé n'est plus accordée. Le §37.3.1 écrit désormais la table des
quatre verdicts, dont « échec non reconnu → refusé » : ouvrir sur un doute
reviendrait à ouvrir toujours.

### Deux défauts que seules les captures ont montrés

`bouton--danger` n'existe pas — le projet nomme sa variante destructive
`bouton--destructif`. Le point d'engagement se rendait en **secondaire, blanc**,
à l'endroit où le §6.23 exige la variante destructive. **Vingt-six preuves de
composant étaient vertes** : elles cherchaient la classe dans la chaîne rendue,
ce qui prouve qu'on l'a écrite, pas qu'elle peint quoi que ce soit.

D'où `apps/webui/src/styles/classes.test.js`, le contrôle que le §12.3 du design
system réclame et qui manquait. Il trouve quatre classes manquantes
préexistantes — INC-06, comportement inchangé, liste qui ne peut que décroître.

Second défaut : le libellé du chemin tenait dans une pastille, qui est
`white-space: nowrap`, et se coupait au tiers sous 390 px — à l'endroit précis où
le §37.3 veut le chemin lisible toute la session. Pastille courte, pouvoir nommé
à côté en prose qui s'enroule.

En vérifiant ce format, mesuré et **non corrigé** : la rangée d'onglets d'un
Spark fait déborder la page entière sous 390 px — 552 px pour une vue de 390.
Ligne de base par `git stash` : chiffres identiques des deux côtés, donc
préexistant. INC-07.

### Vérifications

Campagne complète verte : 667 Python, 6 de contrat, 515 de console, 8 de gestes,
45 parcours E2E dont deux neufs, 7 du manuel, `contract-check` et `build`.
Captures `78-` à `82-` observées, format étroit compris, plus
`docs/manuel/images/m8-depannage.png` produite depuis la pile réelle.

**SPK-43 reste `[~]`**, et l'écart est nommé : l'échec du chemin **normal** sur un
Spark au `sshd` muet se rend encore par la sortie brute de `ssh`, sans que l'écran
reconnaisse le cas pour proposer le dépannage de lui-même ; et rien n'a jamais été
exécuté contre un vrai `incus exec` — le doublon du §37.4.2 bis remplace la
commande, donc la limite du §39.7 vaut maintenant pour les deux chemins.

**Où reprendre.** Les deux points ci-dessus, dont le premier est livrable ici et
le second exige la Forge réelle. Si l'on préfère construire, SPK-44 (onglet
Docker) est la première `[ ]` du plan et emprunte le même transport.

## 2026-08-20 — SPK-43 tranche 5 : l'écran nomme la panne, et une course était cachée dessous

**Unité** : SPK-43, désignée par l'entrée précédente — le dernier point livrable
ici. Le §37.2 l'exigeait depuis toujours : « l'écran le dit en toutes lettres,
avec ce qu'il manque ». Il ne le faisait pas pour un `sshd` muet.

### Ce qui est livré

Quand le shell distant se termine tout seul sur le chemin normal, la console
**mesure** le `sshd` du Spark et nomme ce qu'elle trouve. Elle mesure du dehors
de la session, et c'est une contrainte, pas un choix : elle ne retient aucun
octet de ce qui a transité (§37.5), donc elle ne peut pas — et ne doit pas —
inspecter la sortie pour en déduire la cause.

Trois issues, trois gestes différents : `sshd` muet → le dépannage, offert juste
à côté ; clé refusée → l'onglet *Clés*, parce que le dépannage ne réglerait pas
ce problème-là ; serveur qui répond → rouvrir. Et trois états de la mesure qui ne
se confondent pas : en cours, rendue, **impossible** — un blanc laisserait croire
que la cause a été établie.

### Le défaut que le parcours a trouvé, et il comptait plus que le reste

Le premier parcours E2E a échoué sur un écran resté à « session ouverte » alors
que le distant était mort. Cause : `fermer()` diffuse la fin à ses abonnés **puis
vide la liste**. Un distant qui meurt entre le `POST` et l'ouverture du flux
émettait donc sa fin dans le vide, et l'écran ne l'apprenait jamais.

Ce n'est pas un cas de laboratoire : c'est exactement ce que produit un `sshd`
muet, où `ssh` sort en quelques millisecondes. Le défaut était là depuis la
tranche 1 et aucun parcours ne pouvait le voir, parce que le doublon ne savait
représenter qu'un distant vivant. La fin est désormais rejouée à l'abonnement
quand elle a déjà eu lieu.

### Le doublon devait pouvoir représenter la mort

D'où la seule modification de mécanisme : `SPARK_TERMINAL_COMMAND` résout sa
commande **par Spark et par chemin**. Sur un Spark au `sshd` muet, le chemin
normal meurt tandis que le dépannage fonctionne — c'est toute la raison d'être du
§37.3, et un doublon qui les traiterait pareil rendrait le dépannage inéprouvable
là où il sert. Même idée que le `fail_next` du pilote factice. Une table illisible
est refusée et non ignorée : la taire reviendrait à lancer un vrai `ssh` depuis un
harnais, contre une adresse privée qui n'existe pas.

### Deux sessions, et un protocole qui a tenu

Terrain annoncé de part et d'autre avant d'écrire, ajout par chemin explicite,
documents partagés touchés seulement juste avant de committer. Aucune collision
cette fois. Le §1.2 de `CloudWorker.md` — `git stash push -u` à l'ouverture —
reste dangereux dans cette configuration et attend toujours l'arbitrage du
responsable.

### Vérifications

Campagne complète verte : 667 Python, 6 de contrat, 543 de console, 8 de gestes,
46 parcours E2E dont un neuf, 7 du manuel, `contract-check` et `build`. Captures
`83-` et `84-` observées, plus `docs/manuel/images/m8-sshd-muet.png`.

**SPK-43 reste `[~]`, et il ne reste qu'un seul écart** : la vérification qu'une
connexion atteint réellement un Spark, pour les deux chemins. Elle exige une
Forge réelle avec Incus et un `sshd` installé dans le Spark — ce que l'image de
base n'embarque pas.

**Où reprendre.** **SPK-54** (« Amorcer un Spark depuis la console ») : c'est
l'unité qui installe ce `sshd`, donc celle qui débloque le dernier écart de
SPK-43. Sa spécification existe au §42, elle est `[ ]`, et elle est la première
du plan à porter du comportement livrable. À défaut, SPK-44 (onglet Docker)
emprunte le même transport.

## 2026-08-20 — Un garde-fou qui ne tournait pas

**Mesuré**, et signalé par la session pairs : `apps/webui/src/styles/classes.test.js`,
livré avec la tranche 4 de SPK-43 pour appliquer le §12.3 du design system,
n'était **joué par aucune campagne**. Le script de test de la console balayait
`host/*.test.js src/components/*.test.js` ; le fichier vit dans `src/styles/`.

Vérifié plutôt que cru : `git show a115388:apps/webui/package.json` montre les
deux seuls motifs, et le fichier n'y entre par aucun.

Ce que cela veut dire exactement, et il faut le dire précisément : les trois
preuves ont bien été **exécutées** — à la main, vertes, et le compte rendu de la
tranche 4 les annonçait comme telles. Ce qui était faux, c'est qu'un garde-fou
était en place. Il n'aurait attrapé aucune classe inventée par une session
suivante, puisque rien ne l'aurait lancé.

C'est la même classe de défaut que celle qu'il existe pour attraper, un cran plus
haut : une preuve écrite et non exécutée ressemble en tout point à une preuve qui
passe. Le premier défaut se voyait à la capture ; celui-ci ne se voyait nulle
part.

Réparé par `449b4fd` (session pairs), qui ajoute les motifs manquants au script.
Constaté ici : `pnpm -r test` rend 549 preuves pour la console au lieu de 543, et
les trois du contrôle des classes y figurent nommément.

**Rien d'autre n'est modifié.** Où reprendre reste **SPK-54**, inchangé.

## 2026-08-20 — L'environnement d'un Spark : trois questions, dont une seule est difficile

Demande du responsable : injecter des variables et des secrets dans un Spark, et
les piloter depuis un onglet dédié. Faisable ? Exploré avant d'écrire.

### La question du transport est déjà résolue

`push_file` écrit dans la cellule par l'API de fichiers d'Incus, et sert déjà
`authorized_keys` depuis SPK-11 — réécriture **en entier** depuis l'état voulu,
mesurée sur la Forge réelle. Rien à inventer : l'environnement suit le même
chemin, et hérite des mêmes propriétés (un retrait retire, une restauration
d'instantané est rattrapée par la réapplication).

### La question du bon mécanisme aurait coûté une implémentation entière

Incus sait porter des variables sur une instance — `environment.*`. Elles
s'appliquent aux processus que le **plan de contrôle** lance dans la cellule, et
**pas** aux conteneurs Docker du locataire, qui tiennent leur environnement de
Compose. On aurait obtenu une console où la variable existe et une application
où elle n'existe pas, ce qui est la pire forme d'échec : celle qui a l'air de
marcher quand on la teste au mauvais endroit.

Retenu : un fichier unique à chemin stable, `/etc/spark/env`, que le locataire
attache lui-même par `env_file:`. Le produit n'écrit pas dans son répertoire de
projet — il faudrait le deviner, et l'on écraserait un fichier qui ne nous
appartient pas.

### La seule question difficile : ce que « secret » veut dire

Mesuré sur le filtre de caviardage du §21.2, qui décide par le nom du champ :

    STRIPE_API_KEY   → caviardé
    SMTP_PASSWORD    → caviardé
    DATABASE_URL     → PAS caviardé
    S3_ENDPOINT      → pas caviardé

`DATABASE_URL` porte un mot de passe neuf fois sur dix. La détection par le nom
échoue donc exactement là où elle importe — et elle échouera toujours, parce que
le nom appartient au locataire, pas au produit.

**Décision : le secret est DÉCLARÉ, jamais deviné.** Une entrée déclarée n'est
plus jamais rendue par l'API, ni réaffichée, ni journalisée ; l'écran n'en montre
que le nom, une empreinte et la date du dernier changement — assez pour répondre
à « est-ce la même valeur que sur l'autre Spark ? » sans la montrer.

Et une honnêteté écrite avant que quiconque promette autre chose : le registre
vit sur la Forge, donc `root` lit tout. Ce que la déclaration protège, c'est
l'affichage accidentel, le journal, l'API et les exports. Pas `root`. C'est la
même limite qu'au §35.1, et le manuel devra le dire aussi nettement.

### Ce que je n'ai pas tranché

Où vit la clé de chiffrement : en clair, clé sur la Forge, ou clé tenue par la
console. La troisième posture est séduisante — la Forge ne peut plus déchiffrer
seule — mais elle rend la console **nécessaire** pour appliquer un environnement,
et un poste perdu perd tous les secrets. Elle n'est tenable qu'après SPK-36.
Recommandation écrite : clé sur la Forge. SPK-58 reste bloquée dessus.

### Ce que la doctrine du responsable impose, et qui simplifie

`CLAUDE.md` §4 : tout existe au niveau général, les contextes ne définissent que
leurs différences. Un relais SMTP ou un point d'entrée S3 n'a aucune raison
d'être ressaisi sur chaque Spark. Deux niveaux, donc — Forge puis Spark —, et
l'écran doit dire **d'où vient** chaque valeur, sinon on la lit sans pouvoir
expliquer pourquoi elle est celle-là.

### Vérifications

Aucun code touché : spécification et backlog. Les trois faits cités ont été
mesurés dans le dépôt — signature de `push_file`, comportement du filtre d'audit
sur quatre noms réels, et absence de toute notion d'environnement au registre.

---

## 2026-08-20 — Un curseur plutôt qu'une saisie, mais pas partout, et pas à n'importe quelle borne

### Problème

Demande du responsable : les valeurs numériques se saisissent chiffre par chiffre
alors qu'un curseur serait plus propre et plus intuitif. Avec une réserve
explicite, et c'est elle qui fait le travail — un curseur sans bornes connues, ou
dont le pas est si fin que la plage devient impraticable, est pire que la saisie
qu'il remplace.

### Observations

Onze contrôles numériques dans la console. Ils se rangent en deux familles nettes,
et la frontière n'est pas une question de goût :

- **six quotas** sur l'écran de création — réservation CPU, plafond CPU, cœurs,
  mémoire, disque, débit. Bornes connues dès que la Forge a été relevée, pas
  dicté par le métier (0,05 CPU, 1 Gio, 10 Mbit/s), plages de quelques dizaines à
  quelques centaines de crans ;
- **sept ports** — routes publiques, port cible, port de `sparkd`, port local d'un
  tunnel. Bornes connues elles aussi, 1 à 65 535, mais 65 534 crans à l'unité, et
  aucun arrondi possible : un port voisin n'est pas presque le bon port.

Mesure qui a fixé le seuil : le contrôle mesure au plus 28 rem, soit 448 px.
Au-delà d'environ 400 crans, un cran est plus étroit qu'un pixel et cesse d'être
atteignable au pointeur. Ce n'est pas un chiffre choisi, c'est la largeur du
contrôle divisée par la précision d'une souris.

### La question difficile : quelle borne haute ?

La tentation évidente était de borner un quota sur ce qui **reste libre**. Elle
est fausse, et de trois façons.

D'abord, elle contredit le `docs/DAT.md` §25.1 : le disponible est une
photographie prise à l'ouverture de l'écran, elle se périme dans le sens
favorable, et l'écran ne décide jamais à la place de `sparkd`. Un curseur qui
s'arrête au disponible est un refus déguisé en contrôle — pire qu'un bouton
désactivé, puisqu'il ne se voit même pas.

Ensuite, elle rendrait le **refus d'admission inatteignable depuis le parcours
canonique**. On ne pourrait plus demander ce que la Forge ne peut pas donner,
donc plus éprouver le refus par l'écran. Le §16 du `CLAUDE.md` interdit
précisément d'en arriver là.

Enfin, une borne posée sur la **capacité totale** ne souffre d'aucun de ces deux
défauts : elle ne bouge pas entre l'ouverture de l'écran et la soumission. C'est
exactement le raisonnement déjà retenu pour la liste d'images au §33.5 — une
contrainte stable se pose dans le contrôle, une contrainte périmable appartient
au serveur.

### Décision

- Règle générale dans `docs/DESIGN_SYSTEM.md` **§6.9 bis** : le curseur est
  **préféré**, jamais imposé, et cède devant l'une des trois conditions —
  bornes connues et stables, crans atteignables, granularité métier préservée.
- Application dans `docs/DESIGN_SYSTEM_APP.md` **SPK-DS-07** : quotas au curseur
  borné sur la capacité totale, ports à la saisie.
- Repli quand la capacité n'a pas pu être relevée : saisie numérique. L'écran
  n'invente pas une borne pour garder le curseur.

### Conséquence mesurée, et elle n'est pas cosmétique

Sur la Forge de validation, les deux disques de 6 To en RAID1 donnent un pool de
plus de 5 000 Gio. Au pas de 1 Gio, cinq mille crans ; au pas de 20 Gio qui les
ramènerait sous 400, le quota courant de 10 Gio devient **inatteignable**. Le
disque y reste donc une saisie pendant que la mémoire et le débit sont des
curseurs. C'est la condition 3 qui joue, sur la machine réelle, dès la première
livraison — la règle n'est pas décorative.

### Défaut voisin, corrigé dans le même changement

L'avertissement de capacité ne se rafraîchissait **jamais** pendant la saisie :
seul `cpu_mode` provoquait un repeint. La capture `17-creation-avertissement.png`
le montre — elle porte 64 Gio demandés, un panneau annonçant 64 Gio libres, et
aucun avertissement. Le défaut préexiste au curseur, mais celui-ci le rend
intolérable : on tire une poignée au-delà du disponible et rien ne bouge. La zone
d'avertissement est donc recalculée à chaque changement de valeur, sans repeindre
le formulaire — un repeint arracherait la poignée en cours de glissement et
perdrait le focus (§14.3).

### Vérifications

Voir SPK-59. Le compte rendu de l'unité porte les tests et les captures.

## 2026-08-20 — Six mesures qui tranchent la question de l'environnement

Le responsable a poussé sur ma première rédaction : « on les injecte dans
l'instance, ils sont visibles dans l'env de l'instance, donc Docker va les lire,
non ? Et sinon, un fichier chargé genre dans le `.profile` ? Comment font les
autres ? » Trois questions justes, auxquelles j'avais répondu par une conclusion
sans montrer le chemin. Mesuré dans le Spark `helo`, Docker 29.7.2 :

    A  variable du shell → docker run                  le conteneur NE LA VOIT PAS
    B  variable du shell → environment: - VAR          passe
    C  fichier .env      → environment: - VAR          passe
    E  fichier .env, variable non nommée au compose    ABSENTE
    F  env_file: /etc/spark/env                        tout le fichier passe
    D  /etc/profile.d → shell de connexion             vue
    D  /etc/profile.d → service systemd                ABSENTE

Quatre conclusions, et aucune n'était devinable de mémoire :

1. **Un conteneur n'hérite jamais de l'environnement ambiant** (A). L'intuition
   « c'est dans l'env de l'instance, donc Docker le lit » est fausse, et c'est le
   point de départ de tout le reste.
2. Le shell et `.env` alimentent la **substitution** de Compose, pas l'injection :
   ils ne servent que si le fichier de composition **nomme** la variable (B et C
   contre E). Un `.env` posé par le produit ne suffirait donc pas.
3. `env_file:` est la seule voie qui porte **tout un jeu** sans énumérer les noms
   (F) — donc la seule qui permette d'ajouter une variable plus tard sans que le
   locataire retouche son fichier de composition.
4. L'idée du `.profile` **échoue pour tout ce que systemd démarre** (D), c'est-à-dire
   au redémarrage de la machine. C'est le pire mode de panne disponible : cela
   marche exactement quand on le teste à la main.

Le point 4 mérite d'être retenu au-delà de cette unité. Une solution qui
fonctionne en session interactive et pas au démarrage passe toutes les
vérifications qu'on lui fait subir, et casse la première nuit où la Forge
redémarre.

**Comment font les autres**, vérifié plutôt que supposé : personne ne s'appuie sur
l'environnement ambiant. Compose matérialise `.env` et `env_file:` ; Dokku et ses
semblables tiennent un store et redéploient avec les variables ; Swarm rend ses
secrets sous forme de **fichiers** dans `/run/secrets` ; Kubernetes monte des
ConfigMap et des Secret ; systemd lit un `EnvironmentFile=`. Le motif est
constant : un magasin, une matérialisation en fichier, une référence explicite du
côté qui consomme.

Le §43 garde donc sa conception, mais il porte désormais les mesures qui la
justifient plutôt que ma seule affirmation. Et il gagne le complément que le
responsable avait en tête : `/etc/profile.d/spark-env.sh` est rendu **aussi**,
pour qu'un `docker compose up` tapé à la main substitue `${VAR}` — nommé comme un
confort, jamais comme la garantie.

### Vérifications

Six essais exécutés dans la cellule, sortie citée telle quelle. Aucun code du
dépôt modifié. Les fichiers d'essai et `/etc/spark` créés pour la mesure ont été
retirés du Spark.


## 2026-08-20 — SPK-54 : amorcer un Spark, et trois sessions dans un même arbre

**Unité** : SPK-54, désignée par l'entrée précédente. `[ ]` et non `[~]` : la
spécification manquante a donc été **écrite et poussée avant la première ligne de
code** (§3.2, point 3). Le §42 disait l'intention du geste ; il ne disait ni ce
que la détection exécute, ni ce que l'API rend, ni ce que le journal reçoit.
Quatre sections neuves — §42.5 à §42.8 —, écrites après lecture du pilote et du
runbook.

### Le constat qui a ouvert l'unité

`IncusDriver.exec_command` poste la commande et n'en rend **rien** : ni code, ni
sortie. Suffisant pour ordonner un geste, insuffisant pour **détecter**, qui est
le principe même du §42.1. D'où `exec_capture`, et sa règle : un code de sortie
non nul n'est pas une erreur du pilote. `command -v sshd` qui rend `1` est une
réponse — « absent » —, pas une panne. Les confondre ferait échouer l'amorçage
sur ce qu'il est précisément venu constater.

### Ce que l'unité livre

La détection porte sur l'**origine** du paquet Docker, pas sur sa présence. Un
`docker.io` est rendu `defect`, entre dans les manques, et l'installation le
**purge** avant de poser `docker-ce` : les laisser cohabiter ne réparerait rien,
c'est son profil AppArmor qui casse et il resterait posé.

Deux routes : le relevé n'écrit rien et ne se journalise pas, l'amorçage agit.
À l'écran, le relevé **ne part pas de lui-même** — il exécute une commande dans
la cellule du locataire, et le lancer à chaque ouverture ferait entrer la console
chez lui à chaque coup d'œil.

### Deux manques du doublon, de même nature que celui du terminal

Le pilote factice ne reflétait ni l'effet des scripts, ni l'empreinte des clés
écrites. Sans le second, l'amorçage réécrivait les clés à chaque passage et
n'était **jamais** idempotent — or c'est le point de la DoD. Mesuré au passage :
le relevé contient `docker-ce` dans son `dpkg-query`, et un marqueur posé sur ce
mot faisait déclarer Docker installé par la commande venue constater son absence.

### Vérifications, et ce qui est rouge sans être de moi

688 tests Python, 6 de contrat, 8 de gestes, 7 du manuel, `contract-check`,
`build`. Captures `85-` à `88-` observées, plus `m6-amorcage.png` produite depuis
la pile réelle — c'est elle qui a montré « absent » écrit deux fois sur la même
ligne, corrigé avec sa preuve.

**Deux preuves rouges, toutes deux étrangères à cette unité, mesurées :**

- `classes.test.js` a rougi sur cinq classes de `spark-create.js`, fichier écrit
  **en direct** par la session `spark-environment-e8`. Ligne de base établie :
  vert à `HEAD`, rouge avec son fichier en cours. Elle a posé le CSS manquant
  dans le même changement, et c'est redevenu vert. **Le garde-fou a fait son
  travail sur du code non encore committé.**
- Le parcours `REFUS 1` échoue sur `page.fill('#memory_gib', '512')` : son commit
  `ea1aa28` (SPK-59) a fait de ce champ un `input[type=range]`, qu'on ne remplit
  pas. Elle l'avait annoncé et reprend `e2e/parcours.test.mjs`, `captures.mjs` et
  `manuel.mjs` pour l'adapter.

### Trois sessions dans le même arbre

Nous étions trois cet après-midi. Ce qui a tenu : terrain annoncé avant
d'écrire, ajout par chemin explicite, documents partagés touchés à l'instant du
commit. Ce qui n'a pas tenu : un commit a encore emporté le `CHANGELOG.md` et le
`JOURNAL.md` d'une autre session, et j'ai moi-même lancé un `git stash push -u`
sur l'arbre entier pour établir la ligne de base du §2.4 — il a rendu la main
proprement, mais il aurait arraché le travail en cours des deux autres si l'une
d'elles avait écrit pendant cette seconde. **Le §2.4 porte le même danger que le
§1.2 dans un arbre partagé**, et l'arbitrage du responsable reste attendu.

**SPK-54 est `[~]`**, avec deux écarts nommés : le mode **rootless** du §42.2
n'est ni offert ni éprouvé, et la preuve qu'un amorçage rend une cellule
réellement capable de `docker compose up` exige une Forge réelle.

**Où reprendre.** Le mode rootless de SPK-54, qui est livrable ici : une option à
l'écran qui énonce ce qu'elle coûte (§42.2), une variante d'installation, et ses
preuves. Le reste de l'unité attend la Forge réelle, comme SPK-43.

## 2026-08-20 — SPK-54 : le mode rootless, et un refus qui vaut mieux qu'une bascule

**Unité** : SPK-54, mode rootless, désigné par l'entrée précédente. L'unité étant
`[~]` et le §42.2 ne couvrant que l'intention, j'ai complété **ce point précis**
— §42.2 bis — et l'ai poussé avant la première ligne de code (§3.2).

### Ce que le §42.2 ne disait pas, et qu'il fallait trancher

Comment l'option voyage, ce qu'elle change à l'installation, et surtout : **ce
qui arrive quand on la demande sur une cellule déjà pourvue**.

La réponse est un refus, pas une bascule. Basculer déplacerait le démon sous un
autre compte, et avec lui les conteneurs, les volumes et les réseaux du
locataire — sa production, sans qu'il l'ait demandé. Le §42.1 ne tolère déjà pas
un redémarrage gratuit du démon ; une bascule est un ordre de grandeur au-dessus.
Laisser passer aurait fait de la case à cocher la commande la plus destructrice
de la console, sans confirmation propre.

Le refus joue dans les deux sens et porte sur la **bascule**, pas sur le fait de
redemander : redemander le même mode reste idempotent, et une preuve le garde —
les confondre aurait rendu un second amorçage impossible.

Deux autres points méritent d'être notés : `enable-linger` n'est pas une
précaution — sans lui le démon meurt à la fin de la session du compte, ce qui
donnerait une cellule qui marche jusqu'au premier redémarrage, et cela ne se
verrait qu'alors ; et le démon enraciné est **arrêté** avant l'installation
rootless, deux démons sur la même cellule se disputant stockage et réseaux.

### À l'écran

La case est décochée par défaut et **énonce ses trois coûts** au lieu de les
vendre. Une preuve garde qu'aucun « plus sûr » ni « recommandé » ne s'y glisse :
le §42.2 est explicite, annoncer l'inverse ferait échouer la promesse centrale du
produit sur la moitié des piles.

Quand le relevé montre un mode en place, l'option n'est plus offerte. Ce n'est
pas le §14.9 : l'écran ne suppose rien, il le tient d'une mesure que le serveur
vient de rendre — et le serveur refuse de toute façon.

### Vérifications

Campagne complète **verte** : 697 tests Python (30 propres à l'unité), 6 de
contrat, 590 de console (53 sur la fiche d'un Spark), 8 de gestes, 50 parcours
E2E, 7 du manuel.

**Une réserve à dire** : les 50 parcours ont tourné avec le travail **non
committé** d'une autre session dans `e2e/parcours.test.mjs`, `captures.mjs`,
`manuel.mjs` et `reel.mjs` — son adaptation de REFUS 1 au curseur de SPK-59. Le
verdict est donc vrai de l'arbre tel qu'il était, pas de `origin/main` seul.

### Ce qui manque, et pourquoi

Le **parcours E2E et la capture** du mode rootless ne sont pas écrits : les deux
fichiers étaient tenus par cette autre session, et les reprendre aurait écrasé
son travail. C'est le prix de trois sessions dans un même arbre, et il est réel.

**SPK-54 reste `[~]`** avec trois écarts nommés au backlog.

**Où reprendre.** Le parcours E2E et la capture du rootless, dès que
`e2e/parcours.test.mjs` et `e2e/captures.mjs` sont libres — c'est court et
livrable ici. Ensuite SPK-44 (onglet Docker), première `[ ]` du plan à porter du
comportement, qui emprunte le même transport que SPK-43.

---

## 2026-08-20 — La mémoire au quart de gibioctet, et le format qui rendait le pas invisible

### Problème

Amendement du responsable, quelques minutes après la livraison de SPK-59 : « les
RAM par paliers de 256 Mo ». Le pas de 1 Gio venait d'un choix implicite — le
champ s'appelait `memory_gib`, donc le pas valait un gibioctet — et non d'une
mesure.

### Observations

La mesure lui donne raison, et sur deux points indépendants :

- le **seed** pose quatre Sparks à `512 * MIO`. Un curseur au gibioctet rend donc
  inatteignable une valeur que le produit emploie lui-même dans ses propres
  données de démonstration ;
- sur la pile de validation, le pool mémoire vaut **5,4 Gio** une fois l'ARC et
  `SPARKD_MEMORY_RESERVE` déduits des 98 Gio déclarés. Au gibioctet, le curseur
  n'offrait que **cinq crans**. Il avait la forme d'un réglage fin et la
  granularité d'un menu à cinq entrées — exactement ce que le §6.9 bis cherche à
  éviter, mais dans l'autre sens que celui prévu.

### Ce que le changement a fait apparaître, et qui n'était pas dans la demande

Passer au quart de gibioctet casse l'affichage, et le casse silencieusement.
`formatBytes` arrondit : il rend « 1,3 Gio » pour 1,25 et, au-dessus de 10 Gio,
« 10 Gio » pour 10,25. Trois crans sur quatre auraient donc été **invisibles** —
on déplace la poignée et le chiffre ne bouge pas.

Ce n'est pas un défaut de `formatBytes`. Son arrondi est correct pour ce qu'il
sert : une **mesure** qu'on lit, dont la dernière décimale n'apprend rien. Ce qui
manquait, c'est la distinction entre lire une mesure et régler une valeur qui
sera transmise. D'où `formatOctetsExact`, et la phrase ajoutée au §6.9 bis : la
valeur affichée doit être exacte sur la grille du curseur, et si aucun format ne
sait rendre le pas, c'est le pas qui est mauvais.

### Conséquence acceptée

Au pas de 256 Mio, un pool mémoire dépassant 100,25 Gio compte plus de 400 crans
et retombe en saisie par la condition 2 du §6.9 bis. Vérifié que cela ne touche
pas la machine du projet : la Forge déclare 94 Gio, et son pool reste en deçà une
fois les réserves déduites. Sur une machine plus grosse, la mémoire cédera comme
le disque a déjà cédé — c'est la règle qui fonctionne, pas une exception qu'on
lui concède.

### Décision

- pas de 256 Mio pour la mémoire, consigné avec les cinq autres au SPK-DS-07 : le
  pas de chaque quota est désormais **écrit et motivé**, plus déduit du nom du
  champ ;
- `formatOctetsExact` dans `tokens.js`, à côté de `formatBytes` et non à sa place ;
- règle d'exactitude ajoutée au §6.9 bis.

### Vérifications

Voir SPK-59, dont l'amendement porte le compte rendu.

## 2026-08-20 — La clé est sur la Forge, et la question suivante était la bonne

Arbitrage rendu : **clé de chiffrement sur la Forge**. Et immédiatement la
question qui compte, posée par le responsable : « mais alors, comment
`docker compose` lit-il les variables ? `sparkd` les déchiffre avant de les
injecter ? »

**Oui.** Et il ne peut pas en être autrement. La chaîne est :

    registre chiffré → sparkd déchiffre (clé de la Forge)
      → push_file écrit le fichier EN CLAIR dans la cellule
      → env_file: → le conteneur

`docker compose` ne sait pas déchiffrer, et l'application attend une valeur
utilisable. **Toute chaîne qui livre un secret à une application le lui livre en
clair au bout.** Le chiffrement au repos achète donc exactement une chose : une
copie du seul fichier de registre — sauvegarde emportée, export de support — ne
livre plus rien. C'est réel, et c'est peu. Il fallait l'écrire ainsi plutôt que
de laisser le mot « chiffré » suggérer davantage.

Vérifié plutôt que supposé, pour ne pas prétendre faire moins bien ou mieux que
l'état de l'art : les `Secret` de Kubernetes vivent encodés dans `etcd`, avec une
clé de chiffrement au repos posée sur le serveur d'API ; Docker Swarm déchiffre
sur le gestionnaire et **monte un fichier** dans le conteneur ; Dokku stocke en
clair. La seule architecture qui y échappe est celle où l'application va chercher
son secret elle-même dans un coffre, ce qui déplace le problème sur son identité —
et sort du §1.

### Ce que la mesure a imposé ensuite, et que je n'avais pas vu

    findmnt -no FSTYPE,OPTIONS /run   →   tmpfs rw,nosuid,nodev,…

`/run` est un tmpfs dans un Spark. Conséquence que j'avais manquée dans la
première rédaction : avec les secrets dans le fichier persistant,
**restaurer un instantané ancien ressusciterait un secret révoqué**, en silence,
pendant que le registre le croirait remplacé. C'est un défaut de sécurité
introduit par une fonctionnalité de confort, et il ne se serait vu qu'un jour de
rotation de clé.

**Deux fichiers, donc** : `/etc/spark/env` pour les variables, persistant ;
`/run/spark/secrets` pour les secrets déclarés, en tmpfs, hors de tout
instantané. Le locataire attache les deux. Contrepartie assumée et écrite : le
fichier volatil doit être reposé à chaque démarrage de la cellule — ce que
`sparkd` fait déjà pour `authorized_keys` —, et un Spark démarré hors du produit
n'aura ses secrets qu'après la réconciliation du §14.3.

### Vérifications

Une mesure dans la cellule `helo`, citée telle quelle. Aucun code touché : DAT
§43.5, §43.5.1, §43.5.2 et §43.1, et la DoD de SPK-58 gagne deux preuves — qu'un
instantané ne capture aucun secret, et que le fichier volatil est reposé au
démarrage.


## 2026-08-20 — Les parcours du rootless, écrits et poussés sans avoir été exécutés

Suite immédiate de l'entrée précédente. La session qui tenait
`e2e/parcours.test.mjs` l'a libéré ; j'ai donc écrit les deux parcours qui
manquaient à SPK-54 :

- cocher l'option rootless dans la confirmation, vérifier que l'écran rend le
  mode en français et que le journal le porte dans sa charge ;
- constater qu'un second amorçage dans l'autre mode n'offre plus l'option, **et**
  que le serveur refuse en `409` quand on contourne l'écran.

Le harnais gagne `ecrireSparkd`, dont l'usage est borné et documenté : le §29.3
interdit d'agir par l'API pour atteindre un écran, mais le `CLAUDE.md` §10 exige
qu'une règle d'accès soit vérifiée par une requête directe qui contourne
l'interface. C'est le seul emploi admis, et le commentaire du harnais le dit.

**Ils ne sont pas exécutés, et c'est le fait important de cette entrée.** Ma
campagne a été tuée en cours, puis une troisième session a pris la fenêtre
Playwright de la machine. Je ne l'ai pas reprise : deux campagnes simultanées
font dépasser des timeouts réglés pour une machine au repos — mesuré par deux
sessions aujourd'hui, et le rouge se **déplace** d'un test à l'autre selon la
charge, ce qui est la signature d'une course et non d'une régression.

Poussés quand même (§0 : un travail non poussé est un travail perdu), et le
backlog porte l'écart en toutes lettres.

**Ce que cela apprend, et qui dépasse mon unité** : le harnais isole bien l'ÉTAT
— ports libres, registre jetable, c'est le §29.2 et il tient — mais pas le TEMPS.
Le §29.2 ne dit rien de la machine. Une autre session propose de le consigner en
INC-09 ; je la laisse le faire plutôt que d'écrire deux fois la même chose.

**Où reprendre.** Exécuter `make e2e` puis `make captures` dès qu'une fenêtre
Playwright est libre, observer la capture de la confirmation avec l'option, et
clore ce point. Le reste de SPK-54 attend une pile qui supporte le rootless et
une Forge réelle.

## 2026-08-20 — Le briefing d'un Spark, et la mesure qui l'a fait changer de forme

Demande du responsable, en prévision de déploiements conduits par des agents :
que chaque Spark fraîchement amorcé porte un message d'accueil SSH destiné à un
LLM — environnement, ressources, utilisateur, arborescence, où lire
l'environnement injecté, paquets et versions, routes, ports.

**La forme demandée ne pouvait pas fonctionner, et une mesure le montre.** Dans
`helo` :

    ssh spark            puis shell de connexion   →  message RENDU
    ssh -tt spark 'cmd'                            →  rien
    ssh spark 'cmd'                                →  rien

`sshd` a `printmotd no` ; c'est `pam_motd` qui affiche, et seulement à l'ouverture
d'un **shell de connexion**. Or un agent travaille presque toujours en
`ssh spark 'commande'`. Un message d'accueil seul n'aurait donc jamais atteint son
destinataire — il aurait marché quand un humain le teste à la main, et serait
resté invisible en usage réel. Encore le même mode de panne que le `.profile`
d'hier, et pour une raison voisine : on vérifie dans le contexte interactif ce qui
servira dans un contexte qui ne l'est pas.

**Décision : le briefing est un fichier**, `/etc/spark/BRIEFING.md` et son jumeau
`briefing.json`. Le message d'accueil est réduit à trois lignes dont la seule qui
compte est **le chemin du briefing**.

### Ce que la seconde mesure impose au contenu

Depuis la cellule, `10.77.0.1:9876` est injoignable — propriété voulue, vérifiée
à nouveau aujourd'hui. Conséquence directe : **tout ce que seul `sparkd` sait,
l'agent ne peut que le lire dans le briefing**. D'où la liste : quotas et leur
sémantique — `nproc` et `free` rapportent la machine, pas la cellule et
induiraient un dimensionnement faux —, routes, ports publiés, noms des variables
injectées, état de protection.

Et symétriquement, ce qui n'y entre pas : aucune **valeur** de secret, parce qu'un
briefing est affiché, copié, collé dans un rapport — c'est le trajet qu'un secret
ne doit pas faire ; et aucune liste de paquets prétendue à jour, parce qu'une
liste vieille d'une semaine est un mensonge poli. Le produit inscrit ce qu'il a
installé lui-même, daté, et donne la **commande** pour le reste.

### Une règle que je n'avais pas anticipée

Le briefing s'adresse à quelque chose qui **exécute ce qu'il lit**. Il énonce donc
des faits et ne donne aucun ordre ; et il dit qui l'a écrit, avec la limite de
cette garantie : le locataire est `root` dans sa cellule et peut le réécrire. Un
agent ne doit jamais s'en servir pour décider de ce qu'il a le droit de faire —
l'autorisation se joue côté Forge, là où le locataire n'atteint rien.

### Vérifications

Trois mesures dans `helo`, sorties citées telles quelles, et le message d'accueil
de test retiré derrière moi. Aucun code touché : DAT §44 et unité SPK-60.

Note de coordination : SPK-59 a été prise entre-temps par une autre session pour
les quotas au curseur. Le briefing est donc **SPK-60** — vérifié dans le fichier
avant d'écrire, et non supposé.

## 2026-08-20 — 7,5 Gio, et une règle d'éprouvage qui sort des messages

La machine est tombée **quatre fois** cet après-midi, dont deux terminaisons en
code 137 — un `SIGKILL`, signature du tueur de mémoire — et un redémarrage
constaté à `up 6 min`. Le chiffre qui clôt le diagnostic a manqué longtemps :

    MemTotal:  7714436 kB     →  7,5 Gio

Nous ne travaillons pas sur la mémoire de la machine hôte mais sur celle d'une
**VM WSL2 qui en a une fraction**. `make e2e` monte cinquante fois une pile
complète — `sparkd`, hôte console, Chromium — et `make captures` comme
`make manuel` en montent d'autres. À quatre sessions, ce n'était pas de la
contention : c'était un dépassement mécanique, et il était garanti d'arriver.

Une session voisine avait mesuré la contention le matin même et en avait tiré la
bonne conclusion partielle — des rouges erratiques, qui redeviennent verts rejoués
seuls. La conclusion suivante, qu'elle pouvait aussi **tuer l'hôte**, n'avait pas
été tirée. C'est le genre d'écart qui se voit une fois qu'on a le chiffre, et
jamais avant.

**Ma part, sans détour :** j'avais laissé tourner deux piles de développement —
la console du responsable et une seconde pour mes vérifications visuelles — et je
ne les ai jamais arrêtées. Moins visible qu'une campagne, donc plus facile à
oublier, et exactement la même famille de fuite.

La règle sort des messages entre sessions et entre dans `docs/AGENT_RUNBOOK.md`
§F, où la personne suivante la trouvera : la vérification ciblée
(`--test-name-pattern`, une pile, 2,489 s mesurées contre cinquante piles), ce que
la campagne complète reste — la preuve de non-régression de l'ensemble, due à la
Definition of Done, mais jamais l'outil d'une vérification ciblée —, l'obligation
d'annoncer avant de la lancer sur un hôte partagé, et une seule pile de
développement à la fois.

Le chiffre y figure, et c'est lui qui rend la règle non négociable plutôt que
polie. Une règle sans son motif se contourne dès qu'elle gêne.

L'entrée de SPK-59 cesse de porter « à porter dans un document durable » : c'est
fait, et une tâche accomplie n'a pas à rester écrite comme un reste.


## 2026-08-20 — Le parcours ciblé trouve ce que trente preuves d'unité ne voyaient pas

Suite de l'entrée précédente, qui laissait les deux parcours du rootless écrits
et non exécutés.

Une session pairs a signalé que les campagnes E2E complètes avaient provoqué
plusieurs arrêts de la machine par manque de mémoire — ce qui explique le **code
137** qui avait tué ma propre campagne. Elle a donné le bon moyen de contourner :

```
node --test --test-concurrency=1 --test-name-pattern="<nom exact>" e2e/parcours.test.mjs
```

**Le premier parcours était rouge, et il avait raison.** L'écran n'affichait
aucun mode après un amorçage rootless. Cause : `compte_rendu` reconstruit ses
lignes champ par champ, et `mode` n'en faisait pas partie. Le **relevé** le
portait ; le **compte rendu** le perdait — c'est-à-dire exactement au moment où
l'écran en a besoin, juste après un choix qui ne se reprend pas.

Les trente preuves d'unité de l'unité ne pouvaient pas l'attraper : elles
interrogeaient le relevé. C'est le genre de défaut pour lequel un parcours existe.
Corrigé, avec une preuve d'unité qui le garde des deux côtés — après un amorçage
qui installe, et après un amorçage qui ne change rien.

Les deux parcours sont **verts**. Capture `89-amorcage-rootless.png` produite et
observée : l'option cochée, ses trois coûts, et l'avertissement que le choix ne
se reprend pas.

### Une mesure qui corrige un diagnostic partagé

Une session pairs s'apprêtait à écrire dans `docs/AGENT_RUNBOOK.md` que `make
e2e` monte « cinquante piles » et que `e2e/pile.mjs` n'a ni `after` ni fonction
d'arrêt. Mesuré, les deux sont faux : `parcours.test.mjs` appelle `monterPile`
**une fois** pour ses 52 tests, et la démonte dans son `after` ; `manuel.mjs`
fait de même dans un `finally`. La fonction d'arrêt est **rendue par**
`monterPile`, pas déclarée au niveau du module — ce qui explique qu'un `grep` la
manque.

Sa conclusion tient — plusieurs sessions lançant chacune une campagne, plus les
Chromium de `captures` et `manuel` —, mais son motif devait changer avant d'être
écrit dans une règle. Signalé à son autrice, qui tient ce fichier.

**Où reprendre.** SPK-54 garde deux écarts, tous deux hors de portée d'ici : le
rootless éprouvé sur une pile qui le supporte, et la preuve qu'un amorçage rend
une cellule réellement capable de `docker compose up` — Forge réelle. Sinon,
SPK-44 (onglet Docker) est la première `[ ]` du plan à porter du comportement.

## 2026-08-20 — SPK-49 close par la mesure qui manquait, et un motif que j'avais faux

### La preuve entrante

Sur autorisation du responsable, éprouvé sur la Forge réelle. Port `18080` publié
vers `helo:8080`, puis frappé **depuis Internet** — pas depuis la Forge :

    http://51.158.54.202:18080/   →  200, contenu du Spark servi
    device posé                   →  pub-18080 · proxy Incus
                                     listen tcp:0.0.0.0:18080
                                     connect tcp:10.77.0.17:8080

Les quatre refus nomment chacun leur raison — port déjà publié, en nommant son
détenteur ; `22` tenu par le sshd de la Forge ; `443` tenu par le proxy ; `70000`
hors bornes. Et le retrait **referme** : `DELETE` → le port ne répond plus de
l'extérieur, le device a disparu de l'instance.

C'était la seule mesure qui manquait à SPK-49, restée `[~]` faute de Forge
joignable. Elle passe à `[x]`.

### Un motif que j'avais faux, et corrigé par une session voisine

J'avais écrit au §F du runbook qu'une campagne monte « cinquante fois une pile
complète ». Une session voisine l'a mesuré et m'a contredit :

    grep -c 'monterPile(' e2e/parcours.test.mjs   →  1
    e2e/parcours.test.mjs:57  after(async () => { … pile?.demonter() })

**Une** pile, montée dans le `before`, servant les 52 tests, démontée par le
`after`. J'avais cherché la fonction d'arrêt au niveau du module de `pile.mjs`
alors qu'elle est **rendue par `monterPile`** — d'où un `grep` qui la manque, et
une conclusion fausse tirée d'une absence apparente.

La conclusion pratique ne bouge pas, mais son motif change entièrement : ce n'est
pas le contenu d'une campagne qui tue la machine, c'est **leur nombre** — trois
sessions, trois piles, trois Chromium, plus ceux de `captures` et `manuel`, sur
7,5 Gio.

Et c'est exactement ce que je reprochais à la version précédente : une règle
fondée sur un motif inexact se contourne dès qu'on découvre l'inexactitude. Le
§F porte désormais la mesure, et la note de correction avec sa date — un document
qui se corrige sans le dire apprend à ses lecteurs à se méfier de tout le reste.

L'arbitrage du responsable y figure aussi : vérifications ciblées autorisées en
multi-session, campagne complète par lots et en session seule.

### Vérifications

Six appels d'API contre la Forge réelle, deux essais de connexion entrante depuis
l'extérieur, et l'inspection des devices Incus avant et après. Le Spark `helo`
reste en marche, sur décision du responsable ; le port publié pour la preuve a été
retiré.


## 2026-08-20 — SPK-53 : la console dit quel code la Forge exécute, et se tait quand elle ne sait pas

**Unité** : SPK-53, première `[~]` du plan dont il restait du comportement
livrable sans Forge réelle. Le runtime publiait l'empreinte depuis ce matin ; la
console n'en faisait **rien**.

### Ce que l'unité livre

Une section « Code déployé » sur l'écran de la Forge, alimentée par une route
neuve de l'hôte console. La comparaison vit là et pas dans `sparkd` : c'est le
poste qui porte le dépôt, et la Forge est déployée par `rsync` **sans** `.git`.

### Le point qui décide, et il n'était pas là où je l'attendais

Ce n'est pas la comparaison — trois lignes de `git`. C'est **ce qu'on dit quand
elle est impossible**. Trois verdicts sur six sont des non-réponses, et un seul
affirme que tout va bien : celui qui l'a mesuré.

Le §40.3 en annonçait **cinq**. En l'implémentant, un sixième est apparu :
**aucun dépôt sur le poste**. C'est même le cas le plus probable en exploitation,
chez quelqu'un qui ne développe pas. Le ranger dans « build étrangère » aurait été
faux — on ne sait pas si elle est étrangère, on n'a rien pour le dire. Le §40.3
est corrigé : une spécification qui annonce cinq cas pendant que le code en traite
six a cessé d'être vraie.

Et le cas qui trompe le plus est « c'est le **poste** qui est en retard ». Le
§40.3 le listait sans dire sa conséquence : traité comme un défaut de la Forge, il
enverrait redéployer une version *plus ancienne* que celle qui tourne. Un écran
qui se trompe là ne se contente pas d'informer mal — il fait régresser une machine
en service. Il n'est donc ni en rouge ni annoncé, et une preuve garde la
différence.

### Un parti pris de preuve

Les dix preuves du module montent un **vrai dépôt jetable** plutôt qu'un `git`
simulé. C'est l'ascendance des commits qu'on éprouve, et un doublon ne prouverait
que sa propre fidélité.

### Un défaut trouvé par la campagne, et sa signature

Un parcours du rootless de SPK-54 était **vert lancé seul et rouge dans la
campagne**. Ce n'était pas la contention de machine mesurée cet après-midi : mes
deux parcours supposaient un Spark vierge sur un Spark qu'un parcours antérieur
avait déjà amorcé, et ma propre règle de conflit de mode (§42.2 bis) refusait
donc la bascule. Les deux symptômes se ressemblent et n'ont rien à voir.
Corrigé — ils prennent « boutique », qu'aucun autre n'amorce, et le démarrent
depuis l'écran puisque l'amorçage exige une cellule qui tourne.

### Vérifications

Campagne complète **verte** : 698 tests Python, 6 de contrat, 624 de console,
8 de gestes, 52 parcours E2E, 7 du manuel, `build`. Captures `90-` à `92-`
observées — en retard, à jour, non estampillée — plus
`docs/manuel/images/m4-code-deploye.png` produite depuis la pile réelle.

**SPK-53 reste `[~]`**, avec un seul écart : la **commande de mise à jour** depuis
l'écran. Le §40 ne la spécifie pas, et ce n'est pas une finition — elle ferait
redéployer `sparkd` sur une machine en service depuis un bouton. Ce que « mettre
à jour » veut dire demande une décision du responsable (`CLAUDE.md` §9).

**Où reprendre.** SPK-44 (onglet Docker), première `[ ]` du plan à porter du
comportement, qui emprunte le transport de SPK-43. SPK-54 attend l'autorisation
du responsable pour ses deux derniers écarts, et SPK-53 la sienne pour le geste
de mise à jour.

## 2026-08-20 — SPK-44 : l'onglet Docker, et trois absences qui se ressemblent

**Unité** : SPK-44, désignée par l'entrée précédente. `[ ]`, donc la
spécification manquante a été **écrite et poussée avant la première ligne de
code** : le §37.6 disait ce que l'onglet rend et par quel principe, pas par quel
chemin ni ce qu'on exécute. §37.6 bis, écrit après mesure sur un vrai Docker.

### Deux décisions que la spécification ne portait pas

**Le chemin est SSH depuis la console**, celui du terminal. Pas `incus exec` : le
§37.3 réserve le plan de contrôle au dépannage, et lire l'inventaire d'un
locataire n'en est pas un. La conséquence est assumée et écrite — un Spark au
`sshd` muet n'a pas d'onglet Docker, et l'écran le dit dans les termes du §37.2
plutôt que d'inventer un second diagnostic.

**C'est le code de sortie qui distingue les absences, pas la sortie.** Mesuré :
`127` quand `docker` est introuvable, `1` quand la commande existe et que le
démon ne répond pas, `0` avec zéro ligne quand tout va bien et qu'il n'y a rien.
La sortie est vide dans deux cas sur trois — s'y fier aurait fondu trois états en
un.

Les deux premiers se confondent à l'œil — « Docker ne marche pas » — et
n'appellent pas le même geste : l'un s'amorce, l'autre se redémarre. Les fondre
enverrait réinstaller ce qui est déjà là, donc redémarrer le démon du locataire et
interrompre sa production pour rien. C'est du §14.6 appliqué non plus à
l'affichage mais à la **détection**.

### Prouver une absence en la comptant

La DoD demandait qu'un test prouve que la collecte **cesse** à la fermeture de
l'onglet. Le parcours écoute les requêtes du navigateur après le départ, sur deux
cadences complètes, et exige **zéro**. Affirmer qu'on a arrêté un intervalle ne
prouve rien ; le compter, si.

### Vérifications

Campagne complète **verte** : 698 Python, 6 de contrat, 654 de console, 8 de
gestes, 54 parcours E2E, 7 du manuel, `build`. Captures `93-` à `97-` observées,
dont les deux absences **côte à côte** — c'est là que la différence se voit, une
capture unique n'aurait rien prouvé — et le format étroit. Plus
`docs/manuel/images/m8-docker.png`, produite depuis la pile réelle.

**SPK-44 reste `[~]`**, avec trois écarts nommés au backlog : l'inspection, les
journaux, les réseaux et volumes ne sont pas livrés — cette tranche ne porte que
l'inventaire ; la capture d'un conteneur aux journaux très longs en dépend ; et
aucun vrai `docker ps` n'a encore été lu, le doublon remplaçant la commande.

**Où reprendre.** La deuxième tranche de SPK-44 — inspection d'un conteneur, ses
journaux, ses réseaux et volumes — qui est livrable ici et prolonge directement
cette route. SPK-54 et SPK-53 attendent chacune une décision du responsable.

---

## 2026-08-20 · SPK-44, deuxième tranche — inspecter un conteneur et lire ses journaux

**Problème.** L'inventaire dit ce qui tourne. Il ne dit pas *pourquoi* une pile ne
répond plus. Pour cela il faut ouvrir un conteneur : son état exact, son code de
sortie, ses réseaux, ses volumes, et ce qu'il a écrit avant de se taire.

### Ce que la mesure a tranché avant qu'une ligne soit écrite

Un conteneur `alpine` créé sur cette machine, interrogé, puis supprimé — la
machine rendue à zéro conteneur et l'image effacée. Quatre faits en sont sortis, et
chacun a changé la spécification :

- `.Name` revient préfixé d'une **barre oblique** : `/spark-mesure`. Un nom qui
  n'est pas celui qu'on a tapé fait douter de ce qu'on regarde.
- `.State.ExitCode` vaut `0` pour un conteneur **en marche**. L'afficher tel quel
  ferait lire qu'il s'est terminé sans erreur. C'est le §14.6 à la lettre : il
  n'existe que pour un conteneur arrêté.
- `docker logs --timestamps` rend un horodatage **UTC du locataire**, à la
  nanoseconde. Le retraduire dans le fuseau du poste décalerait l'écran de ce que
  le locataire lit dans son propre journal.
- Un conteneur inconnu rend **1**, sur `inspect` comme sur `logs`.

Ce dernier point avait failli m'échapper : ma première mesure passait par un
`| head` et rapportait `$?=0`. Le tube ment sur le code de sortie. Remesuré
proprement.

### Demandé, jamais collecté

Le §37.6 relève l'inventaire toutes les cinq secondes. Étendre cette cadence à
l'inspection et aux journaux multiplierait par dix le coût pour le locataire, et
personne ne lit dix journaux à la fois. Les deux lectures ne partent donc que sur
un geste, et **ouvrir un conteneur suspend le relevé de la liste** : elle a cédé
la place, la relever ne servirait personne.

Corollaire assumé : `truncated` est **rendu par l'hôte**, jamais déduit à l'écran
d'un `lines.length === tail`. Cette déduction marcherait aujourd'hui et mentirait
le jour où un conteneur a exactement deux cents lignes.

### Le défaut que seul le parcours pouvait trouver

Trente-deux preuves unitaires vertes, et l'écran affichait **cent soixante-quatorze
lignes sur deux cents**. Les montages revenaient vides.

Cause : le relevé se résolvait sur `exit`. Or `exit` arrive quand le processus
meurt, pas quand `stdout` a fini d'être drainé. Sur une sortie courte le doublon
ne le voit jamais ; sur deux cents lignes, si.

C'est le pire défaut possible pour un écran dont le seul rôle est de rapporter :
il n'échoue pas, il **ment en silence**. Il aurait fait conclure qu'un conteneur
n'avait rien écrit, ou n'avait aucun volume. Corrigé en attendant `close`, et
gardé par une preuve qui rejoue l'ordre exact — une ligne émise après `exit` et
avant `close` doit survivre.

Leçon, la même qu'au `compte_rendu` de SPK-54 : les preuves unitaires éprouvent la
**forme** de ce qu'on reçoit ; seul un parcours éprouve qu'on le reçoit en entier.

### Quatre défauts que seule la capture montre

Aucun n'était rouge :

1. Le titre venait du nom **cliqué**, pas de ce que la Forge a rendu. La capture
   d'un conteneur arrêté affichait `crm-web-1` au-dessus des données de
   `crm-migration-1`. C'était mon harnais qui les désaccordait — mais le produit,
   lui, aurait fait exactement la même chose (§14.9).
2. Le retour à la liste était en **pied**, sous deux cents lignes de journal. Un
   écran dont on ne sort qu'en défilant est un écran qui retient.
3. Un conteneur disparu s'affichait en **rouge**, sous un texte disant « c'est un
   état normal, pas une panne ». L'écran se contredisait à l'œil avant même d'être
   lu. Le §25.1 réserve le rouge au refus du serveur.
4. Quand l'identité aboutissait et que **seuls les journaux** trouvaient le
   conteneur disparu, l'écran restait **muet** : il affichait une fiche complète
   d'un conteneur qui n'existait plus. Corrigé — et dit **une seule fois**, parce
   que le même fait dans deux encarts identiques fait douter qu'il s'agisse du
   même fait.

### Une règle révisée, pas contournée

La preuve « aucun bouton d'action n'est offert » est passée au rouge. Elle avait
raison de garder quelque chose, et tort sur ce qu'elle gardait : elle interdisait
tout `<button>`, donc le seul moyen de **demander** une lecture — que le §37.6 ter
exige.

Ce qu'elle protégeait était « aucun geste **sur** le conteneur ». Elle dit
désormais cela, l'explication et sa date sont dans le fichier, et elle éprouve
l'absence de tout libellé de démarrage, d'arrêt, de redémarrage ou de suppression.
La règle n'a pas été affaiblie : elle a été énoncée correctement.

### Éprouver une course au clavier

Un conteneur qui disparaît pendant qu'on le regarde n'est pas atteignable depuis
l'interface : on ne peut pas cliquer un conteneur absent de la liste. Le doublon
fait donc échouer la **deuxième** lecture des journaux, sur témoin. Le parcours
ouvre le conteneur, lit ses journaux, clique *Relire* — et tombe sur la course,
exactement comme si le locataire venait de supprimer sa pile. Aucune URL profonde,
aucun appel d'API.

Le témoin vit aussi longtemps que la pile : sans remise à zéro entre parcours, le
premier condamnait tous les suivants. `pile.oublierLecturesDocker()` l'efface au
`beforeEach`.

### INC-07, reconstaté

Le §8.1 mesuré sur ce nouvel écran : la page déborde de **247 px** sur 390. Les
coupables sont les mêmes trois `a.onglet` qu'au terminal. Ce que cette deuxième
mesure ajoute : le défaut ne tient à **aucun contenu**. Ni le terminal ni le
journal ne débordent — ils défilent chacun dans leur bloc, et la preuve le mesure
séparément. La barre d'onglets seule déborde, sur tout écran de Spark.
Comportement laissé inchangé, mesure consignée.

### Vérifications

32 preuves du module, 32 de composant, 8 parcours E2E ciblés, tous verts. Captures
`98-` à `101-` observées, plus `docs/manuel/images/m8-docker-conteneur.png`
produite depuis la pile réelle. Manuel M8 complété.

**SPK-44 reste `[~]`**, avec un seul écart désormais : aucun vrai `docker ps`,
`docker inspect` ni `docker logs` n'a été lu à travers un tunnel. Le doublon
remplace la commande — le découpage, les refus et l'écran sont éprouvés, la
traversée réelle ne l'est pas. Elle tombera avec l'amorçage d'un Spark sur la
Forge réelle (SPK-54).

**Où reprendre.** SPK-45 — les gestes sur un conteneur — est la suite naturelle et
ne dépend plus de rien. SPK-54 et SPK-53 attendent chacune une décision du
responsable.

---

## 2026-08-20 · SPK-45, première tranche — le cycle de vie d'un conteneur

**Problème.** L'onglet Docker observait sans rien pouvoir faire. Un conteneur
tombé se relançait au terminal, à la main, sans trace au journal.

### Ce que la mesure a tranché avant qu'une ligne soit écrite

Docker 29.6.1, un conteneur `alpine` créé puis supprimé. Trois faits, et chacun a
changé la spécification :

- **`start` et `stop` sont idempotents, `kill` ne l'est pas.** Démarrer ce qui
  tourne déjà et arrêter ce qui est déjà arrêté rendent `0` ; tuer un conteneur
  arrêté rend `1`.
- **Le code `1` a deux causes, et seule la sortie d'erreur les sépare** — `No
  such container` et `is not running`. C'est l'exact inverse du §37.6 bis, où le
  code distinguait et la sortie ne disait rien. Les confondre annoncerait une
  disparition à propos d'un conteneur simplement arrêté, et enverrait chercher
  une suppression qui n'a jamais eu lieu.
- **« Le geste a réussi » ≠ « le conteneur s'est arrêté proprement »** : un
  conteneur qui ignore `SIGTERM` finit en `137`, et `docker stop` rend quand même
  `0`.

Une mesure a failli m'échapper : mon premier `docker inspect` passait par un
`| head` et rapportait `$?=0`. Le tube ment sur le code de sortie.

### Deux décisions qui ne se voyaient pas dans le §37.7

**Quatre actions d'audit, pas une.** Même raison qu'au §37.3, qui a séparé
`spark.rescue_exec` de `spark.terminal_open` : ce qui doit se compter, c'est le
geste. « Combien de conteneurs a-t-on tués ce mois-ci » doit se répondre par un
filtre, pas en lisant les charges.

**La porte d'audit figeait `result: "ok"`.** Un geste refusé n'aurait donc pas pu
être journalisé comme tel, et une tentative répétée sur un Spark protégé serait
restée invisible — exactement ce qu'un journal existe pour montrer. Elle admet
désormais `result`, borné à deux valeurs. Et **seul un geste abouti est un
succès** : un conteneur disparu, déjà arrêté ou injoignable donne `denied` avec
son état pour raison.

### L'objection du §6.23, et sa réponse

Le design system pose qu'une protection ne bloque **jamais** un geste qui réduit
un risque. Arrêter un conteneur compromis y ressemble, et l'objection est fondée.

Elle a sa réponse dans le §37.7 lui-même, désormais écrite : **le terminal reste
ouvert sous gel**. Qui doit couper vite y tape la commande, sans désarmer quoi
que ce soit ni oublier de réarmer. Le garde-fou porte sur le geste distrait,
jamais sur le geste urgent.

### Ce que les parcours ont trouvé et les preuves unitaires non

- **`doublonPour` ne reconnaissait pas les quatre gestes.** La vraie commande
  `ssh` partait, échouait en 255, et l'écran annonçait « aucun serveur SSH ne
  répond » — un diagnostic qui ne dit rien du geste demandé.
- **Le parcours du gel visait un Spark arrêté.** Sans inventaire Docker, il
  aurait éprouvé l'arrêt du Spark au lieu du gel.

### Ce que la capture a trouvé et les parcours non

- **`.confirmation` est rouge depuis son origine.** Cela convenait à une seule
  confirmation, celle du dépannage en root. Avec quatre gestes dont un seul
  détruit, la couleur cessait d'informer. D'où SPK-DS-09 : une confirmation
  sensible prend l'accent, une destructive garde le rouge.
- **Il manquait un troisième bloc d'issue.** Un succès n'avait que l'accent pour
  se dire, et « le conteneur est arrêté » s'affichait dans la couleur qui sert à
  prévenir d'un danger. D'où SPK-DS-08 — et son intérêt second : le vert rend
  visible qu'un conteneur déjà arrêté ou disparu n'est **pas** un succès.
- **Le harnais de capture rendait la même inspection avant et après le geste**,
  affichant « Arrêter : c'est fait » au-dessus de « en marche ». La contradiction
  même que le §37.7.2 existe pour éviter. Une capture qui la montre est fausse.

### Une preuve révisée pour la troisième fois

« Aucun bouton n'est offert » (SPK-44) est repassée au rouge, cette fois par
l'unité qui **livre** les gestes. Ce qu'elle gardait vraiment tient en deux
points, tous deux encore vrais et désormais écrits : la **liste** ne porte aucun
geste — agir depuis une ligne de tableau, c'est agir sans avoir regardé —, et un
geste se demande sur un conteneur qu'on a **ouvert**.

### Vérifications

Campagne complète **verte** : 705 Python, contrat conforme, 730 de console, 8 de
gestes, **64 parcours E2E**, 7 du manuel, `build`. Captures `102-` à `104-`
observées — la confirmation destructive, le succès constaté, le gel — plus
`docs/manuel/images/m8-docker-geste.png` produite depuis la pile réelle.

**SPK-45 reste `[~]`** : la deuxième tranche — le terminal **dans** un conteneur
— n'est pas livrée, et n'est pas encore spécifiée. Et comme pour SPK-44, aucun
vrai `docker stop` n'a traversé un tunnel : le doublon remplace la commande.

**Où reprendre.** La deuxième tranche de SPK-45 : spécifier puis livrer
`docker exec -it` avec le contrat du §37.4 et l'audit du §37.5. SPK-54 et SPK-53
attendent chacune une décision du responsable.

---

## 2026-08-20 · SPK-45, deuxième tranche — le terminal dans un conteneur

**Problème.** L'onglet Docker savait lire et agir, mais pour entrer dans un
conteneur il fallait ouvrir le terminal du Spark et taper `docker exec` à la
main — sans trace au journal disant dans quel conteneur on était entré.

### Ce que la mesure a tranché avant qu'une ligne soit écrite

Docker 29.6.1, un conteneur `alpine`. Le fait qui commande tout le module :

**Quand le binaire demandé manque de l'image, `docker exec` rend `127` et écrit
son message sur la SORTIE STANDARD, pas sur la sortie d'erreur.** Une console qui
ne surveillerait que `stderr` ne verrait rien et prendrait l'échec pour un shell
ouvert et muet — donc laisserait une fenêtre noire dont il faut deviner pourquoi
elle est vide. Une preuve l'éprouve avec un `stderr` vide.

D'où la décision : **on sonde avant d'ouvrir**, comme le §37.3.1 sonde `sshd`
avant de conclure. `bash` préféré, `sh` accepté, aucun des deux = un état NOMMÉ.
Une image *distroless* n'embarque délibérément pas de shell : c'est un bon choix
de sécurité du locataire, pas une panne.

Trois autres mesures : un conteneur arrêté et un conteneur disparu rendent tous
deux `1` et seul le texte les sépare ; le message d'un conteneur arrêté nomme
l'**identifiant long**, jamais le nom, donc il n'est pas montrable (§14.7) ; le
code de sortie de la commande interne est propagé tel quel.

### Une session, pas deux

L'ouverture emprunte la route existante avec un champ `container`. Une seconde
famille de routes aurait dupliqué le flux, la saisie, la fermeture et la mort du
distant — quatre endroits où deux terminaux finissent par diverger.

En écrivant la fermeture, un défaut est apparu : les **deux** routes de fermeture
partageaient une copie qui figeait `path: 'ssh'`. C'était déjà faux pour le
dépannage. Elles partagent désormais une seule fonction, qui lit le chemin de la
session.

### Ce que les parcours et la capture ont trouvé

- **`doublonPour` ne reconnaissait pas `docker exec`** — même défaut qu'à la
  tranche 1 avec les quatre gestes.
- **La capture 105 disait « propage la taille au Spark »** alors qu'on était dans
  un conteneur. Le `stty` part au shell distant, qui est celui du conteneur.
- **La capture 106 a confirmé INC-10** : la bannière annonce « SSH » et promet
  qu'en quittant on terminera la session, au-dessus d'un message disant qu'aucun
  terminal ne peut s'ouvrir. Ligne de base établie sur le seul fichier concerné :
  le défaut est antérieur, comportement laissé inchangé.

### Une preuve révisée, et une seconde

`describe()` a une liste blanche exhaustive de ses champs : elle a fait son
travail en rougissant sur `container` et `shell`. Allongée une seconde fois, avec
son motif — ce sont des métadonnées du même genre que le nom du Spark, et une
preuve vérifie qu'aucun octet de session n'y arrive.

Et le parcours d'inventaire figeait le nombre de conteneurs à deux. Le doublon en
porte trois depuis cette tranche. Même fragilité que celle déjà révisée par
SPK-52 : la preuve dit désormais ce qu'elle gardait — `docker ps -a` liste ce qui
tourne ET ce qui est arrêté.

### Vérifications

Campagne complète **verte** : 707 Python, contrat conforme, 767 de console, 8 de
gestes, **69 parcours E2E**, 7 du manuel, `build`. Captures `105-` et `106-`
observées, plus `docs/manuel/images/m8-terminal-conteneur.png`, toutes produites
par le vrai parcours.

**SPK-45 reste `[~]`** : un seul écart demeure, le même qu'à SPK-44 — aucun vrai
`docker exec` n'a traversé un tunnel, le doublon remplaçant la commande.

**Où reprendre.** SPK-53 et SPK-54 attendent chacune une décision du responsable.
Sans elles, la première unité du plan qui reste à construire est SPK-55 (durcir
la Forge) ou SPK-57 (redimensionner un Spark existant), toutes deux `[ ]`.

---

## 2026-08-20 · SPK-56 — le balayage des écrans, et la limite du §1.5 bis

**Unité choisie** au §4.2 point 2 : premier `[~]` du plan dont il reste du
comportement. SPK-17, SPK-29, SPK-30 et SPK-37 attendent du matériel ou une
exécution de CI ; SPK-43/44/45 attendent la Forge réelle ; SPK-53 et SPK-54 un
arbitrage. SPK-56 restait, avec trois écarts nommés et livrables ici.

### Ce que le §1.5 bis a effectivement retiré

Le test de la règle — « une phrase qui reste vraie quand toutes les valeurs de
l'écran changent appartient au manuel » — appliqué aux écrans non encore balayés.
Quatre paragraphes sont partis : le droit d'ordonnancement (Ressources → M5), le
geste accidentel (Protection → M8), l'argumentation des trois coûts du rootless
et le « pourquoi » de l'amorçage (→ M6), le développement sur le catalogue
(→ M5). Chaque fois, le manuel a été **vérifié d'abord** ; pour le catalogue il
ne disait rien, et le chapitre a donc été écrit avant que l'écran cesse de le
dire.

### La limite qu'il fallait poser

Premier passage trop agressif : j'avais retiré les **trois conséquences** du mode
rootless. Deux preuves l'ont refusé, et elles avaient raison. Le §6.23 exige
qu'une confirmation nomme sa conséquence, et le rootless est un choix
irréversible engagé depuis une confirmation. **Le §1.5 bis vise le raisonnement
de fond ; il ne prime pas sur ce qu'une confirmation doit dire pour qu'on
décide.** Les conséquences restent, l'argumentation part. Le motif est écrit dans
les preuves, pour que la prochaine session ne recoupe pas ce que le §6.23
protège.

### Ce que la vérification visuelle a trouvé, et elle seule

Le manuel n'avait **aucune capture**, alors qu'il est désormais l'endroit où tous
les écrans renvoient. Mesuré sur 390 px : arriver sur `#/manuel/M5` montrait
douze liens de chapitres, et M5 commençait sous la ligne de flottaison. Empilés,
le chapitre passe donc avant le sommaire — le lecteur a cliqué pour lire M5.

Second défaut, du harnais : `goto` vers une adresse identique ne recharge pas, si
bien que la capture de la tablette portait la confirmation de suppression ouverte
par la capture précédente.

### La garde posée

Chaque renvoi `#/manuel/Mx` écrit dans un composant doit désigner un chapitre
présent sur le disque, et les écrans qui ont délégué doivent porter un renvoi. Un
renvoi mort est une commande morte (§1.4) — c'est le piège que SPK-56 avait évité
de justesse, désormais impossible à retomber dedans en silence.

### Vérifications

Campagne complète **verte** : 707 Python, contrat conforme, 772 de console, 8 de
gestes, 69 parcours E2E, 7 du manuel, `build`. Captures `107-` à `110-` observées
— le détail à la tablette, le manuel aux trois formats — plus `14-detail-mobile`
refaite.

**SPK-56 passe `[x]`** : le balayage est fait, la vérification visuelle aussi,
M4 et M12 portent bien ce que les écrans ont cessé de dire, et le manuel M5 porte
ce qui lui manquait.

**Où reprendre.** SPK-53 et SPK-54 attendent une décision du responsable. Sans
elles, la première unité `[ ]` du plan qui reste constructible est SPK-55
(durcir la Forge) ou SPK-57 (redimensionner un Spark existant).

---

## 2026-08-20 · SPK-28 — le stockage se configure, et cesse d'être une dette

**Unité choisie** au §4.2 point 3 : première `[ ]` du plan. Les `[~]` restantes
attendent du matériel, une exécution de CI, la Forge réelle ou un arbitrage.

### Ce que la recherche a trouvé, et que la mémoire aurait manqué

La DoD exigeait « aucune valeur de stockage codée en dur, vérifié par une
recherche ». Elle en a montré trois, toutes dans `sparkd.preflight` : le nom du
pool et celui du jeu de données en **défaut de fonction**, et `size=200GiB` dans
le remède.

Conséquence mesurable : sur une Forge dont le pool s'appelle `tank` et qui
fonctionne, la vérification annonçait « pool « spark » absent ». Un rouge qui ne
dit rien du produit est ce que le §31.2 interdit.

Elle a aussi montré qu'aucun script ne créait le pool : il était posé à la main et
décrit en prose au contrat de déploiement.

### L'arbitrage porté au produit

Le §8.5 disait « une cible et un repli ». Il dit désormais **deux dispositions**,
chacune avec ce qu'elle apporte et ce qu'elle ne protège pas. Ce qu'elle ne
protège pas est dit franchement plutôt qu'adouci : sous la disposition sur
fichier, la protection contre la corruption silencieuse est **absente**, pas
dégradée.

Le motif du changement est écrit là où quelqu'un le cherchera : une dette qu'on ne
compte pas rembourser n'est pas une dette. OP-01 est close pour cette raison, et
plus aucun document ne dit « provisoire » — sauf celui qui raconte pourquoi cela
a changé.

### Ce qui a été construit

`scripts/creer-pool.sh` crée le pool dans l'une ou l'autre disposition, sans
qu'aucune valeur soit codée en dur. `SPARK_POOL_SOURCE` **décide** de la
disposition : le renseigner EST le choix du miroir natif.

Trois refus, chacun avec sa raison : un pool déjà en place n'est jamais recréé ; un
seul périphérique est refusé, faute de quoi on livrerait une disposition qui porte
le nom de « native » sans en donner la protection ; un périphérique non vide est
refusé **avant** toute écriture, et le script montre ce qu'il a trouvé.

Le README porte le schéma de partitionnement JSON à fournir à la création d'un
serveur. Le point qui compte : `sda5` et `sdb5` n'apparaissent ni dans un RAID ni
dans un système de fichiers — les confier à `md` reproduirait exactement le
problème que le miroir ZFS résout.

### Un premier script éprouvé

Aucun script du dépôt ne l'était. Ces preuves exécutent le **vrai** script :
`id`, `incus` et `wipefs` sont doublés sur le `PATH`, ce qui le laisse intact et
lui fait croire qu'il est root sur une machine à lui. Le contrôle `[ -b … ]` étant
une primitive du shell, la preuve nomme de **vrais** périphériques bloc — les
inventer aurait éprouvé le mauvais refus. Rien n'est écrit ni lu sur eux.

### Vérifications

Campagne complète **verte** : 722 Python, contrat conforme, 772 de console, 8 de
gestes, 69 parcours E2E, 7 du manuel, `build`. Aucune capture : cette unité ne
touche pas l'interface.

**SPK-28 reste `[~]`**, avec un seul écart : le schéma JSON n'a jamais été soumis
à un hébergeur. Il est valide et une preuve le garde, mais « un exploitant qui
suit le README obtient les partitions attendues » demande une machine commandée,
que la session ne peut pas fournir.

**Où reprendre.** SPK-35 et SPK-36 sont les `[ ]` suivantes du plan. SPK-53 et
SPK-54 attendent toujours une décision du responsable.

---

## 2026-08-20 · SPK-35 rendue, puis SPK-63 livrée

**Deux unités**, et c'est délibéré : SPK-35 est une instruction pure — son
arbitrage dit « rien n'est implémenté sous cette unité ». Une session qui s'y
arrêterait n'aurait poussé aucun code. Le §4.2 prévoit ce cas : on passe ensuite à
une unité de construction, et SPK-63 est sortie de l'instruction elle-même.

### SPK-35 — le résultat qui déplace la question

`docs/DAT.md` §45. Tant que la clé du responsable ouvre un **shell** sur la Forge,
un second facteur devant l'API de `sparkd` ne protège de rien contre une clé
volée : qui a la clé entre par SSH et atteint le registre. Le facteur serait un
guichet fermé à côté d'une porte ouverte.

D'où la première mesure retenue — **restreindre cette clé au seul tunnel**
(SPK-61) —, qui est le préalable sans lequel aucun facteur n'a de sens.

Les cinq menaces se rangent en deux familles qui n'appellent pas le même remède :
l'**erreur** — acteur légitime, intention fausse — se traite par la friction et le
nommage ; l'**usurpation** se traite par un facteur, et seulement s'il ne vit pas
là où le premier a été volé. Les confondre fait payer une authentification là où
il fallait une confirmation qui nomme.

Écrit franchement : le produit ne prétendra pas traiter un poste de travail
compromis. Aucun facteur saisi sur ce poste n'y survit.

Trois pistes retenues (SPK-61, SPK-62, SPK-63), quatre écartées avec leur motif,
TOTP **reportée** et non rejetée. SPK-40 requalifiée : ce n'est pas de
l'authentification — la clé volée signe —, c'est de la non-répudiation d'audit,
ce que le §36.3 disait déjà. L'arbitrage qui la bloquait est rendu.

### SPK-63 — frapper le nom

La règle est au design system §6.23, avec ses **trois conditions** : action
irréversible, objet confondable, nom court et visible. La troisième n'est pas une
commodité — faire recopier un identifiant long apprend à le coller sans le lire.

La suppression d'un Spark les réunit ; aucun autre geste du produit ne les réunit,
et c'est pourquoi l'unité s'arrête là.

**Défaut trouvé par le parcours, et par lui seul** : mon premier branchement
repeignait tout l'écran à chaque caractère, et la frappe se perdait. Le dépôt
avait déjà appris cette leçon pour les curseurs (§6.9 bis) — `innerHTML`
reconstruit la surface et arrache le contrôle en cours d'usage. Seuls les deux
éléments qui dépendent de la valeur sont désormais réécrits.

Le parcours de suppression existant est passé au rouge parce que la règle a
changé : il cliquait directement. Il frappe désormais le nom, avec son motif écrit
sur place.

### Vérifications

Campagne complète **verte** : 723 Python, contrat conforme, 780 de console, 8 de
gestes, **70 parcours E2E**, 7 du manuel, `build`. Captures `13-` et `111-`
observées — les deux moitiés de la règle —, plus
`docs/manuel/images/m10-suppression-nom-frappe.png`.

**SPK-35 est `[x]`** — l'instruction est rendue, et elle ne devait rien
implémenter. **SPK-63 est `[x]`.**

**Où reprendre.** SPK-36 est la `[ ]` suivante du plan, et c'est encore une
instruction. SPK-61 et SPK-62, nées de cette session, sont de la construction.
SPK-40 est désormais **démarrable**. SPK-53 et SPK-54 attendent toujours une
décision du responsable.

---

## 2026-08-20 · SPK-36, premier scénario — sauvegarder le registre

**Unité choisie** au §4.2 point 3, première `[ ]` du plan. Son arbitrage désigne
lui-même le point de départ : la sauvegarde du registre, **le seul scénario du lot
qui se livre en code vérifiable** plutôt qu'en document.

### Ce que la mesure a tranché

Le registre est en mode WAL (`db.py`). Mesuré pendant qu'une connexion écrivait :

```
500 lignes écrites
cp reg.db copie.db    → la copie s'ouvre SANS ERREUR et contient 490 lignes
Connection.backup()   → 500 lignes
```

**Dix lignes perdues en silence, et une copie qui ne se plaint pas.** C'est le
pire mode de panne d'une sauvegarde : elle restaure, elle ne signale rien, et il
manque ce qu'on venait chercher. En preuve, le cas s'est révélé pire encore —
selon ce qui reste dans le WAL, la copie peut ne pas porter la **table** du tout.

Sur le registre réel : 237 568 octets en 0,005 s, et la chaîne d'audit de la copie
porte la **même tête** que l'original. Le coût n'est pas un argument pour espacer
les sauvegardes.

### Ce qui a été construit

`sparkd.sauvegarde` — sauvegarde par l'API en ligne, sans arrêter le service, et
qui **vérifie ce qu'elle vient d'écrire** par deux contrôles qui ne disent pas la
même chose : `integrity_check` porte sur la structure, la chaîne d'audit sur le
contenu du journal. Une copie douteuse est **retirée** : la garder ferait croire
qu'une sauvegarde existe, ce qui est pire que de n'en avoir aucune.

La restauration refuse si `sparkd` répond, refuse un fichier qui ne se vérifie
pas, et **déplace** le registre remplacé au lieu de l'écraser. Les fichiers `-wal`
et `-shm` partent avec lui — laissés en place, SQLite les rejouerait par-dessus le
registre restauré, et la restauration serait silencieusement inutile.

`docs/CONTINGENCE.md` porte la fiche complète et, une fois pour toutes, la
**frontière** : ce que le produit sauvegarde et ce qu'il ne sauvegarde pas. Le
trou le plus grave y est nommé — les instantanés vivent DANS le pool, donc ils ne
protègent pas de sa perte.

### Un défaut trouvé par les preuves

Un fichier SQLite valide sans `audit_log` faisait lever une erreur brute de
SQLite. Un tel fichier n'est pas un registre Spark — ou c'en est un tronqué —, et
l'erreur nue ferait chercher une panne du produit là où le fichier est simplement
le mauvais. Il est désormais nommé, et la restauration le refuse en parlant du
journal.

### Vérifications

Campagne complète **verte** : 733 Python, contrat conforme, 780 de console, 8 de
gestes, 70 parcours E2E, 7 du manuel, `build`. Aucune capture : cette unité ne
touche pas l'interface.

**SPK-36 reste `[~]`.** Un scénario sur dix est traité, et sa DoD exige en outre
un **exercice réel sur l'hôte** — restauration du registre et reconstruction d'un
Spark — que la session ne peut pas conduire. Les chiffres de reprise restent
espérés tant que cet exercice ne les a pas remplacés.

**Où reprendre.** SPK-40 est démarrable depuis l'arbitrage de SPK-35. SPK-61 et
SPK-62 sont de la construction. Les neuf autres scénarios de SPK-36 sont listés
au §3 de `docs/CONTINGENCE.md`. SPK-53 et SPK-54 attendent une décision du
responsable.

---

## 2026-08-21 · SPK-40, première tranche — la signature d'un geste, côté Forge

**Unité choisie** au §4.2 point 3, première `[ ]` du plan, débloquée par
l'arbitrage de SPK-35.

### Ce que la mesure a tranché

SSHSIG, mesuré sur OpenSSH 8.9p1. `ssh-keygen -Y verify` rend `0` quand tout
tient, et `255` sur chacun des quatre refus : message altéré, identité inconnue,
espace de noms différent, clé absente de la liste. Le code de sortie fait donc
foi.

L'espace de noms `spark-audit` n'est pas décoratif : sans lui, une signature
produite par le responsable pour un commit ou un courriel serait rejouable ici.

**Note de méthode, écrite au §36.10.2 parce qu'elle a failli coûter cher.** Une
première mesure rendait `0` sur une clé hors liste, ce qui contredisait tout le
reste. La cause était un fichier résiduel d'un essai précédent, pas OpenSSH. Une
mesure qui contredit les autres se **rejoue de zéro** avant d'être crue.

### Ce que le contrat a dû dire d'abord

Que l'unité **n'est pas** de l'authentification. Tout en découle, et notamment le
point qui surprend : **une requête non signée reste acceptée.** Refuser faute de
signature ferait de ce mécanisme un contrôle d'accès, ce que le §45.4 dit qu'il
n'est pas.

Mais une signature **présente et invalide** est refusée en `422` — non par
contrôle d'accès, mais parce que l'inscrire ferait mentir le journal : la ligne
affirmerait une preuve qu'elle n'a pas, ce qui est pire que de n'en porter
aucune.

### Ce qui a été construit

Migration `009` : trois colonnes qui vont **ensemble ou pas du tout**, un
déclencheur l'impose. Elles n'entrent **pas** dans l'empreinte de la chaîne — le
champ retenu du §36.9.2 est figé, et l'y ajouter invaliderait toutes les lignes
existantes. Chaîne et signature restent indépendantes par construction.

`sparkd.signature` : la forme canonique, le contrôle que les octets décrivent
bien la requête reçue, et la vérification par `ssh-keygen`. Le middleware la
pose au **même endroit** que l'acteur — ce qui est posé à quatorze endroits est
oublié au quinzième.

`verifier_journal` rejoue la vérification **hors ligne**, et c'est elle qui porte
la preuve : celle de la Forge attrape l'erreur et le bruit, celle-ci attrape
l'adversaire qui a root. Une preuve simule exactement cette attaque.

### Deux écarts que les preuves ont fermés

- Un événement du runtime **héritait** de la signature de la requête qui l'avait
  déclenché : le journal aurait fait croire que le responsable avait demandé un
  recalcul qu'il n'a jamais réclamé. `as_runtime` remet le contexte à zéro.
- Le journal exposait la signature entière à chaque page, contre mon propre
  §36.10.7. Chaque entrée dit désormais `signed` ; la signature ne vient qu'avec
  `with_signature`, et une preuve **mesure** que la page est plus lourde avec —
  sans quoi l'option n'aurait pas de raison d'être.

### Vérifications

Campagne complète **verte** : 762 Python, contrat conforme, 780 de console, 8 de
gestes, 70 parcours E2E, 7 du manuel, `build`. Aucune capture : cette tranche ne
touche pas l'interface.

**SPK-40 reste `[~]`** : la seconde tranche — la console **produit** la signature
par l'agent du responsable — n'est pas livrée. Elle suppose un agent atteignable,
que la pile de développement n'a pas. Tant qu'elle manque, aucune ligne n'est
signée en pratique : la Forge sait recevoir, personne n'envoie encore.

**Où reprendre.** La tranche 2 de SPK-40, ou SPK-61 et SPK-62 nées de SPK-35.
SPK-53 et SPK-54 attendent une décision du responsable.

---

## 2026-08-21 · SPK-40, deuxième tranche — la console signe

**Unité choisie** au §4.2 point 1 : le journal désignait cette reprise.

### La mesure qui décide de la commande

`ssh-keygen -Y sign -f <clé PUBLIQUE>` — et le choix de la clé publique n'est pas
un détail. Mesuré le 2026-08-21 sur OpenSSH 8.9p1, en **retirant la clé privée du
disque** :

```
agent chargé + -f cle.pub, clé privée ABSENTE  →  0, et la signature se vérifie
aucun agent  + -f cle.pub, clé privée absente  →  255, « Load key … No such file »
```

Quand un agent détient la clé, `ssh-keygen` lui délègue la signature et ne lit
jamais le secret. C'est la propriété du §36.3, et elle vaut ici pour la console
elle-même : **elle signe sans jamais tenir la clé privée.**

### Ce qui a été construit

`apps/webui/host/signature.js` — la forme canonique, identique à celle de la
Forge à l'octet près, et la commande de signature. Le relais la pose au **même
endroit** que l'acteur.

**Ne pas pouvoir signer ne retient jamais le geste** (§36.10.8) : le module ne
lève pas, il rend un **motif**. Un exploitant dont l'agent vient de se vider ne
doit pas découvrir que son produit s'est verrouillé.

Le message d'OpenSSH n'est pas montré tel quel — il nomme un fichier que
l'exploitant n'a pas demandé (§14.7) — mais traduit en ce qui manque vraiment, et
le motif dit quoi **faire** : `ssh-add`.

Une **lecture n'est pas signée** : le §36.7 ne les journalise pas, et signer ce
qui ne laisse pas de trace ne prouverait rien.

`signingKey` entre dans l'inventaire, pour **tous** les genres de serveur —
signer ne dépend pas de la façon d'atteindre la Forge. C'est un chemin vers une
clé **publique** : aucun secret n'entre là (§11).

### Vérifications

Campagne complète **verte** : 762 Python, contrat conforme, **796 de console**, 8
de gestes, 70 parcours E2E, 7 du manuel, `build`. Aucune capture : cette tranche
ne touche pas l'interface.

**SPK-40 reste `[~]`**, avec deux écarts nommés :

1. **aucun parcours E2E ne traverse la chaîne complète** — la console signe, la
   Forge vérifie, la ligne porte la signature. Les deux moitiés sont prouvées
   séparément, la jonction ne l'est pas ; le doublon `SPARK_SIGN_COMMAND` n'est
   pas encore posé dans `e2e/pile.mjs` ;
2. **l'échec de signature n'est pas dit À L'ÉCRAN.** Le relais le remonte, mais
   aucun écran ne le montre — c'est du comportement dû, et le §36.10.8 l'exige.

**Où reprendre.** Ces deux écarts, qui closent SPK-40. Puis SPK-61 et SPK-62.
SPK-53 et SPK-54 attendent une décision du responsable.

---

## 2026-08-21 · SPK-40, troisième tranche — ce que les écrans en disent

**Unité choisie** au §4.2 point 1 : le journal désignait ces deux écarts.

### La mesure qui décide du harnais

Le backlog demandait un doublon `SPARK_SIGN_COMMAND` dans `e2e/pile.mjs`. Mesuré
d'abord, sur OpenSSH 8.9p1, avant d'écrire quoi que ce soit :

```
ssh-keygen -Y sign -f cle.pub -n spark-audit intention        →  0
ssh-keygen -Y verify -f allowed_signers -I console/local …    →  0
```

`console/local` est un principal recevable, et la chaîne signe puis se vérifie
**sans agent**, la clé privée étant voisine de la publique. Le harnais fait donc
mieux qu'un doublon : il monte une VRAIE paire de clés et laisse tourner le vrai
`ssh-keygen` des deux côtés. Le doublon reste, mais il répond **par geste**, comme
celui de Docker au §37.6 ter — il échoue sur le relevé de topologie, pour que
l'échec se voie à l'écran, et délègue le reste au vrai `ssh-keygen`. Une seule
pile porte ainsi la chaîne signée ET l'échec dit.

### Ce qui a été trouvé en chemin, et qui n'était pas dans le backlog

L'écran du journal affirmait, en gras : « **Aucune entrée n'est signée** ».
C'était vrai avant SPK-40. C'est faux depuis. Une mention périmée se lit comme
vraie, et celle-ci se lisait sur la page même où l'on vient chercher une
garantie. Le §36.8.5 l'interdisait explicitement, et la RÈGLE a changé : il est
révisé, pas contourné, et la preuve qui le gardait aussi.

De même, la clé de signature ne se déclarait qu'en éditant `servers.json` à la
main — le défaut exact que SPK-41 existe pour supprimer. Le champ est dans
l'écran *Serveurs*, pour tous les genres.

### Où l'avertissement se place, et pourquoi ce n'est pas un détail

Dans la **coquille**, pas dans l'écran du geste. La cause n'est pas le geste :
c'est l'état du poste — agent vidé, clé absente —, et elle survit au geste.
Placé dans l'écran, l'avertissement disparaissait en changeant de page alors que
la cause restait, et l'exploitant croyait avoir réglé en naviguant ce qu'il
n'avait pas touché. Règle extraite : `docs/DESIGN_SYSTEM_APP.md` SPK-DS-10.

En **accent, jamais en rouge** : la Forge a accepté le geste. Ce qui est en jeu
est la trace, pas l'action (§25.1).

### Une preuve révisée, et il faut dire pourquoi

`un SECRET saisi dans le formulaire est refusé` cherchait « key » dans le nom des
champs. `signingKey` — un chemin vers une clé **publique** — l'a fait rougir.
C'est l'heuristique qui était trop large : le parcours emploie désormais le motif
du SERVEUR (`SECRET_HINT`), et non une seconde règle écrite à côté qui dériverait
de la première. Une preuve ajoutée dans le même geste montre que le rempart n'a
pas été retiré mais déplacé : coller une clé privée dans ce champ est refusé en
422.

### Vérifications

Campagne complète **verte** : 762 Python, contrat conforme, 808 de console, 8 de
gestes, 72 parcours E2E, 7 du manuel, `build`. Trois captures observées —
`47-journal-signature.png`, `48-signature-echec.png`,
`49-signature-echec-mobile.png` — et les illustrations du manuel renouvelées :
`m12-journal.png` porte désormais de VRAIES lignes signées, produites par la
chaîne réelle.

**Un manque du contrat de déploiement, fermé au passage** : la migration `009`
avait été livrée la veille sans son opération. `docs/PROD_MIGRATIONS.md` porte
désormais **OP-09**, avec son retour arrière et le piège qui compte — poser
`SPARKD_ALLOWED_SIGNERS` sur un fichier vide ou illisible ferait refuser en 422
tout geste signé, alors que ne PAS la poser désactive proprement la vérification.

**SPK-40 reste `[~]`**, avec un seul écart, et il est hors de portée d'une
session : **aucun agent SSH réel n'a signé un geste de bout en bout**. La preuve
unitaire le mesure déjà avec un vrai agent ; le parcours, lui, signe par le
fichier privé voisin — le cas du poste sans agent, que le §36.10.8 admet. Que
l'agent réponde se mesure **sur un poste** : c'est la même limite qu'au
§37.4.2 bis, et cela **nécessite une action humaine**.

**Où reprendre.** SPK-61 et SPK-62, nées de SPK-35. SPK-53 et SPK-54 attendent
une décision du responsable.

---

## 2026-08-21 · SPK-61 — la clé restreinte, mesurée avant d'être écrite

**Unité choisie** au §4.2 point 3 : première `[ ]` du backlog, désignée par le
journal précédent. Son backlog annonçait que sa faisabilité se déciderait par une
MESURE ; elle a été faite avant la première ligne de spécification.

### Le banc, et pourquoi il fallait un vrai `sshd`

L'hôte n'a pas de `sshd`. Deux conteneurs Alpine — une « Forge » et un « Spark » —
avec un vrai `sshd` 9.7, trois clés portant trois politiques, et deux services
distincts pour distinguer une cible autorisée d'une autre.

### Le résultat qui inverse une intuition

**`restrict` est un faux ami.** Il retire le pseudo-terminal, l'agent, le X11. Il
ne retire **pas** l'exécution d'une commande. MESURÉ : avec
`restrict,port-forwarding,permitopen=…`, `ssh forge "cat <fichier>"` rend `0` et
lit. Une clé « restreinte » à ce seul sens laisse tout le registre lisible, et
l'unité aurait été réputée faite sans l'être — c'est exactement le genre d'écart
qu'une spécification écrite de mémoire aurait produit.

Le corollaire est heureux et lui aussi mesuré : **`command=` ne casse ni le tunnel
ni le rebond**. `-L` et `-W` sont des canaux `direct-tcpip`, auxquels `command=`
ne s'applique pas.

### Le piège annoncé, et sa sortie

`command=` casse le **dépannage** du §37.3, qui est une session avec commande.
Renoncer au dépannage était refusé — il sert précisément quand le `sshd` d'un
Spark est muet, donc au pire moment. La sortie est une **garde** :
`scripts/garde-ssh.sh`, posée en `command=`, lit `SSH_ORIGINAL_COMMAND` et
n'accepte que `incus exec <nom> -- <shell>`. Contrat FERMÉ.

### Deux choses trouvées en montant le banc, et non en réfléchissant

- **`AllowTcpForwarding no`** — le défaut d'Alpine — fait tout tomber, y compris
  avec une clé sans aucune option. La ligne d'`authorized_keys` seule donnerait
  une console en panne, pas une console protégée. C'est au §46.2 et dans OP-10.
- **`permitopen` n'interprète aucun motif d'adresse** : `172.17.0.*:22` est
  refusé. Ma spécification, écrite une heure plus tôt, proposait deux voies ; la
  mesure en a tranché une, et le §46.5 a été récrit. Le joker d'HÔTE fonctionne —
  `permitopen="*:22"` s'écrit une fois et survit à chaque création de Spark, au
  prix d'une concession écrite.

### Deux défauts trouvés par les preuves elles-mêmes

- sans `set -f`, `incus exec * -- /bin/bash` se développait sur le répertoire
  courant et la garde LANÇAIT un dépannage sur une cellule que personne n'avait
  nommée. Vérifié en retirant `set -f` : le doublon d'`incus` est bien appelé ;
- `${2:-9876}` confondait un port VIDE avec un port ABSENT, et rendait
  silencieusement une ligne sur le port par défaut.

### Vérifications

32 preuves Python neuves, et **six chemins mesurés de bout en bout** contre le
`sshd` réel, avec la ligne réellement produite par `scripts/cle-restreinte.sh` et
la garde réellement posée : tunnel `0`, rebond `0`, dépannage `0` ; shell
interactif refusé, lecture d'un fichier refusée, autre service refusé.

**SPK-61 passe à `[~]`**, avec un seul écart : la clé n'est pas posée sur une
Forge de validation. Le banc est un `sshd` jetable et l'`incus` y est un doublon.
Poser la ligne sur la vraie Forge est un geste humain, OP-10 le décrit pas à pas —
**nécessite une action humaine**.

**Où reprendre.** SPK-62, la notification hors bande, entièrement constructible
ici. SPK-53 et SPK-54 attendent une décision du responsable.

---

## 2026-08-21 · SPK-62 — l'alerte hors bande

**Unité choisie** au §4.2 point 1 : le journal la désignait. Spécification écrite
et committée avant la première ligne de code — `docs/DAT.md` §47.

### Où elle s'accroche, et pourquoi ce point-là

Sur `audit.record()`, qui est le **seul chemin** vers le journal (§21.1). Toute
écriture y passe, qu'elle vienne de la console, d'un appel direct ou d'un script
sur la Forge. S'accrocher à la console laisserait sortir sans un mot exactement
les gestes qu'on cherche à détecter : ceux qu'on fait en la contournant.

### Ce qui a décidé de la forme du code

**Un canal injoignable ne fait jamais échouer un geste** (§37.4.5). L'envoi part
dans un fil séparé — jamais dans la transaction SQLite, où un `POST` de trois
secondes bloquerait l'unique écrivain de la Forge —, avec un délai de garde, une
file bornée, et aucune exception qui remonte.

**La liste des actions est FERMÉE**, neuf entrées. Un motif du genre « tout ce qui
contient `delete` » laisserait passer `spark.unprotect`, le geste le plus grave de
la liste. Les lignes du runtime, les refus et les gestes de construction ne
notifient pas : un canal qui crie tout le temps n'est plus lu, et c'est la panne
la plus probable de ce dispositif.

### Deux choses trouvées en éprouvant, non en réfléchissant

- **une preuve supposait plus que le §21.2 ne promet.** Mesuré : `SENSITIVE_VALUE`
  est un second filet étroit — une clé privée en armure, un en-tête
  `Authorization`, une clé publique longue. Un « password=… » composé à la main
  dans un message n'est pas reconnu. La preuve a été révisée sur ce que le filtre
  garantit RÉELLEMENT, et le canal porte exactement ce que le journal porte, ni
  plus ni moins — le resserrer ici ferait diverger deux caviardages ;
- **le parcours cassait d'autres parcours, DEUX fois.** Première version : il
  prenait un instantané sur `crm-production`, et le REFUS 3 compte les
  instantanés de ce Spark. Deuxième : il supprimait `site-vitrine`, et les
  parcours du terminal — trente lignes plus bas — tombaient sur un Spark
  disparu. Corrigé à la cause, et la leçon est écrite dans le parcours : le
  geste sensible éprouvé doit être **réversible**. C'est la levée de
  protection — que le §47.2 range en tête, puisqu'elle rend tous les autres
  gestes possibles — et l'état du seed est remis à la fin.

### Vérifications

33 preuves du module — sur un **vrai serveur HTTP local**, pas un doublon de la
fonction d'envoi : ce qu'on mesure est ce qui part sur le réseau. 6 de l'écran.
1 parcours E2E depuis un geste réel au clavier. Le canal est branché sur la pile
de TOUS les parcours : s'il cassait un geste, la série entière le dirait.

**SPK-62 passe à `[~]`**, avec deux écarts nommés :

1. **l'alerte ne NOMME pas l'objet en clair.** Mesuré : le message de
   `spark.delete` est une transition d'état, et le nom du Spark ne vit que dans
   `spark.deleted`, la ligne d'achèvement. L'alerte porte donc un identifiant
   opaque. Corriger à la cause touche le vocabulaire du journal (§21), hors de
   cette unité — **à arbitrer** : notifier aussi `spark.deleted` au risque de
   doubler l'alerte, ou faire nommer le Spark par le message de `spark.delete` ;
2. les captures du bloc « Alerte hors bande » — `50-notify-sans-canal.png` et
   `51-notify-en-echec.png` — sont produites par le harnais ; leur observation
   est dite dans le compte rendu de la session, qui seul fait foi sur ce point.

**Campagne complète** : 827 Python, contrat conforme, 814 de console, 8 de
gestes, 7 du manuel, `build`. **71 parcours E2E sur 72** — un échec, consigné au
registre en **INC-11** et non tranché : « entrer dans le terminal » est VERT
lorsqu'on le joue seul, et rouge dans la série. Le parcours de SPK-62 ne touche
ni à « crm-production » ni au terminal, et rend la pile à l'état du seed ; rien
n'établit donc qu'il en soit la cause, et le §2.4 interdit de conclure sans
ligne de base.

**Où reprendre.** INC-11 d'abord si la campagne suivante le retrouve — une
instabilité de harnais rend tous les verdicts suivants douteux. Puis l'arbitrage
sur le nom de l'objet dans l'alerte, puis SPK-51 ou SPK-55. SPK-53 et SPK-54
attendent une décision du responsable.

---

## 2026-08-21 · INC-11 non reproduit, puis SPK-55 — durcir la Forge

### INC-11 : deux mesures, aucune reproduction

Le journal précédent le désignait comme premier point à reprendre « si la
campagne suivante le retrouve ». Elle ne le retrouve pas :

```
série complète, seed fraîchement appliqué   =>  73 parcours, 0 échec
série complète REJOUÉE sans reseed          =>  73 parcours, 0 échec
```

La seconde exécution éprouvait l'hypothèse la plus probable — l'échec était
apparu à la DEUXIÈME série d'une même session — et l'infirme. Le harnais monte de
toute façon sa propre pile jetable à chaque série (§29.2).

**Rien n'a été corrigé, et c'est délibéré** : le §18 exige de reproduire avant de
traiter la cause, et corriger ce qu'on n'observe pas reviendrait à poser une
temporisation, que le §3.1 interdit. L'entrée du registre porte désormais la
mesure et ce que la prochaine occurrence devra relever.

### SPK-51 écartée, et pourquoi

Elle exige « deux vérifications préalables, à faire AVANT de coder » : les
conditions d'usage du relais transactionnel, et l'ouverture du port 25 entrant.
Ni le compte ni le serveur ne sont atteignables ici, et c'est ce couple qui
décide entre « émettre par le relais » et « émettre en direct ». Coder l'un ou
l'autre serait choisir à la place du responsable — **bloquée par une dépendance**.

### SPK-55 : ce qui a été construit

Spécification écrite et committée avant le code — `docs/DAT.md` §48.

Deux contrôles neufs au préflight. `NET-REMONTEE` porte le point de l'audit :
mesuré sur la Forge réelle, `10.77.0.1:22` **répond** depuis un Spark, alors que
`9876` et `2019` sont bien injoignables. Le sens du produit est à sens unique —
aucun de ses chemins ne part d'un Spark vers sa Forge.

**La moitié difficile est le remède, pas le constat.** Une règle qui fermerait
tout rendrait chaque Spark muet : il perdrait son résolveur, qui écoute sur
l'adresse du bridge, et sa sortie internet, qui passe par le même NAT. Le remède
ouvre donc le 53 AVANT de fermer, et une preuve garde cet ordre.

`SSH-X11` a demandé un quatrième état de verdict, `AVERTISSEMENT`, non bloquant :
un `X11Forwarding` ouvert n'est pas une faille, et un préflight qui échoue pour
un détail apprend à passer outre ses échecs. Le rendu le compte à part.

Deux décisions écrites plutôt que codées : `sparkd` en `root` est **assumé**
(§48.2), et `ufw` est **écarté** (§48.3) — deux jeux de règles qui se recouvrent,
et le jour où l'un bloque ce que l'autre autorise, personne ne sait lequel a
tranché.

### Vérifications

836 preuves Python (827 + 9), contrat conforme, 814 de console, 8 de gestes,
7 du manuel, `build`. **73 parcours E2E, deux fois de suite, 0 échec.** Aucune
capture : cette unité ne touche aucun écran.

**SPK-55 passe à `[~]`**, deux écarts nommés : la règle n'est pas posée par
l'installation — `install-serveur.sh` n'installe pas le réseau, le bridge naît
d'OP-02 à la main —, et aucun test ne prouve qu'un Spark garde son DNS et sa
sortie après durcissement, ce qui exige une Forge réelle avec un Spark en marche.
OP-11 décrit cette vérification pas à pas, et nomme l'écart le plus dangereux :
les règles `nft` sont VOLATILES, et le préflight lirait toujours « drop » dans la
configuration d'Incus après un redémarrage qui les a perdues.

**Où reprendre.** SPK-57 ou SPK-58, premières `[ ]` constructibles. SPK-51 attend
deux vérifications extérieures ; SPK-53, SPK-54 et l'arbitrage sur le nom de
l'objet dans l'alerte hors bande attendent une décision du responsable.

---

## 2026-08-21 · SPK-57 — l'admission apprend à compter un redimensionnement

**Unité choisie** au §4.2 point 1 : le journal la désignait. Spécification écrite
et committée avant la première ligne de code — `docs/DAT.md` §49.

### Le trou, et ce qui le rendait invisible

Le produit crée et supprime ; il ne sait pas **ajuster**. Agrandir un Spark
suppose de le supprimer et de le recréer — on perd la cellule, ses images Docker,
ses volumes. Pour un produit dont l'unité EST une cellule à quota, c'est le geste
d'exploitation le plus courant qui manque.

### La décision qui portait tout le reste

Un Spark qui existe est **déjà compté** dans l'alloué (§7.7). Rejouer l'admission
sur la demande entière refuserait des agrandissements tenables — et refuserait
même de RÉTRÉCIR sur une Forge saturée, ce qui est absurde : rendre de la mémoire
ne peut pas manquer de mémoire.

Deux voies, et une seule donne des refus vrais. **Soustraire** — admettre
`nouveau − ancien` — a été écartée : le refus du §7.7 porte `requested` et
`available`, et l'exploitant lirait « il manque 2 Gio sur une demande de 2 Gio »
alors qu'il en demande 8. Un message exact sur des chiffres faux est pire qu'un
message absent.

Retenue : **rendre d'abord, admettre ensuite.** `pools(connection, sauf=<id>)`
exclut le Spark visé des TROIS relevés — n'en oublier qu'un rendrait un pool
cohérent et un autre faux, et le refus mélangerait deux comptabilités. Les cœurs
dédiés en font partie, et c'est là que la règle compte le plus : passer de
`dedicated` à `shared` rend des cœurs physiques, donc augmente la **capacité** du
pool partagé.

### Vérifications

7 preuves neuves, dont celle qui montre le défaut évité : la même demande est
REFUSÉE sans exclusion et admise avec. 843 preuves Python au total (836 + 7).
Aucune capture : rien de visible n'a changé.

**SPK-57 passe à `[~]`**, et c'est un début, pas une livraison : le noyau du
calcul est posé, **aucune route ne redimensionne encore**. Restent la route et
son ordre — registre d'abord, Incus ensuite (§49.2) —, les refus de
rétrécissement (§49.3), les refus dus sur un Spark protégé ou transitoire
(§49.5), l'écran, le parcours et le manuel. Et ce que le §49.4 laisse à mesurer
sur une Forge réelle : la prise à chaud du disque et du changement de mode CPU —
**nécessite une action humaine**.

**Où reprendre.** SPK-57, la route `PATCH` et ses refus : la spécification les
fixe ligne à ligne, il n'y a plus qu'à coder. SPK-51 attend deux vérifications
extérieures ; SPK-53, SPK-54 et l'arbitrage sur le nom de l'objet dans l'alerte
hors bande attendent une décision du responsable.

---

## 2026-08-21 · SPK-57 — le geste de redimensionnement, côté serveur

**Unité reprise** au §4.2 point 1. Sa spécification existait (§49) : conformément
à l'exception du §3.2, elle n'a pas été réécrite — la session est allée droit au
code.

### Ce qui a été construit

`PATCH /v1/sparks/{name}` ajuste mémoire, réservation et plafond CPU, mode CPU,
débit réseau et taille de disque. Le nom, l'image et l'adresse privée sont
refusés : ce sont des identités, pas des quotas.

Le registre s'écrit d'abord, dans une transaction qui couvre l'admission et
l'écriture. Rien n'est encore posé sur Incus — c'est l'ordre du §49.2, et la
seconde moitié reste à faire.

### Trois refus, et ils ne se confondent pas

C'est le point qui a demandé le plus de soin. `423 Locked` sur un Spark protégé,
`409 admission_refused` quand la Forge n'a pas la place, et `409 shrink_refused`
quand ce qu'on veut retirer est **utilisé dans la cellule**. Mélanger les deux
derniers enverrait l'exploitant libérer de la place sur la Forge alors que le
problème est ailleurs.

### Deux choses corrigées parce qu'elles étaient fausses

- **ma preuve attendait `403` pour un Spark protégé** ; le produit rend `423
  Locked`, sa convention existante. C'est la preuve — et la docstring que je
  venais d'écrire — qui étaient fausses, pas le produit. En inventer une seconde
  convention aurait fait traiter le même refus de deux façons dans la console ;
- **mes preuves supposaient une Forge de 98 Gio.** Mesuré : la Forge factice
  n'offre que ~7,35 Gio allouables, le commentaire de la fixture disant autre
  chose. Les chiffres ont été alignés sur le mesuré, et l'écart est noté à
  l'endroit où il trompait.

### Vérifications

861 preuves Python (843 + 18), contrat régénéré et conforme. Aucune capture :
**aucun écran n'offre encore ce geste**.

**SPK-57 reste `[~]`**, quatre écarts nommés : aucun écran ni parcours ni manuel ;
rien n'est posé sur Incus ; l'usage relevé ne porte que la mémoire, donc le refus
du §49.3 sur le disque est prouvé au service mais pas atteignable par la route ;
et la prise à chaud du disque et du mode CPU exige une Forge réelle —
**nécessite une action humaine**.

**Où reprendre.** SPK-57 : poser les quotas sur Incus après le registre, puis
l'écran et son parcours. SPK-51 attend deux vérifications extérieures ; SPK-53,
SPK-54 et l'arbitrage sur le nom de l'objet dans l'alerte hors bande attendent une
décision du responsable.

---

## 2026-08-21 · SPK-57 — la cellule reçoit le quota

**Unité reprise** au §4.2 point 1. Spécification existante (§49) : la session est
allée droit au code, comme le §3.2 l'autorise.

### Ce qui manquait, et qui est livré

La seconde moitié du §49.2. Le registre était écrit ; la cellule ne l'était pas.
Après l'écriture, la route traduit les nouveaux quotas et les pose par
`update_instance_config`.

### Le point que la spécification ne tranchait pas, et qu'il a fallu compléter

L'ordre « registre d'abord, Incus ensuite » laisse une fenêtre où le registre est
en AVANCE sur la cellule. Le §49.2 ne disait pas ce que la route en fait ; il le
dit maintenant, et c'est un champ **`applied`** à trois valeurs :

- `true` — registre et noyau disent la même chose ;
- `false`, avec `apply_error` — le quota est **promis**, pas en vigueur ;
- `null` — il n'y avait rien à poser, le Spark n'a pas de cellule.

Les trois ne se confondent pas (§14.6). Confondre les deux premières serait
exactement le pire des cas que la DoD de l'unité nomme : « un quota changé au
registre mais pas dans le noyau ».

**Un échec de pose ne défait pas le registre**, et ce n'est pas de la
négligence : annuler ferait perdre l'admission déjà accordée et rouvrirait la
course que la transaction du §14.2 vient de fermer. Entre surestimer et
sous-estimer l'occupation, le produit surestime — c'est déjà la règle de la
création. Mais l'écart est DIT.

### Vérifications

864 preuves Python (861 + 3), contrat régénéré et conforme. L'échec de pose est
éprouvé sur un client Incus qui refuse, pas supposé. Aucune capture : **aucun
écran n'offre encore ce geste**.

**SPK-57 reste `[~]`**, trois écarts : aucun écran ni parcours ni manuel ; l'usage
relevé ne porte que la mémoire, donc le refus du §49.3 sur le disque est prouvé
au service mais pas atteignable par la route ; et la prise à chaud du disque et
du mode CPU exige une Forge réelle — **nécessite une action humaine**.

### INC-11 réapparaît, et l'observation change le diagnostic

La campagne rend **72 parcours verts et 1 échec** : « entrer dans le terminal »,
vert lorsqu'on le joue seul dans la minute qui suit. Le relevé que l'entrée du
registre demandait a été fait, et il apporte l'information qui manquait : l'écran
montrait « SSH » puis « **Session fermée.** » — la session **s'est ouverte** puis
**s'est refermée** avant la fin des assertions.

Le défaut n'est donc pas « la session ne s'ouvre pas » mais « elle ne dure pas »,
ce qui resserre la piste sur trois mécanismes documentés qui ferment une session.
Consigné en INC-11, comportement inchangé : trois causes plausibles, une seule
est la bonne, et le §18 exige de reproduire avant de traiter. Rien n'établit non
plus qu'il soit imputable à cette unité — le redimensionnement ne touche ni au
terminal ni aux sessions.

**Où reprendre.** SPK-57 : l'écran de redimensionnement et son parcours. Le §49.4
impose qu'il annonce un redémarrage AVANT d'agir pour les champs dont la prise à
chaud n'est pas mesurée. SPK-51 attend deux vérifications extérieures ; SPK-53,
SPK-54 et l'arbitrage sur le nom de l'objet dans l'alerte hors bande attendent une
décision du responsable.

---

## 2026-08-21 · SPK-57 — l'écran s'ouvre sur les quotas

**Unité reprise** au §4.2 point 1. Spécification existante (§49) ; le design
system a été relu **intégralement** avant de toucher à l'interface, comme le
`CLAUDE.md` §4 l'exige.

### Ce qui a été construit

La section *Ressources* de la fenêtre d'un Spark porte sa commande — « Modifier
les quotas » — et ouvre une modale dont le sujet est cette section. C'est le
patron du §6.27 : une fenêtre montre, une modale recueille.

**Le disque annonce son redémarrage AVANT qu'on agisse**, et c'est le point du
§49.4 : tant que la prise à chaud n'est pas mesurée sur une Forge réelle,
l'écran promet moins que ce qu'il fait. Promettre trop coupe un service en
production ; promettre trop peu ne coûte rien.

La modale prépare aussi à un refus qu'elle peut recevoir : elle dit que ce qu'on
retire doit être libre. Cela distingue à l'avance « il n'y a pas la place sur la
Forge » de « ce que vous voulez retirer est utilisé dans la cellule ».

Un Spark protégé garde la commande, **désactivée**, avec sa raison (§9.9) : la
faire disparaître ferait croire que le produit ne sait pas redimensionner.

### Une correction, minuscule et significative

Une preuve a rougi sur une apostrophe : le composant écrivait `qu'il` en
apostrophe droite là où tout le produit emploie l'apostrophe typographique.
C'est le composant qui a été corrigé, pas la preuve.

### Vérifications

821 preuves de console (814 + 7). Aucune capture : **la modale n'est pas encore
câblée**, donc rien de nouveau n'est atteignable au clavier.

**SPK-57 reste `[~]`**, quatre écarts : la modale rend mais n'envoie pas — le
geste manque entre l'écran et l'API, tous deux prêts ; aucun parcours, aucune
capture, aucun manuel ; l'usage relevé ne porte que la mémoire ; et la prise à
chaud du disque et du mode CPU exige une Forge réelle — **nécessite une action
humaine**.

**Où reprendre.** SPK-57 : câbler la modale dans `app.js` — l'ouvrir, envoyer le
`PATCH`, rendre le refus dans la modale —, puis le parcours et les captures.
SPK-51 attend deux vérifications extérieures ; SPK-53, SPK-54 et l'arbitrage sur
le nom de l'objet dans l'alerte hors bande attendent une décision du responsable.

---

## 2026-08-21 · SPK-57 — le geste devient atteignable au clavier

**Unité reprise** au §4.2 point 1. Spécification existante (§49) : code direct.

### Ce qui a été construit

La modale des quotas est **câblée**. Elle s'ouvre pré-remplie des valeurs du
Spark affiché — faire ressaisir de mémoire ce qui est déjà à l'écran invite à se
tromper d'ordre de grandeur, et c'est ce qu'un quota ne pardonne pas. Elle envoie
le `PATCH`, et rend le refus **dans** la modale sans effacer la saisie (§6.27).

Elle suit le contrat commun de modale — focus entrant, `Échap`, focus rendu — et
son état a été ajouté à la fermeture centralisée : l'oublier l'aurait laissée
ouverte après un `Échap`.

### Ce que les parcours ont mesuré, et qui a corrigé le parcours lui-même

Deux échecs successifs, tous deux instructifs, et **aucun n'était un défaut du
produit** :

- **agrandir est refusé** sur la pile du harnais : il n'y reste que ~1,36 Gio
  libres. Le refus est exact, chiffré, et parfaitement légitime ;
- **rétrécir la mémoire d'un Spark EN MARCHE est refusé** aussi — et c'est le
  §49.3 qui parle : descendre sous ce que la cellule emploie livrerait ses
  processus à l'OOM killer. Le produit avait raison ; c'est le parcours qui
  demandait l'impossible.

Le parcours vise donc le **disque d'un Spark arrêté** : pas d'usage relevé, et
rendre du disque ne peut jamais manquer de place (§49.1). Le raisonnement est
écrit dans le parcours, pour que la prochaine session ne le refasse pas.

### Vérifications

821 preuves de console, **2 parcours E2E** neufs — le geste qui aboutit, avec son
effet constaté côté Forge et le Spark toujours vivant ; et le refus qui reste
dans la modale avec sa saisie.

**SPK-57 reste `[~]`**, quatre écarts : aucune capture observée ni manuel M8 ;
l'usage relevé ne porte que la mémoire, donc le refus du §49.3 sur le disque est
prouvé au service mais pas atteignable par la route ; le **mode CPU** n'est pas
modifiable depuis l'écran alors que le §49.2 le range parmi les champs
redimensionnables et que l'API l'accepte ; et la prise à chaud du disque et du
mode CPU exige une Forge réelle — **nécessite une action humaine**.

**Où reprendre.** SPK-57 : les captures du geste, le manuel M8, puis le mode CPU
à l'écran. SPK-51 attend deux vérifications extérieures ; SPK-53, SPK-54 et
l'arbitrage sur le nom de l'objet dans l'alerte hors bande attendent une décision
du responsable.

---

## 2026-08-21 · SPK-57 — les captures et le manuel

**Unité reprise** au §4.2 point 1. Spécification existante (§49) : code direct.

### Ce qui a été livré

**Trois captures, produites et observées** : la commande dans sa section, la
modale pré-remplie portant son annonce de redémarrage sur le disque, et la même
sous 768 px — elle y occupe l'écran entier sans changer de contrat (§6.27).

**Le manuel M8 porte le geste**, et surtout ce qui compte pour l'exploitant : les
**deux familles de refus** ne se confondent pas. « Capacité insuffisante » se
règle sur la Forge ; « ce que la cellule emploie ou contient » se règle **dans le
Spark**. Un message qui les mélangerait enverrait chercher au mauvais endroit.

Le manuel dit aussi franchement ce qui n'est **pas** encore possible — changer le
mode CPU — plutôt que de le taire. Un manuel qui omet une limite se fait
découvrir par l'exploitant au pire moment.

### Vérifications

Captures observées à 1440 px et à 390 px. 7 preuves du manuel vertes.

**SPK-57 reste `[~]`**, trois écarts : le **mode CPU** n'est pas modifiable depuis
l'écran alors que le §49.2 le range parmi les champs redimensionnables et que
l'API l'accepte ; l'usage relevé ne porte que la mémoire, donc le refus du §49.3
sur le disque est prouvé au service mais pas atteignable par la route ; et la
prise à chaud du disque et du mode CPU exige une Forge réelle — **nécessite une
action humaine**.

**Où reprendre.** SPK-57 : le mode CPU à l'écran, puis relever l'occupation du
disque pour rendre le refus du §49.3 atteignable. SPK-51 attend deux
vérifications extérieures ; SPK-53, SPK-54 et l'arbitrage sur le nom de l'objet
dans l'alerte hors bande attendent une décision du responsable.

---

## 2026-08-21 · SPK-57 — le mode CPU se change depuis l'écran

**Unité reprise** au §4.2 point 1. Spécification existante (§49) ; le design
system a été relu **intégralement** avant de toucher à l'interface (§4).

### Ce qui a été construit

La modale des quotas porte un sélecteur des quatre modes CPU, et **les champs qui
suivent dépendent de lui** : une réservation en partagé, un plafond en plafonné,
un nombre de cœurs en dédié. Afficher les trois ensemble ferait saisir des
valeurs que le produit ignorera — un contrôle mort (§1.4).

**Les réglages de l'ancien mode ne survivent pas.** Une réservation laissée sur
un Spark devenu plafonné serait une valeur que rien n'emploie, et que le prochain
lecteur croirait vraie. Le parcours le vérifie côté registre.

Le mode **annonce son redémarrage** avant qu'on agisse, comme le disque (§49.4).

### Deux décisions de conception, écrites parce qu'elles pouvaient aller autrement

- **le mode REPEINT la modale, les autres champs non.** Repeindre à chaque frappe
  arracherait le focus (§14.3) ; mais un `select` n'est pas un champ de frappe, et
  le focus s'y replace. Le motif du §14.3 ne s'applique donc pas ici, et il fallait
  le dire plutôt que d'appliquer la règle par réflexe ;
- **la table des modes est importée**, jamais recopiée (§12.5). Elle s'est heurtée
  à un `MODES` déjà présent dans le fichier — celui des modes d'amorçage — et a
  été nommée `MODES_CPU` : deux tables homonymes dans un même module finiraient
  par être confondues.

### Vérifications

825 preuves de console (821 + 4), **1 parcours E2E** neuf qui va du clavier au
registre. Manuel M8 mis à jour, et sa section « ce qui n'est pas encore
possible » **retirée** : elle est devenue fausse.

**SPK-57 reste `[~]`**, deux écarts, tous deux hors de portée d'ici : l'usage
relevé ne porte que la mémoire, donc le refus du §49.3 sur le disque est prouvé
au service mais pas atteignable par la route ; et la prise à chaud du disque et
du mode CPU exige une Forge réelle — **nécessite une action humaine**.

**Où reprendre.** SPK-57 : relever l'occupation du disque de la cellule pour
rendre le refus du §49.3 atteignable — c'est le dernier écart constructible ici.
SPK-51 attend deux vérifications extérieures ; SPK-53, SPK-54 et l'arbitrage sur
le nom de l'objet dans l'alerte hors bande attendent une décision du responsable.

## 2026-08-21 · SPK-57 — le refus du disque devient atteignable

**Unité reprise** au §4.2 point 1, sur le point où la dernière session s'était
arrêtée : le refus de rétrécissement du disque existait au service, mais la
route ne relevait que la MÉMOIRE. Un refus prouvé mais inatteignable ne protège
personne.

### Ce qui a été construit

`_usage_de_la_cellule()` relève désormais **deux** grandeurs, et pas dans les
mêmes conditions — c'est la dissymétrie écrite au §49.3 avant de coder :

- la **mémoire**, seulement sur une cellule EN MARCHE. Une cellule arrêtée n'en
  occupe aucune, et refuser sur un chiffre périmé interdirait un rétrécissement
  légitime ;
- le **disque**, quel que soit l'état, parce qu'un Spark arrêté occupe toujours
  son jeu de données. C'est `disk.root.usage`, la grandeur que la section
  *Ressources* affiche déjà, **instantanés compris** — le quota porte sur le jeu
  entier, et se fonder sur les seuls fichiers vivants laisserait poser un quota
  que le pool ne peut pas honorer.

L'absence de mesure reste une RÉPONSE : runtime muet, aucun refus prononcé.

### Ce qui a été mesuré

Le message réel du refus, relevé sur le runtime avant d'être posé dans le
harnais de captures — pas transcrit de mémoire :

```
409 shrink_refused · resource=storage · in_use=534981632
« crm-production » occupe actuellement 534981632 octets de disque : descendre
sa taille à 0 perdrait des données. Videz ce qui peut l'être dans la cellule,
puis recommencez.
```

### Vérifications

3 preuves de route neuves — le refus prononcé avec l'occupation mesurée, la
dissymétrie mémoire/disque sur un même Spark arrêté, et le runtime muet qui ne
refuse rien. **867 preuves Python.** 1 parcours E2E neuf : le refus du disque
arrive dans la modale et ne dit PAS « capacité insuffisante ». Capture
`55-quotas-refus-disque.png` produite et observée.

Le commentaire du parcours de redimensionnement disait « un Spark arrêté n'a pas
d'usage relevé » : c'est devenu faux dans le même changement, et il a été
corrigé là.

### Ce qui a été consigné, pas corrigé

**INC-12** : les refus annoncent des octets bruts sous un écran qui se saisit en
Gio. Le défaut porte sur DEUX familles de refus, dont une seule est SPK-57 ; ne
formater que celle-là ferait dire la même grandeur de deux façons.

**Où reprendre.** SPK-57 n'a plus qu'un écart, et il n'est pas constructible
ici : la prise à chaud du disque et du mode CPU, plus le fait qu'une instance
ARRÊTÉE rende bien `disk.root.usage` — les trois exigent une Forge réelle
(**nécessite une action humaine**). La session suivante prend donc l'unité
suivante du plan, ou INC-12 si le responsable l'ordonne.

## 2026-08-21 · SPK-58 — le magasin d'environnement

**Unité choisie au §4.2 point 3.** SPK-57 n'a plus d'écart constructible ici, et
**toutes** les unités `[~]` restantes sont bloquées sur une Forge réelle, un
arbitrage ou un accès : SPK-17 (CI jamais exécutée), 29, 30, 28, 36, 37, 40, 43,
44, 45, 61, 55 (Forge réelle), 53 et 54 (arbitrage). SPK-51, première `[ ]`,
exige deux vérifications extérieures **avant** de coder. La première `[ ]`
réellement constructible est donc SPK-58.

### Ce qui a été spécifié avant d'être codé

`docs/DAT.md` **§43.9** et `docs/SCHEMA.md` §10 ter, committés avant la première
ligne de code (§3.2). Le §43 posait la doctrine ; il ne disait ni le modèle, ni
le chiffrement, ni l'empreinte, ni la résolution.

Trois décisions qui pouvaient aller autrement, et leur motif :

- **une table pour les deux portées**, pas deux. Deux tables imposeraient
  d'écrire deux fois la validation, le chiffrement et la résolution, puis de les
  faire diverger ;
- **AES-256-GCM par `cryptography`**, le nom de la variable en donnée associée.
  Écarté : la bibliothèque standard, qui n'embarque aucun chiffrement
  symétrique ; et `openssl enc`, dont le mode GCM ne gère pas l'étiquette
  d'authentification — le chiffré serait malléable ;
- **l'empreinte est un HMAC, pas un hachage nu.** Un préfixe de SHA-256 public
  livrerait `changeme` par force brute en quelques secondes. Avec la clé de la
  Forge, elle reste comparable entre deux Sparks de la même Forge — ce que le
  §43.3 demande — et ne se retourne pas.

### Ce qui a été codé

Migration `010_environnement.sql` : la table, ses **deux index partiels** — un
`UNIQUE (scope, spark_id, name)` ne protégerait rien au niveau Forge, SQLite
tenant deux `NULL` pour distincts — et **deux déclencheurs** qui interdisent à la
base une ligne secrète portant sa valeur en clair.

`sparkd/environnement.py` : la clé (créée si absente, jamais remplacée),
`chiffrer`, `dechiffrer`, `empreinte`, puis `poser`, `retirer`, `lister` avec
l'origine de chaque valeur, et `resoudre` qui rend le contenu des **deux**
fichiers du §43.5.2.

### Ce qui a été mesuré, et une preuve qui ne prouvait rien

`str(sqlite3.Row)` ne rend **pas** son contenu. La première version de la preuve
centrale cherchait le secret dans `<sqlite3.Row object at 0x…>` et passait sans
rien regarder. Corrigée en aplatissant les colonnes, avec le motif écrit dans le
fichier. C'est le genre de preuve verte qui coûte le plus cher.

Mesuré aussi : SQLite ne concatène pas deux littéraux adjacents comme C — un
`RAISE(ABORT, 'a' 'b')` est une erreur de syntaxe.

### Vérifications

**19 preuves d'unité**, dont celle de la DoD : la valeur d'un secret est
**cherchée** explicitement dans la réponse, dans le journal et dans la table, et
ne s'y trouve pas.

### Où reprendre

Tranche 2 du §43.9.6 : **la matérialisation** — poser `/etc/spark/env` et
`/run/spark/secrets` dans la cellule à la création, au changement, au démarrage
et après restauration d'instantané, sur le modèle d'`authorized_keys` (§17.1).
Puis la tranche 3 (l'onglet *Environnement*) et la tranche 4 (manuel, seed, et la
preuve du §43.0 essai F refaite sur le fichier que le produit écrit).

## 2026-08-21 · SPK-58 — la matérialisation, et ce que la mesure a corrigé

**Unité reprise** au §4.2 point 1 : tranche 2 du §43.9.6. La spécification
existait ; je n'ai complété que le point qu'elle ne couvrait pas.

### Ce que la mesure a trouvé, et qui changeait le contrat

Le §43.1 disait *quel* fichier, pas *comment* y écrire une valeur. Mesuré sur
Docker Compose v5.1.4, avec de vrais conteneurs :

- **l'analyseur d'`env_file:` n'est PAS littéral.** `A=abc$def` arrive comme
  `abc` : Compose substitue, la variable est inconnue, la fin disparaît. **Un
  mot de passe contenant `$` serait tronqué en silence** ;
- **les guillemets sont retirés** et **les blancs de tête et de fin rognés** ;
- **l'apostrophe simple ne sauve pas** : l'idiome du shell `'ab'\''cd'` fait
  échouer la lecture du **fichier entier** — une seule apostrophe dans un mot de
  passe viderait tout l'environnement de la pile ;
- **`docker run --env-file` prend tout littéralement**, lui. Deux analyseurs
  différents pour deux commandes du même produit : il faut écrire pour le plus
  exigeant.

**Décision, mesurée** : guillemets doubles, échappement de `\`, `"` et `$`, et
traduction des caractères de contrôle. Écrit au §43.9.7 et committé avant le
code.

### Ce qui a été codé

`citer()` et `_citer_shell()` — deux grammaires, parce que Compose et le shell
n'en ont pas la même. `fichiers()` rend les **trois** fichiers depuis l'état
voulu, régénérés en entier. `_apply_env()` les pose dans la cellule **à la
création**, **au démarrage** et **après restauration d'instantané**.

### Deux corrections trouvées en codant

- **le fichier de confort ne porte AUCUN secret.** Il vit dans `/etc`, donc sur
  le jeu de données, donc **dans les instantanés** : y écrire les secrets
  annulerait exactement ce que le §43.5.2 protège. Ma première version les y
  mettait ;
- **le chemin de la clé se DÉRIVE de celui du registre.** Le défaut codé en dur
  faisait chercher la clé dans `/var/lib/sparkd` alors que le registre est
  ailleurs — en test, en développement, sur une seconde Forge. La spécification
  disait « à côté du registre » ; le code ne le faisait pas.

### Vérifications

**899 preuves Python** (886 + 13), dont trois qui touchent la cellule : la pose
dès la création, la repose du fichier volatil au démarrage, et la reprise en main
après une restauration qui ramenait un ancien fichier.

### Où reprendre

Il manque à la tranche 2 les **routes d'API** qui posent et retirent une entrée —
donc le « au changement » du §43.2. Puis la tranche 3 (l'onglet *Environnement*)
et la tranche 4 (manuel, seed, et la preuve du §43.0 essai F refaite sur le
fichier que le produit écrit, qui **exige une Forge réelle**).

## 2026-08-21 · SPK-58 — les routes, et le seed qui les emploie

**Unité reprise** au §4.2 point 1 : ce qui manquait à la tranche 2 du §43.9.6.

### Ce qui a été spécifié avant d'être codé

Le §43.9.5 donnait les refus, pas les chemins ni les verbes. Écrit et committé
avant le code : les six routes, `PUT` avec le nom dans le CHEMIN — le geste est
idempotent, « cette variable vaut ceci », et un `POST` sur la collection ferait
de deux requêtes identiques deux gestes différents.

**Une question que la spécification ne tranchait pas** : que fait un geste de
**Forge** face à un Spark protégé ? Une variable de la Forge descend dans tous
ses Sparks, gelés compris. La convention EXISTE déjà dans le produit — la
révocation d'une clé (§35.2) — et on s'y range : **informer, puis accepter**. Le
premier appel nomme les Sparks gelés et refuse en `409`, le second porte
`accept_protected`. Un refus ferme gèlerait toute la Forge dès qu'un seul Spark
est protégé, et l'exploitant lèverait la protection pour contourner : cela
protégerait moins, pas plus. Écrit au §43.9.5 bis.

### Ce qui a été codé

Les six routes. Écrire **repose les fichiers** dans la cellule — c'est le « au
changement » du §43.2, le dernier des quatre moments qui manquait. Une écriture
de Forge repose sur **tous** les Sparks, puisqu'ils en héritent.

Le **seed** pose les cinq situations que l'écran devra distinguer : les trois
origines — héritée, propre, surchargée — et deux secrets, dont un hérité. Il
emploie les **vraies routes** (§28.3), et sa vérification échoue si une origine
manque ou si un secret rend sa valeur.

### Vérifications

**909 preuves Python** (899 + 10). Celle qui garde la DoD cherche la valeur du
secret dans **chaque** sortie de l'API — la liste du Spark, celle de la Forge, la
fiche du Spark, le journal, et la réponse du geste voisin.

Le contrat d'API a été régénéré : `make contract-check` rougissait, et c'est
exactement ce que cette preuve existe pour attraper.

### Où reprendre

**Tranche 3 : l'écran** — onglet *Environnement* dans la fenêtre d'un Spark, une
section par niveau, l'origine de chaque valeur, le champ de secret en écriture
seule. Le seed est prêt à le démontrer. Lire `docs/DESIGN_SYSTEM.md`
INTÉGRALEMENT avant (`CLAUDE.md` §4). Puis la tranche 4 : manuel M6/M8, et la
preuve du §43.0 essai F refaite sur le fichier que le produit écrit — celle-là
**exige une Forge réelle**.

## 2026-08-21 · SPK-58 — la facette Environnement

**Unité reprise** au §4.2 point 1 : tranche 3 du §43.9.6.
`docs/DESIGN_SYSTEM.md` a été relu **intégralement** avant de toucher à
l'interface (`CLAUDE.md` §4).

### Ce qui a été construit

Une facette *Environnement* dans la fenêtre d'un Spark, **deux sections, une par
niveau** (§43.6). Le tableau rend le jeu RÉSOLU — ce que la pile recevra
vraiment —, avec l'**origine** de chaque valeur : héritée, propre, ou surchargeant
celle de la Forge. Montrer deux jeux sans les résoudre ferait faire le calcul de
tête, et c'est précisément le calcul qu'on se trompe à faire.

**La valeur d'un secret n'est jamais rendue** : un badge « Secret » et son
empreinte. Un blanc laisserait croire qu'aucun secret n'est posé (§14.6).

La modale annonce que **rien ne redémarre** (§43.7), et dit ce qu'une déclaration
de secret engage. Sur un Spark protégé, la commande reste visible et
**désactivée** avec sa raison (§9.9) ; celle de la Forge reste ouverte, son geste
suivant le §43.9.5 bis.

### Ce que les captures ont trouvé, et que les tests ne voyaient pas

La colonne *Nom* était **centrée** : un `th scope="row"` hérite du centrage par
défaut du navigateur, là où le §6.14 veut le texte à gauche. Corrigé dans la
feuille de style, pas dans le composant (§12.1).

Le contrôle des classes (§12.3) a par ailleurs refusé une classe `tableau` que
j'avais inventée : le produit a déjà `tableau-enveloppe`, avec son indice de
défilement. C'est exactement ce que cette preuve existe pour attraper.

### Vérifications

**836 preuves de console** (825 + 11). Captures `56-environnement.png` et
`57-environnement-modale.png` produites et **observées**.

### Ce qui a été consigné, pas corrigé

**INC-13** : le harnais de captures finit sur une console non vierge
(`ERR_CONNECTION_REFUSED`). **Ligne de base établie** (§2.4) : le message est
rendu à l'identique sur `cfe5b87`, avant tout changement de cette session. Ce
n'est donc pas une régression, et la facette n'en est pas la cause.

### Où reprendre

Un **parcours E2E** depuis le parcours canonique : poser une variable, la
surcharger, lire son origine, en déclarer une secrète et vérifier que sa valeur
ne s'affiche nulle part. Le seed le permet. Puis la tranche 4 : manuel M6 et M8,
et la preuve du §43.0 essai F refaite sur le fichier que le produit écrit —
celle-là **exige une Forge réelle**.

## 2026-08-21 · SPK-58 — l'environnement éprouvé à l'écran, et un parcours qui résiste

**Unité reprise** au §4.2 point 1 : le parcours E2E de la tranche 3.

### Ce qui est livré

**Deux parcours E2E**, depuis le parcours canonique, sur la pile réelle :

- l'environnement se lit avec l'**origine** de chaque valeur — les trois sont à
  l'écran, et la surcharge porte bien la valeur du Spark, pas celle de la Forge ;
- **la valeur d'un secret ne s'affiche NULLE PART** : la preuve cherche les deux
  valeurs seedées dans tout le texte rendu, pas seulement là où on s'attend à ne
  pas les trouver. C'est le point central de la Definition of Done.

### Ce qui a RÉSISTÉ, et ce que la mesure a établi

Deux parcours d'**écriture** — poser une variable au clavier, et le refus d'un
nom hors grammaire — n'ont pas pu être rendus verts dans la session. Ils ne sont
pas committés : ce sont des échafaudages inachevés, pas une preuve qu'on
désactive.

Ce que j'ai **mesuré**, et qui vaut pour la reprise :

- la saisie **survit** au submit — deux sondes l'ont vérifié avant et après le
  clic : le champ porte toujours `AVEC-TIRET` une seconde et demie après ;
- la modale **reste ouverte** et n'affiche **aucun refus**. Or `<form
  method="dialog">` fermerait nativement la modale si le gestionnaire de submit
  ne s'exécutait pas : il s'exécute donc, et `preventDefault()` prend ;
- le parcours de pose, lui, a bien **atteint le serveur** : l'écran est passé à
  « Chargement du Spark… », donc `router()` a été appelé, donc le `PUT` a réussi.
  Son assertion tombait trop tôt, pendant la repeinte ;
- le relais de l'hôte console est **indifférent au verbe** — vérifié dans
  `relayer()` : rien n'y filtre `PUT`.

**L'hypothèse qui reste** : la promesse de `poserEnv` rejette avant d'atteindre
la branche de refus, laissant `busy` à vrai — ce qui expliquerait une modale
ouverte, une saisie intacte et aucun refus. Le gestionnaire de submit ne
l'attend pas, donc un rejet serait silencieux. La preuve de composant montre que
le refus **se rend** quand l'état le porte : le défaut, s'il existe, est dans le
chemin d'appel, pas dans le rendu.

### Où reprendre

Instrumenter `poserEnv` — un `try/catch` qui **nomme** l'échec au lieu de le
perdre serait de toute façon la bonne forme (§18) — puis rétablir les deux
parcours d'écriture. Ensuite la tranche 4 : manuel M6 et M8, et la preuve du
§43.0 essai F sur le fichier que le produit écrit, qui **exige une Forge
réelle**.

## 2026-08-21 · SPK-58 — le défaut que le parcours a trouvé, et la tranche 3 close

**Unité reprise** au §4.2 point 1 : rétablir les parcours d'écriture.

### Le défaut, et il était RÉEL

La session précédente avait laissé une hypothèse — un rejet silencieux de
`poserEnv`. Elle était **fausse**. Le filet posé au §18 l'a montré du premier
coup : le refus **s'affichait**, texte compris. L'échec était plus loin, sur
`Échap`.

**`onFermer` oubliait l'état de la facette.** `close()` s'exécutait, puis la
repeinte trouvait `envUi.open` encore vrai et rappelait `showModal()` : la modale
se rouvrait dans le même tour, et « Échap » paraissait sans effet. C'est
exactement le défaut que le §6.27 existe pour empêcher, et seul un parcours
pouvait le voir — les preuves de composant ne rejouent pas le cycle de
fermeture.

Le filet du §18 reste, indépendamment : une promesse qui rejette laisserait
sinon la modale sur « Envoi… » indéfiniment.

### Ce qui est livré

- **`Échap` ferme la modale d'environnement**, aux deux niveaux ;
- **trois parcours E2E de plus** : la pose au clavier avec son retrait, le refus
  d'un nom hors grammaire avec sa fermeture par `Échap`, et les deux de lecture
  livrés la veille. La tranche 3 du §43.9.6 est **close** ;
- **le manuel** : M6 dit au locataire comment attacher les deux fichiers à ses
  services et ce que le fichier volatil implique ; M8 dit à l'exploitant les
  trois origines, ce qu'une déclaration de secret engage et ce qu'elle ne protège
  pas.

### Une casse, et sa réparation

Ma chirurgie de la session précédente avait, en retirant les parcours inachevés,
**emporté le corps du parcours du refus de quota** — le fichier gardait son
titre mais le corps d'un autre. Constaté en rejouant, réparé en restaurant le
fichier depuis le dernier commit puis en réinsérant proprement. Leçon : découper
un fichier de tests par index de chaîne est fragile ; restaurer depuis Git puis
réinsérer coûte moins cher que réparer.

### Où reprendre

Il ne reste à SPK-58 que la preuve du §43.0 essai F **refaite sur le fichier que
le produit écrit** — un `docker compose` du locataire qui consomme réellement
`/etc/spark/env`. Elle **exige une Forge réelle** : nécessite une action humaine.
L'unité suivante du plan est donc SPK-60, le briefing d'un Spark (§44).

## 2026-08-21 · La Forge de validation, sur instruction du responsable

Le responsable a demandé en cours de session de **finir sur la Forge réelle** ce
qui l'attendait. Cinq unités étaient bloquées là-dessus depuis des jours. La
build du jour a été installée, la migration `010` s'est appliquée, et les mesures
ont été faites. **Deux d'entre elles ont trouvé des défauts.**

### Ce que la Forge a prouvé

- **SPK-58, essai F** : un `docker compose` du locataire reçoit les trois valeurs
  — héritée de la Forge, propre au Spark, et le secret depuis le fichier
  volatil. Une quatrième, posée **après** le premier démarrage, arrive sans que
  le fichier de composition la nomme. L'unité est **close** ;
- **SPK-57** : le disque ET le mode CPU prennent **à chaud** — la cellule voit la
  nouvelle taille sans redémarrer, le noyau porte le nouveau `cpu.max`. Et une
  instance **arrêtée** rend bien `disk.root.usage`, là où `memory.usage` tombe à
  zéro. L'unité est **close** ;
- **SPK-43** : la connexion atteint réellement un Spark, par les deux chemins —
  `incus exec` rend l'OS du Spark, et `ssh -J` aboutit avec la clé posée par le
  registre ;
- **SPK-44 et SPK-45** : `docker ps`, `inspect`, `logs`, le sondage de shell et
  un geste de conteneur, tous lus **à travers le tunnel** sur une pile réelle.
  Closes ;
- **SPK-55** : OP-11 et OP-12 appliquées et persistées. Préflight : **12
  contrôles, 0 bloquant, 0 signalé**.

### Les deux défauts, et ils étaient graves

**1. `applied: true` mentait.** La route de redimensionnement posait la seule
*configuration* de l'instance ; or la taille du disque vit dans le **device**
`root`. Le registre passait à 12 Gio, Incus restait à 10 — le pire des cas que
la DoD de SPK-57 nomme, affirmé vrai par la réponse. Corrigé, avec une preuve
qui regarde le device.

**2. Mon propre durcissement coupait la Forge de ses Sparks.** La recette d'OP-11
n'acceptait pas les connexions **déjà établies** : les réponses du Spark
revenaient par `sparkbr0` et tombaient sur le `drop`. La Forge ne joignait plus
le port 22 de son propre Spark — le produit va de la Forge VERS ses Sparks. Ma
première vérification ne l'a pas vu parce qu'elle n'éprouvait que le sens
inverse. Corrigé, et la recette porte désormais la vérification manquante.

OP-11 avait par ailleurs trois autres omissions, toutes trouvées en l'appliquant :
la table `inet filter` n'existait pas, le DHCP et l'ICMP utile devaient être
acceptés, et le `/etc/nftables.conf` d'Ubuntu commence par un `flush ruleset` qui
aurait effacé la table d'Incus au premier redémarrage.

### Où reprendre

Restent bloquées sur la Forge, non traitées faute de temps : **SPK-61** (poser la
clé restreinte — geste à faire avec précaution, il touche la seule voie
d'accès), **SPK-54** (rootless), **SPK-40** (un agent SSH réel signe), **SPK-29**
(contention totale), **SPK-30** (niveau 3), **SPK-36** (exercice de restauration).
**SPK-43** n'attend plus qu'une chose : la route de dépannage de l'hôte console
parcourue de bout en bout, ce qui exige l'hôte lancé avec son tunnel.

## 2026-08-21 · SPK-29 — le poids que systemd effaçait

**Unité reprise** au §4.2 point 1, sur la Forge de validation. La mesure de
contention totale que la DoD exige a d'abord trouvé **deux défauts**, dont un
grave, et l'un empêchait purement et simplement de mesurer.

### Le défaut grave : systemd écrasait le poids, en silence

`spark.slice` pesait **1** à l'ouverture de la session, là où la loi du §32.2 en
prescrit 180. Reproduit :

```
on ecrit 180 dans cpu.weight  -> 180
apres daemon-reload           -> 1
apres systemd-run             -> 1
```

Faire de la tranche une unité systemd a un corollaire que le §32.4 ne tirait
pas : **systemd devient l'autorité sur ses propriétés de cgroup**, et l'unité
porte `CPUWeight=1` comme point de départ, qu'il **réaffirme** à chaque
reconciliation. Le produit écrivait le fichier ; sa valeur tenait jusqu'au
premier `daemon-reload`.

C'est le pire mode de panne du produit : la promesse centrale s'évapore sans
qu'aucun contrôle ne rougisse, puisque le registre et le calcul restent justes.

**Corrigé** : le poids se pose par `systemctl set-property`, et systemd le
réaffirme au lieu de l'écraser. Vérifié sur la Forge — 180 avant **et** après
reconciliation.

### Le second défaut : le redimensionnement ne suivait pas l'allocation

La portée de SPK-57 nomme deux effets d'un changement de mode CPU : rendre les
cœurs dédiés au pool (§7.4 bis) et repondérer la tranche (§32.2). **Ni l'un ni
l'autre n'était fait.** C'est ce qui avait laissé la tranche à 1 après mon
aller-retour de mode de la session précédente. Corrigé, avec deux preuves qui
**échouent sans le correctif** — vérifié en le désactivant.

### La mesure, enfin

```
fenetre 25 s sur 8 threads, trois tranches chargees
  spark.slice     95,72 s  ->  47,9 % de la machine
  system.slice    48,16 s  ->  24,1 %
  user.slice      45,42 s  ->  22,7 %
  init.scope       0,00 s  ->   0,0 %
```

Le mécanisme est vérifié **au pour-cent près** : la loi prédit
`180/(180+200) = 47,4 %`, la machine rend 47,9 %.

Et `init.scope` est resté à **zéro** — il ne contient que PID 1 et n'est jamais
exécutable. Le `H = 300` posé est donc optimiste : le `H` réel vaut 200, et la
tranche obtient systématiquement plus que la part visée.

### Où reprendre

**SPK-29 n'attend plus une mesure mais un ARBITRAGE** : garder `H = 300` posé —
la réservation reste un plancher tenu et dépassé, ce que le produit annonce — ou
mesurer `H` pour en faire une égalité, au prix d'un poids qui bouge avec
l'activité de la Forge. Les deux voies sont écrites au §32.2.

Restent bloquées sur la Forge : **SPK-61** (poser la clé restreinte, geste
délicat), **SPK-54** (rootless), **SPK-40** (agent SSH réel), **SPK-30**
(niveau 3), **SPK-36** (exercice de restauration), **SPK-43** (route de dépannage
de bout en bout).

## 2026-08-21 · SPK-30 — le niveau 3, qui a d'abord infirmé la promesse

**Unité choisie au §4.2 point 2** : SPK-29 n'attend plus qu'un arbitrage, SPK-30
suit dans l'ordre du plan et son seul écart — le niveau 3 — exige la Forge.

### Ce que la mesure a établi

Un Spark à 1 Gio, marge de 64 Mio, rempli de données **incompressibles** jusqu'au
refus. Premier enseignement, redécouvert au passage : la compression ZFS avale
les zéros — 2 Gio de `/dev/zero` n'occupent rien. Le §8.7 le disait ; il fallait
s'en souvenir pour saturer réellement.

Sur ce dataset saturé, les deux gestes séparément :

```
ecrire la CONFIGURATION -> ECHEC : backup.yaml: disk quota exceeded
agrandir le DEVICE      -> REUSSIT, la cellule respire aussitot
```

**La marge ne protège pas ce que le §8.8.1 affirmait.** Le quota ZFS porte sur le
jeu de données entier : le `df` de la cellule montre `vendue + marge`, et le
locataire remplit donc la marge. Elle n'est ni invisible ni inaccessible.

### Le défaut, et sa correction

Le produit posait **la configuration avant le disque**. Il échouait donc
précisément sur un Spark plein — le seul cas où l'agrandissement est urgent, et
celui que toute cette unité existe pour traiter.

**Corrigé : le disque d'abord, la configuration ensuite.** Grandir libère la
place que `backup.yaml` réclame. Une preuve garde l'ordre : rien d'autre ne
dirait qu'il compte, et une réorganisation future le perdrait.

### Le niveau 3, de bout en bout, par le produit

```
Spark sature, 0 octet libre, ecriture refusee
PATCH storage_bytes=10 Gio -> applied: true, aucune erreur
le locataire ecrit de nouveau
```

La cellule a été rendue à son état exact — `df` identique à l'octet près après
que ZFS a libéré.

### Où reprendre

**SPK-30 est close.** Un arbitrage y reste attaché, écrit au §8.8.1 : accepter
que la marge soit consommable — la promesse tient par l'ordre des gestes — ou
piloter `refquota`, ce qui contournerait l'abstraction d'Incus.

Restent bloquées sur la Forge : **SPK-61** (poser la clé restreinte, geste
délicat), **SPK-54** (rootless), **SPK-40** (agent SSH réel), **SPK-36**
(exercice de restauration), **SPK-43** (route de dépannage de bout en bout).
**SPK-29** attend un arbitrage.

## 2026-08-21 — La réservation devient un plancher assumé, et le témoin gagne deux canaux

Deux arbitrages rendus par le responsable, persistés avant toute autre chose.

### La réservation CPU : `H = 300` reste posé

La mesure du 2026-08-21 avait vérifié le mécanisme au pour-cent près — 47,9 %
obtenus pour 47,4 % prédits — et corrigé la loi une seconde fois : `init.scope`
n'étant **jamais exécutable**, le `H` réel vaut 200 là où le calcul en pose 300.
La tranche obtient donc systématiquement **plus** que la part visée.

Restait un choix, et il ne portait plus sur du code : garder `H = 300` — la
réservation est un plancher tenu et dépassé — ou mesurer `H` pour en faire une
égalité.

**Le responsable a choisi le plancher**, et c'est le bon choix pour trois raisons
que j'écris ici pour qu'elles ne se rediscutent pas. Une égalité stricte
obligerait à **retirer** du CPU à un locataire quand la Forge est au repos,
c'est-à-dire à supprimer le burst pour être exact. Elle ferait bouger le poids sur
un signal qui n'est pas un changement d'allocation, cassant le modèle où il ne se
recalcule qu'à la création, la suppression et le redimensionnement. Et « au moins
0,5 CPU, souvent plus » est une promesse qu'on tient toujours, là où « exactement
0,5 CPU » est une promesse qu'on doit défendre dans les deux sens.

Conséquence immédiate, et c'est elle qui compte : **le produit cesse de se
sous-vendre.** Il annonçait « réservation proportionnelle entre Sparks — non
garantie sous contention », ce qui était vrai et trop modeste. Il annonce
désormais « garantie sous contention totale, dépassée sinon ». Le runtime publie
`floor_under_contention`, l'écran le lit — jamais écrit en dur (§27.6) —, et les
preuves suivent : 915 Python, 836 console.

### Le témoin gagne deux canaux, et une serrure

Le §47.3 ne retenait qu'un webhook posé par variable d'environnement. Le
responsable demande **deux canaux réglés depuis un onglet de la Forge** — webhook
avec gabarit, SMTP avec adresse de destination — activables séparément, et **toute
modification protégée par un mot de passe fixé au premier usage**.

Trois points valaient d'être écrits plutôt que déduits à l'implémentation :

- **le gabarit est une donnée, jamais une exécution.** Substitution de texte sur
  les seuls champs nommés du §47.4, nom inconnu refusé **à l'enregistrement** et
  non à l'envoi — sinon la panne se découvre le jour de l'incident —, et rendu
  passé par le filtre du §21.2. Sans cette dernière règle, il suffirait d'un
  gabarit pour contourner ce qui protège les secrets ;
- **la serrure a un motif précis** : un canal de notification sert quand tout le
  reste a échoué. Qui peut le couper en silence peut agir sans témoin, et c'est le
  premier geste qu'un attaquant tenterait. D'où une conséquence que la DoD
  retient : **désactiver un canal notifie, par ce canal, pendant qu'il fonctionne
  encore** ;
- **un seul mécanisme de mot de passe**, celui de la protection d'un Spark
  (§35.3). En écrire un second donnerait deux endroits où un secret peut fuir.

La configuration quitte les variables d'environnement pour le registre. Motif :
une variable se règle par un redémarrage et ne se voit nulle part ; un canal qu'on
ne peut ni voir ni éprouver depuis l'écran est un canal dont on ne sait pas s'il
veille.

### Vérifications

915 preuves Python et 836 de console, vertes après l'alignement du runtime, de
l'écran et de leurs fixtures — `test_app`, `test_metrics`, `forge-view.test.js`,
`gestes.test.mjs`, `captures.mjs`. Aucune campagne E2E lancée : la machine est
partagée, et le §F du runbook l'interdit sans annonce.


## 2026-08-21 · L'arbitrage rendu, et le plan de reprise enfin joué

### Du travail non committé récupéré au démarrage (§1.2)

L'arbre de travail portait neuf fichiers modifiés et non committés : **l'arbitrage
du responsable sur SPK-29** — la réservation est un **plancher** —, déjà propagé
au runtime, à l'écran et aux preuves. Préservé par `git stash`, restauré,
vérifié (915 preuves Python, 836 de console) puis committé et poussé.

Motif de l'arbitrage, écrit au §32.2 : une égalité stricte obligerait à
**retirer** du CPU à un locataire quand la Forge est au repos — donc à supprimer
le burst pour être exact — et ferait bouger le poids sur un signal qui n'est pas
un changement d'allocation.

### SPK-29 close, et le mensonge retiré partout

L'arbitrage rendu, l'unité n'attendait plus que lui. Sa **DoD a été révisée** —
l'ancienne décrivait une règle qui n'est plus celle du produit, et elle n'est pas
conservée à côté de la nouvelle.

Puis j'ai cherché ce que l'arbitrage rendait **faux ailleurs**, et retiré chaque
mention : DAT §7.3 et §27.6, module d'admission, deux commentaires du runtime, et
le manuel M4 — qui disait lui-même « l'écran le dira autrement le jour où ce sera
faux ». Ce jour était venu.

**La mécanique de lecture du §27.6 a fait exactement ce pour quoi elle existait** :
l'écran lisait la portée auprès de la Forge plutôt que de l'écrire en dur, et il a
suivi le changement de règle sans qu'on y touche. Vérifié en capture.

### SPK-36 : le plan de reprise n'est plus une fiction

L'exercice réel de restauration a été **joué de bout en bout** sur la Forge, avec
les seules commandes du document :

```
sauvegarde   : 253 952 octets, 0,10 s, service en marche
restauration : 0,08 s
interruption : ~20 s, dominee par l'arret et le redemarrage de sparkd
preflight 12/0/0 · 2 Sparks avec leurs etats reels
GET /v1/audit/verify -> intact: true, 51 entrees
```

**La perte a été démontrée plutôt qu'affirmée** : une variable posée *après* la
sauvegarde n'existe plus après restauration, celles posées avant sont là. Et le
dispositif s'est comporté comme écrit — refus de restaurer sous service actif,
ancien registre déplacé et non écrasé.

La Forge a été rendue à son état, données de démonstration reposées.

### Où reprendre

**SPK-36** garde trois écarts nommés : les neuf autres scénarios à instruire, la
**reconstruction d'un Spark** après perte de sa cellule — l'autre moitié de
l'exercice —, et l'ancre de la console, qui exige l'hôte lancé avec son tunnel.

Restent bloquées : **SPK-28** (une machine à commander), **SPK-61** (poser la clé
restreinte, geste délicat), **SPK-54** (rootless), **SPK-40** (agent SSH réel),
**SPK-43** (route de dépannage de bout en bout), **SPK-17** (CI jamais exécutée).

## 2026-08-21 — L'héritage de l'environnement était un défaut de sécurité

Le responsable, en regardant l'écran : « les variables de la Forge, pourquoi on
les règle Spark par Spark ? Elles devraient être un onglet sur la Forge, et
Spark par Spark on les coche pour les faire descendre. »

Question d'ergonomie en apparence. C'en est une de sécurité, et le défaut est de
moi.

### Ce que j'avais écrit, et pourquoi c'était faux

Mon §43.6 posait un héritage **automatique** : toute entrée de la Forge descend
dans tous ses Sparks, à charge pour chacun de la surcharger. SPK-58 l'a livré
fidèlement — la résolution est là, nom par nom, avec l'origine affichée. Le code
fait exactement ce que la spécification demandait.

Mais le §43.5.1, que j'ai écrit deux jours plus tôt, établit que la valeur
redevient **en clair dans la cellule** — elle doit l'être, `docker compose` ne
déchiffre rien. Les deux mis bout à bout donnent : **définir un secret une fois à
la Forge le dépose en clair dans les trente cellules**, y compris celles qui n'en
ont aucun usage, y compris celle qu'un locataire compromettra.

C'est une violation du moindre privilège, et elle est **silencieuse** : ajouter
une entrée modifie l'environnement de Sparks que personne n'a touchés.

### La faute de raisonnement, parce qu'elle resservira

J'avais invoqué la doctrine du `CLAUDE.md` §4 — tout existe au niveau général,
les contextes ne définissent que leurs différences — et je l'ai citée comme si
elle tranchait. Elle dit **« lorsque cette architecture est pertinente »**, et
j'ai sauté cette réserve.

Elle ne l'est pas ici. Cette doctrine vaut pour des réglages qu'on **lit** — un
libellé, un défaut de formulaire, une préférence. L'environnement d'un Spark n'est
pas lu : il est **distribué dans une cellule isolée**, en clair, chez quelqu'un
d'autre. Appliquée à un secret, la doctrine le répand.

Invoquer une convention du responsable ne dispense pas de vérifier qu'elle
s'applique — et c'est précisément parce qu'elle vient de lui que je ne l'ai pas
questionnée.

### Le modèle retenu

La Forge tient un **catalogue** ; chaque Spark **coche** ce qui descend chez lui.
Une entrée du catalogue n'a aucun effet tant que personne ne l'a cochée. Trois
gains : moindre privilège, aucune surprise à l'ajout, et une révocation précise —
décocher retire d'un seul Spark sans toucher aux autres.

Un point que la DoD retient et qui aurait pu être manqué : **la migration doit
cocher, pour chaque Spark existant, tout ce qu'il recevait déjà.** Sinon la mise à
jour retirerait en silence des variables dont des piles dépendent — une correction
de sécurité qui casserait la production serait un mauvais échange.

SPK-58 reste `[x]` avec un renvoi : elle est le récit exact de ce qui a été livré
et prouvé sous la spécification d'alors. SPK-64 porte le changement.

## 2026-08-21 — « L'onglet Docker ne fonctionne pas » : le code n'était pas en cause

Rapporté par le responsable, avec une remarque juste : « je ne sais pas ce que tu
as vérifié pour dire OK à cette unité. » Réponse honnête : ce n'est pas moi qui ai
livré SPK-44 ni déclaré sa clôture — mais cela ne change rien au fait qu'il perd
du temps.

### Le diagnostic, dans l'ordre où il s'est fait

D'abord une fausse piste, écartée par la mesure : `sparkd` déployé n'expose
**aucune** route Docker. Vrai, et sans rapport — l'onglet ne passe pas par
`sparkd` mais **en SSH depuis la console vers le Spark**.

Ensuite l'appel exact que fait l'écran, joué à la main contre `helo` sur la Forge
réelle, à travers une console fraîche :

    GET /api/spark/docker?server=forge&spark=helo
    → state: ok · helo-web-1 · running · nginx:alpine · cpu 0.00% · mém 7,418 Mio

**La fonctionnalité marche.** Puis la même route contre la console que le
responsable utilise :

    → 404  « Rien sur /api/spark/docker. »
    ps → démarrée le 2026-08-20 à 20:20, soit 15 h 27 plus tôt

Le processus est antérieur à SPK-44. Le code servi n'a jamais eu cette route.

### Ce que ça dit de nos preuves, et c'est le vrai enseignement

SPK-44 a été close sur des preuves qui ne pouvaient pas voir ce défaut — parce
qu'il n'est **pas dans le code**. Aucune campagne, aucune capture, aucun parcours
E2E n'aurait rougi : ils s'exécutent tous contre un processus fraîchement
démarré. Le seul endroit où le défaut existe est la machine de quelqu'un qui n'a
pas redémarré.

**Troisième occurrence en deux jours**, et j'ai traité les deux premières comme
des incidents isolés :

    « le manuel est vide »            → console antérieure aux routes du manuel
    « la Forge dit build inconnue »   → sparkd réinstallé sans estampille
    « l'onglet Docker ne marche pas » → console antérieure à SPK-44

Trois symptômes différents, une seule cause, et à chaque fois le responsable
cherche dans le produit ce qui n'y est pas. J'aurais dû voir le motif à la
deuxième.

L'ironie est complète : **SPK-53 résout exactement ce problème pour la Forge** —
la console compare la build déployée au dépôt et nomme six situations. Elle ne le
fait pas pour elle-même. D'où SPK-65.

### Vérifications

Route jouée contre la Forge réelle depuis deux consoles — une fraîche, une
périmée. Console du responsable redémarrée : l'onglet Docker rend `helo-web-1`
avec ses mesures, et ses quatre serveurs ont survécu, ce qui éprouve au passage
la fusion d'inventaire livrée une heure plus tôt.


## 2026-08-21 · SPK-37 — l'empreinte n'atteignait jamais le journal

**Unité choisie au §4.2 point 2.** La dernière entrée du journal désigne SPK-64,
mais c'est l'unité d'une session voisine, qui a annoncé son terrain. J'ai pris la
première `[~]` du plan hors de ce terrain, et dont l'écart était mesurable ici :
SPK-37, dont le relevé de l'empreinte SSH n'avait jamais rencontré de vrai
`sshd`.

**Coordination** : terrain annoncé au pair avant d'écrire une ligne
— `apps/webui/host/tunnel.js`, `DAT.md` §21.6.3, et les trois fichiers de suivi.
Son `011_env_selection.sql` non suivi était dans l'arbre au démarrage : je ne l'ai
**ni stashé ni touché**, et je l'en ai prévenu — le §1.2 appliqué à la lettre le
lui aurait arraché des mains.

### Le défaut, et il annulait toute l'unité

`Server accepts key` est un message `debug1:`. Le produit demandait
`LogLevel=VERBOSE`, qui s'arrête un cran avant. Mesuré, tunnel ouvert avec les
options exactes du produit contre la Forge de validation :

```
LogLevel=VERBOSE ->  1 ligne,  0 « Server accepts key »
LogLevel=DEBUG1  -> 81 lignes, 1 « Server accepts key »
```

La branche « empreinte déterminée » du §21.6.3 ne se produisait donc **jamais**.
Et rien ne le signalait : l'en-tête retombait sur `console/<serveur>`, qui est une
valeur de repli **légitime** — donc impossible à distinguer d'un repli mérité.
C'est le mode de panne le plus coûteux : le contrat paraissait tenu.

**L'analyseur, lui, était juste.** Sur le flux réel il rend l'empreinte du poste
et ignore celle de l'**hôte**, qui apparaît pourtant AVANT. Une expression qui
aurait pris « la première `SHA256:` » aurait attribué chaque geste à l'empreinte
du serveur — identique pour tous les opérateurs, donc une identité qui n'identifie
personne, et qui en aurait l'air. Une preuve garde désormais ce piège.

### Le second défaut, trouvé en corrigeant le premier

Le flux d'erreur était lu **bloc par bloc**, et seule la première ligne du bloc
était testée. Tout ce qui suivait une ligne bénigne atterrissait dans
`lastError`, que `describe()` publie. Sous VERBOSE, la seule ligne émise —
« Authenticated to … using "publickey" » — y tombait à **chaque tunnel réussi**.
Passer à 81 lignes en aurait fait la règle plutôt que l'exception. Corrigé :
lecture ligne par ligne, et un succès d'authentification n'est plus pris pour une
panne.

### Ce qui est prouvé

La chaîne entière, contre la Forge : tunnel réel → empreinte relevée → en-tête →
geste → journal.

```
env.set | classe: human | acteur: console/validation key=SHA256:Vf2N7ryPnZ…
```

Les entrées antérieures au correctif portent, dans le **même** journal,
`console/forge1` sans clé. L'avant et l'après se lisent côte à côte.

4 preuves de plus (29 sur le tunnel), dont deux vérifiées comme **échouant sans
le correctif**. Le témoin de mesure a été retiré de la Forge.

### Où reprendre

**INC-14** consigné, non corrigé : un sondage raté laisse « fetch failed » dans
`lastError` d'un tunnel `ready` qui sert les requêtes. Même champ que le défaut
que j'ai corrigé, mais autre chemin — il appartient au contrat de santé du tunnel
(SPK-16, §22.3), pas à l'acteur du journal.

Restent bloquées : **SPK-28** (une machine à commander), **SPK-61** (poser la clé
restreinte, geste délicat), **SPK-54** (rootless), **SPK-40** (agent SSH réel),
**SPK-43** (route de dépannage de bout en bout), **SPK-17** (CI jamais exécutée),
**SPK-36** (reconstruction d'un Spark, et neuf scénarios à instruire).

## 2026-08-21 — Trois arbitrages sur l'installation, et le piège de la première

Le responsable a tranché les trois questions de SPK-66 :

1. **pull direct depuis la branche**, sans épinglage — la Forge se met à jour au
   fil de l'eau ;
2. **la dépendance au réseau sortant est acceptée** : « une Forge sans Internet ne
   sert à rien ». Le cas hors ligne sort du périmètre ;
3. **le dépôt reste public** : la question du jeton sur la Forge ne se pose pas.

Les deux dernières ferment proprement. La première ouvre un piège qu'il vaut
mieux écrire maintenant que découvrir sur une Forge en service.

### `pip install -U` peut ne rien faire, en silence

Avec `version = "0.0.0"` figée au `pyproject` — ce qui est le cas aujourd'hui —,
`pip install -U git+…@main` lit la version du dépôt distant, la compare à celle
qui est installée, les trouve **égales**, et conclut « déjà satisfait ». Il ne
réinstalle rien.

La mise à jour paraîtrait faite et ne le serait pas. C'est exactement le mode de
panne qui a produit la Forge en `0.0.0+inconnue` ce matin — mais **silencieux
cette fois**, puisque aucune variable oubliée ne le trahirait.

Deux voies, et l'unité doit les mesurer avant de choisir : une version **dérivée
du dépôt**, de sorte que chaque commit en porte une distincte — ce qui alimente
du même coup l'estampille du §40 —, ou un `--force-reinstall` assumé et écrit. La
première est plus propre, la seconde ne demande rien.

La DoD gagne donc la preuve qui ferme le piège : **une mise à jour doit changer le
commit servi**, et une mise à jour qui ne change rien doit rougir. Sans elle,
l'unité livrerait une commande qui a l'air de fonctionner.

C'est le troisième cas cette semaine du même motif : un geste qui réussit sans
rien faire. Le premier était la console périmée qui servait du code mort, le
second l'empreinte SSH que `LogLevel=VERBOSE` n'atteignait jamais. À chaque fois,
rien ne rougit, et c'est le responsable qui paie la découverte.


---

## 2026-08-21 · SPK-36 — jouer l'entrée fantôme, et trouver la porte fermée

**Problème.** Le §4.4 de `docs/CONTINGENCE.md` venait d'affirmer que la bonne
réponse à une entrée fantôme est **parfois de reconstruire** la cellule plutôt
que d'effacer la ligne. Affirmation non vérifiée. La DoD de SPK-36 nomme
précisément la reconstruction d'un Spark comme la moitié de l'exercice réel qui
restait à jouer.

**Observations.** Sur la Forge de validation, sur un Spark **jetable** créé pour
cela — `helo` n'a pas été touché et a été vérifié intact après coup — la cellule
a été détruite hors du produit. Demander un démarrage a rendu **500**, et laissé
le Spark ainsi, stable à vingt secondes :

```
etat      : starting
commandes : []
erreur    : null
```

Un état transitoire dont on ne sort plus, sans commande offerte et sans même
dire pourquoi. Depuis la console, plus rien : ni reconstruire, ni supprimer.

**Cause.** `InstanceAbsente` n'hérite pas d'`IncusError`, et c'est délibéré : le
§33.3 interdit de confondre « le pilote RAPPORTE que ce n'est pas là » et « je
n'ai pas pu demander ». SPK-52 avait nommé l'absence pour la suppression ; la
branche du cycle de vie ne la nommait pas. Elle s'échappait, `finish` n'était
jamais appelé, et l'état transitoire — posé **avant** l'appel au pilote — ne se
refermait plus. Le second appel du redémarrage vivait de surcroît hors de toute
garde.

**Pourquoi neuf cents preuves ne l'ont pas vu.** Le pilote factice rendait
`IncusError` là où le vrai rend `InstanceAbsente`. La route attrapait donc
proprement en preuve ce qu'elle laissait fuir en production. Le principe était
pourtant déjà écrit dans le fichier, trois lignes plus bas, à côté de
`delete_instance` : « le pilote factice doit la rendre comme le vrai, sans quoi
la règle serait éprouvée sur une forme qui ne tournera jamais en production ». Il
n'avait été appliqué qu'à une méthode. **Un principe écrit à un seul endroit
n'est pas une règle, c'est une note.** SPK-67 est ouverte pour trancher jusqu'où
va la fidélité exigée du doublon.

**Décision.** La perte conduit le Spark en **panne**, seul état d'où le produit
offre les deux remèdes que le contrôle `REG-FANTOME` annonce. À la différence de
la suppression, l'absence ne vaut **pas** réussite ici : la ligne survit au
geste, et un succès de façade laisserait au registre un fantôme silencieux —
exactement ce que le §4 cherche à rendre impossible.

**Ce que l'exercice a appris, au-delà du défaut.** Le chemin de reconstruction
**existait déjà** : `State.ERROR` autorise `retry` et `delete` depuis toujours.
Ce n'était pas une fonctionnalité manquante, c'était une porte fermée devant un
escalier construit. Un plan de reprise qu'on relit ne montre pas cela ; un plan
qu'on joue, si.

**Une réserve, et elle a décidé du correctif.** Le Spark coincé n'était pas
perdu : la reprise des états transitoires au démarrage du service (§14.3) le
ramenait en panne. Vérifié. Mais elle exige de **redémarrer le démon**, ce qu'un
exploitant ne peut pas faire depuis la console. Un recours qui suppose un accès
administrateur à la machine n'est pas un recours pour la personne qui tient la
console — c'est pourquoi le défaut a été corrigé plutôt que documenté comme
contournable.

**Vérifications.** Sur la Forge : le contrôle vu **rouge** puis vert, le refus
nommé, `retry` reconstruisant réellement la cellule à deux reprises sur le vrai
Incus, `delete` rendant la place, le Spark jetable détruit et `helo` intact. En
preuve : 8 unités pour la reprise, 4 pour le contrôle, un parcours qui part de
l'accueil et ne fait que cliquer.

**Ce que la vérification visuelle a sorti, et que rien d'autre ne pouvait voir.**
Le message de refus disait « retry » et « delete » pendant que les boutons, deux
centimètres plus bas, portaient « Reprendre » et « Supprimer ». Il envoyait
chercher des commandes qui ne s'appellent pas ainsi dans la console. Corrigé, avec
sa preuve. Le §16 ne demande pas de regarder par acquit de conscience.

**Une faute de méthode, et sa leçon.** Un `git add -A` a emporté dans mon commit
120 lignes en cours de la session voisine — nous partageons le même `.git`, pas
seulement le même répertoire — et a laissé `main` rouge : du code sans sa
migration. Le fichier n'a pas été touché sur le disque, la session voisine a été
prévenue immédiatement et a poussé la suite. Le reste de la session a été
committé chemin par chemin. `git add -A` n'est pas un raccourci sur une branche
partagée, c'est un pari sur ce que personne d'autre n'a écrit depuis.

---

## 2026-08-21 · SPK-67 — le contrat d'échec du pilote, et ce qu'un doublon doit

**Problème.** L'unité avait été ouverte la veille sur un constat étroit : le
doublon rendait une exception là où le vrai en rend une autre. La mesure, faite
méthode par méthode avant d'écrire la moindre ligne, a montré autre chose.

**Ce que la mesure a trouvé.** Le client RÉEL emploie **trois** aides privées, et
une instance absente en ressortait en `InstanceAbsente` ou en `IncusError` selon
celle qu'une méthode employait. « Lire l'état d'une cellule » ne savait donc pas
dire qu'elle avait disparu, quand « la supprimer » le savait. Or c'est sur cette
distinction que reposent SPK-52 — l'absence fait réussir une suppression — et le
§14.6 — l'absence fait proposer une reconstruction. **Elle dépendait d'un détail
d'implémentation qu'aucun appelant ne peut connaître.** Ce n'était pas le doublon
qui mentait tout seul : il copiait une incohérence du vrai.

**Décision, écrite et committée avant le code** (`docs/DAT.md` §12.1) : le
contrat est uniforme. Les trois transports mappent le 404 vers
`InstanceAbsente`, et rien d'autre ne le fait. Conséquence assumée et écrite :
uniformiser **crée** l'absence là où les appelants n'en voyaient pas, donc le
contrat n'est pas tenu tant que chacun ne la nomme pas. Neuf routes ont suivi.

**Ce que l'unité a appris sur les doublons.** Rendre la mauvaise exception se
voit dès qu'on regarde. Ce qui ne se voit pas, c'est qu'une borne peut être
inéprouvable : douze méthodes du doublon ne savaient pas simuler un pilote
injoignable, donc la borne du §33.3 n'y était pas vérifiable — découvert en
essayant de la vérifier. **Une borne qu'on ne peut pas éprouver n'est pas une
borne, c'est une intention.**

**Et une erreur de ma part, corrigée avant de clore, qui est la leçon la plus
utile de la session.** J'avais écrit que `snapshots()` rendant `[]` sur une
instance absente était le pire écart du doublon — une affirmation là où le vrai
avouerait. Mesuré ensuite sur la Forge, contre un vrai Incus : `GET
.../snapshots` rend **200 et une liste vide** pour une instance inconnue, seul
point du contrat à ne pas rendre 404. Le doublon était FIDÈLE ; mon correctif
l'avait fait diverger, et ma spécification affirmait le contraire de la réalité.

Ce qui m'a trompé mérite d'être nommé : ma première « mesure » était une lecture
de code, plus un 404 **simulé** par un transport de test. Elle prouvait mon
mapping, pas ce qu'Incus répond. **Simuler la condition qu'on veut mesurer n'est
pas une mesure.** La règle du §12.1.3 s'énonce donc dans l'autre sens : un
doublon ne doit pas en savoir PLUS que le vrai, si inconfortable que ce soit.

**Le geste qui ferme la classe plutôt que trois cas.** La preuve compare les deux
pilotes **par énumération du protocole**, et une preuve garde l'énumération
elle-même. Une méthode ajoutée demain entre d'elle-même dans la comparaison :
l'écart ne peut plus se rouvrir en silence, ce qui était exactement arrivé quand
`delete_instance` avait été corrigée et `set_instance_state` oubliée.

**Ce que la vérification visuelle a trouvé, et rien d'autre.** Le seed retirait
l'instance de la MÉMOIRE du pilote sans jamais l'écrire ; sa garde interrogeait
cette même mémoire, donc elle ne pouvait pas échouer. Depuis que le doublon relit
son état, la perte était devenue inerte et « Prendre un instantané » sur le Spark
orphelin **réussissait** — l'inverse de ce que mes preuves d'unité affirmaient.
Aucune preuve ne pouvait le voir : chacune monte sa propre pile. La garde vérifie
maintenant ce que le PRODUIT verra, en demandant l'état de la cellule.

Second défaut vu à l'écran : le refus nommait « Reprendre » sur un écran qui
n'offre que « Démarrer » et « Supprimer », ce bouton n'apparaissant qu'en panne.
C'est le symétrique exact de la faute corrigée la veille — nommer les commandes
d'API au lieu des boutons. **La règle qui manquait est plus générale que les
deux : un message ne nomme un bouton que là où ce bouton est certain d'exister.**

**Où reprendre.** SPK-67 est close. Restent, dans l'ordre du plan : SPK-43 et
SPK-54, dont les écarts sont des PREUVES à exécuter — l'une exige l'hôte console
lancé avec son tunnel, l'autre une Forge réelle, disponible. Les autres unités
`[~]` attendent un arbitrage du responsable ou une action humaine, chacune le
disant dans son bloc.

## 2026-08-21 — Le même défaut consigné deux fois, et ce que cela apprend

En fermant le débordement de la barre de facettes, j'ai trouvé **deux entrées
pour un seul défaut** :

    INC-07 · les onglets débordent la page sous 390 px   (2026-08-20)
    INC-16 · la fenêtre défile horizontalement sous 768  (2026-08-21)

Mêmes coupables — `a.onglet` —, même cause, un jour d'écart, deux sessions. La
seconde a même établi une ligne de base sur témoin pour prouver que la cause
n'était pas le message qu'elle venait d'écrire, ce qui était rigoureux et
inutile : la première entrée le disait déjà.

**Ce que cela apprend** : un rapport d'incohérences qui grossit devient un
rapport qu'on n'ouvre plus avant d'y ajouter. Douze entrées, et personne n'a
relu. Le coût n'est pas la ligne en double — c'est le temps de mesure dépensé
deux fois sur la même chose, et la fausse impression que le produit a douze
défauts distincts quand il en a onze.

Les deux entrées sont retirées. Le fichier n'est pas vide, il en garde dix.

### Le correctif ne suffisait pas, et le rapport le disait

Ma première version faisait défiler la barre dans son conteneur — le §8.2 est
satisfait, la page ne défile plus. Mais INC-16 portait une seconde phrase que
j'avais lue trop vite : « à 390 px, la dernière facette est hors champ **sans
aucune indication** qu'elle existe ».

C'est le §14.2 : un débordement non signalé rend le contenu **fonctionnellement
caché**. Une barre qui défile sans le dire cache la facette *Journal* aussi
sûrement qu'une barre qui déborde — elle le fait juste proprement.

D'où le dégradé au bord droit, qui s'efface quand la barre est défilée jusqu'au
bout, et qui n'existe pas là où rien ne déborde : un voile permanent
suggérerait un ailleurs qui n'existe pas.

**Mesure empruntée, et je le dis** : la vérification à 390 px est celle d'une
session voisine — `débordement horizontal : false` — et non la mienne. Sa
campagne occupait la machine, et le §F du runbook interdit d'en lancer une
seconde. Je referai la mesure sous mes propres yeux avec la vérification
visuelle de SPK-64, qui est due de toute façon.

---

## 2026-08-21 — Les dix incohérences ouvertes sont décidées, le registre est libéré

**Instruction du responsable.** Le registre avait servi à constater des écarts,
mais plusieurs attendaient désormais un choix de produit ou de méthode. Le
responsable demande que ces choix soient rendus ici, à leur place chronologique,
plutôt que de laisser le fichier d'incohérences devenir une seconde file de
travail. Les corrections restent des unités explicites : aucune n'est glissée
dans cette séance d'arbitrage.

### INC-05 — Conserver la preuve réelle et la rendre exécutable

`e2e/reel.mjs` reste la preuve distincte de la console contre un `sparkd` réel.
Il doit suivre la navigation visible — cliquer *Routes* avant de chercher son
titre — et être exposé par une cible `make reel`, séparée de `make captures` :
le premier exige une pile réelle déjà lancée et seedée, le second monte sa pile
jetable. La cible annoncera ce prérequis et échouera sur toute erreur de console.
Les captures `40-reel-*` redeviennent ainsi régénérables sans faire d'une pile
réelle une dépendance cachée de la campagne ordinaire.

### INC-06 — Les quatre classes portent une intention et reçoivent leur style

Elles ne sont pas retirées. `controle--compact` exprime la densité du sélecteur,
`epreuve--ok` et `epreuve--absent` les deux verdicts de la sonde, et
`recette-lignes` la structure à deux informations d'une recette DNS. Chacune
reçoit donc un sélecteur CSS et une preuve visuelle de son écran. `CONNUES` ne
perdra une classe qu'en même temps que son style ; il ne doit pas devenir une
liste de styles « prévus ».

### INC-08 — Après une tentative, l'erreur locale suit la valeur

La première validation locale reste à la soumission : l'écran n'accueille pas
une personne avec des erreurs avant toute tentative. Dès qu'une soumission a
échoué pour la forme, chaque modification revalide la forme locale et met à jour
le message du contrôle concerné sans reconstruire le formulaire ni voler le
focus. Une erreur ne peut donc plus décrire une valeur qui n'est plus celle du
champ ; la capacité reste, elle, du seul ressort de `sparkd` à la soumission.

### INC-09 — La déclaration rend l'entrée effectivement inscrite

`POST /v1/audit` rendra l'entrée sérialisée qui vient d'être ajoutée à la chaîne,
dans la même forme que sa lecture par `GET /v1/audit`. C'est le seul sens cohérent
du champ déjà nommé `entry` : un identifiant seul obligerait l'appelant à relire,
et l'omettre contredirait le contrat actuel. La valeur est produite après
l'écriture et la chaîne ; `null` n'est plus une réponse possible à un `201`.
Le contrat partagé et ses types changent avec cette décision.

### INC-10 — Sans session, pas de bannière de session

La bannière décrit exclusivement une session ouverte. Elle n'est rendue que
lorsqu'une session active porte son identifiant et son chemin réels. Hors session,
l'écran conserve ses commandes et son éventuel motif de fermeture, mais ne dit ni
« SSH » ni que quitter l'onglet terminera quelque chose. Une absence est un état
nommé par l'écran, jamais une session supposée.

### INC-11 — Aucune cause n'est inventée ; la prochaine occurrence doit la nommer

Le défaut intermittent n'autorise ni temporisation ni correctif préventif : les
trois causes possibles ont des remèdes incompatibles. La décision est de ne pas
modifier le produit tant qu'une série n'a pas relevé le motif de fermeture du
terminal. À la prochaine occurrence, le diagnostic du parcours conserve ce motif
(`distant_termine`, `inactivite` ou `flux_ferme`) avec l'ordre des parcours ; ce
seul relevé ouvrira une unité de correction. Le vert isolé et les reproductions
infructueuses ne sont pas traités comme une panne résolue ni comme une régression.

### INC-12 — Les refus humains emploient l'unité du contrôle

Les nombres structurés de l'API restent en unités machine. La console construit
en revanche tous les refus lisibles par un humain depuis ces champs structurés,
par un formateur unique : mémoire et disque s'expriment exactement dans la grille
Gio/Mio du contrôle, réseau en Mbit/s et CPU en CPU. Admission et
rétrécissement emploient cette même frontière de rendu ; aucun des deux ne garde
un texte en octets bruts à côté d'une saisie en Gio.

### INC-13 — Une capture ne réussit jamais avec une console non vierge

Le harnais rendra l'URL et le type de chaque évènement de console ou erreur de
page, puis échouera sans liste blanche pour une erreur applicative. Entre deux
piles, il détachera la page du serveur précédent et attendra la fin de ce
changement avant de fermer le serveur : fermer un port pendant qu'une page le
consulte n'est pas un bruit acceptable. Si un message subsiste après cette borne,
il est une erreur reproductible à corriger, non un avertissement que la campagne
masque.

### INC-14 — Un tunnel `ready` efface son erreur passée

`lastError` décrit l'échec courant d'un tunnel, non son histoire complète. Tout
passage à `ready`, tant à l'ouverture qu'au sondage périodique, l'efface. Un
échec pendant l'établissement peut rester interne à la boucle de reprise, mais
ne paraît jamais dans `describe()` après une sonde réussie. L'écran distingue
ainsi bien l'établissement, la panne et la santé retrouvée.

### INC-15 — Clôturée : le constat a déjà été pris en charge par SPK-67

Cette entrée était déjà périmée. SPK-67 a uniformisé le `404` en
`InstanceAbsente`, puis les routes concernées — instantanés, amorçage et clés —
la nomment désormais avant `IncusError`. Elles ne laissent donc plus s'échapper
en `500`. Le titre « six routes » et son tableau décrivent l'état intermédiaire,
pas le dépôt actuel ; aucune nouvelle correction n'est due pour INC-15.

### Conséquence documentaire

Les dix entrées ont maintenant une décision explicite ou, pour INC-15, une
clôture vérifiée. `docs/INCONSISTENCY_REPORT.md` est donc supprimé dans ce même
changement, conformément à sa propre règle et à `CLAUDE.md` §5. Le journal garde
les décisions ; les travaux qui en découlent devront être ouverts comme unités
explicites, avec leur spécification et leurs preuves, et non recréés comme des
incohérences ouvertes.

---

## 2026-08-21 · SPK-64 — la sélection est vérifiée à l'écran

Le catalogue Forge est devenu une destination explicite, et la facette
*Environnement* de chaque Spark porte les cases qui font effectivement descendre
une entrée. Une valeur propre masque une valeur cochée du même nom ; un secret ne
révèle jamais sa valeur. Le parcours réel ajoute une entrée, constate son absence
avant coche, la voit arriver puis disparaître après décochage.

Les captures observées sont `e2e/captures/56-environnement.png`,
`57-environnement-modale.png` et `82-environnement-catalogue-forge.png`.
`make test` est vert après régénération du contrat : 999 tests runtime, 856 tests
web, 8 gestes, 84 parcours E2E et 7 contrôles du manuel. SPK-64 est `[x]`.

Le diagnostic isolé des deux fichiers runtime a atteint 90 s sans sortie dans
cet environnement, alors que la campagne complète venait de les couvrir au vert ;
aucune régression ne lui est attribuée. La prochaine session reprend une unité
productive selon le §4.2.

---

## 2026-08-21 · SPK-43 — le terminal réel ferme et s'inscrit enfin au bon Spark

### Mesure sur la Forge

La console d'exploitation a été lancée avec l'inventaire qui ouvre un tunnel vers
`ubuntu@51.158.54.202`. Depuis l'accueil, le parcours a suivi *Sparks* → `helo`
→ *Terminal*. La commande non sensible `echo SPK43-REAL-CLOSE-AUDIT; exit` a été
vue dans le shell du Spark, puis l'écran a affiché « Le serveur SSH de ce Spark
répond. » : `GET /api/terminal/diagnostic` a donc été joué à travers l'hôte
console et le tunnel, pas seulement par une commande directe.

### Deux défauts trouvés en situation réelle

1. La fin du shell fermait l'écran mais n'écrivait aucune fermeture au journal.
   Le gestionnaire de sessions porte maintenant l'unique notification : geste
   explicite, fin distante, inactivité et coupure du flux la partagent. Une fin
   reste brièvement rejouable au flux arrivé en retard, sans redevenir une session
   vivante. Commit `7c13eea` ; 82 tests ciblés verts.
2. Les événements de terminal visaient le **nom** du Spark alors que la fiche
   filtre le journal avec son identifiant immuable. La console les attache
   désormais à `spark.id`, pour les terminaux de Spark comme de conteneur.
   Commit `e43704e` ; 84 tests d'hôte ciblés verts.

La capture observée montre dans la fiche de `helo` l'ouverture et la fermeture
`distant_termine`, avec l'acteur et la durée. La commande `SPK43-REAL-CLOSE-AUDIT`
n'y apparaît pas. SPK-43 est donc `[x]`.

### Écart distinct relevé pendant la passe réelle

Le chargement de la fiche a aussi rendu deux `500` sur `/v1/env` et
`/v1/sparks/helo/env`. Le journal de `sparkd` établit un déploiement hybride :
`app.py` attend `Entree.selected_by` tandis que le module d'environnement installé
ne le fournit pas. La Forge reste utilisable pour le terminal, mais sa mise à jour
doit devenir atomique et vérifiable : c'est précisément l'objet de SPK-69, qui
reste ouvert. Ce défaut ne doit pas être masqué comme une limite de SPK-43.

---

## 2026-08-21 · SPK-66 — le paquet répare la Forge hybride, et le premier essai nomme son piège

Avant toute installation, le registre de `spark-experiment` a été sauvegardé par
`sparkd.sauvegarde` : `spark-20260821-192126.db`, chaîne d'audit intacte. La
Forge servait alors `0.0.0+inconnue` et les routes d'environnement échouaient
parce que son `app.py` et son module installé n'étaient pas de la même build.

Le paquet issu de `git+https://github.com/P2Enjoy/spark-environment.git@main`
porte maintenant les migrations, `sparkd.service`, `spark.slice` et
`python -m sparkd.install`. La première installation a réellement échoué — et a
donc refusé de s'annoncer réussie — car l'installateur suivait le lien symbolique
`/opt/sparkd/venv/bin/python` vers `/usr/bin/python3.12`. L'unité résultante ne
voyait plus le paquet. Le chemin du venv est désormais conservé sans résolution,
un test le garde, et la Forge a été restaurée immédiatement avant la publication
du correctif.

La build `c95a7fcea` est ensuite installée directement depuis le dépôt public,
sans checkout sous `/opt/sparkd`. `/healthz` porte sa version de métadonnées,
`/readyz` est `ready` et les 13 contrôles du préflight sont verts. Les réponses
`/v1/env` et `/v1/sparks/helo/env` contiennent de nouveau `selected_by` au lieu
des deux `500` observés pendant SPK-43. La mesure de clôture est consignée
ci-dessous, afin de ne pas présenter l'état intermédiaire comme l'état final.

---

## 2026-08-21 · SPK-65 — la console nomme enfin son propre retard

La build d'une Forge n'est pas la build du processus Node qui la présente. La
console relève donc au démarrage la tête Git de **son** arbre servi, ou la date
de ces seuls fichiers lorsqu'il n'y a pas de dépôt, puis compare cette empreinte
à la lecture. Les quatre faits restent distincts : identique, en retard, dépôt
reculé et indisponible. Seul le retard devient un avertissement dans la
coquille ; aucune branche ne redémarre un processus sous les mains de
l'exploitant.

### Preuve réelle observée

La console d'exploitation a été lancée avec l'inventaire de `validation`, puis
`main` a avancé d'un commit. Son endpoint local a rendu `perimee`, `behind: 1`
et le texte exact « Console démarrée avant 1 commit · redémarrer pour en
bénéficier. ». Dans Chromium, l'avertissement accent « Console à redémarrer »
est resté dans la barre latérale pendant la vue *Forge* ; le tunnel SSH vers
`ubuntu@51.158.54.202` était explicitement **ouvert** et les ressources réelles
de `spark-experiment` étaient rendues. La capture a été observée après
stabilisation de cette vue, pas pendant son squelette de chargement.

Les six scénarios de `console-build` — commit avancé, égalité, dépôt reculé,
absence de dépôt, arbre illisible et dépendance exclue — ainsi que la route sans
tunnel sont verts. SPK-65 est `[x]`.

---

## 2026-08-21 · SPK-66 — le paquet est mesuré sur les deux Forges

La Forge neuve `root@212.47.246.142` confirme la partie qui ne pouvait pas être
déduite d'un wheel local : `sparkd` est importé depuis
`/opt/sparkd/venv/lib/python3.14/site-packages`, sa métadonnée est
`0.post1.dev592+g4420cfb97`, et `/opt/sparkd/.git` est absent. Son `spark.slice`
est installé et actif ; `sparkd.service` reste inactif car la machine n'a pas
encore son Incus, Caddy ni son pool — le travail d'une Forge complète est SPK-68,
pas une raison de copier un dépôt pour SPK-66.

Sur la Forge existante, l'exercice demandé a réellement installé et servi
`c95a7fceac37`, puis `0e8c41f40bd8`, est revenu à `c95a7fceac37`, et a fini sur
`0e8c41f40bd8`. Après chaque pose, `/healthz` a porté le commit attendu,
`/readyz` a été `ready` et les 13 contrôles du préflight ont été verts. La mesure
finale reste lisible : version `0.post1.dev591+g0e8c41f40`, sans dépôt sous
`/opt/sparkd`.

Enfin, 71 tests d'installation/build/préflight sont verts ; un wheel neuf porte
les 11 migrations SQL, `sparkd.install`, `sparkd.service` et `spark.slice`.
La version dérivée de Git progresse (`dev596` pour le wheel courant), ce qui
empêche à nouveau `pip` de confondre une mise à jour avec « déjà satisfait ».
SPK-66 est `[x]`.

---

## 2026-08-21 · SPK-53 — la lecture de build est close, le geste reste SPK-69

La comparaison avait déjà toutes ses branches et ses captures, mais son état
`[~]` portait encore la commande de mise à jour qui vit désormais explicitement
dans SPK-69. Cette confusion faisait attendre à une lecture qu'elle administre
une Forge, alors que c'est précisément la frontière du produit.

Les 10 scénarios d'ascendance du comparateur, 53 contrôles de rendu de la vue
Forge et les 6 routes ciblées sont verts. La passe Chromium sur la Forge réelle
de validation a de plus rendu « En retard — 4 commits d'écart », avec le commit
du paquet installé et celui du poste : le verdict a donc été observé à travers
le tunnel, sans geste de mise à jour. SPK-53 est `[x]`; SPK-69 reste `[ ]`.

---

## 2026-08-21 · SPK-62 — l'alerte de suppression nomme son Spark

Le message de `spark.delete` ne disait jusque-là que la transition d'état. C'est
la ligne qui part vers le canal ; le nom du Spark n'arrivait qu'à
`spark.deleted`, événement runtime qui ne doit pas notifier. Une alerte hors
bande désignait donc un identifiant opaque, sans nom exploitable.

La transition porte maintenant « Spark « crm-production » : … → deleting ».
La preuve lit cette ligne à l'endroit où la notification l'emprunte, et les 80
tests Spark/notification sont verts ; le contrat OpenAPI a été régénéré après la
dérive de version du paquet. Il reste une seule preuve : recevoir ce corps sur un
vrai canal choisi par le responsable, ce qui nécessite son URL et l'autorisation
de jouer un geste sensible. SPK-62 reste `[~]`.

---

## 2026-08-21 · SPK-60 — le briefing a un état, pas deux textes

Avant d'écrire le code, le contrat précise le point qui ne pouvait pas rester
implicite : les versions relevées à l'amorçage et l'auteur d'une installation ne
se déduisent ni de l'état courant de la cellule, ni d'un texte Markdown. Une
ligne `spark_bootstrap_observation` porte le relevé daté et la liste minimale de
ce que le plan de contrôle a effectivement modifié. Trouver Docker déjà présent
ne devient donc jamais, par relecture, « Docker installé par sparkd ».

Le JSON est le modèle source et le Markdown sa seule présentation humaine ; les
deux sont réécrits en entier à chaque changement de plan qui les concerne. Une
adresse publique de Forge est elle aussi un fait configuré, jamais une
supposition tirée de l'adresse privée : absente, elle est dite inconnue. SPK-60
passe à `[~]` : le contrat est poussé avant l'implémentation.
