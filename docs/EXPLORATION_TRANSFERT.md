# Exploration — transférer un Spark d'une Forge à une autre

**Statut : exploratoire. Non planifié.** Cadrage avec le responsable du 2026-11-16 au
2026-11-17.

Ce document n'est ni une spécification, ni un contrat. Il conserve une piste étudiée et
les arbitrages qui l'ont façonnée, pour que la réflexion ne soit pas à refaire le jour où
le sujet devient une unité. **Rien ici n'est implémenté, rien n'est mesuré au-delà de ce
que SPK-160 a déjà mesuré, et aucun code du dépôt n'y renvoie.**

Il ne figure donc ni dans `docs/DAT.md`, qui décrit l'architecture réelle, ni dans
`docs/SCHEMA.md`, ni dans `docs/BACKLOG.md`, sauf comme renvoi depuis la section
*Réservé*. **Aucun identifiant SPK n'est réservé** : une unité future prendra des
identifiants neufs.

---

## 1. La question

« Avec l'implémentation actuelle de `sparkd`, est-il possible de transférer un Spark d'une
Forge à une autre ? » Le responsable a demandé une exploration, pas du code.

## 2. La réponse aujourd'hui : non

Relevé dans le dépôt le 2026-11-16, pas déduit :

- le pilote Incus (`services/sparkd/src/sparkd/incus.py` : `IncusClient`,
  `UnixSocketIncus`, `FakeIncus`) sait créer, démarrer, arrêter, prendre un instantané,
  restaurer et supprimer. Il ne sait **ni exporter ni importer** une instance ;
- le README, dans ses limites connues, dit « Un seul serveur. Aucun ordonnancement
  inter-machines » ; le backlog range « Multi-serveurs » dans *Réservé, non planifié* ;
- le registre ne distingue pas deux Forges : `forge.id` vaut toujours `1`. L'identifiant
  stable `forge.uid` est prévu par SPK-161 et n'existe pas encore.

## 3. Ce qui existe déjà en contrat : le lot 9

La sauvegarde externe (DAT §67, SCHEMA §8 bis, SPK-160 à SPK-168) porte l'essentiel des
briques d'un transfert. Seul SPK-160, la mesure, est avancé (`[~]`) ; SPK-161 à SPK-166 et
SPK-168 ne sont pas commencés.

| Brique | Où | Ce qu'elle apporte au transfert |
|---|---|---|
| Génération : export Incus optimisé + manifeste | §67.2 | le disque et **tous** les instantanés en un flux `zfs send`, blocs partagés non répétés (mesuré : +0,7 % au-dessus des données utiles) |
| La fiche | §67.2 | tout ce que le registre sait du Spark : ressources, mode CPU, clés autorisées, routes, ports, environnement et secrets, notes, projet, réseaux par nom ; une preuve garde la fiche complète |
| Disposition sur le S3 | §67.3 | un préfixe par Forge, plusieurs Forges par bucket |
| Chiffrement STREAM AES-256-GCM | §67.4 | le fournisseur S3 ne lit rien ; troncature, permutation et mauvaise clé refusées |
| Batterie de vérifications V1–V12 | §67.6 | savoir qu'un S3 est utilisable **et** avec quels droits, de chaque côté |
| Récupération, y compris « une autre Forge » | §67.11 | contrôles sans écriture, admission control par la fonction de création, registre d'abord, import en flux comparé au SHA-256, fiche rattachée ligne par ligne avec chaque conflit rapporté, Spark rendu arrêté, rapport |

Faits mesurés par SPK-160 sur la VM du banc (Incus 7.6.0, ZFS 2.4.1), utiles ici :

- l'import dans un pool **détruit puis recréé** fonctionne (8,7 s pour 3,5 Gio) ;
- l'import sous un autre nom restitue les cinq instantanés, restaurables ;
- l'import conserve `volatile.eth0.hwaddr`. Sur la même Forge, cela empêche une copie de
  démarrer à côté de son original ; entre deux Forges, les ponts sont distincts et la
  question ne se pose pas — **non mesuré** entre deux Forges ;
- un export de Spark en marche donne l'état d'un arrêt brutal (§19.2).

**Conclusion :** « exporter sur A, récupérer sur B » est déjà, en contrat, une **copie à
froid**. Ce n'est pas encore un transfert.

## 4. Ce qui sépare « récupérer » de « transférer »

1. **La mise au repos.** La dernière génération doit être prise **Spark arrêté** :
   sinon la copie est celle d'un arrêt brutal, et ce qui s'écrit sur A après l'export est
   perdu.
2. **La bascule publique.**
   - Le DNS : les enregistrements `A`/`AAAA` désignent l'adresse publique de A. La
     console tient le jeton DNS (§38.1) et sait déjà lister ce qui pointe vers une Forge
     (§38.8).
   - Le TLS : le certificat se réémet sur B, et l'émission HTTP-01 exige que le DNS
     désigne déjà B.
   - Les ports publiés : un numéro libre sur A peut être pris sur B.
   - Les réseaux privés et les liens : ils s'arrêtent à la Forge (§58, §59). Un membre
     transféré perd ses pairs.
   - L'accès SSH : le rebond change de Forge. La clé d'hôte du Spark, elle, voyage avec
     sa racine.
3. **Le sort de la source** et la trace d'audit **des deux côtés**.

## 5. Trois transports envisagés

| Transport | Pour | Contre | Retenu |
|---|---|---|---|
| **S3 relais** | réemploie le lot 9 ; aucune confiance entre Forges ; rien de neuf exposé | indisponibilité = export complet + envoi + téléchargement + import | **oui** |
| Migration Incus directe (`incus copy --refresh`, tunnel SSH) | incrémentale, indisponibilité courte | A obtient l'API Incus de B, c'est-à-dire `root` sur B ; rompt la surface 22/80/443 et la règle « `sparkd` ne parle à Incus que par la socket » (§5.1) | non |
| Flux par la console | ni S3 ni confiance entre Forges | tout le volume passe par le lien du poste | non |

