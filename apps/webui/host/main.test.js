/**
 * @verifies docs/BACKLOG.md#SPK-16 · docs/DAT.md §6, §22.3
 *
 * Ce que ces tests gardent : une panne de tunnel remonte AVEC son motif, et la
 * console n'est jamais invitee a presenter des donnees anterieures comme
 * actuelles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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

// `env` vaut `{}` par DÉFAUT, et ce n'est pas un détail : sans cela, l'hôte
// lirait le `.env` du poste et les tests parleraient au VRAI fournisseur DNS,
// donc à quatorze zones en exploitation (SPK-47, docs/DAT.md §38.1).
async function hote({ sonde = async () => ({}), amont, env = {} } = {}) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-'));
  const chemin = join(dossier, 'servers.json');
  const tunnels = new TunnelManager({
    spawn: () => fauxSsh(), probe: sonde, probeIntervalMs: 3_600_000,
  });
  const { server } = createConsoleHost({
    tunnels, inventoryPath: chemin, anchorPath: join(dossier, 'anchors.json'),
    env,
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

  const r = await fetch(`${base}/api/v1/forge?server=prod`);
  assert.equal(r.status, 200);
  // SPK-42 : le chemin relayé est celui de la FORGE. Le relais retire « /api »
  // et transmet le reste tel quel — ce que cette attente vérifie.
  assert.match(vue, /^http:\/\/127\.0\.0\.1:\d+\/v1\/forge$/);
  server.close();
});

test('une requete vers un tunnel rompu remonte le MOTIF, pas un 502 anonyme', async () => {
  const { base, server } = await hote({ sonde: async () => { throw new Error('connexion refusée'); } });
  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });

  const r = await fetch(`${base}/api/v1/forge?server=prod`);
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
  const r = await fetch(`${base}/api/v1/forge`);
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


// --- le catalogue tenu depuis la console (SPK-41, §22.4 ter) --------------

async function poser(base, serveur) {
  return fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(serveur) });
}

test('le premier serveur ajouté devient le serveur COURANT', async () => {
  // Sans cela, la console aurait un inventaire et aucun contexte.
  const { base, server } = await hote();
  assert.equal((await (await fetch(`${base}/api/servers`)).json()).current, null);
  await poser(base, SERVEUR);
  const corps = await (await fetch(`${base}/api/servers`)).json();
  assert.equal(corps.current, 'prod');
  server.close();
});

test('ajouter un second serveur NE CHANGE PAS celui qu’on regarde', async () => {
  // La console prenait `servers[0]` : l'ordre d'écriture décidait du contexte.
  const { base, server } = await hote();
  await poser(base, SERVEUR);
  await poser(base, { ...SERVEUR, name: 'autre' });
  assert.equal((await (await fetch(`${base}/api/servers`)).json()).current, 'prod');
  server.close();
});

test('changer de serveur courant le RETIENT', async () => {
  const { base, server } = await hote();
  await poser(base, SERVEUR);
  await poser(base, { ...SERVEUR, name: 'autre' });
  const r = await fetch(`${base}/api/servers/current`,
                        { method: 'POST', body: JSON.stringify({ name: 'autre' }) });
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(`${base}/api/servers`)).json()).current, 'autre');
  server.close();
});

test('choisir un serveur inconnu est refusé, sans changer le courant', async () => {
  const { base, server } = await hote();
  await poser(base, SERVEUR);
  const r = await fetch(`${base}/api/servers/current`,
                        { method: 'POST', body: JSON.stringify({ name: 'fantome' }) });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'unknown_server');
  assert.equal((await (await fetch(`${base}/api/servers`)).json()).current, 'prod');
  server.close();
});

test('retirer un serveur FERME son tunnel avant de l’effacer', async () => {
  // Laisser un `ssh` vivant vers une machine qu'on vient de retirer, c'est le
  // genre de processus qu'on ne retrouve plus.
  const { base, server, tunnels } = await hote();
  await poser(base, { name: 'prod', kind: 'local', port: 9876 });
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'prod' }) });
  assert.ok(tunnels.get('prod'), 'le tunnel existe');

  const r = await fetch(`${base}/api/servers`,
                        { method: 'DELETE', body: JSON.stringify({ name: 'prod' }) });
  assert.equal(r.status, 200);
  assert.equal(tunnels.get('prod')?.state ?? 'closed', 'closed');
  assert.deepEqual((await (await fetch(`${base}/api/servers`)).json()).servers, []);
  server.close();
});

test('retirer le serveur COURANT donne la place au suivant', async () => {
  const { base, server } = await hote();
  await poser(base, SERVEUR);
  await poser(base, { ...SERVEUR, name: 'autre' });
  const r = await fetch(`${base}/api/servers`,
                        { method: 'DELETE', body: JSON.stringify({ name: 'prod' }) });
  assert.equal((await r.json()).current, 'autre');
  server.close();
});

test('retirer le DERNIER serveur laisse un courant nul, et le dit', async () => {
  // L'écran doit pouvoir dire « aucun serveur », plutôt qu'afficher une liste de
  // Sparks vide qui ferait croire à un serveur sans Sparks.
  const { base, server } = await hote();
  await poser(base, SERVEUR);
  const r = await fetch(`${base}/api/servers`,
                        { method: 'DELETE', body: JSON.stringify({ name: 'prod' }) });
  assert.equal((await r.json()).current, null);
  server.close();
});

test('retirer un serveur inconnu est refusé', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/servers`,
                        { method: 'DELETE', body: JSON.stringify({ name: 'fantome' }) });
  assert.equal(r.status, 404);
  server.close();
});

test('un SECRET est refusé même envoyé explicitement à l’API', async () => {
  // §22.4 : l'inventaire n'en contient jamais. Refuser plutôt que filtrer, pour
  // que l'auteur sache le retirer d'où il l'a copié.
  const { base, server } = await hote();
  for (const champ of ['password', 'privateKey', 'passphrase', 'token']) {
    const r = await poser(base, { ...SERVEUR, [champ]: 'x' });
    assert.equal(r.status, 422, `${champ} doit être refusé`);
  }
  assert.deepEqual((await (await fetch(`${base}/api/servers`)).json()).servers, []);
  server.close();
});

test('l’épreuve REND ce qu’elle a vu, et referme son tunnel', async () => {
  const { base, server, tunnels } = await hote({
    amont: async (url) => new Response(
      JSON.stringify(String(url).includes('readyz') ? { status: 'ready' } : { ok: true }),
      { status: 200 }),
  });
  const r = await fetch(`${base}/api/servers/probe`,
                        { method: 'POST', body: JSON.stringify({ name: 'prod', kind: 'local', port: 9876 }) });
  assert.equal(r.status, 200);
  const bilan = await r.json();
  assert.equal(bilan.reachable, true);
  assert.equal(bilan.healthz.status, 200);
  assert.equal(bilan.readyz.status, 200);
  // Le tunnel temporaire ne SURVIT PAS : un diagnostic ne doit pas fuir un ssh.
  assert.equal(tunnels.get('probe:prod')?.state ?? 'closed', 'closed');
  assert.equal(tunnels.get('prod') ?? null, null, 'et il n’usurpe pas le vrai nom');
  server.close();
});

test('l’épreuve n’enregistre RIEN', async () => {
  // §22.4.4 : elle informe, elle ne décide pas — et elle n'écrit pas non plus.
  const { base, server } = await hote();
  await fetch(`${base}/api/servers/probe`,
              { method: 'POST', body: JSON.stringify({ name: 'prod', kind: 'local', port: 9876 }) });
  assert.deepEqual((await (await fetch(`${base}/api/servers`)).json()).servers, []);
  server.close();
});

test('un serveur INJOIGNABLE s’enregistre quand même', async () => {
  // §25.1 : la machine peut être éteinte. Exiger qu'elle réponde reviendrait à
  // exiger qu'elle soit allumée pour qu'on note son existence.
  const { base, server } = await hote({
    amont: async () => { throw new Error('connexion refusée'); },
  });
  const bilan = await (await fetch(`${base}/api/servers/probe`,
    { method: 'POST', body: JSON.stringify({ name: 'prod', kind: 'local', port: 9876 }) })).json();
  assert.equal(bilan.reachable, false);
  assert.ok(bilan.error || bilan.healthz, 'l’échec est RENDU, pas masqué');

  assert.equal((await poser(base, SERVEUR)).status, 201);
  server.close();
});

test('une entrée invalide est refusée par l’épreuve, sans tunnel', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/servers/probe`,
                        { method: 'POST', body: JSON.stringify({ name: 'Majuscule' }) });
  assert.equal(r.status, 422);
  server.close();
});

// --- le DNS (SPK-47, docs/DAT.md §38) --------------------------------------

const JETON = { SCW_SECRET_KEY: 'jeton-de-test', SCW_DEFAULT_ORGANIZATION_ID: 'org' };

test('sans jeton, les zones rendent 200 et DISENT que rien n est configure', async () => {
  // Un poste sans fournisseur est le cas NORMAL : rendre une erreur ferait
  // chercher une panne la ou il n'y a qu'une absence de configuration (§38.1).
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/dns/zones`);
  const corps = await r.json();
  assert.equal(r.status, 200);
  assert.equal(corps.configured, false);
  assert.match(corps.reason, /Aucun jeton DNS/);
  assert.deepEqual(corps.zones, []);
  server.close();
});

test('sans jeton, une ECRITURE est refusee en 409 avec la meme raison', async () => {
  const { base, server } = await hote();
  const r = await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'exemple.tech', domain: 'a.exemple.tech', address: '1.2.3.4' }),
  });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'dns_not_configured');
  server.close();
});

test('les zones du compte sont listees, et le jeton ne figure PAS dans la reponse', async () => {
  const { base, server } = await hote({
    env: JETON,
    amont: async () => new Response(JSON.stringify({ dns_zones: [
      { domain: 'exemple.tech', subdomain: '', status: 'active', ns: ['a'] },
    ] }), { status: 200 }),
  });
  const r = await fetch(`${base}/api/dns/zones`);
  const texte = await r.text();
  assert.equal(r.status, 200);
  assert.match(texte, /exemple\.tech/);
  assert.ok(!texte.includes('jeton-de-test'), 'le jeton ne sort jamais vers le navigateur');
  server.close();
});

test('un fournisseur injoignable rend 502 AVEC son motif, pas un succes vide', async () => {
  const { base, server } = await hote({
    env: JETON,
    amont: async () => new Response('permission denied', { status: 403 }),
  });
  const r = await fetch(`${base}/api/dns/zones`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /HTTP 403/);
  server.close();
});

test('une ecriture sur l APEX est refusee AVANT tout appel sortant', async () => {
  // Un refus ne doit couter aucune requete, et surtout ne jamais atteindre une
  // zone reelle pour s'y faire refuser sur place (§38.5).
  let appels = 0;
  const { base, server } = await hote({
    env: JETON,
    amont: async () => { appels += 1; return new Response('{}', { status: 200 }); },
  });
  const r = await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'lelabs.tech', domain: 'lelabs.tech', address: '1.2.3.4' }),
  });
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /apex/);
  assert.equal(appels, 0, 'aucune requete ne doit partir vers le fournisseur');
  server.close();
});

test('un domaine hors zone est refuse en 422', async () => {
  const { base, server } = await hote({ env: JETON });
  const r = await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'lelabs.tech', domain: 'a.autre.tech', address: '1.2.3.4' }),
  });
  assert.equal(r.status, 422);
  server.close();
});

test("l espace de noms des essais borne l ecriture quand le poste le pose", async () => {
  const env = { ...JETON, SPARK_DNS_ALLOW_PATTERN: '^test\\.[a-z0-9-]+\\.lelabs\\.tech$' };
  const { base, server } = await hote({
    env, amont: async () => new Response('{}', { status: 200 }),
  });
  const refuse = await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'lelabs.tech', domain: 'gram.lelabs.tech', address: '1.2.3.4' }),
  });
  assert.equal(refuse.status, 422);
  assert.match((await refuse.json()).message, /espace de noms/);

  const pose = await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'lelabs.tech', domain: 'test.spark.lelabs.tech', address: '1.2.3.4' }),
  });
  assert.equal(pose.status, 200);
  server.close();
});

test("l ecriture annonce ce qui est ECRIT et la propagation, jamais un domaine pret", async () => {
  // §38.4 : poser un enregistrement ne le fait pas resoudre. Annoncer « pret »
  // ferait chercher la panne ailleurs pendant toute la duree du TTL.
  const { base, server } = await hote({
    env: JETON, amont: async () => new Response('{}', { status: 200 }),
  });
  const r = await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'lelabs.tech', domain: 'test.spark.lelabs.tech',
                           address: '203.0.113.7' }),
  });
  const corps = await r.json();
  assert.equal(corps.written, true);
  assert.equal(corps.fqdn, 'test.spark.lelabs.tech');
  assert.equal(corps.type, 'A');
  assert.match(corps.propagation, /^La résolution peut demander jusqu'à 300 secondes/,
    'la bannière nomme déjà l’enregistrement écrit : ce champ ne porte que la réserve');
  assert.ok(!('ready' in corps));
  server.close();
});

test('les enregistrements d une zone se lisent, et la zone est OBLIGATOIRE', async () => {
  const { base, server } = await hote({
    env: JETON,
    amont: async () => new Response(JSON.stringify({ records: [
      { name: 'gram', type: 'A', data: '163.172.156.76', ttl: 3600, id: 'x' },
    ] }), { status: 200 }),
  });
  assert.equal((await fetch(`${base}/api/dns/records`)).status, 400);
  const r = await fetch(`${base}/api/dns/records?zone=lelabs.tech`);
  assert.equal((await r.json()).records[0].name, 'gram');
  server.close();
});

test('le jeton DNS n entre NI dans l inventaire NI dans une requete vers sparkd', async () => {
  // §38.1 et §22.4 : le secret vit dans l'environnement du processus, et nulle
  // part ailleurs. Le voir passer dans l'inventaire ou dans le relais, c'est le
  // voir atteindre le disque du poste ou la Forge.
  const vus = [];
  const { base, server, dossier } = await hote({
    env: { ...JETON, SPARK_DNS_ALLOW_PATTERN: '.*' },
    amont: async (url, options = {}) => {
      vus.push(JSON.stringify({ url, headers: options.headers ?? {}, body: String(options.body ?? '') }));
      return new Response('{}', { status: 200 });
    },
  });

  await fetch(`${base}/api/servers`, { method: 'POST', body: JSON.stringify(SERVEUR) });
  await fetch(`${base}/api/dns/record`, {
    method: 'POST',
    body: JSON.stringify({ zone: 'exemple.tech', domain: 'a.exemple.tech', address: '1.2.3.4' }),
  });

  const inventaire = await readFile(join(dossier, 'servers.json'), 'utf8');
  assert.ok(!inventaire.includes('jeton-de-test'), 'l’inventaire ne porte aucun secret');

  // Le jeton n'apparait QUE dans l'appel au fournisseur, en en-tete.
  const versSparkd = vus.filter((v) => v.includes('127.0.0.1'));
  assert.ok(versSparkd.every((v) => !v.includes('jeton-de-test')),
    'rien de ce qui part vers sparkd ne porte le jeton');
  server.close();
});
