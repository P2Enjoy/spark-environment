/**
 * Plan fermé d'installation distante d'une Forge.
 *
 * @spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.3-§50.5 ·
 *       docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 *
 * Cette tranche ne lance encore aucune écriture. Elle transforme un NOUVEAU
 * diagnostic réel en un plan validé : l'étape suivante pourra ainsi exécuter
 * uniquement ce contrat, sans accepter de commande construite par la page.
 */

import { conformity, poolDecision, GIB } from './forge-diagnostic.js';

export { GIB };
export const INSTALL_DEFAULTS = Object.freeze({
  poolName: 'spark',
  bridgeName: 'sparkbr0',
  cpuReserve: 0.5,
  memoryReserveGib: 2,
  arcMaxGib: 16,
  reservedPorts: [22, 80, 443],
});

export class ForgeInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

function positiveNumber(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new ForgeInstallError('invalid_plan', `${label} doit être un nombre ${
      allowZero ? 'positif ou nul' : 'strictement positif'}.`);
  }
  return number;
}

/**
 * Les défauts d'un plan, dans l'ordre de priorité qui évite la réécriture muette.
 *
 * Le §50.4 veut que la reprise conserve ce qui est conforme. Une Forge déjà
 * installée porte sa configuration dans `/etc/sparkd/sparkd.env`, et c'est ELLE
 * qui fait foi : reproposer les valeurs du contrat de déploiement ferait
 * remplacer un pool « tank » par un pool « spark » sans que personne l'ait
 * demandé. Le contrat ne sert donc que là où la Forge ne dit rien encore.
 */
export function installDefaults(report) {
  const observed = report?.config ?? {};
  const nombre = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
  const ports = [...new Set([...INSTALL_DEFAULTS.reservedPorts,
                             ...(observed.reservedPorts ?? [])])].sort((a, b) => a - b);
  return {
    poolName: observed.poolName ?? INSTALL_DEFAULTS.poolName,
    bridgeName: observed.bridgeName ?? INSTALL_DEFAULTS.bridgeName,
    cpuReserve: nombre(observed.cpuReserve) ?? INSTALL_DEFAULTS.cpuReserve,
    memoryReserveGib: nombre(observed.memoryReserveGib) ?? INSTALL_DEFAULTS.memoryReserveGib,
    arcMaxGib: nombre(observed.arcMaxGib) ?? INSTALL_DEFAULTS.arcMaxGib,
    reservedPorts: ports,
  };
}

/**
 * Statut de chaque phase AVANT toute écriture, déduit du relevé et de lui seul.
 *
 * Une phase n'est « terminée » que sur un constat, jamais sur une intention :
 * `verification` attend les deux codes mesurés de `/healthz` et `/readyz`
 * (SPK-DS-12), et `control` exige en plus que la configuration demandée soit
 * DÉJÀ celle de la Forge — sinon l'exécuteur réécrira l'environnement.
 */
export function phaseStatuses(report, config, storagePlan) {
  const verdict = conformity(report, config);
  const ok = (id) => verdict.checks.find((check) => check.id === id)?.ok === true;
  const observed = report?.config ?? null;
  // `SPARKD_RESERVED_PORTS` ne porte que les ports EN PLUS des trois réservés
  // du contrat : comparer les listes entières verrait un écart permanent.
  const extras = (ports) => [...new Set((ports ?? []).map(Number)
    .filter((port) => !INSTALL_DEFAULTS.reservedPorts.includes(port)))]
    .sort((a, b) => a - b).join(',');
  const configUnchanged = Boolean(observed) &&
    observed.poolName === config.poolName && observed.bridgeName === config.bridgeName &&
    Number(observed.cpuReserve) === Number(config.cpuReserve) &&
    Number(observed.memoryReserveGib) === Number(config.memoryReserveGib) &&
    Number(observed.arcMaxGib) === Number(config.arcMaxGib) &&
    extras(observed.reservedPorts) === extras(config.reservedPorts);
  return {
    access: 'done',
    // Un pool ZFS listé prouve la pile ZFS ; Incus, Caddy et Python sont relevés.
    dependencies: ok('incus') && ok('caddy') && ok('pool') && Boolean(report?.runtimes?.python)
      ? 'done' : 'pending',
    // Adopter reste une écriture : le pool Incus n'existe pas encore.
    storage: storagePlan.kind === 'reuse' ? 'done' : 'pending',
    foundation: ok('bridge') ? 'done' : 'pending',
    control: ok('package') && ok('unit') && configUnchanged ? 'done' : 'pending',
    verification: ok('healthz') && ok('readyz') ? 'done' : 'pending',
  };
}

