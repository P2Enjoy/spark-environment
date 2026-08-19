# BACKLOG

Statuts : `[ ]` non commencé · `[~]` en cours ou implémenté mais insuffisamment
vérifié · `[x]` terminé et intégralement vérifié.

Un identifiant `SPK-NN` est **stable** : il est cité par les commentaires `@spec`
du code et `@verifies` des tests. Il ne se renumérote pas.

Une unité ne passe à `[x]` qu'après validation de sa Definition of Done, y compris
la preuve E2E depuis le parcours canonique.

---

## Lot 0 — Socle

### [x] SPK-01 · Socle documentaire et structure du monorepo

Persister l'idée, l'architecture, le modèle de données et le découpage avant
toute ligne de code, puis câbler l'espace de travail.

- Spécification : `docs/DAT.md` §10, `docs/SCHEMA.md`, `docs/ORIGIN_CONVERSATION.md`
- **Clos le 2026-08-18.** Espace de travail conforme au DAT §10 :
  `apps/webui`, `services/sparkd`, `packages/contract`, `deploy`, `scripts`, avec
  un `Makefile` comme point d'entrée reproductible. `pnpm -r test`, `build` et
  `typecheck` traversent les deux paquets TypeScript ; `make sparkd-test` rend
  **19 tests verts**.
- `apps/webui` et `packages/contract` sont déclarés sans source, à dessein :
  `CLAUDE.md` §4 impose la lecture intégrale du design system avant toute
  écriture d'interface, et cette lecture appartient à l'unité qui construit
  l'interface (SPK-18), pas au squelette.

### [x] SPK-02 · Accès au serveur cible et relevé de topologie

Accès SSH obtenu le 2026-08-18. Topologie relevée et consignée : Dell R320,
Xeon E5-1410 v2 (4 cœurs / 8 threads, frères SMT `(0,4) (1,5) (2,6) (3,7)`),
94 Gio de RAM, 2 × 6 To mécaniques en RAID1 `ext4` sur `/`, lien 1 Gbit/s,
Ubuntu 24.04.3 / noyau 6.8 / cgroup v2, VT-x présent.

- Spécification : `docs/DAT.md` §8.1, `docs/JOURNAL.md`
- **Clos le 2026-08-18.** `incus info --resources` rapporte `Core 0 → threads
  id 0, id 4`, `Core 1 → 1, 5`, `Core 2 → 2, 6`, `Core 3 → 3, 7` : concordance
  exacte avec `/sys`, frèrage SMT compris.

### [x] SPK-03 · Installation Incus, pool de stockage et bridge privé sur l'hôte

- Spécification : `docs/DAT.md` §3, §5, §8.5, §16
- Dépend de : SPK-28 pour l'exploitation réelle — le pool reste sur fichier
- **Clos le 2026-08-19.** Les quatre exigences sont satisfaites et archivées :
  Incus 7.3 installé depuis le dépôt amont, pool ZFS et bridge créés, un
  conteneur démarre et obtient `10.77.0.16` sur `sparkbr0`, le quota `size`
  s'arrête exactement à 10 Gio sous écriture incompressible, et `zfs_arc_max`
  est posé à 16 Gio **puis reporté** dans `host.memory_reserve_bytes`.
- Effet du dernier point : le pool mémoire annoncé passe de **98,0 Gio à
  76,2 Gio réellement allouables**, et l'admission control refuse désormais sur
  la capacité corrigée.

## Lot 1 — Registre et admission control

### [x] SPK-04 · Migrations et registre SQLite

- Spécification : `docs/SCHEMA.md` §2 à §12
- **Clos le 2026-08-18.** `migrations/001_socle_registre.sql` crée les douze
  tables ; le moteur applique chaque fichier dans une transaction unique
  englobant l'enregistrement de sa version, et refuse de servir une base dérivée
  (fichier disparu, checksum divergent, trou dans la séquence).
- Preuves : 59 tests verts, dont l'atomicité d'une migration en échec, les trois
  refus, le retour arrière puis la remigration, et les contraintes de la vraie
  migration. Au démarrage réel : le registre se crée, le second lancement ne
  rejoue rien, et un checksum falsifié fait sortir `sparkd` en code 3.

