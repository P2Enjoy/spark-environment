/**
 * Captures du panneau « Installer cette Forge » contre une Forge RÉELLE.
 *
 * @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.2 bis (le relevé conclut),
 *           §50.4 (le plan reprend la configuration déclarée) ·
 *           docs/DESIGN_SYSTEM_APP.md#SPK-DS-12 · CLAUDE.md §16
 *
 * Le parcours part de l'accueil et n'atteint le panneau que par des clics :
 * aucune URL profonde, aucun appel d'API en contournement. Il ne peut donc pas
 * tourner sur un faux serveur — c'est le point.
 *
 *   SPARK_CONSOLE_URL=http://127.0.0.1:5179 \
 *   SPARK_SORTIE=e2e/captures node e2e/forge-conformite.mjs
 *
 * Le relevé qu'il déclenche est strictement en lecture seule (§50.2) : ce script
 * n'écrit rien sur la Forge et n'engage aucun plan.
 */

import { chromium } from 'playwright';
import { join } from 'node:path';

const BASE = process.env.SPARK_CONSOLE_URL ?? 'http://127.0.0.1:5178';
const SORTIE = process.env.SPARK_SORTIE;

const navigateur = await chromium.launch();
const page = await navigateur.newPage();
const bruits = [];
const RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type()) && !RESEAU.test(m.text())) bruits.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

const shot = async (nom, cible = null) => {
  const ou = { path: join(SORTIE, `${nom}.jpg`), type: 'jpeg', quality: 82 };
  await (cible ? page.locator(cible).screenshot(ou) : page.screenshot({ ...ou, fullPage: true }));
  console.log('  ' + nom + '.jpg');
};

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('accueil:', await page.title(), '|', (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' / '));
await shot('spk68-00-accueil');

// Depuis l'accueil, on rejoint la Forge par la navigation, jamais par une URL.
const lienForge = page.getByRole('link', { name: /Forge/i }).first();
await lienForge.click();
await page.waitForTimeout(3000);
await shot('spk68-01-forge');

const bouton = page.getByRole('button', { name: /Diagnostiquer la Forge/i });
await bouton.scrollIntoViewIfNeeded();
await bouton.click();
await page.waitForSelector('text=Conformité constatée', { timeout: 60000 });
await page.waitForTimeout(800);
await shot('spk68-02-conformite-1440', 'section.installation');

const panneau = page.locator('section.installation');
console.log('--- panneau ---');
console.log((await panneau.innerText()).slice(0, 2600));

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await panneau.scrollIntoViewIfNeeded();
await shot('spk68-03-conformite-390', 'section.installation');

// Débordement horizontal : la page ne défile jamais latéralement (§8.1).
const deborde = await page.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth);
console.log('debordement horizontal 390px :', deborde);
console.log('bruits navigateur :', bruits.length ? bruits : 'aucun');
await navigateur.close();
