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
                    ├── spark_bootstrap_observation
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
| `memory_reserve_bytes` | INTEGER | RAM soustraite du pool, réservée à la Forge |
| `storage_reserve_bytes` | INTEGER | idem pour le stockage |
| `overcommit_cpu` | REAL | facteur de surengagement CPU, défaut `1.0` |
| `overcommit_memory` | REAL | défaut `1.0` |
| `overcommit_network` | REAL | défaut `1.0` |
| `topology_synced_at` | TEXT | dernier relevé de topologie |

La capacité allouable n'est jamais la capacité physique : les réserves de la Forge
sont soustraites avant l'admission control.

## 3. `cpu_core` et `cpu_thread`

Topologie relevée sur la Forge, indispensable au mode `dedicated` (§7.5 du DAT).

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
| `protected_at` | TEXT | date d'armement de la protection, NULL si désarmée — **c'est cette colonne qui fait foi** |
| `protection_hash` | TEXT | empreinte `scrypt` du mot de passe, en hexadécimal ; NULL si désarmée |
| `protection_salt` | TEXT | sel aléatoire **par Spark**, en hexadécimal ; NULL si désarmée |
| `protection_params` | TEXT | paramètres de coût `scrypt` en JSON (`n`, `r`, `p`, `dklen`) ; NULL si désarmée |

### 4.1 Les quatre colonnes de protection (`docs/DAT.md` §35, SPK-34)

Elles vont **toujours ensemble** : les quatre sont NULL, ou les quatre sont
renseignées. Un `CHECK` l'impose, parce qu'un état mi-armé serait indécidable —
une empreinte sans sel ne se vérifie pas, et un `protected_at` sans empreinte
verrouillerait un Spark que plus rien ne peut lever.

`protected_at` est la colonne qui **fait foi** : `sparkd` répond « protégé » sur
sa non-nullité, jamais sur la présence d'une empreinte.

Le mot de passe n'est **jamais** stocké en clair (§35.3). Le sel est tiré par
Spark : un sel commun rendrait deux Sparks au même mot de passe reconnaissables à
leur empreinte identique. Les paramètres de coût vivent **à côté** de l'empreinte
plutôt que dans le code, pour qu'ils puissent évoluer sans invalider l'existant —
une empreinte posée avec `n = 2^14` reste vérifiable le jour où le défaut passe à
`2^15`.

**Il n'y a aucune récupération par l'API** (§35.3). Un mot de passe perdu se lève
sur la Forge, avec `root`, par un `UPDATE` sur ces quatre colonnes. C'est cohérent
avec ce que la protection prétend être — un garde-fou, pas un chiffrement.

Aucune de ces colonnes n'est lisible par l'API : `GET /v1/sparks` publie un booléen
`protected` et la date d'armement, jamais l'empreinte, le sel ni les paramètres.

Migration `004_protection_spark`. Les quatre colonnes sont ajoutées NULL sur les
Sparks existants : **une protection n'est jamais armée rétroactivement**, sans quoi
la migration verrouillerait des Sparks dont personne ne connaîtrait le mot de
passe.

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

## 6 bis. `published_port`

Introduite par la migration `008`. Contrat au `docs/DAT.md` §39.5.

| Colonne | Type | Rôle |
|---|---|---|
| `id` | TEXT PK | identifiant |
| `public_port` | INTEGER UNIQUE | port écouté par la Forge |
| `spark_id` | TEXT FK | Spark destinataire, `ON DELETE CASCADE` |
| `target_port` | INTEGER | port sur l'IP privée du Spark |
| `protocol` | TEXT | `tcp` ou `udp` |
| `note` | TEXT | à quoi il sert, écrit par l'exploitant |
| `applied_at` | TEXT | dernière application réussie vers le pilote |
| `created_at` | TEXT | horodatage |

`public_port` est **UNIQUE** : un port public est une ressource de la MACHINE,
pas du Spark, et le premier qui le prend le prend. L'unicité vient de la base et
non de l'interface, qui ne protégerait de rien face à deux requêtes simultanées.

La cascade sur `spark_id` suit celle d'`ingress_route` (§6) : un port qui
survivrait à son Spark serait un port ouvert vers rien.

`applied_at` joue le même rôle qu'au §6 — la dérive entre le registre et le
pilote se voit, au lieu de se déduire.

Les deux ports sont bornés à `1..65535` par une contrainte `CHECK`, et le
protocole à `tcp` ou `udp`.

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

`id`, `ts`, `actor`, `actor_class`, `action`, `target_type`, `target_id`,
`payload` (JSON), `result` ∈ {`ok`, `denied`, `error`}, `message`.

`payload` est filtré avant écriture : aucune clé privée, aucun secret, aucun
en-tête d'authentification. Un refus d'admission est journalisé au même titre
qu'un succès — c'est précisément la trace qui manque toujours quand on en a
besoin.

### 9.1 `actor_class` et le verrou d'écriture (SPK-37, `docs/DAT.md` §21.6)

