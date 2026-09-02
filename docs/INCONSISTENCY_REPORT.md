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

## 2. Le parcours clavier des trois degrés échoue dans la SUITE, jamais isolé

**Constaté le 2026-09-02**, en ajoutant l'onglet « DNS » de SPK-77.

**Le fait.** `e2e/parcours.test.mjs` — « les trois degrés s'atteignent au clavier »
tabule jusqu'à l'onglet `#/forge/images`, avec un budget de vingt frappes. Depuis
l'ajout d'un cinquième onglet à la Forge, il échoue **dans la suite complète**, en
terminant sur `#/manuel` : l'onglet n'a jamais reçu le focus. Il passe **3 fois
sur 3 isolé**, et passe aussi avec ses trois voisins immédiats.

**Ce qui a été mesuré, et corrigé en chemin.** Deux vols de focus réels, tous deux
prouvés rouges avant correction :

- le registre flottant est reconstruit toutes les trois secondes, et le focus qui
  s'y trouvait tombait sur `<body>` ;
- une repeinture de `.principal` — qui arrive **toute seule**, quand un relevé
  aboutit — jetait de même le focus.

Les deux sont corrigés, et le parcours échoue encore dans la suite. La cause
restante n'est donc pas celle-là.

**Piste, non vérifiée.** Une charge tardive d'un écran qu'on a QUITTÉ pourrait
repeindre `.principal` avec les onglets d'un Spark au lieu de ceux de la Forge :
la tabulation traverserait alors des facettes de Spark, et ne rencontrerait jamais
`#/forge/images`. Le dépôt connaît déjà ce motif et s'en protège ailleurs par une
clé de demande (« la dernière ARRIVÉE n'est pas la dernière DEMANDÉE », §38.5.2).
`chargerDetail` et `chargerHote` n'en ont pas.

**Pourquoi ce n'est pas corrigé ici.** La correction porte sur l'ordonnancement
des chargeurs d'écran, partagé par toute la console et au cœur du chantier en
cours sur le registre de sessions. Élargir le budget de frappes du test aurait
enterré le défaut au lieu de le montrer : le test reste rouge, et il a raison.

**Demandé au responsable.** Ouvrir une unité pour la garde de fraîcheur des
chargeurs d'écran, sur le modèle de la clé `lu` du §38.5.2.
