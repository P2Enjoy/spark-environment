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
import { monterDoublonDns } from './dns-doublon.mjs';

const ECHECS = new URL('./captures/echecs/', import.meta.url).pathname;

let pile;
let dns;
let navigateur;
let page;
/** Messages écrits par l'APPLICATION. Le journal réseau de Chromium est à part. */
let bruits = [];
let reseau = [];

const JOURNAL_RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;

before(async () => {
  await mkdir(ECHECS, { recursive: true });
  // SPK-47 · §38 : le fournisseur DNS est un DOUBLON local. Aucun parcours
  // automatique ne doit atteindre un compte réel, et la pile impose de toute
  // façon son propre fichier d'environnement (docs/DAT.md §28.1).
  dns = await monterDoublonDns();
  pile = await monterPile({ dns });
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
  await dns?.demonter();
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

/** Ouvre un Spark PAR SON LIEN dans la liste, puis une de ses facettes.
 *
 *  SPK-33 a réparti la fenêtre en facettes (DESIGN_SYSTEM.md §6.27) : on y va
 *  en cliquant l'onglet, comme un exploitant. Seul le CHEMIN change ; ce que ces
 *  parcours vérifient est inchangé. */
async function ouvrir(nom, facette = '') {
  await accueil();
  await page.click(`tbody a:has-text("${nom}")`);
  await page.waitForSelector('.entete-entite', { timeout: 10000 });
  if (facette) {
    await page.click(`.onglet[href$="/${facette}"]`);
    await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`,
                               { timeout: 10000 });
  }
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
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });

    // La capacité affichée doit être celle que sparkd calcule (§29.3 : on LIT
    // pour constater, on n'a pas navigué par l'API).
    const { corps } = await pile.lireSparkd('/v1/forge');
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

// --- SPK-41 · LE CATALOGUE DES SERVEURS (§22.4 ter) -------------------------

test('ajouter un serveur, voir l’épreuve, basculer, reconnecter, retirer', async () => {
  await parcours('catalogue-serveurs', async () => {
    // PAR LA NAVIGATION : accueil, puis la destination « Serveurs ».
    await accueil();
    await page.click('nav a[href="#/serveurs"]');
    await page.waitForSelector('#titre-serveurs', { timeout: 10000 });
    const initial = await page.$$eval('tbody tr', (l) => l.length);

    // AJOUTER, au clavier, un second serveur pointant sur la MÊME pile : c'est
    // le seul serveur réellement joignable ici, et l'épreuve doit donc réussir.
    await page.focus('[data-ouvre="serveur"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #serveur-nom');
    await page.fill('#serveur-nom', 'second');
    await page.selectOption('#serveur-genre', 'local');
    await page.waitForSelector('#serveur-port-local');
    await page.fill('#serveur-port-local', String(pile.portSparkd));

    // L'ÉPREUVE : elle informe, et son verdict s'affiche dans la modale.
    await page.click('[data-action="eprouver"]');
    await page.waitForSelector('.epreuve', { timeout: 15000 });
    assert.match(await page.textContent('.epreuve'), /Joignable/,
      'la pile répond réellement à travers le tunnel');
    // La saisie SURVIT à l'épreuve (§25.2).
    assert.equal(await page.inputValue('#serveur-nom'), 'second');

    await page.click('dialog.modale[open] [data-engage="serveur"]');
    await page.waitForFunction(
      (avant) => document.querySelectorAll('tbody tr').length > avant,
      initial, { timeout: 15000 });

    // …et l'inventaire du POSTE l'a réellement enregistré.
    let inventaire = await (await fetch(`${pile.base}/api/servers`)).json();
    assert.ok(inventaire.servers.some((s) => s.name === 'second'));

    // BASCULER : le choix est retenu côté console.
    await page.click('[data-bascule="second"]');
    await page.waitForFunction(
      () => document.querySelector('.ligne--courante')?.textContent.includes('second'),
      { timeout: 15000 });
    inventaire = await (await fetch(`${pile.base}/api/servers`)).json();
    assert.equal(inventaire.current, 'second', 'le serveur courant est PERSISTÉ');

    // RETIRER : la confirmation nomme le serveur, et le retrait ferme son tunnel.
    await page.click('[data-retire-serveur="second"]');
    await page.waitForSelector('[data-confirme-serveur="second"]', { timeout: 10000 });
    assert.match(await page.textContent('.confirmation'), /Retirer « second »/);
    await page.click('[data-confirme-serveur="second"]');
    await page.waitForFunction(
      (avant) => document.querySelectorAll('tbody tr').length === avant,
      initial, { timeout: 15000 });

    inventaire = await (await fetch(`${pile.base}/api/servers`)).json();
    assert.ok(!inventaire.servers.some((s) => s.name === 'second'),
      'l’entrée est réellement effacée du poste');
    assert.notEqual(inventaire.current, 'second',
      'retirer le courant ne laisse pas la console sans contexte');

    // Ce parcours REND l'état qu'il a trouvé : les parcours partagent la pile,
    // et laisser un autre serveur courant ferait lire les suivants sur une
    // console qui ne regarde plus la même machine.
    await page.click('nav a[href="#/sparks"]');
    await page.waitForSelector('tbody a', { timeout: 15000 });
  });
});

test('modifier un serveur existant : la modale s’ouvre PRÉ-REMPLIE', async () => {
  await parcours('catalogue-modifier', async () => {
    await accueil();
    await page.click('nav a[href="#/serveurs"]');
    await page.waitForSelector('#titre-serveurs', { timeout: 10000 });

    // Le serveur de la pile est déclaré « local » : on le modifie sans changer
    // ce qu'il désigne, et on constate que la modale sait ce qu'il est.
    const nom = await page.textContent('tbody tr:first-child td:first-child');
    const attendu = nom.replace(/\s*courant\s*/, '').trim();
    await page.click(`[data-modifie-serveur="${attendu}"]`);
    await page.waitForSelector('dialog.modale[open] #serveur-nom', { timeout: 10000 });

    assert.equal(await page.inputValue('#serveur-nom'), attendu,
      'la modale est pré-remplie depuis l’entrée réelle');
    // §22.4.7 ter : le nom ne se modifie pas — le changer créerait un doublon.
    assert.equal(await page.getAttribute('#serveur-nom', 'readonly'), '');
    assert.match(await page.textContent('dialog.modale[open]'),
                 /renommer, c’est retirer puis redéclarer/);
    // Le bouton NOMME le serveur : la modale a été ouverte depuis une ligne
    // parmi d’autres.
    assert.match(await page.textContent('[data-engage="serveur"]'),
                 new RegExp(`Enregistrer « ${attendu} »`));

    // Le focus entre dans le premier champ MODIFIABLE, pas dans le nom.
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'serveur-nom',
      'la saisie ne commence pas là où elle est impossible');

    // On enregistre sans rien changer : l'entrée reste UNE, pas deux.
    await page.click('dialog.modale[open] [data-engage="serveur"]');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 15000 });
    const { servers } = await (await fetch(`${pile.base}/api/servers`)).json();
    assert.equal(servers.filter((s) => s.name === attendu).length, 1,
      'remplacer par le nom ne duplique pas l’entrée');
  });
});

test('un SECRET saisi dans le formulaire est refusé, et la saisie survit', async () => {
  await parcours('catalogue-secret', async () => {
    await accueil();
    await page.click('nav a[href="#/serveurs"]');
    await page.waitForSelector('#titre-serveurs', { timeout: 10000 });

    // Le formulaire n'offre aucun champ de secret — c'est le premier rempart.
    await page.click('[data-ouvre="serveur"]');
    await page.waitForSelector('dialog.modale[open] #serveur-nom');
    const champs = await page.$$eval('dialog.modale[open] input, dialog.modale[open] select',
      (l) => l.map((c) => c.name));
    assert.ok(!champs.some((n) => /password|key|token|secret|passphrase/i.test(n)),
      'aucun champ de secret n’est même proposé');

    // Et le SERVEUR refuse, quoi qu'on lui envoie : c'est le rempart qui compte
    // (§22.4). Vérifié ici sans passer par l'interface, qui n'offre pas le champ.
    const refus = await fetch(`${pile.base}/api/servers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fuite', kind: 'local', port: 9876, passphrase: 'x' }),
    });
    assert.equal(refus.status, 422);
    assert.match((await refus.json()).message, /ressemble à un secret/);
  });
});

