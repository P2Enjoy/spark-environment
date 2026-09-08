/**
 * SPK-98 — captures de la campagne, à OBSERVER (CLAUDE.md §16).
 *
 * @verifies docs/BACKLOG.md#SPK-98 · docs/DESIGN_SYSTEM_APP.md SPK-DS-24
 *
 * Contre la Forge RÉELLE, depuis la page d'accueil et par des clics. Les deux
 * formats du design system : 1440 px et 390 px — c'est à 390 que les
 * débordements se voient, et c'est là qu'on les a trouvés par le passé.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5175';
const SORTIE = process.env.SORTIE || './e2e/captures';
const navigateur = await chromium.launch();
const page = await navigateur.newPage();
const bruits = [];
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

const shot = async (n) => {
  await page.screenshot({ path: `${SORTIE}/${n}.jpg`, type: 'jpeg', quality: 82 });
  console.log(`  ${n}.jpg`);
};

async function ouvrir(nom) {
  await page.click('nav a[href="#/sparks"]');
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 20000 });
  await page.waitForTimeout(1500);
}

for (const [largeur, hauteur, suffixe] of [[1440, 1150, ''], [390, 1000, '-mobile']]) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });

  await ouvrir('val-alpine');
  await shot(`spk98-spark-sans-docker${suffixe}`);

  await page.click('nav a[href="#/forge"]');
  await page.waitForTimeout(900);
  await page.click('nav a[href="#/forge/images"]');
  await page.waitForTimeout(2000);
  await shot(`spk98-catalogue-capacites${suffixe}`);
}

// Le témoin qui garde Docker, à 1440.
await page.setViewportSize({ width: 1440, height: 1150 });
await ouvrir('val-debian');
await shot('spk98-spark-avec-docker');

console.log(bruits.length ? bruits.slice(0, 4) : 'aucun bruit console');
await navigateur.close();
