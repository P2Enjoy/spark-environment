#!/usr/bin/env node
/**
 * Banc SPK-132 : « Recréer » contre un VRAI Docker, avec les commandes que le
 * CODE compose — l'inspection, le geste « Redémarrer », la recréation. Aucune
 * copie à la main : si le code change, c'est le code qui est mesuré.
 *
 * @verifies docs/BACKLOG.md#SPK-132 · docs/DAT.md §37.7.5 (la mesure, la
 *           commande, ce qui est offert, les états), §43.7 (révisé : un
 *           conteneur lit son env_file à sa création)
 *
 * Ce que le banc établit, et qui ne se prouve pas sans Docker :
 *   1. l'inspection que la console lance décrit un conteneur de pile Compose —
 *      projet, service, répertoire, fichier — et ne décrit pas un conteneur
 *      lancé par `docker run` ;
 *   2. le geste « Redémarrer » ne fait PAS relire une variable changée ;
 *   3. la commande de recréation la fait relire, sur un NOUVEAU conteneur ;
 *   4. elle ne touche pas le service voisin (`--no-deps`) ;
 *   5. une image absente fait échouer la recréation (`--pull never`), laisse
 *      l'ancien conteneur en marche, et le message rendu est la dernière ligne
 *      de Compose.
 *
 * Conteneurs `alpine` jetables, dans un projet Compose au nom unique, retirés en
 * sortant. Ni navigateur, ni `sparkd`, ni console : ce n'est pas une épreuve
 * lourde au sens de CLAUDE.md §15 bis, et il ne prend pas le verrou de
 * `e2e/verrou.mjs` — comme le banc de SPK-128.
 *
 *   node scripts/mesures-spk132.mjs        # code 0 si tout est vert, 1 sinon
 *
 * Prérequis : Docker et son greffon Compose, l'image `alpine:latest` en local
 * (le banc ne tire rien). Le contexte rootless de la cellule (§42.2 bis) n'est
 * pas rejoué ici : il emballe la même commande, et ses propres preuves sont
 * dans `apps/webui/host/docker-context.test.js`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyserInspection, inspecter } from '../apps/webui/host/docker.js';
import { GESTES, commandeRecreer, messageEchecCompose }
  from '../apps/webui/host/gestes-docker.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('node scripts/mesures-spk132.mjs — banc SPK-132 (voir l’en-tête du fichier).');
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error('Aucun argument attendu (voir --help).');
  process.exit(2);
}

const sh = (commande) => {
  const r = spawnSync('sh', ['-c', commande], { encoding: 'utf8' });
  return { code: r.status, sortie: r.stdout ?? '', erreurs: r.stderr ?? '' };
};
const doit = (commande) => {
  const r = sh(commande);
  if (r.code !== 0) throw new Error(`« ${commande} » a échoué (${r.code}) : ${r.erreurs}`);
  return r.sortie.trim();
};

const projet = `spk132banc${process.pid}`;
const dossier = mkdtempSync(join(tmpdir(), 'spk132-'));
const fichier = join(dossier, 'compose.yml');
const ecrireCompose = (image) => writeFileSync(fichier, [
  'services:',
  '  app:',
  `    image: ${image}`,
  '    command: ["sleep", "600"]',
  '    env_file: [./env]',
  '  voisin:',
  `    image: ${image}`,
  '    command: ["sleep", "600"]',
  '',
].join('\n'));

let echecs = 0;
const constat = (vrai, texte) => {
  console.log(`${vrai ? '✔' : '✖'} ${texte}`);
  if (!vrai) echecs += 1;
};
const valeur = (nom) => doit(`docker exec ${nom} sh -c 'echo $SMTP_HOTE'`);
const ident = (nom) => doit(`docker inspect -f '{{.Id}}' ${nom}`);

const app = `${projet}-app-1`;
const voisin = `${projet}-voisin-1`;
const nu = `${projet}-nu`;

try {
  ecrireCompose('alpine:latest');
  writeFileSync(join(dossier, 'env'), 'SMTP_HOTE=avant\n');
  doit(`cd '${dossier}' && docker compose -p ${projet} up -d --quiet-pull 2>&1`);

  // 1. L'inspection de la console, telle quelle.
  const decrit = analyserInspection(doit(inspecter(app)))?.compose;
  constat(decrit?.project === projet && decrit?.service === 'app'
    && decrit?.workingDir === dossier && decrit?.configFiles?.[0] === fichier,
  `1. l’inspection décrit la pile : ${JSON.stringify(decrit)}`);
  doit(`docker run -d --name ${nu} alpine:latest sleep 600`);
  constat(analyserInspection(doit(inspecter(nu)))?.compose === null,
    '1. un conteneur lancé par `docker run` ne se décrit pas');

  // 2. Le geste « Redémarrer », tel que la console le lance.
  writeFileSync(join(dossier, 'env'), 'SMTP_HOTE=apres\n');
  const avant = ident(app);
  doit(GESTES.restart.commande(app));
  constat(valeur(app) === 'avant' && ident(app) === avant,
    '2. « Redémarrer » garde l’ANCIENNE valeur, sur le même conteneur');

  // 3 et 4. La recréation composée par le code.
  const voisinAvant = ident(voisin);
  const recree = sh(commandeRecreer(decrit));
  constat(recree.code === 0, `3. la recréation aboutit (code ${recree.code})`);
  constat(valeur(app) === 'apres' && ident(app) !== avant,
    '3. la NOUVELLE valeur est lue, par un nouveau conteneur');
  constat(ident(voisin) === voisinAvant, '4. le service voisin n’est pas touché');

  // 5. Une image absente : refus, et l'ancien conteneur reste.
  ecrireCompose('alpine:nexistepas-spk132');
  const enPlace = ident(app);
  const refuse = sh(commandeRecreer(decrit));
  const message = messageEchecCompose(refuse.erreurs);
  constat(refuse.code !== 0 && /No such image: alpine:nexistepas-spk132/.test(message),
    `5. une image absente fait échouer, message rendu : « ${message} »`);
  constat(ident(app) === enPlace && doit(`docker inspect -f '{{.State.Status}}' ${app}`) === 'running',
    '5. l’ancien conteneur reste en marche, intact');
} catch (erreur) {
  console.error(`✖ le banc s’est interrompu : ${erreur.message}`);
  echecs += 1;
} finally {
  sh(`docker rm -f ${nu} >/dev/null 2>&1`);
  sh(`docker ps -aq --filter label=com.docker.compose.project=${projet} | xargs -r docker rm -f >/dev/null 2>&1`);
  rmSync(dossier, { recursive: true, force: true });
  const restes = sh(`docker ps -aq --filter name=${projet}`).sortie.trim();
  constat(!restes, 'conteneurs du banc retirés');
}

console.log(echecs ? `\n${echecs} constat(s) en échec.` : '\nBanc SPK-132 : vert.');
process.exit(echecs ? 1 : 0);
