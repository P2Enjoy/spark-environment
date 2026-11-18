/**
 * Parcours E2E : changer de serveur depuis la fenêtre d'un Spark mène à la liste.
 *
 * @verifies docs/BACKLOG.md#SPK-180 · docs/DAT.md §22.4.5 (une adresse qui
 *           nomme un Spark de l'ancienne Forge devient #/sparks ; une section de
 *           la Forge est gardée) · CLAUDE.md §16 (souris et clavier, depuis l'accueil)
 *
 * Le second serveur est déclaré PAR L'ÉCRAN Serveurs, comme un exploitant le ferait.
 * Il vise le même sparkd de la pile : ce parcours éprouve la navigation, pas Incus.
 */
// CLAUDE.md §15 bis : la pile prend le verrou ; ce fichier le prend aussi à l'import.
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

before(async () => {
  pile = await monterPile();
  navigateur = await chromium.launch();
  page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
});

after(async () => {
  await navigateur?.close();
  await pile?.demonter();
});

const hash = () => page.evaluate(() => location.hash);

test('changer de serveur depuis un Spark mène à la liste ; depuis la Forge, la section est gardée', async () => {
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });

  // Un second serveur, déclaré par l'écran Serveurs.
  await page.click('a.destination[href="#/serveurs"]');
  await page.click('[data-ouvre="serveur"]');
  await page.fill('#serveur-nom', 'local-bis');
  await page.selectOption('#serveur-genre', 'local');
  await page.fill('#serveur-port-local', String(pile.portSparkd));
  await page.click('[data-engage="serveur"]');
  await page.waitForSelector('td.cellule-nom:has-text("local-bis")');

  // La fenêtre d'un Spark, puis une de ses facettes.
  await page.click('a.destination[href="#/sparks"]');
  await page.waitForSelector('tbody a');
  await page.locator('tbody a').first().click();
  await page.waitForSelector('.entete-entite');
  await page.click('.onglet[href$="/routes"]');
  await page.waitForFunction(() => /\/routes$/.test(location.hash));
  const avant = await hash();

  // Le cas rapporté : changer de Forge depuis cette fenêtre.
  await page.selectOption('#selecteur-serveur', 'local-bis');
  await page.waitForFunction(() => location.hash === '#/sparks', null, { timeout: 15000 });
  await page.waitForSelector('tbody a');
  assert.equal(await hash(), '#/sparks', `quitté ${avant} pour la liste`);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, 'spk180-apres-changement.jpg'), type: 'jpeg', quality: 82 });

  // Une section de la Forge, elle, est gardée et relue.
  await page.click('nav a[href="#/forge"]');
  await page.click('.onglet[href="#/forge/mises-a-jour"]');
  await page.waitForSelector('#titre-paquets');
  await page.selectOption('#selecteur-serveur', 'local');
  await page.waitForSelector('#titre-paquets', { timeout: 15000 });
  assert.equal(await hash(), '#/forge/mises-a-jour');
});
