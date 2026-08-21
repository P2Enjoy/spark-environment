# Contrat de déploiement

Ce document décrit ce qu'un humain doit appliquer sur le serveur, dans l'ordre. Il
ne doit jamais dériver de l'état réel du projet : toute modification touchant le
schéma, le service `sparkd`, la configuration de la Forge ou les variables
d'environnement le met à jour **dans le même changement**.

Aucune opération de ce document ne s'exécute automatiquement. Aucune migration
n'est appliquée en production sans instruction humaine explicite.

---

## 1. Baseline de production

**Établie le 2026-08-19**, et relevée par `python3 -m sparkd.preflight` sur
la Forge de validation. Les neuf contrôles du §31 du [DAT](DAT.md) sont verts.

| Élément | État |
|---|---|
| Forge cible | `51.158.54.202` — Dell R320, accès obtenu le 2026-08-18, topologie relevée |
| Système | Ubuntu 24.04.3, noyau 6.8.0-88, cgroup v2 |
| Disposition disque | 2 × 6 To en RAID1 mdadm, `md1` 5,44 Tio `ext4` sur `/` — **aucun périphérique bloc libre** |
| Incus | **7.3** installé depuis le dépôt amont Zabbly. Les dépôts Ubuntu (6.0.0) sont **inutilisables**, voir §2.0 |
| Pool de stockage | pool ZFS `spark`, **disposition sur fichier** (DAT §8.5) — 200 Gio creux dans `/var/lib/incus/disks/spark.img` |
| `zfs_arc_max` | **16 Gio**, persisté dans `/etc/modprobe.d/zfs.conf` |
| Bridge `sparkbr0` | créé, `10.77.0.1/24`, NAT actif |
| Plage DHCP de `sparkbr0` | **restreinte** à `10.77.0.240-10.77.0.254` — OP-02 appliqué |
| Caddy | **v2.11.4**, actif, API d'administration sur `127.0.0.1:2019` |
| `sparkd` | **déployé** en service systemd, activé au démarrage — OP-04 |
| Registre | `/var/lib/sparkd/spark.db`, **version de schéma 002** |
| Topologie relevée | 4 cœurs / 8 threads, 94,2 Gio, réserve 18,0 Gio (ARC 16 + marge 2), **76,2 Gio allouables** |
| Surface réseau | `22`, `80`, `443` exposés ; `9876` et `2019` sur la boucle locale |

Cette baseline décrit une Forge de **validation**, pas de production. Sa
disposition de stockage n'est plus une dette : c'est un choix, documenté au
DAT §8.5 avec ce qu'il apporte et ce qu'il ne couvre pas.

**Comment la revérifier**, en lecture seule et sans rien modifier :

```
python3 -m sparkd.preflight          # texte lisible, code de sortie 1 si bloquant
python3 -m sparkd.preflight --json   # pour archiver le relevé
```

## 2.0 Contrainte de version : Incus ≥ 6.19, depuis le dépôt amont

**Obligatoire, et non négociable.** Avec Incus 6.0.0 — la version des dépôts
Ubuntu 24.04 — aucun conteneur Docker ne démarre dans un Spark
(cf. `docs/DAT.md` §3.1). Le paquet doit venir du dépôt amont :

```
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: noble
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/zabbly.asc
```

Vérification : `incus version` doit rendre au moins `6.19`. Toute installation
depuis les dépôts Ubuntu est un échec de déploiement, pas une variante acceptable.

**Vérifié le 2026-08-18 en 7.3** : pile Compose réelle fonctionnelle dans un Spark
non privilégié, à idmap isolé, AppArmor actif, sans contournement — `HTTP 200`
depuis la Forge sur l'IP privée du Spark.

**Deux règles d'ordre, apprises dans un incident et non négociables :**

1. **Installer la version cible d'Incus AVANT de créer le moindre Spark.** La montée
   de 6.0.0 vers 7.3 sous une instance en marche l'a laissée « RUNNING » mais
   injoignable (`Failed to retrieve PID of executing child process`), ses hooks
   sortant en 127 ; `stop --force` et `delete --force` restaient bloqués et l'arrêt
   du démon s'est figé en `deactivating`. Il a fallu tuer le démon, démonter les
   résidus sous `/var/lib/incus` et réinitialiser.
