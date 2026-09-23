/**
 * @verifies docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.2 (ce que la route refuse,
 *           et pourquoi), §62.3 (préflight de chargement), §62.4 (l'instance et
 *           `relaunchable` que la page lit)
 *
 * La route est éprouvée sur un VRAI hôte console, par de vraies requêtes HTTP.
 * Seuls le canal vers le lanceur et le préflight sont remplacés : le premier
 * terminerait le processus de test, le second a ses propres preuves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';

/** Un canal de lanceur, présenté, qui note la relance au lieu de sortir. */
function canalPresente() {
  const canal = { relancable: true, relances: 0 };
  canal.relancer = async (fermer) => { canal.relances += 1; await fermer(); canal.ferme?.(); };
  canal.fermeture = new Promise((ok) => { canal.ferme = ok; });
  return canal;
}

function terminauxFactices(sessions = []) {
  const t = { fermees: 0 };
  t.list = () => sessions;
  t.notifierFermeture = () => {};
  t.fermerToutes = () => { t.fermees += 1; };
  return t;
}

async function avecHote(options, agir) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-relance-route-'));
  const { server } = createConsoleHost({
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    consoleBuild: { kind: 'git', head: 'avant' },
    compareConsole: () => ({ verdict: 'perimee', behind: 1 }),
    verifyLoad: async () => ({ ok: true }),
    instance: 'instance-a',
    ...options,
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await agir({ base, server });
  } finally {
    if (server.listening) await new Promise((ok) => server.close(ok));
    await rm(dossier, { recursive: true, force: true });
  }
}

const demander = (base, corps = { sessions: [] }, type = 'application/json') =>
  fetch(`${base}/api/console/relance`, {
    method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(corps),
  });

test('le relevé de build dit si la console est relançable, et quelle instance répond', async () => {
  await avecHote({}, async ({ base }) => {
    const corps = await (await fetch(`${base}/api/console/build`)).json();
    assert.equal(corps.verdict, 'perimee');
    assert.equal(corps.relaunchable, false, 'sans lanceur, pas de relance');
    assert.equal(corps.instance, 'instance-a');
  });
  await avecHote({ relance: canalPresente() }, async ({ base }) => {
    const corps = await (await fetch(`${base}/api/console/build`)).json();
    assert.equal(corps.relaunchable, true);
  });
});

test('deux hôtes ne partagent jamais la même instance', async () => {
  const lire = (base) => fetch(`${base}/api/console/build`).then((r) => r.json());
  const a = await avecHote({ instance: undefined }, ({ base }) => lire(base));
  const b = await avecHote({ instance: undefined }, ({ base }) => lire(base));
  assert.match(a.instance, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.instance, b.instance);
});

test('une requête sans corps JSON est refusée en 415 : une page tierce n’arrête pas la console', async () => {
  const canal = canalPresente();
  await avecHote({ relance: canal }, async ({ base }) => {
    // Le `POST` « simple » qu'une page quelconque peut envoyer sans pré-vol.
    const r = await demander(base, { sessions: [] }, 'text/plain');
    assert.equal(r.status, 415);
    assert.equal((await r.json()).error, 'json_requis');
    assert.equal(canal.relances, 0);
  });
});

test('sans lanceur, la route refuse : personne ne la relancerait', async () => {
  await avecHote({}, async ({ base }) => {
    const r = await demander(base);
    assert.equal(r.status, 409);
    const corps = await r.json();
    assert.equal(corps.error, 'relance_indisponible');
    assert.match(corps.message, /make runProd/);
  });
});

test('une mise à jour de sparkd en cours refuse la relance, et nomme la Forge', async () => {
  const canal = canalPresente();
  await avecHote({ relance: canal, forgeUpdates: { busy: new Set(['validation']) } },
    async ({ base }) => {
      const r = await demander(base);
      assert.equal(r.status, 409);
      const corps = await r.json();
      assert.equal(corps.error, 'mise_a_jour_en_cours');
      assert.match(corps.message, /« validation »/);
      assert.equal(canal.relances, 0);
    });
});

