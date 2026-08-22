# Design System Extension : Spark Environment

Référence complémentaire à `docs/DESIGN_SYSTEM.md`, qui reste la référence
commune. Seules les règles propres à ce produit figurent ici.

## 1. Architecture spécifique

La console est une application **locale**, servie sur `127.0.0.1` par la Forge
console (`docs/DAT.md` §22). Elle administre un ou plusieurs serveurs à travers
des tunnels SSH.

Conséquence sur la navigation : le **serveur courant** est un contexte global,
pas une page. Il est choisi une fois et conditionne tout ce qui est affiché
ensuite. Une console qui laisserait oublier quel serveur on regarde ferait
prendre des décisions sur la mauvaise machine.

L'état du tunnel accompagne donc en permanence ce sélecteur : `connecting`,
`ready`, `broken`.

### Les degrés, appliqués à la console

`docs/DESIGN_SYSTEM.md` §5.4 donne la forme par défaut de chaque degré — une
orientation, pas une loi. Voici ce qu'ils désignent ici :

| Degré | Contenu de la console | Forme |
|---|---|---|
| 1 | **Sparks**, **Forge** | barre latérale, sélecteur de serveur et état du tunnel en tête |
| 2 | sous *Sparks* : *Instances* · sous *Forge* : *Pools*, *Images* | onglets |
| 3 | la fenêtre d'un Spark, ouverte depuis la liste : *Infos*, *Routes*, *Clés*, *Instantanés*, *Journal*, *Docker*, *Terminal* | onglets de la fenêtre, sections à l'intérieur |
| — | modifier une section, ou lui insérer un élément | modale limitée à cette section |

La fenêtre d'un Spark porte donc **ses propres onglets**, sous ceux du second
degré. C'est le cas prévu par le §5.4 : deux rangées d'onglets pour deux sujets
distincts — ce que l'on regarde dans la console, puis quelle facette du Spark
ouvert. Ce qui serait fautif, ce sont deux rangées côte à côte pour le même sujet.

Les facettes reprennent les **panneaux** existants du détail (`docs/DAT.md` §26).
Ce ne sont toujours pas des écrans — une route publique n'existe pas sans son
Spark — mais les onglets de sa fenêtre, et non plus des blocs empilés dans une
page qui s'allonge.

L'onglet *Images* du second degré est la surface du catalogue d'images
(`docs/DAT.md` §33) : le catalogue décrit la Forge, pas un Spark.

Le sélecteur de serveur reste **au-dessus** du premier degré : il ne désigne pas
une destination mais le contexte de toutes les destinations.

**Ce tableau décrit l'écran, et non une cible** : `docs/BACKLOG.md#SPK-33` l'a
livré le 2026-08-19. La barre latérale, les onglets du second degré, les facettes
d'un Spark et la modale limitée à une section existent tous. Le §34 du
[DAT](DAT.md) en donne le détail, et le §26.2 la surface de saisie.

Ce qui prime sur le tableau, et qui ne se négocie pas à la livraison : ce qui
s'affiche et ce qui se saisit ne partagent pas la même surface, chaque surface a
un seul sujet, et une action sensible se confirme (`DESIGN_SYSTEM.md` §5.4,
§6.23).

## 2. Terminologie métier

| Terme | Sens, tel qu'affiché |
|---|---|
| Spark | cellule d'exécution contingentée, hébergeant une pile Docker Compose |
| Réservation | droit d'ordonnancement CPU **sous contention**, jamais un plafond |
| Burst | consommation au-delà de la réservation — normale, pas un dépassement |
| Plafond | seule limite réellement appliquée par le noyau |
| Instantané | retour arrière de la cellule entière, **pas** une sauvegarde |

## 3. Tokens calculés

`docs/DESIGN_SYSTEM.md` §14.1 exige que la conformité soit **calculée**, pas
déclarée. Mesures faites le 2026-08-19 :

