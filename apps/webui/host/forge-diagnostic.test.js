/** @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.2, §50.3 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseDiagnostic, storageProposal, sshArgs, runDiagnostic, conformity,
         parseNetwork, parseForgeConfig, poolDecision, GIB,
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
  assert.deepEqual(storage.nativeMirror.devices.sort(), ['sdb', 'sdd']);
  assert.equal(storage.nativeMirror.eligible, true);
  const motif = (nom) => storage.supports.find((support) => support.name === nom).reasons.join(' ');
  assert.match(motif('sda'), /racine/);
  assert.match(motif('sdc'), /signature/);
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
  assert.equal(storage.supports[0].name, 'nvme0n1');
  assert.match(storage.supports[0].reasons.join(' '), /racine/);
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

/** Le relevé d'une Forge réellement conforme, tel que le script le rend. */
const FORGE_CONFORME = [
  'os\tubuntu 26.04', 'architecture\tx86_64', 'identite\tubuntu',
  'memoire_octets\t101193396224', 'racine\t/dev/md1',
  'espace_racine\t210108399616:193670443008', 'sudo\toui',
  'incus_version\tClient version: 7.4', 'caddy_version\t2.6.2',
  'python_version\tPython 3.14.4', 'sparkd_version\t0.post1.dev674+g5d1906e79',
  'sparkd_actif\tactive', 'sparkd_active\tenabled',
  // SPK-177 · §70.8 : la Forge réelle depuis SPK-129 — Caddy porté par
  // caddy-api.service, caddy.service masqué.
  'caddy_api_actif\tactive', 'caddy_actif\tinactive',
  'pools\tspark,zfs,,1,CREATED;',
  'reseau\teno1,physical,NO,,,,0,',
  'reseau\tsparkbr0,bridge,YES,10.77.0.1/24,none,,1,CREATED',
  'configuration\tSPARKD_CPU_RESERVE=0.5',
  'configuration\tSPARKD_MEMORY_RESERVE=2GiB',
  'configuration\tSPARKD_NETWORK_BRIDGE=sparkbr0',
  'configuration\tSPARKD_RESERVED_PORTS=',
  'configuration\tSPARKD_STORAGE_POOL=spark',
  'arc_max\t17179869184', 'healthz\t200', 'readyz\t200',
].join('\n');

test('le relevé du socle passe par le droit d’administration déjà constaté', () => {
  // Sans `admin`, `incus storage list` était lancé par l'utilisateur SSH : la
  // socket lui est refusée, et le pool existant devenait invisible.
  assert.match(DIAGNOSTIC_SCRIPT, /^admin\(\) \{$/m);
  assert.match(DIAGNOSTIC_SCRIPT, /admin incus storage list --format csv/);
  assert.match(DIAGNOSTIC_SCRIPT, /admin incus network list --format csv/);
  assert.match(DIAGNOSTIC_SCRIPT, /admin sed -n/);
  // Le script lit CINQ clés nommées, jamais le fichier d'environnement entier :
  // `SPARKD_NOTIFY_URL` peut porter un jeton, et il ne doit pas remonter.
  const selection = DIAGNOSTIC_SCRIPT.split('\n')
    .find((ligne) => ligne.includes('STORAGE_POOL')) ?? '';
  assert.deepEqual([...selection.matchAll(/[A-Z][A-Z_]{4,}/g)].map(([cle]) => cle),
    ['SPARKD_', 'STORAGE_POOL', 'NETWORK_BRIDGE', 'CPU_RESERVE',
     'MEMORY_RESERVE', 'RESERVED_PORTS']);
});

test('le mode d’emploi rendu par un incus sans droit ne devient pas un pool', () => {
  const report = parseDiagnostic([
    'pools\tUsage: incus storage list [<remote>:] [<filter>...];                          ┅┅┅;',
  ].join('\n'));
  assert.deepEqual(report.pools, []);
});

test('une ligne de réseau et une clé d’environnement deviennent des données typées', () => {
  assert.deepEqual(parseNetwork('sparkbr0,bridge,YES,10.77.0.1/24,none,,1,CREATED'),
    { name: 'sparkbr0', type: 'bridge', managed: true });
  assert.equal(parseNetwork('Error: permission denied'), null);
  assert.deepEqual(
    parseForgeConfig(['SPARKD_STORAGE_POOL=tank', 'SPARKD_NETWORK_BRIDGE=br1',
                      'SPARKD_CPU_RESERVE=1.5', 'SPARKD_MEMORY_RESERVE=4GiB',
                      'SPARKD_RESERVED_PORTS=2222,8443'], String(8 * GIB)),
    { poolName: 'tank', bridgeName: 'br1', cpuReserve: 1.5, memoryReserveGib: 4,
      reservedPorts: [2222, 8443], arcMaxGib: 8 });
  assert.equal(parseForgeConfig([], null), null);
});

test('une Forge intégralement installée est CONSTATÉE conforme et prête', () => {
  const report = parseDiagnostic(FORGE_CONFORME);
  assert.deepEqual(report.pools, ['spark,zfs,,1,CREATED']);
  assert.equal(report.config.poolName, 'spark');
  assert.equal(report.config.bridgeName, 'sparkbr0');
  assert.equal(report.config.arcMaxGib, 16);
  assert.deepEqual(report.api, { healthz: 200, readyz: 200 });
  const verdict = conformity(report);
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.installed, true);
  assert.equal(verdict.ready, true);
});

