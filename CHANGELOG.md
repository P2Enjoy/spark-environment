# CHANGELOG

## [Non publié]

### Corrigé
- **L'assistant d'installation voit enfin la Forge telle qu'elle est** (SPK-68,
  `docs/DAT.md` §50.2 bis, §50.4) : le relevé interrogeait `incus` sous
  l'identité SSH ordinaire, à qui la socket du démon est refusée. La commande
  rendait son mode d'emploi, le pool ZFS existant devenait invisible, et
  l'assistant proposait de **créer un pool fichier sur une Forge qui portait déjà
  son miroir**. Le droit d'administration déjà constaté pour `sudo` sert
  désormais aux lectures qui l'exigent, et une sortie sans la forme attendue est
  écartée au décodage au lieu de devenir une donnée.
- **Le plan reprend la configuration déclarée par la Forge, plus les défauts du
  contrat** (SPK-68, `docs/DAT.md` §50.4) : cinq clés nommées de
  `/etc/sparkd/sparkd.env` et le plafond ARC sont relevés. Une Forge installée
  sur `tank`/`br1` ne se voit plus reproposer `spark`/`sparkbr0`, et les ports
  réservés supplémentaires ne sont plus retirés en silence. Le fichier n'est
  jamais lu en entier : `SPARKD_NOTIFY_URL` et les autres valeurs sensibles ne
  remontent pas.
- **Le diagnostic conclut, au lieu de seulement relever** (SPK-68,
  `docs/DESIGN_SYSTEM_APP.md` SPK-DS-12) : dix contrôles mesurés — dont les codes
  HTTP de `/healthz` et `/readyz` — disent si la Forge est installée, et si elle
  est prête. Une phase de nouveau constatée conforme s'affiche `terminée` avant
  l'engagement. Une Forge intégralement installée ne reçoit plus exactement le
  même écran qu'une machine nue. « Forge prête » n'est écrit que sur les deux
  codes mesurés ; un contrôle non lisible reste un défaut, pas un succès par
  défaut.
- **La tranche des Sparks délègue à nouveau ses contrôleurs** (SPK-71,
  `docs/DAT.md` §32.4 ter) : le paquet pose `spark-delegation.service`, une unité
  `Slice=spark.slice` déléguée qui n'existe que pour son cgroup. systemd n'active
  un contrôleur dans le `subtree_control` d'une tranche que si une unité sous
  elle le réclame — et les Sparks n'en sont pas, Incus les place par
  `lxc.cgroup.dir.container`. La tranche se retrouvait donc sans `cpu`, `cpuset`
  ni `memory` délégués : les limites d'Incus ne s'appliquaient plus *dans* la
  tranche et la réservation redevenait proportionnelle en silence. Le préflight
  `RUN-SLICE` rougissait et faisait échouer `cloud-init`. Il exige désormais les
  contrôleurs **et** l'unité qui les maintient. Les trois `…Accounting=` sont
  retirés de la tranche : `CPUAccounting=` n'existe plus sur systemd 259, et
  aucun n'a jamais délégué quoi que ce soit à la tranche.
- **Le préflight lit la configuration SSH effective** (SPK-72, `docs/DAT.md`
  §48.2) : `SSH-X11` interroge `sshd -T` au lieu du seul
  `/etc/ssh/sshd_config`, et retombe sur le fichier quand `sshd` n'est pas
  invocable. Le contrôle ignorait le fragment `sshd_config.d/90-spark.conf` que
  l'installateur écrit lui-même, et ne pouvait donc jamais passer au vert sur une
  Forge correctement installée.
- **La documentation décrit la Forge réinstallée** : Ubuntu 26.04.1, noyau 7.0,
  systemd 259, Incus 7.4, ZFS 2.4.1, et surtout la **disposition A** — miroir ZFS
  natif sur `sda5`+`sdb5` — au lieu de la disposition sur fichier. La « contrainte
  structurante » d'absence de périphérique bloc libre est levée et énoncée comme
  telle, au lieu d'être laissée à côté de la nouvelle réalité.

### Ajouté
- **Le Spark présente une identité SSH, et la console en donne la clé publique**
  (SPK-74, `docs/DAT.md` §17.5) : sur la facette « Clés », une section crée d'un
  bouton une paire de clés **dans la cellule**, affiche la clé publique et son
  empreinte en monospace, et la copie au presse-papier — pour la poser en
  *deploy key* sur le dépôt GitHub à cloner. C'est le sens inverse des clés de
  SPK-11 : celles-là laissent entrer, celle-ci laisse sortir. La clé privée
  naît dans le Spark et n'en sort jamais ; aucune copie n'entre au registre, la
  cellule étant la seule source. Un Spark arrêté rend « illisible » et non
  « aucune identité », et remplacer une identité existante exige la frappe du
  nom, parce que la clé déjà posée chez le tiers cesse alors d'être valide.
- **L'amorce d'une Forge entre au dépôt** (SPK-73) : `deploy/cloud-init/` porte
  le script `spark-amorce.sh` et son gabarit `user-data.yaml`, jusqu'ici présents
  seulement sur la machine, donc ni versionnés ni relisibles. Le `README.md`
  documente le rejeu — `sudo /opt/spark-amorce.sh`, pas `cloud-init` — et ce
  qu'il préserve : le pool est adopté, le registre n'est jamais touché, les
  migrations sont additives, donc les Sparks existants survivent.
- **Schéma de partitionnement du README conforme à l'API Elastic Metal**
  (SPK-28) : `disks` et `raids` deviennent des listes et non des objets indexés
  par périphérique, les libellés inexistants `bios` et `pool` cèdent la place à
  `legacy` et `data`, et `size: 0` cède la place à des tailles qui totalisent la
  capacité réelle des disques. Le pool reste délibérément non déclaré à
  l'hébergeur : le créer à l'installation ferait refuser les périphériques par
  `scripts/creer-pool.sh`. Les preuves tiennent désormais la forme et les
  énumérations de l'API, au lieu de la forme qu'elles supposaient.

### Ajouté
- **Amorçage fermé d'une Forge vierge** (cinquième tranche de SPK-68) : avant
  l'exécuteur, la console pose au besoin l'environnement Python et le paquet
  `sparkd` exactement épinglé sur la build qu'elle a chargée, à condition que
  celle-ci soit `main` publiée. Le navigateur ne fournit ni URL, ni branche, ni
  commande ; le script shell et le plan JSON passent par deux connexions SSH
  distinctes, et un paquet déjà conforme n'est pas réinstallé. La progression
  conserve l'amorçage sur sa propre ligne au lieu de l'écraser par la relecture
  suivante du plan.
- **Orchestration hôte de l'installation distante** (quatrième tranche de
  SPK-68) : la console reconstruit le plan sur un dernier diagnostic, exige la
  confirmation du plan et celle du stockage, lance uniquement l'exécuteur
  versionné, refuse deux installations concurrentes et persiste son journal hors
  inventaire. La vue rend les phases et mesures distantes, restaure le compte
  rendu après redémarrage et relit la Forge avant toute reprise.
- **Exécuteur versionné d'installation de Forge** (troisième tranche de SPK-68,
  `docs/DAT.md` §50.4-§50.6) : le paquet consomme exclusivement le plan fermé de
  la console, répète le diagnostic et les confirmations sur la machine, puis
  applique chaque écart jusqu'à la recette `préflight`, `healthz`, `readyz` et
  synchronisation de topologie. Le pool existant n'est jamais recréé et un
  second passage conforme ne réécrit ni stockage, ni réseau, ni unités.
- **Mise à jour distante et retour arrière mesuré de `sparkd`** (SPK-69,
  `docs/DAT.md` §40.6) : pour une Forge dont le commit est un ancêtre sûr de
  `origin/main`, la console installe le paquet épinglé, repose les unités,
  observe `daemon-reload` et le redémarrage, puis exige `healthz`, `readyz=ready`
  et la build attendue. Le navigateur ne fournit aucune commande ni version ;
  un échec après mutation tente la build précédente, et le retour volontaire
  reste borné au reçu du geste. Les deux chemins sont journalisés.
- **Terminal interactif et registre de sessions** (SPK-70, `docs/DAT.md` §37.4) :
  xterm interprète désormais ANSI/ECMA-48, reçoit directement clavier, collage
  et touches de contrôle, répond à DSR et propage la taille au vrai PTY. Le
  registre local retrouve les shells Spark, conteneur et dépannage sur toutes
  les Forges sans conserver aucun octet saisi ou affiché ; il ferme le processus
  distant après confirmation et devient un tiroir sur écran étroit.
- **Diagnostic d’installation distante de Forge** (première tranche de SPK-68,
  `DAT.md` §50) : la console distingue désormais « SSH établi » de l’API
  `sparkd`, même quand `/healthz` ne répond pas. Son script fermé relève en
  lecture seule le système, les runtimes, les services et les supports ; un
  disque racine, monté ou signé est affiché mais jamais proposé au miroir. Aucun
  pool, service ou paquet ne peut être créé depuis cette première tranche.
- **Le briefing d'un Spark** (SPK-60, `docs/DAT.md` §44) : l'amorçage relève
  `openssh-server`, Docker et Compose avec leur date, puis le plan de contrôle
  produit `/etc/spark/BRIEFING.md` et son même modèle JSON. Un agent le lit par
  `ssh spark 'cat …'`, donc sans dépendre d'un shell interactif. Les noms des
  variables sont présents, jamais leurs valeurs secrètes ; routes, ports,
  quotas et protection le réécrivent depuis l'état voulu.
- La version de `sparkd` est **dérivée du dépôt** : elle porte le commit et croît
  à chaque commit, ce qui rend `pip install -U` effectif et supprime la variable
  d'estampille qu'on pouvait oublier.
- `env_selection` (migration `011`) et ses deux routes : le catalogue de la Forge
  ne descend plus que dans les Sparks qui l'ont **coché**.
