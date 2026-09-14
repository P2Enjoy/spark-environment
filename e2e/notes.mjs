/**
 * Captures de la facette « Notes », contre la pile RÉELLE.
 *
 * @verifies docs/BACKLOG.md#SPK-104 · docs/DAT.md §54.10 (ce que la console en
 *           fait) · docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.5, §55.9 ·
 *           docs/DESIGN_SYSTEM.md §13 (les captures sont une preuve), §13.1
 *           (desktop, mobile, état vide, contenu long, clavier) · CLAUDE.md §16
 *
 * Le harnais monte sa propre pile — vrai runtime, vrai registre, vrai seed —
 * puis parcourt l'écran EN CLIQUANT depuis l'accueil. Aucune URL profonde : ce
 * qu'on observe doit être ce qu'un exploitant atteint (§29.3).
 *
 * Ce que ces captures doivent montrer, et qu'aucune preuve de rendu ne montre :
 * les trois états d'une note côte à côte, une proposition lisible À CÔTÉ du
 * texte qu'elle remplacerait, et le tout à 390 px sans débordement.
 */

import { chromium } from 'playwright';
import { join } from 'node:path';

import { monterPile } from './pile.mjs';

const SORTIE = new URL('./captures/', import.meta.url).pathname;

const pile = await monterPile();
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

async function capturer(nom, { pleine = true } = {}) {
  await page.screenshot({ path: join(SORTIE, `${nom}.jpg`), type: 'jpeg',
                          quality: 82, fullPage: pleine });
  console.log(`  ${nom}.jpg`);
}

/** Depuis l'accueil, par des CLICS : le nom du Spark, puis l'onglet. */
async function ouvrirNotes(nom, { largeur = 1440, hauteur = 1600 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.onglets', { timeout: 10000 });
  await page.click('.onglets a:has-text("Notes")');
  await page.waitForSelector('.note-carte', { timeout: 20000 });
  // La lecture de la cellule part après la peinture : on attend qu'elle ait
  // rendu son verdict, sinon la capture montrerait un écran à moitié informé.
  await page.waitForFunction(
    () => !document.body.innerText.includes('Lecture des notes'),
    { timeout: 20000 });
}

console.log('Captures de la facette Notes :');

// --- 1. Les trois états d'une note, et une proposition en attente -----------
await ouvrirNotes('crm-production');
await capturer('spk104-notes-facette');

// --- 2. La proposition DÉPLIÉE, à côté du texte qu'elle remplacerait --------
// C'est le point du §55.9 : accepter un remplacement intégral sans voir ce
// qu'on remplace serait décider à l'aveugle. Une capture repliée ne le
// prouverait pas.
await page.click('.proposition .repli summary');
await page.waitForSelector('.proposition .repli[open]', { timeout: 5000 });
await capturer('spk104-notes-proposition');

// --- 3. La saisie au CLAVIER, touche à touche (§14.3) -----------------------
// Le §14.3 a mesuré qu'un champ reconstruit à chaque frappe écrit à l'envers.
// `fill()` ne l'attraperait pas : il pose la valeur d'un coup.
const zone = page.locator('[data-note-saisie="install"]');
await zone.click();
await page.keyboard.type('Points d’entrée : ');
await page.keyboard.type('https://crm.interne.example/api/v1');
const saisi = await zone.inputValue();
if (!saisi.endsWith('https://crm.interne.example/api/v1')) {
  throw new Error(`la frappe est arrivée dans le désordre : « ${saisi} »`);
}
await capturer('spk104-notes-saisie');

// --- 4. Un Spark SANS aucune note : l'état vide, qui doit appeler à écrire ---
await ouvrirNotes('boutique');
await capturer('spk104-notes-vide');

// --- 5. Mobile : 390 px, sans débordement horizontal ------------------------
await ouvrirNotes('crm-production', { largeur: 390, hauteur: 1800 });
const deborde = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
if (deborde) throw new Error('débordement horizontal à 390 px');
await capturer('spk104-notes-mobile');

if (bruits.length) {
  console.error('Console du navigateur NON SILENCIEUSE :');
  for (const b of bruits) console.error(`  ${b}`);
}

await navigateur.close();
await pile.demonter();
if (bruits.length) process.exit(1);
console.log('Captures produites. À OBSERVER (CLAUDE.md §16).');
