/**
 * SPK-98 — captures contre une Forge RÉELLE, à OBSERVER (CLAUDE.md §16).
 *
 * Même statut qu'`e2e/reel.mjs` : hors campagne, parce qu'il exige une vraie
 * Forge et une console d'exploitation en marche. Il se lance à la main —
 * `node e2e/spk98-captures.mjs` — avec la console sur `127.0.0.1:5175`. Les
 * Sparks qu'il ouvre sont ceux de la campagne du 2026-09-14 : `void-98`, d'une
 * famille SANS Docker, et `sso-p2enjoy`, le témoin qui en reçoit un. Les
 * preuves qui doivent tourner à chaque fois vivent, elles, dans
 * `e2e/parcours.test.mjs`.
 *
 * @verifies docs/BACKLOG.md#SPK-98 · docs/DESIGN_SYSTEM_APP.md SPK-DS-24
 *
 * Contre la Forge RÉELLE, depuis la page d'accueil et par des clics. Les deux
 * formats du design system : 1440 px et 390 px — c'est à 390 que les
 * débordements se voient, et c'est là qu'on les a trouvés par le passé.
 */
import { chromium } from 'playwright';

// SPK-106 · docs/DAT.md §29.8 : UNE seule épreuve à la fois sur ce poste.
// Ce script n'appelle pas `monterPile()` — il vise une console déjà servie —
// mais il lance quand même un Chromium, et deux Chromium restent deux Chromium.
// Le verrou est pris ICI, à l'import, donc avant la moindre allocation.
import { prendreLeVerrou } from './verrou.mjs';

prendreLeVerrou();


const BASE = 'http://127.0.0.1:5175';
// SPK-100 · CLAUDE.md §3 : préfixée comme toutes les autres, pour qu'un balayage
// des variables du dépôt ne puisse pas la manquer.
const SORTIE = process.env.SPARK_SORTIE || './e2e/captures';
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

  await ouvrir('void-98');
  await shot(`spk98-spark-sans-docker${suffixe}`);

  await page.click('nav a[href="#/forge"]');
  await page.waitForTimeout(900);
  await page.click('nav a[href="#/forge/images"]');
  await page.waitForTimeout(2000);
  await shot(`spk98-catalogue-capacites${suffixe}`);
}

// Le témoin qui garde Docker, à 1440.
await page.setViewportSize({ width: 1440, height: 1150 });
await ouvrir('sso-p2enjoy');
await shot('spk98-spark-avec-docker');

console.log(bruits.length ? bruits.slice(0, 4) : 'aucun bruit console');
await navigateur.close();
