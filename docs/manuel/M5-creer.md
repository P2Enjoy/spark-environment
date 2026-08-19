# M5 · Créer un Spark

![Le formulaire de création et la capacité restante](images/m5-formulaire.png)

L'écran affiche la capacité restante à gauche de votre saisie. **Il ne vous
interdit rien sur cette base** : le bouton n'est jamais désactivé parce que
l'estimation locale juge la demande trop grande.

La raison est concrète : cette capacité est une photographie prise à l'ouverture
de l'écran. Un Spark supprimé depuis l'a rendue fausse — dans le sens favorable.
Bloquer sur une valeur périmée refuserait une création que le serveur aurait
acceptée, sans que vous puissiez le savoir.

## Les quatre modes CPU

| Mode | Quand le choisir |
|---|---|
| **partagé** | le défaut, et le bon choix pour presque tout |
| **plafonné** | quand vous voulez interdire le burst, par exemple pour un environnement de recette qui ne doit jamais gêner la production |
| **dédié** | base de données, compilation, inférence — tout ce qui souffre du partage |
| **épinglé partagé** | localité mémoire souhaitée, sans exclusivité |

### Ce que « 0,5 CPU » veut dire

C'est un **droit d'ordonnancement sous contention**, pas un plafond. Quand la
machine est libre, votre Spark consommera davantage, et c'est normal : mesuré, un
Spark réservant 0,5 CPU en consomme presque 2 sur un hôte au repos. L'interface
appelle cela un *burst* et ne le signale pas comme une anomalie.

Ce que ce n'est pas : une garantie que 0,5 CPU vous sera réservé quoi qu'il
arrive sur la machine (voir [M4](M4-pools.md)).

En mode **plafonné**, à l'inverse, la valeur saisie est une limite réellement
appliquée — et elle est provisionnée en entier, parce que vous pouvez la
consommer en permanence.

## Ce que « 10 Gio » de disque veut dire

**10 Gio stockés, après compression.** Le stockage compresse à la volée, et le
quota compte ce qui est réellement écrit sur le disque, pas ce que votre pile
croit avoir écrit.

Mesuré : dans un quota de 2 Gio, 8 Gio de zéros n'ont consommé que 24 Kio,
tandis que 2 Gio de données incompressibles l'ont épuisé exactement.

L'écart joue donc **toujours en votre faveur** : avec des données compressibles —
des journaux, du texte, du JSON — vous logez davantage que ce que vous avez
demandé ; avec des données déjà compressées — images, archives, vidéos — vous
obtenez exactement votre quota. Vous n'en obtenez jamais moins.

## Le débit réseau

Seul le **plafond** est appliqué par le noyau. La réservation réseau sert à la
comptabilité : elle empêche de survendre le lien, elle ne garantit pas une bande
passante.

## Lire un refus

![Un refus du serveur, avec la saisie conservée](images/m5-refus.png)

Un refus vient toujours du serveur, jamais d'un contrôle de l'interface. Il
**chiffre ce qui manque**, dans l'unité que vous avez saisie, et **votre saisie
reste intacte** : vous corrigez la valeur fautive sans tout ressaisir.

Deux contrôles restent locaux, et ils ne portent pas sur la capacité : la syntaxe
du nom, et la cohérence du mode CPU avec les champs affichés. Ce sont des
questions de forme, que le serveur revérifie de toute façon.
