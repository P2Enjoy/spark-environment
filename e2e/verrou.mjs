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

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * L'identifiant de SESSION d'un processus, lu dans `/proc/<pid>/stat`.
 *
 * Complété le 2026-09-17, après un second incident : un harnais tué en `137`
 * laisse ses Chromium derrière lui — ils survivent au processus `node` et
 * continuent d'occuper la mémoire. Le porteur étant mort, l'épave était reprise
 * et une SECONDE pile démarrait à côté des orphelins : exactement ce que ce
 * fichier existe pour empêcher. Les enfants d'un processus gardent sa session
 * jusqu'à leur mort ; c'est elle qu'on inscrit, et elle qu'on relit.
 */
function sessionDe(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Le nom de commande est entre parenthèses et peut contenir des espaces :
    // les champs se comptent APRÈS la dernière parenthèse fermante.
    const apres = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // state(0) ppid(1) pgrp(2) session(3)
    return Number(apres[3]) || null;
  } catch {
    return null;
  }
}

function commandeDe(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim().slice(0, 100);
  } catch {
    return '';
  }
}

/** Les processus encore VIVANTS d'une session, hors le nôtre. */
export function survivantsDeLaSession(sid) {
  if (!sid) return [];
  const vivants = [];
  for (const entree of readdirSync('/proc')) {
    if (!/^\d+$/.test(entree)) continue;
    const pid = Number(entree);
    if (pid === process.pid) continue;
    if (sessionDe(pid) === sid) vivants.push({ pid, commande: commandeDe(pid) });
  }
  return vivants;
}

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
    sid: sessionDe(process.pid),
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
  constructor(porteur, survivants = []) {
    const age = porteur?.depuis
      ? Math.round((Date.now() - Date.parse(porteur.depuis)) / 1000) : null;
    if (survivants.length) {
      // Le porteur est mort, sa pile non. Reprendre ici ferait tourner deux
      // piles — c'est le second incident, celui du 2026-09-17. On REFUSE, et
      // on nomme ce qu'il faut tuer.
      super(
        'Une pile d’épreuve tuée a laissé des processus VIVANTS sur ce poste, et '
        + 'il ne peut y avoir qu’une pile à la fois.\n'
        + `  porteur mort : PID ${porteur?.pid ?? 'inconnu'}`
        + (porteur?.commande ? ` — ${porteur.commande}` : '')
        + '\n  survivants de sa session :\n'
        + survivants.map((s) => `    ${s.pid}  ${s.commande}`).join('\n')
        + `\n  verrou : ${CHEMIN}\n`
        + '  Tuez-les d’abord — `kill -9 '
        + survivants.map((s) => s.pid).join(' ')
        + '` — puis relancez UNE fois. Le verrou n’est pas repris tant qu’ils vivent.');
      this.name = 'VerrouTenu';
      this.porteur = porteur;
      this.survivants = survivants;
      return;
    }
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
    this.survivants = [];
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
    // Porteur mort — mais sa pile ? Un Chromium orphelin est une épreuve qui
    // tourne encore. Tant qu'un processus de sa session vit, on REFUSE.
    const survivants = survivantsDeLaSession(porteur.sid);
    if (survivants.length) throw new VerrouTenu(porteur, survivants);
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
