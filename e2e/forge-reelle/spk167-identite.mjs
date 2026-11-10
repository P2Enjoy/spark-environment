/**
 * SPK-167 sur FORGE RÉELLE, avec un Spark JETABLE, par le parcours canonique :
 * l'identité d'un Spark rootless appartient au compte `spark-docker`, et ce
 * compte s'en sert vraiment — un `git clone` par SSH, avec cette clé, aboutit.
 *
 * @verifies docs/BACKLOG.md#SPK-167 · docs/DAT.md §17.6 (pour QUEL compte le
 *           Spark présente son identité), §17.5, §42.2 bis, §42.2 quater ·
 *           docs/PROD_MIGRATIONS.md#OP-42 · docs/DAT.md §28.7 (la pile factice
 *           ne conclut pas : cette preuve est celle qui le peut) · CLAUDE.md §16
 *
 * Hors campagne automatique : se joue contre la console d'exploitation ouverte
 * sur une Forge réelle (`sparkui`, port 5175), sur feu vert explicite du
 * responsable. UNE seule pile lourde à la fois (CLAUDE.md §15 bis) : le verrou
 * est pris à l'import.
 *
 * Le Spark est JETABLE : créé, éprouvé, supprimé — le tout par l'écran. Ce qu'il
 * coûte à la Forge est dit, parce que ce n'est pas rien : chaque mode CPU
 * réserve au moins 0,25 CPU, et sa suppression envoie l'alerte hors bande de
 * `spark.delete` (DAT §47.2). Le scénario est découpé en phases courtes, chacune
 * sous la limite d'un premier plan, pour que le nettoyage ne dépende jamais
 * d'une phase longue :
 *
 *   make forge-reelle SCRIPT=spk167-identite ARGS="creer   <etat.json>"
 *   make forge-reelle SCRIPT=spk167-identite ARGS="amorcer <etat.json>"
 *   make forge-reelle SCRIPT=spk167-identite ARGS="preuve  <etat.json>"
 *   make forge-reelle SCRIPT=spk167-identite ARGS="nettoyer <etat.json>"
 *
 * `<etat.json>` porte ce que les phases se passent (l'empreinte d'avant la
 * reprise). Il ne contient ni clé privée ni secret : une empreinte et un nom.
 *
 * Ce que la preuve établit, dans l'ordre :
 *   1. l'identité créée AVANT l'amorçage est celle de root (`/root/.ssh`) ;
 *   2. après l'amorçage rootless, la console dit « Aucune identité » (§17.6 : le
 *      compte n'en a pas) ; « Créer l'identité » la REPREND : même empreinte,
 *      chemin du compte ;
 *   3. sous `spark-docker`, dans le terminal de la console : la clé est lisible,
 *      lui appartient en `0600`, et un `git clone` par SSH aboutit avec elle ;
 *   4. « Remplacer… » donne une clé NEUVE au compte, et le clone aboutit encore.
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [phase, fichierEtat, nom = 'jetable-167'] = process.argv.slice(2);
const CONSOLE = process.env.SPARK_CONSOLE_URL ?? 'http://localhost:5175/';
const CAPTURES = new URL('../captures/', import.meta.url).pathname;
const CHEMIN_COMPTE = '/home/spark-docker/.ssh/id_ed25519';
const CHEMIN_ROOT = '/root/.ssh/id_ed25519';

if (!['creer', 'amorcer', 'preuve', 'nettoyer'].includes(phase) || !fichierEtat) {
  console.error('usage : spk167-identite.mjs <creer|amorcer|preuve|nettoyer> <etat.json> [nom]');
  process.exit(2);
}

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1440, height: 1000 } });
const bruits = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bruits.push(m.text());
});
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

const etat = JSON.parse(await readFile(fichierEtat, 'utf8').catch(() => '{}'));
const sauver = () => writeFile(fichierEtat, JSON.stringify(etat, null, 2));

async function capturer(cle, { largeur = 1440, hauteur = 1000 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.waitForTimeout(400);
  await mkdir(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `spk167-reelle-${cle}.jpg`), type: 'jpeg',
                          quality: 82, fullPage: true });
  console.log(`capture : spk167-reelle-${cle}.jpg`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const attendreTexte = (motif, delai = 30000) => page.waitForFunction(
  (m) => new RegExp(m).test(document.body.innerText), motif, { timeout: delai });

/** L'accueil de la console, puis le Spark PAR SON LIEN, puis une facette. */
async function ouvrir(facette = '') {
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 30000 });
  await page.getByRole('link', { name: nom, exact: true }).first().click();
  await page.waitForSelector('.entete-entite', { timeout: 20000 });
  if (facette) {
    await page.click(`.onglet[href$="/${facette}"]`);
    await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`, { timeout: 20000 });
  }
}

/** Ce que le panneau d'identité dit, et rien d'autre. */
async function identite() {
  await page.waitForSelector('section.identite', { timeout: 20000 });
  await page.waitForFunction(
    () => !/Lecture de l’identité/.test(document.querySelector('section.identite').innerText),
    null, { timeout: 30000 });
  const texte = (await page.locator('section.identite').innerText()).replace(/\s+/g, ' ');
  const lire = async (libelle) => (await page.locator(
    `section.identite .def:has(dt:text-is("${libelle}")) dd`).first().innerText().catch(() => null))?.trim() ?? null;
  return { texte, empreinte: await lire('Empreinte'), chemin: await lire('Dans la cellule'),
           cle: (await page.locator('.bloc-cle').first().textContent().catch(() => null))?.trim() ?? null };
}

/** Une commande dans le terminal de la console, et ce qu'elle a rendu. */
async function ouvrirTerminal(compte) {
  await page.click('.onglet[href$="/terminal"]');
  await page.waitForSelector('#titre-terminal', { timeout: 30000 });
  if (await page.locator('[data-terminal="fermer"]').count()) {
    await page.click('[data-terminal="fermer"]');
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });
  }
  if (await page.locator('[data-terminal="compte"]').count()) {
    await page.selectOption('[data-terminal="compte"]', compte);
  } else if (compte !== 'root') {
    throw new Error(`le terminal n'offre pas le compte « ${compte} »`);
  }
  await page.click('[data-terminal="ouvrir"]');
  await page.waitForSelector('[data-terminal="fermer"]', { timeout: 40000 });
  const grille = page.locator('.terminal--emulateur .xterm-helper-textarea');
  await grille.waitFor({ state: 'attached', timeout: 30000 });
  await attendreTexte('~[#$]', 40000);
  return grille;
}
async function fermerTerminal() {
  await page.click('[data-terminal="fermer"]', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 }).catch(() => {});
}
/** Chaque résultat est annoncé `ETIQUETTE=valeur` ; la commande tapée, elle, porte
 *  `ETIQUETTE=$(` — le motif exige un caractère qui n'est pas `$`, donc l'écho de
 *  la saisie ne passe jamais pour le résultat. */
