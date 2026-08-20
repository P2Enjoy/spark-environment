/**
 * Ce que le locataire fait tourner, lu sans rien y toucher.
 *
 * @spec docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6 (l'onglet Docker, en
 *       lecture), §37.6 bis (le contrat, mesuré), §37.2 (le chemin normal :
 *       SSH), §37.3 (pourquoi PAS `incus exec`) · §36.7 (les lectures ne se
 *       journalisent pas) · docs/DESIGN_SYSTEM_APP.md SPK-DS-05
 *
 * Le chemin est SSH depuis la console, comme le terminal. Pas `incus exec` : le
 * §37.3 réserve le plan de contrôle au dépannage, et lire l'inventaire d'un
 * locataire n'en est pas un. La conséquence est directe et voulue — un Spark
 * dont le `sshd` est muet n'a pas d'onglet Docker, et l'écran le dit dans les
 * termes du §37.2 au lieu d'inventer un second diagnostic.
 *
 * Le point qui décide de ce module : **c'est le code de sortie qui distingue les
 * absences, pas la sortie**, qui est vide dans deux cas sur trois. Mesuré le
 * 2026-08-20 sur un vrai Docker (§37.6 bis).
 */

import { spawn } from 'node:child_process';

import { classerEchecSsh } from './terminal.js';

export const OK = 'ok';
export const SANS_CONTENEUR = 'sans_conteneur';
export const DOCKER_ABSENT = 'docker_absent';
export const MOTEUR_MUET = 'moteur_muet';
export const SSHD_MUET = 'sshd_muet';
export const INJOIGNABLE = 'injoignable';

/**
 * L'inventaire. `-a` et non le défaut : un conteneur ARRÊTÉ est précisément ce
 * qu'on vient chercher quand une pile ne répond plus (§37.6 bis).
 *
 * Format tabulé plutôt que `--format json` : la sortie reste lisible à l'œil au
 * débogage, et sa forme ne change pas d'une version de Docker à l'autre.
 */
export const INVENTAIRE =
  "docker ps -a --no-trunc --format "
  + "'{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'";

/**
 * Les mesures. `--no-stream` est OBLIGATOIRE : sans lui la commande ne rend
 * jamais la main. Elle échantillonne, donc elle est plus lente que l'inventaire
 * — d'où un second relevé, facultatif (§37.6 bis).
 */
export const MESURES =
  "docker stats --no-stream --format "
  + "'{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'";

/**
 * Ce que l'écran dit de chaque état, et le geste qui y répond.
 *
 * `docker_absent` et `moteur_muet` se confondent à l'œil — « Docker ne marche
 * pas » — et n'appellent pas le même geste : le premier s'amorce, le second se
 * redémarre. Les fondre enverrait réinstaller ce qui est déjà là.
 */
export const ETATS = {
  [OK]: { titre: null, detail: null },
  [SANS_CONTENEUR]: {
    titre: 'Aucun conteneur',
    detail: 'Docker tourne dans ce Spark, et rien n’y est lancé. '
      + 'C’est un état normal — une cellule fraîchement amorcée, ou une pile arrêtée.',
  },
  [DOCKER_ABSENT]: {
    titre: 'Docker n’est pas installé dans ce Spark',
    detail: 'L’image de base n’en embarque pas. L’amorçage, sur l’onglet Infos, '
      + 'le pose et rend la cellule capable de faire tourner une pile Compose.',
  },
  [MOTEUR_MUET]: {
    titre: 'Docker est installé, mais son moteur ne répond pas',
    detail: 'La commande existe et le démon ne répond pas. Ce n’est pas une '
      + 'installation qui manque : c’est un service à redémarrer dans le Spark.',
  },
  [SSHD_MUET]: {
    titre: 'Aucun serveur SSH ne répond dans ce Spark',
    detail: 'Cet onglet passe par le même chemin que le terminal. Sans « sshd », '
      + 'la console ne peut rien lire — voyez l’onglet Terminal.',
  },
  [INJOIGNABLE]: {
    titre: 'La console n’a pas pu interroger ce Spark',
    detail: 'La cause n’est pas établie. Rien n’est affirmé de ce qui y tourne.',
  },
};

/** Les états qui n'ont rien à lister, et qui se disent (§6.13, §14.5). */
export const SANS_LISTE = [SANS_CONTENEUR, DOCKER_ABSENT, MOTEUR_MUET,
                           SSHD_MUET, INJOIGNABLE];

/**
 * Le verdict, à partir du code de sortie (§37.6 bis).
 *
 * @spec docs/DAT.md §37.6 bis
 *
 * `stderr` ne sert qu'au cas SSH : un `ssh` qui échoue avant d'avoir lancé quoi
 * que ce soit ne rend pas le code de `docker`, il rend le sien.
 */