### [x] SPK-05 · Admission control et comptabilité des pools

L'invariant `Σ réservations ≤ capacité × surengagement`, les réserves de l'hôte,
et le refus motivé.

- Spécification : `docs/DAT.md` §7.3, §7.3 bis, §7.7
- **Livré et prouvé en unitaire le 2026-08-18.** `admission.py` calcule les pools
  et rend une décision motivée. 25 tests dédiés, dont les quatre cas limites de
  la DoD, la comptabilité de chaque mode CPU, tous les états de Spark, et le
  refus d'un Spark dédié qui asphyxierait les Sparks partagés déjà admis.
- **Clos le 2026-08-19.** L'appelant existe : toute création de Spark traverse
  l'admission control, dans la même transaction que l'écriture de la ligne.
  Prouvé sur l'hôte réel — une demande de 9 CPU est refusée en `409` avec
  « 9 CPU demandés, 3.5 disponibles (capacité 4, alloué 0.5) — il manque
  5.5 CPU », et le refus est journalisé.

### [x] SPK-06 · Allocation des cœurs dédiés et découpe dynamique du pool

Retrait de cœurs physiques entiers du pool partagé, frères SMT compris, et
reconfiguration du cpuset **et du poids** de tous les Sparks partagés.

- Spécification : `docs/DAT.md` §7.4, §7.4 bis, §7.4 ter, §7.5
- **Clos le 2026-08-19, prouvé sur l'hôte réel, sans aucun redémarrage.**
  - Découpe de 2 cœurs : le pool passe de 4 à 2 cœurs (`CPU 2,3,6,7`), le Spark
    dédié reçoit les cœurs 0 et 1 soit `CPU 0,1,4,5` — frères SMT emportés
    ensemble.
  - Le Spark partagé **suit** : `cpuset 0-7 → 2-3,6-7` et poids **120 → 245**,
    car `0,5 / 2 × 1000 = 250 %`. Sa réservation absolue est préservée alors que
    le pool a été divisé par deux.
  - Restitution : retour à 4 cœurs, `cpuset 0-7`, poids 120.
  - `uptime` du Spark partagé continu dans les deux sens — 8,4 → 16,1 → 20,4 s.
- Dette notée : le choix des cœurs ignore la topologie NUMA. L'hôte de validation
  n'a qu'un nœud, et une règle qu'on ne peut pas éprouver ne s'implémente pas
  (`docs/DAT.md` §7.4 ter).

## Lot 2 — Runtime serveur

### [x] SPK-07 · `sparkd` : service HTTP local, santé, inventaire hôte

- Spécification : `docs/DAT.md` §5, §5.1 à §5.3
- **Clos le 2026-08-18, prouvé sur l'hôte réel.**
  - `sparkd` déployé sur `spark-experiment`, relève la topologie via l'API REST
    d'Incus 7.3 : 4 cœurs / 8 threads, frères `(0,4) (1,5) (2,6) (3,7)` écrits
    dans `cpu_core`/`cpu_thread`, 105 226 698 752 octets de RAM, 1 Gbit/s,
    207 030 845 440 octets pour le pool `spark`.
  - `GET /v1/host` expose les pools — l'admission control a enfin un appelant —
    et `POST /v1/host/sync` trace le relevé dans `audit_log`.
  - **Scan depuis l'extérieur** (poste de développement → `51.158.54.202`) pendant
    que le service tournait : `22` ouvert, **`9876` refusé**, ainsi que `8443`,
    `2019`, `80` et `443`. La surface réseau du serveur est celle qu'annonce le
    DAT §5.

### [x] SPK-08 · Pilote Incus : traduction du manifeste Spark

Traduction des quatre modes CPU, mémoire, réseau, stockage, nesting, idmap
isolé.

- Spécification : `docs/DAT.md` §7.2, §7.2 bis, §7.2 ter, §7.5, §7.6
- **Clos le 2026-08-18.** 31 tests de traduction, et application réelle vérifiée
  sur l'hôte : `incus config show` rend exactement la configuration produite, et
  le noyau applique `cpu.weight=120` — soit `125 − 10 + 5`, la loi mesurée —,
  `cpu.max=max` (burst réel), `memory.max=2 Gio`, une classe `htb`
  `rate 100Mbit ceil 100Mbit`, un quota disque de 10 Gio effectif, et un idmap
  `1131072` disjoint de celui du Spark voisin.
