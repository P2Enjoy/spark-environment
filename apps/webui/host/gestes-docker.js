/**
 * Le cycle de vie d'un conteneur : démarrer, arrêter, redémarrer, tuer.
 *
 * @spec docs/BACKLOG.md#SPK-45 · docs/DAT.md §37.7 (la décision et le gel),
 *       §37.7.1 (les quatre commandes et leurs codes, mesurés),
 *       §37.7.2 (demandé, confirmé, constaté), §37.7.3 (où le refus est rendu),
 *       §37.7.4 (la route et les quatre actions d'audit) ·
 *       §37.2 (le chemin normal : SSH) · docs/DESIGN_SYSTEM.md §6.23
 * @spec docs/BACKLOG.md#SPK-132 · docs/DAT.md §37.7.5 (recréer un conteneur de
 *       pile Compose : la commande, ce qui est offert, les états) — pour
 *       `commandeRecreer`, `messageEchecCompose`, `DELAI_RECREER`,
 *       `HORS_COMPOSE` et la branche `recreate` d'`agir`
 *
 * **Le point qui décide de ce module** : le code `1` a DEUX causes, et seule la
 * sortie d'erreur les sépare. C'est l'exact inverse du §37.6 bis, où le code
 * distinguait et la sortie ne disait rien.
 *
 * Les confondre annoncerait une DISPARITION à propos d'un conteneur simplement
 * arrêté, et enverrait l'exploitant chercher une suppression qui n'a jamais eu
 * lieu — pendant que son conteneur, lui, est toujours là.
 *
 * Mesuré le 2026-08-20 sur Docker 29.6.1 (§37.7.1).
 */

import { spawn } from 'node:child_process';

import { classerEchecSsh } from './terminal.js';
import { analyserInspection, doublonPour, inspecter, quoter } from './docker.js';
import { dansContexteDocker } from './docker-context.js';

/** Le délai laissé au conteneur avant d'être tué, en secondes. */
export const DELAI_ARRET = 10;

/**
 * Le délai du `ssh` qui porte la commande.
 *
 * Plus long que `DELAI_ARRET`, sans quoi la console abandonnerait un arrêt qui
 * se déroule NORMALEMENT — un conteneur a le droit de prendre ses dix secondes.
 */
export const DELAI_SSH = DELAI_ARRET + 10;

/**
 * SPK-132 · §37.7.5 : le délai du `ssh` qui porte une RECRÉATION — l'arrêt du
 * §37.7.1, puis la création et le démarrage. Rien n'est téléchargé ni construit
 * (`--pull never --no-build`) : soixante secondes suffisent largement.
 */
export const DELAI_RECREER = 60;

/**
 * La recréation d'UN service, telle que Compose l'a créé (SPK-132, §37.7.5).
 *
 * Tout vient des étiquettes relues au geste : le même projet, lu depuis le même
 * répertoire — donc avec le même `.env` de substitution et les mêmes chemins
 * relatifs —, d'après les mêmes fichiers. Chaque valeur est CITÉE : c'est une
 * donnée du locataire, et elle traverse un `ssh`.
 *
 * `--no-deps` : ce service seul. `--no-build` : la cellule ne construit rien.
 * `--pull never` : rien ne se tire d'un registre, une image absente fait
 * échouer. `--force-recreate` : le geste fait ce qu'il dit, même quand Compose ne
 * voit aucun changement.
 */
export function commandeRecreer(compose) {
  return ['docker compose', `-p ${quoter(compose.project)}`,
    `--project-directory ${quoter(compose.workingDir)}`,
    ...compose.configFiles.map((f) => `-f ${quoter(f)}`),
    ...(compose.envFiles ?? []).map((f) => `--env-file ${quoter(f)}`),
    'up -d --force-recreate --no-deps --no-build --pull never',
    `-t ${DELAI_ARRET}`, quoter(compose.service)].join(' ');
}

