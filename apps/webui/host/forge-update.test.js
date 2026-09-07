/**
 * @verifies docs/BACKLOG.md#SPK-69 · docs/DAT.md §40.6
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ForgeUpdateManager, parseStages, updateEligibility, updateSshArgs, verifyForge,
} from './forge-update.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const SERVER = { name: 'prod', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu', port: 22 };

function comparison(overrides = {}) {
  return {
    verdict: 'forge_en_retard', forge: { commit: OLD.slice(0, 9) }, forgeCommit: OLD,
    local: { head: NEW, branch: 'main', published: NEW }, ...overrides,
  };
}

test('seul un ancetre vise par main PUBLIE autorise la mise a jour', () => {
  assert.deepEqual(updateEligibility(comparison()),
                   { allowed: true, before: OLD, target: NEW });
  for (const verdict of ['a_jour', 'poste_en_retard', 'etrangere',
                          'non_estampillee', 'sans_depot']) {
    assert.equal(updateEligibility(comparison({ verdict })).allowed, false);
  }
  assert.equal(updateEligibility(comparison({
    local: { head: NEW, branch: 'main', published: OLD },
  })).allowed, false);
});

test('OpenSSH ne recoit que la destination et deux empreintes validees', () => {
  const args = updateSshArgs(SERVER, NEW, OLD);
  assert.deepEqual(args.slice(-5), ['sh', '-s', '--', NEW, OLD]);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(!args.some((arg) => /StrictHostKeyChecking/.test(arg)));
  assert.throws(() => updateSshArgs(SERVER, 'main', OLD), /Empreinte Git invalide/);
});

test('seuls les jalons fermes deviennent une progression', () => {
  assert.deepEqual(parseStages([
    'sortie quelconque', 'SPARK_UPDATE\tpackage\tdone',
    'SPARK_INSTALL\tdaemon_reload\tin_progress',
    'SPARK_INSTALL\tcommande-inventee\tdone',
  ].join('\n')), { package: 'done', daemon_reload: 'in_progress' });
});

test('readyz HTTP 200 mais DEGRADED refuse la preuve', async () => {
  const bodies = {
    '/healthz': { status: 'ok', build: { commit: NEW } },
    '/readyz': { status: 'degraded' },
    '/v1/forge': { build: { commit: NEW } },
  };
  const result = await verifyForge(1234, NEW, {
    timeoutMs: 1, sleep: async () => {},
    fetchFn: async (url) => new Response(JSON.stringify(bodies[new URL(url).pathname]),
                                        { status: 200 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.readyz.state, 'degraded');
});

test('un succes garde un recu puis le retour arriere le CONSOMME', async () => {
  const installs = [];
  const manager = new ForgeUpdateManager({
    install: async (_server, target, previous) => {
      installs.push([target, previous]);
      return { stages: { package: 'done' } };
    },
    verify: async (_port, commit) => ({ ok: true, expectedCommit: commit }),
  });
  const updated = await manager.update({ server: SERVER, localPort: 1234,
                                         before: OLD, target: NEW });
  assert.equal(updated.state, 'success');
  assert.equal(manager.rollbackOffer('prod', NEW).available, true);
  const rolledBack = await manager.rollback({ server: SERVER, localPort: 1234,
                                               currentCommit: NEW });
  assert.equal(rolledBack.state, 'success');
  assert.equal(manager.rollbackOffer('prod', OLD).available, false);
  assert.deepEqual(installs, [[NEW, OLD], [OLD, NEW]]);
});

test('un echec APRES mutation tente automatiquement l ancienne build', async () => {
  const installs = [];
  const manager = new ForgeUpdateManager({
    install: async (_server, target, previous) => {
      installs.push([target, previous]);
      if (target === NEW) throw Object.assign(new Error('restart casse'), {
        code: 'remote_install_failed', mutated: true, stages: { package: 'done' },
      });
      return { stages: { package: 'done' } };
    },
    verify: async (_port, commit) => ({ ok: true, expectedCommit: commit }),
  });
  const result = await manager.update({ server: SERVER, localPort: 1234,
                                        before: OLD, target: NEW });
  assert.equal(result.state, 'failed');
  assert.equal(result.rollback.state, 'success');
  assert.deepEqual(installs, [[NEW, OLD], [OLD, NEW]]);
});

// --- SPK-85 · §40.6 : ce qu'un retour arrière ne rétablira pas --------------
//
// @verifies docs/BACKLOG.md#SPK-85 · docs/DAT.md §40.6 · docs/SCHEMA.md §12.4
//
// Mesuré le 2026-09-02 : une base portant une migration dont le code n'a pas le
// fichier est REJETÉE au démarrage. Le reçu doit donc retenir de quoi le dire.

test('le recu retient les DEUX versions de schema, et conclut à la migration', async () => {
  const manager = new ForgeUpdateManager({
    install: async () => ({ stages: { package: 'done' } }),
    verify: async (_port, commit) => ({ ok: true, expectedCommit: commit,
                                        readyz: { schemaVersion: 13 } }),
    probeSchema: async () => 12,
  });
  await manager.update({ server: SERVER, localPort: 1234, before: OLD, target: NEW });

  const offre = manager.rollbackOffer('prod', NEW);
  assert.equal(offre.available, true);
  assert.equal(offre.migrated, true);
  assert.equal(offre.schemaBefore, 12);
  assert.equal(offre.schemaAfter, 13);
});

test('une version INCHANGEE ne fait pas croire à une migration', async () => {
  const manager = new ForgeUpdateManager({
    install: async () => ({ stages: { package: 'done' } }),
    verify: async (_port, commit) => ({ ok: true, expectedCommit: commit,
                                        readyz: { schemaVersion: 12 } }),
    probeSchema: async () => 12,
  });
  await manager.update({ server: SERVER, localPort: 1234, before: OLD, target: NEW });
  assert.equal(manager.rollbackOffer('prod', NEW).migrated, false);
});

test('une mesure MANQUANTE ne se range pas avec « pas de migration »', async () => {
  // §14.6 : « je ne sais pas » et « tout va bien » sont deux états distincts.
  // Les confondre ferait taire l'avertissement précisément quand la console est
  // le moins sûre d'elle.
  for (const [avant, apres] of [[null, 13], [12, null], [null, null]]) {
    const manager = new ForgeUpdateManager({
      install: async () => ({ stages: { package: 'done' } }),
      verify: async (_port, commit) => ({ ok: true, expectedCommit: commit,
                                          readyz: { schemaVersion: apres } }),
      probeSchema: async () => avant,
    });
    await manager.update({ server: SERVER, localPort: 1234, before: OLD, target: NEW });
    assert.equal(manager.rollbackOffer('prod', NEW).migrated, null,
                 `avant=${avant} apres=${apres}`);
  }
});

test('la version du schema est relevee AVANT la mutation, jamais apres', async () => {
  // Après l'installation, la nouvelle build a déjà migré au démarrage : relever
  // là ne comparerait plus rien.
  const ordre = [];
  const manager = new ForgeUpdateManager({
    install: async () => { ordre.push('install'); return { stages: {} }; },
    verify: async (_port, commit) => ({ ok: true, expectedCommit: commit,
                                        readyz: { schemaVersion: 13 } }),
    probeSchema: async () => { ordre.push('probe'); return 12; },
  });
  await manager.update({ server: SERVER, localPort: 1234, before: OLD, target: NEW });
  assert.deepEqual(ordre, ['probe', 'install']);
});

test('verifyForge rapporte la version de schema que readyz publie', async () => {
  const bodies = {
    '/healthz': { status: 'ok', build: { commit: NEW } },
    '/readyz': { status: 'ready', schema_version: 13 },
    '/v1/forge': { build: { commit: NEW } },
  };
  const result = await verifyForge(1234, NEW, {
    timeoutMs: 1, sleep: async () => {},
    fetchFn: async (url) => new Response(JSON.stringify(bodies[new URL(url).pathname]),
                                        { status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.readyz.schemaVersion, 13);
});
