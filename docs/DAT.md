# DAT — Dossier d'architecture technique

Projet : **Spark Environment**
Statut : socle documentaire posé, hôte cible relevé, implémentation non commencée
Dernière mise à jour : 2026-08-18

Ce document fait autorité sur l'architecture. Lorsqu'il diverge du code, c'est un
défaut à corriger, pas une tolérance.

---

## 1. Objectif et périmètre

Spark Environment découpe un serveur physique unique en **cellules d'exécution
Linux cloisonnées et contingentées**, appelées **Sparks**, dont l'unique raison
d'être est d'héberger une pile Docker Compose déjà industrialisée.

Le produit se compose de deux livrables :

1. une **console d'administration locale**, exécutée sur le poste du responsable,
   qui ne s'expose jamais sur le réseau ;
2. un **runtime serveur**, exécuté sur la machine à découper, qui n'écoute que sur
   `127.0.0.1`.

Ce qui est **hors périmètre**, explicitement :

- l'orchestration des conteneurs applicatifs à l'intérieur d'un Spark : c'est
  Docker Compose, propriété du locataire, et le plan de contrôle n'y touche pas ;
- le multi-serveurs et l'ordonnancement inter-machines : un serveur, un runtime ;
- la construction d'images applicatives, la CI/CD, le registry ;
- toute forme de PaaS, de build-pack ou de détection automatique de framework.

L'unité de déploiement n'est ni une application ni une fonction. C'est **une
cellule d'exécution Linux à quota**, dont le contenu ne regarde pas le plan de
contrôle.

## 2. Le choix structurant : Docker n'est plus la frontière d'isolation

Le point de bascule conceptuel du projet est le suivant :

```
AVANT                                   APRÈS

serveur                                 serveur
  └── dockerd                             ├── Spark A
        ├── stack A                       │     └── dockerd  (stack A)
        ├── stack B                       ├── Spark B
        └── stack C                       │     └── dockerd  (stack B)
                                          └── Spark C
frontière = conteneur Docker                    └── dockerd  (stack C)
voisinage = total
                                        frontière = Spark
                                        voisinage = quota
```

Docker appartient à l'environnement du locataire. Le Spark est la frontière.
Cette inversion est ce qui permet de conserver telles quelles des piles Compose
existantes, sans les traduire en primitives Kubernetes.

## 3. Moteur d'exécution : Incus

Le moteur d'isolation et de cycle de vie n'est **pas** réécrit. Il s'agit
d'[Incus](https://linuxcontainers.org/incus/) (Apache-2.0), qui fournit
nativement toutes les primitives nécessaires :

| Besoin Spark | Primitive Incus |
|---|---|
| environnement Linux complet | *system container* |
| exécuter Docker dedans | `security.nesting=true` |
| cloisonnement des UID/GID | conteneur non privilégié + `security.idmap.isolated=true` |
| quota CPU dur | `limits.cpu.allowance=<t>ms/100ms` |
| part CPU sous contention | `limits.cpu.allowance=<n>%` |
| arbitrage sous surengagement | `limits.cpu.priority` (0–10) |
| cœurs dédiés | `limits.cpu=<liste d'IDs>` |
| mémoire | `limits.memory`, `limits.memory.enforce`, `limits.memory.swap` |
| débit réseau | device NIC `limits.max` / `limits.ingress` / `limits.egress` (bit/s) |
| quota disque | device disque racine `size` (rootfs uniquement) |
| priorité E/S | `limits.disk.priority` (0–10) |
| injection de clés SSH | `cloud-init.user-data` |
| instantanés, export, restauration | snapshots et `incus export` |
| basculer container → VM | même abstraction, `--vm` |

### 3.1 Version minimale d'Incus : une condition de fonctionnement

**Incus ≥ 6.19 est obligatoire.** Ce n'est pas une préférence de version, c'est une
condition sans laquelle le produit ne fonctionne pas du tout.

Mesuré le 2026-08-18 : avec Incus 6.0.0, la version des dépôts Ubuntu 24.04,
**aucun** conteneur Docker ne démarre dans un Spark. Depuis le correctif de
CVE-2025-52881, `runc` ≥ 1.3 écrit ses sysctls à travers un montage procfs
détaché ; le profil AppArmor qu'Incus applique au Spark interprète cet accès comme
un accès à `/sys/...` et le refuse :

```
open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied
```

Le défaut touche **tout** conteneur, avec ou sans publication de port, et
`--security-opt apparmor=unconfined` posé sur le conteneur Docker ne le contourne
pas, puisque le profil fautif est celui du Spark et non celui de Docker. Rendre le
Spark `unconfined` fonctionnerait, mais retirerait une couche de défense qui fait
partie du modèle d'isolation : ce n'est pas la réponse.

La correction est en amont, et le paquet doit donc venir du dépôt amont et non des
dépôts Ubuntu. Le projet annonce le correctif en 6.19 ; **la version mesurée comme
fonctionnelle sur cet hôte est 7.3**.

**Vérifié le 2026-08-18, et c'est la preuve du concept même du produit.** Sous Incus
7.3, dans un Spark **non privilégié**, à `security.idmap.isolated=true`, **AppArmor
actif** et sans aucun `raw.lxc` de contournement :

```
uid_map du Spark          0  1065536  65536
docker --version          29.7.2
docker compose version    v5.5.0
docker compose up -d      Container demo-web-1 Started
docker ps                 nginx:alpine  Up  0.0.0.0:8080->80/tcp
curl depuis le Spark      HTTP 200
curl depuis l'HÔTE        HTTP 200   sur 10.77.0.38:8080
Storage Driver            overlayfs      Cgroup Version 2
```

Une pile Compose réelle tourne donc dans une cellule contingentée et cloisonnée, et
répond à l'hôte sur son IP privée — exactement le point de raccordement dont Caddy a
besoin (§9). Le contrat central de l'architecture est établi par la mesure, pas par
le raisonnement.

Attention : **un Spark conserve le profil AppArmor produit au moment de son
démarrage.** Redémarrer le démon ne le régénère pas. Une montée de version d'Incus
n'a donc d'effet sur un Spark qu'après arrêt puis redémarrage de celui-ci.

Le mode `vm` n'est pas une fonctionnalité future décorative : il est la réponse
prévue au jour où des piles non maîtrisées seront hébergées, puisqu'un *system
container* partage le noyau de l'hôte. Le modèle de données porte donc le champ
`runtime` dès le premier jour, même si seul `container` est implémenté.

Les valeurs et sémantiques ci-dessus ont été relevées dans la documentation Incus
`main` le 2026-08-18 ; les vérifications restant à faire sur l'hôte cible sont
listées au §13.

## 4. Ce qui est réellement écrit ici

```
Console locale (apps/webui)         ← notre code
Runtime serveur (services/sparkd)   ← notre code
Registre de ressources (SQLite)     ← notre code
─────────────────────────────────────────────────
Incus                               ← existant
Pool de stockage (voir §8)          ← existant
Caddy                               ← existant
OpenSSH                             ← existant
Docker / Compose (dans le Spark)    ← existant, propriété du locataire
```

Pas de Kubernetes, pas de Nomad, pas d'OpenStack, pas de couche de gestion
Proxmox, et **aucune socket Docker exposée au plan de contrôle**.

## 5. Topologie physique et surface réseau

```
                          INTERNET
                             │
                    22 / 80 / 443 seulement
                             │
        ┌────────────────────▼─────────────────────┐
        │              SERVEUR PHYSIQUE            │
        │                                          │
        │  sshd :22        Caddy :80 :443          │
        │                     │                    │
        │  127.0.0.1:9876  sparkd                  │
        │  127.0.0.1:2019  API admin Caddy         │
        │  /var/lib/incus/unix.socket  Incus       │
        │                     │                    │
        │        bridge privé  sparkbr0            │
        │     ┌───────────────┼───────────────┐    │
        │     │               │               │    │
        │  10.77.0.11     10.77.0.12     10.77.0.13│
        │  ┌────────┐    ┌────────┐    ┌────────┐  │
        │  │ SPARK  │    │ SPARK  │    │ SPARK  │  │
        │  │ dockerd│    │ dockerd│    │ dockerd│  │
        │  └────────┘    └────────┘    └────────┘  │
        └──────────────────────────────────────────┘
```

Invariant de sécurité : **aucune API d'administration n'est joignable depuis le
réseau**. `sparkd`, l'API Caddy et Incus n'écoutent que sur la boucle locale ou
une socket Unix. Seul un porteur de clé SSH valide peut les atteindre, via un
tunnel.

Un Spark n'obtient jamais de port SSH public. L'accès se fait par rebond depuis
l'hôte :

```sshconfig
Host spark-crm
    HostName 10.77.0.11
    User root
    ProxyJump spark-host
    IdentityFile ~/.ssh/spark-crm
```

### 5.1 Accès à Incus : la socket, pas la ligne de commande

`sparkd` parle à Incus par son **API REST sur la socket Unix**
`/var/lib/incus/unix.socket`, jamais en lançant le binaire `incus`.

Trois raisons, dans l'ordre d'importance : une sortie de CLI est un format
d'affichage, qui change sans préavis et se parse mal — `incus info --resources`
n'accepte d'ailleurs aucun `--format`, mesuré le 2026-08-18 ; lancer un processus
par requête coûte et ouvre une surface d'injection ; et l'API rend des types,
là où le texte rend des chaînes à réinterpréter.

La socket appartient au groupe `incus-admin`. L'utilisateur système de `sparkd`
doit y être, ce que le contrat de déploiement rappelle.

### 5.2 Inventaire de l'hôte : ce qui est lu, et où

Relevé le 2026-08-18 sur l'hôte, ces chemins et ces unités sont **mesurés**, pas
supposés.

| Grandeur du registre | Source | Unité rendue |
|---|---|---|
| `hostname` | `/1.0` → `environment.server_name` | texte |
| `cpu_threads_total` | `/1.0/resources` → `cpu.total` | threads |
| `cpu_cores_total` | `/1.0/resources` → somme des `cpu.sockets[].cores[]` | cœurs physiques |
| topologie `cpu_core` / `cpu_thread` | `cpu.sockets[].cores[].threads[]` | `id`, `thread`, `numa_node`, `online` |
| `memory_total_bytes` | `/proc/meminfo` → `MemTotal` — **pas** `/1.0/resources` | octets |
| `network_total_bps` | `/1.0/resources` → `network.cards[].ports[].link_speed` du port **détecté** | **Mbit/s**, à convertir |
| `storage_total_bytes` | `/1.0/storage-pools/<pool>/resources` → `space.total` | octets |

Trois pièges, tous rencontrés à la mesure :

- **`cpu.total` compte les threads, pas les cœurs.** Le prendre pour la capacité
  reviendrait à vendre deux fois la même chose (§7.7). Les cœurs se comptent en
  parcourant les sockets.
- **`link_speed` est en Mbit/s.** L'hôte rend `1000` pour un lien 1 Gbit/s. Le
  registre stocke des bit/s : la conversion est explicite, jamais implicite. Les
  ports dont `link_detected` est faux sont ignorés — `eno2` n'est pas raccordé et
  n'ajoute aucune capacité.
- **La capacité de stockage est celle du POOL Incus, pas celle du disque.** Sur
  l'hôte de validation, le pool sur fichier ne rend que 192,8 Gio là où le disque
  en porte 5,4 Tio. Lire le disque ferait promettre vingt-huit fois la place
  réellement disponible.

**Cinquième piège, et il coûte cher : `memory.total` d'Incus est la RAM
PHYSIQUE, pas celle que le noyau peut allouer.** Mesuré le 2026-08-19 : Incus
rapporte `105 226 698 752` octets — le total des barrettes, 98,0 Gio — quand
`/proc/meminfo` rend `MemTotal` à 94,2 Gio. Les quelque 4 Gio d'écart sont
réservés par le micrologiciel et le noyau : aucun processus ne les obtiendra
jamais. Promettre le total physique, c'est promettre de la mémoire qui n'existe
pas pour les locataires. Le registre retient donc `MemTotal`.