2. **Un Spark garde le profil AppArmor produit à son démarrage.** Redémarrer le démon
   ne le régénère pas. Après toute montée de version, arrêter puis redémarrer chaque
   Spark, sans quoi le correctif ne s'applique pas.

Résidu à connaître : après une réinitialisation, l'interface `sparkbr0` survit dans
le noyau et empêche la recréation du réseau géré. La supprimer d'abord :
`ip link delete sparkbr0`.

## 2. Prérequis humains

L'accès SSH est obtenu : ce prérequis est levé.

La disposition du stockage est **tranchée** (SPK-28, OP-01 close) : ce prérequis
est levé lui aussi. Reste à choisir, pour une machine neuve, laquelle des deux
dispositions du DAT §8.5 elle emploiera — le README dit comment obtenir l'une ou
l'autre.

1. Confirmer que le serveur est bien dédié à cet usage et qu'aucune donnée
   existante ne doit y être préservée. La création du pool est destructive pour les
   périphériques qu'elle consomme — `scripts/creer-pool.sh` refuse d'ailleurs
   d'écrire sur un périphérique non vide, et montre ce qu'il y a trouvé.

2. Décider des domaines qui pointeront vers la machine, avant toute configuration
   de Caddy : l'émission automatique de certificats suppose des enregistrements DNS
   déjà résolus.

## 2 bis. Sauvegarder le registre

```bash
python3 -m sparkd.sauvegarde /var/backups/sparkd
```

À exécuter **avant toute migration** et avant toute opération de cette liste. Le
registre est le seul état que le produit ne sait pas reconstruire : les cellules
vivent dans Incus, la configuration dans `scripts/install-serveur.sh`, mais la
correspondance Spark ↔ quotas ↔ routes ↔ clés n'existe nulle part ailleurs.

Ne copiez pas le fichier à la main : il est en WAL, et une copie perd en silence
ce qui n'a pas encore été reversé (`docs/CONTINGENCE.md` §2.2).

## 3. Opérations en attente

### OP-01 · CLOSE le 2026-08-20 — la disposition du stockage est tranchée

```
État          : CLOSE. Arbitrage du responsable, 2026-08-20 (SPK-28).
Ce qui change : cette opération demandait de libérer une paire de partitions pour
                un pool ZFS natif, et tenait le pool sur fichier pour une dette.
                Il n'y a plus une cible et un repli : il y a DEUX dispositions,
                documentées au DAT §8.5 et au README.
Motif         : cette machine est une machine de DÉMONSTRATION. Y inscrire une
                réinstallation qu'aucun de ses usages ne réclame revenait à
                porter au contrat une dette qu'on ne comptait pas rembourser.
                Une dette qu'on ne rembourse pas n'est pas une dette.
Ce qui reste  : rien à faire sur cette Forge. Ce qui est dû est ailleurs, et est
                livré : le README porte le schéma de partitionnement à fournir à
                la création d'un serveur pour obtenir d'emblée la disposition A,
                et « scripts/creer-pool.sh » crée le pool dans l'une ou l'autre
                sans qu'aucune valeur soit codée en dur.
À SAVOIR      : sous la disposition en place, la protection contre la corruption
                silencieuse est ABSENTE — le miroir est géré par « md », qui ne
                sait pas laquelle des deux copies est la bonne. Et aucune mesure
                de débit disque conduite sur ce pool ne caractérise la machine.
```

### OP-02 · Restreindre la plage DHCP dynamique du bridge privé — **APPLIQUÉ le 2026-08-19**

> Relevé : `ipv4.dhcp.ranges = 10.77.0.240-10.77.0.254`. Contrôle `NET-DHCP`.
> Conservé ici pour mémoire ; il n'y a rien à faire.


```
Objectif      : rendre la plage DHCP disjointe de celle qu'attribue le registre,
                pour que dnsmasq ne distribue jamais une adresse déjà promise.
Dépend de     : le bridge sparkbr0 existant
Commande      : incus network set sparkbr0 ipv4.dhcp.ranges=10.77.0.240-10.77.0.254
Vérification  : une instance NON gérée par Spark obtient une adresse ≥ .240 ;
                un Spark épinglé sous .240 conserve la sienne.
Retour arrière: incus network unset sparkbr0 ipv4.dhcp.ranges
Risques       : sans cette restriction, une instance non gérée peut recevoir une
                adresse que le registre a déjà attribuée à un Spark. La collision
                se manifeste alors comme une panne réseau intermittente, très loin
                de sa cause.
```

