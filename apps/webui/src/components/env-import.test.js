/**
 * @verifies docs/BACKLOG.md#SPK-97 · docs/DAT.md §43.10 (coller un lot),
 *           §43.10.1 (la grammaire lue et ses trois refus), §43.10.2 (le secret
 *           reste DÉCLARÉ), §43.9.7 (l'encodage dont l'analyseur est l'inverse),
 *           §43.9.4 (masquer n'est pas remplacer) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-23 · docs/DESIGN_SYSTEM.md §9.9,
 *           §14.5
 *
 * Ce que ces preuves gardent en propre : **rien n'est jeté en silence.** Une
 * ligne refusée, une ligne supplantée et une ligne qui remplace une valeur
 * existante se rendent toutes les trois à l'écran. Un import qui écrit
 * trente-sept lignes sur quarante sans le dire est le défaut que l'unité
 * cherche à éviter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyser, decrireEffet, lireValeur, renderImportEnv, IMPORT_VIDE }
  from './env-import.js';
import { renderModale } from './modale.js';

const relire = (lu, extra = {}) => ({
  ...IMPORT_VIDE, open: 'spark', pas: 'relire',
  lignes: lu.entrees, refus: lu.refus, supplantees: lu.supplantees, ...extra,
});

// --- la grammaire lue (§43.10.1) --------------------------------------------

test('une ligne « NOM=valeur » se lit, avec « export » et sans lui', () => {
  const lu = analyser('SMTP_HOST=mail.exemple.fr\nexport SMTP_PORT=587');
  assert.deepEqual(lu.entrees.map((e) => [e.nom, e.valeur]),
                   [['SMTP_HOST', 'mail.exemple.fr'], ['SMTP_PORT', '587']]);
  assert.deepEqual(lu.refus, []);
});

test('les lignes vides et les commentaires sont ignorés, pas refusés', () => {
  const lu = analyser('# un commentaire\n\n   \nA=1\n');
  assert.equal(lu.entrees.length, 1);
  assert.deepEqual(lu.refus, [], 'ignorer n’est pas refuser : rien à signaler');
});

test('un « # » en MILIEU de ligne appartient à la valeur', () => {
  // §43.10.1 : l'idiome « valeur # commentaire » couperait un mot de passe en
  // deux, sans rien dire. C'est le refus le plus facile à « corriger » par
  // erreur plus tard : la preuve est donc explicite.
  assert.equal(analyser('PASSWORD=p@ss#word').entrees[0].valeur, 'p@ss#word');
});

test('aucune substitution : « $B » vaut littéralement « $B »', () => {
  assert.equal(analyser('A=$B').entrees[0].valeur, '$B');
});

test('les blancs de bord d’une valeur NON citée sont rognés, ceux d’une citée non', () => {
  assert.equal(analyser('A=  ab  ').entrees[0].valeur, 'ab');
  assert.equal(analyser('A="  ab  "').entrees[0].valeur, '  ab  ');
});

test('une valeur VIDE est une valeur, et elle est lue', () => {
  const lu = analyser('A=');
  assert.equal(lu.entrees.length, 1);
  assert.equal(lu.entrees[0].valeur, '');
});

test('les apostrophes simples rendent un contenu LITTÉRAL', () => {
  assert.equal(analyser("A='ab$cd\\n'").entrees[0].valeur, 'ab$cd\\n');
});

/**
 * L'inverse EXACT de `citer()` (§43.9.7).
 *
 * Les lignes de droite sont celles que le produit écrit lui-même dans
 * `/etc/spark/env` — le tableau mesuré du §43.9.7. `test_env_import.py` épingle
 * les mêmes littéraux côté Forge : si l'encodage change d'un côté, l'un des deux
 * fichiers rougit. Sans cette symétrie, le fichier posé par le produit serait la
 * seule chose qu'on ne peut pas lui redonner.
 */
