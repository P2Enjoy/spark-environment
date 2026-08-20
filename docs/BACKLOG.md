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

### [x] SPK-12 · Ingress Caddy et réconciliation

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
- **Depuis SPK-47, le DNS n'est plus l'obstacle** : la console pose
  l'enregistrement d'une route, et une écriture réelle a été mesurée le
  2026-08-20. Ce qui manque est désormais une Forge **joignable depuis
  l'extérieur**, sans quoi l'autorité de certification ne peut pas valider.
- **Close le 2026-08-20 : l'émission TLS est prouvée sur un domaine réel.**
  `helo.spark.lelabs.tech` a été posé par la console vers `51.158.54.202`, la
  route déclarée par l'API, et le certificat émis par Let's Encrypt. Mesuré
  **depuis l'extérieur**, pas depuis la Forge :
  - `https://helo.spark.lelabs.tech/` → `200`, `ssl_verify_result=0`, HTTP/2 ;
  - `subject=CN = helo.spark.lelabs.tech`, `issuer=Let's Encrypt`, valide du
    2026-08-20 au 2026-11-18 ;
  - `http://51.158.54.202/`, domaine non routé → `404`, le comportement corrigé
    plus haut.

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

### [~] SPK-30 · Marge de métadonnées au-dessus du quota vendu

Mesuré le 2026-08-18 : un Spark qui remplit son quota empêche Incus d'écrire son
`backup.yaml`, situé **dans** le jeu de données contingenté. Toute reconfiguration
échoue alors, y compris l'agrandissement qui débloquerait la situation.

- Spécification : `docs/DAT.md` §8.7 (le fait mesuré) et **§8.8** (le contrat).
- Portée : `SPARKD_STORAGE_METADATA_MARGIN`, défaut 64 MiB, refusée négative ;
  le traducteur pose `storage_bytes + marge` sur le disque racine ; l'admission
  évalue la demande et compte l'alloué du pool **marge comprise** ; le registre
  stocke la taille vendue et elle seule, donc aucune migration ; la console
  affiche la taille vendue comme limite et calcule le ratio sur elle.
- Ne change pas : la forme du refus d'admission (§7.7), la sémantique du quota sur
  les octets stockés (§8.7 fait 1), l'imputation des instantanés (§8.7 fait 2).
- DoD, aux trois niveaux du §8.8.5 :
  1. **traduction** — *T* octets vendus produisent un `root.size` de *T* + marge,
     et de *T* exactement quand la marge est nulle ;
  2. **admission** — un Spark qui tiendrait tout juste sans la marge est refusé
     avec elle, et le pool rend un alloué qui l'inclut ;
  3. **sur un hôte réel** — remplir un Spark jusqu'au refus d'écriture, puis
     l'agrandir, et constater que l'agrandissement aboutit. C'est le seul niveau
     qui prouve le fait du §8.7. Tant qu'il n'est pas exécuté, l'unité reste `[~]`.

**Le mécanisme est LIVRÉ et prouvé aux niveaux 1 et 2 ; le niveau 3 ne l'est pas.**

- Livré : `SPARKD_STORAGE_METADATA_MARGIN` (défaut 64 MiB, zéro accepté, négatif
  refusé au démarrage) ; le traducteur pose `taille vendue + marge` ; l'admission
  évalue la demande marge comprise et l'alloué du pool la porte ; `GET /v1/host`
  publie la marge unitaire **et** son coût total ; la carte du disque énonce
  l'écart et nomme la vanne ; M4 l'explique.
- Aucune migration : le registre stocke la taille vendue et elle seule, le quota
  est dérivé (§8.8.2 règle 1).
- Prouvé : 550 tests Python — dont la traduction pour quatre tailles × quatre
  marges, la marge nulle, la marge négative refusée, l'alloué du pool, le refus
  de ce qui tiendrait tout juste sans elle, et l'égalité des trois défauts
  (module, configuration, DAT) ; 215 tests de console ; un parcours E2E qui lit
  l'explication à l'écran **et** vérifie côté serveur que l'alloué vaut
  `Σ vendues + marge × Sparks`.
- Observé : illustration `docs/manuel/images/m4-pools.png`, reproduite depuis la
  pile seedée — cinq Sparks, 320 Mio de marge annoncés — et captures
  `e2e/captures/29-hote-pools.png` et `30-hote-mobile.png`, à 1440 et 390 px.
- **Reste à prouver, et c'est le seul écart** : le niveau 3. Il exige un hôte
  Incus avec un pool réel, pour remplir un Spark jusqu'au refus d'écriture puis
  l'agrandir. Aucun Incus n'est joignable depuis la machine de cette session
  (`which incus` ne rend rien). Les niveaux 1 et 2 prouvent que le quota posé
  porte bien la marge et que le pool la compte ; ils ne prouvent pas qu'elle
  suffit à `backup.yaml` sur le pilote réel.

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

### [ ] SPK-28 · Partitionnement fourni à la création du serveur

**Arbitrage du responsable, 2026-08-20.** L'environnement de validation est une
**démonstration** : le pool sur fichier y suffit, et il cesse d'être « provisoire ».
Ce qui est dû n'est plus un repartitionnement de la machine existante, mais le
moyen d'obtenir d'emblée une machine bien partitionnée — et de rendre le reste
configurable.

L'unité change donc de nature, et son ancienne DoD — « une paire de partitions
dédiées existe » — est abandonnée avec sa raison : repartitionner une machine de
démonstration coûterait une réinstallation pour un gain qu'aucun usage réel ne
réclame ici.

- Spécification : `docs/DAT.md` §8.2, §8.5, §8.6 · `README.md`.
- Portée :
  1. le `README.md` compose le **schéma de partitionnement JSON** à fournir à
     Scaleway à la création du serveur, qui laisse d'emblée une paire de
     partitions libres pour le pool ZFS en miroir. Un exploitant qui part d'une
     machine neuve n'a alors rien à repartitionner ;
  2. **tout est configurable** : chemin du pool, taille du fichier lorsque c'est
     un pool fichier, nom du pool, point de montage. Aucune de ces valeurs ne
     reste codée en dur, ni dans les scripts, ni dans le contrat de déploiement.
- Le §8.5 cesse de présenter le pool natif comme « la cible » et le pool fichier
  comme un repli : il énonce les deux comme deux dispositions, avec ce que
  chacune apporte et ce qu'elle ne protège pas — sur fichier, ZFS ne gère pas le
  miroir et ne répare pas la corruption silencieuse.
- DoD : le schéma JSON figure au README, avec ce qu'il produit et comment le
  fournir ; un exploitant qui suit le README obtient les partitions attendues ;
  aucune valeur de stockage n'est codée en dur — vérifié par une recherche, pas
  par mémoire ; le §8.5 et le contrat de déploiement disent la même chose que le
  README.
- Note d'exploitation conservée : aucune mesure de débit disque menée sur le pool
  fichier ne caractérise la machine.

### [x] SPK-32 · Catalogue d'images vérifié et choix par liste à la création

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

**Livré et prouvé, sauf deux points de la DoD.**

- **Mesuré d'abord** (§33.3 corrigé) : la clé de produit porte le nom de code, et
  l'alias vit dans un champ à part — `debian/13/amd64` n'existe pas. Relevé réel :
  quatre références vérifiées sur 272 produits, `images:debian/31` donnée absente.
- Migration `003_catalogue_images`, module de catalogue, trois routes, refus
  **avant** l'écriture de la ligne, liste déroulante à la création.
- 17 preuves d'API et 6 de rendu. Celle qui porte l'unité compare l'allocation du
  pool avant et après un refus : rien n'est engagé.
- Le seed employait `images:debian/99` pour provoquer son Spark en erreur, ce que
  l'unité rend impossible. Il s'appuie désormais sur sa seule injection de faute —
  le vrai chemin d'erreur, au lieu d'une référence impossible.
- **Close le 2026-08-19.** Les deux manques sont livrés.
  1. **L'écran du catalogue** — onglet Images sous Hôte, comme le §34.1 le
     prescrit. Il affiche la date du dernier relevé, les trois états avec des
     libellés et des couleurs distincts, et ce que le relevé a constaté pour
     chaque entrée. « Non relevée » est en `accent` et non en `danger` : ce n'est
     pas une panne mais un relevé qui n'a pas eu lieu. Les entrées absentes
     restent affichées, et l'écran dit pourquoi.
  2. **Trois parcours E2E** depuis l'accueil, à la souris : l'absence de champ
     libre, les options comparées à ce que `sparkd` déclare proposable, et le
     geste d'ajout qui crée une entrée non relevée.
- Le geste d'ajout existe désormais par l'interface, et le relevé aussi.
- Les trois états ont été observés de bout en bout contre le vrai dépôt :
  `images:debian/31` ajoutée naît « Non relevée », puis le relevé la donne
  « Absente des 272 produits publiés ».
- **Un défaut trouvé par le parcours E2E** : le formulaire de création était
  peint deux fois, et une saisie faite entre les deux était effacée par le second
  rendu. La fenêtre s'est élargie quand le catalogue a ajouté une requête, et le
  refus de capacité n'arrivait plus parce que le nom avait disparu.

### [x] SPK-33 · Refonte de la navigation selon les trois degrés

La console rendait une barre horizontale à deux liens, trois panneaux
d'administration empilés dans le détail, et des formulaires ouverts dans le flux.
Le design system retient trois degrés : barre latérale, onglets, puis fenêtre en
lecture avec une modale par section.

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

**Livrée et intégralement prouvée le 2026-08-19.**

- **Degré 1** : barre latérale, avec le sélecteur de serveur au-dessus — c'est le
  contexte de toutes les destinations, pas une destination. Sous 1024 px elle
  passe en barre supérieure, libellés conservés.
- **Degré 2** : onglets — *Instances* sous Sparks, *Pools* et *Images* sous Hôte.
- **Degré 3** : la fenêtre d'un Spark répartit ses facettes en onglets — Aperçu,
  Routes, Clés, Instantanés, Journal —, chacune une véritable destination.
- Tous les onglets sont des **liens** avec `aria-current="page"`, jamais un
  `tablist` : le critère est l'URL, et un parcours vérifie qu'une facette survit
  au rechargement.
- **Les 14 parcours E2E passent sans que leur intention change** : seuls leurs
  sélecteurs ont bougé, comme la DoD l'exigeait. Deux parcours de plus éprouvent
  le contrat clavier des trois degrés et le rechargement d'une facette.
- **Un défaut trouvé par la mesure** : la page défilait horizontalement à 1024 et
  768 px — une piste de grille ne rétrécit pas sous la largeur de son contenu, et
  le tableau poussait la page entière. Vérifié après correction à 1440, 1024, 768
  et 390 px.
- Manuel M3 et M8 mis à jour ; captures et illustrations refaites.

- **La modale est livrée**, en un composant unique : `dialog` ouvert par
  `showModal()`, nom accessible égal au titre de la section, focus entrant dans le
  premier champ, focus retenu, `Échap` qui vaut annulation, focus rendu au
  déclencheur — **retrouvé par son identifiant**, jamais par `document.activeElement`,
  que le repaint détache —, arrière-plan inerte, une seule à la fois, plein écran
  sous 768 px. Les **quatre** saisies de la console y passent : route, clé,
  instantané, et l'ajout au catalogue d'images.
- Le §26.2 du DAT est réécrit et décrit la modale ; il conserve l'argument de coût
  qui avait fait choisir le formulaire dans le flux, pour qu'on ne le refasse pas.
  Le §33.2 dit que le catalogue suit la même règle, et le tableau de
  `docs/DESIGN_SYSTEM_APP.md` §1 décrit l'écran au lieu d'une cible.
- **Trois défauts trouvés par la mesure**, pas par l'œil : la modale collée au
  bord supérieur, qu'une règle d'espacement de bloc écrasait ; sous 768 px, un
  cadre resté à la hauteur de son contenu, laissant l'engagement flotter au milieu
  de l'écran ; et une attente de parcours devenue vraie d'avance, qui guettait la
  disparition d'une classe que plus aucun composant n'émettait.
- Manuel : M3 énonce ce qu'une saisie garantit au clavier, M5 nomme où vit le
  geste d'ajout au catalogue et l'illustre. Les illustrations des facettes sont
  recadrées — 1400 px était la hauteur des panneaux empilés.
- **Preuves exécutées** : 539 tests Python, 211 Node de la console, 6 de contrat,
  8 gestes, **18 parcours E2E**, 7 contrôles du manuel, build, contrat sans
  dérive, 35 captures et 10 illustrations refaites et observées. Modale mesurée et
  observée à 1440, 1024, 768 et 390 px : centrée, focus dans le premier champ,
  aucun débordement horizontal.

