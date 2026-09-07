# Rapport d'incohérences

Écarts constatés entre la spécification et le code, laissés **inchangés** parce
que leur correction dépasse la tâche autorisée. Chaque entrée nomme le document,
le fait observé, et ce qui est demandé au responsable.

Ce fichier est **supprimé** dès qu'il devient vide (CLAUDE.md §5).

---

## 1. La modale DNS propose une action alors qu'il n'y a rien à saisir

**Constaté le 2026-09-02**, en corrigeant le sélecteur de zones vide (§38.1.1).

**Le document.** `docs/DESIGN_SYSTEM.md` §6.13 : « Un état vide ne doit proposer
une action que lorsqu'une action pertinente existe réellement. »

**Le fait.** Dans « Pointer le domaine », lorsqu'il n'y a **aucun jeton**, que le
fournisseur a **refusé**, ou que le compte ne porte **aucune zone**, la modale
n'affiche aucun formulaire — mais son bouton « Poser l'enregistrement » reste
présent et actionnable. L'appuyer envoie une écriture sans zone ni adresse, que
le serveur refuse. La même remarque vaut pour « Écrire la recette ».

**Pourquoi ce n'est pas corrigé ici.** Le bouton d'engagement est rendu
inconditionnellement par `renderModale` (`apps/webui/src/components/modale.js`),
composant partagé par toutes les modales du produit. Le rendre facultatif change
le contrat d'une surface commune et demande de statuer sur ce qu'une modale sans
action doit devenir — une modale, ou une fenêtre au sens du §6.27, puisqu'elle ne
recueille alors plus rien.

**Antériorité.** Le défaut est présent depuis SPK-47 ; il n'est pas introduit par
la correction du 2026-09-02, qui n'a fait que rendre l'état de refus lisible.

**Demandé au responsable.** Arbitrer : rendre l'engagement facultatif dans
`renderModale`, ou rabattre ces états sur une fenêtre plutôt qu'une modale.

---

## 2. `make manuel` détruit cinq illustrations qu'il ne sait plus produire

**Constaté le 2026-09-02**, en produisant l'illustration de SPK-85.

**Le document.** `docs/DAT.md` §30.1 : « les illustrations sont produites, jamais
collectées à la main » ; §30.2 : le lien manuel-image est vérifié dans les deux
sens.

**Le fait.** `e2e/manuel.mjs` vide `docs/manuel/images/` puis reproduit 25 images
— 24 jusqu'à SPK-92, qui a ajouté `m5-depot.png`. Or le manuel en cite 30 : `m4-update.png`, `m4-update-rollback.png`,
`m4-update-mobile.png`, `m6-identite.png` et `m8-widget.png` sont **committées**
mais aucun bloc du harnais ne les produit. Une exécution de `make manuel` les
supprime donc, et `e2e/manuel.test.mjs` rougit aussitôt sur « ces images sont
citées mais absentes ». Ces cinq-là ne sont pas reproductibles : elles violent
le §30.1 depuis leur commit.

**Ce qui a été fait.** Les cinq fichiers ont été **restaurés** depuis `HEAD` après
l'exécution, avec les autres que la régénération avait réécrites sans que leur
écran ait changé. Seules sont conservées les images dont l'unité en cours a
réellement modifié l'écran — `m8-dossier.png` pour SPK-85, `m5-catalogue.png` et
`m5-depot.png` pour SPK-92.

La même conduite s'applique à chaque unité tant que ce défaut n'est pas corrigé :
lancer `make manuel`, garder ses propres illustrations, restaurer les autres.

**Pourquoi ce n'est pas corrigé ici.** Écrire les blocs manquants demande
d'atteindre quatre écrans qui appartiennent à SPK-69, SPK-74 et SPK-75 — dont
l'un exige une build distante comparable et un autre le widget flottant — et de
statuer sur ce que chaque image doit montrer. C'est le travail de ces unités,
pas de celle-ci.

