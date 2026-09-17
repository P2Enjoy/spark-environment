# Exploration — cloisonner le réseau des Sparks : réseaux privés et liens privés

**Statut : direction décidée par le responsable le 2026-09-17 ; modèle et
réalisation à arbitrer. Non planifié, hors backlog, aucun identifiant `SPK-`
attribué.**

Ce document consigne une **décision de direction** du responsable et l'étude qui
l'accompagne. Il n'est ni une spécification, ni un contrat : rien n'est
implémenté, aucun code du dépôt n'y renvoie, et **aucune écriture n'a été faite
sur la Forge**. Comme `docs/EXPLORATION_EGRESS.md`, il vit hors de `docs/DAT.md`,
qui décrit l'architecture réelle, hors de `docs/SCHEMA.md`, qui décrit le
registre réel, et hors de `docs/BACKLOG.md`, qui décrit ce qui est à faire. Les
unités qui reprendront ces pistes prendront des identifiants neufs.

Il ferme une question de `docs/EXPLORATION_EGRESS.md` — la deuxième du §9, « le
socle coupe-t-il le latéral Spark → Spark ? » — et il en corrige une phrase
(§1 ci-dessous). Les deux documents se lisent ensemble : celui-là traite de ce
qu'un Spark peut joindre **hors** de la Forge, celui-ci de ce qu'il peut joindre
**dedans**.

---

## 0. La décision du responsable (2026-09-17)

Énoncée à l'occasion d'un Spark déployé qui ne joignait pas le SSO de la Forge
(`docs/JOURNAL.md`, 2026-09-17), et reformulée ici en quatre points :

1. **Chaque Spark est isolé du réseau des autres.** Deux Sparks ne se parlent
   pas, même quand l'un connaît l'adresse privée de l'autre.
2. **La Forge sait créer des réseaux privés** — le responsable dit « VPN »,
   « mini-switch » — auxquels on **attache** des Sparks pour les interconnecter.
3. **La Forge sait créer des liens privés** — « pont », « private link » :
   attacher **un port d'un Spark** au réseau **d'un autre Spark**, qui joint alors
   ce seul port, et rien d'autre du réseau du premier.
4. **Les trois se gèrent depuis la console et la Forge.**

Ce que la décision tranche d'emblée :

- la question 2 du §9 de `docs/EXPLORATION_EGRESS.md` : **oui**, le latéral est
  coupé par défaut ;
- le cas du SSO : un service **public** de la Forge se joint par le chemin public
  — l'ingress —, comme depuis Internet, et par rien d'autre. L'ouverture bornée de
  l'ingress aux cellules, analysée au journal, reste nécessaire et devient
  **cohérente** avec l'isolation plutôt que contraire à elle (§4.4).

## 1. Ce qui est mesuré, ce qui est lu, et ce qui ne l'est pas

**Mesuré** — relevé du 2026-09-14 en lecture seule sur la Forge de validation,
repris de `docs/EXPLORATION_EGRESS.md` §0, et lecture du code du dépôt :

| Fait | Source |
|---|---|
| Toutes les cellules partagent un seul bridge, `sparkbr0`, `10.77.0.0/24`, avec NAT et une plage DHCP restreinte | `forge_install.phase_foundation`, `services/sparkd/src/sparkd/forge_install.py` |
| Aucune ACL n'existe ; rien ne filtre entre cellules | `incus network acl list` vide, 2026-09-14 |
| Aucune cellule ne porte `security.ipv4_filtering` ni `security.mac_filtering` | `incus config show sso-p2enjoy`, 2026-09-14 |
| Le bridge n'a pas d'IPv6 | `ipv6.address: none` |
| La remontée d'une cellule vers la Forge est fermée : `table inet spark_filter`, hook `input`, `iifname "sparkbr0" drop` après DNS, DHCP, ICMP et connexions établies | `forge_install.py`, §48 du DAT |
| L'`eth0` d'un Spark est rendue par le produit, avec `limits.max` et `ipv4.address` attribuée par le registre | `translate.py`, §15.1 du DAT |
| Un port publié est un **device `proxy`** d'Incus, `listen tcp:0.0.0.0:<port>` → `connect tcp:<ip privée>:<port>`, et non une règle netfilter posée par `sparkd` | `ports.py`, §39.4 du DAT |

