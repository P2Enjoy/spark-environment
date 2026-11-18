/**
 * OP-46, OP-47, OP-48 sur FORGE RÉELLE, par le parcours canonique : le SLA des instantanés (SPK-183),
 * l'onglet Santé (SPK-186), le canal courriel (SPK-62) et l'image par défaut (SPK-174), sur un Spark
 * d'ESSAI créé par le produit — jamais sur celui d'un locataire.
 *
 * @verifies docs/PROD_MIGRATIONS.md OP-46, OP-47, OP-48 · docs/BACKLOG.md#SPK-62, #SPK-174, #SPK-183,
 *           #SPK-184, #SPK-185, #SPK-186 · CLAUDE.md §16
 *
 * Joué sur instruction explicite du responsable (2026-11-18 : « Oui, sur spark-010 »). Hors campagne
 * automatique : contre la console d'exploitation (port 5175), sur la Forge nommée. UNE seule pile lourde à
 * la fois (CLAUDE.md §15 bis) : le verrou est pris à l'import. Les phases se jouent l'une après l'autre :
 *
 *   node e2e/forge-reelle/op48-preuves.mjs <phase> [serveur] [spark] [--garde-fichier=CHEMIN] [--destinataire=ADRESSE]
 *   phases : image | creer | sla | sante | smtp | geste | nettoyer
 *   --garde-fichier  (phase smtp) fichier 0600 qui porte le mot de passe des canaux ; il n'est jamais affiché
 *   --destinataire   (phase smtp) l'adresse qui reçoit les alertes
 *
 * La phase « smtp » lit les identifiants du relais sur l'AUTRE Forge (dans la cellule qui les porte) et les
 * pose dans le formulaire sans jamais les afficher : ni dans la sortie, ni dans une capture (champ masqué).
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Réglages d'épreuve : des ARGUMENTS NOMMÉS, jamais des variables d'environnement (CLAUDE.md §3).
const nommes = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => [a.slice(2).split('=')[0], a.slice(2).split('=').slice(1).join('=')]));
const [phase = 'image', serveur = 'spark-010', nom = 'essai-spk'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;
const FORGES = { 'spark-010': 'ubuntu@51.159.101.248', 'spark-experiment': 'ubuntu@51.158.54.202' };

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const bruits = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) bruits.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

let ok = true;
const verifier = (condition, message) => {
  console.log(`  ${condition ? 'ok    ' : 'ÉCHEC '} ${message}`);
  if (!condition) ok = false;
};

async function capturer(titre, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(500);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `op48-${serveur}-${titre}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`  capture : op48-${serveur}-${titre}.jpg`);
}

/** Lecture seule sur la Forge, par SSH — sert à CONSTATER un effet, jamais à agir (CLAUDE.md §16). */
function lire(chemin) {
  const brut = execFileSync('ssh', ['-o', 'BatchMode=yes', FORGES[serveur],
    `curl -s http://127.0.0.1:9876${chemin}`], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(brut);
}

async function accueil() {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#selecteur-serveur', { timeout: 30000 });
  if ((await page.locator('#selecteur-serveur').inputValue()) !== serveur) {
    await page.selectOption('#selecteur-serveur', serveur);
  }
  await page.waitForFunction(() => /Tunnel ouvert/.test(document.body.innerText), null, { timeout: 60000 });
  await page.waitForSelector('tbody a', { timeout: 30000 });
}
async function ouvrir(spark, facette = '') {
  await accueil();
  await page.click(`tbody a:has-text("${spark}")`);
  await page.waitForSelector('.entete-entite', { timeout: 30000 });
  if (facette) {
    await page.click(`.onglet[href$="/${facette}"]`);
    await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`, { timeout: 10000 });
  }
}

let avant = null;
try {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#selecteur-serveur', { timeout: 30000 });
  avant = await page.locator('#selecteur-serveur').inputValue();
  console.log(`=== phase « ${phase} » — ${serveur} — Spark d'essai « ${nom} » — serveur courant avant : ${avant}`);

  if (phase === 'image') {
    // SPK-174 : désigner une autre image, constater côté Forge, puis REMETTRE l'état d'avant.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.click('.onglet[href="#/forge/images"]');
    await page.waitForSelector('#titre-catalogue', { timeout: 30000 });
    const depart = lire('/v1/images').images;
    const origine = depart.find((i) => i.is_default);
    const cible = depart.find((i) => i.state === 'verified' && !i.is_default);
    console.log(`  défaut d'origine : ${origine.reference} ; cible : ${cible.reference}`);
    await capturer('image-avant');
    await page.click(`tr:has-text("${cible.reference}") [data-defaut]`);
    await page.waitForSelector('[data-defaut-info]', { timeout: 30000 });
    const apres = lire('/v1/images').images;
    verifier(apres.filter((i) => i.is_default).map((i) => i.reference).join() === cible.reference,
      `la Forge réelle n'a qu'UNE entrée par défaut : ${cible.reference}`);
    await capturer('image-apres');
    await page.click(`tr:has-text("${origine.reference}") [data-defaut]`);
    await page.waitForFunction((r) => /était déjà|désormais/.test(document.querySelector('[data-defaut-info]')?.innerText ?? '')
      && document.querySelector('[data-defaut-info]')?.innerText.includes(r), origine.reference, { timeout: 30000 });
    verifier(lire('/v1/images').images.find((i) => i.is_default).reference === origine.reference,
      `l'état d'avant est rétabli : ${origine.reference}`);
  }

  if (phase === 'creer') {
    await accueil();
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });
    await page.fill('#name', nom);
    await page.selectOption('#image', 'images:ubuntu/26.04');
    for (const [id, valeur] of [['#cpu_reservation', '0.25'], ['#memory_gib', '1'],
                                ['#storage_gib', '10'], ['#network_mbit', '10'], ['#burst_mbit', '10']]) {
      await page.fill(id, valeur);
    }
    await capturer('creer-formulaire');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.entete-entite, .refus', { timeout: 60000 });
    if (await page.locator('.refus').count()) throw new Error('création refusée : ' + (await page.locator('.refus').innerText()));
    await page.click('[data-commande="apply"]');
    await page.waitForSelector('[data-commande="start"]', { timeout: 120000 });
    await page.click('[data-commande="start"]');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 120000 });
    verifier(lire('/v1/sparks').sparks.some((s) => s.name === nom && s.state === 'running'),
      `« ${nom} » tourne sur la Forge réelle`);
  }

  if (phase === 'sla') {
    // SPK-183 : programmer le SLA depuis l'onglet Instantanés, constater qu'il est au registre de la Forge.
    await ouvrir(nom, 'instantanes');
    await page.waitForSelector('section[aria-labelledby="titre-sla"]', { timeout: 30000 });
    await capturer('sla-avant');
    await page.click('[data-ouvre="sla"]');
    await page.waitForSelector('#sla-phrase', { timeout: 10000 });
    await page.fill('#sla-schedule', '*/15 * * * *');
    await page.fill('#sla-count', '2');
    await page.waitForFunction(() => /15 minutes/.test(document.querySelector('#sla-phrase')?.textContent ?? ''), null, { timeout: 15000 });
    await capturer('sla-modale');
    await page.click('[data-engage="sla"]');
    await page.waitForSelector('dialog#sla', { state: 'detached', timeout: 30000 });
    const sla = lire(`/v1/sparks/${nom}/sla`);
    verifier(sla.schedule === '*/15 * * * *' && sla.enabled, `le SLA est au registre de la Forge réelle (${sla.schedule}, actif)`);
    await capturer('sla-actif');
  }

  if (phase === 'sante') {
    // SPK-186 : deux sondes SCRIPT, exécutées par la vraie cellule — l'une réussit, l'autre non.
    await ouvrir(nom, 'sante');
    await page.waitForSelector('section[aria-labelledby="titre-sante"]', { timeout: 30000 });
    for (const [nomSonde, commande] of [['script-ok', 'true'], ['script-ko', 'exit 2']]) {
      await page.click('[data-ouvre="sante"]');
      await page.waitForSelector('#sante-name', { timeout: 10000 });
      await page.fill('#sante-name', nomSonde);
      await page.selectOption('#sante-kind', 'script');
      await page.fill('#sante-commande', commande);
      await page.fill('#sante-threshold', '1');
      await page.waitForSelector('#sante-phrase', { timeout: 10000 });
      await page.waitForFunction(() => /5 minutes/.test(document.querySelector('#sante-phrase')?.textContent ?? ''), null, { timeout: 15000 });
      if (nomSonde === 'script-ko') {
        await page.click('[data-sante-tester]');
        await page.waitForFunction(() => /L’essai a échoué/.test(document.querySelector('#sante-test')?.textContent ?? ''), null, { timeout: 60000 });
        verifier(/code de sortie 2/.test(await page.textContent('#sante-test')), 'l\'essai d\'un script en échec est vu, dans la VRAIE cellule, sans rien enregistrer');
        await capturer('sante-essai-echec');
      }
      await page.waitForFunction(() => !document.querySelector('[data-engage="sante"]')?.disabled, null, { timeout: 15000 });
      await page.click('[data-engage="sante"]');
      await page.waitForSelector('dialog#sante', { state: 'detached', timeout: 30000 });
      await page.waitForSelector(`[data-sante-sonde="${nomSonde}"]`, { timeout: 30000 });
    }
    verifier(lire(`/v1/sparks/${nom}/health`).checks.length === 2, 'les deux sondes sont au registre de la Forge réelle');
    await capturer('sante-posees');
  }

  if (phase === 'proposition') {
    // SPK-185 / SPK-186 : la cellule a ÉCRIT /etc/spark/health.? (par son propre chemin) ; la console la relit
    // ligne par ligne avec le verdict du SERVEUR, et l'acceptation pose la sonde.
    await ouvrir(nom, 'sante');
    await page.waitForSelector('[data-proposition="health"]', { timeout: 60000 });
    await page.locator('[data-proposition="health"] [data-sugg-ouvrir="health"]').click();
    await page.waitForFunction(() => document.querySelector('[data-proposition="health"] .badge--success, [data-proposition="health"] .badge--danger'), null, { timeout: 60000 });
    await capturer('proposition');
    verifier(!lire(`/v1/sparks/${nom}/health`).checks.some((c) => c.name === 'proposee'), 'une proposition ne pose RIEN');
    await page.click('[data-sugg-appliquer="health"]');
    await page.waitForSelector('[data-sante-sonde="proposee"]', { timeout: 60000 });
    verifier(lire(`/v1/sparks/${nom}/health`).checks.some((c) => c.name === 'proposee'), 'l\'acceptation pose la sonde sur la Forge réelle');
    await capturer('proposition-acceptee');
  }

  if (phase === 'smtp') {
    // SPK-62 : régler le canal courriel avec les identifiants du relais de l'AUTRE Forge, sans les afficher.
    const lireSecret = (cle) => {
      const sortie = execFileSync('ssh', ['-o', 'BatchMode=yes', FORGES['spark-experiment'],
        `sudo -n incus exec sso-p2enjoy -- sh -c "grep -E '^${cle}=' /run/spark/secrets | head -1 | cut -d= -f2-"`],
      { encoding: 'utf8', timeout: 60000 }).trim();
      return sortie.replace(/^(['"])(.*)\1$/, '$2');
    };
    const utilisateur = lireSecret('SSO_SMTP_USER');
    const motDePasse = lireSecret('SSO_SMTP_PASSWORD');
    verifier(utilisateur.length > 8 && motDePasse.length > 8, 'identifiants lus sur l\'autre Forge (longueurs plausibles, valeurs non affichées)');
    if (!nommes['garde-fichier']) throw new Error('--garde-fichier manquant : le mot de passe des canaux vit dans un fichier 0600');
    const garde = (await readFile(nommes['garde-fichier'], 'utf8')).trim();
    const destinataire = nommes.destinataire;
    if (!destinataire) throw new Error('--destinataire manquant');
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.click('.onglets a[href="#/forge/alertes"]');
    await page.waitForSelector('#formulaire-smtp', { timeout: 30000 });
    await page.fill('#smtp-hote', 'smtp.tem.scaleway.com');
    await page.fill('#smtp-port', '2465');
    await page.selectOption('#smtp-tls', 'tls');
    await page.fill('#smtp-compte', utilisateur);
    await page.fill('#smtp-secret', motDePasse);
    await page.fill('#smtp-de', 'no-reply@noreply.lelabs.tech');
    await page.fill('#smtp-a', destinataire);
    await page.check('#smtp-actif');
    await page.fill('#smtp-mot', garde);
    await page.click('#formulaire-smtp button[type="submit"]');
    await page.waitForFunction(() => /canal courriel enregistrée|refus|Mot de passe|ne part pas/.test(
      document.querySelector('#formulaire-smtp')?.innerText ?? ''), null, { timeout: 30000 });
    const vu = lire('/v1/notify/channels');
    verifier(vu.smtp.enabled && vu.smtp.password_set && vu.live_smtp.configured, 'le canal courriel est actif sur la Forge réelle, mot de passe enregistré');
    verifier(!JSON.stringify(vu).includes(motDePasse), 'le mot de passe ne ressort PAS de l\'API');
    await capturer('smtp-actif');
  }

  if (phase === 'geste') {
    // SPK-62 : un VRAI geste sensible (supprimer un instantané) depuis l'écran, sur le Spark d'essai ; les
    // compteurs de la Forge disent ensuite si le courriel est parti (relais joint, message accepté).
    const avantEnvoi = lire('/v1/notify/channels').live_smtp.sent;
    await ouvrir(nom, 'instantanes');
    await page.click('[data-ouvre="snapshot"]');
    await page.waitForSelector('#instantane-nom', { timeout: 10000 });
    await page.fill('#instantane-nom', 'essai-alerte');
    await page.click('[data-engage="snapshot"]');
    await page.waitForSelector('[data-supprime-instantane="essai-alerte"]', { timeout: 60000 });
    await page.click('[data-supprime-instantane="essai-alerte"]');
    await page.waitForSelector('[data-confirme-suppression="essai-alerte"]', { timeout: 10000 });
    await page.click('[data-confirme-suppression="essai-alerte"]');
    await page.waitForFunction(() => !document.querySelector('[data-supprime-instantane="essai-alerte"]'), null, { timeout: 60000 });
    let live;
    for (let i = 0; i < 20; i += 1) {
      live = lire('/v1/notify/channels').live_smtp;
      if (live.sent > avantEnvoi || live.failed > 0) break;
      await page.waitForTimeout(1500);
    }
    console.log(`  canal courriel : envoyées ${live.sent}, en échec ${live.failed}, dernier motif : ${live.last_error ?? '—'}`);
    verifier(live.sent > avantEnvoi, 'le relais a ACCEPTÉ le courriel de l\'alerte (geste réel sur la Forge réelle)');
    await ouvrir(nom, 'instantanes');
    await page.click('nav a[href="#/forge"]');
    await page.click('.onglets a[href="#/forge/alertes"]');
    await page.waitForSelector('#formulaire-smtp', { timeout: 30000 });
    await capturer('smtp-apres-geste');
  }

  if (phase === 'nettoyer') {
    await ouvrir(nom);
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('[data-frappe="delete"]', { timeout: 10000 });
    await page.fill('[data-frappe="delete"]', nom);
    await page.click('[data-confirme]');
    await page.waitForFunction((n) => ![...document.querySelectorAll('tbody a')]
      .some((a) => a.textContent.trim() === n), nom, { timeout: 90000 });
    verifier(!lire('/v1/sparks').sparks.some((s) => s.name === nom), `Spark jetable « ${nom} » supprimé de la Forge réelle`);
  }
} catch (erreur) {
  ok = false;
  console.log(`ERREUR : ${erreur.message}`);
  await capturer('erreur').catch(() => {});
} finally {
  if (avant && avant !== serveur) {
    await page.selectOption('#selecteur-serveur', avant).catch(() => {});
  }
  if (bruits.length) console.log(`console du navigateur :\n  ${bruits.slice(0, 8).join('\n  ')}`);
  await navigateur.close();
}
console.log(ok ? 'VERT' : 'ROUGE');
process.exit(ok ? 0 : 1);