test('une valeur relevée dans le fichier du produit se RECOLLE à l’identique', () => {
  const ecrites = [
    ['ab\'cd', 'A="ab\'cd"'],
    ['ab$cd', 'A="ab\\$cd"'],
    ['ab"cd', 'A="ab\\"cd"'],
    ['a\\b', 'A="a\\\\b"'],
    ['  garde  ', 'A="  garde  "'],
    ['a\nb', 'A="a\\nb"'],
  ];
  for (const [valeur, ligne] of ecrites) {
    const lu = analyser(ligne);
    assert.equal(lu.refus.length, 0, `« ${ligne} » a été refusée`);
    assert.equal(lu.entrees[0].valeur, valeur, `« ${ligne} » ne redonne pas sa valeur`);
  }
});

// --- les trois refus, chacun distinct (§43.10.1) -----------------------------

test('une ligne sans « = » est refusée, avec son numéro et son texte', () => {
  const lu = analyser('A=1\nVAR2)value2');
  assert.equal(lu.entrees.length, 1);
  assert.equal(lu.refus.length, 1);
  assert.equal(lu.refus[0].ligne, 2);
  assert.equal(lu.refus[0].texte, 'VAR2)value2');
  assert.match(lu.refus[0].raison, /aucun « = »/);
});

test('un nom hors grammaire est refusé, et le refus NOMME le nom fautif', () => {
  const lu = analyser('AVEC-TIRET=1\n2_CHIFFRE=2');
  assert.equal(lu.entrees.length, 0);
  assert.equal(lu.refus.length, 2);
  assert.match(lu.refus[0].raison, /AVEC-TIRET/);
  assert.match(lu.refus[1].raison, /2_CHIFFRE/);
});

test('une valeur MULTILIGNE est refusée, et le refus dit quoi faire', () => {
  // Refuser bruyamment vaut mieux qu'accepter à moitié : une clé privée tronquée
  // en silence ne se voit qu'au démarrage de la pile (§43.10.1).
  const lu = analyser('CLE="-----BEGIN PRIVATE KEY-----');
  assert.equal(lu.entrees.length, 0);
  assert.match(lu.refus[0].raison, /multiligne/);
  assert.match(lu.refus[0].raison, /\\n/);
});

test('du texte après le guillemet fermant est refusé, pas tronqué', () => {
  const lu = analyser('A="ab" et le reste');
  assert.equal(lu.entrees.length, 0);
  assert.match(lu.refus[0].raison, /guillemet fermant/);
});

test('lireValeur rend soit une valeur, soit une RAISON, jamais les deux', () => {
  assert.deepEqual(lireValeur('  simple  '), { valeur: 'simple' });
  assert.ok(lireValeur('"ouvert').raison);
  assert.equal(lireValeur('"ouvert').valeur, undefined);
});

// --- le doublon : la dernière l'emporte, et la perdante le DIT ---------------

test('le même nom deux fois : la dernière ligne gagne, la première est signalée', () => {
  const lu = analyser('A=un\nB=x\nA=deux');
  assert.deepEqual(lu.entrees.map((e) => [e.nom, e.valeur]), [['B', 'x'], ['A', 'deux']]);
  assert.deepEqual(lu.supplantees, [{ ligne: 1, nom: 'A', gagnante: 3 }]);
});

// --- le secret est DÉCLARÉ, jamais deviné (§43.10.2) -------------------------

test('aucune ligne n’est secrète par défaut, même nommée « KEY » ou « PASSWORD »', () => {
  const lu = analyser('STRIPE_API_KEY=sk_live\nSMTP_PASSWORD=x\nDATABASE_URL=y');
  assert.deepEqual(lu.entrees.map((e) => e.secret), [false, false, false],
    'le §43.3 a mesuré que la détection par le nom échoue là où elle importe');
});

test('l’interrupteur « tout secret » pré-coche TOUTES les lignes', () => {
  const lu = analyser('A=1\nB=2', { secretParDefaut: true });
  assert.deepEqual(lu.entrees.map((e) => e.secret), [true, true]);
});

// --- ce qui arrivera à chaque nom (SPK-DS-23) --------------------------------

