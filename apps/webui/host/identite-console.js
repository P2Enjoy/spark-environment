/**
 * Quelle clé publique du POSTE ouvre cette Forge (SPK-82, docs/DAT.md §42.10.2).
 *
 * @spec docs/BACKLOG.md#SPK-82 · docs/DAT.md §42.10.2 (quelle clé, et comment la
 *       console la connaît), §42.10.3 (quand il n'y en a pas, on le dit) ·
 *       docs/DAT.md §21.6.3 (l'empreinte que le tunnel capte déjà)
 *
 * Le point qui décide de ce module : on ne pousse **pas** n'importe quelle clé
 * du poste, ni la première trouvée. On pousse celle dont l'empreinte CORRESPOND
 * à ce qu'OpenSSH a déclaré accepter pour cette Forge — c'est une
 * correspondance, pas une supposition. Accorder un accès à une clé qu'on n'a pas
 * identifiée serait un octroi au hasard.
 *
 * Quand rien ne correspond, on rend `null`. Le §14.6 vaut ici comme ailleurs :
 * ne pas savoir n'est pas savoir que tout va bien, et une clé « plausible »
 * serait le pire des deux mondes.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Exécute et rend la sortie, ou `''`. Un outil absent n'est pas une panne. */
function lancer(commande, args, entree = null) {
  return new Promise((resolve) => {
    const enfant = execFile(commande, args, { timeout: 5000 },
      (erreur, sortie) => resolve(erreur ? '' : String(sortie)));
    if (entree !== null) { enfant.stdin.end(entree); }
  });
}

/**
 * L'empreinte SHA256 d'une clé publique, telle qu'OpenSSH l'écrit.
 *
 * Calculée par `ssh-keygen -lf -`, et non réimplémentée : c'est la même
 * commande que le manuel M6 donne au lecteur pour comparer, et deux façons de
 * calculer une empreinte finissent par diverger.
 */
export async function empreinteDe(clePublique) {
  const sortie = await lancer('ssh-keygen', ['-lf', '-'], `${clePublique}\n`);
  const trouve = /(SHA256:[A-Za-z0-9+/=]+)/.exec(sortie);
  return trouve ? trouve[1] : null;
}

/**
 * Les clés publiques dont le poste dispose : l'agent d'abord, les fichiers
 * ensuite.
 *
 * L'agent est prioritaire parce que c'est lui qu'OpenSSH interroge en premier,
 * et parce qu'une clé protégée par phrase n'existe QUE là sous forme utilisable.
 */
export async function clesDuPoste({ lire = lancer, dossier = join(homedir(), '.ssh') } = {}) {
  const vues = new Map();
  const agent = await lire('ssh-add', ['-L']);
  for (const ligne of agent.split('\n')) {
    const propre = ligne.trim();
    if (/^(ssh|ecdsa)-\S+\s+\S+/.test(propre)) vues.set(propre.split(/\s+/)[1], propre);
  }
  let fichiers = [];
  try {
    fichiers = (await readdir(dossier)).filter((f) => f.endsWith('.pub'));
  } catch { fichiers = []; }
  for (const fichier of fichiers) {
    try {
      const propre = (await readFile(join(dossier, fichier), 'utf8')).trim();
      if (/^(ssh|ecdsa)-\S+\s+\S+/.test(propre)) {
        const corps = propre.split(/\s+/)[1];
        if (!vues.has(corps)) vues.set(corps, propre);
      }
    } catch { /* une clé illisible n'est pas une panne : on passe */ }
  }
  return [...vues.values()];
}

/**
 * La clé du poste dont l'empreinte est `empreinte`, ou `null`.
 *
 * `null` couvre trois cas RÉELS et distincts du §42.10.3 : le tunnel n'a pas
 * d'empreinte (serveur local, agent muet), aucune clé n'est lisible, ou aucune
 * ne correspond. L'appelant les dit ; il ne les comble pas.
 */
export async function cleCorrespondante(empreinte, options = {}) {
  if (!empreinte) return null;
  for (const cle of await clesDuPoste(options)) {
    if (await empreinteDe(cle) === empreinte) return cle;
  }
  return null;
}

/**
 * Un libellé de registre stable pour la clé de CE poste.
 *
 * Stable est le mot : un libellé qui changerait d'un amorçage à l'autre
 * inscrirait une seconde entrée pour la même clé, et le panneau Clés en
 * montrerait deux là où il n'y a qu'un accès.
 */
export function libelleConsole(clePublique) {
  const commentaire = String(clePublique ?? '').trim().split(/\s+/)[2] ?? '';
  const propre = commentaire.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 32);
  return propre ? `console-${propre}` : 'console';
}
