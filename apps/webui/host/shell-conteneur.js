/**
 * Quel shell un conteneur porte — sondé, jamais supposé.
 *
 * @spec docs/BACKLOG.md#SPK-45 · docs/DAT.md §37.4.7 (le terminal DANS un
 *       conteneur), §37.3.1 (sonder avant de conclure), §37.6 ter (le conteneur
 *       disparu), §37.7.1 (les codes de sortie mesurés) ·
 *       docs/DESIGN_SYSTEM.md §14.5, §14.7
 *
 * **Le point qui décide de ce module** : quand le binaire demandé manque de
 * l'image, `docker exec` rend `127` et écrit son message sur la SORTIE
 * STANDARD, pas sur la sortie d'erreur. Mesuré le 2026-08-20 sur Docker 29.6.1.
 *
 * Une console qui ne surveillerait que `stderr` ne verrait rien et prendrait
 * l'échec pour un shell ouvert et muet — la pire des deux erreurs, puisqu'elle
 * laisse une fenêtre noire dont il faut deviner pourquoi elle est vide.
 *
 * D'où le sondage : un aller-retour de plus à l'ouverture, pour qu'un terminal
 * qui s'ouvre soit un terminal qui marche.
 */

import { spawn } from 'node:child_process';

import { classerEchecSsh } from './terminal.js';
import { doublonPour, quoter } from './docker.js';

/** Les états rendus par le sondage. */
export const SHELL_TROUVE = 'shell_trouve';
export const SANS_SHELL = 'sans_shell';
export const CONTENEUR_ARRETE = 'conteneur_arrete';
export const CONTENEUR_INCONNU = 'conteneur_inconnu';
export const SSHD_MUET = 'sshd_muet';
export const INDETERMINE = 'indetermine';

/**
 * La commande de sondage.
 *
 * `bash` d'abord — il donne l'historique et l'édition de ligne —, `sh` ensuite.
 * `command -v` et non `which` : `which` n'existe pas dans toutes les images.
 */
export const sondage = (nom) =>
  `docker exec ${quoter(nom)} sh -c 'command -v bash || command -v sh'`;

/** La commande d'ouverture, une fois le shell CONNU. */
export const ouverture = (nom, shell) =>
  `docker exec -it ${quoter(nom)} ${quoter(shell)}`;

/** Ce que l'écran écrit, par état. Chaque absence est NOMMÉE (§14.5). */
export const ETATS = {
  [SANS_SHELL]: {
    titre: 'Ce conteneur n’a pas de shell',
    detail: 'Son image n’en embarque aucun — ni « bash », ni « sh ». C’est le '
      + 'cas des images « distroless », et c’est un choix de sécurité délibéré, '
      + 'pas une panne. Il n’y a rien où entrer.',
  },
  [CONTENEUR_ARRETE]: {
    titre: 'Ce conteneur est arrêté',
    detail: 'On n’entre pas dans un conteneur qui ne tourne pas. Démarrez-le '
      + 'depuis sa fiche, puis revenez.',
  },
  [CONTENEUR_INCONNU]: {
    titre: 'Ce conteneur a disparu',
    detail: 'Il n’existe plus sur ce Spark. Le locataire a pu le supprimer '
      + 'depuis le dernier relevé — c’est un état normal, pas une panne.',
  },
  [SSHD_MUET]: {
    titre: 'Aucun serveur SSH ne répond dans ce Spark',
    detail: 'Sans « sshd », la console ne peut pas atteindre ses conteneurs — '
      + 'voyez le terminal du Spark.',
  },
  [INDETERMINE]: {
    titre: 'Le shell de ce conteneur n’a pas pu être établi',
    detail: 'La console ne conclut pas sur ce qu’elle n’a pas constaté.',
  },
};

/**
 * Classe le sondage.
 *
 * @param sortie  stdout — c'est LÀ qu'arrive le message du `127`.
 * @param erreurs stderr — c'est là qu'arrivent les refus du démon.
 */
export function classer(code, sortie = '', erreurs = '') {
  if (code === 255) {
    return classerEchecSsh(code, String(erreurs)).repond === false
      ? SSHD_MUET : INDETERMINE;
  }
  const texte = `${sortie}\n${erreurs}`;
  // L'ordre compte : « No such container » est plus précis que « is not
  // running », et un conteneur disparu ne se dit pas « arrêté ».
  if (/No such container|No such object/i.test(texte)) return CONTENEUR_INCONNU;
  if (/is not running/i.test(texte)) return CONTENEUR_ARRETE;
  if (code === 0) {
    return premierChemin(sortie) ? SHELL_TROUVE : SANS_SHELL;
  }
  // MESURÉ : le binaire manquant rend 127, et son message est sur STDOUT.
  if (code === 127 || /executable file not found/i.test(texte)) return SANS_SHELL;
  return INDETERMINE;
}

/**
 * Le premier chemin absolu rendu par `command -v`.
 *
 * `command -v bash || command -v sh` n'imprime qu'une ligne, mais une image
 * bavarde peut en ajouter : on prend la PREMIÈRE qui ressemble à un chemin, et
 * jamais une ligne quelconque — la lancer reviendrait à exécuter ce qu'une
 * image aurait écrit sur sa sortie.
 */
export function premierChemin(sortie) {
  for (const ligne of String(sortie ?? '').split('\n')) {
    const propre = ligne.trim();
    if (/^\/[\w./-]+$/.test(propre)) return propre;
  }
  return null;
}

function surLeSpark(tunnel, spark, commande, spawnFn, doublonBrut) {
  const doublon = doublonPour(doublonBrut, commande);
  return new Promise((resoudre) => {
    const [programme, ...args] = doublon
      ? ['sh', '-c', doublon, commande]
      : ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
         '-o', 'ConnectTimeout=5', ...tunnel.jumpArgs(),
         `root@${spark.ipv4_address}`, commande];
    const enfant = spawnFn(programme, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreurs = '';
    enfant.stdout?.on('data', (bloc) => { sortie += bloc.toString('utf8'); });
    enfant.stderr?.on('data', (bloc) => { erreurs += bloc.toString('utf8'); });
    // `close` et non `exit` : `exit` précède le drainage de stdout — mesuré au
    // §37.6 ter, où le relevé perdait des lignes en silence.
    enfant.on('close', (code) => resoudre({ code: code ?? 0, sortie, erreurs }));
    enfant.on('error', () => resoudre({ code: 255, sortie: '', erreurs: '' }));
  });
}

/**
 * Sonde le shell d'un conteneur.
 *
 * Rend `{ state, shell, titre, detail }`. `shell` n'est renseigné que dans le
 * seul cas où l'on a CONSTATÉ qu'il existe.
 */
export async function sonderShell({ tunnel, spark, nom,
                                    spawn: spawnFn = spawn, doublon = null } = {}) {
  if (!nom) {
    return { state: INDETERMINE, shell: null, ...ETATS[INDETERMINE],
             detail: 'Aucun conteneur nommé.' };
  }
  if (spark?.state !== 'running' || !spark?.incus_name) {
    return { state: INDETERMINE, shell: null,
             titre: 'Ce Spark est arrêté',
             detail: 'Rien ne tourne dans une cellule à l’arrêt.' };
  }
  const vu = await surLeSpark(tunnel, spark, sondage(nom), spawnFn, doublon);
  const etat = classer(vu.code, vu.sortie, vu.erreurs);
  if (etat === SHELL_TROUVE) {
    return { state: SHELL_TROUVE, shell: premierChemin(vu.sortie), name: nom };
  }
  return { state: etat, shell: null, name: nom, ...ETATS[etat] };
}