| Token | `-soft` | plein sur soft | `-on-soft` retenu | on-soft sur soft |
|---|---|---|---|---|
| `brand` | `#e5e9f1` | **7,42** ✓ | `#23468c` | 7,42 |
| `success` | `#e5f1e7` | 3,71 ✗ | `#1f7b2d` | **4,60** ✓ |
| `accent` | `#faf9e9` | 1,53 ✗ | `#7a7429` | **4,54** ✓ |
| `danger` | `#fde8e8` | 3,19 ✗ | `#c63535` | **4,51** ✓ |

Autres couples vérifiés : `ink` sur surface 19,44 · `text-2` sur surface 7,56 ·
`text-3` sur surface 4,83 · `text-2` sur `hover` 6,87 · blanc sur `brand` 9,03.
Tous ≥ 4,5:1.

Les trois `*-on-soft` calculés confirment le constat du §14.1 : la couleur pleine
de `success`, `accent` et `danger` ne passe **pas** sur sa propre déclinaison
douce.

## 4. Règles de visualisation particulières

### SPK-DS-01 · L'état d'un Spark

Huit états (`docs/SCHEMA.md` §4). Correspondance unique, définie à un seul
endroit (`DESIGN_SYSTEM.md` §12.5) :

| État | Token | Nature |
|---|---|---|
| `running` | `success` | stable |
| `stopped` | `neutral` | stable |
| `pending` | `accent` | stable |
| `error` | `danger` | stable |
| `creating`, `starting`, `stopping`, `deleting` | `brand` | **transitoire** |

Un état transitoire porte en outre une indication de mouvement, distincte de la
couleur : le produit refuse par ailleurs toute commande dans ces états
(`docs/DAT.md` §14.1), et l'interface doit le faire comprendre sans que
l'utilisateur ait à essayer.

### SPK-DS-02 · Le burst n'est pas un dépassement

Mesuré : un Spark réservant `0,5 CPU` en consomme `1,996` sur une Forge au repos
(`docs/DAT.md` §20.3 bis). Une jauge affichant « 1,99 / 0,5 » en rouge
signalerait une violation là où il n'y a qu'un usage optimal.

Donc :

- la part **jusqu'à** la réservation utilise `brand` ;
- la part **au-delà** utilise `accent`, et se nomme « burst » ;
- `danger` n'est employé que si `over_limit` est vrai, ce qui n'arrive qu'en
  mode `capped`.

### SPK-DS-03 · Nommer l'absence de mesure

`docs/DESIGN_SYSTEM.md` §14.6 interdit de confondre zéro, calcul en cours et
mesure impossible. Le runtime rend déjà `null` plutôt que `0` quand il ne sait
pas (`docs/DAT.md` §20.1). L'interface suit :

| Situation | Texte |
|---|---|
| Spark arrêté | « Arrêté — aucune mesure d'exécution » |
| premier relevé | « Mesure en cours » |
| Spark en erreur | « Indisponible » |
| valeur réelle nulle | `0` |

Un blanc n'est jamais employé pour l'une de ces situations.
### SPK-DS-04 · Le terminal n'est ni une section ni une modale

Un terminal ne se range dans aucune des deux formes du §6.27 : il n'a pas de point
d'engagement, donc ce n'est pas une modale ; il n'affiche pas des paires
terme/valeur, donc ce n'est pas une section.

C'est une **surface d'interaction continue**, et elle est traitée comme une
destination : un onglet de la fenêtre du Spark, avec sa propre adresse.

Règles propres :

- l'état protégé du Spark (`docs/DAT.md` §35) et le chemin employé — SSH ou
  dépannage (§37.3) — restent affichés **pendant toute la session**, pas seulement
  à l'ouverture ;
- quitter l'onglet termine la session, et l'écran le dit avant de le faire ;
- le terminal ne porte aucun bouton d'action Docker : les gestes appartiennent à
  l'onglet *Docker*, où ils sont nommés et confirmés (§6.23). Un bouton posé à
  côté d'un shell laisserait croire que les deux font la même chose de deux
  façons ;
