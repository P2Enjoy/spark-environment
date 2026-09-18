/**
 * OP-24 sur FORGE RÉELLE, par le parcours canonique : un réseau privé, une
 * cellule d'essai membre, un service dans l'autre cellule — hors du réseau —
 * dont UN port est publié dans le réseau depuis l'onglet Routes ; puis la
 * preuve depuis le terminal du membre qu'il joint ce port par la passerelle,
 * et rien d'autre de la cellule exposée ; et depuis le terminal de l'exposée
 * qu'elle a lu l'adresse du membre. Tout est défait à la fin.
 *
 * @verifies docs/BACKLOG.md#SPK-111 · docs/DAT.md §59.1 (la portée est un
 *           réseau ; l'exposant n'en est pas membre), §59.3 (nat=true, la
 *           règle ct status dnat, l'adresse source conservée), §59.4 (les
 *           gestes), §59.6 (la preuve sur la Forge) ·
 *           docs/PROD_MIGRATIONS.md#OP-24 · CLAUDE.md §16
 *
 * Hors campagne automatique : contre la console d'exploitation (`sparkui`,
 * port 5175) sur une Forge réelle, sur des cellules d'essai créées par le
 * produit — jamais sur celles d'un locataire. UNE seule pile lourde à la fois
 * (CLAUDE.md §15 bis) : le verrou est pris à l'import. Les cellules n'ont ni
 * curl ni nc : les sondes sont en python3, comme la mesure.
 *
 *   make forge-reelle SCRIPT=spk111-lien-prive ARGS="<exposée> <membre> <réseau> <clé> <port>"
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [a = 'essai-a', b = 'essai-b', reseau = 'essai', cle = 'console-login', port = '8080'] = process.argv.slice(2);
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
const attendreTexte = (motif, delai = 30000) => page.waitForFunction(
  (m) => new RegExp(m).test(document.body.innerText), motif, { timeout: delai });
const attendreSection = (titre, motif, delai = 60000) => page.waitForFunction(
  ([t, m]) => new RegExp(m).test(document.querySelector(t)?.closest('section')?.innerText ?? ''),
  [titre, motif], { timeout: delai });
const echapperRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dernier = (ecran, motif) => {
  const toutes = [...ecran.matchAll(new RegExp(motif, 'g'))];
  return toutes.length ? toutes[toutes.length - 1][1] : undefined;
};

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
async function ouvrir(nom, facette = '') {
  await accueil();
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 30000 });
  if (facette) {
    await page.click(`.onglet[href$="/${facette}"]`);
    await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`, { timeout: 10000 });
  } else {
    await page.waitForSelector('#titre-reseau', { timeout: 30000 });
  }
}
async function accorderCle(nom) {
  await ouvrir(nom, 'cles');
  await page.waitForSelector('#titre-cles', { timeout: 30000 });
  if (await page.locator(`[data-revoque="${cle}"]`).count()) return;
  await page.click('[data-ouvre="key"]');
  await page.waitForSelector('[data-modale="key"] select[name="key_label"]', { timeout: 10000 });
  await page.selectOption('[data-modale="key"] select[name="key_label"]', cle);
  await page.click('[data-modale="key"] [data-engage="key"]');
  await page.waitForSelector(`[data-revoque="${cle}"]`, { timeout: 60000 });
  console.log(`--- ${nom} : clé « ${cle} » accordée ---`);
}
async function attacher(nom) {
  await ouvrir(nom);
  await page.click('[data-ouvre="reseau"]');
  await page.waitForSelector('[data-modale="reseau"] select[name="reseau"]', { timeout: 10000 });
  await page.selectOption('[data-modale="reseau"] select[name="reseau"]', reseau);
  await page.click('[data-modale="reseau"] [data-engage="reseau"]');
  await attendreSection('#titre-reseau', `${echapperRegExp(reseau)} · spn\\d+ · 10\\.78\\.`);
  const texte = await texteDe('#titre-reseau');
  const [, iface, adresse] = texte.match(new RegExp(`${echapperRegExp(reseau)} · (spn\\d+) · (10\\.78\\.\\d+\\.\\d+)`));
  console.log(`--- ${nom} attaché : ${iface} ${adresse} ---`);
  return { iface, adresse };
}
async function detacher(nom) {
  await ouvrir(nom);
  await page.click(`[data-detache-reseau="${reseau}"]`);
  await page.waitForSelector(`[data-confirme-detachement="${reseau}"]`, { timeout: 10000 });
  await page.click(`[data-confirme-detachement="${reseau}"]`);
  await attendreSection('#titre-reseau', 'membre d’aucun réseau privé');
  console.log(`--- ${nom} détaché ---`);
}
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
async function fermerTerminal() {
  await page.click('[data-terminal="fermer"]');
  await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });
}
const sondeHttp = (url, marque) =>
  `python3 -c "import urllib.request
try:
  print('${marque} ->', urllib.request.urlopen('${url}', timeout=6).status)
except Exception as e:
  print('${marque} ->', 'ERR', getattr(e, 'code', None) or type(e).__name__)"`;
const sondeTcp = (hote, p, marque) =>
  `python3 -c "import socket
s = socket.socket(); s.settimeout(4)
try:
  s.connect(('${hote}', ${p})); print('${marque} -> OUVERT')
except Exception as e:
  print('${marque} -> FERME', type(e).__name__)"`;

try {
  // 1. Le réseau, et le membre B — A reste HORS du réseau (§59.1).
  await forge();
  await page.click('[data-ouvre-reseau]');
  await page.waitForSelector('[data-modale="reseau-creation"] input[name="name"]', { timeout: 10000 });
  await page.fill('[data-modale="reseau-creation"] input[name="name"]', reseau);
  await page.fill('[data-modale="reseau-creation"] input[name="note"]', 'preuve OP-24 sur les cellules d’essai');
  await page.click('[data-modale="reseau-creation"] [data-engage="reseau-creation"]');
  await attendreSection('#titre-reseaux-prives', `${echapperRegExp(reseau)} · 10\\.78\\.\\d+\\.0/24 · spn\\d+`);
  console.log('--- réseau créé ---');
  const B = await attacher(b);
  const passerelle = B.adresse.replace(/\.\d+$/, '.1');
  // L'adresse privée de A se lit dans son dossier, section Accès — comme
  // l'exploitant la lirait.
  await ouvrir(a);
  const eth0A = (await page.evaluate(() => document.body.innerText))
    .match(/Adresse privée\s+(10\.77\.\d+\.\d+)/)?.[1] ?? null;
  console.log(`--- ${a} : eth0 ${eth0A} ; passerelle du réseau ${passerelle} ---`);

  // 2. Un service dans A, par son terminal.
  await accorderCle(a);
  await accorderCle(b);
  await terminal(a, [
    `cd /tmp && (nohup python3 -m http.server ${port} --bind 0.0.0.0 >/tmp/srv.log 2>&1 &) ; sleep 1 ; echo SERVEUR-PRET`,
  ], 'SERVEUR-PRET');
  await fermerTerminal();

  // 3. Le port de A publié DANS le réseau, depuis l'onglet Routes.
  await ouvrir(a, 'routes');
  await page.click('[data-ouvre="port"]');
  await page.waitForSelector('[data-modale="port"] select[name="scope"]', { timeout: 10000 });
  await page.selectOption('[data-modale="port"] select[name="scope"]', reseau);
  await page.fill('[data-modale="port"] input[name="public_port"]', port);
  await page.fill('[data-modale="port"] input[name="target_port"]', port);
  await page.fill('[data-modale="port"] input[name="port_note"]', 'preuve OP-24 : un service de A pour les membres');
  await capturer('spk111-forge-publier-lien');
  await page.click('[data-modale="port"] [data-engage="port"]');
  await attendreSection('#titre-ports', `${port}/tcp dans « ${echapperRegExp(reseau)} »`);
  const ligne = await texteDe('#titre-ports');
  const adresseLien = (ligne.match(/joignent en (10\.78\.\d+\.1:\d+)/) ?? [])[1];
  console.log(`--- lien publié : ${adresseLien} ---`);
  await capturer('spk111-forge-lien-publie');

  // 4. Depuis le terminal de B : la passerelle répond sur le port lié, et rien
  //    d'autre — ni un autre port, ni l'eth0 de A, ni le sshd de la Forge.
  const ecranB = await terminal(b, [
    sondeHttp(`http://${passerelle}:${port}/`, 'LIEN'),
    sondeTcp(passerelle, Number(port) + 1, 'AUTRE-PORT'),
    ...(eth0A ? [sondeTcp(eth0A, Number(port), 'ETH0-A')] : []),
    sondeTcp(passerelle, 22, 'FORGE-SPN'),
    'echo FIN-PREUVE-1',
  ], 'FIN-PREUVE-1');
  const resultat = {
    lien: dernier(ecranB, /LIEN -> (\S+)/), autrePort: dernier(ecranB, /AUTRE-PORT -> (\S+)/),
    eth0A: eth0A ? dernier(ecranB, /ETH0-A -> (\S+)/) : 'non sondé', forgeSpn: dernier(ecranB, /FORGE-SPN -> (\S+)/),
  };
  console.log(`--- terminal de ${b} ---`, resultat);
  await capturer('spk111-terminal-membre-joint');
  await fermerTerminal();

  // 5. Depuis le terminal de A : le service a lu l'adresse du membre.
  const ecranA = await terminal(a, [
    'tail -1 /tmp/srv.log | awk \'{print "SOURCE " $1}\'',
    `pkill -f '^python3 -m http.server ${port}' ; rm -f /tmp/srv.log ; echo NETTOYE`,
  ], 'NETTOYE');
  const source = dernier(ecranA, /SOURCE (\S+)/);
  console.log(`--- ${a} a lu l'adresse : ${source} (membre : ${B.adresse}) ---`);
  await capturer('spk111-terminal-exposee-source');
  await fermerTerminal();

  // 6. Tout défaire : le lien, l'adhésion, le réseau.
  await ouvrir(a, 'routes');
  await page.click(`[data-retire-port="${reseau}:${port}"]`);
  await page.waitForSelector(`[data-confirme-port="${reseau}:${port}"]`, { timeout: 10000 });
  await page.click(`[data-confirme-port="${reseau}:${port}"]`);
  await page.waitForFunction(
    ([p, r]) => !new RegExp(`${p}/tcp dans « ${r} »`).test(document.querySelector('#titre-ports')?.closest('section')?.innerText ?? ''),
    [port, echapperRegExp(reseau)], { timeout: 60000 });
  console.log('--- lien retiré ---');
  await detacher(b);
  await forge();
  await page.click(`[data-supprime-reseau="${reseau}"]`);
  await page.waitForSelector(`[data-confirme-suppression-reseau="${reseau}"]`, { timeout: 10000 });
  await page.click(`[data-confirme-suppression-reseau="${reseau}"]`);
  await page.waitForFunction(
    (r) => !new RegExp(`${r} · 10\\.78\\.`).test(document.querySelector('#titre-reseaux-prives')?.closest('section')?.innerText ?? ''),
    echapperRegExp(reseau), { timeout: 60000 });
  console.log('--- réseau supprimé ---\n' + await texteDe('#titre-reseaux-prives'));

  const ok = resultat.lien === '200' && /^FERME/.test(resultat.autrePort ?? '')
    && (resultat.eth0A === 'non sondé' || /^FERME/.test(resultat.eth0A))
    && /^FERME/.test(resultat.forgeSpn ?? '')
    && source === B.adresse && adresseLien === `${passerelle}:${port}`;
  console.log(ok ? 'PREUVE OK' : 'PREUVE EN ÉCHEC', { bruits });
  process.exitCode = ok ? 0 : 1;
} catch (erreur) {
  await page.screenshot({ path: join(CAPTURES, 'echecs', 'spk111-forge-reelle.png'), fullPage: true }).catch(() => {});
  await page.click('[data-terminal="fermer"]', { timeout: 3000 }).catch(() => {});
  console.error('ÉCHEC :', erreur.message, '\n', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500));
  process.exitCode = 1;
} finally {
  await navigateur.close();
}
