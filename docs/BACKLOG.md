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

### [x] SPK-29 · Regrouper les Sparks sous un parent cgroup de poids maîtrisé

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

- DoD **RÉVISÉE le 2026-08-21 par l'arbitrage du responsable**, et le motif est
  écrit au §32.2 : l'égalité stricte `r / capacité` obligerait à **retirer** du
  CPU à un locataire quand la Forge est au repos — donc à supprimer le burst pour
  être exact — et ferait bouger le poids sur un signal qui n'est pas un
  changement d'allocation. La DoD devient donc : **la réservation est un
  plancher**, tenu sous contention totale et dépassé sinon, mesuré et archivé.
  L'ancienne formulation n'est pas conservée à côté : elle décrivait une règle
  qui n'est plus celle du produit.

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
**MESURE SOUS CONTENTION TOTALE, le 2026-08-21**, sur la Forge de validation —
et elle a trouve un DEFAUT GRAVE avant de pouvoir rien mesurer.

- **Le poids etait ecrase par systemd, en silence.** `spark.slice` est une unite
  systemd, donc systemd est l'autorite sur ses proprietes de cgroup ; l'unite
  porte `CPUWeight=1` comme point de depart et le **reaffirme** a chaque
  reconciliation. Le produit ecrivait le fichier `cpu.weight` : sa valeur tenait
  jusqu'au premier `daemon-reload`, puis retombait a **1**. MESURE :
  `ecriture -> 180`, `daemon-reload -> 1`. La promesse centrale du produit
  s'evaporait sans qu'aucun controle ne rougisse — le registre et le calcul
  restaient justes. **Corrige** : le poids se pose par
  `systemctl set-property`, et systemd le reaffirme au lieu de l'ecraser
  (§32.4 bis). Verifie sur la Forge : 180 avant ET apres reconciliation.
- **Le mecanisme est ensuite verifie au pour-cent pres** : `spark.slice` a 180
  contre deux tranches a 100, la loi predit `180/(180+200) = 47,4 %`, la machine
  rend **47,9 %** sur 25 secondes de contention a trois.
- **La mesure corrige la loi une seconde fois** : `init.scope` est reste a
  **zero** — il ne contient que PID 1 et n'est jamais executable. Le `H = 300`
  pose est donc optimiste, le `H` reel vaut 200, et la tranche obtient
  systematiquement PLUS que la part visee.

- **Reste avant `[x]`, et c'est un ARBITRAGE du responsable, plus une mesure** :
  garder `H = 300` pose — la reservation reste un **plancher** tenu et depasse,
  ce que le produit fait et annonce aujourd'hui — ou **mesurer `H`** pour que la
  reservation devienne une egalite, au prix d'un poids qui bouge avec l'activite
  de la Forge. Les deux voies sont ecrites au §32.2.
**CLOSE le 2026-08-21.** L'arbitrage rendu, la DoD révisée est satisfaite :

- **le mécanisme est mesuré au pour-cent près** — 47,9 % obtenus pour 47,4 %
  prédits, sous contention des trois tranches ;
- **la portée est ÉNONCÉE par le produit**, et lue et non écrite en dur : le
  runtime publie `floor_under_contention`, l'écran des pools rend
  « Réservation garantie sous contention totale, dépassée sinon » — vérifié en
  capture (`e2e/captures/29-hote-pools.png`). La mécanique de lecture posée au
  §27.6 a fait exactement ce pour quoi elle existait : l'écran a suivi le
  changement de règle sans qu'on y touche ;
- **le manuel M4 dit la même chose**, avec le chiffre de la mesure ;
- **les mentions devenues fausses ont été RETIRÉES** partout où elles vivaient —
  DAT §7.3, §27.6, module d'admission, runtime, manuel — et non doublées d'une
  note.

### [x] SPK-30 · Marge de métadonnées au-dessus du quota vendu

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

**NIVEAU 3 EXÉCUTÉ le 2026-08-21 sur la Forge de validation, et il a INFIRMÉ la
promesse avant de la rétablir.**

Un Spark à 1 Gio, marge de 64 Mio, rempli de données incompressibles jusqu'au
refus (`Disk quota exceeded`, 0 octet disponible). Puis, sur ce dataset saturé :

| Geste | Résultat |
|---|---|
| écrire la **configuration** de l'instance | **ÉCHOUE** — `backup.yaml: disk quota exceeded` |
| agrandir la **taille du device** | **RÉUSSIT**, et la cellule respire aussitôt |

- **La marge ne protège PAS ce que le §8.8.1 affirmait.** Le quota ZFS porte sur
  le jeu de données ENTIER : le `df` de la cellule montre `vendue + marge`, et le
  locataire remplit donc la marge. Elle n'est ni invisible ni inaccessible.
- **Le produit posait la configuration AVANT le disque** — donc échouait
  précisément sur un Spark plein, le seul cas où l'agrandissement est urgent.
  **Corrigé** : le disque d'abord, la configuration ensuite. Une preuve garde
  l'ordre, car rien d'autre ne dirait qu'il compte.
- **Le niveau 3 est ensuite passé de bout en bout, par le produit** : Spark
  saturé, `PATCH` à 10 Gio, `applied: true` sans erreur, et le locataire écrit de
  nouveau. La cellule a été rendue à son état exact.

- **Reste un ARBITRAGE, pas une mesure** : rendre la marge réellement
  inaccessible exigerait `refquota = taille vendue` en plus de
  `quota = vendue + marge`. Incus ne pose que `quota`. Accepter la marge
  consommable — la promesse tient alors par l'ordre des gestes, ce que le produit
  fait — ou piloter `refquota` en contournant l'abstraction d'Incus. Écrit au
  §8.8.1.

**Le mécanisme est LIVRÉ et prouvé aux niveaux 1 et 2 ; le niveau 3 l'est depuis
le 2026-08-21.**

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

### [~] SPK-28 · Partitionnement fourni à la création du serveur

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

**Livré le 2026-08-20.**

- **§8.5 révisé** : deux DISPOSITIONS, plus une cible et un repli. Ce que la
  disposition sur fichier n'apporte pas est dit franchement — la protection
  contre la corruption silencieuse est **absente**, pas dégradée.
- **§8.5 bis écrit** : le contrat des valeurs configurables, réparties selon une
  frontière qui n'est pas arbitraire — `sparkd` ne CRÉE aucun pool, il en lit un.
- **Trois valeurs codées en dur trouvées par recherche** et retirées de
  `sparkd.preflight`. Sur une Forge dont le pool s'appelle `tank`, la
  vérification annonçait « pool « spark » absent ».
- **`scripts/creer-pool.sh`** : le pool se crée par un geste paramétré, dans
  l'une ou l'autre disposition. Trois refus, dont celui d'écrire sur un
  périphérique non vide — **avant** d'écrire, en montrant ce qui a été trouvé.
- **Le schéma JSON est au README**, avec ce qu'il produit et pourquoi `sda5` et
  `sdb5` restent des périphériques nus.
- **OP-01 close**, avec son motif. Plus aucun document ne dit « provisoire ».
- **Preuves** : 11 du geste et du schéma — le premier script du dépôt à être
  éprouvé, exécuté pour de vrai avec `id`, `incus` et `wipefs` doublés —, plus
  4 du préflight configurable. 722 preuves Python au total.

- **Reste avant `[x]`, et c'est le seul écart** : le schéma JSON n'a **jamais été
  soumis à un hébergeur**. Il est valide, et une preuve le relit depuis le README
  pour garder que la paire reste libre — mais « un exploitant qui suit le README
  obtient les partitions attendues » demande une machine commandée, que la
  session ne peut pas fournir. **Nécessite une action humaine.**

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

### [x] SPK-35 · Instruire la sécurisation des actions sensibles

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

**Instruction RENDUE le 2026-08-20 — `docs/DAT.md` §45.**

- **Le résultat principal**, et il déplace la question : tant que la clé du
  responsable ouvre un **shell** sur la Forge, un second facteur placé devant
  l'API de `sparkd` ne protège de rien contre une clé volée. Qui a la clé n'a
  aucune raison de passer par l'API — il entre par SSH et atteint le registre.
  Le facteur serait un guichet fermé à côté d'une porte ouverte.
- **Les cinq menaces se rangent en deux familles** qui n'appellent pas le même
  remède : l'**erreur** (acteur légitime, intention fausse → friction et nommage,
  déjà largement livré) et l'**usurpation** (acteur qui n'est pas celui que la clé
  désigne → un facteur, et seulement s'il ne vit pas là où le premier a été volé).
- **Ce que le produit ne prétendra pas traiter, écrit franchement** : un poste de
  travail compromis. Aucun facteur saisi sur ce poste n'y survit.
- **Retenues** : SPK-61 (restreindre la clé — préalable à tout facteur), SPK-62
  (notification hors bande — elle détecte, et c'est la seule mesure qui serve
  encore quand tout le reste a échoué), SPK-63 (frappe du nom sur les gestes
  destructifs).
