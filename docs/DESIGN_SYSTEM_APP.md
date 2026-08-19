# Design System Extension : Spark Environment

Référence complémentaire à `docs/DESIGN_SYSTEM.md`, qui reste la référence
commune. Seules les règles propres à ce produit figurent ici.

## 1. Architecture spécifique

La console est une application **locale**, servie sur `127.0.0.1` par l'hôte
console (`docs/DAT.md` §22). Elle administre un ou plusieurs serveurs à travers
des tunnels SSH.

Conséquence sur la navigation : le **serveur courant** est un contexte global,
pas une page. Il est choisi une fois et conditionne tout ce qui est affiché
ensuite. Une console qui laisserait oublier quel serveur on regarde ferait
prendre des décisions sur la mauvaise machine.

L'état du tunnel accompagne donc en permanence ce sélecteur : `connecting`,
`ready`, `broken`.

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

Mesuré : un Spark réservant `0,5 CPU` en consomme `1,996` sur un hôte au repos
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
