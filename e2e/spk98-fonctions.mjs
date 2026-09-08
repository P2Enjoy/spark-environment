/**
 * SPK-98 — les fonctions de base d'un Spark SANS Docker, à la souris.
 *
 * @verifies docs/BACKLOG.md#SPK-98 · docs/DAT.md §42.11, §42.12 ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-24 · CLAUDE.md §16
 *
 * Le point : retirer Docker ne doit RIEN retirer d'autre. On éprouve donc, sur
 * une cellule Alpine, ce qu'un locataire fait tous les jours — le terminal,
 * l'identité, les variables — depuis la page d'accueil et par des clics.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5175';
const SORTIE = process.env.SORTIE || '.';
const SPARK = process.env.SPARK || 'val-alpine';
const navigateur = await chromium.launch();
const page = await navigateur.newPage();
await page.setViewportSize({ width: 1440, height: 1100 });
const bruits = [];
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

const shot = async (n) => { await page.screenshot({ path: `${SORTIE}/${n}.png` }); };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a', { timeout: 20000 });
await page.click(`tbody a:has-text("${SPARK}")`);
await page.waitForSelector('.entete-entite', { timeout: 15000 });

// --- L'amorçage DEPUIS la console : il accorde la clé du poste (SPK-82) ------
// C'est le geste canonique. Le faire ici plutôt que d'accorder la clé à part
// éprouve les deux d'un coup : l'amorçage d'une famille sans Docker, et la
// porte qu'il ouvre.
const amorcer = page.locator('button:has-text("Amorcer ce Spark")').first();
if (await amorcer.count()) {
  await amorcer.click();
  await page.waitForTimeout(1200);
  const engager = page.locator('[data-amorcage="engager"]').first();
  if (await engager.count()) { await engager.click(); await page.waitForTimeout(12000); }
}
const compteRendu = await page.locator('main').textContent();
console.log('amorçage — complète ?', /cellule est complète/.test(compteRendu));
console.log('amorçage — clé accordée ?', /accordée à/.test(compteRendu));
await shot('spk98-amorcage-alpine');

await page.click('nav[aria-label^="Facettes"] a:has-text("Terminal")');
await page.waitForTimeout(1500);
const ouvrir = page.locator('button:has-text("Ouvrir")').first();
if (await ouvrir.count()) { await ouvrir.click(); await page.waitForTimeout(9000); }
const ecran = await page.locator('main').first().textContent();
console.log('terminal — extrait :', (ecran || '').replace(/\s+/g, ' ').slice(0, 240));
await shot('spk98-terminal-sans-docker');

await page.click('nav[aria-label^="Facettes"] a:has-text("Clés")');
await page.waitForTimeout(2500);
const identite = await page.locator('main').textContent();
console.log('identité — empreinte affichée ?', /SHA256:/.test(identite));
await shot('spk98-cles-et-identite');

await page.click('nav[aria-label^="Facettes"] a:has-text("Environnement")');
await page.waitForTimeout(2500);
const env = await page.locator('main').textContent();
console.log('variables — APP_PORT visible ?', /APP_PORT/.test(env));
console.log('variables — CAMPAGNE_FORGE visible ?', /CAMPAGNE_FORGE/.test(env));
await shot('spk98-environnement');

console.log(bruits.length ? bruits.slice(0, 4) : 'aucun bruit console');
await navigateur.close();
