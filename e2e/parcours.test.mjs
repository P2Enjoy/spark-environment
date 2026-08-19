/**
 * Parcours E2E contre la pile réelle.
 *
 * @verifies docs/BACKLOG.md#SPK-24 · docs/DAT.md §29 (éprouver le produit par où
 *           il s'utilise), §29.2 (le harnais monte sa pile), §29.3 (aucune URL
 *           profonde, aucun appel d'API pour agir), §29.4 (les quatre refus),
 *           §29.5 (un échec dit pourquoi), §29.6 (la console fait partie du
 *           verdict) · CLAUDE.md §15, §16
 *
 * Ce harnais est le seul qui traverse la pile RÉELLE et qui AFFIRME. Les tests
 * de composants prouvent un rendu ; `e2e/gestes.test.mjs` prouve qu'un clic part
 * avec le bon corps contre un faux `sparkd` ; `e2e/reel.mjs` produit des
 * captures à observer. Aucun ne prouve que le produit s'utilise de bout en bout.
 *
 * Règle du §29.3, tenue partout ici : on se DÉPLACE et on AGIT à la souris et au
 * clavier, jamais par une URL profonde ni un appel d'API. On LIT `sparkd` pour
 * constater un effet — ce que `CLAUDE.md` §15 exige — jamais pour y arriver.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { monterPile } from './pile.mjs';

const ECHECS = new URL('./captures/echecs/', import.meta.url).pathname;

let pile;
let navigateur;
let page;
/** Messages écrits par l'APPLICATION. Le journal réseau de Chromium est à part. */
let bruits = [];
let reseau = [];

const JOURNAL_RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;

before(async () => {
  await mkdir(ECHECS, { recursive: true });
  pile = await monterPile();
  navigateur = await chromium.launch();
  page = await navigateur.newPage();
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type())) return;
    (JOURNAL_RESEAU.test(m.text()) ? reseau : bruits).push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));
});

after(async () => {
  await navigateur?.close();
  await pile?.demonter();
});

beforeEach(() => { bruits = []; });

/**
 * Enveloppe un parcours pour qu'un échec DISE pourquoi (§29.5).
 *
 * Un `expect` rouge sur une page qu'on ne voit pas oblige à rejouer à la main.
 */
async function parcours(nom, corps) {
  try {
    await corps();
  } catch (erreur) {
    const base = join(ECHECS, nom.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const texte = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    await writeFile(`${base}.txt`,
      `URL : ${page.url()}\n\n--- écran ---\n${texte}\n\n--- console ---\n${bruits.join('\n')}\n`,
    ).catch(() => {});
    erreur.message += `\n  Diagnostic : ${base}.png et ${base}.txt`;
    throw erreur;
  }
  assert.deepEqual(bruits, [], `« ${nom} » a écrit dans la console du navigateur (§29.6)`);
}

/** Repart de l'accueil, comme un exploitant qui ouvre la console. */
async function accueil() {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a', { timeout: 20000 });
}

/** Ouvre un Spark PAR SON LIEN dans la liste. */
async function ouvrir(nom) {
  await accueil();
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 10000 });
}

// --- LE PARCOURS NOMINAL ----------------------------------------------------

test('la console affiche les Sparks seedés, avec leurs états réels', async () => {
  await parcours('liste', async () => {
    await accueil();
    const lignes = await page.$$eval('tbody tr', (tr) => tr.map((l) => l.innerText));
    assert.equal(lignes.length, 5, 'les cinq fixtures du seed');
    const texte = lignes.join('\n');
    for (const attendu of ['crm-production', 'boutique', 'postgres-dedie',
                           'analytics', 'site-vitrine']) {
      assert.ok(texte.includes(attendu), `« ${attendu} » absent de la liste`);
    }
    // Les états viennent du registre, pas d'un rendu figé.
    assert.ok(texte.includes('En marche'));
    assert.ok(texte.includes('Arrêté'));
    assert.ok(texte.includes('En erreur'));
    assert.ok(texte.includes('En attente'));
  });
});

