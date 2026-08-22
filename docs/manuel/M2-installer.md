# M2 · Installer le serveur

Ce chapitre décrit le diagnostic, le plan et l'installation de `sparkd` sur une
destination SSH. La console ne choisit jamais un disque ni une taille à votre
place.

## Diagnostiquer une Forge neuve depuis la console

Déclarez d'abord le serveur dans **Serveurs**, puis ouvrez **Forge** et cliquez
sur **Diagnostiquer la Forge** dans *Installer cette Forge*.

Le relevé est strictement en lecture seule. Il distingue trois faits qui ne se
remplacent pas : le transport SSH, le plan de contrôle `sparkd`, puis la
disponibilité que prouvera plus tard `/readyz`. Ainsi, **SSH établi** avec
`sparkd` absent n'est ni une Forge prête ni une panne SSH.

Le panneau relève le système, les services et les périphériques. Il affiche un
disque exclu avec son motif — racine, montage, partition ou signature — et ne le
sélectionne jamais. S'il n'y a pas deux disques sûrs, il n'invente pas un miroir
ni la taille d'un pool fichier. Le diagnostic seul s'arrête là : aucune commande
d'installation, aucun redémarrage et aucune modification ne sont partis.

## Composer et confirmer le plan

Le formulaire reprend les valeurs du contrat d'exploitation : pool, bridge,
réserves CPU et mémoire, plafond ARC. En l'absence de deux supports sûrs, vous
devez aussi saisir la taille du pool fichier et l'espace qui restera libre sur
la racine. **Vérifier et composer le plan** relance d'abord le diagnostic : le
plan affiché ne repose donc pas sur un relevé resté ouvert dans un onglet.

Relisez ensuite chaque phase et cochez la confirmation du plan. Une création de
pool fichier demande en plus de recopier exactement son chemin et sa taille ; un
miroir natif demande les deux périphériques qui seront effacés. Le bouton reste
désactivé tant que les deux engagements ne concordent pas.

L'exécution affiche les événements réellement produits sur la Forge : `à faire`,
`en cours`, `terminée`, `avertissement`, `échec` ou `interrompue`. Le résultat
utile — version Incus, pool, ARC, bridge, version de `sparkd`, préflight,
`/healthz` et `/readyz` — reste sous sa phase, sans sortie de terminal brute.
Deux installations simultanées sur la même Forge sont refusées.

Le journal vit sur le poste, séparément de l'inventaire. Fermer puis rouvrir la
vue, ou redémarrer la console, le conserve. Avant toute reprise, **Reprendre le
diagnostic** relit la machine ; il ne continue jamais sur la seule foi du journal.

## Vérifier une Forge déjà équipée

La vérification est **en lecture seule** : vous pouvez la lancer sur un serveur
en service sans vous demander ce qu'elle va faire.

```
sudo /opt/sparkd/venv/bin/python -m sparkd.preflight
```

Elle rend treize contrôles. Chacun dit son verdict, **la valeur qu'il a relevée**,
et la commande qui corrige — pour vous éviter d'aller remesurer à la main ce que
le programme venait de mesurer.

| Contrôle | Ce qu'il établit |
|---|---|
| `INC-VERSION` | Incus ≥ 6.19 |
| `STO-POOL` | pool ZFS présent |
| `STO-COMPRESSION` | compression active |
| `MEM-ARC` | plafond de l'ARC ZFS posé et raisonnable |
| `NET-BRIDGE` | bridge privé présent |
| `NET-DHCP` | plage DHCP disjointe de celle du registre |
| `ING-CADDY` | Caddy administrable localement |
| `SEC-PORTS` | seuls `22`, `80`, `443` joignables depuis le réseau |
| `NET-REMONTEE` | un Spark ne peut pas remonter vers le SSH de sa Forge |
| `SSH-X11` | la redirection X11 inutile est désactivée ou signalée sans bloquer |
| `RUN-SPARKD` | `sparkd` survivra à un redémarrage |
| `RUN-SLICE` | la tranche systemd parente des Sparks existe et est paramétrée |
| `REG-FANTOME` | chaque cellule déclarée existe réellement dans Incus |

Un verdict **inconnu** n'est pas un échec : il veut dire que la mesure n'a pas
pu être faite. Les confondre vous ferait « corriger » un serveur correct.

### Pourquoi Incus ≥ 6.19