Un quatrième piège, plus discret : **`/1.0/resources` ne porte aucun nom
d'hôte.** Sa clé `system` décrit le *matériel* — châssis, micrologiciel, carte
mère, et des **numéros de série**. Le nom vient de `/1.0`. Ces numéros de série
ne sont ni stockés ni journalisés : ils identifient la machine sans rien
apporter au produit.

Le pool à interroger est nommé par `SPARKD_STORAGE_POOL`.

### 5.3 Le relevé est explicite, jamais implicite

Le registre n'est **pas** rafraîchi à chaque requête. Le relevé de topologie est
une opération nommée, tracée dans `audit_log`, qui écrit `host`, `cpu_core`,
`cpu_thread` et met à jour `topology_synced_at`.

Motif : la capacité de l'hôte est la base de tous les calculs d'admission. Si
elle bougeait silencieusement sous les pieds du plan de contrôle — un lien qui
tombe, un pool redimensionné —, des Sparks déjà admis deviendraient
rétroactivement non admissibles sans que personne ne l'ait décidé. Un relevé
explicite laisse une trace et une date.

Un relevé qui **réduirait** la capacité sous ce qui est déjà alloué est appliqué
malgré tout — la réalité fait foi — mais il est journalisé en `result=denied`,
et l'écart doit rester visible dans la console. Refuser d'enregistrer la réalité
serait pire : le registre mentirait sur la machine.

## 6. Plan d'administration

```
POSTE DU RESPONSABLE                       SERVEUR

┌──────────────────────────┐
│ navigateur               │
│ http://127.0.0.1:5173    │
└────────────┬─────────────┘
             │ HTTP local
┌────────────▼─────────────┐
│ hôte console (Node)      │
│  · inventaire serveurs   │
│  · gestion des tunnels   │      ssh -L 19876:127.0.0.1:9876
│  · proxy /api → tunnel   │ ──────────────────────────────────▶ sshd :22
└──────────────────────────┘                                        │
                                                                    ▼
                                                          127.0.0.1:9876 sparkd
```

Le navigateur ne sait rien de SSH. C'est l'hôte console local qui porte le
tunnel, parce qu'un navigateur ne peut pas et ne doit pas le faire.

## 7. Modèle de ressources

### 7.1 Le partage est le mode par défaut

Dédier des cœurs à des services web, des API, des workers, du Redis ou du
PostgreSQL modeste gaspille l'essentiel de la capacité : ces charges sont
irrégulières, pas continûment consommatrices. Le modèle par défaut est donc
**partagé, avec burst**.

Sémantique retenue, qui est le cœur du produit :

> **« 0,5 CPU Spark » signifie 0,5 CPU de droit d'ordonnancement garanti sous
> contention — et non un demi-cœur physique réservé en permanence.**

Hors contention, un Spark consomme tout ce qui traîne.

### 7.2 Les quatre modes CPU

| Mode | Sémantique | Traduction Incus | Effet cgroup v2 mesuré |
|---|---|---|---|
| `shared` | part du pool partagé, burst autorisé | `limits.cpu=<cpuset partagé>` + `limits.cpu.allowance=<n>%` | `cpu.weight=<n−10+priorité>`, `cpu.max=max` |
| `capped` | pool partagé, plafond dur, pas de burst | `limits.cpu=<cpuset partagé>` + `limits.cpu.allowance=<t>ms/100ms` | `cpu.max=<t×1000> 100000` |
| `dedicated` | cœurs physiques exclusifs, retirés du pool partagé | `limits.cpu=<IDs, frères SMT inclus>`, pas d'`allowance` | `cpuset.cpus=<IDs>` |
| `shared-pinned` | cœurs imposés mais non exclusifs (localité cache / NUMA) | `limits.cpu=<IDs>` + `allowance` | `cpuset.cpus` + `cpu.weight` |

La documentation Incus recommande de ne pas combiner épinglage et quota temporel
sans nécessité : `capped` et `shared` épinglent au **cpuset partagé complet**,
pas à un sous-ensemble.

### 7.2 bis Correspondance mesurée `allowance` → `cpu.weight`

Mesuré le 2026-08-18 sur l'hôte, noyau 6.8, cgroup v2, Incus 6.0 :

```
allowance    cpu.weight    cpu.max
6%              1          max 100000
7%              2          max 100000
10%             5          max 100000
13%             8          max 100000
25%            20          max 100000
50%            45          max 100000
100%           95          max 100000
200%          195          max 100000
500%          495          max 100000
1000%         995          max 100000
2000%        1995          max 100000

priorité (à allowance 50%) :  0 → 40    5 → 45    10 → 50
forme temporelle :  50ms/100ms → cpu.max = 50000 100000
```

D'où la loi, vérifiée sur onze points :

```
cpu.weight = allowance_pct − 10 + limits.cpu.priority
```

**Deux conséquences corrigent ce document.**

**1. `allowance` et `priority` ne sont pas deux réglages indépendants.** Ils
s'additionnent dans un unique poids. Présenter la réservation comme « la part » et
la priorité comme « l'arbitrage » était faux : c'est le même bouton. La priorité
reste donc constante par défaut, et ne se règle que pour biaiser délibérément un
Spark par rapport aux autres.

**2. La mise à l'échelle naïve est inutilisable pour les petits Sparks.** Avec
`pct = réservation / capacité × 100`, sur un pool de 4 CPU :

```
0,5  CPU → 12,5 %  → poids 8      utilisable
0,25 CPU →  6,25 % → poids 1      plus aucune résolution
0,2  CPU →  5 %    → poids 0      REFUSÉ par le noyau
```

Le refus est explicite — `Error: setting cgroup item for the container failed` —
et non silencieux, ce qui est heureux. Mais la loi d'échelle doit changer. Comme
`2000 %` est accepté, il y a de la marge :

```
allowance_pct = réservation / capacité(pool partagé) × 1000
```

soit `0,25 CPU → 62,5 % → poids ≈ 57`, et un pool plein totalisant environ
1000 % de poids. Les rapports sont préservés et la résolution redevient
exploitable.

### 7.2 ter Rendu exact des valeurs, mesuré

Incus refuse ce qui n'est pas entier. Mesuré le 2026-08-18 sur l'hôte :

```
limits.cpu.allowance = 62.5%        REFUSE  strconv.Atoi: parsing "62.5"
limits.cpu.allowance = 62%          accepte  → cpu.weight 57
limits.cpu.allowance = 1%           REFUSE   setting cgroup item failed
limits.cpu.allowance = 0.5ms/100ms  REFUSE
limits.cpu.allowance = 5ms/100ms    accepte  → cpu.max 5000 100000
limits.cpu.priority  = -1 ou 11     REFUSE   (bornes 0..10 confirmées)
```

Trois règles en découlent, et elles ne sont pas cosmétiques.

**1. Le pourcentage est arrondi à l'entier.** L'échelle ×1000 du §7.2 bis produit
des valeurs fractionnaires — `0,25 CPU` sur 4 cœurs donne `62,5 %` — qu'Incus
rejette. L'arrondi déplace donc légèrement les rapports entre Sparks. Sur des
poids de l'ordre de plusieurs dizaines, l'écart reste inférieur au pourcent ; il
serait inacceptable à l'échelle ×100, où un demi-point de pourcentage pèse
plusieurs pour cent du poids. C'est une raison de plus de retenir ×1000.

**2. Il existe un plancher, et il dépend de la priorité.** Le noyau refuse un
poids nul ou négatif, donc :

```
allowance_pct ≥ 11 − limits.cpu.priority
```

Soit `6 %` à la priorité par défaut `5`. Une réservation trop petite pour
atteindre ce plancher **ne doit pas être arrondie vers le haut en silence** : le
Spark obtiendrait plus que ce qui lui a été comptabilisé, et l'invariant du §7.3
cesserait d'être vrai. Le pilote refuse la traduction et nomme la réservation
minimale admissible pour la capacité du pool.

**3. La forme temporelle s'exprime en millisecondes entières.**

```
limits.cpu.allowance = round(cpu_max × 100) ms / 100ms
```

`0,5 CPU → 50ms/100ms`. Le plancher est `1ms`, soit `cpu_max ≥ 0,01`. En deçà, le
pilote refuse plutôt que d'arrondir : plafonner à `1ms` donnerait au Spark le
double ou le décuple de ce qui a été vendu.

Un principe commun à ces trois règles : **quand la valeur demandée ne peut pas
être rendue fidèlement, on refuse au lieu d'approximer**. Une approximation
silencieuse fait diverger le registre de la machine, et c'est précisément ce que
l'invariant du §7.3 interdit.

### 7.3 L'invariant qui donne son sens à la réservation

Le mode `shared` repose sur des poids relatifs : `cpu.max` reste à `max`, donc
aucun plafond n'est posé et le burst est réel. Un poids seul ne garantit rien dans
l'absolu. Ce qui rend la réservation *signifiante*, c'est l'admission control du
registre :

```
Σ réservations(Sparks partagés) ≤ capacité(pool partagé) × facteur_surengagement
```

Le surengagement devient ainsi un **réglage explicite** (`overcommit_cpu`, par
défaut `1.0`) et non un effet de bord accidentel.

Traduction du poids, corrigée par la mesure (§7.2 bis) :

```
allowance_pct = réservation / capacité(pool partagé) × 1000
```

### 7.3 bis Ce que l'invariant ne suffit PAS à garantir

L'énoncé ci-dessus était incomplet, et la mesure du 2026-08-18 le montre. Un Spark
n'est pas créé sous un parent qui lui serait réservé : Incus le place à la
**racine** de cgroup v2, où il devient frère des tranches de l'hôte.

```
/sys/fs/cgroup/
├── system.slice                 cpu.weight = 100
├── user.slice                   cpu.weight = 100
├── init.scope                   cpu.weight = 100
├── lxc.monitor.spark-test       cpu.weight = 100
└── lxc.payload.spark-test       cpu.weight =   8   ← le Spark
```

Le poids d'un Spark est donc arbitré **contre l'hôte**, et pas seulement contre les
autres Sparks. Sous contention totale, un Spark à poids 8 face à trois tranches
hôte à 100 n'obtient pas 12,5 % de la machine : il obtient
`8 / (8 + 100 + 100 + 100 + …)`, soit un ordre de grandeur de moins.

Autrement dit : l'admission control assure la **proportionnalité entre Sparks**,
mais pas la valeur absolue de la réservation, tant que les Sparks ne sont pas
regroupés sous un parent commun de poids maîtrisé.

Trois voies possibles, à trancher par mesure (unité SPK-29) :

1. placer tous les Sparks sous un parent unique — par exemple une tranche
   `spark.slice` — dont le poids représente la part de la machine cédée aux
   Sparks, les poids individuels n'arbitrant plus qu'à l'intérieur ;
2. conserver la disposition actuelle et **soustraire explicitement** la part de
   l'hôte de la capacité annoncée, ce qui revient à admettre que la réservation
   est une part du reste et non de la machine ;
3. relever le poids des Sparks pour rendre celui de l'hôte négligeable, ce qui
   revient à ne plus protéger l'hôte — écarté.

La voie 1 est la seule qui rende la réservation littéralement vraie. Tant qu'elle
n'est pas mise en œuvre et mesurée, la console ne doit pas présenter la
réservation comme une garantie absolue.

### 7.4 Le pool dédié se découpe dynamiquement

Il n'y a pas de pool dédié figé à l'avance. Au départ, tout est partagé :

```
partagé   = [0,1,2,3,4,5,6,7]
dédié     = ∅
```

À la demande d'un Spark `dedicated: 2 cores`, le registre :

```
1. cherche 2 cœurs physiques libres (frères SMT compris)
2. les retire du cpuset partagé
3. reconfigure le cpuset de TOUS les Sparks partagés
4. épingle le Spark spécial sur ces CPU
5. démarre
```

```
partagé   = [0,1,2,3,4,5]
spark-pg  = [6,7]
```

À la suppression, les cœurs retournent au pool et les Sparks partagés sont
reconfigurés.

**Mesuré et confirmé le 2026-08-18** : `limits.cpu` passé de `0-7` à `0-5` sur un
Spark en marche applique immédiatement `cpuset.cpus=0-5`, l'`uptime` du conteneur
progresse sans discontinuité (118,77 s → 120,05 s) et `nproc` vu de l'intérieur
passe de 8 à 6. La découpe et la restitution du pool dédié sont donc **non
disruptives** : aucun Spark partagé n'a besoin d'être redémarré.

