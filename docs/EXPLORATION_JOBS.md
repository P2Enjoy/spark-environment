# Exploration — les jobs d'un Spark : exposer ou non la mécanique de planification

**Statut : exploratoire. Non planifié.** Cadrage avec le responsable du 2026-11-18.

Ce document n'est ni une spécification, ni un contrat. Il conserve une piste étudiée et les
arbitrages qui l'ont façonnée, pour que la réflexion ne soit pas à refaire le jour où le
sujet devient une unité. **Rien ici n'est implémenté, rien n'est mesuré, et aucun code du
dépôt n'y renvoie.**

Il ne figure donc ni dans `docs/DAT.md`, qui décrit l'architecture réelle, ni dans
`docs/SCHEMA.md`, ni dans `docs/BACKLOG.md`, sauf comme renvoi depuis la section *Réservé*.
**Aucun identifiant SPK n'est réservé** : une unité future prendra des identifiants neufs.

Ce document distingue ce que le responsable a **arbitré** (§3) de ce qui est une **idée**
du rédacteur, à discuter (§5 à §8). Ne pas lire une idée comme une décision.

---

## 1. La demande

Le responsable, le 2026-11-18 : ajouter des **jobs** — « en gros, on contrôle le cron de la
cellule » — et, « comme les autres », créer un fichier `cron.?` avec lequel les agents
peuvent **suggérer une ligne d'exécution cron**. Et il précise ne pas avoir réfléchi ni
arrêté comment mettre en place cette fonctionnalité : il veut **en débattre** avant de dire
qu'on la fait.

## 2. Ce qui existe aujourd'hui

Relevé dans le dépôt le 2026-11-18, pas déduit : **aucun code, aucun document, aucun chapitre
du manuel ne traite de cron, de jobs ni de tâches planifiées d'un Spark.** Le produit ne
planifie rien dans une cellule et ne dit rien aux agents sur la manière de le faire.

Ce que la console offre autour, et qui servirait de socle :

- l'**onglet Docker** (SPK-44) : inventaire, mesures et inspection des conteneurs d'un Spark ;
- les **gestes sur un conteneur** et le terminal dans un conteneur (SPK-45) ;
- **recréer** un conteneur de pile Compose pour qu'il relise son environnement (SPK-132) ;
- le **fichier `.?`** (DAT §55, SPK-105) : six paires fichier réel / proposition, dont
  `routes` et `env`, que la cellule remplit pour *proposer* et que le propriétaire accepte ou
  écarte à l'écran.

## 3. Les arbitrages du responsable (2026-11-18)

1. **L'étude est consignée, non planifiée.** On ne la décide pas maintenant.
2. **Aujourd'hui, les jobs se planifient avec la pile Docker Compose, projet par projet.**
   C'est le mode de fonctionnement actuel, et il continue.
3. **Il n'est pas décidé que le produit doive exposer la mécanique.** Le responsable ne sait
   pas encore si c'est utile.

## 4. Le statu quo est une option à part entière

Avant de comparer des conceptions, il faut poser que **ne rien exposer** est une réponse
légitime, pas une absence de réponse.

**Ce que le statu quo donne :**

- la planification **voyage avec le projet** : elle est dans son `compose.yml`, versionnée
  avec le code qu'elle exécute, et se rejoue à l'identique ailleurs ;
- **aucune dépendance à l'image du Spark** : pas de question de savoir si `cron` est
  installé, quelle famille le sert, quel compte l'exécute — c'est un conteneur, il embarque
  ce dont il a besoin ;
- **aucune surface de plus** dans le produit : pas d'ordonnanceur à maintenir, pas de nouveau
  fichier proposé, pas de commande de plus à confirmer ;
- le produit n'est **pas dans le chemin critique** : un job tourne même si la Forge est
  inatteignable.

**Ce qu'il coûte :**

- **invisible pour la console** : aucune liste de ce qui est planifié, aucune « dernière
  exécution », aucune notification quand un job échoue en silence ;
- **chaque projet réinvente** son ordonnanceur et sa manière de journaliser ;
- un agent qui voit qu'il lui faudrait une tâche périodique **n'a pas de voie pour la
  proposer** au propriétaire, contrairement aux variables ou aux routes ;
- **rien ne distingue** un job volontaire d'un conteneur oublié.

