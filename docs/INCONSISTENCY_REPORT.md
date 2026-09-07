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

## 4. Deux parcours E2E ne peuvent plus atteindre ce qu'ils éprouvent

**Constaté le 2026-09-07**, en jouant la campagne complète — ce que rien ne
faisait plus. Trois parcours rougissaient ; l'un est corrigé, les deux autres
demandent un arbitrage. Aucun des trois ne vient d'un changement de ce jour.

**Corrigé sans arbitrage** : « un quota REFUSÉ reste dans la modale » employait
`page.fill` sur un `input[type=range]`, qui rend « Malformed value » depuis que
SPK-59 a fait des quotas des curseurs. Le geste passe au clavier, comme ailleurs.

### 4.a « le disque OCCUPÉ refuse d'être rétréci » n'est plus atteignable

**Le document.** `docs/DAT.md` §49.3 : le refus de rétrécissement dit autre chose
que le refus d'admission, et l'écran doit le montrer · `CLAUDE.md` §8 : les
données de développement « couvrent les erreurs attendues ».

**Le fait.** Le refus tombe quand la taille visée passe **sous l'occupation
mesurée**. Le curseur de disque a pour borne basse **1 Gio**, et le profil du
doublon donne aux cellules de 300 à 1200 Mio. Or aucun Spark **en marche** du
seed ne dépasse le gibioctet — `crm-production` 488 Mio, `boutique` 505,
`postgres-dedie` 1000. Les deux seuls au-dessus, `analytics` (1187 Mio) et
`orphelin` (1075 Mio), n'ont pas de cellule qui tourne. Aucune valeur
atteignable au curseur ne peut donc provoquer ce refus, et le parcours échoue en
attendant une modale de refus qui ne viendra pas.

**Le produit n'est pas en cause** : sur une Forge réelle une cellule occupe
plusieurs gibioctets, et le refus tombe à des valeurs ordinaires — le parcours le
disait déjà en commentaire. C'est la démonstrabilité qui est perdue.

**Pourquoi ce n'est pas corrigé ici.** Le remède touche au contrat de fidélité du
doublon (§12.1.3) : faire dépendre l'occupation simulée du quota vendu serait plus
réaliste et rendrait le refus atteignable, mais changerait les valeurs que lisent
les courbes de SPK-93 et les preuves d'usage de SPK-14. Ce n'est pas un réglage,
c'est une décision sur ce que le doublon imite.

**Demandé au responsable.** Trancher : faire croître l'occupation simulée avec le
quota vendu, ou seeder une cellule volontairement pleine, ou accepter que ce
refus ne soit prouvé qu'en unité et retirer le parcours en le disant.

### 4.b « un Spark ARRÊTÉ nomme l'arrêt » dépend d'un Spark qu'un autre supprime

**Le document.** `docs/DAT.md` §29.2 : un parcours rend la pile à l'état du seed,
et ne dépend pas de ce qu'un autre a laissé.

**Le fait.** Ce parcours ouvre `orphelin`. Son commentaire explique qu'il
employait `boutique` et que le parcours du rootless le **démarre** plus haut dans
la campagne — la dépendance a donc été déplacée, pas levée : `orphelin` est
**supprimé** par « supprimer un Spark dont l'instance a disparu », qui s'exécute
avant. Le parcours passe seul et rougit en campagne, exactement le symptôme que
son propre commentaire décrit.

**Ce qu'il faudrait, et pourquoi ce n'est pas fait ici.** Un Spark arrêté qu'aucun
parcours ne touche : le seed n'en a aucun, et en ajouter un engage le contrat du
seed (§8). L'autre voie — que le parcours crée sa propre cellule sans la démarrer
— change ce qu'il montre : une cellule jamais démarrée n'a pas de relevé
« arrêté », elle n'a **aucun** relevé, et les deux trous se nomment
différemment. C'est précisément la distinction que ce parcours existe pour
prouver.

**Demandé au responsable.** Décider lequel des deux : un Spark arrêté réservé au
seed, ou un parcours qui établit lui-même son état en arrêtant le Spark qu'il
observe et en le rendant ensuite.
