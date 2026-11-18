/**
 * Parcours E2E du dépôt GitHub d'un Spark : la clé posée, vérifiée, retirée,
 * depuis l'écran, contre la pile réelle et un doublon local de l'API GitHub.
 *
 * @verifies docs/BACKLOG.md#SPK-178 · docs/DAT.md §71.1 (un Spark, un dépôt), §71.2
 *           (le jeton reste sur l'hôte), §71.3 (les gestes et la garde), §71.4 (ce
 *           que GitHub répond), §71.5 (le journal), §71.7 (la démonstration) ·
 *           docs/DESIGN_SYSTEM.md §6.22, §6.23, §9.1, §14.3 ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-48 · CLAUDE.md §10 (une règle d'accès
 *           se prouve par la requête directe), §16 (la vérification se fait
 *           depuis l'accueil, à la souris et au clavier)
 *
 * Ce que ce parcours ne prouve PAS : que GitHub accepte ces corps, ni qu'il
 * refuse bien une même clé sur deux dépôts. Le doublon l'encode (DAT §71.1) ; la
 * mesure se fait avec le jeton du responsable, sur deux dépôts jetables.
 */
// CLAUDE.md §15 bis : le verrou se prend à l'import, avant le Chromium.
import { prendreLeVerrou } from './verrou.mjs';

prendreLeVerrou();

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { monterPile } from './pile.mjs';
import {
  monterDoublonGithub, DEPOT, AUTRE_DEPOT, DEPOT_INTERDIT, DEPOT_INCONNU, CLE_VOISINE,
} from './github-doublon.mjs';

const CAPTURES = new URL('./captures/', import.meta.url).pathname;
const SPARK = 'crm-production';
const JOURNAL_RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;

let github;
let pile;
let navigateur;
let page;
let bruits = [];

before(async () => {
  github = await monterDoublonGithub();
  pile = await monterPile({ github });
  navigateur = await chromium.launch();
  page = await navigateur.newPage({ viewport: { width: 1440, height: 1300 } });
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type())) return;
    if (JOURNAL_RESEAU.test(m.text())) return;
    bruits.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));
});

after(async () => {
  await navigateur?.close();
  await pile?.demonter();
  await github?.demonter();
});

async function capturer(nom, { largeur = 1440, hauteur = 1300 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(300);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1300 });
}

/** De l'accueil au Spark, puis à sa facette Clés : on y va comme un exploitant. */
async function ouvrirCles(nom = SPARK) {
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 10000 });
  await page.click('.onglet[href$="/cles"]');
  await page.waitForSelector('.onglet[href$="/cles"][aria-current="page"]', { timeout: 10000 });
  await page.waitForSelector('#titre-cles', { timeout: 10000 });
}

/** Le corps (type + base64) de la clé que la CELLULE présente, lue chez `sparkd`. */
async function corpsDeLaCellule() {
  const { corps } = await pile.lireSparkd(`/v1/sparks/${SPARK}/identity`);
  return { corps: corps.public_key.split(' ').slice(0, 2).join(' '),
           empreinte: corps.fingerprint };
}

const section = () => page.locator('section.depot-cle');
const saisir = async (depot) => {
  await page.fill('#depot-cle-champ', depot);
};
/** Vérifie au CLAVIER : Entrée dans le champ soumet le formulaire (§9.1). */
async function verifier(depot) {
  await saisir(depot);
  await page.focus('#depot-cle-champ');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.depot-cle .releve-cle', { timeout: 15000 });
}
const audit = async (action) =>
  (await pile.lireSparkd(`/v1/audit?action=${action}&limit=50`)).corps.entries;

test('sans identité, la section « Dépôt GitHub » n’existe pas ; l’identité créée, elle apparaît', async () => {
  await ouvrirCles();
  await page.waitForSelector('[data-identite-creer]', { timeout: 20000 });
  assert.equal(await section().count(), 0, 'sans clé il n’y a rien à poser');

  await page.click('[data-identite-creer]');
  await page.waitForSelector('.bloc-cle', { timeout: 20000 });
  await section().waitFor({ timeout: 15000 });
  assert.match(await section().innerText(), /Dépôt GitHub/);
  // Le jeton est posé sur ce poste : le formulaire est là, la case décochée.
  await page.waitForSelector('#depot-cle-champ', { timeout: 15000 });
  assert.equal(await page.isChecked('[data-depot-ecriture]'), false,
    'l’écriture est décochée à l’ouverture (SPK-DS-39)');
});

