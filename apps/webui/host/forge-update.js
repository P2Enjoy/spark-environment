/**
 * Mise à jour distante, fermée et mesurée, de sparkd.
 *
 * @spec docs/BACKLOG.md#SPK-69 · docs/DAT.md §40.6 ·
 *       docs/DESIGN_SYSTEM_APP.md#SPK-DS-13
 *
 * Le navigateur ne fournit jamais ce que ce module exécute. Il donne un nom de
 * serveur à la route ; la route résout l'inventaire et ce module reçoit deux
 * commits déjà calculés par l'hôte. Les seules interpolations distantes sont
 * donc deux empreintes validées, dans une commande dont le texte vit ici.
 */

import { spawn } from 'node:child_process';

import { FORGE_EN_RETARD } from './build.js';

export const UPDATE_TIMEOUT_MS = 8 * 60 * 1000;
export const VERIFY_TIMEOUT_MS = 60 * 1000;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const SOURCE = 'git+https://github.com/P2Enjoy/spark-environment.git';

export class ForgeUpdateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Une seule situation autorise le geste, et la cible doit être téléchargeable.
 */
export function updateEligibility(comparison) {
  if (comparison?.verdict !== FORGE_EN_RETARD) {
    return { allowed: false, reason: 'La build de la Forge n’est pas un ancêtre sûr de ce poste.' };
  }
  const before = comparison?.forge?.commit;
  const target = comparison?.local?.head;
  if (!COMMIT_PATTERN.test(before ?? '') || !COMMIT_PATTERN.test(target ?? '')) {
    return { allowed: false, reason: 'Les empreintes avant et cible ne sont pas complètes.' };
  }
  if (comparison.local.branch !== 'main') {
    return { allowed: false, reason: 'La cible doit être la branche main.' };
  }
  if (comparison.local.published !== target) {
    return { allowed: false,
             reason: 'La tête de ce poste n’est pas encore publiée sur origin/main.' };
  }
  return { allowed: true, before, target };
}

/** Script POSIX fermé envoyé sur stdin. Aucun fragment ne vient de la page. */
export const UPDATE_SCRIPT = String.raw`#!/bin/sh
set -eu

target="__DOLLAR__{1-}"
previous="__DOLLAR__{2-}"

valid_commit() {
  printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$'
}

if ! valid_commit "$target" || ! valid_commit "$previous"; then
  printf '%s\t%s\t%s\n' SPARK_UPDATE guard failed
  exit 64
fi

as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

python=/opt/sparkd/venv/bin/python
pip=/opt/sparkd/venv/bin/pip
if [ ! -x "$python" ] || [ ! -x "$pip" ]; then
  printf '%s\t%s\t%s\n' SPARK_UPDATE guard failed
  printf '%s\n' 'Le venv /opt/sparkd/venv est absent ou incomplet.' >&2
  exit 66
fi
if [ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null; then
  printf '%s\t%s\t%s\n' SPARK_UPDATE guard failed
  printf '%s\n' 'sudo sans invite est indisponible.' >&2
  exit 77
fi

printf '%s\t%s\t%s\n' SPARK_UPDATE package in_progress
as_root env PIP_DISABLE_PIP_VERSION_CHECK=1 "$pip" install --upgrade --force-reinstall \
  "${SOURCE}@$target#subdirectory=services/sparkd"
printf '%s\t%s\t%s\n' SPARK_UPDATE package done

printf '%s\t%s\t%s\n' SPARK_UPDATE installer in_progress
as_root "$python" -m sparkd.install
printf '%s\t%s\t%s\n' SPARK_UPDATE installer done
`.replaceAll('__DOLLAR__', '$');

