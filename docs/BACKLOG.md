# BACKLOG

Statuts : `[ ]` non commencé · `[~]` en cours ou implémenté mais insuffisamment
vérifié · `[x]` terminé et intégralement vérifié.

Un identifiant `SPK-NN` est **stable** : il est cité par les commentaires `@spec`
du code et `@verifies` des tests. Il ne se renumérote pas.

Une unité ne passe à `[x]` qu'après validation de sa Definition of Done, y compris
la preuve E2E depuis le parcours canonique.

---

## Lot 0 — Socle

### [~] SPK-01 · Socle documentaire et structure du monorepo

Persister l'idée, l'architecture, le modèle de données et le découpage avant
toute ligne de code.

- Spécification : `docs/DAT.md`, `docs/SCHEMA.md`, `docs/ORIGIN_CONVERSATION.md`
- DoD : les documents obligatoires de `CLAUDE.md` §5 existent, décrivent le même
  système, et le squelette du monorepo se construit.
- Reste : squelette `apps/webui` + `services/sparkd` + `packages/contract`.

### [~] SPK-02 · Accès au serveur cible et relevé de topologie

Accès SSH obtenu le 2026-08-18. Topologie relevée et consignée : Dell R320,
Xeon E5-1410 v2 (4 cœurs / 8 threads, frères SMT `(0,4) (1,5) (2,6) (3,7)`),
94 Gio de RAM, 2 × 6 To mécaniques en RAID1 `ext4` sur `/`, lien 1 Gbit/s,
Ubuntu 24.04.3 / noyau 6.8 / cgroup v2, VT-x présent.

- Spécification : `docs/DAT.md` §8.1, `docs/JOURNAL.md`
- Reste : `incus info --resources`, qui exige Incus installé (SPK-03).
- DoD : le relevé d'Incus concorde avec celui de `/sys`, notamment le frèrage SMT.

### [ ] SPK-03 · Installation Incus, pool de stockage et bridge privé sur l'hôte

- Spécification : `docs/DAT.md` §3, §5, §8.5
- Dépend de : SPK-28
- DoD : un conteneur de test démarre, obtient une IP sur `sparkbr0`, le quota
  `size` du disque racine est vérifié par écriture réelle jusqu'au refus, et
  `zfs_arc_max` est posé puis reporté dans `host.memory_reserve_bytes`.

## Lot 1 — Registre et admission control

### [ ] SPK-04 · Migrations et registre SQLite

- Spécification : `docs/SCHEMA.md`
- DoD : migrations appliquées et rejouables, checksum vérifié au démarrage,
  retour arrière testé.

### [ ] SPK-05 · Admission control et comptabilité des pools

L'invariant `Σ réservations ≤ capacité × surengagement`, les réserves de l'hôte,
et le refus motivé.

