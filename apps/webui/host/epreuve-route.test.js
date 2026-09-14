/**
 * @verifies docs/BACKLOG.md#SPK-100 · docs/DAT.md §53.3 (l'interrupteur se voit
 *           à l'écran) · CLAUDE.md §15
 *
 * La coquille ne peut annoncer un doublon que si l'hôte le lui DIT. Cette route
 * est le seul chemin entre l'environnement du processus et l'écran ; sans elle,
 * l'interrupteur resterait lisible du seul côté où personne ne regarde.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';
import { lireEpreuve } from './epreuve.js';

async function avecHote(epreuve, verifier) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-epreuve-route-'));
  const { server } = createConsoleHost({
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    epreuve,
  });
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api/console/epreuve`);
    assert.equal(r.status, 200);
    await verifier(await r.json());
  } finally {
    await new Promise((ok) => server.close(ok));
    await rm(dossier, { recursive: true, force: true });
  }
}

test('une console ordinaire annonce qu’aucun doublon n’est actif', async () => {
  await avecHote(lireEpreuve({ SPARK_DOCKER_COMMAND: 'piege' }, { journal: () => {} }),
    (corps) => {
      assert.equal(corps.active, false);
      // La variable était POSÉE : la route doit quand même rendre une liste
      // vide, sinon l'écran annoncerait un doublon que l'hôte n'emploie pas.
      assert.deepEqual(corps.doublons, []);
    });
});

test('sous interrupteur, la route NOMME les commandes remplacées', async () => {
  await avecHote(lireEpreuve({
    SPARK_EPREUVE: '1',
    SPARK_DOCKER_COMMAND: 'printf docker',
    SPARK_REBOOT_COMMAND: 'printf reboot',
  }, { journal: () => {} }), (corps) => {
    assert.equal(corps.active, true);
    assert.deepEqual(corps.doublons.map((d) => d.variable).sort(),
                     ['SPARK_DOCKER_COMMAND', 'SPARK_REBOOT_COMMAND']);
    // Ce que l'écran affiche : la commande réelle, pas le module qui la lance.
    assert.ok(corps.doublons.every((d) => typeof d.remplace === 'string'));
    // Aucune VALEUR de doublon ne sort : ce sont des commandes shell, et la
    // route est lisible par la page. On nomme la variable, jamais son contenu.
    assert.ok(!JSON.stringify(corps).includes('printf'),
      'la valeur d’un doublon ne doit pas traverser la route');
  });
});
