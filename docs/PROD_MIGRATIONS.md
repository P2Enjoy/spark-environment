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
| Hôte cible | `51.158.54.202`, accès non encore obtenu |
| Incus | non installé |
| Pool ZFS | non créé |
| Bridge `sparkbr0` | non créé |
| Caddy | non installé |
| `sparkd` | non déployé |
| Version de schéma | aucune |

## 2. Prérequis humains

1. **Autoriser la clé publique du poste d'administration** sur le compte `ubuntu`
   du serveur. Sans cela, rien de ce document ne peut être exécuté.

   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fSF4BkFEV5LL5Sl2XoT contact@p2enjoy.studio
   ```

2. Confirmer que le serveur est bien dédié à cet usage et qu'aucune donnée
   existante ne doit y être préservée. La création d'un pool ZFS est destructive
   pour les périphériques qu'elle consomme.

3. Décider des domaines qui pointeront vers la machine, avant toute configuration
   de Caddy : l'émission automatique de certificats suppose des enregistrements DNS
   déjà résolus.

## 3. Opérations en attente

Aucune opération technique n'est encore prête. Elles seront ajoutées ici, dans
l'ordre et avec leurs dépendances, à mesure que les unités SPK-03, SPK-04 et
SPK-26 seront livrées.

Structure prévue pour chaque opération :

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

- La création du pool ZFS est destructive pour les périphériques consommés.
- La découpe d'un pool de CPU dédiés reconfigure le cpuset de **tous** les Sparks
  partagés. Le caractère non disruptif de l'opération est une hypothèse non
  vérifiée (DAT §12, point 2).
- Sans DNS résolu, Caddy échoue à émettre les certificats et la route reste
  inactive.
