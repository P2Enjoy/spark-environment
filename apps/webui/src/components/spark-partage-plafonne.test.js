/**
 * @verifies docs/BACKLOG.md#SPK-152 · docs/DAT.md §7.2 quater, §49.8 ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-41 (deux champs ; un plafond qui
 *           attend le démarrage, et son geste) · docs/DESIGN_SYSTEM.md §1.4,
 *           §6.8, §14.6
 *
 * Le cinquième mode CPU à l'écran : la saisie (création et modale), la ligne de
 * la fiche, et l'annonce du plafond qui n'est pas encore en vigueur. Les refus
 * de cohérence sont prononcés par la Forge : l'écran les affiche, il ne les
 * prononce pas — d'où aucun contrôle local « plafond ≥ réservation » ici.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderQuotas, QUOTAS_VIDE, valeursDesQuotas, corpsDesQuotas, ligneCpu,
  renderPlafondEnAttente,
} from './spark-detail.js';
import {
  renderSparkCreate, validateShape, demandOf, DEFAUTS, MODES,
} from './spark-create.js';

const GIO = 1024 ** 3;
const SPARK = {
  name: 'api-plafonnee', state: 'running', cpu_mode: 'shared-capped',
  cpu_reservation: 0.25, cpu_max: 0.75, cpu_cores: null,
  memory_reservation_bytes: 512 * 1024 ** 2, storage_bytes: 5 * GIO,
  network_reservation_bps: 50e6, network_burst_bps: 50e6,
  allowed_commands: ['delete', 'restart', 'stop'], transient: false, protected: false,
};
const usage = (cpu) => ({ cpu: { used: 0.1, reservation: 0.25, capped: false, ...cpu } });

// --- la fiche -----------------------------------------------------------------

test('la ligne Processeur dit la réservation ET le plafond', () => {
  assert.equal(ligneCpu(SPARK), '0,25 CPU réservés · plafond 0,75 CPU');
});

test('un plafond en vigueur ne fait rien apparaître', () => {
  assert.equal(renderPlafondEnAttente(SPARK, usage({
    ceiling: 0.75, ceiling_in_force: 0.75, ceiling_status: 'applied' })), '');
});

test('un plafond en attente se dit, avec la valeur en vigueur et son geste', () => {
  const html = renderPlafondEnAttente(SPARK, usage({
    ceiling: 0.75, ceiling_in_force: null, ceiling_status: 'pending' }));
  assert.match(html, /badge badge--neutral">en attente du démarrage/);
  assert.match(html, /role="status">Plafond de 0,75 CPU : prendra effet au prochain démarrage\. En vigueur : aucun plafond\./);
  assert.match(html, /data-plafond-redemarrer>Redémarrer pour l’appliquer<\/button>/);
});

test('un ancien plafond encore en vigueur se nomme en CPU', () => {
  const html = renderPlafondEnAttente(SPARK, usage({
    ceiling: 0.75, ceiling_in_force: 0.5, ceiling_status: 'pending' }));
  assert.match(html, /En vigueur : 0,50 CPU\./);
});

test('un plafond retiré mais encore en vigueur se dit aussi', () => {
  const html = renderPlafondEnAttente({ ...SPARK, cpu_mode: 'shared', cpu_max: null },
    usage({ ceiling: null, ceiling_in_force: 0.75, ceiling_status: 'pending' }));
  assert.match(html, /Le plafond sera retiré au prochain démarrage\. En vigueur : 0,75 CPU\./);
});

for (const [cas, spark] of [
  ['protégé', { ...SPARK, protected: true }],
  ['en transition', { ...SPARK, transient: true }],
  ['sans « Redémarrer » publié', { ...SPARK, allowed_commands: ['delete'] }],
]) {
  test(`Spark ${cas} : l'annonce reste, le bouton n'existe pas (§1.4)`, () => {
    const html = renderPlafondEnAttente(spark, usage({
      ceiling: 0.75, ceiling_in_force: null, ceiling_status: 'pending' }));
    assert.match(html, /prendra effet au prochain démarrage/);
    assert.ok(!html.includes('data-plafond-redemarrer'));
  });
}

test('un cgroup illisible se nomme « non relevé », et seulement s’il y a un plafond', () => {
  assert.match(renderPlafondEnAttente(SPARK, usage({
    ceiling: 0.75, ceiling_in_force: null, ceiling_status: 'unread' })),
  /Plafond en vigueur : non relevé\./);
  assert.equal(renderPlafondEnAttente({ ...SPARK, cpu_mode: 'shared' }, usage({
    ceiling: null, ceiling_in_force: null, ceiling_status: 'unread' })), '');
});

test('une cellule arrêtée (aucun usage) n’annonce rien', () => {
  assert.equal(renderPlafondEnAttente({ ...SPARK, state: 'stopped' }, { cpu: null }), '');
  assert.equal(renderPlafondEnAttente(SPARK, null), '');
});

// --- la modale « Ressources » -------------------------------------------------

test('la modale montre la réservation PUIS le plafond, avec leur aide', () => {
  const html = renderQuotas(SPARK, { ...QUOTAS_VIDE, open: true,
    values: valeursDesQuotas(SPARK) });
  const reservation = html.indexOf('name="cpu_reservation"');
  const plafond = html.indexOf('name="cpu_max"');
  assert.ok(reservation > 0 && plafond > reservation, 'réservation puis plafond');
  assert.match(html, /garantie sous contention, comptée dans la capacité/);
  assert.match(html, /jamais dépassé — prend effet au démarrage/);
  assert.ok(!html.includes('name="cpu_cores"'));
});

test('changer le seul plafond envoie le mode et ses DEUX réglages', () => {
  const origine = valeursDesQuotas(SPARK);
  assert.deepEqual(corpsDesQuotas(origine, { ...origine, cpu_max: '1.5' }), {
    cpu_mode: 'shared-capped', cpu_reservation: 0.25, cpu_max: 1.5, cpu_cores: null });
});

test('passer de partagé à partagé plafonné envoie la réservation et le plafond', () => {
  const partage = { ...SPARK, cpu_mode: 'shared', cpu_max: null };
  const origine = valeursDesQuotas(partage);
  assert.deepEqual(corpsDesQuotas(origine, {
    ...origine, cpu_mode: 'shared-capped', cpu_max: '1' }), {
    cpu_mode: 'shared-capped', cpu_reservation: 0.25, cpu_max: 1, cpu_cores: null });
});

// --- la création ---------------------------------------------------------------

test('le mode est proposé à la création, juste après « Partagé »', () => {
  assert.deepEqual(Object.keys(MODES).slice(0, 2), ['shared', 'shared-capped']);
  assert.match(MODES['shared-capped'], /^Partagé plafonné/);
});

test('à la création, le mode montre ses deux champs', () => {
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'api', cpu_mode: 'shared-capped' } });
  assert.match(html, /name="cpu_reservation"/);
  assert.match(html, /name="cpu_max"/);
  assert.match(html, /Jamais dépassé — prend effet au démarrage\./);
});

test('la forme exige les deux valeurs, sans prononcer leur cohérence', () => {
  const valeurs = { ...DEFAUTS, name: 'api', cpu_mode: 'shared-capped' };
  assert.ok(validateShape({ ...valeurs, cpu_max: 0 }).cpu_max);
  assert.ok(validateShape({ ...valeurs, cpu_reservation: 0 }).cpu_reservation);
  // Un plafond sous la réservation part à la Forge, qui le refuse en le disant.
  assert.deepEqual(validateShape({ ...valeurs, cpu_reservation: 1, cpu_max: 0.5 }), {});
});

test('l’estimation locale compte la réservation, comme l’admission', () => {
  assert.equal(demandOf({ ...DEFAUTS, cpu_mode: 'shared-capped',
                          cpu_reservation: 0.25, cpu_max: 2 }).cpu, 0.25);
});

test('un refus de cohérence de la Forge montre sa raison', () => {
  const html = renderSparkCreate({
    values: { ...DEFAUTS, name: 'api', cpu_mode: 'shared-capped' },
    refusal: { error: 'quota_incoherent', field: 'cpu_max',
               message: 'Le plafond CPU (0.5) est sous la réservation (1).' },
  });
  assert.match(html, /Le serveur a refusé cette création\./);
  assert.match(html, /Le plafond CPU \(0\.5\) est sous la réservation \(1\)\./);
});
