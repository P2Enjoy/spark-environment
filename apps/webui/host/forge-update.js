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
  const before = comparison?.forgeCommit;
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
# SPK-91 · §40.7.2 : le fichier à restaurer. VIDE sur une mise à jour — on
# sauvegarde alors —, renseigné sur un retour arrière. C'est le seul argument
# qui distingue les deux sens de la même recette.
restaurer="__DOLLAR__{3-}"
sauvegardes=/var/lib/sparkd/sauvegardes

valid_commit() {
  printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$'
}

valid_backup() {
  printf '%s\n' "$1" | grep -Eq '^/var/lib/sparkd/sauvegardes/spark-[0-9]{8}-[0-9]{6}\.db$'
}

if ! valid_commit "$target" || ! valid_commit "$previous"; then
  printf '%s\t%s\t%s\n' SPARK_UPDATE guard failed
  exit 64
fi

if [ -n "$restaurer" ] && ! valid_backup "$restaurer"; then
  printf '%s\t%s\t%s\n' SPARK_UPDATE guard failed
  printf '%s\n' 'Le chemin de sauvegarde ne ressemble pas à ce que sparkd produit.' >&2
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

# SPK-91 · §40.7 : on ne mute pas ce qu'on ne sait pas rendre.
#
# En MISE À JOUR, la sauvegarde du registre précède toute mutation, et son échec
# arrête tout : rien n'est installé, la Forge continue de servir ce qu'elle
# servait. En RETOUR ARRIÈRE, on restaure au contraire le fichier reçu, sparkd
# arrêté — le §36 refuse de restaurer sous un service actif, et il a raison.
if [ -n "$restaurer" ]; then
  printf '%s\t%s\t%s\n' SPARK_UPDATE restore in_progress
  as_root systemctl stop sparkd
  as_root "$python" -m sparkd.sauvegarde --restaurer "$restaurer"
  printf '%s\t%s\t%s\n' SPARK_UPDATE restore done
else
  printf '%s\t%s\t%s\n' SPARK_UPDATE backup in_progress
  fichier=$(as_root "$python" -m sparkd.sauvegarde "$sauvegardes" --chemin)
  if ! valid_backup "$fichier"; then
    printf '%s\t%s\t%s\n' SPARK_UPDATE backup failed
    printf '%s\n' 'La sauvegarde du registre n a pas abouti : rien n a ete installe.' >&2
    exit 70
  fi
  printf '%s\t%s\n' SPARK_BACKUP "$fichier"
  printf '%s\t%s\t%s\n' SPARK_UPDATE backup done
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
export function updateSshArgs(server, target, previous, restore = null) {
  if (!COMMIT_PATTERN.test(target ?? '') || !COMMIT_PATTERN.test(previous ?? '')) {
    throw new ForgeUpdateError('invalid_commit', 'Empreinte Git invalide pour la mise à jour.');
  }
  // SPK-91 · §40.7.2 : ce chemin part dans une commande root. On le REFUSE s'il
  // ne ressemble pas à ce que le §36 produit, plutôt que de l'échapper.
  if (restore != null && !BACKUP_PATTERN.test(restore)) {
    throw new ForgeUpdateError('invalid_backup',
      'Le chemin de sauvegarde n’est pas celui d’une sauvegarde du registre.');
  }
  if (server?.kind === 'local') {
    throw new ForgeUpdateError(
      'local_server', 'La mise à jour distante ne s’applique pas à une Forge locale.');
  }
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const destination = server?.kind === 'alias'
    ? [server.sshHost]
    : ['-p', String(server?.port ?? 22), `${server?.user}@${server?.host}`];
  return [...common, ...destination, 'sh', '-s', '--', target, previous,
          ...(restore ? [restore] : [])];
}

function filteredDiagnostic(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(password|passphrase|secret|token)=\S+/gi, '$1=***')
    .slice(-4_000)
    .trim();
}

/**
 * Le fichier de sauvegarde que la recette vient de produire (SPK-91, §40.7).
 *
 * Le motif est le MÊME que celui du script, et c'est délibéré : ce chemin
 * repartira dans une commande exécutée en root sur la Forge. On ne reconnaît
 * qu'une sauvegarde du §36, et rien d'autre.
 */
export const BACKUP_PATTERN =
  /^\/var\/lib\/sparkd\/sauvegardes\/spark-\d{8}-\d{6}\.db$/;