### [x] SPK-34 · Sparks protégés contre la modification accidentelle

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
  routes, **octroi** de clé, instantanés y compris la restauration ; état protégé
  visible dans la liste et dans la fenêtre ; contrat d'API régénéré.
- **La révocation d'une clé n'est jamais refusée**, ni sur un Spark protégé, ni
  au registre général. Elle suit l'ordre refus-puis-acceptation du §26.5 : un
  premier appel rend `409 protected_sparks_affected` avec la **liste nommée** des
  Sparks protégés touchés, la console la présente en confirmation, un second appel
  porte `accept_protected` et aboutit. Aucun mot de passe n'est demandé sur ce
  chemin, et aucune protection n'est levée. Motif au §35.2 : une protection ne
  retient jamais un geste qui réduit un risque — clé qui a fuité, personne partie.
- Explicitement **hors** protection : la redistribution des cœurs (§7.4 bis) et
  la repondération de `spark.slice` (§32.2). Les bloquer ferait échouer la
  création d'un autre Spark.
- Ce que l'unité ne prétend pas : ce n'est pas un contrôle d'accès. Qui détient
  une clé SSH de l'hôte atteint `sparkd`, qui détient `root` atteint le registre
  (§35.1). La console ne présentera jamais la protection comme une frontière de
  sécurité, et le manuel non plus.
- DoD : un test d'API prouve le refus `423` sur **chacune** des écritures listées,
  avec les vrais droits, sans passer par l'interface ; un test prouve que les deux
  recalculs globaux passent toujours sur un Spark protégé ; un test prouve qu'une
  **révocation aboutit** sur un Spark protégé après acceptation, et que le premier
  appel a nommé les Sparks concernés ; un test prouve qu'aucun mot de passe
  n'atteint `audit_log`, et que la révocation y consigne les Sparks protégés
  touchés ; deux parcours E2E depuis le parcours canonique — armer, échouer à
  modifier, lever, modifier, réarmer ; puis révoquer une clé malgré le gel en
  passant par la confirmation qui nomme les Sparks ; captures observées ; manuel
  M8 et seed mis à jour ; `@spec` / `@verifies` posés.

**Livrée et intégralement prouvée le 2026-08-19.**

- Migration `004_protection_spark` : quatre colonnes, dont l'invariant — les
  quatre NULL ou les quatre renseignées — est porté par **deux déclencheurs**,
  SQLite n'ajoutant pas de `CHECK` à une table existante. Elles naissent NULL :
  aucune protection n'est armée rétroactivement. `docs/SCHEMA.md` §4.1.
- `POST` et `DELETE /v1/sparks/{name}/protection`, plus un `GET` qui publie un
  booléen et une date — jamais l'empreinte, le sel ni les paramètres.
- Refus `423 spark_protected` sur les cinq familles d'écriture. Le Spark visé par
  un **retrait** de route se lit sur la route, pas sur l'URL.
- Le runtime cesse de publier `allowed_commands` sur un Spark protégé (§24.1) :
  l'écran n'a rien à redériver, et la barre nomme la protection au lieu de
  laisser croire que c'est l'état qui l'interdit.
- Révocation : ordre refus-puis-acceptation sur les deux routes, liste **nommée**,
  aucun mot de passe demandé, aucune protection levée, Sparks touchés consignés
  au journal.
- Seed : « analytics » protégé — le seul Spark qu'aucun autre parcours ne pilote,
  et son état `pending` rend la démonstration plus parlante. La vérification du
  seed envoie une commande et **exige un 423** : un badge posé sur une protection
  qui ne mord pas mentirait.
- **Preuves** : 586 tests Python — dont 20 sur le module, 16 par l'API avec les
  vrais droits et sans passer par l'interface, couvrant chacune des écritures
  listées, les deux recalculs globaux, les trois cas de révocation et l'absence
  de mot de passe au journal ; 224 tests de console ; 8 gestes ; **21 parcours
  E2E**, dont les deux que la DoD nomme ; 7 contrôles du manuel ; build ; contrat
  régénéré et sans dérive.
- **Observé** : `e2e/captures/36-liste-protege.png`, `37-fenetre-protegee.png`,
  `38-protection-modale.png` et `docs/manuel/images/m8-protection.png`.
- Deux preuves **révisées avec leur raison** : le seed tronqué, que la protection
  rendait incapable d'échouer, et la forme du refus `423`, qui sortait sans
  l'enveloppe `detail` de toutes les autres erreurs du produit.

---

## Lot 5 — Sécurité et continuité

Deux unités d'**instruction**. Elles ne livrent pas de fonctionnalité : elles
produisent une décision écrite, des unités de suite, et la liste motivée de ce qui
est écarté. Une instruction dont il ne sort qu'une intention est une instruction
ratée.

### [ ] SPK-35 · Instruire la sécurisation des actions sensibles

Le §6.23 du design system impose une confirmation à toute action sensible, et
SPK-34 ajoute un verrou par Spark. Aucun des deux ne demande de **prouver qui
agit** : la confirmation ne distingue pas le responsable d'un script qui détient
sa clé.

L'unité instruit cette question, et elle commence par ce qui manque le plus :
**écrire le modèle de menace**. Sans lui, chaque option se discute au sentiment.

**Arbitrage du responsable, 2026-08-20 : le modèle de menace s'écrit D'ABORD, et
aucune option technique n'est choisie dans cette unité.** Elle est une
instruction pure — menaces hiérarchisées, options évaluées contre chacune, ce que
le produit ne prétend pas traiter — et le choix se fait ensuite, sur pièces.

Conséquence directe : **SPK-40** (signature des gestes par la clé du responsable)
reste subordonnée à cet arbitrage, et ne peut pas être livrée avant lui.

Menaces à nommer et à hiérarchiser, au minimum :

- une **clé SSH d'accès à l'hôte** volée, copiée ou restée active après un départ ;
- un **poste de travail compromis** sur lequel la console est ouverte, tunnel établi ;
- un **script d'exploitation** lancé sur le mauvais nom ou le mauvais serveur ;
- l'**erreur de main** du responsable lui-même — la seule que SPK-34 traite déjà.

Ce que le produit ne prétendra pas traiter doit être écrit aussi : `root` sur
l'hôte défait tout mécanisme dont le secret vit sur l'hôte, et le §35.1 l'assume
déjà pour la protection.

Options à évaluer, chacune contre le modèle de menace, son coût et son mode de
panne — la liste est ouverte, elle n'est pas un menu à cocher :

| Piste | Ce qu'elle apporte | Ce qu'elle coûte, et où elle casse |
|---|---|---|
| **TOTP** (RFC 6238), compatible Google Authenticator, optionnel par Spark ou global | un facteur que la clé SSH volée ne donne pas ; standard, hors ligne, sans matériel | le secret vit dans le registre, donc `root` sur l'hôte le lit ; dérive d'horloge ; enrôlement et **codes de secours** à concevoir, sinon un téléphone perdu enferme le responsable dehors |
| **Signature par la clé SSH déjà présente** — `sparkd` émet un défi, l'agent le signe | aucun secret nouveau, aucun enrôlement, lie le geste à la clé physique ; réutilise ce que le produit exige déjà ; **sert aussi de preuve d'audit non répudiable** (§36.3, SPK-39) | ne protège **pas** du scénario « clé volée », qui est le premier de la liste ; suppose un agent atteignable depuis l'hôte console |
| **WebAuthn / FIDO2** sur la console locale | facteur non exportable, résistant à l'hameçonnage ; `127.0.0.1` est un contexte sécurisé, donc techniquement ouvert | matériel à acheter et à doubler ; enrôlement, perte, récupération ; la charge de conception la plus lourde des quatre |
| **Ré-authentification à durée limitée** (« mode sudo ») | ramène le coût sur les seules actions sensibles au lieu de chaque geste | dépend de l'heure, donc du même défaut que le déverrouillage temporaire écarté au §35.4 — à trancher, pas à supposer |
| **Confirmation par frappe du nom** de l'objet | quasi gratuit, efficace contre l'erreur de main | ne prouve rien sur l'identité ; ne traite que la menace déjà traitée |
| **Application différée et annulable** d'une action destructive | rattrape l'erreur après coup, y compris celle qu'on n'a pas vue tout de suite | un geste « annulable » invite à moins réfléchir avant ; complique la machine à états du §14 |
| **Notification hors bande** des actions sensibles | détecte ce qu'aucun verrou n'a arrêté ; peu coûteux | introduit une dépendance sortante que le produit n'a pas aujourd'hui ; **détecte**, ne prévient pas |
| **Console en lecture seule par défaut**, bascule explicite | supprime la classe entière des clics accidentels | une bascule que l'on laisse active en permanence ne protège plus de rien |

- Spécification produite par l'unité : nouvelle section du `docs/DAT.md`, et
  extension du §6.23 du design system si une règle réutilisable en sort.
- Dépend de : SPK-34 pour l'articulation — un second facteur et un verrou ne
  doivent pas se recouvrir sans qu'on ait dit lequel prime.
- DoD : le modèle de menace est écrit et hiérarchisé ; chaque piste ci-dessus est
  soit retenue soit **écartée avec son motif** ; les pistes retenues deviennent des
  unités `SPK-NN` avec leur DoD propre ; la question de la **récupération** —
  facteur perdu, téléphone cassé, clé matérielle égarée — est tranchée avant toute
  implémentation, faute de quoi la première mise en service enferme le responsable
  dehors ; rien n'est implémenté sous cette unité.

### [ ] SPK-36 · Instruire les plans de contingence et les gestes d'urgence

**Arbitrage du responsable, 2026-08-20 : commencer par la SAUVEGARDE DU REGISTRE.**
C'est le scénario le moins coûteux et le plus évident du lot, et c'est le seul du
lot qui se livre en **code vérifiable ici** plutôt qu'en document : sauvegarde ET
restauration, avec un test qui rejoue la restauration. Les six autres scénarios
suivront, et l'exercice réel que la DoD exige appartient au responsable, sur
l'hôte.

Le produit n'a **aucun** document d'urgence. Ce qu'il faut faire quand le pool
disparaît, quand l'hôte ne redémarre pas, quand le registre est corrompu ou
qu'une clé a fuité n'existe nulle part — et se découvre donc le jour où ça
arrive, sous pression, sans notes.

Scénarios à instruire, chacun avec **signal, geste immédiat, vérification,
reprise, et ce qui est perdu** :

- **perte du pool de stockage** — les instantanés vivent dedans (§19) : ils
  disparaissent avec lui. C'est le trou le plus grave et il doit être écrit tel
  quel, y compris dans le manuel ;
- **perte ou corruption du registre** `spark.db` — un fichier, et toute la
  correspondance Spark ↔ ressources ↔ routes ↔ clés avec lui. Sa sauvegarde est le
  candidat le plus évident du lot, et le moins coûteux ;
- **hôte qui ne redémarre pas** — reconstruction depuis `scripts/install-serveur.sh`
  et le contrat de déploiement : ce chemin est-il réellement praticable de bout en
  bout, et en combien de temps ;
- **`spark.slice` absente au démarrage** (§32.4) — la réservation redevient
  proportionnelle en silence : quel signal, quelle vérification ;
- **Incus indisponible ou incompatible après mise à jour** — SPK-31 a montré
  qu'une version en moins suffit à tout arrêter ;
- **saturation d'un pool** — disque (SPK-30), mémoire, adresses IPv4 (§15) ;
- **fuite d'une clé SSH** — le geste existe désormais et passe malgré le gel
  (§35.2) ; reste à écrire l'ordre des opérations et ce qu'on vérifie après ;
- **mot de passe de protection perdu** (§35.3) — la levée se fait sur l'hôte : la
  procédure doit être écrite, et journalisée quand elle est employée ;
- **Spark compromis de l'intérieur** — le locataire est maître de sa pile : que
  fait-on du Spark, de ses routes, de ses instantanés ;
- **entrée fantôme au registre** (INC-03) — une ressource comptée pour un Spark
  qui n'existe plus.

Ce que l'unité doit trancher, pas seulement décrire :

- les objectifs de reprise, **chiffrés** — combien de temps, combien de données
  perdues, par scénario. Un plan sans chiffre ne se vérifie pas ;
- ce qui est **sauvegardé** par le produit et ce qui reste à la charge du
  locataire. Aujourd'hui l'export hors machine est écarté et les applications
  sauvegardent vers un S3 externe par leurs propres moyens : cette frontière doit
  être énoncée là où on la lit, pas seulement dans le backlog ;
