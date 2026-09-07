/**
 * @verifies docs/BACKLOG.md#SPK-93 · docs/DESIGN_SYSTEM_APP.md SPK-DS-20 (la
 *           courbe ne relie pas ce qu'elle n'a pas mesuré, deux trous et deux
 *           textes, l'information ne repose pas sur la couleur seule),
 *           SPK-DS-02 (le burst se distingue sans se dénoncer), SPK-DS-03
 *           (nommer l'absence de mesure) · docs/DESIGN_SYSTEM.md §6.13 (états
 *           systématiques), §9.2 (structure sémantique), §14.6 (mesure
 *           indisponible et zéro) · docs/DAT.md §52.4, §52.6
 *
 * Le piège que ces preuves gardent : une courbe ment sans qu'on le voie. Relier
 * deux points qui encadrent un trou affirme une continuité que rien n'a
 * mesurée, et une série vide rendue à plat au sol se lit « il ne consommait
 * rien » — c'est-à-dire une mesure que personne n'a faite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  segments, borneHaute, etatDeLaSerie, dernierPoint, renderGraphique,
  renderMicroCourbe, palier,
} from './graphique.js';
// Le VRAI formateur, et non le doublon local : ce test porte précisément sur
// l'écriture des très petites mesures, et un doublon qui arrondirait autrement
// prouverait l'inverse de ce qu'on cherche.
import { formatCpu } from './tokens.js';

const point = (at, cpu, extra = {}) => ({
  at, cpu, samples: cpu === null ? 0 : 1, states: cpu === null ? [] : ['running'],
  ...extra,
});

const SERIE = [
  point('2026-09-07T12:00:00+00:00', 0.2),
  point('2026-09-07T12:00:15+00:00', 0.4),
  point('2026-09-07T12:00:30+00:00', null),
  point('2026-09-07T12:00:45+00:00', 0.8),
];

const CPU = (v) => `${v.toFixed(2)} CPU`;

/* ------------------------------------------------- la règle qui décide tout */

test('la courbe NE RELIE PAS les deux points qui encadrent un trou', () => {
  // Une droite entre eux affirmerait une continuité que rien n'a mesurée.
  const morceaux = segments(SERIE, 'cpu');
  assert.equal(morceaux.length, 2);
  assert.deepEqual(morceaux[0].map((p) => p.valeur), [0.2, 0.4]);
  assert.deepEqual(morceaux[1].map((p) => p.valeur), [0.8]);
});

test('le trou produit DEUX tracés, pas un seul avec un saut', () => {
  const coupee = [...SERIE, point('2026-09-07T12:01:00+00:00', 0.9)];
  const html = renderGraphique({ cle: 'cpu', titre: 'Processeur', serie: coupee, format: CPU });
  // Deux polylignes, et AUCUN segment ne franchit le trou.
  assert.equal((html.match(/<polyline class="graphique__trace"/g) || []).length, 2);
});

test('un trou en FIN de série ne prolonge pas le dernier tracé', () => {
  const html = renderGraphique({ cle: 'cpu', titre: 'Processeur', serie: SERIE, format: CPU });
  // Le dernier segment n'a qu'un point : il devient un cercle, sans quoi il
  // serait invisible. Une polyligne de deux points l'aurait relié au précédent.
  assert.equal((html.match(/<polyline class="graphique__trace"/g) || []).length, 1);
  assert.match(html, /graphique__point/);
});

test('un segment d’UN seul point est un cercle, jamais rien', () => {
  const isole = [point('a', null), point('b', 0.5), point('c', null)];
  const html = renderGraphique({ cle: 'cpu', titre: 'CPU', serie: isole, format: CPU });
  assert.match(html, /<circle class="graphique__point"/);
});

/* --------------------------------------------- deux trous, et deux textes */

test('une série SANS AUCUN relevé dit « Aucun relevé sur cette période »', () => {
  const vide = [point('a', null), point('b', null)];
  assert.deepEqual(etatDeLaSerie(vide, 'cpu'),
                   { vide: true, texte: 'Aucun relevé sur cette période' });
});

test('un Spark ARRÊTÉ ne dit PAS la même chose qu’une absence de relevé', () => {
  // §52.4 : le premier est un fait sur le Spark, le second un fait sur la Forge.
  const arrete = [
    { at: 'a', cpu: null, samples: 2, states: ['stopped'] },
    { at: 'b', cpu: null, samples: 2, states: ['stopped'] },
  ];
  assert.deepEqual(etatDeLaSerie(arrete, 'cpu'),
                   { vide: true, texte: 'Arrêté — aucune mesure d’exécution' });
});

