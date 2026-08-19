# SCHEMA — Modèle de données du registre

Base : SQLite, fichier `/var/lib/sparkd/spark.db` sur le serveur, accessible par
le seul utilisateur système `sparkd`.

Le registre est la **source de vérité de l'allocation**. Incus et Caddy en sont
des projections, reconstructibles. L'inverse n'est jamais vrai : on ne déduit pas
une allocation en interrogeant Incus.

Toute évolution passe par une migration versionnée dans
`services/sparkd/src/sparkd/schema/`, appliquée dans l'ordre, jamais à la main.

---

## 1. Vue d'ensemble

```
      host (1 ligne)
        │
        ├── cpu_core ─────── cpu_thread
        │
        └── spark ──┬── spark_cpu_pin
                    ├── ingress_route
                    ├── spark_ssh_key ──── ssh_key
                    ├── snapshot
                    └── backup

      audit_log        (transversal)
      schema_migration (technique)
```

## 2. `host`

Capacité physique et politique d'allocation du serveur. Une seule ligne,
contrainte par `CHECK (id = 1)`.

| Colonne | Type | Rôle |
|---|---|---|
| `id` | INTEGER PK | toujours `1` |
| `hostname` | TEXT | nom de la machine |
| `cpu_threads_total` | INTEGER | CPU logiques rapportés par `incus info --resources` |
| `cpu_cores_total` | INTEGER | cœurs physiques |
| `memory_total_bytes` | INTEGER | RAM physique |
| `storage_total_bytes` | INTEGER | capacité du pool de stockage Incus |
| `network_total_bps` | INTEGER | débit nominal du lien, en bit/s |
| `memory_reserve_bytes` | INTEGER | RAM soustraite du pool, réservée à l'hôte |
| `storage_reserve_bytes` | INTEGER | idem pour le stockage |
| `overcommit_cpu` | REAL | facteur de surengagement CPU, défaut `1.0` |
| `overcommit_memory` | REAL | défaut `1.0` |
| `overcommit_network` | REAL | défaut `1.0` |
| `topology_synced_at` | TEXT | dernier relevé de topologie |

La capacité allouable n'est jamais la capacité physique : les réserves de l'hôte
sont soustraites avant l'admission control.

## 3. `cpu_core` et `cpu_thread`

Topologie relevée sur l'hôte, indispensable au mode `dedicated` (§7.5 du DAT).

`cpu_core` : `id`, `socket_id`, `numa_node`, `core_id`, `pool` ∈ {`shared`,
`dedicated`}, `spark_id` (NULL si partagé).