Effet de bord à connaître : `nproc` change sous les pieds des processus déjà
lancés. Une application qui a dimensionné son pool de threads au démarrage ne le
réajustera pas.

### 7.4 bis Ce que « reconfigurer les Sparks partagés » veut dire exactement

Le §7.4 dit de reconfigurer le cpuset de tous les Sparks partagés. Ce n'est que
la moitié du travail, et c'est l'autre moitié qui compte.

**Le poids dépend de la capacité du pool.** Le §7.2 bis pose
`allowance_pct = réservation / capacité(pool partagé) × 1000`. Retirer des cœurs
change la capacité, donc **change le pourcentage de chaque Spark partagé**. Ne
reconfigurer que le cpuset laisserait à chacun un poids calculé pour un pool qui
n'existe plus : une réservation de 0,5 CPU sur un pool passé de 4 à 2 cœurs
vaudrait toujours 125 % au lieu de 250 %, soit la moitié de ce qui a été vendu.

Une découpe recalcule donc, pour chaque Spark partagé, **`limits.cpu` et
`limits.cpu.allowance`**.

Bonne nouvelle au passage : rétrécir le pool ne peut pas faire passer un Spark
sous le plancher du §7.2 ter, puisque le pourcentage **augmente** quand la
capacité diminue. C'est l'élargissement qui pourrait poser problème, et il ne
survient qu'à la restitution, où les réservations tenaient déjà.

### 7.4 ter Choix des cœurs, et ordre des opérations

**Quels cœurs.** Les cœurs physiques libres de plus petit indice, frères SMT
compris. Le déterminisme sert la même chose qu'en §15.3 : une découpe reproduite
sur un parc identique donne le même résultat, donc se vérifie.

Sur un hôte à plusieurs nœuds NUMA, ce choix devrait préférer des cœurs d'un même
nœud. L'hôte de validation n'en a qu'un ; la règle est notée comme dette plutôt
qu'implémentée sans pouvoir être éprouvée.

**Dans quel ordre.** L'ordre n'est pas indifférent :

```
DÉCOUPE                              RESTITUTION
1. rétrécir le cpuset partagé        1. libérer le Spark dédié
2. recalculer les poids partagés     2. élargir le cpuset partagé
3. épingler le Spark dédié           3. recalculer les poids partagés
```

Rétrécir avant d'épingler évite que le Spark dédié et les Sparks partagés se
partagent brièvement les mêmes cœurs — ce qui serait exactement ce que
« dédié » promet d'éviter. À la restitution, libérer avant d'élargir évite le
symétrique.

**Atomicité.** Le registre écrit l'ensemble de la redistribution dans une seule
transaction. Une découpe à moitié appliquée laisserait des Sparks avec un poids
calculé pour une capacité et un cpuset correspondant à une autre — un état que
rien ne permettrait de distinguer d'un fonctionnement normal.

L'application vers Incus, elle, n'est pas atomique : elle est faite Spark par
Spark. Si elle échoue en cours de route, le registre reste la référence et une
réconciliation la rejoue. C'est pourquoi le registre s'écrit d'abord (§14.2).

### 7.5 SMT : un cœur dédié n'est pas un CPU logique

Si le processeur expose du SMT, attribuer le seul CPU `3` ne donne pas l'exclusivité
du cœur physique : son frère `11` reste ordonnançable par d'autres. Le mode
`dedicated` alloue donc **des cœurs physiques entiers, frères inclus** :

```
cores: 1   →   limits.cpu=3,11        (et non limits.cpu=3)
```

La topologie est lue via `incus info --resources`.

**Mesuré et confirmé le 2026-08-18.** Sur l'hôte, `incus info --resources` rapporte
bien la structure cœur → threads, et le frèrage concorde exactement avec `/sys` :

```
Core 0 → threads id 0, id 4        Core 2 → threads id 2, id 6
Core 1 → threads id 1, id 5        Core 3 → threads id 3, id 7
```

Un `limits.cpu=0` n'aurait donc donné aucune exclusivité sur le cœur 0, son frère
`4` restant ordonnançable par les autres. La règle est validée par la mesure, et
non seulement par le raisonnement.

### 7.6 Mémoire, réseau, stockage

```yaml
memory:
  reservation: 16GiB    # limits.memory
  enforce: hard         # limits.memory.enforce
  swap: false           # limits.memory.swap

network:
  reservation: 100Mbit  # comptabilité seule
  burst: 500Mbit        # device NIC limits.max

storage:
  size: 10GiB           # device disque racine : size
  io_priority: 5        # option d'INSTANCE : limits.disk.priority
```

Attention au placement de `limits.disk.priority` : c'est une option
**d'instance**, pas de périphérique. Posée sur le disque, Incus rejette
`Invalid device option` — et comme l'override d'un périphérique est atomique, le
quota `size` du même appel ne s'applique pas non plus. Le Spark repart alors avec
le pool entier, sans que rien ne le signale. Mesuré le 2026-08-18.

Honnêteté nécessaire sur le réseau : le noyau n'applique qu'un **plafond**
(`limits.max`), il n'existe pas de réservation garantie de bande passante avec
cette primitive. `network.reservation` est un concept de registre servant à
l'admission control ; `network.burst` est la seule valeur réellement appliquée.
La console doit présenter cette distinction, pas la masquer.

### 7.7 Admission control : ce qui compte, et contre quoi

Le §7.3 donne l'invariant. Cette section fixe les deux points qu'il laissait
implicites et que le code ne peut pas deviner.

#### Capacité allouable, par ressource

```
CPU partagé   (cœurs_physiques − cœurs_dédiés) × overcommit_cpu
Mémoire       (mémoire_totale − réserve_hôte)  × overcommit_memory
Réseau        débit_nominal                    × overcommit_network
Stockage      (stockage_total − réserve_hôte)          ← AUCUN surengagement
```

La capacité CPU se compte en **cœurs physiques**, jamais en threads : le SMT
n'ajoute pas de capacité d'exécution, il l'entrelace. Compter 8 threads sur cette
machine reviendrait à vendre deux fois la même chose.

Le stockage n'a délibérément pas de facteur de surengagement, et `host` n'en
porte pas de colonne. Un pool CPU saturé se traduit par de la lenteur, qu'un
ordonnanceur lisse ; un pool de stockage saturé est une panne dure, qu'aucun
ordonnancement ne rattrape. Surprovisionner du disque, c'est promettre des octets
qui n'existent pas.

#### Ce que chaque mode CPU consomme

| Mode | Consomme du pool partagé | Retire des cœurs du pool |
|---|---|---|
| `shared` | `cpu_reservation` | non |
| `shared-pinned` | `cpu_reservation` | non — les cœurs sont imposés, pas exclusifs |
| `capped` | `cpu_max` | non |
| `dedicated` | rien | **oui**, `cpu_cores` cœurs entiers |

`capped` consomme son **plafond**, pas zéro. Un Spark plafonné à 0,5 CPU peut
réellement consommer 0,5 CPU en permanence ; ne pas le provisionner reviendrait à
distribuer de la capacité déjà prise. C'est le seul mode où la grandeur comptée
n'est pas une réservation, et c'est délibéré : on provisionne ce que le Spark
peut prendre, pas ce qu'on espère qu'il prendra.

`dedicated` ne consomme pas de réservation : il **réduit la capacité du pool**
pour tous les autres, ce qui est comptabilisé en amont dans la formule de
capacité.

#### Quels Sparks comptent

**Tous ceux qui existent dans le registre**, quel que soit leur état — `stopped`,
`error` et `deleting` compris.

Un Spark arrêté conserve son disque et son adresse ; un Spark en erreur sera
repris et redémarré ; un Spark en cours de suppression n'a pas encore rendu ses
ressources. Traiter l'un de ces états comme de la capacité libre ferait admettre
un nouveau Spark dans une place qu'un simple redémarrage reprendrait — et le
refus tomberait alors au pire moment, sur le Spark qui existait déjà.

La ressource n'est rendue qu'à la disparition de la ligne.

#### Forme du refus

Un refus nomme **la ressource fautive, la quantité demandée, ce qui reste, et le
facteur de surengagement en vigueur**. « Capacité insuffisante » n'aide personne :
l'exploitant doit pouvoir décider, à la lecture, s'il réduit sa demande, libère un
Spark ou relève le surengagement.

Lorsque plusieurs ressources manquent, **toutes** sont rapportées, pas seulement
la première. Corriger une demande pour se heurter à la suivante, puis à la
troisième, est une perte de temps évitable.

#### Ce que cet admission control ne garantit pas

Il garantit que la somme des réservations tient dans la capacité, donc la
**proportionnalité entre Sparks**. Il ne garantit pas la valeur absolue d'une
réservation, pour la raison établie au §7.3 bis : les Sparks sont arbitrés contre
les tranches de l'hôte. Toute présentation de cette garantie — API, console,
manuel — doit rester exacte sur ce point tant que SPK-29 n'est pas livrée.

## 8. Hôte cible et stockage

### 8.1 Ce que la machine est réellement

Relevé le 2026-08-18 sur `51.158.54.202`, Dell PowerEdge R320 :

```
CPU        Xeon E5-1410 v2 @ 2.80 GHz — 1 socket, 4 cœurs, 8 threads, SMT actif
           frères SMT : (0,4) (1,5) (2,6) (3,7)
           1 seul nœud NUMA — limits.cpu.nodes sans objet ici
           VT-x présent — runtime: vm techniquement possible
RAM        94 Gio (4 × 16 Gio DDR3-1600), aucun swap actif
DISQUES    2 × Toshiba MG08ADA600E, 6 To, 7200 tr/min — MÉCANIQUES
           RAID1 mdadm : md0 511 Mio → /boot, md1 5,44 Tio ext4 → /
RÉSEAU     eno1 1 Gbit/s (up), eno2 non raccordé
SYSTÈME    Ubuntu 24.04.3, noyau 6.8.0-88, cgroup v2
PAQUETS    incus 6.0.0 et zfsutils-linux 2.2.2 disponibles ; btrfs-progs installé
```

Les pools réels sont plus petits que ceux imaginés dans la conversation
d'origine : 94 Gio et non 256, 1 Gbit/s et non 3, 5,4 Tio et non 6 To. Le
frèrage SMT observé — `(0,4)` et non `(0,1)` — **confirme par la mesure** la règle
du §7.5 : `dedicated: 1 core` doit produire `limits.cpu=0,4`.

Sur 4 cœurs physiques, un cœur dédié coûte 25 % de la machine. Le mode partagé
n'est donc pas seulement le défaut : c'est le mode normal ici, et `dedicated`
devient une exception à justifier.

### 8.2 La contrainte : aucun périphérique bloc libre

`sda4` et `sdb4` s'étendent jusqu'à la fin des disques et forment `md1`, occupé
par un unique `ext4` monté sur `/`. Il ne reste **ni partition libre, ni espace
non alloué**. Un pool de stockage natif exige donc un repartitionnement.

### 8.3 Pourquoi un pool à copie sur écriture, et pourquoi ce n'est pas une question de sauvegarde

Le pool de stockage remplit trois fonctions, dont **aucune n'est la sauvegarde** :

1. **Appliquer les quotas.** C'est la promesse même du produit : « 10 Gio pris sur
   5,4 Tio ». Sans pilote capable de quota, un seul Spark remplit le système de
   fichiers et emporte tous les autres. Ce point n'est pas négociable.
2. **Cloner l'image de base à coût nul.** Trente Sparks issus de Debian 13, sans
   copie sur écriture, sont trente copies complètes de rootfs — sur des disques
   mécaniques en RAID1, la création d'un Spark passe de quelques secondes à
   plusieurs minutes.
3. **Revenir en arrière sur la cellule entière.** Un instantané rend l'état complet
   du Spark : système, images Docker, fichiers Compose, volumes, configuration.

Une sauvegarde applicative vers S3 protège les **données de l'application**. Elle
ne restaure ni le système du Spark, ni ses images, ni sa configuration. Les deux
mécanismes ne se substituent pas : ils ne protègent pas la même chose.

