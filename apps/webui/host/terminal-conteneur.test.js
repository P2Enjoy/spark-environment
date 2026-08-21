/**
 * @verifies docs/BACKLOG.md#SPK-45 · docs/DAT.md §37.4.7 (le terminal DANS un
 *           conteneur), §37.4.5 (ce que le journal reçoit), §37.4.6 (la porte
 *           étroite), §37.7 (le gel laisse le terminal) ·
 *           docs/DESIGN_SYSTEM.md §14.5
 *
 * Ce que ces preuves gardent : **on sonde avant d'ouvrir**, et **le terminal
 * d'un conteneur porte son action propre au journal**. Sans la première, un
 * terminal s'ouvrirait sur une fenêtre noire ; sans la seconde, on ne pourrait
 * pas dire combien de fois quelqu'un est entré dans un conteneur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';
import { SessionManager } from './terminal.js';

function fauxSsh() {
  const e = new EventEmitter();
  e.stdout = new EventEmitter();
  e.stderr = new EventEmitter();
  e.stdin = { ecrit: [], write(d) { this.ecrit.push(String(d)); } };
  e.tue = [];
  e.kill = (s) => e.tue.push(s);
  return e;
}

async function pile({ spark = { name: 'crm', ipv4_address: '10.77.0.16',
                                incus_name: 'crm', state: 'running',
                                protected: false },
                      sonde = { state: 'shell_trouve', shell: '/bin/bash' } } = {}) {
  const enfants = [];
  const declarees = [];
  const sondes = [];
  const dossier = await mkdtemp(join(tmpdir(), 'spark-tc-'));
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod',
                 jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'],
                 forgeArgs: () => ['-p', '22', 'ubuntu@203.0.113.10'] };
  const { server } = createConsoleHost({
    tunnels: { require: () => faux, get: () => faux, list: () => [faux],
               close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    probeShell: async (args) => { sondes.push(args); return sonde; },
    terminals: new SessionManager({
      spawn: (commande, args) => {
        const enfant = fauxSsh();
        enfant.commande = commande; enfant.args = args;
        enfants.push(enfant); return enfant;
      },
    }),
    fetch: async (url, options = {}) => {
      if (String(url).includes('/v1/audit')) {
        declarees.push(JSON.parse(options.body));
        return new Response('{"recorded":"ok"}', { status: 201 });
      }
      if (String(url).includes('/v1/sparks/')) {
        return new Response(JSON.stringify(spark), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const fermer = () => { server.closeAllConnections?.(); server.close(); };
  return { base: `http://127.0.0.1:${server.address().port}`,
           fermer, enfants, declarees, sondes };
}

const ouvrir = (base, corps) => fetch(`${base}/api/terminal`, {
  method: 'POST',
  body: JSON.stringify({ server: 'prod', spark: 'crm', ...corps }) });

// --- On SONDE avant d'ouvrir (§37.4.7) --------------------------------------

test('ouvrir dans un conteneur SONDE d’abord, puis lance le shell trouvé', async () => {
  const { base, fermer, enfants, sondes } = await pile();
  const r = await ouvrir(base, { container: 'crm-web-1' });
  assert.equal(r.status, 201);
  const session = await r.json();

  assert.equal(sondes.length, 1, 'le sondage a bien eu lieu');
  assert.equal(sondes[0].nom, 'crm-web-1');
  assert.equal(session.path, 'container');
  assert.equal(session.container, 'crm-web-1');
  assert.equal(session.shell, '/bin/bash');

  // Le transport reste celui du §37.2, avec un cran de plus.
  assert.equal(enfants[0].commande, 'ssh');
  assert.deepEqual(enfants[0].args.slice(-5),
    ['docker', 'exec', '-it', 'crm-web-1', '/bin/bash']);
  fermer();
});

test('un conteneur SANS SHELL refuse en 409, et AUCUNE session n’est ouverte', async () => {
  // Ouvrir puis mourir laisserait une fenêtre noire dont il faut deviner
  // pourquoi elle est vide. On refuse AVANT, en disant pourquoi.
  const { base, fermer, enfants, declarees } = await pile({
    sonde: { state: 'sans_shell', shell: null,
             titre: 'Ce conteneur n’a pas de shell',
             detail: 'Son image n’en embarque aucun.' } });
  const r = await ouvrir(base, { container: 'distroless-1' });
  assert.equal(r.status, 409);
  const corps = await r.json();
  assert.equal(corps.reason, 'sans_shell');
  assert.match(corps.titre, /pas de shell/);
  assert.equal(enfants.length, 0, 'aucun ssh n’est parti');
  assert.equal(declarees.length, 0, 'et rien n’est inscrit au journal');
  fermer();
});

test('les trois autres refus du sondage sont rendus tels quels', async () => {
  for (const [etat, mot] of [['conteneur_arrete', /arrêté/],
                             ['conteneur_inconnu', /disparu/],
                             ['sshd_muet', /SSH/]]) {
    const { base, fermer, enfants } = await pile({
      sonde: { state: etat, shell: null, titre: `t ${mot.source}`, detail: 'd' } });
    const r = await ouvrir(base, { container: 'x' });
    assert.equal(r.status, 409, etat);
    assert.equal((await r.json()).reason, etat);
    assert.equal(enfants.length, 0, etat);
    fermer();
  }
});

// --- Le journal (§37.4.5, §37.4.7) ------------------------------------------

test('l’ouverture porte une action DISTINCTE de celle du Spark', async () => {
  const { base, fermer, declarees } = await pile();
  await ouvrir(base, { container: 'crm-web-1' });
  const ouverture = declarees.find((d) => d.action === 'spark.container_terminal_open');
  assert.ok(ouverture, 'l’action du conteneur, pas celle du Spark');
  assert.ok(!declarees.some((d) => d.action === 'spark.terminal_open'));
  assert.equal(ouverture.payload.container, 'crm-web-1');
  assert.equal(ouverture.target_id, 'crm');
  fermer();
});

test('le terminal de conteneur cible aussi l’identifiant immuable du Spark', async () => {
  const { base, fermer, declarees } = await pile({
    spark: { name: 'crm', id: 'spark-immutable-42', ipv4_address: '10.77.0.16',
             incus_name: 'crm', state: 'running', protected: false },
  });
  const session = await (await ouvrir(base, { container: 'crm-web-1' })).json();
  await fetch(`${base}/api/terminal?id=${session.id}`, { method: 'DELETE' });

  const terminal = declarees.filter((d) => d.action.includes('container_terminal'));
  assert.deepEqual(terminal.map((d) => d.target_id),
    ['spark-immutable-42', 'spark-immutable-42']);
  fermer();
});

test('la FERMETURE porte l’action du conteneur, sa durée et son motif', async () => {
  const { base, fermer, declarees } = await pile();
  const session = await (await ouvrir(base, { container: 'crm-web-1' })).json();
  const r = await fetch(`${base}/api/terminal?id=${session.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);

  const fermeture = declarees.find((d) => d.action === 'spark.container_terminal_close');
  assert.ok(fermeture, 'la fermeture d’un conteneur a son action');
  assert.equal(fermeture.payload.container, 'crm-web-1');
  assert.equal(typeof fermeture.payload.duration_seconds, 'number');
  assert.equal(fermeture.payload.reason, 'sortie');
  assert.ok(!declarees.some((d) => d.action === 'spark.terminal_close'));
  fermer();
});

test('la fermeture d’une session de SPARK dit le chemin RÉELLEMENT emprunté', async () => {
  // La copie figeait `path: "ssh"` dans les deux routes de fermeture. C'était
  // déjà faux pour le dépannage, et l'aurait été pour un conteneur.
  const { base, fermer, declarees } = await pile();
  const session = await (await ouvrir(base, {})).json();
  await fetch(`${base}/api/terminal?id=${session.id}`, { method: 'DELETE' });
  const fermeture = declarees.find((d) => d.action === 'spark.terminal_close');
  assert.equal(fermeture.payload.path, 'ssh');
  fermer();
});

test('rien du CONTENU ne traverse la frontière du journal (§37.5)', async () => {
  const { base, fermer, declarees, enfants } = await pile();
  const session = await (await ouvrir(base, { container: 'crm-web-1' })).json();
  await fetch(`${base}/api/terminal/entree?id=${session.id}`, {
    method: 'POST', body: JSON.stringify({ data: 'export TOKEN=SECRET-EN-CLAIR\n' }) });
  enfants[0].stdout.emit('data', Buffer.from('base ouverte, mot de passe accepté'));
  await fetch(`${base}/api/terminal?id=${session.id}`, { method: 'DELETE' });

  const vu = JSON.stringify(declarees);
  assert.ok(!vu.includes('SECRET-EN-CLAIR'));
  assert.ok(!vu.includes('mot de passe accepté'));
  fermer();
});

// --- Le gel LAISSE le terminal (§37.7) --------------------------------------

test('un Spark GELÉ laisse ouvrir un terminal de conteneur', async () => {
  // §35.4 : bloquer le diagnostic pousserait à désarmer pour regarder, donc à
  // oublier de réarmer. C'est aussi la réponse à l'objection du §37.7.3 sur le
  // conteneur compromis : qui doit couper vite entre ici.
  const { base, fermer, enfants } = await pile({
    spark: { name: 'crm', ipv4_address: '10.77.0.16', incus_name: 'crm',
             state: 'running', protected: true } });
  const r = await ouvrir(base, { container: 'crm-web-1' });
  assert.equal(r.status, 201, 'le gel ne bloque pas le terminal');
  assert.equal(enfants.length, 1);
  fermer();
});