test('chaque situation a SON texte, jamais celui d’une autre', () => {
  // SPK-DS-03 : « Mesure en cours » sur un Spark jamais appliqué ferait attendre
  // une valeur qui ne viendra pas (§14.6).
  const sans = (etat) => [{ at: 'a', cpu: null, samples: 1, states: [etat] }];
  assert.match(etatDeLaSerie(sans('pending'), 'cpu').texte, /Pas encore appliqué/);
  assert.match(etatDeLaSerie(sans('error'), 'cpu').texte, /Indisponible/);
  assert.match(etatDeLaSerie(sans('running'), 'cpu').texte, /Mesure en cours/);
});

test('un historien DÉSACTIVÉ se nomme quand il n’y a RIEN à tracer', () => {
  assert.deepEqual(etatDeLaSerie([], 'cpu', { actif: false }),
                   { vide: true, texte: 'Supervision désactivée sur cette Forge' });
});

test('une supervision éteinte n’EFFACE pas l’historique déjà relevé', () => {
  // VU À L'ÉCRAN le 2026-09-07, cadence posée à 0 : les quatre courbes de la
  // Forge annonçaient « désactivée » pendant que les micro-courbes par Spark,
  // juste dessous, traçaient la même histoire. Une page, deux affirmations
  // contraires. Ce qui s'est arrêté, c'est l'arrivée de NOUVEAUX relevés.
  assert.deepEqual(etatDeLaSerie(SERIE, 'cpu', { actif: false }),
                   { vide: false, texte: null });
});

test('un relevé sans taux encore calculé dit « Mesure en cours »', () => {
  const premier = [{ at: 'a', cpu: null, samples: 1, states: ['running'] }];
  assert.equal(etatDeLaSerie(premier, 'cpu').texte, 'Mesure en cours');
});

test('une série vide rend l’état vide, PAS un graphique plat à zéro', () => {
  const html = renderGraphique({ cle: 'cpu', titre: 'Processeur', serie: [], format: CPU });
  assert.match(html, /graphique--vide/);
  assert.match(html, /Aucun relevé sur cette période/);
  assert.doesNotMatch(html, /<polyline/);
});

test('un état vide se nomme UNE FOIS, pas deux', () => {
  // VU À L'ÉCRAN le 2026-09-07 : la phrase occupait la place de la valeur ET le
  // corps de la carte, deux fois la même sur quatre cartes.
  const arrete = [{ at: 'a', cpu: null, samples: 1, states: ['stopped'] }];
  const html = renderGraphique({ cle: 'cpu', titre: 'CPU', serie: arrete, format: CPU });
  assert.equal((html.match(/aucune mesure d’exécution/g) || []).length, 1);
});

test('une série RÉELLEMENT à zéro se trace : zéro est une mesure', () => {
  // §14.6 : ne jamais confondre zéro et « pas de mesure ».
  const zeros = [point('a', 0), point('b', 0)];
  const html = renderGraphique({ cle: 'cpu', titre: 'CPU', serie: zeros, format: CPU });
  assert.doesNotMatch(html, /graphique--vide/);
  assert.match(html, /<polyline/);
  assert.match(html, /0\.00 CPU/);
});

/* ------------------------------------------------------------- l'échelle */

test('la borne haute INCLUT la référence tant qu’elle ne l’écrase pas', () => {
  // Une courbe qui dépasse son quota sans qu'on voie le quota cache ce qu'on est
  // venu regarder.
  assert.ok(borneHaute([point('a', 1)], 'cpu', 2) >= 2);
});

test('une référence trop HAUTE sort du cadre au lieu d’écraser la courbe', () => {
  // MESURÉ le 2026-09-07 : 2 Mbit/s sous un plafond de 100, et 489 Mio sous un
  // quota de 10 Gio. Mise à l'échelle sur la référence, la courbe devient un
  // trait posé au sol : deux des quatre graphiques ne montraient plus rien.
  const haut = borneHaute([point('a', 2e6), point('b', 3e6)], 'cpu', 100e6);
  assert.ok(haut < 10e6, `l’échelle suit la donnée, pas la référence (${haut})`);
});

test('hors du cadre, la référence reste NOMMÉE avec sa valeur', () => {
  // On perd le trait, jamais l'information.
  const html = renderGraphique({
    cle: 'cpu', titre: 'Réseau', serie: [point('a', 2), point('b', 3)],
    format: (v) => `${v} Mbit/s`, reference: 100, referenceNom: 'Plafond' });
  assert.match(html, /Plafond : 100 Mbit\/s/);
  assert.match(html, /hors du cadre/);
  assert.doesNotMatch(html, /graphique__reference/);
});