**Lu le 2026-09-17** dans la référence des devices NIC d'Incus, et **non mesuré
sur la Forge** — un type `bridged` porte :

- `security.port_isolation` (bool, défaut `false`) — « *Prevent the NIC from
  communicating with other NICs in the network that have port isolation
  enabled* » ;
- `security.ipv4_filtering` — « *Prevent the instance from spoofing another
  instance's IPv4 address (enables `security.mac_filtering`)* » ;
- `security.mac_filtering` — « *Prevent the instance from spoofing another
  instance's MAC address* » ;
- `security.acls` — liste d'ACL réseau à appliquer.

La référence ne dit pas si `security.port_isolation` s'applique **à chaud** sur
une instance qui tourne, ni ce qu'elle exige du noyau.

**Une correction à `docs/EXPLORATION_EGRESS.md` §6**, qui disait le latéral
« autorisé par `fwd.sparkbr0` ». C'est imprécis : deux cellules d'un **même
bridge Linux échangent leurs trames en couche 2**, sans passer par le hook
`forward` de la Forge — sauf si `br_netfilter` y est chargé, ce qui n'est pas
mesuré. `fwd.sparkbr0` ne concerne que ce qui est **routé** : la sortie vers
Internet, et le retour de l'ingress. Conséquence directe : **couper le latéral
n'est pas une règle `inet forward`**, ou pas seulement (§4.1).

**Non mesuré, et il ne faut pas le présenter autrement :**

- `br_netfilter` est-il chargé sur la Forge ? S'il l'est, le trafic de couche 2
  traverse aussi les hooks IP, et la conception des règles change ;
- `security.port_isolation` coupe-t-il effectivement `A → B` tout en laissant le
  DNS, le NAT et l'ingress intacts ? S'applique-t-il à chaud ?
- un `drop` en `forward` survit-il à l'`accept` explicite d'Incus, et
  `security.ipv4_filtering=true` ferme-t-il bien l'usurpation ? Les deux mesures
  déjà dues par `docs/EXPLORATION_EGRESS.md` §9 ;
- **quels Sparks se parlent aujourd'hui ?** `conntrack` en lecture seule le dit.
  C'est le risque de la migration : couper le latéral casse ce qui s'y appuie ;
- le coût : aucun relevé de débit ou de latence.

## 2. Les mots

**« VPN »** est une image, pas un mécanisme : il n'y a ni tunnel, ni
chiffrement, ni pair distant — c'est un **commutateur interne à la Forge**. Le
produit dira **réseau privé**. Le modèle laisse la place à une *sorte* de réseau
portée par un tunnel — deux Forges, un jour — mais « un seul serveur » est une
limite connue, et ce n'est pas le sujet.

**« Pont », « private link »** : le produit dira **lien privé**. Ce n'est pas un
pont entre deux réseaux — un pont les fusionnerait, ce qui est le contraire de la
demande — mais **un point d'entrée** : un port d'un Spark, publié **dans** un
réseau.

## 3. Le modèle : trois objets, une seule notion de portée

Conforme au §4 de `CLAUDE.md` : tout existe au niveau général, le contexte ne
définit que sa différence. Le Spark reste l'objet de première classe ; réseaux et
liens paraissent dans son dossier **et** dans un catalogue de la Forge.

**L'isolation par défaut n'est pas un objet.** C'est l'absence de joignabilité
entre cellules. Chaque Spark garde `eth0` sur `sparkbr0` — c'est sa sortie
Internet, son résolveur, l'ingress, ses ports publiés, le rebond SSH — mais cette
`eth0` est **isolée** de ses voisines (§4.1).

