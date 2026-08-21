# M11 · Sécurité et limites

## Surface d'exposition

Trois ports seulement sont ouverts sur l'extérieur : `22`, `80` et `443`.

**Aucune API d'administration n'est joignable depuis le réseau.** Le runtime
n'écoute que sur la boucle locale du serveur, et il *refuse de démarrer* sur une
adresse routable — ce n'est pas un réglage laissé à votre vigilance, c'est une
condition de démarrage. Seul un porteur de clé SSH valide l'atteint, par tunnel.

Un Spark n'expose pas son port 22 : l'accès passe par rebond sur la Forge.

## Ce qui est cloisonné

Les Sparks sont **non privilégiés**, avec des plages d'identifiants disjointes :
deux Sparks ne partagent aucun UID sur la Forge. Le quota disque, le plafond réseau
et les limites mémoire ont été vérifiés par la mesure sur matériel réel.

Seules des clés **publiques** sont stockées. Le journal d'audit retient le
libellé et l'empreinte d'une clé, jamais son corps.

## Ce qui n'est pas garanti

- **Un *system container* partage le noyau de la Forge.** Pour des charges hostiles
  ou réellement multi-locataires, la réponse prévue est un mode machine
  virtuelle, pas un durcissement du mode conteneur.
- **Qui atteint la Forge atteint le réseau privé.** Le rebond SSH simplifie
  l'accès ; il ne cloisonne pas la Forge des Sparks.
- **Une clé restreinte reste une clé.** Volée, elle donne encore tous les gestes
  du produit ; elle ne donne plus la Forge elle-même (voir ci-dessous).
- **La réservation CPU n'est pas absolue** aujourd'hui : elle n'est
  proportionnelle qu'entre Sparks (voir [M4](M4-pools.md)).
- **La réservation réseau est une comptabilité**, pas une garantie de bande
  passante : seul le plafond est appliqué par le noyau.
- **Un instantané n'est pas une sauvegarde** (voir [M9](M9-instantanes.md)).

## Votre clé d'accès peut être restreinte

Par défaut, la clé SSH qui vous donne accès à la Forge y ouvre aussi un **shell**.
Or qui a un shell sur la Forge a le registre : aucun contrôle placé devant
l'interface ne protège de cela.

Le produit fournit de quoi refermer cette porte **sans rien vous retirer**. Une
fois posée, votre clé garde exactement trois usages :

- la console ouvre son tunnel vers le serveur ;
- vous ouvrez un terminal dans un Spark ;
- vous ouvrez le dépannage d'un Spark dont le SSH ne répond plus.

Et elle perd les autres : plus de session interactive sur la Forge, plus de
lecture de ses fichiers, plus d'accès à un autre service qu'elle héberge.

**Ce que cela ne fait pas** : cela ne rend pas votre clé inoffensive si on vous la
vole. Une clé restreinte volée donne toujours les gestes — arrêter, supprimer,
lever une protection. Ce qu'elle change est ailleurs : un accès total et
silencieux devient un accès aux gestes, et **tous les gestes sont journalisés**
(voir [M12](M12-annexes.md)).

La marche à suivre s'adresse à qui administre la Forge : elle est dans le
`README.md` du produit, section *Restreindre la clé d'accès du responsable*.
Gardez une seconde session ouverte pendant l'opération.

## Être prévenu quand quelque chose de grave arrive

La Forge peut envoyer une **alerte hors bande** — vers Slack, Discord, `ntfy` ou
un script à vous — chaque fois qu'un geste sensible aboutit :

- un Spark est supprimé ;
- une **protection est levée** ;
- un instantané est supprimé ou restauré ;
- un accès SSH est donné ou retiré ;
- un port publié ou un nom public est retiré ;
- un shell de **dépannage** est ouvert en root dans un Spark.

Trois choses à comprendre, et elles décident de ce que cette alerte vaut :

- **elle ne prévient pas, elle détecte.** Le geste a déjà eu lieu quand le
  message part. C'est précisément ce qui la rend utile : elle sert encore quand
  tout le reste a échoué ;
- **un canal injoignable n'empêche jamais un geste.** Si votre destinataire est
  en panne, vos gestes continuent d'aboutir. L'écran *Forge* vous dit combien
  d'alertes ne sont pas parties ;
- **sans canal configuré, rien n'est surveillé**, et l'écran *Forge* le dit en
  toutes lettres plutôt que d'afficher des compteurs à zéro qui ressembleraient à
  « tout va bien ».

Le message nomme le geste, qui l'a demandé et sur quoi il a porté. Il ne contient
**jamais** de secret : les valeurs d'un geste — corps de clé, mots de passe — ne
sont pas envoyées du tout.

Cela se règle avec la variable `SPARKD_NOTIFY_URL` sur la Forge.

## Toute règle d'accès est appliquée côté serveur

Un bouton masqué ou un champ désactivé n'est qu'une aide visuelle. Les refus que
vous voyez — capacité insuffisante, commande impossible, domaine déjà pris,
restauration bloquée — sont tous prononcés par le serveur, et le resteraient si
l'interface disparaissait.
