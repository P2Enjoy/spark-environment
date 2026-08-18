# DAT — Dossier d'architecture technique

Projet : **Spark Environment**
Statut : socle documentaire posé, implémentation non commencée
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

Le mode `vm` n'est pas une fonctionnalité future décorative : il est la réponse
prévue au jour où des piles non maîtrisées seront hébergées, puisqu'un *system
container* partage le noyau de l'hôte. Le modèle de données porte donc le champ
`runtime` dès le premier jour, même si seul `container` est implémenté.

Les valeurs et sémantiques ci-dessus ont été relevées dans la documentation Incus
`main` le 2026-08-18 ; les vérifications restant à faire sur l'hôte cible sont
listées au §12.

## 4. Ce qui est réellement écrit ici

```
Console locale (apps/webui)         ← notre code
Runtime serveur (services/sparkd)   ← notre code
Registre de ressources (SQLite)     ← notre code
─────────────────────────────────────────────────
Incus                               ← existant
ZFS                                 ← existant
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

| Mode | Sémantique | Traduction Incus |
|---|---|---|
| `shared` | part du pool partagé, burst autorisé | `limits.cpu=<cpuset partagé>` + `limits.cpu.allowance=<n>%` + `limits.cpu.priority` |
| `capped` | pool partagé, plafond dur, pas de burst | `limits.cpu=<cpuset partagé>` + `limits.cpu.allowance=<t>ms/100ms` |
| `dedicated` | cœurs physiques exclusifs, retirés du pool partagé | `limits.cpu=<IDs, frères SMT inclus>`, pas d'`allowance` |
| `shared-pinned` | cœurs imposés mais non exclusifs (localité cache / NUMA) | `limits.cpu=<IDs>` + `allowance` |

La documentation Incus recommande de ne pas combiner épinglage et quota temporel
sans nécessité : `capped` et `shared` épinglent au **cpuset partagé complet**,
pas à un sous-ensemble.

### 7.3 L'invariant qui donne son sens à la réservation

Le mode `shared` repose sur des poids relatifs : Incus traduit un pourcentage en
poids d'ordonnancement, arbitré entre les instances qui partagent les mêmes CPU.
Un poids seul ne garantit rien dans l'absolu. Ce qui rend la réservation
*signifiante*, c'est l'admission control du registre :

```
Σ réservations(Sparks partagés) ≤ capacité(pool partagé) × facteur_surengagement
```

Tant que cet invariant tient et que le poids de chaque Spark est proportionnel à
sa réservation, un Spark obtient sous contention totale **au moins** sa
réservation. C'est le registre, et non le noyau, qui produit la garantie ; le
noyau ne fait qu'appliquer les proportions.

Conséquence directe : le surengagement devient un **réglage explicite**
(`overcommit_cpu`, par défaut `1.0`) et non un effet de bord accidentel.

Traduction du poids :

```
allowance_pct = max(1, round(réservation / capacité_pool_partagé × 100))
```

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
reconfigurés. `limits.cpu` est modifiable à chaud, ce qui rend l'opération non
disruptive — **à confirmer par mesure sur l'hôte cible** (§12).

### 7.5 SMT : un cœur dédié n'est pas un CPU logique

Si le processeur expose du SMT, attribuer le seul CPU `3` ne donne pas l'exclusivité
du cœur physique : son frère `11` reste ordonnançable par d'autres. Le mode
`dedicated` alloue donc **des cœurs physiques entiers, frères inclus** :

```
cores: 1   →   limits.cpu=3,11        (et non limits.cpu=3)
```

La topologie est lue via `incus info --resources`.

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

## 8. Ingress

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

## 9. Découpage du monorepo

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

### 9.1 Choix des langages, et leur contrepartie

| Paquet | Langage | Motif | Contrepartie assumée |
|---|---|---|---|
| `services/sparkd` | Python 3 + FastAPI | convention maison ; le travail réel est de l'orchestration de processus (`incus`), de la comptabilité SQLite et du HTTP, où Python est adapté et testable rapidement | un binaire Go serait déployable en un fichier unique ; ici le déploiement passe par un paquet et un service systemd, ce qui reste acceptable |
| `apps/webui` | TypeScript (Vite + React, hôte Node) | convention maison pour l'UI ; l'hôte local et la SPA partagent une seule chaîne d'outillage et une seule commande de lancement | deux langages dans le dépôt ; le contrat d'API les sépare proprement |

La conversation d'origine suggérait « un très petit démon Go ou Rust ». L'écart
est délibéré : `CLAUDE.md` §3 fixe Python pour les services backend, et rien dans
ce runtime n'est sensible à la latence au point de le justifier. Si une mesure
montre un jour le contraire, le contrat d'API rend le remplacement de `sparkd`
possible sans toucher à la console.

## 10. Sécurité

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

## 11. Développement local

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

## 12. Vérifications dues avant toute déclaration de conformité

Ces points sont **des hypothèses documentées, pas des faits acquis**. Chacun a
une unité de backlog et sera mesuré sur l'hôte cible :

1. Traduction exacte du pourcentage `limits.cpu.allowance` en poids
   d'ordonnancement, et vérification par une mesure de contention réelle que la
   proportion des réservations est respectée.
2. Comportement à chaud de la reconfiguration du cpuset partagé lors de la
   découpe et de la restitution d'un pool dédié.
3. Prise en charge effective du quota `size` sur le disque racine avec le pilote
   de stockage retenu (ZFS attendu).
4. Nesting Docker complet dans un conteneur non privilégié avec
   `security.idmap.isolated=true`, y compris le stockage overlay de Docker.
5. Comportement réel de `limits.max` sur le NIC en charge, et absence de garantie
   de réservation de bande passante.
6. Correspondance entre la topologie SMT rapportée par `incus info --resources`
   et celle du processeur du serveur cible.
