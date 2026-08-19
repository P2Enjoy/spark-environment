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

### [x] SPK-22 · Vue des pools de ressources de l'hôte

Écran de l'hôte : rendre l'admission control observable, c'est-à-dire permettre
de répondre à « pourquoi cette création serait-elle refusée, et de combien ? ».

Spécification : `docs/DAT.md` §27, qui s'appuie sur §7.7 (ce que l'admission
compte), §16 (la réserve de l'hôte) et §15 (adressage).

- Un écran à part, atteignable depuis la navigation principale : les pools ne
  dépendent d'aucun Spark et concernent tous les Sparks (§27.1).
- Chaque ressource montre **trois** grandeurs — capacité, alloué, disponible —
  jamais deux (§27.2).
- La soustraction de la mémoire est énoncée terme à terme : `MemTotal`, plafond
  de l'ARC, marge d'exploitation (§27.3, §16.1).
- Le CPU se lit à deux endroits : le pool partagé et la carte des cœurs, parce
  qu'un Spark `dedicated` retire des cœurs au lieu de consommer une réservation
  (§27.4).
- Le facteur de surengagement est affiché à côté de la capacité ; l'absence de
  facteur sur le stockage est nommée, pas laissée en blanc (§27.5).
- La portée de la réservation est **lue dans la réponse** (`reservation_guarantee`)
  et non écrite en dur (§27.6).
- `409 host_not_synced` est présenté comme une action à faire, pas comme une
  erreur ; `topology_synced_at` accompagne toujours la capacité (§27.8).

DoD : les trois grandeurs par ressource ; la soustraction mémoire visible ; la
carte des cœurs nomme le Spark propriétaire ; le surengagement affiché et son
absence sur le stockage expliquée ; `reservation_guarantee` relayée depuis la
réponse ; `host_not_synced` offre son remède comme bouton ; le relevé ne demande
aucune confirmation ; états chargement et erreur traités ; navigation clavier ;
console du navigateur vierge ; captures observées.

- **Close le 2026-08-19.** 28 tests de rendu, 2 parcours navigateur — l'écran est
  atteint AU CLAVIER depuis la liste, et le relevé part réellement — et une
  preuve d'API qui vérifie que les deux termes se recomposent en la réserve
  annoncée et que la soustraction aboutit à la capacité allouable.
- **Migration `002_part_arc`** livrée en préalable : `memory_reserve_bytes`
  portait la somme de l'ARC et de la marge, et la somme seule ne dit pas laquelle
  des deux vannes tourner. Voir OP-03 du contrat de déploiement.
- Quatre captures observées (29 à 32). **Trois défauts trouvés par
  l'observation** : `aria-current` était écrit en dur sur « Sparks » et mentait
  sur l'écran de l'hôte ; les deux liens de navigation se touchaient ; et mes
  faux Sparks sans identifiant faisaient afficher « S3 » là où le produit affiche
  un nom — la capture montrait un comportement que le produit n'a pas.

## Lot 4 — Qualité et exploitation

### [x] SPK-23 · Pile de développement autonome et seed

- Spécification : `docs/DAT.md` §12 (principes) et §28 (le contrat).
  *La référence pointait vers le §11, « Sécurité » — corrigé le 2026-08-19.*
- Deux processus, aucun service à orchestrer : `sparkd` avec le pilote factice et
  l'hôte console (§28.1). L'écart à la conteneurisation de `CLAUDE.md` §3 est
  assumé et tombe dès qu'un service réel entre dans la pile.
- L'inventaire accepte un serveur de genre `local`, joint directement : `sparkd`
  refusant toute adresse routable, un accès direct ne peut atteindre qu'un
  `sparkd` de boucle locale (§28.2).
- Le seed appelle les **routes HTTP de `sparkd`**, jamais du SQL direct : un seed
  en SQL peut produire des états que l'application ne sait pas atteindre (§28.3).
- Le pilote factice persiste ses instances : sans cela un Spark seedé « en
  marche » refuse `Arrêter` après un redémarrage (§28.4).
- `make seed` repart d'un registre neuf ; les noms sont stables (§28.6).

DoD : seed couvrant Sparks en marche, arrêtés, en erreur, en attente et dédié,
refus d'admission **réel**, routes d'ingress dont une non appliquée, clés dont un
Spark sans aucune, instantanés permettant le refus de restauration, historique
d'audit couvrant `ok`, `denied` et `error` ; `make runDev` démarre la pile et
`make seed` la peuple ; la console parcourue de bout en bout contre ce `sparkd`
RÉEL ; captures observées.

- **Close le 2026-08-19.** 12 preuves du seed, dont trois sur le seed lui-même :
  il repart d'un registre neuf, il est rejouable à l'identique, et il refuse un
  pilote réel.
- La console tourne **contre un `sparkd` réel** pour la première fois : six
  captures (40 à 45) parcourues à la souris depuis l'accueil, avec vrai registre,
  vrai contrôle d'admission et vrai journal d'audit.
- **Un défaut trouvé par l'observation** : un Spark `pending`, jamais appliqué,
  annonçait « Mesure en cours » alors que rien n'était mesurable — le §14.6
  interdit de confondre un calcul en cours avec une donnée inexistante. Aucun
  faux `sparkd` n'avait jamais produit ce cas.
- Deux constats étrangers consignés au registre : **INC-01** (le journal d'audit
  affiche les états techniques) et **INC-02** (un refus de création n'est
  rattachable à aucune demande). Tous deux attendent un arbitrage.

### [x] SPK-24 · Tests E2E Playwright depuis le parcours canonique

- Spécification : `docs/DAT.md` §29.
- Le harnais monte **sa propre pile** — `sparkd` et l'hôte console sur des ports
  libres, registre jetable seedé (§29.2). Un verdict qui dépend de ce qu'un
  humain a fait avant lui ne prouve rien.
- Aucune URL profonde, aucun appel d'API pour **agir** ; lire l'API pour
  **constater** un effet backend est au contraire exigé (§29.3).
- Les quatre refus réels du produit sont provoqués par l'interface et constatés à
  l'écran : capacité insuffisante, commande impossible dans l'état, restauration
  bloquée, domaine déjà pris (§29.4). Ce produit n'a pas de comptes
  d'utilisateurs : prétendre éprouver une authentification inexistante
  produirait un test décoratif.
- Un échec produit une capture et le texte de l'écran sous `e2e/captures/echecs/`
  (§29.5).
- La console du navigateur fait partie du verdict (§29.6).

DoD : parcours complets, souris et clavier uniquement, aucun accès direct à une
URL profonde ni appel d'API en contournement ; le harnais monte et démonte sa
pile ; les quatre refus couverts ; les effets backend constatés côté `sparkd` ;
la commande est documentée et entre dans `make test` ; console du navigateur
vierge de tout message applicatif.

- **Close le 2026-08-19.** 11 parcours (`make e2e`, dans `make test`).
- **Le harnais a trouvé deux défauts réels dès ses premières exécutions**, tous
  deux invisibles à tout ce qui existait :
  - **la console n'ouvrait jamais son tunnel.** Une console ouverte sur une
    machine fraîche affichait « Tunnel fermé » et « Les Sparks n'ont pas pu être
    chargés », sans aucun moyen d'y remédier. Le défaut a survécu à trois écrans
    et vingt captures parce que tous les harnais ouvraient le tunnel par un appel
    direct à l'API — le contournement même que cette DoD interdit. Corrigé, et le
    §22.6 du DAT dit désormais qui l'ouvre ;
  - **`validate` jetait le port d'un serveur local** et rendait toujours 9876 :
    une pile montée sur un port libre pointait sur un `sparkd` qui n'était pas le
    sien. Les preuves existantes ne le voyaient pas, l'une fixant `remotePort`,
    l'autre utilisant justement 9876.
- **Un défaut trouvé par l'observation** : le badge disait « rompu » et le bandeau
  « broken » à quelques centimètres. Le vocabulaire du tunnel vit désormais dans
  `tokens.js`, à un seul endroit.

### [x] SPK-25 · Manuel utilisateur

- Plan : `docs/MANUAL_PLAN.md`. Contrat de fraîcheur : `docs/DAT.md` §30.
- Les illustrations sont **produites** par un harnais contre la pile réelle
  seedée, jamais collectées à la main (§30.1). Si le parcours change au point que
  le harnais n'atteint plus l'écran, il échoue plutôt que de laisser une image
  périmée.
- Le lien manuel-image est vérifié **dans les deux sens** : toute image citée
  existe, et toute image produite est citée (§30.2). Une image orpheline n'est vue
  de personne et survit indéfiniment à l'écran qu'elle montrait.
- Un chapitre dont l'unité n'est pas livrée **n'est pas rédigé** : il figure avec
  sa raison et l'unité qui le débloque (§30.3).

DoD : les chapitres dont le comportement est livré et observable sont rédigés à
partir de la pile réelle ; les autres sont nommés avec leur blocage ; le harnais
d'illustrations et le contrôle des deux sens entrent dans `make test` ; aucun
secret ni adresse réelle ; captures observées.

- **Close le 2026-08-19.** Dix chapitres sous `docs/manuel/`, neuf illustrations
  produites par `make manuel` contre la pile seedée, sept contrôles dans la
  campagne.
- **M2 « Installer le serveur » n'est pas rédigé** : l'installation n'est pas
  outillée (SPK-26) et le repartitionnement du stockage attend un arbitrage
  (SPK-28). Le sommaire l'annonce avec ces deux unités.
- M6 et M7 portent une limite explicite : le déploiement d'une pile Compose dans
  un Spark est **mesuré sur matériel réel** et non reproductible sur la pile de
  développement ; l'émission d'un certificat n'a pas été éprouvée, faute de
  domaine (SPK-12).
- Le contrôle des deux sens vaut surtout pour les **orphelines** : une image
  citée mais absente laisse un cadre vide que quelqu'un finira par voir, alors
  qu'une image plus citée par personne survit indéfiniment à l'écran qu'elle
  montrait.

### [x] SPK-26 · Contrat de déploiement et procédure d'installation serveur

- Spécification : `docs/DAT.md` §31. Contrat : `docs/PROD_MIGRATIONS.md`.
- **Une seule liste de contrôles**, employée avant l'installation pour savoir ce
  qui manque et après pour constater l'état (§31.1). Deux listes divergeraient,
  et c'est l'après qui deviendrait faux.
- Chaque contrôle rend le verdict, la **valeur relevée** et la **commande** qui
  corrige ; `inconnu` se distingue d'`échec` (§31.2).
- La vérification est **lecture seule**, l'installation est un script distinct
  (§31.3) : un outil qui vérifie et répare finit par réparer ce qu'on voulait
  constater.
- **Mesuré le 2026-08-19** : le seul manque réel est que `sparkd` tourne depuis
  un terminal et ne survivrait pas à un redémarrage (§31.4). L'installation pose
  une unité systemd ; la vérification contrôle qu'elle est **activée au
  démarrage**, pas seulement démarrée.
- Le contrat de déploiement est remis à l'état mesuré : sa baseline n'est plus
  vide, et OP-02 est appliqué.

DoD : les contrôles sont éprouvés par des tests avec relevés injectés ; ils sont
**exécutés contre l'hôte cible réel** et leur sortie consignée ; l'unité systemd
et son script d'installation existent ; le contrat de déploiement décrit l'état
mesuré, sans opération déjà faite présentée comme en attente ; le chapitre M2 du
manuel est mis au niveau de ce qui est réellement outillé.

- **Close le 2026-08-19.** 35 preuves avec relevés injectés, et **l'installation
  réellement exécutée sur l'hôte cible** : les neuf contrôles y sont verts,
  `sparkd` est en service systemd activé au démarrage, et la topologie relevée
  donne 76,2 Gio allouables — soit exactement la soustraction du §16.1.
- **Le premier passage contre l'hôte a trouvé un défaut dans le contrôle
  lui-même** : la surface réseau dénonçait le port 53 de `dnsmasq`, lié au bridge
  **privé** que les Sparks doivent joindre, et ne reconnaissait pas
  `127.0.0.53%lo` comme de la boucle locale. Il classe désormais l'adresse.
- **`readyz` était figé** : il annonçait « degraded » et deux pilotes « non
  implémentés » quoi qu'il arrive. Un endpoint de disponibilité qui rend toujours
  la même chose ne distingue pas un serveur sain d'un serveur en panne, et c'est
  de lui que dépend la vérification de déploiement. Il sonde désormais.
- **OP-02 était présenté comme en attente alors qu'il est appliqué.** Corrigé.
- Reste hors outillage, et le chapitre M2 le dit : la mise en place des
  prérequis, et le repartitionnement du stockage (SPK-28).

### [x] SPK-27 · Vérification par mesure des hypothèses du DAT §13

Les points listés au §13 du DAT, chacun mesuré sur l'hôte cible et consigné.
*L'unité annonçait « sept points » ; le §13 en compte treize — corrigé le
2026-08-19.*

- Spécification : `docs/DAT.md` §13 lui-même. Elle existe et énumère ce qui reste
  à mesurer : la réécrire pour se donner un commit documentaire serait une
  session en échec.
- Restaient au 2026-08-19 : le point **12**, la tenue de l'ARC **sous charge** —
  la mesure statique ne disait que le plafond —, et le point **13**, ce que le
  quota compte lorsque la compression est active.
- Le point 12 impose un livrable de code : une mesure ponctuelle répond une fois.
  La consommation réelle de l'ARC doit être **observable en continu**, faute de
  quoi la vérification périme dès qu'on la termine.

- DoD : chaque hypothèse est soit confirmée par une mesure archivée, soit
  infirmée et le DAT corrigé en conséquence ; la consommation de l'ARC est
  exposée par le runtime et visible à l'écran ; le manuel énonce ce que « 10 Gio »
  désigne réellement.

- **Close le 2026-08-19.** Les treize points du §13 sont désormais mesurés et
  archivés. Aucun n'était en attente.
- **Point 12** — 24 Gio incompressibles écrits puis relus : l'ARC monte à
  16,00 Gio et n'y dépasse pas. La réserve du §16.1 est donc **nécessaire** — il
  atteint son plafond dès qu'on lui donne de quoi le remplir — et **suffisante**.
- **Point 13** — dans un quota de 2 Gio, 8 Gio de zéros ont coûté 24 Kio, et
  2 Gio incompressibles l'ont épuisé exactement. Décision : la compression reste
  active, l'écart est documenté. Il joue toujours en faveur du locataire.
- Livrable de code : la consommation de l'ARC est publiée par le runtime, lue à
  chaque requête et non persistée, et affichée face à son plafond. Vérifié sur
  l'hôte réel — 0,80 Gio annoncés, 0,80 Gio dans `arcstats`.

### [~] SPK-29 · Regrouper les Sparks sous un parent cgroup de poids maîtrisé

Mesuré le 2026-08-18 : Incus place chaque Spark à la **racine** de cgroup v2, frère
de `system.slice`, `user.slice` et `init.scope`, tous à `cpu.weight=100`. Le poids
d'un Spark est donc arbitré contre l'hôte et pas seulement contre les autres
Sparks : la réservation n'est proportionnelle qu'entre Sparks, jamais absolue.

C'est la correction la plus lourde de la campagne : elle touche la promesse
centrale du produit.

- Spécification : `docs/DAT.md` §7.3 bis (le constat) et **§32** (la correction).
- **Mesuré le 2026-08-19** : `raw.lxc` avec `lxc.cgroup.dir.container` place le
  Spark dans `spark.slice`. La loi de poids du §7.2 bis s'y applique inchangée
  (`25 % − 10 + 5 = 20`) et `cpu.max` reste `max`, donc le burst est préservé.
- Le poids de la tranche **n'est pas une constante** : `W = H × f / (1 − f)` avec
  `f = Σr / C`. Une constante rendrait la réservation absolue pour un seul taux
  de remplissage et fausse partout ailleurs (§32.2).
- Une **réserve CPU de l'hôte** devient nécessaire : sans elle `f → 1` et l'hôte
  n'ordonnance plus rien, pas même de quoi corriger la situation (§32.3).
- La tranche est une **unité systemd** : créée à la main elle disparaît au
  redémarrage, et la réservation redeviendrait proportionnelle en silence (§32.4).

- DoD : sous contention totale provoquée, un Spark à réservation *r* obtient
  effectivement `r / capacité` de la machine, mesuré et archivé. Tant que ce n'est
  pas prouvé, la console ne présente pas la réservation comme une garantie absolue.

**Le mécanisme est LIVRÉ et prouvé sur l'hôte ; la DoD ne l'est pas encore.**

- Livré : le traducteur place tout Spark dans `spark.slice` ; le runtime
  recalcule le poids à la création, à la suppression et au démarrage ; la
  délégation des contrôleurs se réaffirme ; la tranche est une unité systemd ; le
  préflight gagne le contrôle `RUN-SLICE` ; `SPARKD_CPU_RESERVE` existe.
- Prouvé sur l'hôte : un Spark créé par `sparkd` atterrit **dans** la tranche,
  poids `245` — la loi `250 − 10 + 5` du §7.2 bis s'applique inchangée — et
  `cpu.max` reste `max`, donc le burst est préservé. Le poids de la tranche est
  passé à `100` à la création d'un Spark réservant 1 CPU, exactement la valeur du
  tableau du §32.2.
- **Reste à prouver, et c'est le seul écart** : sous contention **totale** — les
  trois tranches de l'hôte exécutables simultanément —, la part converge vers
  `r / C`. La mesure du 2026-08-19 a donné **50 %** au lieu de 25 %, parce que
  deux des trois tranches de l'hôte étaient au repos : un poids cgroup ne se
  partage qu'entre frères **exécutables**. L'écart joue en faveur du locataire —
  la réservation est un **plancher** tenu et dépassé — mais l'égalité annoncée
  par la DoD n'est pas établie. Voir §32.2, sous-section « ce que la mesure a
  corrigé ».
- La console continue donc de **ne pas** présenter la réservation comme une
  garantie absolue, conformément à la DoD.

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

### [ ] SPK-32 · Catalogue d'images vérifié et choix par liste à la création

`spark.image` est aujourd'hui un texte libre, et le seul contrôle local porte sur
le **dépôt**, pas sur l'alias : `translate.split_image()` accepte
`images:debian/31`. Le refus ne vient alors que d'Incus, à `apply`, après que la
ligne du registre a été écrite et la ressource comptée (§14.2) ; le Spark reste en
`error` avec ses quotas engagés jusqu'à sa suppression.

- Spécification : `docs/DAT.md` §33, §25.3 · `docs/DESIGN_SYSTEM.md` §5.4, §6.27
  (la liste vit dans une section de fenêtre) · `docs/SCHEMA.md` (migration due
  avec l'unité) · manuel M5.
- Portée : table de catalogue dans le registre + migration ; seed des références
  connues ; `GET /v1/images` ; relevé explicite daté, avec les trois états
  `verified` / `missing` / `unknown` (§33.3) ; refus à la création d'une référence
  absente ou non vérifiée, **avant** écriture de la ligne ; liste déroulante à la
  création alimentée par le catalogue (§33.5) ; ajout d'une image au catalogue
  comme geste explicite, hors formulaire de création.
- Dépend de : rien. Ne dépend **pas** de SPK-28 ni de SPK-29.
- Hypothèse à mesurer avant clôture : la voie de vérification — index
  simplestreams du dépôt, et `GET /1.0/images` d'Incus pour ce qui est local — n'a
  jamais été mesurée sur l'hôte (§33.3). Tant qu'elle ne l'est pas, l'unité reste
  au mieux `[~]`.
- DoD : un alias inexistant est refusé **à la création**, avec un message qui le
  nomme, et le registre reste inchangé — prouvé par un test d'API ; l'écran de
  création ne présente plus de champ libre — prouvé par un parcours E2E depuis le
  parcours canonique ; le relevé affiche sa date et distingue les trois états ;
  seed, manuel M5 et captures refaits ; `@spec` / `@verifies` posés.

### [ ] SPK-33 · Refonte de la navigation selon les trois degrés

La console rend aujourd'hui une barre horizontale à deux liens, trois panneaux
d'administration empilés dans le détail, et des formulaires ouverts dans le flux.
Le design system retient désormais trois degrés : barre latérale, onglets, puis
fenêtre en lecture avec une modale par section.

- Spécification : `docs/DESIGN_SYSTEM.md` §5.4, §6.27, §9.1 ·
  `docs/DESIGN_SYSTEM_APP.md` §1 · `docs/DAT.md` §34.
- Portée : barre latérale de premier degré (Sparks, Hôte) avec le sélecteur de
  serveur et l'état du tunnel au-dessus ; onglets de second degré — *Instances*
  sous Sparks, *Pools* et *Images* sous Hôte ; **fenêtre** d'un Spark ouverte
  depuis la liste, portant ses propres onglets — Infos, Routes, Clés, Instantanés,
  Journal — puis ses sections ; chaque section porte ses commandes, qui ouvrent
  une modale **limitée à cette section**, en modification comme en insertion ;
  composant de modale unique, conforme au contrat du §6.27. Onglets portés par des
  liens et non un `tablist`, puisque ce sont de véritables destinations.
- La hiérarchie est une orientation. Ce que la revue vérifiera, ce sont les trois
  invariants du §5.4 : ce qui s'affiche et ce qui se saisit ne partagent pas la
  même surface, chaque surface a un seul sujet, une action sensible se confirme.
- Ne change pas : les confirmations restent dans le flux (§6.22, §6.23), l'écran
  de création garde sa destination, les commandes de cycle de vie restent des
  boutons de l'onglet Aperçu (`docs/DAT.md` §34.2).
- Conséquence documentaire : le §26.2 du DAT cesse de dire « pas de modale » dans
  le même changement, et le tableau de `docs/DESIGN_SYSTEM_APP.md` §1 cesse de
  décrire une cible pour décrire l'écran.
- DoD : les parcours E2E du §29 passent **sans que leur intention change** —
  seuls leurs sélecteurs bougent ; le contrat clavier est prouvé pour les trois
  degrés (§9.1) : destination courante annoncée, onglet atteignable et annoncé,
  modale avec focus entrant, focus retenu, `Échap`, focus rendu au déclencheur ;
  captures refaites et observées, y compris sous 768 px et 1024 px ; manuel M3,
  M5, M7, M8, M9 mis à jour avec leurs illustrations ; `@spec` / `@verifies`
  posés.

### [ ] SPK-34 · Sparks protégés contre la modification accidentelle

Un interrupteur de protection par Spark. Tant qu'il est armé, **le runtime**
refuse toute écriture visant ce Spark — donc l'API comme la console. Il s'arme
avec un mot de passe et se lève avec ce même mot de passe.

- Spécification : `docs/DAT.md` §35 · `docs/DESIGN_SYSTEM.md` §6.23 (une action
  sensible se confirme ; un objet protégé se déverrouille d'abord) ·
  `docs/SCHEMA.md` (migration due avec l'unité) · manuel M8.
- Portée : colonnes de protection dans `spark` + migration ; empreinte `scrypt`
  à sel par Spark, jamais le mot de passe en clair, jamais journalisé (§21) ;
  `POST` et `DELETE /v1/sparks/{name}/protection` ; refus `423 spark_protected`
  sur toute écriture visant un Spark protégé — commandes, reconfiguration,
  routes, clés, instantanés y compris la restauration ; refus du retrait global
  d'une clé SSH lorsqu'il toucherait un Spark protégé, en les nommant ; état
  protégé visible dans la liste et dans la fenêtre ; contrat d'API régénéré.
- Explicitement **hors** protection : la redistribution des cœurs (§7.4 bis) et
  la repondération de `spark.slice` (§32.2). Les bloquer ferait échouer la
  création d'un autre Spark.
- Ce que l'unité ne prétend pas : ce n'est pas un contrôle d'accès. Qui détient
  une clé SSH de l'hôte atteint `sparkd`, qui détient `root` atteint le registre
  (§35.1). La console ne présentera jamais la protection comme une frontière de
  sécurité, et le manuel non plus.
- DoD : un test d'API prouve le refus `423` sur **chacune** des écritures listées,
  avec les vrais droits, sans passer par l'interface ; un test prouve que les deux
  recalculs globaux passent toujours sur un Spark protégé ; un test prouve
  qu'aucun mot de passe n'atteint `audit_log` ; un parcours E2E arme, échoue à
  modifier, lève, modifie, réarme — depuis le parcours canonique ; captures
  observées ; manuel M8 et seed mis à jour ; `@spec` / `@verifies` posés.

---

## Réservé, non planifié

- `runtime: vm` pour charges non maîtrisées — VT-x est présent sur l'hôte, donc
  techniquement ouvert.
- Multi-serveurs.
- Quotas d'E/S disque par Spark au-delà de la priorité.
- Export hors machine planifié : écarté, les applications sauvegardent déjà vers un
  S3 externe par leur propre ordonnanceur.
