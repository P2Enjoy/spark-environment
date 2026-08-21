/** @verifies docs/DAT.md §42.2 bis · §37.6 bis · §37.7.1 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPTE_ROOTLESS, dansContexteDocker, quoterShell } from './docker-context.js';

test('le contexte ne choisit rootless que si son socket répond', () => {
  const commande = dansContexteDocker("ps -a --format '{{.Names}}'");
  assert.match(commande, new RegExp(`id -u ${COMPTE_ROOTLESS}`));
  assert.match(commande, /\[ -S "\$socket" \]/);
  assert.match(commande, /DOCKER_HOST="unix:\/\/\$socket" docker info/);
  assert.match(commande, /then; exec runuser -u spark-docker/);
  assert.match(commande, /docker ps -a --format/);
  assert.match(commande, /fi; exec docker ps -a --format/);
});

test('un échec de la commande rootless ne la rejoue pas sur Docker root', () => {
  const commande = dansContexteDocker("stop -t 10 'web'");
  const rootless = commande.indexOf('then; exec runuser');
  const racine = commande.indexOf('fi; exec docker');
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