- **Écartées avec leur motif** : WebAuthn (disproportion — sa résistance à
  l'hameçonnage traite une menace que ce produit n'a pas), ré-authentification à
  durée limitée (c'est le déverrouillage temporaire déjà écarté au §35.4),
  console en lecture seule (une bascule laissée active ne protège plus),
  application différée (ce qu'elle apporte est fourni par la notification, sans
  toucher à la machine à états). **TOTP est reportée**, pas rejetée : elle ne
  devient discutable qu'après SPK-61.
- **SPK-40 requalifiée** : ce n'est pas un mécanisme d'authentification — la clé
  volée signe. C'est de la **non-répudiation d'audit**, ce que le §36.3 disait
  déjà.
- **Récupération tranchée** (§45.5) : tout facteur futur aura pour unique voie de
  secours `root` sur la Forge, comme au §35.3. Le produit n'inventera pas un
  second mécanisme : il en aurait deux à défendre, et le plus faible ferait la
  sécurité de l'ensemble.
- **Articulation avec le §35** (§45.6) : le verrou porte sur un OBJET, un facteur
  porterait sur l'ACTEUR. Le verrou prime, et un facteur ne lèverait jamais une
  protection au passage.
- Rien n'a été implémenté, conformément à l'arbitrage.

### [~] SPK-36 · Instruire les plans de contingence et les gestes d'urgence

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

**Premier scénario livré le 2026-08-20 : la sauvegarde du registre.**

- **Le point de l'unité, mesuré** : le registre est en WAL, et une copie de
  fichier perd EN SILENCE ce qui n'a pas été reversé — 490 lignes sur 500, et la
  copie s'ouvre sans se plaindre. C'est le pire mode de panne d'une sauvegarde.
  L'API de sauvegarde en ligne rend 500 sur 500 sans arrêter le service.
- `sparkd.sauvegarde` **vérifie ce qu'elle vient d'écrire** — structure SQLite et
  chaîne d'audit — et **retire** une copie douteuse : la garder ferait croire
  qu'une sauvegarde existe, ce qui est pire que de n'en avoir aucune.
- La restauration refuse si `sparkd` répond, refuse un fichier qui ne se vérifie
  pas, et **déplace** le registre remplacé. Les `-wal` et `-shm` partent avec lui,
  sans quoi SQLite les rejouerait par-dessus le fichier restauré.
- **`docs/CONTINGENCE.md` créé**, lié depuis le README et le contrat de
  déploiement. Il porte la **frontière** — ce que le produit sauvegarde et ce
  qu'il ne sauvegarde pas — et nomme le trou le plus grave : les instantanés
  vivent DANS le pool, donc ils ne protègent pas de sa perte.
- **Preuves** : 10, dont une qui rejoue la mesure du WAL pour qu'une future
  « simplification » en `shutil.copy` rougisse immédiatement.

**L'EXERCICE DE RESTAURATION A ÉTÉ JOUÉ le 2026-08-21**, sur la Forge de
validation, de bout en bout et avec les seules commandes du document. Les
chiffres du §2.6 ne sont plus espérés :

```
sauvegarde   : 253 952 octets, 0,10 s, service en marche
restauration : 0,08 s
interruption : ~20 s, dominee par l'arret et le redemarrage de sparkd
verifications: preflight 12/0/0 · 2 Sparks avec leurs etats reels
               GET /v1/audit/verify -> intact: true, 51 entrees
```

- **La perte a été DÉMONTRÉE, pas affirmée** : une variable posée **après** la
  sauvegarde n'existe plus après restauration, celles posées avant sont là. La
  fenêtre de perte est l'intervalle entre deux sauvegardes, et rien d'autre.
- **Le dispositif s'est comporté comme écrit** : la restauration a refusé de
  s'exécuter tant que `sparkd` tournait, et elle a **déplacé** l'ancien registre
  au lieu de l'écraser.
- La Forge a été rendue à son état, données de démonstration comprises.

- **Reste avant `[x]`** :
  1. les **neuf autres scénarios**, listés au §3 de `docs/CONTINGENCE.md` avec ce
     qui manque à chacun. C'est du travail d'instruction, pas de mesure ;
  2. la **reconstruction d'un Spark** après perte de sa cellule — l'autre moitié
     de l'exercice que la DoD nomme. Non jouée ;
  3. l'**ancre de la console** au §2.5 point 4 : la signaler exige la console
     lancée avec son tunnel, que l'exercice n'a pas monté. Le comportement
     attendu reste écrit, il n'est pas mesuré.

### [x] SPK-37 · Un acteur réel dans le journal, et un journal qu'on ne récrit pas par mégarde

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
**MESURÉ CONTRE UN VRAI `sshd` le 2026-08-21**, sur la Forge de validation — et
la mesure a trouvé que **le relevé ne fonctionnait pas du tout**.

- **Le produit demandait le mauvais niveau de journalisation.** `Server accepts
  key` est un message `debug1:` ; le produit posait `LogLevel=VERBOSE`, qui
  s'arrête un cran avant. Mesuré, tunnel ouvert avec les options exactes du
  produit :

  ```
  LogLevel=VERBOSE ->  1 ligne,  0 « Server accepts key »
  LogLevel=DEBUG1  -> 81 lignes, 1 « Server accepts key »
  ```

  La branche « empreinte déterminée » du §21.6.3 ne se produisait donc
  **jamais**. Et rien ne le signalait : l'en-tête retombait sur
  `console/<serveur>`, une valeur de repli légitime, impossible à distinguer
  d'un repli mérité. **Corrigé** en `DEBUG1`.
- **L'analyseur, lui, était juste** : sur le flux réel il rend l'empreinte du
  poste et **ignore celle de l'HÔTE**, qui apparaît pourtant AVANT dans le flux.
  Une expression qui aurait pris « la première `SHA256:` » aurait attribué chaque
  geste à l'empreinte du serveur — identique pour tous, donc une identité qui
  n'identifie personne. Une preuve garde désormais ce piège.
- **Second défaut, trouvé en corrigeant le premier** : le flux d'erreur était lu
  **bloc par bloc**, et seule la première ligne du bloc était testée. Tout ce qui
  suivait une ligne bénigne atterrissait dans `lastError`, que `describe()`
  publie — un diagnostic affiché sur un tunnel qui va bien. Sous VERBOSE, la
  seule ligne émise, « Authenticated to … », y tombait à chaque tunnel réussi.
  Le passage à 81 lignes en aurait fait la règle. **Corrigé** : lecture ligne par
  ligne, et le succès d'authentification n'est plus pris pour une panne.
- **La chaîne entière est prouvée sur la Forge** — tunnel réel, geste réel,
  journal réel :

  ```
  env.set | classe: human | acteur: console/validation key=SHA256:Vf2N7ryPnZ…
  ```

  Les entrées antérieures au correctif portent, dans le même journal,
  `console/forge1` **sans clé** : l'avant et l'après se lisent côte à côte.
- **Preuves** : 4 de plus (29 sur le tunnel), dont deux vérifiées comme
  **échouant sans le correctif**.

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

### [~] SPK-40 · Signature des gestes par la clé du responsable

La console signe la requête avec la clé SSH du responsable, par son agent ;
`sparkd` conserve la signature et les octets signés. Root sur l'hôte peut alors
supprimer ou tronquer, mais **pas fabriquer** un geste authentique (§36.3).

- Spécification : `docs/DAT.md` §36.3, §36.4.
- **Requalifiée le 2026-08-20 par l'arbitrage de SPK-35 (§45.4).** Elle figurait
  parmi les pistes d'**authentification** ; elle n'en est pas une, puisque la clé
  volée signe. Ce qu'elle apporte réellement est la **non-répudiation d'audit** :
  elle ne prouve pas *qui* agit, elle prouve qu'un geste inscrit a bien été
  demandé et n'a pas été fabriqué par la Forge. Elle reste due à ce titre, et
  l'arbitrage qui la bloquait est rendu : **elle est démarrable**.
- Ce que l'unité ne prétendra pas : la signature atteste l'**intention**, pas ce
  que le runtime a fait ensuite ; le résultat reste couvert par la chaîne. Et une
  ligne produite par le runtime n'est signée par personne — la supervision le dit
  au lieu de le masquer.

**Contrat écrit et poussé avant le code, le 2026-08-21** : `docs/DAT.md` §36.10,
après mesure de SSHSIG sur OpenSSH 8.9p1.

**Découpage**, parce que les deux moitiés vivent sur des machines différentes et
que chacune se prouve seule :

1. **Côté Forge** — le registre porte la signature, `sparkd` la vérifie à la
   réception et l'expose ; plus l'outil de vérification hors ligne. C'est ce qui
   se prouve entièrement ici, avec un vrai `ssh-keygen`.
2. **Côté console** — la signature produite par l'agent du responsable sur chaque
   geste mutant. Elle suppose un agent atteignable, que la pile de développement
   n'a pas.

**Première tranche livrée le 2026-08-21 : côté Forge.**

- **Le point du contrat** : une requête **non signée passe**, une signature
  **présente et invalide** est refusée en `422`. Les confondre ferait de ce
  mécanisme un contrôle d'accès, ce que le §45.4 dit qu'il n'est pas — et
  l'inscrire ferait mentir le journal.
- **Mesuré sur OpenSSH 8.9p1** : les quatre refus rendent tous `255`. L'espace de
  noms `spark-audit` empêche de rejouer ici une signature faite pour un commit.
- **Migration 009** : trois colonnes qui vont ensemble ou pas du tout, un
  déclencheur l'impose. Elles n'entrent **pas** dans l'empreinte de la chaîne.
- **La vérification hors ligne** (`verifier_journal`) est celle qui porte la
  preuve, et une preuve simule l'attaque : root récrit une ligne et y colle une
  signature fabriquée.
- **Deux écarts fermés par les preuves** : un événement du runtime héritait de la
  signature de la requête déclenchante ; et le journal exposait la signature
  entière à chaque page, contre le §36.10.7.
- **Preuves** : 17 du module, 12 de route, avec de vraies clés et un vrai
  `ssh-keygen`. 762 preuves Python au total.

**Deuxième tranche livrée le 2026-08-21 : la console signe.**

- **Mesuré** : avec un agent, `ssh-keygen -Y sign -f <clé PUBLIQUE>` signe **sans
  que la clé privée soit sur le disque** — éprouvé en la retirant. La console
  signe donc sans jamais tenir le secret (§36.3).
- **Ne pas pouvoir signer ne retient jamais le geste** : le module rend un
  MOTIF, il ne lève pas. Un exploitant dont l'agent vient de se vider ne doit pas
  découvrir que son produit s'est verrouillé.
- Le message d'OpenSSH est **traduit** en ce qui manque vraiment (§14.7), et dit
  quoi faire — `ssh-add`.
- Une **lecture n'est pas signée** : signer ce qui ne laisse pas de trace ne
  prouverait rien.
- `signingKey` entre dans l'inventaire pour **tous** les genres de serveur, et
  ne porte qu'une clé **publique**.
- **Preuves** : 16, avec un vrai `ssh-keygen`, un vrai agent et de vraies clés.

**Troisième tranche livrée le 2026-08-21 : ce que les écrans en disent.**
Contrat écrit et poussé avant le code — `docs/DAT.md` §36.10.9, et §36.8.5 révisé.

- **La chaîne complète est éprouvée d'un clic.** Le harnais des parcours produit
  une VRAIE paire de clés dans son dossier jetable, la Forge la reconnaît par
  `SPARKD_ALLOWED_SIGNERS` sous l'identité `console/local` — celle-là même que
  la console déclare —, et `SPARK_SIGN_COMMAND` répond PAR GESTE comme le
  doublon Docker du §37.6 ter : il échoue sur le relevé de topologie et délègue
  tout le reste au vrai `ssh-keygen -Y sign`. Une seule pile porte la chaîne
  signée ET l'échec dit.
- **Le journal dit, ligne à ligne, ce que la Forge a VÉRIFIÉ** : « signée »,
  « non signée » — un état normal, jamais peint en rouge —, « sans objet » pour
  une ligne du runtime, que personne n'a demandée. La mention générale « Aucune
  entrée n'est signée » a disparu : vraie avant SPK-40, fausse après, et lue
  comme vraie sur la page même où l'on vient chercher une garantie.
- **L'échec de signature se dit dans la COQUILLE**, pas dans l'écran du geste :
  sa cause est l'état du poste, elle survit au geste et frappera le suivant. Il
  persiste à travers un changement d'écran et **s'efface de lui-même** dès qu'un
  geste repart signé. Règle réutilisable extraite : `docs/DESIGN_SYSTEM_APP.md`
  SPK-DS-10.
- **Le motif voyage en JETON**, la phrase vit dans `tokens.js` — un en-tête HTTP
  ne transporte pas d'accent, et le §14.7 interdit le jeton brut à l'écran. Une
  preuve garde que les deux tables ne dérivent pas : un motif sans phrase serait
  un échec tu.
- **La clé de signature se déclare depuis l'écran *Serveurs***, pour tous les
  genres. Sans ce champ elle ne se déclarait qu'en éditant un fichier à la main
  — le défaut même que SPK-41 existe pour supprimer.
- **Preuves** : 2 parcours E2E, 7 de composant, 5 du vocabulaire, 2 de relais ;
  3 captures observées (`e2e/captures/47`, `48`, `49`).

- **Reste avant `[x]`, et c'est un seul écart, hors de portée d'une session** :
  aucun agent SSH réel n'a signé un geste. Le harnais éprouve la chaîne avec la
  clé privée voisine de la publique — le cas du poste sans agent, que le
  §36.10.8 admet et qui fonctionne. Que l'agent réponde se mesure **sur un
  poste**, et c'est la même limite qu'au §37.4.2 bis : **nécessite une action
  humaine**.

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
- **Correction du 2026-08-20, à propos de ce contrôle même** : posé dans
  `src/styles/`, il n'était balayé par aucun motif du script de test de la
  console — `host/*.test.js src/components/*.test.js`. Il était donc vert quand
  on le lançait à la main, et **jamais joué par la campagne**. Un garde-fou qui ne
  tourne pas ne garde rien. Réparé par `449b4fd`, qui ajoute les motifs
  manquants ; la console rend désormais 549 preuves au lieu de 543.
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

**VERIFIE sur la Forge de validation le 2026-08-21**, sur instruction explicite
du responsable. La connexion atteint REELLEMENT un Spark, et par les DEUX chemins
du §37.2 :

- **le rebond `incus exec`** : `incus exec helo -- /bin/bash -c "hostname; id"`
  rend `helo`, `root`, et `Debian GNU/Linux 13` — l'OS du SPARK, pas l'Ubuntu de
  la Forge. On est bien dans la cellule ;
- **le rebond SSH** : `ssh -J <forge> root@10.77.0.17` aboutit, avec la cle du
  responsable deja posee dans le Spark **par le registre** — l'amorcage rend
  « cles -> present | conformes au registre ».

Le `sshd` que l'image de base n'embarque pas est bien installe et actif : c'est
SPK-54 qui l'a pose, et le relevé d'amorcage le confirme sur la vraie cellule.

- **Reste avant `[x]`, et l'ecart est RESSERRE** : les deux commandes du
  depannage ont ete executees pour de vrai, mais la route `GET
  /api/terminal/diagnostic` de l'hote console ne l'a pas ete de bout en bout —
  elle exige l'hote lance avec son tunnel, ce que cette session n'a pas monte.
  Ce qui reste n'est donc plus « la commande est un doublon » mais « le chemin
  d'appel n'a pas ete parcouru ».

### [x] SPK-44 · Onglet Docker : inventaire, mesures et inspection

Ce que le locataire fait tourner, observé sans rien y toucher.

- Spécification : `docs/DAT.md` §37.6 · `docs/DESIGN_SYSTEM_APP.md` SPK-DS-05 ·
  `docs/DESIGN_SYSTEM.md` §6.14, §6.13 · manuel M8.
- Dépend de : SPK-43 — les commandes empruntent le même transport.
- Portée : conteneurs et leur état, mesures d'usage, inspection d'un conteneur,
  journaux, réseaux et volumes ; collecte à l'ouverture de l'onglet, rafraîchie
  tant qu'il est ouvert, **arrêtée** quand il est quitté ; mesures du Spark et
  mesures des conteneurs jamais fondues dans la même jauge, chacune affichée avec
  son référentiel.
- Lecture **seule**. Aucun geste **sur un conteneur** dans cette unité — les
  boutons qui DEMANDENT une lecture en font partie, puisque l'inspection et les
  journaux ne se collectent jamais d'office (§37.6 ter).
- États à traiter, chacun nommé et non rendu par un tableau vide : Docker absent
  du Spark, Docker présent sans conteneur, Spark arrêté, `sshd` muet.
- DoD : parcours E2E depuis le parcours canonique sur une pile Compose réelle du
  seed — lire l'inventaire, ouvrir l'inspection, lire les journaux ; un test
  prouve que la collecte **cesse** à la fermeture de l'onglet ; captures observées,
  dont les quatre états d'absence et un conteneur aux journaux très longs ; manuel
  M8 mis à jour.

**Première tranche livrée le 2026-08-20 : l'inventaire et ses absences.**

- Contrat écrit et poussé **avant le code** : DAT §37.6 bis — le chemin, les
  commandes exactes, la forme des refus, la cadence. Écrit après mesure sur un
  vrai Docker.
- **Le chemin est SSH depuis la console**, celui du §37.2 et du terminal. Pas
  `incus exec` : le §37.3 réserve le plan de contrôle au dépannage, et lire
  l'inventaire d'un locataire n'en est pas un. Conséquence assumée — un Spark au
  `sshd` muet n'a pas d'onglet Docker, et l'écran le dit dans les termes du §37.2.
- **Le point de l'unité, mesuré** : c'est le **code de sortie** qui distingue les
  absences, pas la sortie, vide dans deux cas sur trois. `127` quand `docker` est
  introuvable, `1` quand la commande existe et que le démon ne répond pas, `0`
  avec zéro ligne quand tout va bien. Les deux premiers se confondent à l'œil et
  n'appellent pas le même geste : l'un s'amorce, l'autre se redémarre. Les fondre
  enverrait réinstaller ce qui est déjà là — donc redémarrer le démon du locataire
  et interrompre sa production pour rien.
- Zéro conteneur est un **état normal**, pas un tableau vide.
- **SPK-DS-05 tenu** : l'écran écrit que ces mesures viennent de Docker *à
  l'intérieur* de la cellule ; une preuve le garde, sans quoi la règle se perdrait
  au premier remaniement. Une mesure absente se dit « non mesuré » et ne devient
  jamais zéro (§14.6).
- **Aucun bouton** : l'unité est en lecture, les gestes sont SPK-45, et une preuve
  garde qu'aucun n'apparaît.
- **La collecte cesse** au départ de l'onglet — changement de facette, de page, ou
  fermeture du navigateur. Prouvé en **comptant** les requêtes sur deux cadences
  complètes, avec zéro attendu : c'est la façon de prouver une absence d'effet.
- **Preuves** : 17 du module, 13 de composant, 2 parcours E2E, 654 de console au
  total. Captures `93-` à `97-` observées, dont les deux absences **côte à côte**
  et le format étroit, plus `docs/manuel/images/m8-docker.png` produite depuis la
  pile réelle. Manuel M8 complété.

**Deuxième tranche livrée le 2026-08-20 : l'inspection, les journaux, les réseaux
et les volumes.**

- Contrat écrit et poussé **avant le code** : DAT §37.6 ter, après mesure sur un
  vrai conteneur `alpine` créé puis supprimé pour l'occasion.
- **Demandés, jamais collectés d'office.** Relever les journaux de dix conteneurs
  toutes les cinq secondes coûterait dix fois le §37.6 au quota du locataire, pour
  un texte que personne ne lit dix fois à la fois. Ouvrir un conteneur **suspend**
  le relevé de la liste, qui a cédé la place.
- **Journaux bornés à deux cents lignes**, et `truncated` est **rendu** par
  l'hôte, jamais déduit de la longueur : déduire marcherait aujourd'hui et
  mentirait le jour où un conteneur a exactement deux cents lignes.
- **Mesuré, et gardé par des preuves** : le nom que Docker rend est préfixé d'une
  barre oblique ; le code de sortie n'existe que pour un conteneur **arrêté**, en
  rendre `0` pour un conteneur en marche ferait lire qu'il s'est terminé sans
  erreur (§14.6) ; les horodatages sont ceux du locataire et sont rendus **tels
  quels**, les retraduire décalerait l'écran de ce qu'il lit chez lui ; une ligne
  sans horodatage n'en reçoit pas un inventé.
- Une **liste non lue est nulle, pas vide** : « aucun réseau attaché » et « non
  lus » sont deux faits, et l'un des deux ferait chercher une panne inexistante.
  L'identité survit à l'échec des listes — savoir qu'un conteneur est mort en 137
  vaut mieux que rien.
- Un conteneur **disparu** entre l'inventaire et l'inspection rend `1`. C'est une
  course normale, pas une panne : le locataire a le droit de le supprimer pendant
  qu'on le regarde. L'écran le dit en **avertissement**, pas en refus.
- **Défaut trouvé par le parcours, jamais par une preuve unitaire** : le relevé se
  résolvait sur `exit`, qui précède le drainage de `stdout`. Sur deux cents lignes,
  l'écran en montrait cent soixante-quatorze et les montages revenaient vides —
  une **troncature silencieuse**, le pire défaut pour un écran dont le seul rôle
  est de rapporter. Corrigé en attendant `close`, et gardé par une preuve qui
  rejoue cet ordre exact.
- **Quatre défauts d'écran vus seulement à la capture** : le titre venait du nom
  cliqué et non de ce que la Forge a rendu (§14.9) ; le retour à la liste était en
  pied, sous deux cents lignes ; un conteneur disparu s'affichait en **rouge** sous
  un texte disant « pas une panne » (§25.1) ; et quand seuls les journaux le
  trouvaient disparu, l'écran restait **muet** en affichant une fiche complète d'un
  conteneur qui n'existait plus (§14.5).
- **Une règle révisée, pas contournée** : la preuve « aucun bouton » interdisait,
  sans le vouloir, le seul moyen de demander une lecture. Ce qu'elle gardait était
  « aucun geste **sur** le conteneur ». Elle dit désormais cela, l'explication est
  écrite dans le fichier, et elle éprouve l'absence de tout libellé de démarrage,
  d'arrêt, de redémarrage ou de suppression — qui restent SPK-45.
- **Le §8.1 mesuré séparément** : le journal et la fiche ne débordent pas la page
  sur 390 px. La barre d'onglets, elle, déborde de 247 px — c'est INC-07,
  antérieur à cette unité, reconstaté avec sa mesure et laissé inchangé.
- **Preuves** : 32 du module, 32 de composant, 8 parcours E2E. Captures `98-` à
  `101-` observées, dont un conteneur en marche aux journaux à la borne, un
  conteneur arrêté en 137, un conteneur disparu et le format étroit ; plus
  `docs/manuel/images/m8-docker-conteneur.png` produite depuis la pile réelle.
  Manuel M8 complété.

**EPROUVE sur une pile Compose REELLE le 2026-08-21**, par le chemin exact du
produit — `ssh -J <forge> root@<ip-du-Spark>` — et non par un doublon :

| Commande | Ce qu'elle a rendu |
|---|---|
| `docker ps` | `helo-web-1 \| nginx:alpine \| Up 20 minutes` |
| `docker inspect` | `/helo-web-1 running nginx:alpine` |
| `docker logs --tail 2` | deux vraies lignes de nginx, horodatees |

Le doublon du §37.4.2 bis ne remplace donc plus la commande : elle a ete lue a
travers le tunnel, sur une cellule qui fait tourner une pile.

### [x] SPK-45 · Gestes sur un conteneur, et terminal dans un conteneur

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

**Découpage décidé le 2026-08-20**, parce que l'unité porte deux mécanismes qui
n'ont rien en commun — un appel court qui aboutit ou non, et une session
interactive qui vit — et qu'un seul des deux tient dans une session :

1. **Le cycle de vie d'un conteneur** — les quatre gestes, leur confirmation, le
   refus sous gel, le journal. Spécifié au §37.7.1 à §37.7.4.
2. **Le terminal dans un conteneur** — `docker exec -it`, avec le contrat du
   §37.4 et l'audit du §37.5. Spécifié au §37.4.7 le 2026-08-20.

**Contrat écrit et poussé avant le code** : DAT §37.7.1 (les quatre commandes et
leurs codes, mesurés sur Docker 29.6.1), §37.7.2 (demandé, confirmé, constaté),
§37.7.3 (où le refus du gel est rendu), §37.7.4 (la route et les quatre actions
d'audit).

**Première tranche livrée le 2026-08-20 : le cycle de vie d'un conteneur.**

- **Le point de l'unité, mesuré** : le code `1` a DEUX causes, et seule la sortie
  d'erreur les sépare — `No such container` et `is not running`. Inverse exact du
  §37.6 bis. Les confondre annoncerait une disparition à propos d'un conteneur
  simplement arrêté. Un échec non reconnu n'est PAS qualifié.
- `start` et `stop` sont **idempotents** ; `kill` ne l'est pas. Et « le geste a
  abouti » ne promet pas un arrêt propre : un conteneur qui ignore `SIGTERM`
  finit en `137` pendant que `docker stop` rend `0`.
- **Le gel refuse AVANT toute connexion**, pour les quatre gestes, et une preuve
  vérifie qu'aucun `ssh` ne part. Le refus nomme la **levée**. Les boutons
  restent présents, désactivés et expliqués (§1.4). La lecture n'est pas touchée,
  et le terminal non plus — l'objection du §6.23 est levée au §37.7.3.
- **Quatre actions d'audit**, dénombrables séparément. La porte figeait
  `result: "ok"` : elle admet désormais `denied`, borné. **Seul un geste abouti
  est un succès** — inscrire `ok` sur un conteneur disparu ferait dire au journal
  qu'un conteneur a été arrêté alors qu'il ne s'est rien passé.
- **Après le geste, l'écran relit** l'inspection et affiche ce que la Forge rend,
  jamais l'état supposé (§14.9).
- **Deux règles de design system introduites** : SPK-DS-08 (un troisième bloc
  d'issue, vert — sans lui un succès s'écrivait dans la couleur du danger, et son
  existence rend visible qu'un conteneur déjà arrêté n'est PAS un succès) et
  SPK-DS-09 (une confirmation sensible n'a pas la couleur d'une destructive).
- **Preuves** : 19 du module, 9 de route, 17 de la porte d'audit, 48 de
  composant, 5 parcours E2E dont la DoD du gel. Captures `102-` à `104-`
  observées, plus `docs/manuel/images/m8-docker-geste.png`. Manuel M8 complété
  d'un chapitre *Agir sur un conteneur*.

**Deuxième tranche livrée le 2026-08-20 : le terminal DANS un conteneur.**

- **Le point de l'unité, mesuré** : un binaire manquant fait rendre `127` à
  `docker exec`, **avec son message sur la SORTIE STANDARD**. Ne lire que
  `stderr` ferait prendre l'échec pour un shell ouvert et muet.
- **On sonde avant d'ouvrir** (§37.4.7), comme le §37.3.1 sonde `sshd`. `bash`
  préféré, `sh` accepté, aucun des deux = un état NOMMÉ — une image *distroless*
  n'en embarque délibérément pas, et c'est un choix de sécurité du locataire.
- **Une seule session, un seul mécanisme** : la route existante avec un champ
  `container`. Un refus arrive en `409`, aucune session n'est ouverte et rien
  n'est journalisé.
- **Deux actions d'audit distinctes** de celles du Spark, et la fermeture porte
  la durée. Les deux routes de fermeture, qui figeaient `path: 'ssh'` en copie,
  partagent désormais une fonction qui lit le chemin réel — le dépannage cesse
  par là même d'être journalisé comme un `ssh` normal.
- **Le gel LAISSE entrer**, c'est la seconde moitié de la DoD, prouvée au
  parcours. C'est aussi la réponse à l'objection du §37.7.3.
- **Preuves** : 16 du sondage, 48 du terminal, 8 de la route, 19 de la porte
  d'audit, 83 de composant, 5 parcours E2E. Captures `105-` et `106-` observées,
  plus `docs/manuel/images/m8-terminal-conteneur.png`, toutes produites par le
  vrai parcours. Manuel M8 complété d'un chapitre *Entrer dans un conteneur*.

**EPROUVE sur une pile Compose REELLE le 2026-08-21**, par le chemin exact du
produit :

- **le sondage du shell**, avec la commande EXACTE du §37.4.7 —
  `docker exec helo-web-1 sh -c "command -v bash || command -v sh"` — rend
  `/bin/sh`. C'est le cas « pas de bash, mais un sh » que l'ecran doit savoir
  distinguer, et il est venu d'un vrai conteneur ;
- **un geste sur conteneur** : `docker restart helo-web-1` aboutit, et
  l'inspection RELUE derriere rend `running`. Le geste choisi est REVERSIBLE —
  un `stop` aurait laisse la pile du locataire a l'arret (§29.2).

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

### [x] SPK-49 · Publier un port de la Forge vers un Spark

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
- **Close le 2026-08-20 : la connexion entrante est prouvée sur la Forge réelle.**
  Port `18080` publié vers `helo:8080`, puis frappé **depuis Internet** :
  - `http://51.158.54.202:18080/` → `200`, et le contenu servi est celui du Spark ;
  - le device posé est bien un `proxy` d'Incus, et non du netfilter (§39.4) :
    `pub-18080 · listen tcp:0.0.0.0:18080 · connect tcp:10.77.0.17:8080` ;
  - **refus éprouvés, chacun nommant sa raison** : port déjà publié → `409` en
    nommant le Spark qui le détient ; `22` → « tenu par le sshd de la Forge, seule
    porte du système » ; `443` → « tenu par le proxy, qui sert les routes publiques
    en TLS » ; `70000` → hors bornes ;
  - **retrait** : `DELETE` → `200`, le port est **refermé depuis l'extérieur** et
    le device a disparu de l'instance.
  Il ne restait que cette mesure ; tout le reste était déjà éprouvé.

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

### [~] SPK-61 · Restreindre la clé d'accès du responsable au seul tunnel

Retenue par l'arbitrage de SPK-35 (`docs/DAT.md` §45.3), et **préalable à tout
second facteur** : tant que cette clé ouvre un shell sur la Forge, un facteur
devant l'API de `sparkd` ne protège de rien contre une clé volée.

- Spécification : `docs/DAT.md` §45.3 · §11 · §37.2 (le rebond existe déjà).
- Portée : une clé d'accès dont les options OpenSSH — `restrict`, `permitopen=`,
  et `command=` si nécessaire — n'autorisent que le transfert de port vers
  `sparkd`. Le README et le contrat de déploiement disent comment la poser.
- Ce qu'elle ne fait PAS, et qui doit être écrit : elle ne supprime pas la
  menace. Une clé restreinte volée donne toujours l'API, donc les gestes. Elle
  transforme « accès total et silencieux » en « accès aux gestes, journalisés ».
- **Le point qui décidera de sa faisabilité** : le §37.2 fait entrer la console
  dans les Sparks par **rebond** depuis la Forge, et le §37.3 exécute `incus` SUR
  la Forge pour le dépannage. Il faut donc mesurer ce que chaque chemin exige
  réellement de la clé avant de la restreindre — une clé restreinte qui casse le
  terminal de dépannage aurait échangé une protection contre une panne.
- DoD : la clé restreinte est posée sur la Forge de validation et **tous** les
  chemins du produit sont éprouvés avec elle — tunnel, terminal d'un Spark,
  dépannage, gestes Docker ; un test prouve qu'un shell interactif est refusé ;
  le README et `docs/PROD_MIGRATIONS.md` portent la marche à suivre.

**Mesurée, spécifiée et construite le 2026-08-21** — `docs/DAT.md` §46, écrit et
committé avant la première ligne de code.

- **Le résultat qui décide de tout, et il inverse une intuition** : `restrict`
  est un FAUX AMI. Il retire le pseudo-terminal, l'agent, le X11 — il ne retire
  **pas** l'exécution d'une commande. MESURÉ sur un `sshd` réel : avec
  `restrict,port-forwarding,permitopen=…`, `ssh forge "cat <fichier>"` rend `0`
  et lit. Une clé « restreinte » à ce seul sens laisse le registre entier
  lisible, et l'unité aurait été réputée faite sans l'être.
- **`command=` ferme la porte, et ne casse ni le tunnel ni le rebond** : `-L` et
  `-W` sont des canaux `direct-tcpip`, auxquels `command=` ne s'applique pas.
  MESURÉ.
- **Le dépannage (§37.3) est le seul chemin cassé**, et c'est le piège que
  l'unité annonçait. Résolu par une GARDE : `scripts/garde-ssh.sh`, posée en
  `command=`, n'accepte que `incus exec <nom> -- <shell>` et refuse tout le
  reste. Contrat FERMÉ — énumérer laisse passer trop peu, ce qui se voit ;
  filtrer les interdits laisse passer ce qu'on n'a pas prévu.
- **Une condition SERVEUR, découverte en montant le banc** : sans
  `AllowTcpForwarding local`, tout tombe, y compris avec une clé sans aucune
  option. Certaines distributions l'ont à `no` par défaut. La ligne seule
  donnerait une console en panne, pas une console protégée.
- **`permitopen` n'interprète aucun motif d'ADRESSE** — MESURÉ, `172.17.0.*:22`
  est refusé. Le joker d'HÔTE, lui, fonctionne : `permitopen="*:22"` s'écrit une
  fois et survit à chaque création de Spark. Concession écrite au §46.5.
- **La ligne est PRODUITE**, pas recopiée : `scripts/cle-restreinte.sh`. Une
  ligne d'`authorized_keys` recopiée est une ligne où l'on oublie une virgule, et
  `sshd` n'avertit de rien.
- **Deux défauts trouvés par les preuves elles-mêmes** : sans `set -f`,
  `incus exec * -- /bin/bash` se développait sur le répertoire courant et la
  garde LANÇAIT un dépannage que personne n'avait nommé ; et `${2:-9876}`
  confondait un port vide avec un port absent, rendant silencieusement une ligne
  sur le mauvais port.
- **Preuves** : 32, dont le contrat fermé de la garde éprouvé sur 18 commandes
  refusées, et une preuve CROISÉE qui garde que le shell admis par la garde est
  celui que la console lance. Plus **six chemins mesurés de bout en bout** contre
  un `sshd` réel, avec la ligne réellement produite par le dépôt et la garde
  réellement posée.

- **Reste avant `[x]`, et cela ne dépend pas d'une session** : la clé n'est pas
  posée sur une Forge de validation. Le banc de mesure est un `sshd` jetable, pas
  la Forge du produit ; les chemins y sont éprouvés avec un `incus` de doublon.
  Poser la ligne sur la vraie Forge est un geste humain (`CLAUDE.md` §9), et
  OP-10 le décrit pas à pas — **nécessite une action humaine**.

### [~] SPK-62 · Notification hors bande des actions sensibles

Retenue par l'arbitrage de SPK-35 (`docs/DAT.md` §45.4). Elle ne prévient pas :
elle **détecte**, et c'est la seule mesure qui serve encore quand tout le reste a
échoué — y compris contre un poste compromis, que le §45.2 assume ne pas traiter.

- Spécification : `docs/DAT.md` §45.4 · §21 (le journal) · §36.4 (les deux
  classes de lignes).
- Portée : sur les gestes destructifs et sur les levées de protection, un envoi
  vers un canal choisi par le responsable. Le contenu NOMME l'objet et le geste,
  et ne porte **aucun secret** — c'est le §21.2 appliqué à une sortie.
- **Tranché le 2026-08-21 (§47.3)** : **deux canaux**, réglés depuis un **onglet
  de la Forge**, activables et désactivables **séparément** —
  1. un **webhook** avec un **gabarit** : substitution de texte sur les champs
     nommés du §47.4, jamais une exécution, rendu **montré avant** enregistrement,
     et passé par le filtre du §21.2 pour qu'un gabarit ne puisse pas faire sortir
     ce que le contenu interdit ;
  2. un **SMTP** — serveur, port, TLS, compte, mot de passe **traité en secret**
     (§43.3), adresse d'envoi et de destination.
  Les deux peuvent être actifs ensemble, et **l'échec de l'un n'empêche pas
  l'autre** : deux témoins indépendants, pas une chaîne.
- **Toute modification exige un mot de passe, fixé au premier usage** (§47.3.3),
  et c'est le **même mécanisme** que la protection d'un Spark (§35.3) — `scrypt`,
  sel propre, empreinte au registre, jamais la valeur. Motif : qui peut couper le
  témoin en silence peut agir sans témoin, et c'est le premier geste qu'un
  attaquant tenterait. Une **désactivation notifie**, par le canal qu'elle coupe
  et pendant qu'il fonctionne encore.
- La configuration quitte les variables d'environnement pour le **registre** : un
  canal qu'on ne peut ni voir ni éprouver depuis l'écran est un canal dont on ne
  sait pas s'il veille.
- Un canal injoignable ne doit jamais faire échouer le geste — ce serait
  transformer une panne de traçabilité en panne d'exploitation (§37.4.5) —, et
  l'écart doit être visible.
- DoD : un geste destructif produit une notification **sur chacun des deux
  canaux** ; un canal injoignable laisse le geste aboutir, le SIGNALE, et
  **n'empêche pas l'autre canal** — prouvé en coupant l'un des deux ; un gabarit
  qui référence un champ inconnu est refusé **à l'enregistrement** et non à
  l'envoi ; un gabarit ne peut pas faire sortir ce que le §47.4 interdit, prouvé
  en tentant explicitement ; une modification sans mot de passe est refusée, et la
  **désactivation d'un canal part par ce canal** avant qu'il ne se taise ; les
  trois états — aucun canal, configuré mais désactivé, actif en échec — sont
  distingués à l'écran ; aucun secret n'y transite, prouvé sur
  ce que l'envoi porte réellement ; l'absence de canal configuré n'est pas une
  panne, la fonction se désactive et l'écran le dit (§14.5).

**Spécifiée et construite le 2026-08-21** — `docs/DAT.md` §47, écrit et committé
avant la première ligne de code.

- **Elle s'accroche à `audit.record()`**, qui est le SEUL chemin vers le journal
  (§21.1). S'accrocher à la console laisserait sortir sans un mot exactement les
  gestes qu'on cherche à détecter : ceux qu'on fait en la contournant. C'est le
  `CLAUDE.md` §10 appliqué à une sortie.
- **La liste des actions est FERMÉE**, neuf entrées énumérées. Un motif du genre
  « tout ce qui contient `delete` » laisserait passer `spark.unprotect`, qui est
  le geste le plus grave de la liste, et notifierait `spark.settle` le jour où on
  le renommerait.
- **Les lignes du runtime ne notifient pas**, ni les refus, ni les gestes de
  construction : un canal qui crie tout le temps n'est plus lu, et c'est la panne
  la plus probable de ce dispositif.
- **Un canal injoignable ne fait JAMAIS échouer un geste** (§37.4.5) : envoi dans
  un fil séparé — jamais dans la transaction SQLite, où un `POST` de trois
  secondes bloquerait l'unique écrivain de la Forge —, délai de garde de cinq
  secondes, file BORNÉE, et aucune exception qui remonte.
- **Le `payload` n'est PAS envoyé** : c'est là que vivent les valeurs d'un geste.
  Un champ qu'on n'envoie pas ne fuit pas.
- **L'échec est DIT** : `GET /v1/forge` rend `notify`, et l'écran de la Forge le
  montre. Sans canal, il écrit en toutes lettres que **rien n'est surveillé** —
  les compteurs valent alors zéro, et zéro ressemble à « tout va bien » (§14.6).
- **Preuves** : 33 du module, sur un VRAI serveur HTTP local et non un doublon de
  la fonction d'envoi ; 6 de l'écran ; 1 parcours E2E depuis un geste réel au
  clavier — la levée d'une protection, choisie parce qu'elle est RÉVERSIBLE. Le
  canal est branché sur la pile de TOUS les parcours : s'il cassait un geste, la
  série entière le dirait. Captures observées : `e2e/captures/50-notify-sans-canal.png`
  et `51-notify-en-echec.png`.

- **Reste avant `[x]`, et ce sont deux écarts nommés** :
  1. **l'alerte ne NOMME pas l'objet en clair.** MESURÉ : le message de
     `spark.delete` est une transition d'état — « error » → « deleting » —, et le
     nom du Spark ne vit que dans `spark.deleted`, la ligne d'ACHÈVEMENT.
     L'alerte porte donc `target_type` et `target_id`, un identifiant opaque. Le
     backlog exige qu'elle nomme l'objet ; elle le désigne sans le nommer.
     Corriger à la cause touche le vocabulaire du journal (§21), hors de cette
     unité : à arbitrer — notifier aussi `spark.deleted` au risque de doubler
     l'alerte, ou faire nommer le Spark par le message de `spark.delete` ;
  2. **le canal n'a jamais parlé à un vrai destinataire.** Le doublon est un
     vrai serveur HTTP, mais local : qu'un Slack, un Discord ou un `ntfy` accepte
     ce corps se mesure sur un canal réel, et **nécessite une action humaine**.

### [x] SPK-63 · Frappe du nom sur les gestes destructifs

Retenue par l'arbitrage de SPK-35 (`docs/DAT.md` §45.4). Elle traite les menaces
1 et 2 — les plus fréquentes de la liste — pour un coût quasi nul.

- Spécification : `docs/DAT.md` §45.1 · `docs/DESIGN_SYSTEM.md` §6.23.
- Portée : la suppression d'un Spark, et elle seule pour commencer. La
  confirmation demande de **frapper le nom** de l'objet avant d'engager.
- Ce qu'elle ne prouve pas, et qui doit rester écrit : rien sur l'identité. Elle
  ne traite que l'erreur, et le §45.1 la range explicitement dans cette famille.
- **Tranché le 2026-08-20, et la règle est au design system** (§6.23, « Frapper
  le nom ») : on l'exige quand les TROIS conditions tiennent — action
  irréversible, objet confondable avec d'autres, nom court et visible. Dès
  qu'une manque, on ne l'exige pas. La suppression d'un Spark les réunit ; aucun
  autre geste du produit ne les réunit aujourd'hui, et c'est pourquoi l'unité
  s'arrête là.
- DoD : la suppression exige la frappe exacte du nom ; une frappe fausse ou
  partielle n'engage rien ; le parcours est éprouvé au clavier ; si une règle
  réutilisable en sort, `docs/DESIGN_SYSTEM.md` §6.23 est étendu.

**Livrée et vérifiée le 2026-08-20.**

- **La règle réutilisable est au design system** (§6.23, « Frapper le nom ») avec
  ses trois conditions. La troisième — nom **court et visible** — n'est pas une
  commodité : faire recopier un identifiant long apprend à le coller sans le lire.
- **La comparaison est exacte**, casse et espaces compris. Deux Sparks qui ne
  diffèrent que par la casse existent.
- **Le bouton reste présent et désactivé** (§9.9), et le focus entre dans le
  CHAMP — un focus sur un contrôle inerte laisse croire qu'on est bloqué.
- **Une frappe incomplète n'est pas une erreur** : rien n'a été tenté, donc pas
  la couleur du refus.
- **Défaut trouvé par le parcours** : repeindre à chaque caractère perdait la
  frappe. Le §6.9 bis avait déjà enseigné la leçon pour les curseurs ; seuls les
  éléments qui dépendent de la valeur sont réécrits.
- **Preuves** : 8 de composant, 2 parcours E2E dont la révision de la suppression
  existante. Captures `13-` et `111-` observées, plus
  `docs/manuel/images/m10-suppression-nom-frappe.png`. Manuel M10 complété.

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
**Comparaison côté console livrée le 2026-08-20.**

- `apps/webui/host/build.js` : les **six** verdicts. Le §40.3 en annonçait cinq ;
  le sixième — **aucun dépôt sur le poste** — est apparu en l'implémentant, et
  c'est le cas le plus probable en exploitation, chez un exploitant qui ne
  développe pas. Le ranger dans « build étrangère » aurait été faux : on ne sait
  pas si elle est étrangère, on n'a rien pour le dire. Le §40.3 est corrigé.
- **Ce qui décide de l'unité n'est pas la comparaison, c'est ce qu'on dit quand
  elle est impossible.** Trois verdicts sur six sont des non-réponses, et un seul
  affirme que tout va bien — celui qui l'a mesuré.
- **Le cas qui trompe le plus** : « c'est le poste qui est en retard » n'est ni en
  rouge ni annoncé. Traité comme un défaut de la Forge, il enverrait redéployer
  une version *plus ancienne* que celle qui tourne — un écran qui se trompe là ne
  se contente pas d'informer mal, il fait régresser une machine en service. Une
  preuve garde cette différence, et le §40.3 porte désormais la conséquence.
- La comparaison vit dans l'**hôte console**, seul endroit qui ait à la fois le
  tunnel et le dépôt — la Forge est déployée par `rsync` sans `.git` (§40.1). Il
  rend le verdict **et son libellé** : le libellé est le contrat du §40.3, et une
  copie côté navigateur en aurait fait une seconde vérité.
- Un `git` en échec est une **réponse**, jamais une panne : lever ferait d'une
  absence de comparaison une panne d'écran.
- **Preuves** : 10 du module — montées sur un vrai dépôt jetable et non sur un
  `git` simulé, parce que c'est l'ascendance des commits qu'on éprouve et qu'un
  doublon ne prouverait que sa propre fidélité —, 48 d'hôte console, 47 de
  composant. Captures `90-` à `92-` observées, plus
  `docs/manuel/images/m4-code-deploye.png` produite depuis la pile réelle.
  Manuel M4 complété.

- **Reste à livrer, et c'est le seul écart** : la **commande de mise à jour**
  depuis l'écran de la Forge. Le §40 ne la spécifie pas, et elle n'est pas une
  finition : elle ferait redéployer `sparkd` sur une machine en service depuis un
  bouton. Ce que « mettre à jour » veut dire — quel artefact, quelle
  confirmation, quel retour arrière — demande une décision du responsable avant
  la première ligne de code (`CLAUDE.md` §9).

### [~] SPK-54 · Amorcer un Spark depuis la console

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

**Livrée le 2026-08-20, sauf deux points nommés plus bas.**

- **Contrat écrit AVANT le code** : §42.5 à §42.8 du DAT — ce qui manquait au
  pilote, ce que la détection exécute, le contrat d'API, ce que le journal
  reçoit. Commit documentaire dédié, poussé avant la première ligne.
- **Le constat qui a ouvert l'unité** : `exec_command` poste la commande et n'en
  rend RIEN. Suffisant pour ordonner un geste, insuffisant pour DÉTECTER, qui est
  le principe du §42.1. D'où `exec_capture`, et sa règle : **un code de sortie
  non nul n'est pas une erreur du pilote** — `command -v sshd` qui rend `1` est
  une réponse, pas une panne.
- **L'origine, pas la présence** : un `docker.io` est rendu `defect`, entre dans
  les manques, et l'installation le **purge** avant de poser `docker-ce`. Les
  laisser cohabiter ne réparerait rien : c'est son profil AppArmor qui casse, et
  il resterait posé.
- **Deux routes** : le relevé n'écrit rien et ne se journalise pas, l'amorçage
  agit. Faire de la détection l'effet de bord d'une écriture obligerait à amorcer
  pour savoir s'il y a lieu d'amorcer.
- **Le relevé ne part pas de lui-même** depuis l'écran : il exécute une commande
  dans la cellule du locataire, et le lancer à chaque ouverture ferait entrer la
  console chez lui à chaque coup d'œil. « Pas encore relevé » n'est donc ni
  « rien à faire », ni « tout va bien ».
- **Deux manques du doublon**, trouvés en écrivant les parcours et de même nature
  que celui du terminal : le pilote factice ne reflétait pas l'effet des scripts,
  ni l'empreinte des clés écrites. Sans le second, l'amorçage réécrivait les clés
  à chaque passage et n'était **jamais** idempotent.
- **Correction de spécification après mesure** : le refus d'un Spark protégé rend
  `423` et non `409`, code déjà fixé par le §35.5. La table du §42.7 disait
  `409`, ce qui était une supposition.
- **Preuves** : 21 de `sparkd` propres à l'unité, 48 de composant, 4 parcours E2E
  neufs (**50 au total**). Captures `85-` à `88-` observées, format étroit
  compris, plus `docs/manuel/images/m6-amorcage.png` produite depuis la pile
  réelle. Manuel M6 complété.
- **Défaut trouvé en observant la capture du manuel** : « absent » était écrit
  deux fois sur la même ligne — la pastille et le détail. Corrigé, avec sa preuve.

**Mode rootless livré le 2026-08-20 (§42.2, §42.2 bis).**

- Contrat écrit et poussé avant le code : §42.2 bis — comment l'option voyage, ce
  qu'elle change à l'installation, et ce qui arrive quand on la demande sur une
  cellule déjà pourvue.
- **Le point de la tranche** : demander l'autre mode sur une cellule déjà pourvue
  est **refusé**, pas exécuté. Basculer déplacerait le démon sous un autre compte,
  et avec lui les conteneurs, les volumes et les réseaux du locataire — sa
  production, sans qu'il l'ait demandé. Une preuve compte les commandes : un refus
  ne touche pas la cellule. Le refus joue dans les deux sens, et redemander le
  **même** mode reste idempotent — les confondre rendrait un second amorçage
  impossible.
- `enable-linger` n'est pas une précaution : sans lui le démon meurt à la fin de
  la session du compte, ce qui donnerait une cellule qui marche jusqu'au premier
  redémarrage — et cela ne se verrait qu'alors.
- L'option **énonce ses trois coûts** au lieu de les vendre, et une preuve garde
  qu'aucun argument de vente ne s'y glisse. Le mode est une **observation** rendue
  par le relevé, et il figure au journal même quand rien n'a été fait.
- **Preuves** : 30 de `sparkd` propres à l'unité, 53 de composant.

- **Reste à livrer, et c'est pourquoi l'unité n'est pas `[x]`** :
  1. ~~les deux parcours du rootless et la capture~~ — **fait le 2026-08-20**.
     Exécutés en ciblé, un par un, plutôt qu'en campagne complète. Le premier
     était **rouge** et a trouvé un défaut réel : le compte rendu de l'amorçage
     reconstruit ses lignes champ par champ et perdait le `mode` que le relevé
     portait. Les trente preuves d'unité ne pouvaient pas le voir — elles
     interrogeaient le relevé, pas le compte rendu. Corrigé en `4c88a97` avec sa
     preuve. Capture `89-amorcage-rootless.png` produite et observée ;
  2. le mode rootless **éprouvé sur une pile qui le supporte**, que la DoD
     demande. Le doublon représente l'effet des scripts, pas le comportement d'un
     vrai démon rootless ;
  3. la preuve qu'un amorçage rend une cellule **réellement** joignable et
     capable de `docker compose up` : elle exige une Forge réelle avec Incus, et
     c'est la même limite qu'au §39.7.

### [~] SPK-55 · Durcir la Forge : ce que l'audit du 2026-08-20 a trouvé

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

**Spécifiée et commencée le 2026-08-21** — `docs/DAT.md` §48, écrit et committé
avant la première ligne de code.

- **Deux contrôles neufs au préflight** : `NET-REMONTEE` — l'entrée du bridge
  privé n'accepte pas tout, et le port 22 de la Forge n'est pas atteignable
  depuis le réseau des Sparks — et `SSH-X11`.
- **Le remède ouvre le DNS AVANT de fermer le reste**, et une preuve garde cet
  ordre : inversé, la règle qui tombe en premier ferme tout et chaque Spark
  devient muet. Le durcissement ne doit pas casser ce qu'il protège.
- **Un quatrième état de verdict**, `AVERTISSEMENT`, non bloquant. `X11Forwarding`
  ouvert n'est pas une faille : refuser l'installation d'une Forge pour cela
  serait disproportionné, et un préflight qui échoue pour un détail apprend à
  passer outre ses échecs. Le rendu le compte à part — « signalé » n'est ni
  « bloquant » ni « non mesuré ».
- **`sparkd` en `root` est ASSUMÉ et écrit** (§48.2), et `ufw` est **écarté**
  (§48.3) : deux jeux de règles qui se recouvrent, et le jour où l'un bloque ce
  que l'autre autorise, personne ne sait lequel a tranché.
- **OP-11 et OP-12** portent la marche à suivre. OP-11 nomme l'écart le plus
  dangereux : les règles `nft` sont VOLATILES, et le préflight lirait toujours
  « drop » dans la configuration d'Incus après un redémarrage qui les a perdues.
- **Preuves** : 9, dont l'ordre du remède et le comptage séparé des
  avertissements. 836 preuves Python au total.

**APPLIQUE sur la Forge de validation le 2026-08-21**, sur instruction explicite
du responsable. OP-11 et OP-12 sont posees et persistees ; le preflight rend
**12 controles, 0 bloquant, 0 signale**.

- **Le durcissement ne casse pas ce qu'il protege** — c'est la verification qui
  comptait, et elle est faite DEPUIS un Spark : `10.77.0.1:22` est refuse la ou
  il repondait, tandis que le DNS resout et que la sortie HTTPS rend 200.
- **TROIS omissions de la recette, trouvees en l'appliquant** : la table
  `inet filter` n'existait pas ; le **DHCP** devait etre accepte, faute de quoi
  un Spark perd son adresse au bail suivant — une panne differee, donc pire ; et
  l'**ICMP utile** aussi, sans quoi la decouverte de MTU casse en silence.
- **Un piege de persistance, evite** : le `/etc/nftables.conf` d'Ubuntu commence
  par `flush ruleset`, ce qui aurait efface la table d'Incus au premier
  redemarrage — NAT, DNS et DHCP de tous les Sparks. Le fichier pose ne flushe
  que sa propre table.

- **Reste avant `[x]`, et c'est un ARBITRAGE, pas une mesure** : la regle n'est
  pas posee par `scripts/install-serveur.sh`, qui n'installe pas le reseau — le
  bridge nait d'OP-02, a la main. Poser la regle la ou le bridge nait demande
  d'abord de **decider si l'installation prend le reseau en charge**, ce qui
  deborde cette unite. **Attend une decision du responsable.**

### [x] SPK-56 · L'écran nomme, le manuel explique — et le manuel devient joignable

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
**Clos le 2026-08-20 : le balayage, la vérification visuelle et la relecture du
manuel.**

- **Quatre paragraphes retirés**, chaque fois après avoir VÉRIFIÉ que le manuel
  les portait : le droit d'ordonnancement (Ressources → M5), le geste accidentel
  (Protection → M8), l'argumentation des trois coûts du rootless et le
  « pourquoi » de l'amorçage (→ M6), le développement sur le catalogue (→ M5).
  Pour ce dernier le manuel ne disait rien : **le chapitre a été écrit d'abord**.
- **La limite du §1.5 bis, posée** : il vise le raisonnement de fond, et ne prime
  pas sur le §6.23 — une confirmation doit NOMMER sa conséquence. Les trois
  conséquences du rootless restent donc à l'écran ; seule leur argumentation
  part. Deux preuves l'ont imposé, et le motif est écrit dans les fichiers.
- **La vérification visuelle a trouvé ce qu'elle seule pouvait trouver** : le
  manuel n'avait aucune capture, et sur 390 px `#/manuel/M5` montrait douze liens
  avant le chapitre demandé. Empilés, le chapitre passe désormais avant le
  sommaire.
- **Garde durable** : `apps/webui/src/styles/renvois.test.js` exige que chaque
  renvoi `#/manuel/Mx` désigne un chapitre présent, et que tout écran ayant
  délégué porte un renvoi. Un renvoi mort est une commande morte (§1.4).
- **M4 et M12 relus** : ils portent bien le surengagement, la marge de
  métadonnées, `zfs_arc_max` et la chaîne d'intégrité que les écrans ont cessé
  d'expliquer.
- **Preuves** : 772 de console dont 58 du détail, 86 de l'administration, 25 du
  catalogue et des renvois. Captures `107-` à `110-` observées, plus
  `14-detail-mobile` refaite. Campagne complète verte.

### [x] SPK-57 · Redimensionner un Spark existant

**Trou constaté le 2026-08-20, sur question du responsable.** Le produit crée et
supprime ; il ne sait pas **ajuster**. Relevé du contrat servi par la Forge
réelle : aucune route ne modifie les quotas — ni `PATCH /v1/sparks/{name}`, ni
équivalent. Les seules écritures sont le cycle de vie, la protection, les
instantanés et les clés.

Aujourd'hui, agrandir un Spark suppose de le supprimer et de le recréer : on perd
la cellule, ses images Docker, ses volumes et sa configuration. Pour un produit
dont l'unité **est** une cellule à quota, c'est le geste d'exploitation le plus
courant qui manque.

Le comble est déjà écrit ailleurs : SPK-30 existe pour qu'un Spark saturé reste
**reconfigurable** (§8.7) — une propriété au service d'un geste qui n'a jamais
été spécifié.

- Spécification à produire : section du DAT, `docs/SCHEMA.md` si le registre doit
  garder une trace des redimensionnements, manuel M8.
- Portée : modifier mémoire, plafond et réservation CPU, débit réseau, taille de
  disque, et le **mode CPU** ; l'admission control rejoué sur le **delta**, pas
  sur la demande entière ; le registre écrit avant Incus (§14.2) ; refus chiffré
  comme à la création (§7.7) ; journal d'audit ; geste refusé sur un Spark protégé
  (§35.2).
- Ce que l'unité doit **mesurer avant de promettre**, chaque cas séparément :
  - à chaud ou non — le cpuset se reconfigure à chaud (§13), la mémoire aussi ;
    le disque et le mode CPU restent à établir ;
  - **rétrécir** n'est pas agrandir : réduire la mémoire sous l'usage courant
    invite l'OOM killer, réduire un disque sous ce qu'il contient est un refus, et
    passer de `dedicated` à `shared` rend des cœurs qu'il faut redistribuer
    (§7.4 bis) puis repondérer (§32.2) ;
  - un Spark **arrêté** et un Spark **en marche** ne se redimensionnent pas de la
    même façon : dire lequel exige un redémarrage, et le dire à l'écran avant
    d'agir, pas après.
- DoD : tests d'unité des refus, dont chaque rétrécissement impossible nommé ;
  test d'intégration prouvant que l'admission compte le **delta** ; preuve sur la
  Forge réelle qu'un agrandissement à chaud est appliqué et **mesurable dans la
  cellule** — un quota changé au registre mais pas dans le noyau serait le pire
  des cas ; parcours E2E depuis le parcours canonique ; manuel M8 et captures.

**Spécifiée et commencée le 2026-08-21** — `docs/DAT.md` §49, écrit et committé
avant la première ligne de code.

- **Le point qui décide de tout est livré et prouvé** : l'admission compte le
  DELTA. `pools(connection, sauf=<id>)` et `admit(..., sauf=<id>)` **rendent** au
  pool le Spark visé avant d'évaluer sa nouvelle demande.
- **« Rendre d'abord, admettre ensuite » et NON « admettre le delta »**, et le
  motif est écrit au §49.1 : soustraire ferait lire « il manque 2 Gio sur une
  demande de 2 Gio » à qui en demande 8 — un message exact sur des chiffres faux
  est pire qu'un message absent. Une preuve garde que le refus porte les chiffres
  SAISIS.
- **Rétrécir ne peut jamais manquer de place** : sans l'exclusion, une Forge
  saturée refuserait de rendre de la mémoire. Prouvé.
- **Les cœurs DÉDIÉS suivent la même règle**, et c'est là qu'elle compte le plus :
  passer de `dedicated` à `shared` rend des cœurs physiques, donc augmente la
  capacité du pool partagé. Prouvé sur la capacité, pas seulement sur l'alloué.
- **Preuves** : 7, dont celle qui montre le défaut évité — la même demande est
  REFUSÉE sans exclusion et admise avec. 843 preuves Python au total.

**Le geste est livré côté serveur le 2026-08-21.**

- **`PATCH /v1/sparks/{name}`** ajuste mémoire, réservation et plafond CPU, mode
  CPU, débit réseau et taille de disque. Le nom, l'image et l'adresse privée sont
  refusés : ce sont des identités, pas des quotas (§49.2).
- **Le registre d'abord, Incus ensuite** (§49.2, §14.2), dans une transaction qui
  couvre l'admission et l'écriture.
- **Trois refus, et ils ne se confondent PAS** : `423 Locked` sur un Spark
  protégé — le code que le produit emploie déjà, en inventer un second ferait
  traiter le même refus de deux façons dans la console ; `409 admission_refused`,
  chiffré comme à la création ; `409 shrink_refused`, qui dit « ce que vous
  voulez retirer est UTILISÉ » et non « il n'y a pas la place ». Les mélanger
  enverrait l'exploitant libérer de la place sur la Forge alors que le problème
  est dans la cellule (§49.3).
- **Un Spark en état transitoire est refusé** (§49.5) : un quota écrit pendant
  une transition le serait sur un état qui n'existe déjà plus.
- **L'usage de la cellule est RELEVÉ avant d'agir**, et son absence est une
  RÉPONSE, pas une panne : sans mesure, les refus de rétrécissement ne sont
  simplement pas prononcés, et le code le dit au lieu d'inventer une occupation.
- **Preuves** : 18 — 7 de l'admission, 11 du service et de la route, dont celle
  qui montre le point de l'unité : une demande de 7 Gio est REFUSÉE à la création
  et ADMISE en redimensionnement, puisque le Spark rend ses 6. 861 preuves Python
  au total.

**La cellule reçoit le quota, le 2026-08-21.** La seconde moitié du §49.2 est
livrée : après le registre, la route pose les nouvelles limites sur la cellule.

- **Un champ `applied`, à TROIS valeurs qui ne se confondent pas** (§14.6) :
  `true` — registre et noyau disent la même chose ; `false` avec `apply_error` —
  le quota est **promis**, pas en vigueur ; `null` — il n'y avait rien à poser,
  le Spark n'a pas de cellule, et ce n'est pas un échec.
- **Un échec de pose ne défait PAS le registre**, et le §49.2 dit pourquoi :
  annuler ferait perdre l'admission déjà accordée et rouvrirait la course que la
  transaction du §14.2 vient de fermer. Entre surestimer et sous-estimer
  l'occupation, le produit surestime — c'est déjà la règle de la création.
- **Mais l'écart ne se tait pas** : c'est exactement le pire des cas que la DoD
  de cette unité nomme, « un quota changé au registre mais pas dans le noyau ».
- **Preuves** : 3 de plus, dont l'échec de pose éprouvé sur un client Incus qui
  refuse. 864 preuves Python au total.

**L'écran s'ouvre, le 2026-08-21.** La section *Ressources* de la fenêtre d'un
Spark porte sa commande — « Modifier les quotas » — et ouvre une modale dont le
sujet est cette section (`DESIGN_SYSTEM.md` §6.27).

- **Le disque ANNONCE son redémarrage avant qu'on agisse** (§49.4) : tant que la
  prise à chaud n'est pas mesurée sur une Forge réelle, l'écran promet moins que
  ce qu'il fait. L'inverse coupe un service en production.
- **La modale prépare au refus qu'elle peut recevoir** : elle dit que ce qu'on
  retire doit être libre, ce qui distingue à l'avance « il n'y a pas la place »
  de « ce que vous voulez retirer est utilisé » (§49.3).
- **Un Spark protégé garde la commande, DÉSACTIVÉE, avec sa raison** (§9.9) : la
  faire disparaître ferait croire que le produit ne sait pas redimensionner.
- **Preuves** : 7 de composant. 821 preuves de console au total.

**Le geste est ATTEIGNABLE au clavier, le 2026-08-21.** La modale est câblée :
elle s'ouvre pré-remplie des valeurs du Spark affiché, envoie le `PATCH`, et rend
le refus DANS la modale sans effacer la saisie (§6.27).

- **Deux parcours E2E**, depuis le parcours canonique et au clavier : le
  redimensionnement qui aboutit — l'effet est constaté côté Forge, et le Spark
  **existe toujours** —, et le refus qui reste dans la modale avec sa saisie.
- **Ce que les parcours ont MESURÉ, et qui vaut d'être écrit** : rétrécir la
  mémoire d'un Spark EN MARCHE est refusé, et c'est le produit qui a raison
  (§49.3). Le parcours vise donc le disque d'un Spark ARRÊTÉ, et d'assez loin
  au-dessus de son occupation : rendre du disque ne peut jamais manquer de
  place.
- **Preuves** : 2 parcours E2E. 821 preuves de console.

**Captures et manuel, le 2026-08-21.** Trois captures observées —
`52-quotas-commande.png`, `53-quotas-modale.png`, `54-quotas-mobile.png` : la
commande dans sa section, la modale pré-remplie avec son annonce de redémarrage,
et la même sous 768 px où elle occupe l'écran sans changer de contrat (§6.27).
Le manuel M8 porte le geste, ses deux familles de refus et ce qui n'est pas
encore possible.

**Le mode CPU se change depuis l'écran, le 2026-08-21.** La modale porte un
sélecteur des quatre modes, et **les champs qui suivent dépendent de lui** —
réservation en partagé, plafond en plafonné, cœurs en dédié. Laisser saisir des
valeurs que le produit ignorera serait un contrôle mort (§1.4).

- **Les réglages de l'ancien mode ne SURVIVENT pas** : une réservation sur un
  Spark plafonné serait une valeur que rien n'emploie, et que le prochain lecteur
  croirait vraie. Prouvé côté registre par le parcours.
- **Le mode annonce son redémarrage** avant qu'on agisse, comme le disque (§49.4).
- **La table des modes est importée**, jamais recopiée (§12.5) — une seconde
  copie finirait par proposer un mode que le runtime ne connaît pas.
- **Preuves** : 4 de composant, 1 parcours E2E qui va du clavier au registre.
  825 preuves de console.

**Le refus du DISQUE devient atteignable, le 2026-08-21.** La route relevait la
seule mémoire : le refus du §49.3 sur le disque était prouvé au service et ne se
prononçait jamais en production. Un refus inatteignable ne protège personne.

- **Deux grandeurs, deux conditions**, et la dissymétrie est écrite au §49.3
  avant d'être codée : la **mémoire** n'est relevée que sur une cellule EN
  MARCHE — une cellule arrêtée n'en occupe aucune, et refuser sur un chiffre
  périmé interdirait un rétrécissement légitime ; le **disque** est relevé quel
  que soit l'état, parce qu'un Spark arrêté occupe toujours son jeu de données.
- **L'occupation compte les INSTANTANÉS**, et c'est la bonne quantité : le quota
  porte sur le jeu de données entier. Se fonder sur les seuls fichiers vivants
  laisserait poser un quota que le pool ne peut pas honorer.
- **Le runtime muet ne refuse rien** : l'absence de mesure reste une réponse,
  jamais une occupation inventée (§31.2).
- **Preuves** : 3 de route — le refus prononcé avec son occupation mesurée, la
  dissymétrie éprouvée sur un même Spark arrêté, le runtime muet qui laisse
  passer. 867 preuves Python. 1 parcours E2E : le refus arrive dans la modale et
  ne dit PAS « capacité insuffisante ». Capture `55-quotas-refus-disque.png`
  observée.

**CLOSE le 2026-08-21, sur la Forge de validation réelle**, sur instruction
explicite du responsable. Les trois mesures qui manquaient sont faites, et l'une
d'elles a trouvé un DÉFAUT :

- **le disque prend à chaud** : 10 → 12 Gio, la cellule voit la nouvelle taille
  sans redémarrer (`df` rend 13161594880) ; le rétrécissement aussi ;
- **le mode CPU prend à chaud** : `shared` → `capped` pose
  `cpu.max = 50000 100000` dans le cgroup du NOYAU, et le retour rend `max` ;
- **une instance ARRÊTÉE rend bien `disk.root.usage`** — 598029312 octets sur
  `helo` — là où `memory.usage` tombe à zéro. Le refus du §49.3 est donc
  atteignable sur un Spark arrêté, et il a été éprouvé sur la Forge : le refus
  porte le chiffre mesuré et le registre reste intact ;
- **DÉFAUT TROUVÉ ET CORRIGÉ** : la route rendait `applied: true` sans rien
  poser. La taille du disque vit dans le **device** `root`, pas dans la
  configuration de l'instance. C'était le pire des cas que la DoD de l'unité
  nomme — « un quota changé au registre mais pas dans le noyau » —, aggravé par
  un `applied` qui affirmait le contraire. Corrigé, avec la preuve qui regarde le
  device (§49.4 bis).

**Conséquence portée jusqu'à l'écran** : la modale annonçait « exige un
redémarrage » pour le disque et le mode CPU. La mesure l'a démenti ; l'annonce
est retirée de l'écran, du manuel M8, et les preuves qui la gardaient ont été
RÉVISÉES en expliquant pourquoi dans le fichier.

### [x] SPK-58 · Variables d'environnement et secrets d'un Spark

> **Révisée par SPK-64 le 2026-08-21.** Cette unité a livré ce que le §43.6
> demandait alors : un héritage **automatique** de toute entrée de la Forge par
> tous ses Sparks. Le responsable a relevé que cela dépose un secret en clair
> dans des cellules qui n'en ont aucun usage. Le modèle devient une **sélection**,
> et SPK-64 porte le changement. Ce qui est écrit ci-dessous reste le récit exact
> de ce qui a été livré et prouvé.

Le locataire fait tourner une pile Compose ; le produit n'a aucun moyen de lui
passer une valeur. Aujourd'hui, une adresse de relais SMTP ou un jeton d'API se
saisit à la main dans la cellule, par SSH, sans trace et sans état voulu.

**Faisable, et par un mécanisme déjà mesuré** : `push_file` écrit dans la cellule
et sert déjà `authorized_keys` depuis SPK-11. Rien de neuf n'est à inventer côté
transport.

- **Mesuré avant d'écrire la story** (§43.0, six essais sur la Forge réelle) : un
  conteneur n'hérite jamais de l'environnement ambiant ; `.env` et le shell ne
  servent que si le compose **nomme** la variable ; `env_file:` est la seule voie
  qui porte tout un jeu sans énumérer les noms ; et `/etc/profile.d` échoue pour
  tout ce que systemd démarre — donc au redémarrage.
- Spécification : `docs/DAT.md` **§43** · `docs/SCHEMA.md` (migration due) ·
  `docs/DESIGN_SYSTEM.md` §5.4, §6.27, §14.6 · manuel M6 et M8.
- Portée : jeu de variables **de la Forge** et jeu **du Spark** qui le surcharge
  nom par nom (§43.6) ; fichier unique `/etc/spark/env` en `root:root 0600`,
  réécrit **en entier** depuis l'état voulu, réappliqué à la création, au
  changement et **après restauration d'instantané** ; onglet *Environnement* dans
  la fenêtre du Spark, avec une section par niveau et une modale par section ;
  audit du geste **sans jamais la valeur**.
- **Ce qui décide de l'unité, et qui n'est pas le transport** : un secret l'est
  parce qu'on le **déclare**, jamais parce que son nom en a l'air. Mesuré sur le
  filtre du §21.2 : il caviarde `STRIPE_API_KEY` et `SMTP_PASSWORD`, et laisse
  passer `DATABASE_URL` — qui porte un mot de passe neuf fois sur dix. Une entrée
  déclarée secrète n'est plus jamais rendue par l'API, ni réaffichée, ni
  journalisée : l'écran n'en montre que le **nom**, une **empreinte** et la date
  du dernier changement, ce qui suffit à comparer deux Sparks sans rien révéler.
- **Arbitrage rendu le 2026-08-20 : clé sur la Forge** (§43.5). L'unité n'est plus
  bloquée. Conséquence à porter jusqu'au manuel : `sparkd` déchiffre, et la valeur
  est **en clair dans la cellule** — elle doit l'être, `docker compose` ne
  déchiffre rien. Le chiffrement au repos achète **une** chose : une copie du seul
  fichier de registre ne livre plus les secrets. Rien contre `root`.
- **Deux fichiers, pas un** (§43.5.2), et c'est le point que la mesure a imposé :
  `/run` est un **tmpfs** dans la cellule, donc un secret qui y vit n'entre dans
  **aucun instantané**. Avec les secrets dans le fichier persistant, restaurer un
  instantané ancien **ressusciterait un secret révoqué**, en silence, pendant que
  le registre le croirait remplacé. Les secrets vont donc dans
  `/run/spark/secrets`, réécrit à chaque `start` comme `authorized_keys`.
- Ce que l'unité ne fera pas, et qui doit rester écrit : elle ne redémarre pas la
  pile du locataire (§1), elle ne porte pas de **fichiers** — certificats, clés de
  service —, et elle ne protège de personne qui détient `root` sur la Forge
  (§43.4). Le manuel devra le dire aussi clairement que le DAT.
- DoD : un test prouve qu'une valeur déclarée secrète **n'apparaît nulle part** —
  ni réponse d'API, ni journal, ni aperçu, ni export — en la cherchant
  explicitement dans chacun ; un test prouve que le fichier est réécrit en entier
  et qu'un retrait retire ; un test prouve la réapplication **après restauration
  d'instantané**, là où l'ancien fichier revient ; un test d'API prouve le refus
  sur un Spark protégé ; un parcours E2E depuis le parcours canonique pose une
  variable héritée, la surcharge sur un Spark, et lit d'où vient chaque valeur ;
  preuve sur la Forge réelle qu'un `docker compose` du locataire consomme
  effectivement le fichier — déjà obtenue en instruisant l'unité (§43.0, essai F),
  à refaire sur le fichier que le produit écrit ;
  un test prouve qu'une variable **ajoutée après coup** arrive sans que le
  fichier de composition soit retouché, ce qui est la raison d'être de
  `env_file:` ; un test prouve qu'un **instantané ne capture aucun secret**, et
  qu'une restauration ne ressuscite donc pas une valeur révoquée — c'est la
  preuve qui justifie le second fichier ; un test prouve que le fichier volatil
  est **reposé au démarrage** de la cellule ; manuel M6/M8 et
  seed mis à jour.

### [x] SPK-59 · Les quotas se règlent au curseur

**Demande du responsable, 2026-08-20.** Les quotas de l'écran de création se
saisissent au clavier, chiffre par chiffre, alors que ce sont des valeurs bornées
dont on cherche un ordre de grandeur bien plus souvent qu'une valeur exacte. Un
curseur montre la plage en même temps que la valeur ; une saisie ne montre que ce
qu'on y a tapé.

La préférence n'est pas absolue et ne doit pas le devenir : elle ne vaut que
lorsque les bornes sont connues, qu'un pas traverse la plage en un nombre de crans
manipulables, et que ce pas ne détruit pas la granularité que la valeur signifie.

- Spécification : `docs/DESIGN_SYSTEM.md` **§6.9 bis** (la règle générale et ses
  trois conditions) · `docs/DESIGN_SYSTEM_APP.md` **SPK-DS-07** (son application
  ici) · `docs/DAT.md` §25.1, §25.3 · `docs/manuel/M5`.
- Portée : les six quotas de l'écran de création — réservation CPU, plafond CPU,
  cœurs, mémoire, disque, débit. Rien d'autre ne change de forme ; les **ports**
  restent des saisies, et c'est le contre-exemple qui fixe la règle.
- **Ce qui décide de l'unité** : la borne haute est la **capacité totale de la
  Forge**, jamais le disponible. Borner sur le disponible ferait décider l'écran
  à la place de `sparkd` (§25.1) et rendrait le refus d'admission inatteignable
  depuis le parcours canonique.
- Repli obligatoire : capacité inconnue, ou plage impossible à parcourir sans
  perdre la granularité métier — le champ redevient une **saisie numérique**, et
  l'écran ne s'en cache pas.
- DoD : tests de composant sur les deux branches — curseur et repli — et sur le
  calcul des bornes ; parcours E2E qui règle un quota **au clavier** depuis le
  parcours canonique et obtient le refus réel du serveur ; captures observées aux
  trois formats ; manuel M5 et design system mis à jour dans le même changement.
- **Clos le 2026-08-20.** Livré et vérifié :
  - règle générale au `docs/DESIGN_SYSTEM.md` **§6.9 bis**, application au
    **SPK-DS-07**, raisonnement de la borne au `docs/DAT.md` **§25.4** ;
  - **585 tests de console verts**, dont 20 propres à l'unité : borne prise sur la
    capacité et non sur le disponible, cœurs bornés par les cœurs physiques,
    repli en saisie quand la capacité manque, repli quand la plage dépasse les
    crans atteignables, seuil de crans calculé et non déclaré, valeur en clair et
    `aria-valuetext`, deux bornes écrites, borne basse qui ne produit jamais une
    valeur refusée, libellé qui ne porte l'unité que pour la saisie ;
  - **deux garde-fous de non-application** : un port de connexion et un port
    publié doivent rester des saisies. Ce sont eux qui empêcheront la préférence
    de déborder sur ce qu'elle ne doit pas toucher ;
  - **50 parcours E2E verts**, dont REFUS 1 réécrit : il pousse le curseur de
    mémoire à sa borne haute **au clavier** (`Fin`), vérifie que la demande
    dépasse le disponible relevé chez `sparkd`, constate que le bouton n'est
    jamais désactivé avant l'envoi, et obtient le refus réel du serveur ;
  - **captures observées** à 1440, 1024, 768 et 390 px, plus l'état de repli
    (`19b-creation-sans-capacite.png`) : aucun débordement horizontal, la valeur
    et les bornes tiennent à 390 px ;
  - illustrations du manuel `m5-formulaire` et `m5-refus` refaites depuis
    l'application, et observées.
- **Mesure qui vaut d'être retenue** : sur la pile de validation, le pool mémoire
  est de 5,4 Gio et le pool disque de 192 Gio — les deux passent au curseur. Sur
  la Forge réelle, dont les deux disques de 6 To donnent plus de 5 000 Gio, le
  disque **retombe en saisie** par la condition 3. La règle sépare donc bien les
  deux cas sur du matériel réel, sans qu'on ait eu à écrire d'exception.
- **Corrigé dans le même changement, parce que le curseur le rendait intenable** :
  l'avertissement de capacité ne se rafraîchissait jamais pendant la saisie —
  seul un changement de mode CPU provoquait un repeint. La capture 17 d'avant
  cette unité le montre : 64 Gio demandés, 64 Gio libres annoncés, aucun mot. Il
  se rafraîchit maintenant sans repeindre le formulaire, ce qui arracherait la
  poignée en cours de glissement.
- **Défaut voisin NON corrigé, et consigné** : `docs/INCONSISTENCY_REPORT.md`
  **INC-08** — l'erreur d'un champ survit à sa correction jusqu'à la soumission
  suivante. Antérieur à cette unité, mesuré sur la capture d'avant.
- **Amendement du responsable, 2026-08-20, livré le même jour** : la mémoire se
  règle par pas de **256 Mio** et non de 1 Gio. Le gibioctet rendait inatteignables
  les 512 Mio que le seed emploie, et n'offrait que cinq crans sur le pool de 5,4
  Gio de la pile de validation. Deux suites : un format **exact** pour la mémoire,
  `formatOctetsExact` (`formatBytes` rendait « 1,3 Gio » pour 1,25 et « 10 Gio »
  pour 10,25, soit trois crans sur quatre invisibles), et la règle du §6.9 bis
  complétée — la valeur affichée doit être exacte sur la grille du curseur, sans
  quoi c'est le pas qui est mauvais. Détail au `docs/DESIGN_SYSTEM_APP.md`
  SPK-DS-07.
- **Preuve de l'amendement, close le 2026-08-20** : **599 tests de console
  verts** ; captures 15 à 19b et illustrations M5 refaites **et observées après**
  le changement — sur la pile de validation, le curseur de mémoire passe de cinq
  crans à vingt, de 256 Mio à 5,25 Gio ; parcours **`REFUS 1` vert**, seul
  parcours que l'amendement touche, rejoué **isolément** et non par la campagne
  complète (voir le motif ci-dessous). Il pousse le curseur à sa borne haute au
  clavier, vérifie que la demande dépasse le disponible relevé chez `sparkd`, et
  obtient le refus réel.
- **Motif de l'arrêt, et il vaut d'être écrit** : les campagnes E2E ont **saturé
  la mémoire de la machine** et l'ont fait tomber quatre fois. Deux commandes se
  sont terminées en code **137**, un `SIGKILL` — signature du tueur de mémoire.
  `make e2e` monte cinquante fois une pile complète — `sparkd`, hôte console et
  Chromium — et trois sessions en lançaient en parallèle sur le même hôte WSL2.
  La contention avait déjà été mesurée le même jour comme cause de rouges
  erratiques ; la conclusion qu'elle pouvait aussi tuer l'hôte n'en avait pas été
  tirée.
- **Règle qui en sort, et qui dépasse cette unité** : pour éprouver UN parcours,
  `node --test --test-concurrency=1 --test-name-pattern="<nom exact>"` monte
  **une** pile au lieu de cinquante et rend en 2,5 s. La campagne complète reste
  la preuve de non-régression de l'ensemble, mais elle n'est pas l'outil d'une
  vérification ciblée, et elle ne doit pas tourner sur un hôte partagé sans que
  les autres sessions aient confirmé qu'elles ne lancent rien. Portée le
  2026-08-20 dans `docs/AGENT_RUNBOOK.md` §F, avec le chiffre qui la rend non
  négociable : la VM de développement dispose de **7,5 Gio**, pas de la mémoire
  de la machine hôte.

**Spécifiée et commencée le 2026-08-21.** `docs/DAT.md` **§43.9** et
`docs/SCHEMA.md` §10 ter écrits et committés **avant la première ligne de code** :
le §43 posait la doctrine, pas le modèle, ni le chiffrement, ni l'empreinte, ni
la résolution. Le **découpage en quatre tranches** est écrit au §43.9.6 plutôt
que laissé à la mémoire d'une conversation.

**Tranche 1 — le magasin — est LIVRÉE et prouvée le 2026-08-21.**

- **Une table pour les deux portées** (`env_entry`), et non deux : les deux
  niveaux du §43.6 partagent les mêmes colonnes et les mêmes règles.
- **Deux index PARTIELS** portent l'unicité, et c'est une contrainte de SQLite,
  pas un choix de style : un `UNIQUE (scope, spark_id, name)` ne protégerait rien
  au niveau Forge, SQLite tenant deux `NULL` pour distincts.
- **La base refuse elle-même une ligne secrète portant sa valeur en clair**, par
  déclencheur, comme au §10 bis pour la signature. Compter sur le code appelant
  produirait exactement la fuite que l'unité existe pour empêcher.
- **AES-256-GCM, le NOM en donnée associée** : un chiffré déplacé d'une variable
  à une autre ne se déchiffre pas. Écartés, avec leur motif au §43.9.2 : la
  bibliothèque standard, qui n'embarque aucun chiffrement symétrique, et
  `openssl enc`, dont le mode GCM ne gère pas l'étiquette d'authentification.
- **L'empreinte est un HMAC pris avec la clé de la Forge**, jamais un hachage nu
  qui livrerait `changeme` par force brute. Comparable entre deux Sparks de la
  même Forge — ce que le §43.3 demande — et pas d'une Forge à l'autre.
- **La clé est créée si elle manque, et JAMAIS remplacée** : la refabriquer
  rendrait tous les secrets indéchiffrables en silence.
- **Preuves** : 19, dont celle de la DoD — la valeur d'un secret est **cherchée**
  dans la réponse, dans le journal et dans la table, et ne s'y trouve pas. Une
  première version de cette preuve ne prouvait rien : `str(sqlite3.Row)` ne rend
  pas son contenu, et elle cherchait le secret dans une adresse mémoire.

**Tranche 2 — la matérialisation — est livrée le 2026-08-21, sauf ses routes.**

- **La MESURE a corrigé le contrat** (§43.9.7, Docker Compose v5.1.4) :
  l'analyseur d'`env_file:` n'est pas littéral. `A=abc$def` arrive comme `abc`,
  les guillemets sont retirés, les blancs rognés — **un mot de passe contenant
  `$` serait tronqué en silence**. Et l'idiome du shell `'ab'\''cd'` fait
  échouer la lecture du **fichier entier** : une apostrophe dans un mot de passe
  viderait tout l'environnement de la pile. D'où les guillemets doubles avec
  échappement, mesurés sur de vrais conteneurs.
- **Trois fichiers, deux grammaires** : Compose et le shell n'encodent pas
  pareil, et l'idiome que l'un exige est celui que l'autre refuse.
- **Le fichier de confort ne porte AUCUN secret** — trouvé en codant : il vit
  dans `/etc`, donc dans les instantanés, et y écrire les secrets annulerait
  exactement ce que le §43.5.2 protège.
- **La clé se DÉRIVE du chemin du registre** — trouvé en codant aussi : le
  défaut codé en dur la cherchait dans `/var/lib/sparkd` alors que le registre
  est ailleurs en test et en développement.
- **Posé à la création, au démarrage et après restauration.** Le fichier volatil
  est reposé à chaque démarrage : sans cela, un Spark redémarré perdrait ses
  secrets.
- **Preuves** : 13 de plus — 10 sur l'écriture et les trois fichiers, 3 qui
  vérifient ce que la CELLULE a reçu. 899 preuves Python.

**Tranche 2 — COMPLÈTE le 2026-08-21.** Les six routes du §43.9.5 sont ouvertes,
et écrire repose les fichiers : le « au changement » du §43.2 était le dernier des
quatre moments qui manquait.

- **`PUT` avec le nom dans le CHEMIN**, pas `POST` sur la collection : le geste
  est idempotent — « cette variable vaut ceci » — et rejouer la requête doit
  donner le même état, pas une seconde entrée.
- **Un geste de FORGE face à un Spark gelé** : la question n'était pas tranchée,
  et une variable de la Forge descend dans tous les Sparks. La convention EXISTE
  déjà dans le produit — la révocation d'une clé (§35.2) — et on s'y range :
  **informer, puis accepter** (§43.9.5 bis). Un refus ferme gèlerait toute la
  Forge dès qu'un Spark est protégé, et l'exploitant lèverait la protection pour
  contourner : cela protégerait moins, pas plus.
- **Une écriture au niveau du Spark reste refusée en `423`** : le verrou porte
  sur l'objet, et c'est une écriture qui LE vise.
- **Le SEED pose les cinq situations** que l'écran devra distinguer — les trois
  origines et deux secrets, dont un hérité — par les **vraies routes** (§28.3).
  Sa vérification échoue si une origine manque ou si un secret rend sa valeur.
- **Preuves** : 10 de plus, dont celle de la DoD qui cherche la valeur du secret
  dans **chaque** sortie de l'API. 909 preuves Python. Contrat d'API régénéré.

**Tranche 3 — l'écran — livrée le 2026-08-21.** Une facette *Environnement* dans
la fenêtre d'un Spark, **deux sections, une par niveau** (§43.6).
`docs/DESIGN_SYSTEM.md` relu intégralement avant (`CLAUDE.md` §4).

- **Le tableau rend le jeu RÉSOLU**, avec l'**origine** de chaque valeur —
  héritée, propre, ou surchargeant celle de la Forge. Montrer deux jeux sans les
  résoudre ferait faire le calcul de tête, et c'est le calcul qu'on se trompe à
  faire. La surcharge est une règle métier : l'écran la demande au serveur plutôt
  que de croiser deux listes (`DESIGN_SYSTEM.md` §1.2).
- **La valeur d'un secret n'est jamais rendue** : un badge « Secret » et son
  empreinte. Un blanc laisserait croire qu'aucun secret n'est posé (§14.6).
- **La modale annonce que rien ne redémarre** (§43.7), et dit ce qu'une
  déclaration de secret engage. Un refus y reste, sans effacer la saisie.
- **Un Spark protégé garde la commande, DÉSACTIVÉE, avec sa raison** (§9.9) ;
  celle de la Forge reste ouverte, son geste suivant le §43.9.5 bis.
- **Deux défauts trouvés par la CAPTURE et le contrôle de classes**, invisibles
  aux tests : la colonne *Nom* était centrée — un `th scope="row"` hérite du
  centrage par défaut là où le §6.14 veut le texte à gauche — et une classe
  `tableau` inventée ne peignait rien, le produit ayant déjà `tableau-enveloppe`.
- **Preuves** : 11 de composant, 836 preuves de console. Captures
  `56-environnement.png` et `57-environnement-modale.png` observées.

**Deux parcours E2E le 2026-08-21**, depuis le parcours canonique : l'origine de
chaque valeur est à l'écran, et **la valeur d'un secret ne s'affiche nulle part**
— la preuve cherche les deux valeurs seedées dans tout le texte rendu. C'est le
point central de la Definition of Done, et il est tenu.

**Tranche 3 CLOSE le 2026-08-21, et le parcours a trouvé un vrai défaut.**

- **`Échap` ne fermait pas la modale d'environnement.** `onFermer` oubliait
  l'état de la facette : `close()` s'exécutait, puis la repeinte trouvait `open`
  encore vrai et rappelait `showModal()`. La modale se rouvrait dans le même
  tour. C'est le défaut que le §6.27 existe pour empêcher, et **seul un parcours
  pouvait le voir** — les preuves de composant ne rejouent pas le cycle de
  fermeture. Corrigé, et éprouvé.
- **L'hypothèse de la session précédente était FAUSSE** : le refus s'affichait
  bien. Le filet posé au §18 — un échec qui se NOMME au lieu de se perdre — l'a
  montré du premier coup. Il reste en place : une promesse qui rejette laisserait
  sinon la modale sur « Envoi… » indéfiniment.
- **Quatre parcours E2E** : les deux de lecture, la pose au clavier avec son
  retrait, et le refus d'un nom hors grammaire avec sa fermeture par `Échap`.
- **Le manuel porte le geste** : M6 dit au locataire comment attacher les deux
  fichiers à ses services et ce que le fichier volatil implique ; M8 dit à
  l'exploitant les trois origines, ce qu'une déclaration de secret engage et ce
  qu'elle **ne protège pas**.

**CLOSE le 2026-08-21, sur la Forge de validation réelle.** Le dernier écart est
levé : l'essai F du §43.0 a été refait **sur le fichier que le produit écrit**.
Sur instruction explicite du responsable, la build du jour a été installée sur la
Forge, la migration `010` s'est appliquée, et un `docker compose` du locataire a
reçu les trois valeurs — une héritée de la Forge, une propre au Spark, un secret
depuis le fichier volatil. Une quatrième, posée **après** le premier démarrage,
est arrivée **sans que le fichier de composition la nomme** : c'est ce qui
justifie `env_file:`.

Relevé au même instant dans la cellule : les deux fichiers en `root:root 0600`,
le secret absent du fichier persistant et du fichier de confort, et la clé de
chiffrement créée en `0600` à côté du registre.

### [ ] SPK-60 · Le briefing d'un Spark, pour l'agent qui s'y connecte

Un agent qui entre dans une cellule fraîche ne sait rien : ni ses quotas, ni où
lire l'environnement injecté, ni ce qui est installé, ni pourquoi certaines
choses vont échouer. Il découvre par essais, et chaque essai raté coûte un
aller-retour.

- **Mesuré avant d'écrire la story** (§44.1), et cela décide de la forme : le
  message d'accueil SSH n'est rendu que pour un **shell de connexion
  interactif**. `ssh spark 'commande'` — ce que fait un agent — ne l'affiche
  **jamais**, `-tt` compris. Un message d'accueil seul n'atteindrait donc pas son
  destinataire : il marcherait quand un humain le teste, et serait invisible en
  usage réel.
- Spécification : `docs/DAT.md` **§44** · §41, §43 (les pièges qu'il énonce) ·
  `docs/AGENT_RUNBOOK.md` · manuel M6.
- Dépend de : SPK-54 — c'est l'amorçage qui pose le briefing la première fois.
- Portée : `/etc/spark/BRIEFING.md` et `/etc/spark/briefing.json`, même contenu,
  l'un lisible et l'autre analysable ; message d'accueil réduit à trois lignes
  dont **le chemin du briefing** ; réécriture en entier depuis l'état voulu, comme
  `authorized_keys` (§17.1), reposée à chaque changement du plan de contrôle —
  route, port publié, variable, redimensionnement, protection.
- Contenu, dicté par ce que l'agent **ne peut pas apprendre seul** depuis la
  cellule (§44.2, `sparkd` y est injoignable et c'est voulu) : identité et
  adresses, quotas **avec leur sémantique** — `nproc` et `free` rapportent la
  machine, pas la cellule —, routes d'ingress, ports publiés, **noms** des
  variables et secrets injectés et leurs deux chemins, état de protection.
- Ce qu'il ne porte **pas** (§44.3) : aucune valeur de secret — un briefing est
  affiché, copié, collé, c'est le trajet qu'un secret ne doit pas faire ; aucune
  liste de paquets prétendue à jour — le produit inscrit ce qu'il a installé
  lui-même **avec la date**, et donne la commande pour le reste.
- Doit énoncer les pièges qui coûtent chacun un aller-retour (§44.5) : Docker
  depuis le dépôt amont sous peine de refus AppArmor, les deux lignes `env_file:`
  sans lesquelles aucune variable n'arrive, `/run` en tmpfs, et le fait qu'on
  n'expose rien depuis l'intérieur — une route se **demande** au plan de contrôle.
- Règle de fond (§44.6) : un briefing **énonce des faits**, il ne donne pas
  d'ordre, et il dit qui l'a écrit — le locataire est `root` dans sa cellule et
  peut le réécrire, donc un agent ne s'en sert jamais pour décider de ce qu'il a
  le droit de faire.
- DoD : un test prouve qu'aucune **valeur** de secret n'entre dans le briefing, en
  la cherchant explicitement dans les deux fichiers ; un test prouve la réécriture
  après ajout d'une route et après une variable ; un test prouve que les deux
  formats portent **le même** contenu ; parcours E2E depuis le parcours canonique —
  amorcer un Spark, s'y connecter en `ssh spark 'cat …'` et **lire le briefing
  sans shell interactif**, ce qui est le cas d'usage réel ; preuve sur la Forge
  réelle qu'un agent partant du seul briefing déploie une pile joignable ; manuel
  M6 et `docs/AGENT_RUNBOOK.md` mis à jour.

### [ ] SPK-64 · L'héritage de l'environnement devient une sélection

**Correction d'un défaut de sécurité de SPK-58**, relevé par le responsable le
2026-08-21. Le modèle livré fait descendre **toute** entrée de la Forge dans
**tous** ses Sparks. Or le §43.5.1 établit que la valeur redevient **en clair
dans la cellule** : définir un secret une fois à la Forge le dépose donc en clair
dans trente cellules, dont celles qui n'en ont aucun usage et celle qu'un
locataire compromettra.

- Spécification : `docs/DAT.md` **§43.6 révisé** · §43.2 (réécriture en entier
  depuis l'état voulu) · §43.5.1 · `docs/SCHEMA.md` (migration due).
- Portée : la Forge tient un **catalogue** ; chaque Spark **coche** ce qui descend
  chez lui. Une entrée de catalogue n'a **aucun effet** tant qu'aucun Spark ne l'a
  cochée. Un Spark garde ses entrées propres, qui **gagnent** sur une entrée
  cochée de même nom.
- Migration : les sélections n'existent pas encore. Elle doit **cocher pour chaque
  Spark existant tout ce qu'il recevait déjà**, sinon la mise à jour retirerait en
  silence des variables dont des piles dépendent. Le comportement observable ne
  change pas au moment de la migration ; ce sont les **ajouts suivants** qui
  cessent de descendre tout seuls.
- Écran : l'onglet de la Forge porte le catalogue ; la facette *Environnement* d'un
  Spark porte les cases et ses entrées propres. Chaque valeur dit **d'où elle
  vient** — cochée, propre, ou propre en **masquant** une cochée.
- À proposer au responsable, sans l'implémenter d'office : une entrée du catalogue
  pourrait être **proposée par défaut à la création** d'un Spark. Ce serait un
  défaut de formulaire, pas un héritage — la sélection resterait stockée par
  Spark, donc changer le défaut plus tard ne changerait rien aux Sparks existants.
  Utile si cocher les cinq mêmes entrées trente fois devient pénible.
- DoD : un test prouve qu'une entrée ajoutée au catalogue **ne change
  l'environnement d'aucun Spark existant** ; un test prouve que **décocher retire
  réellement** de la cellule, et pas seulement du registre ; un test prouve qu'une
  entrée propre l'emporte sur une entrée cochée de même nom ; un test prouve que la
  migration **préserve** l'environnement effectif de chaque Spark existant ;
  parcours E2E depuis le parcours canonique — définir au catalogue, constater qu'il
  ne descend nulle part, cocher sur un Spark, le voir arriver, décocher, le voir
  partir ; manuel M6/M8 et seed mis à jour.

### [ ] SPK-65 · La console dit quand elle sert du code périmé

**Trois fois en deux jours**, le responsable a perdu du temps sur un défaut qui
n'en était pas un : le processus servait du code plus ancien que le dépôt.

| Symptôme rapporté | Cause réelle |
|---|---|
| « le manuel est vide » | la console tournait depuis avant les routes du manuel |
| « la Forge dit `build inconnue` » | `sparkd` réinstallé sans son estampille |
| « l'onglet Docker ne fonctionne pas » | la console tournait depuis **15 heures**, avant SPK-44 |

Aucun de ces trois n'est un défaut du code. Les trois se voient de la même façon
— on cherche longtemps dans le produit ce qui n'y est pas — et se corrigent par
un redémarrage. **Ce qui manque n'est pas un correctif, c'est un signal.**

SPK-53 a résolu exactement ce problème **pour la Forge** : la console compare la
build déployée au dépôt et nomme les six situations. Elle ne le fait pas pour
**elle-même**.

- Spécification : `docs/DAT.md` §40 (le modèle de SPK-53, à étendre) ·
  `docs/DESIGN_SYSTEM.md` §14.6 (trois situations ne se confondent pas).
- Portée : l'hôte console relève, à son démarrage, ce qu'il exécute — commit du
  dépôt, ou date des fichiers servis quand il n'y a pas de dépôt — et le compare à
  l'état courant. Le décalage est **annoncé dans l'interface**, pas seulement
  journalisé : celui qui subit le symptôme n'est pas dans les journaux.
- Ce que le signal doit dire, et qui décide de l'unité : **quoi faire**. « Console
  démarrée avant 12 commits · redémarrer pour en bénéficier » est utile ; « version
  différente » ne l'est pas.
- Cas à ne pas confondre (§14.6) : dépôt absent — une console installée chez un
  exploitant qui ne développe pas —, dépôt présent et identique, dépôt en avance,
  et **dépôt en retard sur la console**, qui n'est pas une anomalie.
- Ce que l'unité ne fait pas : redémarrer toute seule. Un processus qui se relance
  sous les doigts de quelqu'un est pire que le décalage qu'il corrige.
- DoD : un test prouve qu'un dépôt avancé d'un commit produit le signal ; un test
  prouve que l'absence de dépôt ne le produit **pas** ; un parcours E2E montre le
  signal à l'écran ; captures observées ; le signal nomme le geste, prouvé sur son
  texte.

---

## Réservé, non planifié

- `runtime: vm` pour charges non maîtrisées — VT-x est présent sur l'hôte, donc
  techniquement ouvert.
- Multi-serveurs.
- Quotas d'E/S disque par Spark au-delà de la priorité.
- Export hors machine planifié : écarté, les applications sauvegardent déjà vers un
  S3 externe par leur propre ordonnanceur.