- Spécification : `docs/DAT.md` §7.3
- DoD : tests unitaires sur les cas limites (pool exactement plein, dépassement
  d'une unité, surengagement > 1, réserve hôte) ; refus renvoyé avec la ressource
  fautive et la capacité restante.

### [ ] SPK-06 · Allocation des cœurs dédiés et découpe dynamique du pool

Retrait de cœurs physiques entiers du pool partagé, frères SMT compris, et
reconfiguration du cpuset de tous les Sparks partagés.

- Spécification : `docs/DAT.md` §7.4, §7.5
- DoD : découpe puis restitution vérifiées sur hôte réel, sans redémarrage des
  Sparks partagés ; si un redémarrage s'avère nécessaire, le documenter et le
  rendre explicite dans l'interface.

## Lot 2 — Runtime serveur

### [ ] SPK-07 · `sparkd` : service HTTP local, santé, inventaire hôte

- DoD : écoute exclusivement sur `127.0.0.1:9876`, prouvé par un scan depuis
  l'extérieur ; `/healthz` et `/readyz` distincts.

### [ ] SPK-08 · Pilote Incus : traduction du manifeste Spark

Traduction des quatre modes CPU, mémoire, réseau, stockage, nesting, idmap
isolé.

- Spécification : `docs/DAT.md` §7
- DoD : tests unitaires de traduction sur pilote factice + application réelle
  vérifiée par `incus config show`.

### [ ] SPK-09 · Cycle de vie : create, start, stop, restart, delete

- DoD : machine à états testée, y compris les transitions interdites et la
  reprise après échec en cours de création.

### [ ] SPK-10 · Réseau privé et adressage stable

- DoD : IP stable au redémarrage, `limits.max` appliqué et mesuré par un
  transfert réel.

### [ ] SPK-11 · Clés SSH et injection cloud-init

- Spécification : `docs/SCHEMA.md` §7
- DoD : accès `ssh spark-x` réussi via `ProxyJump` depuis le poste ; retrait
  d'une clé vérifié par un accès effectivement refusé.

### [ ] SPK-12 · Ingress Caddy et réconciliation

- Spécification : `docs/DAT.md` §8
- DoD : `domaine → spark → port` appliqué à chaud ; reconstruction complète de la
  configuration Caddy depuis le registre ; conflit de domaine refusé par la base.

### [ ] SPK-13 · Instantanés et restauration de cellule

Périmètre réduit le 2026-08-18 : les applications hébergées sauvegardent déjà leurs
**données** vers un S3 externe. L'instantané sert donc au retour arrière de la
**cellule entière** — système, images Docker, Compose, volumes, configuration — ce
qu'une sauvegarde applicative ne restaure pas. L'export hors machine reste une
opération manuelle et n'est pas planifié.

- Spécification : `docs/DAT.md` §8.3
- DoD : instantané puis restauration d'un Spark, état de la cellule retrouvé ;
  distinction instantané / sauvegarde explicite dans l'interface.

### [ ] SPK-14 · Métriques d'usage et état temps réel

- DoD : usage CPU/RAM/disque/réseau par Spark, cohérent avec les quotas affichés.

### [ ] SPK-15 · Journal d'audit et filtrage des secrets

- Spécification : `docs/SCHEMA.md` §9
- DoD : test prouvant qu'aucune clé ni secret n'atteint le journal.

## Lot 3 — Console locale

### [ ] SPK-16 · Hôte console : inventaire serveurs et tunnels SSH

- Spécification : `docs/DAT.md` §6
- DoD : ouverture, supervision et fermeture du tunnel ; perte de connexion
  signalée à l'interface, jamais masquée.

### [ ] SPK-17 · Contrat d'API partagé

- DoD : OpenAPI produit par `sparkd`, types TypeScript générés, dérive détectée
  en CI.

### [ ] SPK-18 · Écran liste des Sparks

- Spécification : `docs/DESIGN_SYSTEM.md`, `docs/MANUAL_PLAN.md`
- DoD : états vide, chargement, erreur, données longues ; navigation clavier ;
  captures observées.

### [ ] SPK-19 · Écran détail d'un Spark

### [ ] SPK-20 · Création d'un Spark avec aperçu d'admission

Afficher la capacité restante avant validation, et le refus motivé du backend.

- DoD : le refus provient de `sparkd`, jamais d'un contrôle uniquement côté
  interface.

### [ ] SPK-21 · Écrans ingress, clés SSH, snapshots

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

### [ ] SPK-28 · Décision et exécution du repartitionnement du stockage

Les deux disques sont intégralement consommés par un unique RAID1 `ext4` monté sur
`/`. Aucun périphérique bloc n'est libre pour un pool de stockage natif.

- Spécification : `docs/DAT.md` §8.2, §8.5, §8.6
- Décision attendue du responsable : réinstallation avec partitionnement
  personnalisé, réduction en mode rescue, ou pool sur fichier à titre provisoire.
- DoD : une paire de partitions dédiées existe et porte le pool, ou le choix du
  pool sur fichier est consigné avec ses conséquences ; `docs/PROD_MIGRATIONS.md`
  mis à jour dans le même changement.
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
