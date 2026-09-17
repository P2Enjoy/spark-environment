/**
 * OP-23 sur FORGE RÉELLE, par le parcours canonique : un réseau privé créé
 * depuis la console, deux cellules d'ESSAI attachées depuis leurs dossiers,
 * puis la preuve depuis le terminal de la première qu'elle joint la seconde
 * PAR SON NOM — et rien d'autre par cette interface —, avant de tout défaire.
 *
 * @verifies docs/BACKLOG.md#SPK-110 · docs/DAT.md §58.3 (spn* dans
 *           spark_filter : ni la Forge ni Internet par un réseau privé),
 *           §58.4 (créer, attacher, détacher, supprimer), §58.6 (ce que la
 *           cellule reçoit ; les noms, promis) · docs/PROD_MIGRATIONS.md#OP-23 ·
 *           CLAUDE.md §16
 *
 * Hors campagne automatique : contre la console d'exploitation (`sparkui`,
 * port 5175) sur une Forge réelle, sur des cellules d'essai créées par le
 * produit — jamais sur celles d'un locataire. UNE seule pile lourde à la fois
 * (CLAUDE.md §15 bis) : le verrou est pris à l'import.
 *
 *   make forge-reelle SCRIPT=spk110-reseau-prive ARGS="<a> <b> <réseau>"
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [a = 'essai-a', b = 'essai-b', reseau = 'essai'] = process.argv.slice(2);
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`capture : ${nom}.jpg`);
}
const texteDe = (titre) => page.$eval(titre, (h) => h.closest('section').innerText);
const catalogue = () => texteDe('#titre-reseaux-prives');
const dossier = () => texteDe('#titre-reseau');
const attendreTexte = (motif, delai = 30000) => page.waitForFunction(
  (m) => new RegExp(m).test(document.body.innerText), motif, { timeout: delai });
const attendreSection = (titre, motif, delai = 60000) => page.waitForFunction(
  ([t, m]) => new RegExp(m).test(document.querySelector(t)?.closest('section')?.innerText ?? ''),
  [titre, motif], { timeout: delai });
const echapperRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function accueil() {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 30000 });
}
async function forge() {
  await accueil();
  await page.click('nav a[href="#/forge"]');
  await page.waitForSelector('#titre-reseaux-prives', { timeout: 30000 });
  await attendreSection('#titre-reseaux-prives', 'attribués sur');
}
async function ouvrir(nom) {
  await accueil();
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('#titre-reseau', { timeout: 30000 });
}
/** Attache `nom` au réseau depuis SON dossier, et rend ce que la ligne dit. */
async function attacher(nom) {
  await ouvrir(nom);
  await page.click('[data-ouvre="reseau"]');
  await page.waitForSelector('[data-modale="reseau"] select[name="reseau"]', { timeout: 10000 });
  await page.selectOption('[data-modale="reseau"] select[name="reseau"]', reseau);
  await page.click('[data-modale="reseau"] [data-engage="reseau"]');
  await attendreSection('#titre-reseau', `${echapperRegExp(reseau)} · spn\\d+ · 10\\.78\\.`);
  const texte = await dossier();
  const [, iface, adresse] = texte.match(new RegExp(`${echapperRegExp(reseau)} · (spn\\d+) · (10\\.78\\.\\d+\\.\\d+)`));
  console.log(`--- ${nom} attaché : ${iface} ${adresse} ---\n${texte}`);
  return { iface, adresse, texte };
}
async function detacher(nom) {
  await ouvrir(nom);
  await page.click(`[data-detache-reseau="${reseau}"]`);
  await page.waitForSelector(`[data-confirme-detachement="${reseau}"]`, { timeout: 10000 });
  await page.click(`[data-confirme-detachement="${reseau}"]`);
  await attendreSection('#titre-reseau', 'membre d’aucun réseau privé');
  console.log(`--- ${nom} détaché ---`);
}
/** Joue des commandes dans le terminal de `nom`, attend `fin`, rend l'écran. */
async function terminal(nom, commandes, fin) {
  await ouvrir(nom);
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
  for (const c of commandes) { await grille.pressSequentially(c); await grille.press('Enter'); }
  await attendreTexte(fin, 90000);
  return page.locator('.xterm-rows').innerText();
}
/** Une commande de l'en-tête — Arrêter, Démarrer — et l'état qu'elle doit rendre. */
async function commander(nom, commande, etatAttendu) {
  await ouvrir(nom);
  await page.click(`[data-commande="${commande}"]`);
  await page.waitForFunction(
    (e) => new RegExp(e).test(document.querySelector('.entete-entite')?.innerText ?? ''),
    etatAttendu, { timeout: 120000 });
  console.log(`--- ${nom} : ${commande} → ${etatAttendu} ---`);
}
async function fermerTerminal() {
  await page.click('[data-terminal="fermer"]');
  await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });
}