### OP-04 · Déployer `sparkd` en service systemd

```
Objectif      : que sparkd survive a un redemarrage. Mesure le 2026-08-19 : il
                tournait depuis une session ssh. Un plan de controle lance a la
                main disparait au premier redemarrage, et les Sparks continuent
                de tourner sans que rien ne les administre : la panne est
                silencieuse et ne se decouvre qu'a la premiere operation.
Depend de     : Incus >= 6.19, pool de stockage, bridge prive
Commande      : scripts/install-serveur.sh (idempotent, en root)
Apres         : POST /v1/host/sync — un registre neuf ignore la capacite de la
                machine tant qu'elle n'a pas ete relevee.
Verification  : python3 -m sparkd.preflight  -> controle RUN-SPARKD vert, qui
                exige « active » ET « enabled » ; puis GET /readyz, qui sonde
                reellement Incus et Caddy.
Retour arriere: systemctl disable --now sparkd. Le registre est conserve dans
                /var/lib/sparkd et n'est jamais efface par le script.
Risques       : le script redemarre le service. Un sparkd lance a la main sur le
                meme port doit etre arrete avant, sinon l'unite ne peut pas se
                lier.
État          : APPLIQUÉ le 2026-08-19 sur la Forge de validation.
```

### OP-03 · Migration `002_part_arc` du registre

```
Objectif      : persister séparément le plafond de l'ARC ZFS et la marge
                d'exploitation, jusqu'ici confondus dans memory_reserve_bytes.
                La console des pools énonce la soustraction terme à terme, ce
                qui indique laquelle des deux vannes tourner.
Dépend de     : 001_socle_registre
Commande      : appliquée automatiquement au démarrage de sparkd, qui migre son
                registre lui-même (docs/SCHEMA.md §12).
Après         : POST /v1/host/sync — sans ce relevé les deux colonnes restent à
                zéro. La console affiche alors la soustraction sans ses termes,
                ce qui est exact et non trompeur.
Vérification  : GET /v1/host rend reserves.arc_bytes et reserves.margin_bytes,
                dont la somme vaut reserves.memory_bytes.
Retour arrière: fourni. ALTER TABLE host DROP COLUMN, sans perte : les colonnes
                retirées sont dérivées d'un relevé reproductible.
Risques       : aucun sur les données. Deux colonnes ajoutées à zéro ; aucune
                valeur existante n'est modifiée ni devinée.
```

### OP-05 · Migration `004_protection_spark` du registre

```
Objectif      : donner à chaque Spark un interrupteur de protection (SPK-34,
                docs/DAT.md §35). Quatre colonnes, plus deux déclencheurs qui
                portent leur invariant : les quatre NULL, ou les quatre
                renseignées. SQLite n'ajoutant pas de CHECK à une table
                existante, la contrainte ne peut PAS être une colonne.
Dépend de     : 001_socle_registre
Commande      : appliquée automatiquement au démarrage de sparkd, qui migre son
                registre lui-même (docs/SCHEMA.md §12).
Après         : rien. Aucun relevé, aucune reconfiguration.
Vérification  : GET /v1/sparks rend « protected: false » sur chaque Spark.
                Puis, sur un Spark de test : POST /v1/sparks/{nom}/protection
                rend 200, et une commande y répond ensuite 423.
Retour arrière: fourni. Les quatre colonnes et les deux déclencheurs sont
                retirés. PERTE ASSUMÉE et documentée : les protections armées
                disparaissent, et les Sparks concernés redeviennent modifiables.
                Ce n'est pas une perte de données du locataire.
Risques       : aucun sur l'existant. Les colonnes naissent NULL : AUCUNE
                protection n'est armée rétroactivement — l'inverse
                verrouillerait des Sparks dont personne ne connaîtrait le mot
                de passe.
Point d'exploitation : il n'y a AUCUNE récupération d'un mot de passe perdu par
                l'API (§35.3). Elle se fait ici, en root, par un UPDATE mettant
                les quatre colonnes à NULL sur la ligne du Spark concerné.
```

### OP-06 · Migration `005_journal_acteur` du registre

