# Rapport d'incohérences

Ce fichier n'existe que tant qu'une incohérence relevée n'est pas résolue ; il
est supprimé du dépôt quand il devient vide (CLAUDE.md §5).

## 2026-09-30 · « Les trois degrés s'atteignent au clavier » rouge une fois sur deux campagnes

**Constaté** en rejouant la campagne E2E pendant SPK-132 : rouge à la première
passe (148/149, en 261 ms), vert seul, puis vert à la seconde passe complète
(149/149). La capture d'échec montre `#/forge` dans l'état d'un serveur « qui
peut accepter SSH sans encore porter `sparkd` », comme si la console visait un
autre serveur de l'inventaire que la pile d'épreuve — un état qu'un parcours
antérieur aurait laissé. Le parcours s'exécute AVANT ceux de SPK-132, dont le
code ne touche ni la Forge ni la navigation.

**Arbitré le 2026-10-01** : pas de correction à part — le parcours tourne sur la
pile factice, qui ne valide plus rien (DAT §28.7). Il est absorbé par SPK-138 et
rejoué contre la VM ; l'entrée sort du rapport à ce moment.

## 2026-10-11 · « Changer le MODE CPU depuis l'écran, au clavier » est refusé par la capacité

**Constaté** dans la campagne E2E de SPK-154 (150 sur 153) : le parcours bascule
`boutique` en mode `capped` à 1 CPU, et la Forge refuse — « Capacité
insuffisante — cpu : 1 CPU demandés, 0.75 disponibles (capacité 3, alloué
2.25) — il manque 0.25 CPU ». La modale reste ouverte, et l'attente de sa
fermeture expire (`parcours.test.mjs:656`). **Mesuré** : rouge joué seul, sur le
code de SPK-154 comme sur `cfe1582`, qui précède SPK-154 — le défaut lui est donc
antérieur. Cause probable : le seed de SPK-152 (`api-plafonnee`) ne laisse que
peu de CPU libre (journal du 2026-10-06, « pourrait manquer » sur le
formulaire), et le parcours demande un plafond que la capacité ne couvre plus.
Le refus lui-même est correct : c'est l'attente du parcours, ou le seed, qui
n'a pas suivi.

## 2026-11-10 · `spark.id` : « ULID » dans le schéma, `token_hex(12)` dans le code

**Constaté** en spécifiant la sauvegarde externe (DAT §67). `docs/SCHEMA.md` §4 déclare
`spark.id` « ULID » ; `sparks._new_id()` renvoie `token_hex(12)` (24 caractères
hexadécimaux, non triables par le temps). Les instantanés suivent le même schéma
(`snapshots.create` : `token_hex(12)`).

**Comportement inchangé.** Rien ne casse : aucun code ne relit l'identifiant comme un
ULID. Le contrat de la sauvegarde externe n'en dépend pas — ses identifiants de
génération sont triables par le temps sans ULID (SCHEMA §8 bis).

**Arbitrage demandé** : corriger le schéma (`spark.id` = 24 hexadécimaux), ou migrer
les identifiants. La première voie suffit tant que personne n'a besoin du tri par le
temps.
