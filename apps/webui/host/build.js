/**
 * Comparer la build d'une Forge à l'état du dépôt local.
 *
 * @spec docs/BACKLOG.md#SPK-53, docs/BACKLOG.md#SPK-69 ·
 *       docs/DAT.md §40 (la build installée se nomme),
 *       §40.2 (« inconnue » est une réponse, pas un défaut),
 *       §40.3 (ce que la console en fait, et ses cinq situations) ·
 *       docs/DESIGN_SYSTEM.md §14.6 (« inconnue » n'est pas zéro)
 *
 * Le point qui décide de ce module : **la console NOMME ce qu'elle sait, elle ne
 * conclut pas**. Le §40.3 l'écrit pour les deux derniers cas — build étrangère
 * au dépôt, build non estampillée — et dit pourquoi ils comptent autant que les
 * autres : « une console qui afficherait "à jour" faute de savoir comparer
 * mentirait exactement au moment où l'on a besoin d'elle ».
 *
 * La comparaison vit ICI, dans l'hôte console, et pas dans `sparkd` : c'est le
 * poste qui porte le dépôt, et la Forge n'a aucune raison d'en avoir un — le
 * déploiement se fait par `rsync` sans `.git` (§40.1).
 */

import { execFile } from 'node:child_process';

export class BuildError extends Error {}

/** Les six verdicts. Cinq viennent du §40.3 ; le sixième est expliqué plus bas. */
export const A_JOUR = 'a_jour';
export const FORGE_EN_RETARD = 'forge_en_retard';
export const POSTE_EN_RETARD = 'poste_en_retard';
export const ETRANGERE = 'etrangere';
export const NON_ESTAMPILLEE = 'non_estampillee';
/**
 * Sixième cas, ABSENT de la table du §40.3 et rencontré en l'implémentant : la
 * console peut tourner là où il n'y a **aucun dépôt** — une console installée
 * chez un exploitant qui ne développe pas.
 *
 * Le ranger dans « build étrangère » serait faux : on ne sait pas si elle est
 * étrangère, on n'a rien à quoi la comparer. Le §40.3 tranche déjà l'esprit de
 * ce cas — nommer plutôt que conclure —, donc il reçoit son propre verdict.
 */
export const SANS_DEPOT = 'sans_depot';

/**
 * Ce que chaque verdict dit, et ce qu'il ne dit pas.
 *
 * Le texte est ici et non dans le composant : c'est le contrat du §40.3, pas
 * une formulation d'écran, et deux copies divergeraient.
 */
export const VERDICTS = {
  [A_JOUR]: {
    titre: 'À jour',
    detail: 'Cette Forge exécute le même commit que le dépôt de ce poste.',
  },
  [FORGE_EN_RETARD]: {
    titre: 'En retard',
    detail: 'Le dépôt de ce poste porte des commits que cette Forge n’exécute pas.',
  },
  [POSTE_EN_RETARD]: {
    titre: 'C’est ce poste qui est en retard',
    detail: 'La Forge exécute un commit plus récent que le dépôt de ce poste. '
      + 'Récupérez avant de conclure quoi que ce soit sur elle.',
  },
  [ETRANGERE]: {
    titre: 'Build étrangère à ce dépôt',
    detail: 'Le commit de cette Forge est inconnu du dépôt de ce poste. '
      + 'Aucune comparaison n’est possible — ce n’est pas « à jour », c’est « on ne sait pas ».',
  },
  [NON_ESTAMPILLEE]: {
    titre: 'Build non estampillée',
    detail: 'Cette Forge ne dit pas quel code elle exécute. Réinstallez-la pour le savoir.',
  },
  [SANS_DEPOT]: {
    titre: 'Aucun dépôt sur ce poste',
    detail: 'Il n’y a rien ici à quoi comparer la build de cette Forge.',
  },
};

/** Un verdict qui APPELLE un geste. Les autres informent (§40.3). */
export const A_TRAITER = [FORGE_EN_RETARD, NON_ESTAMPILLEE];