- Unité SPK-66 : `sparkd` s'installe comme un **paquet**, pas comme une copie du
  dépôt. Le paquet existe déjà à moitié ; c'est la copie qui est en trop. Effet
  qui justifie l'unité à lui seul : l'estampille de build cesse d'être passée à la
  main, donc plus personne ne peut l'oublier.
- Unité SPK-65 : la console dit quand elle sert du code périmé. Trois symptômes
  rapportés en deux jours — manuel vide, build inconnue, onglet Docker en 404 —
  avaient la même cause : un processus plus ancien que le dépôt.
- `make runProd` : la **console d'exploitation seule** — inventaire du poste,
  tunnels vers de vraies Forges, aucun `sparkd` local. La cible manquait, alors
  que `CLAUDE.md` §3 la demande ; `make runDev` monte un `sparkd` **factice**, et
  rien ne disait comment lancer la console pour de vrai.
- Unité SPK-64 : l'héritage de l'environnement devient une **sélection**. La Forge
  tient un catalogue, chaque Spark coche ce qui descend chez lui — correction d'un
  défaut de sécurité de SPK-58, relevé par le responsable.
- SPK-64 : la console rend maintenant ce modèle utilisable. L'onglet
  **Environnement** de la Forge décrit le catalogue et combien de Sparks reçoivent
  chaque entrée ; la facette du Spark coche, décoche et nomme les valeurs qu'elle
  reçoit. Une entrée nouvelle ne descend nulle part avant un geste explicite. Les
  valeurs propres restent distinctes et disent quand elles masquent une entrée
  cochée. Un geste de Forge qui toucherait un Spark protégé le nomme et demande
  confirmation, sans lever de protection.
- **L'environnement d'un Spark : le magasin** (SPK-58, `docs/DAT.md` §43.9) —
  première tranche. Le registre sait porter des variables d'environnement à deux
  niveaux, la Forge et le Spark, la seconde surchargeant la première **nom par
  nom**. Une entrée peut être **déclarée secrète** : sa valeur est alors chiffrée
  au repos, n'est plus jamais rendue par l'API, n'entre jamais au journal, et
  l'écran n'en montrera que le nom, une empreinte et la date. La clé de
  chiffrement vit sur la Forge, est créée si elle manque et n'est jamais
  remplacée.
- **L'environnement d'un Spark : les fichiers** (SPK-58, `docs/DAT.md` §43.9.7) —
  deuxième tranche. Les fichiers `/etc/spark/env` et `/run/spark/secrets` sont
  désormais **posés dans la cellule** à la création, à chaque démarrage et après
  une restauration d'instantané. Le locataire les attache à ses services par un
  `env_file:` à deux entrées. Les valeurs sont écrites de façon à **traverser
  Compose intactes** — mesuré : sans cela, un mot de passe contenant `$` serait
  tronqué en silence, et une apostrophe viderait tout l'environnement de la pile.
- **L'environnement d'un Spark : les gestes** (SPK-58, `docs/DAT.md` §43.9.5) —
  troisième tranche. Six routes posent, lisent et retirent une variable, au
  niveau de la **Forge** ou d'un **Spark**, et l'écriture repose aussitôt les
  fichiers dans la cellule. La lecture d'un Spark dit **d'où vient chaque
  valeur** — cochée au catalogue, propre, ou masquant une entrée cochée. Un Spark protégé
  refuse l'écriture qui le vise ; un geste de Forge qui toucherait des Sparks
  protégés les **nomme** d'abord et n'aboutit qu'au second appel. Les données de
  démonstration couvrent les trois origines et deux secrets.
- **L'environnement d'un Spark : l'écran** (SPK-58, `docs/DESIGN_SYSTEM.md` §6.27)
  — quatrième tranche. La fenêtre d'un Spark porte un onglet **Environnement**
  qui rend les variables propres et leur origine, sans jamais afficher une valeur
  secrète : seuls son nom, une empreinte et sa date. Poser une variable se fait
  depuis la section, et l'écran annonce que **rien ne redémarre** — la pile du
  locataire lira la nouvelle valeur à son prochain démarrage. SPK-64 a depuis
  séparé le catalogue Forge de la sélection explicite par Spark. Le manuel M6
  explique au locataire comment attacher les fichiers à ses services, et le
  manuel M8 explique à l'exploitant ce qu'une déclaration de secret engage.

- **La réservation CPU est désormais annoncée pour ce qu'elle est** (SPK-29) :
  un **plancher**, garanti quand la Forge et ses Sparks travaillent tous, et
  dépassé le reste du temps. L'écran des pools et le manuel M4 le disent, avec le
  chiffre de la mesure. Le produit annonçait jusqu'ici « non garantie sous
  contention » — vrai, mais trop modeste.

### Corrigé
- **Un SSH établi sans `sparkd` n'émet plus deux faux incidents réseau dans le
  navigateur** (SPK-68) : l'ouverture du transport rend un succès avec ses deux
  états distincts, puis la page réserve les routes d'administration à un plan de
  contrôle prêt. Le diagnostic d'installation reste accessible sans appeler
  `/v1/forge` par anticipation. L'en-tête dit alors **SSH établi · sparkd sans
  réponse**, sans proposer une reconnexion qui ne redémarrerait pas le service ;
  la carte des ressources désigne l'assistant, sans refus rouge, sortie
  `fetch failed` ni bouton **Réessayer** sans effet.
- **Deux régressions d'exploitation introduites dans les douze dernières
  heures** : passer directement du terminal d'un Spark à celui d'un autre ferme
  désormais le premier shell, et le sélecteur de contexte Docker produit de
  nouveau une commande `sh` valide. L'amorçage ne peut donc plus annoncer un
  Docker présent pendant que l'onglet échoue avant même de lancer le client.
- **Les procédures d'exploitation emploient maintenant le Python du paquet**
  (SPK-55 / SPK-66) : préflight, sauvegarde et restauration passent par
  `/opt/sparkd/venv/bin/python`, comme le service systemd. Le Python système ne
  contient volontairement pas `sparkd`; le message après restauration annonce
  donc l'exécutable qui vient réellement d'effectuer le geste.
- **Le contexte Docker rootless est maintenant cohérent entre la console et le
  briefing** (SPK-54 / SPK-60) : chaque commande de lecture ou d'action emploie
  le socket de `spark-docker` uniquement lorsqu'il répond; un échec n'est jamais
  rejoué sur Docker root. Le briefing, M6 et le runbook indiquent le compte et
  le gabarit de socket nécessaires à une pile rootless.
- **Un changement de clé d'hôte SSH est nommé sans être contourné** (SPK-43) :
  l'onglet Docker et le diagnostic de terminal distinguent cette empreinte
  changée d'un Spark injoignable. Aucune commande ne part, et la console
  n'accepte ni n'efface automatiquement `known_hosts`.
- **La reprise Docker rootless constate maintenant un démon réellement
  utilisable** (SPK-54) : le compte de service seul ne suffit pas. Le script
  porte aussi explicitement `systemd-container` dans sa préparation Debian 13,
  rejoint son bus D-Bus avec `runuser`, vérifie le service et son socket, et
  réserve ses sous-plages `subuid`/`subgid` dans l'idmap réel de la cellule
  Incus. Il reprend seulement ce démon quand aucun Docker enraciné ne tourne et
  refuse tout résultat incomplet au lieu de journaliser un succès fictif.
- **« La cellule a disparu » se dit maintenant partout** (SPK-67). Selon l'écran
  d'où l'on agissait, le produit savait ou ne savait pas distinguer une cellule
  disparue d'un Incus injoignable : la suppression le savait, la lecture non.
  Neuf écrans supplémentaires — usage, instantanés, amorçage, clés — nomment
  désormais la perte avec la même phrase et les mêmes issues, au lieu de rendre
  une erreur interne. Le pilote factice du développement rend enfin les mêmes
  réponses que le vrai — ni moins, ni plus —, ce qui empêche une preuve d'être
  verte sur une forme qui ne tourne jamais en production.
- **Un Spark dont la cellule a disparu reste manœuvrable** (SPK-36). Demander son
  démarrage rendait une erreur interne et le laissait **stablement** en cours de
  démarrage, sans aucune commande offerte et sans dire pourquoi : depuis la
  console, il n'était plus possible ni de le reconstruire ni de le supprimer. Le
  chemin de reprise existait pourtant déjà — c'était une porte fermée devant un
  escalier construit. Le Spark passe désormais en panne, l'écran nomme la perte,
  et les deux issues sont offertes : « Reprendre » reconstruit la cellule,
  « Supprimer » rend sa place au pool. Mesuré sur la Forge de validation, puis
  éprouvé depuis la console.
- **Le préflight voit une ligne de registre qui déclare une cellule absente**
  (SPK-36, contrôle `REG-FANTOME`). La Forge de validation en portait une depuis
  deux jours sans que rien ne le signale : trois fois trop de processeur compté,
  et un poids de tranche quatre fois trop élevé, pendant que le préflight
  annonçait « 0 bloquant ». Le contrôle nomme les Sparks concernés **et ce qu'ils
  coûtent**.
- **Le journal nomme enfin la clé qui a agi** (SPK-37). L'empreinte de la clé
  SSH n'atteignait **jamais** le journal : la console demandait à OpenSSH un
  niveau de diagnostic qui n'émet pas la ligne nommant la clé acceptée. Chaque
  geste était donc attribué au seul serveur, sans que rien ne le signale — la
  valeur de repli est légitime, et ne se distinguait pas d'un repli mérité.
  Mesuré et corrigé contre un vrai serveur SSH.
- **Un tunnel qui s'ouvre bien n'affiche plus de diagnostic** (SPK-37). Le
  message de succès d'OpenSSH était rangé parmi les erreurs et rendu à l'écran.