/** Arguments OpenSSH stricts. La clé d'hôte reste la décision d'OpenSSH. */
export function updateSshArgs(server, target, previous) {
  if (!COMMIT_PATTERN.test(target ?? '') || !COMMIT_PATTERN.test(previous ?? '')) {
    throw new ForgeUpdateError('invalid_commit', 'Empreinte Git invalide pour la mise à jour.');
  }
  if (server?.kind === 'local') {
    throw new ForgeUpdateError(
      'local_server', 'La mise à jour distante ne s’applique pas à une Forge locale.');
  }
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const destination = server?.kind === 'alias'
    ? [server.sshHost]
    : ['-p', String(server?.port ?? 22), `${server?.user}@${server?.host}`];
  return [...common, ...destination, 'sh', '-s', '--', target, previous];
}

function filteredDiagnostic(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(password|passphrase|secret|token)=\S+/gi, '$1=***')
    .slice(-4_000)
    .trim();
}

/** Transforme uniquement les jalons fermés en état présentable. */
export function parseStages(output) {
  const stages = {};
  for (const line of String(output ?? '').split('\n')) {
    const match = line.match(/^SPARK_(?:UPDATE|INSTALL)\t([a-z_]+)\t(in_progress|done|failed)$/);
    if (match) stages[match[1]] = match[2];
  }
  return stages;
}

/** Exécute une installation distante et borne durée, volume et diagnostic. */
export function runRemoteInstall(server, target, previous, {
  spawnFn = spawn, timeoutMs = UPDATE_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  let args;
  try {
    args = updateSshArgs(server, target, previous);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ForgeUpdateError(
        'ssh_start_failed', `OpenSSH n’a pas pu démarrer : ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let settled = false;
    let timer = null;
    const append = (current, chunk) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next) > maxOutputBytes) {
        overflow = true;
        return current;
      }
      return next;
    };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', (error) => finishError(new ForgeUpdateError(
      'ssh_start_failed', `OpenSSH n’a pas pu démarrer : ${error.message}`)));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stages = parseStages(stdout);
      const mutated = stages.package === 'done';
      if (overflow) {
        reject(new ForgeUpdateError(
          'output_too_large', 'La sortie distante a dépassé la limite de sécurité.',
          { mutated, stages }));
      } else if (code !== 0) {
        const diagnostic = filteredDiagnostic(stderr || stdout);
        reject(new ForgeUpdateError(
          'remote_install_failed',
          diagnostic || `La commande distante s’est terminée avec le code ${code ?? signal}.`,
          { mutated, stages, exitCode: code, signal }));
      } else {
        resolve({ mutated, stages });
      }
    });
    timer = setTimeout(() => {
      child.kill?.('SIGTERM');
      finishError(new ForgeUpdateError(
        'update_timeout', 'La mise à jour distante a dépassé huit minutes.',
        { mutated: parseStages(stdout).package === 'done', stages: parseStages(stdout) }));
    }, timeoutMs);
    timer.unref?.();
    child.stdin?.end(UPDATE_SCRIPT);
  });
}

async function readJson(fetchFn, url) {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(4_000) });
    let body = null;
    try { body = await response.json(); } catch { /* réponse non JSON : échec mesuré plus bas */ }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, body: null, error: error?.message ?? String(error) };
  }
}

/**
 * Attend que les trois vérités distantes concordent. HTTP 200 ne suffit pas à
 * readyz : le runtime répond aussi 200 lorsqu'il dit explicitement degraded.
 */
export async function verifyForge(localPort, expectedCommit, {
  fetchFn = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = VERIFY_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(localPort) || localPort <= 0 ||
      !COMMIT_PATTERN.test(expectedCommit ?? '')) {
    throw new ForgeUpdateError('invalid_verification', 'Cible de vérification invalide.');
  }
  const base = `http://127.0.0.1:${localPort}`;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    const [health, ready, forge] = await Promise.all([
      readJson(fetchFn, `${base}/healthz`),
      readJson(fetchFn, `${base}/readyz`),
      readJson(fetchFn, `${base}/v1/forge`),
    ]);
    last = {
      healthz: { status: health.status, state: health.body?.status ?? null,
                 commit: health.body?.build?.commit ?? null },
      readyz: { status: ready.status, state: ready.body?.status ?? null,
                detail: ready.body?.detail ?? ready.error ?? null },
      build: { status: forge.status, commit: forge.body?.build?.commit ?? null,
               version: forge.body?.build?.version ?? null },
    };
    if (health.ok && health.body?.status === 'ok' &&
        health.body?.build?.commit === expectedCommit &&
        ready.ok && ready.body?.status === 'ready' &&
        forge.ok && forge.body?.build?.commit === expectedCommit) {
      return { ok: true, expectedCommit, ...last };
    }
    if (Date.now() < deadline) await sleep(1_000);
  } while (Date.now() < deadline);
  return { ok: false, expectedCommit, ...last };
}

