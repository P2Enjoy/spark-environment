/**
 * Parcours E2E de l'onglet « Mises à jour » de la Forge, contre la pile réelle.
 *
 * @verifies docs/BACKLOG.md#SPK-171 · docs/DAT.md §70.5 (l'onglet, depuis
 *           l'accueil ; lecture seule ; le relevé de démonstration se voit ;
 *           *Relire* refait la lecture sans rien écrire) · §70.6 (le renvoi des
 *           pools ZFS à l'installation) · docs/DESIGN_SYSTEM_APP.md SPK-DS-46 ·
 *           CLAUDE.md §16 (la vérification se fait au clavier et à la souris,
 *           depuis l'accueil)
 *
 * La pile est celle des parcours (`e2e/pile.mjs`) : `sparkd` sous pilote
 * factice, qui rend le relevé de démonstration (§70.5), et la vraie console.
 */
// CLAUDE.md §15 bis : la pile prend le verrou ; ce fichier le prend aussi à
// l'import, avant le Chromium.
import { prendreLeVerrou } from './verrou.mjs';

prendreLeVerrou();

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { monterPile } from './pile.mjs';

const CAPTURES = new URL('./captures/', import.meta.url).pathname;
let pile;
let navigateur;
let page;
const bruits = [];

before(async () => {
  pile = await monterPile();
  navigateur = await chromium.launch();
  page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) bruits.push(m.text()); });
  page.on('pageerror', (e) => bruits.push(e.message));
});

after(async () => {
  await navigateur?.close();
  await pile?.demonter();
});

async function capturer(nom, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(300);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test('depuis l’accueil, Forge → Mises à jour montre le relevé, et Relire le refait sans rien écrire', async () => {
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.click('nav a[href="#/forge"]');
  const onglet = page.locator('.onglet[href="#/forge/mises-a-jour"]');
  await onglet.waitFor();
  assert.equal(await onglet.innerText(), 'Mises à jour');
  await onglet.click();
  await page.waitForSelector('h1:has-text("Mises à jour")');
  await page.waitForSelector('#titre-paquets');

  const texte = await page.locator('.principal').innerText();
  // Le relevé de démonstration se dit (§70.5, §53).
  assert.match(texte, /relevé de démonstration/);
  assert.match(texte, /Ubuntu 26\.04\.1 LTS/);
  assert.match(texte, /3 mises à jour en attente, dont 1 de sécurité/);
  assert.match(texte, /redémarrage requis/);
  assert.match(texte, /Ubuntu 26\.10 disponible/);
  assert.match(texte, /Choisissez les paquets, puis appliquez-les/);
  assert.match(texte, /3 fonctionnalités à activer/);
  // La sécurité en tête de la table.
  const premiere = await page.locator('#titre-paquets ~ .tableau-enveloppe tbody tr').first().innerText();
  assert.match(premiere, /openssl/);
  assert.equal(await page.locator('.onglet[aria-current="page"]').innerText(), 'Mises à jour');
  await capturer('spk171-mises-a-jour');
  await capturer('spk171-mises-a-jour-mobile', { largeur: 390, hauteur: 844 });

  // Relire, au clavier : le focus revient au bouton, et rien n'est journalisé.
  const avant = await pile.lireSparkd('/v1/audit');
  await page.focus('[data-action="relire-systeme"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#titre-paquets');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.action), 'relire-systeme');
  const apres = await pile.lireSparkd('/v1/audit');
  assert.deepEqual(apres.corps, avant.corps, 'une lecture ne journalise rien');

  // Le renvoi des pools ZFS mène à l'installation de la Forge (§70.6).
  await page.click('#titre-zfs ~ p a[href="#/forge"]');
  await page.waitForSelector('.onglet[aria-current="page"][href="#/forge"]');
  assert.deepEqual(bruits, [], `console du navigateur : ${bruits.join(' | ')}`);
});

// SPK-181 · §73 : choisir, confirmer, appliquer — puis l'issue et le relevé relu.
// @verifies docs/BACKLOG.md#SPK-181 · docs/DAT.md §73.1-§73.4
test('choisir un paquet au clavier, confirmer, appliquer : le paquet sort de la liste, le geste est signé', async () => {
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.click('nav a[href="#/forge"]');
  await page.click('.onglet[href="#/forge/mises-a-jour"]');
  await page.waitForSelector('[data-paquet="openssl"]');
  assert.equal(await page.locator('[data-action="maj-demander"]').count(), 0, 'pas de bouton sans sélection');

  // Au clavier : la case d'openssl.
  await page.focus('[data-paquet="openssl"]');
  await page.keyboard.press('Space');
  await page.waitForSelector('[data-action="maj-demander"]');
  assert.match(await page.locator('[data-action="maj-demander"]').innerText(), /\(1\)/);
  await page.click('[data-action="maj-demander"]');
  await page.waitForSelector('#titre-confirmation-maj');
  const confirmation = await page.locator('[aria-labelledby="titre-confirmation-maj"]').innerText();
  assert.match(confirmation, /openssl/);
  assert.match(confirmation, /jamais redémarrée/);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.action), 'maj-confirmer');
  await capturer('spk181-confirmation');
  await capturer('spk181-confirmation-mobile', { largeur: 390, hauteur: 844 });

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Mises à jour appliquées/.test(document.body.innerText), null, { timeout: 20000 });
  assert.equal(await page.locator('[data-paquet="openssl"]').count(), 0, 'openssl sort du relevé relu');
  assert.ok(await page.locator('[data-paquet="incus"]').count(), 'les autres restent');
  await capturer('spk181-appliquee');

  // Effet backend : la demande, signée, puis l'issue, au journal.
  const { corps } = await pile.lireSparkd('/v1/audit');
  const lignes = corps.entries.filter((e) => e.action === 'system.upgrade');
  assert.ok(lignes.some((e) => /demandées/.test(e.message) && e.signed), 'demande signée');
  assert.ok(lignes.some((e) => /appliquées/.test(e.message)), 'issue inscrite');
  assert.deepEqual(bruits, [], `console du navigateur : ${bruits.join(' | ')}`);
});
