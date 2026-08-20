# M7 · Exposer un domaine

Le contrat est simple : **domaine → Spark → port**.

![Déclaration d'une route publique](images/m7-route.png)

## Déclarer une route

Le port demandé est celui sur lequel écoute votre pile **dans le Spark**, pas
celui de la Forge. C'est l'erreur la plus fréquente : on saisit `443` en croyant
décrire l'entrée.

Le TLS est confié à la gestion automatique du proxy. **L'émission d'un certificat
suppose que le domaine résolve déjà vers ce serveur.** Un domaine mal pointé
produit un échec d'émission côté proxy, pas une panne du plan de contrôle, et
l'interface ne présentera jamais un certificat comme « actif » : elle ne le sait
pas.

Pour faire résoudre le domaine, voir « Pointer le domaine » ci-dessous.

## Un domaine et tous ses sous-domaines

Une route peut porter une **étoile** en tête : `*.monapi.fr`. Elle sert alors
tous les sous-domaines d'un seul niveau — `api.monapi.fr`, `client42.monapi.fr` —
sans qu'il faille les déclarer un par un.

L'étoile ne vaut **qu'en tête et que sur un niveau**. `*.*.monapi.fr`,
`api.*.monapi.fr` et `*.fr` sont refusés, et le refus vous dit laquelle de ces
trois formes vous avez employée.

### Sortir un sous-domaine du lot

C'est le geste de la montée en charge : quand `api.monapi.fr` devient assez
chargé pour mériter son propre Spark, vous le déclarez **en nom exact** sur ce
Spark. Il prend aussitôt le pas sur l'étoile, sans que vous ayez à toucher à
cette dernière. Tout le reste continue de passer par elle.

**Le plus précis gagne toujours.** C'est la règle du DNS et celle du proxy ;
le produit n'en invente pas d'autre.

### Vous saurez toujours qui prend le pas sur quoi

Dans les deux sens, et c'est voulu :

* **au moment où vous déclarez** un nom déjà servi par l'étoile d'un autre
  Spark, un bandeau vous dit lequel. La déclaration réussit — c'est un geste
  légitime —, mais vous venez de détourner une adresse qui partait ailleurs, et
  vous devez le savoir ;
* **en consultant les routes** du Spark qui porte l'étoile, chaque nom qui lui a
  été soustrait apparaît sous elle, avec le Spark qui le sert.

Ce second point est celui qui sert le plus au dépannage. Un sous-domaine qui ne
répond pas comme les autres se diagnostique depuis l'étoile elle-même — sans
cela, on cherche dans la configuration du Spark porteur, où il n'y a rien à
trouver.

> **Limite connue.** Un certificat pour une étoile exige une validation par
> enregistrement DNS, que le produit ne réalise pas encore. Les noms exacts, eux,
> se valident normalement.

## Pointer le domaine

Chaque route porte un bouton **DNS**. Il ouvre une fenêtre qui lit les zones de
votre compte chez le fournisseur, et pose l'enregistrement qui fait résoudre ce
domaine vers votre serveur.

Le domaine n'est pas saisissable : il vient de la route. Le rendre modifiable
laisserait pointer un nom que le serveur ne route pas, c'est-à-dire un nom qui
répondrait « page introuvable ».

La zone la plus précise qui contienne le domaine est proposée d'avance. Si votre
compte porte à la fois `exemple.tech` et `staging.exemple.tech`, un domaine
`app.staging.exemple.tech` ira dans la seconde — écrit dans la première, il
serait invisible.

L'adresse demandée est celle du **serveur**, pas celle du Spark : un Spark vit
sur un réseau privé et n'a pas d'adresse publique. C'est le proxy qui répartit
ensuite par nom d'hôte.

Avant d'écrire, la fenêtre montre l'enregistrement exact qui partira, **et ce
qu'il va faire à ce qui est déjà en place** :

* « l'enregistrement sera posé » — rien n'occupe ce nom ;
* « il sera **remplacé** : *ancienne valeur* → *nouvelle valeur* » — la valeur
  remplacée est affichée, pas seulement annoncée ;
* « l'écrire ne changera rien » — la valeur en place est déjà la bonne.

Après, elle annonce ce qui a été **écrit** — jamais que le domaine est « prêt ».
La résolution demande le temps du délai d'expiration, et davantage si un
résolveur a déjà mis l'ancienne réponse en cache.

### Le domaine nu

`johndalia.com` sans sous-domaine est un cas ordinaire, et il fonctionne. La
fenêtre le signale — « il porte sur le domaine **nu** » — parce que le remplacer
déplace tout ce qui répond sur ce domaine, et pas seulement une de ses branches.

Vos serveurs de noms, votre messagerie et vos preuves de propriété ne sont **pas**
touchés : chaque écriture vise un nom *et un type* précis, et ceux-là sont d'un
autre type.

### Ce que ce bouton ne fera jamais

Il n'achète aucun domaine et n'en renouvelle aucun : une opération qui engage de
l'argent ne se déclenche pas depuis un écran d'administration. Il ne transfère
aucune zone et ne change aucun serveur de noms. Et il **ne supprime jamais** un
enregistrement qu'il n'a pas posé : votre zone porte de la messagerie et des
preuves de propriété, dont la disparition casserait des choses sans rapport avec
ce produit.

Deux écritures sont refusées, et le refus dit ce qu'il protège :

* un domaine qui n'est **pas dans** la zone choisie ;
* tout ce qui n'est pas une adresse IP.

### Si rien n'est configuré

Le jeton du fournisseur vit sur le **poste** qui fait tourner la console, dans un
fichier `.env` qui n'entre jamais dans le dépôt — jamais sur le serveur, où il
serait lisible par qui y détient l'administration. Sans jeton, la fenêtre le dit
et n'offre aucune saisie : ce n'est pas une panne, c'est une configuration
absente.

## Un domaine déjà pris

Deux Sparks ne peuvent pas revendiquer le même nom. Le refus vient de la base de
données, pas d'un contrôle de l'interface — qui ne protégerait de rien si deux
consoles agissaient en même temps.

## « Non appliquée »

Une route peut être enregistrée sans être servie : c'est ce qui arrive si le
proxy était injoignable au moment de la déclaration. L'interface l'affiche en
jaune, avec un bouton **Réappliquer**.

Le jaune est délibéré : rien n'est cassé, un état est simplement en retard.
Réappliquer ne détruit rien et ne demande donc aucune confirmation.

## Retirer

Le domaine cesse de répondre immédiatement. C'est réversible — il suffit de le
redéclarer — mais la confirmation nomme le domaine, parce que la coupure est
instantanée.

> **Limite connue.** L'émission d'un certificat n'a pas encore été éprouvée de
> bout en bout. La cause la plus fréquente de son échec — un domaine qui ne
> résout pas — est levée depuis que la console pose le DNS, mais l'émission
> elle-même reste à constater sur un serveur joignable depuis l'extérieur. Voir
> SPK-12 au [backlog](../BACKLOG.md).

## Appliquer une recette DNS

Certains usages ne tiennent pas en un enregistrement. Un site sur le domaine nu
en demande deux ; une messagerie en demande quatre ou cinq, et **l'absence d'un
seul suffit à faire classer tout le courrier en indésirable**.

Le bouton **Appliquer une recette DNS** pose ces jeux d'un geste.

### Ce que la fenêtre vous montre avant d'écrire

La recette **entière**, ligne par ligne, avec pour chacune ce qu'elle fait et ce
qu'elle deviendra : *sera posé*, *remplacera telle valeur*, ou *déjà à cette
valeur*. Rien n'est écrit tant que vous n'avez pas engagé.

Elle vous montre aussi **ce que la recette ne peut pas faire** — les choses qui
ne vivent pas dans la zone et qu'aucun enregistrement ne réglera.

### Les deux recettes disponibles

**Site web sur le domaine nu** — fait répondre le domaine lui-même et son `www`
sur cette Forge. Deux enregistrements, aucune valeur à aller chercher ailleurs.

**Émission par le relais transactionnel** — fait émettre un sous-domaine par le
relais de votre fournisseur. **Attention** : ce sous-domaine *émet* et *ne reçoit
pas* — son `MX` pointe vers un puits. Ne l'appliquez pas sur un domaine censé
recevoir du courrier.

Cette recette réclame une **clé DKIM**, que le produit **n'invente jamais** :
elle est produite par votre fournisseur, et une clé inventée produirait une
signature invalide — exactement l'effet qu'on cherche à éviter. Laissée vide, la
recette est posée quand même, et la fenêtre vous dit alors qu'elle est
**incomplète** : les messages partiront sans signature.

### Après : ce qui est passé, et ce qui ne l'est pas

Une recette écrit ses enregistrements **un par un**, et votre fournisseur peut en
refuser un au milieu. La fenêtre ne vous annonce donc ni succès ni échec global :
elle rend **la liste**, chaque ligne avec son sort, et le motif de chaque refus.

**Ce qui est passé n'est pas défait.** Le produit ne connaît pas la valeur
d'avant — il ne l'a pas retenue — et il ne supprime jamais ce qu'il n'a pas posé.
Vous voyez l'état réel, et vous décidez.

## Publier un port — pour ce qui ne parle pas HTTP

Tout ce qui précède route par **nom** : vos applications partagent les ports 80 et
443, et le proxy lit dans la requête le nom demandé. C'est ce qui permet à des
dizaines de Sparks de partager une seule adresse, avec un certificat automatique
par nom.

Cela suppose que le client **annonce** le nom. C'est le cas de HTTP et de HTTPS —
et donc, c'est moins évident, des WebSockets, qui commencent par une requête HTTP
avant de changer de protocole. Une API, un Ollama, un serveur de développement,
un Keycloak, un MinIO : **aucun n'a besoin d'un port publié**.

Un serveur de messagerie, lui, reçoit une connexion sur le port 25 sans qu'aucun
nom ne soit prononcé. Une base de données, un Redis, un SSH sont dans le même
cas. Le seul élément qui désigne alors le Spark destinataire est **le port sur
lequel la connexion est arrivée**.

C'est à cela que sert la section **Ports publiés**, sous les routes.

### Ce qu'un port publié vous coûte

**Le certificat automatique.** Le proxy obtient et renouvelle les certificats
parce qu'il comprend le protocole ; un port transporté tel quel ne lui passe pas
devant. L'application dans le Spark doit donc faire **son propre TLS** — une base
de données, un MinIO ou un serveur de messagerie savent le faire, mais il faut le
savoir.

Publier un port pour une application qui parle HTTP est presque toujours une
erreur : vous perdez le certificat sans rien gagner. La fenêtre vous le dit ;
elle ne vous l'interdit pas.

### Un port appartient à la machine, pas au Spark

C'est la différence avec un nom. Vous pouvez donner autant de noms que vous voulez
à autant de Sparks que vous voulez. Un port, lui, est **unique sur la Forge** : le
premier qui le prend le prend, et le refus vous nomme le Spark qui le détient.

Certains ports ne sont jamais attribuables — ceux qu'occupe le système de la
Forge. La fenêtre les énumère avec la raison de chacun, pour que vous ne
cherchiez pas à libérer un port qui sert à quelque chose.

### Retirer referme

Le port cesse d'être joignable immédiatement. Le retrait se confirme, parce que
la coupure est instantanée — mais rien n'est détruit dans le Spark, et vous
pouvez republier.

> **Limite connue.** Le fait qu'une connexion entrante atteigne réellement le
> Spark n'a pas encore été constaté sur une Forge réelle : cela demande une
> machine avec Incus et une adresse publique. Ce que le produit garantit
> aujourd'hui est que la règle est posée et retirée correctement.
