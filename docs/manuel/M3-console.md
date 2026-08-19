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
