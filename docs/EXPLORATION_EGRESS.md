# Exploration — des règles de sortie pour un Spark

**Statut : exploratoire. Non planifié, non retenu pour réalisation.**
Étudié le 2026-09-14, à la demande du responsable, et consigné **hors backlog**.

Ce document n'est ni une spécification, ni un contrat. Il conserve une piste
étudiée le 2026-09-14 et les raisons qui l'ont façonnée, pour que la réflexion ne
soit pas à refaire si le sujet revient. **Rien n'est implémenté, aucun code du
dépôt n'y renvoie, et aucune écriture n'a été faite sur la Forge.**

Il ne figure donc pas dans `docs/DAT.md`, qui décrit l'architecture réelle, ni
dans `docs/SCHEMA.md`, qui décrit le registre réel, ni dans `docs/BACKLOG.md`,
qui décrit ce qui est à faire.

**Aucun identifiant `SPK-` n'est attribué.** Comme pour
`docs/EXPLORATION_GPU.md`, une unité future qui reprendrait cette piste prendra
un identifiant neuf. `docs/EXPLORATION_MCP.md` a dû *rendre* trois numéros déjà
parus dans un message de commit poussé ; on ne recommence pas.

**Trois questions restent ouvertes** et attendent l'arbitrage du responsable
(§9) ; la deuxième — couper le latéral Spark → Spark — a été tranchée le
2026-09-17 et vit dans `docs/EXPLORATION_RESEAU_PRIVE.md`. Tant que les autres ne
sont pas tranchées, ce document ne peut pas devenir une spécification.

---

## 0. Ce qui est mesuré, et ce qui ne l'est pas

Le 2026-09-14, sur la Forge de validation `spark-experiment`, en **lecture
seule** — `nft list`, `incus network show`, `incus config show`, `incus query
/1.0`. Aucune règle posée, aucune cellule touchée.

**Mesuré :**

| Fait | Relevé |
|---|---|
| Incus sait filtrer par cellule | extensions `network_acl`, `network_bridge_acl`, `network_bridge_acl_devices`, `network_acl_log`, `network_acl_stateless` — parmi les 553 de la 7.4 |
| Aucune ACL n'existe | `incus network acl list` rend une table vide |
| Le pilote de pare-feu d'Incus | `firewall: nftables` |
| Rien ne filtre la sortie | `chain fwd.sparkbr0`, hook `forward`, priorité `filter`, `policy accept`, deux règles `accept` sans condition de source |
| Le NAT est **après** le filtrage | `chain pstrt.sparkbr0`, hook `postrouting`, priorité `srcnat` |
| La remontée vers la Forge est fermée | `table inet spark_filter`, hook `input`, priorité `filter + 10`, `drop` final (§48) |
| Aucune cellule n'a d'anti-usurpation | sur `sso-p2enjoy` : `eth0: {ipv4.address: 10.77.0.16, limits.max, network, type}` — pas de `security.ipv4_filtering`, pas de `security.mac_filtering` |
| Le bridge n'a pas d'IPv6 | `ipv6.address: none` |

**Non mesuré, et il ne faut pas le présenter autrement :**

- **Un `drop` posé en `forward` à `filter + 10` survit-il à l'`accept`
  d'Incus ?** La sémantique de netfilter dit oui — `accept` termine la chaîne de
  base, pas le parcours du hook, seul `drop` arrête. Le §48 s'appuie déjà
  dessus **côté `input`**, mais Incus n'y pose qu'une `policy accept` ; côté
  `forward`, l'`accept` est **explicite**. Ce n'est pas la même preuve, et elle
  reste à faire.
- **L'usurpation d'adresse source depuis une cellule.** Rien ne la contraint,
  c'est structurel et lisible dans la configuration ; qu'elle passe
  effectivement n'a pas été essayé.
- **Ce que les ACL de bridge d'Incus filtrent réellement.** Les extensions sont
  là ; qu'elles portent sur le trafic sortant **vers internet** — et pas
  seulement sur le trafic du bridge — n'a pas été vérifié.
- **Le coût.** Aucune mesure de débit ou de latence avec une chaîne de règles
  non triviale.

## 1. Le besoin d'origine

Deux étages, énoncés par le responsable :

1. des jeux de règles de sortie **définis au niveau de la Forge** et
   **appliqués par Spark**, pour que le propriétaire d'un Spark borne ce que ses
   applications peuvent joindre ;
2. des jeux « **super** » posés par le propriétaire de la Forge, qui s'imposent
   au Spark **et** à son propriétaire.

## 2. Le point où l'énoncé ne passe pas : « bloquer les apps, pas le propriétaire »

