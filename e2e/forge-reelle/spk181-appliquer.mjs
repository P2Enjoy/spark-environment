/**
 * Preuve sur FORGE RÉELLE, par le parcours canonique : un paquet en attente
 * s'applique depuis l'onglet « Mises à jour », et sort de la liste relue.
 *
 * @verifies docs/BACKLOG.md#SPK-181 · docs/DAT.md §73.4 (machine réelle) ·
 *           docs/PROD_MIGRATIONS.md OP-45 · CLAUDE.md §16
 *
 * D'abord sparkd est mis à jour par le bloc « Code déployé », s'il est en retard.
 * Ensuite, dans l'onglet, la case du premier paquet qui n'est pas un noyau,
 * *Appliquer*, la confirmation, et l'attente de l'issue. Le serveur courant
 * d'avant est rétabli à la fin. Jouer contre une console À PART, jamais contre
 * celle que l'exploitant utilise.
 *
 *   SPARK_CONSOLE_URL=http://127.0.0.1:<port>/ node e2e/forge-reelle/spk181-appliquer.mjs spark-010
 *   … spark-experiment tout     # « Tout sélectionner » : sur instruction du responsable
 */
// CLAUDE.md §15 bis : ce script lance un Chromium. Le verrou est pris à l'import.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [serveur = 'spark-010', mode = 'un'] = process.argv.slice(2);
const CONSOLE = process.env.SPARK_CONSOLE_URL;
if (!CONSOLE) throw new Error('SPARK_CONSOLE_URL : une console À PART, pas celle de l’exploitant');
const CAPTURES = new URL('../captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const verdicts = [];
const verdict = (nom, ok, detail) => { verdicts.push(ok); console.log(`${ok ? 'VERT ' : 'ROUGE'} ${nom} — ${detail}`); };
const capturer = async (nom) => {
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true,
                          mask: [page.locator('td.technique'), page.locator('pre')] });
};
let avant = null;

try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#selecteur-serveur', { timeout: 30000 });
  avant = await page.locator('#selecteur-serveur').inputValue();
  if (avant !== serveur) await page.selectOption('#selecteur-serveur', serveur);
  await page.waitForFunction(() => /Tunnel ouvert/.test(document.body.innerText), null, { timeout: 60000 });

  await page.click('nav a[href="#/forge"]');
  await page.waitForSelector('[data-action="comparer-build"]', { timeout: 60000 });
  if (await page.locator('[data-action="demander-update"]').count()) {
    await page.click('[data-action="demander-update"]');
    await page.click('[data-action="confirmer-update"]');
    await page.waitForFunction(() => /Mise à jour (prouvée|en échec)/.test(document.body.innerText), null,
                               { timeout: 8 * 60 * 1000 });
    verdict('sparkd mis à jour par l’écran', /Mise à jour prouvée/.test(await page.locator('body').innerText()), '');
  }

  await page.click('.onglet[href="#/forge/mises-a-jour"]');
  await page.waitForSelector('#titre-paquets', { timeout: 60000 });
  const noms = await page.locator('[data-paquet]').evaluateAll((cases) => cases.map((c) => c.dataset.paquet));
  const choisi = mode === 'tout' ? null : noms.find((n) => !/^linux-/.test(n));
  if (mode !== 'tout' && !choisi) throw new Error(`aucun paquet hors noyau en attente : ${noms.join(', ') || 'aucun'}`);
  console.log(`paquets en attente : ${noms.length} ; ${mode === 'tout' ? 'tous' : `choisi : ${choisi}`}`);
  if (mode === 'tout') await page.click('[data-action="maj-tout"]');
  else await page.check(`[data-paquet="${choisi}"]`);
  await page.click('[data-action="maj-demander"]');
  await page.waitForSelector('#titre-confirmation-maj');
  await capturer('spk181-reel-confirmation');
  await page.click('[data-action="maj-confirmer"]');
  await page.waitForFunction(() => /Mises à jour appliquées|Application en échec/.test(document.body.innerText),
                             null, { timeout: 10 * 60 * 1000 });
  const issue = await page.locator('#titre-paquets ~ .succes, #titre-paquets ~ .refus').first().innerText();
  verdict('le paquet est appliqué sur la vraie machine', /Mises à jour appliquées/.test(issue), issue.replace(/\s+/g, ' '));
  await page.waitForTimeout(1500);
  const restants = await page.locator('[data-paquet]').count();
  verdict(mode === 'tout' ? 'la liste relue est vide' : 'il sort de la liste relue',
          mode === 'tout' ? restants === 0 : await page.locator(`[data-paquet="${choisi}"]`).count() === 0,
          mode === 'tout' ? `${restants} restant(s)` : choisi);
  await capturer('spk181-reel-appliquee');
} catch (erreur) {
  verdict('parcours', false, erreur.message);
} finally {
  if (avant && avant !== serveur) await page.selectOption('#selecteur-serveur', avant).catch(() => {});
  await navigateur.close();
}
if (verdicts.some((ok) => !ok)) process.exit(1);
