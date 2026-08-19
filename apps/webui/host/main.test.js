/**
 * @verifies docs/BACKLOG.md#SPK-16 · docs/DAT.md §6, §22.3
 *
 * Ce que ces tests gardent : une panne de tunnel remonte AVEC son motif, et la
 * console n'est jamais invitee a presenter des donnees anterieures comme
 * actuelles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { createConsoleHost } from './main.js';
import { TunnelManager } from './tunnel.js';

const SERVEUR = { name: 'prod', host: '203.0.113.10', user: 'ubuntu', port: 22, remotePort: 9876 };

function fauxSsh() {
  const e = new EventEmitter();
  e.stderr = new EventEmitter();
  e.kill = () => {};
  return e;
}

async function hote({ sonde = async () => ({}), amont } = {}) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-'));
  const chemin = join(dossier, 'servers.json');
  const tunnels = new TunnelManager({
    spawn: () => fauxSsh(), probe: sonde, probeIntervalMs: 3_600_000,
  });
  const { server } = createConsoleHost({
    tunnels, inventoryPath: chemin, anchorPath: join(dossier, 'anchors.json'),
    fetch: amont ?? (async () => new Response('{"ok":true}', { status: 200 })),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, tunnels, dossier };
}

// --- inventaire -------------------------------------------------------------

test('un serveur s enregistre puis se relit', async () => {
  const { base, server } = await hote();
  const cree = await fetch(`${base}/api/servers`, {
    method: 'POST', body: JSON.stringify(SERVEUR),
  });
  assert.equal(cree.status, 201);
  const { servers } = await (await fetch(`${base}/api/servers`)).json();
  assert.equal(servers[0].name, 'prod');
  server.close();
});

test('un secret dans l inventaire est refuse en 422', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/servers`, {
    method: 'POST', body: JSON.stringify({ ...SERVEUR, password: 'x' }),
  });
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /ressemble à un secret/);
  server.close();
});

// --- ouverture de tunnel ----------------------------------------------------

test('ouvrir un tunnel sain rend 200 et son etat', async () => {
  const { base, server } = await hote();
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  const r = await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, 'ready');
  server.close();
});

test('un tunnel qui ne repond pas rend 502, PAS 200', async () => {
  // Annoncer un succes parce que la commande a ete lancee serait un succes
  // simule (CLAUDE.md §18).
  const { base, server } = await hote({ sonde: async () => { throw new Error('injoignable'); } });
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  const r = await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).state, 'broken');
  server.close();
});

test('un serveur inconnu est refuse en 404', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'fantome' }) });
  assert.equal(r.status, 404);
  server.close();
});

// --- relais (§22.3) ---------------------------------------------------------

test('le relais atteint sparkd a travers le tunnel', async () => {
  let vue = null;
  const { base, server } = await hote({
    amont: async (url) => { vue = url; return new Response('{"status":"ok"}', { status: 200 }); },
  });
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });

  const r = await fetch(`${base}/api/v1/host?server=prod`);
  assert.equal(r.status, 200);
  assert.match(vue, /^http:\/\/127\.0\.0\.1:\d+\/v1\/host$/);
  server.close();
});

test('une requete vers un tunnel rompu remonte le MOTIF, pas un 502 anonyme', async () => {
  const { base, server } = await hote({ sonde: async () => { throw new Error('connexion refusée'); } });
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });

  const r = await fetch(`${base}/api/v1/host?server=prod`);
  assert.equal(r.status, 502);
  const corps = await r.json();
  assert.equal(corps.error, 'tunnel_unavailable');
  assert.match(corps.message, /connexion refusée/);
  assert.equal(corps.tunnel.state, 'broken');
  // La console est explicitement mise en garde contre l'affichage de donnees
  // anterieures comme actuelles (docs/DAT.md §22.3).
  assert.match(corps.stale_data_warning, /antérieures/);
  server.close();
});

test('le relais exige de nommer le serveur vise', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/v1/host`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /Préciser le serveur/);
  server.close();
});

test('les parametres de requete sont transmis, sauf « server »', async () => {
  let vue = null;
  const { base, server } = await hote({
    amont: async (url) => { vue = url; return new Response('{}', { status: 200 }); },
  });
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  await fetch(`${base}/api/v1/audit?server=prod&limit=5&result=denied`);
  assert.match(vue, /limit=5/);
  assert.match(vue, /result=denied/);
  assert.equal(/server=/.test(vue), false);
  server.close();
});

test('fermer le serveur ferme les tunnels', async () => {
  const { base, server, tunnels } = await hote();
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  assert.equal(tunnels.list().length, 1);
  server.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tunnels.list().length, 0);
});


// --- l'ancre, de bout en bout (SPK-38, docs/DAT.md §36.2, §36.9.6) ---------

/** Un `sparkd` factice dont on pilote la chaîne annoncée. */
function sparkdChaine(etat) {
  return async (url) => {
    if (String(url).includes('/v1/audit/verify')) {
      return new Response(JSON.stringify({
        checked: etat.length, head: etat.head, length: etat.length,
        intact: true, verified_at: '2026-08-19T10:00:00', break: null,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      entries: (etat.entries ?? []).map((h) => ({ entry_hash: h })),
    }), { status: 200 });
  };
}

async function ouvrir(base, tunnels, amont) {
  await fetch(`${base}/api/servers`, {
    method: 'POST',
    body: JSON.stringify({ name: 'prod', kind: 'local', port: 9876 }),
  });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  return amont;
}

test('le premier relevé POSE l’ancre, les suivants la comparent', async () => {
  const chaine = { head: 'aaa', length: 3, entries: ['aaa'] };
  const { base, server, tunnels } = await hote({ amont: (u) => sparkdChaine(chaine)(u) });
  await ouvrir(base, tunnels);

  let r = await fetch(`${base}/api/anchor`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  let corps = await r.json();
  assert.equal(corps.verdict, 'first', 'rien de retenu : on pose, on ne juge pas');
  assert.equal(corps.alert, false);

  // Le journal s'allonge et contient toujours la tête connue : il PROLONGE.
  chaine.head = 'ccc'; chaine.length = 6; chaine.entries = ['aaa', 'bbb', 'ccc'];
  r = await fetch(`${base}/api/anchor`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  corps = await r.json();
  assert.equal(corps.verdict, 'extends');
  assert.equal(corps.alert, false);
  server.close();
});

test('une histoire qui NE PROLONGE PAS la précédente est signalée', async () => {
  const chaine = { head: 'aaa', length: 5, entries: ['aaa'] };
  const { base, server, tunnels } = await hote({ amont: (u) => sparkdChaine(chaine)(u) });
  await ouvrir(base, tunnels);
  await fetch(`${base}/api/anchor`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });

  // TRONCATURE : la chaîne restante est valide, seule la console le voit.
  chaine.head = 'aa'; chaine.length = 2; chaine.entries = ['aa'];
  let corps = await (await fetch(`${base}/api/anchor`,
    { method: 'POST', body: JSON.stringify({ name: 'prod' }) })).json();
  assert.equal(corps.verdict, 'shrunk');
  assert.equal(corps.alert, true);
  assert.match(corps.explanation, /RACCOURCI/);
  assert.equal(corps.known.length, 5, 'la référence est CONSERVÉE malgré l’alerte');

  // REMPLACEMENT : un journal neuf et cohérent, sans la tête connue.
  chaine.head = 'zzz'; chaine.length = 9; chaine.entries = ['xxx', 'yyy', 'zzz'];
  corps = await (await fetch(`${base}/api/anchor`,
    { method: 'POST', body: JSON.stringify({ name: 'prod' }) })).json();
  assert.equal(corps.verdict, 'diverged');
  assert.equal(corps.alert, true);
  assert.equal(corps.known.head, 'aaa', 'toujours la référence d’origine');
  server.close();
});

test('sans tunnel ouvert, l’ancre ne prétend rien', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/anchor`, { method: 'POST', body: JSON.stringify({ name: 'absent' }) });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'tunnel_unavailable');
  server.close();
});