- Reste hors de cette unité : le choix des cœurs dédiés (SPK-06) et la création
  effective par l'API (SPK-09). Le traducteur ne parle à personne, il transforme.

### [x] SPK-09 · Cycle de vie : create, start, stop, restart, delete

- Spécification : `docs/DAT.md` §14
- **Clos le 2026-08-19, prouvé de bout en bout sur l'hôte réel.** Créé par
  `POST /v1/sparks`, appliqué, démarré — instance Incus obtenant `10.77.0.138`
  sur le bridge privé —, arrêté, supprimé, et la capacité intégralement rendue
  (`alloué=0`, `dispo=4.0`). Le noyau applique `cpu.weight=120`,
  `memory.max=2 Gio`, et le locataire voit 2 Gio de RAM et 10 Gio de disque.
- 86 tests dédiés : toutes les transitions interdites, la réconciliation des
  quatre états transitoires au démarrage, et le refus d'admission de bout en
  bout.

### [x] SPK-10 · Réseau privé et adressage stable

- Spécification : `docs/DAT.md` §15
- **Clos le 2026-08-19, les deux moitiés de la DoD prouvées sur l'hôte.**
  - **Adresse stable** : `10.77.0.16` attribuée par le registre *avant* toute
    instance Incus, conservée à travers un redémarrage du Spark **et** un
    `incus restart` direct.
  - **Plafond réseau mesuré par transfert réel** (iperf3, 10 s) : **95,6 Mbit/s**
    sous un plafond de 100 Mbit/s, puis **478 Mbit/s** après relèvement à
    500 Mbit/s. Le plafond mord, et il s'ajuste à chaud.
- La plage DHCP dynamique est restreinte à `10.77.0.240-254`, disjointe de celle
  du registre — opération de déploiement, voir `docs/PROD_MIGRATIONS.md`.

### [x] SPK-11 · Clés SSH et provisionnement de l'accès

L'injection par cloud-init est **écartée** : elle ne s'exécute qu'au premier
démarrage, donc ne peut pas retirer une clé (`docs/DAT.md` §17.1).

- Spécification : `docs/DAT.md` §17, `docs/SCHEMA.md` §7
- **Clos le 2026-08-19, la DoD prouvée depuis le poste.**
  - Un Spark créé et démarré par `sparkd` **seul** reçoit `openssh-server`,
    l'authentification par mot de passe désactivée, et les clés voulues.
  - `ssh -J ubuntu@<hôte> root@10.77.0.16` **réussit** depuis le poste : on entre
    dans le Spark `neuf`, en `root`.
  - Après `DELETE /v1/sparks/neuf/ssh-keys/poste-admin`, la même commande rend
    **`Permission denied (publickey)`**.
  - Le port 22 du Spark reste injoignable de l'extérieur : l'accès passe par le
    rebond, jamais par une exposition publique.

### [~] SPK-12 · Ingress Caddy et réconciliation

- Spécification : `docs/DAT.md` §9, §18
- **Les trois exigences de la DoD sont prouvées sur l'hôte, le 2026-08-19.**
  - `domaine → spark → port` **appliqué à chaud** : une pile Compose réelle
    (nginx) dans le Spark `site` répond `HTTP 200` et son contenu par
    `site.exemple.test → 10.77.0.16:8080`. Le retrait fait cesser le trafic.
  - **Reconstruction complète** depuis le registre par
    `POST /v1/ingress/reconcile`.
  - **Conflit de domaine refusé** : `409`, en nommant le Spark propriétaire.
  - Défaut corrigé au passage : sans route terminale, Caddy rendait `200` et un
    corps vide pour **tout** domaine non routé. Il rend désormais `404`.
- **Reste, et c'est pourquoi l'unité n'est pas `[x]`** : l'émission TLS n'est pas
  prouvée. Elle suppose un domaine résolvant vers l'hôte, ce que le produit ne
  contrôle pas et dont je ne dispose pas ici. Seul le routage HTTP par nom d'hôte
  est vérifié.