test('dans le cadre, la référence est tracée et n’est PAS dite hors cadre', () => {
  const html = renderGraphique({
    cle: 'cpu', titre: 'CPU', serie: [point('a', 1), point('b', 2)],
    format: CPU, reference: 3, referenceNom: 'Réservation' });
  assert.match(html, /graphique__reference/);
  assert.doesNotMatch(html, /hors du cadre/);
});

test('une série entièrement nulle garde une échelle utilisable', () => {
  assert.equal(borneHaute([point('a', 0)], 'cpu', null), 1);
});

test('une série sans aucune valeur n’a pas d’échelle du tout', () => {
  assert.equal(borneHaute([point('a', null)], 'cpu', null), null);
});

/* ------------------------------------------------------------ la graduation */

test('la courbe porte son ÉCHELLE : sans elle, un pic ne vaut rien', () => {
  // SIGNALÉ le 2026-09-08 : une courbe montrait des pics et chaque lecture
  // disait zéro. Sans graduation, rien ne permettait de trancher entre « la
  // mesure est nulle » et « l'écriture l'a écrasée ».
  const html = renderGraphique({
    cle: 'cpu', titre: 'Processeur', serie: [point('a', 0.0041), point('b', 0.0012)],
    format: (v) => `${formatCpu(v)} CPU` });
  assert.match(html, /class="graphique__echelle"/);
  // Le sommet est un PALIER — 0,005 pour un pic à 0,0041 —, et il s'écrit avec
  // assez de décimales pour ne pas devenir « 0,01 », soit le double.
  assert.match(html, /0,0050 CPU/);
  // Le bas est un zéro NU : « 0,00 CPU » sous « 0,0050 CPU » juxtaposerait deux
  // précisions sur un même axe.
  assert.match(html, /<span>0<\/span>/);
  // Une médiane CHIFFRÉE aurait le même défaut : elle peut tomber de l'autre
  // côté du seuil de précision de son sommet. Le trait reste, le chiffre non.
  assert.match(html, /graphique__grille/);
  // La médiane rattache l'étiquette du milieu à un trait.
  assert.match(html, /graphique__grille/);
});

test('la graduation est MASQUÉE aux lecteurs d’écran, qui ont le tableau', () => {
  const html = renderGraphique({ cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU });
  assert.match(html, /<div class="graphique__echelle" aria-hidden="true">/);
});

test('le sommet est un PALIER, pour que l’échelle ne saute pas', () => {
  // Bornée à la mesure la plus haute plus 8 %, l'échelle changeait à chaque
  // rafraîchissement et la courbe entière se déformait toutes les quinze
  // secondes sans qu'aucune consommation n'ait bougé.
  assert.equal(palier(0.0041), 0.005);
  assert.equal(palier(0.0044), 0.005);   // même palier : l'échelle ne bouge pas
  assert.equal(palier(1.3), 2);
  assert.equal(palier(7), 10);
  assert.equal(palier(0), 1);
  // Deux relevés voisins d'une même série tiennent sur la MÊME échelle.
  const a = borneHaute([point('x', 0.0041)], 'cpu', null);
  const b = borneHaute([point('x', 0.0044)], 'cpu', null);
  assert.equal(a, b);
});

/* ----------------------------------------------- burst, légende, référence */

test('le burst est un aplat, et il est NOMMÉ dans la légende', () => {
  // SPK-DS-02 : au-delà de la réservation, c'est un usage optimal de la machine.
  const html = renderGraphique({
    cle: 'cpu', titre: 'Processeur', serie: [point('a', 1.9), point('b', 1.5)],
    format: CPU, reference: 0.5, referenceNom: 'Réservation', burst: true });
  assert.match(html, /graphique__burst/);
  assert.match(html, /Burst/);
  // Et surtout : aucune couleur de danger. Un dépassement n'existe qu'en mode
  // plafonné, et ce Spark ne l'est pas.
  assert.doesNotMatch(html, /danger/);
});

test('sans référence, aucun aplat de burst n’est peint', () => {
  const html = renderGraphique({
    cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU, reference: null, burst: true });
  assert.doesNotMatch(html, /graphique__burst/);
  assert.match(html, /Aucune référence connue/);
});

