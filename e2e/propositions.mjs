/**
 * Captures des propositions déposées dans la cellule, contre la pile RÉELLE.
 *
 * @verifies docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.5 (consulter ne consomme
 *           pas), §55.9 (là où le geste se conclut) ·
 *           docs/DESIGN_SYSTEM.md §13 (les captures sont une preuve), §13.1 ·
 *           CLAUDE.md §16
 *
 * Le harnais parcourt l'écran EN CLIQUANT depuis l'accueil (§29.3). Il fait
 * plus que photographier : il **accepte partiellement** une proposition et
 * vérifie les trois effets — ce qui est entré au registre, ce qui ne l'est pas,
 * et le fichier de la cellule vidé.
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

async function capturer(nom) {
  await page.screenshot({ path: join(SORTIE, `${nom}.jpg`), type: 'jpeg',
                          quality: 82, fullPage: true });
  console.log(`  ${nom}.jpg`);
}

async function ouvrir(nom, onglet, { largeur = 1440, hauteur = 1500 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.onglets', { timeout: 10000 });
  await page.click(`.onglets a:has-text("${onglet}")`);
  await page.waitForSelector('.proposition, .carte.bloc', { timeout: 20000 });
}

console.log('Captures des propositions :');

// --- 1. La bannière, sur la facette qui porte l'objet -----------------------
await ouvrir('crm-production', 'Environnement');
await page.waitForSelector('[data-sugg-ouvrir="variables"]', { timeout: 20000 });
await capturer('spk105-proposition-banniere');

// --- 2. La relecture ligne par ligne ---------------------------------------
await page.click('[data-sugg-ouvrir="variables"]');
await page.waitForSelector('[data-sugg-garder="variables"]', { timeout: 10000 });
await page.locator('.proposition').scrollIntoViewIfNeeded();
await capturer('spk105-proposition-relecture');

// --- 3. Une acceptation PARTIELLE, et ses trois effets ----------------------
// C'est le point du §55.5 : ce qui n'a pas été retenu est REFUSÉ, pas ajourné,
// et le fichier est vidé quand même.
await page.uncheck('[data-sugg-garder="variables"][data-ligne="2"]');
const libelle = await page.textContent('[data-sugg-appliquer="variables"]');
if (!libelle.includes('1 retenue')) {
  throw new Error(`le bouton ne compte pas les retenues : « ${libelle} »`);
}
await page.click('[data-sugg-appliquer="variables"]');
// Le compte rendu doit SURVIVRE à la proposition qu'il décrit : on attend que
// l'écran soit relu — le tableau de relecture a disparu — ET que la
// confirmation soit encore là. Attendre le seul message aurait attrapé l'état
// transitoire d'avant la relecture, et laissé passer le défaut.
await page.waitForFunction(
  () => !document.querySelector('[data-sugg-appliquer]')
        && /Proposition appliquée/.test(document.body.innerText),
  { timeout: 20000 });
await capturer('spk105-proposition-appliquee');

const vu = await page.textContent('body');
if (!vu.includes('REDIS_URL')) {
  throw new Error('la ligne retenue n’est pas entrée au registre');
}
if (vu.includes('SESSION_TTL')) {
  throw new Error('la ligne ÉCARTÉE est entrée au registre : le §55.5 est violé');
}

// Le troisième effet, invisible à l'écran : le fichier de la cellule est vidé.
const { corps } = await pile.lireSparkd('/v1/sparks/crm-production/suggestions');
const variables = corps.suggestions.find((s) => s.kind === 'variables');
if (variables.present) {
  throw new Error('le fichier `.?` n’a pas été vidé après la décision');
}
// Et celui des routes, que personne n'a touché, est INTACT : une décision ne
// consomme que la proposition qu'elle vise.
const routes = corps.suggestions.find((s) => s.kind === 'routes');
if (routes.present) throw new Error('la proposition de routes a été consommée par erreur');

// --- 4. Mobile : 390 px, sans débordement ----------------------------------
await ouvrir('crm-production', 'Notes', { largeur: 390, hauteur: 1800 });
await page.waitForSelector('.note-carte', { timeout: 20000 });
const deborde = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
if (deborde) throw new Error('débordement horizontal à 390 px');
await capturer('spk105-proposition-mobile');

if (bruits.length) {
  console.error('Console du navigateur NON SILENCIEUSE :');
  for (const b of bruits) console.error(`  ${b}`);
}

await navigateur.close();
await pile.demonter();
if (bruits.length) process.exit(1);
console.log('Captures produites. À OBSERVER (CLAUDE.md §16).');
