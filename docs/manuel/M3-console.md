# M3 · Ouvrir la console

La console est une application **locale**. Elle tourne sur votre poste et
n'expose rien sur le réseau. Elle administre un ou plusieurs serveurs à travers
un tunnel SSH.

## Lancer

```
make runDev
```

La console répond alors sur `http://127.0.0.1:5173`.

## Choisir un serveur

Un serveur se déclare dans un inventaire local. Il porte un nom, un hôte, un
utilisateur et le port sur lequel `sparkd` écoute à l'autre bout.

**L'inventaire ne contient jamais de secret.** Ni mot de passe, ni phrase de
passe, ni clé : l'authentification appartient à votre configuration SSH. Un champ
qui ressemble à un secret est refusé à l'écriture plutôt que filtré en silence,
pour que vous sachiez le retirer d'où vous l'aviez copié.

## Se repérer

La console a **trois niveaux**, et la forme de chacun dit ce qui va changer quand
vous cliquez :

| Niveau | Ce que c'est | Forme |
|---|---|---|
| 1 | les destinations — Sparks, Hôte | barre latérale, à gauche |
| 2 | les sous-parties d'une destination — Pools, Images sous Hôte | onglets |
| 3 | un Spark ouvert, avec ses facettes — Aperçu, Routes, Clés, Instantanés, Journal | onglets de sa fenêtre |

Le **serveur courant** et l'état de son tunnel sont au-dessus de la barre
latérale : ce n'est pas une destination, c'est le contexte de toutes les
destinations. On ne « va » pas au serveur comme on va aux Sparks.

Chaque onglet a sa propre adresse. Vous pouvez donc recharger la page sur
« Instantanés », ou en partager le lien.

Sous 1024 px, la barre latérale passe en haut. Elle garde ses libellés : un
pictogramme seul n'est pas une navigation.

## L'état du tunnel

La console **ouvre elle-même** le tunnel du serveur courant à son démarrage, et
en affiche l'état en permanence, en haut à droite :

| État | Ce qu'il veut dire |
|---|---|
| en cours | le tunnel s'établit |
| ouvert | `sparkd` répond à travers le tunnel |
| rompu | le tunnel ne répond plus |

![Liste des Sparks, avec l'état du tunnel en haut à droite](images/m3-liste.png)

L'état « ouvert » n'est jamais posé sans preuve : la console interroge `sparkd`
**à travers** le tunnel. Un processus `ssh` vivant mais figé ne suffit pas — il
serait déclaré rompu, ce qui est la vérité utile.

## Quand le tunnel tombe

La console affiche un bandeau et **cesse d'afficher des données**. Elle ne montre
pas les valeurs précédentes : une valeur périmée prise pour vraie vous ferait
décider sur un état qui n'existe plus.

Le message reprend la sortie d'erreur de `ssh` — « clé refusée », « hôte
inconnu » —, pour vous éviter de relancer la commande à la main pour la lire.
