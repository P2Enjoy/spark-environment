# CHANGELOG

## [Non publié]

### Ajouté
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
- Une session dont le distant mourait **avant** l'ouverture du flux laissait
  l'écran sur « session ouverte » indéfiniment. C'est la course exacte d'un
  `sshd` muet, où `ssh` sort en quelques millisecondes.

### Modifié
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
