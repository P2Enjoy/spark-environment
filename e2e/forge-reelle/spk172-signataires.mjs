/**
 * Preuve sur FORGE RÉELLE, par le parcours canonique : la console pose sa clé de
 * signature à la connexion, et le geste signé suivant passe.
 *
 * @verifies docs/BACKLOG.md#SPK-172 · docs/DAT.md §70.3 (la console pose sa
 *           ligne à la première ouverture du tunnel ; ce qui se voit) ·
 *           §36.10.5 · docs/DESIGN_SYSTEM_APP.md SPK-DS-45 · CLAUDE.md §16
 *
 * Préalable, sur la Forge : la ligne `console/<serveur>` est ABSENTE de
 * `/etc/sparkd/allowed_signers` — c'est l'état d'une Forge neuve. Le script fait
 * ce qu'un exploitant ferait : l'accueil, *Serveurs*, *Regarder* sur le serveur,
 * puis la colonne *Signature* ; ensuite *Sparks* → *Projets* → *Créer un projet*,
 * un geste humain qui écrit et part donc signé ; *Forge* → *Journal*, dont la
 * ligne `project.create` doit dire « signée » ; enfin le projet d'essai est
 * supprimé par le même écran.
 *
 *   SPARK_CONSOLE_URL=http://127.0.0.1:<port>/ node e2e/forge-reelle/spk172-signataires.mjs <serveur>
 */
// CLAUDE.md §15 bis : ce script lance un Chromium. Le verrou est pris à l'import.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [serveur = 'spark-010'] = process.argv.slice(2);
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

const ligneServeur = () => page.locator('tbody tr', { has: page.locator(`td.cellule-nom:has-text("${serveur}")`) });

let echec = null;
try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.click('a.destination[href="#/serveurs"]');
  await ligneServeur().waitFor({ timeout: 20000 });
  const regarder = ligneServeur().locator(`[data-bascule="${serveur}"]`);
  if (await regarder.count()) await regarder.click();

  // La pose part au premier passage à prêt : on relit l'écran comme un
  // exploitant qui y revient, jusqu'à ce que la colonne dise ce qui s'est passé.
  let cellule = '';
  for (let essai = 0; essai < 30; essai += 1) {
    await page.click('a.destination[href="#/serveurs"]');
    await ligneServeur().waitFor({ timeout: 10000 });
    cellule = await ligneServeur().locator('td').nth(4).innerText();
    if (!/en attente de connexion/.test(cellule)) break;
    await page.waitForTimeout(2000);
    await page.click('a.destination[href="#/sparks"]').catch(() => {});
  }
  console.log(`colonne Signature : ${cellule.trim()}`);
  await capturer('spk172-serveurs-signature');
  await capturer('spk172-serveurs-signature-mobile', { largeur: 390, hauteur: 844 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (!/clé (posée|remplacée) à la connexion|clé reconnue par la Forge/.test(cellule)) {
    throw new Error(`la colonne Signature ne confirme pas la pose : « ${cellule.trim()} »`);
  }

  // Un geste HUMAIN qui écrit, donc signé, et réversible : créer un projet
  // d'essai. (Relever le catalogue est un geste automatique : non signé.)
  const PROJET = 'essai-spk172';
  await page.click('a.destination[href="#/sparks"]');
  await page.click('.onglet[href="#/sparks/~projets"]');
  await page.click('[data-ouvre="projet-creation"]');
  await page.fill('#projet-nom', PROJET);
  await page.click('[data-engage="projet-creation"]');
  await page.waitForSelector(`a.lien-spark:has-text("${PROJET}")`, { timeout: 20000 });
  const refus = await page.locator('[role="alert"]').allInnerTexts();
  if (refus.some((t) => /signataires|signature/i.test(t))) {
    throw new Error(`le geste signé est refusé : ${refus.join(' | ')}`);
  }
  await capturer('spk172-projet-cree');

  await page.click('a.destination[href="#/forge"]');
  await page.click('.onglet[href="#/forge/journal"]');
  // L'onglet change la page, pas tout de suite : attendre que le JOURNAL soit la
  // destination courante, sans quoi on lirait le tableau précédent.
  await page.waitForSelector('.onglet[aria-current="page"][href="#/forge/journal"]', { timeout: 20000 });
  await page.waitForFunction(() => /project\.create/.test(document.querySelector('tbody')?.innerText ?? ''),
                             null, { timeout: 20000 });
  const premiere = await page.locator('tbody tr').first().innerText();
  console.log(`journal, première ligne : ${premiere.replace(/\s+/g, ' ').trim()}`);
  await capturer('spk172-journal-signe');
  const signee = /project\.create/.test(premiere) && /\bsignée\b/.test(premiere)
    && !/non signée/.test(premiere);

  // Le rangement d'essai ne reste pas : supprimé par le même parcours.
  await page.click('a.destination[href="#/sparks"]');
  await page.click('.onglet[href="#/sparks/~projets"]');
  const ligne = page.locator('li', { has: page.locator(`a.lien-spark:has-text("${PROJET}")`) });
  await ligne.locator('[data-supprime-projet]').click();
  await ligne.locator('[data-confirme-suppression-projet]').click();
  await page.waitForFunction((n) => ![...document.querySelectorAll('a.lien-spark')]
    .some((a) => a.textContent.trim() === n), PROJET, { timeout: 20000 });
  if (!signee) throw new Error('la ligne project.create du journal ne dit pas « signée »');
  console.log('VERT : clé posée à la connexion, geste suivant signé et accepté');
} catch (erreur) {
  echec = erreur;
  await capturer('spk172-echec').catch(() => {});
} finally {
  if (bruits.length) console.log(`console du navigateur :\n${bruits.join('\n')}`);
  await navigateur.close();
}
if (echec) { console.error(`ROUGE : ${echec.message}`); process.exit(1); }
