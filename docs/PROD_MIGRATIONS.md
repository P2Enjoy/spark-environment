# Contrat de déploiement

Ce document décrit ce qu'un humain doit appliquer sur le serveur, dans l'ordre. Il
ne doit jamais dériver de l'état réel du projet : toute modification touchant le
schéma, le service `sparkd`, la configuration de l'hôte ou les variables
d'environnement le met à jour **dans le même changement**.

Aucune opération de ce document ne s'exécute automatiquement. Aucune migration
n'est appliquée en production sans instruction humaine explicite.

---

## 1. Baseline de production

**Aucune.** Rien n'est déployé à ce jour.

| Élément | État |
|---|---|
| Hôte cible | `51.158.54.202` — Dell R320, accès obtenu le 2026-08-18, topologie relevée |
| Système | Ubuntu 24.04.3, noyau 6.8.0-88, cgroup v2 |
| Disposition disque | 2 × 6 To en RAID1 mdadm, `md1` 5,44 Tio `ext4` sur `/` — **aucun périphérique bloc libre** |
| Incus | **7.3** installé depuis le dépôt amont Zabbly. Les dépôts Ubuntu (6.0.0) sont **inutilisables**, voir §2.0 |
| Pool de stockage | pool ZFS `spark` **sur fichier**, 200 Gio creux dans `/var/lib/incus/disks/spark.img` — provisoire, voir OP-01 |
| `zfs_arc_max` | **16 Gio**, persisté dans `/etc/modprobe.d/zfs.conf` |
| Bridge `sparkbr0` | créé, `10.77.0.1/24`, NAT actif |
| Caddy | non installé |
| `sparkd` | non déployé |
| Version de schéma | aucune |

Cette baseline décrit un hôte de **validation**, pas de production : le pool sur
fichier et l'absence de repartitionnement restent des dettes ouvertes (OP-01).

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

À exécuter après toute mise en service, et à archiver :

1. `sparkd` n'écoute que sur la boucle locale — prouvé par un scan **depuis
   l'extérieur**, pas depuis la machine.
2. L'API d'administration de Caddy n'est pas joignable depuis le réseau.
3. Un Spark de test se crée, démarre, obtient son IP privée, et son quota disque
   refuse effectivement l'écriture au-delà de la limite.
4. Le registre et l'état réel d'Incus concordent.

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