```
Objectif      : donner au journal la CLASSE de son acteur, et le verrouiller en
                écriture seule (SPK-37, docs/DAT.md §21.6). Trois déclencheurs :
                UPDATE refusé, DELETE refusé, classe hors domaine refusée.
Dépend de     : 001_socle_registre
Commande      : appliquée automatiquement au démarrage de sparkd, qui migre son
                registre lui-même (docs/SCHEMA.md §12).
Après         : rien. Aucun relevé, aucune reconfiguration.
Vérification  : GET /v1/audit rend « actor_class » sur chaque entrée, à valeurs
                dans {human, runtime}. Puis, en base : un UPDATE et un DELETE
                sur audit_log échouent tous deux.
Retour arrière: fourni. Colonne et déclencheurs retirés, sans perte : aucune
                entrée n'est supprimée.
Risques       : aucun sur l'existant. Les lignes déjà écrites reçoivent
                « runtime » : leur acteur réel n'est pas connu, et le supposer
                humain inventerait une attribution.
Point d'exploitation : À CONNAÎTRE AVANT LA PREMIÈRE MAINTENANCE. Tout script
                qui corrigeait ou purgeait audit_log échouera désormais, et
                c'est le but. La purge du §36.5 n'est pas tranchée : le jour où
                elle le sera, elle passera par une migration qui suspend le
                déclencheur, scelle le préfixe dans un point de contrôle, et le
                repose. Ne PAS supprimer les déclencheurs à la main.
```

### OP-07 · Migration `006_journal_chaine` du registre

```
Objectif      : chaîner les entrées du journal (SPK-38, docs/DAT.md §36.9).
                Deux colonnes, `entry_hash` et `prev_hash`.
Dépend de     : 005_journal_acteur
Commande      : appliquée automatiquement au démarrage de sparkd.
Après         : rien. Aucun relevé, aucune reconfiguration.
Vérification  : GET /v1/audit/verify rend « intact: true » et une tête non nulle
                dès la première écriture qui suit la migration.
Retour arrière: fourni. Colonnes retirées, sans perte d'entrée.
Risques       : aucun sur l'existant. Les lignes ANTÉRIEURES ne sont pas
                chaînées rétroactivement, et c'est délibéré : une chaîne
                recalculée ne prouverait que la capacité à calculer un sha256.
                Elles gardent la chaîne vide et la vérification les traverse
                sans les juger.
Point d'exploitation : LE JOURNAL NE SE PURGE PAS. C'est une décision, pas un
                oubli (§36.5). Une purge sans scellement casserait la chaîne de
                façon indétectable. Le jour où le volume l'imposera, elle
                passera par une migration qui scelle le préfixe supprimé dans
                une ligne de point de contrôle — jamais par une commande
                d'exploitation.
```

### OP-08 · Migration `008_ports_publies` du registre

```
Objectif      : publier un port de la Forge vers un Spark, pour ce qui ne parle
                pas HTTP — SMTP, Postgres, Redis, SSH (SPK-49,
                docs/DAT.md §39, docs/SCHEMA.md §6 bis). Une table
                `published_port`, dont le port public est UNIQUE.
Dépend de     : 007_forge
Commande      : appliquée automatiquement au démarrage de sparkd.
Après         : RIEN d'automatique. Aucun port n'est ouvert par la migration
                elle-même — la table naît vide.
Vérification  : GET /v1/ports rend une liste vide et la liste des ports
                réservés, chacun avec la raison qui le tient.
Retour arrière: fourni. La table et son index sont retirés. Les publications
                déjà faites seraient perdues ; les devices « pub-* » posés sur
                les instances, eux, SURVIVRAIENT au retour arrière. Les retirer
                avant de redescendre, sans quoi des ports resteraient ouverts
                sans rien au registre pour les décrire.
Risques       : la publication ouvre un port sur l'adresse publique de la Forge.
                Vérifier que le pare-feu de l'hébergeur laisse passer ce port,
                et que l'application dans le Spark fait SON PROPRE TLS — un port
                publié ne passe pas devant le proxy et ne reçoit donc aucun
                certificat (§39.3).
Variable      : SPARKD_RESERVED_PORTS, facultative. Liste d'entiers séparés par
                des virgules, ajoutée aux ports que le produit réserve déjà
                (22, 80, 443). À renseigner si la Forge en occupe d'autres.
```

### OP-09 · Migration `009_journal_signature` du registre