// --- SPK-39 · L'ONGLET DE SUPERVISION (§36.8) -------------------------------

test('l’onglet Journal s’atteint par la navigation, se filtre, et se vérifie', async () => {
  await parcours('journal-supervision', async () => {
    // PAR LA NAVIGATION : accueil, Hôte, onglet Journal (§36.8.1).
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/journal"]');
    await page.waitForSelector('#titre-journal-forge', { timeout: 10000 });

    const toutes = await page.$$eval('tbody tr', (l) => l.length);
    assert.ok(toutes > 0, 'le seed a écrit au journal');

    // FILTRER : par origine, puisque le seed produit les deux classes.
    await page.selectOption('#filtre-actor_class', 'runtime');
    await page.click('[data-filtres="journal"] button[type="submit"]');
    // On attend le tableau RECHARGÉ, pas un simple changement de nombre :
    // l'état de chargement rend zéro ligne, ce qui satisfaisait cette attente
    // avant même que la réponse n'arrive. Mesuré — le test lisait alors un
    // tableau vide et concluait qu'aucun événement du serveur n'existait.
    await page.waitForFunction(() => {
      const lignes = [...document.querySelectorAll('tbody tr')];
      return lignes.length > 0
        && lignes.every((l) => l.children[3]?.textContent.trim() === 'automatique');
    }, { timeout: 10000 });
    const auteurs = await page.$$eval('tbody tr td:nth-child(4)',
      (l) => l.map((c) => c.textContent.trim()));
    assert.ok(auteurs.length > 0, 'des événements du serveur existent');
    assert.ok(auteurs.every((a) => a === 'automatique'),
      'le filtre retient les événements du serveur, et eux seuls');

    // Le filtre est RÉELLEMENT appliqué côté serveur, pas dans la page.
    const { corps } = await pile.lireSparkd('/v1/audit?actor_class=runtime&limit=200');
    assert.ok(corps.entries.every((e) => e.actor_class === 'runtime'));

    // « Tout afficher » n'apparaît QUE lorsqu'un filtre est posé (§1.4).
    await page.click('[data-action="filtres-vides"]');
    await page.waitForFunction(
      (avant) => document.querySelectorAll('tbody tr').length === avant,
      toutes, { timeout: 10000 });
    // Ici l'attente porte sur l'ÉGALITÉ : l'état de chargement ne peut pas la
    // satisfaire, puisqu'il rend zéro ligne.
    assert.equal(await page.$('[data-action="filtres-vides"]'), null,
      'un « Tout afficher » alors que tout est affiché est un bouton mort');

    // VÉRIFIER la chaîne : un relevé EXPLICITE, déclenché au clavier.
    assert.match(await page.textContent('#titre-integrite ~ .definitions'),
      /n’a pas encore été vérifiée/,
      'avant le relevé, l’écran ne prétend pas que la chaîne est intacte');
    await page.focus('[data-action="verifier-chaine"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.body.innerText.includes('Chaîne intacte'), { timeout: 15000 });

    // La chaîne ET l'ancre, jamais résumées en un seul indicateur (§36.8.4).
    const integrite = await page.textContent('#titre-integrite ~ .definitions');
    assert.match(integrite, /Chaîne intacte/);
    assert.match(integrite, /Première comparaison|prolonge|Rien de nouveau/,
      'le verdict de l’ancre est rendu à part');

    // …et le runtime a réellement vérifié (§29.3 : on lit pour constater).
    const { corps: etat } = await pile.lireSparkd('/v1/audit/verify');
    assert.equal(etat.intact, true);
    assert.ok(etat.checked > 0);
    // La vérification est elle-même journalisée (§36.7).
    const { corps: apres } = await pile.lireSparkd('/v1/audit?action=audit.verify&limit=10');
    assert.ok(apres.entries.length > 0, 'le relevé laisse sa trace');
  });
});

// --- SPK-37 · QUI A AGI (§21.6, §36.4) --------------------------------------

test('le journal distingue un geste de la console d’un événement du serveur', async () => {
  await parcours('journal-acteur', async () => {
    // Un geste RÉEL depuis l'écran, qui produit les deux classes d'un coup : la
    // demande est humaine, la conclusion appartient à la machine.
    await ouvrir('crm-production', 'instantanes');
    await page.focus('[data-ouvre="snapshot"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #instantane-nom');
    await page.fill('#instantane-nom', 'trace-acteur');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 10000 });

    // Ce que le RUNTIME a écrit (§29.3 : on lit pour constater).
    const { corps } = await pile.lireSparkd('/v1/audit?limit=200');
    const geste = corps.entries.find(
      (e) => e.action === 'snapshot.create' && e.message.includes('trace-acteur'));
    assert.ok(geste, 'le geste a bien laissé une trace');
    assert.equal(geste.actor_class, 'human', 'prendre un instantané est un geste HUMAIN');
    assert.match(geste.actor, /^console\//,
      'l’identité déclarée par la console remplace « responsable »');
    assert.notEqual(geste.actor, 'responsable');
    assert.ok(corps.entries.some((e) => e.actor_class === 'runtime'),
      'le runtime écrit aussi, et se déclare comme tel');

    // Et l'ÉCRAN ne confond pas les deux classes : le journal du Spark porte
    // l'auteur de chaque ligne, sans jamais parler de signature.
    await page.click('.onglet[href$="/journal"]');
    await page.waitForSelector('#titre-journal', { timeout: 10000 });
    const journal = await page.textContent('#titre-journal ~ .liste-evenements');
    assert.match(journal, /automatique/, 'un événement du serveur se dit tel quel');
    assert.ok(!/signé/.test(journal), 'rien ne doit laisser croire à une signature');

    // Ce parcours REND l'état qu'il a trouvé : la pile est partagée, et un
    // instantané plus récent changerait la fixture du refus de restauration.
    await page.click('.onglet[href$="/instantanes"]');
    await page.waitForSelector('[data-supprime-instantane="trace-acteur"]', { timeout: 10000 });
    await page.click('[data-supprime-instantane="trace-acteur"]');
    await page.click('[data-confirme-suppression="trace-acteur"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-supprime-instantane="trace-acteur"]'),
      { timeout: 10000 });
  });
});