test('« prête » exige les deux codes mesurés, jamais la seule unité active', () => {
  const report = parseDiagnostic(
    FORGE_CONFORME.replace('healthz\t200', 'healthz\t000').replace('readyz\t200', 'readyz\t'));
  const verdict = conformity(report);
  assert.deepEqual(verdict.missing, ['healthz', 'readyz']);
  assert.equal(verdict.installed, true, 'le socle reste constaté en place');
  assert.equal(verdict.ready, false);
  assert.equal(report.api.healthz, null, '000 n’est pas un code HTTP');
});

test('un pool illisible faute de droit reste un défaut, pas un succès par défaut', () => {
  const report = parseDiagnostic(
    FORGE_CONFORME.replace('sudo\toui', 'sudo\tnon').replace('pools\tspark,zfs,,1,CREATED;', 'pools\t'));
  const verdict = conformity(report);
  assert.ok(verdict.missing.includes('pool'));
  assert.equal(verdict.checks.find((c) => c.id === 'pool').detail, 'non lisible');
  assert.equal(verdict.installed, false);
});

test('le verdict suit le pool DEMANDÉ, pas seulement celui que la Forge déclare', () => {
  const report = parseDiagnostic(FORGE_CONFORME);
  assert.equal(conformity(report, { poolName: 'tank', bridgeName: 'sparkbr0' })
    .checks.find((check) => check.id === 'pool').ok, false);
});

/**
 * Serveur dédié partitionné à la commande (docs/DAT.md §8.6), AVANT que le pool
 * n'existe : `sda5`/`sdb5` sont réservées et vides. C'est le matériel que le
 * produit vise, et le miroir natif y était pourtant impossible à proposer.
 */
