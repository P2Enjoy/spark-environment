# Spark Environment

Découper un serveur physique en **cellules d'exécution Linux cloisonnées et
contingentées** — les *Sparks* — dont la seule raison d'être est d'héberger une
pile Docker Compose déjà industrialisée.

Un Spark, c'est un hôte Docker à soi : `0,5 CPU`, `16 Gio` de RAM, `10 Gio` de
disque, `100 Mbit/s`, une IP privée, ses clés SSH, ses domaines. Prélevés sur les
pools du serveur, comptabilisés, et rendus à la suppression.

```
                          INTERNET
                             │
                    22 / 80 / 443 seulement
                             │
        ┌────────────────────▼─────────────────────┐
        │              SERVEUR PHYSIQUE            │
        │  sshd :22        Caddy :80 :443          │
        │  127.0.0.1:9876  sparkd                  │
        │        bridge privé  sparkbr0            │
        │     ┌───────────────┼───────────────┐    │
        │  ┌────────┐    ┌────────┐    ┌────────┐  │
        │  │ SPARK  │    │ SPARK  │    │ SPARK  │  │
        │  │ dockerd│    │ dockerd│    │ dockerd│  │
        │  └────────┘    └────────┘    └────────┘  │
        └──────────────────────────────────────────┘
```

Le point de bascule : **Docker n'est plus la frontière d'isolation**. Docker
appartient au locataire ; le Spark est la frontière. C'est ce qui permet de
reprendre une pile Compose existante sans la réécrire.

Ce n'est pas un PaaS, pas un ordonnanceur de conteneurs, pas un Kubernetes de
poche. C'est un très petit plan de contrôle de VPS privé, dont l'unité n'est ni
une application ni une fonction, mais une cellule d'exécution à quota.

L'idée d'origine est conservée intégralement dans
[docs/ORIGIN_CONVERSATION.md](docs/ORIGIN_CONVERSATION.md).

## Statut

**Le plan de contrôle tourne sur une Forge réelle.** 67 unités : 51 closes, 11
partielles, 5 non commencées. L'état de chacune est dans
[docs/BACKLOG.md](docs/BACKLOG.md), qui fait foi — ce paragraphe se périme, lui.

Ce qui est **établi par la mesure**, et non par intention :

- une pile Docker Compose réelle tourne dans un Spark **non privilégié**, à plages
  UID/GID disjointes, sous AppArmor actif et **sans aucun contournement** ;
- elle est **servie publiquement en TLS** : `HTTPS 200`, certificat Let's Encrypt,
  chaîne vérifiée depuis l'extérieur, et `404` sur un domaine non routé ;
- un **port publié** de la Forge atteint réellement un Spark depuis Internet, et
  son retrait referme le port ;
- la **réservation CPU est un plancher** : `47,9 %` obtenus pour `47,4 %` prédits,
  sous contention des trois tranches. Garantie sous contention totale, dépassée
  quand la Forge est au repos ;
- un Spark **saturé reste reconfigurable**, un Spark **redimensionné** l'est à
  chaud, et un Spark dont la **cellule a disparu** se reconstruit.

Ce que la mesure a **infirmé** en chemin, et qui est corrigé dans le
[DAT](docs/DAT.md) : le paquet Docker d'une distribution est inutilisable sous
imbrication — son profil AppArmor refuse `socketpair()` —, l'image de base
n'embarque pas de `sshd`, et un conteneur n'hérite jamais de l'environnement
ambiant de sa cellule.

**Ce qui manque encore** tient en trois lignes : le plan de reprise n'est joué
qu'à moitié, l'installation n'a jamais été rejouée sur une machine neuve, et rien
n'a jamais tourné ailleurs que sur cette Forge-là. Le détail est au §13 du
[DAT](docs/DAT.md) et dans les unités `[~]`.

## Forge cible