// --- SPK-34 · LES SPARKS PROTÉGÉS (§35) -------------------------------------

/** Le mot de passe du seed. Ce n'est PAS un secret : la protection est un
 *  garde-fou, pas un contrôle d'accès (§35.1), et le manuel M8 le publie. */
const MOT_DE_PASSE = 'protege-moi';

test('armer, échouer à modifier, lever, modifier, réarmer — au clavier', async () => {
  await parcours('protection', async () => {
    // « boutique » est libre dans le seed : on l'arme nous-mêmes, depuis l'écran.
    await ouvrir('boutique');
    await page.waitForSelector('#titre-protection', { timeout: 10000 });

    // AVANT : la barre propose des commandes.
    assert.ok(await page.$('[data-commande]'), 'un Spark libre porte ses commandes');

    // ARMER, au clavier depuis le déclencheur de la section.
    await page.focus('[data-ouvre="protection"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', MOT_DE_PASSE);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.body.innerText.includes('Armée'), { timeout: 10000 });

    // ÉCHOUER À MODIFIER : plus aucune commande n'est offerte, et la cause est
    // NOMMÉE — c'est la protection, pas l'état (§24.1).
    assert.equal(await page.$('[data-commande]'), null,
      'un Spark protégé n’offre aucune commande');
    assert.match(await page.textContent('.entete-entite'), /protégé/);

    // …et une écriture encore ATTEIGNABLE à l'écran est refusée par le SERVEUR.
    // C'est le sens du §35.1 : la protection est appliquée côté runtime, pas
    // par l'interface. Le refus arrive DANS la modale, sans effacer la saisie.
    await page.click('.onglet[href$="/routes"]');
    await page.waitForSelector('[data-ouvre="route"]', { timeout: 10000 });
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('dialog.modale[open] #route-domaine');
    await page.fill('#route-domaine', 'refuse.example.test');
    await page.fill('#route-port', '8080');
    await page.click('dialog.modale[open] [data-engage="route"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });
    assert.match(await page.textContent('dialog.modale[open] .refus'), /protégé/);
    assert.equal(await page.inputValue('#route-domaine'), 'refuse.example.test',
      'un refus n’efface pas la saisie (§25.2)');
    await page.keyboard.press('Escape');

    // La route n'a REELLEMENT pas été créée côté serveur.
    const routes = await pile.lireSparkd('/v1/ingress');
    assert.ok(!JSON.stringify(routes.corps).includes('refuse.example.test'));
    await page.click('.onglet[href$="/sparks/boutique"], .onglet:text-is("Infos")');
    await page.waitForSelector('#titre-protection', { timeout: 10000 });

    // Le badge suit le Spark JUSQUE DANS LA LISTE (§35.4).
    await page.click('a[href="#/sparks"]');
    await page.waitForSelector('tbody a');
    const ligne = await page.textContent('tbody tr:has(a:text-is("boutique"))');
    assert.match(ligne, /protégé/, 'l’état est visible partout où le Spark est listé');

    // LEVER, puis MODIFIER.
    await ouvrir('boutique');
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', MOT_DE_PASSE);
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Désarmée'), { timeout: 10000 });
    assert.ok(await page.$('[data-commande]'), 'les commandes reviennent');

    // RÉARMER avec un AUTRE mot de passe : le produit ne retient pas l'ancien.
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', 'un-autre-secret');
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Armée'), { timeout: 10000 });

    // L'ancien mot de passe ne lève plus rien, et l'échec se lit dans la modale.
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', MOT_DE_PASSE);
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });
    await page.keyboard.press('Escape');
    assert.equal((await pile.lireSparkd('/v1/sparks/boutique/protection'))
                 .corps.protected, true, 'un échec ne désarme rien');

    // Ce parcours REND l'état qu'il a trouvé. Les parcours partagent une pile ;
    // laisser « boutique » armé ferait échouer ceux qui le pilotent ensuite —
    // mesuré, et c'est la bonne défaillance : la protection mord vraiment.
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', 'un-autre-secret');
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Désarmée'), { timeout: 10000 });
  });
});