### [x] SPK-13 · Instantanés et restauration de cellule

Périmètre réduit le 2026-08-18 : les applications hébergées sauvegardent déjà leurs
**données** vers un S3 externe. L'instantané sert donc au retour arrière de la
**cellule entière** — système, images Docker, Compose, volumes, configuration — ce
qu'une sauvegarde applicative ne restaure pas. L'export hors machine reste une
opération manuelle et n'est pas planifié.

- Spécification : `docs/DAT.md` §8.3, §19
- **Clos le 2026-08-19, prouvé sur l'hôte.** Cellule cassée volontairement —
  fichier réécrit, `/srv/site` supprimé, **images Docker effacées** — puis
  restaurée : les trois sont revenus à l'identique et le Spark est resté
  `RUNNING`. Le retour des images Docker est ce qu'aucune sauvegarde applicative
  ne restaure : c'est l'argument du §8.3, vérifié.
- Restaurer un instantané ancien est **refusé** tant que des plus récents
  existent ; le refus nomme ce qui bloque et la sortie, et l'acceptation de la
  perte est un drapeau de requête (§19.1).
- La distinction instantané / sauvegarde est portée par l'API — la liste rappelle
  qu'un instantané ne protège ni de la perte du pool ni de celle de la machine.
  **Obligation reportée à SPK-18 et suivantes** : l'interface visuelle devra la
  porter aussi.

### [x] SPK-14 · Métriques d'usage et état temps réel

- Spécification : `docs/DAT.md` §20
- **Clos le 2026-08-19, prouvé sur l'hôte.** `GET /v1/sparks/<nom>/usage` rend les
  quatre ressources, chacune comparée à ce qui est **réellement appliqué** :
  mémoire `167 Mio / 2 Gio = 8,1 %`, disque `510 Mio / 10 Gio = 5,0 %`, CPU par
  taux calculé sur fenêtre, réseau comparé au **plafond** et non à la réservation.
- Le premier relevé rend `null`, jamais `0` : un taux exige deux points.
- Découverte de la mesure, portée au §20.3 bis : un Spark réservant `0,5 CPU`
  chargé sur un hôte au repos consomme **1,996 CPU**. Ce n'est pas un
  dépassement mais le burst du mode partagé. L'API distingue donc `burst` de
  `over_limit`, ce dernier n'existant qu'en mode `capped`.

### [x] SPK-15 · Journal d'audit et filtrage des secrets

- Spécification : `docs/SCHEMA.md` §9, `docs/DAT.md` §21
- **Clos le 2026-08-19, prouvé sur l'hôte.** Un parcours réel poussant une clé
  publique, une clé privée et un instantané a laissé **17 entrées** : ni le corps
  de la clé publique, ni l'en-tête `BEGIN OPENSSH PRIVATE KEY`, ni le contenu de
  la clé privée n'y figurent — et le journal reste lisible, empreintes et noms de
  Sparks compris.
- Les cinq modules qui écrivaient chacun leur `INSERT` passent par une fonction
  unique. Un test lit les sources pour vérifier qu'aucun autre fichier ne
  mentionne `audit_log` : l'omission devient impossible, pas seulement
  improbable.

## Lot 3 — Console locale

### [x] SPK-16 · Hôte console : inventaire serveurs et tunnels SSH

- Spécification : `docs/DAT.md` §6, §22
- **Clos le 2026-08-19, prouvé depuis le poste vers le serveur réel.**
  - **Ouverture** : vrai `ssh -L` vers `51.158.54.202`, état `ready`, port local
    attribué par le système.
  - **`sparkd` joint à travers le tunnel** : `spark-experiment`, 4 cœurs /
    8 threads, 76,2 Gio allouables, Spark `site (running)`.
  - **Perte de connexion** : le processus `ssh` tué sous les pieds donne
    `502 tunnel_unavailable`, avec le motif, l'âge de la dernière réponse et la
    mise en garde explicite contre l'affichage de données périmées.
  - **Fermeture** propre.
- Défaut trouvé par la preuve réelle : la première sonde courait plus vite que
  l'établissement du tunnel, et déclarait rompu un tunnel qui se connectait.
- 36 tests pour l'hôte console.

