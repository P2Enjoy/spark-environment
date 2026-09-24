/**
 * @verifies docs/BACKLOG.md#SPK-118 · docs/DAT.md §63.1 (les deux voies,
 *           rejouées), §63.2 (la garde précède TOUTE route : hôte, relais,
 *           flux, fichiers)
 *
 * Les deux attaques mesurées le 2026-09-24 sont rejouées sur un VRAI hôte
 * console, relié à un faux `sparkd` qui note ce qu'il reçoit : la preuve n'est
 * pas qu'un code d'erreur sort, mais que RIEN n'atteint la Forge ni
 * l'inventaire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';

/** Une requête HTTP brute : `fetch` ne laisse pas choisir l'en-tête `Host`. */
function envoyer(port, { method = 'GET', path, headers = {}, corps }) {
  return new Promise((ok, ko) => {
    const q = request({ host: '127.0.0.1', port, method, path,
      headers: { host: `127.0.0.1:${port}`, ...headers } }, (r) => {
      let texte = '';
      r.on('data', (c) => { texte += c; });
      r.on('end', () => ok({ status: r.statusCode, texte,
        json: () => JSON.parse(texte) }));
    });
    q.on('error', ko);
    if (corps !== undefined) q.write(corps);
    q.end();
  });
}

async function avecPile(agir) {
  const recu = [];
  const sparkd = createServer((q, r) => {
    recu.push(`${q.method} ${q.url}`);
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end('{"status":"ok","sparks":[]}');
  });
  await new Promise((ok) => sparkd.listen(0, '127.0.0.1', ok));
  const dossier = await mkdtemp(join(tmpdir(), 'spark-garde-'));
  const inventaire = join(dossier, 'servers.json');
  await writeFile(inventaire, JSON.stringify([
    { name: 'prod', kind: 'local', host: '127.0.0.1', port: sparkd.address().port }]));
  const { server } = createConsoleHost({ inventoryPath: inventaire,
    anchorPath: join(dossier, 'a.json'), env: {} });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const page = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  try {
    // Le tunnel s'ouvre comme la page l'ouvre : c'est l'état d'une console en usage.
    const t = await envoyer(port, { method: 'POST', path: '/api/tunnels',
      headers: page, corps: '{"name":"prod"}' });
    assert.equal(t.status, 200, t.texte);
    recu.length = 0;
    return await agir({ port, page, recu, inventaire });
  } finally {
    server.close();
    sparkd.close();
    await rm(dossier, { recursive: true, force: true });
  }
}

test('un site tiers ne fait pas relayer la suppression d’un Spark, avec ou sans type', async () => {
  await avecPile(async ({ port, recu }) => {
    const chemin = '/api/v1/sparks/boutique/delete?server=prod';
    // `fetch(…, { mode: 'no-cors', method: 'POST' })` : ni corps, ni type.
    const nu = await envoyer(port, { method: 'POST', path: chemin,
      headers: { origin: 'https://site-piege.example' } });
    assert.equal(nu.status, 403);
    assert.equal(nu.json().error, 'origine_refusee');
    // Un navigateur qui omettrait l'origine : le type manque encore.
    const sansOrigine = await envoyer(port, { method: 'POST', path: chemin });
    assert.equal(sansOrigine.status, 415);
    assert.deepEqual(recu, [], 'rien n’a atteint sparkd');
  });
});

test('un formulaire d’un site tiers n’écrit pas dans l’inventaire', async () => {
  await avecPile(async ({ port, inventaire }) => {
    const avant = await readFile(inventaire, 'utf8');
    const r = await envoyer(port, { method: 'POST', path: '/api/servers',
      headers: { origin: 'https://site-piege.example', 'content-type': 'text/plain' },
      corps: JSON.stringify({ name: 'intrus', kind: 'ssh', host: 'attaquant.example' }) });
    assert.equal(r.status, 403);
    assert.equal(await readFile(inventaire, 'utf8'), avant);
  });
});

test('DNS rebinding : aucune lecture, aucun fichier, aucun flux, aucun relais', async () => {
  await avecPile(async ({ port, recu }) => {
    const piege = { host: `site-piege.example:${port}` };
    for (const path of ['/api/servers', '/', '/index.html', '/src/app.js',
                        '/api/terminal/sessions', '/api/terminal/flux?id=x',
                        '/api/v1/sparks?server=prod']) {
      const r = await envoyer(port, { path, headers: piege });
      assert.equal(r.status, 403, `${path} devait être refusé`);
      assert.equal(r.json().error, 'hote_refuse');
      assert.doesNotMatch(r.texte, /prod|127\.0\.0\.1:\d+"/, `${path} a laissé fuir une donnée`);
    }
    // Sous rebinding, la page est « de même origine » et envoie du JSON :
    // seul l'hôte l'arrête.
    const geste = await envoyer(port, { method: 'POST',
      path: '/api/v1/sparks/boutique/delete?server=prod',
      headers: { ...piege, origin: `http://site-piege.example:${port}`,
                 'content-type': 'application/json' } });
    assert.equal(geste.status, 403);
    assert.deepEqual(recu, []);
  });
});

test('la page de la console, elle, lit, écrit et fait relayer', async () => {
  await avecPile(async ({ port, page, recu }) => {
    assert.equal((await envoyer(port, { path: '/api/servers' })).status, 200);
    assert.equal((await envoyer(port, { path: '/' })).status, 200);
    const geste = await envoyer(port, { method: 'POST',
      path: '/api/v1/sparks/boutique/stop?server=prod', headers: page });
    assert.equal(geste.status, 200, geste.texte);
    assert.deepEqual(recu, ['POST /v1/sparks/boutique/stop']);
    // `localhost` est la console aussi.
    const l = await envoyer(port, { path: '/api/servers',
      headers: { host: `localhost:${port}` } });
    assert.equal(l.status, 200);
  });
});
