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
  assert.match(html, /Vérifier et composer le plan/);
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

const PLAN = {
  storage: { kind: 'file', poolName: 'spark', path: '/var/lib/incus/disks/spark.img',
    sizeGib: 4, reserveGib: 1 },
  phases: ['access', 'dependencies', 'storage', 'foundation', 'control', 'verification']
    .map((id) => ({ id, label: id, status: id === 'access' ? 'done' : 'pending' })),
};

test('le plan fichier exige deux confirmations distinctes et exactes', () => {
  const base = {
    status: 'planned', result: {
      report: { system: {}, access: {}, runtimes: {}, services: {}, blocks: [] },
      storage: { disks: [], nativeMirror: { eligible: false, disks: [] }, filePool: {} },
    }, plan: PLAN, accepted: true,
  };
  let html = renderForgeInstaller({ ...base, confirmation: '' });
  assert.match(html, /J’ai relu la destination/);
  assert.match(html, /CREER \/var\/lib\/incus\/disks\/spark\.img 4GiB/);
  assert.match(html, /data-action="executer-installation-forge" disabled/);
  html = renderForgeInstaller({ ...base,
    confirmation: 'CREER /var/lib/incus/disks/spark.img 4GiB' });
  assert.match(html, /data-action="executer-installation-forge">/);
});

test('le journal rend les statuts et les mesures sans sortie terminal brute', () => {
  const html = renderForgeInstaller({ status: 'idle', execution: {
    status: 'interrupted', currentPhase: 'storage', plan: PLAN,
    error: 'Connexion interrompue.', events: [
      { phase: 'access', status: 'done', message: 'Plan concordant', result: {} },
      { phase: 'storage', status: 'interrupted', message: 'Connexion interrompue' },
    ],
  } });
  assert.match(html, /Installation interrompue/);
  assert.match(html, /Reprendre le diagnostic/);
  assert.match(html, /terminée/);
  assert.match(html, /interrompue/);
});

test('un journal terminé n’empêche pas de recomposer un plan idempotent', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: {}, access: {}, runtimes: {}, services: {}, blocks: [] },
    storage: { disks: [], nativeMirror: { eligible: false, disks: [] }, filePool: {} },
  }, execution: { status: 'done', plan: PLAN, events: [] } });
  assert.match(html, /id="formulaire-plan-forge"/);
  assert.match(html, /Forge prête — recette finale mesurée/);
});
