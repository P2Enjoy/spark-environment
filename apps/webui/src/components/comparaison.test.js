/**
 * @verifies docs/BACKLOG.md#SPK-131 · docs/DAT.md §55.9.3 (comment les textes
 *           s'alignent, la borne, ce que l'écran montre, les quatre états
 *           nommés) · docs/DESIGN_SYSTEM.md §6.29 (comparer deux versions d'un
 *           texte), §1.5 (jamais la couleur seule), §14.3 (le repli reste en
 *           place) · docs/DESIGN_SYSTEM_APP.md SPK-DS-27
 *
 * Deux choses à tenir, et elles ne se prouvent pas de la même façon :
 *
 * - l'alignement est JUSTE et le plus COURT — prouvé par une propriété, sur des
 *   suites tirées au hasard avec une graine fixe, contre une plus longue
 *   sous-suite commune calculée à part. Quelques exemples choisis à la main ne
 *   trouvent pas l'erreur d'indice qui ne frappe qu'une diagonale sur dix ;
 * - l'écran ne dit jamais un changement par la seule couleur, et le repli ne
 *   perd pas le focus — prouvé sur le HTML rendu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORNE, aligner, apparier, comparer, libellePli, lignes, marquerMots,
  phraseCompte, plier, renderComparaison,
} from './comparaison.js';

/** Rejoue un script : il doit redonner les DEUX suites, dans l'ordre. */
function rejouer(ops, a, b) {
  const gauche = [];
  const droite = [];
  for (const op of ops) {
    if (op.type === 'egal') {
      assert.equal(a[op.a], b[op.b], `« égal » sur deux lignes différentes : ${op.a}/${op.b}`);
      gauche.push(a[op.a]);
      droite.push(b[op.b]);
    } else if (op.type === 'retire') gauche.push(a[op.a]);
    else droite.push(b[op.b]);
  }
  assert.deepEqual(gauche, a, 'le script ne redonne pas le texte actuel');
  assert.deepEqual(droite, b, 'le script ne redonne pas la version proposée');
}

/** La longueur de la plus longue sous-suite commune, par programmation dynamique. */
function lcs(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
    }
  }
  return t[a.length][b.length];
}

