/**
 * OP-43, part sparkd, par le parcours canonique : chaque Forge est mise à jour
 * depuis le bloc « Code déployé » de la console, puis relue à l'écran.
 *
 * @verifies docs/PROD_MIGRATIONS.md OP-43 · docs/BACKLOG.md#SPK-69 · docs/DAT.md
 *           §40.6 (la mise à jour fermée, prouvée après) · docs/BACKLOG.md#SPK-171,
 *           #SPK-172 · docs/DAT.md §70.3, §70.5 · CLAUDE.md §16
 *
 * Joué sur instruction explicite du responsable (2026-11-18 : « Les deux Forges »).
 * Pour chaque serveur nommé : le sélecteur, *Forge*, *Mettre à jour sparkd*, la
 * confirmation, l'attente de « Mise à jour prouvée » ; puis *Mises à jour* et la
 * colonne *Signature*. Le serveur courant d'avant est rétabli à la fin.
 *
 *   node e2e/forge-reelle/op43-mise-a-jour.mjs spark-experiment spark-010
 */
// CLAUDE.md §15 bis : ce script lance un Chromium. Le verrou est pris à l'import.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const serveurs = process.argv.slice(2);
if (!serveurs.length) throw new Error('nommer au moins un serveur');
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const verdicts = [];
const verdict = (nom, ok, detail) => { verdicts.push(ok); console.log(`${ok ? 'VERT ' : 'ROUGE'} ${nom} — ${detail}`); };

async function capturer(nom) {
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82,
                          fullPage: true, mask: [page.locator('.technique')] });
  console.log(`capture : ${nom}.jpg`);
}

async function choisir(nom) {
  await page.selectOption('#selecteur-serveur', nom);
  await page.waitForFunction(() => /Tunnel ouvert/.test(document.body.innerText), null, { timeout: 60000 });
}

let avant = null;
try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#selecteur-serveur', { timeout: 30000 });
  avant = await page.locator('#selecteur-serveur').inputValue();

  for (const nom of serveurs) {
    await choisir(nom);
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('[data-action="comparer-build"]', { timeout: 60000 });
    const demander = page.locator('[data-action="demander-update"]');
    if (await demander.count()) {
      await demander.click();
      await page.click('[data-action="confirmer-update"]');
      await page.waitForFunction(() => /Mise à jour (prouvée|en échec)/.test(document.body.innerText),
                                 null, { timeout: 8 * 60 * 1000 });
      const issue = await page.locator('.progression ~ div').first().innerText();
      verdict(`${nom} : sparkd mis à jour par l’écran`, /Mise à jour prouvée/.test(issue), issue.replace(/\s+/g, ' '));
      await capturer(`op43-${nom}-mise-a-jour`);
    } else {
      const bloc = await page.locator('body').innerText();
      verdict(`${nom} : rien à mettre à jour`, /À jour/.test(bloc), 'le bloc dit « À jour »');
    }

    await page.click('.onglet[href="#/forge/mises-a-jour"]');
    await page.waitForSelector('#titre-paquets', { timeout: 60000 });
    const maj = await page.locator('.principal').innerText();
    verdict(`${nom} : onglet Mises à jour lu sur la machine`, !/démonstration/.test(maj) && /Ubuntu/.test(maj),
            maj.match(/Ubuntu [^\n]*/)?.[0] ?? '');
    await capturer(`op43-${nom}-mises-a-jour`);

    let cellule = '';
    for (let essai = 0; essai < 20; essai += 1) {
      await page.click('a.destination[href="#/serveurs"]');
      await page.waitForSelector('tbody tr', { timeout: 10000 });
      cellule = await page.locator('tbody tr', { has: page.locator(`td.cellule-nom:has-text("${nom}")`) })
        .locator('td').nth(4).innerText();
      if (!/en attente de connexion/.test(cellule)) break;
      await page.waitForTimeout(2000);
    }
    verdict(`${nom} : colonne Signature`, /clé (posée|remplacée) à la connexion|clé reconnue par la Forge/.test(cellule),
            cellule.trim());
  }
} catch (erreur) {
  verdict('parcours', false, erreur.message);
  await capturer('op43-echec').catch(() => {});
} finally {
  if (avant) await choisir(avant).catch(() => {});
  await navigateur.close();
}
if (verdicts.some((ok) => !ok)) process.exit(1);