Dell PowerEdge R320, relevé le 2026-09-01, après réinstallation complète depuis
le schéma de partitionnement JSON ci-dessous.

| Ressource | Capacité physique | Remarque |
|---|---|---|
| CPU | Xeon E5-1410 v2, **4 cœurs / 8 threads**, 1 socket, 1 nœud NUMA | SMT actif, frères `(0,4) (1,5) (2,6) (3,7)` |
| RAM | **94 Gio** (4 × 16 Gio DDR3-1600) | aucun swap actif |
| Stockage | **200 Gio** système + **5,25 Tio** de pool | 2 × 6 To Toshiba MG08 **7200 tr/min** ; `md1` RAID1 → `/`, `sda5`+`sdb5` miroir ZFS natif → pool `spark` |
| Réseau | **1 Gbit/s** (`eno1`) | `eno2` non raccordé |
| Système | Ubuntu 26.04.1, noyau 7.0, systemd 259, cgroup v2 | Incus 7.4, ZFS 2.4.1 ; VT-x présent, donc `runtime: vm` possible |

Les pools réels sont donc plus petits que ceux évoqués dans la conversation
d'origine — 94 Gio et non 256, 1 Gbit/s et non 3. Sur 4 cœurs physiques, dédier
un cœur coûte un quart de la machine : le mode partagé n'est pas seulement le
défaut, c'est le mode normal sur cette machine.

**Ce que le partitionnement à la commande a débloqué :** cette machine a
d'abord été livrée avec ses deux disques entièrement consommés par un unique
RAID1 `ext4` monté sur `/`, sans aucun périphérique bloc libre — la disposition
sur fichier était alors la seule possible. Le schéma JSON fourni à la création
réserve désormais `sda5` et `sdb5`, et la Forge tourne sur un **miroir ZFS
natif**. Le partitionnement ne se change plus après la
livraison : il se décide à la commande. Voir le §8 du [DAT](docs/DAT.md).

### Installer le plan de contrôle sans copier le dépôt

Le runtime de Forge est un paquet Python autonome : les migrations et les unités
systemd voyagent avec lui. Depuis un poste ayant l'accès SSH, sur une Forge dont
les prérequis Incus, pool, bridge et Caddy sont déjà conformes :

```bash
ssh <compte>@<forge> 'sudo apt-get update && sudo apt-get install -y --no-install-recommends git python3-venv && sudo python3 -m venv /opt/sparkd/venv'
ssh <compte>@<forge> 'sudo /opt/sparkd/venv/bin/pip install --upgrade "git+https://github.com/P2Enjoy/spark-environment.git@main#subdirectory=services/sparkd" && sudo /opt/sparkd/venv/bin/python -m sparkd.install'
```