test('vérifier, poser en lecture seule, retirer : depuis l’écran, avec ce que GitHub porte réellement', async () => {
  await ouvrirCles();
  await page.waitForSelector('#depot-cle-champ', { timeout: 20000 });
  const { corps, empreinte } = await corpsDeLaCellule();

  // Vérifier, au clavier : l'état est DATÉ et la clé n'est pas posée.
  await verifier(DEPOT);
  let texte = await section().innerText();
  assert.match(texte, /non posée/);
  assert.match(texte, /Relevé à \d{2}:\d{2}:\d{2}/);
  assert.equal(await page.locator('[data-depot-retirer]').count(), 0,
    'rien à retirer tant que la clé n’est pas posée');
  await capturer('spk178-non-posee');

  // Poser : lecture seule, sans confirmation.
  await page.click('[data-depot-poser]');
  await page.waitForFunction(
    () => document.querySelector('.depot-cle')?.innerText.includes('posée · lecture seule'),
    null, { timeout: 15000 });
  texte = await section().innerText();
  assert.match(texte, /Clé posée en lecture seule/);

  // L'EFFET est constaté chez le doublon, jamais supposé depuis l'écran (§29.3).
  const posees = github.cles(DEPOT).filter((c) => c.title === `spark:${SPARK}`);
  assert.equal(posees.length, 1);
  assert.equal(posees[0].key, corps, 'c’est la clé que la CELLULE présente');
  assert.equal(posees[0].read_only, true);
  assert.deepEqual(github.cles(DEPOT).find((c) => c.title === 'ci-deploy'), CLE_VOISINE,
    'la clé d’un autre usage n’a pas bougé');

  // Le geste est au journal de la Forge, sans corps de clé ni jeton.
  const [entree] = await audit('spark.deploykey_add');
  assert.equal(entree.result, 'ok');
  assert.deepEqual(JSON.parse(entree.payload),
    { repository: DEPOT, fingerprint: empreinte, access: 'lecture' });
  assert.ok(!JSON.stringify(entree).includes(corps));
  assert.ok(!JSON.stringify(entree).includes(github.jeton));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.depotVerifier !== undefined),
    true, 'le focus retombe sur un contrôle qui existe (§14.3)');
  await capturer('spk178-posee');
  await capturer('spk178-posee-mobile', { largeur: 390, hauteur: 844 });

  // Retirer : une confirmation qui NOMME le dépôt, le focus y entre, Annuler le rend.
  await page.click('[data-depot-retirer]');
  await page.waitForSelector('.depot-cle .confirmation', { timeout: 10000 });
  const conf = await page.locator('.depot-cle .confirmation').innerText();
  assert.match(conf, new RegExp(DEPOT));
  assert.match(conf, /ne pourra plus cloner/);
  assert.doesNotMatch(await section().innerText(), /Clé posée en lecture seule\./,
    'le succès du geste précédent ne reste pas sous la question suivante');
  assert.equal(await page.locator('[data-frappe-identite], [data-frappe]').count(), 0,
    'retirer une clé est réversible : pas de frappe du nom (§6.23)');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.confirmation')), true,
    'le focus entre dans la confirmation (§6.22)');
  await capturer('spk178-retirer-confirmation');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter'); // Annuler, au clavier
  await page.waitForFunction(() => !document.querySelector('.depot-cle .confirmation'));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.depotRetirer !== undefined),
    true, 'l’annulation rend le focus au déclencheur');
  assert.equal(github.cles(DEPOT).filter((c) => c.title === `spark:${SPARK}`).length, 1,
    'annuler ne retire rien');

  await page.click('[data-depot-retirer]');
  await page.click('[data-depot-retire-confirme]');
  await page.waitForFunction(
    () => document.querySelector('.depot-cle')?.innerText.includes('non posée'),
    null, { timeout: 15000 });
  assert.match(await section().innerText(), /Clé retirée du dépôt/);
  assert.equal(github.cles(DEPOT).filter((c) => c.title === `spark:${SPARK}`).length, 0);
  assert.deepEqual(github.cles(DEPOT).find((c) => c.title === 'ci-deploy'), CLE_VOISINE,
    'seule la clé du Spark est partie');
  assert.equal((await audit('spark.deploykey_remove')).length, 1);
  assert.deepEqual(bruits, [], `console du navigateur : ${bruits.join(' | ')}`);
});

