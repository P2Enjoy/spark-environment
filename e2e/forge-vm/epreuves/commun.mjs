/**
 * Ce que partagent les épreuves jouées contre la console branchée sur la VM du
 * banc.
 *
 * @spec docs/BACKLOG.md#SPK-137 · docs/DAT.md §51.6 (tout se crée par la
 *       console, depuis l'accueil, souris et clavier ; les captures s'observent)
 *       · CLAUDE.md §15 bis (le verrou, pris à l'import), §16
 *
 * Une épreuve est importée par `redemarrage.mjs`, qui tient déjà le verrou des
 * épreuves lourdes : le reprendre ici est sans effet dans ce processus (le
 * verrou est réentrant pour son porteur), et refusé à tout autre processus.
 */
import { prendreLeVerrou } from '../../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CAPTURES = new URL('../../captures/', import.meta.url).pathname;

/** Un navigateur neuf, et une page qui relève ce que la console écrit d'anormal. */
export async function ouvrirNavigateur() {
  const navigateur = await chromium.launch();
  const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
  const bruits = [];
  page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));
  // Le journal RÉSEAU de Chromium n'est pas un message de l'application : un
  // refus attendu (423, 502) y écrit « Failed to load resource » (DAT §29.6).
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      bruits.push(`[console] ${m.text()}`);
    }
  });
  return { navigateur, page, bruits };
}

/** Une capture JPEG dans `e2e/captures/`, pour être OBSERVÉE (CLAUDE.md §16). */
export async function capturer(page, nom, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(500);
  await mkdir(CAPTURES, { recursive: true });
  const chemin = join(CAPTURES, `${nom}.jpg`);
  await page.screenshot({ path: chemin, type: 'jpeg', quality: 82, fullPage: true });
  return chemin;
}

/** L'accueil de la console, et le tunnel ouvert vers la VM. */
export async function accueil(page, url) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 60000 });
}

/** Un Spark ouvert PAR SON LIEN dans la liste, puis une de ses facettes. */
export async function ouvrirSpark(page, url, nom, facette = '') {
  await accueil(page, url);
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 20000 });
  if (facette) {
    await page.click(`.onglet[href$="/${facette}"]`);
    await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`,
                               { timeout: 20000 });
  }
}

/** Attendre qu'un texte apparaisse dans une zone, ou échouer en le disant. */
export async function attendreTexte(page, selecteur, motif, delai = 60000) {
  await page.waitForFunction(
    ({ s, m }) => new RegExp(m).test(document.querySelector(s)?.innerText ?? ''),
    { s: selecteur, m: motif.source ?? motif }, { timeout: delai });
}
