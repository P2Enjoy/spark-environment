# M7 · Exposer un domaine

Le contrat est simple : **domaine → Spark → port**.

![Déclaration d'une route publique](images/m7-route.png)

## Déclarer une route

Le port demandé est celui sur lequel écoute votre pile **dans le Spark**, pas
celui de l'hôte. C'est l'erreur la plus fréquente : on saisit `443` en croyant
décrire l'entrée.

Le TLS est confié à la gestion automatique du proxy. **L'émission d'un certificat
suppose que le domaine résolve déjà vers ce serveur** — le DNS est extérieur au
produit. Un domaine mal pointé produit un échec d'émission côté proxy, pas une
panne du plan de contrôle, et l'interface ne présentera jamais un certificat
comme « actif » : elle ne le sait pas.

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

> **Limite connue.** L'émission d'un certificat n'a pas été éprouvée : elle
> suppose un domaine résolvant vers l'hôte, dont le projet ne dispose pas encore.
> Seul le routage HTTP par nom d'hôte est prouvé. Voir SPK-12 au
> [backlog](../BACKLOG.md).