test('révoquer une clé malgré le gel, par la confirmation qui NOMME', async () => {
  await parcours('protection-revocation', async () => {
    // « analytics » est protégé par le seed et porte une clé.
    await ouvrir('analytics', 'cles');
    await page.waitForSelector('#titre-cles', { timeout: 10000 });

    await page.click('[data-revoque="ci-deploiement"]');
    // §6.23 : les objets protégés sont NOMMÉS, pas comptés.
    await page.waitForSelector('[data-accepte-protege]', { timeout: 10000 });
    const refus = await page.textContent('.refus');
    assert.match(refus, /analytics/, 'le Spark protégé est nommé');
    assert.match(refus, /Aucune protection ne sera levée/);

    // La clé est TOUJOURS là : le premier appel n'a rien retiré.
    let cles = await pile.lireSparkd('/v1/sparks/analytics/ssh-config');
    assert.ok(JSON.stringify(cles.corps).includes('ci-deploiement'));

    // ACCEPTER : la révocation aboutit.
    await page.click('[data-accepte-protege="ci-deploiement"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-accepte-protege]'), { timeout: 10000 });

    cles = await pile.lireSparkd('/v1/sparks/analytics/ssh-config');
    assert.ok(!JSON.stringify(cles.corps).includes('ci-deploiement'),
      'la clé est réellement retirée côté serveur');

    // …et AUCUNE protection n'a été levée au passage (§35.2).
    assert.equal((await pile.lireSparkd('/v1/sparks/analytics/protection'))
                 .corps.protected, true);
  });
});

