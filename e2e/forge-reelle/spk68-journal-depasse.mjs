/**
 * SPK-68 · §50.4 sur FORGE RÉELLE, par le parcours canonique : le journal d'une installation échouée, dépassé par un
 * relevé qui ne voit plus d'écart, n'est plus un encadré d'erreur. LECTURE SEULE : on ouvre l'écran Forge du serveur
 * nommé, le relevé se lance de lui-même (il ne lance pas d'installation), on observe et on capture.
 *
 * @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4 · CLAUDE.md §16
 *
 *   node e2e/forge-reelle/spk68-journal-depasse.mjs spark-experiment
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [serveur = 'spark-experiment'] = process.argv.slice(2);
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;
const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
let ok = true;
const verifier = (c, m) => { console.log(`  ${c ? 'ok    ' : 'ÉCHEC '} ${m}`); if (!c) ok = false; };
let avant = null;
try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#selecteur-serveur', { timeout: 30000 });
  avant = await page.locator('#selecteur-serveur').inputValue();
  if (avant !== serveur) await page.selectOption('#selecteur-serveur', serveur);
  await page.waitForFunction(() => /Tunnel ouvert/.test(document.body.innerText), null, { timeout: 60000 });
  await page.click('nav a[href="#/forge"]');
  await page.waitForSelector('#titre-installation', { timeout: 60000 });
  // Le relevé se lance de lui-même quand un journal existe (§50.4) : on attend son verdict.
  await page.waitForFunction(() => /Le dernier relevé a trouvé cette Forge installée et prête|Conformité constatée|Diagnostic impossible/
    .test(document.querySelector('.installation')?.innerText ?? ''), null, { timeout: 120000 });
  const texte = await page.locator('.installation').innerText();
  const journal = await page.locator('.installation__execution').count();
  console.log(`  journal présent : ${journal > 0}`);
  if (journal > 0) {
    verifier(!(await page.locator('.installation .refus').count()), 'aucun encadré rouge sous un relevé qui dit la Forge prête');
    verifier(/Dernière tentative d’installation/.test(texte), 'le journal est présenté comme une tentative antérieure');
    verifier(!/Installation arrêtée sur un échec/.test(texte), 'le titre d\'erreur a disparu');
    verifier(await page.locator('details.installation__journal:not([open])').count() === 1, 'le journal reste consultable, replié');
  }
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `spk68-${serveur}-journal-depasse.jpg`), type: 'jpeg', quality: 82, fullPage: true });
} catch (e) {
  ok = false; console.log(`ERREUR : ${e.message}`);
} finally {
  if (avant && avant !== serveur) await page.selectOption('#selecteur-serveur', avant).catch(() => {});
  await navigateur.close();
}
console.log(ok ? 'VERT' : 'ROUGE');
process.exit(ok ? 0 : 1);