**La question de fond n'est donc pas « comment ? » mais « a-t-on assez souffert du coût ? »**
— un job qui a échoué sans que personne le sache, un agent qui a dû décrire une tâche en
prose, un parc de projets qui ne se ressemblent plus. Si ces douleurs ne sont pas réelles,
l'étude s'arrête ici.

## 5. Une échelle d'exposition (idée du rédacteur)

Exposer n'est pas binaire. Du moins au plus, chaque barreau garde le précédent et ajoute un
coût :

| Barreau | Ce que le produit fait | Ce que cela ajoute | Ce que cela coûte |
|---|---|---|---|
| **0. Rien** | rien | — | — |
| **1. Dire** | une convention écrite pour les agents (le dossier, `INSTALL.md`, le brief du Spark) : « planifiez dans la pile Compose, voici comment » | les agents font pareil d'un projet à l'autre | un texte à maintenir ; aucun code |
| **2. Montrer** | la console **lit** : l'onglet Docker repère les conteneurs d'ordonnancement (par convention d'étiquette Compose ou de nom) et affiche leur état et leur dernière sortie | la visibilité, sans rien contrôler | une convention à tenir ; une lecture de plus par visite |
| **3. Proposer** | un fichier `.?` — `cron.?` ou, plus proche de ce qui existe, une **proposition de service Compose** — que le propriétaire accepte | les agents peuvent suggérer | une septième paire au DAT §55 ; une grammaire |
| **4. Contrôler** | le produit pose, active, suspend, retire et lance les jobs | le contrôle et l'historique | un ordonnanceur ; des questions d'image, de compte, de fuseau |

Le débat du 2026-11-18 est parti du barreau 4 (« on contrôle le cron de la cellule »). **Le
statu quo du responsable est entre 0 et 1**, et il se peut que le bon point soit 2 : voir
sans toucher.

Une remarque qui change la forme du barreau 3 : puisque les jobs se planifient aujourd'hui
**dans la pile Compose**, une proposition d'agent n'a peut-être pas à être une *ligne cron*.
Elle pourrait être un **fragment de pile** (un service d'ordonnancement et sa commande). La
grammaire d'une ligne cron n'est pas un acquis si le moteur n'est pas cron.

## 6. Si l'on contrôle (barreau 4) : les choix qui en découlent

Idées discutées le 2026-11-18, **rien n'est mesuré**.

### 6.1 Où tourne l'ordonnanceur

- **A. Dans la cellule** : la Forge génère le fichier de planification depuis le registre, et
  le cron de la cellule exécute. Les jobs survivent à une panne de `sparkd` — même principe
  que Caddy, qui sert les routes sans lui. Contre : il faut un moteur présent dans l'image,
  et l'historique est à reconstituer.
- **B. Dans `sparkd`** : il planifie et lance par `incus exec`. Comportement uniforme,
  historique et notifications centralisés. Contre : une panne ou un redémarrage de `sparkd`
  manque des exécutions, et `sparkd` devient un ordonnanceur.

Inclination du rédacteur : **A, avec un « témoin »** — un petit wrapper qui lance la commande
et note début, code de sortie, durée et fin de sortie, que la console relève à la demande,
daté (comme Caddy et les certificats, §18.7). Le moteur est le cron, le registre est la
vérité, le wrapper est le témoin.

### 6.2 Le moteur et les images

Une image minimale n'embarque pas forcément `cron` ; Alpine a un autre démon ; les minuteurs
systemd n'ont pas la sémantique de cron (jour du mois et jour de la semaine se combinent en
« ou » dans cron). Comme pour les familles d'images (SPK-98), une capacité « jobs » pourrait
être déclarée par famille et refuser ce qu'on ne sert pas. **À mesurer sur le catalogue
avant toute décision.**

### 6.3 La grammaire d'une proposition

Une ligne `nom  m h jour mois jour-semaine  commande`. Le **nom** est indispensable : le
DAT §55.3 veut qu'une acceptation *ajoute ou remplace entrée par entrée* ; sans clé stable,
corriger une ligne en créerait une seconde. Comme pour toute paire du §55.3, **aucune
proposition ne retire** : retirer reste un geste du propriétaire.

### 6.4 Ce qu'un job doit avoir pour marcher

- **L'environnement.** Un cron nu n'a ni les variables du Spark, ni ses secrets, ni le socket
  Docker d'un compte rootless (SPK-94 à SPK-96). Sans cela, le premier job réel échoue.
- **Le compte.** Qui exécute : `root`, ou le compte qui fait tourner la pile.
- **Pas de recouvrement** par défaut, et une **durée maximale** : une sauvegarde plus longue
  que son intervalle est le piège classique.
- **Le fuseau horaire**, posé dès le départ et dit à l'écran. « 2 h 30 » est ambigu sans lui.

### 6.5 Les gestes du propriétaire

Activer ou suspendre sans supprimer ; modifier ; retirer, avec confirmation ; lancer
maintenant ; créer à la main (les routes permettent les deux voies). Une facette « Jobs » dans
la fenêtre du Spark : prochaine exécution, dernière exécution relevée et son état. Un échec
pourrait emprunter le canal de notification hors bande (SPK-62).

### 6.6 Points de friction relevés

- **Sensibilité de l'acceptation.** Un agent qui propose un job ne gagne aucune capacité
  nouvelle : il peut déjà tout faire dans sa cellule. Il gagne de la **persistance**. Piste :
  la comparaison ligne par ligne de SPK-131, avec la commande exacte et le compte.
- **Cellule arrêtée.** Cron ne rattrape rien : le produit devrait dire « aucune exécution
  pendant l'arrêt » plutôt que laisser croire à un échec.
- **Les planifications non gérées.** Si l'agent installe lui-même sa planification, on peut
  la **montrer** en lecture seule (comme l'inventaire DNS, SPK-77, ou Docker, SPK-44) ou
  chercher à l'empêcher. Le rédacteur préfère montrer.
- **Restauration, instantanés, transfert.** Les jobs vivent au registre ; le fichier posé est
  régénéré, donc une restauration le rend sans surprise, et un éventuel transfert entre Forges
  (`docs/EXPLORATION_TRANSFERT.md`) les emporterait avec la fiche.

## 7. Ce qui reste ouvert

Toutes ces questions attendent le responsable.

1. **Est-ce utile ?** Quelle douleur concrète justifierait d'exposer quoi que ce soit : un
   job échoué sans que personne le sache, une tâche décrite en prose faute de voie pour la
   proposer, des projets qui planifient chacun à leur façon ? Combien de projets ont des
   jobs aujourd'hui ?
2. **À quel barreau ?** 0, 1, 2, 3 ou 4 (§5) ?
3. **Si c'est contrôlé : cellule (A) ou `sparkd` (B) ?** Survivre à une panne de `sparkd`,
   ou un historique et des notifications simples ?
4. **Le propriétaire crée-t-il un job à la main**, ou seulement accepte-t-il ceux que
   proposent les agents ?
5. **Pour quels jobs ?** Des tâches d'entretien d'agents (sauvegardes, nettoyage), ou de
   vraies tâches métier ? Les exigences de fiabilité ne sont pas les mêmes.
6. **Si une proposition existe : une ligne cron, ou un fragment de pile Compose ?** (§5, fin.)

## 8. Ce qu'il faudrait mesurer avant d'en faire une unité

Si le sujet devient une unité, la pratique du dépôt est de **mesurer avant de décider**
(SPK-27, SPK-143, SPK-160) :

- quelles images du catalogue embarquent `cron`, un démon équivalent ou des minuteurs
  systemd ;
- l'exécution d'une commande sous le compte rootless d'un Spark, avec le socket Docker ;
- le comportement d'une planification à l'arrêt, au démarrage et à la restauration d'un
  instantané ;
- le coût d'une lecture de l'état des conteneurs d'ordonnancement à chaque visite de l'onglet
  Docker (barreau 2).

## 9. Un exécuteur dans la cellule existera déjà : la santé (ajouté le 2026-11-18)

La santé d'un Spark (`docs/DAT.md` §75, SPK-184 à SPK-186) a été **décidée** le même jour et exécute des
**scripts dans la cellule**, sous le compte de la pile, avec un délai, un code de sortie et une cadence en
chaîne crontab. Si les jobs sont un jour exposés (barreaux 3 et 4 du §5), **cet exécuteur est celui qu'ils
réutiliseraient** : un script de santé est un job avec une assertion. Ce n'est pas une décision d'exposer les
jobs ; c'est ce qui rend l'étude moins coûteuse si elle aboutit.

## 10. Ce que cette étude ne fait pas

- elle ne décide pas d'exposer quoi que ce soit ;
- elle ne touche ni à `sparkd`, ni à la console, ni au schéma, ni à `docs/DAT.md` ;
- elle ne réserve aucun identifiant et n'ajoute aucune ligne exécutable au backlog ;
- elle ne remplace pas la planification actuelle par pile Compose, qui continue.