test('l’écriture est une case décochée, puis une confirmation qui nomme ce qu’elle permet', async () => {
  await ouvrirCles();
  await page.waitForSelector('#depot-cle-champ', { timeout: 20000 });
  await saisir(DEPOT);
  await page.check('[data-depot-ecriture]');
  assert.match(await page.locator('[data-depot-poser]').innerText(), /en écriture/);

  const avant = github.recus().length;
  await page.click('[data-depot-poser]');
  await page.waitForSelector('.depot-cle .confirmation', { timeout: 10000 });
  assert.match(await page.locator('.depot-cle .confirmation').innerText(), /pousser/);
  assert.equal(github.recus().length, avant, 'rien n’est envoyé avant la confirmation');
  await capturer('spk178-ecriture-confirmation');

  await page.click('[data-depot-poser-confirme]');
  await page.waitForFunction(
    () => document.querySelector('.depot-cle')?.innerText.includes('posée · écriture'),
    null, { timeout: 15000 });
  const posee = github.cles(DEPOT).find((c) => c.title === `spark:${SPARK}`);
  assert.equal(posee.read_only, false);
  assert.equal((await audit('spark.deploykey_add')).length, 2);
});

test('régénérer l’identité rend la clé périmée, et la pastille porte sa sortie', async () => {
  await ouvrirCles();
  await page.waitForSelector('[data-identite-remplacer]', { timeout: 20000 });
  await page.click('[data-identite-remplacer]');
  await page.fill('[data-frappe-identite]', SPARK);
  await page.waitForFunction(() => !document.querySelector('[data-identite-remplace]').disabled);
  await page.click('[data-identite-remplace]');
  await page.waitForFunction(() => !document.querySelector('[data-frappe-identite]'));

  await verifier(DEPOT);
  const texte = await section().innerText();
  assert.match(texte, /périmée/);
  assert.match(await page.locator('[data-depot-poser]').innerText(), /Remplacer la clé périmée/);
  await capturer('spk178-perimee');

  // Remplacer : une seule clé au titre du Spark, et c'est la nouvelle.
  await page.uncheck('[data-depot-ecriture]');
  await page.click('[data-depot-poser]');
  await page.waitForFunction(
    () => document.querySelector('.depot-cle')?.innerText.includes('posée · lecture seule'),
    null, { timeout: 15000 });
  const { corps } = await corpsDeLaCellule();
  const siennes = github.cles(DEPOT).filter((c) => c.title === `spark:${SPARK}`);
  assert.equal(siennes.length, 1);
  assert.equal(siennes[0].key, corps);
  assert.equal((await audit('spark.deploykey_replace')).length, 1);
  assert.deepEqual(github.cles(DEPOT).find((c) => c.title === 'ci-deploy'), CLE_VOISINE);
});

