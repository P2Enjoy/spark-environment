/**
 * @verifies docs/BACKLOG.md#SPK-178 · docs/DAT.md §71.2 (le jeton : où, par qui,
 *           comment), §71.3 (les gestes et la garde), §71.4 (ce que GitHub répond),
 *           §71.5 (où cela vit) · §38.1 (le modèle du jeton)
 *
 * Ces preuves parlent au VRAI client, contre un faux `fetch` qui rend les formes
 * réelles de l'API des clés de déploiement. Le point de ce fichier est la garde :
 * un dépôt tiers reçoit une clé, ou en perd une, et rien d'autre ne doit y bouger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GithubError, GithubDeployKeys, corpsDeCle, depotDepuis, etatDeLaCle,
  fournisseurGithubDepuis, titreDeCle,
} from './github.js';

const CORPS = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0000000000000000000000000000000000000000000';
const PUBLIQUE = `${CORPS} spark:crm`;
const AUTRE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK1111111111111111111111111111111111111111111';

/** Un faux GitHub : une liste de clés par dépôt, et la trace de chaque appel. */
function faux({ cles = [], refus = null, jeton = 'ghp_secret-de-test' } = {}) {
  const appels = [];
  const etat = { cles: cles.map((c) => ({ ...c })), prochain: 100 };
  const fetchFn = async (url, options = {}) => {
    appels.push({ url, methode: options.method ?? 'GET',
                  corps: options.body ? JSON.parse(options.body) : null,
                  entetes: options.headers });
    if (refus) return new Response(JSON.stringify(refus.corps ?? {}), {
      status: refus.status, headers: refus.entetes ?? {} });
    const m = (options.method ?? 'GET');
    const racine = /\/repos\/([^/]+)\/([^/]+)\/keys(?:\/(\d+))?/.exec(url);
    if (!racine) return new Response('{}', { status: 404 });
    if (m === 'GET') return new Response(JSON.stringify(etat.cles), { status: 200 });
    if (m === 'POST') {
      const corps = JSON.parse(options.body);
      if (etat.cles.some((c) => c.key === corps.key.split(' ').slice(0, 2).join(' '))) {
        return new Response(JSON.stringify({
          message: 'Validation Failed',
          errors: [{ message: 'key is already in use' }] }), { status: 422 });
      }
      const cle = { id: etat.prochain += 1, key: corps.key.split(' ').slice(0, 2).join(' '),
                    title: corps.title, read_only: corps.read_only };
      etat.cles.push(cle);
      return new Response(JSON.stringify(cle), { status: 201 });
    }
    if (m === 'DELETE') {
      etat.cles = etat.cles.filter((c) => String(c.id) !== racine[3]);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 405 });
  };
  return { fetchFn, appels, etat, jeton };
}

const client = (f) => new GithubDeployKeys({ token: f.jeton, fetch: f.fetchFn });
const DEPOT = depotDepuis('p2enjoy/crm');

// --- la forme du dépôt et de la clé -----------------------------------------

test('un dépôt se saisit « propriétaire/dépôt », et rien d’autre', () => {
  assert.deepEqual(depotDepuis(' P2Enjoy/crm.v2 '),
    { proprietaire: 'P2Enjoy', depot: 'crm.v2', nom: 'P2Enjoy/crm.v2' });
  for (const mauvais of ['', 'crm', 'a/b/c', '/crm', 'p2enjoy/', 'p2enjoy/../x',
                         'p2enjoy/crm?x=1', 'https://github.com/p2enjoy/crm', 'a b/c']) {
    assert.throws(() => depotDepuis(mauvais), GithubError, `« ${mauvais} » doit être refusé`);
  }
});

test('le corps d’une clé retire le commentaire, et compare type + base64', () => {
  assert.equal(corpsDeCle(PUBLIQUE), CORPS);
  assert.equal(corpsDeCle(`${CORPS}\n`), CORPS);
});

test('GARDE : une clé PRIVÉE n’est jamais envoyée, ni même lue jusqu’au bout', () => {
  const privee = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
  assert.throws(() => corpsDeCle(privee), (e) => e instanceof GithubError
    && e.code === 'cle_privee' && !e.message.includes('b3BlbnNz'));
});

