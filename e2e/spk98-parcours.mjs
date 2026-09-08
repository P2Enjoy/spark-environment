/**
 * Parcours canonique SPK-98 : depuis la page d'accueil, à la souris.
 *
 * @verifies docs/BACKLOG.md#SPK-98 · docs/DAT.md §42.11, §42.13 ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-24 · CLAUDE.md §16
 *
 * Aucune URL profonde saisie à la main, aucun appel d'API en contournement :
 * on part de la liste et l'on n'atteint chaque écran que par des clics.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5175';
const SORTIE = process.env.SORTIE || '.';
const navigateur = await chromium.launch();
const page = await navigateur.newPage();
await page.setViewportSize({ width: 1440, height: 1100 });

const bruits = [];
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of \d{3}/.test(m.text())) bruits.push(`[console] ${m.text()}`);
});

const shot = async (n) => { await page.screenshot({ path: `${SORTIE}/${n}.png` }); };
const onglets = () => page.locator('nav[aria-label^="Facettes"] a').allTextContents();

async function ouvrir(nom) {
  await page.click('nav a[href="#/sparks"]');
  await page.waitForSelector('tbody a', { timeout: 15000 });
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 15000 });
  await page.waitForTimeout(1200);
}

// --- Le Spark SANS Docker : l'onglet n'est pas construit -------------------
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a', { timeout: 20000 });

await ouvrir('val-alpine');
const sans = await onglets();
console.log('val-alpine (Alpine) — onglets :', sans.join(' · '));
console.log('  Docker présent ?', sans.includes('Docker'));
await shot('spk98-alpine-sans-docker');

// La raison, dite une fois, dans le panneau d'amorçage.
const raison = await page.locator('#titre-amorcage').locator('..').textContent();
console.log('  raison dite :', /ne reçoit pas Docker/.test(raison));

// --- L'adresse de la facette retirée ne mène nulle part --------------------
// Un favori pris sur un autre Spark. On l'écrit dans la barre, ce qui est ce
// qu'un utilisateur ferait en rouvrant un signet — pas un contournement d'API.
await page.evaluate(() => { window.location.hash = '#/sparks/val-alpine/docker'; });
await page.waitForTimeout(1500);
const apresFavori = await page.locator('h2').allTextContents();
console.log('  favori #/docker → titres rendus :', apresFavori.join(' | '));
await shot('spk98-alpine-favori-docker');

// --- Le Spark AVEC Docker : rien ne lui a été retiré ------------------------
await ouvrir('sso-p2enjoy');
const avec = await onglets();
console.log('sso-p2enjoy (Ubuntu) — onglets :', avec.join(' · '));
console.log('  Docker présent ?', avec.includes('Docker'));
await shot('spk98-ubuntu-avec-docker');

// --- Le catalogue d'images annonce les capacités par famille ---------------
await page.click('nav a[href="#/forge"]');
await page.waitForTimeout(800);
await page.click('nav a[href="#/forge/images"]');
await page.waitForTimeout(1500);
await shot('spk98-catalogue');

console.log(bruits.length ? bruits.slice(0, 5) : 'aucun bruit console');
await navigateur.close();