Ce que la sauvegarde applicative externe **rend effectivement superflu**, et qui
sort donc du périmètre : la planification d'`incus export` comme voie principale de
reprise, et toute ambition de réplication `send`/`receive` hors machine. L'unité
SPK-13 s'en trouve réduite aux instantanés locaux, l'export restant une opération
manuelle.

### 8.4 Capacité des pilotes, relevée dans la documentation Incus

| | dir | btrfs | LVM | ZFS |
|---|---|---|---|---|
| quotas de stockage | oui, **seulement** sur ext4/XFS avec quotas de projet activés | oui | oui | oui |
| image optimisée | non | oui | oui | oui |
| création d'instance optimisée | non | oui | oui | oui |
| instantané optimisé | non | oui | oui | oui |
| copie sur écriture | non | oui | oui | oui |
| clonage instantané | non | oui | oui | oui |

Le pilote `dir` est écarté : sans copie sur écriture ni clonage instantané, il
transforme chaque création de Spark en copie intégrale de rootfs sur disque
mécanique, et chaque instantané en copie complète.

### 8.5 Décision

**ZFS, en miroir natif sur une paire de partitions dédiées.** Les motifs, dans
l'ordre :

- le quota `refquota` est exact et c'est le chemin le plus éprouvé d'Incus ;
- ZFS assure lui-même le miroir avec sommes de contrôle : sur des disques de 6 To
  mécaniques, il détecte et **répare** une corruption silencieuse, ce que
  `md` RAID1 ne peut pas faire — `md` ignore laquelle des deux copies est la bonne ;
- l'ARC transforme 94 Gio de RAM en cache de lecture devant des disques à
  7200 tr/min, ce qui est ici un gain substantiel.

Deux contreparties assumées :

- **Module hors arbre.** Ubuntu 24.04 le fournit et le maintient
  (`zfsutils-linux` 2.2.2) ; le risque se limite aux mises à jour de noyau.
- **L'ARC consomme de la RAM hors du registre.** C'est le point le plus important,
  et il interfère directement avec la comptabilité mémoire du §7 : par défaut
  l'ARC peut prendre jusqu'à la moitié de la RAM, que le registre croirait
  allouable. `zfs_arc_max` est donc **posé explicitement** et sa valeur est
  soustraite du pool via `host.memory_reserve_bytes`. Un pool mémoire qui ignore
  l'ARC est un pool qui promet ce qu'il n'a pas.

Repli documenté, si le module hors arbre est refusé : **btrfs**, en `raid1`, qui
apporte aussi sommes de contrôle et réparation, est déjà installé et vit dans le
noyau. Sa contrepartie est que la comptabilité des quotas repose sur les
`qgroups`, dont le coût croît avec le nombre d'instantanés — c'est-à-dire
précisément sur le mécanisme dont dépend la promesse de quota.

Repli sans repartitionnement : pool sur **fichier** posé sur l'`ext4` existant.
C'est le chemin par défaut d'`incus admin init` et il fonctionne, mais il empile
deux systèmes de fichiers sur du disque mécanique et prive ZFS de la gestion du
miroir. Acceptable pour valider la chaîne, pas pour exploiter.

**État au 2026-08-18 : c'est cette voie qui est en place**, sur décision du
responsable, à titre provisoire. Le pool natif en miroir reste la cible ; la dette
est inscrite dans `docs/PROD_MIGRATIONS.md` (OP-01) et n'est pas refermée. Deux
conséquences à ne pas perdre de vue : aucune mesure de débit disque menée sur ce
pool ne caractérise la machine, et ZFS ne protège pas ici contre la corruption
silencieuse puisque le miroir reste géré par `md`.

### 8.6 Disposition de partitions visée

```
sda1 / sdb1   537 Mo   bios_grub
sda2 / sdb2   4,3 Go   swap            — présent, actuellement inutilisé
sda3 / sdb3   537 Mo   md0  → /boot
sda4 / sdb4   ~200 Go  md1  → /  ext4
sda5 / sdb5   ~5,2 To  zpool miroir    — À CRÉER
```

Le passage de la disposition actuelle à celle-ci suppose de réduire `md1`, ce que
`resize2fs` ne sait pas faire à chaud sur un système de fichiers racine monté. Deux
voies, la décision appartenant au responsable :

| Voie | Coût | Risque |
|---|---|---|
| réinstallation avec partitionnement personnalisé | reconfiguration complète de l'hôte | faible — la machine est vide, 2,7 Go utilisés |
| réduction en mode rescue (`resize2fs` puis `mdadm --grow`) | une fenêtre d'indisponibilité | moyen — opération destructive en cas d'erreur |

Sur une machine vide, la réinstallation est la voie **la moins risquée**, pas la
plus lourde.

Point d'exploitation à connaître : `md1` était en resynchronisation au moment du
relevé, à 3,1 % pour environ 8 heures restantes. Toute mesure de débit disque
conduite avant la fin de cette resynchronisation ne mesure pas la machine.

### 8.7 Ce que la mesure du quota a révélé

Trois faits mesurés le 2026-08-18, dont deux imposent une correction du produit.

**1. Le quota mord, mais sur les octets stockés.** La compression ZFS est active par
défaut (`compression=on`). Une première tentative a écrit **20 Gio de zéros** dans un
Spark limité à 10 Gio sans jamais être refusée : la compression les avait absorbés,
`used` restant à 884 Kio. Rejoué avec des données incompressibles, le quota s'est
appliqué exactement :

```
dd if=/dev/urandom … count=12000
  → 10 237 blocs écrits, 10 734 665 728 octets, puis refus
  → used = 10.0G   available = 0B   df = 100 %
```

Le quota est donc réel, mais il porte sur ce qui est **stocké**, pas sur ce que le
locataire écrit. Un Spark à 10 Gio peut contenir bien plus de 10 Gio de données
compressibles. Ce n'est pas un défaut, c'est une sémantique à choisir puis à
énoncer : soit on l'assume et le manuel l'explique, soit la compression est
désactivée par jeu de données pour que le quota compte les octets logiques.

**2. Incus pose `quota`, pas `refquota`.** Conséquence directe : les instantanés
d'un Spark sont **imputés à son propre quota**. Un Spark qui prend des instantanés
réduit l'espace dont il dispose. C'est défendable — l'instantané consomme
réellement — mais cela doit apparaître dans la console, sans quoi l'espace
disparaît sans explication.

**3. Un Spark qui remplit son quota verrouille son administration.** C'est le fait
le plus gênant. `backup.yaml` est écrit par Incus **à l'intérieur** du jeu de
données contingenté. Disque plein, toute reconfiguration échoue :

```
Error: Failed to write backup file: … open
/var/lib/incus/containers/spark-test/backup.yaml: disk quota exceeded
```

Un locataire qui sature son disque empêche donc le plan de contrôle de modifier ses
limites — y compris de l'agrandir pour le débloquer. Le remède est de ne jamais
poser le quota du jeu de données exactement à la valeur annoncée : le registre
réserve une **marge de métadonnées** (quelques dizaines de mébioctets) au-dessus de
la taille vendue, invisible du locataire. Unité SPK-30.

## 9. Ingress

Un unique Caddy sur l'hôte détient l'exposition publique et les certificats. Le
contrat est délibérément minimal :

```
domaine  →  spark  →  port
```

```
crm.p2enjoy.studio  →  spark:crm-production  →  10.77.0.11:8080
```

La pile Compose du locataire reste parfaitement ordinaire :

```yaml
services:
  web:
    ports:
      - "8080:8080"
```

`8080` n'est joignable que sur l'interface privée du Spark.

Ce qui est **refusé** : que chaque pile Compose pilote le proxy de l'hôte par des
labels Docker, une socket Traefik ou un montage de `/var/run/docker.sock`. Cela
recouplerait le plan de contrôle au runtime Docker du locataire et détruirait la
frontière posée au §2.

`sparkd` pilote Caddy par son API d'administration sur `127.0.0.1:2019`, qui
applique à chaud des modifications valides de la configuration JSON active. Le
registre reste la source de vérité ; Caddy en est le reflet, et une commande de
réconciliation doit pouvoir reconstruire intégralement la configuration Caddy
depuis le registre.

## 10. Découpage du monorepo

```
spark-environment/
├── apps/
│   └── webui/          console locale : SPA React/Vite + hôte Node (tunnels SSH)
├── services/
│   └── sparkd/         runtime serveur : FastAPI, 127.0.0.1, pilote Incus/Caddy
├── packages/
│   └── contract/       contrat d'API partagé (OpenAPI + types TypeScript générés)
├── deploy/
│   ├── dev/            pile de développement autonome
│   ├── staging/
│   └── prod/
├── scripts/            bootstrap, seed, preuves
└── docs/
```

Deux livrables, un contrat entre les deux, conformément à la consigne du
responsable : « un monorepo, un avec la webui locale et un avec le runtime
serveur ».

### 10.1 Choix des langages, et leur contrepartie

| Paquet | Langage | Motif | Contrepartie assumée |
|---|---|---|---|
| `services/sparkd` | Python 3 + FastAPI | convention maison ; le travail réel est de l'orchestration de processus (`incus`), de la comptabilité SQLite et du HTTP, où Python est adapté et testable rapidement | un binaire Go serait déployable en un fichier unique ; ici le déploiement passe par un paquet et un service systemd, ce qui reste acceptable |
| `apps/webui` | TypeScript (Vite + React, hôte Node) | convention maison pour l'UI ; l'hôte local et la SPA partagent une seule chaîne d'outillage et une seule commande de lancement | deux langages dans le dépôt ; le contrat d'API les sépare proprement |

La conversation d'origine suggérait « un très petit démon Go ou Rust ». L'écart
est délibéré : `CLAUDE.md` §3 fixe Python pour les services backend, et rien dans
ce runtime n'est sensible à la latence au point de le justifier. Si une mesure
montre un jour le contraire, le contrat d'API rend le remplacement de `sparkd`
possible sans toucher à la console.

## 11. Sécurité

- Aucune API d'administration exposée au réseau ; le seul vecteur d'accès est SSH.
- Les Sparks sont non privilégiés, `security.idmap.isolated=true`, afin que deux
  Sparks ne partagent pas de plage UID/GID sur l'hôte.
- Toute règle d'autorisation est appliquée par `sparkd`, jamais par la console.
  Masquer un bouton n'est qu'une aide visuelle.
- Aucun secret n'entre dans le dépôt. Les clés SSH gérées par le produit sont des
  clés **publiques** ; les clés privées restent sur le poste du responsable.
- Chaque opération mutante est tracée dans un journal d'audit persistant.
- Un *system container* partage le noyau de l'hôte : pour des charges hostiles ou
  réellement multi-locataires, le mode `vm` est la réponse, pas un durcissement du
  mode `container`.

## 12. Développement local

Le poste de développement ne dispose ni d'Incus ni du serveur cible. La pile de
développement doit donc rester autonome, sans service payant ni dépendance au
serveur de production :

- `sparkd` s'exécute avec un **pilote Incus factice** enregistrant les commandes
  qu'il aurait passées, pour les tests unitaires et d'API ;
- une **VM Incus jetable** fournit les tests d'intégration et E2E réels ;
- le seed produit des Sparks, des routes d'ingress, des clés et un historique
  d'audit couvrant les cas nominaux, les refus d'admission et les états d'erreur.

Un pilote factice sert à tester la traduction et l'admission control. Il ne prouve
jamais qu'un quota est appliqué : cette preuve exige un hôte Incus réel.

## 13. Vérifications dues avant toute déclaration de conformité

Statut au 2026-08-18, après une première campagne de mesures sur l'hôte.

### Confirmées par la mesure

1. **Reconfiguration du cpuset à chaud** — `0-7` → `0-5` appliqué sans redémarrage,
   `uptime` continu, `nproc` interne suivi. §7.4.
2. **Topologie SMT** — `incus info --resources` concorde avec `/sys` :
   `(0,4) (1,5) (2,6) (3,7)`. §7.5.
3. **Quota du disque racine** — l'écriture de données **incompressibles** s'arrête
   exactement à 10 Gio, `available` tombe à `0B`. §8.7.
4. **Plafond réseau** — classe `htb` `rate 100Mbit ceil 100Mbit`. §7.6.
5. **Cloisonnement des UID/GID** — `volatile.idmap.base=1065536`, table du conteneur
   `0 1065536 65536`. §10.
