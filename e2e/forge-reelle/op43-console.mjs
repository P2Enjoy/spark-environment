/**
 * OP-43, part de la console, par le parcours canonique : la console d'exploitation
 * se redémarre par son propre geste, puis montre ce que SPK-171 et SPK-172 livrent.
 *
 * @verifies docs/BACKLOG.md#SPK-172 · docs/DAT.md §70.3 (la colonne Signature
 *           de la console d'exploitation) · docs/BACKLOG.md#SPK-171 · docs/DAT.md
 *           §70.5 · docs/BACKLOG.md#SPK-117 · docs/DAT.md §62 (le redémarrage
 *           depuis la console) · docs/PROD_MIGRATIONS.md OP-43 · CLAUDE.md §16
 *
 * Le redémarrage n'est ENGAGÉ que si la confirmation dit qu'aucune session de
 * terminal n'est ouverte : couper le terminal de l'exploitant n'est pas une preuve.
 * Les captures masquent les adresses et les domaines (le dépôt est public).
 *
 *   node e2e/forge-reelle/op43-console.mjs          # vise sparkui, port 5175
 */
// CLAUDE.md §15 bis : ce script lance un Chromium. Le verrou est pris à l'import.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const verdicts = [];
const verdict = (nom, ok, detail) => { verdicts.push(ok); console.log(`${ok ? 'VERT ' : 'ROUGE'} ${nom} — ${detail}`); };

async function capturer(nom, masques, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(600);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82,
                          fullPage: true, mask: masques.map((m) => page.locator(m)) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`capture : ${nom}.jpg`);
}

try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  const ouvrir = page.locator('[data-relance="ouvrir"]');
  await page.waitForTimeout(3000);
  if (await ouvrir.count()) {
    await ouvrir.click();
    const bloc = await page.locator('[data-relance="bloc"]').innerText();
    if (!/Aucune session de terminal n’est ouverte/.test(bloc)) {
      await page.click('[data-relance="annuler"]');
      throw new Error(`des sessions de terminal sont ouvertes, redémarrage ANNULÉ : ${bloc.replace(/\s+/g, ' ')}`);
    }
    await page.click('[data-relance="engager"]');
    // La page se recharge seule quand la nouvelle console répond (§62.4).
    await page.waitForFunction(() => !document.querySelector('[data-relance="bloc"]'), null, { timeout: 90000 });
    await page.waitForTimeout(4000);
    verdict('la console s’est redémarrée par son geste', true, 'aucune session coupée');
  } else {
    verdict('la console n’avait pas de code périmé à relancer', true, 'aucun bouton de redémarrage');
  }

  // SPK-171 : l'onglet existe dans la console d'exploitation.
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.click('nav a[href="#/forge"]');
  await page.click('.onglet[href="#/forge/mises-a-jour"]');
  await page.waitForSelector('#titre-paquets', { timeout: 60000 });
  verdict('SPK-171 : l’onglet Mises à jour répond dans la console d’exploitation', true, 'relevé lu');

  // SPK-172 : la colonne Signature, après un tunnel prêt.
  let cellule = '';
  for (let essai = 0; essai < 20; essai += 1) {
    await page.click('a.destination[href="#/serveurs"]');
    // L'écran Serveurs, et non le tableau de la page précédente encore affiché.
    await page.waitForSelector('h1:has-text("Serveurs")', { timeout: 10000 });
    await page.waitForSelector('tbody tr', { timeout: 10000 });
    cellule = await page.locator('tbody tr', { hasText: 'courant' }).locator('td').nth(4).innerText();
    if (!/en attente de connexion/.test(cellule)) break;
    await page.click('a.destination[href="#/sparks"]');
    await page.waitForTimeout(2000);
  }
  verdict('SPK-172 : la colonne Signature confirme la clé du serveur courant',
          /clé (posée|remplacée) à la connexion|clé reconnue par la Forge/.test(cellule), cellule.trim());
  // Ce qui désigne une machine — adresse, alias — est masqué.
  await capturer('spk172-serveurs-signature', ['td.technique', '.technique']);
  await capturer('spk172-serveurs-signature-mobile', ['td.technique', '.technique'], { largeur: 390, hauteur: 844 });
} catch (erreur) {
  verdict('parcours', false, erreur.message);
} finally {
  await navigateur.close();
}
if (verdicts.some((ok) => !ok)) process.exit(1);