// --- SPK-30 · LA MARGE DE MÉTADONNÉES (§8.8) --------------------------------

test("l’écart entre les tailles vendues et l’alloué du disque est EXPLIQUÉ", async () => {
  await parcours('marge-metadonnees', async () => {
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });

    // Ce que l'exploitant lit à l'écran, sans avoir à ouvrir le code.
    const pools = await page.textContent('#titre-pools ~ .pools, .pools');
    assert.match(pools, /de métadonnées par Spark/,
      'l’écart doit être nommé là où il se constate');
    assert.match(pools, /SPARKD_STORAGE_METADATA_MARGIN/,
      '§27.3 : chaque terme nomme la vanne qui le commande');

    // …ET l'effet backend est réel (CLAUDE.md §15) : l'alloué publié vaut la
    // somme des tailles VENDUES plus une marge par Spark. Le registre, lui, ne
    // stocke que la taille vendue (§8.8.2 règle 1).
    const { corps } = await pile.lireSparkd('/v1/forge');
    const { corps: liste } = await pile.lireSparkd('/v1/sparks');
    const vendu = liste.sparks.reduce((total, s) => total + s.storage_bytes, 0);
    const marge = corps.reserves.storage_metadata_margin_bytes;
    assert.ok(marge > 0, 'le défaut du produit pose une marge');
    assert.equal(corps.reserves.storage_metadata_total_bytes,
                 marge * liste.sparks.length);
    assert.equal(corps.pools.storage.allocated,
                 vendu + marge * liste.sparks.length);
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
    await ouvrir('crm-production', 'instantanes');
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
    await ouvrir('boutique', 'routes');
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
    await ouvrir('postgres-dedie', 'instantanes');
    await page.waitForSelector('#titre-instantanes');

    const avant = (await pile.lireSparkd('/v1/sparks/postgres-dedie/snapshots'))
      .corps.snapshots.length;

    // Au CLAVIER : on met le focus sur le déclencheur et on active par Entrée.
    await page.focus('[data-ouvre="snapshot"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#instantane-nom');
    await page.fill('#instantane-nom', 'avant-bascule');
    await page.keyboard.press('Enter');

    // La saisie aboutie referme la modale (§6.27). La condition portait sur
    // `.formulaire-panneau`, la classe du formulaire dans le flux : plus aucun
    // composant ne l'émet depuis que la modale est livrée, donc elle était vraie
    // d'avance et ne prouvait plus rien.
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]')
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
    for (let i = 0; i < 15 && atteint !== '#/forge'; i += 1) {
      await page.keyboard.press('Tab');
      atteint = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    }
    assert.equal(atteint, '#/forge', 'le lien « Hôte » doit être atteignable au clavier');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });

    const courant = await page.evaluate(() =>
      document.querySelector('nav a[aria-current="page"]')?.getAttribute('href'));
    assert.equal(courant, '#/forge', 'l’indicateur de page courante suit la route');
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
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('.onglets', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/images"]');
    await page.waitForSelector('#titre-catalogue', { timeout: 10000 });

    const texte = await page.textContent('body');
    assert.match(texte, /Dernier relevé le/, 'la date du relevé est affichée');
    assert.match(texte, /Vérifiée/);

    // L'onglet courant se signale — on doit pouvoir recharger ici (§34.1).
    const courant = await page.evaluate(() =>
      document.querySelector('.onglet[aria-current="page"]')?.getAttribute('href'));
    assert.equal(courant, '#/forge/images');
  });
});

