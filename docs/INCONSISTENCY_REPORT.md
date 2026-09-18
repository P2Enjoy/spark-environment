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

## 2026-09-18 · Trois parcours d'alerte hors bande rouges sur `main`, avant le lot 6

**Constaté** en rejouant la campagne E2E entière pendant SPK-111 (138
parcours), puis en rejouant ces trois-là seuls sur l'arbre committé
(`13e4c44`, le lot 6 retiré du plan de travail) : ils échouent de la même
façon, donc **avant** SPK-111 :

- « l’onglet Alertes se règle, et le REFUS vient du serveur » : sur une pile
  neuve, le formulaire répond « Mot de passe refusé : la configuration des
  canaux n'est pas modifiée » là où le parcours attend « Aucun mot de passe
  n'est encore fixé » — un mot de passe des canaux existe déjà que le seed ne
  pose pas ;
- « un geste sensible envoie une alerte hors bande, un geste ordinaire non » :
  la protection d'`analytics` est bien levée à l'écran, mais le canal du
  harnais ne reçoit aucune alerte ;
- « révoquer une clé malgré le gel, par la confirmation qui NOMME » : conséquence
  du précédent, qui laisse `analytics` désarmé et ne le réarme pas avant de
  s'interrompre — le bloc de confirmation « protégé » n'a plus lieu d'apparaître.

**Non résolu ici** : hors du périmètre du lot 6, qui ne touche ni les canaux
d'alerte ni les clés. La cause commune est vraisemblablement dans le canal
configuré au registre ou dans le mot de passe des canaux ; elle n'a pas été
cherchée. À arbitrer par le responsable : réparer le canal d'épreuve, ou
requalifier ces trois parcours.

## 2026-09-18 · Un parcours DNS qui lit l'état de chargement avant le refus

**Constaté** en rejouant la campagne entière deux fois pendant SPK-111 :
« un fournisseur qui REFUSE ne laisse pas un sélecteur vide et muet » est vert
à la première campagne, rouge à la seconde — il lit « Lecture des zones du
compte… » dans `#recette-zones-vides` avant que le refus `401` ne l'ait
remplacé —, et vert seul. Le sélecteur qu'il attend existe déjà pendant le
chargement ; il faudrait attendre le TEXTE du refus, pas l'élément.

**Non résolu ici** : hors du périmètre du lot 6 (SPK-50). À arbitrer par le
responsable : durcir l'attente du parcours.