## 6. Les arbitrages du responsable (2026-11-17)

| Question | Décision |
|---|---|
| Scénarios | déplacer **un** Spark entre deux Forges en service ; **évacuer** une Forge entière ; la **reprise sur sinistre**, déjà couverte par le lot 9 |
| Indisponibilité acceptable | **à froid**, de quelques minutes à une heure. Pas de pré-copie incrémentale |
| Transport | **le S3 comme relais**, avec une **poignée de main à deux bouts dans l'interface** : A propose d'envoyer, B accepte de recevoir, chacun vérifie les paramètres de l'autre et les droits sur le S3 ; quand tout est vert, le transfert se lance **depuis l'un ou l'autre bout** |
| Qui tient les deux bouts | **un même propriétaire, une seule console** (`servers.json`). La console porte l'offre et l'acceptation entre ses deux tunnels ; les Forges ne se parlent jamais |
| Quel S3 | **la destination de sauvegarde externe**, quand les deux Forges partagent le bucket ; sinon un S3 temporaire saisi des deux côtés et éprouvé par la même batterie |
| Chiffrement | **une clé d'appairage éphémère** : chaque `sparkd` produit une paire de clés à usage unique, la console échange les clés publiques, chacun dérive la même clé de transfert, et **les deux écrans affichent le même code court** que le propriétaire compare. La clé de sauvegarde de A ne quitte jamais A |
| Bascule | **complète, conduite par la console** : DNS repointé, TLS attendu sur B, routes vérifiées |
| La source | **gardée arrêtée sur A** comme retour arrière. Sa destruction est un **geste séparé et confirmé**, jamais l'étape finale d'une file — même règle que « jamais de destruction différée » (§67.8) |

## 7. L'esquisse qui en découle

*Une esquisse, pas un contrat : elle dit la forme que prennent les arbitrages, pour que
la future spécification parte de là.*

**Le déroulé.** Chaque étape est visible, se défait à l'échec, et dit où elle s'est
arrêtée.

1. **L'offre, sur A.** Le propriétaire choisit le Spark et la Forge de destination dans
   le catalogue de la console. Mot de passe de garde si le Spark est protégé (§35). La
   console remet l'offre à B.
2. **L'acceptation, sur B.** B fait ses contrôles **à blanc**, sans rien écrire :
   - capacité et mode CPU, par la fonction d'admission de la création ;
   - nom, domaines et ports libres ;
   - versions d'Incus et de ZFS compatibles avec celles de A ;
   - droits sur le S3, V1 à V9, **des deux côtés** ;
   - réseaux privés et liens **rapportés** : ils ne se transportent pas dans la première
     version.

   Si tout est vert, l'appairage se fait et le code s'affiche des deux côtés.
3. **Le lancement**, depuis le bouton de A **ou** celui de B :
   - A arrête le Spark — l'indisponibilité commence ;
   - A écrit une génération **de transfert** sous un préfixe propre, `transferts/<id>/`,
     que l'inventaire de la sauvegarde externe ne confond pas avec une sauvegarde ;
   - B l'importe en flux, vérifie l'empreinte, applique la fiche et démarre le Spark.
4. **La bascule**, par la console :
   - le DNS est repointé vers B, à partir de l'inventaire du §38.8 ;
   - la console attend le certificat sur B, puis vérifie chaque route par le diagnostic
     du §18.7 ;
   - A passe dans un **état nommé**, « transféré vers B », qui refuse le démarrage
     ordinaire. « Reprendre ici » est le retour arrière : il redémarre A et remet le DNS.
5. **La clôture.**
   - Les objets de transfert sont purgés du S3 : un transfert n'est pas une sauvegarde.
   - B prend sa propre première génération de sauvegarde, sous son propre préfixe.
   - La destruction de la source reste un geste à part.

**L'identité.** Le `spark_id` est conservé sur B, où il est libre. L'adresse privée est
réattribuée par le plan d'adressage de B (§15.3) : une note qui citait l'ancienne devient
fausse, et le rapport doit le dire.

**La trace.** Journal d'audit des deux côtés, et notification hors bande pour l'offre,
l'acceptation, le lancement, la bascule et le retour arrière. Cela ajoute des actions à la
liste fermée du §47.2.

**L'évacuation.** Une file **série** de transferts, un export à la fois sur la Forge
(§67.7), chaque Spark avec sa propre bascule.

**La dépendance.** Le transfert se bâtit sur SPK-161 (destination, `forge.uid`), SPK-162
(génération, fiche, chiffrement), SPK-166 (récupération) et SPK-168 (restauration par le
volume). Il s'ordonne donc **après** le lot 9.

## 8. Ce qui reste ouvert

Non arbitré, à trancher avant toute spécification :

1. Lors d'une **évacuation complète**, faut-il recréer par nom sur B les réseaux privés et
   les liens dont tous les membres partent ensemble ?
2. Combien de temps une **offre non acceptée** reste-t-elle valable ?
3. Que fait la console si elle **perd l'un des deux tunnels** en pleine bascule ? Le
   transfert doit pouvoir être repris depuis l'autre bout, qui lit l'état dans le
   registre de sa Forge.
4. Le temps de **propagation du DNS** (TTL) s'ajoute à l'indisponibilité. Faut-il baisser
   le TTL avant l'offre ?
5. Le **coût pour les Sparks voisins** d'un export sur les disques mécaniques de la Forge
   reste à mesurer (critère (c) de SPK-160). Une évacuation en enchaîne plusieurs.
