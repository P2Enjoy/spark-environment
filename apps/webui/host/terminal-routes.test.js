/**
 * @verifies docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.4.4 (la surface d'API),
 *           §37.4.5 (ce que le journal reçoit), §37.2 (un Spark sans `sshd`),
 *           §37.5 (rien du contenu) · §15.1 (l'adresse vient du REGISTRE)
 *
 * Les routes du terminal ont leur fichier : elles montent une pile complète —
 * serveur HTTP, tunnel simulé, sessions — là où `main.test.js` éprouve
 * l'inventaire et le relais. Les mêler retenait le processus de test.
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

/**
 * Une pile dont le tunnel est SIMULÉ : c'est le terminal qu'on éprouve, pas le
 * tunnel — celui-ci a ses propres preuves dans `tunnel.test.js`.
 */
async function pile({ spark = { name: 'crm', ipv4_address: '10.77.0.16' },
                      statutSpark = 200, journalMuet = false } = {}) {
  const enfants = [];
  const declarees = [];
  const dossier = await mkdtemp(join(tmpdir(), 'spark-term-'));
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod',
                 jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] };
  const { server } = createConsoleHost({
    tunnels: { require: () => faux, get: () => faux, list: () => [faux],
               close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    terminals: new SessionManager({
      spawn: (commande, args) => {
        const enfant = fauxSsh();
        enfant.commande = commande; enfant.args = args;
        enfants.push(enfant); return enfant;
      },
    }),
    fetch: async (url, options = {}) => {
      if (String(url).includes('/v1/audit')) {
        if (journalMuet) throw new Error('sparkd injoignable');
        declarees.push(JSON.parse(options.body));
        return new Response('{"recorded":"ok"}', { status: 201 });
      }
      if (String(url).includes('/v1/sparks/')) {
        return new Response(JSON.stringify(spark), { status: statutSpark });
      }
      return new Response('{}', { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // `close()` cesse d'ACCEPTER mais laisse vivre les connexions persistantes que
  // `fetch` garde ouvertes : sans `closeAllConnections`, le processus de test ne
  // rend pas la main.
  const fermer = () => { server.closeAllConnections?.(); server.close(); };
  return { base: `http://127.0.0.1:${server.address().port}`,
           fermer, enfants, declarees };
}

const ouvrir = (base) => fetch(`${base}/api/terminal`, {
  method: 'POST', body: JSON.stringify({ server: 'prod', spark: 'crm' }) });

test('ouvrir lance ssh vers le Spark et DÉCLARE l’ouverture au journal', async () => {
  const { base, fermer, enfants, declarees } = await pile();
  const r = await ouvrir(base);
  // Le corps se lit UNE fois : le passer aussi en message d'assertion le
  // consommait, et `json()` échouait ensuite sur « Body already read ».
  const brut = await r.text();
  assert.equal(r.status, 201, brut);
  const session = JSON.parse(brut);
  assert.equal(session.spark, 'crm');
  assert.equal(session.path, 'ssh');
  assert.equal(enfants[0].commande, 'ssh');
  assert.ok(enfants[0].args.includes('-tt'), 'le pseudo-terminal vient du Spark');

  const ouverture = declarees.find((d) => d.action === 'spark.terminal_open');
  assert.ok(ouverture, 'l’ouverture doit être déclarée');
  assert.deepEqual(ouverture.payload, { path: 'ssh' });
  fermer();
});

test('un Spark sans adresse est NOMMÉ, pas rendu par une erreur technique', async () => {
  // §37.2 : l'écran doit dire ce qui manque. Un Spark jamais appliqué n'a rien
  // où se connecter.
  const { base, fermer } = await pile({ spark: { name: 'neuf', ipv4_address: null } });
  const r = await ouvrir(base);
  assert.equal(r.status, 409);
  const corps = await r.json();
  assert.equal(corps.error, 'spark_not_reachable');
  assert.match(corps.message, /jamais été appliqué/);
  fermer();
});

test('un Spark inconnu du serveur rend 404', async () => {
  const { base, fermer } = await pile({ statutSpark: 404 });
  assert.equal((await ouvrir(base)).status, 404);
  fermer();
});

test('les octets traversent, et le redimensionnement passe par stty', async () => {
  const { base, fermer, enfants } = await pile();
  const { id } = await (await ouvrir(base)).json();
  assert.equal((await fetch(`${base}/api/terminal/entree?id=${id}`, {
    method: 'POST', body: JSON.stringify({ data: 'ls -la\n' }) })).status, 204);
  assert.equal((await fetch(`${base}/api/terminal/taille?id=${id}`, {
    method: 'POST', body: JSON.stringify({ rows: 40, cols: 120 }) })).status, 204);
  assert.deepEqual(enfants[0].stdin.ecrit, ['ls -la\n', 'stty rows 40 cols 120\n']);
  fermer();
});

test('fermer TUE le distant et déclare la fermeture avec sa durée', async () => {
  const { base, fermer, enfants, declarees } = await pile();
  const { id } = await (await ouvrir(base)).json();
  assert.equal((await fetch(`${base}/api/terminal?id=${id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(enfants[0].tue, ['SIGKILL']);
  const fermeture = declarees.find((d) => d.action === 'spark.terminal_close');
  assert.ok(fermeture);
  assert.equal(fermeture.payload.reason, 'sortie');
  assert.equal(typeof fermeture.payload.duration_seconds, 'number');
  fermer();
});

test('AUCUN octet de la session n’atteint le journal', async () => {
  // §37.5, et c'est LA règle : le journal dira qu'une session a eu lieu, jamais
  // ce qui y a été fait.
  const { base, fermer, enfants, declarees } = await pile();
  const { id } = await (await ouvrir(base)).json();
  await fetch(`${base}/api/terminal/entree?id=${id}`, {
    method: 'POST', body: JSON.stringify({ data: 'mysql -u root -pSECRET-EN-CLAIR\n' }) });
  enfants[0].stdout.emit('data', Buffer.from('base ouverte, 42 tables'));
  await fetch(`${base}/api/terminal?id=${id}`, { method: 'DELETE' });

  const tout = JSON.stringify(declarees);
  assert.ok(!tout.includes('SECRET-EN-CLAIR'), 'aucune frappe ne doit atteindre le journal');
  assert.ok(!tout.includes('42 tables'), 'aucune sortie non plus');
  fermer();
});

test('une session inconnue est refusée sur chaque route', async () => {
  const { base, fermer } = await pile();
  assert.equal((await fetch(`${base}/api/terminal/entree?id=nulle`, {
    method: 'POST', body: JSON.stringify({ data: 'x' }) })).status, 409);
  assert.equal((await fetch(`${base}/api/terminal/taille?id=nulle`, {
    method: 'POST', body: JSON.stringify({ rows: 24, cols: 80 }) })).status, 409);
  assert.equal((await fetch(`${base}/api/terminal?id=nulle`, { method: 'DELETE' })).status, 404);
  fermer();
});

test('le journal INJOIGNABLE n’empêche pas d’ouvrir un terminal', async () => {
  // §37.4.5 : refuser un terminal parce que le journal est indisponible
  // transformerait une panne de traçabilité en panne d'exploitation, au moment
  // précis où l'on cherche à réparer.
  const { base, fermer } = await pile({ journalMuet: true });
  assert.equal((await ouvrir(base)).status, 201,
    'la session doit s’ouvrir malgré le journal muet');
  fermer();
});

test('le flux d’évènements porte la sortie, et sa fermeture TUE la session', async () => {
  // §37.4.1 et §37.4.2 : c'est ce qui fait qu'un onglet fermé ne laisse pas un
  // shell root derrière lui.
  const { base, fermer, enfants } = await pile();
  const { id } = await (await ouvrir(base)).json();

  const flux = await fetch(`${base}/api/terminal/flux?id=${id}`);
  assert.equal(flux.status, 200);
  assert.match(flux.headers.get('content-type'), /text\/event-stream/);

  const lecteur = flux.body.getReader();
  const decodeur = new TextDecoder();
  // Le premier morceau est le commentaire d'amorce : il PROUVE que le flux est
  // ouvert, il ne porte aucun évènement. On lit donc jusqu'à l'évènement.
  let texte = '';
  const premier = await lecteur.read();
  texte += decodeur.decode(premier.value, { stream: true });
  assert.match(texte, /^: ouvert/, 'le flux s’annonce ouvert avant tout évènement');

  enfants[0].stdout.emit('data', Buffer.from('bonjour'));
  while (!texte.includes('event: sortie')) {
    const { value, done } = await lecteur.read();
    if (done) break;
    texte += decodeur.decode(value, { stream: true });
  }
  assert.match(texte, /event: sortie/);
  assert.match(texte, /"bonjour"/);

  // `cancel` LIBÈRE le corps et ferme la connexion. Un `AbortController` laisse
  // le lecteur attaché, et le processus de test ne rend alors jamais la main.
  await lecteur.cancel();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(enfants[0].tue, ['SIGKILL'], 'le flux fermé doit tuer le distant');
  fermer();
});

test('le flux d’une session inconnue rend 404, pas un flux vide', async () => {
  const { base, fermer } = await pile();
  const r = await fetch(`${base}/api/terminal/flux?id=nulle`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'unknown_session');
  fermer();
});

test('la fermeture par BALISE tue le distant et déclare la fermeture', async () => {
  // §37.4.2 : `sendBeacon` ne sait que POSTer, et c'est le seul envoi qui parte
  // encore quand l'onglet se ferme. Sans cette route, fermer le navigateur
  // laisserait un shell root vivant jusqu'au délai d'inactivité.
  const { base, fermer, enfants, declarees } = await pile();
  const { id } = await (await ouvrir(base)).json();

  const r = await fetch(`${base}/api/terminal/fermeture?id=${id}`, { method: 'POST' });
  assert.equal(r.status, 204);
  assert.deepEqual(enfants[0].tue, ['SIGKILL']);

  const fermeture = declarees.find((d) => d.action === 'spark.terminal_close');
  assert.ok(fermeture);
  assert.equal(fermeture.payload.reason, 'flux_ferme',
    'la balise dit que la CONNEXION est partie, pas qu’on a quitté volontairement');
  fermer();
});

test('une balise sur une session inconnue ne fâche personne', async () => {
  // Une balise part quand la page se démonte : elle peut arriver après que la
  // session a déjà été fermée autrement. La refuser n'apprendrait rien.
  const { base, fermer } = await pile();
  assert.equal((await fetch(`${base}/api/terminal/fermeture?id=nulle`,
                            { method: 'POST' })).status, 204);
  fermer();
});
