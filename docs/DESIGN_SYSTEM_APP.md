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
