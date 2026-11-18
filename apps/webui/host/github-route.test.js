/**
 * @verifies docs/BACKLOG.md#SPK-178 · docs/DAT.md §71.2 (le jeton reste sur
 *           l'hôte), §71.3 (les gestes, la garde, l'identité lue chez sparkd),
 *           §71.4 (les refus de GitHub), §71.5 (le journal), §71.6 (la racine de
 *           l'API ne se remplace que sous l'interrupteur d'épreuve) ·
 *           docs/DAT.md §10 CLAUDE.md (une règle d'accès se prouve en contournant
 *           l'écran : ici, par la requête directe)
 *
 * Ces preuves frappent les routes de l'HÔTE, sans écran. Ce que l'écran cache
 * ne vaut rien : un bouton grisé n'est pas une règle (CLAUDE.md §10).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleHost } from './main.js';
import { lireEpreuve } from './epreuve.js';

const JETON = 'github_pat_SECRET-DE-TEST-0123456789';
const CORPS = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0000000000000000000000000000000000000000000';
const EMPREINTE = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const IDENTITE = { spark: 'crm', state: 'presente', public_key: `${CORPS} spark:crm`,
                   fingerprint: EMPREINTE, comment: 'spark:crm', key_type: 'ed25519',
                   path: '/root/.ssh/id_ed25519' };
const AUTRE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK1111111111111111111111111111111111111111111';

async function pile({ env = { SPARK_GITHUB_DEPLOY_TOKEN: JETON }, identite = IDENTITE,
                      statutIdentite = 200, cles = [], refusGithub = null,
                      journalMuet = false, tunnelRompu = false, epreuve } = {}) {
  const github = [];
  const journal = [];
  const etat = { cles: cles.map((c) => ({ ...c })), prochain: 200 };
  const faux = { name: 'prod', localPort: 9876, actorHeader: 'console/prod' };
  const dossier = await mkdtemp(join(tmpdir(), 'spark-gh-'));
  const { server } = createConsoleHost({
    tunnels: { require: () => {
      if (tunnelRompu) throw new Error('Tunnel vers « prod » indisponible (broken).');
      return faux;
    }, get: () => faux, list: () => [faux], close() {}, closeAll() {} },
    inventoryPath: join(dossier, 'servers.json'),
    anchorPath: join(dossier, 'anchors.json'),
    env,
    ...(epreuve ? { epreuve } : {}),
    fetch: async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/v1/audit')) {
        if (journalMuet) throw new Error('sparkd injoignable');
        journal.push(JSON.parse(options.body));
        return new Response('{"recorded":"ok"}', { status: 201 });
      }
      if (u.includes('/identity')) {
        return new Response(JSON.stringify(identite), { status: statutIdentite });
      }
      if (u.includes('/repos/')) {
        const m = options.method ?? 'GET';
        github.push({ url: u, methode: m, entetes: options.headers,
                      corps: options.body ? JSON.parse(options.body) : null });
        if (refusGithub) {
          return new Response(JSON.stringify(refusGithub.corps ?? {}),
                              { status: refusGithub.status });
        }
        const id = /\/keys\/(\d+)/.exec(u)?.[1];
        if (m === 'GET') return new Response(JSON.stringify(etat.cles), { status: 200 });
        if (m === 'DELETE') {
          etat.cles = etat.cles.filter((c) => String(c.id) !== id);
          return new Response(null, { status: 204 });
        }
        const corps = JSON.parse(options.body);
        const cle = { id: etat.prochain += 1, key: corps.key, title: corps.title,
                      read_only: corps.read_only };
        etat.cles.push(cle);
        return new Response(JSON.stringify(cle), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const fermer = () => { server.closeAllConnections?.(); server.close(); };
  const base = `http://127.0.0.1:${server.address().port}`;
  const envoyer = (methode, chemin, corps) => fetch(`${base}${chemin}`, {
    method: methode, headers: { 'content-type': 'application/json' },
    ...(corps ? { body: JSON.stringify(corps) } : {}) });
  return { base, fermer, github, journal, etat, envoyer };
}

const GESTE = { server: 'prod', spark: 'crm', repository: 'p2enjoy/crm' };

// --- l'état de la fonction (§71.2) ------------------------------------------

test('sans jeton : 200, `configured: false` et la raison — ce n’est pas une panne', async () => {
  const p = await pile({ env: {} });
  const r = await p.envoyer('GET', '/api/github/etat');
  assert.equal(r.status, 200);
  const corps = await r.json();
  assert.equal(corps.configured, false);
  assert.match(corps.reason, /SPARK_GITHUB_DEPLOY_TOKEN/);
  p.fermer();
});

test('avec un jeton : configuré, et le jeton ne sort JAMAIS de l’hôte', async () => {
  const p = await pile();
  const r = await p.envoyer('GET', '/api/github/etat');
  const texte = await r.text();
  assert.equal(JSON.parse(texte).configured, true);
  assert.equal(texte.includes(JETON), false);
  // Ni dans une réponse de geste, y compris un refus de GitHub.
  const refus = await pile({ refusGithub: { status: 401, corps: { message: 'Bad credentials' } } });
  const r2 = await refus.envoyer('POST', '/api/github/cle/verifier', GESTE);
  assert.equal((await r2.text()).includes(JETON), false);
  p.fermer(); refus.fermer();
});

for (const [methode, chemin] of [['POST', '/api/github/cle/verifier'],
                                  ['POST', '/api/github/cle/poser'],
                                  ['DELETE', '/api/github/cle']]) {
  test(`${methode} ${chemin} sans jeton : 409, et AUCUN appel sortant`, async () => {
    const p = await pile({ env: {} });
    const r = await p.envoyer(methode, chemin, GESTE);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'github_not_configured');
    assert.equal(p.github.length, 0);
    assert.equal(p.journal.length, 0);
    p.fermer();
  });
}

// --- la garde, avant tout appel (§71.3) -------------------------------------

test('un dépôt mal formé est refusé en 422 avant tout appel à GitHub', async () => {
  const p = await pile();
  for (const mauvais of ['crm', 'a/b/c', 'p2enjoy/../etc', '']) {
    const r = await p.envoyer('POST', '/api/github/cle/poser', { ...GESTE, repository: mauvais });
    assert.equal(r.status, 422, mauvais);
    assert.equal((await r.json()).code, 'depot_invalide');
  }
  assert.equal(p.github.length, 0);
  p.fermer();
});

test('la clé posée est CELLE DU SPARK, lue chez sparkd — jamais celle du client', async () => {
  const p = await pile();
  const r = await p.envoyer('POST', '/api/github/cle/poser', {
    ...GESTE, public_key: AUTRE, key: AUTRE, publicKey: AUTRE });
  assert.equal(r.status, 200);
  const envoi = p.github.find((a) => a.methode === 'POST');
  assert.equal(envoi.corps.key, CORPS);
  assert.equal(envoi.corps.title, 'spark:crm');
  assert.equal(envoi.corps.read_only, true);
  p.fermer();
});

test('une clé privée glissée dans la requête ne change rien : elle n’est pas lue', async () => {
  const p = await pile();
  const r = await p.envoyer('POST', '/api/github/cle/poser', {
    ...GESTE, public_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----' });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(p.github).includes('PRIVATE KEY'));
  p.fermer();
});

test('un Spark sans identité : 409 nommé, aucun appel, rien au journal', async () => {
  for (const [state, motif] of [['absente', /aucune identité/i], ['indisponible', /illisible|arrêté/i]]) {
    const p = await pile({ identite: { ...IDENTITE, state, public_key: null, fingerprint: null } });
    const r = await p.envoyer('POST', '/api/github/cle/poser', GESTE);
    assert.equal(r.status, 409);
    const corps = await r.json();
    assert.equal(corps.error, 'no_identity');
    assert.equal(corps.state, state);
    assert.match(corps.message, motif);
    assert.equal(p.github.length, 0);
    assert.equal(p.journal.length, 0);
    p.fermer();
  }
});

test('un Spark inconnu : 404 ; un tunnel rompu : 502 nommé', async () => {
  const inconnu = await pile({ statutIdentite: 404, identite: { detail: { error: 'not_found' } } });
  const r = await inconnu.envoyer('POST', '/api/github/cle/verifier', GESTE);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'unknown_spark');
  inconnu.fermer();
  const rompu = await pile({ tunnelRompu: true });
  const r2 = await rompu.envoyer('POST', '/api/github/cle/verifier', GESTE);
  assert.equal(r2.status, 502);
  assert.equal((await r2.json()).error, 'tunnel_unavailable');
  rompu.fermer();
});

// --- les gestes (§71.3) -----------------------------------------------------

test('vérifier : lit, ne journalise rien, et ne montre que la clé du Spark', async () => {
  const p = await pile({ cles: [
    { id: 1, key: AUTRE, title: 'ci-deploy-secret', read_only: true },
    { id: 2, key: CORPS, title: 'spark:crm', read_only: true },
  ] });
  const r = await p.envoyer('POST', '/api/github/cle/verifier', GESTE);
  const texte = await r.text();
  const corps = JSON.parse(texte);
  assert.equal(r.status, 200);
  assert.equal(corps.state, 'posee');
  assert.equal(corps.access, 'lecture');
  assert.equal(corps.repository, 'p2enjoy/crm');
  assert.equal(texte.includes('ci-deploy-secret'), false);
  assert.deepEqual(p.github.map((a) => a.methode), ['GET']);
  assert.equal(p.journal.length, 0, 'une lecture ne se journalise pas');
  p.fermer();
});

test('poser en écriture exige `write: true` exactement', async () => {
  const p = await pile();
  await p.envoyer('POST', '/api/github/cle/poser', { ...GESTE, write: 'true' });
  assert.equal(p.github.find((a) => a.methode === 'POST').corps.read_only, true);
  const q = await pile();
  const r = await q.envoyer('POST', '/api/github/cle/poser', { ...GESTE, write: true });
  assert.equal((await r.json()).access, 'ecriture');
  assert.equal(q.github.find((a) => a.methode === 'POST').corps.read_only, false);
  p.fermer(); q.fermer();
});

test('poser est journalisé : dépôt, empreinte, accès — jamais le jeton ni le corps de la clé', async () => {
  const p = await pile();
  const r = await p.envoyer('POST', '/api/github/cle/poser', GESTE);
  assert.equal((await r.json()).journalise, true);
  assert.equal(p.journal.length, 1);
  const e = p.journal[0];
  assert.equal(e.action, 'spark.deploykey_add');
  assert.equal(e.result, 'ok');
  assert.equal(e.target_id, 'crm');
  assert.deepEqual(e.payload, { repository: 'p2enjoy/crm', fingerprint: EMPREINTE,
                                access: 'lecture' });
  const brut = JSON.stringify(e);
  assert.equal(brut.includes(JETON), false);
  assert.equal(brut.includes(CORPS), false);
  p.fermer();
});

test('remplacer une clé périmée journalise `replace`', async () => {
  const p = await pile({ cles: [{ id: 3, key: AUTRE, title: 'spark:crm', read_only: true }] });
  const r = await p.envoyer('POST', '/api/github/cle/poser', GESTE);
  assert.equal((await r.json()).replaced, true);
  assert.equal(p.journal[0].action, 'spark.deploykey_replace');
  p.fermer();
});

test('poser une clé déjà posée ne journalise rien : rien n’a changé', async () => {
  const p = await pile({ cles: [{ id: 2, key: CORPS, title: 'spark:crm', read_only: true }] });
  const r = await p.envoyer('POST', '/api/github/cle/poser', GESTE);
  assert.equal((await r.json()).changed, false);
  assert.equal(p.journal.length, 0);
  assert.deepEqual(p.github.map((a) => a.methode), ['GET']);
  p.fermer();
});

test('retirer supprime la clé du Spark et la journalise ; une absente est un refus', async () => {
  const p = await pile({ cles: [
    { id: 1, key: AUTRE, title: 'ci-deploy', read_only: true },
    { id: 2, key: CORPS, title: 'spark:crm', read_only: true },
  ] });
  const r = await p.envoyer('DELETE', '/api/github/cle', GESTE);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).removed, true);
  assert.deepEqual(p.github.filter((a) => a.methode === 'DELETE').map((a) => a.url.split('/keys/')[1]),
                   ['2']);
  assert.equal(p.journal[0].action, 'spark.deploykey_remove');
  const encore = await p.envoyer('DELETE', '/api/github/cle', GESTE);
  assert.equal(encore.status, 409);
  assert.equal((await encore.json()).code, 'absente');
  p.fermer();
});

// --- ce que GitHub répond (§71.4) -------------------------------------------

test('401 de GitHub : 502 « refuse » ; un geste d’écriture refusé est journalisé `denied`', async () => {
  const p = await pile({ refusGithub: { status: 401, corps: { message: 'Bad credentials' } } });
  const lecture = await p.envoyer('POST', '/api/github/cle/verifier', GESTE);
  assert.equal(lecture.status, 502);
  assert.equal((await lecture.json()).code, 'refuse');
  assert.equal(p.journal.length, 0, 'une lecture refusée ne se journalise pas');
  const ecriture = await p.envoyer('POST', '/api/github/cle/poser', GESTE);
  assert.equal(ecriture.status, 502);
  assert.equal(p.journal.length, 1);
  assert.equal(p.journal[0].result, 'denied');
  assert.equal(p.journal[0].payload.reason, 'refuse');
  p.fermer();
});

test('404, 403 : codes distincts, messages qui disent quoi réparer', async () => {
  const introuvable = await pile({ refusGithub: { status: 404 } });
  const a = await (await introuvable.envoyer('POST', '/api/github/cle/verifier', GESTE)).json();
  assert.equal(a.code, 'introuvable');
  const permission = await pile({ refusGithub: { status: 403, corps: { message: 'Resource not accessible' } } });
  const b = await (await permission.envoyer('POST', '/api/github/cle/verifier', GESTE)).json();
  assert.equal(b.code, 'permission');
  assert.match(b.message, /Administration/);
  introuvable.fermer(); permission.fermer();
});

test('la clé déjà utilisée ailleurs : 409 « un Spark sert un seul dépôt »', async () => {
  const q = await pile({ refusGithub: { status: 422, corps: {
    message: 'Validation Failed', errors: [{ message: 'key is already in use' }] } } });
  const r = await q.envoyer('POST', '/api/github/cle/poser', GESTE);
  assert.equal(r.status, 409);
  const corps = await r.json();
  assert.equal(corps.code, 'cle_deja_utilisee');
  assert.match(corps.message, /un seul dépôt/);
  q.fermer();
});

test('un journal muet ne défait pas le geste : il le DIT (`journalise: false`)', async () => {
  const p = await pile({ journalMuet: true });
  const r = await p.envoyer('POST', '/api/github/cle/poser', GESTE);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).journalise, false);
  p.fermer();
});

// --- la racine de l'API (§71.6) ---------------------------------------------

test('sans interrupteur d’épreuve, SPARK_GITHUB_BASE_URL ne remplace RIEN : GitHub est employé', async () => {
  const dits = [];
  const epreuve = lireEpreuve({ SPARK_GITHUB_BASE_URL: 'http://127.0.0.1:9' },
                              { journal: (m) => dits.push(m) });
  const p = await pile({ epreuve });
  await p.envoyer('POST', '/api/github/cle/verifier', GESTE);
  assert.ok(p.github[0].url.startsWith('https://api.github.com/repos/p2enjoy/crm/keys'));
  assert.match(dits.join(''), /SPARK_GITHUB_BASE_URL/, 'le refus est écrit');
  p.fermer();
});

test('sous l’interrupteur, la racine du doublon est employée', async () => {
  const epreuve = lireEpreuve({ SPARK_EPREUVE: '1', SPARK_GITHUB_BASE_URL: 'http://127.0.0.1:8098' },
                              { journal: () => {} });
  const p = await pile({ epreuve });
  await p.envoyer('POST', '/api/github/cle/verifier', GESTE);
  assert.ok(p.github[0].url.startsWith('http://127.0.0.1:8098/repos/p2enjoy/crm/keys'));
  p.fermer();
});

test('un retrait refusé par GitHub est journalisé comme un RETRAIT refusé, pas comme une pose', async () => {
  const p = await pile({ refusGithub: { status: 403, corps: { message: 'Resource not accessible' } } });
  await p.envoyer('DELETE', '/api/github/cle', GESTE);
  assert.equal(p.journal[0].action, 'spark.deploykey_remove');
  assert.equal(p.journal[0].result, 'denied');
  p.fermer();
});
