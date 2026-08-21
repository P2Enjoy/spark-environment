/**
 * Diagnostic, strictement en lecture seule, d'une Forge joignable par SSH.
 *
 * @spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.1 (transport distinct du
 *       plan de contrôle), §50.2 (contrat fermé), §50.3 (stockage sans choix
 *       implicite) · docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 *
 * Le navigateur ne fournit qu'un NOM de serveur déjà validé par l'inventaire.
 * Il ne fournit ni commande ni argument distant : ce fichier possède le seul
 * script exécuté, et ne fait que le transmettre à `sh -s` sur la Forge.
 */

import { spawn } from 'node:child_process';

export const DIAGNOSTIC_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 96 * 1024;

export class ForgeDiagnosticError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Script fermé, versionné avec la console. Il n'écrit rien et ne reçoit aucune
 * interpolation venant du navigateur. Le protocole tabulé limite chaque valeur
 * à une ligne, afin qu'une sortie inhabituelle ne puisse pas devenir du HTML ou
 * une pseudo-commande au retour.
 */
export const DIAGNOSTIC_SCRIPT = String.raw`#!/bin/sh
set -u

nettoie() {
  printf '%s' "__DOLLAR__{1-}" | tr '\r\n\t' '   ' | cut -c1-2048
}

dit() {
  printf '%s\t%s\n' "$1" "$(nettoie "__DOLLAR__{2-}")"
}

commande() {
  cle="$1"
  shift
  if command -v "$1" >/dev/null 2>&1; then
    dit "$cle" "$("$@" 2>&1 | head -n 1 || true)"
  else
    dit "$cle" ""
  fi
}

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  dit os "__DOLLAR__{ID-} __DOLLAR__{VERSION_ID-}"
else
  dit os ""
fi
dit architecture "$(uname -m 2>/dev/null || true)"
dit identite "$(id -un 2>/dev/null || true)"
dit memoire_octets "$(awk '/MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo 2>/dev/null || true)"
dit racine "$(findmnt -n -o SOURCE / 2>/dev/null || true)"
dit espace_racine "$(df -B1 --output=size,avail / 2>/dev/null | awk 'NR == 2 { print $1 ":" $2 }')"

if [ "$(id -u 2>/dev/null || printf x)" = 0 ]; then
  dit sudo "racine"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  dit sudo "oui"
else
  dit sudo "non"
fi

commande incus_version incus version
commande caddy_version caddy version
commande python_version python3 --version
commande sparkd_version sparkd --version

if command -v systemctl >/dev/null 2>&1; then
  dit sparkd_actif "$(systemctl is-active sparkd.service 2>/dev/null || true)"
  dit sparkd_active "$(systemctl is-enabled sparkd.service 2>/dev/null || true)"
  dit caddy_actif "$(systemctl is-active caddy.service 2>/dev/null || true)"
else
  dit sparkd_actif ""
  dit sparkd_active ""
  dit caddy_actif ""
fi

if command -v incus >/dev/null 2>&1; then
  dit pools "$(incus storage list --format csv 2>/dev/null | tr '\n' ';' || true)"
else
  dit pools ""
fi

if command -v lsblk >/dev/null 2>&1; then
  # --raw et --pairs sont exclusifs. La forme --pairs, compacte et sans
  # tableau JSON à décoder sur la Forge, conserve une ligne structurée par bloc.
  lsblk -b -P -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,PKNAME 2>/dev/null |
    while IFS= read -r ligne; do dit bloc "$ligne"; done
fi
`.replaceAll('__DOLLAR__', '$');

/** Arguments OpenSSH, hors tout contrôle du navigateur. */
export function sshArgs(server) {
  const commun = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (server.kind === 'alias') return [...commun, server.sshHost, 'sh', '-s'];
  return [...commun, '-p', String(server.port), `${server.user}@${server.host}`, 'sh', '-s'];
}

/** Retire les échappements non utiles de la forme `lsblk -P`. */
export function parseBlock(line) {
  const values = {};
  for (const match of String(line).matchAll(/([A-Z]+)="([^"]*)"/g)) {
    values[match[1].toLowerCase()] = match[2];
  }
  const size = Number(values.size);
  if (!values.name || !values.type || !Number.isFinite(size) || size < 0) return null;
  const device = (value) => String(value ?? '').replace(/^\/dev\//, '');
  return {
    name: device(values.name),
    type: values.type,
    sizeBytes: size,
    filesystem: values.fstype || null,
    mountpoint: values.mountpoint || null,
    parent: values.pkname ? device(values.pkname) : null,
  };
}