- qui exécute, avec quel accès, et ce qu'on fait quand cette personne est
  indisponible.

- Livrable : un document d'urgence dédié — `docs/CONTINGENCE.md` ou équivalent —
  lié depuis le README et le manuel, plus les unités de suite qu'il fait
  apparaître.
- DoD : chaque scénario ci-dessus a sa fiche complète ; **au moins un exercice
  réel** est exécuté sur l'hôte de validation et archivé — restauration du registre
  et reconstruction d'un Spark au minimum. Un plan jamais joué est une fiction, et
  ce dépôt ne déclare pas fait ce qui n'a pas été éprouvé ; les chiffres de reprise
  observés pendant l'exercice remplacent les chiffres espérés.

### [~] SPK-37 · Un acteur réel dans le journal, et un journal qu'on ne récrit pas par mégarde

Le champ `actor` vaut aujourd'hui la chaîne littérale « responsable » ou
« sparkd » : le journal ne sait pas qui agit. Toute idée de signature bute d'abord
là-dessus (§36.7).

- Spécification : `docs/DAT.md` §21, §36.7 · `docs/SCHEMA.md` §9.
- Portée : identité réelle de l'appelant portée jusqu'à `audit.record()` — au
  minimum l'empreinte de la clé SSH qui a ouvert le tunnel, et la distinction
  explicite entre un geste humain et un événement du runtime (§36.4) ; complétude
  de la couverture des **écritures**, y compris celles du runtime ; verrou
  d'écriture sur `audit_log` — `UPDATE` et `DELETE` refusés au niveau de la base,
  pas seulement par convention de code.
- Ne journalise **pas** les lectures (§36.7), à deux exceptions : ouverture d'un
  tunnel, vérification d'intégrité.
- DoD : un test prouve qu'un `UPDATE` ou un `DELETE` sur `audit_log` échoue,
  exécuté directement en base et non par l'application ; un test recense les
  écritures de chaque module et prouve qu'aucune n'échappe au journal ; l'acteur
  d'un geste passé par la console est distinct de celui d'un événement du runtime,
  prouvé de bout en bout ; INC-02 est réexaminé au passage — un refus de création
  doit-il porter le nom demandé.

**Livrée le 2026-08-19, sauf un point de preuve nommé plus bas.**

- Migration `005_journal_acteur` : colonne `actor_class`, et **trois
  déclencheurs** — `UPDATE` et `DELETE` refusés, classe hors domaine refusée.
  SQLite n'ajoutant pas de `CHECK` à une table existante, la contrainte ne peut
  pas être une colonne. Contrat au §21.6, schéma au §9.1.
- La constante `"responsable"` **disparaît du dépôt** : elle affirmait une
  identité que rien n'établissait. L'acteur voyage par un contexte de requête,
  pour la raison qui avait imposé le chemin d'écriture unique — ce qui se passe
  à quatorze endroits s'oublie au quinzième. Sans déclaration : `inconnu` et
  `runtime`.
- Les cinq recalculs globaux se déclarent explicitement `runtime`, y compris
  déclenchés par une requête humaine (§36.4).
- L'hôte console pose `X-Spark-Actor` : le serveur, et l'empreinte de la clé SSH
  quand OpenSSH la lui dit. Un en-tête venu du navigateur est **écrasé**.
- La console affiche l'auteur de chaque ligne, et dit « déclaré », jamais
  « signé » : l'identité attribue, elle ne prouve pas (§21.6.2).
- **Preuves** : 604 tests Python — dont 18 propres à l'unité : `UPDATE` et
  `DELETE` directs **en base** qui échouent, `INSERT` qui reste libre, complétude
  vérifiée par lecture du code source, et la distinction des deux classes prouvée
  de bout en bout par l'API ; 232 de console ; 22 parcours E2E dont un dédié ;
  contrat régénéré. Capture `e2e/captures/39-journal-auteur.png` observée.
- **INC-02 réexaminé, et NON tranché** : l'arbitrage appartient au responsable.
  Ce que l'unité change se mesure — un refus portait « responsable » et porte
  maintenant l'identité déclarée, ce qui rend deux refus consécutifs
  distinguables par qui les a demandés. L'écart subsiste sur le **nom demandé**,
  toujours absent du message, et un test le constate au lieu de le masquer.
- **Reste à prouver, et c'est le seul écart** : le relevé de l'empreinte SSH
  n'est éprouvé que sur la **forme documentée** d'OpenSSH, par test unitaire.
  Aucun `sshd` ni agent ne répond sur la machine de cette session (`ss -lntp`
  ne montre aucun port 22, `ssh-add -l` rend « Could not open a connection »),
  donc rien n'établit ici qu'un vrai tunnel émet bien cette ligne. Tant que ce
  n'est pas mesuré contre un serveur réel, l'unité reste `[~]`. Le reste du
  contrat — verrou, classes, contexte, en-tête, affichage — est prouvé.

### [x] SPK-38 · Chaîne d'intégrité du journal et ancre tenue par la console

Chaque entrée porte l'empreinte de la précédente, et la console retient la tête
qu'elle a vue. C'est l'ancre qui donne sa valeur à la chaîne, pas la chaîne
(§36.1, §36.2).

- Spécification : `docs/DAT.md` §36.1 à §36.5 · `docs/SCHEMA.md` (migration due).
- Dépend de : SPK-37 — chaîner un journal dont l'acteur est une constante n'a
  pas d'intérêt.
- Portée : sérialisation **canonique** figée et documentée ; empreinte de la
  ligne et de la précédente, calculées et insérées dans la **même transaction**
  que la lecture de la tête ; lignes de point de contrôle ; `GET` de vérification
  rendant l'état de la chaîne et la première rupture s'il y en a une ; ancre
  côté console — dernière tête connue par serveur dans l'inventaire local, et
  signalement lorsqu'une histoire ne la prolonge pas.
- Tranché avant la première ligne écrite : le journal **ne se purge pas**, ou une
  purge scelle le préfixe dans un point de contrôle (§36.5). Laisser la question
  ouverte reviendrait à casser la chaîne le jour où le fichier grossit.
- DoD : un test modifie une ligne en base et prouve que la vérification la
  **désigne** ; un test supprime une ligne au milieu et prouve la détection ; un
  test tronque la fin et prouve que **seule l'ancre** la détecte — la chaîne seule
  ne le peut pas, et le test le documente ; un test prouve qu'un trou
  d'identifiant, produit par un `ROLLBACK` réel, **ne** déclenche **pas** d'alerte ;
  un parcours E2E montre l'ancre signalant une histoire qui ne prolonge pas la
  précédente.

**Livrée le 2026-08-19, close le 2026-08-20 par le parcours au navigateur.**

- Migration `006_journal_chaine` : `entry_hash` et `prev_hash`, défaut à la chaîne
  vide. Les lignes antérieures **ne sont pas chaînées rétroactivement** — une
  chaîne recalculée ne prouverait que la capacité à calculer un `sha256`.
- Sérialisation **canonique figée** (§36.9.2), `id` exclu de l'empreinte.
- La tête se lit et la ligne s'écrit sous une même transaction ; quand une
  transaction est déjà ouverte, `record()` n'en ouvre pas une seconde — ce qui
  laisse un refus être journalisé hors transaction (§21.1).
- `GET /v1/audit/verify` : première rupture désignée, motif distingué —
  `entry_hash` (ligne récrite) ou `prev_hash` (ligne retirée ou insérée).
- **Purge tranchée** : le journal ne se purge pas. La vérification connaît déjà le
  point de contrôle, pour ne pas devoir être modifiée le jour de la purge.
- **Ancre** côté console : cinq verdicts, dont `shrunk` et `diverged`, les deux
  attaques que la chaîne seule ne voit pas. Jamais écrasée sur une alerte.
- **Preuves** : 617 tests Python — dont 13 propres à l'unité : ligne modifiée
  **désignée**, ligne supprimée au milieu **détectée**, ligne insérée détectée,
  troncature **non détectée et le test le documente**, trou d'identifiant sans
  alerte, refus hors transaction toujours chaîné ; 246 de console dont 11 sur
  l'ancre et 3 de bout en bout console → tunnel → `sparkd` ; 22 parcours E2E ;
  contrat régénéré.
- **Correction de spécification, mesurée** : le §36.5 affirmait qu'`AUTOINCREMENT`
  consomme un identifiant qu'un `ROLLBACK` abandonne. C'est **faux sur SQLite**,
  qui annule aussi `sqlite_sequence`. Le DAT est corrigé ; la règle « ne jamais
  juger la continuité des `id` » reste, comme garantie de conception.
- **Parcours E2E livré le 2026-08-20**, le dernier point de la DoD. Depuis
  l'accueil, à la souris et au clavier : la console pose sa référence, on coupe
  la fin du journal **en base**, et le même geste rend « le journal a raccourci »
  pendant que la chaîne, elle, s'affiche **intacte**. Un troisième relevé alerte
  encore — l'ancre n'est pas écrasée par l'alerte (§36.9.6).
- **Mesuré en écrivant ce parcours** : le verrou d'immuabilité de SPK-37 refuse
  le `DELETE`. Le parcours lève donc le déclencheur, coupe, puis le rétablit et
  **vérifie qu'il est revenu**. C'est le pouvoir que l'ancre suppose à
  l'adversaire (§36.1) ; ce n'est pas un contournement du produit, et le parcours
  ne s'exécuterait plus contre la Forge livrée s'il laissait la garde désarmée.
- **Défaut d'interface trouvé et corrigé au passage** : la rupture de chaîne
  portait `role="alert"`, l'alerte d'ancre non. Deux signaux de même gravité dont
  un seul est annoncé — et le muet était justement le seul que la chaîne ne sait
  pas voir. Règle écrite en `docs/DESIGN_SYSTEM_APP.md` **SPK-DS-06**.
- **Fuite d'état corrigée** : le harnais de captures ne passait pas de chemin
  d'ancre, donc il écrivait dans le `~/.config/spark` du poste et le verdict de
  la capture dépendait de la machine qui la produisait. Chemin jetable désormais.
- Le parcours **ampute le journal de la pile** : il est le dernier du fichier, et
  un commentaire dit pourquoi il doit le rester. Même contrainte pour
  l'illustration `m12-ancre-alerte.png`, produite en dernier.
- Captures observées : `e2e/captures/44-journal-ancre-alerte.png`,
  `45-journal-ancre-mobile.png`, `docs/manuel/images/m12-ancre-alerte.png`.

### [x] SPK-39 · Onglet de supervision du journal

Le journal devient une destination sous **Hôte** (§34.1, §36.8) : il couvre tous
les Sparks.

- Spécification : `docs/DAT.md` §36.8 · `docs/DESIGN_SYSTEM.md` §5.4, §6.14
  (tableau), §6.13 (états de vue) · manuel M12.
- Dépend de : SPK-37 et SPK-38.
- Portée : entrées filtrables par résultat, action, acteur et période ; état de la
  chaîne et date du dernier relevé ; comparaison avec l'ancre de la console ;
  **classe** de chaque entrée — geste humain signé, ou événement du runtime
  (§36.4) ; la vérification est un relevé explicite, jamais rejoué à chaque
  affichage.
- À traiter dans la même unité : INC-01. Cet onglet expose sur une page entière
  l'écart de vocabulaire entre les messages du runtime et les libellés de
  l'interface ; il le rend plus visible qu'aujourd'hui, il ne l'invente pas.
- DoD : parcours E2E depuis le parcours canonique — ouvrir l'onglet, filtrer,
  lancer la vérification, lire son résultat ; un parcours montre l'écran quand la
  chaîne est **rompue**, et il est capturé ; captures observées, y compris état
  vide et données longues ; manuel M12 mis à jour.

**Livrée et intégralement prouvée le 2026-08-19.**

- `#/hote/journal`, troisième onglet de second degré. Il couvre **tous** les
  Sparks ; la facette d'un Spark reste, et répond à l'autre question.
- Cinq filtres au runtime — résultat, action (par **préfixe**), acteur (par
  sous-chaîne), classe, date minimale. Un filtre à valeur inconnue est **refusé**
  en `422`, jamais ignoré.
- La chaîne **et** l'ancre sont rendues à part, jamais résumées en un indicateur :
  une chaîne intacte avec une ancre qui alerte est exactement la troncature.
  Tant qu'aucun relevé n'a eu lieu, l'écran le dit au lieu d'afficher « intacte ».
