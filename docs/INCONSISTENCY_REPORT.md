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
