/**
 * Ce que le redémarrage de la console refuse, et la preuve que le nouveau code
 * se charge.
 *
 * @spec docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.2 (ce que la route refuse, et
 *       pourquoi), §62.3 (le nouveau code doit se charger avant qu'on quitte
 *       l'ancien)
 *
 * Le verdict est PUR : la route le rejoue sur l'état du processus, les preuves
 * le rejouent sur des états construits. Le préflight, lui, lance un vrai Node —
 * la seule façon de savoir si des modules se chargent est de les charger.
 */

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DELAI_CHARGEMENT_MS = 20_000;
// Assez pour porter le fichier, la ligne et le message d'une erreur de syntaxe
// ou d'import : Node les écrit EN TÊTE, la pile d'appels vient après.
const TETE_SORTIE = 1500;

/**
 * Rend `null` si rien ne s'oppose au redémarrage, sinon `{ code, message }`.
 *
 * Les sessions de terminal ne sont PAS un refus (§62.2) : elles mourront avec
 * la console, et la confirmation les nomme. Ce qui se refuse, c'est une session
 * que la confirmation n'a PAS nommée — née entre l'affichage et le clic.
 */
export function examinerRelance({ relancable, enCours = false, misesAJour = [],
                                  installations = [], sessions = [], annoncees = [] }) {
  if (!relancable) {
    return { code: 'relance_indisponible',
      message: 'Cette console n’a pas été démarrée par son lanceur (make runProd, '
        + 'make runDev ou pnpm dev) : personne ne la relancerait. Arrêtez-la et '
        + 'relancez-la à la main.' };
  }
  if (enCours) {
    return { code: 'relance_en_cours',
      message: 'Un redémarrage de la console est déjà en cours.' };
  }
  if (misesAJour.length) {
    return { code: 'mise_a_jour_en_cours',
      message: `Une mise à jour de sparkd est en cours sur ${nommer(misesAJour)}. `
        + 'Attendez sa fin : redémarrer maintenant laisserait la Forge entre deux builds.' };
  }
  if (installations.length) {
    return { code: 'installation_en_cours',
      message: `Une installation est en cours sur ${nommer(installations)}. `
        + 'Attendez sa fin avant de redémarrer la console.' };
  }
  const nommees = new Set(annoncees);
  const imprevues = sessions.filter((s) => !nommees.has(s.id));
  if (imprevues.length) {
    return { code: 'sessions_changees',
      message: 'Une session de terminal s’est ouverte depuis la confirmation '
        + `(${nommer(imprevues.map((s) => s.spark))}). Relisez la confirmation : `
        + 'elle serait fermée sans avoir été nommée.' };
  }
  return null;
}

const nommer = (noms) => [...new Set(noms)].map((n) => `« ${n} »`).join(', ');

/**
 * La tête d'une erreur de chargement : fichier, ligne, code, message.
 *
 * La pile d'appels qui suit ne parle que du chargeur de Node, et noyait le
 * message dans une trentaine de lignes — vu en capture le 2026-09-24.
 */
export function tete(sortie) {
  const lignes = String(sortie).split('\n');
  const pile = lignes.findIndex((l) => /^\s+at /.test(l));
  return (pile === -1 ? lignes : lignes.slice(0, pile)).join('\n').trim();
}

/**
 * Importe `cheminMain` dans un processus à part, et dit s'il s'est chargé.
 *
 * L'import charge tous les modules sans rien écouter : le bloc de démarrage de
 * `main.js` ne s'exécute que lorsqu'il est le script lancé. La preuve est donc
 * bornée — le code se CHARGE, rien ne dit qu'il DÉMARRE —, et le §62.3 l'écrit.
 *
 * Rend `{ ok: true }` ou `{ ok: false, sortie }`, jamais une exception : un
 * préflight qui lèverait ferait passer un refus pour une panne de l'hôte.
 */
export function verifierChargement(cheminMain, { spawnFn = spawn,
                                                 delaiMs = DELAI_CHARGEMENT_MS } = {}) {
  return new Promise((rendre) => {
    let sortie = '';
    let fini = false;
    const conclure = (verdict) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      rendre(verdict);
    };
    const enfant = spawnFn(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(cheminMain).href)});`], {
      cwd: dirname(dirname(cheminMain)), stdio: ['ignore', 'ignore', 'pipe'],
    });
    enfant.stderr.on('data', (bloc) => {
      if (sortie.length < TETE_SORTIE) sortie = (sortie + bloc).slice(0, TETE_SORTIE);
    });
    const minuterie = setTimeout(() => {
      enfant.kill('SIGKILL');
      conclure({ ok: false,
        sortie: `Le chargement n’a pas abouti en ${Math.round(delaiMs / 1000)} s.` });
    }, delaiMs);
    enfant.on('error', (erreur) => conclure({ ok: false, sortie: erreur.message }));
    enfant.on('close', (code) => conclure(code === 0
      ? { ok: true }
      : { ok: false, sortie: tete(sortie) || `Le chargement est sorti en ${code}.` }));
  });
}