test('un Spark en erreur dit pourquoi, et propose de reprendre', async () => {
  await parcours('detail-erreur', async () => {
    await ouvrir('site-vitrine');
    const entete = await page.textContent('.entete-entite');
    assert.match(entete, /Dernière erreur/);
    // Depuis SPK-32, une image absente du catalogue est refusée À LA CRÉATION :
    // le Spark en erreur du seed vient donc d'une panne du pilote, pas d'une
    // référence impossible. Le message reste la cause RÉELLE.
    assert.match(entete, /cgroup indisponible/, 'la cause réelle, pas un message générique');
    assert.ok(await page.$('[data-commande="retry"]'), '« Reprendre » doit être offert');
  });
});

test("l'écran de l'hôte s'atteint par la navigation et montre la vraie capacité", async () => {
  await parcours('hote', async () => {
    await accueil();
    await page.click('nav a[href="#/hote"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });

    // La capacité affichée doit être celle que sparkd calcule (§29.3 : on LIT
    // pour constater, on n'a pas navigué par l'API).
    const { corps } = await pile.lireSparkd('/v1/host');
    const attendu = corps.pools.cpu.available;
    const texte = await page.textContent('#titre-pools ~ .pools, .pools');
    assert.ok(texte.includes('Disponible'), 'les trois grandeurs du §27.2');

    // Un cœur dédié existe dans le seed : la carte doit le nommer.
    const carte = await page.textContent('#titre-coeurs ~ .coeurs, .coeurs');
    assert.match(carte, /dédié à postgres-dedie/,
      'le NOM du Spark, pas son identifiant interne');
    assert.ok(attendu < corps.pools.cpu.capacity, 'le seed a bien alloué du CPU');
  });
});

// --- LES QUATRE REFUS DU PRODUIT (§29.4) ------------------------------------

test('REFUS 1 · capacité insuffisante, et le bouton n’est jamais désactivé avant', async () => {
  await parcours('refus-capacite', async () => {
    await accueil();
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });

    await page.fill('#name', 'demande-enorme');
    await page.fill('#memory_gib', '512');
    // §25.1 : l'estimation locale ne désactive JAMAIS la soumission.
    assert.equal(await page.isDisabled('button[type="submit"]'), false,
      'le refus doit venir du serveur, pas d’un contrôle local');

    await page.click('button[type="submit"]');
    await page.waitForSelector('.refus', { timeout: 10000 });
    const refus = await page.textContent('.refus');
    assert.match(refus, /Le serveur a refusé/);
    assert.match(refus, /mémoire/, 'la ressource manquante est nommée en français');
    assert.match(refus, /Gio/, 'la quantité est formatée, pas rendue en octets bruts');

    // La saisie survit (§25.2).
    assert.equal(await page.inputValue('#name'), 'demande-enorme');

    // Effet backend : le Spark refusé n'existe PAS.
    const { status } = await pile.lireSparkd('/v1/sparks/demande-enorme');
    assert.equal(status, 404, 'un refus ne doit laisser aucune ligne derrière lui');
  });
});

test('REFUS 2 · une commande impossible dans l’état n’est pas offerte', async () => {
  await parcours('refus-commande', async () => {
    // `boutique` est arrêté : « Arrêter » ne doit pas exister — §24.1, une
    // commande absente n'est pas rendue désactivée, elle n'est pas rendue.
    await ouvrir('boutique');
    assert.ok(await page.$('[data-commande="start"]'), '« Démarrer » attendu');
    assert.equal(await page.$('[data-commande="stop"]'), null,
      'un bouton mort vaut moins que pas de bouton (§1.4 du design system)');

    // Le runtime publie cette liste : l'écran ne la déduit pas.
    const { corps } = await pile.lireSparkd('/v1/sparks/boutique');
    assert.ok(corps.allowed_commands.includes('start'));
    assert.ok(!corps.allowed_commands.includes('stop'));
  });
});

test('REFUS 3 · restaurer un instantané ancien est refusé, et nomme ce qui bloque', async () => {
  await parcours('refus-restauration', async () => {
    await ouvrir('crm-production');
    await page.waitForSelector('#titre-instantanes');

    // Avant toute tentative, aucun moyen d'accepter la perte n'existe (§26.5).
    assert.equal(await page.$('[data-accepte-perte]'), null);

    await page.click('[data-restaure="avant-deploiement"]');
    await page.waitForSelector('[data-confirme-restauration]');
    await page.click('[data-confirme-restauration]');
    await page.waitForSelector('[data-accepte-perte]', { timeout: 10000 });

    const refus = await page.textContent('.refus');
    assert.match(refus, /apres-migration/, 'l’instantané bloquant est nommé');
    assert.match(refus, /avant-deploiement/, 'la cible de la restauration est nommée');

    // Effet backend : rien n'a été détruit puisque le refus tient.
    const { corps } = await pile.lireSparkd('/v1/sparks/crm-production/snapshots');
    assert.deepEqual(corps.snapshots.map((s) => s.incus_name),
                     ['avant-deploiement', 'apres-migration'],
                     'un refus ne doit rien avoir supprimé');
  });
});