- le mode lecteur d'écran est activable et son réglage persiste.

SPK-70 précise la surface sans en faire une exception à la navigation : la grille
xterm reçoit le focus et la frappe directement — ni champ miroir, ni bouton
« envoyer ». Elle garde la sélection, le copier-coller et les touches de contrôle
du terminal. Son mode lecteur d'écran expose la restitution textuelle interprétée
sans jamais montrer les séquences brutes.

Le registre des sessions est un second repère de l'exploitation, pas une nouvelle
destination : à large écran, il occupe le bord gauche de la console et reste
visible pendant la navigation. Il liste le type, Forge, Spark, conteneur s'il y
en a un, chemin, ouverture et dernière activité ; une ligne mène à la session.
« Fermer » demande confirmation et nomme la session visée. Sous 1024 px, ce
registre devient un tiroir déclenché par un bouton libellé, avec focus rendu à son
déclencheur à la fermeture ; il ne réduit jamais la grille au point de la rendre
inutilisable.

### SPK-DS-05 · Deux origines de mesure ne partagent pas une jauge

Les mesures d'un Spark viennent du runtime et se comparent à ses quotas
(`docs/DAT.md` §20). Celles des conteneurs viennent de Docker, à l'intérieur de la
cellule, et se comparent à ce que la cellule voit d'elle-même (§37.6).

Elles ne sont jamais empilées dans le même graphique ni additionnées. Chaque
mesure est affichée avec **ce à quoi elle se rapporte**, écrit à côté d'elle. Même
principe que SPK-DS-02 : un chiffre sans son référentiel est un chiffre faux.


### SPK-DS-06 · Deux témoins de l'intégrité, jamais résumés en un

L'écran *Journal* de la Forge porte **deux** verdicts, et ils ne disent pas la
même chose : la **chaîne**, telle que le serveur la voit, et la **comparaison**
avec ce que la console avait vu (`docs/DAT.md` §36.1, §36.8.4).

Ils ne se combinent jamais en un seul indicateur. Le cas qui décide de la règle
est celui de la **troncature** : la chaîne restante est parfaitement valide et
s'affiche « intacte », alors que des entrées ont disparu de la fin. Un indicateur
unique dirait alors « tout va bien », et il aurait tort précisément là où le
dispositif entier a été construit pour ne pas se tromper.

Conséquences visuelles, non négociables :

- les deux verdicts occupent **deux lignes de définition distinctes**, avec leurs
  intitulés propres — jamais un badge de synthèse ;
- un verdict d'ancre en alerte — `shrunk`, `diverged` — est rendu dans la même
  enveloppe annoncée qu'une rupture de chaîne : `role="alert"`
  (`DESIGN_SYSTEM.md` §9.7). Deux signaux de même gravité dont un seul est
  annoncé, c'est celui qu'on tait qui sera manqué ;
- la différence de nature passe par la **structure** — un panneau bordé face à
  une ligne simple — et pas seulement par la couleur du badge
  (`DESIGN_SYSTEM.md` §14.8, §1.5) ;
- les trois verdicts sains — `first`, `extends`, `unchanged` — ne portent **pas**
  de région d'alerte : une alerte permanente n'alerte plus de rien ;
- l'écart est **chiffré** — combien la console avait retenu, combien le serveur
  annonce — et non simplement affirmé.

Preuve : `e2e/captures/44-journal-ancre-alerte.png` et
`e2e/captures/45-journal-ancre-mobile.png`, observées.

### SPK-DS-07 · Les quotas se règlent au curseur, les ports se saisissent

`DESIGN_SYSTEM.md` §6.9 bis donne la préférence et ses trois conditions. Voici où
elles tombent dans la console.

**Les quotas de l'écran de création** — réservation CPU, plafond CPU, cœurs,
mémoire, disque, débit — se règlent au curseur dès que la capacité de la Forge
est connue.