**Au niveau du paquet, cette distinction n'existe pas.** `dockerd` masque ses
conteneurs derrière l'`eth0` de la cellule : le `curl` d'un conteneur applicatif
et le `curl` que le propriétaire tape dans son shell sortent avec **la même
adresse source**. Il n'y a rien à discriminer.

On peut fabriquer la distinction — router les sous-réseaux Docker au lieu de les
masquer, filtrer par sous-réseau — mais cette configuration vit **dans** la
cellule, où le propriétaire est root : il la défait en une commande. Ce serait un
garde-fou déguisé en frontière, ce que le §18 de `CLAUDE.md` interdit.

**Il reste une lecture qui tient**, et c'est celle qui est proposée à
l'arbitrage : la règle est le **choix du propriétaire du Spark**, mais elle est
**appliquée hors de la cellule**. Elle ne lui retire aucune liberté — il la
change quand il veut, depuis la console, et le geste est journalisé. Elle en
retire une à tout ce qui tourne dans sa cellule **sans être lui** : une
application compromise ne peut pas réécrire une règle qui n'est pas dans son
espace de noms.

La frontière n'est donc pas « app contre humain », elle est **« dans la cellule
contre hors de la cellule »**, et le levier du propriétaire passe par le plan de
contrôle authentifié, pas par le chemin des paquets. C'est la propriété qui
survit à une compromission, et c'est la seule des deux qui s'applique de force.

## 3. Le préalable qui commande tout : l'anti-usurpation

Le modèle entier repose sur `ip saddr`, et l'adresse d'un Spark est attribuée par
le registre avant qu'Incus ne soit touché (§15.1) : c'est la bonne clé, elle est
unique, et le produit en est déjà propriétaire.

Mais **aucune cellule ne porte `security.ipv4_filtering`** (§0). Rien, ni dans
Incus ni dans nftables, ne contraint aujourd'hui l'adresse source d'une cellule.
Un propriétaire root dans son Spark pose l'adresse qu'il veut sur `eth0` et sort
sous l'identité d'un voisin — ou sous une adresse hors `10.77.0.0/24` qu'aucune
de nos règles ne matche, donc qui retombe en `accept`.

**Sans `security.ipv4_filtering=true` — et `security.mac_filtering` avec lui — le
filtrage par Spark est décoratif.** C'est la première chose à poser et la
première à prouver. Incus s'appuie pour cela sur l'adresse statique que le
registre attribue déjà : le raccord est direct, il n'y a pas de mécanisme à
inventer.

## 4. Où les deux étages se posent

```
paquet sortant d'une cellule → hook forward
   priorité filter       : fwd.sparkbr0  (Incus)          accept
   priorité filter + 10  : chaîne socle  (Forge)          drop = définitif
   priorité filter + 20  : chaîne spark  (propriétaire)   drop = définitif
   priorité srcnat       : masquerade
```

Deux propriétés tombent d'elles-mêmes :

- **L'adresse source est encore celle de la cellule au moment du filtrage**,
  puisque le NAT est en `postrouting` (§0). `ip saddr 10.77.0.X` identifie donc
  le Spark sans ambiguïté.
- **L'effectif est l'INTERSECTION** : socle ∩ spark. Un jeu de règles de Spark ne
  peut que restreindre davantage, jamais élargir, puisqu'il s'exécute après un
  `drop` déjà tombé. Il n'y a pas de « surcharge » à expliquer, ni de question
  « lequel gagne » — c'est l'ordre des priorités qui répond, et il se lit.

Le montage dépend entièrement du point non mesuré du §0 : si un `drop` à
`filter + 10` ne survit pas à l'`accept` explicite d'Incus, cet empilement est
faux et il faut passer par les ACL d'Incus (§5).

## 5. Table à nous ou ACL d'Incus

Les deux mécanismes existent. L'argument pour les ACL est celui du §48.3, écrit
pour `ufw` : deux jeux de règles qui se recouvrent, et le jour où l'un bloque ce
que l'autre autorise, personne ne sait lequel a tranché.

**La piste retenue par l'exploration est une table `inet spark_egress` au
produit**, pour trois raisons :

- le rendu est une **fonction pure du registre** vers un fichier
  `/etc/sparkd/egress.nft` : lisible d'un coup, et testable hors ligne par
  comparaison à un fichier témoin — c'est la forme de preuve que le dépôt sait
  déjà produire ;
- les deux étages sont **visiblement** de nature différente : deux chaînes, deux
  priorités, deux propriétaires. Noyés dans le même espace de noms d'ACL Incus,
  ils deviennent indistinguables, et « qui a posé cette règle » redevient une
  question ;
- `table inet spark_filter` existe déjà et fait exactement cela (§48) : le
  précédent est posé, pas créé.

**Le mélange est le pire des trois** : socle en nftables et étage Spark en ACL
Incus, c'est précisément l'ambiguïté que le §48.3 refuse.

