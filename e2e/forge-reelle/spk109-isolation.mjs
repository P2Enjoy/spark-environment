/**
 * OP-22 sur FORGE RÉELLE, par le parcours canonique : le rattrapage des
 * cellules créées avant la règle, puis la preuve depuis le terminal d'une
 * cellule de locataire qu'elle ne joint plus sa voisine — et joint encore tout
 * le reste.
 *
 * @verifies docs/BACKLOG.md#SPK-109 · docs/DAT.md §57.2 (les deux étages),
 *           §57.3 (le rattrapage, une fois, confirmé), §57.7 (la preuve depuis
 *           les terminaux) · §56.2 (l'ingress reste joint) ·
 *           docs/PROD_MIGRATIONS.md#OP-22 · CLAUDE.md §16
 *
 * Hors campagne automatique : se joue contre la console d'exploitation ouverte
 * sur une Forge réelle (`sparkui`, port 5175), sur feu vert explicite du
 * responsable — il touche les cellules des locataires. UNE seule pile lourde à
 * la fois (CLAUDE.md §15 bis) : le verrou est pris à l'import.
 *
 *   make forge-reelle SCRIPT=spk109-isolation ARGS="<spark> <voisine> <domaine>"
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [spark = 'redaction-devis', voisine = '10.77.0.16', domaine = 'oauth.lelabs.tech'] = process.argv.slice(2);
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const bruits = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) bruits.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

async function capturer(nom, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(500);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  console.log(`capture : ${nom}.jpg`);
}
const section = () => page.$eval('#titre-isolation', (h) => h.closest('section').innerText);
const attendreTexte = (motif, delai = 30000) => page.waitForFunction(
  (m) => new RegExp(m).test(document.body.innerText), motif, { timeout: delai });

try {
  // 1. L'accueil, la Forge, la section — comme un exploitant.
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 30000 });
  await page.click('nav a[href="#/forge"]');
  await page.waitForSelector('#titre-isolation', { timeout: 30000 });
  await attendreTexte('Créées avant la règle');
  console.log('--- avant ---\n' + await section());
  await capturer('spk109-forge-avant-rattrapage');

  // 2. Le rattrapage, confirmé dans le flux.
  await page.click('[data-isolation="demander"]');
  await page.waitForSelector('[data-isolation="engager"]', { timeout: 10000 });
  await capturer('spk109-forge-confirmation');
  await page.click('[data-isolation="engager"]');
  await attendreTexte('Le rattrapage a été joué|cellule(s)? isolée(s)? :');
  const issue = await section();
  console.log('--- après ---\n' + issue);
  await capturer('spk109-forge-apres-rattrapage');
  await capturer('spk109-forge-apres-rattrapage-mobile', { largeur: 390, hauteur: 844 });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 3. Le dossier de la cellule de locataire le dit.
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 30000 });
  await page.click(`tbody a:has-text("${spark}")`);
  await page.waitForSelector('#titre-reseau', { timeout: 30000 });
  const reseau = await page.$eval('#titre-reseau', (h) => h.closest('section').innerText);
  console.log('--- dossier ---\n' + reseau);
  await capturer('spk109-dossier-locataire-isole');

  // 4. Depuis SON terminal : la voisine ne répond plus ; tout le reste tient.
  await page.click('.onglet[href$="/terminal"]');
  await page.waitForSelector('#titre-terminal', { timeout: 30000 });
  if (await page.locator('[data-terminal="fermer"]').count()) {
    await page.click('[data-terminal="fermer"]');
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });
  }
  await page.click('[data-terminal="ouvrir"]');
  await page.waitForSelector('[data-terminal="fermer"]', { timeout: 30000 });
  const grille = page.locator('.terminal--emulateur .xterm-helper-textarea');
  await grille.waitFor({ state: 'attached', timeout: 20000 });
  await attendreTexte('~[#$]');
  const commandes = [
    `nc -zvw3 ${voisine} 22 ; echo "VOISINE code=$?"`,
    `ping -c1 -W2 ${voisine} >/dev/null 2>&1 ; echo "PING-VOISINE code=$?"`,
    `ping -c1 -W2 10.77.0.1 >/dev/null 2>&1 ; echo "PASSERELLE code=$?"`,
    `getent hosts deb.debian.org >/dev/null && echo "DNS ok" || echo "DNS ECHEC"`,
    `curl -sS -m 10 -o /dev/null -w 'INTERNET -> %{http_code}\\n' https://deb.debian.org/`,
    `curl -sS -m 10 -o /dev/null -w 'INGRESS ${domaine} -> %{http_code}\\n' https://${domaine}/`,
  ];
  for (const c of commandes) { await grille.pressSequentially(c); await grille.press('Enter'); }
  await attendreTexte(`INGRESS ${domaine} -> \\d{3}`);
  const ecran = await page.locator('.xterm-rows').innerText();
  const lire = (motif) => (ecran.match(new RegExp(motif)) ?? [])[1];
  const resultat = { voisine: lire(/VOISINE code=(\d+)/), pingVoisine: lire(/PING-VOISINE code=(\d+)/),
                     passerelle: lire(/PASSERELLE code=(\d+)/), dns: lire(/DNS (ok|ECHEC)/),
                     internet: lire(/INTERNET -> (\d{3})/), ingress: lire(new RegExp(`INGRESS ${domaine} -> (\\d{3})`)) };
  console.log('--- terminal ---', resultat);
  await capturer('spk109-terminal-voisine-injoignable');
  await page.click('[data-terminal="fermer"]');
  await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });

  const repond = (c) => /^[1-5]\d{2}$/.test(c ?? '');
  const ok = resultat.voisine !== '0' && resultat.pingVoisine !== '0' && resultat.passerelle === '0'
    && resultat.dns === 'ok' && repond(resultat.internet) && repond(resultat.ingress)
    && /Isolé du réseau des autres Sparks/.test(reseau);
  console.log(ok ? 'PREUVE OK' : 'PREUVE EN ÉCHEC', { bruits });
  process.exitCode = ok ? 0 : 1;
} catch (erreur) {
  await page.screenshot({ path: join(CAPTURES, 'echecs', 'spk109-forge-reelle.png'), fullPage: true }).catch(() => {});
  await page.click('[data-terminal="fermer"]', { timeout: 3000 }).catch(() => {});
  console.error('ÉCHEC :', erreur.message, '\n', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500));
  process.exitCode = 1;
} finally {
  await navigateur.close();
}