test('ajouter une image la crée NON RELEVÉE, puis le relevé tranche', async () => {
  await parcours('image-ajout', async () => {
    await page.goto(`${pile.base}/#/forge/images`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#titre-catalogue', { timeout: 15000 });

    await page.click('[data-ouvre="image"]');
    // §6.27 : la saisie se fait dans une modale, et le focus y entre tout seul.
    await page.waitForSelector('dialog.modale[open] #image-reference');
    await page.fill('#image-reference', 'images:debian/31');
    await page.fill('#image-label', 'Version qui n’existe pas');
    await page.click('dialog.modale[open] [data-engage="image"]');
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

// --- LE CONTRAT CLAVIER DES TROIS DEGRÉS (SPK-33, §5.4, §9.1) --------------

test('les trois degrés s’atteignent au clavier, et annoncent où l’on est', async () => {
  await parcours('clavier-degres', async () => {
    await accueil();

    // Degré 1 — la barre latérale. La destination courante est annoncée.
    const destination = await page.evaluate(() =>
      document.querySelector('.laterale a[aria-current="page"]')?.getAttribute('href'));
    assert.equal(destination, '#/sparks');

    // Degré 2 — l'onglet de l'hôte, atteint par le clavier.
    let atteint = null;
    for (let i = 0; i < 20 && atteint !== '#/forge'; i += 1) {
      await page.keyboard.press('Tab');
      atteint = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    }
    assert.equal(atteint, '#/forge', 'la destination « Hôte » est atteignable');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.onglets', { timeout: 10000 });

    let onglet = null;
    for (let i = 0; i < 20 && onglet !== '#/forge/images'; i += 1) {
      await page.keyboard.press('Tab');
      onglet = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    }
    assert.equal(onglet, '#/forge/images', 'l’onglet est atteignable au clavier');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#titre-catalogue', { timeout: 10000 });

    // L'onglet courant s'annonce, et la destination de premier degré reste
    // « Hôte » : deux degrés, deux indications, sans conflit.
    assert.equal(
      await page.evaluate(() =>
        document.querySelector('.onglet[aria-current="page"]')?.getAttribute('href')),
      '#/forge/images');
    assert.equal(
      await page.evaluate(() =>
        document.querySelector('.laterale a[aria-current="page"]')?.getAttribute('href')),
      '#/forge');
  });
});

test('une facette d’un Spark est une DESTINATION rechargeable', async () => {
  await parcours('facette-rechargeable', async () => {
    await ouvrir('crm-production', 'instantanes');
    const url = page.url();
    assert.match(url, /#\/sparks\/crm-production\/instantanes$/);

    // §5.4 : le critère est l'URL. Recharger doit ramener la même facette.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#titre-instantanes', { timeout: 15000 });
    assert.equal(
      await page.evaluate(() =>
        document.querySelector('.onglet[aria-current="page"]')?.getAttribute('href')),
      '#/sparks/crm-production/instantanes');
    // Un seul sujet par surface : les routes ne sont pas là.
    assert.equal(await page.$('#titre-routes'), null);
  });
});

// --- LE CONTRAT DE LA MODALE (SPK-33, DESIGN_SYSTEM.md §6.27) --------------

test('la modale tient son contrat : focus entrant, Échap, focus rendu', async () => {
  await parcours('modale-contrat', async () => {
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-routes');

    // Le déclencheur reste visible : c'est lui qui recevra le focus.
    await page.focus('[data-ouvre="route"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open]', { timeout: 10000 });

    // Le nom accessible est le TITRE DE LA SECTION : c'est ce qui borne la portée.
    assert.equal(
      await page.evaluate(() => {
        const d = document.querySelector('dialog.modale');
        return document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim();
      }),
      'Routes publiques');

    // Le focus entre dans le PREMIER contrôle : ouvrir, c'est commencer à saisir.
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'route-domaine');

    // L'arrière-plan est inerte : on ne peut pas atteindre ce qui est derrière.
    assert.equal(
      await page.evaluate(() => {
        const derriere = document.querySelector('[data-ouvre="route"]');
        derriere?.focus();
        return document.activeElement === derriere;
      }),
      false, 'le focus ne sort pas de la modale');

    // Échap ferme, et la fermeture ÉQUIVAUT À UNE ANNULATION.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.modale[open]'),
                               { timeout: 10000 });
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-ouvre')),
      'route', 'le focus revient au déclencheur');
  });
});

test('un refus s’affiche DANS la modale et n’efface pas la saisie', async () => {
  await parcours('modale-refus', async () => {
    await ouvrir('boutique', 'routes');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('dialog.modale[open]');

    // `crm.example.com` appartient déjà au CRM dans le seed : la base refuse.
    await page.fill('#route-domaine', 'crm.example.com');
    await page.fill('#route-port', '8080');
    await page.click('[data-engage="route"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });

    // La modale ne se referme pas : elle perdrait le travail et cacherait la raison.
    assert.ok(await page.$('dialog.modale[open]'));
    assert.equal(await page.inputValue('#route-domaine'), 'crm.example.com');
    assert.equal(await page.inputValue('#route-port'), '8080');
  });
});

// --- POINTER LE DOMAINE (SPK-47, docs/DAT.md §38) --------------------------

/** Déclare une route publique DEPUIS l'écran, comme un exploitant (§29.3). */
async function declarerRoute(spark, domaine, port = '8080') {
  await ouvrir(spark, 'routes');
  await page.waitForSelector('#titre-routes');
  await page.click('[data-ouvre="route"]');
  await page.waitForSelector('dialog.modale[open] #route-domaine');
  await page.fill('#route-domaine', domaine);
  await page.fill('#route-port', port);
  await page.click('[data-engage="route"]');
  await page.waitForSelector(`li:has-text("${domaine}")`, { timeout: 10000 });
}

test('pointer le DNS d’une route écrit l’enregistrement, et RIEN d’autre', async () => {
  await parcours('dns-pointer', async () => {
    await declarerRoute('boutique', 'boutique.exemple.test');

    // Le geste part de la LIGNE de la route : c'est elle qui porte le domaine.
    await page.click('li:has-text("boutique.exemple.test") [data-dns-route]');
    await page.waitForSelector('dialog.modale[open] #dns-zone', { timeout: 10000 });

    // Le domaine n'est pas saisissable : il vient de la route.
    assert.equal(await page.inputValue('#dns-domaine'), 'boutique.exemple.test');
    assert.equal(await page.getAttribute('#dns-domaine', 'readonly'), '');
    // La zone la plus spécifique qui le contienne est PRÉ-CHOISIE.
    assert.equal(await page.inputValue('#dns-zone'), 'exemple.test');

    await page.fill('#dns-adresse', '198.51.100.7');
    // L'écran montre ce qui SERA écrit avant de l'écrire.
    const apercu = await page.textContent('dialog.modale[open] .note');
    assert.ok(apercu.includes('boutique'), 'le nom relatif à la zone');
    assert.ok(apercu.includes('198.51.100.7'));

    await page.click('[data-engage="dns"]');
    await page.waitForSelector('#titre-routes ~ * .avertissement, .avertissement[role="status"]',
                               { timeout: 10000 });
    const annonce = await page.textContent('.avertissement[role="status"]');
    assert.ok(annonce.includes('A boutique.exemple.test'));
    assert.ok(annonce.includes('198.51.100.7'));
    assert.ok(/écrit chez le fournisseur/.test(annonce));
    // §38.4 : ce qui est ÉCRIT, jamais un domaine « prêt ».
    assert.ok(/propagation|jusqu/i.test(annonce), 'la propagation doit être dite');
    assert.ok(!/prêt|résout désormais/i.test(annonce));

    // EFFET, constaté chez le fournisseur : l'enregistrement est là…
    const zone = dns.enregistrements();
    const pose = zone.find((r) => r.name === 'boutique' && r.type === 'A');
    assert.ok(pose, 'l’enregistrement doit exister chez le fournisseur');
    assert.equal(pose.data, '198.51.100.7');
    assert.equal(pose.ttl, 300);

    // … et les VOISINS n'ont pas bougé. C'est la règle du §38.2, et c'est ce
    // qu'une écriture trop large casserait pour de bon dans une zone réelle.
    assert.ok(zone.some((r) => r.type === 'MX' && r.data === '10 mail.exemple.test.'),
      'la messagerie de la zone ne doit pas être touchée');
    assert.ok(zone.some((r) => r.name === '_verification' && r.type === 'TXT'),
      'la preuve de propriété ne doit pas être touchée');
    assert.ok(zone.some((r) => r.name === 'www' && r.data === '198.51.100.1'),
      'un A voisin ne doit pas être emporté');

    // Ce que le produit a DEMANDÉ : jamais de création de zone.
    const dernier = dns.recus().at(-1);
    assert.equal(dernier.disallow_new_zone_creation, true);
    assert.equal(dernier.changes.length, 1, 'un seul changement, pas un lot');
  });
});

test('pointer l’APEX d’une zone est refusé, et la zone n’est pas touchée', async () => {
  await parcours('dns-apex', async () => {
    const avant = dns.enregistrements().length;
    await declarerRoute('boutique', 'exemple.test', '8081');

    await page.click('li:has-text("exemple.test") [data-dns-route]');
    await page.waitForSelector('dialog.modale[open] #dns-adresse', { timeout: 10000 });
    // Aucune zone ne contient l'apex : il faut donc la choisir à la main, ce qui
    // est déjà un signal. Le refus, lui, vient du produit et pas de l'écran.
    await page.selectOption('#dns-zone', 'exemple.test');
    await page.fill('#dns-adresse', '198.51.100.7');
    assert.equal(await page.isDisabled('[data-engage="dns"]'), false,
      'l’interface ne s’oppose pas : le refus est une RÈGLE, pas un grisage');
    await page.click('[data-engage="dns"]');

    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });
    const refus = await page.textContent('dialog.modale[open] .refus');
    assert.ok(/apex/.test(refus), 'le refus doit NOMMER ce qu’il protège');
    assert.ok(/serveurs de noms|messagerie/.test(refus));

    // La modale reste ouverte, et la zone n'a pas bougé d'un enregistrement.
    assert.ok(await page.$('dialog.modale[open]'));
    assert.equal(dns.enregistrements().length, avant);
  });
});