```
Objectif      : le journal porte la SIGNATURE d'un geste, les octets qu'elle
                couvre et sa version (SPK-40, docs/DAT.md §36.10,
                docs/SCHEMA.md §10 bis). Root peut alors supprimer ou tronquer,
                mais pas FABRIQUER un geste authentique.
Dépend de     : 006_journal_chaine
Commande      : appliquée automatiquement au démarrage de sparkd.
Après         : RIEN d'automatique. Les trois colonnes naissent nulles, et les
                lignes déjà écrites restent non signées — elles l'étaient.
                Les colonnes n'entrent PAS dans l'empreinte de la chaîne : la
                migration ne casse donc aucune vérification antérieure.
Vérification  : GET /v1/audit rend « signed: false » sur chaque entrée
                existante, et la vérification de chaîne reste intacte.
Retour arrière: fourni. Les trois colonnes, le déclencheur et l'index partiel
                sont retirés. Les signatures déjà inscrites seraient perdues —
                les lignes, elles, survivent.
Risques       : aucun tant que SPARKD_ALLOWED_SIGNERS n'est pas posée : sans
                fichier de signataires, la vérification se DÉSACTIVE et toute
                requête passe non signée, ce qui est le comportement voulu
                (§36.10.5). Le risque apparaît à l'inverse — poser la variable
                sur un fichier vide ou illisible ferait refuser en 422 tout
                geste porteur d'une signature.
Variable      : SPARKD_ALLOWED_SIGNERS, facultative. Chemin d'un fichier
                `allowed_signers` d'OpenSSH, ne contenant que des clés
                PUBLIQUES, chaque ligne nommant le principal sous lequel la
                console se déclare — « console/<nom-du-serveur> », l'identité
                exacte de l'en-tête x-spark-actor (§36.10.8). Un principal qui
                ne coïncide pas ferait refuser des signatures valides.
```

### OP-10 · Restreindre la clé d'accès du responsable

```
Objectif      : la clé SSH du responsable n'ouvre plus de shell sur la Forge.
                Elle garde ce dont la console a besoin — le tunnel vers sparkd,
                le rebond vers un Spark, le dépannage du §37.3 — et rien d'autre
                (SPK-61, docs/DAT.md §46).
Dépend de     : sparkd installé et son port connu.
Ordre         : les deux gestes vont ENSEMBLE. Poser la ligne sans le réglage
                serveur donne une console EN PANNE ; poser le réglage sans la
                ligne ne protège de rien.

  1. sshd_config de la Forge :

         AllowTcpForwarding local

     MESURÉ (§46.2) : à « no », TOUT tombe, y compris avec une clé sans aucune
     option, sur « administratively prohibited: open failed ». Certaines
     distributions l'ont ainsi par défaut. « local » et non « yes » : il
     autorise -L et -W, dont la console a besoin, et refuse -R.
     Puis : systemctl reload ssh

  2. La garde, posée sur la Forge :

         install -m 0755 scripts/garde-ssh.sh /usr/local/sbin/spark-garde-ssh

  3. La ligne, PRODUITE et non recopiée :

         ./scripts/cle-restreinte.sh ~/.ssh/id_ed25519.pub 9876

     Elle remplace la ligne existante de CETTE clé dans le
     ~/.ssh/authorized_keys de la Forge. Une ligne recopiée à la main est une
     ligne où l'on oublie une virgule, et une virgule oubliée y ouvre une porte
     en silence : sshd n'avertit de rien.

Après         : RIEN d'automatique. Aucun redémarrage de sparkd n'est requis.
Vérification  : GARDER UNE SECONDE SESSION OUVERTE pendant tout le geste. Puis,
                depuis une NOUVELLE connexion, les six cas mesurés au §46 :

                  doivent PASSER
                    ssh -W 127.0.0.1:<port sparkd> <forge>
                    ssh -J <forge> root@<ip privée d'un Spark> id
                    ssh <forge> incus exec <cellule> -- /bin/bash

                  doivent ÊTRE REFUSÉS
                    ssh <forge>                      (shell interactif)
                    ssh <forge> "cat /etc/hostname"  (lecture d'un fichier)
                    ssh -W 127.0.0.1:22 <forge>      (autre service)

                Et depuis la console : le tunnel s'ouvre, un terminal de Spark
                s'ouvre, le dépannage s'ouvre.
Retour arrière: immédiat et sans perte — remettre la ligne d'origine dans
                authorized_keys. C'est pourquoi la seconde session ouverte n'est
                pas une précaution facultative : elle EST le retour arrière.
Risques       : s'enfermer dehors. Une ligne mal écrite refuse la clé, et sans
                session ouverte il ne reste que la console de l'hébergeur.
                Second risque, moins visible : « restrict » SEUL ne ferme pas
                l'exécution de commande (§46.1, MESURÉ). Une ligne sans
                « command= » laisse lire tout le registre, et l'opération serait
                réputée faite sans l'être.
Concession    : « permitopen="*:22" » autorise à rebondir sur le port 22 de
                toute machine joignable depuis la Forge, pas seulement des
                Sparks. C'est le prix d'une ligne qui ne se réécrit pas à chaque
                création de Spark ; OpenSSH n'interprète aucun motif d'adresse
                (§46.5, MESURÉ).
Variable      : aucune.
```