La borne haute d'un curseur de quota est la **capacité totale de la Forge**, et
jamais ce qui reste libre. Ce n'est pas un détail d'implémentation :

- borner sur le **disponible** ferait décider l'écran à la place de `sparkd`, ce
  que le `docs/DAT.md` §25.1 interdit — le disponible est une photographie qui se
  périme, et dans le sens favorable ;
- cela rendrait le **refus d'admission inatteignable depuis le parcours
  canonique** : on ne pourrait plus demander ce que la Forge ne peut pas donner,
  donc plus l'éprouver par l'écran ;
- la **capacité**, elle, ne bouge pas entre l'ouverture de l'écran et la
  soumission. C'est le raisonnement de la liste d'images du §33.5 : une contrainte
  stable se pose dans le contrôle, une contrainte périmable appartient au serveur.

Le panneau *Capacité restante* le dit en toutes lettres. Un curseur qui va
jusqu'à 76 Gio à côté d'un panneau annonçant 64 Gio libres se lirait autrement
comme une contradiction.

Lorsque la capacité n'a pas pu être relevée, les quotas se rendent en **saisie
numérique** : sans bornes, pas de curseur (§6.9 bis, condition 1).

**Le pas de chaque quota, et pourquoi la mémoire ne se règle pas au gibioctet.**

| Quota | Pas | Motif |
|---|---|---|
| réservation et plafond CPU | 0,05 CPU | la plus petite part que le produit sait poser |
| cœurs | 1 | un cœur physique ne se coupe pas |
| **mémoire** | **256 Mio** | décision du responsable, 2026-08-20 |
| disque | 1 Gio | le quota compte l'écrit après compression, au gibioctet |
| débit | 10 Mbit/s | la comptabilité du lien ne descend pas plus bas |

Le gibioctet était trop grossier pour la mémoire, et la mesure le dit : le seed
pose des Sparks à **512 Mio**, valeur qu'un pas de 1 Gio rend inatteignable. Sur
la pile de validation, dont le pool mémoire est de 5,4 Gio une fois les réserves
déduites, un curseur au gibioctet n'offrait que **cinq crans** — le contrôle avait
la forme d'un réglage fin et la granularité d'un menu à cinq entrées.

Deux conséquences, toutes deux assumées :

- la mémoire s'affiche avec un format **exact** (§6.9 bis) et non avec l'arrondi
  des mesures : « 512 Mio », « 1,25 Gio », « 76 Gio ». `formatBytes` rendrait
  « 1,3 Gio » pour 1,25 et « 10 Gio » pour 10,25 — trois crans sur quatre y
  seraient invisibles ;
- un pool mémoire dépassant **100,25 Gio** compte plus de 400 crans à ce pas, et
  la mémoire y **retombe en saisie** par la condition 2. La Forge de validation
  déclare 94 Gio de RAM et son pool reste bien en deçà une fois l'ARC et
  `SPARKD_MEMORY_RESERVE` déduits, donc le curseur y survit ; sur une machine plus
  grosse il cédera, et c'est la règle qui fonctionne.

**Le disque de la Forge de validation illustre la condition 3, et il vaut d'être
écrit** : ses deux disques de 6 To en RAID1 donnent un pool de plus de 5 000 Gio.
Au pas de 1 Gio le curseur compterait plus de cinq mille crans ; le pas de 20 Gio
qui les ramènerait sous 400 rendrait le quota courant de 10 Gio **inatteignable**.
Le disque s'y saisit donc, pendant que la mémoire et le débit restent des
curseurs. La règle fonctionne — ce n'est pas une exception qu'on lui concède.

**Les ports ne sont jamais des curseurs** : route publique, port cible, port de
`sparkd`, port local d'un tunnel. C'est le contre-exemple du §6.9 bis.

### SPK-DS-08 · Trois blocs d'issue, et le rouge n'en est qu'un

**Date** : 2026-08-20 · introduit par SPK-45.

La console rendait déjà deux blocs d'issue, et leur partage est une règle :