test('GARDE : un corps qui n’est pas une clé publique SSH est refusé', () => {
  for (const mauvais of ['', 'bonjour', 'ssh-ed25519', 'ssh-ed25519 pas-du-base64!!',
                         'ssh-inconnu AAAAC3Nza']) {
    assert.throws(() => corpsDeCle(mauvais), GithubError);
  }
});

test('le titre d’une clé nomme le Spark', () => {
  assert.equal(titreDeCle('crm'), 'spark:crm');
});

// --- l’état d’une clé (§71.3) -----------------------------------------------

test('non posée, posée en lecture, posée en écriture, périmée', () => {
  const voisine = { id: 1, key: AUTRE, title: 'ci-deploy', read_only: true };
  assert.equal(etatDeLaCle({ cles: [voisine], corps: CORPS, spark: 'crm' }).state, 'non_posee');

  const lecture = { id: 2, key: CORPS, title: 'spark:crm', read_only: true };
  assert.deepEqual(etatDeLaCle({ cles: [voisine, lecture], corps: CORPS, spark: 'crm' }),
    { state: 'posee', access: 'lecture', id: 2, title: 'spark:crm' });

  const ecriture = { ...lecture, read_only: false };
  assert.equal(etatDeLaCle({ cles: [ecriture], corps: CORPS, spark: 'crm' }).access, 'ecriture');

  // Même titre, autre corps : l'identité a été régénérée depuis (§17.5).
  const ancienne = { id: 3, key: AUTRE, title: 'spark:crm', read_only: true };
  assert.deepEqual(etatDeLaCle({ cles: [voisine, ancienne], corps: CORPS, spark: 'crm' }),
    { state: 'perimee', access: 'lecture', id: 3, title: 'spark:crm' });
});

test('l’état ne rend JAMAIS les clés des autres : ni corps, ni titre, ni nombre', () => {
  const bilan = etatDeLaCle({
    cles: [{ id: 1, key: AUTRE, title: 'secret-interne', read_only: true }],
    corps: CORPS, spark: 'crm' });
  assert.equal(JSON.stringify(bilan).includes('secret-interne'), false);
  assert.equal(JSON.stringify(bilan).includes(AUTRE), false);
});

// --- le client : lire, poser, retirer ---------------------------------------

