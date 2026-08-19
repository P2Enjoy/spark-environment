/**
 * @verifies docs/BACKLOG.md#SPK-18 · docs/DESIGN_SYSTEM.md §6.13, §6.14, §9.8,
 *           §14.5, §14.6 · docs/DESIGN_SYSTEM_APP.md §4
 *
 * La Definition of Done nomme quatre etats — vide, chargement, erreur, donnees
 * longues — et la navigation clavier. Les captures les montrent ; ces tests les
 * verrouillent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSparksView, renderSkeleton, renderEmpty, renderError,
  renderStateBadge, renderCpuGauge,
} from './sparks-view.js';

const SPARK = {
  name: 'crm-production', state: 'running', cpu_mode: 'shared', cpu_reservation: 0.5,
  memory_reservation_bytes: 2 * 1024 ** 3, storage_bytes: 10 * 1024 ** 3,
  ipv4_address: '10.77.0.16', image: 'images:debian/13',
};
const USAGE = {
  'crm-production': {
    cpu: { used: 0.3, reservation: 0.5, over_limit: false },
    memory: { used_bytes: 174_764_032 }, disk: { used_bytes: 534_981_632 },
  },
};

// --- les quatre etats de la DoD (§6.13) -------------------------------------

test('etat CHARGEMENT : des squelettes, pas un spinner plein ecran', () => {
  const html = renderSparksView({ status: 'loading' });
  assert.match(html, /squelette/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.equal(/spinner/i.test(html), false);
});

test('etat VIDE : nomme l absence et propose une action qui existe', () => {
  const html = renderSparksView({ status: 'ready', sparks: [] });
  assert.match(html, /Aucun Spark sur ce serveur/);
  assert.match(html, /Créer un Spark/);
});

test('etat ERREUR : le motif accompagne le refus', () => {
  const html = renderSparksView({
    status: 'error', error: { message: 'Tunnel « prod » indisponible (broken).' },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Tunnel « prod » indisponible/);
  assert.match(html, /Réessayer/);
});

test('etat CHARGE : le tableau utilise des elements natifs', () => {
  // §6.14 : ne pas reconstruire une table avec des div.
  const html = renderSparksView({ status: 'ready', sparks: [SPARK], usage: USAGE });
  for (const balise of ['<table>', '<thead>', '<tbody>', '<th ', '<td'])
    assert.ok(html.includes(balise), `${balise} attendu`);
  assert.match(html, /<caption class="sr-only">/);
});

// --- donnees longues (DoD) --------------------------------------------------

test('un nom et une image tres longs ne debordent pas', () => {
  const long = {
    ...SPARK,
    name: 'spark-au-nom-particulierement-long-pour-eprouver-la-mise-en-page',
    image: 'images:debian/13/cloud/variante-tres-longue-qui-ne-tient-pas',
  };
  const html = renderSparksView({ status: 'ready', sparks: [long], usage: {} });
  // La cellule dense tronque avec ellipse et conserve la valeur complete.
  assert.match(html, /cellule-dense/);
  assert.match(html, /title="images:debian\/13\/cloud\/variante-tres-longue/);
});

// --- tri (§6.14) ------------------------------------------------------------

test('le tri est un bouton et le th porte aria-sort', () => {
  const html = renderSparksView({ status: 'ready', sparks: [SPARK], usage: USAGE });
  assert.match(html, /aria-sort="ascending"/);
  assert.match(html, /<button type="button" class="tri"/);
  // Les colonnes non triables ne mentent pas sur leur capacite.
  assert.equal((html.match(/aria-sort/g) || []).length, 2);
});

test('le tri ordonne reellement', () => {
  const html = renderSparksView({
    status: 'ready',
    sparks: [{ ...SPARK, name: 'zeta' }, { ...SPARK, name: 'alpha' }],
    sort: { key: 'name', dir: 'asc' },
  });
  assert.ok(html.indexOf('alpha') < html.indexOf('zeta'));
});

// --- la couleur ne porte jamais seule l information (§9.8) ------------------

test('un badge d etat porte toujours un texte', () => {
  for (const etat of ['running', 'stopped', 'error', 'pending'])
    assert.match(renderStateBadge(etat), />[A-ZÀ-Ü]/);
});

test('un etat transitoire est annonce aux technologies d assistance', () => {
  const html = renderStateBadge('creating');
  assert.match(html, /badge--transitoire/);
  assert.match(html, /opération en cours/);
});

test('un etat inconnu ne devient jamais undefined', () => {
  // §14.7
  const html = renderStateBadge('zombie');
  assert.match(html, /inconnu/);
  assert.equal(/undefined/.test(html), false);
});

// --- le burst n est PAS un depassement (SPK-DS-02) --------------------------

test('consommer au-dela de la reservation n est pas rouge', () => {
  const html = renderCpuGauge(
    { used: 1.996, reservation: 0.5, over_limit: false },
    { ...SPARK, state: 'running' },
  );
  assert.match(html, /jauge__part--burst/);
  assert.equal(/jauge__part--depasse/.test(html), false);
  assert.match(html, /en burst/);
});

test('un depassement reel, lui, est rouge', () => {
  const html = renderCpuGauge(
    { used: 1.5, reservation: 0.5, over_limit: true },
    { ...SPARK, state: 'running', cpu_mode: 'capped', cpu_reservation: null, cpu_max: 0.5 },
  );
  assert.match(html, /jauge__part--depasse/);
  assert.match(html, /en dépassement/);
});

// --- l absence de mesure est NOMMEE (§14.6, SPK-DS-03) ---------------------

test('les trois absences de mesure ont des textes distincts', () => {
  const arrete = renderCpuGauge(null, { ...SPARK, state: 'stopped' });
  const erreur = renderCpuGauge(null, { ...SPARK, state: 'error' });
  const attente = renderCpuGauge({ used: null }, { ...SPARK, state: 'running' });
  assert.match(arrete, /aucune mesure d’exécution/);
  assert.match(erreur, /Indisponible/);
  assert.match(attente, /Mesure en cours/);
  assert.notEqual(arrete, erreur);
});

test('une cellule sans donnee reste VIDE, pas remplie d un tiret', () => {
  // §6.14 : ne pas remplir avec « N/A », « non renseigné » ou un tiret.
  const html = renderSparksView({ status: 'ready', sparks: [SPARK], usage: {} });
  assert.equal(/N\/A|non renseigné|—<\/td>/.test(html), false);
});

// --- tunnel rompu : ne jamais laisser croire que c est a jour ---------------

test('un tunnel rompu est annonce au-dessus des donnees', () => {
  const html = renderSparksView({
    status: 'ready', sparks: [SPARK], usage: USAGE,
    tunnel: { name: 'prod', state: 'broken' },
  });
  assert.match(html, /bandeau-tunnel/);
  assert.match(html, /ne sont plus à jour/);
  assert.match(html, /role="alert"/);
});

// --- echappement ------------------------------------------------------------

test('le contenu venant du backend est echappe', () => {
  const html = renderSparksView({
    status: 'ready', sparks: [{ ...SPARK, name: '<script>alert(1)</script>' }],
  });
  assert.equal(/<script>alert/.test(html), false);
  assert.match(html, /&lt;script&gt;/);
});