- `.refus` — **rouge**. Le serveur a refusé. C'est le seul cas rouge.
- `.avertissement` — **accent**. Un risque est annoncé, ou un fait est signalé
  qui n'est ni un refus ni un succès.

Un troisième manquait, et son absence se voyait : un geste **abouti** n'avait que
le jaune de l'avertissement pour se dire. « Le conteneur est arrêté » s'affichait
dans la couleur qui sert à prévenir d'un danger.

- `.succes` — **vert**. Le geste demandé a eu lieu, constaté et non supposé.

**Ce que cette troisième couleur interdit**, et c'est son intérêt : elle rend
visible qu'un état intermédiaire n'est PAS un succès. Un conteneur déjà arrêté,
un conteneur disparu, un geste qui n'est pas parti prennent l'accent — pas le
vert. Sans ce troisième bloc, on aurait été tenté de tout verdir dès que la
requête aboutissait, ce qui aurait fait lire « c'est fait » sur un geste qui n'a
rien fait.

Le vert ne s'écrit jamais sur ce que l'écran **suppose** : il s'écrit sur ce que
la Forge a rendu (`DESIGN_SYSTEM.md` §14.9).

### SPK-DS-09 · Une confirmation sensible n'a pas la couleur d'une confirmation destructive

**Date** : 2026-08-20 · introduit par SPK-45.

`.confirmation` est **rouge** depuis son origine. Cela convenait tant que la
console n'en portait qu'une, celle du dépannage en root — un geste dont l'effet
est grave par nature.

SPK-45 en apporte quatre d'un coup, et l'une seulement est destructive. Peindre
« redémarrer » de la couleur de « tuer » les rendrait indiscernables **au moment
où l'on est pressé**, c'est-à-dire au moment où l'on tue. La couleur cesserait
alors d'être une information et deviendrait un bruit de fond dont on apprend à ne
plus tenir compte.

- `.confirmation` — **rouge** : le geste détruit, sans attendre ni prévenir.
- `.confirmation.confirmation--sensible` — **accent** : le geste interrompt, mais
  laisse une chance de terminer proprement.

Le bouton d'engagement suit la même règle : `bouton--destructif` pour le premier
cas, un bouton ordinaire pour le second. Une confirmation accent avec un bouton
rouge donnerait deux signaux contradictoires dans le même bloc.

### SPK-DS-10 · Un avertissement dont la cause survit au geste vit dans la coquille

**Date** : 2026-08-21 · introduit par SPK-40.

Un message d'après-geste se place selon la DURÉE DE SA CAUSE, pas selon l'écran
d'où le geste est parti.

- **La cause est le geste** — un refus du serveur, une saisie invalide, un
  instantané créé : le message vit DANS l'écran, à côté de ce qui l'a produit.
  C'est le cas ordinaire, et SPK-DS-08 en fixe les trois blocs.
- **La cause survit au geste** — un agent SSH vidé, une clé non configurée, un
  service extérieur muet : le message vit dans la COQUILLE, sous le contexte du
  serveur auquel la cause appartient.

Le motif est mesuré sur le cas qui a introduit cette règle : l'échec de signature
(`docs/DAT.md` §36.10.9). Posé dans l'écran du geste, il disparaissait en
changeant de page — alors que l'agent restait vide et que le geste suivant
repartirait non signé lui aussi. L'exploitant croyait avoir réglé en naviguant ce
qu'il n'avait pas touché.

Deux obligations en découlent, et elles vont ensemble :

- l'avertissement **PERSISTE** tant que la cause persiste, y compris à travers un
  changement d'écran ;
- il **S'EFFACE DE LUI-MÊME** dès que la cause disparaît. Un avertissement qui
  survivrait à sa cause mentirait dans l'autre sens, et l'on désapprendrait à le
  lire — ce qui est pire que ne rien dire.

Il porte `role="status"` et non `role="alert"` : le geste a eu lieu, rien n'est
refusé. Et sa couleur suit le §25.1 — accent, jamais rouge.

