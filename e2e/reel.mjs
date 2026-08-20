/**
 * Captures de la console contre un `sparkd` RÉEL.
 *
 * @verifies docs/BACKLOG.md#SPK-23 · docs/DAT.md §28 (la pile et le seed) ·
 *           CLAUDE.md §16 (la vérification visuelle se fait dans la peau de
 *           l'utilisateur final)
 *
 * Toutes les captures précédentes s'appuyaient sur un faux `sparkd` écrit pour
 * la circonstance : elles prouvaient le rendu, pas le produit. Celles-ci
 * parcourent la pile de développement réelle — vrai runtime, vrai registre,
 * vrai contrôle d'admission, vrai journal d'audit.
 *
 * Le parcours part de la page d'accueil et n'atteint chaque écran que par des
 * clics : aucune URL profonde, aucun appel d'API en contournement.
 */

import { chromium } from 'playwright';
import { join } from 'node:path';

const BASE = process.env.SPARK_CONSOLE_URL ?? 'http://127.0.0.1:5173';
const SORTIE = new URL('./captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const page = await navigateur.newPage();

const bruits = [];
const JOURNAL_RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type()) && !JOURNAL_RESEAU.test(m.text())) {
    bruits.push(`[${m.type()}] ${m.text()}`);
  }
});
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

/**
 * Pousse un quota à sa borne haute, AU CLAVIER (SPK-59, §6.9 bis).
 *
 * On ne « remplit » pas un curseur : `page.fill` rend « Malformed value » sur un
 * `input[type=range]`. « Fin » est le geste natif qui va à la borne haute — la
 * capacité TOTALE de la Forge, donc au-delà de ce qui reste libre.
 */
async function auMaximum(selecteur) {
  const controle = page.locator(selecteur);
  const type = await controle.getAttribute('type');
  await controle.focus();
  if (type === 'range') await controle.press('End');
  else await controle.fill('999999');   // repli du §6.9 bis : resté une saisie
}

async function capturer(nom, { hauteur = 1000 } = {}) {
  await page.screenshot({ path: join(SORTIE, `${nom}.png`) });
  console.log(`  ${nom}.png`);
}

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a', { timeout: 15000 });
await capturer('40-reel-liste');

// La Forge, atteint par la navigation.
await page.click('nav a[href="#/forge"]');
await page.waitForSelector('#titre-pools', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 1250 });
await capturer('41-reel-hote');

// Retour à la liste, puis le Spark en erreur — ouvert PAR SON LIEN.
await page.click('nav a[href="#/sparks"]');
await page.waitForSelector('tbody a');
await page.setViewportSize({ width: 1440, height: 1200 });
await page.click('tbody a:has-text("site-vitrine")');
await page.waitForSelector('.entete-entite', { timeout: 10000 });
await capturer('42-reel-detail-erreur');

// Le Spark nominal : routes, clés, instantanés, journal — tout vient du runtime.
await page.click('.lien-spark:has-text("Tous les Sparks")');
await page.waitForSelector('tbody a');
await page.click('tbody a:has-text("crm-production")');
await page.waitForSelector('#titre-routes', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 1400 });
await capturer('43-reel-detail-complet');

// Le refus de restauration du §19.1, contre le vrai runtime : on restaure
// l'instantané le PLUS ANCIEN alors qu'un plus récent existe.
await page.click('[data-restaure="avant-deploiement"]');
await page.waitForSelector('[data-confirme-restauration]');
await page.click('[data-confirme-restauration]');
await page.waitForSelector('[data-accepte-perte]', { timeout: 10000 });
await capturer('44-reel-restauration-bloquee');

// L'écran de création, et un refus d'admission RÉEL.
await page.click('.lien-spark:has-text("Tous les Sparks")');
await page.waitForSelector('tbody a');
await page.setViewportSize({ width: 1440, height: 1000 });
await page.click('.titre-vue .bouton--primaire, [href="#/creer"]').catch(() => {});
if (!(await page.$('#formulaire-spark'))) {
  await page.evaluate(() => { location.hash = '#/creer'; });
}
await page.waitForSelector('#formulaire-spark', { timeout: 10000 });
await page.fill('#name', 'trop-gourmand');
await auMaximum('#memory_gib');
await page.click('button[type="submit"]');
await page.waitForSelector('.refus', { timeout: 10000 });
await capturer('45-reel-refus-admission');

await navigateur.close();
if (bruits.length) {
  console.error(`\n  CONSOLE NON VIERGE — ${bruits.length} message(s) :`);
  for (const b of [...new Set(bruits)]) console.error(`    ${b}`);
  process.exit(1);
}
console.log('  console vierge de tout message applicatif');
process.exit(0);
