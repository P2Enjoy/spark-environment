# Runbook de l'agent

Procédures exécutables par un agent, écrites **depuis une exécution réelle** du
2026-08-20 sur la Forge `spark-experiment` (`51.158.54.202`), et non de mémoire.

Chaque commande de ce document a été jouée. Ce qui n'a pas été éprouvé est dit
tel quel, à l'endroit où on le lit.

Vocabulaire : `docs/DESIGN_SYSTEM_APP.md` §2. Une **Forge** est la machine qui
porte `sparkd` ; un **Spark** est une cellule d'exécution de cette Forge.

---

## A. Déployer `sparkd` sur une nouvelle Forge

**Entrée** : un accès SSH root sans mot de passe — `ssh root@<hôte>` — ou un
compte à `sudo` sans mot de passe.

**Sortie** : `sparkd` actif, estampillé, et 10 contrôles de préflight verts.

### A.1 Ce que la machine doit avoir AVANT

Ces trois points ne s'improvisent pas et bloquent tout le reste (`docs/DAT.md`
§3.1, §8, `docs/PROD_MIGRATIONS.md` §2.0) :

| Prérequis | Pourquoi | Vérification |
|---|---|---|
| **Incus ≥ 6.19**, dépôt amont Zabbly | avec 6.0.0 (dépôts Ubuntu) **aucun** conteneur Docker ne démarre dans un Spark | `incus version` |
| **pool de stockage à quotas** nommé `spark` | le quota disque du produit **est** le quota du jeu de données | `incus storage list` |
| **bridge privé** `sparkbr0` en `10.77.0.1/24` | l'adressage du registre en dépend | `incus network list` |

Ordre non négociable : **installer Incus à sa version cible avant de créer le
moindre Spark.** Une montée de version sous une instance en marche l'a déjà
laissée « RUNNING » mais injoignable, `stop --force` compris.

### A.2 Déploiement

Depuis le poste, **sans copier le dépôt** :

```bash
ssh <compte>@<forge> 'sudo apt-get update && sudo apt-get install -y --no-install-recommends git python3-venv && sudo python3 -m venv /opt/sparkd/venv'
ssh <compte>@<forge> 'sudo /opt/sparkd/venv/bin/pip install --upgrade "git+https://github.com/P2Enjoy/spark-environment.git@main#subdirectory=services/sparkd" && sudo /opt/sparkd/venv/bin/python -m sparkd.install'
```

En root direct, retirer `sudo`. La première ligne est nécessaire même sur une
Ubuntu neuve : Python peut y être présent sans `ensurepip`, donc sans `venv`.
La seconde ligne est **idempotente** : elle
réinstalle le paquet, ses dépendances et ses unités sans jamais effacer le
registre. `sparkd.install` part du paquet qui vient d'être posé — migrations SQL
et unités systemd incluses — et la version issue de ses métadonnées porte le
commit sans aucune variable à transmettre (`docs/DAT.md` §40.4).

### A.3 Vérifier, sans faire confiance au script

```bash
ssh <compte>@<forge> 'curl -s http://127.0.0.1:9876/healthz'
```

Attendu — le commit doit être **celui qu'on vient de déployer** :

```json
{"status":"ok","version":"0.post1.dev…+g163acf161628…","build":{"commit":"163acf161628", ...}}
```

`0.0.0+inconnue` signifie que l'estampille n'a pas été écrite : réinstaller.
Le préflight se rejoue seul, en lecture seule :

```bash
ssh <compte>@<forge> 'sudo /opt/sparkd/venv/bin/python -m sparkd.preflight'
```

Les 10 contrôles doivent être verts. `SEC-PORTS` doit ne rapporter que **22, 80,
443**.

### A.4 Inscrire la Forge au catalogue du poste

Le catalogue vit dans `~/.config/spark/servers.json` et ne contient **aucun
secret** (`docs/DAT.md` §22.4). Deux formes :

```json
{"name":"demo","kind":"ssh","host":"51.158.54.202","user":"ubuntu","remotePort":9876}
{"name":"demo","kind":"alias","sshHost":"ma-forge","remotePort":9876}
```

La seconde délègue à `~/.ssh/config` — rebond, clé dédiée, algorithmes imposés
(§22.4 bis). Depuis la console : `POST /api/servers`, ou l'écran des serveurs.

---

## B. Créer un Spark sur une Forge existante

