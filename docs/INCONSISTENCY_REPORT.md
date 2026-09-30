# Rapport d'incohérences

Ce fichier n'existe que tant qu'une incohérence relevée n'est pas résolue ; il
est supprimé du dépôt quand il devient vide (CLAUDE.md §5).

## 2026-09-23 · Le refus de « Retirer la route » et de « Réappliquer » ne s'affiche nulle part

**Constaté** en écrivant SPK-112 : les deux gestes passent par
`agir('route', …)`, qui range leur refus sous le panneau `route`. Or ce panneau
n'est rendu que **dans la modale** « Routes publiques » (`renderRoutesPanel`,
`apps/webui/src/components/spark-admin.js`), et cette modale est fermée quand on
retire ou réapplique. Vérifié par un rendu direct : un refus `{ panel: 'route' }`
avec la modale fermée n'apparaît pas dans le HTML. Deux refus réels y tombent :
`DELETE /v1/ingress/{domain}` sur un Spark protégé (`423`, `ensure_writable`) et
`POST /v1/ingress/reconcile` quand le proxy est injoignable (`502`). L'écran ne
dit rien, ce que `DESIGN_SYSTEM.md` §1.3 et §6.27 refusent.

**Arbitré le 2026-10-01** : corriger — unité SPK-139. L'entrée sort du rapport
quand la correction est livrée.

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
