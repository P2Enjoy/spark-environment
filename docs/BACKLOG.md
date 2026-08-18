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

### [ ] SPK-03 · Installation Incus, pool de stockage et bridge privé sur l'hôte

- Spécification : `docs/DAT.md` §3, §5, §8.5
- Dépend de : rien pour la voie provisoire ; SPK-28 pour l'exploitation réelle
- DoD : un conteneur de test démarre, obtient une IP sur `sparkbr0`, le quota
  `size` du disque racine est vérifié par écriture réelle jusqu'au refus, et
  `zfs_arc_max` est posé puis reporté dans `host.memory_reserve_bytes`.

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

### [~] SPK-07 · `sparkd` : service HTTP local, santé, inventaire hôte

Entamé par le squelette (SPK-01) : le service démarre, `/healthz` et `/readyz`
sont distincts, et la garde d'adresse d'écoute refuse toute adresse routable au
démarrage — vérifié par 19 tests et à l'exécution réelle
(`SPARKD_BIND=0.0.0.0:9876` sort en code 2 ; `ss` confirme l'écoute sur
`127.0.0.1:9876` seulement).

- Spécification : `docs/DAT.md` §5
- Reste : l'inventaire de l'hôte, et la preuve d'écoute par un scan **depuis
  l'extérieur de la machine cible** — celle conduite ici l'a été localement, sur
  le poste de développement, ce qui ne prouve pas la surface réseau du serveur.
- DoD : écoute exclusivement sur `127.0.0.1:9876`, prouvé par un scan depuis
  l'extérieur ; `/healthz` et `/readyz` distincts ; inventaire de l'hôte exposé.

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