`sparkd` n'écoute que sur `127.0.0.1` et **refuse** de démarrer sur une adresse
routable. Tout passe donc par un tunnel :

```bash
ssh -N -L 19876:127.0.0.1:9876 <compte>@<forge> &
```

### B.1 L'image vient du catalogue, pas de la mémoire

```bash
curl -s -X POST http://127.0.0.1:19876/v1/images/verify   # relevé daté
curl -s http://127.0.0.1:19876/v1/images                  # états
```

Une référence absente du catalogue est refusée **avant** écriture au registre
(`docs/DAT.md` §33.2). Sur une Forge fraîche, les images sont `unknown` tant que
le relevé n'a pas été fait : c'est voulu, pas une panne.

### B.2 Créer, appliquer, démarrer

Trois gestes distincts, et c'est délibéré : le registre s'écrit **avant** Incus
(§14.2).

```bash
curl -s -X POST http://127.0.0.1:19876/v1/sparks \
  -H 'content-type: application/json' -d '{
    "name":"demo-app","image":"images:debian/13","cpu_mode":"shared",
    "cpu_reservation":0.5,"memory_bytes":2147483648,
    "network_bps":100000000,"storage_bytes":10737418240}'

curl -s -X POST http://127.0.0.1:19876/v1/sparks/demo-app/apply
curl -s -X POST http://127.0.0.1:19876/v1/sparks/demo-app/start
```

`0.5 CPU`, `100 Mbit/s`, `10 Gio` s'écrivent respectivement `cpu_reservation`,
`network_bps` en bits par seconde, `storage_bytes` en octets. Un refus
d'admission rend `409` et **chiffre ce qui manque**, ressource par ressource.

### B.3 Donner les clés

```bash
curl -s -X POST http://127.0.0.1:19876/v1/ssh-keys \
  -H 'content-type: application/json' \
  -d '{"label":"responsable","public_key":"ssh-ed25519 AAAA…"}'
curl -s -X POST http://127.0.0.1:19876/v1/sparks/demo-app/ssh-keys/responsable
```

Seules des clés **publiques** entrent au registre. `authorized_keys` est réécrit
en entier à chaque changement, jamais complété (§17.1).

---

## C. Se connecter à un Spark en marche

### C.1 Le chemin normal

```bash
curl -s http://127.0.0.1:19876/v1/sparks/demo-app/ssh-config
ssh -J <compte>@<forge> root@10.77.0.x
```

Le Spark n'a **aucun port SSH public** : on passe par rebond sur la Forge.

### C.2 Le piège, mesuré : l'image de base n'a pas de `sshd`

`images:debian/13` n'embarque ni `cloud-init` ni `sshd` (§17.1). `sparkd` a bien
écrit `authorized_keys`, mais **rien n'écoute**. Amorcer par le plan de contrôle,
une fois :

```bash
ssh <compte>@<forge> 'sudo incus exec demo-app -- bash -lc "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq openssh-server ca-certificates curl
  systemctl enable --now ssh"'
```

C'est le chemin de **dépannage** du §37.3, employé ici pour l'amorçage. Ensuite,
tout passe par SSH.

### C.3 Installer le runtime Docker — **depuis le dépôt amont, jamais celui de la distribution**

**Mesuré le 2026-08-20, et c'est un blocage total, pas une préférence.** Avec
`docker.io` 26.1.5 de Debian 13, `nginx` démarre puis meurt :

```
[alert] socketpair() failed while spawning "worker process" (13: Permission denied)
```

Le noyau dit exactement pourquoi :

```
apparmor="DENIED" operation="create" class="net" profile="docker-default"
  family="unix" sock_type="stream" requested="create" denied="create"
```

Le profil `docker-default` que génère cette version **précède la médiation des
sockets unix d'AppArmor 4**. `seccomp=unconfined` n'y change rien ;
`apparmor=unconfined` « répare » en désactivant une protection pour **tous** les
conteneurs du locataire — ce n'est pas une solution, c'est un renoncement.

Docker CE **29.7.2** du dépôt amont fonctionne sans aucun contournement :

```bash
ssh -J <compte>@<forge> root@10.77.0.x 'set -e
  export DEBIAN_FRONTEND=noninteractive
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  dpkg --configure -a
  systemctl enable --now docker'
```

C'est la même leçon que pour Incus (`SPK-31`) : sur ce terrain, le paquet de la
distribution est trop ancien pour l'imbrication.

