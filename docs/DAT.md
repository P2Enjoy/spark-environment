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

## 1 bis. Glossaire : Forge, Spark, console (SPK-42)

**Arbitrage du responsable, 2026-08-20.** La machine qui porte `sparkd` s'appelle
désormais une **Forge**. Elle n'avait pas de nom : on disait « l'hôte », mot déjà
pris par le processus Node du poste (§22), et la console affichait les deux.

| Terme | Ce qu'il désigne | Ce qu'il ne désigne pas |
|---|---|---|
| **Forge** | LA machine physique qui porte `sparkd`, Incus et le pool | pas une grappe : une Forge est **une** machine |
| **Spark** | une cellule sur une Forge — une fraction de sa capacité | pas un conteneur Docker : Docker tourne **dans** le Spark |
| **console** | l'application locale d'administration, sur le poste du responsable | pas une machine administrée |
| **hôte console** | le processus Node qui sert la console et ouvre les tunnels | pas une Forge |

### 1 bis.1 Ce que le renommage change, et ce qu'il NE change PAS

C'est un renommage **sémantique**, jamais textuel. Une substitution globale de
`host` serait fausse, et dangereuse : le mot a trois sens dans ce dépôt, et deux
d'entre eux ne bougent pas.

**Change** — le mot désignait la machine :

- la table `host` du registre et ses colonnes de capacité ;
- la route `GET /v1/host`, `POST /v1/host/sync`, `/v1/host/cores` ;
- les libellés d'interface, la destination `#/hote`, le manuel, le glossaire ;
- les messages où « l'hôte » veut dire « la machine ».

**Ne change PAS** — le mot y a un autre sens, et le changer produirait un
contresens :

- `host` au sens **réseau** : `SPARKD_BIND`, l'adresse d'écoute, `hostname`, le
  `host` d'un serveur dans `servers.json`, `sshHost`, `HostName` et `Host` du
  `ssh_config`. C'est le vocabulaire d'OpenSSH et de TCP, pas le nôtre ;
- **« hôte console »**, qui reste : la collision disparaît d'elle-même puisque
  l'autre sens s'en va. Le renommer aussi serait renommer pour renommer ;
- `hostmem`, qui lit la mémoire de **la machine locale** où tourne `sparkd` —
  donc de la Forge : il **change** de nom, mais son contenu ne bouge pas.

Cette distinction n'est pas un détail de style : la vérification de la DoD — « plus
aucune occurrence du terme abandonné **dans le sens visé** » — ne peut se faire
qu'en la connaissant. Un `grep` nu compte les trois sens et ne prouve rien.

### 1 bis.2 Ordre de livraison, et pourquoi cet ordre

1. **le registre et l'API** — migration `host` → `forge`, routes, contrat
   régénéré. C'est ce dont le coût croît : chaque unité livrée après cet
   arbitrage ajoute des appelants ;
2. **la console** — libellés et destination ;
3. **la documentation et le manuel**, captures refaites.

La compatibilité ascendante n'est **pas** maintenue : le contrat n'a qu'un
consommateur, le dépôt lui-même (§23). Garder `/v1/host` en alias créerait deux
noms pour la même chose, ce que cette unité existe précisément pour supprimer.

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
réserve une **marge de métadonnées** au-dessus de la taille vendue, invisible du
locataire. Son contrat est au §8.8, et l'unité est SPK-30.

### 8.8 La marge de métadonnées : contrat

C'est la correction du fait 3 du §8.7. Elle tient en une phrase : **le quota posé
sur le jeu de données n'est jamais la taille vendue, il est la taille vendue plus
une marge que le locataire ne voit pas et ne peut pas remplir.**

#### 8.8.1 Ce que la marge protège, et ce qu'elle ne protège pas

Elle protège **l'administrabilité** d'un Spark saturé : `backup.yaml` continue de
s'écrire, donc `PATCH` sur l'instance continue d'aboutir, donc le plan de contrôle
peut encore agrandir le Spark pour le débloquer.

Elle ne protège **pas** le locataire de la saturation : il atteindra son quota,
verra 100 %, et ses écritures seront refusées. C'est voulu. La marge n'est pas un
supplément d'espace offert, c'est de la place gardée pour les métadonnées d'Incus.

#### 8.8.2 Les quatre règles

**1. Le registre stocke la taille VENDUE, jamais le quota posé.** `spark.storage_bytes`
garde exactement ce que le responsable a demandé. Le quota est une valeur
**dérivée**, recalculée à chaque traduction. Stocker les deux ferait deux vérités à
tenir d'accord ; aucune migration n'est donc due par cette unité.

**2. Le traducteur pose `storage_bytes + marge`.** C'est le seul endroit où la
marge apparaît. Un Spark de 10 Gio avec une marge de 64 Mio reçoit un
`root.size` de `10 804 088 832` octets.

**3. La marge est INVISIBLE du locataire.** Ce que la console affiche comme limite
reste la taille vendue, et le ratio d'occupation se calcule sur elle. Un Spark
plein montre `10,0 Gio / 10,0 Gio` et 100 %, jamais `10,06 Gio`. Une limite
affichée qui ne serait pas celle qu'on a vendue ferait douter du chiffre annoncé —
et le locataire ne peut de toute façon pas atteindre la marge, puisque ses données
saturent le quota avant.

**4. La marge est COMPTÉE au pool.** L'admission évalue `storage_bytes + marge`,
et l'alloué du pool de stockage vaut `Σ(storage_bytes) + marge × nombre de Sparks`.
C'est le même raisonnement qu'au §8.5 pour l'ARC : la marge est réellement prise
sur le pool, un pool qui l'ignorerait promettrait ce qu'il n'a pas. Sur trente
Sparks à 64 Mio, elle coûte 1,9 Gio — négligeable en valeur, mais la comptabilité
du §7.7 ne connaît pas le négligeable.

**Conséquence, et elle n'est pas facultative : l'écran des pools doit NOMMER la
marge.** Invisible du locataire (règle 3), elle est au contraire visible de
l'exploitant, puisqu'elle grossit l'alloué. Un exploitant qui additionne cinq
Sparks de 10 Gio et lit 50,3 Gio alloué doit trouver l'explication à l'écran, et
non la chercher dans le code. Le runtime publie donc **deux** termes dans le bloc
`reserves` de `GET /v1/host` : la marge **unitaire**, qui est le réglage, et ce
qu'elle **coûte au total** à cet instant, qui est la conséquence. Le total est
calculé au serveur, où le nombre de Sparks est connu — la console énonce, elle ne
recompose pas — c'est exactement la règle du §27.3, et pour la
même raison : la somme seule ne dit pas quelle vanne tourner. La console ne pose
jamais cette valeur en dur (§27.6) : elle la lit dans la réponse.

#### 8.8.3 La valeur, et pourquoi elle est configurable

`SPARKD_STORAGE_METADATA_MARGIN`, défaut **64 MiB**.

Le fait mesuré est que `backup.yaml` doit pouvoir s'écrire ; il pèse quelques
kibioctets. Le défaut est donc large de trois ordres de grandeur, délibérément :
`backup.yaml` n'est pas le seul écrit d'Incus dans le jeu de données, et une marge
trop juste rendrait le remède intermittent — c'est-à-dire pire qu'absent, parce
qu'on cesserait de le soupçonner.

Elle est configurable parce que la valeur utile dépend du pilote de stockage, que
le §8.5 laisse ouvert : ce qui suffit à ZFS ne vaut pas nécessairement pour btrfs,
dont les `qgroups` comptent autrement.

- **Zéro est accepté** : il restaure exactement le comportement d'avant cette
  unité, pour un pilote qui n'écrirait pas ses métadonnées dans le jeu de données
  contingenté. C'est un choix d'exploitant, pas un défaut.
- **Une valeur négative est refusée au démarrage**, comme les autres réserves
  (§5) : `sparkd` ne démarre pas.

#### 8.8.4 Ce qui ne change pas

- Le **refus d'admission** reste celui du §7.7, dans sa forme et son vocabulaire.
  Un Spark refusé parce que la marge ne tient pas est refusé sur `storage`, avec
  le manque exprimé en octets. Il n'existe pas de refus « marge ».
- La **sémantique du quota** reste celle du fait 1 du §8.7 : il porte sur les
  octets stockés après compression. La marge ne corrige pas cela et ne prétend pas
  le faire.
- L'**imputation des instantanés** au quota du Spark (fait 2 du §8.7) reste
  inchangée, ainsi que la note que la console affiche à ce sujet.

#### 8.8.5 Ce que la preuve doit établir

Trois niveaux, et ils ne prouvent pas la même chose :

1. **Traduction** — un manifeste de *T* octets produit un `root.size` de
   *T* + marge, et de *T* exactement quand la marge est nulle.
2. **Admission** — la demande évaluée et l'alloué du pool incluent la marge ; un
   Spark qui tiendrait tout juste sans elle est refusé avec elle.
3. **Sur un hôte réel** — un Spark saturé reste reconfigurable : on remplit
   jusqu'au refus d'écriture, puis on agrandit, et l'agrandissement aboutit. Ce
   troisième niveau est le seul qui prouve le fait du §8.7 ; les deux premiers ne
   prouvent que la mécanique. Tant qu'il n'est pas exécuté, l'unité reste `[~]`.

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

### Confirmées, suite (nesting)

11. **Nesting Docker complet** — pile Compose réelle dans un Spark non privilégié à
    idmap isolé, AppArmor actif, sans contournement ; `HTTP 200` depuis l'hôte sur
    l'IP privée. Docker retient `overlayfs` au-dessus du rootfs ZFS. Exige
    Incus ≥ 6.19 ; mesuré fonctionnel en 7.3, et **cassé en 6.0.0**. §3.1.

### Confirmées, suite

12. **`zfs_arc_max` tient sous charge** — **confirmé le 2026-08-19.** La mesure
    statique disait le plafond ; celle-ci dit ce que l'ARC en fait réellement.
    24 Gio incompressibles écrits puis relus intégralement sur le pool :

    ```
    au repos            size  1,50 Gio     c  8,00 Gio     c_max 16,00 Gio
    pendant la lecture  size 16,00 / 15,99 Gio (quatre relevés)
    après la lecture    size 15,99 Gio     c 16,00 Gio     c_max 16,00 Gio
    ```

    Deux conclusions, et elles vont dans des sens opposés. L'ARC **atteint** son
    plafond dès qu'on lui donne de quoi le remplir : la réserve de 16 Gio du §16.1
    n'est donc pas prudente, elle est **nécessaire** — sans elle, ces 16 Gio
    seraient promis aux Sparks et repris par le cache. Et il ne le **dépasse
    pas** : la réserve est donc suffisante, et il n'y a pas lieu de l'augmenter.

13. **Ce que le quota compte, avec compression** — **mesuré le 2026-08-19**, sur
    un jeu de données à `quota=2G`, `compression=on` :

    | Données écrites | Reçu par le quota | `available` final |
    |---|---|---|
    | 8 Gio de zéros | **24 Kio** | `2,00G` — intact |
    | 2 Gio incompressibles | **2,00 Gio** | `0B` — épuisé |

    Le quota porte sur les octets **stockés**. Les zéros ne sont d'ailleurs même
    pas compressés : ZFS ne les stocke pas du tout, et 8 Gio n'ont coûté que
    24 Kio.

    **Décision : la compression reste active, et l'écart est documenté** plutôt
    que supprimé. Trois raisons.

    - L'écart joue **toujours en faveur du locataire** : avec des données
      compressibles il loge plus que ce qu'il a acheté, avec des données
      incompressibles il obtient exactement son quota. Il n'en obtient jamais
      moins. Une promesse tenue au-delà n'est pas une promesse rompue.
    - Désactiver la compression ferait consommer au pool des octets qui n'ont pas
      besoin d'exister. Le pool est la ressource rare et non surengageable
      (§7.7) : la gaspiller pour rendre une unité de mesure plus intuitive est un
      mauvais échange.
    - L'admission control compte le **quota**, pas l'usage (§7.7). Un locataire
      qui loge plus de données logiques dans son quota ne consomme pas davantage
      du pool : le pool ne peut donc pas être survendu par cet écart.

    Conséquence à énoncer dans le manuel : « 10 Gio » désigne 10 Gio **stockés
    après compression**.

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

### 14.5 Une instance déjà absente vaut suppression réussie

