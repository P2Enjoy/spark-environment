/**
 * @verifies docs/BACKLOG.md#SPK-115 · docs/DAT.md §60.1 (un index qui mène à la
 *           facette où la proposition se tranche), §60.2 (une cellule non
 *           consultée est nommée), §60.3 · docs/DESIGN_SYSTEM.md §5.2, §6.13,
 *           §14.6 · docs/DESIGN_SYSTEM_APP.md SPK-DS-32
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROPOSITIONS_FORGE_VIDE, lienProposition, renderPropositionsForge }
  from './forge-propositions.js';
import { ONGLETS_FORGE } from './forge-images.js';

const PRETE = (sparks) => ({ ...PROPOSITIONS_FORGE_VIDE, status: 'ready', sparks,
                             luA: '17:42' });

test('chaque nature mène à la facette où elle se TRANCHE (§55.9)', () => {
  assert.equal(lienProposition('crm', 'variables'), '#/sparks/crm/environnement');
  assert.equal(lienProposition('crm', 'secrets'), '#/sparks/crm/environnement');
  assert.equal(lienProposition('crm', 'routes'), '#/sparks/crm/routes');
  assert.equal(lienProposition('crm', 'install'), '#/sparks/crm/notes');
  assert.equal(lienProposition('a b', 'readme'), '#/sparks/a%20b/notes');
});

test('une ligne par proposition, des LIENS, et aucun geste de décision', () => {
  const rendu = renderPropositionsForge(PRETE([
    { spark: 'crm', cell_read: true,
      pending: [{ kind: 'secrets', lines: 2 }, { kind: 'readme', lines: null }] },
    { spark: 'boutique', cell_read: true, pending: [{ kind: 'routes', lines: 1 }] },
  ]));
  assert.match(rendu, /<a class="lien-spark" href="#\/sparks\/crm\/environnement" data-proposition-lien="crm:secrets">Secrets proposés<\/a>/);
  assert.match(rendu, /<a class="lien-spark" href="#\/sparks\/boutique\/routes"[^>]*>Routes proposées<\/a>/);
  assert.match(rendu, /2 ligne\(s\)/);
  assert.match(rendu, /un texte à relire en entier/);
  assert.equal((rendu.match(/<tr>/g) ?? []).length, 4, 'un en-tête et trois lignes');
  assert.doesNotMatch(rendu, /data-sugg-appliquer|data-sugg-refuser|Tout refuser/);
  assert.match(rendu, /Lu à <span class="technique">17:42<\/span>/);
});

test('rien n’attend : l’absence est NOMMÉE, pas un tableau vide (§14.5)', () => {
  const rendu = renderPropositionsForge(PRETE([{ spark: 'crm', cell_read: true, pending: [] }]));
  assert.match(rendu, /Aucune proposition n’attend dans les Sparks de cette Forge/);
  assert.doesNotMatch(rendu, /<table>/);
});

test('une cellule non consultée est nommée, et ne se lit pas comme « rien » (§14.6)', () => {
  const rendu = renderPropositionsForge(PRETE([
    { spark: 'perdu', cell_read: false, pending: [] },
    { spark: 'crm', cell_read: true, pending: [] },
  ]));
  assert.match(rendu, /Cellule\(s\) non consultée\(s\)\s*<\/strong> : perdu\./);
});

test('chargement et erreur sont deux états distincts, et le bouton relit', () => {
  const charge = renderPropositionsForge(PROPOSITIONS_FORGE_VIDE);
  assert.match(charge, /aria-busy="true">Lecture des cellules…/);
  assert.match(charge, /data-propositions-relire\s+disabled/);
  const erreur = renderPropositionsForge({ ...PROPOSITIONS_FORGE_VIDE, status: 'error',
                                          error: 'Forge injoignable.' });
  assert.match(erreur, /<div class="refus" role="alert"><p><strong>Forge injoignable\./);
  assert.doesNotMatch(erreur, /Aucune proposition/);
});

test('rien de ce qui vient du serveur n’est injecté sans échappement', () => {
  const rendu = renderPropositionsForge(PRETE([
    { spark: '<img>', cell_read: false, pending: [{ kind: '<b>', lines: 1 }] }]));
  assert.doesNotMatch(rendu, /<img>|<b>/);
});

test('l’onglet existe dans la rangée de la Forge, comme une destination', () => {
  assert.ok(ONGLETS_FORGE.some(([href, libelle]) =>
    href === '#/forge/propositions' && libelle === 'Propositions'));
});
