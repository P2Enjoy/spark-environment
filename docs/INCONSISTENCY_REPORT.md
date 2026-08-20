# Registre des incohérences

Défauts constatés en travaillant, **étrangers à l'unité en cours**. Le
comportement est laissé inchangé (`CLAUDE.md` §5, CloudWorker §3.1) : ils sont
consignés avec leur mesure, pas corrigés au passage.

Une entrée résolue est **retirée** de ce fichier. Lorsqu'il devient vide, le
fichier est supprimé du dépôt.

> Ce fichier a été supprimé le 2026-08-20 quand sa dernière entrée a été traitée,
> puis recréé le même jour au premier écart suivant. C'est le cycle voulu.

## Ouverts

### INC-05 · `e2e/reel.mjs` attend un écran que la navigation ne montre plus

**Constaté le** 2026-08-20, en refaisant les captures pour la DoD de SPK-42.

**Mesure.** Le script s'arrête à sa quatrième étape :

```
page.waitForSelector: Timeout 10000ms exceeded.
  - waiting for locator('#titre-routes') to be visible
    at e2e/reel.mjs:63
```

Il ouvre un Spark puis attend immédiatement `#titre-routes`. Depuis **SPK-33**,
la fenêtre d'un Spark s'ouvre sur la facette *Infos* et les routes publiques
vivent derrière un onglet (`docs/DAT.md` §34.2). Le titre n'existe donc pas à ce
moment-là, et n'existera jamais sans un clic sur l'onglet.

**Ligne de base établie** (§2.4) : le script échoue **à l'identique** avant et
après le changement de la session — `git stash -u`, exécution, `git stash pop`.
Ce n'est pas une régression du renommage.

**Pourquoi il est passé inaperçu.** `reel.mjs` n'est appelé par **aucune cible du
Makefile** : `make captures` exécute `e2e/captures.mjs`, `make manuel` exécute
`e2e/manuel.mjs`. Ce script n'appartient à aucune campagne, il n'a donc jamais
rougi devant personne depuis SPK-33.

**Impact.** Les captures `40-reel-*` à `45-reel-*` — celles qui montrent la
console contre un runtime RÉEL, par opposition au faux `sparkd` de
`captures.mjs` — ne sont plus régénérables. Elles restent dans le dépôt, figées à
leur dernière production réussie, et **rien ne signale qu'elles vieillissent**.

**Comportement laissé inchangé.** Le script n'est pas corrigé ici : ce serait
corriger un défaut étranger à l'unité en cours (CloudWorker §3.1).

**Ce que sa correction demanderait**, pour la session qui s'en chargera : ajouter
le clic sur l'onglet *Routes* comme le fait déjà `ouvrir()` dans
`e2e/parcours.test.mjs`, **et** rattacher `reel.mjs` à une cible du `Makefile` —
sans quoi il rougira de nouveau sans témoin à la prochaine refonte de navigation.

### INC-06 · Quatre classes employées par la console n'existent pas dans le CSS

**Constaté le** 2026-08-20, en introduisant le contrôle que le §12.3 du design
system exige — lui-même motivé par un défaut de la tranche 4 de SPK-43, où
`bouton--danger` avait été écrit à la place de `bouton--destructif`.

**Mesure.** Balayage des attributs `class="…"` littéraux de
`apps/webui/src/components/*.js` et de `apps/webui/src/app.js`, confrontés aux
sélecteurs de `apps/webui/src/styles/app.css` et `tokens.css` :

```
controle--compact  → app.js
epreuve--absent    → servers-view.js
epreuve--ok        → servers-view.js
recette-lignes     → spark-admin.js
```

**Ce que cela produit.** Ces classes ne peignent rien. L'écran se rend, sans le
style attendu, et aucune preuve ne le dit : une assertion qui cherche la classe
dans la chaîne rendue reste verte — elle prouve qu'on l'a écrite, pas qu'elle
existe. C'est exactement ce que le §12.3 décrit.

**Ce qui n'est pas mesuré.** L'écart visuel réel de chacune : il faudrait
regarder les trois écrans concernés, ce qui appartient à leurs unités et non à
celle en cours. `epreuve--ok` et `epreuve--absent` portent vraisemblablement une
couleur de verdict (SPK-41), `controle--compact` une densité de champ,
`recette-lignes` la mise en page du compte rendu d'une recette (SPK-50).

**Comportement laissé inchangé** (CloudWorker §3.1). Les quatre sont nommées
dans `CONNUES`, au sein de `apps/webui/src/styles/classes.test.js`. Cette liste
ne peut que décroître : une classe neuve absente du CSS fait échouer le
contrôle, et un second test refuse qu'une classe soldée y reste.

**Pour clore.** Décider, pour chacune, si la classe doit être ajoutée au CSS ou
retirée du composant, en regardant l'écran concerné ; puis la retirer de
`CONNUES` et cette entrée du registre.

### INC-07 · Les onglets de la fenêtre d'un Spark débordent la page sous 390 px

**Constaté le** 2026-08-20, en vérifiant au format étroit la bannière du chemin
de dépannage (SPK-43, tranche 4).

**Mesure.** Fenêtre 390 × 844, écran d'un Spark, onglet *Terminal* :

```
liste     scrollWidth 390 / vue 390   → conforme, le tableau défile dans SON conteneur
terminal  scrollWidth 552 / vue 390   → la PAGE déborde
coupables : a.onglet → 464 · a.onglet → 552
```

**Ligne de base établie** (CloudWorker §2.4) : `git stash -u` sur
`apps/webui/src` et `apps/webui/host`, mesure rejouée, **chiffres identiques**.
Le défaut est donc préexistant et n'appartient pas à la tranche 4 de SPK-43.

**Ce que cela viole.** `docs/DESIGN_SYSTEM.md` §8.1 : « La page ne défile jamais
horizontalement. » La rangée d'onglets de la fenêtre d'un Spark — *Infos*,
*Routes*, *Clés*, *Instantanés*, *Terminal*, *Journal*, et *Docker* quand
SPK-44 l'ajoutera — dépasse 390 px et pousse le document entier. Le §8.2 exige en
outre qu'un débordement soit **signalé** : ici il ne l'est pas, et les deux
derniers onglets sont simplement hors champ.

**À distinguer du cas conforme.** Sur la liste des Sparks, le tableau large
défile bien dans son propre conteneur : `scrollWidth` reste égal à la vue. C'est
la forme attendue, et elle montre que le défaut est propre à la rangée d'onglets.

**Comportement laissé inchangé** (CloudWorker §3.1). La rangée d'onglets
appartient à SPK-33 (les trois degrés de navigation), et la corriger demanderait
de trancher entre défilement local signalé, repli, ou tiroir — un arbitrage de
navigation qui déborde de l'unité en cours.

**Pour clore.** Décider de la forme au format étroit, l'appliquer à
`.onglet`, et vérifier par une mesure que `scrollWidth` retombe à la largeur de
la vue sur les sept facettes.
