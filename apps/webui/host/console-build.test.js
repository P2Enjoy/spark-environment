/** @verifies docs/BACKLOG.md#SPK-65 · docs/DAT.md §40.5 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capture, compare, describe, latestMtime,
         A_JOUR, PERIMEE, DEPOT_RECULE, INDISPONIBLE } from './console-build.js';

// Les règles Git sont unitaires : les simuler rend le test portable dans le
// harnais, qui interdit à Node de créer un sous-processus. Le chemin réel est
// ensuite éprouvé avec une console d'exploitation lancée normalement.
function git({ head, start, isStartAncestor = false, isHeadAncestor = false, behind = 0 }) {
  return (_binary, args) => {
    const command = args.join(' ');
    if (command === 'rev-parse HEAD') return head;
    if (command === `merge-base --is-ancestor ${start} ${head}`) {
      if (isStartAncestor) return '';
      throw new Error('pas ancêtre');
    }
    if (command === `merge-base --is-ancestor ${head} ${start}`) {
      if (isHeadAncestor) return '';
      throw new Error('pas ancêtre');
    }
    if (command === `rev-list --count ${start}..${head}`) return String(behind);
    throw new Error(`commande inattendue : ${command}`);
  };
}

test('un commit arrivé après le démarrage signale de redémarrer la console', () => {
  const start = capture('/depot', { execute: git({ head: 'avant', start: 'avant' }) });
  const vu = describe(compare(start, '/depot', {
    execute: git({ head: 'apres', start: 'avant', isStartAncestor: true, behind: 1 }),
  }));
  assert.equal(vu.verdict, PERIMEE);
  assert.equal(vu.behind, 1);
  assert.match(vu.detail, /redémarrer pour en bénéficier/);
});

test('sans changement la console est à jour', () => {
  const execute = git({ head: 'identique', start: 'identique' });
  assert.equal(compare(capture('/depot', { execute }), '/depot', { execute }).verdict, A_JOUR);
});

test('un dépôt revenu en arrière ne pousse jamais à redémarrer vers un code plus vieux', () => {
  const start = capture('/depot', { execute: git({ head: 'apres', start: 'apres' }) });
  assert.equal(compare(start, '/depot', {
    execute: git({ head: 'avant', start: 'apres', isHeadAncestor: true }),
  }).verdict, DEPOT_RECULE);
});

test('sans dépôt, les dates identiques ne produisent aucun faux avertissement', () => {
  const start = { kind: 'files', mtime: 42 };
  assert.equal(compare(start, '/absent', { latestMtime: () => 42 }).verdict, A_JOUR);
});

test('sans dépôt ni arbre lisible, aucun retard imaginaire ne se produit', () => {
  const start = capture('/absent', { execute: () => { throw new Error('pas de Git'); },
                                     latestMtime: () => null });
  assert.deepEqual(start, { kind: 'unavailable' });
  assert.equal(compare(start, '/absent').verdict, INDISPONIBLE);
});

test('le repli fichiers ne confond pas une dépendance avec le code servi', () => {
  const arbres = {
    '/console': { isDirectory: () => true },
    '/console/app.js': { isDirectory: () => false, isFile: () => true, mtimeMs: 20 },
    '/console/node_modules': { isDirectory: () => true, isFile: () => false },
  };
  const stat = (path) => arbres[path];
  const read = (path) => (path === '/console' ? ['app.js', 'node_modules'] : []);
  assert.equal(latestMtime('/console', stat, read), 20);
});