try {
  // 1. Le catalogue, avant.
  await forge();
  console.log('--- catalogue avant ---\n' + await catalogue());
  await capturer('spk110-forge-catalogue-avant');

  // 2. Créer le réseau, par la modale.
  await page.click('[data-ouvre-reseau]');
  await page.waitForSelector('[data-modale="reseau-creation"] input[name="name"]', { timeout: 10000 });
  await page.fill('[data-modale="reseau-creation"] input[name="name"]', reseau);
  await page.fill('[data-modale="reseau-creation"] input[name="note"]', 'preuve OP-23 sur les cellules d’essai');
  await page.click('[data-modale="reseau-creation"] [data-engage="reseau-creation"]');
  await attendreSection('#titre-reseaux-prives', `${echapperRegExp(reseau)} · 10\\.78\\.\\d+\\.0/24 · spn\\d+`);
  console.log('--- catalogue, réseau créé ---\n' + await catalogue());
  await capturer('spk110-forge-reseau-cree');

  // 3. Attacher les deux cellules d'essai depuis leurs dossiers — A en marche,
  //    B ARRÊTÉE (§58.6 : la configuration est posée, prise au démarrage), puis
  //    redémarrée par le produit.
  const A = await attacher(a);
  await capturer('spk110-dossier-essai-membre');
  await commander(b, 'stop', 'Arrêté');
  const B = await attacher(b);
  await capturer('spk110-dossier-essai-arretee-membre');
  await commander(b, 'start', 'En marche');
  const passerelle = A.adresse.replace(/\.\d+$/, '.1');

  // 4. Depuis le terminal de A : B se joint PAR SON NOM ; ni la Forge ni
  //    Internet ne répondent par spn<n> ; le reste tient.
  const commandes = [
    `ip -4 -o addr show ${A.iface} | awk '{print "IFACE " $4}'`,
    `N=$(getent hosts ${b}.${reseau} | awk '{print $1}') ; echo "NOM=\${N:-aucun}"`,
    `ping -c1 -W2 ${b}.${reseau} >/dev/null 2>&1 ; echo "PING-NOM code=$?"`,
    `ping -c1 -W2 ${B.adresse} >/dev/null 2>&1 ; echo "PING-ADRESSE code=$?"`,
    `nc -zw3 ${passerelle} 22 ; echo "FORGE-SPN code=$?"`,
    `curl -sS -m 8 --interface ${A.iface} -o /dev/null -w 'INTERNET-SPN -> %{http_code}\\n' https://deb.debian.org/ 2>/dev/null || echo "INTERNET-SPN -> aucun"`,
    `curl -sS -m 10 -o /dev/null -w 'INTERNET -> %{http_code}\\n' https://deb.debian.org/`,
    `ping -c1 -W2 10.77.0.1 >/dev/null 2>&1 ; echo "PASSERELLE code=$?"`,
    'echo FIN-PREUVE-1',
  ];
  const ecran = await terminal(a, commandes, 'FIN-PREUVE-1');
  const lire = (motif) => (ecran.match(new RegExp(motif)) ?? [])[1];
  const resultat = {
    iface: lire(/IFACE (\S+)/), nom: lire(/NOM=(\S+)/), pingNom: lire(/PING-NOM code=(\d+)/),
    pingAdresse: lire(/PING-ADRESSE code=(\d+)/), forgeSpn: lire(/FORGE-SPN code=(\d+)/),
    internetSpn: lire(/INTERNET-SPN -> (\S+)/), internet: lire(/INTERNET -> (\d{3})/),
    passerelle: lire(/PASSERELLE code=(\d+)/),
  };
  console.log('--- terminal de ' + a + ' ---', resultat);
  await capturer('spk110-terminal-nom-joint');
  await fermerTerminal();

  // 5. Un Spark qui n'est plus membre n'est plus joint : B détaché, A ne
  //    l'atteint plus par son adresse.
  await detacher(b);
  const ecran2 = await terminal(a, [
    `ping -c1 -W2 ${B.adresse} >/dev/null 2>&1 ; echo "PING-DETACHE code=$?"`,
    'echo FIN-PREUVE-2',
  ], 'FIN-PREUVE-2');
  const pingDetache = (ecran2.match(/PING-DETACHE code=(\d+)/) ?? [])[1];
  console.log('--- après détachement de ' + b + ' ---', { pingDetache });
  await fermerTerminal();

  // 6. Tout défaire : A détaché, le réseau supprimé, le pool rendu.
  await detacher(a);
  await forge();
  await page.click(`[data-supprime-reseau="${reseau}"]`);
  await page.waitForSelector(`[data-confirme-suppression-reseau="${reseau}"]`, { timeout: 10000 });
  await page.click(`[data-confirme-suppression-reseau="${reseau}"]`);
  await page.waitForFunction(
    (r) => !new RegExp(`${r} · 10\\.78\\.`).test(document.querySelector('#titre-reseaux-prives')?.closest('section')?.innerText ?? ''),
    echapperRegExp(reseau), { timeout: 60000 });
  console.log('--- catalogue après ---\n' + await catalogue());
  await capturer('spk110-forge-catalogue-apres');

  const repond = (c) => /^[1-5]\d{2}$/.test(c ?? '');
  const ok = (resultat.iface ?? '').startsWith(A.adresse + '/')
    && resultat.nom === B.adresse && resultat.pingNom === '0' && resultat.pingAdresse === '0'
    && resultat.forgeSpn !== '0' && !repond(resultat.internetSpn)
    && repond(resultat.internet) && resultat.passerelle === '0'
    && pingDetache !== '0'
    && /se joint par <spark>\./.test(A.texte)
    && /cellule arrêtée : configuration posée, prise au démarrage/.test(B.texte);
  console.log(ok ? 'PREUVE OK' : 'PREUVE EN ÉCHEC', { bruits });
  process.exitCode = ok ? 0 : 1;
} catch (erreur) {
  await page.screenshot({ path: join(CAPTURES, 'echecs', 'spk110-forge-reelle.png'), fullPage: true }).catch(() => {});
  await page.click('[data-terminal="fermer"]', { timeout: 3000 }).catch(() => {});
  console.error('ÉCHEC :', erreur.message, '\n', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500));
  process.exitCode = 1;
} finally {
  await navigateur.close();
}