### SPK-DS-11 · Le code local périmé est un avertissement de coquille

**Date** : 2026-08-21 · introduit par SPK-65.

Une console démarrée avant la tête du dépôt affiche une version qui n'est plus
celle que le responsable vient de lire. Le symptôme survit à toutes les
destinations : il est donc rendu sous le contexte de serveur, dans la coquille,
avec un badge **accent**, un texte explicite et `role="status"`.

Le message nomme le seul geste qui le corrige — redémarrer la console — sans
bouton qui prétendrait pouvoir le faire. Un processus ne se relance jamais sous
les mains de l'exploitant. L'absence de dépôt, un dépôt qui a reculé, et une
comparaison impossible restent des faits nommés, jamais « à jour » par défaut.

### SPK-DS-12 · Installer est un parcours visible, jamais une barre qui promet

**Date** : 2026-08-22 · introduit par SPK-68.

L'installation d'une Forge est une suite de changements sur une machine qui peut
porter des données. Elle ne peut donc pas prendre la forme d'un bouton isolé ni
d'une progression décorative. La destination Forge rend un panneau dédié avec :

- le transport SSH et `sparkd` sur **deux lignes distinctes** ; « SSH établi »
  ne reçoit jamais le vert de « Forge prête » ;
- les phases nommées, dans leur ordre réel, et un statut textuel `à faire`, `en
  cours`, `terminée`, `avertissement`, `échec` ou `interrompue` ;
- le relevé utile sous la phase qui l'a produit, sans sortie de terminal brute ni
  secret ;
- un plan avant l'engagement, puis une confirmation séparée pour tout disque ou
  fichier de pool qui sera créé.

Un disque exclu reste visible avec son motif ; le masquer ferait passer son
absence de proposition pour une incapacité de l'outil. La phase finale ne dit
jamais « prête » avant les réponses mesurées de `/healthz` et `/readyz`. Une
déconnexion conserve l'étape interrompue et offre **Reprendre le diagnostic**,
pas « Reprendre » comme si une écriture avait nécessairement continué.

## 5. Responsive spécifique

Le tableau des Sparks défile dans son propre conteneur sous 1024 px
(`DESIGN_SYSTEM.md` §8.1). La page ne défile jamais horizontalement.

Sous 768 px, les colonnes secondaires — adresse, image — sont retirées avant les
colonnes d'identité et d'état, conformément à l'ordre de sacrifice du §5.3.

## 6. Écarts au design system commun

### SPK-DS-E01 · Pas de Tailwind

**Date** : 2026-08-19
**Règle concernée** : `DESIGN_SYSTEM.md` §12.2
**Écart** : la console utilise du CSS avec variables, sans Tailwind.
**Justification** : le §12.2 ne rend Tailwind obligatoire nulle part ; il décrit
ce qu'il faut faire *lorsqu'une application l'utilise*. Introduire Tailwind pour
ensuite en réinitialiser les espaces de noms ajouterait une chaîne de
construction et un risque de classe non générée (§12.3) sans bénéfice à cette
échelle. Les tokens sont déclarés une seule fois sur `:root` (§12.1), ce qui est
l'exigence de fond.
**Décision** : à revoir si la console grossit au point que le CSS manuel devienne
coûteux.

### SPK-DS-E02 · Textes français en clair, sans système d'i18n

**Date** : 2026-08-19
**Règle concernée** : `DESIGN_SYSTEM.md` §11
**Écart** : les textes visibles sont écrits en français dans les composants.
**Justification** : le §11 conditionne l'usage de clés à la présence d'un système
d'internationalisation — il n'y en a pas, et le produit s'adresse aujourd'hui à
un seul responsable francophone. Introduire des clés sans catalogue ni seconde
langue ajouterait une indirection que rien n'exploite.
**Décision** : les textes restent regroupés par composant, pour qu'une extraction
ultérieure reste mécanique. À rouvrir dès qu'une seconde langue est demandée.
