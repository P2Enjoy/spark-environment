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

**Faisabilité prouvée sur matériel réel, plan de contrôle non commencé.**
L'architecture, le modèle de données et le backlog font foi. L'état réel de chaque
unité est dans [docs/BACKLOG.md](docs/BACKLOG.md).

Ce qui est **établi par la mesure** sur l'hôte, le 2026-08-18 : une pile Docker
Compose réelle tourne dans un Spark **non privilégié**, à plages UID/GID disjointes,
sous AppArmor actif et sans aucun contournement, et répond en `HTTP 200` à l'hôte sur
son IP privée. Le quota disque, le plafond réseau, les limites mémoire et la
reconfiguration du cpuset à chaud sont vérifiés de la même façon.

Ce que la mesure a **infirmé**, et qui est corrigé dans le [DAT](docs/DAT.md) : la
sémantique de la réservation CPU. Le poids d'un Spark est arbitré contre les tranches
de l'hôte et pas seulement contre les autres Sparks, donc la réservation est pour
l'instant proportionnelle et non absolue. C'est la principale dette ouverte
([SPK-29](docs/BACKLOG.md)), et la console ne doit pas présenter la réservation comme
une garantie tant qu'elle n'est pas levée.

Le détail des vérifications, confirmées comme infirmées, est au §13 du
[DAT](docs/DAT.md).

## Hôte cible

Dell PowerEdge R320, relevé le 2026-08-18.

| Ressource | Capacité physique | Remarque |
|---|---|---|
| CPU | Xeon E5-1410 v2, **4 cœurs / 8 threads**, 1 socket, 1 nœud NUMA | SMT actif, frères `(0,4) (1,5) (2,6) (3,7)` |
| RAM | **94 Gio** (4 × 16 Gio DDR3-1600) | aucun swap actif |
| Stockage | **5,4 Tio** utiles | 2 × 6 To Toshiba MG08 **7200 tr/min**, RAID1 mdadm |
| Réseau | **1 Gbit/s** (`eno1`) | `eno2` non raccordé |
| Système | Ubuntu 24.04.3, noyau 6.8, cgroup v2 | VT-x présent, donc `runtime: vm` possible |

Les pools réels sont donc plus petits que ceux évoqués dans la conversation
d'origine — 94 Gio et non 256, 1 Gbit/s et non 3. Sur 4 cœurs physiques, dédier
un cœur coûte un quart de la machine : le mode partagé n'est pas seulement le
défaut, c'est le mode normal sur cette machine.

**Contrainte structurante :** les deux disques sont entièrement consommés par un
unique RAID1 `ext4` monté sur `/`. Il n'existe aucun périphérique bloc libre pour
un pool de stockage natif. Voir le §8 du [DAT](docs/DAT.md).

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
| `make runDev` | pile de développement : `sparkd` factice + console | **oui** |
| `make seed` | recrée le registre de développement et le peuple | **oui** |
| `make captures` | captures d'interface, à observer | **oui** |
| `make build` | build de tous les paquets | **oui** |
| `pnpm -r test` / `build` / `typecheck` | paquets TypeScript de l'espace de travail | **oui** |
| `pnpm dev` | hôte console sur `http://127.0.0.1:5173` — inventaire et tunnels | **oui** |

| `make e2e` / `pnpm e2e` | parcours complets contre la pile réelle | **oui** |

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
| `SPARKD_MEMORY_RESERVE` | mémoire soustraite du pool pour l'hôte lui-même, hors ARC | octets ou suffixe | non | `2GiB` |
| `SPARKD_LOG_LEVEL` | niveau de journalisation | `debug`…`error` | non | `info` |

`SPARKD_BIND` ne peut pas être positionné sur une adresse routable : `sparkd`
**refuse de démarrer** et sort en code 2. L'absence d'API d'administration exposée
au réseau est une propriété de sécurité du produit, pas un réglage laissé à la
vigilance de l'exploitant.

### `apps/webui`

| Variable | Rôle | Format | Requis | Exemple |
|---|---|---|---|---|
| `SPARK_CONSOLE_PORT` | port local de la console | entier | non | `5173` |
| `SPARK_CONSOLE_STATE` | inventaire des serveurs | chemin | non | `~/.config/spark/servers.json` |

## Sécurité

- Aucune API d'administration n'est joignable depuis le réseau. Seul un porteur de
  clé SSH valide atteint `sparkd`, par tunnel.
- Les Sparks sont non privilégiés, avec des plages UID/GID disjointes.
- Un Spark n'a pas de port SSH public : l'accès se fait par rebond sur l'hôte.
- Seules des clés **publiques** sont stockées.
- Un *system container* partage le noyau de l'hôte. Pour des charges hostiles, la
  réponse prévue est le mode `vm`, pas un durcissement du mode `container`.

## Limites connues

- Un seul serveur. Aucun ordonnancement inter-machines.
- `runtime: vm` est porté par le modèle de données mais n'est pas implémenté.
- La réservation réseau est une grandeur de **comptabilité** : le noyau n'applique
  qu'un plafond, il n'y a pas de garantie de bande passante.
- Le relevé de topologie est explicite : la capacité n'est pas rafraîchie à
  chaque requête. L'écran de l'hôte affiche la date du dernier relevé et offre
  un bouton pour le refaire.
- L'hôte cible n'a aucun périphérique bloc libre : le pool de stockage est
  actuellement **sur fichier**, à titre provisoire, et l'exploitation réelle suppose
  un repartitionnement (DAT §8, SPK-28).
- La réservation CPU n'est proportionnelle qu'entre Sparks, pas absolue, tant que
  SPK-29 n'est pas livrée.
- Les disques de l'hôte sont mécaniques (7200 tr/min) : la copie sur écriture n'y
  est pas un confort mais une condition de temps de création acceptable.

## Documentation

| Document | Contenu |
|---|---|
| [docs/DAT.md](docs/DAT.md) | architecture, modèle de ressources, sécurité |
| [docs/SCHEMA.md](docs/SCHEMA.md) | modèle de données du registre |
| [docs/BACKLOG.md](docs/BACKLOG.md) | unités de travail et état réel |
| [docs/JOURNAL.md](docs/JOURNAL.md) | décisions et investigations |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | règles d'interface |
| [docs/MANUAL_PLAN.md](docs/MANUAL_PLAN.md) | plan du manuel utilisateur |
| [docs/PROD_MIGRATIONS.md](docs/PROD_MIGRATIONS.md) | contrat de déploiement |
| [docs/ORIGIN_CONVERSATION.md](docs/ORIGIN_CONVERSATION.md) | conversation fondatrice |

## Licence

Voir [LICENSE](LICENSE).