- **La modale d'environnement se ferme désormais par « Échap »** (SPK-58). Elle
  se rouvrait dans le même tour : la fermeture s'exécutait, puis la repeinte la
  rappelait aussitôt. La touche paraissait sans effet.
- **Un redimensionnement de disque prend désormais réellement effet** (SPK-57).
  La taille était écrite au registre et annoncée comme appliquée, alors qu'elle
  n'était **jamais posée** sur la cellule : elle vit dans le device racine, et
  non dans la configuration de l'instance. Trouvé sur la Forge de validation.
- **Le disque et le mode CPU n'annoncent plus de redémarrage** (SPK-57) : la
  prise à chaud a été mesurée sur matériel réel, les deux prennent effet
  immédiatement. L'écran promettait moins que ce que le produit tient.
- **La réservation CPU tient de nouveau ses promesses** (SPK-29). Le poids de la
  tranche parente était écrit dans le fichier cgroup, et **systemd l'écrasait**
  à la première reconciliation : la réservation retombait à presque rien, sans
  qu'aucun contrôle ne le signale. Le poids se pose désormais par systemd, qui
  le réaffirme. Mesuré sur matériel réel, avant et après reconciliation.
- **Un Spark dont le disque est plein peut de nouveau être agrandi** (SPK-30).
  Le produit écrivait la configuration de la cellule avant sa taille de disque ;
  or, disque plein, écrire la configuration échoue. L'agrandissement — le seul
  geste qui débloque la situation — était donc refusé précisément quand il
  devenait urgent. Mesuré et corrigé sur matériel réel.
- **Redimensionner un Spark met à jour l'allocation** (SPK-57) : changer le mode
  CPU ne rendait pas ses cœurs dédiés au pool commun et ne recalculait pas le
  poids de la tranche. Un simple redimensionnement pouvait donc rompre la
  réservation de tous les Sparks.
- **Redimensionner un Spark existant** (SPK-57, `docs/DAT.md` §49) :
  `PATCH /v1/sparks/{name}` ajuste mémoire, CPU, réseau et disque **sans
  détruire la cellule**. Trois refus distincts : Spark protégé (`423`), pas de
  place sur la Forge (`409 admission_refused`), et « ce que vous voulez retirer
  est utilisé dans la cellule » (`409 shrink_refused`). Les nouvelles limites
  sont **posées sur la cellule** après le registre, et la réponse dit laquelle
  des trois situations on est : quota en vigueur, quota **promis** mais que le
  noyau a refusé, ou rien à poser faute de cellule. La section *Ressources* d'un
  Spark porte désormais sa commande **Modifier les quotas**, et le champ du
  disque annonce qu'il **exige un redémarrage** avant qu'on agisse. La modale
  s'ouvre **pré-remplie** des valeurs du Spark, et un refus y reste affiché sans
  effacer la saisie. Le manuel M8 porte le geste et ses deux familles de refus.
  Le **mode CPU** se change aussi : les champs qui suivent dépendent de lui, et
  les réglages de l'ancien mode ne survivent pas. Réduire le **disque** sous ce
  que la cellule contient est désormais refusé pour de bon : l'occupation est
  relevée sur la cellule — instantanés compris — même lorsque le Spark est
  arrêté. La mémoire, elle, n'est comptée que sur un Spark en marche.
- **L'admission sait compter un redimensionnement** (SPK-57, `docs/DAT.md` §49.1) :
  `pools(..., sauf=<id>)` et `admit(..., sauf=<id>)` rendent au pool le Spark
  visé avant d'évaluer sa nouvelle demande. Un agrandissement tenable n'est plus
  refusé, et **rétrécir ne peut jamais manquer de place**. Le refus porte les
  chiffres saisis, jamais un delta. *La route de redimensionnement elle-même
  n'est pas encore livrée.*
- **Deux contrôles de durcissement au préflight** (SPK-55, `docs/DAT.md` §48) :
  `NET-REMONTEE` échoue si un Spark peut atteindre le `sshd` de sa Forge — mesuré
  ouvert sur la Forge réelle —, et `SSH-X11` signale un `X11Forwarding` inutile.
  Le remède ouvre le DNS **avant** de fermer le reste : un Spark garde son
  résolveur et sa sortie internet. Nouvel état de verdict `avertissement`, **non
  bloquant**, compté à part. Marche à suivre : `docs/PROD_MIGRATIONS.md` OP-11 et
  OP-12.
- **Alerte hors bande sur les gestes sensibles** (SPK-62, `docs/DAT.md` §47) :
  neuf actions — suppression d'un Spark, levée de protection, restauration ou
  suppression d'un instantané, don ou retrait d'un accès, retrait d'un port ou
  d'un nom public, ouverture d'un shell root de dépannage — envoient un message
  JSON à l'URL de `SPARKD_NOTIFY_URL`. **Un canal injoignable n'empêche jamais un
  geste** ; l'échec se lit sur l'écran de la Forge. Sans URL, la fonction est
  désactivée et l'écran dit que rien n'est surveillé. Le `payload` n'est jamais
  envoyé.
- **La clé d'accès du responsable peut être restreinte** (SPK-61, `docs/DAT.md`
  §46) : elle garde le tunnel, le rebond vers un Spark et le dépannage, et perd
  le shell interactif, la lecture des fichiers de la Forge et l'accès à ses
  autres services. `scripts/garde-ssh.sh` est la garde posée en `command=` ;
  `scripts/cle-restreinte.sh` **produit** la ligne `authorized_keys` au lieu de
  la faire recopier. Marche à suivre : `docs/PROD_MIGRATIONS.md` OP-10.
  **Mesuré** : `restrict` seul ne ferme pas l'exécution de commande — une clé
  restreinte sans `command=` lit encore tout le registre.
- **Le journal dit, ligne à ligne, ce que la Forge a vérifié de la signature**
  (SPK-40, `docs/DAT.md` §36.10.9) : « signée » sur les gestes dont la Forge a
  vérifié la signature à la réception, « non signée » sur ceux arrivés sans elle
  — un état normal, pas un défaut —, « sans objet » sur les lignes du runtime,
  que personne n'a demandées. La mention générale « Aucune entrée n'est signée »
  a disparu : elle était vraie avant SPK-40 et fausse après.
- **Un geste que la console n'a pas pu signer le DIT à l'écran**, dans la barre
  latérale, sous le contexte du serveur. L'avertissement dit que le geste a bien
  eu lieu, nomme ce qui manque, dit quoi faire — « ssh-add » —, et **s'efface de
  lui-même** dès qu'un geste repart signé. En accent, jamais en rouge : la Forge
  a accepté le geste.
- **La clé de signature se déclare depuis l'écran *Serveurs***, champ *Clé de
  signature*, pour tous les genres de serveur. Elle nomme une clé **publique** ;
  laissée vide, les gestes partent non signés.
- Le contrat de déploiement porte **OP-09**, l'opération de la migration `009`
  du journal, avec son retour arrière et le réglage de `SPARKD_ALLOWED_SIGNERS`.
- **La console signe les gestes qu'elle relaie** (SPK-40 deuxième tranche,
  `docs/DAT.md` §36.10.8), par l'agent SSH du responsable — la clé privée n'est
  jamais lue. Le champ `signingKey` de l'inventaire désigne la clé **publique**.
  Ne pas pouvoir signer **ne retient jamais le geste** : il part, non signé.
- **Le journal conserve la signature d'un geste** (SPK-40 première tranche,
  `docs/DAT.md` §36.10) : `sparkd` accepte une signature SSHSIG, la vérifie et
  l'inscrit. Une requête **non signée passe** — ce n'est pas un contrôle
  d'accès —, une signature invalide est refusée. `SPARKD_ALLOWED_SIGNERS` désigne
  les clés **publiques** autorisées ; absent, la vérification se désactive.
- La vérification du journal **se rejoue hors ligne**, sur une sauvegarde : c'est
  là qu'elle attrape l'adversaire qui a root.
- **Sauvegarder et restaurer le registre** (SPK-36, `python3 -m sparkd.sauvegarde`)
  : sans arrêter le service, avec vérification de ce qui vient d'être écrit —
  structure SQLite et chaîne du journal. La restauration refuse si `sparkd`
  tourne, refuse un fichier qui ne se vérifie pas, et déplace le registre
  remplacé au lieu de l'écraser.
- **`docs/CONTINGENCE.md`** : les plans d'urgence. La première fiche est écrite,
  les neuf autres scénarios sont listés avec ce qui manque à chacun.
- **Supprimer un Spark exige de frapper son nom** (SPK-63,
  `docs/DESIGN_SYSTEM.md` §6.23) : le bouton reste visible et désactivé tant que
  le nom exact n'est pas saisi, et l'écran dit pourquoi. La comparaison ne
  pardonne ni la casse ni un espace en trop. Aucun autre geste ne le demande.
- **Le modèle de menace des actions sensibles est écrit** (SPK-35,
  `docs/DAT.md` §45) : cinq menaces hiérarchisées, ce que le produit ne prétend
  pas traiter, et chaque piste retenue ou écartée avec son motif. Trois unités
  en sortent : SPK-61, SPK-62, SPK-63.
- **Le pool de stockage se crée par un geste paramétré** (SPK-28,
  `scripts/creer-pool.sh`) : nom, pilote, source et taille viennent tous de
  l'environnement. Il refuse de recréer un pool en place, refuse un miroir à un
  seul périphérique, et refuse d'écrire sur un périphérique non vide — en
  montrant ce qu'il y a trouvé.
- **Le README porte le schéma de partitionnement** à fournir à la création d'un
  serveur, pour obtenir d'emblée une paire de partitions libres.
- `SPARKD_STORAGE_DATASET` : le jeu de données dont la compression est vérifiée,
  qui suit le pool par défaut.
