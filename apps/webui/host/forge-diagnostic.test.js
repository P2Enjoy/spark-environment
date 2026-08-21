/** @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.2, §50.3 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseDiagnostic, storageProposal, sshArgs, runDiagnostic,
         DIAGNOSTIC_SCRIPT, ForgeDiagnosticError } from './forge-diagnostic.js';

const SERVER = { name: 'neuve', kind: 'ssh', host: '203.0.113.8', user: 'root', port: 22 };

test('le script est fermé, sans secret ni interpolation de navigateur', () => {
  assert.match(DIAGNOSTIC_SCRIPT, /lsblk/);
  assert.ok(!/StrictHostKeyChecking=no|UserKnownHostsFile|password|token/i.test(DIAGNOSTIC_SCRIPT));
  assert.deepEqual(sshArgs(SERVER), [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '22',
    'root@203.0.113.8', 'sh', '-s',
  ]);
});

test('un support racine, une partition ou une signature ne sont jamais proposés', () => {
  const report = parseDiagnostic([
    'os\tubuntu 24.04', 'racine\t/dev/sda1', 'espace_racine\t100000:50000',
    'bloc\tNAME="sda" TYPE="disk" SIZE="100000" FSTYPE="" MOUNTPOINT="" PKNAME=""',
    'bloc\tNAME="sda1" TYPE="part" SIZE="90000" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sda"',
    'bloc\tNAME="sdb" TYPE="disk" SIZE="100000" FSTYPE="" MOUNTPOINT="" PKNAME=""',
    'bloc\tNAME="sdc" TYPE="disk" SIZE="100000" FSTYPE="zfs_member" MOUNTPOINT="" PKNAME=""',
    'bloc\tNAME="sdd" TYPE="disk" SIZE="100000" FSTYPE="" MOUNTPOINT="" PKNAME=""',
  ].join('\n'));
  const storage = storageProposal(report);
  assert.deepEqual(storage.nativeMirror, { eligible: true, disks: ['sdb', 'sdd'] });
  assert.match(storage.disks.find((disk) => disk.name === 'sda').reasons.join(' '), /racine/);
  assert.match(storage.disks.find((disk) => disk.name === 'sdc').reasons.join(' '), /signature/);
  assert.equal(storage.filePool.sizeBytes, null, 'une taille n’est jamais devinée');
});

test('un rapport incomplet conserve les absences, au lieu d’inventer zéro', () => {
  const report = parseDiagnostic('os\tubuntu 24.04\narchitecture\tx86_64\n');
  assert.equal(report.system.memoryBytes, null);
  assert.deepEqual(report.blocks, []);
  assert.equal(storageProposal(report).nativeMirror.eligible, false);
});

test('les noms complets de lsblk rejoignent la source de la racine', () => {
  const report = parseDiagnostic([
    'racine\t/dev/nvme0n1p1',
    'bloc\tNAME="/dev/nvme0n1" TYPE="disk" SIZE="100" FSTYPE="" MOUNTPOINT="" PKNAME=""',
    'bloc\tNAME="/dev/nvme0n1p1" TYPE="part" SIZE="90" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="/dev/nvme0n1"',
  ].join('\n'));
  const storage = storageProposal(report);
  assert.equal(storage.disks[0].name, 'nvme0n1');
  assert.match(storage.disks[0].reasons.join(' '), /racine/);
});

function fakeSsh({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: (input) => { child.input = input; } };
  child.kill = () => { child.killed = true; };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
}

test('le diagnostic SSH renvoie une structure, pas une sortie de shell', async () => {
  let child;
  const result = await runDiagnostic(SERVER, { spawnFn: () => (child = fakeSsh({
    stdout: 'os\tubuntu 24.04\nbloc\tNAME="sdb" TYPE="disk" SIZE="100" FSTYPE="" MOUNTPOINT="" PKNAME=""\n',
  })) });
  assert.equal(result.transport, 'established');
  assert.equal(result.report.system.os, 'ubuntu 24.04');
  assert.equal(result.storage.nativeMirror.eligible, false);
  assert.equal(child.input, DIAGNOSTIC_SCRIPT);
});

test('un échec SSH reste le motif, il ne devient pas un tunnel sparkd rompu', async () => {
  await assert.rejects(
    runDiagnostic(SERVER, { spawnFn: () => fakeSsh({ stderr: 'Host key verification failed.', code: 255 }) }),
    (error) => error instanceof ForgeDiagnosticError
      && error.code === 'ssh_failed' && /Host key verification failed/.test(error.message),
  );
});