Vérifier, sans se contenter du code de retour :

```bash
docker --version && docker compose version
docker info --format '{{.Driver}} · cgroup {{.CgroupVersion}} · {{.SecurityOptions}}'
```

Attendu : `overlay2 · cgroup 2 · [name=apparmor name=seccomp,profile=builtin name=cgroupns]`.
AppArmor et seccomp doivent rester **actifs**.

Note d'exploitation : sur un Spark à 2 Gio, `dpkg` a échoué une fois en
« Broken pipe » sur le dépaquetage de `docker-buildx-plugin`.
`dpkg --configure -a` a suffi, et `dpkg --audit` doit finir vide.

### C.4 Une sortie vide de `docker` a trois causes : lire le CODE DE SORTIE

Mesuré le 2026-08-20. `docker ps` rend une sortie **vide dans deux cas sur
trois**, et ces deux-là n'appellent pas le même geste :

| Code | Ce que ça veut dire | Ce qu'il faut faire |
|---|---|---|
| `127` | `docker` introuvable — la cellule n'est pas amorcée | **amorcer** |
| `1` | la commande existe, le démon ne répond pas | **redémarrer le démon** |
| `0`, zéro ligne | tout va bien, rien ne tourne | **ne rien faire** |

Les deux premiers se ressemblent à l'œil — « Docker ne marche pas ». Les
confondre envoie **réinstaller ce qui est déjà là**, ce qui redémarre le démon du
locataire et interrompt sa production pour rien.

C'est la règle du §14.6 du design system — ne pas confondre zéro, en cours et
indisponible — appliquée non plus à l'affichage mais à la **détection**. Une
absence a des causes ; les fondre coûte un geste faux.

Le contrat complet, côté produit, est au §37.6 bis du [DAT](DAT.md).

---

## D. Déployer une application dans un Spark

Structure attendue côté dépôt applicatif : des fichiers Compose par
environnement (`compose.yaml`, surcharges `dev`/`prod`).

```bash
rsync -az --exclude '.git' --exclude 'node_modules' \
  -e "ssh -J <compte>@<forge>" ../mon-app/ root@10.77.0.x:/srv/mon-app/
ssh -J <compte>@<forge> root@10.77.0.x \
  'cd /srv/mon-app && docker compose -f compose.yaml up -d'
```

Le port publié dans le Spark (`8080` ci-dessous) reste **privé** : rien ne
l'atteint depuis Internet tant qu'une route d'ingress ne le désigne pas.

---

## E. Exposer publiquement : DNS puis ingress

**L'ordre compte.** Le certificat ne peut pas être émis avant que le nom
résolve.

```bash
# 1. DNS — depuis la console (le jeton vit sur le POSTE, jamais sur la Forge)
#    Écran DNS, ou POST /api/dns/record : <nom> → adresse publique de la Forge

# 2. Route d'ingress
curl -s -X POST http://127.0.0.1:19876/v1/ingress \
  -H 'content-type: application/json' \
  -d '{"spark":"demo-app","domain":"app.exemple.tld","port":8080,"tls":true}'
```

Vérifier **depuis l'extérieur**, pas depuis la Forge :

```bash
curl -sS -o /dev/null -w '%{http_code} verify=%{ssl_verify_result}\n' https://app.exemple.tld/
echo | openssl s_client -connect app.exemple.tld:443 -servername app.exemple.tld 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Attendu : `200 verify=0`, émetteur Let's Encrypt. Un domaine **non routé** doit
rendre `404` — pas `200` avec un corps vide.

---

## F. Éprouver sans faire tomber la machine

**Chiffre qui rend cette section non négociable : la VM de développement dispose
de 7,5 Gio**, et non de la mémoire de la machine hôte. Relevé le 2026-08-20,
`MemTotal: 7714436 kB`.

Une campagne monte **une** pile complète — un `sparkd` Python, un hôte console
Node, un Chromium — et la démonte à la fin. Mesuré : `e2e/parcours.test.mjs`
appelle `monterPile()` **une seule fois**, dans son `before`, pour ses 52 tests,
et son `after` la démonte. `--test-concurrency=1` est posé dans la cible : rien
n'est concurrent **à l'intérieur** d'une campagne.

**Ce qui tue la machine, c'est donc leur nombre, pas leur contenu.** Trois
sessions qui lancent chacune leur campagne font trois piles et trois Chromium
simultanés ; `make captures` et `make manuel` en ajoutent chacun un. Sur 7,5 Gio
c'est confortable **seul**, et intenable à plusieurs. Constaté quatre fois le
2026-08-20, dont deux terminaisons en **code 137** — un `SIGKILL`, signature du
tueur de mémoire — et un redémarrage de l'hôte.

*Rédaction corrigée le 2026-08-20 : la première version affirmait cinquante piles
par campagne. C'était faux, mesuré par une session voisine, et une règle fondée
sur un motif inexact se contourne dès qu'on découvre l'inexactitude.*

### F.1 Éprouver UN parcours

```bash
node --test --test-concurrency=1 \
  --test-name-pattern="<nom exact du test>" e2e/parcours.test.mjs