`cpu_thread` : `cpu_id` (identifiant logique tel qu'utilisé par `limits.cpu`),
`core_id` → `cpu_core.id`.

L'appartenance à un pool se décide **au niveau du cœur physique**, jamais du
thread : c'est ce qui garantit qu'un cœur dédié l'est réellement, frères SMT
compris.

## 4. `spark`

| Colonne | Type | Contrainte / valeurs |
|---|---|---|
| `id` | TEXT PK | ULID |
| `name` | TEXT UNIQUE | `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` |
| `state` | TEXT | `pending`, `creating`, `stopped`, `starting`, `running`, `stopping`, `error`, `deleting` |
| `runtime` | TEXT | `container` (implémenté), `vm` (réservé) |
| `image` | TEXT | ex. `images:debian/13` |
| `cpu_mode` | TEXT | `shared`, `capped`, `dedicated`, `shared-pinned` |
| `cpu_reservation` | REAL | en CPU ; requis si `shared` ou `shared-pinned` |
| `cpu_max` | REAL | en CPU ; requis si `capped` |
| `cpu_cores` | INTEGER | cœurs physiques ; requis si `dedicated` ou `shared-pinned` |
| `cpu_priority` | INTEGER | 0–10, défaut 5 |
| `memory_reservation_bytes` | INTEGER | |
| `memory_enforce` | TEXT | `hard` \| `soft` |
| `memory_swap` | INTEGER | booléen |
| `network_reservation_bps` | INTEGER | comptabilité seule |
| `network_burst_bps` | INTEGER | seule valeur réellement appliquée au NIC |
| `storage_bytes` | INTEGER | quota du disque racine |
| `storage_io_priority` | INTEGER | 0–10, défaut 5 |
| `ipv4_address` | TEXT UNIQUE | adresse stable sur le bridge privé |
| `incus_name` | TEXT UNIQUE | nom de l'instance Incus |
| `docker_enabled` | INTEGER | installation de Docker + Compose à la création |
| `created_at`, `updated_at` | TEXT | ISO 8601 UTC |
| `last_error` | TEXT | dernière erreur de transition, NULL si aucune |

Cohérence des modes, appliquée par `CHECK` **et** revalidée en Python :

```
shared         → cpu_reservation NOT NULL, cpu_max NULL,     cpu_cores NULL
capped         → cpu_max NOT NULL,         cpu_reservation NULL, cpu_cores NULL
dedicated      → cpu_cores NOT NULL,       cpu_reservation NULL, cpu_max NULL
shared-pinned  → cpu_cores NOT NULL,       cpu_reservation NOT NULL
```

`state` est piloté par `sparkd` seul. La console ne l'écrit jamais : elle le lit.

## 5. `spark_cpu_pin`

Allocation effective des cœurs dédiés : `spark_id`, `core_id`, PK composite.
Un cœur ne peut appartenir qu'à un seul Spark, contrainte d'unicité sur `core_id`.

## 6. `ingress_route`

| Colonne | Type | Rôle |
|---|---|---|
| `id` | TEXT PK | ULID |
| `domain` | TEXT UNIQUE | nom d'hôte public |
| `spark_id` | TEXT FK | Spark cible |
| `target_port` | INTEGER | port sur l'IP privée du Spark |
| `tls` | INTEGER | émission automatique du certificat |
| `enabled` | INTEGER | route active |
| `applied_at` | TEXT | dernière application réussie vers Caddy |

L'unicité du domaine est portée par la base, pas par l'interface. `applied_at`
rend visible toute dérive entre le registre et Caddy.

## 7. `ssh_key` et `spark_ssh_key`

`ssh_key` : `id`, `label` unique, `public_key`, `fingerprint` unique, `created_at`.

**Seules des clés publiques sont stockées.** Aucune clé privée n'entre ni dans la
base, ni dans le dépôt, ni dans un journal.

`spark_ssh_key` : association `spark_id` × `ssh_key_id`, PK composite. Elle décrit
l'état *voulu* ; l'application effective dans le Spark est décrite au §17 du
`docs/DAT.md`.

## 8. `snapshot` et `backup`

`snapshot` : `id`, `spark_id`, `incus_name`, `created_at`, `size_bytes`,
`stateful`.

`backup` : `id`, `spark_id`, `path`, `created_at`, `size_bytes`, `checksum`.

Un snapshot vit dans le pool de stockage et ne protège pas de sa perte. Un backup
est une archive exportée, éventuellement hors machine. Les deux notions restent
distinctes dans le modèle comme dans l'interface.

## 9. `audit_log`

`id`, `ts`, `actor`, `action`, `target_type`, `target_id`, `payload` (JSON),
`result` ∈ {`ok`, `denied`, `error`}, `message`.

`payload` est filtré avant écriture : aucune clé privée, aucun secret, aucun
en-tête d'authentification. Un refus d'admission est journalisé au même titre
qu'un succès — c'est précisément la trace qui manque toujours quand on en a
besoin.

## 10. `schema_migration`

`version` (PK), `applied_at`, `checksum`. Le démarrage de `sparkd` échoue si une
migration appliquée a un checksum différent de celle présente dans le dépôt.

## 11. Retour arrière

Chaque migration fournit son `down`. Lorsqu'un retour arrière est impossible sans
perte, la migration le documente explicitement dans son en-tête et le contrat de
déploiement `docs/PROD_MIGRATIONS.md` le signale.

## 11 bis. `host` : les deux termes de la réserve mémoire

`memory_reserve_bytes` porte la **somme** de ce qui est soustrait à `MemTotal`.
La migration `002_part_arc` ajoute les deux termes séparément :

| Colonne | Sens |
|---|---|
| `memory_arc_bytes` | plafond de l'ARC ZFS relevé sur le module (`docs/DAT.md` §16.2) |
| `memory_margin_bytes` | marge d'exploitation configurée (`SPARKD_MEMORY_RESERVE`) |

Motif : la somme seule ne dit pas **laquelle des deux vannes tourner**. Un
exploitant qui lit « 76,2 Gio allouables » sur une machine de 94 Gio doit pouvoir
choisir entre abaisser `zfs_arc_max` et abaisser `SPARKD_MEMORY_RESERVE`.

Les deux colonnes valent `0` par défaut : une base existante conserve sa réserve
totale, et le prochain relevé de topologie renseigne le détail. Aucune donnée
n'est perdue et aucune valeur n'est devinée.

## 12. Mécanique des migrations

Le §11 dit que chaque migration fournit son `down` ; le §10 dit que le démarrage
échoue sur un checksum divergent. Cette section fixe le reste, qui était
implicite et que le code ne peut pas inventer.

### 12.1 Fichiers

```
services/sparkd/src/sparkd/schema/NNN_intitule.sql
```

Les fichiers vivent **à l'intérieur du paquet**, et non à côté. Placés hors du
paquet, ils ne suivent pas l'installation : `sparkd` démarre alors sans aucune
migration, et chaque requête échoue ensuite sans que rien ne désigne la cause.
Un dossier de migrations absent est donc une erreur d'installation, signalée
comme telle au démarrage — jamais interprétée comme « aucune migration ».

`NNN` est la version, entière, sur trois chiffres, à partir de `001`. L'ordre
d'application est l'ordre numérique. Une version ne se réutilise ni ne se
renumérote : elle est citée par `schema_migration` dans les bases déjà migrées.

Un fichier porte les deux sens, séparés par des marqueurs sur une ligne :

```sql
-- @up
CREATE TABLE ...;

-- @down
DROP TABLE ...;
```

`-- @up` est obligatoire. `-- @down` l'est aussi ; lorsqu'un retour arrière est
impossible sans perte, la section existe quand même et contient uniquement :

```sql
-- @down
-- IRREVERSIBLE: <raison>
```

Le moteur refuse alors le retour arrière au lieu de l'exécuter à moitié, et
`docs/PROD_MIGRATIONS.md` le signale.

### 12.2 Checksum

`sha256` du contenu intégral du fichier, en hexadécimal. Il couvre les deux
sections : modifier un `down` déjà appliqué est une dérive au même titre que
modifier un `up`.

### 12.3 Application

Une migration s'applique dans **une seule transaction**, qui contient à la fois
ses instructions et l'insertion de sa ligne dans `schema_migration`. Une
migration interrompue ne laisse donc jamais un schéma à moitié migré sans trace :
soit la transaction passe entière, soit rien.

### 12.4 Vérification au démarrage

Avant de servir, `sparkd` compare les migrations enregistrées aux fichiers du
dépôt et **refuse de démarrer** si :

- une migration enregistrée n'a plus de fichier — la base a été migrée par un
  autre code que celui-ci ;
- un checksum diverge — le fichier a été modifié après application ;
- une migration non appliquée précède une migration appliquée — un trou dans la
  séquence signale des historiques divergents fusionnés.

Ces trois refus disent la même chose : le schéma réel n'est plus celui que le
code croit. Continuer produirait des erreurs plus loin, plus difficiles à
rattacher à leur cause.

### 12.5 Pragmas de connexion

Toute connexion pose, dans cet ordre :

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

`foreign_keys` mérite d'être appelé par son nom : **SQLite ne l'active pas par
défaut**, et le fait par connexion, pas par base. Un modèle aussi riche en clés
étrangères que celui-ci les verrait silencieusement ignorées — un `spark_id`
pointant vers rien s'insérerait sans un mot. C'est la valeur par défaut la plus
coûteuse de SQLite, et la seule ligne de cette liste qui change la correction et
non la performance.