6. **Correspondance `allowance` → poids** — loi `cpu.weight = pct − 10 + priorité`
   établie sur onze points, et `cpu.max` laissé à `max` donc burst réel. §7.2 bis.

### Infirmées par la mesure, et corrigées dans ce document

7. **`allowance` et `priority` étaient présentés comme indépendants.** Faux : ils
   s'additionnent dans un unique poids. §7.2 bis.
8. **La mise à l'échelle du poids était inutilisable.** `réservation / capacité × 100`
   refuse toute réservation sous 0,25 CPU sur un pool de 4 CPU. Remplacée par un
   facteur 1000. §7.2 bis.
9. **L'invariant d'admission control ne suffisait pas.** Les Sparks sont frères des
   tranches de l'hôte à la racine de cgroup v2 : la réservation n'est proportionnelle
   qu'entre Sparks, pas absolue. §7.3 bis, unité SPK-29.
10. **Le quota bloque le plan de contrôle.** Un Spark qui remplit son quota empêche
    Incus d'écrire son `backup.yaml`, donc toute reconfiguration. §8.7, unité SPK-30.

### Confirmées, suite

11. **Nesting Docker complet** — pile Compose réelle dans un Spark non privilégié à
    idmap isolé, AppArmor actif, sans contournement ; `HTTP 200` depuis l'hôte sur
    l'IP privée. Docker retient `overlayfs` au-dessus du rootfs ZFS. Exige
    Incus ≥ 6.19 ; mesuré fonctionnel en 7.3, et **cassé en 6.0.0**. §3.1.

### Restant à vérifier

12. **`zfs_arc_max` soustrait du pool** — **confirmé le 2026-08-19.** Plafonné à
    16 Gio, lu sur le module et reporté dans `host.memory_reserve_bytes` avec la
    marge d'exploitation : le pool annoncé passe de 98,0 à 76,2 Gio. Reste à
    vérifier la seule chose que la mesure statique ne dit pas : que la
    consommation réelle de l'ARC demeure sous son plafond **en charge**.
13. **Compression et quota** — la compression étant active, le quota porte sur les
    octets **stockés**, pas sur les octets logiques. Décision à prendre : documenter
    l'écart, ou désactiver la compression par jeu de données. §8.7.

## 14. Cycle de vie d'un Spark

`docs/SCHEMA.md` §4 énumère les états. Cette section fixe les **transitions**, et
ce qui se passe quand une opération échoue au milieu — que le modèle de données
ne pouvait pas dire.

### 14.1 Les transitions autorisées

```
        (néant)
           │ create
           ▼
       ┌────────┐   apply    ┌──────────┐  ok   ┌─────────┐
       │pending │──────────▶ │ creating │──────▶│ stopped │◀──┐
       └────────┘            └──────────┘       └─────────┘   │
           │                       │ échec           │ start   │ ok
           │                       ▼                 ▼         │
           │                  ┌───────┐         ┌──────────┐   │
           └─────────────────▶│ error │         │ starting │   │
                     échec    └───────┘         └──────────┘   │
                                │ │ retry            │ ok      │
                                │ └──────────────────┼─────┐   │
                                │                    ▼     │   │
                                │              ┌─────────┐ │   │
                                │              │ running │ │   │
                                │              └─────────┘ │   │
                                │                    │ stop│   │
                                │                    ▼     │   │
                                │              ┌──────────┐│   │
                                │              │ stopping ├┘───┘
                                │              └──────────┘
                                ▼
                          ┌──────────┐
                          │ deleting │──▶ (néant)
                          └──────────┘
```

Tout état **stable** — `pending`, `stopped`, `running`, `error` — peut aller vers
`deleting`. Aucun état **transitoire** — `creating`, `starting`, `stopping`,
`deleting` — n'accepte une nouvelle commande : une opération est déjà en cours, et
en lancer une seconde produirait deux vérités concurrentes sur la même instance.

Un redémarrage n'est pas un état : c'est `running → stopping → stopped →
starting → running`. Le modéliser autrement cacherait la fenêtre pendant laquelle
le Spark est réellement arrêté.

Une transition interdite est **refusée en nommant l'état courant et les commandes
possibles depuis là**. Un refus muet obligerait l'appelant à deviner.

### 14.2 Le registre s'écrit avant Incus, jamais l'inverse

L'ordre de la création est imposé, et il n'est pas symétrique :

```
1. admission control            ← refuse ici, avant toute écriture
2. écriture de la ligne         état = pending
3. création dans Incus          état = creating
4. confirmation                 état = stopped
```

Motif : les deux pannes possibles n'ont pas le même coût.

- Écrire d'abord, et mourir avant Incus, laisse **une ligne sans instance**. Le
  registre surestime l'occupation : c'est visible, réconciliable, et sans danger.
- Créer d'abord, et mourir avant d'écrire, laisse **une instance sans ligne**.
  Elle consomme du CPU, de la RAM et du disque réels que la comptabilité ignore.
  L'admission control admettrait alors des Sparks dans une capacité déjà prise,
  et le refus tomberait sur un locataire innocent.

Entre surestimer et sous-estimer l'occupation, on surestime toujours.

L'admission control et l'écriture de la ligne se font dans **la même
transaction**. Sans cela, deux créations concurrentes passeraient toutes deux un
contrôle qu'aucune n'a encore invalidé.

### 14.3 Reprise après échec : les états transitoires ne survivent pas au démarrage

Un état transitoire décrit une opération **en cours**. Si `sparkd` s'arrête au
milieu, plus personne ne la mène : l'état ment.

Au démarrage, `sparkd` réconcilie donc chaque Spark en état transitoire avec la
réalité d'Incus :

| État trouvé | Instance dans Incus | Conclusion |
|---|---|---|
| `creating` | absente | retour à `pending` — la création n'a pas eu lieu |
| `creating` | présente | passe à `stopped` — elle a abouti |
| `starting` | arrêtée | `stopped` |
| `starting` | démarrée | `running` |
| `stopping` | démarrée | `running` |
| `stopping` | arrêtée | `stopped` |
| `deleting` | absente | la ligne est supprimée — la suppression a abouti |
| `deleting` | présente | reste `deleting`, à reprendre |

Chaque réconciliation est journalisée. Un état transitoire retrouvé au démarrage
n'est pas une anomalie du produit : c'est la trace d'un arrêt, et il doit se lire
comme tel.

Le retour à `pending` plutôt qu'à `error` est délibéré : rien n'a été créé, la
demande reste valide, et l'exploitant n'a pas à décider quoi que ce soit.

### 14.4 Ce que la suppression rend, et quand

La ressource n'est rendue **qu'à la disparition de la ligne** (§7.7). Un Spark en
`deleting` compte donc encore. C'est ce qui empêche qu'une suppression lente
laisse admettre un Spark dans une place pas encore libérée.

## 15. Adressage du réseau privé

Le §5 pose le bridge privé. Cette section fixe **qui attribue les adresses**, ce
qui n'était écrit nulle part et que le code ne peut pas deviner.

### 15.1 Le registre attribue, Incus épingle

L'adresse d'un Spark est allouée par le **registre**, à la création, avant
qu'Incus ne soit touché — comme la ligne elle-même (§14.2).

Deux raisons, et la seconde est décisive :

- l'ingress a besoin de l'adresse **avant** que l'instance existe : une route
  `domaine → spark → port` se déclare sur un Spark encore arrêté ;
- laisser Incus attribuer par DHCP ferait découvrir une collision au moment de
  l'application, alors que la ligne est déjà écrite et la capacité déjà
  comptabilisée. Le refus tomberait trop tard pour être utile.

Incus reçoit ensuite l'adresse par `ipv4.address` sur le périphérique NIC, et
inscrit une entrée statique dans son dnsmasq. **Mesuré le 2026-08-19** :
l'adresse est conservée au redémarrage de l'instance, et Incus refuse lui-même
un doublon — `IP address "10.77.0.50" already defined on another NIC`. Cette
vérification est une seconde ligne de défense, pas la première.

### 15.2 Plan d'adressage

```
10.77.0.1                passerelle, portée par sparkbr0
10.77.0.2   – 10.77.0.15 réservé à l'infrastructure de l'hôte
10.77.0.16  – 10.77.0.239 attribué par le REGISTRE — 224 Sparks
10.77.0.240 – 10.77.0.254 DHCP dynamique, hors du produit
```

La plage dynamique est **disjointe** de la plage du registre, imposée par
`ipv4.dhcp.ranges` sur le réseau géré. Sans cette restriction, dnsmasq
distribuerait dans tout le `/24` et pourrait attribuer à une instance non gérée
une adresse que le registre a déjà promise à un Spark.

**Mesuré le 2026-08-19** : avec `ipv4.dhcp.ranges=10.77.0.240-10.77.0.254`, une
instance non épinglée reçoit `10.77.0.247`, et un Spark épinglé sur `10.77.0.50`
— hors plage dynamique — conserve son adresse.

### 15.3 Attribution déterministe, et épuisement explicite

Le registre attribue **la plus petite adresse libre**. Ce n'est pas une
commodité d'implémentation : c'est ce qui rend l'attribution prévisible, donc
vérifiable. Un exploitant qui supprime puis recrée un Spark dans un parc
inchangé retrouve la même adresse, et ses notes restent vraies.

L'épuisement de la plage est **refusé en le nommant**, jamais contourné en
débordant sur une plage voisine. Une plage qui déborde silencieusement finit par
recouvrir la passerelle ou le DHCP, et la panne se manifeste alors très loin de
sa cause.

L'unicité est portée par la base — `ipv4_address TEXT UNIQUE`, `docs/SCHEMA.md`
§4 — et l'attribution se fait dans la même transaction que la création, pour la
raison du §14.2 : deux créations concurrentes ne doivent pas obtenir la même
adresse.

### 15.4 Ce que le plafond réseau garantit, et ce qu'il ne garantit pas

`network.burst` devient `limits.max` sur le NIC, soit une classe `htb` dont
`rate` égale `ceil` : c'est un **plafond strict**, sans dépassement possible.

`network.reservation` reste une grandeur de comptabilité (§7.6). Le noyau
n'offre pas de réservation de bande passante avec cette primitive : rien ne
garantit qu'un Spark obtienne son débit réservé quand les autres saturent le
lien. La console doit présenter les deux différemment.


## 16. La réserve de l'hôte

Le §7.7 pose que la capacité allouable n'est jamais la capacité physique. Cette
section dit **ce qu'on soustrait**, et pourquoi chaque terme est nécessaire.

### 16.1 Trois consommateurs que le registre doit connaître

```
MemTotal (noyau)                        94,2 Gio   ← base, §5.2
  − plafond de l'ARC ZFS                16,0 Gio
  − marge d'exploitation de l'hôte       2,0 Gio   ← réglable
  ─────────────────────────────────────────────
  = mémoire réellement allouable        76,2 Gio
```

**L'ARC.** ZFS peut prendre jusqu'à son plafond à tout instant, sans prévenir et
sans que rien ne l'en empêche. Une réserve qui l'ignore promet une mémoire que
le noyau reprendra sous les Sparks. Mesuré le 2026-08-19 : le registre annonçait
98,0 Gio allouables avec une réserve à zéro, alors que l'ARC était plafonné à
16 Gio — soit un cinquième du pool promis en trop.

**L'hôte lui-même.** `sparkd`, Incus, dnsmasq, `sshd`, systemd et le noyau
consomment. Mesuré : 3,1 Gio en marche à vide. Cette part est un **réglage
explicite** (`SPARKD_MEMORY_RESERVE`) et non une valeur devinée : elle dépend de
ce que l'exploitant fait tourner à côté, et le produit n'a pas à le supposer.

### 16.2 Lire le plafond, ne jamais le supposer

Le plafond de l'ARC est lu sur `/sys/module/zfs/parameters/zfs_arc_max`, source
autoritaire et lisible sans privilège (mesuré).

S'il est **illisible** — module absent, pilote de stockage autre que ZFS — la
réserve retombe sur la seule marge configurée, et le relevé est journalisé en
`result=denied` avec la raison. On ne suppose **jamais** un ARC nul : c'est
précisément l'hypothèse qui a produit le défaut ci-dessus, et la supposer en
silence le reproduirait.

