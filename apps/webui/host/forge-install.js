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

export const GIB = 1024 ** 3;
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

function poolFrom(line) {
  const [name, driver] = String(line ?? '').split(',').map((value) => value.trim());
  return name && driver ? { name, driver } : null;
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

  const poolName = String(input.poolName ?? INSTALL_DEFAULTS.poolName).trim();
  const bridgeName = String(input.bridgeName ?? INSTALL_DEFAULTS.bridgeName).trim();
  if (!NAME.test(poolName) || !NAME.test(bridgeName)) {
    throw new ForgeInstallError('invalid_plan',
      'Les noms du pool et du bridge doivent commencer par une lettre et ne contenir que a-z, 0-9 ou - .');
  }

  const cpuReserve = positiveNumber(input.cpuReserve ?? INSTALL_DEFAULTS.cpuReserve,
    'La réserve CPU', { allowZero: true });
  const memoryReserveGib = positiveNumber(
    input.memoryReserveGib ?? INSTALL_DEFAULTS.memoryReserveGib,
    'La réserve mémoire', { allowZero: true });
  const arcMaxGib = positiveNumber(input.arcMaxGib ?? INSTALL_DEFAULTS.arcMaxGib,
    'Le plafond ARC');
  const memoryBytes = report.system?.memoryBytes;
  if (Number.isFinite(memoryBytes) && (memoryReserveGib + arcMaxGib) * GIB >= memoryBytes) {
    throw new ForgeInstallError('memory_too_small',
      'La réserve mémoire et le plafond ARC laisseraient zéro mémoire allouable aux Sparks.');
  }

  const pools = (report.pools ?? []).map(poolFrom).filter(Boolean);
  const existing = pools.find((pool) => pool.name === poolName && pool.driver === 'zfs');
  let storagePlan;
  if (existing) {
    storagePlan = { kind: 'reuse', poolName, driver: 'zfs', destructive: false };
  } else if (input.storageKind === 'native') {
    const eligible = storage.nativeMirror?.disks ?? [];
    const requested = Array.isArray(input.devices) ? input.devices.map(String) : [];
    if (!storage.nativeMirror?.eligible || requested.length !== 2 ||
        requested.some((device) => !eligible.includes(device))) {
      throw new ForgeInstallError('unsafe_devices',
        'Le miroir doit reprendre exactement deux supports déclarés libres par le nouveau diagnostic.');
    }
    storagePlan = { kind: 'native', poolName, driver: 'zfs',
      devices: requested.map((device) => `/dev/${device}`), destructive: true };
  } else if (input.storageKind === 'file') {
    const sizeGib = positiveNumber(input.filePoolSizeGib, 'La taille du pool fichier');
    const reserveGib = positiveNumber(input.rootReserveGib,
      'La réserve conservée sur la racine', { allowZero: true });
    const requiredBytes = (sizeGib + reserveGib) * GIB;
    if (!Number.isFinite(storage.filePool?.availableBytes)) {
      throw new ForgeInstallError('storage_unknown',
        'L’espace libre de la racine n’a pas été mesuré ; le pool fichier est refusé.');
    }
    if (requiredBytes > storage.filePool.availableBytes) {
      throw new ForgeInstallError('storage_too_small',
        `${sizeGib} Gio de pool et ${reserveGib} Gio de réserve dépassent l’espace libre mesuré.`);
    }
    storagePlan = { kind: 'file', poolName, driver: 'zfs', sizeGib, reserveGib,
      path: `/var/lib/incus/disks/${poolName}.img`, destructive: false };
  } else {
    throw new ForgeInstallError('storage_choice_required',
      'Choisissez explicitement le miroir natif ou le pool fichier.');
  }

  const phases = [
    ['access', 'Accès et nouveau relevé', 'done'],
    ['dependencies', 'Dépendances et runtimes', 'pending'],
    ['storage', storagePlan.kind === 'reuse' ? `Conserver le pool « ${poolName} »`
      : `Créer le pool « ${poolName} »`, storagePlan.kind === 'reuse' ? 'done' : 'pending'],
    ['foundation', `Socle réseau « ${bridgeName} » et durcissement`, 'pending'],
    ['control', 'Paquet sparkd et unités systemd', 'pending'],
    ['verification', 'Préflight, healthz, readyz et topologie', 'pending'],
  ].map(([id, label, status]) => ({ id, label, status }));

  return {
    version: 1,
    system: { os: report.system?.os ?? null, architecture: report.system?.architecture ?? null },
    storage: storagePlan,
    config: { poolName, bridgeName, cpuReserve, memoryReserveGib, arcMaxGib,
      reservedPorts: [...INSTALL_DEFAULTS.reservedPorts] },
    phases,
  };
}
