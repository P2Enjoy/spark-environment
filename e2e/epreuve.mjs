/**
 * Captures du bandeau d'épreuve, contre la pile RÉELLE du harnais.
 *
 * @verifies docs/BACKLOG.md#SPK-100 · docs/DAT.md §53.3 (l'interrupteur se voit
 *           à l'écran) · docs/DESIGN_SYSTEM.md §13 (les captures sont une
 *           preuve), §13.1 (desktop et mobile) · CLAUDE.md §16
 *
 * Cette pile EST doublée — `monterPile` pose `SPARK_EPREUVE=1` —, donc le
 * bandeau y est visible. C'est la seule façon de le photographier : une console
 * d'exploitation, par construction, n'en affiche aucun.
 */

import { chromium } from 'playwright';
import { join } from 'node:path';

import { monterPile } from './pile.mjs';

const SORTIE = new URL('./captures/', import.meta.url).pathname;

const pile = await monterPile();
const navigateur = await chromium.launch();
const page = await navigateur.newPage();

// Le bandeau vit dans la COQUILLE : l'accueil suffit à le montrer, et c'est
// justement le premier écran qu'un exploitant voit.
for (const [nom, largeur, hauteur] of [
  ['spk100-01-bandeau', 1440, 1200],
  ['spk100-02-bandeau-mobile', 390, 1400],
]) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.entete__epreuve .avertissement', { timeout: 15000 });
  // La liste des Sparks est attendue : une capture prise sur les squelettes de
  // chargement ne montrerait pas l'écran dans lequel le bandeau s'insère.
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.screenshot({ path: join(SORTIE, `${nom}.jpg`), type: 'jpeg',
                          quality: 82, fullPage: true });
  console.log(`  ${nom}.jpg`);
}

const debordement = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth);

await navigateur.close();
await pile.demonter();

console.log(`\n  débordement horizontal de la page : ${debordement ? 'OUI' : 'non'}`);
process.exit(debordement ? 1 : 0);