export const GESTES = {
  start: {
    libelle: 'Démarrer',
    commande: (nom) => `docker start ${quoter(nom)}`,
    action: 'spark.container_start',
    // §6.23 : la confirmation nomme le conteneur ET l'effet.
    effet: (nom) => `Le conteneur « ${nom} » sera relancé.`,
    destructif: false,
  },
  stop: {
    libelle: 'Arrêter',
    commande: (nom) => `docker stop -t ${DELAI_ARRET} ${quoter(nom)}`,
    action: 'spark.container_stop',
    effet: (nom) => `La production servie par « ${nom} » s’interrompt. `
      + `Le conteneur reçoit d’abord une demande d’arrêt, puis il est tué au bout `
      + `de ${DELAI_ARRET} secondes s’il ne s’est pas arrêté.`,
    destructif: false,
  },
  restart: {
    libelle: 'Redémarrer',
    commande: (nom) => `docker restart -t ${DELAI_ARRET} ${quoter(nom)}`,
    action: 'spark.container_restart',
    effet: (nom) => `« ${nom} » s’arrête puis repart. Le service qu’il rend est `
      + `interrompu le temps du redémarrage.`,
    destructif: false,
  },
  // SPK-132 · §37.7.5 : la commande dépend des étiquettes relues au geste, et
  // `agir` la compose ; `commande` reste nommée pour que la table dise ce que
  // chaque geste lance.
  recreate: {
    libelle: 'Recréer',
    commande: commandeRecreer,
    action: 'spark.container_recreate',
    // Destructif : le conteneur est SUPPRIMÉ avant d'être refait, et ce qu'il
    // avait écrit hors de ses volumes est perdu (SPK-DS-35).
    effet: (nom) => `« ${nom} » est supprimé puis recréé d’après son fichier de `
      + `composition : il relit ses deux fichiers d’environnement. Ce qu’il avait `
      + `écrit hors de ses volumes est perdu.`,
    destructif: true,
  },
  kill: {
    libelle: 'Tuer',
    commande: (nom) => `docker kill ${quoter(nom)}`,
    action: 'spark.container_kill',
    // Le seul destructif : il n'attend rien et ne laisse rien se terminer.
    effet: (nom) => `« ${nom} » est tué IMMÉDIATEMENT, sans demande d’arrêt : `
      + `ce qu’il était en train d’écrire est perdu.`,
    destructif: true,
  },
};

export const ABOUTI = 'abouti';
export const DEJA_ARRETE = 'deja_arrete';
export const CONTENEUR_INCONNU = 'conteneur_inconnu';
export const ECHEC = 'echec';
export const SSHD_MUET = 'sshd_muet';
export const INJOIGNABLE = 'injoignable';
export const HORS_COMPOSE = 'hors_compose';

/** Ce que l'écran écrit, par état. Le geste est nommé, l'effet aussi. */
export const ETATS = {
  [DEJA_ARRETE]: {
    titre: 'Ce conteneur ne tournait pas',
    detail: 'Il n’y avait rien à tuer. L’état voulu est déjà celui-là.',
  },
  [CONTENEUR_INCONNU]: {
    titre: 'Ce conteneur a disparu',
    detail: 'Il n’existe plus sur ce Spark. Le locataire a pu le supprimer '
      + 'depuis le dernier relevé — c’est un état normal, pas une panne.',
  },
  [SSHD_MUET]: {
    titre: 'Aucun serveur SSH ne répond dans ce Spark',
    detail: 'Sans « sshd », la console ne peut rien y faire — voyez l’onglet '
      + 'Terminal.',
  },
  [INJOIGNABLE]: {
    titre: 'La liaison avec ce Spark n’est pas établie',
    detail: 'Le geste n’est pas parti. Rien n’a changé dans ce Spark.',
  },
  // SPK-132 · §37.7.5 : les étiquettes relues au geste ne décrivent pas de
  // service Compose. Rien n'est lancé : on ne recrée pas ce qu'on ne sait pas
  // décrire.
  [HORS_COMPOSE]: {
    titre: 'Ce conteneur n’a pas été créé par Compose',
    detail: 'La console ne sait le recréer que d’après son fichier de '
      + 'composition. Rien n’a été lancé.',
  },
};