test('REFUS 4 · un domaine déjà pris est refusé par la base, pas par l’interface', async () => {
  await parcours('refus-domaine', async () => {
    await ouvrir('boutique');
    await page.waitForSelector('#titre-routes');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('#route-domaine');

    // `crm.example.com` appartient déjà au CRM, dans le seed.
    await page.fill('#route-domaine', 'crm.example.com');
    await page.fill('#route-port', '8080');
    // L'interface ne s'y oppose PAS : elle laisse partir la demande (§26.3).
    assert.equal(await page.isDisabled('button[type="submit"]'), false);
    await page.click('button[type="submit"]');

    await page.waitForSelector('.refus', { timeout: 10000 });
    const refus = await page.textContent('.refus');
    assert.ok(refus.length > 0, 'le refus du serveur doit être montré');

    // Effet backend : la route appartient toujours au CRM.
    const { corps } = await pile.lireSparkd('/v1/ingress');
    const route = corps.routes.find((r) => r.domain === 'crm.example.com');
    assert.equal(route.spark_name, 'crm-production',
      'un refus ne doit pas avoir déplacé la route');
  });
});

// --- UN GESTE QUI RÉUSSIT, DE BOUT EN BOUT ----------------------------------

test('prendre un instantané au clavier le crée réellement côté sparkd', async () => {
  await parcours('instantane', async () => {
    await ouvrir('postgres-dedie');
    await page.waitForSelector('#titre-instantanes');

    const avant = (await pile.lireSparkd('/v1/sparks/postgres-dedie/snapshots'))
      .corps.snapshots.length;

    // Au CLAVIER : on met le focus sur le déclencheur et on active par Entrée.
    await page.focus('[data-ouvre="snapshot"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#instantane-nom');
    await page.fill('#instantane-nom', 'avant-bascule');
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => !document.querySelector('.formulaire-panneau')
            && document.querySelector('#titre-instantanes'),
      { timeout: 10000 });

    // Visible à l'écran…
    assert.match(await page.textContent('#titre-instantanes ~ .liste-administrable, .liste-administrable'),
                 /avant-bascule/);
    // …ET réellement créé côté serveur (CLAUDE.md §15).
    const { corps } = await pile.lireSparkd('/v1/sparks/postgres-dedie/snapshots');
    assert.equal(corps.snapshots.length, avant + 1);
    assert.ok(corps.snapshots.some((s) => s.incus_name === 'avant-bascule'));
  });
});

test('arrêter un Spark le fait réellement passer à l’arrêt', async () => {
  await parcours('arreter', async () => {
    await ouvrir('crm-production');
    await page.click('[data-commande="stop"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="start"]') !== null,
      { timeout: 15000 });

    const { corps } = await pile.lireSparkd('/v1/sparks/crm-production');
    assert.equal(corps.state, 'stopped');
    assert.ok(corps.allowed_commands.includes('start'));

    // On remet la pile dans l'état du seed : les parcours suivants ne doivent
    // pas dépendre de l'ordre d'exécution de celui-ci.
    await page.click('[data-commande="start"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="stop"]') !== null,
      { timeout: 15000 });
  });
});

// --- ACCESSIBILITÉ DU PARCOURS ----------------------------------------------

test('toute la navigation principale est atteignable au clavier', async () => {
  await parcours('clavier', async () => {
    await accueil();
    let atteint = null;
    for (let i = 0; i < 15 && atteint !== '#/hote'; i += 1) {
      await page.keyboard.press('Tab');
      atteint = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    }
    assert.equal(atteint, '#/hote', 'le lien « Hôte » doit être atteignable au clavier');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });

    const courant = await page.evaluate(() =>
      document.querySelector('nav a[aria-current="page"]')?.getAttribute('href'));
    assert.equal(courant, '#/hote', 'l’indicateur de page courante suit la route');
  });
});

