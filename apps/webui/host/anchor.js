/**
 * L'ancre : la console est le second témoin du journal.
 *
 * @spec docs/BACKLOG.md#SPK-38 · docs/DAT.md §36.1 (ce qu'une chaîne ne prouve
 *       pas), §36.2 (l'ancre), §36.9.6 (les cinq verdicts)
 *
 * Le point qui décide de tout : une chaîne de hachage détecte la modification et
 * la suppression au milieu, mais **pas** la troncature ni le remplacement — qui
 * peut écrire dans le fichier peut recalculer toute la chaîne. Ce qui distingue
 * un journal chaîné utile d'un journal chaîné décoratif, ce n'est donc pas la
 * chaîne : c'est le fait que la vérité de référence vive **ailleurs** que sur la
 * machine qu'on soupçonne.
 *
 * La console tourne sur une autre machine et s'y connecte régulièrement. Elle
 * retient, par serveur, la dernière tête vue, et vérifie que l'histoire annoncée
 * **prolonge** celle qu'elle connaît.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_PATH as INVENTAIRE } from './inventory.js';

/**
 * Fichier distinct de l'inventaire, et ce n'est pas un détail : `inventory.save`
 * ne réécrit que six champs et écarte tout le reste. Une ancre rangée dans
 * l'inventaire disparaîtrait au premier enregistrement d'un serveur — c'est-à-dire
 * silencieusement, et précisément quand on croirait la référence tenue.
 */
export const DEFAULT_ANCHOR_PATH =
  process.env.SPARK_CONSOLE_ANCHORS ?? join(dirname(INVENTAIRE), 'anchors.json');

export const FIRST = 'first';
export const EXTENDS = 'extends';
export const UNCHANGED = 'unchanged';
export const SHRUNK = 'shrunk';
export const DIVERGED = 'diverged';

/** Les deux verdicts qui signalent ce que la chaîne seule ne voit pas (§36.1). */
export const ALERTES = [SHRUNK, DIVERGED];

export const EXPLICATIONS = {
  [FIRST]: 'Premier relevé de ce serveur : la référence est posée, rien n’est jugé.',
  [EXTENDS]: 'L’histoire du serveur prolonge celle que la console avait vue.',
  [UNCHANGED]: 'Rien n’a été écrit au journal depuis le dernier relevé.',
  [SHRUNK]: 'Le journal a RACCOURCI : des entrées ont disparu de la fin. '
    + 'La chaîne seule ne peut pas voir cela — c’est la console qui le voit.',
  [DIVERGED]: 'L’histoire annoncée ne contient plus ce que la console avait vu : '
    + 'le journal a été remplacé. La chaîne seule ne peut pas voir cela.',
};

/**
 * Compare ce que la console avait retenu à ce que le serveur annonce.
 *
 * `connue` est l'ancre retenue (ou `null`), `annoncee` porte `head` et `length`
 * du relevé, et `contient` dit si la tête retenue se retrouve dans l'histoire
 * annoncée — c'est le serveur qui répond à cette question, et c'est assumé : un
 * hôte hostile ment, et c'est précisément pourquoi une longueur en recul suffit
 * à alerter sans lui demander son avis.
 */
export function juger(connue, annoncee, contient = false) {
  if (!connue?.head) return FIRST;
  const avant = Number(connue.length ?? 0);
  const apres = Number(annoncee?.length ?? 0);

  // Le recul se juge AVANT tout le reste : c'est la troncature, et elle ne se
  // discute pas. Un serveur qui aurait aussi remplacé son journal serait alors
  // signalé « shrunk » plutôt que « diverged » — les deux sont des alertes, et
  // celle qui se constate sans faire confiance à l'hôte prime.
  if (apres < avant) return SHRUNK;
  if (annoncee?.head === connue.head && apres === avant) return UNCHANGED;
  return contient ? EXTENDS : DIVERGED;
}

export async function load(path = DEFAULT_ANCHOR_PATH) {
  try {
    const brut = await readFile(path, 'utf8');
    const donnees = JSON.parse(brut);
    return donnees && typeof donnees === 'object' && !Array.isArray(donnees) ? donnees : {};
  } catch (erreur) {
    // Une ancre illisible n'est PAS une panne de la console : on repart sans
    // référence, ce que le verdict `first` dit honnêtement. Refuser de démarrer
    // rendrait la console inutilisable pour un fichier d'état accessoire.
    if (erreur.code === 'ENOENT') return {};
    return {};
  }
}

export async function save(ancres, path = DEFAULT_ANCHOR_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ancres, null, 2) + '\n', { mode: 0o600 });
  return ancres;
}

/**
 * Confronte un relevé à l'ancre, et met celle-ci à jour SI le verdict est sain.
 *
 * L'ancre n'est mise à jour que sur `first`, `extends` et `unchanged`. Écraser
 * la référence sur un verdict d'alerte reviendrait à effacer la preuve avec le
 * signal : au relevé suivant, tout paraîtrait normal (§36.9.6).
 */
export function confronter(ancres, serveur, releve, contient = false) {
  const verdict = juger(ancres[serveur] ?? null, releve, contient);
  const suivantes = { ...ancres };
  if (!ALERTES.includes(verdict)) {
    suivantes[serveur] = {
      head: releve?.head ?? null,
      length: Number(releve?.length ?? 0),
      seenAt: releve?.verified_at ?? null,
    };
  }
  return {
    verdict,
    explanation: EXPLICATIONS[verdict],
    alert: ALERTES.includes(verdict),
    known: ancres[serveur] ?? null,
    announced: { head: releve?.head ?? null, length: Number(releve?.length ?? 0) },
    anchors: suivantes,
  };
}