const METAL_NEUF = [
  'racine\t/dev/md1', 'espace_racine\t210108399616:193670443008',
  'bloc\tNAME="sda" TYPE="disk" SIZE="6001175126016" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
  'bloc\tNAME="sda1" TYPE="part" SIZE="536870912" FSTYPE="" MOUNTPOINT="" PKNAME="sda" PARTTYPE="21686148-6449-6e6f-744e-656564454649"',
  'bloc\tNAME="sda2" TYPE="part" SIZE="4294967296" FSTYPE="swap" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  'bloc\tNAME="sda3" TYPE="part" SIZE="536870912" FSTYPE="linux_raid_member" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  'bloc\tNAME="md0" TYPE="raid1" SIZE="535822336" FSTYPE="ext4" MOUNTPOINT="/boot" PKNAME="sda3" PARTTYPE=""',
  'bloc\tNAME="sda4" TYPE="part" SIZE="214748364800" FSTYPE="linux_raid_member" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  'bloc\tNAME="md1" TYPE="raid1" SIZE="214613098496" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sda4" PARTTYPE=""',
  'bloc\tNAME="sda5" TYPE="part" SIZE="5781055938048" FSTYPE="" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  'bloc\tNAME="sdb" TYPE="disk" SIZE="6001175126016" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
  'bloc\tNAME="sdb1" TYPE="part" SIZE="536870912" FSTYPE="" MOUNTPOINT="" PKNAME="sdb" PARTTYPE="21686148-6449-6e6f-744e-656564454649"',
  'bloc\tNAME="sdb2" TYPE="part" SIZE="4294967296" FSTYPE="swap" MOUNTPOINT="" PKNAME="sdb" PARTTYPE=""',
  'bloc\tNAME="sdb3" TYPE="part" SIZE="536870912" FSTYPE="linux_raid_member" MOUNTPOINT="" PKNAME="sdb" PARTTYPE=""',
  'bloc\tNAME="md0" TYPE="raid1" SIZE="535822336" FSTYPE="ext4" MOUNTPOINT="/boot" PKNAME="sdb3" PARTTYPE=""',
  'bloc\tNAME="sdb4" TYPE="part" SIZE="214748364800" FSTYPE="linux_raid_member" MOUNTPOINT="" PKNAME="sdb" PARTTYPE=""',
  'bloc\tNAME="md1" TYPE="raid1" SIZE="214613098496" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sdb4" PARTTYPE=""',
  'bloc\tNAME="sdb5" TYPE="part" SIZE="5781055938048" FSTYPE="" MOUNTPOINT="" PKNAME="sdb" PARTTYPE=""',
].join('\n');

test('une paire de PARTITIONS dédiées forme le miroir, sur le disque du système', () => {
  // Le défaut du 2026-09-02 : seuls les disques ENTIERS étaient candidats, donc
  // le miroir n'était jamais proposable sur le matériel que le produit vise.
  const storage = storageProposal(parseDiagnostic(METAL_NEUF));
  assert.deepEqual(storage.nativeMirror.devices.sort(), ['sda5', 'sdb5']);
  assert.equal(storage.nativeMirror.eligible, true);
  assert.equal(storage.nativeMirror.refusal, null);
  const motif = (nom) => storage.supports.find((support) => support.name === nom).reasons;
  assert.deepEqual(motif('sda5'), [], 'la partition réservée est libre');
  // Le disque qui la porte reste exclu EN TANT QUE DISQUE, avec son motif.
  assert.match(motif('sda').join(' '), /porte la racine.*porte des partitions/);
  // Les DEUX disques portent la racine à travers le miroir logiciel.
  assert.match(motif('sdb').join(' '), /porte la racine/);
  // Une partition d'amorçage n'a ni signature ni montage : sans son type GPT,
  // elle passerait pour un support libre de 537 Mo.
  assert.match(motif('sda1').join(' '), /amorçage BIOS/);
  assert.deepEqual(storage.supports.filter((s) => s.reasons.length === 0)
    .map((s) => s.name).sort(), ['sda5', 'sdb5']);
});