test('la référence est TRACÉE et NOMMÉE avec sa valeur', () => {
  // Un trait sans légende n'est pas un référentiel, et une courbe sans
  // référentiel est un chiffre faux (SPK-DS-05).
  const html = renderGraphique({
    cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU,
    reference: 0.5, referenceNom: 'Réservation' });
  assert.match(html, /graphique__reference/);
  assert.match(html, /Réservation : 0\.50 CPU/);
});

test('l’intitulé et la valeur courante sont écrits en toutes lettres', () => {
  // §1.5 : un graphique lu en niveaux de gris reste complet.
  const html = renderGraphique({ cle: 'cpu', titre: 'Processeur', serie: SERIE, format: CPU });
  assert.match(html, /Processeur/);
  assert.match(html, /0\.80 CPU/);
});

test('la valeur courante est celle du dernier point MESURÉ, pas du dernier seau', () => {
  const finTrouee = [...SERIE, point('2026-09-07T12:01:00+00:00', null)];
  assert.equal(dernierPoint(finTrouee, 'cpu').valeur, 0.8);
  assert.match(renderGraphique({ cle: 'cpu', titre: 'CPU', serie: finTrouee, format: CPU }),
               /0\.80 CPU/);
});

/* ----------------------------------------------------------- accessibilité */

test('le SVG est décoratif, et la donnée est AUSSI rendue en tableau', () => {
  // §9.2 : un graphique inaccessible au lecteur d'écran n'est pas terminé.
  const html = renderGraphique({ cle: 'cpu', titre: 'Processeur', serie: SERIE, format: CPU });
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /<div class="graphique__donnees"><table>/);
  assert.match(html, /<caption>Processeur, point par point<\/caption>/);
});

test('le tableau de données est MASQUÉ par son enveloppe, pas par lui-même', () => {
  // MESURÉ le 2026-09-07 : porté par le `<table>`, le masquage ne masquait rien
  // — `height` n'est qu'un minimum sur une table, et la page atteignait
  // 10 556 px de haut. Seule la capture l'a montré ; aucune preuve de rendu ne
  // pouvait l'attraper, car la classe ÉTAIT bien écrite.
  const html = renderGraphique({ cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU });
  assert.match(html, /<div class="graphique__donnees"><table><caption>/);
  assert.doesNotMatch(html, /<table class="graphique__donnees"/);
});

test('un seau non mesuré est NOMMÉ dans le tableau, jamais laissé vide', () => {
  const html = renderGraphique({ cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU });
  assert.match(html, /aucun relevé/);
});

test('le cadre est atteignable au clavier et annonce ce que les flèches font', () => {
  const html = renderGraphique({ cle: 'cpu', titre: 'Processeur', serie: SERIE, format: CPU });
  assert.match(html, /tabindex="0"/);
  assert.match(html, /parcourir les points avec les flèches/);
});

test('la lecture d’un seau visé s’affiche SOUS le tracé, pas dans une bulle', () => {
  // Une info-bulle flottante ne se vise pas au clavier (§9.1).
  const html = renderGraphique({
    cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU, curseur: 1 });
  assert.match(html, /graphique__curseur/);
  assert.match(html, /class="graphique__lecture" role="status"/);
  assert.match(html, /0\.40 CPU/);
});

test('viser un seau NON MESURÉ le dit, au lieu d’afficher un blanc', () => {
  const html = renderGraphique({
    cle: 'cpu', titre: 'CPU', serie: SERIE, format: CPU, curseur: 2 });
  assert.match(html, /aucun relevé/);
});

test('un seau formé de plusieurs relevés annonce que c’est une MOYENNE', () => {
  // §52.6 : une moyenne sur un point et une moyenne sur quarante ne valent pas
  // la même chose.
  const groupe = [{ at: 'a', cpu: 0.5, samples: 40, states: ['running'] }];
  const html = renderGraphique({
    cle: 'cpu', titre: 'CPU', serie: groupe, format: CPU, curseur: 0 });
  assert.match(html, /moyenne de 40 relevés/);
});

/* -------------------------------------------------------- la micro-courbe */

test('la micro-courbe suit la MÊME règle sur les trous', () => {
  const html = renderMicroCourbe(SERIE, 'cpu', { titre: 'CPU de helo' });
  assert.equal((html.match(/<polyline/g) || []).length, 1);
  assert.match(html, /<circle/);
  assert.match(html, /aria-label="CPU de helo"/);
});

test('une micro-courbe sans mesure NOMME l’absence', () => {
  const html = renderMicroCourbe([point('a', null)], 'cpu', { titre: 'CPU de helo' });
  assert.match(html, /aucune mesure/);
  assert.doesNotMatch(html, /<polyline/);
});