test('trois effets distincts : nouvelle, remplacée, masquée', () => {
  assert.equal(decrireEffet('NEUF', ['A'], ['B']).texte, 'nouvelle entrée');
  assert.equal(decrireEffet('A', ['A'], []).texte, 'remplace la valeur actuelle');
  // §43.9.4 : sur un Spark, un nom qui porte une entrée COCHÉE n'est pas
  // remplacé — il est masqué, et le dire autrement enverrait chercher la valeur
  // là où elle n'agit plus.
  assert.equal(decrireEffet('B', [], ['B']).texte, 'masque une entrée cochée');
});

// --- la modale à deux pas (SPK-DS-23) ----------------------------------------

test('le premier pas offre la zone de texte, et son engagement n’écrit rien', () => {
  const html = renderImportEnv({ portee: 'forge',
                                 ui: { ...IMPORT_VIDE, open: 'forge' }, renderModale });
  assert.match(html, /id="import-env-texte"/);
  assert.match(html, /controle--zone/);
  assert.match(html, />Analyser</);
  assert.match(html, /Rien n’est écrit à cette étape/);
});

test('le second pas nomme le COMPTE dans son engagement', () => {
  const html = renderImportEnv({ ui: relire(analyser('A=1\nB=2')), renderModale });
  assert.match(html, />Importer 2 entrées</);
});

test('un texte sans ligne exploitable garde l’action VISIBLE et désactivée (§9.9)', () => {
  const html = renderImportEnv({ ui: relire(analyser('rien du tout')), renderModale });
  assert.match(html, /disabled/);
  assert.match(html, /aucune ligne n’est exploitable/i);
  assert.match(html, /Aucune ligne exploitable dans ce texte/);
});

test('les lignes refusées sont rendues avec leur NUMÉRO et leur raison', () => {
  const html = renderImportEnv({ ui: relire(analyser('A=1\nsans egal\nB-C=2')), renderModale });
  assert.match(html, /ligne 2/);
  assert.match(html, /ligne 3/);
  assert.match(html, /aucun « = »/);
  assert.match(html, /2 lignes ne seront pas importées/);
});

test('la ligne supplantée est annoncée, et la gagnante nommée', () => {
  const html = renderImportEnv({ ui: relire(analyser('A=un\nA=deux')), renderModale });
  assert.match(html, /La ligne 1 définit « A » une première fois/);
  assert.match(html, /la ligne 2 qui l’emporte/);
});

test('une valeur VIDE se nomme au lieu de laisser une cellule blanche (§14.5)', () => {
  const html = renderImportEnv({ ui: relire(analyser('A=')), renderModale });
  assert.match(html, /valeur vide/);
});

test('la valeur reste LISIBLE au pas de relecture, secret coché ou non (§43.10.2)', () => {
  const lu = analyser('APP_KEY=sk_live_visible', { secretParDefaut: true });
  const html = renderImportEnv({ ui: relire(lu), renderModale });
  assert.match(html, /sk_live_visible/,
    'elle n’est pas encore écrite, elle vient du presse-papier, et elle est déjà '
    + 'sous les yeux dans la zone de texte');
  assert.match(html, /data-import-secret="APP_KEY"\s*\n?\s*checked/);
});

test('le remplacement s’annonce AVANT d’écrire', () => {
  const html = renderImportEnv({ ui: relire(analyser('A=1\nZ=2')),
                                 existantes: ['A'], renderModale });
  assert.match(html, /remplace la valeur actuelle/);
  assert.match(html, /nouvelle entrée/);
});

test('la confirmation des Sparks protégés reste DANS la modale et renomme l’engagement', () => {
  const html = renderImportEnv({
    ui: relire(analyser('A=1'), {
      confirming: { message: 'Importer 1 entrée touche 1 Spark protégé : boutique.',
                    protected_sparks: ['boutique'] } }),
    renderModale });
  assert.match(html, /class="confirmation"/);
  assert.match(html, /boutique/);
  assert.match(html, /Aucune protection ne sera levée/);
  assert.match(html, />Continuer malgré les protections</);
  assert.doesNotMatch(html, />Importer 1 entrée</,
    'un seul point d’engagement à la fois, et il dit ce qu’il engage');
});

test('une valeur hostile est ÉCHAPPÉE avant d’atteindre le DOM', () => {
  const html = renderImportEnv({ ui: relire(analyser('A=<script>alert(1)</script>')),
                                 renderModale });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
