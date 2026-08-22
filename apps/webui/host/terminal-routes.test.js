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
  e.onData = (ecouter) => {
    const sortie = (data) => ecouter(String(data));
    e.stdout.on('data', sortie); e.stderr.on('data', sortie);
    return { dispose: () => { e.stdout.off('data', sortie); e.stderr.off('data', sortie); } };
  };
  e.onExit = (ecouter) => {
    const sortie = (code, signal) => ecouter({ exitCode: code ?? 0, signal: signal ?? null });
    e.on('exit', sortie);
    return { dispose: () => e.off('exit', sortie) };
  };
  e.write = (data) => e.stdin.write(data);
  e.redimensionnements = [];
  e.resize = (cols, rows) => e.redimensionnements.push({ cols, rows });
  return e;
}

/**
 * Une pile dont le tunnel est SIMULÉ : c'est le terminal qu'on éprouve, pas le
 * tunnel — celui-ci a ses propres preuves dans `tunnel.test.js`.
 */
async function pile({ spark = { name: 'crm', ipv4_address: '10.77.0.16',
                                incus_name: 'crm' },
                      statutSpark = 200, journalMuet = false,
                      sondage = { repond: true, motif: null } } = {}) {
  const sondages = [];
  const enfants = [];
  const declarees = [];
  const dossier = await mkdtemp(join(tmpdir(), 'spark-term-'));
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod',
                 jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'],
                 forgeArgs: () => ['-p', '22', 'ubuntu@203.0.113.10'] };
  const { server } = createConsoleHost({
    tunnels: { require: () => faux, get: () => faux, list: () => [faux],
               close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    probeSshd: async (args) => { sondages.push(args); return sondage; },
    terminals: new SessionManager({
      ptySpawn: (commande, args) => {
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
           fermer, enfants, declarees, sondages };
}

const ouvrir = (base, path) => fetch(`${base}/api/terminal`, {
  method: 'POST',
  body: JSON.stringify({ server: 'prod', spark: 'crm', ...(path ? { path } : {}) }) });

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

test('un Spark sans CELLULE est NOMMÉ, pas rendu par une erreur technique', async () => {
  // §37.2 : l'écran doit dire ce qui manque. Et le signal est `incus_name`, pas
  // l'adresse — elle est attribuée dès l'écriture au registre, bien avant qu'une
  // cellule existe. Mesuré : un Spark « pending » porte déjà la sienne, et s'y
  // fier laissait ouvrir un terminal vers rien.
  const { base, fermer } = await pile({
    spark: { name: 'neuf', ipv4_address: '10.77.0.19', incus_name: null } });
  const r = await ouvrir(base);
  assert.equal(r.status, 409);
  const corps = await r.json();
  assert.equal(corps.error, 'spark_not_reachable');
  assert.match(corps.message, /pas encore de cellule/);
  fermer();
});

test('un Spark inconnu du serveur rend 404', async () => {
  const { base, fermer } = await pile({ statutSpark: 404 });
  assert.equal((await ouvrir(base)).status, 404);
  fermer();
});

test('les octets traversent, et le redimensionnement ne devient pas une frappe', async () => {
  const { base, fermer, enfants } = await pile();
  const { id } = await (await ouvrir(base)).json();
  assert.equal((await fetch(`${base}/api/terminal/entree?id=${id}`, {
    method: 'POST', body: JSON.stringify({ data: 'ls -la\n' }) })).status, 204);
  assert.equal((await fetch(`${base}/api/terminal/taille?id=${id}`, {
    method: 'POST', body: JSON.stringify({ rows: 40, cols: 120 }) })).status, 204);
  assert.deepEqual(enfants[0].stdin.ecrit, ['ls -la\n']);
  assert.deepEqual(enfants[0].redimensionnements, [{ cols: 120, rows: 40 }]);
  fermer();
});

test('le registre ne rend que les métadonnées d’une session encore vivante', async () => {
  const { base, fermer, enfants } = await pile();
  const { id } = await (await ouvrir(base)).json();
  enfants[0].stdout.emit('data', Buffer.from('mot-de-passe-qui-ne-doit-pas-sortir'));
  const sessions = await (await fetch(`${base}/api/terminal/sessions`)).json();
  assert.equal(sessions.sessions.length, 1);
  const session = sessions.sessions[0];
  assert.equal(session.id, id);
  assert.equal(session.forge, 'prod');
  assert.equal(session.type, 'spark');
  assert.equal(session.state, 'open');
  assert.ok(typeof session.openedAt === 'string');
  assert.ok(typeof session.lastActivity === 'string');
  assert.ok(!JSON.stringify(sessions).includes('mot-de-passe-qui-ne-doit-pas-sortir'));
  enfants[0].emit('exit', 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await (await fetch(`${base}/api/terminal/sessions`)).json()).sessions, []);
  fermer();
});

test('déconnecter une Forge tue ses sessions et les retire du registre', async () => {
  const { base, fermer, enfants } = await pile();
  await ouvrir(base);
  const r = await fetch(`${base}/api/tunnels`, {
    method: 'DELETE', body: JSON.stringify({ name: 'prod' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sessionsClosed, 1);
  assert.deepEqual(enfants[0].tue, ['SIGKILL']);
  assert.deepEqual((await (await fetch(`${base}/api/terminal/sessions`)).json()).sessions, []);
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

test('le journal cible l’identifiant immuable du Spark, jamais son nom', async () => {
  const { base, fermer, declarees } = await pile({
    spark: { name: 'crm', id: 'spark-immutable-42', ipv4_address: '10.77.0.16',
             incus_name: 'crm' },
  });
  const { id } = await (await ouvrir(base)).json();
  await fetch(`${base}/api/terminal?id=${id}`, { method: 'DELETE' });

  const terminal = declarees.filter((d) => d.action.startsWith('spark.terminal_'));
  assert.deepEqual(terminal.map((d) => d.target_id),
    ['spark-immutable-42', 'spark-immutable-42']);
  fermer();
});

test('la fin du shell déclare elle aussi UNE fermeture, sans retenir son contenu', async () => {
  // Le shell peut rendre la main sans que le navigateur clique « Fermer ».
  // Cette voie était la seule à contourner le journal : elle doit maintenant
  // partager la déclaration unique de toutes les fermetures.
  const { base, fermer, enfants, declarees } = await pile();
  await ouvrir(base);
  enfants[0].stdout.emit('data', Buffer.from('sortie qui ne doit pas être journalisée'));
  enfants[0].emit('exit', 0);
  await new Promise((resolve) => setImmediate(resolve));

  const fermetures = declarees.filter((d) => d.action === 'spark.terminal_close');
  assert.equal(fermetures.length, 1);
  assert.equal(fermetures[0].payload.reason, 'distant_termine');
  assert.ok(!JSON.stringify(fermetures).includes('sortie qui ne doit pas être journalisée'));
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

test('un flux quitté ne tue pas une session encore suivie par une autre grille', async () => {
  // Le registre peut reprendre une session dans une autre vue. Le premier flux
  // qui part ne doit donc pas tuer le shell sous l'autre grille ; le DERNIER
  // garde toujours le contrat historique de fermeture.
  const { base, fermer, enfants } = await pile();
  const { id } = await (await ouvrir(base)).json();
  const premier = await fetch(`${base}/api/terminal/flux?id=${id}`);
  const second = await fetch(`${base}/api/terminal/flux?id=${id}`);
  const lecteurPremier = premier.body.getReader();
  const lecteurSecond = second.body.getReader();
  await lecteurPremier.read();
  await lecteurSecond.read();

  await lecteurPremier.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(enfants[0].tue, [], 'l’autre grille regarde encore la session');

  await lecteurSecond.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(enfants[0].tue, ['SIGKILL'], 'le dernier flux ferme le shell');
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

// --- SPK-43, tranche 4 · LE DÉPANNAGE SE CONTRÔLE AU BACKEND (§37.3) --------
//
// L'écran n'est pas l'autorité : la requête reste formable à la main. Ces
// preuves passent donc TOUTES par la route, jamais par le composant.

test('le dépannage est REFUSÉ quand le chemin normal est disponible', async () => {
  const { base, fermer, enfants, declarees } = await pile({
    sondage: { repond: true, motif: null } });
  const r = await ouvrir(base, 'rescue');
  const corps = await r.json();
  assert.equal(r.status, 409);
  assert.equal(corps.error, 'rescue_refused');
  assert.equal(corps.reason, 'ssh_disponible');
  assert.equal(enfants.length, 0, 'aucun incus exec ne doit avoir été lancé');
  assert.deepEqual(declarees, [], 'un refus n’ouvre rien, donc ne déclare rien');
  fermer();
});

test('un sshd MUET ouvre le dépannage, et lance incus exec sur la FORGE', async () => {
  const { base, fermer, enfants, declarees, sondages } = await pile({
    sondage: { repond: false, motif: 'sshd_muet' } });
  const r = await ouvrir(base, 'rescue');
  const session = JSON.parse(await r.text());
  assert.equal(r.status, 201);
  assert.equal(session.path, 'rescue');
  assert.equal(session.rescueReason, 'sshd_muet');
  assert.equal(sondages.length, 1, 'la règle se fonde sur une MESURE, pas une supposition');
  assert.equal(enfants[0].commande, 'ssh');
  assert.ok(enfants[0].args.includes('incus'));
  assert.ok(enfants[0].args.includes('exec'));
  assert.ok(!enfants[0].args.some((a) => String(a).includes('10.77.0.16')),
    'on ne se connecte pas au Spark : c’est lui qui ne répond pas');
  fermer();
});

test('un Spark EN ERREUR ouvre le dépannage SANS sonder', async () => {
  // Attendre cinq secondes de plus pour apprendre ce que l'état dit déjà
  // retarderait le geste au moment précis où l'on cherche à réparer.
  const { base, fermer, sondages, declarees } = await pile({
    spark: { name: 'crm', ipv4_address: '10.77.0.16', incus_name: 'crm', state: 'error' },
    sondage: { repond: true, motif: null } });
  const r = await ouvrir(base, 'rescue');
  assert.equal(r.status, 201);
  assert.deepEqual(sondages, [], 'l’état suffit : aucun sondage');
  const entree = declarees.find((d) => d.action === 'spark.rescue_exec');
  assert.equal(entree.payload.reason, 'spark_en_erreur');
  fermer();
});

test('le dépannage écrit une action DISTINCTE, qui NOMME le pouvoir employé', async () => {
  // §37.3 : « pour qu'un relevé du journal montre combien de fois cette voie a
  // servi ». Et le message dit ce qui a été employé, comme la confirmation à
  // l'écran — un « mode dégradé » laisserait croire à quelque chose d'anodin.
  const { base, fermer, declarees } = await pile({
    sondage: { repond: false, motif: 'sshd_muet' } });
  await ouvrir(base, 'rescue');
  assert.equal(declarees.filter((d) => d.action === 'spark.terminal_open').length, 0,
    'le dépannage ne se compte pas comme une session SSH');
  const entree = declarees.find((d) => d.action === 'spark.rescue_exec');
  assert.ok(entree, 'l’action distincte est écrite');
  assert.match(entree.message, /exécution en root dans la cellule, depuis le plan de contrôle/);
  assert.deepEqual(entree.payload, { path: 'rescue', reason: 'sshd_muet' });
  fermer();
});

test('une clé refusée NE donne PAS le dépannage, et dit quoi faire', async () => {
  const { base, fermer, enfants } = await pile({
    sondage: { repond: true, motif: 'cle_refusee' } });
  const r = await ouvrir(base, 'rescue');
  const corps = await r.json();
  assert.equal(r.status, 409);
  assert.equal(corps.reason, 'cle_refusee');
  assert.match(corps.message, /onglet Clés/);
  assert.equal(enfants.length, 0);
  fermer();
});

test('un Spark SANS CELLULE ne passe pas non plus par le dépannage', async () => {
  const { base, fermer } = await pile({
    spark: { name: 'neuf', ipv4_address: '10.77.0.19', incus_name: null } });
  const r = await ouvrir(base, 'rescue');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'spark_not_reachable',
    'le refus de cellule prime : il n’y a rien où exécuter');
  fermer();
});

test('un chemin INCONNU retombe sur ssh, il n’invente pas un troisième chemin', async () => {
  const { base, fermer } = await pile();
  const r = await ouvrir(base, 'root');
  assert.equal(r.status, 201);
  assert.equal(JSON.parse(await r.text()).path, 'ssh');
  fermer();
});

// --- SPK-43 · POURQUOI LE CHEMIN NORMAL N'A PAS ABOUTI (§37.2, §37.3.1) -----

const diagnostiquer = (base, spark = 'crm') =>
  fetch(`${base}/api/terminal/diagnostic?server=prod&spark=${spark}`);

test('le diagnostic MESURE le sshd au lieu de deviner, et ne journalise rien', async () => {
  // §37.5 : la console ne retient aucun octet de la session, donc elle ne peut
  // pas inspecter la sortie pour en déduire la cause. Elle sonde.
  // §36.7 : une lecture ne se journalise pas.
  const { base, fermer, sondages, declarees } = await pile({
    sondage: { repond: false, motif: 'sshd_muet' } });
  const corps = await (await diagnostiquer(base)).json();
  assert.equal(sondages.length, 1, 'le verdict vient d’une mesure');
  assert.deepEqual(corps.sshd, { repond: false, motif: 'sshd_muet' });
  assert.equal(corps.rescue.ouvert, true);
  assert.match(corps.rescue.explication, /rien ne répond sur le port 22/i);
  assert.deepEqual(declarees, [], 'un diagnostic est une lecture');
  fermer();
});

test('le diagnostic n’OUVRE aucune session', async () => {
  // Il informe. Ouvrir au passage priverait l'exploitant de la confirmation que
  // le §37.3 exige avant d'employer le dépannage.
  const { base, fermer, enfants } = await pile({
    sondage: { repond: false, motif: 'sshd_muet' } });
  await diagnostiquer(base);
  assert.equal(enfants.length, 0);
  fermer();
});

test('un sshd qui REFUSE LA CLÉ est distingué d’un sshd muet', async () => {
  const { base, fermer } = await pile({ sondage: { repond: true, motif: 'cle_refusee' } });
  const corps = await (await diagnostiquer(base)).json();
  assert.equal(corps.sshd.repond, true);
  assert.equal(corps.rescue.ouvert, false);
  assert.match(corps.rescue.explication, /onglet Clés/);
  fermer();
});

test('un Spark EN ERREUR est diagnostiqué sans sonder', async () => {
  const { base, fermer, sondages } = await pile({
    spark: { name: 'crm', ipv4_address: '10.77.0.16', incus_name: 'crm', state: 'error' } });
  const corps = await (await diagnostiquer(base)).json();
  assert.deepEqual(sondages, []);
  assert.equal(corps.sshd, null, 'aucune mesure n’est prétendue');
  assert.equal(corps.rescue.ouvert, true);
  assert.equal(corps.rescue.motif, 'spark_en_erreur');
  fermer();
});

test('un Spark INCONNU rend 404, pas un diagnostic inventé', async () => {
  const { base, fermer } = await pile({ statutSpark: 404 });
  const r = await diagnostiquer(base);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'unknown_spark');
  fermer();
});

test('un distant mort AVANT le flux fait quand même arriver la fin', async () => {
  // MESURÉ : `fermer()` diffuse à ses abonnés puis vide la liste. Un distant qui
  // meurt entre le POST et l'ouverture du flux émettait donc sa fin dans le
  // vide, et l'écran restait sur « session ouverte » pour une session morte.
  // C'est la course exacte d'un `sshd` muet, où `ssh` sort en quelques
  // millisecondes (§37.2).
  const { base, fermer, enfants } = await pile();
  const session = JSON.parse(await (await ouvrir(base)).text());

  // Le distant meurt AVANT que quiconque écoute.
  enfants[0].emit('exit', 255);

  const flux = await fetch(`${base}/api/terminal/flux?id=${session.id}`);
  const texte = await flux.text();
  assert.match(texte, /event: fin/, 'la fin est rejouée à l’abonnement');
  assert.match(texte, /distant_termine/);
  fermer();
});