- La vérification est un relevé **explicite**, jamais rejoué à l'affichage.
- L'écran n'écrit **jamais** « signé » — une preuve l'interdit.
- **Preuves** : 617 tests Python, 260 de console dont 14 propres à cet écran, 8
  gestes, **23 parcours E2E** dont celui que la DoD nomme — ouvrir, filtrer,
  vérifier, lire —, 7 contrôles du manuel, build, contrat régénéré.
- **Observé** : `e2e/captures/40-journal-supervision.png`, `41-journal-integrite.png`,
  `42-journal-mobile.png` (390 px), **`43-journal-chaine-rompue.png`**, et
  l'illustration `docs/manuel/images/m12-journal.png`.
- **Trois défauts trouvés par la mesure** : les filtres partaient en escalier
  (alignement par le bas, avec une aide de trois lignes) ; l'auteur tronqué
  n'était plus consultable ; et un « Tout afficher » s'affichait alors que tout
  était déjà affiché.
- **INC-01 traité comme la DoD le demande** : l'écart change d'échelle et la
  nouvelle mesure est consignée au registre. L'onglet ne réécrit aucun message —
  le trancher **serait** l'arbitrage, qui appartient au responsable — mais le
  manuel M12 le nomme, pour qu'on ne cherche pas une erreur là où il n'y en a pas.

### [ ] SPK-40 · Signature des gestes par la clé du responsable

La console signe la requête avec la clé SSH du responsable, par son agent ;
`sparkd` conserve la signature et les octets signés. Root sur l'hôte peut alors
supprimer ou tronquer, mais **pas fabriquer** un geste authentique (§36.3).

- Spécification : `docs/DAT.md` §36.3, §36.4.
- Dépend de : SPK-35 pour l'arbitrage — c'est la même mécanique que la piste
  « signature par la clé SSH » de la sécurisation des actions sensibles, et il
  serait absurde d'en écrire deux. **Ne pas démarrer avant cet arbitrage.**
- Ce que l'unité ne prétendra pas : la signature atteste l'**intention**, pas ce
  que le runtime a fait ensuite ; le résultat reste couvert par la chaîne. Et une
  ligne produite par le runtime n'est signée par personne — la supervision le dit
  au lieu de le masquer.

### [x] SPK-41 · Catalogue local des serveurs, tenu depuis la console

Le catalogue **existe** — `~/.config/spark/servers.json`, validé, sans secret, et
`GET`/`POST /api/servers` le servent (SPK-16). Ce qui manque, c'est tout ce qui
permet de s'en servir sans éditeur de texte.

Constaté dans le code le 2026-08-19 :

- aucune interface n'appelle `POST /api/servers` : une entrée s'ajoute **à la
  main** dans le fichier ;
- il n'existe pas de `DELETE /api/servers` : une entrée ne se retire pas ;
- la console prend `servers[0]` au démarrage — **aucun sélecteur**, alors que
  `docs/DESIGN_SYSTEM_APP.md` §1 place le serveur courant au-dessus du premier
  degré de navigation ;
- le tunnel n'est ouvert **qu'au démarrage** (§22.6) : un tunnel rompu ensuite
  n'a aucune commande de reconnexion à l'écran.

- Spécification : `docs/DAT.md` §22.4, **§22.4 bis**, §22.5, §22.6 ·
  `docs/DESIGN_SYSTEM.md` §5.4, §6.27 (le catalogue est une section, l'ajout une
  modale) · `docs/DESIGN_SYSTEM_APP.md` §1 · manuel M3.
- Portée : ajout, modification et retrait depuis la console ; sélecteur de
  serveur courant, avec le dernier utilisé retenu ; commande de reconnexion
  explicite et reprise automatique visible ; alias `ssh` accepté en plus du
  triplet (§22.4 bis) ; proposition — jamais l'ajout d'office — des `Host` du
  `~/.ssh/config` ; **épreuve avant enregistrement** : le tunnel est ouvert et
  `/healthz` puis `/readyz` sont appelés **à travers lui**, et le résultat est
  affiché ; champ de version dans le fichier, pour que sa forme puisse évoluer
  sans deviner ; fichier en `0600`.
- L'épreuve **informe, elle ne décide pas** : un serveur injoignable au moment de
  l'ajout peut être enregistré quand même, avec l'avertissement. C'est la règle du
  §25.1, et elle vaut ici pour la même raison — la machine peut être éteinte.
- Prévoir le champ d'**ancre d'audit** par serveur (§36.2) : c'est ce fichier qui
  retiendra la dernière tête connue. SPK-38 l'écrit, SPK-41 lui laisse la place.
- Ne fait **pas** partie de la portée : stocker une clé, une phrase de passe ou un
  mot de passe (§22.4), et désactiver la vérification de la clé d'hôte (§22.4 bis).
- DoD : parcours E2E depuis le parcours canonique — ajouter un serveur, voir
  l'épreuve, basculer entre deux serveurs, rompre le tunnel et le rouvrir depuis
  l'écran, retirer l'entrée ; un test prouve qu'aucun champ de secret n'est
  accepté, même envoyé explicitement ; un test prouve qu'une entrée par alias
  `ssh` ouvre le tunnel sans que le produit connaisse ni `user` ni `port` ;
  captures observées, dont l'état « aucun serveur enregistré » ; manuel M3 et
  seed mis à jour.

**Le socle et le contexte sont LIVRÉS ; l'écran d'administration du catalogue ne
l'est pas.** Contrat au §22.4 ter du DAT, écrit et committé avant le code.

