# M1 · Comprendre un Spark

Un **Spark** est une cellule d'exécution Linux cloisonnée et contingentée. Sa
seule raison d'être est d'héberger une pile Docker Compose que vous avez déjà.

Concrètement, un Spark c'est : une part de processeur, une quantité de mémoire,
un disque, un plafond réseau, une adresse privée, ses clés SSH et ses domaines.
Le tout prélevé sur les pools du serveur, comptabilisé, et rendu à la
suppression.

## Le point qui change tout

**Docker n'est pas la frontière d'isolation. Le Spark l'est.**

Dans un hébergement classique, on isole les applications les unes des autres avec
Docker, et on finit par réécrire les piles pour qu'elles cohabitent. Ici, Docker
appartient au locataire : il vit *à l'intérieur* du Spark, et vous y lancez votre
`docker compose up` sans rien changer.

C'est ce qui permet de reprendre une pile existante telle quelle.

## Ce que ce n'est pas

Ce n'est ni un PaaS, ni un ordonnanceur de conteneurs, ni un Kubernetes de poche.
Il n'y a pas de scheduler, pas de service mesh, pas de registre d'images géré.
L'unité n'est ni une application ni une fonction : c'est une **machine à quota**.

## Ce qui reste votre responsabilité

- le contenu du Spark : votre pile Compose, ses images, ses volumes ;
- vos sauvegardes applicatives — un instantané de cellule n'en est pas une
  (voir [M9](M9-instantanes.md)) ;
- le pointage DNS de vos domaines vers le serveur (voir [M7](M7-domaine.md)).
