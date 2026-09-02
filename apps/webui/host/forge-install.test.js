/**
 * @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.2 bis (relevé du socle avec
 *           le droit d'administration), §50.4 (le plan reprend la configuration
 *           déclarée et saute ce qui est constaté conforme) ·
 *           docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiagnostic, storageProposal, conformity,
         poolDecision } from './forge-diagnostic.js';
import { createInstallPlan, installDefaults, phaseStatuses,
         INSTALL_DEFAULTS, ForgeInstallError } from './forge-install.js';

/** Relevé d'une Forge réellement installée, dans le protocole du script. */
const CONFORME = [
  'os\tubuntu 26.04', 'architecture\tx86_64', 'memoire_octets\t101193396224',
  'racine\t/dev/md1', 'espace_racine\t210108399616:193670443008', 'sudo\toui',
  'incus_version\tClient version: 7.4', 'caddy_version\t2.6.2',
  'python_version\tPython 3.14.4', 'sparkd_version\t0.post1.dev674+g5d1906e79',
  'sparkd_actif\tactive', 'sparkd_active\tenabled', 'caddy_actif\tactive',
  'pools\tspark,zfs,,1,CREATED;', 'zpool\tspark ONLINE',
  'reseau\tsparkbr0,bridge,YES,10.77.0.1/24,none,,1,CREATED',
  'configuration\tSPARKD_CPU_RESERVE=0.5',
  'configuration\tSPARKD_MEMORY_RESERVE=2GiB',
  'configuration\tSPARKD_NETWORK_BRIDGE=sparkbr0',
  'configuration\tSPARKD_RESERVED_PORTS=',
  'configuration\tSPARKD_STORAGE_POOL=spark',
  'arc_max\t17179869184', 'healthz\t200', 'readyz\t200',
].join('\n');

function diagnostic(brut) {
  const report = parseDiagnostic(brut);
  return { transport: 'established', report, storage: storageProposal(report),
           conformity: conformity(report) };
}

test('le plan reprend la configuration DÉCLARÉE par la Forge, pas le contrat', () => {
  const report = parseDiagnostic(CONFORME
    .replace('SPARKD_STORAGE_POOL=spark', 'SPARKD_STORAGE_POOL=tank')
    .replace('SPARKD_NETWORK_BRIDGE=sparkbr0', 'SPARKD_NETWORK_BRIDGE=br1')
    .replace('SPARKD_CPU_RESERVE=0.5', 'SPARKD_CPU_RESERVE=1.5')
    .replace('SPARKD_RESERVED_PORTS=', 'SPARKD_RESERVED_PORTS=2222'));
  assert.deepEqual(installDefaults(report), {
    poolName: 'tank', bridgeName: 'br1', cpuReserve: 1.5, memoryReserveGib: 2,
    arcMaxGib: 16, reservedPorts: [22, 80, 443, 2222],
  });
  // Une machine muette, elle, retombe bien sur le contrat de déploiement.
  assert.deepEqual(installDefaults(parseDiagnostic('os\tubuntu 26.04')), {
    ...INSTALL_DEFAULTS, reservedPorts: [22, 80, 443],
  });
});

test('une Forge déjà conforme rend un plan de réutilisation, toutes phases terminées', () => {
  const plan = createInstallPlan(diagnostic(CONFORME), {});
  assert.deepEqual(plan.storage,
    { kind: 'reuse', poolName: 'spark', driver: 'zfs', destructive: false });
  assert.deepEqual(plan.phases.map((phase) => phase.status),
    ['done', 'done', 'done', 'done', 'done', 'done']);
  // Le contrat du plan version 1 reste fermé : l'exécuteur le revalide.
  assert.deepEqual(Object.keys(plan).sort(),
    ['config', 'phases', 'storage', 'system', 'version']);
});

test('un zpool présent qu’Incus ignore est ADOPTÉ, pas recréé', () => {
  // §50.3 : le zpool et le pool Incus sont deux objets. C'est l'état d'une
  // machine dont l'OS a été réinstallé en conservant ses disques de données ; la
  // traiter comme « aucun pool » ferait écrire sur des supports qui le portent.
  const brut = CONFORME.replace('pools\tspark,zfs,,1,CREATED;', 'pools\t');
  assert.deepEqual(poolDecision(parseDiagnostic(brut), 'spark'),
    { kind: 'adopt', zpool: 'spark', imported: true });
  const plan = createInstallPlan(diagnostic(brut), {});
  assert.deepEqual(plan.storage, { kind: 'adopt', poolName: 'spark', driver: 'zfs',
    zpool: 'spark', imported: true, destructive: false });
  assert.equal(plan.phases.find((phase) => phase.id === 'storage').label,
    'Adopter le pool ZFS « spark » déjà présent');
});

test('un zpool seulement IMPORTABLE est importé puis adopté', () => {
  const brut = CONFORME.replace('pools\tspark,zfs,,1,CREATED;', 'pools\t')
    .replace('zpool\tspark ONLINE', 'zpool_importable\tspark');
  const plan = createInstallPlan(diagnostic(brut), {});
  assert.deepEqual(plan.storage, { kind: 'adopt', poolName: 'spark', driver: 'zfs',
    zpool: 'spark', imported: false, destructive: false });
  // Adopter n'efface rien : aucune confirmation destructive n'est demandée.
  assert.equal(plan.storage.destructive, false);
});

