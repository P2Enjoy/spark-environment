/**
 * Captures du dépôt d'images lu en direct, et du retrait (SPK-92).
 *
 * @verifies docs/BACKLOG.md#SPK-92 · docs/DAT.md §33.6, §33.7 ·
 *           docs/DESIGN_SYSTEM.md §13.1 (ce qu'il faut vérifier), §13.2 (les
 *           captures sont une preuve) · CLAUDE.md §16 (la vérification visuelle
 *           se fait dans la peau de l'utilisateur final)
 *
 * Le harnais monte SA pile (§29.2), et le parcours part de l'accueil : aucune
 * URL profonde, aucun appel d'API pour arriver quelque part. Ce qui est capturé
 * est ce qu'un exploitant voit après avoir cliqué.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { monterPile } from './pile.mjs';

const SORTIE = new URL('./captures/', import.meta.url).pathname;
await mkdir(SORTIE, { recursive: true });

const pile = await monterPile({});
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

const prendre = async (nom) => {
  await page.screenshot({ path: join(SORTIE, `spk92-${nom}.jpg`), type: 'jpeg',
                          quality: 82, fullPage: true });
  console.log(`capture : spk92-${nom}.jpg`);
};

async function allerAuCatalogue() {
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click('nav a[href="#/forge"]');
  await page.waitForSelector('.onglets', { timeout: 10000 });
  await page.click('.onglet[href="#/forge/images"]');
  await page.waitForSelector('#titre-catalogue', { timeout: 10000 });
}

// --- grand écran -------------------------------------------------------------
await page.setViewportSize({ width: 1440, height: 1300 });
await allerAuCatalogue();
await prendre('catalogue');

await page.click('[data-ouvre="depot"]');
await page.waitForSelector('dialog.modale[open] #depot-filtre', { timeout: 15000 });
// L'engagement est PRÉSENT et désactivé, sa raison lisible sous lui (§9.9).
await prendre('depot-ouvert');

// Les familles sont repliées : on en déplie une non amorçable, pour voir que
// l'annonce du §42.9.6 ne l'empêche pas d'être proposée.
await page.click('.depot-famille:has-text("alpine") > summary');
await prendre('depot-famille-non-amorcable');

// La recherche par nom de code, que l'alias ne porte pas.
await page.fill('#depot-filtre', 'bullseye');
await page.waitForSelector('[data-coche="images:debian/11"]', { timeout: 10000 });
await page.check('[data-coche="images:debian/11"]');
await prendre('depot-coche');

// Une recherche sans résultat NOMME l'absence (§14.5).
await page.fill('#depot-filtre', 'zzz-inexistante');
await page.waitForSelector('.etat-vue', { timeout: 10000 });
await prendre('depot-sans-resultat');

// On revient au coché, et l'on pose le lot.
await page.fill('#depot-filtre', 'bullseye');
await page.waitForSelector('[data-coche="images:debian/11"]', { timeout: 10000 });
await page.click('dialog.modale[open] [data-engage="depot"]');
await page.waitForSelector('tbody tr:has-text("images:debian/11")', { timeout: 15000 });
await prendre('catalogue-apres-ajout');

// Le refus du retrait, qui NOMME les Sparks (§33.7).
await page.click('tr:has-text("images:ubuntu/24.04") [data-retire]');
await page.click('[data-confirme-retrait]');
await page.waitForSelector('.confirmation--sensible .refus', { timeout: 15000 });
await prendre('retrait-refus');

// La confirmation seule, en accent — SPK-DS-09.
await page.click('[data-annule-retrait]');
await page.click('tr:has-text("images:debian/11") [data-retire]');
await page.waitForSelector('.confirmation--sensible', { timeout: 10000 });
await prendre('retrait-confirmation');

// --- le clavier, et le focus (§9.1, §14.3) ----------------------------------
await page.keyboard.press('Tab');
const focus = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 90));
console.log('focus après Tab dans la confirmation :', focus);
await page.click('[data-confirme-retrait]');
await page.waitForFunction(
  () => !document.body.innerText.includes('images:debian/11'), { timeout: 15000 });
await prendre('catalogue-apres-retrait');

// --- le dépôt injoignable (§33.6, le repli obligatoire) ---------------------
//
// La panne est INJECTÉE au niveau du navigateur, et le corps injecté est
// exactement celui que `sparkd` rend — `test_un_depot_injoignable_rend_un_502_qui_le_NOMME`
// le prouve côté serveur. On observe ici ce que la console EN FAIT : nommer la
// cause, et laisser la saisie libre utilisable.
await page.setViewportSize({ width: 1440, height: 1300 });
await page.route('**/api/v1/images/depot*', (route) => route.fulfill({
  status: 502, contentType: 'application/json',
  body: JSON.stringify({ detail: {
    error: 'depot_unreachable',
    message: "Le depot d'images n'a pas repondu : "
      + '[Errno -3] Temporary failure in name resolution',
  } }),
}));
await allerAuCatalogue();
await page.click('[data-ouvre="depot"]');
await page.waitForSelector('dialog.modale[open] .etat-vue--erreur', { timeout: 15000 });
await prendre('depot-injoignable');
await page.unroute('**/api/v1/images/depot*');

// Le repli EST utilisable : la saisie libre s'ouvre et accepte une référence.
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('dialog.modale[open]'),
                           { timeout: 10000 });
await page.click('[data-ouvre="image"]');
await page.waitForSelector('dialog.modale[open] #image-reference', { timeout: 10000 });
await prendre('repli-saisie-libre');
await page.keyboard.press('Escape');

// --- tablette et mobile (§8) -------------------------------------------------
await page.setViewportSize({ width: 768, height: 1100 });
await allerAuCatalogue();
await prendre('catalogue-tablette');
await page.click('[data-ouvre="depot"]');
await page.waitForSelector('dialog.modale[open]', { timeout: 15000 });
await page.click('.depot-famille:has-text("debian") > summary');
await prendre('depot-tablette');

await page.setViewportSize({ width: 390, height: 900 });
await allerAuCatalogue();
await prendre('catalogue-mobile');
await page.click('[data-ouvre="depot"]');
await page.waitForSelector('dialog.modale[open]', { timeout: 15000 });
await page.click('.depot-famille:has-text("debian") > summary');
await prendre('depot-mobile');

// La page ne défile JAMAIS horizontalement (§8.1).
const debordement = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('débordement horizontal en 390 px :', debordement, 'px');

await navigateur.close();
await pile.arreter?.();
console.log(bruits.length ? `BRUITS : ${bruits.join(' | ')}` : 'aucun bruit console');
process.exit(0);