/**
 * La date d'une sauvegarde, lue dans son nom (SPK-91, §40.7).
 *
 * Le §36 nomme ses fichiers `spark-AAAAMMJJ-HHMMSS.db`, en UTC. On la LIT au
 * lieu de la demander : un horodatage transporté à côté du fichier pourrait
 * désigner autre chose que lui.
 */
export function backupDate(chemin) {
  const match = String(chemin ?? '').match(/spark-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
  if (!match) return null;
  const [, a, mo, j, h, mi, s] = match;
  const date = new Date(Date.UTC(+a, +mo - 1, +j, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseBackup(output) {
  for (const line of String(output ?? '').split('\n')) {
    const match = line.match(/^SPARK_BACKUP\t(\S+)$/);
    if (match && BACKUP_PATTERN.test(match[1])) return match[1];
  }
  return null;
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
  restore = null,
  spawnFn = spawn, timeoutMs = UPDATE_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  let args;
  try {
    args = updateSshArgs(server, target, previous, restore);
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
      const backup = parseBackup(stdout);
      if (overflow) {
        reject(new ForgeUpdateError(
          'output_too_large', 'La sortie distante a dépassé la limite de sécurité.',
          { mutated, stages, backup }));
      } else if (code !== 0) {
        const diagnostic = filteredDiagnostic(stderr || stdout);
        reject(new ForgeUpdateError(
          'remote_install_failed',
          diagnostic || `La commande distante s’est terminée avec le code ${code ?? signal}.`,
          { mutated, stages, exitCode: code, signal, backup }));
      } else {
        resolve({ mutated, stages, backup: parseBackup(stdout) });
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
  timeoutMs = VERIFY_TIMEOUT_MS, resolveCommit = async (commit) => commit,
} = {}) {
  if (!Number.isInteger(localPort) || localPort <= 0 ||
      !COMMIT_PATTERN.test(expectedCommit ?? '')) {
    throw new ForgeUpdateError('invalid_verification', 'Cible de vérification invalide.');
  }
  const base = `http://127.0.0.1:${localPort}`;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const resolved = new Map();
  const resolve = async (commit) => {
    if (!resolved.has(commit)) resolved.set(commit, await resolveCommit(commit));
    return resolved.get(commit);
  };
  do {
    const [health, ready, forge] = await Promise.all([
      readJson(fetchFn, `${base}/healthz`),
      readJson(fetchFn, `${base}/readyz`),
      readJson(fetchFn, `${base}/v1/forge`),
    ]);
    const healthCommit = health.body?.build?.commit ?? null;
    const forgeCommit = forge.body?.build?.commit ?? null;
    const [healthResolved, forgeResolved] = await Promise.all([
      resolve(healthCommit), resolve(forgeCommit),
    ]);
    last = {
      healthz: { status: health.status, state: health.body?.status ?? null,
                 commit: healthCommit, resolvedCommit: healthResolved },
      readyz: { status: ready.status, state: ready.body?.status ?? null,
                // SPK-85 · §40.6 : la plus haute migration appliquée. C'est le
                // seul fait qui distingue un retour arrière qui rétablit d'un
                // retour arrière qui laisse la Forge arrêtée.
                schemaVersion: ready.body?.schema_version ?? null,
                detail: ready.body?.detail ?? ready.error ?? null },
      build: { status: forge.status, commit: forgeCommit, resolvedCommit: forgeResolved,
               version: forge.body?.build?.version ?? null },
    };
    if (health.ok && health.body?.status === 'ok' &&
        healthResolved === expectedCommit &&
        ready.ok && ready.body?.status === 'ready' &&
        forge.ok && forgeResolved === expectedCommit) {
      return { ok: true, expectedCommit, ...last };
    }
    if (Date.now() < deadline) await sleep(1_000);
  } while (Date.now() < deadline);
  return { ok: false, expectedCommit, ...last };
}

/**
 * La version de schéma que la Forge sert MAINTENANT (SPK-85, docs/DAT.md §40.6).
 *
 * `/readyz` la publie déjà (§31.4). On la relève AVANT la mutation : après, le
 * démarrage de la nouvelle build a déjà migré, et la comparaison serait perdue.
 *
 * Rend `null` quand elle n'a pas pu être lue — et `null` n'est pas zéro : le
 * §14.6 du design system interdit de conclure d'une mesure absente.
 */
export async function probeSchemaVersion(localPort, { fetchFn = fetch } = {}) {
  if (!Number.isInteger(localPort) || localPort <= 0) return null;
  const ready = await readJson(fetchFn, `http://127.0.0.1:${localPort}/readyz`);
  const version = ready.body?.schema_version;
  return Number.isInteger(version) ? version : null;
}

/** Une opération par Forge et un seul reçu de retour arrière, en mémoire. */
export class ForgeUpdateManager {
  constructor({ install = runRemoteInstall, verify = verifyForge,
                probeSchema = probeSchemaVersion } = {}) {
    this.install = install;
    this.verify = verify;
    this.probeSchema = probeSchema;
    this.busy = new Set();
    this.receipts = new Map();
  }

  /**
   * Ce que le retour arrière rétablirait, et ce qu'il ne rétablirait pas.
   *
   * @spec docs/BACKLOG.md#SPK-85 · docs/DAT.md §40.6
   *
   * `migrated` porte TROIS valeurs, et pas deux : `true` quand la version du
   * schéma a monté pendant la mise à jour — la build précédente refusera alors
   * de servir ce registre —, `false` quand elle n'a pas bougé, et `null` quand
   * l'une des deux mesures manque. Un booléen aurait rangé « je ne sais pas »
   * avec « tout va bien », ce qui est exactement le mensonge à éviter ici.
   */
  rollbackOffer(serverName, currentCommit) {
    const receipt = this.receipts.get(serverName);
    if (!receipt || receipt.target !== currentCommit) return { available: false };
    const { schemaBefore = null, schemaAfter = null } = receipt;
    const migrated = Number.isInteger(schemaBefore) && Number.isInteger(schemaAfter)
      ? schemaAfter > schemaBefore
      : null;
    return { available: true, previous: receipt.before, current: receipt.target,
             migrated, schemaBefore, schemaAfter,
             backup: receipt.backup ?? null, backupAt: receipt.backupAt ?? null };
  }

  async #rollback(server, localPort, before, target, restore = null) {
    try {
      // SPK-91 · §40.7.2 : restaurer PUIS réinstaller. C'est la recette qui tient
      // l'ordre ; le manager ne fait que lui passer le fichier du reçu.
      const execution = await this.install(server, before, target, { restore });
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
      // Relevé AVANT toute mutation : après, la nouvelle build a déjà migré au
      // démarrage, et la comparaison n'existe plus (§40.6).
      const schemaBefore = await this.probeSchema(localPort).catch(() => null);
      let execution;
      try {
        execution = await this.install(server, target, before);
      } catch (error) {
        // §40.7.2 : le retour arrière automatique restaure LUI AUSSI. Sans
        // cela, un échec survenu après que `sparkd.install` a migré laisserait
        // la Forge arrêtée — le mode de panne que cette unité corrige.
        const rollback = error.mutated
          ? await this.#rollback(server, localPort, before, target, error.backup ?? null)
          : null;
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
                 rollback: await this.#rollback(server, localPort, before, target,
                                                execution.backup ?? null) };
      }
      const journaled = await audit('forge.sparkd_update', before, target);
      // SPK-85 · §40.6 : les deux bornes du schéma. `schemaAfter` vient de la
      // vérification qui vient d'aboutir — donc de la build servie, pas d'une
      // seconde lecture qui pourrait tomber ailleurs.
      const receipt = { server: name, before, target, schemaBefore,
                        schemaAfter: verification.readyz?.schemaVersion ?? null,
                        // SPK-91 · §40.7 : ce que le retour arrière restaurera,
                        // et la date qu'il annoncera.
                        backup: execution.backup ?? null,
                        backupAt: backupDate(execution.backup) };
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
      // SPK-91 · §40.7.2 : le geste volontaire restaure le registre du reçu.
      // `null` quand la mise à jour n'en a pas produit — une console antérieure
      // à cette unité —, et la recette se contente alors de réinstaller.
      const result = await this.#rollback(
        server, localPort, receipt.before, receipt.target, receipt.backup ?? null);
      if (result.state === 'success') this.receipts.delete(name);
      return { ...result, before: receipt.target, journaled };
    } finally {
      this.busy.delete(name);
    }
  }
}
