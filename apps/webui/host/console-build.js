/**
 * Empreinte de la console elle-même, relevée à son démarrage.
 *
 * @spec docs/BACKLOG.md#SPK-65 · docs/DAT.md §40.5
 *
 * La Forge peut être parfaitement à jour tandis que le processus Node qui la
 * présente sert encore les modules qu'il a chargés avant le dernier commit.
 * Cette comparaison vit donc dans l'hôte console, avec le dépôt qu'il sert.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const A_JOUR = 'a_jour';
export const PERIMEE = 'perimee';
export const DEPOT_RECULE = 'depot_recule';
export const INDISPONIBLE = 'indisponible';

function git(args, root, execute = execFileSync) {
  try {
    return String(execute('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    })).trim();
  } catch {
    return null;
  }
}

/** La date des fichiers servis quand il n'y a délibérément pas de dépôt. */
export function latestMtime(root, stat = statSync, read = readdirSync) {
  let latest = null;
  const visit = (path) => {
    let info;
    try { info = stat(path); } catch { return; }
    if (info.isDirectory()) {
      const name = basename(path);
      if (['.git', 'node_modules', '.venv', 'dist', 'coverage'].includes(name)) return;
      let entries;
      try { entries = read(path); } catch { return; }
      for (const entry of entries) visit(join(path, entry));
      return;
    }
    if (info.isFile()) latest = Math.max(latest ?? 0, info.mtimeMs);
  };
  visit(root);
  return latest;
}

/** Capture UNE fois, avant que le serveur commence à répondre. */
export function capture(root, dependencies = {}) {
  const head = git(['rev-parse', 'HEAD'], root, dependencies.execute);
  if (head) return { kind: 'git', head };
  const mtime = (dependencies.latestMtime ?? latestMtime)(root);
  return mtime == null ? { kind: 'unavailable' } : { kind: 'files', mtime };
}

/** Compare l'empreinte capturée au même arbre, sans rien modifier. */
export function compare(start, root, dependencies = {}) {
  if (!start || start.kind === 'unavailable') return { verdict: INDISPONIBLE };
  if (start.kind === 'files') {
    const mtime = (dependencies.latestMtime ?? latestMtime)(root);
    if (mtime == null) return { verdict: INDISPONIBLE };
    // Une date reculée est une information, pas une raison de redémarrer vers
    // une copie plus ancienne. Elle suit le même principe que §40.3.
    if (mtime > start.mtime) return { verdict: PERIMEE, changed_at: mtime };
    if (mtime < start.mtime) return { verdict: DEPOT_RECULE, changed_at: mtime };
    return { verdict: A_JOUR };
  }

  const head = git(['rev-parse', 'HEAD'], root, dependencies.execute);
  if (!head) return { verdict: INDISPONIBLE };
  if (head === start.head) return { verdict: A_JOUR, start: start.head, head };
  const ancestor = git(['merge-base', '--is-ancestor', start.head, head], root,
                       dependencies.execute);
  if (ancestor !== null) {
    const count = git(['rev-list', '--count', `${start.head}..${head}`], root,
                      dependencies.execute);
    return { verdict: PERIMEE, start: start.head, head, behind: Number(count ?? 0) };
  }
  const currentAncestor = git(['merge-base', '--is-ancestor', head, start.head], root,
                              dependencies.execute);
  if (currentAncestor !== null) return { verdict: DEPOT_RECULE, start: start.head, head };
  return { verdict: INDISPONIBLE, start: start.head, head };
}

/** Le libellé est le contrat : le navigateur ne le reconstruit pas. */
export function describe(result) {
  if (result.verdict === PERIMEE) {
    const n = Number(result.behind ?? 0);
    return {
      ...result,
      title: 'Console à redémarrer',
      detail: `Console démarrée avant ${n} commit${n > 1 ? 's' : ''} · redémarrer pour en bénéficier.`,
    };
  }
  if (result.verdict === DEPOT_RECULE) {
    return { ...result, title: 'Dépôt modifié depuis le démarrage',
             detail: 'Le dépôt est plus ancien que la console démarrée. Aucun redémarrage n’est proposé.' };
  }
  if (result.verdict === A_JOUR) {
    return { ...result, title: 'Console à jour', detail: 'La console sert le code actuellement relevé.' };
  }
  return { ...result, title: 'Comparaison de console indisponible',
           detail: 'La console ne peut pas comparer son code de démarrage à l’arbre actuel.' };
}
