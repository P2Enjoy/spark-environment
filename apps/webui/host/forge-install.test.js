/**
 * @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.2 bis (relevé du socle avec
 *           le droit d'administration), §50.4 (le plan reprend la configuration
 *           déclarée et saute ce qui est constaté conforme) ·
 *           docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiagnostic, storageProposal, conformity } from './forge-diagnostic.js';
import { createInstallPlan, installDefaults, phaseStatuses,
         INSTALL_DEFAULTS, ForgeInstallError } from './forge-install.js';

/** Relevé d'une Forge réellement installée, dans le protocole du script. */
const CONFORME = [
  'os\tubuntu 26.04', 'architecture\tx86_64', 'memoire_octets\t101193396224',
  'racine\t/dev/md1', 'espace_racine\t210108399616:193670443008', 'sudo\toui',
  'incus_version\tClient version: 7.4', 'caddy_version\t2.6.2',
  'python_version\tPython 3.14.4', 'sparkd_version\t0.post1.dev674+g5d1906e79',
  'sparkd_actif\tactive', 'sparkd_active\tenabled', 'caddy_actif\tactive',
  'pools\tspark,zfs,,1,CREATED;',
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

test('sans droit d’administration le pool est invisible, et le plan le refuse', () => {
  // C'est le défaut constaté le 2026-09-02 : `incus` lancé sans le droit rendait
  // son mode d'emploi, le pool `spark` disparaissait, et l'assistant proposait
  // d'en créer un second sur une Forge qui en portait déjà un.
  const nu = diagnostic(CONFORME.replace('pools\tspark,zfs,,1,CREATED;', 'pools\t'));
  assert.throws(() => createInstallPlan(nu, {}),
    (error) => error instanceof ForgeInstallError && error.code === 'storage_choice_required');
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