/**
 * Ce que rend un code `1`, lu sur la SORTIE D'ERREUR et non sur le code.
 *
 * Mesuré (§37.7.1) : « No such container » quand il a disparu, « is not
 * running » quand `kill` tombe sur un conteneur déjà arrêté. Toute autre sortie
 * n'est PAS qualifiée — conclure sur un doute reviendrait à conclure toujours.
 */
export function classer(code, erreurs = '') {
  if (code === 0) return ABOUTI;
  const texte = String(erreurs ?? '');
  if (code === 255) {
    // `classerEchecSsh` rend un OBJET, comme au §37.6 : `repond === false`
    // signifie que rien n'écoute. Tout le reste n'est PAS qualifié.
    return classerEchecSsh(code, texte).repond === false ? SSHD_MUET : INJOIGNABLE;
  }
  if (/No such container|No such object/i.test(texte)) return CONTENEUR_INCONNU;
  if (/is not running/i.test(texte)) return DEJA_ARRETE;
  return ECHEC;
}

/**
 * Le message d'un échec NON QUALIFIÉ : ce que Docker a dit, sans traduction.
 *
 * Inventer un diagnostic ferait chercher une cause qu'on n'a pas constatée.
 */
export function messageEchec(erreurs) {
  const ligne = String(erreurs ?? '').split('\n').find((l) => l.trim());
  return ligne
    ? ligne.replace(/^Error response from daemon:\s*/i, '').trim()
    : 'Docker n’a rien dit de plus.';
}

/**
 * Le message d'un échec de COMPOSE : sa DERNIÈRE ligne, et non la première.
 *
 * MESURÉ (Compose v5.5.1) : Compose écrit sa progression sur la sortie
 * d'erreur — « Container … Recreate » — et l'erreur vient après elle. La
 * première ligne dirait ce qu'il faisait, pas pourquoi il a échoué.
 */
export function messageEchecCompose(erreurs) {
  const lignes = String(erreurs ?? '').split('\n').filter((l) => l.trim());
  return messageEchec(lignes[lignes.length - 1] ?? '');
}

function surLeSpark(tunnel, spark, commande, spawnFn, doublonBrut,
                    delai = DELAI_SSH) {
  const doublon = doublonPour(doublonBrut, commande);
  return new Promise((resoudre) => {
    const [programme, ...args] = doublon
      ? ['sh', '-c', doublon, commande]
      : ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
         '-o', 'ConnectTimeout=5', ...tunnel.jumpArgs(),
         `root@${spark.ipv4_address}`, dansContexteDocker(commande)];
    const enfant = spawnFn(programme, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreurs = '';
    const minuterie = setTimeout(() => enfant.kill?.('SIGKILL'), delai * 1000);
    enfant.stdout?.on('data', (bloc) => { sortie += bloc.toString('utf8'); });
    enfant.stderr?.on('data', (bloc) => { erreurs += bloc.toString('utf8'); });
    // `close` et non `exit` : `exit` précède le drainage de stdout (§37.6 ter,
    // mesuré — le relevé perdait des lignes en silence).
    enfant.on('close', (code) => {
      clearTimeout(minuterie);
      resoudre({ code: code ?? 0, sortie, erreurs });
    });
    enfant.on('error', () => {
      clearTimeout(minuterie);
      resoudre({ code: 255, sortie: '', erreurs: '' });
    });
  });
}

/**
 * Porte un geste sur un conteneur.
 *
 * Le refus du GEL est rendu ici, AVANT d'ouvrir la moindre connexion (§37.7.3) :
 * Docker n'a aucune raison de refuser, la protection n'existe pas chez le
 * locataire. C'est l'écart assumé au §37.7 — un garde-fou, pas un contrôle
 * d'accès.
 */