test('vérifier lit les clés du dépôt, avec les en-têtes de l’API', async () => {
  const f = faux({ cles: [{ id: 2, key: CORPS, title: 'spark:crm', read_only: true }] });
  const bilan = await client(f).verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.equal(bilan.state, 'posee');
  assert.match(f.appels[0].url, /\/repos\/p2enjoy\/crm\/keys\?per_page=100/);
  assert.equal(f.appels[0].entetes.Authorization, `Bearer ${f.jeton}`);
  assert.equal(f.appels[0].entetes['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(f.appels[0].entetes['User-Agent'], 'GitHub refuse une requête sans User-Agent');
});

test('poser met la clé en LECTURE SEULE par défaut', async () => {
  const f = faux();
  const bilan = await client(f).poser({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  const envoi = f.appels.find((a) => a.methode === 'POST');
  assert.deepEqual(envoi.corps, { title: 'spark:crm', key: CORPS, read_only: true });
  assert.equal(bilan.state, 'posee');
  assert.equal(bilan.access, 'lecture');
  assert.equal(bilan.changed, true);
});

test('poser en écriture exige l’intention explicite, et la pose en écriture', async () => {
  const f = faux();
  const bilan = await client(f).poser({ depot: DEPOT, corps: CORPS, spark: 'crm',
                                        ecriture: true });
  assert.equal(f.appels.find((a) => a.methode === 'POST').corps.read_only, false);
  assert.equal(bilan.access, 'ecriture');
  // `ecriture` doit valoir EXACTEMENT true : « "false" » ou 1 ne l'accordent pas.
  const g = faux();
  await client(g).poser({ depot: DEPOT, corps: CORPS, spark: 'crm', ecriture: 'false' });
  assert.equal(g.appels.find((a) => a.methode === 'POST').corps.read_only, true);
});

test('poser une clé déjà posée avec le même accès ne fait AUCUNE écriture', async () => {
  const f = faux({ cles: [{ id: 2, key: CORPS, title: 'spark:crm', read_only: true }] });
  const bilan = await client(f).poser({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.equal(bilan.changed, false);
  assert.deepEqual(f.appels.map((a) => a.methode), ['GET']);
});

test('poser en écriture une clé posée en lecture est REFUSÉ, avec le chemin pour y arriver', async () => {
  const f = faux({ cles: [{ id: 2, key: CORPS, title: 'spark:crm', read_only: true }] });
  await assert.rejects(client(f).poser({ depot: DEPOT, corps: CORPS, spark: 'crm',
                                         ecriture: true }),
    (e) => e.code === 'acces_different' && /retirez-la/.test(e.message));
  assert.deepEqual(f.appels.map((a) => a.methode), ['GET']);
});

test('poser sur une clé PÉRIMÉE la remplace : retire celle-là, pose la nouvelle', async () => {
  const f = faux({ cles: [
    { id: 1, key: AUTRE, title: 'ci-deploy', read_only: true },
    { id: 3, key: AUTRE.replace('K111', 'K222'), title: 'spark:crm', read_only: true },
  ] });
  const bilan = await client(f).poser({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.deepEqual(f.appels.map((a) => `${a.methode} ${a.url.split('/keys')[1]}`),
    ['GET ?per_page=100&page=1', 'DELETE /3', 'POST ']);
  assert.equal(bilan.replaced, true);
  // La clé d'un autre n'a pas bougé.
  assert.ok(f.etat.cles.some((c) => c.title === 'ci-deploy'));
});

test('GARDE : une clé d’un autre titre n’est JAMAIS supprimée par un remplacement', async () => {
  const f = faux({ cles: [{ id: 1, key: AUTRE, title: 'ci-deploy', read_only: true }] });
  await client(f).poser({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.equal(f.appels.some((a) => a.methode === 'DELETE'), false);
});

test('retirer ne supprime que la clé du Spark, après relecture', async () => {
  const f = faux({ cles: [
    { id: 1, key: AUTRE, title: 'ci-deploy', read_only: true },
    { id: 2, key: CORPS, title: 'spark:crm', read_only: true },
  ] });
  const bilan = await client(f).retirer({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.equal(bilan.removed, true);
  assert.deepEqual(f.appels.filter((a) => a.methode === 'DELETE').map((a) => a.url.split('/keys')[1]),
    ['/2']);
});

test('retirer une clé absente est un refus nommé, pas un succès', async () => {
  const f = faux({ cles: [{ id: 1, key: AUTRE, title: 'ci-deploy', read_only: true }] });
  await assert.rejects(client(f).retirer({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'absente');
  assert.equal(f.appels.some((a) => a.methode === 'DELETE'), false);
});

// --- ce que GitHub répond (§71.4) -------------------------------------------

test('401 : jeton refusé, expiré ou révoqué', async () => {
  const f = faux({ refus: { status: 401, corps: { message: 'Bad credentials' } } });
  await assert.rejects(client(f).verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'refuse' && /expiré ou révoqué/.test(e.message));
});

test('403 : permission manquante ; 403 de limite de débit : nommée comme telle', async () => {
  const perm = faux({ refus: { status: 403, corps: { message: 'Resource not accessible by personal access token' } } });
  await assert.rejects(client(perm).verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'permission' && /Administration/.test(e.message));
  const debit = faux({ refus: { status: 403, corps: { message: 'API rate limit exceeded' },
                                entetes: { 'x-ratelimit-remaining': '0' } } });
  await assert.rejects(client(debit).verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'debit');
});

test('404 : le dépôt est introuvable OU le jeton n’y a pas accès — les deux sont dits', async () => {
  const f = faux({ refus: { status: 404, corps: { message: 'Not Found' } } });
  await assert.rejects(client(f).verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'introuvable' && /introuvable/.test(e.message) && /accès/.test(e.message));
});

test('422 « key is already in use » : un Spark sert un seul dépôt', async () => {
  const f = faux({ cles: [{ id: 9, key: CORPS, title: 'autre', read_only: true }] });
  // La clé est posée sous un AUTRE titre sur ce même dépôt : GitHub la refuse.
  const g = { ...f, fetchFn: async (url, o = {}) => (o.method === 'POST'
    ? new Response(JSON.stringify({ message: 'Validation Failed',
        errors: [{ message: 'key is already in use' }] }), { status: 422 })
    : new Response('[]', { status: 200 })) };
  await assert.rejects(client(g).poser({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'cle_deja_utilisee' && /un seul dépôt/.test(e.message));
});

test('un remplacement dont la pose échoue le DIT : l’ancienne clé est déjà retirée', async () => {
  const f = faux({ cles: [{ id: 3, key: AUTRE, title: 'spark:crm', read_only: true }] });
  const brut = f.fetchFn;
  const g = { ...f, fetchFn: async (url, o = {}) => (o.method === 'POST'
    ? new Response('{"message":"boom"}', { status: 500 }) : brut(url, o)) };
  await assert.rejects(client(g).poser({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => /ancienne clé a été retirée/.test(e.message));
});

test('un fournisseur injoignable rend une erreur nommée, sans nouvelle tentative', async () => {
  let essais = 0;
  const c = new GithubDeployKeys({ token: 'jeton', fetch: async () => {
    essais += 1; throw new TypeError('fetch failed'); } });
  await assert.rejects(c.poser({ depot: DEPOT, corps: CORPS, spark: 'crm' }),
    (e) => e.code === 'injoignable');
  assert.equal(essais, 1, 'aucune nouvelle tentative sur une écriture');
});

// --- le secret (§71.2) ------------------------------------------------------

test('le jeton est un champ PRIVÉ : il ne sort ni d’une sérialisation ni d’une erreur', async () => {
  const f = faux({ refus: { status: 401, corps: { message: 'Bad credentials' } } });
  const c = client(f);
  assert.equal(JSON.stringify(c).includes(f.jeton), false);
  assert.equal(Object.values(c).some((v) => v === f.jeton), false);
  try {
    await c.verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  } catch (e) {
    assert.equal(String(e.message).includes(f.jeton), false);
    assert.equal(JSON.stringify({ ...e }).includes(f.jeton), false);
  }
});

test('un fournisseur sans jeton est refusé à la construction', () => {
  assert.throws(() => new GithubDeployKeys({ token: '' }), GithubError);
});

test('sans jeton, le fournisseur dit sa raison : ce n’est pas une panne', () => {
  const bilan = fournisseurGithubDepuis({});
  assert.equal(bilan.configured, false);
  assert.equal(bilan.provider, null);
  assert.match(bilan.reason, /SPARK_GITHUB_DEPLOY_TOKEN/);
  assert.equal(fournisseurGithubDepuis({ SPARK_GITHUB_DEPLOY_TOKEN: '   ' }).configured, false);
});

test('un jeton fait un fournisseur ; la racine de l’API est celle de GitHub par défaut', async () => {
  const vus = [];
  const bilan = fournisseurGithubDepuis({ SPARK_GITHUB_DEPLOY_TOKEN: 'jeton' },
    { fetch: async (url) => { vus.push(url); return new Response('[]', { status: 200 }); } });
  assert.equal(bilan.configured, true);
  await bilan.provider.verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.ok(vus[0].startsWith('https://api.github.com/repos/p2enjoy/crm/keys'));
});

test('la racine est REMPLAÇABLE par un argument (le doublon d’épreuve), et par lui seul', async () => {
  const vus = [];
  const bilan = fournisseurGithubDepuis(
    { SPARK_GITHUB_DEPLOY_TOKEN: 'jeton', SPARK_GITHUB_BASE_URL: 'http://piege.invalide' },
    { baseUrl: 'http://127.0.0.1:8098',
      fetch: async (url) => { vus.push(url); return new Response('[]', { status: 200 }); } });
  await bilan.provider.verifier({ depot: DEPOT, corps: CORPS, spark: 'crm' });
  assert.ok(vus[0].startsWith('http://127.0.0.1:8098/repos/'),
    'la variable d’environnement ne remplace rien : seule l’épreuve (argument) le fait');
});
