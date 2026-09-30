# Rapport d'incohérences

Ce fichier n'existe que tant qu'une incohérence relevée n'est pas résolue ; il
est supprimé du dépôt quand il devient vide (CLAUDE.md §5).

## 2026-09-18 · Quatre classes de composants que la feuille de style ne peint pas

**Constaté** en rejouant la campagne de composants de la console pendant
SPK-110 : la preuve `apps/webui/src/styles/classes.test.js` — « toute classe
littérale employée par un composant EXISTE dans le CSS » — est **rouge sur
`main` avant SPK-110** (vérifié en la rejouant contre la feuille de style de
`cf6ec7a`), pour quatre classes que des composants écrivent et que
`app.css` ne définit pas :

- `erreur` dans `forge-alertes.js` ;
- `proposition` et `note-carte` dans `spark-notes.js` ;
- `proposition` dans `spark-suggestions.js`.

La liste des manquantes connues de la preuve ne les nomme pas : elles ont été
écrites après elle, sans règle de style. Une preuve de composant qui les cherche
dans la chaîne rendue reste verte sans rien garantir (`DESIGN_SYSTEM.md` §12.3).

**Non résolu ici** : hors du périmètre de SPK-110, qui ne touche ni ces
composants ni ces classes. À arbitrer par le responsable : leur donner une règle
de style, ou les retirer des composants.

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

**Non résolu ici** : hors du périmètre validé de SPK-112, dont le geste « Activer
le TLS » a son propre panneau (`route-tls`) rendu dans la section. À arbitrer par
le responsable : rendre aussi le refus du panneau `route` dans la section quand
la modale est fermée.

## 2026-09-23 · Le doublon Incus perd des écritures simultanées : `500` sur des lectures concurrentes

**Constaté** en jouant la campagne E2E de SPK-114 : une lecture de
`GET /v1/sparks/{nom}/suggestions` faite par le parcours pendant que la console
relisait la même facette a rendu une réponse non JSON. **Reproduit** hors
navigateur : six fils qui lisent quinze fois `/suggestions` sur le pilote
factice rendent **84 erreurs sur 90**, toutes `FileNotFoundError` sur le
renommage du fichier provisoire. Cause : `FakeIncus._persist`
(`services/sparkd/src/sparkd/incus.py`) écrit toujours dans le même
`<registre>.incus.tmp` puis le renomme ; deux requêtes simultanées — chaque
lecture repose les `.?` — se volent ce fichier. Le pilote réel n'est pas
concerné : il ne persiste rien de tel.

**Non résolu ici** : c'est le doublon de la pile de développement et des
parcours, hors du périmètre de SPK-112 et SPK-114. Le parcours de SPK-114
attend désormais que l'écran soit relu avant de lire `sparkd` (la règle de
SPK-DS-27), ce qui évite la course sans la corriger. À arbitrer par le
responsable : rendre `_persist` sûr entre fils (verrou, fichier provisoire
propre à chaque écriture), ce qui supprimerait aussi une source possible de
rouges intermittents dans la campagne.

## 2026-09-30 · « Les trois degrés s'atteignent au clavier » rouge une fois sur deux campagnes

**Constaté** en rejouant la campagne E2E pendant SPK-132 : rouge à la première
passe (148/149, en 261 ms), vert seul, puis vert à la seconde passe complète
(149/149). La capture d'échec montre `#/forge` dans l'état d'un serveur « qui
peut accepter SSH sans encore porter `sparkd` », comme si la console visait un
autre serveur de l'inventaire que la pile d'épreuve — un état qu'un parcours
antérieur aurait laissé. Le parcours s'exécute AVANT ceux de SPK-132, dont le
code ne touche ni la Forge ni la navigation.

**Non résolu ici** : hors du périmètre de SPK-132. La cause n'a pas été
cherchée. À arbitrer par le responsable : isoler ce parcours de l'inventaire que
les parcours antérieurs modifient.
