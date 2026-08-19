# CHANGELOG

## [Non publié]

### Ajouté

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

### Modifié

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

### Modifié

- `.gitignore` :
- `docs/SCHEMA.md` §7 : l'injection des clés ne passe plus par cloud-init.
- `docs/DAT.md` §5.2 : la mémoire totale vient de `/proc/meminfo`, non d'Incus. remplacement du gabarit C++ hérité, qui ignorait `Makefile`.
- `docs/SCHEMA.md` : nouveau §12, mécanique des migrations.
- `docs/DAT.md` : nouveau §7.7, ce que l'admission control compte et contre quoi ;
  nouveaux §5.1 à §5.3, accès à Incus et relevé de l'inventaire ; nouveau
  §7.2 ter, rendu exact des valeurs CPU ; nouveau §14, cycle de vie d'un Spark ;
  nouveau §15, adressage du réseau privé ; nouveau §16, la réserve de l'hôte ;
  nouveaux §7.4 bis et §7.4 ter, redistribution lors d'une découpe ; nouveau
  §17, accès SSH aux Sparks ; nouveau §18, réconciliation de l'ingress ; nouveau §19, instantanés et
  restauration ; nouveau §20, métriques d'usage ;
  nouveau §21, journal d'audit.
- `docs/SCHEMA.md` §12.1 : les migrations vivent dans le paquet.

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