Le second geste redémarre brièvement le plan de contrôle et ne réussit qu'après
`/healthz` et le préflight. Il ne supprime jamais `/var/lib/sparkd/spark.db`.
La procédure complète et son retour arrière sont dans le
[runbook d'agent](docs/AGENT_RUNBOOK.md#A-déployer-sparkd-sur-une-nouvelle-forge).

## Le stockage : un miroir ZFS natif, et rien d'autre

Le produit ne suppose ni le nom du pool, ni son emplacement, ni sa taille. Le pool
se crée par un geste, et **toutes** ses valeurs viennent de l'environnement :

```bash
sudo SPARK_POOL_SOURCE=/dev/sda5,/dev/sdb5 scripts/creer-pool.sh
```

| Variable | Rôle | Défaut |
|---|---|---|
| `SPARK_POOL_NAME` | nom du pool à créer | `spark` |
| `SPARK_POOL_DRIVER` | pilote Incus — `zfs`, `btrfs`, `dir` | `zfs` |
| `SPARK_POOL_SOURCE` | les **deux** supports du miroir, séparés par une virgule — obligatoire | aucun |

Le script est **idempotent** : sur un pool déjà en place, il ne touche à rien. Il
**refuse** de créer un pool sur un support qui porte déjà des données, et montre
ce qu'il y a trouvé. Il refuse aussi de créer un pool sans miroir.

Ce que le miroir natif apporte en propre : **ZFS gère lui-même la redondance**,
donc il détecte **et répare** la corruption silencieuse. Un `md` RAID1 ne le peut
pas — il ignore laquelle des deux copies est la bonne.

### Une Forge exige deux disques

Depuis le 2026-09-02, c'est une **règle d'éligibilité**, pas un manque
(`docs/DAT.md` §8.5). Une machine qui n'a ni pool ZFS existant, ni deux supports
libres sur deux disques physiques distincts, n'est pas une Forge installable.
Sont hors périmètre :

- le VPS à disque unique entièrement alloué à `/`, qui ne se repartitionne pas
  après livraison ;
- toute machine n'offrant qu'un seul support libre.

Un support est un **disque entier libre ou une partition libre** — y compris sur
un disque qui porte le système, ce qui est précisément le cas du schéma
ci-dessous. Le remède à une machine inéligible est en amont : la commander
partitionnée, ou lui ajouter un disque. Le produit promet le quota, les
instantanés **et** le miroir ; il n'offre pas de repli qui n'en tiendrait que
deux en silence.

Le pool sur fichier, décrit ici jusqu'au 2026-09-02, est retiré : il n'apportait
pas la protection contre la corruption silencieuse, n'a jamais été exécuté sur
une Forge réelle, et portait la plus grande part de la surface d'installation.
Une Forge déjà installée ainsi continue de fonctionner ; le préflight la relève
en avertissement et l'assistant n'en reproduira pas.

### Obtenir d'emblée une machine partitionnée


Chez un hébergeur qui accepte un schéma de partitionnement à la création du
serveur — Scaleway le fait —, le fournir évite tout repartitionnement ultérieur.
Ce schéma laisse **`sda5` et `sdb5` libres** pour le pool :

```json
{
  "disks": [
    {
      "device": "/dev/sda",
      "partitions": [
        { "label": "legacy", "number": 1, "size": 536870912 },
        { "label": "swap",   "number": 2, "size": 4294967296 },
        { "label": "boot",   "number": 3, "size": 536870912 },
        { "label": "root",   "number": 4, "size": 214748364800 },
        { "label": "data",   "number": 5, "size": 5766596526080 }
      ]
    },
    {
      "device": "/dev/sdb",
      "partitions": [
        { "label": "legacy", "number": 1, "size": 536870912 },
        { "label": "swap",   "number": 2, "size": 4294967296 },
        { "label": "boot",   "number": 3, "size": 536870912 },
        { "label": "root",   "number": 4, "size": 214748364800 },
        { "label": "data",   "number": 5, "size": 5766596526080 }
      ]
    }
  ],
  "raids": [
    { "name": "/dev/md0", "level": "raid_level_1",
      "devices": ["/dev/sda3", "/dev/sdb3"] },
    { "name": "/dev/md1", "level": "raid_level_1",
      "devices": ["/dev/sda4", "/dev/sdb4"] }
  ],
  "filesystems": [
    { "device": "/dev/md0", "format": "ext4", "mountpoint": "/boot" },
    { "device": "/dev/md1", "format": "ext4", "mountpoint": "/" }
  ],
  "zfs": null
}
```

C'est la forme exacte de `scaleway.baremetal.v1.Schema` : `disks`, `raids` et
`filesystems` sont des **listes**, pas des objets indexés par périphérique. Les
tailles sont en octets et **totalisent la capacité du disque** — ici
5 986 713 600 000 octets par disque. Sur des disques d'une autre taille, ajuster
la dernière partition, ou lui donner `"use_all_available_space": true` au lieu
d'une taille.

Ce qu'il produit, et pourquoi :

- les libellés viennent d'une **énumération fermée** — `uefi`, `legacy`, `root`,
  `boot`, `swap`, `data`, `home`, `raid`, `zfs`. `legacy` est la partition
  d'amorçage BIOS : cette machine n'amorce pas en UEFI, donc **pas de partition
  `uefi` ni de `/boot/efi` en fat32**. `data` ne désigne ici qu'une partition
  que rien ne réclame ;
- **`sda5` et `sdb5` n'apparaissent ni dans `raids` ni dans `filesystems`** :
  elles restent des périphériques bloc nus, ce qu'exige le miroir natif. Les
  confier à `md` reproduirait exactement le problème que le miroir ZFS résout ;
- **`"zfs": null` est délibéré.** Déclarer le pool ici le ferait créer par
  l'hébergeur à l'installation ; `creer-pool.sh` verrait alors une signature
  `zfs_member` sur les deux périphériques et **refuserait** d'écrire dessus. Le
  pool se crée après livraison, par le geste paramétré, ou pas du tout ;
- le système reste sur un RAID1 de ~200 Gio, largement suffisant : la Forge de
  validation en consomme 2,7 Gio.

Par l'API, ce bloc se place sous `install.partitioning_schema`. L'hébergeur sait
le vérifier avant toute installation, et c'est la seule réponse qui engage :

```bash
curl -i -X POST -H "X-Auth-Token: $SCW_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"offer_id":"…","os_id":"…","partitioning_schema":{…}}' \
  https://api.scaleway.com/baremetal/v1/zones/fr-par-2/partitioning-schemas/validate
```

Un `204` vaut acceptation. Le partitionnement ne se change plus après coup :
seule une réinstallation le refait.

Une fois la machine livrée, il ne reste qu'à créer le pool :

```bash
sudo SPARK_POOL_SOURCE=/dev/sda5,/dev/sdb5 scripts/creer-pool.sh
```

### Amorcer la Forge au premier démarrage, et rejouer l'amorce

Le script d'amorce est [`deploy/cloud-init/spark-amorce.sh`](deploy/cloud-init/spark-amorce.sh).
Il se fournit à l'hébergeur en `user_data` `cloud-init`, avec
[`deploy/cloud-init/user-data.yaml`](deploy/cloud-init/user-data.yaml) pour
gabarit. Il installe Incus depuis le dépôt amont Zabbly, **adopte** le pool
livré par le schéma ci-dessus sans jamais le formater, pose le paquet `sparkd`,
puis laisse l'exécuteur `sparkd.forge_install` poser Caddy, `nftables`, l'ARC, le
bridge, le durcissement SSH et les unités systemd, et finir par la recette
`préflight` / `healthz` / `readyz`.

**L'amorce est idempotente et se rejoue :**

```bash
ssh <compte>@<forge> 'sudo /opt/spark-amorce.sh'
```

Un second passage réinstalle et remet d'aplomb ce qui a dérivé, et **ne
réinitialise pas les Sparks existants** : le pool est adopté (`kind: reuse`,
jamais `destructive`), le registre `/var/lib/sparkd/spark.db` n'est jamais
touché par l'installation, et les migrations de schéma sont additives. Ce que le
rejeu refait, ce sont les paquets, les unités, la configuration du socle et la
recette finale.

Le rejeu passe par le script, **pas par `cloud-init`** : `runcmd` ne s'exécute
qu'une seule fois par instance, et `cloud-init clean` effacerait aussi l'état et
les journaux de la première installation. Le script est déposé en
`/opt/spark-amorce.sh` par `cloud-init` au premier démarrage ; il peut aussi être
copié à la main sur une Forge existante.

## Stack

| Couche | Choix | Écrit ici ? |
|---|---|---|
| Console d'administration | React + Vite + TypeScript | oui |
| Hôte local de la console | Node (tunnels SSH, proxy) | oui |
| Runtime serveur | Python 3 + FastAPI | oui |
| Registre de ressources | SQLite | oui |
| Isolation et cycle de vie | Incus **≥ 6.19** (Apache-2.0), dépôt amont obligatoire | non |
| Stockage | pool à quotas et copie sur écriture — voir DAT §8 | non |
| Ingress et TLS | Caddy | non |
| Transport d'administration | OpenSSH | non |
| Runtime applicatif | Docker + Compose, dans le Spark | non |

Ni Kubernetes, ni Nomad, ni OpenStack, ni Proxmox. Et **aucune socket Docker
exposée au plan de contrôle**.

## Structure du dépôt

```
apps/webui/          console locale : SPA React + hôte Node (tunnels SSH)
services/sparkd/     runtime serveur : FastAPI, écoute 127.0.0.1 uniquement
packages/contract/   contrat d'API partagé (OpenAPI + types générés)
deploy/              piles dev / staging / prod
scripts/             bootstrap, seed, preuves
docs/                DAT, schéma, backlog, journal, design system, manuel
```

## Prérequis

- Node ≥ 22 et pnpm ≥ 9 (console)
- Python ≥ 3.11 (runtime serveur)
- Docker et Docker Compose (pile de développement)
- côté serveur : Incus **≥ 6.19** — la version des dépôts Ubuntu (6.0.0) ne permet
  pas de faire tourner Docker dans un Spark —, un pool de stockage à quotas, Caddy.
  Voir le contrat de déploiement.

## Commandes principales

Les commandes ci-dessous seront disponibles au fur et à mesure des unités du
backlog. Elles sont documentées ici pour fixer le contrat ; celles qui n'existent
pas encore sont marquées.

| Commande | Rôle | Disponible |
|---|---|---|
| `make bootstrap` | installe les dépendances des deux livrables | **oui** |
| `make sparkd-install` | crée le venv et installe le runtime serveur | **oui** |
| `make sparkd-test` | tests unitaires du runtime serveur | **oui** |
| `make sparkd-run` | lance `sparkd` sur `127.0.0.1:9876` — migre le registre puis sert | **oui** |
| `make test` | toutes les suites de tests, contrat compris | **oui** |
| `make contract` | régénère le contrat d'API et ses types | **oui** |
| `make contract-check` | échoue si le contrat committé a dérivé du code | **oui** |
| `make gestes` | parcours navigateur des gestes d'administration | **oui** |
| `make runDev` | pile de développement : `sparkd` **factice** + console, inventaire jetable | **oui** |
| `make runProd` | **console d'exploitation seule** sur `:5175` : inventaire du poste, tunnels vers de vraies Forges. Port distinct de `runDev`, donc les deux tournent ensemble | **oui** |
| `make seed` | recrée le registre de développement et le peuple | **oui** |
| `make captures` | captures d'interface, à observer | **oui** |
| `make build` | build de tous les paquets | **oui** |
| `pnpm -r test` / `build` / `typecheck` | paquets TypeScript de l'espace de travail | **oui** |
| `pnpm dev` | hôte console sur `http://127.0.0.1:5173` — inventaire et tunnels | **oui** |

| `make e2e` / `pnpm e2e` | parcours complets contre la pile réelle | **oui** |
| `make manuel` | reproduit les illustrations du manuel | **oui** |

## Variables d'environnement

Aucune valeur réelle n'apparaît dans ce dépôt, et aucun secret n'y sera ajouté.

### `services/sparkd`

| Variable | Rôle | Format | Requis | Exemple |
|---|---|---|---|---|
| `SPARKD_BIND` | adresse d'écoute | `host:port` | non | `127.0.0.1:9876` |
| `SPARKD_DB` | fichier du registre | chemin absolu | non | `/var/lib/sparkd/spark.db` |
| `SPARKD_INCUS_SOCKET` | socket Incus | chemin absolu | non | `/var/lib/incus/unix.socket` |
| `SPARKD_CADDY_ADMIN` | API d'administration Caddy | URL | non | `http://127.0.0.1:2019` |
| `SPARKD_DRIVER` | pilote d'exécution | `incus` \| `fake` | non | `incus` |
| `SPARKD_STORAGE_POOL` | pool Incus dont la capacité fait foi | nom | non | `spark` |
| `SPARKD_STORAGE_DATASET` | jeu de données ZFS dont la compression est vérifiée | nom | non | la valeur de `SPARKD_STORAGE_POOL` |
| `SPARKD_ALLOWED_SIGNERS` | fichier `allowed_signers` d'OpenSSH — clés **publiques** autorisées à signer un geste (`docs/DAT.md` §36.10) | chemin absolu | non | vide, la vérification est désactivée |
| `SPARKD_SECRET_KEY_FILE` | clé de chiffrement des **secrets d'environnement** — 32 octets, `0600`, créée si absente et jamais remplacée (`docs/DAT.md` §43.9.2) | chemin absolu | non | `secret.key` **à côté du registre** |
| `SPARKD_NOTIFY_URL` | canal d'**alerte hors bande** : un `POST` de JSON y part sur chaque geste sensible (`docs/DAT.md` §47) | URL | non | vide, la fonction est désactivée |
| `SPARKD_FORGE_PUBLIC_ADDRESS` | adresse ou nom public de la Forge, rendu dans le briefing d'un Spark (`docs/DAT.md` §44.8) | IPv4, IPv6 ou nom sans schéma | non | vide : l'adresse est inconnue du plan de contrôle |
| `SPARKD_MEMORY_RESERVE` | mémoire soustraite du pool pour la Forge elle-même, hors ARC | octets ou suffixe | non | `2GiB` |
| `SPARKD_CPU_RESERVE` | part de processeur que la Forge garde pour lui, en cœurs | décimal ≥ 0 | non | `0.5` |
| `SPARKD_STORAGE_METADATA_MARGIN` | marge posée au-dessus de la taille vendue de chaque Spark, pour qu'un disque plein n'empêche plus sa reconfiguration | octets ou suffixe | non | `64MiB` |
| `SPARKD_LOG_LEVEL` | niveau de journalisation | `debug`…`error` | non | `info` |
| `SPARKD_RESERVED_PORTS` | ports que la Forge occupe déjà, jamais attribuables à un Spark — **en plus** de `22`, `80` et `443`, que le produit réserve toujours | entiers séparés par des virgules | non | `9100,9090` |

`SPARKD_BIND` ne peut pas être positionné sur une adresse routable : `sparkd`
**refuse de démarrer** et sort en code 2. L'absence d'API d'administration exposée
au réseau est une propriété de sécurité du produit, pas un réglage laissé à la
vigilance de l'exploitant.

### `apps/webui`

| Variable | Rôle | Format | Requis | Exemple |
|---|---|---|---|---|
| `SPARK_CONSOLE_PORT` | port local de la console | entier | non | `5173` |
| `SPARK_CONSOLE_STATE` | inventaire des serveurs | chemin | non | `~/.config/spark/servers.json` |
| `SPARK_ENV_FILE` | fichier `.env` lu par l'hôte console | chemin | non | `./.env` |
| `SCW_SECRET_KEY` | jeton du fournisseur DNS ; **son absence désactive le pilotage DNS, ce n'est pas une panne** | jeton | non | *(jamais dans le dépôt)* |
| `SCW_DEFAULT_ORGANIZATION_ID` | organisation dont les zones sont listées | UUID | non | `00000000-0000-0000-0000-000000000000` |
| `SPARK_DNS_ALLOW_PATTERN` | expression régulière bornant les domaines écrivables depuis ce poste | regex | non | `^test\.[a-z0-9-]+\.exemple\.tech$` |
| `SPARK_DNS_BASE_URL` | racine de l'API DNS, pour pointer un doublon local | URL | non | `http://127.0.0.1:8099` |
| `SPARK_SIGN_COMMAND` | remplace la **commande** de signature d'un geste, pour éprouver la chaîne sans agent (`docs/DAT.md` §36.10.9) | commande shell | non | *(vide en production)* |

La **clé de signature** d'un serveur se déclare dans l'écran *Serveurs*, champ
*Clé de signature* : un chemin vers une clé **publique**, retenu dans
`servers.json`. La console demande la signature à l'agent SSH, qui ne rend jamais
la clé privée. Vide, les gestes de ce serveur partent non signés — un état
normal, que la console dit sans le traiter comme une panne (`docs/DAT.md`
§36.10.8, §36.10.9). Côté Forge, `SPARKD_ALLOWED_SIGNERS` décide quelles clés
sont recevables.

### Restreindre la clé d'accès du responsable

Par défaut, une clé qui atteint la Forge y ouvre un shell — et qui a un shell a le
registre. Deux gestes ferment cela sans rien retirer à la console, et ils vont
**ensemble** :

```bash
# 1. Sur la Forge — sans ce réglage, tout tombe, même avec une clé sans options.
#    Dans /etc/ssh/sshd_config :  AllowTcpForwarding local
# 2. Poser la garde sur la Forge :
install -m 0755 scripts/garde-ssh.sh /usr/local/sbin/spark-garde-ssh
# 3. Produire la ligne, et remplacer celle de cette clé dans authorized_keys :
./scripts/cle-restreinte.sh ~/.ssh/id_ed25519.pub 9876
```

Ce que la clé garde : le tunnel vers `sparkd`, le rebond vers un Spark, et le
dépannage. Ce qu'elle perd : le shell interactif, la lecture des fichiers de la
Forge, et l'accès à tout autre service que `sparkd`.

**Gardez une seconde session SSH ouverte pendant l'opération** : elle est votre
retour arrière. La marche à suivre complète, avec ses six vérifications, est dans
`docs/PROD_MIGRATIONS.md` (OP-10) ; le raisonnement et les mesures sont au §46 du
`docs/DAT.md`.

Attention à un faux ami mesuré : `restrict` seul **ne ferme pas** l'exécution de
commande. Une clé « restreinte » sans `command=` lit encore tout le registre.

Le jeton DNS vit **sur le poste qui fait tourner la console**, dans un `.env`
ignoré par Git — jamais sur la Forge, où il serait lisible par qui y détient
`root`, et jamais dans `servers.json`, dont le contrat interdit tout secret.
Une variable exportée **vide** n'écrase pas le fichier : elle neutralise un
héritage.

Un jeton présent ne veut pas dire un jeton valide. Une clé **expirée** ou privée
de la permission de lire les zones fait répondre `401` au fournisseur ; la
console rend alors son message tel quel, sous le champ « Zone » de l'écran, et ne
le confond ni avec l'absence de jeton, ni avec un compte sans zone
(`docs/DAT.md` §38.1.1).

## Sécurité

- Aucune API d'administration n'est joignable depuis le réseau. Seul un porteur de
  clé SSH valide atteint `sparkd`, par tunnel.
- Les Sparks sont non privilégiés, avec des plages UID/GID disjointes.
- Un Spark n'a pas de port SSH public : l'accès se fait par rebond sur la Forge.
- Seules des clés **publiques** sont stockées.
- La clé d'accès du responsable **peut être restreinte** au strict nécessaire :
  elle n'ouvre alors plus de shell sur la Forge (voir ci-dessous).
- Un *system container* partage le noyau de la Forge. Pour des charges hostiles, la
  réponse prévue est le mode `vm`, pas un durcissement du mode `container`.

## Limites connues

- Un seul serveur. Aucun ordonnancement inter-machines.
- `runtime: vm` est porté par le modèle de données mais n'est pas implémenté.
- La réservation réseau est une grandeur de **comptabilité** : le noyau n'applique
  qu'un plafond, il n'y a pas de garantie de bande passante.
- Le relevé de topologie est explicite : la capacité n'est pas rafraîchie à
  chaque requête. L'écran de la Forge affiche la date du dernier relevé et offre
  un bouton pour le refaire.
- **Une Forge exige deux disques** (`docs/DAT.md` §8.5, arbitré le 2026-09-02).
  Le pool est un miroir ZFS natif sur deux supports portés par deux disques
  distincts, ou un pool ZFS déjà existant qu'on réutilise. Une machine à disque
  unique, ou n'offrant qu'un seul support libre, n'est pas installable — et le
  diagnostic le nomme au lieu de basculer vers un repli. La Forge de validation
  tourne sur `sda5`+`sdb5` depuis la réinstallation du 2026-08-30 : la corruption
  silencieuse y est détectée et réparée.
- La réservation CPU est un **plancher** : garantie sous contention totale,
  dépassée sinon. Mesuré sur la Forge de validation le 2026-08-21 — 47,9 %
  obtenus pour 47,4 % prédits, sous contention des trois tranches. Ce n'est pas
  une égalité : quand la Forge est au repos, un Spark obtient plus que sa
  réservation, et c'est voulu (`docs/DAT.md` §32.2).
- Les disques de la Forge sont mécaniques (7200 tr/min) : la copie sur écriture n'y
  est pas un confort mais une condition de temps de création acceptable.

## Sauvegarder le registre

Le registre `spark.db` porte toute la correspondance Spark ↔ quotas ↔ routes ↔
clés, et le journal d'audit. Les cellules, elles, vivent dans Incus : perdre le
registre ne détruit aucune donnée de locataire, mais détruit la connaissance que
le produit en a.

```bash
python3 -m sparkd.sauvegarde /var/backups/sparkd
```

N'arrête rien, écrit un fichier daté, et **vérifie ce qu'il vient d'écrire** —
structure SQLite et chaîne du journal — avant de rendre la main.

**Ne copiez pas `spark.db` à la main.** Il est en mode WAL : une copie de fichier
laisse derrière les transactions validées qui vivent encore dans le `-wal`, et la
copie s'ouvre ensuite **sans se plaindre**. Mesuré : 490 lignes sur 500.

Pour restaurer, `sparkd` doit être arrêté :

```bash
systemctl stop sparkd
python3 -m sparkd.sauvegarde --restaurer /var/backups/sparkd/spark-….db
systemctl start sparkd
```

Le registre remplacé est **déplacé**, pas écrasé. La marche à suivre complète, ce
qui est perdu et ce qu'il faut vérifier après : [docs/CONTINGENCE.md](docs/CONTINGENCE.md).

## Documentation

| Document | Contenu |
|---|---|
| [docs/DAT.md](docs/DAT.md) | architecture, modèle de ressources, sécurité |
| [docs/SCHEMA.md](docs/SCHEMA.md) | modèle de données du registre |
| [docs/BACKLOG.md](docs/BACKLOG.md) | unités de travail et état réel |
| [docs/JOURNAL.md](docs/JOURNAL.md) | décisions et investigations |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | règles d'interface |
| [docs/manuel/](docs/manuel/) | manuel utilisateur |
| [docs/MANUAL_PLAN.md](docs/MANUAL_PLAN.md) | plan du manuel utilisateur |
| [docs/PROD_MIGRATIONS.md](docs/PROD_MIGRATIONS.md) | contrat de déploiement |
| [docs/CONTINGENCE.md](docs/CONTINGENCE.md) | plans d'urgence : ce qu'on fait quand ça casse |
| [docs/ORIGIN_CONVERSATION.md](docs/ORIGIN_CONVERSATION.md) | conversation fondatrice |

## Licence

Voir [LICENSE](LICENSE).