/** Le protocole de DIAGNOSTIC_SCRIPT devient une donnée bornée et typée. */
export function parseDiagnostic(output) {
  const values = {};
  const blocks = [];
  for (const line of String(output ?? '').split('\n')) {
    const index = line.indexOf('\t');
    if (index < 1) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (key === 'bloc') {
      const block = parseBlock(value);
      if (block) blocks.push(block);
    } else if (/^[a-z_]+$/.test(key)) {
      values[key] = value || null;
    }
  }
  const [rootSize, rootAvailable] = String(values.espace_racine ?? '').split(':').map(Number);
  return {
    system: { os: values.os ?? null, architecture: values.architecture ?? null,
              identity: values.identite ?? null,
              memoryBytes: numberOrNull(values.memoire_octets),
              rootSource: values.racine ?? null,
              rootSizeBytes: numberOrNull(rootSize), rootAvailableBytes: numberOrNull(rootAvailable) },
    access: { sudo: values.sudo ?? null },
    runtimes: { incus: values.incus_version ?? null, caddy: values.caddy_version ?? null,
                python: values.python_version ?? null, sparkd: values.sparkd_version ?? null },
    services: { sparkd: values.sparkd_actif ?? null, sparkdEnabled: values.sparkd_active ?? null,
                caddy: values.caddy_actif ?? null },
    pools: values.pools ? values.pools.split(';').filter(Boolean) : [],
    blocks,
  };
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

/**
 * Classe le stockage sans décider. Une partition, un montage ou une signature
 * rend le disque parent impropre au miroir : l'incertitude est une exclusion.
 */
export function storageProposal(report) {
  const blocks = report?.blocks ?? [];
  const rootDevice = String(report?.system?.rootSource ?? '').replace(/^\/dev\//, '');
  const rootBlock = blocks.find((block) => block.name === rootDevice);
  const rootName = rootBlock?.parent ?? rootDevice.replace(/\d+$/, '');
  const reasons = new Map();
  for (const block of blocks) {
    const disk = block.type === 'disk' ? block.name : block.parent;
    if (!disk) continue;
    const reasonsForDisk = reasons.get(disk) ?? [];
    if (block.name === rootName || block.parent === rootName) reasonsForDisk.push('porte la racine');
    if (block.mountpoint) reasonsForDisk.push(`monté sur ${block.mountpoint}`);
    if (block.filesystem) reasonsForDisk.push(`signature ${block.filesystem}`);
    if (block.type !== 'disk' && !reasonsForDisk.includes('porte une partition')) {
      reasonsForDisk.push('porte une partition');
    }
    reasons.set(disk, [...new Set(reasonsForDisk)]);
  }
  const disks = blocks.filter((block) => block.type === 'disk').map((disk) => ({
    ...disk,
    reasons: reasons.get(disk.name) ?? ['information de stockage incomplète'],
  }));
  const eligible = disks.filter((disk) => disk.reasons.length === 0);
  return {
    disks,
    nativeMirror: eligible.length >= 2
      ? { eligible: true, disks: eligible.slice(0, 2).map((disk) => disk.name) }
      : { eligible: false, disks: [] },
    filePool: {
      possible: Number.isFinite(report?.system?.rootAvailableBytes),
      filesystem: report?.system?.rootSource ?? null,
      availableBytes: report?.system?.rootAvailableBytes ?? null,
      // La taille ne devient pas un défaut déguisé : le responsable la choisit
      // dans le plan et devra la confirmer avant la moindre écriture.
      sizeBytes: null,
    },
  };
}

/** Lance le script fermé, avec durée et volume bornés. */
export function runDiagnostic(server, {
  spawnFn = spawn, timeoutMs = DIAGNOSTIC_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  if (server.kind === 'local') {
    return Promise.reject(new ForgeDiagnosticError(
      'local_server', 'Le diagnostic d’installation distante ne s’applique pas à cette Forge locale.',
    ));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('ssh', sshArgs(server), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ForgeDiagnosticError('ssh_start_failed', `OpenSSH n’a pas pu démarrer : ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const take = (target, chunk) => {
      const next = target + String(chunk);
      if (Buffer.byteLength(next) > maxOutputBytes) { overflow = true; return target; }
      return next;
    };
    child.stdout?.on('data', (chunk) => { stdout = take(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = take(stderr, chunk); });
    child.on('error', (error) => reject(new ForgeDiagnosticError(
      'ssh_start_failed', `OpenSSH n’a pas pu démarrer : ${error.message}`,
    )));
    const timeout = setTimeout(() => {
      child.kill?.('SIGTERM');
      reject(new ForgeDiagnosticError('ssh_timeout', 'Le diagnostic SSH a dépassé 20 secondes.'));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (overflow) return reject(new ForgeDiagnosticError(
        'output_too_large', 'Le diagnostic a produit trop de données et a été arrêté.',
      ));
      if (code !== 0) return reject(new ForgeDiagnosticError(
        'ssh_failed', safeError(stderr) || `OpenSSH s’est arrêté (code ${code}).`,
      ));
      const report = parseDiagnostic(stdout);
      if (!report.system.os && !report.blocks.length) return reject(new ForgeDiagnosticError(
        'invalid_report', 'Le diagnostic distant n’a pas rendu un relevé exploitable.',
      ));
      resolve({ transport: 'established', report, storage: storageProposal(report) });
    });
    child.stdin?.end(DIAGNOSTIC_SCRIPT);
  });
}

function safeError(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2048);
}