- **Les écrans renvoient au manuel au lieu de recopier son raisonnement**
  (SPK-56, `docs/DESIGN_SYSTEM.md` §1.5 bis) : les sections *Ressources*,
  *Protection*, *Amorçage*, *Clés* et le catalogue d'images gardent leurs valeurs,
  leurs qualificatifs et un renvoi ; l'explication vit désormais au seul endroit
  où elle peut rester juste.
- Manuel M5 : nouveau passage *Ce catalogue n'est pas un registre d'images*.
- Sur écran étroit, le manuel ouvre le **chapitre demandé** et non son sommaire.
- **Entrer dans un conteneur** (SPK-45 deuxième tranche, `docs/DAT.md` §37.4.7) :
  un conteneur qui tourne porte un bouton *Ouvrir un terminal*, et la session
  s'ouvre dans un shell **du conteneur**. La bannière le nomme, avec son shell —
  deux conteneurs d'une même pile se ressemblent.
- La console **cherche le shell avant d'ouvrir** : `bash` s'il est là, sinon
  `sh`. Une image sans shell, un conteneur arrêté ou disparu sont **nommés** et
  n'ouvrent rien, au lieu d'une fenêtre noire dont il faut deviner pourquoi elle
  est vide.
- Chaque ouverture et chaque fermeture entrent au journal sous une action propre
  au conteneur, avec sa durée. Rien du contenu ne traverse.
- **Un Spark protégé laisse entrer dans ses conteneurs** — c'est l'issue de
  secours qui évite d'avoir à désarmer la protection pour diagnostiquer.
- Manuel M8 : chapitre *Entrer dans un conteneur*, illustré depuis la pile réelle.
- **Agir sur un conteneur** (SPK-45 première tranche, `docs/DAT.md` §37.7.1 à
  §37.7.4) : démarrer, redémarrer, arrêter, tuer. Les gestes vivent sur le
  conteneur **ouvert**, jamais sur la liste — agir depuis une ligne de tableau,
  c'est agir sans avoir regardé. Seuls les gestes qui ont un sens sont offerts :
  un conteneur arrêté ne propose que *Démarrer*, un conteneur disparu ne propose
  rien.
- Chaque geste se confirme en **nommant le conteneur et l'effet**, jamais par un
  « êtes-vous sûr ». *Tuer* est le seul destructif, et le seul en rouge.
- Chaque geste est **inscrit au journal** du Spark, sous une action qui lui est
  propre — « combien de conteneurs a-t-on tués ce mois-ci » se répond par un
  filtre. Un geste **refusé** y figure comme refusé. La lecture, elle, n'est
  toujours pas journalisée.
- Après le geste, l'écran **relit** le conteneur et affiche ce que la Forge rend,
  jamais l'état supposé atteint.
- **Un Spark protégé refuse les gestes et laisse la lecture** : les boutons
  restent visibles, désactivés, et l'écran dit comment lever la protection. Le
  terminal reste ouvert — le garde-fou vise le geste distrait, pas le geste
  urgent.
- `docs/DESIGN_SYSTEM_APP.md` SPK-DS-08 : un troisième bloc d'issue, vert. Sans
  lui, un succès s'écrivait dans la couleur qui sert à prévenir d'un danger.
- `docs/DESIGN_SYSTEM_APP.md` SPK-DS-09 : une confirmation sensible n'a pas la
  couleur d'une confirmation destructive.
- Manuel M8 : chapitre *Agir sur un conteneur*, illustré depuis la pile réelle.
- **Ouvrir un conteneur depuis l'onglet Docker** (SPK-44 deuxième tranche,
  `docs/DAT.md` §37.6 ter) : son état, son code de sortie, son image, ses réseaux,
  ses volumes et ses deux cents dernières lignes de journal. Ces lectures sont
  **demandées**, jamais collectées d'office — les relever pour dix conteneurs
  toutes les cinq secondes coûterait dix fois l'inventaire au quota du locataire,
  pour un texte que personne ne lit dix fois à la fois. Ouvrir un conteneur
  suspend le relevé de la liste ; refermer le reprend.
- Le code de sortie ne s'affiche que pour un conteneur **arrêté** : en rendre `0`
  pour un conteneur en marche ferait lire qu'il s'est terminé sans erreur.
- Les horodatages des journaux sont ceux du locataire, rendus **tels quels** : les
  retraduire dans le fuseau du poste décalerait l'écran de ce qu'il lit chez lui.
- L'écran avertit que les journaux n'ont été **ni relus ni caviardés** et peuvent
  contenir un secret que le locataire y a écrit.
- Un conteneur supprimé pendant qu'on le regarde est dit **disparu**, en
  avertissement et non en refus : c'est une course normale, pas une panne.
- Manuel M8 : chapitre *Ouvrir un conteneur*, illustré depuis la pile réelle.
- `docs/AGENT_RUNBOOK.md` §C.4 : une sortie vide de `docker` a trois causes, que
  seul le **code de sortie** sépare — `127` s'amorce, `1` se redémarre, `0` ne
  demande rien. Les confondre envoie réinstaller ce qui est déjà là.
- `docs/AGENT_RUNBOOK.md` §F.4 : « vert seul, rouge en campagne » a **deux** causes
  qui se ressemblent — la contention, et un état partagé entre parcours. La
  question qui les sépare : le rouge est-il le même à chaque fois ?
- `docs/AGENT_RUNBOOK.md` §F : éprouver sans faire tomber la machine — la
  vérification ciblée qui monte **une** pile au lieu de cinquante, quand la
  campagne complète reste due, et la règle d'une seule pile de développement à la
  fois. Avec le chiffre qui la rend non négociable : la VM dispose de 7,5 Gio.
- `docs/DAT.md` : nouveau §44, le briefing d'un Spark — ce qu'un agent doit savoir
  en entrant, et pourquoi c'est un fichier et non un message d'accueil.
- Unité SPK-60.
- `docs/DAT.md` §43.5 : la clé de chiffrement vit sur la Forge — arbitrage rendu.
  §43.5.1 dit qui déchiffre et où la valeur redevient lisible ; §43.5.2 sépare les
  secrets des variables, en tmpfs, pour qu'aucun instantané ne les capture.
- **Amorcer un Spark depuis la console** (SPK-54, `docs/DAT.md` §41, §42) : la
  fiche d'un Spark porte une section *Amorçage* qui relève ce qui manque —
  serveur SSH, clés, dépôt Docker amont, moteur, greffon Compose — et n'installe
  que cela. Le relevé se demande, il ne part pas tout seul : il exécute une
  commande dans la cellule du locataire.
- Un `docker.io` de distribution est signalé **« à corriger »** et non
  « présent » : il s'installe, il démarre, et les conteneurs meurent
  (`socketpair() failed`). L'amorçage le purge et pose `docker-ce`.
- Un second amorçage ne fait **rien** et le dit. Un Spark protégé le refuse.
- `exec_capture` au pilote Incus : exécuter et LIRE le code de sortie et les deux
  flux, là où `exec_command` ne rendait rien.
- `docs/manuel/M6-acces.md` : le chapitre de l'amorçage et son illustration.

- `docs/DAT.md` §43.0 : les six mesures qui tranchent l'injection d'environnement
  — un conteneur n'hérite pas de l'environnement ambiant, `env_file:` est la seule
  voie qui porte un jeu entier, et `/etc/profile.d` échoue pour ce que systemd
  démarre. §43.0 bis : comment font les autres produits.
- `docs/DESIGN_SYSTEM.md` : nouveau **§6.9 bis**, curseur ou saisie numérique.
  Le curseur est préféré pour une valeur numérique, sans devenir obligatoire : il
  cède dès que les bornes sont inconnues ou instables, que la plage dépasse ce
  qu'un pointeur peut viser, ou que le pas détruirait la granularité que la valeur
  signifie. Un numéro de port reste une saisie, et c'est le contre-exemple qui
  fixe la règle.
- `docs/DESIGN_SYSTEM_APP.md` : **SPK-DS-07**, son application à la console — les
  quotas au curseur, borné sur la **capacité totale** de la Forge et jamais sur ce
  qui reste libre, les ports à la saisie.
- Unité SPK-59 : les quotas de l'écran de création se règlent au curseur.
- `docs/DAT.md` : nouveau §43, l'environnement d'un Spark — où la valeur atterrit,
  pourquoi `environment.*` d'Incus n'est pas le mécanisme, et pourquoi un secret
  se déclare au lieu de se deviner.
- Unité SPK-58 : variables d'environnement et secrets, bloquée par un arbitrage
  sur l'emplacement de la clé de chiffrement.
- `apps/webui/modules.test.js` : tout module de la console doit se CHARGER. Une
  erreur de syntaxe passait la relecture et cassait au chargement, sans qu'aucune
  suite ne rougisse — puisque rien ne se charge, rien ne s'exécute.
- Unité SPK-57 : redimensionner un Spark existant. Le produit crée et supprime,
  il ne sait pas ajuster — relevé sur la Forge réelle, aucune route ne modifie
  les quotas.
- **L'écran du terminal dit pourquoi le chemin normal n'a pas abouti** (SPK-43,
  `docs/DAT.md` §37.2) : quand le shell distant se termine tout seul, la console
  mesure le serveur SSH du Spark et nomme ce qu'elle trouve — aucun serveur,
  serveur qui refuse la clé, ou serveur qui répond. Chaque cas dit le geste qui y
  répond. Une vérification impossible est dite comme telle, pas laissée en blanc.

- **Terminal de dépannage** (SPK-43, `docs/DAT.md` §37.3) : quand un Spark est en
  erreur ou que rien ne répond sur son port 22, la console demande à la Forge
  d'exécuter un shell root dans la cellule. Confirmation qui nomme le pouvoir
  employé, action d'audit distincte `spark.rescue_exec`, bannière visible toute
  la session. Le serveur décide, pas l'écran.
