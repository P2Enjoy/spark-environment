/**
 * @verifies docs/BACKLOG.md#SPK-45 · docs/DAT.md §37.7.3 (où le refus du gel est
 *           rendu), §37.7.4 (la surface d'API et le journal),
 *           §37.4.6 (la porte étroite) · docs/DESIGN_SYSTEM.md §6.23
 *
 * Les routes du geste ont leur fichier, pour la même raison que celles du
 * terminal : elles montent une pile complète — serveur HTTP, tunnel simulé,
 * journal — là où `main.test.js` éprouve l'inventaire et le relais.
 *
 * Ce que ces preuves gardent : **un geste qui n'a pas eu lieu n'est jamais
 * inscrit comme un succès**, et **le refus du gel ne laisse partir aucune
 * commande**.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';

async function pile({ spark = { name: 'crm', ipv4_address: '10.77.0.16',
                                incus_name: 'crm', state: 'running',
                                protected: false },
                      statutSpark = 200, journalMuet = false,
                      resultat = null } = {}) {
  const declarees = [];
  const gestes = [];
  const dossier = await mkdtemp(join(tmpdir(), 'spark-geste-'));
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod',
                 jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] };
  const { server } = createConsoleHost({
    tunnels: { require: () => faux, get: () => faux, list: () => [faux],
               close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env: {},
    // Le geste lui-même a ses preuves dans `gestes-docker.test.js` ; ici c'est
    // la ROUTE qu'on éprouve — son refus, son code, ce qu'elle journalise.
    ...(resultat ? { actOnContainer: async (args) => {
      gestes.push(args);
      return { name: args.nom, geste: args.geste, ...resultat };
    } } : {}),
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
  const fermer = () => { server.closeAllConnections?.(); server.close(); };
  return { base: `http://127.0.0.1:${server.address().port}`,
           fermer, declarees, gestes };
}

const agir = (base, corps) => fetch(`${base}/api/spark/container/action`, {
  method: 'POST',
  body: JSON.stringify({ server: 'prod', spark: 'crm', ...corps }) });

// --- Le geste abouti --------------------------------------------------------

test('un geste abouti rend 200 et est inscrit au journal comme SUCCÈS', async () => {
  const { base, fermer, declarees, gestes } = await pile({
    resultat: { state: 'abouti', titre: 'Arrêter : c’est fait', detail: 'x' } });
  const r = await agir(base, { name: 'crm-web-1', action: 'stop' });
  assert.equal(r.status, 200);
  const corps = await r.json();
  assert.equal(corps.state, 'abouti');
  assert.equal(corps.journalise, true);

  assert.deepEqual(gestes[0].nom, 'crm-web-1');
  const inscrit = declarees.find((d) => d.action === 'spark.container_stop');
  assert.ok(inscrit, 'le geste doit être journalisé');
  assert.equal(inscrit.result, 'ok');
  // §37.7.4 : la cible est le SPARK, le conteneur entre dans la charge.
  assert.equal(inscrit.target_id, 'crm');
  assert.equal(inscrit.payload.container, 'crm-web-1');
  assert.match(inscrit.message, /crm-web-1/);
  fermer();
});

test('la lecture ne journalise rien, le geste OUI — et c’est la différence', async () => {
  // §37.6 : lire ne se journalise pas, sinon le journal se remplit de bruit.
  // Arrêter le conteneur d'un locataire interrompt sa production.
  const { base, fermer, declarees } = await pile({
    resultat: { state: 'abouti', titre: 'x', detail: 'y' } });
  await fetch(`${base}/api/spark/docker?server=prod&spark=crm`).catch(() => {});
  assert.equal(declarees.length, 0, 'aucune lecture n’est journalisée');
  await agir(base, { name: 'crm-web-1', action: 'kill' });
  assert.equal(declarees.length, 1, 'le geste, lui, l’est');
  assert.equal(declarees[0].action, 'spark.container_kill');
  fermer();
});

// --- Ce qui N'A PAS eu lieu n'est pas un succès -----------------------------

test('un conteneur DISPARU n’est pas inscrit comme un arrêt réussi', async () => {
  // Inscrire « ok » ferait dire au journal qu'un conteneur a été arrêté alors
  // qu'il ne s'est rien passé — et c'est ce qu'on relira après un incident.
  const { base, fermer, declarees } = await pile({
    resultat: { state: 'conteneur_inconnu', titre: 'Ce conteneur a disparu',
                detail: 'x' } });
  const r = await agir(base, { name: 'parti', action: 'stop' });
  assert.equal(r.status, 200, 'la route a fonctionné : c’est le geste qui n’a rien fait');
  assert.equal(declarees[0].result, 'denied');
  assert.equal(declarees[0].payload.reason, 'conteneur_inconnu');
  fermer();
});

test('les quatre issues NON ABOUTIES sont inscrites comme refusées, avec leur raison', async () => {
  for (const etat of ['conteneur_inconnu', 'deja_arrete', 'sshd_muet', 'echec']) {
    const { base, fermer, declarees } = await pile({
      resultat: { state: etat, titre: 't', detail: 'd' } });
    await agir(base, { name: 'web', action: 'kill' });
    assert.equal(declarees[0].result, 'denied', etat);
    assert.equal(declarees[0].payload.reason, etat, etat);
    fermer();
  }
});

// --- Le gel (§37.7.3) -------------------------------------------------------

test('un Spark PROTÉGÉ rend 423, et le refus est JOURNALISÉ', async () => {
  // 423 et non 409 : c'est le code déjà employé par le runtime pour un Spark
  // protégé, et deux codes pour un même refus obligeraient à savoir par quel
  // chemin on est passé.
  const { base, fermer, declarees, gestes } = await pile({
    spark: { name: 'crm', ipv4_address: '10.77.0.16', incus_name: 'crm',
             state: 'running', protected: true } });
  const r = await agir(base, { name: 'crm-web-1', action: 'stop' });
  assert.equal(r.status, 423);
  const corps = await r.json();
  assert.equal(corps.refus, 'protege');
  assert.match(corps.detail, /Levez la protection/);

  // Une tentative répétée sur un Spark protégé doit être VISIBLE : c'est
  // exactement ce qu'un journal existe pour montrer.
  assert.equal(declarees[0].result, 'denied');
  assert.equal(declarees[0].payload.reason, 'protege');
  assert.match(declarees[0].message, /refusé/i);
  assert.equal(gestes.length, 0, 'aucun geste n’est parti');
  fermer();
});

// --- Les refus de la route --------------------------------------------------

test('un geste HORS DES QUATRE est refusé en nommant les admis', async () => {
  const { base, fermer, declarees } = await pile();
  for (const invente of ['remove', 'pull', 'exec', '']) {
    const r = await agir(base, { name: 'web', action: invente });
    assert.equal(r.status, 422, invente);
    const corps = await r.json();
    assert.match(corps.message, /start/);
    assert.match(corps.message, /kill/);
  }
  assert.equal(declarees.length, 0, 'un geste refusé d’emblée n’est pas journalisé');
  fermer();
});

test('un conteneur SANS NOM est refusé', async () => {
  const { base, fermer } = await pile();
  const r = await agir(base, { action: 'stop' });
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /missing_container/);
  fermer();
});

test('un Spark INCONNU du serveur rend 404, pas une erreur technique', async () => {
  const { base, fermer } = await pile({ statutSpark: 404 });
  const r = await agir(base, { name: 'web', action: 'stop' });
  assert.equal(r.status, 404);
  assert.match((await r.json()).message, /Aucun Spark/);
  fermer();
});

// --- Le journal muet ne défait rien (§37.4.5) -------------------------------

test('un journal MUET ne défait pas le geste, et l’écart est VISIBLE', async () => {
  // Le geste est déjà parti : la console ne peut pas le défaire, et prétendre
  // le contraire serait pire. Elle le signale plutôt que de le taire.
  const { base, fermer } = await pile({
    journalMuet: true,
    resultat: { state: 'abouti', titre: 'x', detail: 'y' } });
  const r = await agir(base, { name: 'web', action: 'stop' });
  assert.equal(r.status, 200);
  const corps = await r.json();
  assert.equal(corps.state, 'abouti');
  assert.equal(corps.journalise, false, 'l’écart est rendu, pas tu');
  fermer();
});
