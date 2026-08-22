/**
 * Orchestrateur local de l'installation distante d'une Forge.
 *
 * @spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4-§50.6 ·
 *       docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 *
 * Le navigateur ne fournit jamais une commande. Ce module ne lance que
 * l'exécuteur versionné déjà publié dans `/opt/sparkd`, avec le plan fermé
 * produit par `forge-install.js`. Son journal est durable et distinct de
 * l'inventaire : aucune clé ni sortie de terminal brute n'y entre.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_EVENTS = 256;
export const STATE_VERSION = 1;

const PHASES = new Set([
  'access', 'dependencies', 'storage', 'foundation', 'control', 'verification',
]);
const STATUSES = new Set(['pending', 'running', 'done', 'warning', 'failed', 'interrupted']);
const PYTHON = '/opt/sparkd/venv/bin/python';

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

/** Confirmation destructive attendue par l'exécuteur embarqué. */
export function requiredStorageConfirmation(plan) {
  const storage = plan?.storage;
  if (storage?.kind === 'file') {
    return `CREER ${storage.path} ${Number(storage.sizeGib)}GiB`;
  }
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
                maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
    if (!path) throw new Error('Le chemin du journal d’installation est requis.');
    this.path = path;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
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
      await this._replace(name, () => state);
      this._launch(server, state, { plan, confirmation }).catch(() => {
        // `_launch` transforme chaque issue en état durable. Cette garde évite
        // seulement une promesse rejetée orpheline si le disque local tombe.
      });
      return publicState(state);
    } catch (error) {
      this.active.delete(name);
      throw error;
    }
  }

  async _launch(server, state, envelope) {
    const name = server.name;
    let child;
    try {
      child = this.spawnFn('ssh', installSshArgs(server), { stdio: ['pipe', 'pipe', 'pipe'] });
      this.active.set(name, { child });
    } catch (error) {
      await this._finish(name, state, 'interrupted',
        `OpenSSH n’a pas pu démarrer : ${safeText(error.message)}`);
      return;
    }

    let buffer = '';
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    let closed = false;
    let writes = Promise.resolve();
    const appendEvent = (event) => {
      writes = writes.then(async () => {
        state.currentPhase = event.phase;
        state.updatedAt = now();
        state.events = [...state.events, event].slice(-MAX_EVENTS);
        await this._replace(name, () => state);
      });
    };
    const consume = (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > this.maxOutputBytes) {
        overflow = true;
        child.kill?.('SIGTERM');
        return;
      }
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseInstallEvent(line);
        if (event) appendEvent(event);
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > this.maxOutputBytes) {
        overflow = true;
        child.kill?.('SIGTERM');
      }
      stderr = safeText(`${stderr} ${String(chunk)}`, 4_000);
    });
    child.on('error', (error) => {
      stderr = safeText(`${stderr} ${error.message}`, 4_000);
    });

    const timer = setTimeout(() => {
      overflow = true;
      stderr = 'L’installation distante a dépassé quarante-cinq minutes.';
      child.kill?.('SIGTERM');
    }, this.timeoutMs);
    timer.unref?.();

    child.on('close', async (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (buffer) {
        const event = parseInstallEvent(buffer);
        if (event) appendEvent(event);
      }
      await writes;
      const final = [...state.events].reverse().find((event) => event.phase === 'verification');
      if (code === 0 && final?.status === 'done' && !overflow) {
        await this._finish(name, state, 'done', null);
      } else {
        const remoteFailure = state.events.some((event) => event.status === 'failed');
        const interrupted = !remoteFailure && (code === 255 || signal || overflow);
        const detail = overflow
          ? stderr || 'La sortie distante a dépassé la limite de sécurité.'
          : stderr || (interrupted
            ? 'La connexion SSH s’est interrompue.'
            : `L’installateur distant s’est arrêté avec le code ${code}.`);
        await this._finish(name, state, interrupted ? 'interrupted' : 'failed', detail);
      }
    });
    child.stdin?.on('error', (error) => {
      stderr = safeText(`${stderr} ${error.message}`, 4_000);
    });
    child.stdin?.end(JSON.stringify(envelope));
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