/** Produit un plan uniquement depuis des valeurs fermées et le relevé courant. */
export function createInstallPlan(diagnostic, input = {}) {
  const report = diagnostic?.report;
  const storage = diagnostic?.storage;
  if (!report || !storage || diagnostic?.transport !== 'established') {
    throw new ForgeInstallError('diagnostic_required',
      'Un diagnostic SSH complet et actuel est requis avant le plan.');
  }
  if (!['racine', 'oui'].includes(report.access?.sudo)) {
    throw new ForgeInstallError('sudo_required',
      'La Forge doit offrir root ou sudo sans invite avant toute installation.');
  }

  const defauts = installDefaults(report);
  const poolName = String(input.poolName ?? defauts.poolName).trim();
  const bridgeName = String(input.bridgeName ?? defauts.bridgeName).trim();
  if (!NAME.test(poolName) || !NAME.test(bridgeName)) {
    throw new ForgeInstallError('invalid_plan',
      'Les noms du pool et du bridge doivent commencer par une lettre et ne contenir que a-z, 0-9 ou - .');
  }

  const cpuReserve = positiveNumber(input.cpuReserve ?? defauts.cpuReserve,
    'La réserve CPU', { allowZero: true });
  const memoryReserveGib = positiveNumber(
    input.memoryReserveGib ?? defauts.memoryReserveGib,
    'La réserve mémoire', { allowZero: true });
  const arcMaxGib = positiveNumber(input.arcMaxGib ?? defauts.arcMaxGib,
    'Le plafond ARC');
  const memoryBytes = report.system?.memoryBytes;
  if (Number.isFinite(memoryBytes) && (memoryReserveGib + arcMaxGib) * GIB >= memoryBytes) {
    throw new ForgeInstallError('memory_too_small',
      'La réserve mémoire et le plafond ARC laisseraient zéro mémoire allouable aux Sparks.');
  }

  // §8.5 révisé : DEUX branches, et pas de troisième. Soit un pool ZFS existe et
  // on l'adopte sans rien écrire sur les données, soit deux supports libres sur
  // deux disques distincts forment le miroir, soit la machine n'est pas une
  // Forge — et le refus le nomme au lieu de basculer vers un repli.
  const existing = poolDecision(report, poolName);
  let storagePlan;
  if (existing?.kind === 'reuse') {
    storagePlan = { kind: 'reuse', poolName, driver: 'zfs', destructive: false };
  } else if (existing?.kind === 'adopt') {
    storagePlan = { kind: 'adopt', poolName, driver: 'zfs', zpool: existing.zpool,
      imported: existing.imported, destructive: false };
  } else {
    const eligible = storage.nativeMirror?.devices ?? [];
    // Sans désignation explicite, le plan reprend LA paire que ce diagnostic
    // vient de déclarer libre — celle-là même que l'écran nomme. Ce n'est pas un
    // effacement automatique : l'engagement exige encore la frappe de
    // « EFFACER /dev/… /dev/… », qui nomme chaque support (§50.4).
    const requested = Array.isArray(input.devices) ? input.devices.map(String)
      : typeof input.devices === 'string' && input.devices.trim()
        ? input.devices.split(',').map((device) => device.trim()).filter(Boolean)
        : eligible;
    if (!storage.nativeMirror?.eligible) {
      throw new ForgeInstallError('not_eligible',
        `Cette machine n’est pas une Forge installable : ${
          storage.nativeMirror?.refusal ?? 'le relevé ne déclare aucun support libre'}. ` +
        'Une Forge exige un pool ZFS existant, ou deux supports libres sur deux ' +
        'disques distincts. Le remède est en amont : commander la machine ' +
        'partitionnée, ou lui ajouter un disque.');
    }
    if (requested.length !== 2 || requested.some((device) => !eligible.includes(device))) {
      throw new ForgeInstallError('unsafe_devices',
        'Le miroir doit reprendre exactement deux supports déclarés libres par le nouveau diagnostic.');
    }
    storagePlan = { kind: 'native', poolName, driver: 'zfs',
      devices: requested.map((device) => `/dev/${device}`), destructive: true };
  }

  const config = { poolName, bridgeName, cpuReserve, memoryReserveGib, arcMaxGib,
    reservedPorts: [...defauts.reservedPorts] };
  // Les statuts viennent du relevé : une Forge déjà conforme montre ses phases
  // « terminée » au lieu de se voir proposer une installation entière (§50.4).
  const statuses = phaseStatuses(report, config, storagePlan);
  const phases = [
    ['access', 'Accès et nouveau relevé'],
    ['dependencies', 'Dépendances et runtimes'],
    ['storage', { reuse: `Conserver le pool « ${poolName} »`,
      adopt: `Adopter le pool ZFS « ${poolName} » déjà présent`,
      native: `Créer le pool « ${poolName} »` }[storagePlan.kind]],
    ['foundation', `Socle réseau « ${bridgeName} » et durcissement`],
    ['control', 'Paquet sparkd et unités systemd'],
    ['verification', 'Préflight, healthz, readyz et topologie'],
  ].map(([id, label]) => ({ id, label, status: statuses[id] }));

  return {
    version: 1,
    system: { os: report.system?.os ?? null, architecture: report.system?.architecture ?? null },
    storage: storagePlan,
    config,
    phases,
  };
}