- Distinction entre « le `sshd` ne répond pas » et « le `sshd` refuse la clé » :
  le second renvoie à l'onglet *Clés*, il n'ouvre pas le dépannage.
- `apps/webui/src/styles/classes.test.js` : le contrôle que le §12.3 du design
  system exige — toute classe littérale d'un composant existe dans le CSS.
- `docs/manuel/M8-exploiter.md` : le chapitre du dépannage, avec son illustration.
- `docs/INCONSISTENCY_REPORT.md` : INC-06 (quatre classes CSS manquantes) et
  INC-07 (les onglets d'un Spark débordent la page sous 390 px).

- Le **manuel est joignable depuis la console** : servi depuis `docs/manuel/`,
  sa source unique, et rendu dans une destination de premier degré. Les renvois
  des écrans y mènent réellement.
- `docs/DESIGN_SYSTEM.md` §1.5 bis : l'écran nomme, le manuel explique. Le test
  écrit : si la phrase reste vraie quand toutes les valeurs de l'écran changent,
  elle appartient au manuel.
- Unité SPK-56.
- Parcours E2E de l'**ancre du journal** (SPK-38), le dernier point de sa DoD :
  depuis l'accueil et au clavier, la console pose sa référence, on coupe la fin
  du journal en base, et le relevé suivant rend « le journal a raccourci » alors
  que la chaîne s'affiche **intacte**. Un relevé de plus alerte encore.
- `docs/DESIGN_SYSTEM_APP.md` : règle **SPK-DS-06**, deux témoins de l'intégrité
  jamais résumés en un — et une alerte d'ancre annoncée comme une rupture.
- Captures `44-journal-ancre-alerte.png`, `45-journal-ancre-mobile.png` et
  illustration `docs/manuel/images/m12-ancre-alerte.png`, produites depuis
  l'application exécutée.
- `docs/manuel/M12-annexes.md` : ce qu'il faut faire quand l'ancre alerte, et
  pourquoi relancer le relevé ne l'efface pas.
- `docs/AGENT_RUNBOOK.md` : les procédures exécutables par un agent — déployer
  `sparkd` sur une Forge, créer un Spark, s'y connecter, y déployer une pile,
  l'exposer par DNS puis ingress. Écrites depuis une exécution réelle, pas de
  mémoire.
- `docs/DAT.md` : nouveau §41, ce que l'image d'un Spark ne donne pas — ni `sshd`,
  et un Docker de distribution inutilisable sous imbrication ; nouveau §42, le
  geste « Amorcer ce Spark », en détection.
- Unités SPK-54 (amorçage d'un Spark) et SPK-55 (durcissement de la Forge, sur
  l'audit du 2026-08-20).
- `sparkd` porte l'empreinte de la build installée : `build.json` écrit à
  l'installation, publié par `/healthz` et `/v1/forge`, sous la forme
  `0.0.0+<commit>` — et `0.0.0+inconnue` quand la build n'est pas estampillée.
- `docs/DAT.md` : nouveau §40, la build installée se nomme, et les cinq situations
  que la console doit distinguer plutôt que de conclure.
- Unité SPK-53.

- Socle documentaire du projet : `docs/DAT.md`, `docs/SCHEMA.md`,
  `docs/BACKLOG.md`, `docs/JOURNAL.md`, `docs/MANUAL_PLAN.md`,
  `docs/PROD_MIGRATIONS.md`.
- `docs/ORIGIN_CONVERSATION.md` : transcription intégrale de la conversation
  fondatrice, extraite de la charge utile de la page de partage.
- `README.md` décrivant réellement le projet.
- Relevé de topologie de l'hôte cible : Dell R320, 4 cœurs / 8 threads, frèrage SMT
  `(0,4) (1,5) (2,6) (3,7)`, 94 Gio, 2 × 6 To mécaniques en RAID1, lien 1 Gbit/s.
- `CLAUDE.md` : règle « la documentation suit la réalité » — toute mention devenue
  fausse est retirée dans le même changement, et non annotée ; ajoutée aussi à la
  Definition of Done.
- Unité SPK-28 : décision et exécution du repartitionnement du stockage.
- Unité SPK-32 : catalogue d'images vérifié, et choix par liste à la création
  plutôt que par champ libre.
- Unité SPK-33 : refonte de la navigation de la console selon les degrés du
  design system.
- Unité SPK-34 : Sparks protégés — un interrupteur par Spark, armé et levé par mot
  de passe, dont le **runtime** fait respecter le refus, API comprise. La
  révocation d'une clé SSH échappe au refus : elle nomme les Sparks protégés
  touchés et se confirme, elle ne se bloque pas.
- `docs/DAT.md` : nouveau §35, les Sparks protégés — portée du refus, mot de
  passe et son empreinte, ce que la protection n'est pas.
- `docs/DAT.md` : nouveau §37, les outils d'administration dans le Spark —
  terminal, onglet Docker, gestes sur un conteneur, et pourquoi la frontière du
  §11 tient : c'est la console qui parle au Spark, pas `sparkd`.
- Unités SPK-43 (terminal dans un Spark), SPK-44 (onglet Docker en lecture) et
  SPK-45 (gestes sur un conteneur et terminal dans un conteneur).
- `docs/DESIGN_SYSTEM_APP.md` : SPK-DS-04, le terminal n'est ni une section ni une
  modale mais une destination ; SPK-DS-05, deux origines de mesure ne partagent
  pas une jauge.
- `docs/DAT.md` : nouveau §22.4 bis, ce que le catalogue des serveurs délègue à
  OpenSSH — alias `ssh` accepté, découverte proposée jamais imposée, vérification
  de la clé d'hôte jamais désactivée.
- Unités SPK-41 (catalogue des serveurs tenu depuis la console : ajout, retrait,
  sélecteur, reconnexion, épreuve avant enregistrement) et SPK-42 (nommer la
  machine qui porte `sparkd`, arbitrage en attente).
- `docs/DAT.md` : nouveau §36, intégrité du journal d'audit — ce qu'une chaîne de
  hachage prouve et contre qui, l'ancre tenue par la console, où la signature doit
  être produite, les pièges d'implémentation, et ce qui n'est pas retenu.
- Unités SPK-37 à SPK-40 : acteur réel et verrou d'écriture du journal ; chaîne
  d'intégrité et ancre côté console ; onglet de supervision sous Hôte ; signature
  des gestes par la clé du responsable, subordonnée à l'arbitrage de SPK-35.
- Lot 5 « Sécurité et continuité » et deux unités d'instruction : SPK-35, instruire
  la sécurisation des actions sensibles — modèle de menace d'abord, puis TOTP,
  signature par la clé SSH, WebAuthn, ré-authentification limitée, et la question
  de la récupération d'un facteur perdu ; SPK-36, instruire les plans de
  contingence et les gestes d'urgence, avec un exercice réel exigé avant clôture.
- `docs/DESIGN_SYSTEM.md` : nouveau §5.4, les trois degrés de navigation — barre
  latérale au premier, onglets au second, fenêtre et modale au troisième ; nouveau
  §6.27, fenêtre d'options et modale de section, avec son contrat d'interaction.
- `docs/DAT.md` : nouveau §33, le catalogue d'images ; nouveau §34,
  l'architecture de navigation de la console.

### Corrigé
- La fermeture d'une session de terminal inscrivait toujours `path: "ssh"` au
  journal, quel que soit le chemin réellement emprunté. C'était faux dès le
  dépannage.
- **Troncature silencieuse des relevés Docker** : la lecture se résolvait sur
  `exit`, qui précède le drainage de `stdout`. Sur deux cents lignes de journal,
  l'écran en affichait cent soixante-quatorze et les montages revenaient vides,
  sans rien signaler. Elle attend désormais `close`.
- L'écran d'un conteneur affichait le nom **cliqué** plutôt que celui rendu par la
  Forge, plaçait le retour à la liste sous deux cents lignes de journal, peignait
  en rouge un conteneur disparu sous un texte disant « pas une panne », et restait
  muet quand seuls les journaux le trouvaient disparu.
- Une session dont le distant mourait **avant** l'ouverture du flux laissait
  l'écran sur « session ouverte » indéfiniment. C'est la course exacte d'un
  `sshd` muet, où `ssh` sort en quelques millisecondes.

### Modifié
- La barre de facettes défile dans son conteneur **et signale son débordement**.
  INC-07 et INC-16 — le même défaut consigné deux fois à un jour d'écart — sont
  retirés du rapport d'incohérences.
- `README.md` : la section « Statut » annonçait encore un **plan de contrôle non
  commencé** et SPK-29 comme dette ouverte, alors qu'il tourne sur une Forge
  réelle et que la réservation est arbitrée. Réécrite avec ce que la mesure
  établit, et avec ce qui manque encore. Deux limites connues devenues fausses
  sont retirées : l'émission TLS, prouvée le 2026-08-20, et le champ « image »
  libre, remplacé par le catalogue de SPK-32.
- `make runProd` écoute sur **5175**, et non plus sur le port de `runDev` : les
  deux consoles servent deux mondes différents — un `sparkd` factice d'un côté,
  de vraies Forges de l'autre — et devaient pouvoir tourner ensemble. Un port
  partagé obligeait à en arrêter une pour voir l'autre.
- `docs/CloudWorker.md` §2.1 ter : `pkill -f vite` remplacé par un geste qui ne
  vise **que ce qui tient le port 4173**. Mesuré : `-f` fait correspondre la ligne
  de commande entière, donc la commande tuait tout processus mentionnant ce mot —
  y compris le shell d'une session voisine qui ne servait rien.
- **La pile de développement n'efface plus les serveurs saisis.** `scripts/dev.sh`
  réécrivait l'inventaire en entier à chaque démarrage : les deux serveurs de la
  pile revenaient, et tout ce qui avait été ajouté depuis la console disparaissait.
  Ils sont désormais **fusionnés** — le port du serveur local suit `SPARKD_BIND`,
  le reste est conservé, ancres comprises.
- `docs/DAT.md` §43.6 révisé : l'héritage automatique déposait un secret **en
  clair** dans toutes les cellules, y compris celles qui n'en ont aucun usage.
  La doctrine du général vers le particulier vaut pour ce qu'on **lit**, pas pour
  ce qu'on **distribue dans des cellules isolées**.
- **La réservation CPU est un plancher, et le produit le dit enfin.** Arbitrage du
  responsable : `H = 300` reste posé, donc `r/C` est garanti sous contention
  totale et dépassé sinon. Le runtime publie `floor_under_contention` et l'écran
  annonce « garantie sous contention totale, dépassée sinon » — plus vrai que le
  « non garantie » précédent, qui était exact mais trop modeste.
- `docs/DAT.md` §47.3 réécrit : **deux canaux de notification** réglés depuis un
  onglet de la Forge — webhook avec gabarit, SMTP avec destination —, activables
  séparément, et toute modification protégée par un mot de passe fixé au premier
  usage. La configuration quitte les variables d'environnement pour le registre.
- **Le pool sur fichier n'est plus « provisoire »** : le DAT §8.5 énonce **deux
  dispositions**, chacune avec ce qu'elle apporte et ce qu'elle ne protège pas.
  Sous la disposition sur fichier, la protection contre la corruption silencieuse
  est absente, pas dégradée. OP-01 est close.
- La vérification du stockage lit le nom du pool et du jeu de données dans la
  configuration : sur une Forge configurée autrement, elle annonçait un pool
  absent qui existait.
- **SPK-49 close** : une connexion entrante atteint réellement un Spark. Port
  publié, frappé depuis Internet en `200`, refus nommés, et retrait qui referme
  le port — mesuré sur la Forge réelle.
- `docs/AGENT_RUNBOOK.md` §F : motif corrigé. Une campagne monte **une** pile, pas
  cinquante ; ce qui tue la machine est le nombre de campagnes simultanées, pas
  leur contenu. Arbitrage du responsable ajouté : ciblé en multi-session, complet
  en session seule.
- **Les quotas de l'écran de création se règlent au curseur** (SPK-59,
  `docs/DESIGN_SYSTEM.md` §6.9 bis) : réservation CPU, plafond CPU, cœurs,
  mémoire, disque et débit. Chaque curseur porte sa valeur formatée, ses deux
  bornes, et `aria-valuetext` — sans quoi la synthèse annoncerait « 16 » là où
  l'écran montre « 16 Gio ». Sa borne haute est la **capacité totale** de la
  Forge et jamais le disponible : demander plus que ce qui reste libre doit
  rester possible, c'est le serveur qui tranche. Sans capacité relevée, ou quand
  la plage ne se parcourt pas sans perdre la granularité métier — le pool disque
  de la Forge de validation dépasse 5 000 Gio —, le champ redevient une saisie
  numérique.
- **La mémoire se règle par pas de 256 Mio**, non de 1 Gio (SPK-59,
  `docs/DESIGN_SYSTEM_APP.md` SPK-DS-07). Le gibioctet rendait inatteignables les
  512 Mio que le seed emploie, et n'offrait que cinq crans sur le pool de la pile
  de validation. Le quota mémoire s'affiche en conséquence avec un format
  **exact** — « 512 Mio », « 1,25 Gio » — et non avec l'arrondi réservé aux
  mesures : un curseur qui affiche « 10 Gio » pour 10,25 ment sur ce qu'il envoie.
- `docs/DESIGN_SYSTEM.md` §6.9 bis : la valeur affichée par un curseur doit être
  **exacte sur sa grille**. Si aucun format ne sait rendre le pas, c'est le pas
  qui est mauvais.
- L'avertissement de capacité de l'écran de création se rafraîchit désormais
  **pendant** le réglage. Il ne bougeait jamais : seul un changement de mode CPU
  provoquait un repeint, si bien qu'on pouvait demander 64 Gio devant un panneau
  en annonçant 64 de libres sans qu'un mot bouge. Le formulaire n'est pas
  repeint pour autant, ce qui arracherait la poignée en cours de glissement.
- Le script de test de la console n'exécutait ni `modules.test.js` ni
  `src/styles/classes.test.js` : deux garde-fous écrits et jamais joués.
- Recettes DNS : le champ ne demande plus que le libellé, la zone s'affiche en
  suffixe, vide vaut le domaine lui-même, et l'adresse publique de la Forge est
  pré-remplie depuis le serveur courant.
- Écran de la Forge et écran du journal : les paragraphes explicatifs sont
  retirés. Restent la valeur, son unité, le réglage qui la commande — et la
  mesure vive de l'ARC, relevée à chaque requête. Le manuel M4 et M12 portaient
  déjà ces explications : l'écran les dupliquait.
- Une alerte d'ancre — journal raccourci ou remplacé — est désormais rendue dans
  la même enveloppe `role="alert"` qu'une rupture de chaîne. Elle était portée par
  la seule couleur du badge, donc muette pour une synthèse vocale.
- Le harnais de captures impose un chemin d'ancre jetable : il écrivait dans le
  `~/.config/spark` du poste, et le verdict de la capture dépendait de la machine
  qui la produisait.
- **SPK-12 close** : l'émission TLS est prouvée sur un domaine réel.
  `https://helo.spark.lelabs.tech/` rend `200` depuis l'extérieur, certificat
  Let's Encrypt valide et chaîne vérifiée, et un domaine non routé rend `404`.

- `README.md` : remplacement du contenu hérité d'`ollama.cpp`, sans rapport avec
  ce dépôt.
- `docs/CloudWorker.md` : retrait de toutes les références à un autre produit — nom
  du dépôt, chemin de seed, scripts de vérification et scripts npm spécifiques,
  nombre de services, version de Node. Le document redevient générique et renvoie
  aux commandes que le dépôt documente lui-même.
- `docs/DAT.md` : nouveau §8 « Hôte cible et stockage » ; le choix du pool de
  stockage est motivé par le quota, le clonage et le retour arrière de cellule, et
  non par la sauvegarde. Sections suivantes renumérotées.
- `docs/BACKLOG.md` : SPK-02 passe à `[~]`, SPK-03 dépend désormais de SPK-28,
  SPK-13 réduit aux instantanés locaux.
- `docs/JOURNAL.md`, `docs/PROD_MIGRATIONS.md` : mise en cohérence avec le relevé
  réel de l'hôte.

### Retiré

- Les trois incohérences relevées sont résolues — référence à un autre dépôt dans
  `docs/CloudWorker.md`, README hérité d'un autre produit, et injection des clés
  SSH tranchée en faveur de `cloud-init.user-data`. Le rapport d'incohérences
  devenu vide n'est pas conservé dans le dépôt.
- Mentions de blocage de l'accès au serveur cible : l'accès est obtenu.

### Ajouté — code

- Unité SPK-47 : **le DNS entre dans le périmètre du produit.** La console lit
  les zones du compte chez le fournisseur et pose l'enregistrement `A`/`AAAA`
  d'une route d'ingress, depuis un bouton porté par la route elle-même. Elle
  annonce ce qui est **écrit** et le délai de propagation, jamais un domaine
  « prêt ».

  Le jeton vit dans un `.env` du poste, ignoré par Git : jamais sur la Forge,
  jamais dans `servers.json`. Son absence désactive la fonction et l'écran le
  dit — ce n'est pas une panne. Le produit ne supprime aucun enregistrement,
  ne transfère aucune zone et n'achète aucun domaine ; il refuse d'écrire à
  l'apex, hors de la zone choisie, ou autre chose qu'une adresse.

  Le harnais E2E impose son propre fichier d'environnement et un doublon local
  du fournisseur, pour qu'aucun parcours automatique n'atteigne un compte réel.

- Unité SPK-42, **close** : le renommage de la machine en « Forge » est achevé.
  Les trois fichiers de la console renommés, et 211 occurrences au sens de la
  machine traduites dans la documentation, le code du runtime, les harnais et le
  README. Le sens réseau — nom d'hôte, clé d'hôte, « Hôte, utilisateur et port »
  — et l'« hôte console » ne bougent pas.

- Unité SPK-43, en cours : **un terminal dans un Spark, depuis la console.**
  C'est votre poste qui s'y connecte avec votre clé ; le serveur qui gère les
  Sparks n'est pas sur ce chemin. Quitter l'onglet termine la session, et une
  inactivité prolongée la ferme après un avertissement.

  Le journal retient l'ouverture et la fermeture avec leur durée, et **rien de ce
  qui est tapé** — le caviardage ne saurait pas nettoyer un flux interactif, et
  enregistrer les frappes créerait un dépôt de secrets en clair.

  Nouvelle route `POST /v1/audit`, étroite : liste blanche d'actions, acteur pris
  de l'en-tête, charge bornée.

- Unité SPK-46 : **la console traduit les états que le serveur rapporte.** Le
  journal affichait « starting » → « running » à quelques centimètres d'un badge
  qui disait « En marche ». Le journal reste technique — il sert au diagnostic —
  et c'est l'affichage qui traduit, dans la facette *Journal* d'un Spark comme
  dans l'onglet de supervision. Le message d'erreur de tunnel suit.

  Elle ne devine pas : un nom de serveur cité entre guillemets n'est pas un état
  et n'est pas déformé, et un message inconnu traverse mot pour mot.

- Unité SPK-52 : **supprimer un Spark dont la cellule a déjà disparu réussit.**
  Auparavant la ligne restait indéfiniment au registre, occupait de la place dans
  les pools, et le seul recours était d'ouvrir la base à la main.

  Trois bornes empêchent ce succès d'être un mensonge : le journal porte la
  mention « absente » et dit ce que la ligne coûtait ; un serveur qui ne répond
  pas reste une panne et la ligne reste ; un Spark protégé refuse d'abord.

- Unité SPK-50 : **les recettes DNS** — un jeu d'enregistrements posé ensemble,
  parce qu'un `MX` sans SPF fait recevoir du courrier qu'on ne peut pas renvoyer.
  La garde s'élargit à `MX`, `TXT`, `SRV` et `CNAME`, chacun avec la forme que
  sa donnée doit avoir.

  Deux recettes : *site web sur le domaine nu*, et *émission par le relais
  transactionnel*, composée d'après ce qui a été mesuré sur une zone réelle. La
  seconde réclame une clé DKIM que le produit n'invente jamais ; sans elle la
  recette est posée et annoncée incomplète.

  L'écran présente la recette entière avant d'écrire, puis rend le sort de chaque
  ligne — jamais un verdict global. Ce qui est passé n'est pas défait.

- Unité SPK-49 : **publier un port de la Forge vers un Spark**, pour ce qui ne
  parle pas HTTP — messagerie, base de données, Redis, SSH. Un port public est
  unique sur la machine : le refus nomme le Spark qui le détient, ou le service
  qui tient un port réservé. La fenêtre annonce d'abord ce qu'un port publié fait
  perdre — le certificat automatique — et vers quoi se rabattre.

  Migration `008_ports_publies`, opération OP-08 du contrat de déploiement.
  Nouvelle variable facultative `SPARKD_RESERVED_PORTS`.

- Unité SPK-48 : **une route peut porter une étoile** — `*.monapi.fr` sert tous
  les sous-domaines d'un niveau. Un nom exact déclaré sur un autre Spark prend
  le pas sur elle, ce qui est le geste de la montée en charge : sortir un
  sous-domaine du lot pour lui donner son propre Spark, sans toucher à l'étoile.

  Défaut corrigé : les routes étaient données au proxy dans l'ordre
  alphabétique, où l'étoile précède les lettres. L'étoile gagnait donc sur le nom
  exact, à l'inverse de la règle. Elles sont désormais ordonnées par spécificité.

  La surcharge se voit dans les deux sens — un bandeau au moment de la
  déclaration, et sous chaque route étoile la liste des noms qui lui sont
  soustraits avec le Spark qui les sert.

- SPK-47, révisé sur arbitrage : la console n'est plus bornée à un espace de
  noms — elle gère **toutes** les zones du compte. La borne existe encore comme
  option de poste, mais elle vit dans un fichier d'environnement réservé aux
  vérifications autonomes de l'agent, que la console ne lit jamais.

  Le refus d'écrire à l'**apex** est levé : un site sur le domaine nu est un cas
  ordinaire, et l'écriture visant un nom *et un type* exacts, les `NS`, le `MX` et
  les `TXT` de la zone ne sont pas concernés. En remplacement, l'écran **montre ce
  qui est déjà là** avant de l'écraser — posera, remplacera *telle valeur*, ou
  aucun changement.

- Règle de design system §6.9 : un champ en lecture seule se **voit** — fond
  distinct, curseur inerte, et un texte d'aide qui dit d'où vient la valeur.


- Espace de travail du monorepo : `apps/webui`, `services/sparkd`,
  `packages/contract`, `deploy`, `scripts`, avec un `Makefile` d'entrée.
- `services/sparkd` : configuration validée depuis l'environnement, garde
  refusant toute adresse d'écoute routable, sondes `/healthz` et `/readyz`
  distinctes. 19 tests unitaires.

- Registre SQLite : migration socle des douze tables, moteur de migrations avec
  checksum, retour arrière et refus d'une base dérivée. `sparkd` migre le
  registre avant d'ouvrir son port.

- Admission control : comptabilité des pools, invariant
  `Σ réservations ≤ capacité × surengagement`, refus motivé nommant toutes les
  ressources fautives. Pas encore joignable depuis un parcours réel.

- Inventaire de l'hôte : client de l'API Incus sur socket Unix, `POST
  /v1/host/sync` et `GET /v1/host`. Relevé tracé dans le journal d'audit.

- Traducteur du manifeste Spark vers la configuration Incus : quatre modes CPU,
  mémoire, réseau, stockage, nesting et idmap isolé. Refuse plutôt qu'approxime
  lorsqu'une valeur ne peut pas être rendue fidèlement.

- Cycle de vie complet d'un Spark : création avec admission control, application
  dans Incus, démarrage, arrêt, redémarrage, suppression, et réconciliation des
  états transitoires au démarrage de `sparkd`.

- Adressage du réseau privé : attribution déterministe par le registre,
  épinglage dans Incus, plage DHCP dynamique disjointe.

- Réserve de l'hôte : le plafond de l'ARC ZFS et une marge d'exploitation
  réglable sont soustraits du pool mémoire, qui passe de 98,0 à 76,2 Gio
  réellement allouables sur l'hôte de validation.

- Découpe dynamique du pool de cœurs : un Spark dédié retire des cœurs physiques
  entiers, et les Sparks partagés voient leur cpuset **et leur poids** recalculés
  à chaud, sans redémarrage.

- Clés SSH : enregistrement, octroi, révocation, et provisionnement automatique
  d'`openssh-server` au démarrage d'un Spark. Accès par rebond sur l'hôte.

- Ingress Caddy : déclaration de routes `domaine → spark → port`, réconciliation
  par régénération complète depuis le registre, refus des domaines non routés.

- Instantanés de cellule : prise, liste, restauration et suppression. Restaurer
  un instantané ancien est refusé tant que des plus récents existent.

- Métriques d'usage par Spark : CPU et réseau en taux avec leur fenêtre de
  mesure, mémoire et disque instantanés, chacun comparé à ce qui est réellement
  appliqué. Le burst est distingué du dépassement.

- Journal d'audit : point de passage unique, caviardage des valeurs sensibles,
  payload borné, et consultation par `GET /v1/audit`.

- Hôte console : inventaire des serveurs, ouverture et supervision de tunnels
  SSH, relais vers `sparkd`. Une panne de tunnel remonte avec son motif.

- Contrat d'API : OpenAPI committé et déterministe, types TypeScript dérivés,
  détection de dérive par `make contract-check`, et une CI qui rejoue la campagne.

- Écran liste des Sparks : tableau natif trié, badges d'état, jauge distinguant
  le burst du dépassement, et traitement explicite des états vide, chargement,
  erreur et données longues.
- `docs/DESIGN_SYSTEM_APP.md` : extension du design system pour la console.

- Écran détail d'un Spark : identité, ressources, accès, instantanés et journal,
  avec les seules commandes que le runtime déclare possibles et une confirmation
  de suppression intégrée au flux.
- `sparkd` publie `allowed_commands` et `transient` avec chaque Spark.

- Écran de création d'un Spark : capacité restante affichée, avertissement local
  distinct du refus serveur, saisie conservée en cas de refus.
- Trois panneaux d'administration agissants sur l'écran détail : déclarer et
  retirer une route publique, la réappliquer quand Caddy est en retard ;
  accorder, enregistrer et révoquer une clé SSH ; prendre, supprimer et restaurer
  un instantané. La restauration bloquée par des instantanés plus récents les
  nomme et n'offre l'acceptation de leur perte qu'après ce refus.
- Écran des ressources de l'hôte : les quatre pools avec capacité, alloué et
  disponible, la soustraction qui donne la mémoire allouable énoncée terme à
  terme, la carte des cœurs, le pool d'adresses et le relevé de topologie.
- Pile de développement autonome : `make runDev` démarre `sparkd` avec le pilote
  factice et l'hôte console ; `make seed` recrée le registre et le peuple en
  appelant les routes HTTP de `sparkd`, jamais du SQL direct.
- L'inventaire de la console accepte un serveur de genre `local`, joint
  directement sur la boucle locale, sans tunnel SSH.
- Le pilote factice persiste ses instances et accepte une injection de faute à
  usage unique, ce qui permet d'atteindre l'état `error` par le vrai chemin.
- Navigation à trois degrés : barre latérale (Sparks, Hôte), onglets de section,
  et fenêtre d'un Spark découpée en facettes — Aperçu, Routes, Clés, Instantanés,
  Journal. Chaque onglet a son adresse et survit au rechargement.
- La page ne défile plus horizontalement à 1024 et 768 px.
- Écran du catalogue d'images : onglet Images sous Hôte, avec la date du dernier
  relevé, les trois états et ce que le relevé a constaté. Ajout et relevé s'y
  font.
- Catalogue d'images vérifié : une référence inexistante est refusée **à la
  création** et non plus à l'application, et l'image se choisit dans une liste.
  Migration `003_catalogue_images` ; routes `GET/POST /v1/images` et
  `POST /v1/images/verify`.
- Les Sparks vivent désormais dans une tranche cgroup parente `spark.slice` dont
  le poids suit ce qui a été alloué, au lieu d'être arbitrés contre les tranches
  de l'hôte. Nouveau réglage `SPARKD_CPU_RESERVE` ; nouveau contrôle `RUN-SLICE`.
- La consommation instantanée de l'ARC ZFS est publiée par `GET /v1/host` et
  affichée face à son plafond sur l'écran de l'hôte.
- `python3 -m sparkd.preflight` : neuf contrôles d'état du serveur, en lecture
  seule, employés avant et après l'installation.
- `scripts/install-serveur.sh` et `deploy/sparkd.service` : `sparkd` devient un
  service systemd activé au démarrage.
- `GET /readyz` **sonde** désormais ses dépendances et nomme la cause d'une panne,
  au lieu de rendre une réponse figée.
- Chapitre M2 du manuel : installer le serveur.
- Manuel utilisateur sous `docs/manuel/` : dix chapitres écrits à partir du
  comportement observé sur la pile réelle. Les illustrations sont produites par
  `make manuel` et le lien manuel-image est vérifié dans les deux sens.
- Parcours E2E contre la pile réelle (`make e2e`, dans `make test`) : le harnais
  monte sa propre pile seedée, se déplace à la souris et au clavier, et couvre
  les quatre refus du produit.
- La console **ouvre** le tunnel du serveur courant à son démarrage. Elle se
  contentait de lire son état, laissant une console fraîche inutilisable.
- Vocabulaire du tunnel unifié : le badge et le bandeau rendaient le même état
  avec deux mots différents.
- `make gestes` : parcours navigateur assertifs, intégrés à `make test`.
- `make captures` échoue si l'application écrit dans la console du navigateur.
- **La machine qui porte `sparkd` est une « Forge »** (SPK-42) : table `forge`,
  routes `/v1/forge`, destination `#/forge` et libellés de la console. Le mot au
  sens réseau — `hostname`, l'hôte d'un serveur SSH — ne change pas, et « hôte
  console » non plus. Migration `007_forge`, sans alias sur l'ancien chemin.
- **Écran du catalogue des serveurs** (SPK-41) : destination « Serveurs » au
  premier degré — ajouter, **modifier**, basculer, retirer depuis la console, avec
  l'épreuve affichée dans la modale et les `Host` du `ssh_config` proposés. Une
  console sans serveur y mène désormais, au lieu d'afficher une erreur globale.
  En modification, le nom est verrouillé : le changer créerait un doublon.
- **Catalogue des serveurs** (SPK-41, socle) : genre `alias` qui délègue la
  connexion à OpenSSH, version du fichier, serveur courant persisté avec son
  sélecteur, retrait qui ferme le tunnel, proposition des `Host` du `ssh_config`,
  épreuve `/healthz` puis `/readyz` à travers un tunnel temporaire, et commande
  de reconnexion sur un tunnel rompu.
- **Onglet de supervision du journal** (SPK-39) : `Hôte → Journal`, qui couvre
  tous les Sparks. Cinq filtres, dont l'action par préfixe ; un filtre inconnu est
  refusé plutôt qu'ignoré. L'écran rend l'état de la chaîne **et** la comparaison
  avec ce que la console avait vu, jamais résumés en un seul indicateur, et dit
  qu'aucune entrée n'est signée. La vérification est un relevé explicite.
- **Chaîne d'intégrité du journal et ancre** (SPK-38) : chaque entrée porte
  l'empreinte de la précédente, sur une sérialisation canonique figée.
  `GET /v1/audit/verify` désigne la première rupture et distingue une ligne
  récrite d'une ligne retirée. La console retient la dernière tête vue par
  serveur et signale les deux attaques que la chaîne seule ne voit pas : journal
  raccourci, journal remplacé. Le journal ne se purge pas. Migration
  `006_journal_chaine`.
- **Un acteur réel dans le journal** (SPK-37) : la constante « responsable »
  disparaît du dépôt. L'hôte console déclare qui agit — serveur, et empreinte de
  la clé SSH quand elle est connue —, `sparkd` porte cette déclaration, et chaque
  entrée dit sa classe : geste humain ou événement du runtime. L'écran l'affiche
  et dit « déclaré », jamais « signé » : l'identité attribue, elle ne prouve pas.
  `UPDATE` et `DELETE` sur `audit_log` sont refusés **par la base**. Migration
  `005_journal_acteur`.
- **Sparks protégés** (SPK-34) : un interrupteur par Spark, armé et levé par mot
  de passe, dont le **runtime** fait respecter le refus — `423 spark_protected`
  sur les commandes, les routes, l'octroi d'une clé et les instantanés. Empreinte
  `scrypt` à sel par Spark, jamais le mot de passe en clair, jamais journalisé.
  L'état est visible partout où le Spark est listé. **Révoquer une clé n'est
  jamais refusé** : la confirmation nomme les Sparks protégés touchés, et aucune
  protection n'est levée. Migration `004_protection_spark`.
- **Marge de métadonnées au-dessus de la taille vendue** (`SPARKD_STORAGE_METADATA_MARGIN`,
  64 MiB par défaut) : le quota posé sur un Spark n'est plus exactement ce qui lui
  a été vendu. Sans elle, un Spark qui remplit son disque empêchait Incus d'écrire
  ses métadonnées et devenait irréconfigurable — pas même agrandissable pour le
  débloquer. La marge est comptée au pool, à l'admission comme dans l'alloué, et
  reste invisible du locataire. `GET /v1/host` publie la marge unitaire et son
  coût total ; la carte du disque énonce l'écart et nomme la vanne.
- Navigation à trois degrés : barre latérale, onglets de second degré, et fenêtre
  d'un Spark répartie en facettes — Infos, Routes, Clés, Instantanés, Journal.
  Chaque onglet est un lien avec sa propre adresse, jamais un `tablist`.
- Composant de **modale limitée à une section** : focus entrant dans le premier
  champ, focus retenu, `Échap` qui vaut annulation, focus rendu au déclencheur,
  arrière-plan inerte, une seule à la fois, plein écran sous 768 px. Les quatre
  saisies de la console y passent — route, clé, instantané, image du catalogue.
- Captures du catalogue d'images et de sa saisie, atteintes par la navigation, à
  1440 et 390 px. Illustration du catalogue dans le manuel, et chapitre M3
  complété de ce qu'une saisie garantit au clavier.

### Modifié

- `.gitignore` : remplacement du gabarit C++ hérité, qui ignorait `Makefile`.
- `docs/SCHEMA.md` §7 : l'injection des clés ne passe plus par cloud-init.
- `docs/DAT.md` §5.2 : la mémoire totale vient de `/proc/meminfo`, non d'Incus.
- `docs/SCHEMA.md` : nouveau §12, mécanique des migrations.
- `docs/DAT.md` : nouveau §7.7, ce que l'admission control compte et contre quoi ;
  nouveaux §5.1 à §5.3, accès à Incus et relevé de l'inventaire ; nouveau
  §7.2 ter, rendu exact des valeurs CPU ; nouveau §14, cycle de vie d'un Spark ;
  nouveau §15, adressage du réseau privé ; nouveau §16, la réserve de l'hôte ;
  nouveaux §7.4 bis et §7.4 ter, redistribution lors d'une découpe ; nouveau
  §17, accès SSH aux Sparks ; nouveau §18, réconciliation de l'ingress ; nouveau §19, instantanés et
  restauration ; nouveau §20, métriques d'usage ;
  nouveau §21, journal d'audit ; nouveau §22, l'hôte local de la console ;
  nouveau §23, le contrat d'API partagé ; nouveau §24, l'écran détail ;
  nouveau §25, l'écran de création ; nouveau §26, les trois surfaces
  d'administration d'un Spark ; nouveau §27, l'écran des pools ; nouveau §28, la
  pile de développement et le contrat du seed ; nouveau §29, les parcours E2E ;
  nouveau §30, le manuel et sa fraîcheur ; nouveau §31, l'installation du
  serveur et sa vérification ; nouveau §32, rendre la réservation CPU absolue ;
  nouveau §22.6, qui ouvre le tunnel de la console et quand.
- `docs/SCHEMA.md` : nouveau §11 bis, les deux termes de la réserve mémoire.
- Migration `002_part_arc` : `host` porte désormais `memory_arc_bytes` et
  `memory_margin_bytes`, jusqu'ici confondus dans `memory_reserve_bytes`.
  Opération OP-03 du contrat de déploiement.
- `docs/SCHEMA.md` §12.1 : les migrations vivent dans le paquet.
- `docs/DESIGN_SYSTEM.md` §5 : la barre latérale devient la forme par défaut du
  premier degré ; un autre patron reste possible mais devient un écart documenté.
  §9.1 gagne le contrat clavier des onglets et des modales.
- `docs/DESIGN_SYSTEM.md` §5.4 : la hiérarchie est énoncée comme une **orientation**
  et non comme une loi — une fenêtre ouverte depuis une liste peut porter ses
  propres onglets. Ce qui ne se négocie pas est nommé à part : afficher et saisir
  ne partagent pas la même surface, une surface a un seul sujet, une action
  sensible se confirme. §6.27 : une fenêtre porte **plusieurs** sections, et la
  modale sert aussi bien à insérer qu'à modifier, toujours limitée à sa section.
  §6.23 devient « actions sensibles et actions destructives », traite le cas d'un
  objet protégé, et pose la règle absolue : une protection ne bloque jamais un
  geste qui **réduit** un risque — révoquer un accès, retirer une clé, couper une
  publication. Elle nomme alors les objets protégés touchés et demande
  confirmation, au lieu de refuser.
- `docs/DESIGN_SYSTEM_APP.md` §1 : les trois degrés appliqués à la console. Le
  tableau décrit l'écran depuis la livraison de SPK-33, et non plus une cible.
- `docs/DAT.md` §26.2 : réécrit, la saisie est recueillie par une modale limitée à
  la section. Il conserve l'argument de coût qui avait fait choisir le formulaire
  dans le flux, pour qu'on ne le refasse pas. §33.2 dit que le catalogue suit la
  même règle. §25.3 renvoie au catalogue d'images pour le contrôle de forme de la
  référence.
- `README.md` : le champ « image » libre entre dans les limites connues.

### Vérifié sur matériel réel

- Une pile Docker Compose réelle tourne dans un Spark non privilégié, à plages
  UID/GID disjointes, sous AppArmor actif et sans contournement, et répond en
  `HTTP 200` à l'hôte sur son IP privée. C'est la faisabilité du produit lui-même.
- Quota disque, plafond réseau `htb`, limites mémoire, cloisonnement des UID/GID,
  reconfiguration du cpuset à chaud sans redémarrage, topologie SMT.
- Incus **≥ 6.19** devient une contrainte de déploiement : la version des dépôts
  Ubuntu (6.0.0) ne permet de démarrer aucun conteneur Docker dans un Spark.

## [Publié]

_Rien à publier pour le moment._