## 6. Ce qui casse si on s'y prend mal

- **L'amorçage a besoin de sortir.** `apt`, `download.docker.com`, les dépôts des
  familles du §42.11. Un socle en refus-par-défaut posé naïvement rend toute
  création de cellule impossible. Soit le socle porte un **noyau incompressible**
  de ce dont le produit lui-même a besoin, soit les règles ne s'arment qu'après
  amorçage. À trancher (§9).
- **Le retour de l'ingress.** Caddy et les ports publiés (§39) entrent ; leurs
  réponses sortent. `ct state established,related accept` en tête de chaque
  chaîne, sinon fermer la sortie coupe le produit.
- **Le DNS n'est pas concerné, et c'est voulu.** `dnsmasq` sur `10.77.0.1:53`
  passe par le hook `input`, pas `forward` (§48.3 : « fermer le port 53 aux
  Sparks — écarté : c'est leur résolveur »).
- **Spark → Spark.** Aujourd'hui ouvert — et **pas par `fwd.sparkbr0`** : deux
  cellules d'un même bridge Linux s'échangent leurs trames en couche 2, sans
  passer par le hook `forward` de la Forge, sauf si `br_netfilter` y est chargé,
  ce qui n'est pas mesuré. `fwd.sparkbr0` ne concerne que ce qui est routé. Le
  responsable a tranché le 2026-09-17 : le latéral est **coupé par défaut**, et
  se rouvre à dessein par réseau privé — `docs/EXPLORATION_RESEAU_PRIVE.md`. Les
  règles de sortie de ce document n'ont donc pas à en décider.

## 7. Les limites à écrire dès la spécification, pas après

- **Le tunnel DNS reste ouvert.** Un socle en refus total laisse le résolveur de
  la Forge comme canal d'exfiltration. C'est structurel : cela ne se ferme pas à
  ce niveau.
- **Pas de filtrage par nom de domaine.** `nftables` ne connaît que des adresses.
  « Autoriser github.com » exige soit des ensembles alimentés par résolution
  périodique — fragile : CDN, TTL courts, faux négatifs silencieux, donc une
  panne qui ressemble à un défaut applicatif —, soit un **proxy sortant à
  filtrage SNI/CONNECT** sur la Forge. C'est un composant à part entière, et une
  unité distincte.
- **IP et port sont grossiers.** Bloquer SMTP n'empêche pas de relayer par une
  destination HTTP autorisée.
- **IPv6 est absent** du bridge : rien à filtrer aujourd'hui, tout à refaire le
  jour où il apparaît.
- **Cela ne protège pas de `root` sur la Forge** (§35.1), ni d'une évasion de
  *system container* (§11).

## 8. Esquisse de modèle, si le sujet est repris

Conforme au §4 de `CLAUDE.md` — tout existe au niveau général, le contexte ne
définit que sa différence :

```
egress_ruleset (id, nom, portee: 'socle' | 'spark', description)
egress_rule    (ruleset_id, ordre, action: allow | deny, protocole,
                cidr_dest, ports, motif)
spark_egress   (spark_id, ruleset_id)
```

Le catalogue vit au niveau Forge ; les jeux de portée `socle` s'appliquent à
toutes les cellules et ne sont pas détachables par un propriétaire de Spark.
Chaque jeu porte une **action par défaut explicite** en fin de liste — c'est elle
qui décide s'il est une liste noire ou une liste blanche, et elle doit être
visible à l'écran, jamais déduite de la lecture des règles.

## 9. Les questions ouvertes

1. **La lecture du §2** — « hors de la cellule », et non « app contre humain » —
   est-elle bien l'intention ? Si la distinction entre le trafic des conteneurs
   et celui du propriétaire est vraiment voulue, elle ne s'applique pas de force,
   et il faut le dire avant d'écrire une ligne.
2. **Tranché le 2026-09-17 : oui.** Le latéral Spark → Spark est coupé par
   défaut, et se rouvre à dessein par réseau privé. Le changement de comportement
   du parc existant, et sa migration, sont traités dans
   `docs/EXPLORATION_RESEAU_PRIVE.md` — plus ici.
3. **L'amorçage** : noyau incompressible dans le socle, ou règles armées
   seulement après amorçage ?
4. **La v1 s'arrête-t-elle à IP/port**, le filtrage par domaine partant en unité
   séparée avec son proxy ?

Et dans tous les cas, avant toute spécification définitive, deux mesures — qui
demandent d'**écrire** sur la Forge, ce qui n'a pas été fait : un `drop` en
`forward` à `filter + 10` survit-il à l'`accept` explicite d'Incus, et
`security.ipv4_filtering=true` ferme-t-il bien l'usurpation d'adresse.