async function jouer(grille, etiquette, commande, delai = 60000) {
  // Les accolades : sans elles, seule la DERNIÈRE commande d'une suite `a; b; c`
  // passerait dans `tr`, et la sortie des autres arriverait sur plusieurs lignes.
  // `\r` autant que `\n` : l'avertissement de `ssh` sur known_hosts finit par
  // `\r\n`, et un retour chariot ramène le curseur en début de ligne — il écrasait
  // l'étiquette à l'écran (mesuré sur la Forge réelle, 2026-11-10).
  await grille.pressSequentially(`echo "${etiquette}=$( { ${commande}; } 2>&1 | tr '\\r\\n' '  ' | cut -c1-200)"`);
  await grille.press('Enter');
  const motif = new RegExp(`${etiquette}=([^$\\n][^\\n]*)`);
  await page.waitForFunction(
    ({ m }) => new RegExp(m).test(document.querySelector('.xterm-rows')?.innerText ?? ''),
    { m: motif.source }, { timeout: delai });
  const ecran = await page.locator('.xterm-rows').innerText();
  return (ecran.match(motif) ?? [])[1]?.trim() ?? '';
}

let ok = true;
const verifier = (condition, message) => {
  console.log(`  ${condition ? 'ok    ' : 'ÉCHEC '} ${message}`);
  if (!condition) ok = false;
};

