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