```

Mesuré sur le parcours `REFUS 1` : **vert en 2,489 s**, contre plusieurs minutes
pour la campagne entière — qui monte la même pile unique, mais joue les 52
parcours.

C'est l'outil de la vérification ciblée — celle qu'on fait vingt fois par heure
en corrigeant un défaut.

### F.2 Ce que la campagne complète reste, et quand la lancer

Elle **garde sa place dans la Definition of Done** : elle est la preuve de
non-régression de l'**ensemble**, et rien d'autre ne la remplace. Ce qu'elle
n'est pas, c'est l'outil d'une vérification ciblée.

**Arbitrage du responsable, 2026-08-20 :** les vérifications ciblées sont
autorisées en **multi-session** ; la campagne complète se lance **par lots et en
session seule**. Avant de lancer `make e2e`, `make captures` ou `make manuel` sur
un hôte partagé, **annoncer et attendre** que les autres sessions aient confirmé
qu'elles ne lancent rien. Deux campagnes simultanées produisent en outre des rouges
**erratiques** : des délais réglés pour une machine au repos sont dépassés sous
charge, et le rouge se déplace d'un test à l'autre. Un défaut de la mesure coûte
plus cher qu'un défaut du produit, parce qu'on le cherche dans le produit.

Ne jamais lancer une campagne **en arrière-plan** : quand la machine tombe, on ne
sait plus ce qui tournait.

### F.4 Vert seul, rouge en campagne : deux causes qui se ressemblent

Le symptôme est identique et les causes n'ont rien à voir. Les confondre fait
chercher au mauvais endroit, parfois longtemps.

| Cause | Signe qui la distingue | Ce qu'il faut faire |
|---|---|---|
| **contention** de la machine | le rouge **se déplace** d'un parcours à l'autre selon la charge ; rejoué seul, il redevient vert | relancer seul, et suivre le §F.2 |
| **état partagé** entre parcours | le rouge est **toujours le même**, et le parcours suppose un état qu'un parcours antérieur a déjà consommé — un Spark vierge devenu amorcé, par exemple | corriger le parcours, pas la machine |

Constaté le 2026-08-20 par une session voisine : deux parcours supposaient un
Spark vierge et tournaient sur un Spark déjà amorcé par un parcours précédent.
Rien à voir avec la mémoire.

Le réflexe « c'est la contention » est confortable parce qu'il n'accuse pas le
code. Le distinguer coûte une seule question : **le rouge est-il le même à chaque
fois ?** S'il l'est, ce n'est pas la charge.

### F.3 Une seule pile de développement à la fois

Même famille de fuite, moins visible donc plus facile à oublier : une pile lancée
pour une vérification visuelle et jamais arrêtée continue de consommer. Deux
piles oubliées ont participé aux chutes du 2026-08-20.

```bash
# ce qui écoute encore, avant d'en lancer une de plus
ss -ltn | grep -E ':5173|:9876'
```

Une pile se lance pour une vérification et **s'arrête quand elle est finie**. Sur
un hôte partagé, la console du responsable est la seule qui a vocation à rester
ouverte.

---

## G. Ce qu'un agent ne fait pas sans instruction explicite

- écrire un enregistrement DNS hors du motif autorisé sur le poste
  (`SPARK_DNS_ALLOW_PATTERN`) ;
- toucher aux données d'une Forge en exploitation ;
- désactiver la vérification de la clé d'hôte SSH ;
- employer `apparmor=unconfined` ou `--privileged` pour « faire passer » une
  pile : c'est troquer une protection contre un symptôme.
