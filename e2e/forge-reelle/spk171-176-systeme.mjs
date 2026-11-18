/**
 * Preuve sur FORGE RÉELLE, par le parcours canonique : l'onglet « Mises à jour »
 * lit la vraie machine, et l'installation propose la mise à niveau ZFS décochée.
 *
 * @verifies docs/BACKLOG.md#SPK-171 · docs/DAT.md §70.5 (le relevé réel, sans
 *           le badge de démonstration) · docs/BACKLOG.md#SPK-176 · docs/DAT.md
 *           §70.6 (la case décochée, le plan composé avec et sans elle) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-46, SPK-DS-47 · CLAUDE.md §16 ·
 *           docs/BACKLOG.md#SPK-177 · docs/DAT.md §70.8 (« Caddy actif » conforme
 *           sur caddy-api.service)
 *
 * **Le plan n'est JAMAIS exécuté** : la mise à niveau ZFS est irréversible, et
 * la jouer est une décision du responsable (OP-43). Le script s'arrête au plan
 * relu, puis le laisse tel quel.
 *
 *   SPARK_CONSOLE_URL=http://127.0.0.1:<port>/ node e2e/forge-reelle/spk171-176-systeme.mjs
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
const bruits = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) bruits.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));
// Le message « Failed to load resource » ne dit pas QUELLE ressource : on la relève.
page.on('response', (r) => { if (r.status() >= 500) bruits.push(`[${r.status()}] ${r.request().method()} ${new URL(r.url()).pathname}`); });

async function capturer(nom, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(600);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`capture : ${nom}.jpg`);
}

const verdicts = [];
const verdict = (nom, ok, detail) => { verdicts.push({ nom, ok }); console.log(`${ok ? 'VERT ' : 'ROUGE'} ${nom} — ${detail}`); };

try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });

  // --- SPK-171 : Forge → Mises à jour, contre la vraie machine.
  await page.click('nav a[href="#/forge"]');
  await page.click('.onglet[href="#/forge/mises-a-jour"]');
  await page.waitForSelector('#titre-paquets', { timeout: 60000 });
  const texte = await page.locator('.principal').innerText();
  verdict('SPK-171 : le relevé vient de la machine, pas de la démonstration',
          !/démonstration/.test(texte), 'aucun badge de démonstration');
  verdict('SPK-171 : version et noyau réels', /Ubuntu 26\.04/.test(texte) && /7\.0\.0-/.test(texte),
          texte.match(/Ubuntu [^\n]*/)?.[0] ?? '');
  verdict('SPK-171 : les pools ZFS à mettre à niveau sont nommés',
          /spark\s*:\s*7 fonctionnalités à activer/.test(texte), 'spark : 7');
  await capturer('spk171-reel-mises-a-jour');
  await capturer('spk171-reel-mises-a-jour-mobile', { largeur: 390, hauteur: 844 });

  // --- SPK-176 : le renvoi mène à l'installation ; diagnostic, puis la case.
  await page.click('#titre-zfs ~ p a[href="#/forge"]');
  await page.waitForSelector('[data-action="diagnostiquer-forge"]', { timeout: 30000 });
  await page.click('[data-action="diagnostiquer-forge"]');
  const caseZfs = page.locator('#installation-zfs-upgrade');
  await caseZfs.waitFor({ timeout: 60000 });
  const caddy = await page.locator('.installation__controle', { hasText: 'Caddy actif' }).innerText();
  verdict('SPK-177 : « Caddy actif » conforme sur caddy-api.service, les deux unités nommées',
          /conforme/.test(caddy) && /caddy-api\.service : active/.test(caddy) && /caddy\.service :/.test(caddy),
          caddy.replace(/\s+/g, ' '));
  verdict('SPK-176 : la case est proposée, et DÉCOCHÉE', !(await caseZfs.isChecked()), 'décochée');
  const aide = await page.locator('#installation-zfs-upgrade-aide').innerText();
  verdict('SPK-176 : l’aide dit l’irréversibilité et la liste, sans les (*)',
          /Irréversible/.test(aide) && /physical_rewrite/.test(aide) && !/dynamic_gang_header/.test(aide),
          aide.replace(/\s+/g, ' ').slice(0, 120));
  await page.locator('#formulaire-plan-forge').scrollIntoViewIfNeeded();
  await capturer('spk176-installation-zfs');

  // Plan SANS la case : il ne parle pas de ZFS.
  await page.click('#formulaire-plan-forge button[type="submit"]');
  await page.waitForSelector('#titre-plan-valide', { timeout: 60000 });
  const sans = await page.locator('section[aria-labelledby="titre-plan-valide"]').innerText();
  verdict('SPK-176 : sans la case, le plan ne met rien à niveau', !/ZFS/.test(sans),
          sans.match(/Stockage :[^\n]*/)?.[0] ?? '');

  // Cochée au clavier (barre d'espace), puis plan recomposé.
  await page.focus('#installation-zfs-upgrade');
  await page.keyboard.press('Space');
  verdict('SPK-176 : la case se coche au clavier', await page.locator('#installation-zfs-upgrade').isChecked(), 'cochée');
  await page.click('#formulaire-plan-forge button[type="submit"]');
  await page.waitForFunction(() => /irréversible/.test(
    document.querySelector('section[aria-labelledby="titre-plan-valide"]')?.innerText ?? ''), null, { timeout: 60000 });
  const avec = await page.locator('section[aria-labelledby="titre-plan-valide"]').innerText();
  verdict('SPK-176 : cochée, le plan redit la mise à niveau et son irréversibilité',
          /activer les fonctionnalités ZFS disponibles — irréversible/.test(avec)
          && /activer ses fonctionnalités ZFS — à faire/.test(avec),
          avec.match(/Stockage :[^\n]*/)?.[0] ?? '');
  await page.locator('#titre-plan-valide').scrollIntoViewIfNeeded();
  await capturer('spk176-installation-zfs-coche');
  await capturer('spk176-installation-zfs-mobile', { largeur: 390, hauteur: 844 });
  // Le plan reste NON exécuté : aucun clic sur « Exécuter le plan vérifié ».
  verdict('la console n’a rien écrit d’anormal', bruits.length === 0, bruits.join(' | ') || 'rien');
} catch (erreur) {
  verdict('parcours', false, erreur.message);
  await capturer('spk171-176-echec').catch(() => {});
} finally {
  await navigateur.close();
}
if (verdicts.some((v) => !v.ok)) process.exit(1);
