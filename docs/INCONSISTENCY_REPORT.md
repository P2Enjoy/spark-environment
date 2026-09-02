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

## 2. Deux unités de backlog portent le même identifiant `SPK-84`

**Constaté le 2026-09-02**, en attribuant un identifiant à SPK-85.

**Le document.** `docs/BACKLOG.md`, en tête : « Un identifiant `SPK-NN` est
**stable** : il est cité par les commentaires `@spec` du code et `@verifies` des
tests. Il ne se renumérote pas. »

**Le fait.** Deux unités distinctes portent `SPK-84` : « Une recette pose AUSSI sa
route, et les trois blocs se ressemblent » et « L'amorce prévient le `grub-pc`
cassé, et le préflight le nomme ». Les deux sont `[ ]`, donc aucune n'est encore
citée par un `@spec` ou un `@verifies` — c'est ce qui rend la correction encore
possible sans toucher au code.

**Pourquoi ce n'est pas corrigé ici.** Renuméroter l'une des deux est un
arbitrage sur des unités qui n'appartiennent pas à la tâche en cours, et les deux
identifiants ont pu être cités ailleurs qu'ici — un message de commit, une note.
Le journal du 2026-09-02 rappelle que `SPK-79`, `SPK-80` et `SPK-81` ont été
rendus et ne seront **pas réemployés** : ils ne peuvent donc pas servir à
départager.

**Ce qui a été fait à la place.** La nouvelle unité prend `SPK-85`, le premier
identifiant libre au-delà du doublon.

**Demandé au responsable.** Arbitrer laquelle des deux unités `SPK-84` conserve
l'identifiant, et si la seconde doit prendre `SPK-86`.