Ce n'est pas une préférence de version. Avec la version des dépôts Ubuntu,
**aucun** conteneur Docker ne démarre dans un Spark — le produit ne fonctionne
pas du tout. Installez Incus depuis le dépôt amont.

### Pourquoi plafonner l'ARC de ZFS

ZFS peut prendre jusqu'à son plafond à tout instant, sans prévenir. Un plafond
non posé fait promettre aux Sparks une mémoire que le noyau leur reprendra. Le
registre soustrait ce plafond de la mémoire allouable (voir [M4](M4-pools.md)).

## Installer

```
sudo scripts/install-serveur.sh
```

Le script est **idempotent** : le relancer met à jour le code et l'unité sans
rien détruire. **Il n'efface jamais le registre.**

Il installe `sparkd` dans un environnement isolé, pose son unité systemd,
l'**active au démarrage**, puis relance la vérification.

> Un plan de contrôle lancé à la main depuis une session `ssh` disparaît au
> premier redémarrage. Les Sparks, eux, continuent de tourner — sans que rien ne
> les administre. La panne est silencieuse et ne se découvre qu'à la première
> opération. C'est pourquoi le contrôle exige que le service soit **activé au
> démarrage**, et pas seulement démarré.

## Mettre à jour une Forge déjà installée

Quand **Forge → Code déployé** dit que la Forge est *En retard*, le bouton
**Mettre à jour `sparkd`** remplace la procédure SSH. Il n'apparaît que si le
commit installé est un ancêtre certain de la branche `main` publiée par votre
poste. Une build étrangère, inconnue, plus récente ou un dépôt absent ne propose
aucun geste : la console ne prend jamais le risque de régresser un serveur.

La confirmation nomme l'interruption brève du plan de contrôle. Les Sparks et
leurs conteneurs continuent de tourner ; seule leur API d'administration est
redémarrée. La console installe le paquet épinglé au commit publié, repose les
unités, exécute `daemon-reload`, redémarre `sparkd`, puis vérifie successivement
`/healthz`, `/readyz` et la build servie. Un téléchargement terminé ne suffit
donc jamais à afficher un succès.

Après un succès, **Revenir à la build précédente** permet un retour immédiat et
borné au seul commit remplacé. Il redémarre encore le plan de contrôle et exige
les mêmes preuves. Il ne descend pas automatiquement les migrations de données :
une suppression de données demanderait une opération distincte et sa propre
confirmation.

Un échec conserve la dernière build connue et sa cause. S'il survient après que
le paquet a changé, la console tente automatiquement de réinstaller la build
précédente et affiche séparément l'issue de ce retour arrière.

## Après l'installation

Un registre neuf ignore la capacité de la machine. Relevez-la :

```
curl -X POST http://127.0.0.1:9876/v1/host/sync
```

Ou, depuis la console, le bouton **Relever la topologie** ([M4](M4-pools.md)).

Vérifiez ensuite que les dépendances répondent :

```
curl http://127.0.0.1:9876/readyz
```

Cette réponse **sonde** réellement Incus, Caddy et le registre, et nomme la cause
de toute dépendance en panne.

## Ce que ces contrôles ne disent pas

Ils vérifient des **conditions**, pas des comportements. Qu'Incus soit en 7.3
n'établit pas qu'une pile Docker tourne effectivement dans un Spark : cette
preuve-là est une mesure, à faire une fois sur le serveur.

Deux vérifications restent donc manuelles :

1. **le scan des ports depuis l'extérieur.** Le contrôle lit ce que la Forge
   déclare écouter ; un pare-feu amont peut en différer ;
2. **un Spark de test** qui se crée, démarre, obtient son adresse privée, et dont
   le quota disque refuse effectivement l'écriture au-delà de la limite.

## Ce qui demande encore une décision extérieure

- **Une taille de pool fichier n'a aucun défaut caché.** Tant que vous ne l'avez
  pas choisie, l'assistant ne crée rien.
- **Le miroir natif exige deux supports réellement libres.** Si la machine n'en
  possède pas, aucun parcours d'écran ne peut en fabriquer la preuve.
- **Une Ubuntu totalement nue est amorcée par la console après confirmation du
  plan.** Elle pose seulement l'environnement Python et le paquet `sparkd`
  épinglé sur la build `main` publiée que la console exécute. Aucun checkout
  n'est laissé sur la Forge ; un second passage conforme ne réinstalle rien.
- Le DNS public et les choix de messagerie restent des opérations humaines :
  `/readyz` ne prétend pas les avoir effectuées.
