# Contrat de déploiement

Ce document décrit ce qu'un humain doit appliquer sur le serveur, dans l'ordre. Il
ne doit jamais dériver de l'état réel du projet : toute modification touchant le
schéma, le service `sparkd`, la configuration de l'hôte ou les variables
d'environnement le met à jour **dans le même changement**.

Aucune opération de ce document ne s'exécute automatiquement. Aucune migration
n'est appliquée en production sans instruction humaine explicite.

---

## 1. Baseline de production

**Établie le 2026-08-19**, et relevée par `python3 -m sparkd.preflight` sur
l'hôte de validation. Les neuf contrôles du §31 du [DAT](DAT.md) sont verts.

| Élément | État |
|---|---|
| Hôte cible | `51.158.54.202` — Dell R320, accès obtenu le 2026-08-18, topologie relevée |
| Système | Ubuntu 24.04.3, noyau 6.8.0-88, cgroup v2 |
| Disposition disque | 2 × 6 To en RAID1 mdadm, `md1` 5,44 Tio `ext4` sur `/` — **aucun périphérique bloc libre** |
| Incus | **7.3** installé depuis le dépôt amont Zabbly. Les dépôts Ubuntu (6.0.0) sont **inutilisables**, voir §2.0 |
| Pool de stockage | pool ZFS `spark` **sur fichier**, 200 Gio creux dans `/var/lib/incus/disks/spark.img` — provisoire, voir OP-01 |
| `zfs_arc_max` | **16 Gio**, persisté dans `/etc/modprobe.d/zfs.conf` |
| Bridge `sparkbr0` | créé, `10.77.0.1/24`, NAT actif |
| Plage DHCP de `sparkbr0` | **restreinte** à `10.77.0.240-10.77.0.254` — OP-02 appliqué |
| Caddy | **v2.11.4**, actif, API d'administration sur `127.0.0.1:2019` |
| `sparkd` | **déployé** en service systemd, activé au démarrage — OP-04 |
| Registre | `/var/lib/sparkd/spark.db`, **version de schéma 002** |
| Topologie relevée | 4 cœurs / 8 threads, 94,2 Gio, réserve 18,0 Gio (ARC 16 + marge 2), **76,2 Gio allouables** |
| Surface réseau | `22`, `80`, `443` exposés ; `9876` et `2019` sur la boucle locale |

Cette baseline décrit un hôte de **validation**, pas de production : le pool sur
fichier et l'absence de repartitionnement restent des dettes ouvertes (OP-01).

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
depuis l'hôte sur l'IP privée du Spark.

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

1. **Trancher la disposition du stockage** (unité SPK-28). Voir OP-01 : c'est la
   seule décision qui bloque encore l'exploitation réelle.

2. Confirmer que le serveur est bien dédié à cet usage et qu'aucune donnée
   existante ne doit y être préservée. La création du pool est destructive pour les
   périphériques qu'elle consomme.

3. Décider des domaines qui pointeront vers la machine, avant toute configuration
   de Caddy : l'émission automatique de certificats suppose des enregistrements DNS
   déjà résolus.

## 3. Opérations en attente

### OP-01 · Libérer un périphérique bloc pour le pool de stockage

```
Objectif      : disposer d'une paire de partitions dédiées (~5,2 To) pour un pool
                ZFS en miroir, le système restant sur un RAID1 réduit (~200 Go).
Dépend de     : décision du responsable (SPK-28)
État          : DÉCIDÉ le 2026-08-18 — VOIE C retenue, à titre PROVISOIRE.
                Le pool natif reste la cible ; la voie C ne la remplace pas, elle
                permet de valider la chaîne sans toucher au partitionnement.
Contexte      : sda4 et sdb4 s'étendent jusqu'à la fin des disques et forment md1,
                occupé par un ext4 monté sur /. Aucun espace non alloué.

Voie A — réinstallation avec partitionnement personnalisé
  Coût        : reconfiguration complète de l'hôte
  Risque      : FAIBLE — la machine est vide (2,7 Go utilisés)
  Recommandée : oui, sur une machine vide c'est la voie la moins risquée

Voie B — réduction en mode rescue
  Étapes      : démarrer en rescue, resize2fs sur md1, mdadm --grow --size,
                repartitionner sda/sdb, créer sda5/sdb5
  Coût        : une fenêtre d'indisponibilité
  Risque      : MOYEN — destructif en cas d'erreur de calcul de taille

Voie C — pool sur fichier, provisoire            ← RETENUE le 2026-08-18
  Étapes      : laisser incus admin init créer un pool sur fichier dans l'ext4
  Coût        : nul
  Risque      : faible pour les données, mais empile deux systèmes de fichiers sur
                du disque mécanique et prive ZFS de la gestion du miroir
  Usage       : valider la chaîne de bout en bout, pas exploiter
  Conséquence : l'exploitation réelle exigera une migration vers un pool natif
                (voie A ou B). Cette dette est ouverte et reste inscrite ici
                jusqu'à sa résolution. Aucune mesure de débit disque conduite sur
                ce pool ne caractérise la machine.

Vérification  : lsblk montre une partition libre par disque, ou le pool sur
                fichier est consigné avec ses conséquences
Retour arrière: voie A et B — réinstallation ; voie C — suppression du pool
Risques       : md1 était en resynchronisation au relevé (~8 h). Toute opération
                disque menée pendant cette fenêtre est plus lente et plus risquée.
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
État          : APPLIQUÉ le 2026-08-19 sur l'hôte de validation.
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
| `STO-POOL` | pool ZFS présent ; signale s'il est sur fichier (provisoire) |
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
   lit ce que l'hôte déclare écouter, un pare-feu amont peut différer ;
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
