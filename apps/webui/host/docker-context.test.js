/** @verifies docs/DAT.md §42.2 bis · §37.6 bis · §37.7.1 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { COMPTE_ROOTLESS, dansContexteDocker, quoterShell } from './docker-context.js';

test('le contexte ne choisit rootless que si son socket répond', () => {
  const commande = dansContexteDocker("ps -a --format '{{.Names}}'");
  assert.match(commande, new RegExp(`id -u ${COMPTE_ROOTLESS}`));
  assert.match(commande, /\[ -S "\$socket" \]/);
  assert.match(commande, /DOCKER_HOST="unix:\/\/\$socket" docker info/);
  assert.match(commande, /then\n  exec runuser -u spark-docker/);
  assert.match(commande, /docker ps -a --format/);
  assert.match(commande, /fi\nexec docker ps -a --format/);
});

test('le contexte complet est une commande réellement comprise par sh', async () => {
  // Vérifier des fragments avait laissé passer `then;`, que le shell refuse
  // avant même d'atteindre `docker info`. Le parseur réel garde la frontière.
  const commande = dansContexteDocker("ps -a --format '{{.Names}}'");
  const analyse = await new Promise((resolve) => {
    const enfant = spawn('sh', ['-n', '-c', commande], { stdio: ['ignore', 'ignore', 'pipe'] });
    let erreurs = '';
    enfant.stderr.on('data', (bloc) => { erreurs += bloc.toString('utf8'); });
    enfant.on('close', (status) => resolve({ status, erreurs }));
  });
  assert.equal(analyse.status, 0, analyse.erreurs);
});

test('un échec de la commande rootless ne la rejoue pas sur Docker root', () => {
  const commande = dansContexteDocker("stop -t 10 'web'");
  const rootless = commande.indexOf('then\n  exec runuser');
  const racine = commande.indexOf('fi\nexec docker');
  assert.ok(rootless > 0 && racine > rootless);
  assert.equal(commande.slice(rootless, racine).includes('exec docker stop'), false);
});

test('une commande déjà préfixée ne double jamais le client Docker', () => {
  const commande = dansContexteDocker('docker logs --tail 5 web');
  assert.match(commande, /docker logs --tail 5 web/);
  assert.ok(!commande.includes('docker docker logs'));
});

test('un argument du shell distant reste un unique littéral', () => {
  assert.equal(quoterShell("x'; rm -rf /"), "'x'\\''; rm -rf /'");
});