/** Une opération par Forge et un seul reçu de retour arrière, en mémoire. */
export class ForgeUpdateManager {
  constructor({ install = runRemoteInstall, verify = verifyForge } = {}) {
    this.install = install;
    this.verify = verify;
    this.busy = new Set();
    this.receipts = new Map();
  }

  rollbackOffer(serverName, currentCommit) {
    const receipt = this.receipts.get(serverName);
    return receipt && receipt.target === currentCommit
      ? { available: true, previous: receipt.before, current: receipt.target }
      : { available: false };
  }

  async #rollback(server, localPort, before, target) {
    try {
      const execution = await this.install(server, before, target);
      const verification = await this.verify(localPort, before);
      return verification.ok
        ? { state: 'success', target: before, stages: execution.stages, verification }
        : { state: 'failed', target: before, error: 'rollback_unverified', verification,
            stages: execution.stages };
    } catch (error) {
      return { state: 'failed', target: before,
               error: error.code ?? 'rollback_failed', message: error.message,
               stages: error.stages ?? {} };
    }
  }

  async update({ server, localPort, before, target, audit = async () => false }) {
    const name = server?.name;
    if (this.busy.has(name)) {
      throw new ForgeUpdateError('update_busy', 'Une opération agit déjà sur cette Forge.');
    }
    this.busy.add(name);
    try {
      let execution;
      try {
        execution = await this.install(server, target, before);
      } catch (error) {
        const rollback = error.mutated
          ? await this.#rollback(server, localPort, before, target) : null;
        return { state: 'failed', before, target,
                 error: error.code ?? 'update_failed', message: error.message,
                 stages: error.stages ?? {}, rollback };
      }
      const verification = await this.verify(localPort, target);
      if (!verification.ok) {
        return { state: 'failed', before, target, error: 'update_unverified',
                 message: 'La build ou les sondes distantes ne concordent pas.',
                 stages: execution.stages,
                 verification,
                 rollback: await this.#rollback(server, localPort, before, target) };
      }
      const journaled = await audit('forge.sparkd_update', before, target);
      const receipt = { server: name, before, target };
      this.receipts.set(name, receipt);
      return { state: 'success', before, target, stages: execution.stages,
               verification, journaled, receipt };
    } finally {
      this.busy.delete(name);
    }
  }

  async rollback({ server, localPort, currentCommit, audit = async () => false }) {
    const name = server?.name;
    if (this.busy.has(name)) {
      throw new ForgeUpdateError('update_busy', 'Une opération agit déjà sur cette Forge.');
    }
    const receipt = this.receipts.get(name);
    if (!receipt || receipt.target !== currentCommit) {
      throw new ForgeUpdateError(
        'rollback_unavailable', 'Le reçu ne concorde plus avec la build servie.');
    }
    this.busy.add(name);
    try {
      const journaled = await audit('forge.sparkd_rollback', receipt.target, receipt.before);
      const result = await this.#rollback(
        server, localPort, receipt.before, receipt.target);
      if (result.state === 'success') this.receipts.delete(name);
      return { ...result, before: receipt.target, journaled };
    } finally {
      this.busy.delete(name);
    }
  }
}