export function classer(code, sortie = '', erreurs = '') {
  // `ssh` rend 255 quand c'est LUI qui a échoué, jamais la commande distante.
  if (code === 255) {
    const ssh = classerEchecSsh(code, erreurs);
    return ssh.repond === false ? SSHD_MUET : INJOIGNABLE;
  }
  if (code === 127) return DOCKER_ABSENT;
  if (code !== 0) return MOTEUR_MUET;
  return analyser(sortie).length ? OK : SANS_CONTENEUR;
}

/** Découpe l'inventaire tabulé. Une ligne mal formée est IGNORÉE, pas devinée. */
export function analyser(sortie) {
  const lignes = [];
  for (const brute of String(sortie).split('\n')) {
    const ligne = brute.trimEnd();
    if (!ligne.trim()) continue;
    const [id, name, state, status, image, ports] = ligne.split('\t');
    // Six champs sont demandés ; moins veut dire que la sortie n'est pas celle
    // qu'on croit. L'ignorer vaut mieux que d'inventer un conteneur.
    if (!id || !name) continue;
    lignes.push({
      id, name, state: state ?? '', status: status ?? '',
      image: image ?? '', ports: (ports ?? '').trim(),
    });
  }
  return lignes;
}

/**
 * Attache les mesures aux conteneurs, par NOM.
 *
 * Une mesure absente reste absente : le §14.6 interdit de confondre « pas
 * mesuré » et « zéro », et `docker stats` peut n'avoir pas répondu alors que
 * l'inventaire, lui, a abouti.
 */
export function attacher(conteneurs, sortieMesures) {
  const par = new Map();
  for (const brute of String(sortieMesures ?? '').split('\n')) {
    const [nom, cpu, memoire, part] = brute.trimEnd().split('\t');
    if (nom && cpu) par.set(nom, { cpu, memory: memoire ?? '', memoryPercent: part ?? '' });
  }
  return conteneurs.map((c) => {
    const mesure = par.get(c.name);
    return mesure ? { ...c, ...mesure } : c;
  });
}

/** Lance une commande DANS le Spark, par le chemin du §37.2. */
function surLeSpark(tunnel, spark, commande, spawnFn, doublon) {
  return new Promise((resoudre) => {
    const [programme, ...args] = doublon
      ? doublon.split(/\s+/)
      : ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
         '-o', 'ConnectTimeout=5', ...tunnel.jumpArgs(),
         `root@${spark.ipv4_address}`, commande];
    const enfant = spawnFn(programme, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreurs = '';
    enfant.stdout?.on('data', (bloc) => { sortie += bloc.toString('utf8'); });
    enfant.stderr?.on('data', (bloc) => { erreurs += bloc.toString('utf8'); });
    enfant.on('exit', (code) => resoudre({ code: code ?? 0, sortie, erreurs }));
    // `ssh` introuvable sur le poste : on ne peut RIEN conclure du Spark.
    enfant.on('error', () => resoudre({ code: 255, sortie: '', erreurs: '' }));
  });
}

/**
 * Le relevé complet : inventaire d'abord, mesures ensuite (§37.6 bis).
 *
 * L'inventaire décide de l'état. Si `docker stats` échoue, les conteneurs sont
 * rendus SANS mesures plutôt qu'avec des zéros, et l'état ne change pas : ne pas
 * avoir mesuré n'est pas une panne de Docker.
 */
export async function relever({ tunnel, spark, spawn: spawnFn = spawn,
                                doublon = null } = {}) {
  if (!spark?.incus_name) {
    return { spark: spark?.name ?? null, state: INJOIGNABLE, containers: [],
             ...ETATS[INJOIGNABLE],
             detail: 'Ce Spark n’a pas encore de cellule : rien n’y tourne.' };
  }
  if (spark.state !== 'running') {
    return { spark: spark.name, state: INJOIGNABLE, containers: [],
             titre: 'Ce Spark est arrêté',
             detail: 'Rien ne tourne dans une cellule à l’arrêt.' };
  }

  const inventaire = await surLeSpark(tunnel, spark, INVENTAIRE, spawnFn, doublon);
  const etat = classer(inventaire.code, inventaire.sortie, inventaire.erreurs);
  if (etat !== OK) {
    return { spark: spark.name, state: etat, containers: [], ...ETATS[etat] };
  }

  let conteneurs = analyser(inventaire.sortie);
  const mesures = await surLeSpark(tunnel, spark, MESURES, spawnFn, doublon);
  if (mesures.code === 0) conteneurs = attacher(conteneurs, mesures.sortie);

  return { spark: spark.name, state: OK, containers: conteneurs,
           ...ETATS[OK] };
}
