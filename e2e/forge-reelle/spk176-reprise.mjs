/**
 * Reprise, par le parcours canonique, de l'installation que le faux échec de la
 * mise à niveau ZFS avait arrêtée (DAT §70.6 révisé).
 *
 * @verifies docs/BACKLOG.md#SPK-176 · docs/DAT.md §70.6 (un pool qui ne liste
 *           plus que des (*) est à niveau : la case disparaît) · docs/BACKLOG.md#SPK-177
 *           · docs/DAT.md §70.8 · CLAUDE.md §16
 *
 * Diagnostic, puis plan. Le plan n'est EXÉCUTÉ que si toutes ses phases, sauf la
 * vérification finale, sont déjà constatées terminées : la reprise ne doit rien
 * écrire d'autre que la recette. Sinon le script s'arrête et dit ce qui reste.
 *
 *   node e2e/forge-reelle/spk176-reprise.mjs spark-experiment
 */
// CLAUDE.md §15 bis : ce script lance un Chromium. Le verrou est pris à l'import.
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
const verdicts = [];
const verdict = (nom, ok, detail) => { verdicts.push(ok); console.log(`${ok ? 'VERT ' : 'ROUGE'} ${nom} — ${detail}`); };
let avant = null;

try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#selecteur-serveur', { timeout: 30000 });
  avant = await page.locator('#selecteur-serveur').inputValue();
  await page.selectOption('#selecteur-serveur', serveur);
  await page.waitForFunction(() => /Tunnel ouvert/.test(document.body.innerText), null, { timeout: 60000 });
  await page.click('nav a[href="#/forge"]');
  await page.click('[data-action="diagnostiquer-forge"]');
  await page.waitForSelector('#formulaire-plan-forge', { timeout: 90000 });
  verdict('la case ZFS n’est plus proposée (seul un (*) reste)',
          await page.locator('#installation-zfs-upgrade').count() === 0, 'absente');
  const caddy = await page.locator('.installation__controle', { hasText: 'Caddy actif' }).innerText();
  verdict('Caddy actif conforme', /conforme/.test(caddy), caddy.replace(/\s+/g, ' '));
  await page.click('#formulaire-plan-forge button[type="submit"]');
  await page.waitForSelector('#titre-plan-valide', { timeout: 90000 });
  const phases = await page.locator('section[aria-labelledby="titre-plan-valide"] ol li').allInnerTexts();
  console.log(phases.map((p) => `  ${p}`).join('\n'));
  const restantes = phases.filter((p) => !/terminée/.test(p) && !/Préflight/.test(p));
  if (restantes.length) throw new Error(`des phases écriraient encore : ${restantes.join(' | ')}`);
  await page.check('[data-installation-accepted]');
  await page.click('[data-action="executer-installation-forge"]');
  await page.waitForFunction(() => /terminée|échec/.test(
    [...document.querySelectorAll('.installation li')].map((l) => l.innerText).join(' '))
    && !document.querySelector('[aria-busy="true"]'), null, { timeout: 8 * 60 * 1000 });
  await page.waitForTimeout(3000);
  const texte = await page.locator('section[aria-labelledby="titre-installation"]').innerText();
  verdict('l’installation reprise se termine', !/échec/.test(texte.split('Exécution')[1] ?? texte), 'pas d’échec affiché');
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, 'spk176-reprise.jpg'), type: 'jpeg', quality: 82,
                          fullPage: true, mask: [page.locator('.technique')] });
} catch (erreur) {
  verdict('parcours', false, erreur.message);
} finally {
  if (avant) {
    await page.selectOption('#selecteur-serveur', avant).catch(() => {});
    await page.waitForTimeout(2000);
  }
  await navigateur.close();
}
if (verdicts.some((ok) => !ok)) process.exit(1);