`actor_class` ∈ {`human`, `runtime`}, `NOT NULL`, défaut `runtime`.

Le défaut est `runtime` **délibérément** : une écriture qui oublierait de se
déclarer sera classée comme un événement de la machine, jamais comme un geste
humain. Se tromper dans ce sens fait perdre une attribution ; se tromper dans
l'autre en **fabriquerait** une, ce qui est bien pire.

`actor` reste `TEXT NOT NULL`. Sa valeur par défaut applicative devient `inconnu`
et non plus `responsable` : affirmer une identité que rien n'établit est un
mensonge, l'ignorance n'en est pas un.

**`UPDATE` et `DELETE` sont refusés par deux déclencheurs** — `audit_log_immuable_update`
et `audit_log_immuable_delete` — et non par convention de code. `INSERT` reste
libre. Le verrou protège de l'erreur, pas de `root`, qui peut supprimer les
déclencheurs : ce qui protège de `root` est l'ancre tenue ailleurs (§36.3, SPK-38).

Migration `005_journal_acteur`. Les lignes existantes reçoivent `runtime`, pour la
même raison que ci-dessus : leur acteur réel n'est pas connu, et le supposer humain
inventerait une attribution.

### 9.2 `entry_hash` et `prev_hash` (SPK-38, `docs/DAT.md` §36.9)

Deux colonnes `TEXT`, en hexadécimal minuscule, `NOT NULL` sur toute ligne écrite
après la migration `006_journal_chaine`.

- `entry_hash` : `sha256` de la sérialisation canonique de la ligne, `prev_hash`
  compris.
- `prev_hash` : l'`entry_hash` de la ligne précédente ; `GENESE` sur la première.

`id` **n'entre pas** dans l'empreinte : il est attribué par la base et un
`ROLLBACK` en consomme sans écrire. La vérification ne contrôle donc jamais la
continuité des `id` — un trou est normal, et une alerte fausse est la meilleure
façon de faire ignorer les vraies.

**Les lignes antérieures à la migration ne sont PAS chaînées rétroactivement.**
Recalculer leurs empreintes produirait une chaîne que rien n'atteste : elle
prouverait seulement que la migration sait calculer un `sha256`. La migration pose
donc une ligne de **point de contrôle** qui scelle l'état à cet instant, et la
chaîne commence là. Ce que le journal ne peut pas prouver, il ne le prétend pas.

Le défaut des deux colonnes est la chaîne vide, ce qui rend les lignes anciennes
reconnaissables : la vérification les traverse sans les juger, et le dit.

## 10. `schema_migration`

`version` (PK), `applied_at`, `checksum`. Le démarrage de `sparkd` échoue si une
migration appliquée a un checksum différent de celle présente dans le dépôt.

## 10 bis. `audit_log` : la signature d'un geste (SPK-40)

Migration `009_journal_signature.sql`.

| Colonne | Type | Contenu |
|---|---|---|
| `signature` | TEXT | la signature SSHSIG, armure comprise, ou `NULL` |
| `signed_bytes` | TEXT | les octets exacts signés (`docs/DAT.md` §36.10.3), ou `NULL` |
| `signature_version` | TEXT | la version de la forme sérialisée, ou `NULL` |

Les trois vont **ensemble ou pas du tout**, et un déclencheur l'impose. Une
signature sans ses octets ne se vérifie pas ; des octets sans signature
n'attestent rien. Une ligne qui porterait l'un sans l'autre affirmerait une
preuve qu'elle n'a pas.

Elles **n'entrent pas** dans l'empreinte de la chaîne (§9.2) : le champ retenu y
est figé, et l'y ajouter invaliderait toutes les lignes existantes. Chaîne et
signature sont indépendantes par construction — l'une couvre l'ordre et
l'intégrité, l'autre l'intention.

Une ligne produite par le **runtime** porte `NULL` aux trois (`docs/DAT.md` §36.4).

## 10 ter. `env_entry` : l'environnement d'un Spark (SPK-58)

Migration `010_environnement.sql`. Contrat complet : `docs/DAT.md` §43.9.

| Colonne | Type | Contenu |
|---|---|---|
| `id` | TEXT | clé primaire |
| `scope` | TEXT | `forge` ou `spark` |
| `spark_id` | TEXT | le Spark visé, `NULL` **si et seulement si** `scope = 'forge'` |
| `name` | TEXT | le nom de la variable, grammaire du shell `[A-Za-z_][A-Za-z0-9_]*` |
| `is_secret` | INTEGER | `0` ou `1` — **déclaré**, jamais deviné (`docs/DAT.md` §43.3) |
| `value` | TEXT | la valeur en clair, ou `NULL` si l'entrée est secrète |
| `value_enc` | TEXT | le chiffré AES-256-GCM, ou `NULL` si l'entrée ne l'est pas |
| `fingerprint` | TEXT | HMAC-SHA-256 tronqué, ou `NULL` |
| `updated_at` | TEXT | horodatage du dernier changement |