**Le réseau privé** est un objet de la Forge : un nom, un sous-réseau **attribué
par le registre** sur un pool, comme les adresses le sont au §15.1, une note,
des membres. Un membre est un Spark et une adresse **sur ce réseau**, attribuée
par le registre elle aussi. Le réseau est de **couche 2 seulement** : il ne mène
ni à Internet, ni à `sparkbr0`, ni à un autre réseau privé. Un Spark peut être
membre de plusieurs réseaux.

**Le lien privé est un port publié dont la portée n'est pas Internet.** C'est le
point qui économise un concept. Aujourd'hui, un port publié (§39) a une portée
implicite — Internet, `listen tcp:0.0.0.0:<port>`. Un lien privé est le **même
objet** avec pour portée un réseau privé : la Forge écoute sur **son adresse à
elle sur ce réseau**, et relaie vers l'adresse privée du Spark qui expose. Les
membres du réseau joignent `<passerelle du réseau>:<port>`, et rien d'autre du
Spark exposé — ni de son propre réseau.

« Attacher ce port au réseau de cet autre Spark » se lit alors sans cas
particulier : **la portée d'un lien est toujours un réseau**, et un réseau à un
seul membre est un réseau valide. Si le Spark consommateur n'en a pas encore, le
geste en crée un avec lui pour seul membre.

Esquisse, dans la forme de `docs/SCHEMA.md` :

```
private_network        (id, name UNIQUE, cidr UNIQUE, note, created_at)
private_network_member (network_id FK CASCADE, spark_id FK CASCADE,
                        ipv4_address, applied_at,
                        PRIMARY KEY (network_id, spark_id))
published_port         + scope : 'internet' | <network_id>
                       UNIQUE (scope, public_port)   ← remplace UNIQUE (public_port)
```

L'unicité reste portée par la **base**, comme au §18.4 et au §39.5 : un port
n'est unique que **dans sa portée** — le `5432` d'un réseau privé ne dispute rien
au `5432` d'un autre. La cascade sur `spark_id` suit celle des routes et des
ports : une adhésion ou un lien qui survivrait à son Spark serait un chemin vers
rien.

## 4. Réalisations envisagées, et ce qu'elles coûtent

