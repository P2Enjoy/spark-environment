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
| `memory_total_bytes` | `/1.0/resources` → `memory.total` | octets |
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
  size: 10GiB           # device disque racine size
  io_priority: 5        # limits.disk.priority
```

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

12. **`zfs_arc_max`** — plafonné à 16 Gio sur décision du responsable et persisté
    dans `/etc/modprobe.d/zfs.conf`. Reste à vérifier que la consommation réelle
    de l'ARC demeure sous ce plafond en charge, et que la valeur est bien
    soustraite via `host.memory_reserve_bytes`.
13. **Compression et quota** — la compression étant active, le quota porte sur les
    octets **stockés**, pas sur les octets logiques. Décision à prendre : documenter
    l'écart, ou désactiver la compression par jeu de données. §8.7.