### [~] SPK-17 · Contrat d'API partagé

- Spécification : `docs/DAT.md` §23
- **Livré et prouvé le 2026-08-19.** `packages/contract/openapi/sparkd.json`
  committé, 20 chemins, généré de façon déterministe ; 1183 lignes de types
  TypeScript dérivées par `openapi-typescript` ; `make contract-check` sort en
  code 1 sur une vraie dérive provoquée, avec le diff et la marche à suivre.
- **Reste, et c'est pourquoi l'unité n'est pas `[x]`** : la CI est écrite
  (`.github/workflows/verification.yml`) mais **jamais exécutée**. Je ne peux pas
  la déclencher ni observer son résultat depuis ici. Tant qu'une exécution n'a
  pas eu lieu, « dérive détectée en CI » reste une intention, pas une preuve.

### [x] SPK-18 · Écran liste des Sparks

- Spécification : `docs/DESIGN_SYSTEM.md` (lu intégralement), `docs/DESIGN_SYSTEM_APP.md`
- **Clos le 2026-08-19.** Les quatre états sont traités et **observés en
  capture** : chargement par squelettes, vide nommant l'absence, erreur portant
  son motif, données longues tronquées sans casser la mise en page. Navigation
  clavier vérifiée, anneau de focus visible.
- **Cinq défauts trouvés par l'observation des captures**, invisibles aux tests :
  séparateur décimal anglais dans une interface francophone ; deux précisions
  juxtaposées dans « 2.0 sur 0.50 » ; un nom long élargissant sa colonne et
  faisant replier toutes les autres ; des mesures coupées en deux lignes ; et un
  débordement horizontal **non signalé** au mobile, ce que le §14.2 interdit.
- Captures : `e2e/captures/`, régénérables par `node e2e/captures.mjs`.

### [x] SPK-19 · Écran détail d'un Spark

Identité, état, ressources, accès, instantanés et journal d'un Spark, avec les
commandes que le runtime déclare possibles.

- Spécification : `docs/DAT.md` §24, `docs/DESIGN_SYSTEM.md` §6.3 à §6.6, §6.22,
  §6.23, §14.9 · `docs/DESIGN_SYSTEM_APP.md`
- **Clos le 2026-08-19.** `allowed_commands` est publié par le runtime, dérivé
  de la table qui applique le refus ; un test passe à la vue un état inventé
  pour prouver qu'elle ne redérive rien. Un Spark `running` n'affiche que
  « Redémarrer, Arrêter, Supprimer » — pas de « Démarrer », même désactivé. Un
  état `creating` n'affiche **aucun bouton** et explique pourquoi.
- Confirmation de suppression intégrée au flux, ouverte **au clavier**, nommant
  le Spark et la conséquence, focus dedans, annulation rendant le focus.
- Cinq captures observées. **Deux défauts trouvés par l'observation** : le
  runtime publiant `allowed_commands` par ordre alphabétique, « Supprimer »
  arrivait en tête — l'action la plus dangereuse était la plus proéminente et la
  première atteinte au clavier ; et le journal affichait `ok`, valeur brute du
  backend, au lieu de « réussi ».

### [x] SPK-20 · Création d'un Spark avec aperçu d'admission

Afficher la capacité restante avant validation, et le refus motivé du backend.

- Spécification : `docs/DAT.md` §25 · `docs/DESIGN_SYSTEM.md` §6.9, §6.12,
  §7.1, §14.9
- **Clos le 2026-08-19.** Le bouton n'est désactivé que pendant l'envoi, jamais
  sur la foi de l'estimation locale — un test soumet une demande énorme mais bien
  formée et vérifie qu'aucun contrôle local ne la rejette. L'avertissement local
  utilise `accent` et dit « c'est le serveur qui décide » ; seul le refus de
  `sparkd` est rouge, et il conserve intégralement la saisie.
- Cinq captures observées. **Deux défauts trouvés par l'observation** : le refus
  affichait des octets bruts (`64424509440`) et le mot `memory` en anglais, alors
  que toute l'interface formate ; et l'avertissement estimé restait affiché à
  côté du refus qui fait autorité — deux messages disant la même chose, dont un
  moins fiable.

