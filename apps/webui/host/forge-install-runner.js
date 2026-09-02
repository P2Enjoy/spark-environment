/**
 * Orchestrateur local de l'installation distante d'une Forge.
 *
 * @spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4-§50.6 ·
 *       docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 *
 * Le navigateur ne fournit jamais une commande. Ce module amorce au besoin le
 * paquet épinglé sur la build publiée de la console, puis lance son exécuteur
 * versionné avec le plan fermé produit par `forge-install.js`. Son journal est
 * durable et distinct de l'inventaire : aucune clé ni sortie brute n'y entre.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_EVENTS = 256;
export const STATE_VERSION = 1;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const PHASES = new Set([
  'access', 'dependencies', 'storage', 'foundation', 'control', 'verification',
]);
const STATUSES = new Set(['pending', 'running', 'done', 'warning', 'failed', 'interrupted']);
const PYTHON = '/opt/sparkd/venv/bin/python';
const SOURCE = 'git+https://github.com/P2Enjoy/spark-environment.git';

/**
 * Script POSIX fermé : seul le commit complet, validé côté hôte, est variable.
 * Le marqueur est la seule sortie que le journal sait interpréter.
 */
export const BOOTSTRAP_SCRIPT = String.raw`#!/bin/sh
set -eu

target="__DOLLAR__{1-}"
if ! printf '%s\n' "$target" | grep -Eq '^[0-9a-f]{40}$'; then
  printf '%s\t%s\t%s\n' SPARK_BOOTSTRAP package failed
  exit 64
fi

as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

if [ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null; then
  printf '%s\t%s\t%s\n' SPARK_BOOTSTRAP package failed
  exit 77
fi

python=/opt/sparkd/venv/bin/python
pip=/opt/sparkd/venv/bin/pip
package_matches() {
  [ -x "$python" ] && [ -x "$pip" ] && as_root "$python" - "$target" <<'PY'
import sys

try:
    from sparkd.build import commit_du_paquet
    from sparkd.forge_install import main
except Exception:
    raise SystemExit(1)

commit = commit_du_paquet()
raise SystemExit(0 if commit and sys.argv[1].startswith(commit) and callable(main) else 1)
PY
}

if package_matches; then
  printf '%s\t%s\t%s\n' SPARK_BOOTSTRAP package unchanged
  exit 0
fi

failed=1
on_exit() {
  code=$?
  if [ "$failed" = 1 ] && [ "$code" != 0 ]; then
    printf '%s\t%s\t%s\n' SPARK_BOOTSTRAP package failed
  fi
  exit "$code"
}
trap on_exit EXIT

printf '%s\t%s\t%s\n' SPARK_BOOTSTRAP package in_progress
as_root env DEBIAN_FRONTEND=noninteractive apt-get -qq update
as_root env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y \
  ca-certificates git python3 python3-venv
as_root mkdir -p /opt/sparkd
if [ ! -x "$python" ] || [ ! -x "$pip" ]; then
  as_root python3 -m venv --clear /opt/sparkd/venv
fi
as_root env PIP_DISABLE_PIP_VERSION_CHECK=1 "$pip" install --quiet \
  --upgrade --force-reinstall "${SOURCE}@$target#subdirectory=services/sparkd"
package_matches
failed=0
trap - EXIT
printf '%s\t%s\t%s\n' SPARK_BOOTSTRAP package done
`.replaceAll('__DOLLAR__', '$');

export class ForgeInstallRunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const now = () => new Date().toISOString();

function safeText(value, limit = 1_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(password|passphrase|secret|token)=\S+/gi, '$1=***')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function safeResult(value) {
  if (value == null) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 8 * 1024) return { detail: 'résultat trop volumineux' };
    const clean = (item, depth = 0) => {
      if (depth > 6) return '…';
      if (typeof item === 'string') return safeText(item, 2_000);
      if (item == null || typeof item === 'number' || typeof item === 'boolean') return item;
      if (Array.isArray(item)) return item.slice(0, 64).map((entry) => clean(entry, depth + 1));
      if (typeof item === 'object') {
        return Object.fromEntries(Object.entries(item).slice(0, 64).map(([key, entry]) => [
          safeText(key, 128), /password|passphrase|secret|token|private[_-]?key/i.test(key)
            ? '***' : clean(entry, depth + 1),
        ]));
      }
      return safeText(item, 2_000);
    };
    return clean(JSON.parse(encoded));
  } catch {
    return { detail: 'résultat illisible' };
  }
}

