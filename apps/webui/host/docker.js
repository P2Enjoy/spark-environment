/**
 * Ce que le locataire fait tourner, lu sans rien y toucher.
 *
 * @spec docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6 (l'onglet Docker, en
 *       lecture), §37.6 bis (l'inventaire, mesuré), §37.6 ter (l'inspection et
 *       les journaux, mesurés), §37.2 (le chemin normal : SSH), §37.3 (pourquoi
 *       PAS `incus exec`) · §36.7 (les lectures ne se journalisent pas) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-05
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

export const CONTENEUR_INCONNU = 'conteneur_inconnu';

/** Combien de lignes de journal au plus. Le §37.6 ter dit pourquoi une borne. */
export const TAIL = 200;

/**
 * L'inspection d'un conteneur (§37.6 ter).
 *
 * Trois commandes plutôt qu'une : les réseaux et les montages sont des LISTES,
 * et les mêler à la ligne d'identité obligerait à deviner où l'une finit.
 */
export const inspecter = (nom) => `docker inspect ${quoter(nom)} --format `
  + "'{{.Name}}\t{{.State.Status}}\t{{.State.ExitCode}}\t{{.State.StartedAt}}"
  + "\t{{.State.FinishedAt}}\t{{.RestartCount}}\t{{.Config.Image}}'";

export const reseaux = (nom) => `docker inspect ${quoter(nom)} --format `
  + "'{{range $r,$c := .NetworkSettings.Networks}}{{$r}}\t{{$c.IPAddress}}\n{{end}}'";

export const montages = (nom) => `docker inspect ${quoter(nom)} --format `
  + "'{{range .Mounts}}{{.Type}}\t{{.Source}}\t{{.Destination}}"
  + "\t{{if .RW}}rw{{else}}ro{{end}}\n{{end}}'";

/**
 * Les journaux, BORNÉS (§37.6 ter).
 *
 * Sans `--tail`, un conteneur bavard renvoie tout son historique par le tunnel
 * et l'écran devient inutilisable au moment précis où l'on en a besoin.
 */
export const journaux = (nom, tail = TAIL) =>
  `docker logs --tail ${Number(tail) || TAIL} --timestamps ${quoter(nom)} 2>&1`;

/**
 * Un nom de conteneur entre guillemets simples, pour le shell distant.
 *
 * Il vient de l'inventaire, donc de Docker — mais il traverse un `ssh`, et une
 * valeur non citée y serait interprétée. On ne suppose pas qu'un nom est sûr
 * parce qu'on l'a lu quelque part.
 */
export function quoter(valeur) {
  return `'${String(valeur ?? '').replace(/'/g, "'\\''")}'`;
}

/** Le nom que Docker rend est préfixé d'une barre oblique. MESURÉ. */
const sansBarre = (nom) => String(nom ?? '').replace(/^\//, '');

/** Découpe l'identité d'un conteneur (§37.6 ter). */
export function analyserInspection(sortie) {
  const [ligne] = String(sortie).split('\n').filter((l) => l.trim());
  if (!ligne) return null;
  const [nom, etat, code, debut, fin, redemarrages, image] = ligne.split('\t');
  return {
    name: sansBarre(nom),
    state: etat ?? '',
    // §14.6 : le code de sortie n'existe QUE pour un conteneur arrêté. Rendre 0
    // pour un conteneur en marche ferait croire qu'il s'est terminé sans erreur.
    exitCode: etat === 'exited' ? Number(code ?? 0) : null,
    startedAt: debut || null,
    finishedAt: etat === 'exited' ? (fin || null) : null,
    restarts: Number(redemarrages ?? 0),
    image: image ?? '',
  };
}

export function analyserReseaux(sortie) {
  return String(sortie).split('\n').map((l) => l.trimEnd()).filter(Boolean)
    .map((l) => {
      const [name, address] = l.split('\t');
      return { name, address: address || null };
    })
    .filter((r) => r.name);
}

export function analyserMontages(sortie) {
  return String(sortie).split('\n').map((l) => l.trimEnd()).filter(Boolean)
    .map((l) => {
      const [type, source, destination, mode] = l.split('\t');
      return { type, source: source ?? '', destination: destination ?? '',
               mode: mode ?? '' };
    })
    .filter((m) => m.destination);
}

/**
 * Découpe les journaux horodatés.
 *
 * Les horodatages sont rendus TELS QUELS : ce sont ceux du locataire, et les
 * reformater dans le fuseau du poste décalerait l'écran de ce qu'il lit dans son
 * propre journal (§37.6 ter).
 */
export function analyserJournaux(sortie) {
  return String(sortie).split('\n').map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length)
    .map((ligne) => {
      const espace = ligne.indexOf(' ');
      const tete = espace > 0 ? ligne.slice(0, espace) : '';
      // Une ligne sans horodatage reconnaissable n'en reçoit pas un inventé.
      return /^\d{4}-\d{2}-\d{2}T/.test(tete)
        ? { at: tete, text: ligne.slice(espace + 1) }
        : { at: null, text: ligne };
    });
}

/** Lance une commande DANS le Spark, par le chemin du §37.2. */
/**
 * Le doublon qui répond à CETTE commande.
 *
 * Une chaîne simple répond à tout — c'est le doublon de la première tranche. Une
 * table JSON répond par geste (« ps », « stats », « inspect », « logs », plus
 * les quatre gestes du §37.7), parce que ces commandes n'ont pas à rendre la
 * même chose, et que l'une puisse échouer pendant que l'autre aboutit.
 *
 * `*` sert de réponse par défaut. Une valeur absente laisse passer la vraie
 * commande, ce qui échouera bruyamment plutôt que de rendre une sortie muette.
 */