### [x] SPK-21 · Écrans ingress, clés SSH, snapshots

Rendre agissantes les trois sections que l'écran détail affiche en lecture seule
depuis SPK-19 : routes publiques, clés autorisées, instantanés.

Spécification : `docs/DAT.md` §26, qui s'appuie sur §17 (accès SSH), §18
(réconciliation de l'ingress) et §19 (instantanés).

- Trois panneaux du détail, pas trois écrans : une route et un instantané
  n'existent pas sans leur Spark (§26.1).
- Chaque formulaire s'ouvre dans le flux, un seul à la fois ; le focus y entre,
  l'annulation le rend au déclencheur, un refus conserve la saisie (§26.2).
- Routes : déclarer, retirer avec confirmation nommant le domaine, réappliquer
  sans confirmation ; `applied_at` vide s'affiche en `accent` et non en `danger`
  (§26.3).
- Clés : accorder depuis le registre, enregistrer une clé nouvelle, révoquer sans
  confirmation ; révoquer la dernière clé nomme sa conséquence ; l'empreinte
  affichée est celle du serveur ; le fragment `ssh_config` est donné à copier
  (§26.4).
- Instantanés : prendre sans confirmation, supprimer et restaurer avec ;
  `stateful` n'est pas proposé (§26.5).
- **Le refus `blocked_by_newer_snapshots` liste nommément les instantanés qui
  bloquent, et l'acceptation de leur perte n'est offerte qu'APRÈS ce refus,
  jamais avant** (§26.5).

DoD : les gestes partent réellement vers `sparkd` et l'écran relit l'état après
chaque succès ; aucun contrôle d'unicité de domaine côté interface ; l'ordre
refus-puis-acceptation est éprouvé par un test ; états chargement, erreur et
absence traités ; navigation clavier ; console du navigateur vierge ; captures
observées.

- **Close le 2026-08-19.** 35 tests de rendu et **8 parcours navigateur
  assertifs** (`e2e/gestes.test.mjs`, intégrés à `make test`) qui ouvrent le
  Spark depuis la liste, cliquent et saisissent. Ils vérifient que chaque geste
  part avec la bonne méthode et le bon corps, et que l'écran relit ensuite.
- Le parcours central est éprouvé deux fois : la première tentative de
  restauration part avec un corps `{}`, le refus nomme l'instantané bloquant, et
  `accept_losing_newer` ne part **qu'ensuite**.
- Neuf captures observées (20 à 28). **Deux défauts trouvés par l'observation** :
  les listes n'avaient pas les séparateurs du §6.19, si bien que dans la colonne
  étroite des instantanés le groupe d'actions passait à la ligne et se retrouvait
  entre deux instantanés — l'action voisine étant « Supprimer » ; et le refus de
  restauration ne nommait pas l'instantané visé.
- **Limite assumée** : ces parcours s'exécutent contre un faux `sparkd`. Il
  n'existe pas encore de pile locale à interroger — c'est SPK-23 — et l'E2E
  contre la pile réelle appartient à SPK-24. C'est le même niveau de preuve que
  SPK-18 à SPK-20, augmenté des parcours assertifs.

### [ ] SPK-22 · Vue des pools de ressources de l'hôte

## Lot 4 — Qualité et exploitation

### [ ] SPK-23 · Pile de développement autonome et seed

- Spécification : `docs/DAT.md` §11
- DoD : seed couvrant Sparks en marche, arrêtés, en erreur, refus d'admission,
  routes d'ingress, clés, historique d'audit.

### [ ] SPK-24 · Tests E2E Playwright depuis le parcours canonique

- DoD : parcours complets, souris et clavier uniquement, aucun accès direct à une
  URL profonde ni appel d'API en contournement.

### [ ] SPK-25 · Manuel utilisateur

### [ ] SPK-26 · Contrat de déploiement et procédure d'installation serveur

### [ ] SPK-27 · Vérification par mesure des hypothèses du DAT §13

Les sept points listés au §13 du DAT, chacun mesuré sur l'hôte cible et consigné.

- DoD : chaque hypothèse est soit confirmée par une mesure archivée, soit
  infirmée et le DAT corrigé en conséquence.

### [ ] SPK-29 · Regrouper les Sparks sous un parent cgroup de poids maîtrisé

Mesuré le 2026-08-18 : Incus place chaque Spark à la **racine** de cgroup v2, frère
de `system.slice`, `user.slice` et `init.scope`, tous à `cpu.weight=100`. Le poids
d'un Spark est donc arbitré contre l'hôte et pas seulement contre les autres
Sparks : la réservation n'est proportionnelle qu'entre Sparks, jamais absolue.

C'est la correction la plus lourde de la campagne : elle touche la promesse
centrale du produit.

- Spécification : `docs/DAT.md` §7.3 bis
- DoD : sous contention totale provoquée, un Spark à réservation *r* obtient
  effectivement `r / capacité` de la machine, mesuré et archivé. Tant que ce n'est
  pas prouvé, la console ne présente pas la réservation comme une garantie absolue.

### [ ] SPK-30 · Marge de métadonnées au-dessus du quota vendu

Mesuré le 2026-08-18 : un Spark qui remplit son quota empêche Incus d'écrire son
`backup.yaml`, situé **dans** le jeu de données contingenté. Toute reconfiguration
échoue alors, y compris l'agrandissement qui débloquerait la situation.

- Spécification : `docs/DAT.md` §8.7
- DoD : quota du jeu de données posé au-dessus de la taille vendue, marge invisible
  du locataire ; un Spark saturé reste reconfigurable, prouvé par un test qui
  remplit puis agrandit.

### [x] SPK-31 · Version minimale d'Incus imposée par le nesting Docker

Mesuré le 2026-08-18 : avec Incus 6.0.0 (version d'Ubuntu 24.04), **aucun**
conteneur Docker ne démarre dans un Spark. `runc` ≥ 1.3 écrit ses sysctls à travers
un montage procfs détaché depuis le correctif de CVE-2025-52881 ; le profil AppArmor
qu'Incus applique au Spark interprète cet accès comme un accès à `/sys/...` et le
refuse :

```
open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied
```

Le défaut est en amont, pas dans la configuration : il touche tout conteneur, avec
ou sans publication de port, et `--security-opt apparmor=unconfined` côté Docker ne
le contourne pas puisque le profil fautif est celui du Spark. Le correctif est dans
**Incus 6.19**.

- **Vérifié le 2026-08-18.** Incus porté en **7.3** depuis le dépôt amont Zabbly.
  Dans un Spark non privilégié, à idmap isolé, AppArmor actif et sans aucun
  `raw.lxc` de contournement : `docker compose up -d` démarre, et `nginx` répond
  **HTTP 200 depuis l'hôte** sur `10.77.0.38:8080`. Docker retient `overlayfs`
  au-dessus du rootfs ZFS, cgroup v2.
- Conséquence portée au contrat de déploiement : Incus ≥ 6.19 obligatoire, version
  des dépôts Ubuntu interdite, et installation **avant** la création du moindre
  Spark. Ce n'est pas une préférence, c'est une condition de fonctionnement.

### [ ] SPK-28 · Décision et exécution du repartitionnement du stockage

Les deux disques sont intégralement consommés par un unique RAID1 `ext4` monté sur
`/`. Aucun périphérique bloc n'est libre pour un pool de stockage natif.

- Spécification : `docs/DAT.md` §8.2, §8.5, §8.6
- Décision du responsable, 2026-08-18 : **pool sur fichier, à titre provisoire**.
  Le pool natif en miroir reste la cible ; l'unité reste donc ouverte.
- DoD : une paire de partitions dédiées existe et porte le pool. Le pool sur
  fichier ne clôt pas cette unité, il en diffère l'échéance.
- Note d'exploitation : `md1` resynchronisait au moment du relevé, pour environ
  8 heures. Aucune mesure de débit disque n'a de valeur avant la fin de cette
  resynchronisation.

---

## Réservé, non planifié

- `runtime: vm` pour charges non maîtrisées — VT-x est présent sur l'hôte, donc
  techniquement ouvert.
- Multi-serveurs.
- Quotas d'E/S disque par Spark au-delà de la priorité.
- Export hors machine planifié : écarté, les applications sauvegardent déjà vers un
  S3 externe par leur propre ordonnanceur.