**Une table pour les deux portées.** Les deux niveaux du §43.6 partagent les
mêmes colonnes et les mêmes règles ; deux tables imposeraient d'écrire deux fois
la validation, le chiffrement et la résolution, puis de les faire diverger.

**L'unicité tient en deux index PARTIELS**, et c'est une contrainte de SQLite,
pas un choix de style : un `UNIQUE (scope, spark_id, name)` ne protégerait rien
au niveau Forge, SQLite tenant deux `NULL` pour distincts.

**Un déclencheur impose la cohérence des trois colonnes de valeur** : une entrée
secrète porte un chiffré et une empreinte et **aucune** valeur en clair ; une
entrée ordinaire l'inverse. Une ligne secrète qui porterait sa valeur en clair
serait exactement la fuite que l'unité existe pour empêcher — la base la refuse
plutôt que de compter sur le code appelant, comme au §10 bis pour la signature.

**Retour arrière** : le `down` supprime la table, donc les valeurs. Les secrets
sont perdus, et c'est irréversible même en réappliquant la migration : le
chiffré part avec la ligne.

## 10 quater. `env_selection` : ce qui descend, et où (SPK-64)

Migration `011_env_selection.sql`. Contrat : `docs/DAT.md` §43.6 révisé.

| Colonne | Type | Contenu |
|---|---|---|
| `spark_id` | TEXT | le Spark qui reçoit, `ON DELETE CASCADE` |
| `entry_id` | TEXT | l'entrée **du catalogue** cochée, `ON DELETE CASCADE` |
| `selected_at` | TEXT | horodatage de la case cochée |

Clé primaire `(spark_id, entry_id)` : cocher deux fois n'a pas de sens, et la clé
suffit à l'interdire. Le geste est donc **idempotent par construction**, ce qui
importe quand deux consoles cochent en même temps — aucune ne doit rougir pour un
état qu'elles voulaient toutes les deux.

**Pourquoi cette table existe.** Avant elle, toute entrée de portée `forge`
descendait dans **tous** les Sparks. Comme la valeur redevient en clair dans la
cellule (§43.5.1), définir un secret une fois à la Forge le déposait en clair dans
trente cellules — y compris celles qui n'en avaient aucun usage. Mesuré sur la
Forge réelle le 2026-08-21 : `SMTP_PASSWORD`, posé au niveau Forge, est arrivé
dans `/run/spark/secrets` d'un Spark qui ne l'avait jamais demandé.

**On référence l'identifiant, jamais le nom.** Renommer une entrée du catalogue
garde donc les cases cochées, et la supprimer les retire toutes par cascade —
sans quoi une case survivrait à ce qu'elle désigne.

**Un déclencheur refuse de cocher une entrée de portée `spark`.** Une entrée
propre à un Spark est déjà chez lui : la cocher n'aurait aucun sens et laisserait
croire à un second mécanisme. La contrainte porte sur une autre table, donc elle
ne peut pas s'écrire en `CHECK`.

**La migration coche l'existant.** Avant elle, chaque Spark recevait tout le
catalogue ; ne rien cocher aurait retiré, au premier geste suivant, des variables
dont des piles en marche dépendent. Le comportement observable ne change donc
**pas** au moment de la migration — ce sont les ajouts **suivants** qui cessent de
descendre tout seuls. Une correction de sécurité qui casse la production est un
mauvais échange.

**Retour arrière** : le `down` supprime la table. Les cases sont perdues, et
l'environnement effectif de chaque Spark **redevient** le catalogue entier — le
comportement d'avant SPK-64, donc le défaut qu'elle corrige. Un retour arrière
sur cette migration se décide en connaissance de cause.

## 10 quinquies. `spark_bootstrap_observation` : ce que l'amorçage a constaté (SPK-60)

Migration `012_briefing.sql`. Contrat : `docs/DAT.md` §44.3, §44.4 et §44.8.

| Colonne | Type | Contenu |
|---|---|---|
| `spark_id` | TEXT PK | Spark observé, `ON DELETE CASCADE` |
| `observed_at` | TEXT | date du relevé d'amorçage qui a produit le rapport |
| `openssh_version` | TEXT nullable | version d'`openssh-server` alors observée |
| `docker_version` | TEXT nullable | version de `docker-ce` alors observée |
| `compose_version` | TEXT nullable | version du greffon Compose alors observée |
| `docker_mode` | TEXT nullable | `enracine` ou `rootless`, si Docker est utilisable |
| `managed_items` | TEXT JSON | composants effectivement installés ou réparés par `sparkd` |

Une ligne est remplacée après chaque amorçage, parce qu'un relevé daté doit dire
ce qu'il a vu à cette date. `managed_items` conserve l'historique minimal des
composants que le plan de contrôle a posés : un composant seulement trouvé déjà
présent n'est jamais réécrit rétrospectivement comme « installé par sparkd ».
Cette donnée est informative et non une autorisation; son contenu sera de toute
façon visible dans une cellule dont le locataire est `root`.

La cascade est nécessaire : un briefing sans Spark n'a aucun sens et ne doit pas
survivre à la libération de ses ressources.

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
