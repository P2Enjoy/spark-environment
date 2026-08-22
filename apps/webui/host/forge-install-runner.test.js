/** @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4-§50.6 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOOTSTRAP_SCRIPT, ForgeInstallManager, ForgeInstallRunError,
  bootstrapSshArgs, installSshArgs, parseBootstrapMarker,
  parseInstallEvent, requiredStorageConfirmation,
} from './forge-install-runner.js';

const TARGET = 'b'.repeat(40);

const SERVER = {
  name: 'prod', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu', port: 22,
};
const PLAN = {
  version: 1,
  system: { os: 'ubuntu 24.04', architecture: 'x86_64' },
  storage: { kind: 'file', poolName: 'spark', driver: 'zfs', sizeGib: 4,
    reserveGib: 1, path: '/var/lib/incus/disks/spark.img', destructive: false },
  config: { poolName: 'spark', bridgeName: 'sparkbr0', cpuReserve: 0.5,
    memoryReserveGib: 1, arcMaxGib: 1, reservedPorts: [22, 80, 443] },
  phases: ['access', 'dependencies', 'storage', 'foundation', 'control', 'verification']
    .map((id) => ({ id, label: id, status: id === 'access' ? 'done' : 'pending' })),
};

function child() {
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = (signal) => process.emit('close', null, signal);
  return process;
}

async function manager(spawnFn) {
  const directory = await mkdtemp(join(tmpdir(), 'spark-install-'));
  return new ForgeInstallManager({
    path: join(directory, 'installations.json'), spawnFn,
    resolveTarget: async () => TARGET,
  });
}

test('la commande SSH ne reprend aucun argument libre du navigateur', () => {
  assert.deepEqual(installSshArgs(SERVER).slice(-5), [
    'sudo', '-n', '/opt/sparkd/venv/bin/python', '-m', 'sparkd.forge_install',
  ]);
  assert.equal(requiredStorageConfirmation(PLAN),
    'CREER /var/lib/incus/disks/spark.img 4GiB');
  assert.deepEqual(bootstrapSshArgs(SERVER, TARGET).slice(-5),
                   ['sh', '-s', '--', TARGET]);
  assert.ok(BOOTSTRAP_SCRIPT.includes('P2Enjoy/spark-environment.git'));
  assert.equal(parseBootstrapMarker('SPARK_BOOTSTRAP\tpackage\tunchanged'), 'unchanged');
  assert.equal(parseBootstrapMarker('sortie apt'), null);
});

test('une ligne distante inconnue ne devient jamais du journal présentable', () => {
  assert.equal(parseInstallEvent('sortie de shell brute'), null);
  assert.equal(parseInstallEvent(JSON.stringify({
    phase: 'shell', status: 'done', message: '<script>alert(1)</script>',
  })), null);
  const event = parseInstallEvent(JSON.stringify({
    date: '2026-08-22T00:00:00Z', phase: 'control', status: 'done',
    message: 'Plan installé', result: { token: 'fuite', version: '1.2.3' },
  }));
  assert.equal(event.result.token, '***');
  assert.equal(event.result.version, '1.2.3');
});

test('les événements réels sont persistés et le succès exige la vérification finale', async () => {
  const bootstrap = child();
  const remote = child();
  const children = [bootstrap, remote];
  const installations = await manager(() => children.shift());
  await installations.start({ server: SERVER, plan: PLAN, values: {},
    confirmation: 'CREER /var/lib/incus/disks/spark.img 4GiB' });
  bootstrap.stdout.write('SPARK_BOOTSTRAP\tpackage\tunchanged\n');
  bootstrap.emit('close', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const phase of PLAN.phases.map(({ id }) => id)) {
    remote.stdout.write(JSON.stringify({ date: new Date().toISOString(), phase,
      status: 'running', message: `${phase} en cours` }) + '\n');
    remote.stdout.write(JSON.stringify({ date: new Date().toISOString(), phase,
      status: 'done', message: `${phase} fini`, result: { changed: false } }) + '\n');
  }
  remote.emit('close', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const state = await installations.read('prod');
  assert.equal(state.status, 'done');
  assert.equal(state.events.at(-1).phase, 'verification');
  assert.equal(state.events.at(-1).status, 'done');
});

test('le verrou est posé avant le premier await et refuse un second lancement', async () => {
  const bootstrap = child();
  const installations = await manager(() => bootstrap);
  const first = installations.start({ server: SERVER, plan: PLAN, values: {},
    confirmation: 'CREER /var/lib/incus/disks/spark.img 4GiB' });
  await assert.rejects(
    installations.start({ server: SERVER, plan: PLAN, values: {},
      confirmation: 'CREER /var/lib/incus/disks/spark.img 4GiB' }),
    (error) => error instanceof ForgeInstallRunError && error.code === 'install_in_progress');
  await first;
  bootstrap.emit('close', 2, null);
});

test('un running orphelin est conservé comme interrompu au redémarrage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-install-recovery-'));
  const path = join(directory, 'installations.json');
  await writeFile(path, JSON.stringify({ version: 1, installations: { prod: {
    server: 'prod', status: 'running', currentPhase: 'storage', plan: PLAN,
    values: {}, events: [], startedAt: '2026-08-22T00:00:00Z',
    updatedAt: '2026-08-22T00:00:00Z', endedAt: null, error: null,
  } } }));
  const installations = new ForgeInstallManager({ path, spawnFn: () => child() });
  const state = await installations.read('prod');
  assert.equal(state.status, 'interrupted');
  assert.equal(state.events.at(-1).phase, 'storage');
  assert.match(state.events.at(-1).message, /relancer le diagnostic/);
});