Lorsque `zfs_arc_max` vaut `0`, ZFS applique son propre défaut — la moitié de la
RAM. Le registre retient alors cette moitié, et non zéro : un plafond non posé
n'est pas un plafond absent.


## 17. Accès SSH aux Sparks

### 17.1 Pourquoi ce n'est pas cloud-init

`docs/SCHEMA.md` annonçait une injection par cloud-init à la création. La mesure
du 2026-08-19 a écarté cette voie, pour trois raisons dont la dernière suffit.

- L'image `images:debian/13` n'embarque **ni cloud-init ni sshd**. La variante
  `debian/13/cloud` existe (132 Mio contre 100), mais imposer une variante
  contraindrait le choix d'image de l'exploitant.
- `cloud-init.ssh-keys.*` **n'existe pas** dans Incus 7.3 :
  `Unknown configuration key`. Seuls `cloud-init.user-data` et
  `cloud-init.vendor-data` sont acceptés.
- Surtout : **cloud-init ne s'exécute qu'au premier démarrage.** Retirer une clé
  d'un Spark existant lui est donc structurellement hors de portée. Une
  conception fondée sur cloud-init aurait besoin d'un second mécanisme pour le
  retrait — et deux mécanismes écrivant le même état finissent par diverger.

**Décision : un seul mécanisme.** Le registre écrit `authorized_keys` dans le
Spark par l'API de fichiers d'Incus, aussi bien à la création qu'à chaque
changement. Le fichier est **réécrit en entier** à partir de l'état voulu, jamais
modifié par ajout : c'est ce qui garantit qu'un retrait retire réellement, et que
le contenu du Spark ne dérive pas de ce que le registre annonce.

### 17.2 Ce qui est stocké, et ce qui ne l'est jamais

Seules des clés **publiques**. La base le fait respecter par une contrainte, pas
par une consigne : `CHECK (public_key NOT LIKE '%PRIVATE KEY%')`
(`docs/SCHEMA.md` §7). Une clé privée collée par erreur est refusée à l'écriture,
pas détectée plus tard.

L'empreinte est celle d'OpenSSH — `SHA256:` suivi du condensat base64 sans
remplissage — pour que ce que la console affiche soit ce que `ssh-keygen -lf`
affiche. Une empreinte maison obligerait à traduire mentalement à chaque
vérification.

Le journal d'audit retient le **label et l'empreinte**, jamais le corps de la
clé : une clé publique n'est pas un secret, mais un journal n'a pas à la répéter.

### 17.3 Provisionnement : ce que la création installe

Un Spark neuf reçoit `openssh-server`, puis Docker et Compose si
`docker_enabled`. Mesuré : environ **130 secondes** pour `openssh-server` sur
l'hôte de validation, dépendant du réseau. La création d'un Spark n'est donc pas
instantanée, et la console doit le montrer plutôt que de laisser croire à un
blocage.

Le serveur SSH du Spark n'accepte que l'authentification par clé. Le mot de passe
est désactivé, y compris pour `root` : un Spark n'a pas de mot de passe à
deviner.

### 17.4 Aucun port SSH public, jamais

Un Spark n'expose pas `22` sur l'extérieur. L'accès se fait par **rebond sur
l'hôte**, dont le `sshd` est la seule porte du système (§5) :

```sshconfig
Host spark-crm
    HostName 10.77.0.16
    User root
    ProxyJump spark-host
    IdentityFile ~/.ssh/spark-crm
```

La console produit ce fragment à partir du registre. Elle ne le devine pas :
l'adresse vient de `ipv4_address`, qui est attribuée par le registre (§15.1).

Conséquence à ne pas perdre de vue : quiconque peut se connecter à l'hôte peut
atteindre le réseau privé. Le rebond simplifie l'accès, il ne cloisonne pas
l'hôte des Sparks — et le §11 reste la référence sur ce que l'isolation garantit.


## 18. Réconciliation de l'ingress

Le §9 pose le contrat `domaine → spark → port`. Cette section dit **comment** la
configuration de Caddy est produite, ce que le §9 laissait ouvert.

### 18.1 On régénère, on ne rapièce pas

`sparkd` construit la configuration **entière** de Caddy depuis le registre et la
pose d'un seul geste sur `POST /load`. Mesuré le 2026-08-19 : cet appel applique
à chaud, sans interruption de service, et rend `200`.

C'est le même principe qu'`authorized_keys` (§17.1), et pour la même raison : une
configuration rapiécée diverge. Un `PATCH` route par route laisserait subsister
les routes d'un Spark supprimé pendant que `sparkd` s'arrêtait, et rien ne
permettrait de distinguer cet état d'un fonctionnement normal. Régénérer rend la
dérive **impossible plutôt qu'improbable**.

La conséquence pratique est que la réconciliation n'est pas une opération de
réparation exceptionnelle : c'est le mécanisme **normal** d'application. Toute
modification de route la déclenche.

### 18.2 Forme de la configuration produite

```json
{"apps": {"http": {"servers": {"spark": {
  "listen": [":80", ":443"],
  "routes": [
    {"match": [{"host": ["crm.example.com"]}],
     "handle": [{"handler": "reverse_proxy",
                 "upstreams": [{"dial": "10.77.0.16:8080"}]}]}
  ]}}}}}
```

L'amont est `ipv4_address:target_port` — l'adresse que le **registre** a
attribuée (§15.1), jamais une découverte par Docker ou par étiquettes. C'est ce
qui maintient la frontière du §2 : le plan de contrôle ne consulte pas le runtime
du locataire.

La configuration se termine par une **route terminale sans filtre**, qui rend
`404`. Sans elle, Caddy répond `200` avec un corps vide à **tout** domaine non
routé — mesuré le 2026-08-19. L'hôte répondrait alors au nom de domaines qu'il ne
sert pas, et une erreur de pointage DNS resterait invisible au lieu de se
manifester tout de suite. Elle vient après les routes nommées, sans quoi elle les
masquerait.

Seules les routes `enabled` d'un Spark ayant une adresse sont émises. Une route
déclarée sur un Spark encore `pending` existe dans le registre — c'est voulu, on
déclare avant de créer — mais n'est pas servie tant qu'il n'y a rien à servir.

### 18.3 TLS : ce qui est automatique, et ce qui ne peut pas l'être

Une route à `tls = 1` est confiée à la gestion automatique de Caddy, qui obtient
et renouvelle le certificat. Une route à `tls = 0` n'est servie qu'en clair sur
`:80` — utile pour un domaine interne, un essai, ou un frontal qui termine déjà
le TLS.

**L'émission d'un certificat suppose que le domaine résolve vers cet hôte.** Ce
n'est pas une propriété que le produit contrôle : elle dépend du DNS, extérieur
au système. Un domaine mal pointé produit un échec d'émission côté Caddy, pas une
erreur de `sparkd` — et la console doit présenter cet écart comme tel plutôt que
de laisser croire à une panne du plan de contrôle.

### 18.4 L'unicité du domaine appartient à la base

`ingress_route.domain` est `UNIQUE` (`docs/SCHEMA.md` §6). Deux Sparks ne peuvent
pas revendiquer le même nom, et le refus vient de la base — pas d'un contrôle
dans l'interface, qui ne protégerait de rien face à deux requêtes simultanées.

### 18.5 `applied_at`, ou la dérive rendue visible

Chaque route porte la date de sa dernière application réussie. Une route
enregistrée mais jamais appliquée — Caddy injoignable au moment de la demande —
se voit donc immédiatement, au lieu de se déduire d'une comparaison manuelle
entre le registre et la configuration active.

## 19. Instantanés et restauration

Le §8.3 dit *pourquoi* les instantanés existent. Cette section dit ce que la
mesure du 2026-08-19 impose sur le *comment*.

### 19.1 Restaurer un instantané ancien détruit les suivants — et cela se refuse

ZFS rembobine un jeu de données : revenir à un point détruit tout ce qui a été
capturé depuis. Incus le sait et **refuse** plutôt que de le faire en silence :

```
Snapshot "avant-changement" cannot be restored due to subsequent snapshot(s).
Set zfs.remove_snapshots to override
```

**Décision : ce refus est conservé comme comportement par défaut.** Restaurer un
point ancien en détruisant sans prévenir tous les instantanés pris depuis est
exactement le genre de surprise irréversible qu'un plan de contrôle ne doit pas
produire. `sparkd` relaie donc le refus **en nommant les instantanés qui
bloquent**, et n'écrase qu'à la demande explicite de l'exploitant.

La demande explicite est un drapeau de la requête, jamais une option de
configuration : une configuration se pose une fois et s'oublie, alors que la
perte est décidée instantané par instantané.

### 19.2 Un instantané ne suspend pas le Spark

Mesuré : la création d'un instantané sur un Spark en marche n'interrompt pas son
exécution, et la restauration le laisse `RUNNING`. Un témoin écrit après
l'instantané disparaît bien après restauration, et les fichiers supprimés
reviennent.

Le Spark n'est donc pas arrêté pour être capturé — mais son système de fichiers
est figé à un instant qui ne correspond à aucun point de cohérence applicatif.
Une base de données en cours d'écriture au moment de l'instantané se retrouvera,
à la restauration, dans l'état d'un arrêt brutal. C'est acceptable pour ce que
l'instantané sert — revenir avant un déploiement raté — et c'est précisément
pourquoi il ne remplace pas la sauvegarde applicative (§8.3).

### 19.3 L'instantané avec état n'est pas disponible

`--stateful` capture la mémoire du conteneur et exige `migration.stateful=true`.
Mesuré sur l'hôte : même activé, la capture échoue —
`CRIU was built without libnftables support`, puis `snapshot dump failed`.

Le modèle porte le champ `stateful` (`docs/SCHEMA.md` §8) et il restera à `false`
sur cet hôte. Le produit **ne propose pas** cette option tant qu'elle n'a pas été
mesurée fonctionnelle : offrir un bouton qui échoue à l'usage vaut moins que ne
pas l'offrir.

### 19.4 Un instantané consomme le quota du Spark

Mesuré : le quota est posé sur le jeu de données parent, qui **inclut** ses
instantanés (§8.7). Un instantané coûte d'abord zéro — il partage tous ses
blocs — puis grossit à mesure que le Spark s'en écarte.

Conséquence à énoncer dans l'interface : un Spark qui accumule des instantanés
voit son espace disponible diminuer sans qu'aucun fichier n'ait été ajouté.
Laisser l'exploitant le découvrir par un disque plein serait un mauvais service.

### 19.5 Ce qu'un instantané n'est pas

Il vit dans le même pool que le Spark. Il ne protège **ni** de la perte du pool,
**ni** de celle de la machine. La console ne doit jamais le présenter comme une
sauvegarde : les deux notions restent distinctes dans le modèle comme dans
l'interface (`docs/SCHEMA.md` §8).

## 20. Métriques d'usage

Relevé le 2026-08-19 sur `/1.0/instances/<nom>/state`. Ce que la mesure impose,
et ce qu'elle interdit d'afficher.

### 20.1 Ce qui est instantané, et ce qui est un compteur

```
memory.usage         instantané   → comparable directement
disk.root.usage      instantané   → comparable directement
cpu.usage            COMPTEUR     nanosecondes cumulées depuis le démarrage
network.<if>.counters COMPTEUR    octets cumulés depuis le démarrage
```

Un compteur ne répond pas à « combien consomme-t-il ». Deux relevés à trois
secondes d'intervalle ont donné `4 815 083 000` puis `4 817 955 000` ns, soit
`0,0010 CPU` — un taux qu'aucune lecture unique n'aurait pu produire.

`sparkd` conserve donc le relevé précédent et calcule le taux, **en publiant la
fenêtre de mesure**. Un taux sans sa fenêtre n'est pas interprétable : « 0,3 CPU »
sur trois secondes et sur une heure ne disent pas la même chose.

**Au premier relevé, il n'y a pas de fenêtre. Le taux vaut alors `null`, jamais
`0`.** Annoncer zéro serait affirmer une mesure qu'on n'a pas faite — et zéro est
une valeur plausible, donc indétectable.