test('une installation de Forge en cours refuse la relance', async () => {
  const canal = canalPresente();
  await avecHote({ relance: canal, forgeInstallations: {
    active: new Map([['neuve', { child: null }]]), closeAll() {} } },
  async ({ base }) => {
    const r = await demander(base);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'installation_en_cours');
  });
});

test('une session que la confirmation n’a pas nommée refuse la relance', async () => {
  const canal = canalPresente();
  const terminals = terminauxFactices([
    { id: 's1', spark: 'helo', state: 'open' },
    { id: 's2', spark: 'site-vitrine', state: 'open' },
    { id: 's3', spark: 'ancien', state: 'closed' },
  ]);
  await avecHote({ relance: canal, terminals }, async ({ base }) => {
    const r = await demander(base, { sessions: ['s1'] });
    assert.equal(r.status, 409);
    const corps = await r.json();
    assert.equal(corps.error, 'sessions_changees');
    assert.match(corps.message, /« site-vitrine »/);
    assert.doesNotMatch(corps.message, /ancien/, 'une session fermée ne compte pas');
    assert.equal(canal.relances, 0);
  });
});

test('un code qui ne se charge pas refuse la relance et laisse la console servir', async () => {
  const canal = canalPresente();
  await avecHote({ relance: canal,
    verifyLoad: async () => ({ ok: false, sortie: 'SyntaxError: Unexpected token' }) },
  async ({ base, server }) => {
    const r = await demander(base);
    assert.equal(r.status, 409);
    const corps = await r.json();
    assert.equal(corps.error, 'code_illisible');
    assert.match(corps.output, /SyntaxError/);
    assert.equal(canal.relances, 0);
    assert.equal(server.listening, true, 'la console courante sert toujours');
    // Le refus ne laisse pas la route bloquée sur « déjà en cours ».
    assert.equal((await (await demander(base)).json()).error, 'code_illisible');
  });
});

test('une seconde demande pendant le préflight est refusée : déjà en cours', async () => {
  const canal = canalPresente();
  let liberer;
  const preflight = new Promise((ok) => { liberer = ok; });
  await avecHote({ relance: canal, verifyLoad: () => preflight }, async ({ base }) => {
    const premiere = demander(base);
    await new Promise((ok) => setTimeout(ok, 50));
    const seconde = await demander(base);
    assert.equal(seconde.status, 409);
    assert.equal((await seconde.json()).error, 'relance_en_cours');
    liberer({ ok: true });
    assert.equal((await premiere).status, 202);
    await canal.fermeture;
  });
});

test('une session née pendant le préflight refuse la relance', async () => {
  const canal = canalPresente();
  const sessions = [];
  await avecHote({ relance: canal, terminals: terminauxFactices(sessions),
    verifyLoad: async () => {
      sessions.push({ id: 'tard', spark: 'helo', state: 'open' });
      return { ok: true };
    } },
  async ({ base }) => {
    const r = await demander(base, { sessions: [] });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'sessions_changees');
    assert.equal(canal.relances, 0);
  });
});

test('accepté : 202 avec l’instance, puis la console rend son port et ferme ses sessions', async () => {
  const canal = canalPresente();
  const terminals = terminauxFactices([{ id: 's1', spark: 'helo', state: 'open' }]);
  await avecHote({ relance: canal, terminals }, async ({ base, server }) => {
    const r = await demander(base, { sessions: ['s1'] });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { instance: 'instance-a' });
    await canal.fermeture;
    assert.equal(canal.relances, 1);
    assert.equal(server.listening, false, 'le port est rendu au successeur');
    // Fermées AVANT l'arrêt, pendant que l'hôte sert — puis de nouveau par le
    // `close` du serveur, qui n'a plus rien à fermer.
    assert.ok(terminals.fermees >= 1, 'aucun shell ne survit à l’hôte (§37.4.2)');
  });
});