export function doublonPour(doublon, commande) {
  if (!doublon) return null;
  if (!doublon.trimStart().startsWith('{')) return doublon;
  let table;
  try { table = JSON.parse(doublon); } catch { return doublon; }
  // Les quatre gestes du §37.7 en font partie : sans eux, un doublon laisse
  // partir la VRAIE commande `ssh`, qui échoue en 255 et fait rendre à l'écran
  // « aucun serveur SSH ne répond » — un diagnostic qui ne dit rien du geste.
  const geste = /docker\s+(ps|stats|inspect|logs|start|stop|restart|kill)\b/
    .exec(commande)?.[1] ?? '*';
  return table[geste] ?? table['*'] ?? null;
}

function surLeSpark(tunnel, spark, commande, spawnFn, doublonBrut) {
  const doublon = doublonPour(doublonBrut, commande);
  return new Promise((resoudre) => {
    const [programme, ...args] = doublon
      // La vraie commande est passée en `$0` : sans elle, un doublon ne pourrait
      // pas répondre différemment selon le conteneur demandé, et une preuve ne
      // saurait pas distinguer un conteneur présent d'un conteneur disparu.
      ? ['sh', '-c', doublon, commande]
      : ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
         '-o', 'ConnectTimeout=5', ...tunnel.jumpArgs(),
         `root@${spark.ipv4_address}`, commande];
    const enfant = spawnFn(programme, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreurs = '';
    enfant.stdout?.on('data', (bloc) => { sortie += bloc.toString('utf8'); });
    enfant.stderr?.on('data', (bloc) => { erreurs += bloc.toString('utf8'); });
    // `close`, et non `exit`. MESURÉ le 2026-08-20 : sur deux cents lignes de
    // journal, `exit` arrive AVANT que stdout ait fini d'être drainé, et le
    // relevé perdait une trentaine de lignes sans rien dire. `close` n'est émis
    // qu'une fois tous les flux fermés. Une troncature silencieuse est le pire
    // des défauts pour un écran dont le seul rôle est de rapporter.
    enfant.on('close', (code) => resoudre({ code: code ?? 0, sortie, erreurs }));
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

/**
 * L'inspection d'un conteneur (§37.6 ter).
 *
 * @spec docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6 ter
 *
 * Un conteneur DISPARU entre l'inventaire et l'inspection rend `1` — mesuré.
 * Ce n'est pas une panne : c'est une course normale, le locataire ayant le droit
 * de supprimer son conteneur pendant qu'on le regarde. On le dit, on ne lève pas.
 */
export async function inspecterConteneur({ tunnel, spark, nom,
                                           spawn: spawnFn = spawn,
                                           doublon = null } = {}) {
  const identite = await surLeSpark(tunnel, spark, inspecter(nom), spawnFn, doublon);
  const etat = classer(identite.code, 'x', identite.erreurs);
  if (identite.code === 1) {
    return { name: nom, state: CONTENEUR_INCONNU,
             titre: `« ${nom} » a disparu`,
             detail: 'Ce conteneur n’existe plus depuis le dernier relevé. '
               + 'Le locataire a pu le supprimer ou le recréer sous un autre nom.' };
  }
  if (identite.code !== 0) {
    return { name: nom, state: etat, ...ETATS[etat] };
  }

  const vu = analyserInspection(identite.sortie);
  if (!vu) {
    return { name: nom, state: INJOIGNABLE, ...ETATS[INJOIGNABLE] };
  }

  // Les listes sont demandées SÉPARÉMENT, et leur échec ne fait pas échouer
  // l'identité : savoir qu'un conteneur est mort en 137 vaut mieux que rien.
  const [r, m] = await Promise.all([
    surLeSpark(tunnel, spark, reseaux(nom), spawnFn, doublon),
    surLeSpark(tunnel, spark, montages(nom), spawnFn, doublon),
  ]);
  return {
    ...vu,
    networks: r.code === 0 ? analyserReseaux(r.sortie) : null,
    mounts: m.code === 0 ? analyserMontages(m.sortie) : null,
  };
}

/**
 * Les journaux d'un conteneur, bornés (§37.6 ter).
 *
 * `truncated` est rendu EXPLICITEMENT et non déduit de la longueur : déduire
 * marcherait aujourd'hui et mentirait le jour où un conteneur a exactement
 * `tail` lignes.
 */
export async function lireJournaux({ tunnel, spark, nom, tail = TAIL,
                                     spawn: spawnFn = spawn,
                                     doublon = null } = {}) {
  const borne = Number(tail) > 0 ? Math.min(Number(tail), 2000) : TAIL;
  const vu = await surLeSpark(tunnel, spark, journaux(nom, borne), spawnFn, doublon);
  if (vu.code === 1) {
    return { name: nom, state: CONTENEUR_INCONNU, lines: [],
             titre: `« ${nom} » a disparu`,
             detail: 'Ce conteneur n’existe plus depuis le dernier relevé.' };
  }
  if (vu.code !== 0) {
    const etat = classer(vu.code, 'x', vu.erreurs);
    return { name: nom, state: etat, lines: [], ...ETATS[etat] };
  }
  const lignes = analyserJournaux(vu.sortie);
  return { name: nom, state: OK, tail: borne, lines: lignes,
           truncated: lignes.length >= borne };
}