### 20.2 Seule `eth0` compte pour le réseau

Le relevé énumère aussi `docker0` et les `br-*` que Docker crée dans le Spark.
Ce trafic est **interne au Spark** : il ne traverse jamais le bridge de l'hôte et
ne consomme aucune bande passante du pool. L'additionner ferait apparaître une
consommation réseau là où rien n'est sorti, et la fausserait d'autant plus que la
pile du locataire est bavarde entre ses propres conteneurs.

Seule l'interface rattachée au bridge privé est comptée.

### 20.3 À quoi chaque usage se compare — et à quoi il ne se compare pas

| Usage | Se compare à | Remarque |
|---|---|---|
| mémoire | `limits.memory` | plafond réellement appliqué |
| disque | quota du disque racine | **inclut les instantanés** (§19.4) |
| CPU | la **réservation** | garantie seulement proportionnelle (§7.3 bis) |
| réseau | le **plafond** `network.burst` | **jamais** à `network.reservation` |

La dernière ligne est celle qui compte. `network.reservation` est une grandeur de
comptabilité pour l'admission control (§7.6) : le noyau ne garantit aucun débit.
Afficher « 40 Mbit/s sur 100 réservés » laisserait croire à une garantie qui
n'existe pas. La comparaison se fait au plafond, seule valeur que le système
applique.

De même, une consommation CPU rapportée à la réservation ne dit pas que cette
réservation est tenue en valeur absolue : tant que SPK-29 n'est pas livrée, elle
ne l'est qu'entre Sparks.

### 20.3 bis Consommer plus que sa réservation est NORMAL

Mesuré le 2026-08-19 : un Spark réservant `0,5 CPU`, chargé par deux boucles sur
un hôte au repos, consomme **1,996 CPU** sur une fenêtre de six secondes — quatre
fois sa réservation.

Ce n'est pas un dépassement, c'est le produit qui fonctionne. Le mode `shared`
laisse `cpu.max` à `max` : aucun plafond n'est posé, et « hors contention, un
Spark consomme tout ce qui traîne » (§7.1). La réservation est un **droit
d'ordonnancement sous contention**, pas un plafond.

**Conséquence pour l'interface, et elle n'est pas facultative.** Une jauge qui
afficherait « 1,99 / 0,5 » en rouge signalerait une violation là où il n'y a
qu'un usage optimal de la machine. L'usage au-delà de la réservation se présente
comme du **burst**, distinct de la part garantie — et un dépassement n'existe
que dans le mode `capped`, seul mode où un plafond est réellement posé.

Sans cette distinction, chaque exploitant signalera le même faux défaut.

### 20.4 Un Spark arrêté n'a pas d'usage nul, il n'en a pas

Interroger l'état d'un Spark arrêté ne rend aucune métrique. Le produit répond
alors que l'usage est **indisponible**, et non nul : un disque occupé reste
occupé même quand rien ne tourne, et afficher `0` sur les quatre ressources
laisserait croire qu'un Spark arrêté ne coûte rien. Il coûte son disque, et sa
place dans la comptabilité (§7.7).

## 21. Journal d'audit

`docs/SCHEMA.md` §9 dit que le `payload` est filtré avant écriture. Cette section
dit **où** le filtre s'applique et **ce qu'il retient**, ce qui n'était écrit
nulle part.

### 21.1 Un seul chemin d'écriture

Constat du 2026-08-19 : cinq modules écrivaient chacun leur `INSERT INTO
audit_log`, avec un payload composé à la main. Un filtre posé à cinq endroits
sera oublié au sixième — et l'oubli ne se verra pas, puisqu'un journal qui
contient trop ressemble à un journal qui fonctionne.

**Toute écriture passe désormais par une fonction unique.** Ce n'est pas une
commodité d'organisation : c'est ce qui rend l'omission impossible plutôt
qu'improbable. Aucun module n'émet plus de `INSERT` vers cette table.

### 21.2 On caviarde, on ne supprime pas

Une valeur sensible est remplacée par un marqueur, la clé restant visible :

```
{"label": "poste", "public_key": "ssh-ed25519 AAAA…"}
      →  {"label": "poste", "public_key": "[caviardé]"}
```

Supprimer la clé effacerait l'information « ce champ était présent », qui compte
lors d'une enquête : savoir qu'un secret a transité par un appel n'est pas la
même chose que ne rien savoir. Le journal doit rester lisible comme récit de ce
qui s'est passé.

### 21.3 Ce qui est reconnu comme sensible

**Par le nom du champ**, quelle que soit sa valeur : tout nom contenant
`password`, `secret`, `token`, `credential`, `authorization`, `private_key`,
`passphrase`, `api_key`, ou `key` seul. Le nom est le signal le plus fiable :
il est choisi par le développeur, alors que la valeur peut prendre n'importe
quelle forme.

`public_key` est caviardée elle aussi. Une clé publique n'est pas un secret,
mais un journal n'a pas à la répéter (§17.2) — et distinguer `public_key` de
`private_key` par un préfixe est exactement le genre de finesse qui se retourne
le jour où quelqu'un nomme un champ `user_key`.

**Par la forme de la valeur** : un bloc PEM (`-----BEGIN … PRIVATE KEY-----`),
un en-tête `Authorization:`, ou une chaîne commençant par `ssh-` suivie de
base64. Ce second filet attrape ce qu'un nom anodin laisserait passer.

### 21.4 Un payload n'est pas un dépotoir

Le journal de l'ingress écrivait la **configuration Caddy entière** dans son
payload. Ce n'est plus une trace, c'est une copie — coûteuse en place, illisible
à la relecture, et prête à emporter le premier secret qu'on ajoutera à cette
configuration.

Le payload est donc **borné**. Au-delà, il est tronqué en le disant. Ce qu'un
journal doit permettre, c'est de reconstituer *qui a fait quoi et avec quel
résultat* — pas de rejouer l'état complet du système.

### 21.5 Ce que le journal retient sans faute

Un **refus** est journalisé au même titre qu'un succès (`docs/SCHEMA.md` §9).
C'est précisément la trace qui manque toujours quand on en a besoin : personne
n'enquête sur une opération qui a réussi.

## 22. L'hôte console

Le §6 pose le principe : le navigateur ne sait rien de SSH, l'hôte console local
porte le tunnel. Cette section fixe le reste.

### 22.1 Le binaire `ssh` du système, pas une bibliothèque

L'hôte console lance `ssh -L` comme sous-processus. Il n'embarque **pas** de
client SSH.

Motif : le poste du responsable a déjà une configuration SSH — `~/.ssh/config`,
un agent, des clés, des `ProxyJump`, parfois une clé matérielle ou une double
authentification. Le binaire système les honore toutes, sans que le produit ait à
les connaître. Une bibliothèque les réimplémenterait mal, et le premier
exploitant avec un bastion dans sa configuration serait bloqué par un outil censé
lui simplifier la vie.

Contrepartie assumée : le produit dépend d'un `ssh` présent sur le poste. C'est
acceptable — tout le modèle d'administration repose déjà sur SSH.

### 22.2 Un tunnel vivant se prouve à travers lui, pas à côté

Un processus `ssh` **mort** se voit tout de suite. Un processus `ssh` **figé** ne
se voit pas : il vit, la socket locale accepte les connexions, et chaque requête
attend indéfiniment. C'est le cas dangereux, parce qu'il ressemble au bon.

La supervision interroge donc `/healthz` **à travers** le tunnel, à intervalle
régulier et avec un délai d'expiration court. Vérifier que le sous-processus est
vivant ne prouve rien : c'est précisément ce que le cas figé met en défaut.

Trois états, et ils sont distincts :

```
connecting   le tunnel s'ouvre
ready        /healthz a répondu à travers lui
broken       il n'a pas répondu, ou le processus est mort
```

### 22.3 Une panne se signale, elle ne se masque pas

Une requête adressée à un tunnel `broken` échoue **immédiatement**, avec le
motif : le dernier état connu, l'heure de la dernière réponse, et l'erreur
rapportée par `ssh`. Elle n'attend pas l'expiration d'un délai réseau, et elle ne
rend pas un `502` anonyme.

La console ne doit **jamais** afficher des données obtenues avant la panne comme
si elles étaient à jour. Une valeur périmée présentée comme actuelle est pire
qu'une erreur : l'exploitant prend une décision sur un état qui n'existe plus.

### 22.4 L'inventaire ne contient aucun secret

`~/.config/spark/servers.json` retient un nom, un hôte, un utilisateur, un port
distant et le port local à ouvrir. **Aucune clé, aucun mot de passe, aucune
phrase de passe.** L'authentification appartient à la configuration SSH du poste,
et le produit n'a pas à la dupliquer — dupliquer un secret, c'est doubler les
endroits où il fuit.

### 22.5 Le port local est demandé au système

Le port local du tunnel est obtenu en laissant le système en choisir un libre,
et non en piochant dans une plage fixée. Une plage fixée entre en collision avec
ce que l'exploitant fait tourner par ailleurs, et la collision se manifeste comme
un tunnel qui « ne marche pas » sans dire pourquoi.

## 23. Le contrat d'API

Le §10 pose `packages/contract` comme frontière entre les deux livrables. Cette
section dit ce qu'il contient et comment il reste vrai.

### 23.1 Le contrat est un fichier committé, pas une réponse HTTP

`sparkd` produit son OpenAPI à l'exécution. Ce n'est pas suffisant, pour deux
raisons.

La console doit pouvoir **se construire sans qu'un `sparkd` tourne** : un
développeur qui ne peut pas compiler sans démarrer le serveur finira par ne plus
vérifier ses types du tout.

Et surtout, un contrat qui n'existe qu'à l'exécution **ne se relit pas**. Committé,
un changement d'API apparaît dans le diff, au moment de la revue, avec le reste du
changement. Non committé, il se découvre en production, par une console qui appelle
un champ disparu.

Le fichier fait donc partie du dépôt, au même titre que le code qui le produit.

### 23.2 La dérive se détecte en régénérant

La vérification est simple et sans échappatoire : régénérer le contrat depuis le
code, comparer au fichier committé, échouer s'ils diffèrent.

C'est le même principe que le checksum des migrations (`docs/SCHEMA.md` §12.4) :
on ne fait pas confiance à la discipline pour maintenir deux choses en accord, on
rend le désaccord détectable.

**La génération doit être déterministe**, sans quoi la vérification échouerait à
chaque exécution et serait désactivée dans la semaine. Le JSON est écrit avec des
clés triées et une indentation fixe.

### 23.3 Les types TypeScript sont dérivés, jamais écrits à la main

`packages/contract` publie des types produits **depuis** l'OpenAPI par
`openapi-typescript`. Ils ne sont pas rédigés à la main : une déclaration
manuelle diverge du serveur dès la première modification, et la divergence se
découvre à l'exécution, chez l'utilisateur.

La console ne redéclare donc jamais la forme d'une donnée de son côté. Le
runtime est la seule source ; la console en dérive.

### 23.4 Ce que la vérification ne dit pas

Le contrat décrit des **formes**, pas des comportements. Qu'un champ existe ne dit
pas qu'il est renseigné, ni que sa valeur est fraîche, ni qu'une opération est
permise. Ces garanties-là appartiennent au runtime et à ses tests, et le §10 de
`CLAUDE.md` reste la référence : une règle d'autorisation n'est jamais portée par
un schéma.

## 24. L'écran détail : le runtime publie ce qui est possible

### 24.1 La console ne redérive pas la machine à états

Le §14.1 définit les transitions autorisées depuis chaque état. La console doit
savoir lesquelles proposer — sans quoi elle affiche des boutons qui échoueront,
ou en cache qui auraient marché.

Deux voies, et une seule est tenable.

**Réimplémenter la table des transitions côté console** est exclu. Ce serait
maintenir la même règle à deux endroits, dans deux langages, avec la certitude
qu'elles divergeront ; et `docs/DESIGN_SYSTEM.md` §14.9 comme `CLAUDE.md` §10
disent la même chose autrement — l'interface n'est jamais l'autorité.

**Le runtime publie les commandes possibles** avec le Spark. `GET
/v1/sparks/<nom>` porte donc un champ `allowed_commands`, dérivé de la même
table que celle qui applique le refus. La console affiche ce que le runtime
déclare ; elle ne le devine pas.