**Arbitrage du responsable, 2026-08-20** (remplace l'entrée INC-03 du rapport
d'incohérences, retirée dans le même changement).

Mesuré le 2026-08-19 : un Spark en `error`, dont l'instance Incus avait été
supprimée hors du produit, restait indéfiniment au registre. `delete` rendait
`502`, l'entrée continuait de peser dans l'admission, et aucun redémarrage ne la
retirait — la reprise du §14.3 ne traite que les états **transitoires**, et
`error` est stable. Le seul recours était d'ouvrir le registre à la main, ce que
la console existe précisément pour éviter.

**La règle.** Quand le pilote rapporte que l'instance n'existe pas, `delete`
**réussit** : la ligne part, les ressources sont rendues, la route et les clés
suivent comme au §14.4.

**Trois choses que cette règle ne fait pas**, parce qu'elles feraient d'un succès
un mensonge :

- elle ne **cache pas** l'écart : l'entrée d'audit porte
  `instance_absente: true` et son message le dit en toutes lettres. Un `delete`
  ordinaire et un `delete` sur une instance disparue ne se lisent pas pareil au
  journal ;
- elle ne s'applique qu'à une **absence rapportée**, jamais à un pilote
  injoignable. Ne pas pouvoir demander n'est pas savoir que ce n'est pas là —
  c'est la même règle qu'au §33.3 pour le catalogue d'images. Un pilote muet rend
  toujours une panne ;
- elle ne vaut pas pour un Spark **protégé** : le §35 s'applique d'abord, et une
  instance absente n'est pas une raison de contourner une protection armée.

**Le risque assumé.** Si le pilote se trompe et rapporte absente une instance qui
vit, la ligne disparaît et l'instance continue de consommer sans être comptée. Ce
risque existait déjà en sens inverse — une ligne comptée pour rien — et il est
détectable : la réconciliation compare le registre au pilote, et une instance
sans ligne est visible depuis Incus.

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

**L'émission d'un certificat suppose que le domaine résolve vers cette Forge.**
Ce n'est toujours pas une propriété que `sparkd` contrôle : elle dépend du DNS,
puis de sa propagation. Ce qui a changé depuis le §38, c'est que le DNS n'est
plus **extérieur au produit** : la console pose l'enregistrement. Elle ne rend
pas la résolution pour autant, et l'écran ne l'annonce jamais (§38.4).

Un domaine mal pointé produit donc encore un échec d'émission côté Caddy, pas une
erreur de `sparkd` — et la console doit présenter cet écart comme tel plutôt que
de laisser croire à une panne du plan de contrôle.

### 18.3 bis Le joker, et la règle de préséance

**Arbitrage du responsable, 2026-08-20.** Une route peut porter un **joker de
premier niveau** : `*.monapi.fr`.

Le besoin est réel et il n'a pas de contournement : une API qui donne un
sous-domaine par client ne peut pas déclarer une route et un enregistrement DNS
par locataire, à la main, indéfiniment. Le joker est aussi ce que Caddy et le DNS
font tous les deux nativement — il n'y a donc rien à simuler.

**Un seul niveau, et pas ailleurs qu'en tête.** `*.monapi.fr` est valide.
`*.*.monapi.fr` ne l'est pas, `api.*.monapi.fr` non plus, et `*` seul non plus —
il désignerait la zone entière. Cette borne suit celle du DNS, où un joker ne
couvre qu'un seul niveau et ne vaut qu'en position initiale.

**La préséance : le plus spécifique gagne.** `api.monapi.fr` déclaré par un Spark
l'emporte sur `*.monapi.fr` déclaré par un autre. C'est la règle du DNS et celle
de Caddy ; en adopter une autre ferait diverger ce que le produit affiche de ce
que le trafic fait réellement.

**Ce que l'unicité devient.** Le §18.4 disait « deux Sparks ne peuvent pas
revendiquer le même nom ». Cela reste vrai **à l'identique** : deux routes de
même texte se refusent toujours. Mais un joker et un nom exact ne sont PAS le
même nom, et leur coexistence est légitime — c'est même l'usage courant : un
`*.monapi.fr` général, et un `admin.monapi.fr` pointé ailleurs.

**Ce que l'écran doit dire, parce que sinon personne ne le devinera.** Quand une
route exacte est avalée par le joker d'un **autre** Spark, la déclaration
réussit et l'écran NOMME le Spark dont elle prend le pas. Un exploitant qui
déclare `admin.monapi.fr` doit savoir qu'il vient de détourner une adresse qui
partait ailleurs — silence ici produirait une panne cherchée pendant des heures
du mauvais côté.

**Et la vue depuis le joker — arbitrage du responsable, 2026-08-20.** Dire la
surcharge au moment où on la crée ne suffit pas : ce message passe une fois, et
la personne qui exploite le Spark porteur du joker ne l'a peut-être jamais lu.

Quand on consulte les routes d'un Spark, une route joker affiche donc **la liste
des noms qui lui sont soustraits**, chacun avec le Spark qui le sert. Un
`*.monapi.fr` porte la mention « `api.monapi.fr` est servi par le Spark
*dedie* » aussi longtemps que cette route exacte existe.

C'est l'information qui manque le plus au diagnostic : un exploitant qui constate
qu'un sous-domaine ne répond pas comme les autres doit pouvoir voir, **depuis le
joker lui-même**, que ce nom part ailleurs. Sans cela il cherche dans la
configuration du Spark porteur, où il n'y a rien à trouver.

Le cas d'usage est celui du responsable : lorsqu'un sous-domaine devient assez
chargé pour mériter son propre Spark, on le déclare en exact et il prend le pas.
La montée en charge se fait ainsi, un nom à la fois, sans toucher au joker.

**Deux règles pour que cette liste reste utile.** Elle ne compte que les routes
**actives** — une route désactivée ne prend le pas sur rien. Et elle ne mentionne
pas les noms exacts que **le même Spark** possède : ce n'est pas une surcharge,
c'est le même exploitant qui affine sa propre route, et l'afficher serait du
bruit.

**Côté TLS**, un certificat joker exige une validation par enregistrement DNS —
`DNS-01` — là où un nom exact se valide par HTTP. Le §38 rend cette validation
possible pour la première fois, puisque la console sait écrire dans la zone ;
elle n'est pas pour autant implémentée, et le §18.3 continue de valoir : l'écran
n'affirme jamais qu'un certificat est émis.

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

### 21.5 bis Le vocabulaire du journal, et qui le traduit

**Arbitrage du responsable, 2026-08-20** (registre, INC-01).

Le journal reste un **enregistrement technique** : `sparkd` continue d'y écrire
« `starting` → `running` », qui est ce que le runtime a réellement fait. C'est la
**console qui traduit** à l'affichage, en reconnaissant les états rapportés et en
posant les libellés du §14.7.

Motif : le journal sert aussi au diagnostic, et y écrire du vocabulaire
d'interface le rendrait moins précis pour gagner en confort — au mauvais endroit.
La traduction vit donc à un seul endroit, celui qui affiche.

Ce que cela n'est pas : une traduction qui devinerait. La console ne traduit que
les formes qu'elle **sait** reconnaître ; ce qu'elle ne reconnaît pas est affiché
tel quel, sans être déformé. Un message inconnu mal traduit serait pire que le
même message resté technique.

Porté par `docs/BACKLOG.md#SPK-46`.

### 21.5 ter Un refus ne porte pas le nom demandé

**Arbitrage du responsable, 2026-08-20** (registre, INC-02).

Un refus d'admission journalise sa **cause**, pas la demande qui l'a provoqué : ni
le nom souhaité, ni un identifiant d'entité — la transaction est annulée, aucune
ligne n'existe, et écrire au journal la donnée d'une entité inexistante ferait
croire à une trace de quelque chose qui a été.

Ce qui distingue deux refus consécutifs est donc **qui les a demandés** (§21.6) et
**quand**, pas ce qu'ils visaient. C'est assumé et écrit ici plutôt que laissé
comme un manque.

### 21.6 Qui a agi : contrat de l'acteur (SPK-37)

Le §36.7 posait le constat : `actor` valait la chaîne littérale « responsable »
ou « sparkd », donc le journal ne savait pas qui agissait. Cette section fixe ce
qui le remplace.

#### 21.6.1 Deux classes, portées par une colonne

`audit_log` gagne `actor_class`, contrainte à deux valeurs :

| `actor_class` | Ce que c'est | Exemples |
|---|---|---|
| `human` | un geste demandé par une personne, arrivé par l'API | création, commande, route, clé, instantané, protection |
| `runtime` | un événement produit par `sparkd` lui-même | réconciliation au démarrage (§14.3), repondération de la tranche (§32.2), relevés |

C'est le §36.4 rendu vérifiable. Les afficher pareillement laisserait croire que
la seconde classe est signée par quelqu'un — elle ne l'est par personne, et elle
ne le sera jamais.

La classe n'est **pas déduite du nom de l'action** : deux chemins peuvent écrire
la même action. Elle est portée par l'appelant, au même titre que l'acteur.

#### 21.6.2 L'identité voyage dans un en-tête, et elle est DÉCLARATIVE

L'hôte console pose sur chaque requête relayée :

```
X-Spark-Actor: <identité>
```

`sparkd` la lit, la borne à 200 caractères, et la porte jusqu'à
`audit.record()`. En son absence, l'acteur vaut `inconnu` — jamais
« responsable », qui affirmerait une identité que rien n'établit.

**Cet en-tête n'est pas une preuve, et le produit ne le présentera jamais comme
telle.** Qui atteint `sparkd` écrit ce qu'il veut dedans, exactement comme qui
atteint l'hôte contourne la protection du §35.1. C'est une **attribution**, utile
entre usages légitimes et pour distinguer les deux classes ; la preuve viendra de
la signature (SPK-40), et d'elle seule. Le §36.7 dit l'ordre : identité, puis
signature, puis chaîne, puis ancre — celle-ci est la première marche, et se dit
comme telle.

#### 21.6.3 Ce que l'hôte console y met

Il nomme le serveur visé et, **quand il la connaît**, l'empreinte de la clé SSH
qui a ouvert le tunnel :

```
console/<serveur> key=SHA256:…      empreinte déterminée
console/<serveur>                   empreinte non déterminée
```

La forme est **ASCII**, et ce n'est pas un détail de style : un en-tête HTTP ne
transporte pas d'accent. Mesuré — une valeur portant « clé » fait échouer la
requête à l'encodage, avant d'atteindre `sparkd`. Une identité qui casse l'appel
qu'elle devait attribuer serait pire qu'aucune identité, donc `sparkd` **borne
aussi ce qu'il accepte** : tout caractère hors ASCII imprimable est écarté à
l'entrée du journal.

L'empreinte est relevée à l'ouverture du tunnel, sur la sortie de diagnostic
d'OpenSSH (`LogLevel=VERBOSE`), qui nomme la clé acceptée par le serveur. Elle
n'est **pas devinée** : un tunnel local (§28.2) n'en a aucune, un agent muet n'en
donne aucune, et dans ces cas l'en-tête ne porte que le serveur. Écrire une
empreinte plausible plutôt que rien serait le pire des deux mondes.

#### 21.6.4 Le journal ne se récrit pas par mégarde

`UPDATE` et `DELETE` sur `audit_log` sont refusés **par la base**, par
déclencheur, et non par convention de code. Une table qu'on s'interdit d'écraser
par discipline est une table qu'on écrasera : le premier script de maintenance
écrit à deux heures du matin suffit.

Ce verrou ne protège pas de `root` — qui peut supprimer les déclencheurs comme le
fichier — et le §36 le dit déjà : ce qui protège de `root`, c'est l'ancre tenue
ailleurs (SPK-38), pas la base elle-même. Il protège de l'erreur, qui est le
risque réel et fréquent.

**L'insertion reste libre**, et la purge du §36.5 n'est pas tranchée ici : le
jour où elle le sera, elle passera par une migration qui suspend le déclencheur,
scelle le préfixe dans un point de contrôle, et le repose.

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

### 22.4 bis Ce que le catalogue délègue à OpenSSH

Le §22.4 dit ce que l'inventaire ne contient pas. Celui-ci dit à qui il confie ce
qu'il ne contient pas.

L'inventaire retient aujourd'hui `host`, `user` et `port` : il redécrit une
connexion qu'OpenSSH sait déjà décrire. Toute configuration un peu réelle —
rebond par un bastion (`ProxyJump`), clé dédiée, algorithmes imposés, agent
transféré — n'a alors nulle part où aller, et le produit se retrouverait à
réimplémenter `ssh_config` champ par champ.

**Décision : le catalogue accepte un simple alias `ssh`.** Une entrée nomme un
`Host` du `~/.ssh/config` du poste, et rien d'autre ; le triplet
`host`/`user`/`port` reste accepté pour le cas simple. Ce qui relève de la
connexion appartient à OpenSSH, ce qui relève du produit — quel serveur, quel
port local, quel état de tunnel — appartient au catalogue.

Conséquence sur la découverte : la console peut **proposer** les `Host` du
`~/.ssh/config` comme candidats, jamais les ajouter d'office. Un poste de
développeur en contient des dizaines qui n'ont rien à voir avec le produit.

**La vérification de la clé d'hôte n'est jamais désactivée.** Le produit ne pose
ni `StrictHostKeyChecking=no`, ni `UserKnownHostsFile=/dev/null` — pas même pour
« simplifier la première connexion ». Un changement de clé d'hôte est un signal,
et il est affiché comme tel : rapproché du §36.2, une clé d'hôte qui change **et**
une histoire d'audit qui ne prolonge plus la précédente disent la même chose.

Cible portée par `docs/BACKLOG.md#SPK-41` ; aujourd'hui le catalogue ne connaît
que le triplet, et s'édite à la main dans le fichier.

### 22.4 ter Le catalogue tenu depuis la console : contrat (SPK-41)

Les §22.4 et §22.4 bis disent ce que le catalogue contient et à qui il délègue.
Celui-ci dit ce qui se code pour s'en servir sans éditeur de texte.

#### 22.4.1 Trois genres, et non plus deux

`kind` ∈ { `ssh`, `alias`, `local` }.

| Genre | Ce que l'entrée porte | Ce qu'OpenSSH résout |
|---|---|---|
| `ssh` | `host`, `user`, `port` | rien de plus |
| `alias` | `sshHost` — un `Host` du `~/.ssh/config` | l'hôte, l'utilisateur, le port, le rebond, la clé |
| `local` | `port` | rien : `sparkd` écoute déjà ici (§28.2) |

Une entrée `alias` ne porte **ni** `host`, **ni** `user`, **ni** `port` de
connexion, et le produit ne les devine pas : les inventer donnerait l'illusion de
les connaître, et ils seraient faux dès qu'un `ProxyJump` s'interpose.

`ssh` reste accepté et n'est pas déprécié : le cas simple ne doit pas exiger un
`ssh_config`.

#### 22.4.2 Le fichier porte sa version

```json
{ "version": 1, "servers": [ … ], "anchors": { … } }
```

La forme historique — un **tableau nu** — est lue comme la version `0` et
convertie en mémoire. Elle n'est jamais réécrite en place au chargement : une
console qui migrerait le fichier à la lecture le récrirait sans qu'on l'ait
demandé, y compris quand elle n'a fait que l'afficher. La conversion est écrite
au **premier enregistrement**, qui est un geste explicite.

`anchors` est le champ que SPK-38 remplit (§36.2) : il est **prévu ici** pour que
la place existe, et le fichier séparé écrit par SPK-38 sera replié dedans le jour
où l'on touche à sa forme. Deux fichiers pour un même état sont une dette, pas une
architecture — elle est nommée ici plutôt que découverte.

#### 22.4.3 Surface d'API de l'hôte console

| Geste | Route | Réponse |
|---|---|---|
| lister | `GET /api/servers` | `{ servers, tunnels, current }` |
| ajouter ou remplacer | `POST /api/servers` | `201` |
| retirer | `DELETE /api/servers/{nom}` | `200`, ou `404` |
| choisir le courant | `POST /api/servers/current` | `200`, ou `404` |
| candidats du `ssh_config` | `GET /api/ssh-hosts` | `{ hosts: [...] }` |
| éprouver avant d'enregistrer | `POST /api/servers/probe` | `{ reachable, healthz, readyz, error }` |

`DELETE` **ferme le tunnel** de l'entrée retirée avant de l'effacer : laisser un
`ssh` vivant vers une machine qu'on vient de retirer de l'inventaire serait
exactement le genre de processus qu'on ne retrouve plus.

Retirer le serveur **courant** ne laisse pas la console sans contexte : le
suivant de la liste devient courant, ou aucun si la liste est vide — et l'écran le
dit alors, au lieu d'afficher une liste de Sparks vide qui ferait croire à un
serveur sans Sparks.

#### 22.4.4 L'épreuve informe, elle ne décide pas

`POST /api/servers/probe` ouvre un tunnel **temporaire**, appelle `/healthz` puis
`/readyz` **à travers lui**, referme, et rend ce qu'il a vu.

Elle n'enregistre rien, et son résultat n'est **pas** une condition
d'enregistrement (§25.1) : la machine peut être éteinte, le réseau coupé, le
serveur pas encore installé. Un serveur injoignable s'enregistre donc, avec son
avertissement affiché. Refuser reviendrait à exiger qu'une machine soit allumée
pour qu'on note son existence.

Le tunnel temporaire est **toujours refermé**, y compris en cas d'échec : une
épreuve qui laisserait un `ssh` derrière elle transformerait un diagnostic en
fuite de processus.

#### 22.4.5 Le serveur courant est retenu, et il est un choix

Le serveur courant est **persisté** dans le fichier (`current`). La console
prenait `servers[0]`, ce qui rendait le choix implicite et dépendant de l'ordre
d'écriture : ajouter un serveur changeait celui qu'on regardait.

À l'ouverture, la console ouvre le tunnel du serveur courant **seulement**
(§22.6). Changer de serveur courant ouvre le tunnel du nouveau ; elle ne ferme pas
celui de l'ancien, qui peut encore servir et se ferme explicitement.

#### 22.4.6 La reconnexion est un geste, pas une attente

Un tunnel `broken` porte une commande de reconnexion **à l'écran**. Aujourd'hui il
n'en a aucune, et la seule issue est de recharger la console — ce qui n'est pas
un remède, c'est une superstition.

Le geste appelle `POST /api/tunnels`, qui rouvre. L'état passe par `connecting`
et l'écran le montre : une reconnexion silencieuse laisserait croire que rien ne
se passe.

#### 22.4.7 bis Où vit l'écran du catalogue

Le §22.4 ter disait les routes ; il ne disait pas la surface. Ce point-ci le
tranche, et lui seul.

**Une destination de premier degré, nommée « Serveurs ».** Elle rejoint *Sparks*
et *Hôte* dans la barre latérale.

Ce n'est **pas** une contradiction avec le §1 de `DESIGN_SYSTEM_APP` — « on ne va
pas au serveur comme on va aux Sparks ». Le sélecteur reste au-dessus du premier
degré et désigne le **contexte** ; cette destination-ci ne dit pas « va à ce
serveur », elle dit « administre ta liste ». Ce sont deux sujets différents :
l'un choisit ce qu'on regarde, l'autre gère ce qui est déclaré.

Elle est une propriété de la **console**, pas du serveur courant : c'est
précisément pourquoi elle ne peut pas être un onglet sous *Hôte*, qui décrit la
machine qu'on regarde. Un catalogue rangé sous *Hôte* disparaîtrait avec le
tunnel qui le sert, alors qu'il est justement ce qui permet d'en choisir un autre.

Sa forme suit le §6.14 et le §6.27 :

- un **tableau** des serveurs — nom, genre, ce qu'ils désignent, état du tunnel ;
- la ligne du serveur courant est **signalée**, et une commande y bascule ;
- l'ajout et la modification passent par une **modale limitée à la section**,
  portant l'épreuve du §22.4.4 ;
- le retrait se **confirme dans le flux** (§6.22, §6.23) et nomme le serveur : il
  ferme un tunnel et fait perdre une déclaration ;
- l'état **« aucun serveur enregistré »** propose l'ajout, parce que c'est là
  l'action pertinente — et c'est le seul écran où elle l'est (§6.13).

#### 22.4.7 ter Ce que la modale d'ajout demande, et dans cet ordre

Le **genre** d'abord, parce qu'il décide de tout le reste : un `alias` ne
demande qu'un `Host`, un `ssh` demande le triplet, un `local` ne demande qu'un
port. Afficher les champs des trois genres à la fois ferait remplir des champs
que le produit ignorera.

L'**épreuve** est un bouton de cette modale, pas une étape obligatoire. Son
résultat s'affiche **dans** la modale, sans effacer la saisie, et
l'enregistrement reste possible quel qu'il soit (§22.4.4).

Les **candidats du `ssh_config`** sont proposés pour le genre `alias`, dans une
liste où l'on peut aussi saisir librement : un `Host` peut vivre dans un fichier
inclus que la console ne lit pas.

**En modification, le nom n'est pas modifiable.** `POST /api/servers` remplace par
le **nom** : changer le nom en modifiant ne renommerait rien, cela créerait une
seconde entrée en laissant la première — et l'exploitant se retrouverait avec un
doublon qu'il n'a pas demandé.

Le produit ne prétend donc pas renommer. Renommer, c'est retirer puis redéclarer,
et l'écran le dit plutôt que de laisser découvrir le doublon. Le champ est en
lecture seule, avec sa raison à côté.

Le **genre** reste modifiable : passer un serveur de `ssh` à `alias` est
exactement ce qu'on veut pouvoir faire quand la connexion se complique, et le nom
ne change pas.

#### 22.4.7 Ce qui reste hors de portée, et le reste

Aucun secret, jamais (§22.4). La vérification de la clé d'hôte n'est jamais
désactivée (§22.4 bis). La découverte **propose** les `Host` du `ssh_config`, elle
n'ajoute rien d'office — un poste de développeur en contient des dizaines qui
n'ont rien à voir avec le produit.

Le fichier reste en `0600`.

### 22.5 Le port local est demandé au système

Le port local du tunnel est obtenu en laissant le système en choisir un libre,
et non en piochant dans une plage fixée. Une plage fixée entre en collision avec
ce que l'exploitant fait tourner par ailleurs, et la collision se manifeste comme
un tunnel qui « ne marche pas » sans dire pourquoi.

### 22.6 Qui ouvre le tunnel, et quand

Cette section manquait, et son absence a produit un défaut : la console lisait
l'état des tunnels sans jamais en ouvrir un. Une console ouverte sur une machine
fraîche affichait « Tunnel fermé » et « Les Sparks n'ont pas pu être chargés »,
sans offrir le moindre moyen d'y remédier. Tous les harnais l'ouvraient par un
appel direct à `POST /api/tunnels` — c'est-à-dire par le contournement que la DoD
de SPK-24 interdit —, ce qui masquait le défaut aussi longtemps qu'aucun parcours
ne partait vraiment de l'accueil.

**Décision : la console ouvre le tunnel du serveur courant à son démarrage.**

- Elle l'ouvre pour le serveur courant **seulement**. Ouvrir les tunnels de tout
  l'inventaire établirait des connexions SSH vers des machines qu'on n'a pas
  demandé à regarder.
- Si un tunnel est déjà `ready`, elle ne le rouvre pas : `TunnelManager.open`
  rend l'existant, et la console n'a pas à le savoir.
- L'ouverture est **visible** : l'en-tête passe par `connecting` puis `ready` ou
  `broken`. Un échec n'est pas masqué — c'est le bandeau du §22.3 qui prend le
  relais, avec la sortie d'erreur de `ssh`.
- Elle n'est **pas** silencieuse en cas d'échec : la vue affiche l'erreur réelle
  plutôt que la liste vide, faute de quoi on croirait n'avoir aucun Spark.

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

Un troisième s'y ajoutera avec le catalogue d'images (§33.5) : la référence
d'image proposée vient du catalogue, donc l'écran ne peut plus produire un alias
inexistant. C'est également une règle de forme, et elle est doublée par le
runtime.

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

### 26.2 La saisie est recueillie par une modale limitée à la section

Chaque panneau porte une commande — « Ajouter une route », « Autoriser une clé »,
« Prendre un instantané » — qui ouvre une **modale dont le sujet est cette
section**, et rien d'autre (`DESIGN_SYSTEM.md` §6.27).

**Cette section disait le contraire jusqu'au 2026-08-19**, et l'argument mérite
d'être rappelé pour qu'on ne le refasse pas : elle refusait la modale par son
coût — ni voile, ni piège de focus, ni `Échap` à écrire pour trois formulaires de
deux champs. L'argument était juste tant que la console n'avait aucune modale.
Il tombe dès qu'elle en porte une : ce qui était trois exceptions à écrire est
devenu **un composant unique**, dont le contrat est tenu à un seul endroit.

Ce que le §6.27 impose, et que l'ancien choix obtenait déjà :

- le focus entre dans le premier contrôle à l'ouverture ;
- l'annulation — et `Échap` — rendent le focus au déclencheur ;
- un refus du serveur s'affiche **dans** la surface de saisie et n'efface rien.

Ce que la modale ajoute, et qui manquait :

- l'arrière-plan est **inerte** et ne défile pas. Le formulaire dans le flux
  laissait la page derrière lui active : on pouvait tabuler hors de la saisie
  sans s'en apercevoir ;
- le nom accessible de la surface est **le titre de la section**, ce qui borne sa
  portée : une modale ouverte depuis « Routes » ne touche que les routes ;
- **une seule à la fois**, garanti par le composant plutôt que par une règle que
  chaque panneau devait respecter de son côté.

Le déclencheur, lui, **reste visible** pendant la saisie : c'est lui qui reçoit le
focus à la fermeture, et un déclencheur disparu n'aurait rien à qui le rendre.

Les **confirmations** ne changent pas : elles restent dans le flux (§6.22,
§6.23). Une modale recueille une saisie ; elle ne démontre pas une intention, et
l'ouvrir ne tient pas lieu de confirmation.

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


## 27. L'écran des pools : rendre l'admission control observable

Le §7.7 dit ce que l'admission control compte. La route `/v1/host` existe, selon
ses propres termes, pour que « l'admission control devienne observable : sans
cette vue, rien ne permet de savoir pourquoi une création serait refusée ». Cette
section dit comment cela s'affiche.

### 27.1 Celui-là est un écran, et le §26.1 explique pourquoi

Le §26.1 a refusé de faire des écrans séparés pour les routes et les instantanés,
parce qu'ils n'existent pas sans leur Spark. Les pools sont l'inverse exact : ils
ne dépendent d'aucun Spark en particulier, et ils concernent **tous** les Sparks
à la fois. Les loger dans le détail de l'un d'eux obligerait à en choisir un
arbitrairement pour parler de la machine entière.

**Décision : un écran, atteignable depuis la navigation principale** — au même
rang que la liste des Sparks, parce qu'on y va pour une autre question.

### 27.2 La question à laquelle l'écran répond

« Pourquoi cette création serait-elle refusée, et de combien ? »

Chaque ressource montre donc les **trois** grandeurs, jamais deux : capacité,
alloué, disponible. Afficher « 4,0 Gio libres » sans dire sur combien ne permet
pas de juger s'il faut supprimer un Spark ou agrandir la machine.

### 27.3 La mémoire allouable n'est pas la mémoire de la machine, et cela s'écrit

Le §16.1 soustrait deux termes de `MemTotal`. Un exploitant qui lit « 76,2 Gio »
sur une machine qu'il sait porter 94 Gio conclura à un défaut s'il ne voit pas
d'où vient l'écart. **L'écran énonce la soustraction terme à terme**, en nommant
l'ARC et la marge d'exploitation.

C'est le même principe qu'au §26.5 : ce que le produit retranche doit être
visible au moment où l'on s'interroge, pas déductible d'une lecture de la
documentation.

### 27.4 Le CPU se lit à deux endroits, parce que ce sont deux choses

Un Spark `dedicated` ne consomme pas de réservation : il **retire des cœurs** du
pool commun (§7.7). Une jauge unique masquerait exactement cela — le pool
rétrécirait sans qu'aucune allocation n'augmente, ce qui est incompréhensible.

L'écran montre donc :

- le **pool partagé**, en CPU, avec son alloué et son disponible ;
- la **carte des cœurs** (`GET /v1/host/cores`) : quels cœurs physiques sont
  communs, lesquels sont dédiés et à quel Spark.

### 27.5 Le surengagement s'affiche, il ne se cache pas dans un total

Une capacité CPU de `4 cœurs × 2` n'est pas huit processeurs. Afficher « 8,0 CPU »
sans le facteur promet du matériel qui n'existe pas.

L'écran affiche donc le facteur à côté de la capacité, pour chaque ressource qui
en porte un — et **le stockage n'en porte aucun**. Cette asymétrie est délibérée
(§7.7 : un pool CPU saturé est de la lenteur, un pool de stockage saturé est une
panne dure) et l'écran la nomme, plutôt que de laisser un blanc inexpliqué là où
les autres ressources ont un chiffre.

### 27.6 La réservation n'est pas une garantie, et l'écran le relaie

Le runtime publie `reservation_guarantee`, qui vaut aujourd'hui
`proportional_between_sparks_only` (§7.3 bis). C'est la dette SPK-29. L'écran des
pools est l'endroit où cette nuance compte le plus : c'est là qu'on lit
« 2,5 CPU alloués » et qu'on pourrait croire ces 2,5 CPU garantis.

L'écran énonce donc la portée réelle de la réservation, et il la lit dans la
réponse **plutôt que de l'écrire en dur** : le jour où SPK-29 est livrée, le
runtime changera cette valeur et l'écran suivra sans qu'on ait à y penser.

### 27.7 Les adresses sont un pool, et il s'épuise en silence

`/v1/host` rend `addresses` avec sa capacité, son usage et sa plage DHCP. Un pool
d'adresses épuisé refuse la création d'un Spark pour une raison qui n'a rien à
voir avec le CPU ou la mémoire. Il figure donc avec les autres.

### 27.8 Une topologie non relevée est un état nommé, pas une erreur

`/v1/host` répond `409 host_not_synced` avec un remède explicite quand la
topologie n'a jamais été relevée. Ce n'est pas une panne : c'est une machine
qu'on n'a pas encore interrogée. L'écran présente donc le remède **comme une
action**, pas comme un message d'erreur à décoder.

De même, `topology_synced_at` est affiché avec la capacité : une capacité sans
date serait crue à jour. Le relevé (`POST /v1/host/sync`) est une action
réparatrice au sens du §6.24 — elle ne détruit rien, n'a aucun paramètre, et ne
demande donc aucune confirmation.

### 27.9 Ce que cet écran ne fait pas

Il ne crée rien et ne supprime rien. C'est une surface de **lecture** et de
relevé. La seule écriture qu'il déclenche est `POST /v1/host/sync`, qui met le
registre en accord avec la machine et ne touche à aucun Spark.


## 28. La pile de développement et le seed

Le §12 pose les principes. Cette section fixe le contrat : ce que la pile
démarre, comment le seed est produit, et ce qu'il doit démontrer.

### 28.1 « Autonome » veut dire : aucun service à orchestrer

La pile de développement est faite de **deux processus** :

```
sparkd        Python, SPARKD_DRIVER=fake, registre SQLite dans un fichier
console       Node, sert la SPA et relaie vers sparkd
```

Il n'y a ni base de données serveur, ni file de messages, ni fournisseur externe.
`CLAUDE.md` §3 demande de conteneuriser tout projet qui peut raisonnablement
l'être ; ici, mettre deux processus sans dépendance dans des conteneurs
**ajouterait** une dépendance — un démon Docker — là où il n'y en avait aucune, et
rendrait la pile moins autonome, pas plus.

**Écart assumé, à rouvrir** : dès qu'un service réel entre dans la pile de
développement — un Incus local, un Caddy, un fournisseur simulé —, la
conteneurisation redevient la bonne réponse et cet écart tombe.

### 28.2 Le serveur local est un chemin d'accès, pas un tunnel SSH simulé

La console modélise un **chemin d'accès** vers `sparkd` ; SSH en est une
implémentation, adaptée à un serveur distant. En local, `sparkd` écoute déjà sur
la boucle locale de la même machine : ouvrir un tunnel SSH vers `localhost`
exigerait un `sshd` et des clés pour n'accomplir aucun transport.

L'inventaire accepte donc un serveur de genre `local`, joint directement sur son
port. Ce n'est pas un contournement de sécurité, et pour une raison qui ne dépend
pas de la bonne volonté de l'appelant : **`sparkd` refuse de démarrer sur une
adresse routable** et sort en code 2 (§22). Un accès direct ne peut donc atteindre
qu'un `sparkd` lié à la boucle locale de la machine où tourne la console —
exactement ce que le tunnel SSH garantissait à distance.

Un serveur `local` n'a ni hôte, ni utilisateur, ni port distant : les exiger
obligerait à inventer des valeurs qui ne servent à rien.

### 28.3 Le seed passe par les mêmes chemins que l'application

`CLAUDE.md` §8 l'impose et la raison est concrète : un seed qui écrit des lignes
en SQL direct peut produire des états que l'application est **incapable
d'atteindre**. Les écrans seraient alors éprouvés contre des situations qui
n'existent pas, et les vrais défauts resteraient invisibles.

Le seed appelle donc les **routes HTTP de `sparkd`** — les mêmes que la console
appelle. Un refus d'admission y est un vrai `409` produit par le vrai contrôle
d'admission, pas une ligne d'audit fabriquée.

Conséquence à accepter : le seed ne peut créer que ce que le produit sait créer.
C'est le but.

### 28.4 Le pilote factice doit garder ses instances entre deux démarrages

Mesuré : `FakeIncus` tient ses instances en mémoire. Un Spark seedé « en marche »
survivrait au redémarrage de `sparkd` — le registre est un fichier — mais l'appel
`Arrêter` échouerait ensuite sur « instance absente », parce que le pilote, lui,
aurait tout oublié. La pile paraîtrait fonctionnelle jusqu'au premier geste.

Le pilote factice reçoit donc un **fichier d'état** optionnel, à côté du registre.
Ce n'est pas une simulation de plus : c'est ce qui rend la pile de développement
cohérente avec elle-même après un redémarrage.

### 28.5 Ce que le seed doit démontrer

Chaque fixture existe pour rendre une situation observable à l'écran. Un seed qui
ne produirait que des cas nominaux laisserait les états d'erreur, les absences et
les refus non éprouvés — précisément ceux où les défauts se logent.

| Fixture | Ce qu'elle rend observable |
|---|---|
| Spark en marche, avec mesures | l'écran liste et l'écran détail nominaux |
| Spark arrêté | « Arrêté — aucune mesure d'exécution » (§20.1) |
| Spark en erreur, avec `last_error` | le bandeau d'erreur et la commande `Reprendre` |
| Spark `pending` | un Spark déclaré et pas encore appliqué |
| Spark en mode **dédié** | la carte des cœurs du §27.4 a quelque chose à montrer |
| Refus d'admission réel | l'écran de création et le journal d'audit en `denied` |
| Route appliquée + route **non appliquée** | le badge « non appliquée » et `Réappliquer` (§18.5) |
| Clé accordée, et un Spark **sans aucune clé** | l'absence nommée du §26.4 |
| Instantanés, dont un ancien et un plus récent | le refus de restauration du §19.1 |
| Journal d'audit couvrant `ok`, `denied`, `error` | les trois résultats du §21 |

### 28.6 Reproductible veut dire : rejouable à l'identique

`make seed` **repart d'un registre neuf**. Il ne complète pas un état existant :
un seed qui s'ajoute produit des captures différentes à chaque exécution, et une
capture qui change sans que le produit change ne prouve plus rien.

Les noms des Sparks sont **stables** et choisis une fois : les tests et les
captures s'y réfèrent.

### 28.7 Ce que cette pile ne prouve pas

Le pilote est factice. Aucun quota n'est appliqué, aucun conteneur ne tourne,
aucune configuration Caddy n'est chargée. La pile éprouve la **traduction**, le
contrôle d'admission, le cycle de vie, l'audit et l'interface — elle ne prouve
rien de l'isolation. Cette preuve exige un hôte Incus réel (§12, §13).


## 29. Les parcours E2E : éprouver le produit par où il s'utilise

Le §28 a livré une pile réelle. Cette section dit ce qu'on en fait : des parcours
qui traversent le produit **par où l'exploitant le traverse**, et qui affirment.

### 29.1 La différence avec ce qui existe déjà

Trois harnais coexistent, et confondre leurs rôles ferait croire à une couverture
qu'on n'a pas :

| Harnais | Contre quoi | Ce qu'il prouve |
|---|---|---|
| tests de composants | rien, fonctions pures | le **rendu** : ce que produit une fonction pour un état donné |
| `e2e/gestes.test.mjs` | un faux `sparkd` écrit sur place | qu'un clic **part** avec la bonne méthode et le bon corps |
| `e2e/reel.mjs` | la pile réelle | des **captures** à observer — il n'affirme rien |

Il manque le seul qui compte pour la DoD : un harnais qui traverse la **pile
réelle** et qui **affirme**. C'est SPK-24.

### 29.2 Le harnais monte sa propre pile

Les parcours démarrent `sparkd` et l'hôte console **eux-mêmes**, sur des ports
libres, avec un registre jetable seedé.

Le motif est concret : s'appuyer sur une pile déjà lancée fait dépendre le
verdict de son état. Un Spark supprimé à la main pendant une mise au point rend
la suite rouge sans que le produit ait changé, et — plus grave — un Spark ajouté
à la main la rend verte alors qu'elle ne devrait pas l'être. Un harnais dont le
résultat dépend de ce qu'un humain a fait avant lui ne prouve rien.

Chaque exécution repart donc du seed du §28, dont les noms sont stables.

### 29.3 Aucune URL profonde, aucun appel d'API pour AGIR

C'est la DoD, et c'est `CLAUDE.md` §16 : on se déplace en cliquant et en tapant,
depuis l'accueil. Écrire `location.hash = '#/creer'` pour arriver plus vite
sauterait exactement ce qu'on veut éprouver — qu'un chemin existe pour y arriver.

**Une distinction à ne pas manquer** : lire l'API pour CONSTATER un effet n'est
pas un contournement. L'interdiction porte sur le fait d'**atteindre** un écran ou
d'**accomplir** un geste autrement que par l'interface. Vérifier ensuite, en
interrogeant `sparkd`, que l'instantané existe bien côté serveur est au contraire
ce que `CLAUDE.md` §15 exige — « vérifier les effets backend lorsqu'ils
existent ». Un parcours qui ne regarderait que l'écran validerait un affichage
optimiste.

### 29.4 Ce que « refus d'autorisation » veut dire dans ce produit

`CLAUDE.md` §15 demande de couvrir les refus d'autorisation. Ce produit n'a **pas
de comptes d'utilisateurs** : il s'administre par une console locale, derrière
SSH, par un seul responsable. Prétendre éprouver une authentification qui
n'existe pas produirait un test décoratif.

Les refus que ce produit oppose réellement, et que les parcours doivent couvrir,
sont ceux du **serveur** :

| Refus | Règle | Où il se voit |
|---|---|---|
| capacité insuffisante | admission control, §7.7 | écran de création |
| commande impossible dans l'état courant | machine à états, §14.1 | écran détail |
| restauration bloquée par des instantanés plus récents | §19.1 | panneau instantanés |
| domaine déjà pris | `UNIQUE` en base, §18.4 | panneau routes |

Chacun doit être **provoqué par l'interface** et **constaté à l'écran**. Et pour
chacun, le parcours vérifie que l'interface n'a pas décidé à la place du serveur :
la demande part, et c'est la réponse qui refuse.

### 29.5 Un parcours qui échoue doit dire pourquoi

`CLAUDE.md` §15 demande de « capturer les erreurs utiles au diagnostic ». Un
`expect` rouge sur une page qu'on ne voit pas oblige à rejouer à la main.

Chaque échec produit donc une capture et le texte de l'écran au moment de
l'échec, sous `e2e/captures/echecs/`. Les messages de la console du navigateur
sont collectés pendant tout le parcours et joints au verdict.

### 29.6 La console du navigateur fait partie du verdict

Un avertissement toléré pendant des mois finit par masquer l'erreur qui comptait.
Les parcours échouent si l'**application** écrit dans la console.

Le journal réseau que Chromium produit de lui-même pour toute réponse non-2xx
n'en fait pas partie : les parcours provoquent délibérément des refus, et
compter ces lignes rendrait le contrôle inutilisable. Elles sont comptées à part
et affichées, jamais masquées.

### 29.7 Ce que ces parcours ne prouvent pas

Le pilote reste factice (§28.7). Aucun quota n'est appliqué, aucun conteneur ne
tourne, aucune configuration Caddy n'est chargée. Ces parcours prouvent que le
produit **s'utilise** de bout en bout et que ses refus arrivent où il faut ; ils
ne prouvent rien de l'isolation, qui exige un hôte Incus réel (§13).


## 30. Le manuel et sa fraîcheur

`CLAUDE.md` §7 exige que la documentation utilisateur suive le comportement réel
et que « les captures d'écran soient renouvelées lorsque l'apparence ou le
parcours change ». Une exigence de ce genre ne tient pas sans mécanisme : elle
dépend de la vigilance, et la vigilance s'épuise.

Cette section dit comment le manuel est **tenu vrai par construction**.

### 30.1 Les illustrations sont produites, jamais collectées à la main

Un harnais parcourt la pile réelle seedée (§28) et écrit les images du manuel
sous `docs/manuel/images/`. Aucune image n'entre autrement.

Conséquence directe : une capture ne peut pas montrer un écran qui n'existe plus,
puisqu'elle est refaite depuis l'application à chaque exécution. Et si le parcours
change au point que le harnais n'atteint plus l'écran, il **échoue** au lieu de
laisser en place une image périmée.

### 30.2 Le lien manuel-image est vérifié dans les deux sens

Deux dérives sont possibles, et une seule est visible à l'œil :

- une page cite une image **absente** — le lecteur voit un cadre vide. C'est
  visible, mais seulement par celui qui ouvre la page ;
- une image **orpheline** subsiste, plus citée par aucune page. Elle n'est vue de
  personne, et elle survit indéfiniment à l'écran qu'elle montrait.

Le contrôle porte donc sur les **deux sens** : toute image citée existe, et toute
image produite est citée. Les deux échouent la campagne.

### 30.3 Ce qu'un chapitre a le droit d'affirmer

Un chapitre n'est écrit qu'à partir d'un comportement **observé sur la pile**.
Trois conséquences que le plan laissait implicites :

- un chapitre dont l'unité n'est pas livrée **n'est pas rédigé**. Il figure au
  manuel avec la raison et l'unité qui le débloque, plutôt que d'être écrit
  d'avance et faux ;
- un comportement mesuré sur l'hôte réel mais **non reproductible** sur la pile de
  développement — l'isolation, les quotas, l'émission d'un certificat — est
  présenté comme tel, en renvoyant à la mesure du §13, jamais comme quelque chose
  que le lecteur pourra vérifier avec la pile de développement ;
- aucune valeur de secret, aucune adresse réelle. Les noms de variables
  d'environnement sont autorisés, leurs valeurs jamais (`CLAUDE.md` §7).

### 30.4 Ce que le manuel n'est pas

Ce n'est ni le DAT, ni le journal. Il ne justifie pas les choix d'architecture :
il explique comment se servir du produit. Quand une explication demande de
comprendre une décision — pourquoi une réservation n'est pas un plafond, pourquoi
un instantané n'est pas une sauvegarde —, le manuel énonce la conséquence pour
l'exploitant et renvoie au DAT pour le raisonnement.


## 31. L'installation du serveur et sa vérification

Le §12 du contrat de déploiement énumère les opérations manuelles. Cette section
dit comment on **sait** qu'elles ont été faites, et pourquoi cette vérification
est le livrable principal de l'installation.

### 31.1 Une seule liste de contrôles, employée deux fois

La même série de contrôles sert **avant** l'installation — pour savoir ce qui
manque — et **après** — pour constater que le serveur est en état. Deux listes
distinctes finiraient par diverger, et c'est l'après qui deviendrait faux, parce
qu'on ne le relit qu'en cas de doute.

Chaque contrôle porte un identifiant stable, cité par le contrat de déploiement.

### 31.2 Un contrôle mesure, nomme sa valeur, et donne son remède

Un contrôle qui rend « échec » sans rien d'autre oblige l'exploitant à aller
mesurer à la main ce que le programme venait de mesurer.

Chacun rend donc trois choses : le **verdict**, la **valeur relevée** telle
quelle, et la **commande** qui corrige. Un verdict `inconnu` existe et se
distingue d'un échec : ne pas avoir pu mesurer n'est pas la même chose qu'avoir
mesuré une valeur fautive, et les confondre ferait « corriger » un serveur
correct.

### 31.3 La vérification ne modifie rien

Elle est **lecture seule**, sans exception. C'est ce qui la rend utilisable : on
peut la lancer sur un serveur en service sans se demander ce qu'elle va faire.

L'installation, elle, est un script distinct. Cette séparation est délibérée —
un outil qui vérifie *et* répare finit par réparer ce qu'on voulait seulement
constater.

### 31.4 Ce que l'installation doit garantir, mesuré le 2026-08-19

Relevé sur l'hôte cible, en lecture seule :

| Condition | État relevé |
|---|---|
| Incus ≥ 6.19 (§3.1) | **7.3** — conforme |
| pool de stockage à quotas, compression | `spark`, ZFS, compression active |
| plafond de l'ARC ZFS | 16 Gio |
| bridge privé et plage DHCP disjointe | `sparkbr0` en `10.77.0.1/24`, plage `.240-.254` |
| Caddy et son API d'administration locale | v2.11.4, API sur `127.0.0.1:2019` |
| surface réseau : `22`, `80`, `443` seulement | conforme — `9876` et `2019` sur la boucle locale |
| `sparkd` **survit à un redémarrage** | **NON** — il tourne depuis un terminal |

Le dernier point est le manque réel. Un plan de contrôle lancé à la main depuis
une session `ssh` disparaît au premier redémarrage, et les Sparks continuent de
tourner sans que rien ne les administre : la panne est silencieuse et ne se
découvre qu'à la première opération. L'installation pose donc une **unité
systemd**, et la vérification contrôle qu'elle est **activée au démarrage**, pas
seulement démarrée.

### 31.5 Ce que la vérification ne dit pas

Elle contrôle des **conditions**, pas des comportements. Qu'Incus soit en 7.3
n'établit pas qu'une pile Docker tourne dans un Spark : cette preuve-là est une
mesure, et elle est au §13. La vérification dit que le serveur est en état
d'être utilisé ; le §13 dit que le produit fonctionne.


## 32. Rendre la réservation CPU absolue

Le §7.3 bis constate la dette : Incus place chaque Spark à la **racine** de
cgroup v2, frère de `system.slice`, `user.slice` et `init.scope`. Le poids d'un
Spark est donc arbitré contre l'hôte, et sa réservation n'est proportionnelle
qu'entre Sparks. Cette section dit comment on la rend absolue.

### 32.1 Le mécanisme, mesuré le 2026-08-19

LXC accepte de placer la charge ailleurs qu'à la racine, et Incus laisse passer
la directive par `raw.lxc` :

```
lxc.cgroup.dir.container = spark.slice/<nom>
lxc.cgroup.dir.monitor   = spark.slice/monitor-<nom>
```

Mesuré sur l'hôte : l'instance atterrit dans `/sys/fs/cgroup/spark.slice/<nom>`
et non plus à la racine. **Deux propriétés survivent au déplacement**, et c'est ce
qui rend la solution viable :

- la loi de poids du §7.2 bis s'applique **inchangée** — `allowance 25 %` et
  `priority 5` donnent `cpu.weight = 20`, exactement `25 − 10 + 5` ;
- `cpu.max` reste `max`, donc le **burst** du mode partagé est préservé (§7.2).

La tranche doit porter les contrôleurs délégués (`cpu`, `cpuset`, `memory`, `io`,
`pids`), sans quoi les limites ne s'appliqueraient pas à l'intérieur.

### 32.2 Le poids de la tranche n'est pas une constante

C'est le cœur de l'unité. Placer les Sparks sous un parent ne suffit pas : il
faut que ce parent pèse **exactement ce que les Sparks ont acheté**.

L'hôte présente trois tranches à `cpu.weight = 100` — `system.slice`,
`user.slice`, `init.scope` — soit `H = 300`. Sous contention totale, une tranche
de poids `W` obtient `W / (W + H)` de la machine.

Pour qu'un Spark réservant `r` obtienne `r / C` de la machine, il faut que la
tranche obtienne la somme des réservations rapportée à la capacité :

```
W / (W + H) = f        où f = Σr / C
donc  W = H × f / (1 − f)
```

Vérification arithmétique sur l'hôte, `C = 4` cœurs :

| Σr | f | W | part obtenue | attendu |
|---|---|---|---|---|
| 1,0 | 0,25 | 100 | 100/400 = 25 % | 1/4 ✓ |
| 2,0 | 0,50 | 300 | 300/600 = 50 % | 2/4 ✓ |
| 3,5 | 0,875 | 2100 | 2100/2400 = 87,5 % | 3,5/4 ✓ |

**Le poids se recalcule donc à chaque changement d'allocation** — création,
suppression, redimensionnement. Une constante rendrait la réservation absolue
seulement pour un taux de remplissage donné, et fausse partout ailleurs.

#### Ce que la mesure a corrigé dans ce calcul

**Mesuré le 2026-08-19**, sous contention provoquée : un Spark réservant 1 CPU
sur une machine de 8 threads, tranche à poids 100, a obtenu **50 %** de la
machine — et non les 25 % que le tableau annonce.

```
fenêtre 25 s sur 8 threads
Spark        100,22 s  → 50,1 %
system.slice  98,70 s  → 49,3 %
```

La cause n'est pas une erreur de calcul : **`H` n'est pas une constante**. Un
poids cgroup ne se partage qu'entre frères **exécutables**. Pendant la mesure,
`user.slice` et `init.scope` étaient au repos : seuls `spark.slice` (100) et
`system.slice` (100) se disputaient la machine, d'où 100/200.

Conséquence sur la promesse, et elle est favorable :

- avec `H = 300` posé en dur, la tranche est **sous-évaluée** dès qu'une tranche
  de l'hôte est inactive. Le Spark obtient alors **plus** que sa part, jamais
  moins ;
- la réservation devient donc un **plancher** : `r / C` est garanti quand tout
  l'hôte s'exécute, et dépassé sinon. C'est ce qu'une réservation doit être, et
  c'est cohérent avec le burst du §7.2.

**Ce qui reste à prouver**, et c'est pourquoi SPK-29 n'est pas close : que sous
contention **totale** — les trois tranches de l'hôte exécutables en même temps —
la part converge bien vers `r / C`. La mesure ci-dessus ne l'établit pas, elle
établit seulement que le plancher est tenu et largement dépassé quand l'hôte est
calme.

### 32.3 L'hôte garde une part, et c'est ce qui rend la loi définie

Quand `f → 1`, `W → ∞` : les Sparks prendraient tout et l'hôte n'ordonnancerait
plus rien — ni `sparkd`, ni `sshd`, ni Incus lui-même. On ne pourrait alors même
plus corriger la situation.

**Une réserve CPU de l'hôte est donc nécessaire à la définition de la loi**, pas
seulement prudente. C'est le même raisonnement qu'au §16 pour la mémoire :

```
capacité allouable = cœurs physiques − réserve CPU de l'hôte
```

`f` est calculée sur la capacité **physique**, et bornée par la réserve :

```
f = min(Σr, C − réserve) / C
```

Avec une réserve de `0,5` cœur sur quatre, `f` ne dépasse jamais `0,875` et `W`
reste fini. La réserve est un **réglage explicite**, comme
`SPARKD_MEMORY_RESERVE` : elle dépend de ce que l'exploitant fait tourner à côté,
et le produit n'a pas à le supposer.

### 32.4 La tranche doit survivre à un redémarrage

Mesuré : une tranche créée à la main dans `/sys/fs/cgroup` **disparaît au
redémarrage**. Les Sparks retomberaient alors à la racine, et la réservation
redeviendrait proportionnelle sans que rien ne le signale — exactement le défaut
qu'on corrige, revenu en silence.

La tranche est donc une **unité systemd** (`spark.slice`), posée par
l'installation et activée au démarrage, au même titre que `sparkd` (§31.4). Le
contrôle `RUN-SPARKD` gagne un pendant : la tranche existe et porte ses
contrôleurs.

### 32.5 Ce que cette section ne prétend pas

La réservation devient absolue **sous contention CPU**. Elle ne dit rien de la
latence, ni de la contention mémoire ou disque. Et elle ne vaut que si la loi de
poids est appliquée à tous les Sparks : un Spark créé hors de la tranche — par
`incus launch` à la main, par exemple — échapperait au partage et fausserait
celui de tous les autres. Le §14 reste la référence : le registre est la seule
source de vérité sur ce qui existe.


## 33. Le catalogue d'images

### 33.1 Ce que le champ « image » vaut aujourd'hui

`spark.image` est un `TEXT NOT NULL` libre (`docs/SCHEMA.md` §4), et l'écran de
création le saisit dans un champ texte, pré-rempli à `images:debian/13`.

Le seul contrôle existant est celui du traducteur : `translate.split_image()`
sépare « dépôt:alias » et refuse un **dépôt** inconnu. Il ne dit rien de
l'**alias**. `images:debian/31` passe donc tous les contrôles locaux.

Ce qui se produit alors est mesurable dans le code du §14.2 : la ligne du
registre est écrite *avant* que l'instance n'existe, donc la ressource est déjà
comptée ; le refus ne vient qu'à `apply`, d'Incus, et `finish(success=False)`
laisse le Spark en `error` avec ses quotas engagés. Il faut le supprimer pour
récupérer la ressource — et si l'instance n'a jamais existé, la suppression
rencontre INC-03.

Une faute de frappe coûte donc une ligne morte dans le registre et une part de
pool immobilisée, pour une erreur que l'on pouvait connaître avant d'écrire quoi
que ce soit.

### 33.2 Décision : un catalogue tenu par le registre

Le registre porte un **catalogue d'images**, pré-renseigné, vérifié, et faisant
autorité à la création.

- Une entrée nomme une image utilisable : sa **référence** (`images:debian/13`),
  son **libellé** lisible, son dépôt, son alias, son architecture, et l'état de sa
  dernière vérification.
- La création n'accepte qu'une **référence du catalogue**. Le refus est alors un
  refus d'admission ordinaire, rendu **avant** l'écriture de la ligne, comme celui
  du §7.7.
- Le catalogue est **extensible** : ajouter une image est un geste explicite, qui
  déclenche sa vérification. Ce n'est pas le formulaire de création qui sert de
  porte d'entrée à une référence inconnue.
- La saisie est recueillie par une **modale limitée à la section « Catalogue »**
  (`DESIGN_SYSTEM.md` §6.27), comme celle des panneaux d'un Spark (§26.2). Elle
  s'ouvrait d'abord dans le flux, sous le tableau qu'elle décrit : la section
  portait alors deux sujets et la tabulation sortait de la saisie, ce que le §5.4
  interdit. Ajouter au catalogue **insère un élément dans une section** ; c'est la
  création d'un Spark, objet de premier plan, qui garde sa destination propre.

### 33.3 La vérification est un relevé, pas un rafraîchissement

Le catalogue suit la règle déjà retenue pour la topologie de l'hôte (§27.8) :
l'existence d'une image est **relevée explicitement**, datée, et affichée avec sa
date. Elle n'est pas revérifiée à chaque requête.

Motif : interroger un dépôt distant à chaque ouverture d'un formulaire rendrait
la création tributaire d'un service extérieur, alors que l'ensemble du produit
tient sans réseau sortant une fois les images en cache.

Une entrée porte donc trois états distincts, jamais confondus (`DESIGN_SYSTEM.md`
§14.6) :

| État | Sens |
|---|---|
| `verified` | l'image existait au dernier relevé, à sa date |
| `missing` | le dépôt ne la publie plus au dernier relevé |
| `unknown` | jamais relevée, ou relevé impossible |

Une entrée `missing` ou `unknown` reste **visible** et n'est pas proposée à la
création : la faire disparaître ferait croire qu'elle n'a jamais existé.

**Mesuré le 2026-08-19 sur l'hôte**, et la mesure corrige l'hypothèse sur un
point qui change le code.

La voie est bien celle qui était pressentie : `/streams/v1/index.json` donne
`streams/v1/images.json`, qui publie **272 produits**. Mais la façon d'y trouver
un alias n'était pas celle qu'on aurait supposée.

```
clé de produit : debian:trixie:amd64:default     ← nom de CODE, pas « 13 »
aliases        : "debian/13,debian/trixie,…"     ← champ à part, séparé par des virgules
```

Trois conséquences :

- **l'alias ne se déduit pas de la clé.** `debian:13:amd64` ne correspond à rien :
  la clé porte `trixie`. Il faut lire le champ `aliases` de chaque produit et
  construire la table inverse — 230 alias distincts pour 272 produits ;
- **l'architecture n'est pas dans l'alias.** `debian/13/amd64` est **absent** de
  la table des alias ; `debian/13` y renvoie aux quatre produits
  `amd64`, `arm64`, `armhf`, `riscv64`. L'architecture se lit dans la clé, pas
  dans ce que l'exploitant saisit ;
- **un alias inexistant est bien absent.** `debian/31` ne figure nulle part, ce
  qui est la propriété dont dépend tout le §33.2.

Pour ce qui est déjà local, `GET /1.0/images` sur la socket d'Incus rend les
empreintes des images en cache. Mesuré : l'image présente sur l'hôte n'a **aucun
alias local**. Le local renseigne donc la disponibilité hors ligne, jamais
l'existence d'un alias — les deux voies sont complémentaires et ne se
remplacent pas.

### 33.4 Ce que le catalogue n'est pas

Ce n'est **pas** un registry. Le §1 exclut explicitement du périmètre la
construction d'images applicatives, la CI/CD et le registry, et cette exclusion
ne bouge pas : le
catalogue ne stocke aucune image, n'en construit aucune, n'en publie aucune. Il
tient une liste de références *système* utilisables pour créer une cellule.

Les images **Docker** du locataire ne le concernent pas davantage. Elles vivent
dans le Spark, sous sa responsabilité, et le plan de contrôle n'a aucune socket
Docker pour les regarder (§11).

### 33.5 Conséquence sur l'écran de création

Le champ « Image » devient une **liste déroulante** alimentée par le catalogue,
avec le libellé lisible et la référence, ordonnée, et pré-sélectionnée sur
l'entrée par défaut. Une saisie libre ne peut plus produire une référence qui
n'existe pas.

Cela ne contredit pas le §25.1 — « montrer sans décider ». Le §25.1 interdit de
**bloquer sur une estimation périmée** de la capacité : la capacité change entre
l'ouverture de l'écran et la soumission. L'existence d'un alias, elle, ne se
périme pas dans le même intervalle, et la contrainte est ici de **forme**, comme
celle du nom au §25.3 : on ne propose pas une valeur dont on sait qu'elle sera
refusée.


## 34. L'architecture de navigation de la console

`docs/DESIGN_SYSTEM.md` §5.4 fixe trois degrés — barre latérale, onglets, puis
fenêtre en lecture et modale par section (§6.27). Cette section dit ce qu'ils
désignent dans la console, et ce qu'ils changent de l'existant.

### 34.1 Ce que porte chaque degré

| Degré | Contenu | Forme |
|---|---|---|
| 1 | Sparks, Hôte | barre latérale |
| 2 | sous Sparks : Instances · sous Hôte : Pools, Images | onglets |
| 3 | la fenêtre d'un Spark : Infos, Routes, Clés, Instantanés, Journal, Docker, Terminal | onglets de la fenêtre, sections à l'intérieur |
| — | modifier une section, ou lui insérer un élément | modale limitée à cette section |

La fenêtre d'un Spark porte ses propres onglets, sous ceux du second degré. Le
§5.4 du design system l'autorise explicitement : deux rangées d'onglets pour deux
sujets distincts — ce que l'on regarde, puis quelle facette du Spark ouvert. La
hiérarchie est une orientation ; ce qu'elle sert à obtenir ne l'est pas :

1. ce qui s'affiche et ce qui se saisit ne partagent pas la même surface ;
2. une surface a un seul sujet, nommable en une phrase ;
3. une action sensible se confirme (§6.23 du design system).

L'onglet **Images** est la surface du catalogue (§33) : il décrit l'hôte, pas un
Spark, et c'est là que s'ajoute et se relève une référence.

Le **sélecteur de serveur** et l'état du tunnel restent au-dessus du premier
degré. Ce n'est pas une destination : c'est le contexte de toutes les
destinations (`docs/DESIGN_SYSTEM_APP.md` §1). Le confondre avec une entrée de
navigation ferait croire qu'on peut « aller au serveur » comme on va aux Sparks.

Les onglets du second degré sont de **véritables destinations** — on doit pouvoir
recharger la page sur l'onglet « Instantanés » d'un Spark. Ce sont donc des liens
dans un `nav`, avec `aria-current="page"`, et non un `tablist` (§5.2 et §5.4 du
design system).

### 34.2 Ce que cela révise du §26.2

Le §26.2 avait tranché : « pas de modale », le formulaire d'ajout s'ouvre dans le
flux du panneau. Ce choix reposait sur un argument de coût — ni voile, ni piège
de focus, ni `Échap` global pour trois formulaires de deux champs.

**La règle du responsable le remplace** : la modification d'une section passe par
une modale (`DESIGN_SYSTEM.md` §6.27). L'argument de coût tombe dès lors que la
console porte une modale par ailleurs : ce qui était trois exceptions à écrire
devient un composant unique, déjà écrit, et le contrat d'interaction du §26.2 —
focus entrant, annulation qui rend le focus, saisie qui survit à un refus — est
exactement celui que le §6.27 impose.

Ce qui **ne** devient **pas** une modale, et le §6.27 le dit :

- la confirmation de suppression d'un Spark, d'une route, d'une clé ou d'un
  instantané reste **dans le flux** (§6.22, §6.23) ;
- l'écran de création garde sa destination propre : une création qui mérite une
  URL mérite un écran, pas une fenêtre superposée ;
- les commandes de cycle de vie (§24) restent des boutons de l'onglet Infos de la
  fenêtre du Spark ;
- ouvrir une modale ne vaut pas confirmation : une action sensible engagée depuis
  une modale demande sa confirmation, rendue dans le flux de cette modale.

**Fait le 2026-08-19** : le §26.2 est réécrit et décrit la modale. Il conserve
l'argument de coût qui avait fait choisir le formulaire dans le flux, pour qu'on
ne le refasse pas — il était juste tant que la console ne portait aucune modale.

### 34.3 Ce que la refonte ne doit pas perdre

Elle est une refonte de **surface**. Rien de ce que les §24 à §27 ont établi ne
change :

- le runtime publie ce qui est possible, l'écran n'en déduit rien (§24.1) ;
- un refus est rendu près du geste refusé et n'efface pas la saisie (§25.2) ;
- un seul formulaire ouvert à la fois (§26.2) — une seule modale à la fois le dit
  désormais mécaniquement ;
- l'ordre refus-puis-acceptation des instantanés (§26.5) ;
- les états d'une vue — chargement, vide, erreur — restent traités par onglet, et
  non une fois pour la page (`DESIGN_SYSTEM.md` §6.13).

Le contrôle en est simple : les parcours E2E du §29 doivent passer après la
refonte **sans que leur intention change**. Leurs sélecteurs changeront ; ce
qu'ils prouvent, non.


## 35. Les Sparks protégés

### 35.1 Ce que protège la protection, et de quoi

Un Spark porte un interrupteur de **protection**. Tant qu'il est armé, le plan de
contrôle refuse toute écriture visant ce Spark — par l'API comme par la console,
puisque c'est le **runtime** qui refuse.

Ce dont il protège : le geste accidentel. Le mauvais Spark sélectionné, la ligne
cliquée trop vite, le `curl` recopié d'un autre bocal, le script d'astreinte lancé
sur le mauvais nom.

Ce dont il **ne** protège **pas**, et il faut le dire aussi nettement : d'un
opérateur hostile. Qui détient une clé SSH de l'hôte atteint `sparkd` (§11), et
qui détient `root` sur l'hôte atteint le fichier SQLite du registre. La protection
est un **garde-fou**, pas un contrôle d'accès, et le produit ne la présentera
jamais comme une frontière de sécurité.

Elle est appliquée côté runtime malgré tout, et ce n'est pas contradictoire : une
protection que seule l'interface respecterait ne protégerait pas du cas le plus
fréquent — le script, pas l'humain.

### 35.2 Portée : toutes les écritures visant le Spark

Sont refusées sur un Spark protégé :

- les commandes de cycle de vie (§14) — `start`, `stop`, `restart`, `apply`,
  `retry`, `delete` ;
- toute reconfiguration de ses quotas ;
- les routes d'ingress qui le désignent, en ajout comme en retrait ;
- l'**octroi** d'une clé à ce Spark ;
- la création, la suppression et la **restauration** d'un instantané.

Ne sont **pas** refusées : les lectures, les métriques, le journal d'audit.

La règle est volontairement **entière**. Une liste partielle — « on peut démarrer
mais pas supprimer » — obligerait à justifier chaque cas et produirait exactement
les surprises que l'interrupteur est censé supprimer. Un Spark protégé reste dans
l'état où son responsable l'a laissé.

**Deux exceptions, et elles sont structurelles.** La protection porte sur les
gestes qui **visent** ce Spark, pas sur les recalculs globaux dont il n'est
qu'objet indirect :

- la redistribution des cœurs lors d'une découpe (§7.4 bis) ;
- la repondération de `spark.slice` à chaque changement d'allocation (§32.2).

Les bloquer ferait échouer la création d'un *autre* Spark parce qu'un troisième
est protégé, ce qui serait incompréhensible et faux : ces recalculs n'altèrent ni
sa configuration, ni son état, ni ses données.

**Une troisième exception, et c'est la plus importante : retirer un accès passe
toujours.** La révocation d'une clé — sur ce Spark, ou du registre entier par
`DELETE /v1/ssh-keys/{label}`, qui la retire de **tous** les Sparks (§26.1) —
n'est jamais refusée par la protection.

Motif, et il est décisif : la protection existe pour arrêter l'erreur, pas pour
retenir un geste de sécurité. Le jour où l'on retire l'accès d'une personne
partie, ou d'une clé qui a fuité, un refus ne protégerait rien — il laisserait
l'accès en place parce qu'un interrupteur a été oublié ailleurs. Ce serait
transformer un garde-fou en vulnérabilité. C'est la règle du §6.23 du design
system : une protection ne bloque jamais un geste qui **réduit** un risque.

Ce qui reste, c'est le devoir d'**informer** : la révocation qui touche un ou
plusieurs Sparks protégés les **nomme**, et demande une confirmation explicite
portant cette liste. Elle aboutit ensuite sans qu'aucune protection ait à être
levée, et sans en lever aucune. Le journal d'audit enregistre la révocation avec
les Sparks protégés qu'elle a touchés.

Le partage est donc net : **octroyer** une clé à un Spark protégé se refuse,
**révoquer** se confirme.

### 35.3 Le mot de passe

La protection s'arme avec un mot de passe et se lève avec ce même mot de passe.

- Il n'est **jamais** stocké en clair : le registre garde une empreinte dérivée
  par `scrypt` (bibliothèque standard), avec un **sel aléatoire par Spark** et les
  paramètres de coût stockés à côté de l'empreinte, pour que ceux-ci puissent
  évoluer sans invalider l'existant.
- Il n'est **jamais** journalisé. Le filtre de secrets du §21 gagne le champ,
  au même titre que les clés — et le journal enregistre la **tentative**, son
  résultat et sa date, jamais sa valeur.
- Il n'y a **aucune récupération** par l'API. Un mot de passe perdu se lève sur
  l'hôte, avec `root`, dans le registre. C'est cohérent avec le §35.1 : ce n'est
  pas un chiffrement, et prétendre le contraire par un mécanisme de secours
  compliqué serait mentir sur ce que l'interrupteur vaut.

**Pas de verrouillage après N échecs.** Un compte à rebours ne gênerait que le
responsable légitime — l'attaquant qu'il repousserait a déjà, par hypothèse, un
accès qui lui permet de contourner la protection tout entière. Chaque tentative
est en revanche journalisée, réussie comme refusée : c'est la trace qui a une
valeur ici, pas l'entrave.

### 35.4 Lever la protection est un état, pas une fenêtre de temps

Lever la protection la **désarme**, durablement, jusqu'à ce qu'on la réarme.

L'alternative — un déverrouillage temporaire, valable quelques minutes — a été
écartée : elle rend le comportement du produit dépendant de l'heure, donc
imprévisible, et pousse à travailler vite pour « ne pas rater la fenêtre », ce qui
est l'inverse du but recherché.

Conséquences, portées par l'interface :

- l'état protégé est **visible** partout où le Spark est listé, pas seulement
  dans sa fenêtre ;
- un Spark désarmé le dit aussi clairement, pour que l'oubli de réarmement se
  voie ;
- les deux transitions sont journalisées avec leur acteur et leur date.

Réarmer demande de saisir un mot de passe — le même ou un autre. Le produit ne
retient pas l'ancien pour le proposer.

### 35.5 Surface d'API

| Geste | Route | Corps | Réponse |
|---|---|---|---|
| armer | `POST /v1/sparks/{name}/protection` | `{ "password": … }` | `200` |
| lever | `DELETE /v1/sparks/{name}/protection` | `{ "password": … }` | `200` |

La révocation d'une clé suit l'**ordre refus-puis-acceptation** déjà retenu pour
la restauration d'un instantané (§26.5), parce qu'il donne à la console de quoi
nommer ce qu'elle va toucher :

| Geste | Route | Corps | Réponse |
|---|---|---|---|
| révoquer sans savoir | `DELETE /v1/ssh-keys/{label}` | `{}` | `409 protected_sparks_affected`, avec la **liste nommée** des Sparks protégés touchés |
| révoquer en connaissance | `DELETE /v1/ssh-keys/{label}` | `{ "accept_protected": true }` | `200` |

Aucun mot de passe n'est demandé sur ce chemin : exiger le secret de chaque Spark
protégé pour révoquer une clé qui a fuité reviendrait à refuser. Le premier appel
n'est pas un blocage, c'est la façon dont le runtime **dit ce qui sera touché** —
et si aucun Spark protégé n'est concerné, il n'y a pas de refus du tout, la
révocation passe directement.

La même mécanique vaut pour `DELETE /v1/sparks/{name}/ssh-keys/{label}` lorsque
le Spark visé est protégé.

Une écriture refusée par la protection répond **`423 spark_protected`**, avec un
message qui nomme le Spark et le geste refusé. Le code est distinct des refus
d'admission (`409`) et des refus de transition (`409`) : confondre « impossible
maintenant » et « verrouillé exprès » ferait chercher une cause qui n'existe pas.

Un mot de passe erroné répond `403 bad_protection_password`, sans distinguer
« mauvais mot de passe » de « Spark non protégé » dans le délai de réponse — mais
en le distinguant dans le message, puisque le §35.1 assume que ce n'est pas un
secret défendu contre un adversaire.

Le registre gagne les colonnes correspondantes par migration, et
`docs/SCHEMA.md` est mis à jour dans le même changement que celle-ci.

### 35.6 Ce que la protection ne fait pas

- Elle n'empêche **rien à l'intérieur** du Spark. Le locataire y reste maître de
  sa pile Docker : la protection est une propriété du plan de contrôle, pas du
  système invité.
- Elle ne protège pas des pannes, ni de la perte du pool de stockage. Ce n'est ni
  une sauvegarde, ni un instantané (§19).
- Elle ne crée pas de rôles : il n'y a toujours qu'un responsable, et le produit
  n'introduit pas de modèle multi-utilisateur par ce biais.


## 36. Intégrité du journal d'audit

Le §21 dit ce que le journal contient et par où il s'écrit. Cette section dit ce
qui garantit qu'il n'a pas été **récrit**, et surtout ce que chaque mécanisme
prouve réellement — parce que l'écart entre « signé » et « infalsifiable » est
exactement là où ce genre de dispositif déçoit.

### 36.1 Ce qu'une chaîne de hachage prouve, et contre qui

Chaîner les lignes — chaque entrée porte l'empreinte de la précédente — détecte
la **modification** et la **suppression au milieu** du journal. C'est peu coûteux
et c'est la bonne primitive. Mais seule, elle ne détecte que l'adversaire qui
n'a pas lu le code : quiconque peut écrire dans le fichier peut aussi
**recalculer toute la chaîne** après modification, et obtenir un journal
parfaitement cohérent.

Deux attaques ne sont pas couvertes du tout par la chaîne seule :

- la **troncature** — on coupe la fin, la chaîne restante est valide ;
- le **remplacement** — on repart d'un journal neuf et cohérent.

Ce qui distingue un journal chaîné utile d'un journal chaîné décoratif, ce n'est
donc pas la chaîne : c'est l'**ancre**.

### 36.2 L'ancre : la console est le second témoin

Le produit a déjà ce qu'il faut : la console tourne sur une **autre machine** que
l'hôte, et s'y connecte régulièrement (§22).

Décision : la console retient, par serveur, la **dernière empreinte de tête**
qu'elle a vue, dans son inventaire local. À chaque connexion, elle vérifie que
l'histoire annoncée par le serveur **prolonge** celle qu'elle connaît. Une
histoire qui ne la prolonge pas — tête inconnue, longueur en recul, empreinte
divergente — est signalée, et ce signal couvre la troncature et le remplacement
que la chaîne seule laisse passer.

C'est le point important : ce n'est pas la cryptographie qui apporte la garantie,
c'est le fait que la vérité de référence vive **ailleurs** que sur la machine
qu'on soupçonne.

### 36.3 Où la signature est produite décide de ce qu'elle vaut

Signer les lignes avec une clé **détenue par l'hôte** ne protège pas de qui
contrôle l'hôte : il signe ce qu'il veut. Cela reste utile contre un processus
non privilégié ou une erreur, et rien de plus. Il ne faut pas l'appeler
autrement.

Signer **côté console**, avec la clé SSH du responsable via son agent, change la
nature de la preuve : la clé privée n'est jamais sur l'hôte. Root peut alors
supprimer ou tronquer, mais ne peut pas **fabriquer** un geste authentique. C'est
la seule forme de non-répudiation atteignable ici, et elle rejoint une des pistes
de SPK-35 : un seul mécanisme sert à la fois d'authentification et de preuve
d'audit.

Ce qu'une signature de requête couvre, et qu'il faut dire : elle atteste
l'**intention** — ce qui a été demandé, par qui, à quel instant logique. Elle
n'atteste pas ce que le runtime a réellement fait ensuite. Le résultat, lui, est
couvert par la chaîne, pas par la signature.

### 36.4 Deux classes de lignes, jamais confondues

Toutes les entrées ne peuvent pas être signées par un humain :

| Classe | Exemples | Ce qui la couvre |
|---|---|---|
| geste humain | création, commande, route, clé, instantané | signature de la requête + chaîne |
| événement du runtime | réconciliation au démarrage (§14.3), repondération de la tranche (§32.2), relevés | chaîne seule |

Les afficher pareillement laisserait croire que la seconde classe est signée. La
supervision distingue donc les deux, explicitement.

### 36.5 Les pièges, qui sont tous des pièges d'implémentation

Ils sont listés ici parce que chacun produit soit une fausse alerte, soit une
garantie creuse, et qu'ils se découvrent trop tard.

- **Sérialisation canonique.** L'empreinte porte sur des octets. Ordre des
  champs, encodage, représentation des nombres et de `null` doivent être figés une
  fois pour toutes, sans quoi une vérification échouera un an plus tard sans
  qu'aucune ligne n'ait bougé.
- **Lecture de la tête et insertion dans la même transaction.** Sinon deux
  écritures s'intercalent et la chaîne fourche. SQLite n'a qu'un écrivain, ce qui
  aide, mais ne dispense pas de l'atomicité.
- **Les trous d'identifiants ne sont pas des altérations.** La vérification porte
  sur la chaîne, jamais sur la continuité des `id` — confondre les deux
  fabriquerait des alertes fausses, ce qui est la meilleure façon de faire ignorer
  les vraies.

  **Correction du 2026-08-19, mesurée.** Ce paragraphe affirmait qu'`AUTOINCREMENT`
  consomme des identifiants qu'un `ROLLBACK` abandonne. C'est **faux sur SQLite** :
  le `ROLLBACK` annule aussi la mise à jour de `sqlite_sequence`, et l'identifiant
  est réattribué. Mesuré — une insertion annulée laisse `seq` à sa valeur
  antérieure, et la ligne suivante reprend l'identifiant libéré.

  La règle ne change pas pour autant, et c'est important : elle n'est pas une
  réaction à un phénomène observé, c'est une **garantie de conception**. Une purge,
  une restauration partielle, une migration future ou un autre moteur peuvent
  produire des trous ; une vérification qui les jugerait deviendrait fausse ce
  jour-là, sans que personne ne l'ait touchée.
- **La purge casse la chaîne.** À trancher avant d'écrire la première ligne : soit
  le journal ne se purge jamais, soit une purge scelle le préfixe supprimé dans une
  ligne de **point de contrôle** qui porte son empreinte.
- **Le temps n'est pas une preuve.** La chaîne donne un **ordre**, pas une date :
  l'horloge de l'hôte est modifiable. Un horodatage reste informatif.
- **Le coût de vérification est linéaire.** Des points de contrôle périodiques
  permettent une vérification incrémentale. À l'échelle de ce produit, la
  vérification intégrale reste de toute façon peu coûteuse — le journal se compte
  en milliers de lignes, pas en millions.

### 36.6 Ce qui n'est pas retenu, et ce qui reste optionnel

**Pas de chaîne de blocs distribuée, pas de consensus, pas de jeton.** Le
consensus répond à la question « plusieurs écrivains qui ne se font pas
confiance » ; ici il y a **un** écrivain. Ce que le mot « blockchain » désigne
d'utile dans ce contexte se réduit à un journal chaîné et vérifiable, ce que le
§36.1 décrit.

Restent optionnels, désactivés par défaut, parce qu'ils introduisent une
dépendance sortante que le produit n'a pas :

- **copie hors machine au fil de l'eau** — un second exemplaire chez un tiers
  oblige à corrompre deux machines de façon cohérente. C'est le renfort le plus
  efficace après l'ancre de la console ;
- **ancrage temporel public** — publier périodiquement l'empreinte de tête auprès
  d'un service d'horodatage public prouve à un tiers qu'un journal existait à une
  date, sans aucune machinerie de consensus. Utile seulement si un tiers doit un
  jour être convaincu ;
- **arbre de Merkle plutôt que chaîne linéaire** — n'apporte que des preuves
  d'inclusion et de cohérence **partielles**, donc n'a d'intérêt que si un
  vérificateur tiers doit contrôler un extrait sans recevoir tout le journal.

### 36.7 Couverture : ce qui est journalisé, et ce qui ne l'est pas

Sont journalisées **toutes les écritures**, y compris celles produites par le
runtime lui-même. Un journal qui ne contient que les gestes humains laisse croire
que le reste n'est pas arrivé.

Les **lectures ne sont pas journalisées**. Elles n'altèrent rien, elles sont des
ordres de grandeur plus nombreuses, et les inscrire noierait précisément ce qu'on
vient chercher. Deux exceptions, parce qu'elles disent qui est entré et quand :
l'ouverture d'un tunnel, et les vérifications d'intégrité elles-mêmes.

**L'ordre reste : identité réelle, puis signature, puis chaîne, puis ancre.** La
première marche est livrée par SPK-37 et son contrat est au §21.6 : l'hôte console
déclare qui agit, `sparkd` porte cette déclaration au journal, et la classe —
geste humain ou événement du runtime — est une colonne et non une devinette.

Cette identité est **déclarative** : elle attribue, elle ne prouve pas. C'est
exactement pourquoi la signature reste due. Parler de « signature de l'acteur »
avant SPK-40 resterait une figure de style.

### 36.8 bis L'onglet de supervision : contrat (SPK-39)

Le §36.8 dit ce que l'onglet montre. Cette section dit ce qui se code.

#### 36.8.1 Une destination sous Hôte, pas une facette d'un Spark

`#/hote/journal`, troisième onglet de second degré après *Pools* et *Images*
(§34.1). Le journal **couvre tous les Sparks** : le lire dans la fenêtre d'un seul
obligerait à ouvrir chaque Spark pour reconstituer une séquence qui les traverse.

La facette *Journal* d'un Spark **reste** : elle répond à « qu'est-il arrivé à
CELUI-CI », qui est une autre question. Les deux coexistent sans se dupliquer, et
la seconde ne porte ni filtres ni vérification.

#### 36.8.2 Les quatre filtres

`GET /v1/audit` accepte, en plus de `limit` déjà existant :

| Paramètre | Effet | Forme |
|---|---|---|
| `result` | égalité stricte | `ok` \| `denied` \| `error` |
| `action` | **préfixe** — `spark` retient `spark.create`, `spark.settle`… | texte |
| `actor` | sous-chaîne, insensible à la casse | texte |
| `actor_class` | égalité stricte | `human` \| `runtime` |
| `since` | horodatage minimum, inclusif | ISO 8601 |

`action` filtre par **préfixe** et non par égalité : les actions sont nommées
`sujet.verbe`, et l'exploitant cherche « tout ce qui touche aux instantanés »
bien plus souvent qu'une action précise.

Un filtre inconnu est **refusé** en `422`, jamais ignoré : un filtre ignoré rend
une liste plus large que demandée, que l'exploitant lira comme un résultat filtré.
C'est la pire des deux erreurs.

#### 36.8.3 La vérification est un relevé explicite

Comme le relevé de topologie (§27.8) et celui du catalogue d'images (§33.3) : un
**bouton**, une **date**, et rien qui se rejoue à chaque affichage. Vérifier la
chaîne parcourt tout le journal ; le faire à chaque ouverture d'onglet en ferait
un coût permanent pour une information qui ne change qu'à l'écriture.

Tant qu'aucun relevé n'a eu lieu dans la session, l'écran le **dit** — il n'affiche
pas « intacte » par défaut. Une intégrité supposée est exactement ce que ce
dispositif existe pour ne pas laisser croire.

#### 36.8.4 Ce que l'écran montre de la chaîne et de l'ancre

Trois choses, et elles ne se confondent pas :

1. **l'état de la chaîne** — vérifiée le …, nombre d'entrées, tête ; et si elle est
   rompue, la ligne exacte avec son motif ;
2. **la comparaison avec l'ancre** — le verdict du §36.9.6 en toutes lettres, et
   ce que la console avait retenu face à ce que le serveur annonce ;
3. **la classe de chaque entrée**, dans le tableau — geste humain ou événement du
   runtime (§36.4).

Une chaîne intacte **et** une ancre qui alerte est le cas le plus important de
tout le dispositif : c'est exactement la troncature. L'écran ne doit donc jamais
résumer les deux en un seul indicateur — « tout va bien » y serait faux.

#### 36.8.5 Ce que l'écran ne prétend pas

Il n'écrit **jamais** « signé ». Le §21.6.2 le dit pour la facette d'un Spark, et
cela vaut ici davantage : une page entière consacrée à l'intégrité est l'endroit
où l'on croirait le plus volontiers à une garantie qui n'existe pas encore. La
signature est SPK-40.

**INC-01 y devient plus visible, et ce n'est pas un défaut de cette unité.** Les
messages du runtime portent son vocabulaire — « `starting` → `running` » — là où
l'interface affiche « En marche ». Une page entière de journal expose cet écart
sur des dizaines de lignes au lieu de trois. L'arbitrage appartient au responsable
(§21) ; l'onglet le rend visible, il ne le tranche pas, et il ne réécrit aucun
message.

### 36.9 La chaîne, ligne à ligne : contrat (SPK-38)

Les §36.1 à §36.5 disent ce que la chaîne prouve, contre qui, et quels pièges
l'annulent. Cette section fixe ce qui s'écrit.

#### 36.9.1 Deux colonnes, et ce qu'elles portent

`audit_log` gagne `entry_hash` et `prev_hash`, en hexadécimal minuscule.

- `entry_hash` = `sha256(serialisation_canonique(ligne))`, où la ligne inclut
  `prev_hash`. C'est ce chaînage-là qui rend une modification détectable : changer
  une ligne change son empreinte, donc invalide toutes les suivantes.
- `prev_hash` = l'`entry_hash` de la ligne précédente. La **première** ligne du
  journal porte `prev_hash` = `GENESE`, une constante littérale et non une chaîne
  vide : une chaîne vide se confond avec « colonne oubliée », et la confusion
  tomberait précisément sur la ligne qui ancre tout le reste.

#### 36.9.2 La sérialisation canonique, figée

C'est le premier piège du §36.5, et il ne se rattrape pas : une vérification qui
échouerait un an plus tard sans qu'aucune ligne n'ait bougé détruirait la
confiance dans le dispositif entier.

**Forme, figée une fois pour toutes** : JSON, séparateurs `,` et `:` sans espace,
clés **triées par ordre d'octets**, échappement `ensure_ascii`, encodage UTF-8.

**Champs retenus, et eux seuls** :

```
actor, actor_class, action, message, payload, prev_hash,
result, target_id, target_type, ts
```

`id` n'y figure **pas**, délibérément : il est attribué par la base, et un
`ROLLBACK` en consomme sans écrire (§36.5). Le faire entrer dans l'empreinte
ferait dépendre celle-ci d'un compteur que le produit ne contrôle pas.

Une valeur absente est sérialisée `null`, jamais omise. Omettre une clé produirait
deux octets différents pour deux lignes équivalentes.

**Toute évolution de cette forme est une rupture de compatibilité**, et se traite
comme telle : nouvelle version de sérialisation portée par une ligne de point de
contrôle, jamais un changement en place.

#### 36.9.3 La tête se lit et s'écrit dans la même transaction

`record()` calcule l'empreinte à partir de la tête courante, et insère, sous une
même transaction. `record()` n'en ouvrait pas — l'appelant décidait si la trace
devait vivre ou mourir avec son opération (§21.1) — et cela reste vrai : quand une
transaction est **déjà ouverte**, `record()` n'en ouvre pas une seconde ; sinon il
en ouvre une pour lui seul.

Ce que cela préserve, et qui compte : un refus journalisé **hors** transaction le
reste, sans quoi le `ROLLBACK` emporterait la trace — c'est exactement le cas où
elle sert.

#### 36.9.4 Points de contrôle, et la purge tranchée

**Le journal ne se purge pas.** C'est la décision, prise avant la première ligne
écrite, comme le §36.5 l'exige.

Motif : à l'échelle de ce produit le journal se compte en milliers de lignes, et
une purge sans scellement casserait la chaîne de façon indétectable. Le jour où
le volume l'imposera, la purge passera par une ligne de **point de contrôle**
(`action = "audit.checkpoint"`) qui porte l'empreinte du préfixe supprimé — et
elle sera une migration, pas une commande d'exploitation.

Le point de contrôle n'est donc **pas** livré par cette unité, mais la
vérification le connaît déjà : elle traite une ligne `audit.checkpoint` comme un
nouveau départ légitime, et non comme une rupture. L'ignorer aujourd'hui
obligerait à modifier la vérification le jour de la purge, c'est-à-dire au pire
moment.

#### 36.9.5 Ce que la vérification rend

`GET /v1/audit/verify` — une **lecture**, mais journalisée, comme le §36.7 le
prévoit pour les vérifications d'intégrité.

```
{
  "checked": 1234,          entrées parcourues
  "head": "…",              empreinte de la dernière ligne, ou null si vide
  "intact": true|false,
  "verified_at": "…",
  "break": null | {         PREMIÈRE rupture, et elle seule
     "id": 42,
     "reason": "entry_hash" | "prev_hash",
     "ts": "…", "action": "…"
  }
}
```

Elle désigne la **première** rupture et s'arrête là. Signaler les suivantes serait
du bruit : une ligne modifiée invalide mécaniquement toute la suite, et lister
mille alertes ferait manquer la seule qui compte.

`reason` distingue deux constats qui n'ont pas la même cause : `entry_hash` dit
que la ligne **elle-même** a été récrite, `prev_hash` dit qu'une ligne a été
**retirée ou insérée** avant elle.

**Ce que la vérification ne fait PAS** : contrôler la continuité des `id`. Un trou
est normal (§36.5) — `AUTOINCREMENT` en consomme à chaque `ROLLBACK`, et le §21
journalise délibérément certains refus hors transaction. Une alerte fausse est la
meilleure façon de faire ignorer les vraies.

**Ce qu'elle ne peut pas voir** : la troncature. Une chaîne coupée à la fin reste
parfaitement valide. Seule l'ancre du §36.2 la détecte, et le §36.9.6 dit comment.

#### 36.9.6 L'ancre, tenue par la console

La console retient dans son inventaire local, **par serveur** :

```
{ "head": "…", "length": 1234, "seenAt": "…" }
```

À chaque relevé, elle compare ce qu'elle avait vu à ce que le serveur annonce, et
rend un verdict :

| Verdict | Constat | Ce qu'il signifie |
|---|---|---|
| `first` | rien de retenu | premier relevé ; on retient, on ne juge pas |
| `extends` | longueur ≥ retenue, et la tête retenue est **retrouvée** dans l'histoire | l'histoire prolonge celle qu'on connaît |
| `unchanged` | tête identique, longueur identique | rien n'a été écrit depuis |
| `shrunk` | longueur en recul | **troncature** — la chaîne seule ne l'aurait pas vue |
| `diverged` | longueur suffisante mais tête retenue introuvable | **remplacement** — un journal neuf et cohérent |

`shrunk` et `diverged` sont exactement les deux attaques que le §36.1 dit non
couvertes par la chaîne. C'est là, et seulement là, qu'elles se voient.

L'ancre n'est mise à jour **que** sur `first`, `extends` et `unchanged`. Écraser
la référence sur un verdict d'alerte reviendrait à effacer la preuve avec le
signal : au second relevé, tout paraîtrait normal.

### 36.8 L'onglet de supervision

Le journal devient une destination de second degré sous **Hôte** (§34.1) : il
couvre tous les Sparks, il ne se lit pas dans la fenêtre d'un seul.

Il rend, outre les entrées filtrables :

- l'état de la chaîne — vérifiée le …, tête …, première rupture le cas échéant,
  avec la ligne exacte ;
- la comparaison avec l'ancre de la console — « prolonge l'histoire connue » ou
  le signalement contraire ;
- la **classe** de chaque entrée (§36.4), pour ne pas laisser croire à une
  signature qui n'existe pas.

La vérification est un **relevé explicite**, daté, comme le relevé de topologie
(§27.8) et celui du catalogue d'images (§33.3) : elle n'est pas rejouée à chaque
affichage.

Une réserve à traiter dans la même unité : INC-01 signale que les messages
d'audit portent le vocabulaire technique du runtime là où l'interface affiche des
libellés français. Un onglet dédié va exposer cet écart sur toute une page au lieu
d'un panneau, et le rendra donc plus visible qu'il ne l'est aujourd'hui.


## 37. Les outils d'administration dans le Spark

Un terminal dans le Spark, l'inventaire de ses conteneurs Docker avec leurs
mesures, leur inspection, et un terminal dans l'un d'eux. Arbitré par le
responsable le 2026-08-19.

### 37.1 La frontière tient, et voici pourquoi

Le produit annonce qu'**aucune socket Docker n'est exposée au plan de contrôle**
(§11) et que Docker appartient au locataire (§2). Ces outils ne l'entament pas, à
une condition qui est le cœur de leur conception : **c'est la console qui parle au
Spark, pas `sparkd`**.

L'hôte console — le processus Node du poste local (§22) — ouvre une session SSH
vers le Spark, à travers le tunnel déjà existant, avec la clé du responsable. Les
commandes `docker` s'exécutent **dans** le Spark, et leur sortie remonte au
navigateur. `sparkd` n'est pas dans ce chemin : il ne voit pas Docker, ne lui
parle pas, et n'en gagne aucun pouvoir.

Autrement dit, la console fait exactement ce que le responsable ferait avec un
terminal et sa clé. Elle lui épargne les gestes, pas les droits.

### 37.2 Le chemin normal : SSH, et ce qu'il suppose

Le transport normal est SSH vers le Spark, par rebond sur la machine hôte, comme
le manuel M6 le décrit déjà pour un humain.

Il suppose un `sshd` **dans** le Spark. L'image `images:debian/13` n'en embarque
pas (§17.1) : sur un Spark fraîchement créé où le locataire n'a rien installé,
ces outils ne fonctionnent pas. L'écran le dit en toutes lettres, avec ce qu'il
manque — il n'affiche ni onglet vide, ni erreur technique.

### 37.3 Le dépannage : `incus exec`, borné et nommé

`sparkd` sait déjà exécuter dans une instance (`exec_command`, §14). Cette
capacité n'est **pas** le chemin par défaut : elle donne au plan de contrôle
l'exécution arbitraire en root chez le locataire, ce qui est précisément ce que
le §11 évite.

Elle est ouverte au seul **dépannage**, sous quatre conditions cumulatives :

- le Spark est en `error`, ou son `sshd` ne répond pas ;
- le geste demande une confirmation qui **nomme le pouvoir employé** — « exécuter
  en root dans la cellule, depuis le plan de contrôle » — et non un vague
  « confirmer » ;
- l'entrée d'audit est **distincte** de celle d'une session SSH
  (`spark.rescue_exec`), pour qu'un relevé du journal montre combien de fois cette
  voie a servi ;
- la bannière reste visible pendant toute la session : on ne doit pas oublier par
  quel chemin on est entré.

### 37.4 Le terminal

Un pseudo-terminal, rendu dans le navigateur, servi par l'hôte console sur la
boucle locale. Contrat :

- fermer l'onglet **termine** le processus distant ; une session qui survivrait à
  son écran serait un shell root abandonné dont personne ne se souvient ;
- une inactivité prolongée ferme la session, après avertissement à l'écran ;
- le redimensionnement est propagé, sans quoi tout programme plein écran s'affiche
  de travers ;
- le mode lecteur d'écran du terminal est activable — un terminal est utilisable
  au clavier par construction, mais il n'est pas lisible par défaut.

### 37.5 Ce que le journal retient d'une session

**Décision du responsable : l'ouverture et la fermeture, rien du contenu.** Sont
journalisés l'acteur, le Spark ou le conteneur visé, le chemin employé — SSH ou
dépannage —, l'horodatage et la durée.

Motif : le filtre de caviardage du §21.2 travaille sur des champs nommés. Il ne
sait pas, et ne saura pas, caviarder un flux interactif où un mot de passe est
tapé au milieu d'une ligne de commande. Enregistrer les frappes reviendrait à
créer un dépôt de secrets en clair dans le journal — l'inverse du but.

Conséquence assumée, écrite ici pour qu'elle ne soit pas découverte après un
incident : **le journal dira qu'une session a eu lieu, jamais ce qui y a été
fait**. Qui veut cette trace-là doit la chercher dans le Spark, chez le locataire.

### 37.6 L'onglet Docker, en lecture

Il rend, en interrogeant Docker **dans** le Spark : les conteneurs et leur état,
les mesures d'usage, l'inspection d'un conteneur, ses journaux, ses réseaux et
volumes.

La collecte est faite à l'ouverture de l'onglet puis rafraîchie tant qu'il reste
ouvert, et **cesse** quand il est quitté. Une console qui interroge en permanence
un Spark qu'on ne regarde plus consomme le quota du locataire pour rien.

**Deux sources de mesure, jamais fondues dans la même jauge.** Les mesures du
Spark viennent du runtime et se comparent à ses quotas (§20). Celles des
conteneurs viennent de Docker, **à l'intérieur** de la cellule, et se comparent à
ce que la cellule voit d'elle-même. Additionner les secondes ou empiler les deux
pourcentages dans un même graphique produirait un chiffre qui ne veut rien dire.
C'est le même principe qu'au SPK-DS-02 : une mesure s'affiche avec ce à quoi elle
se rapporte.

### 37.7 Les gestes sur un conteneur, et le gel

**Décision du responsable : lecture, plus le cycle de vie d'un conteneur** —
démarrer, arrêter, redémarrer, tuer. **Pas** Compose : ni `up`, ni `down`, ni
`pull`, ni édition du fichier. Le §1 exclut du périmètre la construction et le
déploiement applicatifs, et cette limite ne bouge pas ici.

Chaque geste est **sensible** au sens du §6.23 du design system : il interrompt la
production du locataire. La confirmation nomme le conteneur et l'effet, jamais un
« êtes-vous sûr ».

**Le gel (§35) bloque ces gestes, pas la lecture** — arbitrage du responsable.
Observer un Spark protégé reste possible ; arrêter un de ses conteneurs exige de
lever le gel d'abord.

Le terminal, lui, **reste ouvert sous gel**, et c'est délibéré : c'est l'outil de
diagnostic. Le bloquer pousserait à désarmer pour regarder, donc à oublier de
réarmer — le défaut nommé au §35.4. L'écran affiche l'état protégé en permanence
pendant la session.

**Et il faut dire où cette règle est appliquée.** Les gestes Docker ne passent pas
par `sparkd` (§37.1) : le runtime ne peut donc pas les refuser. Le refus est rendu
par la **console**, à partir de l'état de protection publié par le runtime, qui
reste la source de vérité. C'est un écart assumé à la règle « une interdiction
s'applique côté serveur » — et il est cohérent avec ce que la protection est
déjà : un garde-fou, pas un contrôle d'accès (§35.1). Qui veut contourner ouvre un
terminal et tape la commande, exactement comme il l'aurait fait en SSH depuis son
poste. Le produit ne prétendra pas l'en empêcher, parce qu'il ne le peut pas là où
il a **choisi** de n'avoir aucune autorité.

### 37.8 Ce que ces outils ne sont pas

Ce n'est pas un Docker Desktop. Restent hors périmètre, et pas seulement « pas
tout de suite » : la construction d'images, les registres, le déploiement de
piles, l'édition de Compose (§1). L'outil observe la pile du locataire et permet
de reprendre un conteneur tombé ; il ne la gère pas à sa place.


## 38. Le DNS entre dans le périmètre (SPK-47)

**Décision du responsable, 2026-08-20.** Jusqu'ici le produit disait, et répétait
à l'écran : « le DNS est extérieur au produit ». C'était vrai, et c'était le
premier obstacle réel — SPK-12 reste `[~]` précisément parce qu'aucune émission
TLS n'a pu être prouvée faute de domaine qui résolve.

La console sait désormais **piloter un fournisseur DNS** : lister les zones que
le compte possède, et poser l'enregistrement qui fait résoudre un domaine vers la
Forge, pour la route d'ingress d'un Spark.

### 38.1 Qui détient le secret, et où il vit

**L'hôte console**, jamais la Forge.

Le jeton d'API du fournisseur vit dans un `.env` du **poste**, hors du dépôt et
hors du registre. C'est le même raisonnement qu'au §36.3 pour la signature : un
secret qui vit sur la Forge est lisible par qui détient `root` sur la Forge, et
le produit assume déjà (§35.1) qu'il ne protège pas de celui-là.

Conséquences, et elles ne sont pas négociables :

- `sparkd` **ne voit jamais** ce jeton, ne l'écrit jamais, ne le journalise
  jamais. Aucune colonne du registre ne le porte ;
- le jeton n'entre **pas** dans `servers.json` : le §22.4 dit que l'inventaire ne
  contient aucun secret, et cette règle ne souffre pas d'exception ;
- il est lu depuis l'environnement du processus de l'hôte console, et **rien
  d'autre**. Un jeton absent n'est pas une panne : la fonctionnalité se désactive
  et l'écran le dit.

### 38.2 Ce que le produit fait, et ce qu'il ne fait pas

**Il fait** : lire les zones du compte, lire les enregistrements d'une zone, et
créer ou mettre à jour **un** enregistrement pour un domaine d'ingress.

**Il ne fait pas**, et c'est délibéré :

- il n'**achète** aucun domaine, et ne renouvelle rien. Une opération qui engage
  de l'argent ne se déclenche pas depuis un écran d'administration ;
- il ne **transfère** aucune zone, ne change aucun serveur de noms ;
- il ne **supprime** jamais un enregistrement qu'il n'a pas posé. Une zone réelle
  porte des enregistrements de messagerie, de vérification et de service dont la
  suppression casse des choses qui n'ont rien à voir avec le produit ;
- il ne touche **aucun** enregistrement dont le nom ne correspond pas au domaine
  demandé, ni d'un autre type que celui qu'il écrit. Le rapprochement se fait sur
  le couple nom + type exacts, jamais sur un préfixe. C'est cette règle, et non
  une liste de noms interdits, qui protège les `NS`, le `MX` et les `TXT` d'une
  zone (§38.5.1).

### 38.3 Ce qu'écrit un enregistrement d'ingress

Pour un domaine `app.exemple.tech` dans la zone `exemple.tech` :

```
type = A       (AAAA si l'adresse est IPv6)
name = app     le nom RELATIF à la zone
data = <adresse publique de la Forge>
ttl  = 300
```

Le TTL est **court** : une route d'ingress se déplace quand la Forge change
d'adresse, et un TTL long ferait traîner la panne bien après la correction.

L'adresse écrite est celle de la **Forge**, pas celle du Spark : le Spark vit sur
un bridge privé (§10) et n'a pas d'adresse publique. C'est Caddy qui répartit
ensuite par nom d'hôte (§18).

### 38.4 Poser un enregistrement ne suffit pas, et l'écran le dit

Un enregistrement posé ne **résout** pas immédiatement : la propagation prend le
temps du TTL des serveurs interrogés, et un cache déjà chaud peut servir
l'ancienne réponse. L'écran annonce donc l'enregistrement **écrit**, jamais le
domaine « prêt » — et le §18.5 continue de valoir : une route enregistrée mais
non appliquée est un retard, pas une panne.

L'émission du certificat par Caddy, elle, reste subordonnée à la résolution
effective. Le produit ne la déclenche pas : il retire seulement la cause la plus
fréquente de son échec.

### 38.5 Garde d'écriture, et pourquoi elle est dans le code

Une zone DNS réelle porte des enregistrements dont la casse arrête une
messagerie, invalide une vérification de propriété, ou coupe un service. Le
produit écrit donc sous une **garde explicite** :

- il refuse d'écrire un type autre que `A` ou `AAAA` ;
- il refuse si le domaine demandé n'est pas **sous** la zone choisie, ni la zone
  elle-même.

Ces refus ne sont pas des précautions d'usage : ce sont des règles, et un test les
éprouve chacune.

#### 38.5.1 L'apex n'est plus refusé — révision du 2026-08-20

La première version de ce chapitre refusait d'écrire à l'**apex** de la zone, au
motif qu'il porte les `NS` et le `MX`. **Ce refus était trop large, et il a été
retiré.**

Il interdisait un cas parfaitement ordinaire, et nommé par le responsable : un
site web sur le domaine nu, `johndalia.com`. Un produit qui ne sait pas exposer
un site sur son propre domaine ne remplit pas son objet.

Et le motif du refus ne tenait pas à l'examen. L'écriture du §38.3 vise un nom
**et un type** exacts : à l'apex, elle ne remplace que les `A` — ou les `AAAA` —
qui s'y trouvent. Les `NS`, le `MX`, les `TXT` de vérification et de politique
sont d'autres types, et ne sont pas touchés. Ce que le refus prétendait protéger
l'était déjà par la règle du §38.2, qui est la vraie garantie.

Reste que l'apex est le nom le plus **exposé** de la zone : s'y tromper coupe le
domaine entier, et non un sous-domaine. C'est la raison d'être du §38.5.2, qui ne
lui est d'ailleurs pas propre.

#### 38.5.2 Ce qui est déjà là est montré AVANT d'être remplacé

Une écriture qui vise un nom et un type déjà pourvus **remplace** la valeur en
place. C'est le comportement voulu — reposer une route déplacée doit marcher —
mais il ne doit jamais être une surprise.

Avant d'écrire, la console **lit** l'enregistrement existant pour ce nom et ce
type exacts, et l'écran énonce alors :

- « posera », lorsque rien n'occupe le couple nom + type ;
- « **remplacera** `<valeur actuelle>` par `<nouvelle valeur>` », lorsque quelque
  chose l'occupe. La valeur actuelle est affichée, pas seulement annoncée ;
- « **aucun changement** », lorsque la valeur en place est déjà celle demandée.
  Le geste reste possible, il ne prétend simplement pas modifier quoi que ce
  soit.

Cette lecture ne remplace pas la règle du §38.2 : elle la rend **visible**. Elle
vaut pour tous les noms, l'apex compris, et c'est ce qui autorise à lever le
refus du §38.5.1 sans rien perdre.

#### 38.5.3 La borne d'espace de noms est une option du POSTE, jamais du produit

`SPARK_DNS_ALLOW_PATTERN` restreint les domaines écrivables depuis un poste
donné. Elle est **absente par défaut**, et son absence est le cas normal.

**Elle ne borne jamais la console du responsable.** Le §38.2 est explicite depuis
le début : le produit gère la zone entière, et toutes les zones du compte. Une
console qui refuserait un domaine que le jeton permet d'écrire serait un produit
diminué, pas un produit prudent.

Elle existe pour un cas précis, et un seul : **l'agent qui développe et valide en
autonomie** ne doit pas pouvoir toucher une zone en exploitation. Elle est donc
posée dans un fichier d'environnement **distinct**, réservé à ses vérifications,
que la console du responsable ne lit jamais. Le harnais E2E, lui, ne dépend même
pas de cette borne : il impose son propre fichier et un doublon local du
fournisseur (§28.1), de sorte qu'aucun parcours automatique n'atteigne un compte
réel.

Un exploitant qui voudrait la même borne sur son poste peut la poser — c'est une
option documentée —, mais rien dans le produit ne la suppose.

### 38.6 Les recettes DNS, et pourquoi une seule écriture ne suffira pas

**Décision du responsable, 2026-08-20.** Une prochaine itération fera héberger
des serveurs de messagerie — Mailcow — par des Sparks, et la console devra poser
leur DNS **d'un geste**, comme Scaleway le fait pour ses e-mails transactionnels.

Le §38.3 ne connaît qu'un enregistrement, `A` ou `AAAA`. Une messagerie en exige
un jeu **cohérent**, dont l'absence d'un seul membre suffit à faire classer tout
le courrier en indésirable :

| Enregistrement | Ce qu'il dit | D'où vient sa valeur |
|---|---|---|
| `A` / `AAAA` de `mail.<domaine>` | où est le serveur | l'adresse de la Forge |
| `MX` | à qui remettre le courrier de ce domaine | `mail.<domaine>` |
| `TXT` SPF | quelles adresses ont le droit d'émettre pour ce domaine | l'adresse de la Forge |
| `TXT` DKIM | la clé publique qui signe les messages | **le Spark**, qui la génère |
| `TXT` DMARC | quoi faire d'un message qui échoue aux deux précédents | choix de l'exploitant |
| `SRV` / `CNAME` d'autoconfiguration | comment un client mail se configure seul | conventions |

**Une recette est donc un jeu d'enregistrements écrit ENSEMBLE**, pas une suite
d'écritures indépendantes. Une recette à moitié posée est pire qu'une recette
absente : un `MX` sans SPF fait recevoir du courrier qu'on ne peut pas renvoyer.
L'écran présente donc la recette **entière** avant d'écrire, et rend compte de
chaque enregistrement individuellement après.

**La valeur DKIM ne s'invente pas.** Elle est produite par Mailcow au moment où
le domaine y est créé, et elle doit être **lue dans le Spark**. Une recette qui
inventerait cette clé produirait une signature invalide, donc exactement l'effet
qu'elle prétend éviter. Cette lecture dépend du transport vers le Spark
(SPK-43) : tant qu'il n'existe pas, la recette pose ce qu'elle connaît et
**demande la valeur DKIM à l'exploitant**, en disant où la trouver.

**La garde du §38.5 s'élargit, et sa règle centrale se durcit.** Écrire `MX`,
`TXT` et `SRV` devient nécessaire ; l'interdiction de toucher un enregistrement
que le produit n'a pas posé devient, elle, **plus** importante et non moins :
c'est précisément le genre d'enregistrement dont la disparition arrête une
messagerie sans bruit. Chaque enregistrement d'une recette continue de viser un
nom ET un type exacts.

### 38.6 bis Envoyer et recevoir sont deux produits, et le relais les réunit

**Question du responsable, 2026-08-20**, et elle est la bonne : faut-il un
serveur mail complet, ou suffit-il de relayer par le service transactionnel du
fournisseur ?

**Mesuré dans la zone `lelabs.tech`** : le service transactionnel de Scaleway y
est **déjà en service** sur le sous-domaine `noreply`, et sa signature est sans
ambiguïté :

```
noreply                          MX   0 blackhole.tem.scaleway.com.
noreply                          TXT  "v=spf1 include:_spf.tem.scaleway.com -all"
<project_id>._domainkey.noreply  TXT  "v=DKIM1; …"
_dmarc.noreply                   TXT  "v=DMARC1; p=none"
```

Le sélecteur DKIM **est** l'identifiant de projet du compte — vérifié caractère
pour caractère contre `SCW_DEFAULT_PROJECT_ID`. Et le `MX` pointe vers un
`blackhole` : il dit littéralement que ce domaine **n'accepte aucun courrier
entrant**.

**Ce que cela établit.** Le service transactionnel est un **relais sortant**. Il
n'a ni boîte aux lettres, ni IMAP, ni webmail : il ne remplace pas un serveur de
messagerie, il en prend la moitié.

| | Envoyer | Recevoir |
|---|---|---|
| Service transactionnel du fournisseur | oui, c'est son métier | **non** |
| Serveur de messagerie dans un Spark | oui | oui — boîtes, IMAP, alias |

**L'architecture retenue** — et c'est la configuration recommandée d'un serveur
de messagerie en environnement infonuagique :

- le serveur du Spark **reçoit** : le `MX` du domaine pointe vers la Forge, et le
  port 25 **entrant** est publié (§39) ;
- il n'émet pas lui-même : il **remet au relais** du fournisseur, sur un port
  chiffré, avec les identifiants du compte.

**Trois des limites du §38.7 disparaissent dans cette architecture**, et c'est la
raison de la préférer :

1. le port 25 **sortant** n'est plus employé — donc plus rien à faire débloquer ;
2. le `PTR` qui compte devient celui du relais, déjà cohérent ;
3. la réputation est celle du fournisseur, déjà établie, et non celle d'une
   adresse neuve.

**Deux points restent à vérifier auprès du fournisseur, et ils décident du
reste** — ils sont écrits ici pour ne pas être découverts à l'implémentation :

- les **quotas, la tarification et les conditions d'usage** du service
  transactionnel lorsqu'il achemine la correspondance de vraies boîtes aux
  lettres, et non des messages applicatifs. Le produit est vendu comme
  *transactionnel* ; rien ne garantit que l'usage visé entre dans son périmètre ;
- que le port 25 **entrant** soit bien ouvert sur le type de serveur retenu. Le
  blocage porte classiquement sur le sortant, mais cela se constate, cela ne se
  suppose pas.

Tant que ces deux points ne sont pas tranchés, SPK-51 ne peut pas choisir entre
« émettre par le relais » et « émettre en direct » — et c'est ce choix qui décide
si les trois limites ci-dessus tombent ou demeurent.

### 38.7 Ce que le DNS ne peut pas faire, et qu'il faut dire avant

Trois conditions d'une messagerie qui fonctionne **ne sont pas dans la zone**. Le
produit ne les posera pas, et prétendre le contraire ferait perdre des jours :

1. **Le DNS inverse (`PTR`).** Il se déclare chez le propriétaire de l'adresse
   IP — la configuration du serveur chez l'hébergeur —, pas dans la zone du
   domaine. C'est une API différente. Sans `PTR` cohérent avec le nom du
   serveur, la plupart des destinataires refusent le courrier ou le classent.
2. **Le port 25 sortant.** Il est bloqué par défaut chez la quasi-totalité des
   hébergeurs, Scaleway compris, et son déblocage demande une **requête humaine
   explicite**. Aucun enregistrement DNS n'y changera rien.
3. **La réputation de l'adresse.** Une adresse neuve est traitée avec méfiance
   pendant des semaines, quels que soient les enregistrements posés.

Une recette de messagerie affiche donc ces trois points comme des **actions
humaines restantes**, nommées, à côté de ce qu'elle a écrit. C'est la seule
façon honnête de livrer cette fonction : le produit fait la part qui lui revient
et dit précisément où s'arrête son pouvoir.

## 39. Les ports publiés : ce qui ne parle pas HTTP

**Décision du responsable, 2026-08-20**, forcée par le besoin de messagerie.

### 39.1 Deux mécanismes, et pourquoi il en faut deux

Le §18 route par **nom** : toutes les routes partagent `:80` et `:443`, et le
proxy lit dans la requête le nom demandé pour choisir le Spark. C'est ce qui
permet à des dizaines de Sparks de partager une seule adresse publique, avec un
certificat automatique par nom.

Cela suppose que le client **annonce** le nom. C'est le cas de HTTP, de HTTPS, et
donc — c'est moins évident — des WebSockets, qui commencent par une requête HTTP
avant de changer de protocole. Ollama, Vite, Keycloak, GoTrue, MinIO, les
fonctions de bord et l'ensemble des services web d'un Supabase relèvent tous du
§18 : **aucun n'a besoin d'un port publié**.

Un serveur SMTP, lui, reçoit une connexion sur le port 25 sans qu'aucun nom ne
soit prononcé. Postgres, Redis, SSH, MQTT sont dans le même cas. Le seul élément
qui permette alors de désigner le Spark destinataire est **le port sur lequel la
connexion est arrivée**.

D'où le second mécanisme : la Forge fait suivre un port public vers l'adresse
privée et le port d'un Spark.

### 39.2 Un port public est une ressource de la Forge, pas du Spark

C'est la différence qui structure tout le reste. Un nom appartient à celui qui le
possède, et deux Sparks peuvent en porter autant qu'ils veulent. Un port public
est **unique sur la machine** : le premier qui le prend le prend.

Conséquences :

- le registre tient une table des ports publiés, et l'unicité est portée par la
  **base**, comme celle du domaine au §18.4 ;
- un conflit est refusé en **nommant le Spark** qui détient déjà le port ;
- les ports réservés au système de la Forge — dont `22`, `80` et `443` — ne sont
  jamais attribuables, et le refus dit pourquoi ;
- la publication ouvre le pare-feu, et la retirer le referme. Un port ouvert vers
  un Spark arrêté est une surface offerte sans service derrière.

### 39.3 Ce qu'un port publié fait perdre, et qui doit être dit à l'écran

Le TLS automatique. Le proxy obtient et renouvelle les certificats parce qu'il
comprend le protocole ; un port transporté tel quel ne lui passe pas devant.
**L'application dans le Spark doit donc faire son propre TLS** — Postgres,
MinIO et Mailcow savent le faire, mais il faut le savoir.

L'écran propose donc le nom **d'abord**, et présente le port publié comme un
second geste qui **annonce ce qu'il coûte**. Publier un port pour une application
qui parle HTTP est presque toujours une erreur : on perd le certificat
automatique sans rien gagner. Le produit ne l'interdit pas — il le dit.

### 39.4 Le mécanisme : un device `proxy` d'Incus, pas du netfilter

**Complété le 2026-08-20, après lecture du pilote.** Le §39 disait « la
publication ouvre le pare-feu » sans dire par quoi. Deux voies existaient :

1. écrire des règles de traduction d'adresse en `nftables` depuis `sparkd` ;
2. poser un **device `proxy`** sur l'instance Incus, qui fait écouter la Forge et
   relaie vers l'adresse privée du Spark.

**La seconde est retenue**, et pour la même raison qui fonde le §2 : le plan de
contrôle pilote Incus, il ne pilote pas le système de la Forge par-dessus.
Écrire des règles de netfilter obligerait `sparkd` à un accès au filtrage réseau
qu'il n'a pas besoin d'avoir, et créerait un second endroit où l'état du réseau
peut diverger de ce que le registre dit. Incus sait déjà faire exactement cela,
et c'est lui qui défait la règle quand l'instance disparaît.

Le device porte le nom `pub-<port public>`, ce qui rend l'appartenance lisible
depuis `incus config show` sans consulter le registre.

**On régénère l'ensemble des devices d'un Spark, on ne les rapièce pas.** C'est
la règle du §18.1, pour la même raison : `PATCH` fusionne et ne sait donc pas
**retirer** un device. Un retrait rapiécé laisserait un port ouvert vers un
service qui n'est plus là — précisément la surface offerte sans service derrière
que le §39.2 interdit. La publication comme le retrait reconstruisent donc la
carte complète des devices du Spark depuis le registre.

### 39.5 Le modèle : `published_port`, et où vit l'unicité

Une table dédiée, décrite à `docs/SCHEMA.md` §6 bis. Trois points qui ne sont pas
négociables :

- `public_port` est **`UNIQUE`**. C'est la base qui refuse le doublon, jamais
  l'interface — qui ne protégerait de rien face à deux requêtes simultanées.
  C'est la règle du §18.4, transposée ;
- la suppression d'un Spark emporte ses ports publiés, comme elle emporte ses
  routes (§14.4). Un port qui survivrait à son Spark serait un port ouvert vers
  rien ;
- `applied_at` porte la date de la dernière application réussie, exactement comme
  au §18.5 : un port enregistré mais non appliqué — pilote injoignable au moment
  de la demande — se voit, au lieu de se déduire.

**Les ports réservés** sont ceux du système de la Forge. Le défaut est `22`, `80`
et `443` — respectivement la seule porte du système (§5) et les deux ports que
le proxy occupe (§18.2). La liste est **configurable** par
`SPARKD_RESERVED_PORTS`, parce qu'une Forge peut en occuper d'autres, et le refus
nomme le service qui tient le port plutôt que de dire « réservé ».

### 39.6 La surface d'API

```
GET    /v1/ports                  la liste des ports publiés de la Forge
POST   /v1/ports                  { spark, public_port, target_port }
DELETE /v1/ports/{public_port}    retire, et referme
```

`POST` rend `409` sur un port déjà pris — en **nommant** le Spark qui le
détient —, sur un port réservé, et sur un port hors bornes. Il rend `502` quand
le pilote refuse d'appliquer : la ligne reste au registre et `applied_at` reste
vide, comme au §18.5. Un Spark **protégé** (§35) refuse ces gestes avant tout le
reste.

### 39.7 Ce qui ne se prouve pas sans hôte réel

Le pilote factice permet d'éprouver **tout ce qui appartient au produit** : les
refus, l'unicité portée par la base, la reconstruction complète des devices, et
le fait qu'un retrait fasse disparaître le device.

Il ne prouve **pas** qu'une connexion entrante atteigne réellement le Spark :
cela exige une Forge réelle, avec Incus et une adresse publique. C'est la même
limite qu'au §33.3 pour le catalogue d'images et qu'à SPK-30 pour les quotas —
et elle est nommée dans l'unité plutôt que masquée par une simulation.