export async function agir({ tunnel, spark, nom, geste,
                             spawn: spawnFn = spawn, doublon = null } = {}) {
  const modele = GESTES[geste];
  if (!modele) {
    return { state: ECHEC, refus: 'geste_inconnu',
             titre: 'Geste inconnu', detail: `« ${geste} » n’existe pas.` };
  }
  if (spark?.protected) {
    return {
      state: ECHEC, refus: 'protege', geste, name: nom,
      titre: 'Ce Spark est protégé',
      // Le refus nomme la LEVÉE, pas seulement l'interdiction : un refus qui ne
      // dit pas comment avancer se contourne au jugé.
      detail: 'Levez la protection sur l’onglet Infos pour agir sur ses '
        + 'conteneurs. La lecture, elle, reste entière.',
    };
  }
  if (spark?.state !== 'running' || !spark?.incus_name) {
    return { state: INJOIGNABLE, geste, name: nom,
             titre: 'Ce Spark est arrêté',
             detail: 'Rien ne peut être fait dans une cellule à l’arrêt.' };
  }

  if (geste === 'recreate') {
    return recreer({ tunnel, spark, nom, modele, spawnFn, doublon });
  }

  const vu = await surLeSpark(tunnel, spark, modele.commande(nom), spawnFn, doublon);
  const etat = classer(vu.code, vu.erreurs);
  const base = { state: etat, geste, name: nom, action: modele.action };
  if (etat === ABOUTI) {
    return { ...base, titre: `${modele.libelle} : c’est fait`,
             detail: `Le geste a abouti sur « ${nom} ».` };
  }
  if (etat === ECHEC) {
    return { ...base, titre: `${modele.libelle} : Docker a refusé`,
             detail: messageEchec(vu.erreurs) };
  }
  return { ...base, ...ETATS[etat] };
}

/**
 * La recréation (SPK-132, §37.7.5) : les étiquettes RELUES, puis Compose.
 *
 * Relues au moment du geste, et non reprises de l'écran : ce qui est lancé doit
 * décrire le conteneur tel qu'il est, pas tel qu'il était à l'ouverture de
 * l'onglet. Une inspection qui échoue se classe comme les autres gestes — un
 * conteneur disparu entre-temps est « disparu », pas un échec de Compose.
 */
async function recreer({ tunnel, spark, nom, modele, spawnFn, doublon }) {
  const base = { geste: 'recreate', name: nom, action: modele.action };
  const lu = await surLeSpark(tunnel, spark, inspecter(nom), spawnFn, doublon);
  if (lu.code !== 0) {
    const etat = classer(lu.code, lu.erreurs);
    if (etat === ECHEC) {
      return { ...base, state: ECHEC, titre: 'Recréer : Docker a refusé',
               detail: messageEchec(lu.erreurs) };
    }
    return { ...base, state: etat, ...ETATS[etat] };
  }
  const compose = analyserInspection(lu.sortie)?.compose;
  if (!compose) return { ...base, state: HORS_COMPOSE, ...ETATS[HORS_COMPOSE] };

  const vu = await surLeSpark(tunnel, spark, commandeRecreer(compose), spawnFn,
                              doublon, DELAI_RECREER);
  const etat = classer(vu.code, vu.erreurs);
  if (etat === ABOUTI) {
    return { ...base, state: ABOUTI, titre: 'Recréer : c’est fait',
             detail: `« ${nom} » a été recréé d’après `
               + `${compose.configFiles.join(', ')} : il a relu ses deux fichiers `
               + 'd’environnement.' };
  }
  if (etat === ECHEC || etat === CONTENEUR_INCONNU || etat === DEJA_ARRETE) {
    // Un refus de COMPOSE — fichier déplacé, image absente, greffon manquant —
    // se rend tel quel, par sa dernière ligne. Le classement par la sortie
    // d'erreur, pensé pour `docker start`, ne s'applique pas à lui.
    return { ...base, state: ECHEC, titre: 'Recréer : Compose a refusé',
             detail: messageEchecCompose(vu.erreurs) };
  }
  return { ...base, state: etat, ...ETATS[etat] };
}