- **Livré et prouvé** :
  - genre **`alias`** — l'entrée ne nomme qu'un `Host` du `ssh_config`, et le
    produit ne connaît ni `user`, ni `port`, ni le rebond. Le tunnel passe le
    `Host` tel quel, sans `-p` ni `user@`, et **ne désactive jamais** la
    vérification de la clé d'hôte ;
  - **version du fichier** : la forme historique se lit encore et n'est **pas**
    réécrite à la lecture ; la conversion attend un enregistrement ;
  - **serveur courant persisté**, et sélecteur à l'écran dès qu'il y a le choix ;
  - `DELETE /api/servers` — **ferme le tunnel** avant d'effacer, et donne la place
    au suivant si c'est le courant qui part ;
  - `POST /api/servers/current`, `GET /api/ssh-hosts` (proposition, jamais ajout
    d'office, motifs écartés), `POST /api/servers/probe` ;
  - **épreuve** : tunnel temporaire, `/healthz` puis `/readyz` **à travers lui**,
    refermé dans tous les cas. Elle informe et ne décide pas — un serveur
    injoignable s'enregistre quand même ;
  - **commande de reconnexion** sur un tunnel rompu, la tentative étant montrée.
- **Preuves** : 88 tests de l'hôte console, dont 13 propres aux nouvelles routes —
  secret refusé même envoyé explicitement, épreuve qui n'enregistre rien et ne
  laisse aucun `ssh`, retrait du courant, entrée par alias sans `user` ni `port` ;
  284 tests de console ; 617 Python ; 23 parcours E2E ; build.
- **Observé** : `e2e/captures/09-tunnel-rompu.png` — sélecteur, badge et commande
  de reconnexion, après correction d'un contexte qui était **écrasé** dans une
  barre latérale de 240 px.
- Deux preuves **révisées avec leur raison** : le message d'un genre inconnu
  énumère trois genres, et le fichier a un objet à sa racine.
**L'écran est LIVRÉ le 2026-08-20**, et sa surface est tranchée au §22.4.7 bis.

- Destination **« Serveurs »** au premier degré : elle gère ce qui est **déclaré**,
  là où le sélecteur au-dessus choisit ce qu'on **regarde**. Elle ne pouvait pas
  être un onglet sous *Hôte* — un catalogue rangé là disparaîtrait avec le tunnel
  qui le sert, alors qu'il est ce qui permet d'en choisir un autre.
- Tableau des serveurs, ligne du courant signalée, bascule, retrait confirmé qui
  **nomme** le serveur et dit ce qui n'est pas touché.
- Modale d'ajout dont les **champs suivent le genre** (§22.4.7 ter), candidats du
  `ssh_config` proposés dans une liste où l'on peut saisir librement, et
  **épreuve** dont le verdict ne bloque jamais l'enregistrement.
- **Défaut trouvé en produisant la capture de la DoD** : sans aucun serveur, la
  console affichait une erreur globale et l'écran du catalogue était
  **inatteignable** — alors que c'est le seul endroit d'où en déclarer un. Elle y
  mène désormais.
- **Défaut trouvé par le parcours E2E** : sur un fichier en forme historique, où
  le courant est nul, l'ajout d'un second serveur lui **volait le contexte**,
  alors que la lecture montrait le premier. Le test unitaire ne le voyait pas — il
  partait d'un fichier neuf.
- **Preuves** : 300 tests de console dont 16 propres à cet écran, 88 de l'hôte
  console, 617 Python, **25 parcours E2E** dont les deux de cette unité — le
  parcours complet de la DoD (ajouter, éprouver, basculer, retirer, avec l'effet
  constaté sur l'inventaire du poste à chaque étape) et le refus d'un secret ;
  build ; contrat sans dérive.
- **Observé** : `e2e/captures/44-serveurs.png`, `45-serveurs-ajout.png`,
  `46-serveurs-aucun.png` (l'état que la DoD nomme), et
  `docs/manuel/images/m3-serveurs.png`. Manuel M3 réécrit.
**Close le 2026-08-20.**

- **Modification** d'une entrée existante : chaque ligne porte son bouton, la
  modale s'ouvre **pré-remplie depuis l'entrée réelle** — un alias n'a ni
  utilisateur ni port, et les valeurs par défaut rempliraient des champs que le
  produit ne connaît pas. Le **nom y est en lecture seule** (§22.4.7 ter) : `POST`
  remplaçant par le nom, le changer créerait une seconde entrée en laissant la
  première. Le genre, lui, reste modifiable.
- **Pile de développement** : elle écrivait encore un tableau nu — la forme qui a
  causé le vol de contexte — et un seul serveur. Elle écrit la version 1 et
  **deux** serveurs, dont un par alias délibérément injoignable : sans lui, ni le
  sélecteur ni un tunnel fermé ne se verraient, et l'écran ne présenterait que le
  cas heureux.
- **Défaut trouvé sur la capture** : le focus entrait dans le champ « Nom », en
  lecture seule — la saisie commençait là où elle est impossible. Le composant de
  modale saute désormais les contrôles verrouillés, ce qui vaut pour toutes les
  modales du produit.
- **Preuves** : 617 Python, **305 de console** dont 21 propres à cet écran, 88 de
  l'hôte console, 6 de contrat, 8 gestes, **26 parcours E2E** dont les trois de
  cette unité — le parcours complet de la DoD, le refus d'un secret, et la
  modification qui ne duplique pas —, 7 contrôles du manuel, build, contrat sans
  dérive.
- **Observé** : `44-serveurs.png`, `45-serveurs-ajout.png`, `46-serveurs-aucun.png`,
  `47-serveurs-modifier.png`, et `docs/manuel/images/m3-serveurs.png`.

### [x] SPK-42 · Nommer la machine qui porte `sparkd`, et propager le nom

**ARBITRÉ le 2026-08-20 : la machine est une « Forge ».**

Un Spark est une fraction de machine, `sparkd` est le démon — la machine, elle,
n'avait pas de nom de produit. Elle était appelée « l'hôte », terme déjà pris :
le §22 nomme « hôte console » le processus Node du poste local. Le même mot
désignait donc deux machines différentes, et la console affichait les deux.

**Forge** lève la collision, se pluralise sans ambiguïté, survit en identifiant
de code comme en segment d'URL, et ne ment pas sur la portée : une Forge est
**une** machine, pas une grappe. Elle produit des Sparks, ce que le mot dit.

- Candidats instruits dans `docs/JOURNAL.md` (entrée du 2026-08-19) : **Forge**
  — retenu —, **Foyer**, et les écartés avec leur motif.
- Critères retenus pour trancher : lever la collision avec « hôte console » ;
  survivre en identifiant de code et en segment d'URL ; se pluraliser sans
  ambiguïté ; ne pas mentir sur la portée — c'est **une** machine, pas une grappe.
- Portée de l'unité, une fois le nom arbitré : glossaire du DAT et du design
  system d'application, libellés d'interface, `docs/manuel/`, puis la table
  `host`, la route `/v1/host`, le contrat d'API et ses types générés, le fichier
  `servers.json` et son schéma.
- **À faire maintenant ou pas du tout.** Le contrat n'a qu'un consommateur, le
  dépôt lui-même. Chaque unité livrée après cet arbitrage augmente le coût du
  renommage, et un produit qui garde deux mots pour la même chose finit par les
  employer tous les deux au hasard.
- DoD : le nom est arbitré et écrit ; plus aucune occurrence du terme abandonné
  dans le sens visé — vérifié par une recherche, pas par mémoire ; migration de
  la table et du contrat livrées ensemble ; `make contract-check` vert ; manuel
  et captures refaits.

**Le CODE est renommé le 2026-08-20 ; la documentation ne l'est pas encore.**

Le contrat du renommage est au **§1 bis** du DAT, écrit et committé avant le
code. Le point qui décide de tout y est écrit : c'est un renommage **sémantique**,
jamais textuel — `host` a trois sens ici et deux ne bougent pas.

- **Livré** :
  - migration `007_forge` : `ALTER TABLE host RENAME TO forge`. SQLite renomme
    sans recopier et met à jour les clés étrangères ; aucune donnée ne bouge.
    `hostname` **reste**, elle porte le nom réseau et non le concept ;
  - `GET /v1/forge`, `POST /v1/forge/sync`, `GET /v1/forge/cores`, refus
    `forge_not_synced`, contrat régénéré. **Aucun alias** sur l'ancien chemin ;
  - console : destination `#/forge`, entrée de navigation « Forge », et les
    libellés — « Ressources de la Forge », « Sections de la Forge », « réserve de
    la Forge », « tranches de la Forge », « mesurable sur cette Forge ».
- **Volontairement inchangé** (§1 bis.1) : le mot au sens **réseau** — `hostname`,
  `SPARKD_BIND`, le `host` d'un serveur dans `servers.json`, `sshHost`, et le
  libellé « Hôte, utilisateur et port » du formulaire d'un serveur SSH. Et
  « hôte console », dont la collision disparaît puisque l'autre sens s'en va.
- **Preuves** : 617 Python, 217 de console, 88 de l'hôte console, 6 de contrat,
  8 gestes, **26 parcours E2E**, 7 contrôles du manuel, build, `contract-check`
  vert. Captures et illustrations refaites ; `29-hote-pools.png` observée.
- **Cinq preuves révisées avec leur raison** : la liste des tables — qui exige en
  plus que `host` n'existe plus —, les chemins du contrat — qui exigent qu'aucun
  alias ne subsiste —, le chemin relayé par l'hôte console, et deux libellés.
- **Reste à livrer, et c'est pourquoi l'unité n'est pas `[x]`** :
  1. **la documentation** — `docs/DAT.md`, `docs/SCHEMA.md`, `docs/PROD_MIGRATIONS.md`,
     `docs/MANUAL_PLAN.md` et le **manuel** (M2, M3, M6, M10, M11, M12) emploient
     encore « hôte » au sens de la machine. C'est la tranche 3 du §1 bis.2, et
     elle est purement rédactionnelle — mais elle doit distinguer les trois sens,
     comme le code l'a fait ;
  2. les **noms de fichiers** de la console — `host-view.js`, `host-images.js`,
     `host-journal.js` — et leurs identifiants internes portent encore l'ancien
     mot. Aucun n'est visible de l'utilisateur ni du contrat ; c'est le dernier
     morceau, et le moins urgent ;
  3. la vérification finale de la DoD — « plus aucune occurrence dans le sens
     visé » — ne peut être faite qu'après 1 et 2.

**Tranche 3 livrée le 2026-08-20 : l'unité est close.**

- **Fichiers de la console renommés** : `host-view.js`, `host-images.js` et
  `host-journal.js` deviennent `forge-*`, et leurs identifiants suivent —
  `renderHostView`, `renderJournalHote`, `titre-journal-hote`.
- **211 occurrences renommées au sens de la machine** : 142 dans la
  documentation — DAT, schéma, contrat de déploiement, plan du manuel, design
  system d'application et neuf chapitres du manuel — et 69 dans le code du
  runtime, les harnais E2E et le `README.md`. Le contrat d'API portait la
  description de la route des pools et a été régénéré.
- **Le sens RÉSEAU n'a pas bougé**, comme le §1 bis.1 l'exige. Deux tournures
  ont rejoint la liste des protégées en cours de route : « un hôte Docker »,
  qu'un Spark **est** — ce n'est pas une Forge —, et « hôte inconnu », message
  d'OpenSSH.
- **Trois défauts trouvés en RELISANT le résultat**, pas en le supposant : des
  accords restés au masculin — Forge est féminin —, et surtout la **mention
  historique** du §1 bis, qui explique qu'on disait « l'hôte » : la remplacer
  détruisait l'explication elle-même.
- **Vérification finale de la DoD, par recherche** : plus aucune occurrence du
  terme abandonné dans le sens visé, hors `docs/JOURNAL.md`, `docs/BACKLOG.md`,
  `CHANGELOG.md` et `docs/ORIGIN_CONVERSATION.md`, qui sont des **archives** —
  y réécrire le passé le falsifierait.
- **Preuves** : 653 Python, 413 de console et d'hôte console, 6 de contrat,
  8 gestes, **39 parcours E2E**, 7 contrôles du manuel, build et
  `contract-check` vert. 13 illustrations du manuel refaites et observées.

### [x] SPK-46 · La console traduit les états que le serveur rapporte

**Arbitrage du responsable, 2026-08-20** (registre, INC-01) : le journal reste un
enregistrement technique, et c'est la **console** qui traduit à l'affichage.

- Spécification : `docs/DAT.md` §21.5 bis · `docs/DESIGN_SYSTEM.md` §14.7 ·
  `docs/DESIGN_SYSTEM_APP.md` SPK-DS-01 (les libellés d'état).
- Portée : les messages venus du serveur — journal d'audit, erreurs de l'hôte
  console — sont traduits **à l'affichage**, sur les formes que la console sait
  reconnaître : les transitions d'état (« `starting` → `running` ») et les états
  de tunnel (« broken »). Un seul endroit, partagé par la facette *Journal* d'un
  Spark et l'onglet de supervision.
- **Ce qu'elle ne fait pas** : deviner. Ce que la console ne reconnaît pas est
  affiché **tel quel**, sans être déformé — un message inconnu mal traduit serait
  pire que le même message resté technique. Aucun message n'est réécrit côté
  serveur.
- DoD : un test prouve qu'une transition connue est traduite dans les DEUX
  surfaces ; un test prouve qu'un message inconnu traverse **intact** ; le
  message d'erreur de tunnel du §22.3 est traduit lui aussi, ce que le registre
  signalait comme le même motif ; captures de la facette *Journal* et de l'onglet
  de supervision refaites et observées ; INC-01 retiré du registre dans le même
  changement.
- **Livré et vérifié le 2026-08-20.**
  - La traduction vit dans `tokens.js`, où vivent déjà les libellés, et les deux
    surfaces l'emploient. Le message d'erreur de tunnel est traduit lui aussi.
  - 6 preuves sur la traduction elle-même, 3 sur l'onglet de supervision, 2 sur
    la facette *Journal*. Elles gardent surtout ce qu'elle NE fait pas : un nom
    de serveur cité entre guillemets n'est pas un état et n'est pas déformé, un
    message inconnu traverse mot pour mot, et seul l'état connu d'un message
    mixte est traduit.
  - Détail d'implémentation qui compte : la table est consultée **directement**
    et non par `stateOf`, dont le repli « État inconnu (…) » aurait déformé tout
    mot cité qui n'est pas un état.
  - Captures `73-` et `74-` observées : plus aucun vocabulaire technique sur les
    deux écrans, et les messages que la console ne reconnaît pas sont intacts.
- **INC-01 est retiré.** C'était la dernière entrée du registre, qui a donc été
  **supprimé du dépôt** — `CLAUDE.md` §5 : un registre vide qu'on garde se lit
  comme un registre qu'on ne tient plus. Il réapparaîtra au premier écart
  constaté.

### [~] SPK-43 · Terminal dans un Spark depuis la console

Le transport de tous les outils du §37, et le premier d'entre eux.

- Spécification : `docs/DAT.md` §37.1 à §37.5, complétée le 2026-08-20 par les
  §37.4.1 à §37.4.5 — le transport, la vie de la session, la limite du
  redimensionnement, la surface d'API et ce que le journal reçoit ·
  `docs/DESIGN_SYSTEM_APP.md` SPK-DS-04 · manuel M8.
- **Décision de transport (§37.4.1)** : un flux d'évènements et des envois, pas
  une WebSocket. La console n'a AUCUNE dépendance d'exécution — mesuré — et le
  navigateur porte `EventSource` nativement. `ssh -tt` fournit le
  pseudo-terminal côté Spark, ce qui évite aussi `node-pty`.
- Portée : pseudo-terminal servi par l'hôte console sur la boucle locale, rendu
  dans le navigateur ; transport **SSH vers le Spark** par le tunnel existant,
  avec la clé du responsable — `sparkd` n'est pas dans ce chemin (§37.1) ;
  fermeture de l'onglet qui **termine** le processus distant ; fermeture après
  inactivité, annoncée avant ; propagation du redimensionnement ; mode lecteur
  d'écran activable et retenu ; entrée d'audit à l'ouverture et à la fermeture,
  avec l'acteur, la cible, le chemin et la durée — **et rien du contenu** (§37.5).
- Chemin de dépannage `incus exec`, aux quatre conditions du §37.3 : Spark en
  `error` ou `sshd` muet, confirmation qui **nomme le pouvoir employé**, action
  d'audit distincte `spark.rescue_exec`, bannière visible toute la session. Ce
  n'est jamais le chemin par défaut.
- Cas à traiter explicitement, pas à laisser en erreur technique : un Spark sans
  `sshd` — l'image de base n'en a pas (§17.1). L'écran nomme ce qui manque.
- Le terminal reste **ouvert sous gel** (§37.7), avec l'état protégé affiché en
  permanence.
- DoD : parcours E2E depuis le parcours canonique — ouvrir la fenêtre d'un Spark,
  entrer dans le terminal, exécuter une commande, la voir répondre, quitter et
  vérifier que le processus distant est mort ; un test prouve que le journal porte
  l'ouverture et la fermeture **et rien de ce qui a été tapé** ; un parcours
  montre l'écran d'un Spark sans `sshd` ; un parcours emprunte le dépannage et
  prouve son audit distinct ; captures observées, dont la bannière de dépannage ;
  manuel M8 mis à jour.

**Première tranche livrée le 2026-08-20 — le TRANSPORT et sa traçabilité.**

- **Livré et prouvé** :
  - `apps/webui/host/terminal.js` : une session lance `ssh -tt` vers le Spark
    par rebond sur sa Forge, avec la clé du poste. **18 preuves**, dont les deux
    qui portent l'unité : ce que la session décrit ne contient aucune frappe ni
    aucune sortie, et le module ne retient **aucun historique même en mémoire**.
    Fermer tue le distant ; l'arrêt de l'hôte console ne laisse aucun shell ;
    l'avis d'inactivité arrive **avant** la fermeture et une frappe la repousse ;
    l'identifiant est tiré au hasard et ne dérive pas du nom du Spark.
  - `Tunnel.jumpArgs()` : le rebond se construit sur le tunnel, qui sait déjà
    comment on atteint son serveur.
  - **`POST /v1/audit`**, la porte étroite du §37.4.6, avec **8 preuves** : liste
    blanche d'actions, acteur pris de l'en-tête et non du corps, charge bornée à
    `path`, `reason` et `duration_seconds`. L'entrée rejoint la chaîne
    d'intégrité sans être distinguée.
**Deuxième tranche, 2026-08-20 : les routes sont prouvées, et l'écran existe.**

- **L'obstacle de la tranche 1 était un DÉFAUT DU PRODUIT**, pas du harnais :
  Node n'émet pas les en-têtes d'une réponse tant que rien n'y est écrit.
  L'ouverture du flux ne se terminait donc **jamais** côté client — un
  `EventSource` de navigateur serait resté pendu, sans qu'aucune erreur ne le
  dise. Les en-têtes sont poussés, un commentaire d'amorce prouve que le flux est
  ouvert, et l'en-tête qui désactive la mise en tampon d'un intermédiaire
  l'accompagne.
- **Les cinq routes sont prouvées** : 10 preuves dans leur propre fichier, dont
  qu'aucun octet de la session n'atteint le journal, que la fermeture du flux tue
  le distant, et qu'un Spark sans adresse est nommé plutôt que rendu par une
  erreur technique.
- **L'écran existe** : une facette *Terminal* de la fenêtre d'un Spark, avec
  16 preuves. L'état protégé et le chemin employé restent affichés pendant toute
  la session ; l'écran prévient que quitter l'onglet termine la session ; il ne
  porte aucun bouton d'action Docker ; les motifs de fermeture sont dits en
  français ; le mode lecteur d'écran fait du terminal une région annoncée.
  Captures `75-` à `77-` observées, format étroit compris.
- **Défaut corrigé en capturant** : la facette manquait au motif du routeur.
  L'adresse n'était pas rechargeable — ce que SPK-DS-04 exige d'une destination —
  et l'onglet menait silencieusement à « Infos ».

**Troisième tranche, 2026-08-20 : l'écran est câblé et le parcours de la DoD passe.**

- **Le câblage est livré** : le bouton ouvre, `EventSource` porte la sortie, les
  frappes partent **groupées** (§37.4.1 — sans quoi coller un script ferait une
  requête par ligne), la taille se propage, et quitter l'onglet termine la
  session — par le changement d'adresse **et** par une balise quand la page se
  démonte. `sendBeacon` ne sait que POSTer et c'est le seul envoi qui parte encore
  à la fermeture d'un onglet, d'où `POST /api/terminal/fermeture` ; sans elle,
  fermer le navigateur laissait un shell root vivant jusqu'au délai d'inactivité.
- **Les octets vont DIRECTEMENT au DOM** : l'état de l'écran n'en garde aucune
  trace, parce qu'un tampon dans l'état serait sérialisé.
- **Le parcours de la DoD passe** : entrer dans le terminal, écrire au clavier,
  voir répondre, quitter, et constater que le journal porte l'ouverture et la
  fermeture avec sa durée — et **rien** de ce qui a été tapé. Deux autres
  parcours : changer d'onglet termine la session, et un Spark sans cellule nomme
  ce qui manque.
- **Doublon du transport** (§37.4.2 bis) : `SPARK_TERMINAL_COMMAND` remplace la
  commande lancée, pas le mécanisme — tout le reste du chemin est celui de la
  production. Absente en production.
- **Défaut corrigé, trouvé par un parcours** : je jugeais qu'un Spark n'avait rien
  où se connecter à son **adresse**, alors qu'elle est attribuée dès l'écriture au
  registre. Un Spark `pending` porte déjà la sienne, et s'y fier laissait ouvrir
  un terminal vers rien. Le signal est la **cellule**, comme au §39.4.
- **Preuves** : 665 Python, 461 de console et d'hôte console, 6 de contrat,
  8 gestes, **42 parcours E2E**, 7 contrôles du manuel, build et
  `contract-check`. Captures `78-` à `81-` observées, format étroit compris.
  Manuel M8 mis à jour.

**Quatrième tranche, 2026-08-20 : le chemin de dépannage, ses quatre conditions
tenues.**

- Le dépannage ne se connecte PAS au Spark — c'est lui qui ne répond pas. Il vise
  la **Forge** et lui fait exécuter `incus exec <cellule> -- /bin/bash`. Sur une
  Forge locale, aucun `ssh` n'est lancé : `incus` s'exécute sur place.
- **La règle d'accès est appliquée par l'hôte console**, qui est le backend de ce
  chemin puisque `sparkd` n'y est pas (§37.1). Masquer un bouton n'aurait été
  qu'une aide d'interface (`CLAUDE.md` §10) : sept preuves passent par la route,
  aucune par le composant.
- **Point qui décide, et qui n'était pas dans la spécification** : « le `sshd` ne
  répond pas » et « le `sshd` répond et refuse la clé » ne sont pas le même
  incident. Le second se règle en réaccordant la clé, et l'écran le renvoie à
  l'onglet *Clés*. Un échec **non reconnu** n'ouvre rien non plus — ouvrir sur un
  doute reviendrait à ouvrir toujours, puisque toute panne finit par produire un
  message inconnu. Et un `ssh` introuvable ne fait pas conclure que le `sshd`
  distant est muet, sinon le dépannage s'ouvrirait parce que la console est mal
  installée.
- Le sondage emprunte **exactement** le chemin du terminal normal et n'exécute que
  `true` : sonder autrement mesurerait un autre chemin que celui qu'on s'apprête à
  déclarer indisponible. Il n'a pas lieu quand l'état suffit — un Spark en erreur
  ouvre le chemin sans cinq secondes d'attente de plus.
- Confirmation **dans le flux** (§6.22) qui nomme le pouvoir employé, action
  d'audit **distincte** `spark.rescue_exec` avec son motif, et bannière portant le
  chemin RÉEL de la session, qui tient après la fin du shell distant.
- **Deux défauts que seules les captures ont montrés** : `bouton--danger`
  n'existe pas dans la feuille de style — le point d'engagement se rendait en
  secondaire là où le §6.23 exige la variante destructive —, et le libellé du
  chemin, tenu dans une pastille `white-space: nowrap`, se coupait au tiers sous
  390 px. Vingt-six preuves de composant étaient vertes avec le premier en place.
  D'où le contrôle du §12.3, jusque-là absent : `apps/webui/src/styles/classes.test.js`.
- **Preuves** : 667 Python, 35 d'hôte console et 19 de routes, 27 de composant,
  3 de classes CSS, **45 parcours E2E** dont deux neufs. Captures `78-` à `82-`
  observées, format étroit compris. Manuel M8 mis à jour, illustration
  `m8-depannage.png`.

**Cinquième tranche, 2026-08-20 : l'écran dit ce qui manque, et une course est
corrigée.**

- `GET /api/terminal/diagnostic` **mesure** au lieu de deviner, et mesure du
  DEHORS de la session : la console ne retient aucun octet de ce qui a transité
  (§37.5), donc elle ne peut pas inspecter la sortie pour en déduire la cause.
  Lecture pure, rien d'ouvert, rien de journalisé (§36.7).
- L'écran nomme les trois issues et les distingue : `sshd` muet — qui ouvre le
  dépannage, offert juste à côté —, clé refusée — qui renvoie à l'onglet *Clés*,
  parce que le dépannage ne réglerait pas ce problème-là —, et serveur qui
  répond. Les trois états de la mesure ne se confondent pas non plus (§6.13,
  §14.6) : en cours, rendue, **impossible**.
- **Défaut trouvé par le parcours, et il comptait plus que le reste** : un distant
  qui meurt AVANT que le flux soit branché diffusait sa fin à zéro abonné, et
  `fermer()` vidait ensuite la liste. L'écran restait sur « session ouverte »
  pour une session morte, indéfiniment. C'est la course exacte d'un `sshd` muet,
  où `ssh` sort en quelques millisecondes. La fin est désormais rejouée à
  l'abonnement quand elle a déjà eu lieu.
- **Le doublon du transport résout sa commande par Spark ET par chemin** (§37.4.2
  bis). Un doublon qui ne sait représenter qu'un distant vivant ne peut pas
  éprouver ce qui arrive quand il meurt ; et sur un Spark au `sshd` muet, le
  chemin normal meurt tandis que le dépannage fonctionne — c'est toute la raison
  d'être du §37.3. Même idée que le `fail_next` du pilote factice. Une table
  illisible est **refusée**, pas ignorée : la taire reviendrait à lancer un vrai
  `ssh` depuis un harnais, contre une adresse qui n'existe pas.
- **Preuves** : 667 Python, 43 d'hôte console, 25 de routes, 34 de composant,
  **46 parcours E2E** dont un neuf. Captures `83-` et `84-` observées, plus
  `docs/manuel/images/m8-sshd-muet.png`. Manuel M8 mis à jour.

- **Reste à livrer, et c'est le seul écart** : la vérification que la connexion
  atteint **réellement** un Spark. Elle exige une Forge réelle avec Incus et un
  `sshd` installé, que l'image de base n'embarque pas (§37.2) — SPK-54 est
  précisément l'unité qui installera ce `sshd`. Le dépannage n'a jamais non plus
  été exécuté contre un vrai `incus exec` : le doublon du §37.4.2 bis remplace la
  commande. Même limite qu'au §39.7, et elle vaut pour les deux chemins.

### [ ] SPK-44 · Onglet Docker : inventaire, mesures et inspection

Ce que le locataire fait tourner, observé sans rien y toucher.

- Spécification : `docs/DAT.md` §37.6 · `docs/DESIGN_SYSTEM_APP.md` SPK-DS-05 ·
  `docs/DESIGN_SYSTEM.md` §6.14, §6.13 · manuel M8.
- Dépend de : SPK-43 — les commandes empruntent le même transport.
- Portée : conteneurs et leur état, mesures d'usage, inspection d'un conteneur,
  journaux, réseaux et volumes ; collecte à l'ouverture de l'onglet, rafraîchie
  tant qu'il est ouvert, **arrêtée** quand il est quitté ; mesures du Spark et
  mesures des conteneurs jamais fondues dans la même jauge, chacune affichée avec
  son référentiel.
- Lecture **seule**. Aucun bouton d'action dans cette unité.
- États à traiter, chacun nommé et non rendu par un tableau vide : Docker absent
  du Spark, Docker présent sans conteneur, Spark arrêté, `sshd` muet.
- DoD : parcours E2E depuis le parcours canonique sur une pile Compose réelle du
  seed — lire l'inventaire, ouvrir l'inspection, lire les journaux ; un test
  prouve que la collecte **cesse** à la fermeture de l'onglet ; captures observées,
  dont les quatre états d'absence et un conteneur aux journaux très longs ; manuel
  M8 mis à jour.

### [ ] SPK-45 · Gestes sur un conteneur, et terminal dans un conteneur

- Spécification : `docs/DAT.md` §37.7, §37.4 · `docs/DESIGN_SYSTEM.md` §6.23 ·
  manuel M8.
- Dépend de : SPK-43 et SPK-44.
- Portée : démarrer, arrêter, redémarrer, tuer un conteneur ; terminal **dans** un
  conteneur en marche, avec le même contrat qu'au §37.4 et le même audit qu'au
  §37.5 ; chaque geste confirmé en **nommant le conteneur et l'effet**.
- Hors portée, et pas seulement « plus tard » : Compose — `up`, `down`, `pull`,
  édition du fichier —, la construction d'images et les registres. Le §1 les exclut
  du périmètre du produit.
- **Le gel bloque ces gestes, pas la lecture ni le terminal** (§37.7). Le refus est
  rendu par la console à partir de l'état publié par le runtime : c'est un écart
  assumé à « une interdiction s'applique côté serveur », parce que ces gestes ne
  passent délibérément pas par `sparkd`. L'écart est écrit au §37.7 et doit être
  rappelé dans le manuel : la protection est un garde-fou, pas un contrôle d'accès.
- DoD : parcours E2E depuis le parcours canonique — arrêter puis redémarrer un
  conteneur du seed, avec sa confirmation nommée ; ouvrir un terminal dans un
  conteneur et y exécuter une commande ; un parcours prouve qu'un Spark **gelé**
  refuse le geste, laisse la lecture et laisse le terminal ; captures observées ;
  manuel M8 mis à jour.

### [x] SPK-47 · Le DNS entre dans le produit : zones lues, enregistrement d'ingress posé

Le produit disait « le DNS est extérieur au produit », et SPK-12 restait
`[~]` faute d'un domaine qui résolve. Cette unité retire cette cause.

- Spécification : `docs/DAT.md` §38 (§38.1 où vit le secret, §38.2 le périmètre,
  §38.3 ce qui est écrit, §38.4 poser n'est pas résoudre, §38.5 la garde) ·
  `docs/DAT.md` §22.4 (l'inventaire ne porte aucun secret) · `docs/DESIGN_SYSTEM.md`
  §6.27 (la modale bornée à une section) · manuel M7.
- **Révise** une affirmation du produit, à trois endroits, dans le même
  changement : `apps/webui/src/components/spark-admin.js`, `docs/manuel/M7-domaine.md`
  et `docs/DAT.md` disaient que le DNS était extérieur au produit. Ce n'est plus
  vrai ; la preuve qui l'affirmait est révisée en expliquant pourquoi, jamais
  supprimée.
- Portée : lire les zones du compte ; lire les enregistrements d'une zone ;
  créer ou mettre à jour **un** enregistrement `A`/`AAAA` pour le domaine d'une
  route d'ingress, avec l'adresse publique de la Forge et un TTL court.
- Hors portée, et pas « plus tard » : achat et renouvellement de domaine,
  transfert de zone, changement de serveurs de noms, suppression d'un
  enregistrement que le produit n'a pas posé.
- Le jeton vit dans un `.env` de l'**hôte console**, hors dépôt et hors registre.
  `sparkd` ne le voit jamais. Jeton absent n'est pas une panne : la fonction se
  désactive et l'écran le dit.
- Gardes éprouvées une à une : apex refusé, type autre que `A`/`AAAA` refusé,
  domaine hors de la zone refusé.
- États à traiter, chacun nommé : aucun jeton configuré, jeton refusé par le
  fournisseur, fournisseur injoignable, compte sans zone, zone sans
  enregistrement, enregistrement déjà posé à la bonne valeur.
- DoD : tests unitaires sur les gardes et sur le calcul du nom relatif ; un test
  prouve qu'aucun secret n'entre dans l'inventaire ni dans le registre ; parcours
  E2E **depuis le parcours canonique** — se connecter, atteindre l'onglet d'un
  Spark, ouvrir la modale, choisir une zone, poser l'enregistrement ; captures
  observées, dont les états d'absence ; manuel M7 révisé ; §38 tenu à jour.
- **Livré et vérifié le 2026-08-20.**
  - 22 tests du module — les trois refus, le suffixe trompeur, la casse, le
    point final, les bornes du TTL, l'absence de méthode de suppression sur la
    surface publique du client.
  - Un test prouve que le jeton **n'atteint ni l'inventaire ni `sparkd`**, et un
    autre qu'il ne sort pas d'un fournisseur sérialisé. Défaut trouvé par ce
    test et corrigé : le jeton était un champ public.
  - 10 tests d'écran, 9 tests de routes, **2 parcours E2E** : poser
    l'enregistrement, et se voir refuser l'apex. Le parcours constate chez le
    fournisseur que le `MX`, le `TXT` de vérification et le `A` voisin n'ont pas
    bougé, et que la demande interdit la création d'une zone.
  - **Écriture RÉELLE mesurée** sur `test.spark.lelabs.tech` depuis le parcours
    canonique, contre le compte du responsable : l'enregistrement `A` existe
    chez le fournisseur avec `ttl=300`, et la garde d'espace de noms a refusé
    `gram.lelabs.tech` sans qu'aucune requête ne parte. Captures `48-` à `52-`
    observées, dont le format étroit.
  - Défaut corrigé au passage : l'aperçu de l'enregistrement ne suivait pas la
    saisie et montrait une valeur qui n'aurait pas été écrite.
- **Révisé le 2026-08-20, sur arbitrage du responsable.** Deux défauts nommés par
  lui, corrigés dans la même unité :
  - la borne d'espace de noms bridait **sa** console, alors que le §38.5 disait
    depuis le début qu'elle valait pour le harnais. Elle vit désormais dans un
    fichier d'environnement distinct, réservé aux vérifications autonomes de
    l'agent, que la console ne lit jamais (§38.5.3) ;
  - le refus d'écrire à l'**apex** interdisait un site sur le domaine nu —
    `johndalia.com` —, cas ordinaire et explicitement attendu. Le refus est levé
    (§38.5.1) : l'écriture visant un nom ET un type exacts, les `NS`, le `MX` et
    les `TXT` de la zone sont protégés par le §38.2, pas par une liste de noms.
  - en remplacement, l'écran **montre ce qui est déjà là** avant de l'écraser
    (§38.5.2) : « posera », « remplacera *valeur actuelle* », ou « aucun
    changement ». Cela vaut pour tous les noms, l'apex compris.
- **Reste hors de cette unité** : l'émission TLS elle-même (SPK-12), qui exige un
  serveur joignable depuis l'extérieur.

### [x] SPK-48 · Le joker sur une route, et la préséance du plus spécifique

Une API qui donne un sous-domaine par client ne peut pas déclarer une route et un
enregistrement DNS par locataire, à la main, indéfiniment.

- Spécification : `docs/DAT.md` §18.3 bis (le joker et sa préséance), §18.4
  (l'unicité appartient à la base), §38.3 · `docs/SCHEMA.md` · manuel M7.
- Portée : `*.monapi.fr` devient une route valide ; un enregistrement DNS joker
  se pose depuis le même bouton qu'au §38 ; l'écran NOMME le Spark dont une
  route exacte prend le pas quand elle est avalée par le joker d'un autre.
- **Et la vue inverse** (arbitrage du 2026-08-20) : consulter les routes d'un
  Spark montre, sur chaque route joker, **les noms qui lui sont soustraits** et
  le Spark qui les sert. Dire la surcharge à sa création ne suffit pas — ce
  message passe une fois, et l'exploitant du Spark porteur ne l'a peut-être
  jamais lu. Routes actives seulement, et les noms exacts du même Spark ne
  comptent pas comme une surcharge.
- Bornes, portées par la base : un seul niveau, en tête seulement. `*.*.x.tld`,
  `api.*.x.tld` et `*` seul sont refusés, et le refus dit laquelle des trois
  bornes s'applique.
- Ce qui NE change pas : deux routes de même texte se refusent toujours. Un
  joker et un nom exact ne sont pas le même nom.
- Hors portée : le certificat joker, qui exige une validation `DNS-01`. Le §18.3
  continue de valoir — l'écran n'affirme jamais qu'un certificat est émis.
- DoD : tests des trois bornes et de la préséance ; un test prouve qu'un nom
  exact l'emporte sur un joker au niveau de la configuration produite, pas
  seulement à l'écran ; parcours E2E depuis le parcours canonique — déclarer
  `*.exemple.test` sur un Spark, puis `admin.exemple.test` sur un autre, et voir
  l'écran NOMMER le premier ; captures observées ; manuel M7 mis à jour.
- **Livré et vérifié le 2026-08-20.**
  - **Défaut de préséance corrigé** : `build_config` émettait les routes dans
    l'ordre alphabétique, où `*` précède les lettres. Caddy retenant la première
    correspondance, le joker l'emportait sur le nom exact — l'inverse exact de la
    règle. Les routes sont triées par spécificité, et un test lit l'ordre dans la
    **configuration produite**, pas à l'écran.
  - 20 tests d'unité : les trois bornes nommées une à une, la couverture d'un
    seul niveau, la préséance, l'ordre entre deux jokers, le relevé du joker
    dépassé, et les quatre cas où rien ne doit être signalé.
  - **3 parcours E2E** depuis le parcours canonique : lire depuis le joker ce qui
    lui est soustrait, déclarer un nom avalé par le joker d'un autre Spark et
    voir ce Spark nommé, se voir refuser un joker mal placé avec sa borne.
  - **Seed** : `*.boutique.example.com` sur `boutique` et
    `vip.boutique.example.com` sur `crm-production`, posés avant le bloc
    `caddy.fail` pour ne pas détruire la fixture du §18.5.
  - Captures `56-` à `59-` observées, format étroit compris. Défaut visuel
    corrigé : la liste des surcharges se posait à côté de la route au lieu d'être
    imbriquée dessous.
- **Reste hors de cette unité** : le certificat joker, qui exige une validation
  `DNS-01` — écrit comme limite connue dans le manuel M7.

### [~] SPK-49 · Publier un port de la Forge vers un Spark

Ce qui ne parle pas HTTP n'a aucun autre chemin : un SMTP, un Postgres, un Redis
ou un SSH joignable de l'extérieur ne se route pas par nom.

- Spécification : `docs/DAT.md` §39 (§39.1 pourquoi deux mécanismes, §39.2 un
  port est une ressource de la Forge, §39.3 ce qu'il fait perdre) · §18 ·
  `docs/SCHEMA.md` · `docs/DESIGN_SYSTEM.md` §6.27 · manuel M7.
- Dépend de : rien. C'est le prérequis de SPK-51.
- Portée : déclarer `port public de la Forge → adresse privée et port du Spark` ;
  l'unicité du port portée par la **base** ; le pare-feu ouvert à la déclaration
  et refermé au retrait ; la liste des ports publiés d'une Forge.
- Refus à éprouver, chacun nommant sa raison : port déjà pris — en NOMMANT le
  Spark qui le détient —, port réservé au système de la Forge (`22`, `80`,
  `443`, et la liste configurable), port hors bornes.
- L'écran propose le **nom d'abord** et annonce ce que le port publié coûte : pas
  de certificat automatique, l'application doit faire son TLS. Il ne l'interdit
  pas, il le dit (§39.3).
- DoD : tests unitaires des refus ; un test d'intégration prouve que l'unicité
  vient de la base et non de l'écran ; un test prouve que le retrait REFERME le
  pare-feu ; parcours E2E depuis le parcours canonique — publier un port,
  constater le conflit nommé sur un second Spark, retirer ; captures observées ;
  manuel M7 mis à jour.
- **Livré le 2026-08-20, et `[~]` pour une seule raison, nommée au §39.7.**
  - Spécification complétée avant tout code : §39.4 (un device `proxy` d'Incus
    et non du netfilter — c'est la frontière du §2), §39.5 (le modèle et où vit
    l'unicité), §39.6 (l'API), §39.7 (ce qui ne se prouve pas sans hôte réel).
    Migration `008`, `docs/SCHEMA.md` §6 bis, opération OP-08.
  - 17 tests d'unité et d'API, **4 parcours E2E** depuis le parcours canonique,
    captures `60-` à `64-` observées, format étroit compris, console vierge.
  - Deux défauts trouvés par les preuves. Je jugeais qu'un Spark avait une
    instance à sa seule **adresse**, alors qu'elle est attribuée dès l'écriture
    au registre : la publication échouait en `502` sur un Spark encore
    `pending`. Le signal est `incus_name`, ce qu'emploie déjà `_apply_keys` — et
    l'application d'un Spark ouvre désormais les ports déclarés avant sa
    création. Second : les ports réservés étaient rendus dans un dictionnaire
    indexé par le port, dont les clés JSON sont des chaînes.
- **Ce qui manque pour passer à `[x]`, et rien d'autre** : constater qu'une
  connexion entrante atteint réellement le Spark. Cela exige une **Forge réelle**
  avec Incus et une adresse publique — même limite que SPK-30 et SPK-29. Tout ce
  qui appartient au produit est éprouvé : les refus, l'unicité portée par la
  base, la reconstruction complète des devices, et le fait qu'un retrait fasse
  disparaître le device.

### [x] SPK-50 · Recettes DNS : un jeu d'enregistrements posé ensemble

Une recette à moitié posée est pire qu'une recette absente : un `MX` sans SPF
fait recevoir du courrier qu'on ne peut pas renvoyer.

- Spécification : `docs/DAT.md` §38.6 (les recettes), §38.7 (ce que le DNS ne
  peut pas faire), §38.2, §38.5 · manuel M7.
- Dépend de : SPK-47.
- Portée : la garde du §38.5 s'élargit à `MX`, `TXT`, `SRV` et `CNAME`, chacun
  avec la forme que sa donnée doit avoir (§38.6.2) ; une recette est présentée
  **entière** avant écriture et rend compte enregistrement par enregistrement
  après ; chaque enregistrement continue de viser un nom ET un type exacts.
- **Une recette est une FONCTION, pas une donnée stockée** (§38.6.1) : une
  recette enregistrée divergerait du code dès la première correction, et deux
  vérités coexisteraient sans qu'on sache laquelle est appliquée.
- **Deux recettes livrées** (§38.6.4) : `site-web`, qui ne dépend de rien et
  prouve le mécanisme ; et `relais-transactionnel`, mesurée sur une zone réelle,
  qui exerce `MX` et `TXT` et surtout le cas de la **valeur que l'exploitant doit
  fournir** — la clé DKIM ne s'invente pas.
- **On n'annule pas ce qui est passé** (§38.6.3) : défaire supposerait de
  connaître la valeur d'avant, que le produit n'a pas retenue, et le §38.2 lui
  interdit de supprimer ce qu'il n'a pas posé.
- **L'interdiction de toucher ce que le produit n'a pas posé se durcit** : ce
  sont précisément les enregistrements dont la disparition arrête une messagerie
  sans bruit.
- Une recette affiche les **actions humaines restantes** qu'elle ne peut pas
  faire (§38.7) : le `PTR`, qui n'est pas dans la zone ; le port 25 sortant,
  bloqué par défaut chez l'hébergeur ; la réputation d'une adresse neuve.
- DoD : tests de la garde élargie ; un test prouve qu'une recette dont un
  enregistrement échoue rend compte des deux — ce qui est passé et ce qui ne
  l'est pas — sans prétendre à un succès ; parcours E2E depuis le parcours
  canonique contre le doublon local ; captures observées ; manuel M7 mis à jour.
- **Livré et vérifié le 2026-08-20.**
  - Spécification complétée avant tout code : §38.6.1 à §38.6.5.
  - 16 tests du module, 6 tests de routes, 8 tests d'écran, **2 parcours E2E**
    contre le doublon local.
  - **Écriture RÉELLE mesurée** sur `test.recette.lelabs.tech` et son `www`,
    depuis le parcours canonique, contre le compte du responsable. Après
    écriture, la zone porte 18 enregistrements : le `MX` de `noreply`, le DKIM et
    le `A` de `gram` intacts. Captures `65-` à `68-` observées, format étroit
    compris, console du navigateur vierge.
  - Deux défauts trouvés au parcours, et non par relecture : les écoutes des
    paramètres n'avaient jamais été posées ; et le bloc d'aperçu se vidait
    pendant la relecture, faisant rétrécir la modale et **dérober le bouton
    d'engagement entre l'appui et le relâchement** — même défaut qu'au §38.5.2,
    même correction.
- **Ce qui n'est PAS dans cette unité** : la recette de messagerie complète, qui
  est SPK-51 et dépend de SPK-43 pour lire la clé DKIM dans le Spark. La recette
  `relais-transactionnel` livrée ici couvre l'ÉMISSION seule.

### [ ] SPK-51 · Un Spark qui héberge une messagerie, et sa recette DNS

- Spécification : `docs/DAT.md` §38.6, §38.7, §39 · manuel M7 et M8.
- Dépend de : SPK-49 (les ports 25, 465, 587, 143, 993 ne passent pas par le
  proxy), SPK-50 (la recette), et SPK-43 pour lire la clé DKIM dans le Spark.
- Portée : préréglage « messagerie » qui compose la recette du §38.6 à partir du
  domaine et de l'adresse de la Forge, et publie les ports nécessaires.
- **Architecture visée (§38.6 bis)** : le Spark **reçoit** — `MX` vers la Forge,
  port 25 entrant publié — et **émet par le relais transactionnel** du
  fournisseur, ce qui fait tomber trois des limites du §38.7 : plus de port 25
  sortant à débloquer, un `PTR` déjà cohérent, une réputation déjà établie.
  Mesuré : ce relais est **déjà en service** sur `noreply.lelabs.tech`, et son
  sélecteur DKIM est l'identifiant de projet du compte.
- **Deux vérifications préalables, à faire AVANT de coder** : les quotas, la
  tarification et les conditions d'usage du relais pour de la correspondance
  humaine et non des messages applicatifs ; et que le port 25 **entrant** soit
  ouvert sur le serveur retenu. C'est ce couple qui décide entre « émettre par le
  relais » et « émettre en direct ».
- **La valeur DKIM ne s'invente pas.** Tant que SPK-43 n'existe pas, la recette
  pose ce qu'elle connaît et **demande la clé à l'exploitant en disant où la
  trouver** — une clé inventée produirait une signature invalide, donc l'effet
  exact qu'elle prétend éviter.
- DoD : parcours E2E depuis le parcours canonique jusqu'à la recette posée et ses
  actions humaines restantes affichées ; captures observées ; manuel mis à jour.
  Le fonctionnement réel d'un envoi **ne pourra pas être prouvé** tant que le
  port 25 sortant n'est pas débloqué par l'hébergeur : cette limite est écrite
  dans l'unité, elle n'est pas contournée par une simulation.

### [x] SPK-52 · Une instance déjà absente vaut suppression réussie

Arbitrage du responsable du 2026-08-20, qui remplace l'entrée INC-03 du rapport
d'incohérences — retirée dans le même changement.

- Spécification : `docs/DAT.md` §14.5, §14.4, §14.3 · §33.3 (ne pas savoir n'est
  pas savoir que ce n'est pas là) · §35.
- Portée : quand le pilote rapporte l'instance absente, `delete` réussit, la
  ligne part et les ressources sont rendues.
- Trois bornes, chacune éprouvée : l'audit porte `instance_absente: true` et le
  dit en toutes lettres ; un pilote **injoignable** rend toujours une panne ; un
  Spark **protégé** reste refusé par le §35 d'abord.
- DoD : test unitaire des trois bornes ; test d'intégration sur le registre réel
  prouvant que les ressources sont rendues et que l'admission les récupère ;
  parcours E2E depuis le parcours canonique sur un Spark dont le pilote factice
  rapporte l'instance absente ; le journal montre les deux suppressions
  distinctement ; captures observées.
- **Livré et vérifié le 2026-08-20.**
  - L'absence rapportée porte son propre type, `InstanceAbsente`, qui **n'hérite
    pas** d'`IncusError` : un appelant qui rattrape `IncusError` pour conclure à
    une panne ne doit pas l'attraper par mégarde. Côté pilote réel, un `404`
    d'Incus est la seule réponse qui autorise à conclure que la chose n'est pas
    là.
  - 6 tests d'intégration sur la pile réelle : la suppression réussit, la place
    revient au pool de la Forge, le journal distingue les deux suppressions, un
    pilote **muet** rend toujours `502` et laisse la ligne, un Spark **protégé**
    refuse d'abord, et un Spark jamais appliqué se supprime sans solliciter le
    pilote.
  - **1 parcours E2E** depuis le parcours canonique sur la fixture `orphelin` du
    seed, avec les trois effets constatés côté `sparkd`. Captures `69-` à `72-`
    observées, console du navigateur vierge.
  - Deux preuves révisées avec leur raison : celle qui énumérait les Sparks
    seedés, et celle qui **figeait leur nombre** à cinq — le compte se lit
    désormais sur le registre, ce qui est ce que la preuve voulait dire.

### [~] SPK-53 · La build installée se nomme, et la console dit si la pile est en retard

- Spécification : `docs/DAT.md` §40 · `docs/PROD_MIGRATIONS.md` OP-04 ·
  `docs/DESIGN_SYSTEM.md` §14.6 (« inconnue » n'est pas zéro).
- Portée : `build.json` écrit à l'installation ; `sparkd.build` qui le lit ;
  `/healthz` et `/v1/forge` qui le publient ; comparaison côté console avec le
  dépôt local et les **cinq** situations du §40.3 ; commande de mise à jour depuis
  l'écran de la Forge.
- **Livré et vérifié le 2026-08-20 pour le runtime** : module `build.py`,
  4 tests d'unité, estampille écrite par `scripts/install-serveur.sh`, et
  `/healthz` de la Forge réelle qui rend le commit déployé.
- **Reste** : la comparaison côté console, ses cinq situations, et la commande de
  mise à jour depuis l'interface. Tant que ce n'est pas livré et éprouvé depuis le
  parcours canonique, l'unité reste `[~]`.

### [ ] SPK-54 · Amorcer un Spark depuis la console

Mesuré en montant `helo` de bout en bout (§41) : un Spark neuf n'a **ni `sshd`**,
et `docker.io` de la distribution y est **inutilisable** — son profil AppArmor
`docker-default` refuse `socketpair()`. Les deux se répètent à chaque création.

- Spécification : `docs/DAT.md` §41 (les constats), **§42** (le geste) ·
  `docs/DESIGN_SYSTEM.md` §6.23, §6.27 · manuel M6.
- Portée : geste « Amorcer ce Spark », en **détection** — relever, n'installer que
  les manques, rendre un compte rendu ligne à ligne ; `sshd`, clés réécrites
  depuis le registre, dépôt Docker **amont**, `docker-ce`, `docker-compose-plugin` ;
  option **rootless**, non retenue par défaut (§42.2) ; passage par `incus exec`
  avec confirmation nommée et action d'audit distincte (§42.3).
- Point qui décide de l'unité : la détection porte sur l'**origine** du paquet
  Docker, pas sur sa présence. Un `docker.io` présent est un défaut à corriger,
  pas un état acceptable — sans quoi l'amorçage déclarerait bon un Spark où
  aucune pile ne tournera.
- DoD : un amorçage sur cellule vierge la rend joignable en SSH et capable de
  `docker compose up`, prouvé par un parcours E2E depuis le parcours canonique ;
  un second amorçage ne fait **rien** et le dit — prouvé, car c'est là qu'un geste
  bavard casserait la production du locataire ; un test prouve la détection d'un
  `docker.io` de distribution ; le mode rootless est éprouvé sur une pile qui le
  supporte ; captures observées ; manuel M6 mis à jour.

### [ ] SPK-55 · Durcir la Forge : ce que l'audit du 2026-08-20 a trouvé

Audit mené sur la Forge réelle pendant la mise en place de `helo`. La posture est
bonne sur l'essentiel — seuls `22`, `80`, `443` répondent depuis l'extérieur,
`sparkd` et l'API d'administration de Caddy sont sur la boucle locale, l'API
d'Incus n'est exposée qu'en socket unix, `sshd` refuse les mots de passe, aucun
correctif de sécurité n'est en attente. Trois points restent.

- **Un Spark atteint le `sshd` de la Forge.** Mesuré depuis `helo` :
  `10.77.0.1:9876` et `10.77.0.1:2019` sont injoignables — c'est la propriété
  attendue —, mais `10.77.0.1:22` **répond**. Le chemin d'accès du produit va de
  la Forge vers le Spark, jamais l'inverse : un locataire compromis n'a aucune
  raison d'atteindre le service qui l'héberge. La chaîne `input` du bridge est en
  `policy accept`.
- **Aucun pare-feu par défaut.** `ufw` est inactif : ce qui n'est pas joignable ne
  l'est que parce que rien ne s'y lie. Le jour où un service se lie à `0.0.0.0`,
  il est public sans que personne ne l'ait décidé.
- **`sparkd` tourne en `root`**, avec `ProtectSystem=strict`, `PrivateTmp` et
  `NoNewPrivileges`. C'est défendable — il repondère `spark.slice` et parle à la
  socket d'Incus — mais ce doit être une décision écrite, pas un héritage.
  `X11Forwarding` reste par ailleurs à `yes` sans usage.
- Spécification à produire par l'unité : section de durcissement du DAT et
  contrôles ajoutés au préflight, pour que la posture soit **vérifiée** et non
  constatée une fois.
- DoD : un contrôle de préflight échoue si un Spark atteint un port de la Forge
  autre que ceux dont il a besoin ; la règle est posée par l'installation, pas à
  la main ; un test prouve qu'un Spark garde son DNS et sa sortie internet après
  durcissement — le durcissement ne doit pas casser ce qu'il protège.

### [~] SPK-56 · L'écran nomme, le manuel explique — et le manuel devient joignable

Constat du responsable, 2026-08-20 : l'écran de la Forge portait des paragraphes
entiers — pourquoi le disque n'est pas surengageable, ce que ZFS reprend sous les
Sparks, ce qu'une marge de métadonnées évite. Vérifié : **le manuel M4 disait déjà
les trois**, mot pour mot en substance. L'écran dupliquait donc une explication
qu'il ne pouvait que faire diverger.

- Spécification : `docs/DESIGN_SYSTEM.md` **§1.5 bis** (la règle), §1.4 (pas de
  commande morte) · `docs/DAT.md` §27, §30 · `docs/manuel/M4`, `M12`.
- **Livré et vérifié le 2026-08-20** :
  - écran de la Forge et écran du journal allégés — le fait, l'unité, le réglage
    qui la commande et la mesure vive restent ; le raisonnement part au manuel ;
  - le manuel est **servi depuis `docs/manuel/`**, sa source unique, par trois
    routes de l'hôte console, et devient une destination de premier degré ;
  - rendu Markdown restreint à ce que le manuel emploie, sans dépendance ;
  - 10 tests de composant, 7 tests d'hôte, 479 tests de console verts.
- Ce qui a **failli** être introduit et ne l'a pas été : un renvoi « Manuel M4 »
  qui ne mène nulle part. C'est le §1.4 — une commande morte — et c'est pourquoi
  le manuel est servi dans le même changement que l'allègement.
- **Reste avant `[x]`** : le balayage des autres écrans, dont l'écran de création
  et le détail d'un Spark, qui n'ont pas été relus sous cette règle ; la
  vérification visuelle des deux écrans modifiés et du manuel, aux trois formats ;
  le manuel M4 et M12 à relire pour qu'ils portent bien ce que l'écran a cessé de
  dire.

---

## Réservé, non planifié

- `runtime: vm` pour charges non maîtrisées — VT-x est présent sur l'hôte, donc
  techniquement ouvert.
- Multi-serveurs.
- Quotas d'E/S disque par Spark au-delà de la priorité.
- Export hors machine planifié : écarté, les applications sauvegardent déjà vers un
  S3 externe par leur propre ordonnanceur.