Un principe déjà en place dans le dépôt commande le partage des rôles, et il vaut
d'être nommé : **ce qui change avec le registre passe par Incus** — devices,
configuration d'instance, réseaux gérés —, **ce qui est posé une fois passe par
l'installateur** — `table inet spark_filter`, `spark-firewall.service`. C'est le
§39.4 (« un device `proxy`, pas du netfilter ») et le §48.2 bis (« la règle est
posée par l'installation ») lus ensemble. `sparkd` ne pilote pas netfilter à
l'exécution ; il pilote Incus.

### 4.1 L'isolation — trois voies

**I1 — Isolation de port, anti-usurpation, et un verrou de couche 3.** Sur
l'`eth0` de chaque Spark, rendues par `translate.py` comme `ipv4.address` l'est
déjà : `security.port_isolation=true`, `security.ipv4_filtering=true` (qui
emporte `mac_filtering`). L'isolation de port est un **drapeau du bridge du
noyau** : deux ports isolés ne s'échangent aucune trame — pas d'ARP, donc pas
d'IP —, tandis que chacun parle au bridge lui-même, c'est-à-dire à la Forge :
DNS, DHCP, NAT et ingress restent intacts. C'est structurel, pas un filtre.

Il reste **un détour**, et il faut le fermer : un locataire `root` peut poser
dans sa cellule une route vers le voisin **via `10.77.0.1`**. La trame va alors
au port de la Forge — non isolé —, la Forge **route** le paquet et le réémet sur
`sparkbr0` vers le port isolé de la cible, ce que l'isolation de port autorise.
Ce chemin, lui, traverse le hook `forward` : une règle **statique** de
l'installateur, dans `spark_filter`, le ferme — `iifname "sparkbr0" oifname
"sparkbr0" drop`. Une seule règle, posée une fois.

Coûts : aucune migration d'adresse ; deux propriétés par device et une règle ;
mais **deux mécanismes** au lieu d'un, et deux mesures dues (§6 : l'application
à chaud, la survie du `drop` en `forward`).

**I2 — Un bridge par Spark.** L'isolation devient topologique : rien à filtrer,
rien à ordonner. Mais autant de bridges et de `dnsmasq` que de Sparks, un modèle
d'adressage à refaire — un sous-réseau par Spark et non une adresse dans
`10.77.0.0/24` —, une migration des adresses du parc que l'ingress et les ports
publiés désignent, et `spark_filter` à généraliser à une famille d'interfaces.
Plus lourd ; à garder si I1 échoue à la mesure.

**I3 — ACL Incus par NIC.** C'est du filtrage, avec la dette de mesure que
`docs/EXPLORATION_EGRESS.md` §0 note déjà — ce que les ACL de bridge filtrent
réellement n'a pas été vérifié —, et un filtre peut être mal ordonné là où une
topologie ne le peut pas. Non retenue en première intention.

**Proposé à l'arbitrage : I1**, sous réserve des mesures du §6.

### 4.2 Le réseau privé

Un **réseau géré d'Incus par réseau privé** — un bridge de plus sur la Forge,
nommé par le produit dans la limite des 15 caractères d'un nom d'interface —,
sans NAT, sans IPv6, avec son `dnsmasq` : c'est lui qui distribue aux membres les
adresses **statiques** que le registre a attribuées, par le même mécanisme que
sur `sparkbr0`, et c'est lui qui leur donne **des noms** — Incus inscrit chaque
instance dans le résolveur de son réseau. Les membres d'un réseau se joignent
donc par nom, sans travail supplémentaire du produit ; à vérifier, mais c'est
une propriété acquise, pas à construire.

Un membre reçoit un **second device NIC**, `eth1` et suivants, rendu comme
`eth0` : adresse du registre, `security.ipv4_filtering=true`, et **sans**
isolation de port — c'est le point du réseau. Le plafond de débit de cette
interface se décide (§8).

Côté Forge, un bridge de plus est une interface de plus, et `spark_filter` doit
la couvrir : en `input`, le même `drop` après DNS, DHCP et ICMP — sinon la porte
que le §48.1 a fermée se rouvre par le réseau privé ; en `forward`, `iifname
"<réseaux privés>" drop` sans exception : **un réseau privé n'est une route vers
rien**, ni Internet, ni `sparkbr0`, ni un autre réseau. Entre membres, le trafic
est commuté en couche 2 et ne passe pas par là.

Dans la cellule, `eth1` apparaît. Les conteneurs du locataire l'atteignent par le
routage de la cellule, comme ils atteignent `eth0` ; pour **servir** sur le
réseau, le locataire publie sur la cellule, comme aujourd'hui. C'est un chapitre
du manuel, pas du code.

Un Spark **protégé** (§35) refuse l'attachement et le détachement, comme il
refuse une route ou un port. Supprimer un Spark emporte ses adhésions et ses
liens. Supprimer un réseau qui a des membres : refusé, ou détache en journalisant
— à trancher (§8).

### 4.3 Le lien privé

Le précédent du §39.4 s'applique tel quel : un **device `proxy`** posé sur le
Spark qui expose, `listen tcp:<adresse de la Forge sur le réseau>:<port>` →
`connect tcp:<ip privée du Spark>:<port cible>`, nommé pour que l'appartenance se
lise dans `incus config show`. La carte des devices d'un Spark est **régénérée**
entière, jamais rapiécée — la règle du §39.4, pour la même raison.

Le point dur est le **pare-feu**, et il révèle une tension entre deux principes
du dépôt. Le `drop` de `spark_filter` en `input` ferme la Forge aux cellules ;
un lien demande qu'un port de la Forge, sur un réseau privé, s'ouvre — et
`sparkd` ne pose pas de règle netfilter (§39.4). Trois façons d'en sortir :

- **(a) une règle par lien**, posée par `sparkd` — contraire au §39.4 ;
- **(b) tout accepter vers la passerelle sur les réseaux privés**, statiquement.
  Écarté : `sshd` se lie sur toutes les adresses, et c'est **précisément** la
  porte du §48.1, rouverte par chaque réseau privé ;
- **(c) le device `proxy` en mode `nat=true`.** Incus pose alors lui-même une
  traduction d'adresse, dans **sa** table, et le flux traverse `prerouting` puis
  `forward` — plus `input`. Une **seule règle statique** de l'installateur
  suffit, avant les `drop` du hook `forward` : `ct status dnat accept` — « tout
  flux qu'Incus a traduit est un lien que le produit a créé ». L'état par lien
  reste dans Incus, la règle est posée une fois. Ce mode **conserve l'adresse
  source** du consommateur — le Spark exposé voit le membre, pas la Forge —, et
  exige une adresse statique sur la NIC, que le §15.1 garantit.

**Proposé à l'arbitrage : (c)**, sous réserve de mesure (§6). Un **nom** pour le
lien dans le résolveur du réseau — `<lien>.<réseau>` — est une commodité
ultérieure, pas une condition.

### 4.4 Le SSO d'aujourd'hui dans ce modèle

Un service **public** se joint par le chemin public. Le Spark qui parle au SSO
doit atteindre l'ingress de sa Forge comme n'importe quel visiteur : même vhost,
même TLS, même refus `404` sur un domaine non routé. C'est l'ouverture **bornée
aux ports de l'ingress** dans `spark_filter` — sans DNAT, puisque Caddy écoute
déjà sur l'adresse publique, et sans `MASQUERADE`, puisque l'adresse source de la
cellule doit rester lisible. Le 22, le 9876 et le 2019 restent fermés ; le
préflight `NET-REMONTEE` devra lire les **règles effectives** et non une
étiquette, sinon il ne verrait pas une ouverture trop large.

Un lien privé n'est **pas** l'outil pour l'OIDC : il faudrait que la cellule du
SSO termine elle-même le TLS avec un certificat valide pour le nom public, et que
ce nom se résolve vers le lien depuis le réseau du consommateur — deux contraintes
que le chemin public n'a pas. Le lien privé est l'outil de Postgres, de Redis, de
SMTP entre Sparks : ce qui ne prononce pas de nom (§39.1).

## 5. Ce que cela change dans le produit

- **Registre** — deux tables et une colonne (§3), une migration, les cascades ;
  un **pool de sous-réseaux** à côté du pool d'adresses (`addressing.py`), et un
  pool d'adresses par réseau. Les pools de la Forge (SPK-22) montrent le
  nouveau ;
- **`translate.py`** — les propriétés de sécurité d'`eth0`, les NIC
  supplémentaires, la portée des devices `proxy`. Tout reste une **fonction pure
  du registre**, testable par comparaison à un témoin ;
- **`forge_install.phase_foundation`** — `spark_filter` gagne une chaîne
  `forward` et couvre une famille d'interfaces ; toujours idempotent, toujours
  persisté par `spark-firewall.service` ;
- **préflight** — un contrôle de posture d'isolation qui lit les drapeaux
  **effectifs** des NIC et les règles effectives, pas une étiquette ;
- **API** — `/v1/networks`, ses membres, et `/v1/ports` qui gagne une portée ;
- **console** — un catalogue « Réseaux privés » côté Forge, membres et liens ; une
  facette « Réseau » au dossier du Spark — adresse, état d'isolation, adhésions,
  liens exposés et consommés ; des gestes avec confirmation, refusés sur un Spark
  protégé ; `docs/DESIGN_SYSTEM.md` si un composant naît ;
- **journal d'audit** — une action par geste : créer et supprimer un réseau,
  attacher et détacher, publier avec portée ;
- **seed** — un réseau de démonstration à deux membres, un lien, et un Spark
  isolé qui ne joint rien d'autre ;
- **tests** — unitaires sur les rendus ; API sur les refus, l'unicité par portée,
  les cascades, le Spark protégé ; E2E par le parcours canonique **et** une
  preuve depuis l'intérieur des cellules : `B` joint `A:<port>`, `B` ne joint ni
  `A:<autre port>` ni `C`, un Spark isolé ne joint rien que l'Internet et
  l'ingress ;
- **documents** — une section du DAT, `docs/SCHEMA.md`, un chapitre du manuel
  pour le locataire (« ce qu'`eth1` est, comment s'en servir »),
  `docs/PROD_MIGRATIONS.md` pour la migration du parc, et les limites connues du
  README, dont deux entrées ont été ajoutées le 2026-09-17.

**La migration du parc est un changement de comportement.** Elle est précédée du
relevé `conntrack` (§6), appliquée **par le produit** Spark par Spark — jamais à
la main, c'est la décision du §48.2 bis —, avec un état visible tant qu'elle
n'est pas complète : une Forge à moitié migrée doit se lire comme telle.

## 6. Préalables et mesures

En **lecture seule**, sans instruction particulière :

1. `br_netfilter` est-il chargé sur la Forge ?
2. `conntrack` : quels flux Spark ↔ Spark existent aujourd'hui ?

En **écriture** sur la Forge de validation — donc sur instruction explicite du
responsable (§9 de `CLAUDE.md`), et réversibles :

3. `security.port_isolation=true` sur l'`eth0` d'un Spark d'essai : s'applique-t-il
   à chaud, coupe-t-il `A → B`, laisse-t-il DNS, NAT et ingress intacts ?
4. un `drop` en `forward` dans `spark_filter` survit-il à l'`accept` explicite
   d'Incus ? — dû depuis `docs/EXPLORATION_EGRESS.md` ;
5. `security.ipv4_filtering=true` ferme-t-il l'usurpation d'adresse ? — dû aussi ;
6. un device `proxy` en `nat=true` écoutant sur l'adresse de la Forge d'un bridge
   privé : le flux est-il bien traduit, et `ct status dnat` le voit-il ?

## 7. Ordre proposé

1. **L'ouverture bornée de l'ingress aux cellules** — petite, indépendante, et
   elle débloque un Spark déployé. Sa propre unité, avec l'amendement du §48.1
   qu'elle suppose.
2. Les mesures 1 à 5, puis **l'isolation** (I1) et la migration du parc.
3. **Le réseau privé.**
4. **Le lien privé**, c'est-à-dire la portée du port publié, après la mesure 6.
5. Plus tard, les règles de sortie de `docs/EXPLORATION_EGRESS.md` : même table,
   mêmes priorités, aucune contradiction.

## 8. Les questions à arbitrer

1. **Les mots** — « réseau privé » et « lien privé » à l'écran ?
2. **La portée d'un lien est-elle toujours un réseau**, un réseau à un seul membre
   étant valide — ou faut-il une portée « ce Spark » distincte ?
3. **L'adresse source vue par le Spark exposé** — celle du membre (`nat=true`) ou
   celle de la Forge ? Cela décide de ce que le locataire peut mettre dans ses
   listes d'accès et lire dans ses journaux.
4. **Le débit des interfaces privées** — sans plafond, ou le même que l'`eth0` ?
5. **Supprimer un réseau qui a des membres** — refus, ou détachement journalisé ?
6. **La migration** — une opération explicite sur tout le parc après le relevé
   `conntrack`, ou un choix par Spark pendant une transition ? Proposé : une
   opération, avec un état « non encore isolé » visible entre-temps.
7. **Les noms entre membres** dès la première version — Incus les donne ; à
   vérifier, puis à promettre ou non.

Tant que ces questions ne sont pas tranchées et que les mesures du §6 ne sont pas
faites, ce document ne peut pas devenir une spécification.
