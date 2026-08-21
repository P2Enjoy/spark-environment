/** @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.1, §50.3 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderForgeInstaller } from './forge-installer.js';

test('le panneau explique le diagnostic sans promettre une installation', () => {
  const html = renderForgeInstaller();
  assert.match(html, /Diagnostiquer la Forge/);
  assert.match(html, /aucune écriture distante/i);
  assert.ok(!/data-action="installer-forge"/.test(html));
});

test('SSH établi et sparkd absent ont leurs deux lignes distinctes', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: { os: 'ubuntu 24.04', architecture: 'x86_64', rootAvailableBytes: 5000 },
              access: { sudo: 'racine' }, runtimes: { sparkd: null, incus: null, caddy: null },
              services: { sparkd: null }, blocks: [] },
    storage: { disks: [], nativeMirror: { eligible: false, disks: [] },
               filePool: { availableBytes: 5000 } },
  } });
  assert.match(html, /SSH établi/);
  assert.match(html, /sans réponse ou non installé/);
  assert.match(html, /Aucune paire de disques sûre/);
  assert.match(html, /L’exécution du plan reste\s+désactivée/);
});

test('un disque exclu reste affiché avec son motif', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: {}, access: {}, runtimes: {}, services: {}, blocks: [] },
    storage: { disks: [{ name: 'sda', sizeBytes: 1000, reasons: ['porte la racine'] }],
               nativeMirror: { eligible: false, disks: [] }, filePool: {} },
  } });
  assert.match(html, /\/dev\/sda/);
  assert.match(html, /porte la racine/);
});
