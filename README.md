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

**Socle documentaire posé, implémentation non commencée.** L'architecture, le
modèle de données et le backlog font foi ; aucune fonctionnalité n'est encore
livrée. L'état réel de chaque unité est dans [docs/BACKLOG.md](docs/BACKLOG.md).

Six hypothèses techniques restent **non vérifiées** faute d'accès à l'hôte cible ;
elles sont listées au §12 du [DAT](docs/DAT.md) et ne doivent pas être tenues pour
acquises.

## Stack

| Couche | Choix | Écrit ici ? |
|---|---|---|
| Console d'administration | React + Vite + TypeScript | oui |
| Hôte local de la console | Node (tunnels SSH, proxy) | oui |
| Runtime serveur | Python 3 + FastAPI | oui |
| Registre de ressources | SQLite | oui |
| Isolation et cycle de vie | Incus (Apache-2.0) | non |
| Stockage | ZFS | non |
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
- côté serveur : Incus, ZFS, Caddy — voir le contrat de déploiement

## Commandes principales

Les commandes ci-dessous seront disponibles au fur et à mesure des unités du
backlog. Elles sont documentées ici pour fixer le contrat ; celles qui n'existent
pas encore sont marquées.

| Commande | Rôle | Disponible |
|---|---|---|
| `pnpm install` | dépendances de la console | non |
| `pnpm dev` | console locale sur `http://127.0.0.1:5173` | non |
| `pnpm build` | build de production de la console | non |
| `pnpm test` | tests unitaires de la console | non |
| `pnpm e2e` | tests Playwright | non |
| `make runDev` | pile de développement autonome | non |
| `make seed` | données de démonstration reproductibles | non |
| `make test` | tests du runtime serveur | non |

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
| `SPARKD_LOG_LEVEL` | niveau de journalisation | `debug`…`error` | non | `info` |

`SPARKD_BIND` ne doit jamais être positionné sur une adresse routable : l'absence
d'API d'administration exposée au réseau est une propriété de sécurité du produit,
pas un réglage.

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
- L'accès au serveur cible est actuellement bloqué (clé publique non autorisée), ce
  qui suspend toute vérification sur matériel réel.

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
| [docs/INCONSISTENCY_REPORT.md](docs/INCONSISTENCY_REPORT.md) | contradictions relevées, non résolues |

## Licence

Voir [LICENSE](LICENSE).