Conséquence directe : une commande absente de cette liste **n'est pas affichée
désactivée, elle n'est pas affichée du tout** — sauf lorsque son absence est
elle-même une information. Un état transitoire, par exemple, n'accepte aucune
commande : l'écran le dit en toutes lettres plutôt que de présenter quatre
boutons morts.

### 24.2 Ce qui demande une confirmation, et ce qui n'en demande pas

`docs/DESIGN_SYSTEM.md` §6.23 et §6.24 tranchent :

| Commande | Confirmation | Raison |
|---|---|---|
| `delete` | **oui**, nommant le Spark | destruction irréversible de la cellule |
| `stop`, `restart` | non | interrompt un service, mais ne détruit rien |
| `start`, `apply`, `retry` | non | réparatrices, sans paramètre, réversibles |

Une confirmation systématique banaliserait celle qui compte (§6.24). La
confirmation de suppression est **intégrée au flux** (§6.22), pas une modale :
pas de voile, pas de piège de focus, pas de gestion globale d'`Échap` à écrire.

### 24.3 L'identité avant tout le reste

`docs/DESIGN_SYSTEM.md` §6.3 : l'identité de l'objet est présentée avant son
historique. Sur cet écran, l'ordre est : identité et état, puis ressources, puis
accès — adresse, clés, routes —, puis instantanés, puis journal.

Les paires terme/valeur utilisent `dl`/`dt`/`dd` (§6.4). Une donnée absente
**n'est pas rendue** ; une absence qui informe est nommée : « Aucune route
publique », « Aucune clé autorisée » — un Spark sans clé n'est pas un Spark dont
on ignore les clés.

## 25. L'écran de création : montrer sans décider

### 25.1 Une estimation qui informe, jamais qui bloque

La DoD de SPK-20 demande deux choses qui semblent s'opposer : afficher la
capacité restante **avant** validation, et faire venir le refus de `sparkd`
**seulement**. Elles ne s'opposent pas, à condition de séparer *montrer* de
*décider*.

L'écran affiche la capacité restante — c'est ce qui permet de dimensionner un
Spark sans tâtonner. Il **n'interdit rien** sur cette base :

- le bouton de création n'est **jamais** désactivé parce que l'estimation locale
  juge la demande trop grande ;
- lorsque l'estimation dit que ça ne tiendra pas, l'écran **avertit** et laisse
  soumettre.

Motif, et il est concret : la capacité affichée est une photographie prise à
l'ouverture de l'écran. Un Spark supprimé entre-temps l'a rendue fausse — dans le
sens favorable. Bloquer sur une valeur périmée refuserait une création que le
serveur aurait acceptée, et l'exploitant n'aurait aucun moyen de le savoir.
`docs/DESIGN_SYSTEM.md` §14.9 dit la même chose : ne pas désactiver une action
parce que l'interface *pense* qu'elle sera refusée.

L'avertissement local utilise donc `accent`, pas `danger` : il annonce un risque,
pas un refus. Seul le refus renvoyé par `sparkd` utilise `danger`.

### 25.2 Un refus n'efface pas la saisie

Le refus d'admission de `sparkd` chiffre ce qui manque, ressource par ressource
(§7.7). L'écran le rend tel quel, **près du bouton**, et conserve intégralement
les valeurs saisies (`docs/DESIGN_SYSTEM.md` §7.1).

Perdre un formulaire de dix champs parce que la mémoire demandée dépassait de
2 Gio serait une punition disproportionnée — et pousserait à demander moins que
nécessaire pour éviter d'avoir à ressaisir.

### 25.3 Ce que le formulaire refuse lui-même, et pourquoi ce n'est pas la même chose

Deux contrôles restent **locaux**, et ils ne relèvent pas de l'admission :

- **la forme d'un nom** — minuscules, chiffres, tirets. Ce n'est pas une question
  de capacité mais de syntaxe, connue sans interroger le serveur, et le dire
  immédiatement évite un aller-retour inutile ;
- **la cohérence du mode CPU** — un mode `dedicated` demande des cœurs, un mode
  `capped` un plafond. Là encore, une règle de forme.

Ces deux contrôles sont **doublés** par le runtime, qui refuserait de la même
façon (`docs/SCHEMA.md` §4). Ils rendent l'écran agréable ; ils ne le rendent pas
autoritaire.

La distinction est celle du §14.9 : un champ **mal formé** se signale tout de
suite, un champ **qui ne tiendra peut-être pas** se soumet quand même.


## 26. Les trois surfaces d'administration d'un Spark

Le §24 a fait du détail l'écran où l'on *lit* un Spark. Cette section dit comment
il devient l'écran où l'on *agit* sur ses routes, ses clés et ses instantanés.

### 26.1 Ce ne sont pas trois écrans

Le titre de l'unité dit « écrans », au pluriel, et c'est le seul point où la
spécification s'écarte de lui. Une route publique n'existe pas sans son Spark :
`ingress_route.spark_id` est obligatoire (`docs/SCHEMA.md` §6). Un instantané non
plus. Leur donner des écrans séparés obligerait à choisir un Spark en entrant,
c'est-à-dire à refaire l'écran détail en moins bon.

**Décision : trois panneaux du détail, pas trois écrans.** C'est l'architecture
que `CLAUDE.md` §4 demande — l'objet métier principal est citoyen de première
classe, le reste est un contexte porté par lui.

**Une exception, et elle est réelle.** Le registre de clés est *général* : une
clé y existe avant d'être accordée, et `DELETE /v1/ssh-keys/{label}` la retire de
**tous** les Sparks à la fois. Ce geste-là n'appartient pas au détail d'un Spark,
parce que son effet déborde le Spark qu'on regarde. Le détail accorde et révoque
pour **son** Spark ; l'oubli d'une clé du registre relève d'une surface générale
qui n'est pas livrée par cette unité, et le panneau le dit plutôt que de le
laisser deviner.

### 26.2 Un formulaire s'ouvre, il n'occupe pas

Chaque panneau porte un bouton d'ajout qui **révèle** son formulaire à sa place,
dans le flux (`DESIGN_SYSTEM.md` §6.22). Pas de modale : ni voile, ni piège de
focus, ni `Échap` global à écrire pour trois formulaires de deux champs.

Le contrat d'interaction est celui du §6.22, et il vaut pour les trois :

- à l'ouverture, le focus entre dans le premier champ ;
- l'annulation referme et **rend le focus au bouton déclencheur** ;
- la saisie survit à un refus du serveur — c'est déjà la règle du §25.2, et elle
  ne change pas parce que le formulaire est plus petit.

Un seul panneau est ouvert à la fois. Deux formulaires ouverts côte à côte
laisseraient croire qu'on prépare deux gestes qui partiraient ensemble, alors que
chacun part seul.

### 26.3 Routes publiques

**Déclarer** demande un domaine, un port et le TLS. Le port est celui **du
Spark**, pas celui de l'hôte : c'est `target_port`, et l'amont est
`ipv4_address:target_port` (§18.2). Le libellé du champ le dit, sans quoi on
saisit `443` en croyant décrire l'entrée.

**L'unicité du domaine n'est pas contrôlée ici.** `ingress_route.domain` est
`UNIQUE` en base (§18.4) et le refus arrive en `409 route_refused`. Le refaire
côté interface ne protégerait de rien face à deux consoles simultanées, et
donnerait l'illusion inverse. C'est le même partage qu'au §25.3 : l'interface
montre, le serveur tranche.

**`applied_at` vide veut dire quelque chose de précis** (§18.5) : la route est
enregistrée mais Caddy ne la sert pas. L'écran l'affiche en `accent` — « non
appliquée » — et non en `danger` : rien n'est cassé, un état est simplement en
retard. À côté, une action **Réappliquer** appelle `POST /v1/ingress/reconcile`.
C'est une action réparatrice au sens du §6.24 : elle ne détruit rien, n'a aucun
paramètre, et ne demande donc **pas** de confirmation.

**Le TLS ne se promet pas.** Une route à `tls = 1` est confiée à Caddy, dont
l'émission dépend du DNS — extérieur au produit (§18.3). Le formulaire énonce
cette dépendance au moment du choix. L'écran ne montre jamais un certificat comme
« actif » : il ne le sait pas, et `sparkd` ne le lui dit pas.

**Retirer** une route la retire du service. C'est réversible en la redéclarant,
mais le domaine cesse de répondre immédiatement : confirmation nommant le domaine
(§6.23).

### 26.4 Clés autorisées

Deux gestes distincts, dans le même panneau parce qu'ils servent la même
intention :

- **accorder** une clé déjà enregistrée — une liste déroulante des clés du
  registre qui ne sont pas déjà accordées à ce Spark ;
- **enregistrer** une clé nouvelle — un libellé et une clé publique.

Le second n'existe que pour éviter un aller-retour : sans lui, autoriser une
nouvelle machine imposerait de quitter le Spark qu'on regarde. Il n'accorde pas
tout seul — enregistrer puis accorder restent deux effets, et l'écran enchaîne
les deux appels en le disant.

**L'empreinte affichée est celle que le serveur rend**, jamais un condensat
recalculé dans le navigateur. C'est le §17.2 : ce que la console affiche doit
être ce que `ssh-keygen -lf` affiche, et une seconde implémentation du calcul
finirait par diverger de la première.

**Une clé privée collée par erreur est refusée par la base** (`CHECK` du §17.2),
en `422 invalid_key`. L'interface n'anticipe pas ce refus : elle le montre.

**Révoquer ne demande pas de confirmation.** Le geste est réversible — la clé
reste au registre, on la ré-accorde d'un clic — et confirmer les gestes
réversibles banalise les confirmations qui comptent (§6.24). Mais **révoquer la
dernière clé** ferme le Spark à tout le monde : le panneau nomme cette
conséquence avant le geste, à l'endroit où le geste se fait.

**Le fragment `ssh_config` est donné à copier** tel que `sparkd` le rend (§17.4),
en typographie technique (§3.1). Il n'est pas reconstruit par l'interface :
l'adresse vient du registre, et la retaper ici créerait une seconde vérité.

### 26.5 Instantanés

**Prendre** un instantané ne détruit rien : pas de confirmation. Le formulaire
énonce en revanche ce que le §19.4 impose de savoir — l'instantané consomme le
quota disque du Spark, et un Spark qui en accumule voit son espace diminuer sans
qu'aucun fichier n'ait été ajouté.

**Supprimer** un instantané est irréversible : confirmation nommant l'instantané
(§6.23).

**Restaurer est le geste délicat de cette unité.** Ce n'est pas une action
réparatrice au sens du §6.24 : elle **écrase l'état courant** de la cellule. Elle
confirme donc, en nommant ce qui est perdu.

Et surtout, quand le serveur refuse en `409 blocked_by_newer_snapshots` parce que
des instantanés plus récents seraient détruits (§19.1), l'écran :

1. affiche le refus et **liste nommément** les instantanés qui bloquent, tels que
   `sparkd` les rend dans `blocking` ;
2. n'offre qu'**alors** l'acceptation explicite de leur perte, qui renvoie la
   requête avec `accept_losing_newer`.

**L'ordre compte, et c'est la seule chose que cette section demande de ne pas
inverser.** Un formulaire qui porterait la case « accepter la perte » *avant* la
première tentative la ferait cocher par habitude, et l'exploitant perdrait des
instantanés qu'il n'a jamais regardés. Le refus est ce qui rend la perte visible ;
l'acceptation doit venir après lui, et nommer ce qui meurt. C'est la traduction à
l'écran de la décision du §19.1 : le drapeau appartient à la requête, jamais à la
configuration.

**`stateful` n'est pas proposé** (§19.3). Il échoue sur cet hôte, et un bouton
qui échoue à l'usage vaut moins que pas de bouton.

### 26.6 Ce que ces panneaux ne font pas

Ils ne rafraîchissent pas en continu. Après un geste réussi, l'écran relit le
Spark et ses trois collections — c'est le même choix qu'au §24 : un état relu
vaut mieux qu'un état deviné, et l'optimisme d'interface (`DESIGN_SYSTEM.md` §7.1)
n'a pas sa place sur des gestes qui touchent au réseau et au disque.