test('deux supports libres sur le MÊME disque ne font pas un miroir', () => {
  const storage = storageProposal(parseDiagnostic([
    'racine\t/dev/sda1',
    'bloc\tNAME="sda" TYPE="disk" SIZE="900" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
    'bloc\tNAME="sda1" TYPE="part" SIZE="300" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sda" PARTTYPE=""',
    'bloc\tNAME="sda2" TYPE="part" SIZE="300" FSTYPE="" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
    'bloc\tNAME="sda3" TYPE="part" SIZE="300" FSTYPE="" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  ].join('\n')));
  assert.equal(storage.nativeMirror.eligible, false);
  assert.equal(storage.nativeMirror.refusal,
    'tous les supports libres sont sur le même disque physique');
  assert.deepEqual(storage.free.sort(), ['sda2', 'sda3']);
});

test('un VPS dont les disques sont montés nomme son refus, il ne le tait pas', () => {
  const storage = storageProposal(parseDiagnostic([
    'racine\t/dev/vda1', 'espace_racine\t100000:50000',
    'bloc\tNAME="vda" TYPE="disk" SIZE="90000" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
    'bloc\tNAME="vda1" TYPE="part" SIZE="89000" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="vda" PARTTYPE=""',
    'bloc\tNAME="vdb" TYPE="disk" SIZE="50000" FSTYPE="ext4" MOUNTPOINT="/data" PKNAME="" PARTTYPE=""',
  ].join('\n')));
  assert.equal(storage.nativeMirror.eligible, false);
  assert.equal(storage.nativeMirror.refusal, 'aucun support libre');
  assert.equal(storage.filePool.possible, true);
  assert.match(storage.supports.find((s) => s.name === 'vdb').reasons.join(' '), /monté sur \/data/);
});

test('un seul support libre n’est pas un miroir, et le refus le DIT', () => {
  const storage = storageProposal(parseDiagnostic([
    'racine\t/dev/vda1',
    'bloc\tNAME="vda" TYPE="disk" SIZE="90000" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
    'bloc\tNAME="vda1" TYPE="part" SIZE="89000" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="vda" PARTTYPE=""',
    'bloc\tNAME="vdb" TYPE="disk" SIZE="50000" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
  ].join('\n')));
  assert.equal(storage.nativeMirror.eligible, false);
  assert.equal(storage.nativeMirror.refusal, 'un seul support libre');
  assert.deepEqual(storage.free, ['vdb']);
});

test('le zpool est relevé, et « zpool import » ne fait que LISTER', () => {
  // §50.3 : sans argument, `zpool import` énumère les candidats ; il n'importe
  // rien. Un relevé qui importerait cesserait d'être en lecture seule.
  assert.match(DIAGNOSTIC_SCRIPT, /admin zpool list -H -o name,health/);
  assert.match(DIAGNOSTIC_SCRIPT, /admin zpool import\b/);
  assert.ok(!/zpool import -a|zpool import [a-z]/.test(DIAGNOSTIC_SCRIPT));
  assert.ok(!/zpool (create|destroy|add|remove|replace)/.test(DIAGNOSTIC_SCRIPT));

  const report = parseDiagnostic([
    'zpool\tspark ONLINE', 'zpool\ttank DEGRADED',
    'zpool_importable\tvieux', 'zpool_importable\tvieux',
    'zpool_importable\t  no pools available to import',
  ].join('\n'));
  assert.deepEqual(report.zpools,
    [{ name: 'spark', health: 'ONLINE' }, { name: 'tank', health: 'DEGRADED' }]);
  assert.deepEqual(report.importableZpools, ['vieux'], 'dédoublonné, et le bruit écarté');
});

test('le zpool et le pool Incus sont DEUX objets : la décision les distingue', () => {
  // Mesuré le 2026-09-02 : le pool Incus ne porte qu'un `zfs.pool_name` qui
  // référence le zpool. Une machine réinstallée en conservant ses disques a donc
  // son pool intact et invisible d'Incus.
  const incusEtZpool = parseDiagnostic('pools\tspark,zfs,,1,CREATED;\nzpool\tspark ONLINE');
  assert.deepEqual(poolDecision(incusEtZpool, 'spark'),
    { kind: 'reuse', zpool: 'spark', imported: true });

  const zpoolSeul = parseDiagnostic('zpool\tspark ONLINE');
  assert.deepEqual(poolDecision(zpoolSeul, 'spark'),
    { kind: 'adopt', zpool: 'spark', imported: true });

  const importable = parseDiagnostic('zpool_importable\tspark');
  assert.deepEqual(poolDecision(importable, 'spark'),
    { kind: 'adopt', zpool: 'spark', imported: false });

  assert.equal(poolDecision(parseDiagnostic('os\tubuntu 26.04'), 'spark'), null);
  assert.equal(poolDecision(zpoolSeul, 'tank'), null, 'un AUTRE nom n’est pas adopté');
});

// --- SPK-176 · §70.6 : le relevé de « zpool upgrade » ---------------------
// @verifies docs/BACKLOG.md#SPK-176 · docs/DAT.md §70.6

import { execFileSync } from 'node:child_process';
import { parseZfsUpgrade, DIAGNOSTIC_SCRIPT as SCRIPT_176 } from './forge-diagnostic.js';

/** Sortie RÉELLE de `zpool upgrade` sur `spark-010`, le 2026-11-18. */
const ZPOOL_UPGRADE_REEL = `This system supports ZFS pool feature flags.

All pools are formatted using feature flags.


Some supported features are not enabled on the following pools. Once a
feature is enabled the pool may become incompatible with software
that does not support the feature. See zpool-features(7) for details.

Note that the pool 'compatibility' feature can be used to inhibit
feature upgrades.

Features marked with (*) are not applied automatically on upgrade, and
must be applied explicitly with zpool-set(7).

POOL  FEATURE
---------------
spark
      redaction_list_spill
      raidz_expansion
      fast_dedup
      longname
      large_microzap
      dynamic_gang_header(*)
      block_cloning_endian
      physical_rewrite
`;

test('le filtre du script fermé rend une ligne par pool, sur la sortie RÉELLE', () => {
  const awk = /awk '\n([\s\S]*?)' \| head -n 16 \|\n\s*while IFS= read -r ligne; do dit zfs_a_niveau/.exec(SCRIPT_176);
  assert.ok(awk, 'le filtre de zpool upgrade est dans le script');
  const sortie = execFileSync('awk', [awk[1]], { input: ZPOOL_UPGRADE_REEL }).toString().trim();
  assert.equal(sortie, 'spark:redaction_list_spill,raidz_expansion,fast_dedup,longname,'
    + 'large_microzap,dynamic_gang_header(*),block_cloning_endian,physical_rewrite');
  const aJour = 'This system supports ZFS pool feature flags.\n\nEvery feature flags pool has all supported and requested features enabled.\n';
  assert.equal(execFileSync('awk', [awk[1]], { input: aJour }).toString(), '');
});

test('une ligne de relevé devient un pool, ses fonctionnalités, et les manuelles à part', () => {
  assert.deepEqual(parseZfsUpgrade('spark:fast_dedup,longname,dynamic_gang_header(*)'),
    { pool: 'spark', features: ['fast_dedup', 'longname'], manual: ['dynamic_gang_header'] });
  assert.equal(parseZfsUpgrade('spark:dynamic_gang_header(*)'), null, 'rien à activer par upgrade');
  assert.equal(parseZfsUpgrade('<b>:x'), null);
  assert.deepEqual(parseZfsUpgrade('spark:ok,<script>').features, ['ok']);
  const report = parseDiagnostic('os\tubuntu 26.04\nzfs_a_niveau\tspark:longname\nzfs_a_niveau\tbruit');
  assert.deepEqual(report.zfsUpgradable, [{ pool: 'spark', features: ['longname'], manual: [] }]);
});

// --- SPK-177 · §70.8 : l'unité de Caddy que le produit emploie --------------
// @verifies docs/BACKLOG.md#SPK-177 · docs/DAT.md §70.8 · §51.5

import { conformity as conformite177 } from './forge-diagnostic.js';

/** Relevé RÉEL de `spark-010` le 2026-11-18 : caddy-api actif, caddy.service masqué. */
const SPARK_010 = 'os\tubuntu 26.04\nsudo\toui\ncaddy_api_actif\tactive\ncaddy_actif\tinactive';

test('Caddy porté par caddy-api.service est CONFORME, et le détail nomme les deux unités', () => {
  const caddy = conformite177(parseDiagnostic(SPARK_010)).checks.find((c) => c.id === 'caddy');
  assert.equal(caddy.ok, true);
  assert.equal(caddy.detail, 'caddy-api.service : active · caddy.service : inactive');
});

test('une Forge d’avant SPK-129, où seul caddy.service tourne, reste à faire et le dit', () => {
  const caddy = conformite177(parseDiagnostic('os\tubuntu 26.04\ncaddy_api_actif\tinactive\ncaddy_actif\tactive'))
    .checks.find((c) => c.id === 'caddy');
  assert.equal(caddy.ok, false);
  assert.match(caddy.detail, /caddy-api\.service : inactive · caddy\.service : active/);
});

test('le script fermé relève les DEUX unités', () => {
  assert.match(SCRIPT_176, /dit caddy_api_actif "\$\(systemctl is-active caddy-api\.service/);
  assert.match(SCRIPT_176, /dit caddy_actif "\$\(systemctl is-active caddy\.service/);
});
