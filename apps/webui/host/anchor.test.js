/**
 * @verifies docs/BACKLOG.md#SPK-38 · docs/DAT.md §36.1 (ce que la chaîne ne
 *           prouve pas), §36.2 (l'ancre), §36.9.6 (les cinq verdicts)
 *
 * Ce fichier éprouve exactement ce que `test_journal_chaine.py` DOCUMENTE comme
 * hors de portée de la chaîne : la troncature et le remplacement. C'est le sens
 * du §36.2 — la garantie ne vient pas de la cryptographie, mais du fait que la
 * référence vive ailleurs que sur la machine qu'on soupçonne.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  juger, confronter, FIRST, EXTENDS, UNCHANGED, SHRUNK, DIVERGED, ALERTES,
} from './anchor.js';

const releve = (head, length) => ({ head, length, verified_at: '2026-08-19T10:00:00' });

// --- les cinq verdicts (§36.9.6) -------------------------------------------

test('sans référence, on POSE l’ancre et on ne juge pas', () => {
  assert.equal(juger(null, releve('a', 1)), FIRST);
  assert.equal(juger({ head: null }, releve('a', 1)), FIRST);
});

test('une histoire qui contient la tête connue la PROLONGE', () => {
  assert.equal(juger({ head: 'a', length: 3 }, releve('d', 6), true), EXTENDS);
});

test('même tête et même longueur : rien n’a été écrit depuis', () => {
  assert.equal(juger({ head: 'a', length: 3 }, releve('a', 3), true), UNCHANGED);
});

test('une longueur en RECUL est une troncature, que la chaîne ne voit pas', () => {
  // C'est l'attaque que `test_UNE_TRONCATURE_N_EST_PAS_DETECTEE` documente côté
  // serveur : ce qui reste après la coupe est une chaîne parfaitement valide.
  assert.equal(juger({ head: 'e', length: 5 }, releve('c', 3), true), SHRUNK);
});

test('une tête connue INTROUVABLE est un remplacement', () => {
  // Un journal neuf et cohérent : la chaîne le valide, l'ancre le refuse.
  assert.equal(juger({ head: 'a', length: 3 }, releve('z', 9), false), DIVERGED);
});

test('le RECUL prime, et il se juge SANS croire l’hôte', () => {
  // Un serveur hostile ment sur ce qu'il contient — donc sur `contient`. Il ne
  // peut pas mentir sur le fait d'en avoir moins qu'avant, et c'est pourquoi ce
  // verdict est rendu en premier.
  assert.equal(juger({ head: 'e', length: 9 }, releve('x', 2), false), SHRUNK);
  assert.equal(juger({ head: 'e', length: 9 }, releve('x', 2), true), SHRUNK);
});

// --- ce que l'ancre fait de son verdict -------------------------------------

test('l’ancre n’est PAS écrasée sur une alerte', () => {
  // Écraser la référence effacerait la preuve avec le signal : au relevé
  // suivant, tout paraîtrait normal (§36.9.6).
  const connues = { prod: { head: 'e', length: 5, seenAt: 'hier' } };
  for (const tronque of [releve('c', 3), releve('z', 9)]) {
    const bilan = confronter(connues, 'prod', tronque, false);
    assert.ok(ALERTES.includes(bilan.verdict));
    assert.equal(bilan.alert, true);
    assert.deepEqual(bilan.anchors.prod, connues.prod, 'la référence est CONSERVÉE');
  }
});

test('l’ancre est mise à jour sur les verdicts sains', () => {
  const bilan = confronter({ prod: { head: 'a', length: 3 } }, 'prod', releve('d', 6), true);
  assert.equal(bilan.verdict, EXTENDS);
  assert.equal(bilan.alert, false);
  assert.deepEqual(bilan.anchors.prod,
                   { head: 'd', length: 6, seenAt: '2026-08-19T10:00:00' });
});

test('chaque serveur porte SA référence, et une alerte n’atteint pas les autres', () => {
  const connues = { prod: { head: 'e', length: 5 }, recette: { head: 'r', length: 2 } };
  const bilan = confronter(connues, 'prod', releve('c', 1), false);
  assert.equal(bilan.verdict, SHRUNK);
  assert.deepEqual(bilan.anchors.recette, connues.recette);
});

test('le bilan porte ce qu’on avait vu ET ce qui est annoncé', () => {
  // Sans les deux, l'exploitant ne peut pas juger : « rompu » sans les chiffres
  // n'est pas un diagnostic.
  const bilan = confronter({ prod: { head: 'e', length: 5 } }, 'prod', releve('c', 3), true);
  assert.deepEqual(bilan.known, { head: 'e', length: 5 });
  assert.deepEqual(bilan.announced, { head: 'c', length: 3 });
  assert.match(bilan.explanation, /RACCOURCI/);
});

test('un premier relevé sur un journal VIDE ne fabrique pas de fausse alerte', () => {
  const bilan = confronter({}, 'neuf', { head: null, length: 0 }, false);
  assert.equal(bilan.verdict, FIRST);
  assert.equal(bilan.alert, false);
  assert.deepEqual(bilan.anchors.neuf, { head: null, length: 0, seenAt: null });
});
