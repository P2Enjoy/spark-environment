/**
 * Redémarrer la Forge : le relevé, le refus, puis le geste (SPK-87).
 *
 * @spec docs/BACKLOG.md#SPK-87 · docs/DAT.md §51.1 (ce que le geste REFUSE),
 *       §51.2 (le relevé), §51.4 (par où il passe) · docs/DAT.md §50 (le même
 *       exécuteur SSH que la mise à jour) · docs/DESIGN_SYSTEM_APP.md SPK-DS-19
 *
 * Le point de ce module n'est pas de redémarrer — une ligne suffirait — mais de
 * REFUSER quand il ne faut pas. Un redémarrage vers un noyau dépourvu de module
 * ZFS laisse le pool indisponible, donc tous les Sparks du locataire à terre, et
 * cela ne se voit qu'après : la console a déjà perdu le contact.
 *
 * Cette vérification a été faite à la main le 2026-09-02 avant de recommander un
 * redémarrage. Un produit qui offre le bouton la fait par construction.
 */

import { spawn } from 'node:child_process';

export const RELEVE_TIMEOUT_MS = 30 * 1000;
export const REBOOT_TIMEOUT_MS = 20 * 1000;

export class ForgeRebootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeRebootError';
    this.code = code;
  }
}

/**
 * Le relevé du §51.2. Il n'écrit RIEN.
 *
 * Une seule commande : trois lectures dans une cellule qu'on n'ouvre qu'une
 * fois. Le noyau qui démarrera est celui que GRUB servira, c'est-à-dire le plus
 * récent installé — et non `uname -r`, qui dit celui qui tourne AUJOURD'HUI.
 * Confondre les deux ferait vérifier le module ZFS du mauvais noyau, donc
 * rassurer sur exactement le cas qu'on veut attraper.
 */
export const RELEVE_SCRIPT = String.raw`set -eu
courant=$(uname -r)
# Le plus récent installé, au sens de la version : c'est celui que GRUB sert.
cible=$(ls -1 /lib/modules 2>/dev/null | sort -V | tail -1)
[ -n "$cible" ] || cible="$courant"
if modinfo -k "$cible" zfs >/dev/null 2>&1; then zfs=present; else zfs=absent; fi
[ -f /var/run/reboot-required ] || [ -f /run/reboot-required ] && requis=oui || requis=non
printf 'courant=%s\ncible=%s\nzfs=%s\nrequis=%s\n' "$courant" "$cible" "$zfs" "$requis"
`;

/** Le geste. Détaché, parce que la connexion meurt avec la machine. */
export const REBOOT_SCRIPT = String.raw`set -eu
# --no-block : systemctl reboot ne rend pas la main, et attendre ferait
# conclure a l'echec d'un redemarrage qui a parfaitement eu lieu.
systemctl reboot --no-block
printf 'engage\n'
`;

export function rebootSshArgs(server) {
  if (server?.kind === 'local') {
    throw new ForgeRebootError(
      'local_server',
      'Cette Forge est locale : la console ne redémarre pas la machine qui la fait tourner.');
  }
  const commun = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const destination = server?.kind === 'alias'
    ? [server.sshHost]
    : ['-p', String(server?.port ?? 22), `${server?.user}@${server?.host}`];
  return [...commun, ...destination, 'sudo', 'sh', '-s'];
}

/** Joue un script sur la Forge et rend sa sortie. Aucun secret n'y transite. */
export function executerSurLaForge(server, script, {
  spawnFn = spawn, timeoutMs = RELEVE_TIMEOUT_MS,
  // §15 : instrumentation de test, absente de l'exploitation. Même couture que
  // `SPARK_TERMINAL_COMMAND` et `SPARK_SIGN_COMMAND` — la pile de preuves n'a
  // pas de Forge à redémarrer, et le REFUS est ce qu'il faut pourtant éprouver
  // de bout en bout.
  doublon = process.env.SPARK_REBOOT_COMMAND || null,
} = {}) {
  let args;
  try {
    args = doublon ? [] : rebootSshArgs(server);
  } catch (erreur) {
    return Promise.reject(erreur);
  }
  return new Promise((resolve, reject) => {
    let enfant;
    try {
      enfant = doublon
        ? spawnFn('sh', ['-c', doublon], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawnFn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (erreur) {
      reject(new ForgeRebootError('ssh_start_failed',
        `OpenSSH n’a pas pu démarrer : ${erreur.message}`));
      return;
    }
    let sortie = '';
    let erreurs = '';
    let fini = false;
    const minuteur = setTimeout(() => {
      if (fini) return;
      fini = true;
      enfant.kill('SIGKILL');
      reject(new ForgeRebootError('timeout', 'La Forge n’a pas répondu à temps.'));
    }, timeoutMs);
    enfant.stdout?.on('data', (m) => { sortie += String(m); });
    enfant.stderr?.on('data', (m) => { erreurs += String(m); });
    enfant.on('error', (erreur) => {
      if (fini) return;
      fini = true; clearTimeout(minuteur);
      reject(new ForgeRebootError('ssh_start_failed', String(erreur?.message ?? erreur)));
    });
    enfant.on('close', (code) => {
      if (fini) return;
      fini = true; clearTimeout(minuteur);
      if (code === 0) resolve(sortie);
      else reject(new ForgeRebootError('remote_failed',
        (erreurs || sortie).trim().slice(-500) || `ssh a rendu ${code}`));
    });
    enfant.stdin?.end(script);
  });
}

/** Traduit le relevé brut en ce que l'écran doit dire (§51.2). */
export function lireReleve(brut) {
  const lignes = {};
  for (const ligne of String(brut ?? '').split('\n')) {
    const [cle, ...reste] = ligne.split('=');
    if (reste.length) lignes[cle.trim()] = reste.join('=').trim();
  }
  const noyauCible = lignes.cible || null;
  // §51.1 : c'est la SEULE condition de refus, et elle ne se clique pas.
  const zfsAbsent = lignes.zfs === 'absent';
  return {
    noyauCourant: lignes.courant || null,
    noyauCible,
    zfs: lignes.zfs ?? null,
    redemarrageRequis: lignes.requis === 'oui',
    // « pas mesuré » n'est pas « mesuré sain » : sans relevé lisible du module,
    // on refuse aussi. Redémarrer sur un doute coûterait le pool.
    autorise: lignes.zfs === 'present',
    refus: zfsAbsent || !lignes.zfs
      ? {
          code: 'zfs_absent',
          message: noyauCible
            ? `Le noyau qui démarrera — ${noyauCible} — n’a pas de module ZFS `
              + 'lisible. Le pool de stockage serait indisponible au démarrage, '
              + 'et tous les Sparks avec lui. Le redémarrage n’est pas proposé.'
            : 'Le noyau qui démarrera n’a pas pu être relevé : on ne redémarre '
              + 'pas sur un doute qui coûterait le pool de stockage.',
        }
      : null,
  };
}
