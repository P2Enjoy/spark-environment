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
  // §8.5 révisé : le pool sur fichier est retiré. La seule écriture destructive
  // du parcours est la création du miroir, et c'est elle qui se confirme.
  storage: { kind: 'native', poolName: 'spark', driver: 'zfs',
    devices: ['/dev/sda5', '/dev/sdb5'], destructive: true },
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
  assert.equal(requiredStorageConfirmation(PLAN), 'EFFACER /dev/sda5 /dev/sdb5');
  // Ni la réutilisation ni l'adoption d'un zpool n'écrivent sur une donnée.
  assert.equal(requiredStorageConfirmation(
    { storage: { kind: 'reuse', poolName: 'spark' } }), '');
  assert.equal(requiredStorageConfirmation(
    { storage: { kind: 'adopt', poolName: 'spark', zpool: 'spark' } }), '');
  // `slice(-5)` reprenait la destination et comparait CINQ éléments à quatre :
  // la preuve était rouge depuis qu'elle existe. Ce qu'elle veut garder est la
  // QUEUE fermée de la commande, qui en compte quatre.
  assert.deepEqual(bootstrapSshArgs(SERVER, TARGET).slice(-4),
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

/**
 * Attend une CONDITION plutôt qu'une durée.
 *
 * Les `setTimeout` fixes rendaient cette preuve rouge de façon intermittente :
 * l'amorçage écrit son journal sur disque avant que l'installateur ne soit
 * lancé, et 10 ms ne suffisent pas toujours. Une temporisation arbitraire est
 * précisément ce que le CLAUDE.md §18 interdit pour masquer une course.
 */
async function jusqua(condition, quoi, limite = 5_000) {
  const fin = Date.now() + limite;
  while (Date.now() < fin) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`délai dépassé en attendant : ${quoi}`);
}

test('les événements réels sont persistés et le succès exige la vérification finale', async () => {
  const bootstrap = child();
  const remote = child();
  const children = [bootstrap, remote];
  const installations = await manager(() => children.shift());
  await installations.start({ server: SERVER, plan: PLAN, values: {},
    confirmation: 'EFFACER /dev/sda5 /dev/sdb5' });
  // `close` est un événement à un coup : l'émettre avant que le gestionnaire ne
  // se soit abonné le perdrait, et l'installateur ne serait jamais lancé.
  await jusqua(() => children.length === 1, 'le lancement de l’amorceur');
  bootstrap.stdout.write('SPARK_BOOTSTRAP\tpackage\tunchanged\n');
  bootstrap.emit('close', 0, null);
  // L'installateur n'est lancé qu'APRÈS l'amorçage : on attend qu'il le soit.
  await jusqua(() => children.length === 0, 'le lancement de l’installateur');
  for (const phase of PLAN.phases.map(({ id }) => id)) {
    remote.stdout.write(JSON.stringify({ date: new Date().toISOString(), phase,
      status: 'running', message: `${phase} en cours` }) + '\n');
    remote.stdout.write(JSON.stringify({ date: new Date().toISOString(), phase,
      status: 'done', message: `${phase} fini`, result: { changed: false } }) + '\n');
  }
  remote.emit('close', 0, null);
  await jusqua(async () => (await installations.read('prod'))?.status !== 'running',
               'la fin de l’installation');
  const state = await installations.read('prod');
  assert.equal(state.status, 'done');
  assert.equal(state.events.at(-1).phase, 'verification');
  assert.equal(state.events.at(-1).status, 'done');
});

test('le verrou est posé avant le premier await et refuse un second lancement', async () => {
  const bootstrap = child();
  const installations = await manager(() => bootstrap);
  const first = installations.start({ server: SERVER, plan: PLAN, values: {},
    confirmation: 'EFFACER /dev/sda5 /dev/sdb5' });
  await assert.rejects(
    installations.start({ server: SERVER, plan: PLAN, values: {},
      confirmation: 'EFFACER /dev/sda5 /dev/sdb5' }),
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
