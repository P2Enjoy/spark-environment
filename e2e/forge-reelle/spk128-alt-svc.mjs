/**
 * Preuve sur FORGE RÉELLE, après OP-27 : l'ingress ne sert pas HTTP/3, cesse de
 * l'annoncer, et le dossier du Spark le dit.
 *
 * @verifies docs/BACKLOG.md#SPK-128 · docs/DAT.md §18.6 (l'annonce remplacée
 *           par `Alt-Svc: clear`), §44.2 quater (le dossier le dit) ·
 *           docs/BACKLOG.md#SPK-130 · docs/DAT.md §18.7 (l'onglet Routes relève
 *           Caddy et le certificat, pour de vrai) · CLAUDE.md §16
 *
 * Deux personnes, deux parcours, chacun par son entrée ordinaire :
 *
 *   1. le VISITEUR tape l'adresse d'un domaine servi dans un navigateur. On
 *      relève ce que le navigateur a reçu — le protocole négocié et
 *      l'`alt-svc` de la page —, pas ce qu'un `curl` aurait reçu ;
 *   2. l'EXPLOITANT ouvre la console d'exploitation (`sparkui`, port 5175), clique
 *      le Spark qui sert ce domaine depuis l'accueil, déplie son dossier et
 *      lit ce qu'il dit de l'ingress. Les captures vont dans `e2e/captures/`,
 *      pour être OBSERVÉES.
 *
 * L'écoute UDP/443 se vérifie sur la Forge (`ss -lnu`, OP-27) : un navigateur ne
 * peut pas la voir.
 *
 *   make forge-reelle SCRIPT=spk128-alt-svc ARGS="<spark> <domaine> [<domaine>…]"
 */
// CLAUDE.md §15 bis · docs/DAT.md §29.8 : ce script lance un Chromium. Le
// verrou est pris ICI, à l'import, avant la moindre allocation.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [spark = 'sso-p2enjoy', ...domainesDonnes] = process.argv.slice(2);
const domaines = domainesDonnes.length ? domainesDonnes : ['oauth.lelabs.tech'];
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;

const navigateur = await chromium.launch();
const bruits = [];

async function capturer(page, nom, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(600);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  console.log(`capture : ${nom}.jpg`);
}

/** Ce qu'un navigateur NEUF reçoit en ouvrant `https://<domaine>/`. */
async function visiter(domaine) {
  // Un contexte neuf : aucune annonce mémorisée d'une visite précédente.
  const contexte = await navigateur.newContext();
  const page = await contexte.newPage();
  const cdp = await contexte.newCDPSession(page);
  await cdp.send('Network.enable');
  let protocole = null;
  cdp.on('Network.responseReceived', ({ type, response }) => {
    if (type === 'Document' && protocole === null) protocole = response.protocol;
  });
  const reponse = await page.goto(`https://${domaine}/`, { waitUntil: 'domcontentloaded' });
  // La PREMIÈRE réponse de la chaîne : la racine d'un SSO redirige, et c'est
  // chaque réponse de l'ingress qui doit porter l'en-tête.
  let premiere = reponse.request();
  while (premiere.redirectedFrom()) premiere = premiere.redirectedFrom();
  const altSvc = [
    (await premiere.response())?.headers()['alt-svc'] ?? null,
    reponse.headers()['alt-svc'] ?? null,
  ];
  await contexte.close();
  return { domaine, statut: reponse.status(), protocole, altSvc };
}

try {
  // 1. Le visiteur.
  const visites = [];
  for (const domaine of domaines) visites.push(await visiter(domaine));
  for (const v of visites) console.log('visite :', v);

  // 2. L'exploitant : l'accueil de la console, puis le Spark, par son lien.
  const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) bruits.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
  await page.click(`tbody a:has-text("${spark}")`);
  await page.waitForSelector('[data-dossier-copie]', { timeout: 20000 });
  await page.click('.dossier .repli > summary');
  await page.waitForSelector('.dossier__texte', { timeout: 10000 });
  const dossier = await page.locator('.dossier__texte').innerText();
  // Amener les lignes de l'ingress sous les yeux, dans le texte qui défile.
  await page.evaluate((cherche) => {
    const pre = document.querySelector('.dossier__texte');
    const index = pre.textContent.indexOf(cherche);
    if (index < 0) return;
    const plage = document.createRange();
    plage.setStart(pre.firstChild, index);
    plage.setEnd(pre.firstChild, index + 1);
    pre.scrollTop += plage.getBoundingClientRect().top - pre.getBoundingClientRect().top - 12;
  }, 'Les visiteurs atteignent l');
  await page.locator('.dossier').scrollIntoViewIfNeeded();
  await capturer(page, 'spk128-forge-dossier-ingress');
  await capturer(page, 'spk128-forge-dossier-ingress-mobile', { largeur: 390, hauteur: 1600 });

  // 3. SPK-130 : l'onglet Routes du même Spark, par son onglet. Le relevé est
  //    celui des SONDES RÉELLES de la Forge — la page ne doit pas dire
  //    « factices » —, et chaque domaine demandé est servi, certificat reconnu.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('.onglet[href$="/routes"]');
  await page.waitForFunction(
    () => /relevés à/.test(document.querySelector('section[aria-labelledby="titre-routes"]')
      ?.textContent ?? ''), null, { timeout: 30000 });
  const section = await page.textContent('section[aria-labelledby="titre-routes"]');
  const routesVues = {};
  for (const domaine of domaines) {
    const ligne = await page.locator(
      `li:has(span.technique:text-is("${domaine}"))`).textContent({ timeout: 2000 })
      .catch(() => '');
    // Un domaine visité peut relever d'un AUTRE Spark : seul celui-ci est ici.
    if (!ligne) continue;
    routesVues[domaine] = {
      caddy: /Caddy ici · \d{3}/.test(ligne) && !/pile muette/.test(ligne),
      tls: /TLS valide · \d+ j/.test(ligne),
    };
  }
  console.log('onglet Routes :', { factices: /factices/.test(section), routesVues });
  await capturer(page, 'spk130-forge-routes');
  await capturer(page, 'spk130-forge-routes-mobile', { largeur: 390, hauteur: 1200 });

  const dit = {
    http3: dossier.includes('pas en HTTP/3'),
    clear: dossier.includes("l'ingress pose `Alt-Svc: clear`"),
    retire: dossier.includes('de vos réponses `Alt-Svc`'),
    securite: dossier.includes("n'ajoute aucun en-tête de sécurité"),
  };
  console.log('le dossier dit :', dit);

  // `h2` : le navigateur a négocié HTTP/2 ; `clear` sur CHAQUE réponse de la
  // chaîne, redirection comprise, et plus aucun `h3=`.
  const visitesOk = visites.every((v) => v.protocole === 'h2'
    && v.altSvc.every((valeur) => valeur === 'clear'));
  const routesOk = !/factices/.test(section) && Object.keys(routesVues).length > 0
    && Object.values(routesVues).every((r) => r.caddy && r.tls);
  const ok = visitesOk && routesOk && Object.values(dit).every(Boolean) && bruits.length === 0;
  console.log(ok ? 'PREUVE OK' : 'PREUVE EN ÉCHEC', { bruits });
  process.exitCode = ok ? 0 : 1;
} catch (erreur) {
  console.error('ÉCHEC :', erreur.message);
  process.exitCode = 1;
} finally {
  await navigateur.close();
}