Les opérations suivantes — installation d'Incus, création du pool, `zfs_arc_max`,
bridge privé, Caddy, `sparkd` — seront ajoutées ici à mesure que les unités SPK-03
et SPK-26 seront livrées.

Structure de chaque opération :

```
### OP-NN · Intitulé
Objectif    :
Dépend de   :
Commande    :
Vérification:
Retour arrière:
Risques     :
```

## 4. Variables et secrets à poser

Aucun secret n'est requis à ce stade. Les variables du service `sparkd` sont
documentées dans le `README.md` ; toutes ont une valeur par défaut sûre.

`SPARKD_ALLOWED_SIGNERS` (OP-09) ne porte que des clés **publiques** : ce n'est
pas un secret, et le fichier peut être versionné hors de ce dépôt. La clé privée
correspondante ne quitte jamais le poste du responsable — la console la fait
employer par l'agent SSH, elle ne la lit pas (§36.10.8).

Un réglage système est en revanche obligatoire dès la création du pool :
`zfs_arc_max` doit être posé explicitement, et sa valeur reportée dans
`host.memory_reserve_bytes`. Sans cela le registre compte comme allouable de la
mémoire que l'ARC consomme (DAT §8.5).

## 5. Vérifications post-déploiement

**Automatisées** — même série qu'avant l'installation (DAT §31.1), en lecture
seule :

```
python3 -m sparkd.preflight
```

| Code | Ce qu'il établit |
|---|---|
| `INC-VERSION` | Incus ≥ 6.19, sans quoi aucun conteneur Docker ne démarre dans un Spark |
| `STO-POOL` | pool ZFS présent ; nomme la disposition et ce qu'elle ne couvre pas |
| `STO-COMPRESSION` | compression active |
| `MEM-ARC` | plafond de l'ARC posé et ≤ 16 Gio |
| `NET-BRIDGE` | bridge privé présent |
| `NET-DHCP` | plage DHCP disjointe de celle qu'attribue le registre |
| `ING-CADDY` | Caddy administrable sur la boucle locale |
| `SEC-PORTS` | seuls `22`, `80`, `443` joignables depuis le réseau |
| `RUN-SPARKD` | unité systemd **active ET activée au démarrage** |

Puis `GET /readyz`, qui **sonde** Incus, Caddy et le registre et nomme la cause
de toute dépendance en panne.

**Restant à faire à la main**, parce que ces contrôles ne peuvent pas les rendre :

1. le scan des ports **depuis l'extérieur**, pas depuis la machine : `SEC-PORTS`
   lit ce que la Forge déclare écouter, un pare-feu amont peut différer ;
2. un Spark de test qui se crée, démarre, obtient son IP privée, et dont le quota
   disque refuse effectivement l'écriture au-delà de la limite — c'est une mesure
   de comportement, pas une condition (DAT §31.5, §13).

## 6. Retour arrière

Tant qu'aucune baseline n'existe, le retour arrière consiste à réinstaller la
machine. Cette situation cesse dès la première mise en service : à partir de là,
chaque opération porte sa propre procédure de retour arrière, ou documente
pourquoi elle n'en a pas.

## 7. Risques connus

- La création du pool est destructive pour les périphériques consommés.
- `md1` était en resynchronisation lors du relevé du 2026-08-18, pour environ
  8 heures. Aucune mesure de débit disque menée avant la fin n'a de valeur, et toute
  opération disque y est plus lente.
- La découpe d'un pool de CPU dédiés reconfigure le cpuset de **tous** les Sparks
  partagés. Le caractère non disruptif de l'opération est une hypothèse non
  vérifiée (DAT §13, point 2).
- Sans DNS résolu, Caddy échoue à émettre les certificats et la route reste
  inactive.
