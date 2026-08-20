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

Depuis le poste, dépôt à jour :

```bash
COMMIT=$(git rev-parse --short=12 HEAD)
COMMIT_AT=$(git log -1 --format=%cI)

rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.venv' --exclude '.dev' \
  --exclude '.env' --exclude '.env.*' --exclude '__pycache__' \
  --exclude '.pytest_cache' --exclude '*.egg-info' \
  ./ <compte>@<forge>:/home/<compte>/spark-environment/

ssh <compte>@<forge> "sudo \
  SPARKD_BUILD_COMMIT='$COMMIT' \
  SPARKD_BUILD_AT='$COMMIT_AT' \
  SPARKD_BUILD_DIRTY=false \
  SPARKD_BUILD_FROM='$(hostname):$(pwd)' \
  bash /home/<compte>/spark-environment/scripts/install-serveur.sh"
```

En root direct, retirer `sudo`. Le script est **idempotent** : le relancer met à
jour le code et l'unité sans jamais effacer le registre.

`--exclude '.git'` n'est pas un détail : c'est pourquoi le hash est passé en
variable. Le runtime ne dérive jamais sa build d'un dépôt (`docs/DAT.md` §40.1).

### A.3 Vérifier, sans faire confiance au script

```bash
ssh <compte>@<forge> 'curl -s http://127.0.0.1:9876/healthz'
```

Attendu — le commit doit être **celui qu'on vient de déployer** :

```json
{"status":"ok","version":"0.0.0+163acf161628","build":{"commit":"163acf161628", ...}}
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

## F. Ce qu'un agent ne fait pas sans instruction explicite

- écrire un enregistrement DNS hors du motif autorisé sur le poste
  (`SPARK_DNS_ALLOW_PATTERN`) ;
- toucher aux données d'une Forge en exploitation ;
- désactiver la vérification de la clé d'hôte SSH ;
- employer `apparmor=unconfined` ou `--privileged` pour « faire passer » une
  pile : c'est troquer une protection contre un symptôme.
