/**
 * Le verrou EXCLUSIF des harnais lourds.
 *
 * @spec docs/BACKLOG.md#SPK-106 · docs/DAT.md §29.8 (une seule pile lourde à la
 *       fois) · CLAUDE.md §14 (l'environnement local), §21 (les performances se
 *       mesurent, et une ressource se borne)
 *
 * **Pourquoi il existe.** Chaque harnais monte une pile complète — `sparkd`, la
 * console, un navigateur Chromium et ses onglets. Deux campagnes lancées en même
 * temps, c'est deux navigateurs et deux piles ; quatre, c'est la machine à
 * genoux. Mesuré le 2026-09-14, sur ce poste : quatre campagnes lancées coup sur
 * coup en tâche de fond ont épuisé la mémoire, le noyau a tué le dernier
 * processus (code 137), et l'exécution a emporté avec elle un fichier que ce
 * processus devait restaurer en sortant.
 *
 * **Pourquoi il est ICI et pas dans le `Makefile`.** Une cible qu'on oublie
 * d'emprunter ne protège rien, et rien n'oblige à passer par `make` : un
 * `node e2e/…` direct fait le même mal. `monterPile()` est le seul passage que
 * TOUS les harnais traversent — ceux d'aujourd'hui et ceux qu'on écrira. Le
 * verrou y est donc une porte, pas une consigne.
 *
 * **Il n'a aucun interrupteur**, et c'est délibéré (`CLAUDE.md` §3) : ni
 * variable d'environnement, ni argument pour le contourner. Un verrou qu'on peut
 * désactiver est un verrou qu'on désactive le jour où il gêne, c'est-à-dire le
 * jour où il sert.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Où vit le verrou.
 *
 * Dans le répertoire temporaire du système, et non dans le dépôt : c'est un état
 * d'exécution, il ne se versionne pas et il doit disparaître au redémarrage du
 * poste. Le nom est fixe — deux processus doivent se disputer LE MÊME fichier,
 * sans quoi il n'y a pas de verrou.
 */
export const CHEMIN = join(tmpdir(), 'spark-e2e.verrou');

/** Ce qu'on inscrit dedans, pour que le refus puisse NOMMER qui tient. */
function empreinteDuPorteur() {
  return JSON.stringify({
    pid: process.pid,
    commande: process.argv.slice(1).join(' '),
    depuis: new Date().toISOString(),
  });
}

/** Le porteur tient-il encore, ou le verrou est-il une épave ? */
function porteurVivant(pid) {
  try {
    // Signal 0 : ne tue rien, vérifie seulement que le processus existe et
    // qu'on a le droit de le signaler.
    process.kill(pid, 0);
    return true;
  } catch (erreur) {
    // EPERM veut dire « il existe, mais il n'est pas à moi » : c'est vivant.
    return erreur.code === 'EPERM';
  }
}

function lireLePorteur() {
  try {
    return JSON.parse(readFileSync(CHEMIN, 'utf8'));
  } catch {
    // Un verrou illisible — écriture interrompue, fichier tronqué — est traité
    // comme une épave SANS porteur connu. On ne le prend pas pour autant : le
    // §29.8 veut qu'on refuse plutôt qu'on devine.
    return null;
  }
}

export class VerrouTenu extends Error {
  constructor(porteur) {
    const age = porteur?.depuis
      ? Math.round((Date.now() - Date.parse(porteur.depuis)) / 1000) : null;
    // Deux refus, parce qu'ils appellent deux gestes différents. Dire « il se
    // libérera tout seul » d'un verrou illisible serait faux, et ferait
    // attendre indéfiniment quelque chose qui n'arrivera pas.
    const suite = porteur?.pid
      ? '  Attendez qu’elle finisse. Si ce PID n’existe plus, le verrou se\n'
        + '  libère tout seul au prochain essai.'
      : '  Ce verrou est ILLISIBLE : on ne peut pas savoir qui le tient, et le\n'
        + '  reprendre ferait peut-être tourner deux piles à la fois. Si aucune\n'
        + '  campagne ne tourne, effacez-le à la main.';
    super(
      'Une pile d’épreuve tourne DÉJÀ sur ce poste, et il ne peut y en avoir '
      + 'qu’une : chacune monte sparkd, la console et un navigateur.\n'
      + `  tenue par le PID ${porteur?.pid ?? 'inconnu'}`
      + (porteur?.commande ? ` — ${porteur.commande}` : '')
      + (age !== null ? `\n  depuis ${age} s` : '')
      + `\n  verrou : ${CHEMIN}\n`
      + suite);
    this.name = 'VerrouTenu';
    this.porteur = porteur;
  }
}

let tenuParNous = false;

/**
 * Prend le verrou, ou LÈVE.
 *
 * `openSync(…, 'wx')` est atomique : le fichier est créé, ou l'ouverture échoue.
 * Deux processus qui démarrent en même temps ne peuvent donc pas croire tous
 * les deux l'avoir pris.
 *
 * Un verrou dont le porteur est mort est une ÉPAVE — la machine a redémarré, le
 * processus a été tué par le noyau, `SIGKILL` ne laisse exécuter aucun
 * nettoyage. On le reprend en le disant : sans cela, un seul OOM rendrait le
 * harnais inutilisable jusqu'à ce que quelqu'un efface un fichier dont il
 * ignore l'existence.
 */
export function prendreLeVerrou({ journal = console } = {}) {
  try {
    const fd = openSync(CHEMIN, 'wx');
    writeSync(fd, empreinteDuPorteur());
    closeSync(fd);
  } catch (erreur) {
    if (erreur.code !== 'EEXIST') throw erreur;
    const porteur = lireLePorteur();
    // ILLISIBLE : on ne sait pas qui tient, donc on REFUSE. Le reprendre ferait
    // peut-être tourner deux piles à la fois — exactement ce que ce fichier
    // existe pour empêcher. Le §29.8 refuse plutôt qu'il ne devine.
    if (!porteur?.pid) throw new VerrouTenu(porteur);
    if (porteurVivant(porteur.pid)) throw new VerrouTenu(porteur);
    journal.warn?.(
      `Verrou d’épreuve abandonné par le PID ${porteur?.pid ?? 'inconnu'} `
      + '(processus disparu) : il est repris.');
    unlinkSync(CHEMIN);
    return prendreLeVerrou({ journal });
  }
  tenuParNous = true;
  // La sortie normale rend le verrou. `exit` couvre le retour de `main`, une
  // exception non rattrapée et `process.exit()` ; les deux signaux couvrent le
  // Ctrl-C et le `kill` ordinaire. Reste `SIGKILL`, qu'aucun code ne peut
  // intercepter — et c'est exactement le cas que la reprise d'épave traite.
  process.once('exit', rendreLeVerrou);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { rendreLeVerrou(); process.exit(130); });
  }
  return CHEMIN;
}

/** Rend le verrou. Idempotent : appelé par la sortie ET par `demonter()`. */
export function rendreLeVerrou() {
  if (!tenuParNous) return;
  tenuParNous = false;
  try {
    unlinkSync(CHEMIN);
  } catch {
    // Déjà retiré — par notre propre `demonter()`, ou par une reprise d'épave
    // qui nous a cru morts. Il n'y a rien à réparer ici.
  }
}