function git(args, cwd) {
  return new Promise((resoudre) => {
    execFile('git', args, { cwd, timeout: 5000 }, (erreur, sortie) => {
      // Un `git` en échec n'est PAS une panne de la console : c'est une réponse
      // — « pas de dépôt », « commit inconnu ». Lever ferait d'une absence de
      // comparaison une panne d'écran, ce que le §40.2 refuse pour la Forge et
      // qui vaut ici pour les mêmes raisons.
      resoudre(erreur ? null : String(sortie).trim());
    });
  });
}

/** Résout une empreinte complète ou abrégée ; `null` couvre inconnue ET ambiguë. */
export async function resoudreCommit(commit, racine) {
  if (!/^[0-9a-f]{7,40}$/.test(String(commit ?? ''))) return null;
  const resolved = await git(['rev-parse', `${commit}^{commit}`], racine);
  return /^[0-9a-f]{40}$/.test(resolved ?? '') ? resolved : null;
}

/**
 * L'état du dépôt de ce poste. `null` quand il n'y en a pas.
 *
 * On ne lit QUE la tête : le reste — l'ascendance, le nombre de commits — se
 * demande à `git` pour un couple précis, parce que la réponse dépend du commit
 * de la Forge et qu'un instantané pris à l'avance serait faux dès le suivant.
 */
export async function etatDepot(racine) {
  const tete = await git(['rev-parse', 'HEAD'], racine);
  if (!tete) return null;
  return {
    head: tete,
    branch: await git(['rev-parse', '--abbrev-ref', 'HEAD'], racine),
    // SPK-69 · §40.6 : la Forge télécharge depuis GitHub. Une tête seulement
    // locale ne peut donc jamais être une cible, même si son ascendance est
    // sûre. La comparaison reste une lecture ; la route de geste tranche.
    published: await git(['rev-parse', 'origin/main'], racine),
  };
}

/**
 * Confronte la build d'une Forge au dépôt local. Rend UN des six verdicts.
 *
 * `forge` est l'objet `build` que `/v1/forge` publie (§40.3).
 */
export async function comparer(forge, racine, depot = undefined) {
  const local = depot === undefined ? await etatDepot(racine) : depot;
  const commit = forge?.commit ?? null;

  // §40.2 : une build non estampillée se DIT inconnue. C'est une réponse.
  if (!commit) return { verdict: NON_ESTAMPILLEE, forge: forge ?? null, local };
  if (!local) return { verdict: SANS_DEPOT, forge, local: null };

  // Les paquets setuptools-scm historiques publient une abréviation unique.
  // `rev-parse` la résout ET refuse une abréviation ambiguë : la route de mise
  // à jour ne reçoit donc jamais autre chose qu'une empreinte complète.
  const forgeCommit = await resoudreCommit(commit, racine);
  if (forgeCommit === null) return { verdict: ETRANGERE, forge, local };

  if (forgeCommit === local.head) {
    return { verdict: A_JOUR, forge, forgeCommit, local, behind: 0 };
  }

  const forgeAncetre = await git(
    ['merge-base', '--is-ancestor', forgeCommit, local.head], racine);
  if (forgeAncetre !== null) {
    const compte = await git(['rev-list', '--count', `${forgeCommit}..${local.head}`], racine);
    return { verdict: FORGE_EN_RETARD, forge, forgeCommit, local,
             behind: Number(compte ?? 0) };
  }

  const localAncetre = await git(
    ['merge-base', '--is-ancestor', local.head, forgeCommit], racine);
  if (localAncetre !== null) {
    const compte = await git(['rev-list', '--count', `${local.head}..${forgeCommit}`], racine);
    return { verdict: POSTE_EN_RETARD, forge, forgeCommit, local,
             ahead: Number(compte ?? 0) };
  }

  // Connu, mais ni ancêtre ni descendant : les deux histoires ont divergé. Le
  // §40.3 ne nomme pas ce cas séparément, et « étrangère » le décrit bien —
  // aucune conclusion n'est possible sur qui est en avance.
  return { verdict: ETRANGERE, forge, forgeCommit, local };
}
