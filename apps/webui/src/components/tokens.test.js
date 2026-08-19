/**
 * @verifies docs/DESIGN_SYSTEM.md §2.6, §12.5, §14.6, §14.7 ·
 *           docs/DESIGN_SYSTEM_APP.md §4
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPARK_STATES, stateOf, formatBytes, formatBps, formatCpu, MEASURE } from './tokens.js';

test('les huit etats du modele sont couverts', () => {
  // docs/SCHEMA.md §4 : un etat non couvert tomberait dans le repli sans qu'on
  // s'en apercoive.
  for (const etat of ['pending', 'creating', 'stopped', 'starting', 'running',
                      'stopping', 'error', 'deleting']) {
    assert.ok(SPARK_STATES[etat], `${etat} doit avoir une correspondance`);
  }
});

test('les etats transitoires sont marques comme tels', () => {
  for (const etat of ['creating', 'starting', 'stopping', 'deleting'])
    assert.equal(SPARK_STATES[etat].transient, true);
  for (const etat of ['running', 'stopped', 'pending', 'error'])
    assert.equal(SPARK_STATES[etat].transient, false);
});

test('une valeur inconnue recoit un repli, jamais undefined', () => {
  // docs/DESIGN_SYSTEM.md §14.7
  const inconnu = stateOf('zombie');
  assert.equal(inconnu.token, 'neutral');
  assert.match(inconnu.label, /inconnu/);
  assert.ok(!inconnu.label.includes('undefined'));
  assert.match(stateOf(undefined).label, /inconnu/);
});

test('null n est jamais formate en zero', () => {
  // docs/DESIGN_SYSTEM.md §14.6 — zero et « on ne sait pas » sont distincts.
  assert.equal(formatBytes(null), null);
  assert.equal(formatBps(null), null);
  assert.equal(formatCpu(null), null);
  assert.equal(formatBytes(0), '0 o');
  assert.equal(formatCpu(0), '0,00');
});

test('les octets sont lisibles', () => {
  assert.equal(formatBytes(2 * 1024 ** 3), '2,0 Gio');
  assert.equal(formatBytes(534981632), '510 Mio');
});

test('les debits sont lisibles', () => {
  assert.equal(formatBps(100_000_000), '100 Mbit/s');
  assert.equal(formatBps(1_000_000_000), '1,0 Gbit/s');
});

test('le separateur decimal est la virgule, pas le point', () => {
  // Le produit est entierement francophone : « 2.0 Gio » est un anglicisme.
  assert.equal(formatCpu(1.996), '2,00');
  assert.equal(formatCpu(0.5), '0,50');
  assert.ok(!formatBytes(2 * 1024 ** 3).includes('.'));
});

test('la precision du CPU est fixe', () => {
  // « 2.0 sur 0.50 » juxtaposait deux precisions dans une meme phrase.
  assert.equal(formatCpu(2).length, formatCpu(0.5).length);
});

test('les trois absences de mesure ont des textes distincts', () => {
  const textes = Object.values(MEASURE);
  assert.equal(new Set(textes).size, textes.length);
  for (const t of textes) assert.ok(t.length > 0);
});

// --- un Spark declare n'est pas un Spark en cours de mesure (§14.6) ---------

test('les quatre absences de mesure portent des textes DISTINCTS', () => {
  const textes = Object.values(MEASURE);
  assert.equal(new Set(textes).size, textes.length,
    'confondre deux situations les rendrait indiscernables a l’ecran');
  assert.match(MEASURE.declared, /rien à mesurer/);
});