try {
  console.log(`=== phase « ${phase} » — Spark « ${nom} » — console ${CONSOLE}`);

  if (phase === 'creer') {
    await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('tbody a', { timeout: 30000 });
    console.log('Forge servie par la console :', (await page.locator('aside, nav').first().innerText()).replace(/\s+/g, ' ').slice(0, 120));
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });
    await page.fill('#name', nom);
    // Le plus petit possible : la Forge n'a que 0,25 CPU de réservable.
    for (const [id, valeur] of [['#cpu_reservation', '0.25'], ['#memory_gib', '2'],
                                ['#storage_gib', '10'], ['#network_mbit', '10'], ['#burst_mbit', '10']]) {
      await page.fill(id, valeur);
    }
    await capturer('01-formulaire');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.entete-entite, .refus', { timeout: 30000 });
    if (await page.locator('.refus').count()) {
      throw new Error('création refusée : ' + (await page.locator('.refus').innerText()).replace(/\s+/g, ' '));
    }
    await page.click('[data-commande="apply"]');
    await page.waitForSelector('[data-commande="start"]', { timeout: 60000 });
    await page.click('[data-commande="start"]');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 90000 });
    verifier(true, 'Spark jetable créé, appliqué, démarré');

    // 1. L'identité créée AVANT l'amorçage rootless : celle de root.
    await page.click('.onglet[href$="/cles"]');
    await page.waitForSelector('[data-identite-creer]', { timeout: 30000 });
    await page.click('[data-identite-creer]');
    await page.waitForSelector('.bloc-cle, section.identite .refus', { timeout: 60000 });
    const avant = await identite();
    console.log('identité avant amorçage :', avant.empreinte, avant.chemin);
    verifier(avant.chemin === CHEMIN_ROOT, `avant l'amorçage, l'identité est celle de root (${avant.chemin})`);
    etat.empreinteRoot = avant.empreinte;
    etat.cleRoot = avant.cle;
    await sauver();
    await capturer('02-identite-avant-amorcage');
  }

  if (phase === 'amorcer') {
    await ouvrir();
    await page.waitForSelector('#titre-amorcage', { timeout: 20000 });
    await page.click('[data-amorcage="amorcer"]');
    await page.waitForSelector('[data-amorcage="engager"]', { timeout: 15000 });
    await page.check('#amorcage-rootless');
    await capturer('03-amorcage-confirmation');
    await page.click('[data-amorcage="engager"]');
    // Docker rootless s'installe depuis le dépôt amont : plusieurs minutes.
    await page.waitForSelector('.liste-amorcage', { timeout: 540000 });
    const compteRendu = (await page.textContent('#titre-amorcage ~ .liste-amorcage')).replace(/\s+/g, ' ');
    console.log('compte rendu :', compteRendu.slice(0, 400));
    verifier(/rootless/.test(compteRendu), 'l\'amorçage s\'est fait en rootless');
    await capturer('04-amorcage-fait');
  }

  if (phase === 'preuve') {
    // 2. La reprise, depuis l'écran des clés.
    await ouvrir('cles');
    await page.waitForSelector('#titre-cles', { timeout: 20000 });
    await page.waitForSelector('section.identite', { timeout: 20000 });
    await page.waitForFunction(
      () => !/Lecture de l’identité/.test(document.querySelector('section.identite').innerText),
      null, { timeout: 30000 });
    const avant = await identite();
    // Reprenable : une phase interrompue après la reprise ne la rejoue pas (elle
    // serait refusée, à raison : l'identité du compte existe déjà).
    const dejaRepris = avant.chemin === CHEMIN_COMPTE && etat.empreinteCompte;
    if (!dejaRepris) {
      verifier(/Aucune identité/.test(avant.texte),
        'rootless : « Aucune identité » — le compte, lui, n\'en a pas (§17.6)');
      await capturer('05-aucune-identite-pour-le-compte');
      await page.focus('[data-identite-creer]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.bloc-cle', { timeout: 60000 });
    } else {
      console.log('reprise déjà faite par une exécution précédente : on la relit.');
    }
    const reprise = await identite();
    console.log('après reprise :', reprise.empreinte, reprise.chemin);
    verifier(reprise.chemin === CHEMIN_COMPTE, `chemin du compte (${reprise.chemin})`);
    verifier(reprise.empreinte === etat.empreinteRoot, 'MÊME empreinte que celle de root : la clé posée chez le tiers reste valide');
    await capturer('06-identite-reprise');
    await capturer('06-identite-reprise-mobile', { largeur: 390, hauteur: 844 });
    etat.empreinteCompte = reprise.empreinte;
    etat.cleCompte = reprise.cle;
    await sauver();

    // 3. Le serveur Git de la cellule, en root : un compte « deploy » qui n'accepte
    //    que la clé du Spark, et un dépôt nu. C'est le rôle que GitHub joue ailleurs.
    let grille = await ouvrirTerminal('root');
    const installation = await jouer(grille, 'GIT_INSTALLE',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1; git --version', 240000);
    verifier(/git version/.test(installation), `git est installé dans la cellule (${installation})`);
    await jouer(grille, 'DEPLOY_PRET',
      'id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy; ' +
      'install -d -m 700 -o deploy -g deploy /home/deploy/.ssh; ' +
      'rm -rf /home/deploy/repo.git /tmp/graine; ' +
      'git init -q --bare -b main /home/deploy/repo.git; ' +
      'git init -q -b main /tmp/graine; cd /tmp/graine; ' +
      'git -c user.name=jetable -c user.email=jetable@invalid commit -q --allow-empty -m "graine SPK-167"; ' +
      'git push -q /home/deploy/repo.git main; chown -R deploy:deploy /home/deploy/repo.git; echo pret');
    const autorise = async () => jouer(grille, 'AUTORISE',
      'install -m 600 -o deploy -g deploy /home/spark-docker/.ssh/id_ed25519.pub /home/deploy/.ssh/authorized_keys; ' +
      'ssh-keygen -lf /home/deploy/.ssh/authorized_keys | cut -d" " -f2');
    etat.autorise1 = await autorise();
    verifier(etat.autorise1 === etat.empreinteRoot, `le « tiers » n'accepte que la clé reprise (${etat.autorise1})`);
    await fermerTerminal();

    // 4. Sous spark-docker, dans son terminal : la clé se lit, et le clone aboutit.
    grille = await ouvrirTerminal('spark-docker');
    const bandeau = (await page.textContent('.bandeau-terminal')).replace(/\s+/g, ' ');
    verifier(/spark-docker/.test(bandeau), 'le terminal est ouvert sous spark-docker (le bandeau le dit)');
    verifier((await jouer(grille, 'QUI', 'id -un')) === 'spark-docker', 'qui suis-je : spark-docker');
    const fiche = await jouer(grille, 'FICHE', 'stat -c "%U:%G %a" ~/.ssh/id_ed25519');
    verifier(fiche === 'spark-docker:spark-docker 600', `la clé appartient au compte, en 0600 (${fiche})`);
    const empreinte = await jouer(grille, 'EMPREINTE', 'ssh-keygen -y -f ~/.ssh/id_ed25519 | ssh-keygen -lf - | cut -d" " -f2');
    verifier(empreinte === etat.empreinteRoot, `le compte LIT sa clé privée : empreinte dérivée ${empreinte}`);
    const clone = await jouer(grille, 'CLONE',
      'rm -rf /tmp/clone-1; GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" ' +
      'git clone -q ssh://deploy@127.0.0.1/home/deploy/repo.git /tmp/clone-1 && git -C /tmp/clone-1 log --oneline | head -1', 90000);
    verifier(/graine SPK-167/.test(clone), `git clone par SSH avec la clé reprise : ${clone}`);
    await capturer('07-terminal-clone-compte');
    // Ce que ssh dit de known_hosts (§17.6, « ce que cette section ne règle pas ») :
    // le dossier est à root, le compte ne peut pas l'écrire. On le MESURE ici.
    const kh = await jouer(grille, 'KNOWN_HOSTS', 'ls ~/.ssh/known_hosts 2>&1 | head -1');
    console.log('known_hosts :', kh);
    etat.knownHosts = kh;
    await fermerTerminal();

    // 5. Remplacer : une clé NEUVE pour le compte, et le clone aboutit encore.
    await page.click('.onglet[href$="/cles"]');
    await page.waitForSelector('[data-identite-remplacer]', { timeout: 30000 });
    await page.click('[data-identite-remplacer]');
    await page.waitForSelector('[data-frappe-identite]', { timeout: 10000 });
    await page.fill('[data-frappe-identite]', nom);
    await page.click('[data-identite-remplace]');
    await page.waitForFunction((ancienne) => {
      const b = document.querySelector('.bloc-cle');
      return b && b.textContent.trim() !== ancienne;
    }, etat.cleCompte, { timeout: 60000 });
    const neuve = await identite();
    verifier(neuve.empreinte !== etat.empreinteRoot, `une clé NEUVE (${neuve.empreinte})`);
    verifier(neuve.chemin === CHEMIN_COMPTE, 'toujours chez le compte');
    await capturer('08-identite-remplacee');
    etat.empreinteNeuve = neuve.empreinte;
    await sauver();

    grille = await ouvrirTerminal('root');
    const autorise2 = await autorise();
    verifier(autorise2 === neuve.empreinte, `le « tiers » est mis à jour avec la clé neuve (${autorise2})`);
    await fermerTerminal();
    grille = await ouvrirTerminal('spark-docker');
    const clone2 = await jouer(grille, 'CLONE2',
      'rm -rf /tmp/clone-2; GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" ' +
      'git clone -q ssh://deploy@127.0.0.1/home/deploy/repo.git /tmp/clone-2 && git -C /tmp/clone-2 log --oneline | head -1', 90000);
    verifier(/graine SPK-167/.test(clone2), `git clone avec la clé neuve : ${clone2}`);
    await capturer('09-terminal-clone-cle-neuve');
    await fermerTerminal();
  }

  if (phase === 'nettoyer') {
    await ouvrir();
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('[data-frappe="delete"]', { timeout: 10000 });
    await page.fill('[data-frappe="delete"]', nom);
    await page.click('[data-confirme]');
    await page.waitForSelector('tbody a', { timeout: 60000 });
    await page.waitForFunction((n) => ![...document.querySelectorAll('tbody a')]
      .some((a) => a.textContent.trim() === n), nom, { timeout: 90000 });
    verifier(true, `Spark jetable « ${nom} » supprimé`);
  }

  verifier(bruits.length === 0, `aucune erreur dans la console du navigateur ${bruits.length ? JSON.stringify(bruits) : ''}`);
  console.log(ok ? `PHASE « ${phase} » OK` : `PHASE « ${phase} » EN ÉCHEC`);
  process.exitCode = ok ? 0 : 1;
} catch (erreur) {
  await mkdir(join(CAPTURES, 'echecs'), { recursive: true });
  await page.screenshot({ path: join(CAPTURES, 'echecs', `spk167-reelle-${phase}.png`), fullPage: true }).catch(() => {});
  await page.click('[data-terminal="fermer"]', { timeout: 3000 }).catch(() => {});
  console.error('ÉCHEC :', erreur.message, '\n', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500));
  process.exitCode = 1;
} finally {
  await navigateur.close();
}
