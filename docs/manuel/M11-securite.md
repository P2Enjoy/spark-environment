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
- **La réservation CPU n'est pas absolue** aujourd'hui : elle n'est
  proportionnelle qu'entre Sparks (voir [M4](M4-pools.md)).
- **La réservation réseau est une comptabilité**, pas une garantie de bande
  passante : seul le plafond est appliqué par le noyau.
- **Un instantané n'est pas une sauvegarde** (voir [M9](M9-instantanes.md)).

## Toute règle d'accès est appliquée côté serveur

Un bouton masqué ou un champ désactivé n'est qu'une aide visuelle. Les refus que
vous voyez — capacité insuffisante, commande impossible, domaine déjà pris,
restauration bloquée — sont tous prononcés par le serveur, et le resteraient si
l'interface disparaissait.
