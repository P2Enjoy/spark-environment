/**
 * @verifies docs/BACKLOG.md#SPK-100 · docs/DAT.md §53.1 (les quatre cases d'un
 *           réglage), §53.3 (l'interrupteur, le refus écrit, le bandeau) ·
 *           §37.4.2 bis révisé · CLAUDE.md §15
 *
 * Le point de ces preuves est l'INERTIE : une variable de doublon posée sans
 * interrupteur ne doit rien remplacer. C'est exactement ce qui manquait — un
 * `SPARK_DOCKER_COMMAND` exporté dans un shell remplaçait la commande `docker`
 * que la console exécute en exploitation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lireEpreuve, DOUBLONS, INTERRUPTEUR } from './epreuve.js';

const muet = () => {};

test('sans interrupteur, AUCUN doublon n’est lu', () => {
  const env = Object.fromEntries(DOUBLONS.map((d) => [d.variable, 'commande-piegee']));
  const epreuve = lireEpreuve(env, { journal: muet });

  assert.equal(epreuve.actif, false);
  assert.deepEqual(epreuve.doublons, []);
  for (const { variable } of DOUBLONS) {
    assert.equal(epreuve.commande(variable), null,
      `${variable} ne doit rien remplacer hors interrupteur`);
  }
});

test('le refus est ÉCRIT, et nomme les variables vues', () => {
  // Ignorer en silence remplacerait une option cachée par un comportement
  // caché : on chercherait une heure pourquoi un doublon « ne marche pas ».
  const dits = [];
  lireEpreuve({ SPARK_DOCKER_COMMAND: 'x', SPARK_SIGN_COMMAND: 'y' },
              { journal: (m) => dits.push(m) });

  assert.equal(dits.length, 1);
  assert.match(dits[0], /SPARK_DOCKER_COMMAND/);
  assert.match(dits[0], /SPARK_SIGN_COMMAND/);
  assert.match(dits[0], new RegExp(INTERRUPTEUR));
  // La conséquence est dite, pas seulement le refus.
  assert.match(dits[0], /commandes réelles/);
});

test('rien n’est écrit quand aucune variable n’est posée', () => {
  const dits = [];
  lireEpreuve({}, { journal: (m) => dits.push(m) });
  assert.deepEqual(dits, [], 'un environnement propre ne mérite aucun message');
});

test('avec l’interrupteur, les doublons posés sont lus — et EUX SEULS', () => {
  const epreuve = lireEpreuve({
    [INTERRUPTEUR]: '1',
    SPARK_DOCKER_COMMAND: 'printf docker',
    SPARK_TERMINAL_COMMAND: '',
  }, { journal: muet });

  assert.equal(epreuve.actif, true);
  assert.equal(epreuve.commande('SPARK_DOCKER_COMMAND'), 'printf docker');
  // Posée VIDE, elle ne devient pas une commande à lancer (§14.6 : « rien »
  // n'est pas « une commande vide »).
  assert.equal(epreuve.commande('SPARK_TERMINAL_COMMAND'), null);
  assert.equal(epreuve.commande('SPARK_REBOOT_COMMAND'), null);

  assert.deepEqual(epreuve.doublons.map((d) => d.variable), ['SPARK_DOCKER_COMMAND']);
  // Le bandeau doit pouvoir NOMMER ce qui est remplacé, pas seulement compter.
  assert.match(epreuve.doublons[0].remplace, /docker/);
});

test('seule la valeur « 1 » arme l’interrupteur', () => {
  // Un interrupteur qui accepterait « true », « oui » ou « 0 » selon l'humeur
  // de qui le pose serait un second levier caché, à l'intérieur du premier.
  for (const valeur of ['0', 'true', 'oui', 'yes', '', ' 1', '1 ', 'EPREUVE']) {
    const epreuve = lireEpreuve({ [INTERRUPTEUR]: valeur, SPARK_DOCKER_COMMAND: 'x' },
                                { journal: muet });
    assert.equal(epreuve.actif, false, `« ${valeur} » ne doit pas armer`);
    assert.equal(epreuve.commande('SPARK_DOCKER_COMMAND'), null);
  }
});

test('les cinq doublons du produit sont couverts, et nommés pour l’écran', () => {
  // Un doublon ajouté sans entrer dans cette table serait à nouveau invisible :
  // la table EST le contrat du §53.3. Elle a d'ailleurs fait son travail le
  // 2026-09-14 — le cinquième a été refusé ici avant d'exister ailleurs.
  assert.deepEqual(DOUBLONS.map((d) => d.variable).sort(), [
    'SPARK_CONSOLE_IDENTITY', 'SPARK_DOCKER_COMMAND', 'SPARK_REBOOT_COMMAND',
    'SPARK_SIGN_COMMAND', 'SPARK_TERMINAL_COMMAND',
  ]);
  for (const { remplace } of DOUBLONS) {
    assert.ok(remplace.length > 10, 'chaque doublon dit ce qu’il remplace');
  }
});

test('AUCUN module de production ne relit un doublon depuis l’environnement', async () => {
  // Le garde-fou qui manquait. `forge-reboot.js` relisait
  // `process.env.SPARK_REBOOT_COMMAND` dans un DÉFAUT DE PARAMÈTRE : l'appelant
  // croyait fermer la porte, et elle restait ouverte — trouvé en relisant le
  // dépôt après la correction, pas par une preuve. Une seconde lecture ailleurs
  // referait exactement ce défaut, donc on l'interdit ici plutôt que de compter
  // sur la relecture.
  const { readdir, readFile } = await import('node:fs/promises');
  const racine = new URL('./', import.meta.url);
  const fichiers = (await readdir(racine))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'epreuve.js');

  const fautifs = [];
  for (const fichier of fichiers) {
    const source = await readFile(new URL(fichier, racine), 'utf8');
    for (const { variable } of DOUBLONS) {
      // `process.env.X` sous toutes ses formes d'accès.
      if (new RegExp(`process\\.env(\\.${variable}\\b|\\[['"\`]${variable}['"\`]\\])`)
            .test(source)) {
        fautifs.push(`${fichier} → ${variable}`);
      }
    }
  }
  assert.deepEqual(fautifs, [],
    'seul epreuve.js lit ces variables ; ailleurs, le doublon se reçoit en argument');
});