/** Une ligne distante ne devient un événement que si son contrat est exact. */
export function parseInstallEvent(line) {
  let raw;
  try { raw = JSON.parse(String(line)); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !PHASES.has(raw.phase) || !STATUSES.has(raw.status) ||
      typeof raw.message !== 'string') return null;
  const date = Number.isFinite(Date.parse(raw.date)) ? raw.date : now();
  const event = {
    date, phase: raw.phase, status: raw.status,
    message: safeText(raw.message),
  };
  const result = safeResult(raw.result);
  if (result !== undefined) event.result = result;
  return event;
}

/**
 * Confirmation destructive attendue par l'exécuteur embarqué.
 *
 * §8.5 révisé : la création du miroir est la SEULE écriture destructive du
 * parcours. Réutiliser un pool ou adopter un zpool existant ne demande rien —
 * ces gestes déclarent, ils n'effacent pas.
 */
export function requiredStorageConfirmation(plan) {
  const storage = plan?.storage;
  if (storage?.kind === 'native') return `EFFACER ${storage.devices.join(' ')}`;
  return '';
}

/** Arguments OpenSSH stricts ; les seuls fragments variables viennent de l'inventaire validé. */
export function installSshArgs(server) {
  if (server?.kind === 'local') {
    throw new ForgeInstallRunError(
      'local_server', 'L’installation distante ne s’applique pas à une Forge locale.');
  }
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const destination = server?.kind === 'alias'
    ? [server.sshHost]
    : ['-p', String(server?.port ?? 22), `${server?.user}@${server?.host}`];
  // Un alias ne révèle pas son utilisateur ; il doit donc désigner une identité
  // administrative autorisée à `sudo -n`, conformément au §50.6.
  const command = server?.kind !== 'alias' && server?.user === 'root'
    ? [PYTHON, '-m', 'sparkd.forge_install']
    : ['sudo', '-n', PYTHON, '-m', 'sparkd.forge_install'];
  return [...common, ...destination, ...command];
}

/** L'amorceur et le JSON utilisent volontairement deux connexions distinctes. */
export function bootstrapSshArgs(server, target) {
  if (!COMMIT_PATTERN.test(target ?? '')) {
    throw new ForgeInstallRunError('invalid_commit', 'Empreinte Git invalide pour l’amorçage.');
  }
  if (server?.kind === 'local') {
    throw new ForgeInstallRunError(
      'local_server', 'L’installation distante ne s’applique pas à une Forge locale.');
  }
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const destination = server?.kind === 'alias'
    ? [server.sshHost]
    : ['-p', String(server?.port ?? 22), `${server?.user}@${server?.host}`];
  return [...common, ...destination, 'sh', '-s', '--', target];
}

export function parseBootstrapMarker(line) {
  const match = String(line).match(
    /^SPARK_BOOTSTRAP\tpackage\t(in_progress|done|unchanged|failed)$/);
  return match?.[1] ?? null;
}

function emptyFile() {
  return { version: STATE_VERSION, installations: {} };
}

function publicState(state) {
  return state ? structuredClone(state) : null;
}

/**
 * Un gestionnaire par processus console : il porte le verrou en mémoire et le
 * journal sur disque. Un `running` retrouvé après redémarrage devient
 * `interrupted`, puisque le processus qui possédait son SSH n'existe plus.
 */
export class ForgeInstallManager {
  constructor({ path, spawnFn = spawn, timeoutMs = INSTALL_TIMEOUT_MS,
                maxOutputBytes = MAX_OUTPUT_BYTES, resolveTarget } = {}) {
    if (!path) throw new Error('Le chemin du journal d’installation est requis.');
    this.path = path;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.resolveTarget = resolveTarget ?? (async () => null);
    this.active = new Map();
    this.writeQueue = Promise.resolve();
  }

  isRunning(server) { return this.active.has(server); }