test('une phase n’est terminée que sur un constat, jamais sur une intention', () => {
  const report = parseDiagnostic(CONFORME
    .replace('healthz\t200', 'healthz\t000').replace('readyz\t200', 'readyz\t'));
  const config = { ...installDefaults(report), reservedPorts: [22, 80, 443] };
  const statuses = phaseStatuses(report, config,
    { kind: 'reuse', poolName: 'spark', driver: 'zfs', destructive: false });
  assert.equal(statuses.verification, 'pending', '/healthz et /readyz font foi');
  assert.equal(statuses.control, 'done');

  // Demander une AUTRE configuration rouvre la phase qui la réécrira.
  const change = phaseStatuses(report, { ...config, memoryReserveGib: 8 },
    { kind: 'reuse', poolName: 'spark', driver: 'zfs', destructive: false });
  assert.equal(change.control, 'pending');
});

/** Serveur dédié partitionné à la commande, pool pas encore créé (§8.6). */
const METAL_NEUF = [
  'os\tubuntu 26.04', 'architecture\tx86_64', 'memoire_octets\t101193396224',
  'racine\t/dev/md1', 'espace_racine\t210108399616:193670443008', 'sudo\tracine',
  'incus_version\tClient version: 7.4', 'caddy_version\t2.6.2',
  'python_version\tPython 3.14.4', 'caddy_actif\tactive', 'pools\t',
  'bloc\tNAME="sda" TYPE="disk" SIZE="6001175126016" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
  'bloc\tNAME="sda4" TYPE="part" SIZE="214748364800" FSTYPE="linux_raid_member" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  'bloc\tNAME="md1" TYPE="raid1" SIZE="214613098496" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sda4" PARTTYPE=""',
  'bloc\tNAME="sda5" TYPE="part" SIZE="5781055938048" FSTYPE="" MOUNTPOINT="" PKNAME="sda" PARTTYPE=""',
  'bloc\tNAME="sdb" TYPE="disk" SIZE="6001175126016" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
  'bloc\tNAME="sdb4" TYPE="part" SIZE="214748364800" FSTYPE="linux_raid_member" MOUNTPOINT="" PKNAME="sdb" PARTTYPE=""',
  'bloc\tNAME="md1" TYPE="raid1" SIZE="214613098496" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sdb4" PARTTYPE=""',
  'bloc\tNAME="sdb5" TYPE="part" SIZE="5781055938048" FSTYPE="" MOUNTPOINT="" PKNAME="sdb" PARTTYPE=""',
].join('\n');

test('le miroir se pose sur les partitions dédiées du disque système', () => {
  // Sans désignation, le plan reprend la paire que CE relevé déclare libre ;
  // la confirmation destructive nomme ensuite chaque support.
  const plan = createInstallPlan(diagnostic(METAL_NEUF), {});
  assert.deepEqual(plan.storage, { kind: 'native', poolName: 'spark', driver: 'zfs',
    devices: ['/dev/sda5', '/dev/sdb5'], destructive: true });
  assert.equal(plan.phases.find((phase) => phase.id === 'storage').label,
    'Créer le pool « spark »');
});

test('un support qui n’est plus déclaré libre est refusé, avec sa cause', () => {
  const diag = diagnostic(METAL_NEUF);
  assert.throws(() => createInstallPlan(diag, { devices: ['sda4', 'sdb5'] }),
    (error) => error instanceof ForgeInstallError && error.code === 'unsafe_devices');
  // Une machine sans aucun support libre nomme le motif du refus.
  const vps = diagnostic([
    'os\tubuntu 26.04', 'architecture\tx86_64', 'memoire_octets\t68719476736',
    'racine\t/dev/vda1', 'espace_racine\t100000000000:50000000000', 'sudo\tracine',
    'bloc\tNAME="vda" TYPE="disk" SIZE="90000000000" FSTYPE="" MOUNTPOINT="" PKNAME="" PARTTYPE=""',
    'bloc\tNAME="vda1" TYPE="part" SIZE="89000000000" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="vda" PARTTYPE=""',
  ].join('\n'));
  assert.throws(() => createInstallPlan(vps, { storageKind: 'native' }),
    (error) => error instanceof ForgeInstallError && /aucun support libre/.test(error.message));
  // §8.5 révisé : il n'y a PLUS de disposition de repli. La machine est refusée,
  // et le refus nomme le geste qui le lève — en amont de la console.
  assert.throws(() => createInstallPlan(vps, {}),
    (error) => error instanceof ForgeInstallError && error.code === 'not_eligible'
      && /deux supports libres sur deux\s+disques distincts/.test(error.message)
      && /ajouter un disque/.test(error.message));
});

test('un bridge absent rouvre le socle réseau, et lui seul', () => {
  const report = parseDiagnostic(
    CONFORME.replace('reseau\tsparkbr0,bridge,YES,10.77.0.1/24,none,,1,CREATED',
                     'reseau\teno1,physical,NO,,,,0,'));
  const statuses = phaseStatuses(report, installDefaults(report),
    { kind: 'reuse', poolName: 'spark', driver: 'zfs', destructive: false });
  assert.equal(statuses.foundation, 'pending');
  assert.equal(statuses.dependencies, 'done');
  assert.equal(statuses.storage, 'done');
});