test('chaque refus de GitHub est dit pour ce qu’il est — et un Spark ne sert qu’UN dépôt', async () => {
  await ouvrirCles();
  await page.waitForSelector('#depot-cle-champ', { timeout: 20000 });
  const alerte = () => page.locator('.depot-cle [role="alert"]').innerText();
  const essai = async (depot) => {
    await saisir(depot);
    await page.click('[data-depot-poser]');
    await page.waitForSelector('.depot-cle [role="alert"]', { timeout: 15000 });
    return alerte();
  };

  // La clé est déjà posée sur DEPOT (test précédent) : le second dépôt la refuse.
  assert.match(await essai(AUTRE_DEPOT), /Un Spark sert un seul dépôt/);
  assert.equal(github.cles(AUTRE_DEPOT).length, 0, 'rien n’a été posé sur le second dépôt');
  await capturer('spk178-refus-un-seul-depot');

  assert.match(await essai(DEPOT_INTERDIT), /permission « Administration »/);
  assert.match(await essai(DEPOT_INCONNU), /introuvable, ou le jeton n’y a pas accès/);
  assert.match(await essai('crm'), /propriétaire\/dépôt/);

  // Un jeton expiré n'est pas un jeton absent (§71.4).
  github.refuser({ message: 'Bad credentials' }, 401);
  assert.match(await essai(DEPOT), /expiré ou révoqué/);
  github.refuser(null);
  assert.ok((await audit('spark.deploykey_add')).some((e) => e.result === 'denied'),
    'une écriture refusée par GitHub est journalisée comme refusée');
  assert.ok(!JSON.stringify(await audit('spark.deploykey_add')).includes(github.jeton));
  assert.deepEqual(bruits, [], `console du navigateur : ${bruits.join(' | ')}`);
});

test('la règle tient par la REQUÊTE DIRECTE : la clé posée est celle de la cellule, jamais celle qu’on envoie', async () => {
  const cle = (await corpsDeLaCellule()).corps;
  const avant = github.recus().length;
  const forgee = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIForgee0000000000000000000000000000000000';
  const direct = (chemin, methode, corps) => fetch(`${pile.base}${chemin}`, {
    method: methode, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corps) });

  // Retirer d'abord, par l'écran n'est pas nécessaire : la requête suffit.
  const retrait = await direct('/api/github/cle', 'DELETE',
    { server: 'local', spark: SPARK, repository: DEPOT });
  assert.equal(retrait.status, 200);
  const pose = await direct('/api/github/cle/poser', 'POST', {
    server: 'local', spark: SPARK, repository: DEPOT,
    public_key: forgee, key: forgee });
  assert.equal(pose.status, 200);
  const posees = github.recus().slice(avant).filter((r) => r.methode === 'POST');
  assert.equal(posees.length, 1);
  assert.equal(posees[0].corps.key, cle, 'la clé de la requête n’a pas été lue');
  assert.ok(!JSON.stringify(github.recus()).includes('Forgee'));

  // Un dépôt mal formé ne coûte aucun appel sortant.
  const avantRefus = github.recus().length;
  for (const mauvais of ['a/b/c', 'p2enjoy/../x', '']) {
    const r = await direct('/api/github/cle/poser', 'POST',
      { server: 'local', spark: SPARK, repository: mauvais });
    assert.equal(r.status, 422, mauvais);
  }
  assert.equal(github.recus().length, avantRefus);
  // Un Spark qui n'existe pas est refusé nommément.
  const inconnu = await direct('/api/github/cle/poser', 'POST',
    { server: 'local', spark: 'fantome', repository: DEPOT });
  assert.equal(inconnu.status, 404);
});

test('un Spark arrêté n’offre pas le dépôt : il n’a pas d’identité lisible', async () => {
  await ouvrirCles('boutique');
  await page.waitForFunction(() => document.body.innerText.includes('illisible'), null,
    { timeout: 20000 });
  assert.equal(await section().count(), 0);
});

test('sans jeton sur le poste, la section dit pourquoi et ne rend aucun formulaire', async () => {
  // Une SECONDE pile, l'une après l'autre : la première rend le verrou (§15 bis).
  await navigateur.close();
  await pile.demonter();
  pile = await monterPile();
  navigateur = await chromium.launch();
  page = await navigateur.newPage({ viewport: { width: 1440, height: 1300 } });
  page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

  await ouvrirCles();
  await page.waitForSelector('[data-identite-creer]', { timeout: 20000 });
  await page.click('[data-identite-creer]');
  await page.waitForSelector('.bloc-cle', { timeout: 20000 });
  await section().waitFor({ timeout: 15000 });
  const texte = await section().innerText();
  assert.match(texte, /Aucun jeton GitHub sur ce poste/);
  assert.match(texte, /SPARK_GITHUB_DEPLOY_TOKEN/);
  assert.equal(await page.locator('#depot-cle-champ').count(), 0,
    'sans jeton il n’y a pas de commande morte (§1.4)');
  await capturer('spk178-sans-jeton');
});
