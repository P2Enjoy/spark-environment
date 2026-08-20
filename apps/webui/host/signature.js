/**
 * La console signe l'intention d'un geste, par l'agent du responsable.
 *
 * @spec docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.3 (où la signature est produite
 *       décide de ce qu'elle vaut), §36.10.1 (ce que l'unité n'est PAS),
 *       §36.10.3 (la forme canonique), §36.10.7 (les en-têtes),
 *       §36.10.8 (côté console) · §21.6.2 (l'identité déclarée) ·
 *       docs/DESIGN_SYSTEM.md §14.7 (pas de jeton technique à l'écran)
 *
 * **Le point qui décide de ce module.** La commande désigne la clé **PUBLIQUE**,
 * jamais la privée. MESURÉ le 2026-08-21 sur OpenSSH 8.9p1 : avec un agent qui
 * détient la clé, `ssh-keygen -Y sign -f cle.pub` signe **sans que la clé privée
 * soit sur le disque** — retirée du disque, la signature est produite et se
 * vérifie. C'est la propriété du §36.3, et elle vaut ici pour la console
 * elle-même, qui signe sans jamais tenir le secret.
 *
 * **Ne pas pouvoir signer n'empêche JAMAIS le geste** (§36.10.8). Refuser d'agir
 * faute de signature ferait de ce mécanisme un contrôle d'accès, et un exploitant
 * dont l'agent vient de se vider ne doit pas découvrir que son produit s'est
 * verrouillé. L'échec est dit, jamais tu.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** La même version que la Forge attend (`sparkd.signature.VERSION`). */
export const VERSION = 'sshsig-v1';

/** Le même espace de noms, et il n'est pas décoratif (§36.10.2). */
export const NAMESPACE = 'spark-audit';

/** Champs retenus, et eux seuls — l'ordre vient du tri, pas d'ici (§36.10.3). */
export const CHAMPS = ['action', 'actor', 'body', 'method', 'path', 'ts'];

/** Motifs d'un échec de signature. Ils sont STABLES ; les messages sont pour
 *  l'humain (§14.7 : le message d'OpenSSH nomme un fichier qu'on n'a pas
 *  demandé, et ne se montre pas tel quel). */
export const SANS_CLE = 'sans_cle';
export const AGENT_MUET = 'agent_muet';
export const ECHEC = 'echec_signature';

export const MOTIFS = {
  [SANS_CLE]: 'Aucune clé de signature n’est configurée pour ce serveur : '
    + 'ce geste part sans signature.',
  [AGENT_MUET]: 'La clé de signature est configurée, mais aucun agent ne la '
    + 'détient et le fichier privé est introuvable : ce geste part sans '
    + 'signature. Chargez la clé dans votre agent — « ssh-add ».',
  [ECHEC]: 'La signature n’a pas pu être produite : ce geste part sans elle.',
};

/**
 * Les octets du §36.10.3, figés.
 *
 * `JSON.stringify` avec des clés TRIÉES, sans espace. Une valeur absente est
 * sérialisée `null`, jamais omise : omettre une clé produirait deux octets
 * différents pour deux intentions équivalentes, et la Forge refuserait une
 * signature parfaitement valide.
 */
export function canonique(intention) {
  const retenu = {};
  for (const champ of [...CHAMPS].sort()) {
    const valeur = intention?.[champ];
    retenu[champ] = valeur === undefined ? null : valeur;
  }
  return Buffer.from(JSON.stringify(retenu), 'utf8');
}

/**
 * Traduit l'échec d'`ssh-keygen` en ce qui MANQUE réellement.
 *
 * MESURÉ : sans agent et sans fichier privé, OpenSSH rend « Load key "…" : No
 * such file or directory ». Ce message nomme un fichier que l'exploitant n'a pas
 * demandé, et le §14.7 interdit un jeton technique à l'écran.
 */
export function classer(code, erreurs = '') {
  if (code === 0) return null;
  return /No such file|Could not open|not found/i.test(String(erreurs))
    ? AGENT_MUET : ECHEC;
}

function lancer(programme, args, spawnFn) {
  return new Promise((resoudre) => {
    const enfant = spawnFn(programme, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreurs = '';
    enfant.stdout?.on('data', (b) => { sortie += b.toString('utf8'); });
    enfant.stderr?.on('data', (b) => { erreurs += b.toString('utf8'); });
    // `close` et non `exit` : `exit` précède le drainage de stdout, et le relevé
    // perdrait des octets en silence (§37.6 ter, mesuré).
    enfant.on('close', (code) => resoudre({ code: code ?? 0, sortie, erreurs }));
    enfant.on('error', () => resoudre({ code: 255, sortie: '', erreurs: 'introuvable' }));
  });
}

/**
 * Signe une intention. Rend `{ signature, signed }` ou `{ motif }`.
 *
 * Ne LÈVE jamais : un geste qui ne peut pas être signé part quand même
 * (§36.10.8). Le motif remonte pour être DIT, pas pour arrêter l'appelant.
 */
export async function signer(intention, { signingKey = null, doublon = null,
                                          spawn: spawnFn = spawn } = {}) {
  const octets = canonique(intention);
  const signed = octets.toString('base64');

  if (!doublon && !signingKey) return { motif: SANS_CLE, signed };

  const dossier = await mkdtemp(join(tmpdir(), 'spark-sign-'));
  try {
    const fichier = join(dossier, 'intention');
    await writeFile(fichier, octets);

    // §36.10.8 : le doublon remplace la COMMANDE, pas le mécanisme — même motif
    // qu'au §37.4.2 bis. Tout le reste du chemin est celui de la production.
    const [programme, ...args] = doublon
      ? ['sh', '-c', doublon, fichier]
      : ['ssh-keygen', '-Y', 'sign', '-f', signingKey, '-n', NAMESPACE, fichier];

    const vu = await lancer(programme, args, spawnFn);
    const motif = classer(vu.code, vu.erreurs);
    if (motif) return { motif, signed };

    const armure = await readFile(`${fichier}.sig`, 'utf8').catch(() => vu.sortie);
    if (!armure.trim()) return { motif: ECHEC, signed };

    // L'en-tête porte la signature sur UNE ligne (§36.10.7) : l'armure est
    // retirée ici, et la Forge la remet. Un en-tête HTTP ne transporte pas de
    // saut de ligne.
    const surUneLigne = armure.split('\n')
      .filter((l) => l && !l.startsWith('-----')).join('');
    return { signature: surUneLigne, signed };
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
}

/**
 * Les deux en-têtes du §36.10.7, prêts à poser sur une requête.
 *
 * Rend un objet VIDE quand rien n'a pu être signé : envoyer une signature vide
 * ferait refuser le geste par la Forge en `422`, alors que le §36.10.1 veut
 * précisément qu'il passe.
 */
export function entetes(resultat) {
  if (!resultat?.signature) return {};
  return {
    'x-spark-signature': resultat.signature,
    'x-spark-signed': resultat.signed,
  };
}