/** Un générateur à graine fixe : un rouge se rejoue à l'identique. */
function hasard(graine) {
  let s = graine >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// --- l'alignement -----------------------------------------------------------

test('un texte vide n’a aucune ligne, et les fins de ligne CRLF sont ramenées', () => {
  assert.deepEqual(lignes(''), []);
  assert.deepEqual(lignes(null), []);
  assert.deepEqual(lignes('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
  // Une ligne vide AU MILIEU reste une ligne : c'est un paragraphe Markdown.
  assert.deepEqual(lignes('a\n\nb'), ['a', '', 'b']);
});

test('deux textes identiques ne portent que des lignes identiques', () => {
  const a = ['# Titre', '', 'Texte.'];
  const { ops, depasse } = aligner(a, [...a]);
  assert.equal(depasse, false);
  assert.deepEqual(ops.map((o) => o.type), ['egal', 'egal', 'egal']);
});

test('une ligne ajoutée au milieu est UNE ligne ajoutée, pas un remplacement', () => {
  const a = ['un', 'deux', 'trois'];
  const b = ['un', 'nouvelle', 'deux', 'trois'];
  const { ops } = aligner(a, b);
  assert.deepEqual(ops.map((o) => o.type), ['egal', 'ajoute', 'egal', 'egal']);
  rejouer(ops, a, b);
});

test('une ligne retirée au milieu est UNE ligne retirée', () => {
  const a = ['un', 'deux', 'trois', 'quatre'];
  const b = ['un', 'trois', 'quatre'];
  const { ops } = aligner(a, b);
  assert.deepEqual(ops.map((o) => o.type), ['egal', 'retire', 'egal', 'egal']);
  rejouer(ops, a, b);
});

test('PROPRIÉTÉ : sur 400 couples tirés au hasard, le script est juste et le plus court', () => {
  // Un alphabet de quatre lignes fait naître beaucoup de lignes communes, donc
  // beaucoup de chemins possibles : c'est là qu'un alignement non minimal se
  // trahit. La graine est fixe — un rouge se rejoue.
  const tirer = hasard(20260930);
  const suite = () => Array.from({ length: Math.floor(tirer() * 14) },
    () => 'abcd'[Math.floor(tirer() * 4)]);
  for (let essai = 0; essai < 400; essai += 1) {
    const a = suite();
    const b = suite();
    const { ops, depasse } = aligner(a, b);
    assert.equal(depasse, false);
    rejouer(ops, a, b);
    assert.equal(ops.filter((o) => o.type === 'egal').length, lcs(a, b),
      `alignement non minimal pour ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
});

test('au-delà de la borne, le script reste JUSTE, mais le dit : tout retiré, tout ajouté', () => {
  const a = ['début', 'a1', 'a2', 'a3', 'fin'];
  const b = ['début', 'b1', 'b2', 'b3', 'fin'];
  const { ops, depasse } = aligner(a, b, 2);
  assert.equal(depasse, true);
  rejouer(ops, a, b);
  // Le début et la fin communs restent alignés : ils ne comptent pas dans la borne.
  assert.deepEqual(ops.map((o) => o.type),
    ['egal', 'retire', 'retire', 'retire', 'ajoute', 'ajoute', 'ajoute', 'egal']);
});

test('une note de 64 Kio réécrite en entier atteint la borne, et le rendu reste juste', () => {
  // §55.9.3 : la borne n'existe que pour ce cas. Deux textes sans aucune ligne
  // commune demanderaient 3 200 pas de Myers et une trace de dix millions de cases.
  const a = Array.from({ length: 1600 }, (_, i) => `ancienne ligne ${i} ${'x'.repeat(24)}`);
  const b = Array.from({ length: 1600 }, (_, i) => `nouvelle ligne ${i} ${'y'.repeat(24)}`);
  const modele = comparer(a.join('\n'), b.join('\n'));
  assert.equal(modele.depasse, true);
  assert.deepEqual(modele.compte, { retirees: 1600, ajoutees: 1600, identiques: 0 });
  assert.ok(BORNE < a.length + b.length);
});

test('un README de 1 600 lignes où trois lignes changent s’aligne exactement', () => {
  const a = Array.from({ length: 1600 }, (_, i) => `ligne ${i}`);
  const b = [...a];
  b[10] = 'ligne 10 corrigée';
  b.splice(800, 0, 'ligne insérée');
  b.splice(1500, 1);
  const { ops, depasse } = aligner(a, b);
  assert.equal(depasse, false);
  rejouer(ops, a, b);
  assert.equal(ops.filter((o) => o.type === 'retire').length, 2);
  assert.equal(ops.filter((o) => o.type === 'ajoute').length, 2);
});

// --- l'appariement et les mots -----------------------------------------------

test('dans un bloc, la n-ième retirée fait face à la n-ième ajoutée ; le surplus, à une case vide', () => {
  const a = ['garde', 'r1', 'r2', 'r3', 'fin'];
  const b = ['garde', 'n1', 'fin'];
  const rangs = apparier(aligner(a, b).ops, a, b);
  assert.deepEqual(rangs.map((r) => r.nature), ['egal', 'modifie', 'retire', 'retire', 'egal']);
  assert.deepEqual([rangs[1].gauche.texte, rangs[1].droite.texte], ['r1', 'n1']);
  assert.equal(rangs[2].droite, null);
  // Les numéros sont ceux de CHAQUE texte : « fin » est la ligne 5 à gauche, 3 à droite.
  assert.deepEqual([rangs[4].gauche.numero, rangs[4].droite.numero], [5, 3]);
});

test('les mots changés d’une ligne remplacée sont marqués, et seulement eux', () => {
  const mots = marquerMots('- API REST : `https://crm.interne.example/api/v1`',
                           '- API REST : `https://crm.lelabs.example/api/v2`');
  // Un mot est une suite de lettres et de chiffres : « v1 » change en entier.
  assert.deepEqual(mots.gauche.filter((m) => m.change).map((m) => m.texte), ['interne', 'v1']);
  assert.deepEqual(mots.droite.filter((m) => m.change).map((m) => m.texte), ['lelabs', 'v2']);
  // Et les morceaux redonnent chaque ligne, lettre pour lettre.
  assert.equal(mots.gauche.map((m) => m.texte).join(''),
    '- API REST : `https://crm.interne.example/api/v1`');
});

test('deux lignes sans AUCUN mot commun ne se marquent pas : tout y a changé', () => {
  assert.equal(marquerMots('Sauvegardes quotidiennes', 'Pile Compose'), null);
  // Des blancs en commun ne font pas un mot en commun.
  assert.equal(marquerMots('a b', 'c d'), null);
});

// --- les replis ---------------------------------------------------------------

const texte = (n, remplace = {}) => Array.from({ length: n },
  (_, i) => remplace[i + 1] ?? `ligne ${i + 1}`).join('\n');

test('trois lignes de contexte autour d’un changement, le reste replié', () => {
  // Vingt lignes, la dixième change : 1-6 et 14-20 se replient.
  const { blocs } = comparer(texte(20), texte(20, { 10: 'dix, corrigée' }));
  assert.deepEqual(blocs.map((b) => b.type), ['pli', 'rangs', 'pli']);
  assert.deepEqual(blocs[0].rangs.map((r) => r.gauche.numero), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(blocs[1].rangs.map((r) => r.gauche.numero), [7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(blocs[2].rangs.map((r) => r.gauche.numero), [14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(blocs.filter((b) => b.type === 'pli').map((b) => b.index), [0, 1]);
});

test('un repli qui cacherait moins de quatre lignes n’est pas fait', () => {
  // Entre deux changements : 3 de contexte + 3 cachées + 3 de contexte = 9.
  const neuf = comparer(texte(11), texte(11, { 1: 'un', 11: 'onze' }));
  assert.ok(!neuf.blocs.some((b) => b.type === 'pli'));
  // Dix lignes entre les deux : quatre se cachent.
  const dix = comparer(texte(12), texte(12, { 1: 'un', 12: 'douze' }));
  assert.deepEqual(dix.blocs.filter((b) => b.type === 'pli').map((b) => b.rangs.length), [4]);
});

test('un texte identique en entier se replie tout entier, et se nomme', () => {
  const modele = comparer(texte(10), texte(10));
  assert.equal(modele.identique, true);
  assert.deepEqual(modele.blocs.map((b) => b.type), ['pli']);
  // Trop court pour un repli : on le montre.
  assert.deepEqual(comparer(texte(3), texte(3)).blocs.map((b) => b.type), ['rangs']);
});

test('le libellé d’un repli compte et situe, dans les deux textes quand ils diffèrent', () => {
  const memes = comparer(texte(20), texte(20, { 10: 'x' })).blocs[2];
  assert.equal(libellePli(memes, false), 'Afficher 7 lignes identiques (lignes 14 à 20)');
  assert.equal(libellePli(memes, true), 'Masquer 7 lignes identiques (lignes 14 à 20)');
  // Une ligne ajoutée plus haut décale la suite dans la version proposée.
  const decale = comparer(texte(20), `nouvelle\n${texte(20)}`).blocs[1];
  assert.equal(libellePli(decale, false),
    'Afficher 17 lignes identiques (lignes 4 à 20, 5 à 21 dans la version proposée)');
});

// --- le compte et les états --------------------------------------------------

test('le compte s’accorde : 0 et 1 au singulier, au-delà au pluriel', () => {
  assert.equal(phraseCompte({ retirees: 0, ajoutees: 1, identiques: 31 }),
    '0 ligne retirée, 1 ajoutée, 31 identiques');
  assert.equal(phraseCompte({ retirees: 3, ajoutees: 5, identiques: 1 }),
    '3 lignes retirées, 5 ajoutées, 1 identique');
});

test('les quatre états se reconnaissent au modèle', () => {
  const jamais = comparer('', '# Intégrer\n\nAPI');
  assert.equal(jamais.avantVide, true);
  assert.deepEqual(jamais.compte, { retirees: 0, ajoutees: 3, identiques: 0 });
  assert.equal(comparer('a\nb', 'a\nb').identique, true);
  const vide = comparer('a\nb', '');
  assert.equal(vide.apresVide, true);
  assert.deepEqual(vide.compte, { retirees: 2, ajoutees: 0, identiques: 0 });
  assert.equal(comparer('a\nb', 'c\nd', { borne: 1 }).depasse, true);
});

// --- le rendu ------------------------------------------------------------------

const RENDU = {
  id: 'readme', cle: 'readme:2:abc', sujet: 'README.md',
  titreAvant: 'Texte actuel · révision 2', titreApres: 'Version proposée',
};

test('le rendu porte la MÊME comparaison en deux colonnes et en une', () => {
  const html = renderComparaison({ ...RENDU, avant: 'a\nb\nc', apres: 'a\nB\nc' });
  assert.match(html, /<table class="comparaison__table comparaison__deux"/);
  assert.match(html, /<table class="comparaison__table comparaison__une"/);
  assert.match(html, /<th scope="col" colspan="2">Texte actuel · révision 2<\/th>/);
  assert.match(html, /<th scope="col" colspan="2">Version proposée<\/th>/);
  assert.match(html, /<caption class="sr-only">README\.md : Texte actuel · révision 2 et Version proposée, côte à côte<\/caption>/);
  assert.match(html, /<p class="comparaison__compte" id="comparaison-readme-compte">1 ligne retirée, 1 ajoutée, 2 identiques<\/p>/);
  assert.match(html, /data-comparaison-cle="readme:2:abc"/);
});

test('un changement ne se dit jamais par la seule couleur : un signe, et un mot pour la synthèse', () => {
  const html = renderComparaison({ ...RENDU, avant: 'garde\nancienne', apres: 'garde\nnouvelle' });
  assert.match(html, /<span class="comparaison__signe" aria-hidden="true">−<\/span><span class="sr-only">retirée : <\/span>ancienne/);
  assert.match(html, /<span class="comparaison__signe" aria-hidden="true">\+<\/span><span class="sr-only">ajoutée : <\/span>nouvelle/);
  // En une colonne, la retirée précède celle qui la remplace.
  const une = html.slice(html.indexOf('comparaison__une'));
  assert.ok(une.indexOf('retirée : </span>ancienne') < une.indexOf('ajoutée : </span>nouvelle'));
});

test('les mots changés sont des del et des ins', () => {
  const html = renderComparaison({ ...RENDU,
    avant: 'Port : 8080, en clair', apres: 'Port : 8443, en clair' });
  assert.match(html, /Port : <del>8080<\/del>, en clair/);
  assert.match(html, /Port : <ins>8443<\/ins>, en clair/);
});

test('le texte comparé est ÉCHAPPÉ : une note n’injecte rien dans la console', () => {
  const html = renderComparaison({ ...RENDU, avant: '', apres: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'), 'du HTML de la proposition a atteint la page');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('une cellule de texte tient sur une ligne : un retour du gabarit s’y peindrait', () => {
  const html = renderComparaison({ ...RENDU, avant: texte(12), apres: texte(12, { 6: 'six' }) });
  const cellules = html.match(/<td class="comparaison__texte[^"]*">[\s\S]*?<\/td>/g);
  assert.ok(cellules.length > 0);
  for (const cellule of cellules) assert.ok(!cellule.includes('\n'), cellule);
});

test('un repli est un bouton qui compte, contrôle ses lignes cachées, et reste en place', () => {
  const html = renderComparaison({ ...RENDU, avant: texte(20), apres: texte(20, { 10: 'x' }) });
  assert.match(html, /aria-expanded="false"\s+aria-controls="comparaison-readme-deux-pli-0"/);
  assert.match(html, /<tbody id="comparaison-readme-deux-pli-0" data-comparaison-lignes="0" hidden>/);
  assert.match(html, />Afficher 6 lignes identiques \(lignes 1 à 6\)<\/button>/);
  // Les deux libellés voyagent avec le bouton : le déplier ne repeint rien.
  assert.match(html, /data-libelle-masquer="Masquer 6 lignes identiques \(lignes 1 à 6\)"/);
  // La vue en une colonne a ses propres identifiants.
  assert.match(html, /aria-controls="comparaison-readme-une-pli-0"/);
});

test('un repli déplié le reste à la repeinture suivante', () => {
  const html = renderComparaison({ ...RENDU, avant: texte(20), apres: texte(20, { 10: 'x' }),
                                   deplies: new Set([1]) });
  assert.match(html, /aria-expanded="true"\s+aria-controls="comparaison-readme-deux-pli-1"/);
  assert.match(html, /<tbody id="comparaison-readme-deux-pli-1" data-comparaison-lignes="1">/);
  assert.match(html, />Masquer 7 lignes identiques \(lignes 14 à 20\)<\/button>/);
  assert.match(html, /<tbody id="comparaison-readme-deux-pli-0" data-comparaison-lignes="0" hidden>/);
});

test('les états se NOMMENT au-dessus de la comparaison', () => {
  const jamais = renderComparaison({ ...RENDU, avant: '', apres: 'Texte',
    avantAbsent: 'Personne n’a encore écrit cette note : tout le texte proposé est nouveau.' });
  assert.match(jamais, /<p class="absence">Personne n’a encore écrit cette note/);

  assert.match(renderComparaison({ ...RENDU, avant: 'a', apres: 'a' }),
    /est <strong>identique<\/strong> au\s+texte actuel : l’accepter ne changerait pas le texte/);
  assert.match(renderComparaison({ ...RENDU, avant: 'a', apres: '' }),
    /<strong>La version proposée est vide<\/strong> :\s+l’accepter effacerait ce texte/);
  // Un texte actuel vide et une proposition vide ne se disent pas « identiques ».
  assert.doesNotMatch(renderComparaison({ ...RENDU, avant: '', apres: '' }), /identique<\/strong>/);
});

test('au-delà de la borne, l’écran le dit', () => {
  const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n');
  assert.match(renderComparaison({ ...RENDU, avant: a, apres: b }),
    /Les deux textes diffèrent trop pour être alignés\s+ligne à ligne/);
});