  async _load() {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (!raw || raw.version !== STATE_VERSION || !raw.installations ||
          typeof raw.installations !== 'object' || Array.isArray(raw.installations)) {
        throw new Error('forme inconnue');
      }
      return raw;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyFile();
      throw new ForgeInstallRunError(
        'install_state_unreadable', `Journal d’installation illisible : ${error.message}`);
    }
  }

  async _write(file) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async read(server) {
    await this.writeQueue;
    const file = await this._load();
    const state = file.installations[server] ?? null;
    if (state?.status === 'running' && !this.active.has(server)) {
      return publicState(await this._replace(server, (current) => {
        const recovered = current ?? state;
        recovered.status = 'interrupted';
        recovered.endedAt = now();
        recovered.updatedAt = recovered.endedAt;
        recovered.error = 'Le processus console précédent ne porte plus cette installation.';
        recovered.events = [...(recovered.events ?? []), {
          date: recovered.endedAt,
          phase: recovered.currentPhase ?? 'access',
          status: 'interrupted',
          message: 'Connexion interrompue ; relancer le diagnostic avant toute reprise.',
        }].slice(-MAX_EVENTS);
        return recovered;
      }));
    }
    return publicState(state);
  }

  async _replace(server, transform) {
    let next;
    this.writeQueue = this.writeQueue.then(async () => {
      const file = await this._load();
      next = transform(file.installations[server] ?? null);
      file.installations[server] = next;
      await this._write(file);
    });
    await this.writeQueue;
    return next;
  }

  async start({ server, plan, values, confirmation }) {
    const name = server?.name;
    if (!name) throw new ForgeInstallRunError('unknown_server', 'La Forge n’est pas nommée.');
    if (this.active.has(name)) {
      throw new ForgeInstallRunError(
        'install_in_progress', `Une installation est déjà en cours sur « ${name} ».`);
    }
    const required = requiredStorageConfirmation(plan);
    if (String(confirmation ?? '') !== required) {
      throw new ForgeInstallRunError(
        'storage_confirmation_required', required
          ? `Recopiez exactement « ${required} » avant l’écriture du stockage.`
          : 'La confirmation de stockage ne correspond pas au plan.');
    }

    const startedAt = now();
    const state = {
      server: name, status: 'running', startedAt, updatedAt: startedAt,
      endedAt: null, currentPhase: 'access', plan: structuredClone(plan),
      values: structuredClone(values ?? {}), events: [], error: null,
    };
    // Le verrou est posé AVANT la première attente : deux requêtes arrivées dans
    // le même tour de boucle ne peuvent pas franchir ensemble l'écriture disque.
    this.active.set(name, { child: null });
    try {
      const target = await this.resolveTarget();
      if (!COMMIT_PATTERN.test(target ?? '')) {
        throw new ForgeInstallRunError(
          'bootstrap_unpublished',
          'La build chargée par cette console n’est pas publiée sur origin/main. Redémarrez-la depuis main publié.');
      }
      await this._replace(name, () => state);
      this._launch(server, state, { plan, confirmation }, target).catch(() => {
        // `_launch` transforme chaque issue en état durable. Cette garde évite
        // seulement une promesse rejetée orpheline si le disque local tombe.
      });
      return publicState(state);
    } catch (error) {
      this.active.delete(name);
      throw error;
    }
  }

  async _launch(server, state, envelope, target) {
    const name = server.name;
    let writes = Promise.resolve();
    const appendEvent = (event) => {
      writes = writes.then(async () => {
        state.currentPhase = event.phase;
        state.updatedAt = now();
        state.events = [...state.events, event].slice(-MAX_EVENTS);
        await this._replace(name, () => state);
      });
      return writes;
    };

    await appendEvent({
      date: now(), phase: 'access', status: 'running',
      message: 'Vérification du paquet d’installation publié',
    });
    let bootstrapStatus = null;
    const bootstrap = await this._runProcess(
      name, bootstrapSshArgs(server, target), BOOTSTRAP_SCRIPT,
      (line) => { bootstrapStatus = parseBootstrapMarker(line) ?? bootstrapStatus; });
    if (bootstrap.code !== 0 || bootstrap.signal || bootstrap.overflow ||
        !['done', 'unchanged'].includes(bootstrapStatus)) {
      const interrupted = bootstrap.code === 255 || bootstrap.code == null ||
        bootstrap.signal || bootstrap.overflow;
      if (!interrupted) {
        await appendEvent({
          date: now(), phase: 'access', status: 'failed',
          message: 'Le paquet d’installation n’a pas pu être amorcé',
        });
      }
      await writes;
      await this._finishProcessFailure(name, state, bootstrap, 'amorceur');
      return;
    }
    await appendEvent({
      date: now(), phase: 'access', status: 'done',
      message: bootstrapStatus === 'unchanged'
        ? 'Paquet d’installation déjà conforme à la build publiée'
        : 'Paquet d’installation amorcé depuis la build publiée',
      result: { changed: bootstrapStatus === 'done', commit: target.slice(0, 12) },
    });

    const execution = await this._runProcess(
      name, installSshArgs(server), JSON.stringify(envelope),
      (line) => {
        const event = parseInstallEvent(line);
        if (event) appendEvent(event);
      });
    await writes;
    const final = [...state.events].reverse().find((event) => event.phase === 'verification');
    if (execution.code === 0 && final?.status === 'done' && !execution.overflow) {
      await this._finish(name, state, 'done', null);
      return;
    }
    await this._finishProcessFailure(name, state, execution, 'installateur');
  }

  _runProcess(name, args, input, consumeLine) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnFn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.active.set(name, { child });
      } catch (error) {
        resolve({ code: null, signal: null, overflow: false,
                  stderr: `OpenSSH n’a pas pu démarrer : ${safeText(error.message)}` });
        return;
      }
      let buffer = '';
      let stderr = '';
      let bytes = 0;
      let overflow = false;
      let closed = false;
      const count = (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.maxOutputBytes) {
          overflow = true;
          child.kill?.('SIGTERM');
        }
      };
      child.stdout?.on('data', (chunk) => {
        count(chunk);
        if (overflow) return;
        buffer += String(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      });
      child.stderr?.on('data', (chunk) => {
        count(chunk);
        stderr = safeText(`${stderr} ${String(chunk)}`, 4_000);
      });
      child.on('error', (error) => {
        stderr = safeText(`${stderr} ${error.message}`, 4_000);
      });
      child.stdin?.on('error', (error) => {
        stderr = safeText(`${stderr} ${error.message}`, 4_000);
      });
      const timer = setTimeout(() => {
        overflow = true;
        stderr = 'L’installation distante a dépassé quarante-cinq minutes.';
        child.kill?.('SIGTERM');
      }, this.timeoutMs);
      timer.unref?.();
      child.on('close', (code, signal) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (buffer && !overflow) consumeLine(buffer);
        resolve({ code, signal, overflow, stderr });
      });
      child.stdin?.end(input);
    });
  }

  async _finishProcessFailure(name, state, process, label) {
    const remoteFailure = state.events.some((event) => event.status === 'failed');
    const interrupted = !remoteFailure &&
      (process.code === 255 || process.code == null || process.signal || process.overflow);
    const detail = process.overflow
      ? process.stderr || 'La sortie distante a dépassé la limite de sécurité.'
      : process.stderr || (interrupted
        ? 'La connexion SSH s’est interrompue.'
        : `L’${label} distant s’est arrêté avec le code ${process.code}.`);
    await this._finish(name, state, interrupted ? 'interrupted' : 'failed', detail);
  }

  async _finish(name, state, status, error) {
    const date = now();
    state.status = status;
    state.updatedAt = date;
    state.endedAt = date;
    state.error = error ? safeText(error, 4_000) : null;
    if (status === 'interrupted' &&
        state.events.at(-1)?.status !== 'interrupted') {
      state.events = [...state.events, {
        date, phase: state.currentPhase ?? 'access', status: 'interrupted',
        message: 'Connexion interrompue ; relancer le diagnostic avant toute reprise.',
      }].slice(-MAX_EVENTS);
    }
    try {
      await this._replace(name, () => state);
    } finally {
      this.active.delete(name);
    }
  }

  closeAll() {
    for (const { child } of this.active.values()) child?.kill?.('SIGTERM');
  }
}