**Demandé au responsable.** Décider qui reprend ces cinq illustrations. En
l'état, personne ne peut lancer `make manuel` sans casser le manuel, ce qui rend
la cible inutilisable pour tout le monde.

---

## 3. Deux règles de design distinctes portent le même identifiant `SPK-DS-19`

**Constaté le 2026-09-07**, en réservant l'identifiant de la règle de courbe de
SPK-93.

**Le document.** `docs/DESIGN_SYSTEM_APP.md` porte **deux** sections nommées
`SPK-DS-19` :

- « Un texte fait pour être collé se montre, se copie, et ne se cache pas »
  (SPK-85, dossier de déploiement) ;
- « Le redémarrage de la Forge : un refus qui ne se clique pas » (SPK-87).

**Le fait.** L'identifiant n'identifie donc plus rien, et le code s'y réfère
depuis les deux camps : `spark-dossier.js`, `spark-dossier.test.js` et
`app.css:613` visent la première ; `forge-view.js`, `forge-view.test.js` et
`host/forge-reboot.js` visent la seconde. Une recherche sur `SPK-DS-19` rend six
fichiers qui ne parlent pas du même sujet.

**Pourquoi ce n'est pas corrigé ici.** Renuméroter l'une des deux règles change
six références `@spec` réparties dans deux fonctionnalités closes, dont aucune
n'appartient à SPK-93. Le faire en passant mêlerait à l'unité en cours un
changement qui ne la concerne pas, et laisserait l'historique de deux unités
livrées pointer vers un identifiant qui a bougé sous elles.

**Ce qui est demandé au responsable.** Trancher laquelle des deux garde
`SPK-DS-19` — la plus ancienne, SPK-85, est le candidat naturel — et autoriser la
renumérotation de l'autre avec ses références. En attendant, SPK-93 prend
`SPK-DS-20`, qui reste libre et sans ambiguïté.

---

## 4. `make captures` s'arrête avant la fin, et cette panne précède SPK-93

**Constaté le 2026-09-07**, en ajoutant les captures de supervision.

**Le fait.** `node e2e/captures.mjs` échoue à la capture
`107-terminal-xterm-registre.png` : `waiting for locator('.widget-inv__ligne')`
expire au bout de huit secondes, après le dépliage de la pastille du widget
d'inventaire (SPK-75, SPK-DS-16). Le script est un programme de haut niveau sans
reprise sur erreur : **tout ce qui suit cette ligne n'est jamais produit**.

**Ce n'est pas SPK-93.** La même panne, au même endroit, se reproduit en
exécutant le `e2e/captures.mjs` de `HEAD` — extrait par `git show` et lancé tel
quel. Elle est donc antérieure, et indépendante des captures ajoutées à la fin
du fichier par cette unité.

**Ce que cela coûte.** Les captures `83` à `90` de SPK-93 — écran de Forge,
curseur de lecture, facette d'un Spark, Spark arrêté, format étroit, absence de
relevé, historien désactivé, lecture en échec — **n'ont jamais été produites par
ce harnais**. Les mêmes états ont été observés autrement, contre la pile de
développement RÉELLE et non un doublon de réponses : historien désactivé par
`SPARKD_METRICS_INTERVAL=0`, absence de relevé sur une Forge neuve jamais seedée,
lecture en échec en coupant `sparkd` sous la console. Ces observations ont
d'ailleurs trouvé trois défauts, corrigés dans l'unité.

**Pourquoi ce n'est pas corrigé ici.** La cause est dans le parcours du terminal
et du widget d'inventaire — une session xterm, un faux `sshd`, une sonde de
sessions vivantes —, c'est-à-dire trois unités closes qui ne sont pas celle en
cours. Diagnostiquer et réparer ce parcours mêlerait à SPK-93 un travail qui ne
la concerne pas.

**Ce qui est demandé au responsable.** Autoriser une tâche dédiée à la remise en
marche de `make captures`. Tant qu'elle n'est pas faite, la campagne de captures
ne prouve plus rien de ce qui suit la ligne 1399, pour SPK-93 comme pour les
unités qui viendront.
