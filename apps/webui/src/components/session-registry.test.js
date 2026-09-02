/**
 * @verifies docs/BACKLOG.md#SPK-75, docs/BACKLOG.md#SPK-70 · docs/DAT.md
 * §37.4.8 (l'inventaire permanent), §37.5 (aucun octet de session) ·
 * docs/DESIGN_SYSTEM_APP.md SPK-DS-16
 *
 * Ce que ces preuves gardent : le widget est un INVENTAIRE, pas une liste de
 * shells. Il montre tous les Sparks même sans session — c'est ce qui en fait un
 * point de départ — et il ne relève les conteneurs d'un Spark que déplié.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INVENTAIRE_VIDE, renderSessionRegistry } from './session-registry.js';

const SESSION = {
  id: 'opaque-42', forge: 'production', spark: 'crm', path: 'container',
  type: 'container', container: 'nginx', openedAt: '2026-08-22T10:00:00.000Z',
  lastActivity: '2026-08-22T10:01:00.000Z', state: 'open',
};
const SESSION_SPARK = { ...SESSION, id: 'opaque-7', path: 'ssh', type: 'spark', container: null };
const SPARKS = [{ name: 'crm', state: 'running' }, { name: 'boutique', state: 'stopped' }];

const ouvert = (champs = {}) => renderSessionRegistry({
  sparks: SPARKS, ouvert: true, forge: 'production', ...champs });

test('replié, le widget est une pastille qui COMPTE les shells', () => {
  const aucun = renderSessionRegistry({ sparks: SPARKS });
  assert.match(aucun, /data-widget="basculer"/);
  assert.match(aucun, /aucun shell/);
  assert.match(aucun, /aria-expanded="false"/);
  // Replié, il ne déverse pas l'inventaire dans la page.
  assert.match(aucun, /id="widget-inventaire-contenu" hidden/);

  const un = renderSessionRegistry({ sparks: SPARKS, sessions: [SESSION_SPARK] });
  assert.match(un, /1 shell</);
  const deux = renderSessionRegistry({
    sparks: SPARKS, sessions: [SESSION_SPARK, { ...SESSION, id: 'x' }] });
  assert.match(deux, /2 shells</);
});

test('déplié, il liste TOUS les Sparks, même sans session', () => {
  // C'est ce qui en fait un point de départ et non une liste de shells : sur
  // une Forge où rien n'est ouvert, il reste utile.
  const rendu = ouvert();
  assert.match(rendu, /data-widget-spark="crm"/);
  assert.match(rendu, /data-widget-spark="boutique"/);
  assert.match(rendu, /Forge : <strong>production/);
  // §SPK-DS-01 : l'état se lit avec la table du reste de la console, jamais en
  // brut. « running » à côté d'un tableau qui dit « En marche » ferait douter
  // qu'il s'agit du même objet.
  assert.match(rendu, /En marche/);
  assert.match(rendu, /Arrêté/);
  assert.ok(!/état : running|état : stopped/.test(rendu));
  assert.ok(!rendu.includes('shell ouvert'), 'aucune session : rien ne le prétend');
});

test('une cible qui porte un shell le DIT, et le distingue d’une cible vide', () => {
  const rendu = ouvert({ sessions: [SESSION_SPARK] });
  assert.match(rendu, /shell ouvert/);
  assert.match(rendu, /data-vivante="oui"/);
  // §14.6 : « ouvrir » et « revenir » ne sont pas le même geste, et l'entrée
  // sans session ne porte pas la marque.
  const lignes = rendu.split('<li');
  const ligneCrm = lignes.find((l) => l.includes('data-widget-spark="crm"'));
  const ligneBoutique = lignes.find((l) => l.includes('data-widget-spark="boutique"'));
  assert.match(ligneCrm, /shell ouvert/);
  assert.ok(!/shell ouvert/.test(ligneBoutique));
});

test('les conteneurs n’apparaissent QUE pour un Spark déplié (§37.4.8)', () => {
  const replie = ouvert();
  assert.ok(!replie.includes('data-widget-conteneur'), 'rien n’est relevé sans dépliage');
  assert.match(replie, /data-widget-deplier="crm"[^>]*aria-expanded="false"/);

  const deplie = ouvert({
    deplies: { crm: true },
    conteneurs: { crm: { status: 'pret', items: [{ name: 'nginx', image: 'nginx:1' }] } },
  });
  assert.match(deplie, /data-widget-conteneur="crm" data-conteneur="nginx"/);
  assert.match(deplie, /aria-expanded="true"/);
  // Et le Spark voisin n'a toujours rien demandé.
  assert.ok(!deplie.includes('data-widget-conteneur="boutique"'));
});

test('un relevé de conteneurs en cours, vide ou illisible sont TROIS états', () => {
  const enCours = ouvert({ deplies: { crm: true }, conteneurs: { crm: { status: 'chargement' } } });
  assert.match(enCours, /Relevé des conteneurs…/);

  const vide = ouvert({ deplies: { crm: true }, conteneurs: { crm: { status: 'pret', items: [] } } });
  assert.match(vide, /Aucun conteneur\./);

  const casse = ouvert({
    deplies: { crm: true }, conteneurs: { crm: { status: 'erreur', erreur: 'Spark arrêté' } } });
  assert.match(casse, /Conteneurs illisibles : Spark arrêté/);
  assert.ok(!casse.includes('Aucun conteneur'), '§14.6 : illisible n’est pas vide');
});

test('la fermeture demande une confirmation qui dit que le shell sera tué', () => {
  const rendu = ouvert({ sessions: [SESSION_SPARK], confirmation: SESSION_SPARK.id });
  assert.match(rendu, /shell distant sera tué/);
  assert.match(rendu, /data-session-close-confirm="opaque-7"/);
  assert.match(rendu, /data-session-close-cancel/);
});

test('une session dont la cible a disparu reste VISIBLE', () => {
  // Une session qu'on ne voit plus est une session qu'on oublie — exactement ce
  // que le widget existe pour empêcher (§37.4.2 révisé).
  const rendu = ouvert({ sessions: [{ ...SESSION_SPARK, spark: 'supprime' }] });
  assert.match(rendu, /supprime/);
  assert.match(rendu, /hors inventaire/);
  assert.match(rendu, /data-session-select="opaque-7"/);
});

test('aucun octet de session ne traverse le widget (§37.5)', () => {
  const rendu = ouvert({ sessions: [{ ...SESSION_SPARK, output: 'SECRET-EN-CLAIR' }] });
  assert.ok(!rendu.includes('SECRET-EN-CLAIR'));
});

test('une Forge sans Spark le dit, sans prétendre à une session', () => {
  const rendu = renderSessionRegistry({ sparks: [], ouvert: true, forge: 'vide' });
  assert.match(rendu, /Aucun Spark sur cette Forge\./);
});

test('l’état initial est replié et sans inventaire', () => {
  assert.equal(INVENTAIRE_VIDE.ouvert, false);
  assert.deepEqual(INVENTAIRE_VIDE.items, []);
  assert.deepEqual(INVENTAIRE_VIDE.deplies, {});
});

test('rien n’est injecté : le rendu échappe les noms venus du serveur', () => {
  const rendu = renderSessionRegistry({
    sparks: [{ name: '<img onerror=1>', state: 'running' }], ouvert: true });
  assert.ok(!rendu.includes('<img onerror=1>'));
  assert.match(rendu, /&lt;img onerror=1&gt;/);
});
