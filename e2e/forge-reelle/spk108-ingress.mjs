/**
 * Preuve sur FORGE RÉELLE, par le parcours canonique : un Spark joint les
 * services publics de sa propre Forge, et rien d'autre.
 *
 * @verifies docs/BACKLOG.md#SPK-108 · docs/DAT.md §56.2 (80 et 443, et rien
 *           d'autre), §56.5 (la preuve depuis le terminal du Spark, par la
 *           console) · §48.1 (le 22 reste fermé) · CLAUDE.md §16
 *
 * Ce script n'appartient PAS à la campagne automatique (`e2e/parcours.test.mjs`),
 * dont la pile est un doublon sans netfilter : il se joue contre la console
 * d'exploitation déjà ouverte sur une Forge réelle (`sparkui`, port 5175), et
 * fait ce qu'un exploitant ferait — l'accueil, le Spark, l'onglet Terminal, une
 * commande au clavier —, puis capture ce qui s'affiche. Les captures vont dans
 * `e2e/captures/`, pour être OBSERVÉES.
 *
 *   node e2e/forge-reelle/spk108-ingress.mjs <spark> <domaine servi par la Forge>
 */
// CLAUDE.md §15 bis · docs/DAT.md §29.8 : ce script ne monte pas de pile, mais
// il lance un Chromium — et deux Chromium restent deux Chromium. Le verrou est
// pris ICI, à l'import, avant la moindre allocation.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [spark = 'redaction-devis', domaine = 'oauth.lelabs.tech'] = process.argv.slice(2);
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const bruits = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) bruits.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

async function capturer(nom, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(600);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  console.log(`capture : ${nom}.jpg`);
}

const rows = () => page.locator('.xterm-rows').innerText();
async function attendre(motif, delai = 30000) {
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.querySelector('.xterm-rows')?.innerText ?? ''),
    motif, { timeout: delai });
}

try {
  // L'accueil, comme un exploitant qui ouvre la console ; puis le Spark, par son lien.
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${spark}")`);
  await page.waitForSelector('.entete-entite', { timeout: 10000 });
  await page.click('.onglet[href$="/terminal"]');
  await page.waitForSelector('.onglet[href$="/terminal"][aria-current="page"]', { timeout: 10000 });
  await page.waitForSelector('#titre-terminal');

  // Une session survit à la navigation (SPK-95) : une preuve interrompue en
  // laisse une derrière elle. On la ferme d'abord, comme un exploitant.
  if (await page.locator('[data-terminal="fermer"]').count()) {
    await page.click('[data-terminal="fermer"]');
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });
  }
  await page.click('[data-terminal="ouvrir"]');
  await page.waitForSelector('[data-terminal="fermer"]', { timeout: 30000 });
  const grille = page.locator('.terminal--emulateur .xterm-helper-textarea');
  await grille.waitFor({ state: 'attached', timeout: 20000 });
  // L'invite de la cellule : `root@<spark>:~#`, ou `$` pour une porte sans privilège.
  await attendre('~[#$]');

  // 1. Le SSO, par son nom public : la découverte OpenID Connect, de serveur à serveur.
  await grille.pressSequentially(
    `curl -sS -m 10 -o /dev/null -w 'DECOUVERTE ${domaine} -> %{http_code}\\n' https://${domaine}/.well-known/openid-configuration`);
  await grille.press('Enter');
  await attendre(`DECOUVERTE ${domaine} -> \\d{3}`);
  const decouverte = (await rows()).match(new RegExp(`DECOUVERTE ${domaine} -> (\\d{3})`))[1];
  console.log(`découverte OIDC : ${decouverte}`);

  // 2. La racine du domaine, comme un visiteur.
  await grille.pressSequentially(`curl -sS -m 10 -o /dev/null -w 'RACINE ${domaine} -> %{http_code}\\n' https://${domaine}/`);
  await grille.press('Enter');
  await attendre(`RACINE ${domaine} -> \\d{3}`);
  const racine = (await rows()).match(new RegExp(`RACINE ${domaine} -> (\\d{3})`))[1];
  console.log(`racine : ${racine}`);
  await capturer('spk108-terminal-sso-joint');
  await capturer('spk108-terminal-sso-joint-mobile', { largeur: 390, hauteur: 844 });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 3. Le 22 de la Forge reste fermé (§48.1) : la propriété de SPK-55 tient.
  await grille.pressSequentially('nc -zvw3 10.77.0.1 22 ; echo "PORT22 code=$?"');
  await grille.press('Enter');
  await attendre('PORT22 code=\\d+');
  const port22 = (await rows()).match(/PORT22 code=(\d+)/)[1];
  console.log(`nc 10.77.0.1:22 -> code ${port22}`);
  await capturer('spk108-terminal-22-ferme');

  await page.click('[data-terminal="fermer"]');
  await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });

  // Ce qui prouve la joignabilité, c'est une RÉPONSE du service à travers
  // l'ingress, certificat vérifié par curl — un 302 vers la page de connexion
  // ou un 404 sur un chemin que ce SSO ne sert pas le prouvent autant qu'un
  // 200. `000` seul dirait « injoignable ». Le 22, lui, doit échouer.
  const repond = (code) => /^[1-5]\d{2}$/.test(code);
  const ok = repond(decouverte) && repond(racine) && port22 !== '0';
  console.log(ok ? 'PREUVE OK' : 'PREUVE EN ÉCHEC', { decouverte, racine, port22, bruits });
  process.exitCode = ok ? 0 : 1;
} catch (erreur) {
  await page.screenshot({ path: join(CAPTURES, 'echecs', 'spk108-forge-reelle.png'), fullPage: true }).catch(() => {});
  // Ne pas laisser une session ouverte derrière une preuve en échec.
  await page.click('[data-terminal="fermer"]', { timeout: 3000 }).catch(() => {});
  console.error('ÉCHEC :', erreur.message, '\n', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500));
  process.exitCode = 1;
} finally {
  await navigateur.close();
}
