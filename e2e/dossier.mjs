/**
 * Captures du dossier de déploiement, contre la pile RÉELLE.
 *
 * @verifies docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9.5 ·
 *           docs/BACKLOG.md#SPK-99 · docs/DAT.md §44.9.2 (point 4), §44.9.7 ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-19 ·
 *           docs/DESIGN_SYSTEM.md §13 (les captures sont une preuve), §13.1
 *           (desktop, mobile, état vide, contenu long, clavier) · CLAUDE.md §16
 *
 * Le harnais monte sa propre pile — vrai runtime, vrai registre, vrai seed —
 * puis parcourt l'écran EN CLIQUANT depuis l'accueil. Aucune URL profonde : ce
 * qu'on observe doit être ce qu'un exploitant atteint (§29.3).
 *
 * Les fichiers sont des JPEG : ils sont faits pour être REGARDÉS, y compris par
 * une capacité de vision, et non comparés pixel à pixel.
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

/** Depuis l'accueil, par un clic sur le nom du Spark. */
async function ouvrir(nom, { largeur = 1440, hauteur = 1400 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.dossier, .carte.bloc', { timeout: 10000 });
  await page.waitForSelector('[data-dossier-copie]', { timeout: 10000 });
}

await page.context().grantPermissions(['clipboard-read', 'clipboard-write'],
                                      { origin: pile.base });

/**
 * Amène une ligne du dossier sous les yeux, DANS le texte replié (SPK-99).
 *
 * Le `<pre>` a sa propre hauteur et son propre défilement (SPK-DS-18) : une
 * capture de la page ne montre que son début. Les deux ajouts du SPK-99 vivent
 * plus bas, et une capture qui ne les montre pas ne prouve rien d'eux.
 */
async function defilerVers(fragment) {
  await page.evaluate((cherche) => {
    const pre = document.querySelector('.dossier__texte');
    const index = pre.textContent.indexOf(cherche);
    if (index < 0) throw new Error(`fragment absent du dossier : ${cherche}`);
    const plage = document.createRange();
    plage.setStart(pre.firstChild, index);
    plage.setEnd(pre.firstChild, index + 1);
    pre.scrollTop += plage.getBoundingClientRect().top
                     - pre.getBoundingClientRect().top - 12;
  }, fragment);
}

/** Amorce un Spark par le geste de l'écran, jamais par un appel d'API. */
async function amorcer(nom) {
  await ouvrir(nom);
  await page.click('[data-amorcage="amorcer"]');
  await page.waitForSelector('[data-amorcage="engager"]', { timeout: 10000 });
  await page.click('[data-amorcage="engager"]');
  await page.waitForSelector('.liste-amorcage', { timeout: 20000 });
}

// Le seed n'amorce aucun Spark : les parcours de SPK-54 exigent une cellule que
// rien n'a amorcée. On amorce donc ici, par le geste de l'écran, pour observer un
// dossier COMPLET — l'autre état a sa propre capture, plus bas.
await amorcer('crm-production');

// 1. La section repliée, au format bureau : ce qu'on voit sans rien faire.
await ouvrir('crm-production');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk85-01-section-repliee');

// 2. Dépliée : le texte qu'on vérifie AVANT de le coller. Contenu long, donc le
//    cas du §13.1 — un pavé de Markdown dans une colonne étroite.
await page.click('.dossier .repli > summary');
await page.waitForSelector('.dossier__texte', { timeout: 8000 });
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk85-02-texte-deplie');

// 3. Après la copie : le vert ne s'écrit qu'une fois le presse-papier d'accord.
await page.click('.dossier [data-dossier-copie]');
await page.waitForSelector('.dossier .succes', { timeout: 8000 });
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk85-03-copie');

// 3 bis. SPK-99 · §44.9.2 point 4 : la ligne qui lit le briefing sans ouvrir de
//         shell. Un agent qui entre par `ssh hôte 'commande'` ne voit aucun
//         `motd`, donc rien ne lui dit que ce fichier existe.
await defilerVers('Lire le briefing de la cellule sans ouvrir de shell');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk99-01-lecture-briefing');

// 3 ter. SPK-99 · §44.9.7 : le bloc que l'agent rend au propriétaire, et la
//        raison pour laquelle il ne peut pas poser la variable lui-même.
await defilerVers('Il en manque une pour votre pile');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk99-02-bloc-variables');

// 3 quater. SPK-101 · §44.2 bis : le chemin par lequel on atteint la pile. Un
//           agent réel, faute de ces phrases, a inventé une procédure entière.
await defilerVers('Une route active est un chemin complet');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk101-01-chemin-ingress');

// 4. Le focus clavier sur le bouton : l'anneau doit être visible (§9.5).
await defilerVers('# Dossier de déploiement');
await page.keyboard.press('Shift+Tab');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk85-04-focus-clavier');

// 5. Un Spark jamais amorcé : l'AUTRE état, celui d'une cellule neuve (§14.6).
await ouvrir('boutique');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk85-05-jamais-amorce');

// 6. Le format étroit. Le texte se replie au lieu de déborder (SPK-DS-15/18), et
//    la page ne défile jamais horizontalement (§8.1).
await ouvrir('crm-production', { largeur: 390, hauteur: 1600 });
await page.click('.dossier .repli > summary');
await page.waitForSelector('.dossier__texte', { timeout: 8000 });
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk85-06-mobile');

// 7. Le bloc `.env` au format étroit : ses lignes sont les plus longues du
//    texte, et c'est là qu'un débordement se verrait (SPK-99). On vise le bloc
//    lui-même et non son titre — c'est `AUTRE_VARIABLE="…"` qu'il faut voir.
await defilerVers('NOM_DE_VARIABLE=valeur');
await page.locator('.dossier').scrollIntoViewIfNeeded();
await capturer('spk99-03-bloc-variables-mobile');

const debordement = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth);

await navigateur.close();
await pile.demonter();

console.log(`\n  débordement horizontal de la page : ${debordement ? 'OUI' : 'non'}`);
if (bruits.length) {
  console.error(`\n  CONSOLE NON VIERGE — ${bruits.length} message(s) :`);
  for (const b of [...new Set(bruits)]) console.error(`    ${b}`);
  process.exit(1);
}
console.log('  console vierge de tout message applicatif');
process.exit(debordement ? 1 : 0);