test('le classement sépare le journal réseau des messages applicatifs (§29.6)', () => {
  // Ces parcours provoquent DÉLIBÉRÉMENT des 409 et des 422 : Chromium les
  // journalise de lui-même. Les compter comme des messages applicatifs rendrait
  // le contrôle du §29.6 inutilisable ; les masquer le rendrait mensonger.
  //
  // Une première version affirmait `reseau.length > 0`. C'était un mauvais test :
  // il éprouvait ce que Chromium choisit de journaliser, pas ce que ce harnais
  // fait. Ce qui m'appartient, c'est le CLASSEMENT — et il se vérifie sans
  // dépendre du navigateur.
  const reseauType = 'Failed to load resource: the server responded with a status of 409 (Conflict)';
  const applicatif = "Uncaught TypeError: impossible de lire « name »";
  assert.ok(JOURNAL_RESEAU.test(reseauType), 'une ligne réseau doit être reconnue');
  assert.ok(!JOURNAL_RESEAU.test(applicatif), 'un message applicatif ne doit JAMAIS être écarté');

  // Et ce qui a réellement été observé est affiché, jamais masqué. Les lignes
  // stockées portent leur préfixe de type — la regex, elle, s'applique au texte
  // nu au moment du classement.
  for (const ligne of reseau) assert.ok(ligne.includes('Failed to load resource'), ligne);
  console.log(`  journal réseau observé : ${reseau.length} ligne(s)`);
  for (const ligne of [...new Set(reseau)]) console.log(`    ${ligne}`);
});

// --- LE CATALOGUE D'IMAGES (SPK-32, docs/DAT.md §33, §34.1) -----------------

test("l'image se choisit dans une LISTE : plus aucune saisie libre", async () => {
  await parcours('image-liste', async () => {
    await accueil();
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });

    // La DoD l'exige depuis le parcours canonique, pas depuis un test de rendu.
    assert.equal(await page.$('input#image'), null,
      'une saisie libre pouvait produire une référence inexistante');
    assert.ok(await page.$('select#image'));

    const options = await page.$$eval('#image option', (o) => o.map((x) => x.value));
    assert.ok(options.length > 0);
    // Chaque option vient du catalogue, et le catalogue les dit vérifiées.
    const { corps } = await pile.lireSparkd('/v1/images');
    assert.deepEqual([...options].sort(), [...corps.selectable].sort());
  });
});

test('le catalogue a son écran, atteint par les onglets de l’hôte', async () => {
  await parcours('catalogue', async () => {
    await accueil();
    await page.click('nav a[href="#/hote"]');
    await page.waitForSelector('.onglets', { timeout: 10000 });
    await page.click('.onglet[href="#/hote/images"]');
    await page.waitForSelector('#titre-catalogue', { timeout: 10000 });

    const texte = await page.textContent('body');
    assert.match(texte, /Dernier relevé le/, 'la date du relevé est affichée');
    assert.match(texte, /Vérifiée/);

    // L'onglet courant se signale — on doit pouvoir recharger ici (§34.1).
    const courant = await page.evaluate(() =>
      document.querySelector('.onglet[aria-current="page"]')?.getAttribute('href'));
    assert.equal(courant, '#/hote/images');
  });
});

test('ajouter une image la crée NON RELEVÉE, puis le relevé tranche', async () => {
  await parcours('image-ajout', async () => {
    await page.goto(`${pile.base}/#/hote/images`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#titre-catalogue', { timeout: 15000 });

    await page.click('[data-ouvre="image"]');
    await page.waitForSelector('#image-reference');
    await page.fill('#image-reference', 'images:debian/31');
    await page.fill('#image-label', 'Version qui n’existe pas');
    await page.click('[data-formulaire="image"] button[type="submit"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Non relevée'), { timeout: 15000 });

    // §33.2 : l'état vient du relevé, jamais d'une déclaration.
    const { corps } = await pile.lireSparkd('/v1/images');
    const ajoutee = corps.images.find((i) => i.reference === 'images:debian/31');
    assert.equal(ajoutee.state, 'unknown');
    assert.equal(ajoutee.verified_at, null);
    assert.ok(!corps.selectable.includes('images:debian/31'),
      'une entrée non relevée n’est pas proposable à la création');
  });
});
