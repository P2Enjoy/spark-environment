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

beforeEach(async () => {
  bruits = [];
  // SPK-44 : le doublon Docker garde un témoin entre deux parcours. Le laisser
  // condamnerait tous les parcours suivants à ne plus lire de journaux, et leur
  // échec ne dirait pas pourquoi.
  await pile?.oublierLecturesDocker?.();
});

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
  // REVISE par SPK-52 : le compte était FIGÉ à cinq. Le seed porte désormais
  // « orphelin » (§14.5), et le nombre a rougi sans rien dire du produit — il
  // rougira encore à la prochaine fixture.
  //
  // Ce que la preuve établit est INCHANGÉ, et mieux dit : l'écran montre ce que
  // le REGISTRE contient, ni plus ni moins. Le compte se lit donc sur `sparkd`
  // au lieu d'être recopié ici, et les fixtures nommées restent exigées une à
  // une — c'est leur PRÉSENCE qui compte, pas leur nombre.
  await parcours('liste', async () => {
    await accueil();
    const lignes = await page.$$eval('tbody tr', (tr) => tr.map((l) => l.innerText));
    const { corps } = await pile.lireSparkd('/v1/sparks');
    assert.equal(lignes.length, corps.sparks.length,
      'l’écran doit montrer exactement ce que le registre contient');
    const texte = lignes.join('\n');
    for (const attendu of ['crm-production', 'boutique', 'postgres-dedie',
                           'analytics', 'site-vitrine', 'orphelin']) {
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

test("l'écran de la Forge s'atteint par la navigation et montre la vraie capacité", async () => {
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
    // PAR LA NAVIGATION : accueil, Forge, onglet Journal (§36.8.1).
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
    // SPK-59 : la mémoire se règle au curseur. On le pousse à sa borne haute au
    // clavier — la capacité TOTALE de la Forge —, ce qui dépasse forcément le
    // disponible dès qu'un Spark existe. Un curseur borné sur le disponible
    // rendrait ce refus inatteignable, et cette preuve sans objet.
    await auMaximum('#memory_gib');
    const demande = Number(await page.inputValue('#memory_gib'));
    const { corps: forge } = await pile.lireSparkd('/v1/forge');
    assert.ok(demande * 1024 ** 3 > forge.pools.memory.available,
      'le curseur doit laisser demander plus que ce qui reste libre');
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
    assert.equal(atteint, '#/forge', 'le lien « Forge » doit être atteignable au clavier');
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

test('le catalogue a son écran, atteint par les onglets de la Forge', async () => {
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

    // Degré 2 — l'onglet de la Forge, atteint par le clavier.
    let atteint = null;
    for (let i = 0; i < 20 && atteint !== '#/forge'; i += 1) {
      await page.keyboard.press('Tab');
      atteint = await page.evaluate(() => document.activeElement?.getAttribute('href'));
    }
    assert.equal(atteint, '#/forge', 'la destination « Forge » est atteignable');
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
    // « Forge » : deux degrés, deux indications, sans conflit.
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

/**
 * Désigne la LIGNE d'une route par son domaine EXACT.
 *
 * `has-text` cherche un sous-texte : « exemple.test » désignait aussi
 * « boutique.exemple.test », et le parcours de l'apex cliquait sur la mauvaise
 * ligne — il passait seul et rougissait dans la campagne. Mesuré.
 */
const ligneRoute = (domaine) => `li:has(span.technique:text-is("${domaine}"))`;

/** Déclare une route publique DEPUIS l'écran, comme un exploitant (§29.3). */
/**
 * Pousse un quota à sa borne haute, AU CLAVIER, comme un utilisateur.
 *
 * @verifies docs/BACKLOG.md#SPK-59 · docs/DESIGN_SYSTEM.md §6.9 bis
 *
 * On ne « remplit » pas un curseur : `page.fill` rend « Malformed value » sur un
 * `input[type=range]`. `Fin` est le geste natif qui va à la borne haute, et
 * l'employer prouve au passage que le curseur est utilisable sans souris (§9.1).
 *
 * La borne haute étant la capacité TOTALE de la Forge et non le disponible, ce
 * geste demande plus que ce qui reste libre dès qu'un seul Spark existe. C'est
 * ce qui garde le refus d'admission atteignable depuis l'écran.
 */
async function auMaximum(selecteur) {
  const controle = page.locator(selecteur);
  const type = await controle.getAttribute('type');
  await controle.focus();
  if (type === 'range') {
    await controle.press('End');
    return;
  }
  // Repli du §6.9 bis : sans bornes exploitables, le champ est resté une saisie.
  await controle.fill('999999');
}

async function declarerRoute(spark, domaine, port = '8080') {
  await ouvrir(spark, 'routes');
  await page.waitForSelector('#titre-routes');
  await page.click('[data-ouvre="route"]');
  await page.waitForSelector('dialog.modale[open] #route-domaine');
  await page.fill('#route-domaine', domaine);
  await page.fill('#route-port', port);
  await page.click('[data-engage="route"]');
  await page.waitForSelector(ligneRoute(domaine), { timeout: 10000 });
}

test('pointer le DNS d’une route écrit l’enregistrement, et RIEN d’autre', async () => {
  await parcours('dns-pointer', async () => {
    await declarerRoute('boutique', 'boutique.exemple.test');

    // Le geste part de la LIGNE de la route : c'est elle qui porte le domaine.
    await page.click(`${ligneRoute('boutique.exemple.test')} [data-dns-route]`);
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

    // Un exploitant LIT ce que l'écriture va faire avant d'engager. Le parcours
    // attend la même chose — et c'est aussi ce qui prouve que la lecture aboutit.
    await page.waitForSelector('#dns-effet p', { timeout: 10000 });
    assert.match(await page.textContent('#dns-effet'), /Rien n’occupe ce nom/);

    await page.click('[data-engage="dns"]');
    // `#dns-ecrit` et non `.avertissement` : depuis §38.5.2, la modale porte elle
    // aussi un avertissement — « sera remplacé ». Attendre la classe seule ferait
    // prendre un projet d'écriture pour une écriture faite. Mesuré.
    await page.waitForSelector('#dns-ecrit', { timeout: 10000 });
    const annonce = await page.textContent('#dns-ecrit');
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

test('pointer l’APEX écrit le domaine NU, sans toucher ses NS ni son MX', async () => {
  // REVISE le 2026-08-20 (§38.5.1). Ce parcours exigeait un REFUS sur l'apex. Le
  // refus interdisait un site sur le domaine nu — `johndalia.com` —, cas
  // ordinaire et nommé par le responsable ; et son motif ne tenait pas, puisque
  // l'écriture vise un nom ET un type exacts.
  //
  // Ce que le parcours établit est plus fort qu'avant : non seulement l'apex
  // s'écrit, mais les enregistrements d'AUTRE TYPE qui y vivent survivent — ce
  // qui EST la garantie que le refus prétendait apporter.
  await parcours('dns-apex', async () => {
    await declarerRoute('boutique', 'exemple.test', '8081');

    await page.click(`${ligneRoute('exemple.test')} [data-dns-route]`);
    await page.waitForSelector('dialog.modale[open] #dns-adresse', { timeout: 10000 });
    // Aucune zone ne CONTIENT l'apex : il se choisit donc à la main.
    await page.selectOption('#dns-zone', 'exemple.test');
    await page.fill('#dns-adresse', '198.51.100.7');
    await page.waitForSelector('#dns-effet p', { timeout: 10000 });
    // L'écran DIT que le geste porte sur le domaine nu (§38.5.1).
    assert.match(await page.textContent('#dns-effet'), /domaine nu/);

    await page.click('[data-engage="dns"]');
    await page.waitForSelector('#dns-ecrit', { timeout: 10000 });
    const annonce = await page.textContent('#dns-ecrit');
    assert.ok(annonce.includes('exemple.test'));

    const zone = dns.enregistrements();
    const apex = zone.find((r) => r.name === '' && r.type === 'A');
    assert.ok(apex, 'l’apex doit porter un A');
    assert.equal(apex.data, '198.51.100.7');

    // LA garantie : le MX de l'apex, qui est d'un AUTRE type, n'a pas bougé.
    assert.ok(zone.some((r) => r.name === '' && r.type === 'MX'
                               && r.data === '10 mail.exemple.test.'),
      'la messagerie de l’apex ne doit pas être emportée');
    assert.ok(zone.some((r) => r.name === '_verification' && r.type === 'TXT'));
  });
});

test('l’écran MONTRE ce qu’il va remplacer avant de le remplacer', async () => {
  // §38.5.2 : c'est ce qui remplace le refus d'écrire à l'apex — on ne retire
  // pas le pouvoir, on montre ce qu'il va faire.
  await parcours('dns-remplace', async () => {
    await declarerRoute('boutique', 'www.exemple.test', '8082');
    await page.click(`${ligneRoute('www.exemple.test')} [data-dns-route]`);
    await page.waitForSelector('dialog.modale[open] #dns-adresse', { timeout: 10000 });

    // `www` porte déjà 198.51.100.1 dans le doublon.
    await page.fill('#dns-adresse', '198.51.100.9');
    await page.dispatchEvent('#dns-adresse', 'change');
    await page.waitForSelector('#dns-effet .avertissement', { timeout: 10000 });
    const effet = await page.textContent('#dns-effet');

    // Le focus ne doit PAS avoir bougé : la lecture remplace un bloc, elle ne
    // reconstruit pas le formulaire sous les doigts.
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'dns-adresse');
    assert.ok(effet.includes('198.51.100.1'), 'la valeur REMPLACÉE doit être lisible');
    assert.ok(effet.includes('198.51.100.9'));
    assert.ok(/remplac/.test(effet));
  });
});

// --- LE JOKER ET LA SURCHARGE (SPK-48, docs/DAT.md §18.3 bis) --------------

test('le joker seedé montre le nom qui lui est SOUSTRAIT, et qui le sert', async () => {
  await parcours('joker-surcharge', async () => {
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-routes');

    const joker = ligneRoute('*.boutique.example.com');
    await page.waitForSelector(joker, { timeout: 10000 });

    // C'est CE que l'unité apporte : depuis le joker, on voit ce qui part
    // ailleurs. Sans cela on chercherait dans la configuration du Spark
    // porteur, où il n'y a rien à trouver.
    const surcharge = await page.textContent(`${joker} .surcharges`);
    assert.ok(surcharge.includes('vip.boutique.example.com'));
    assert.ok(surcharge.includes('crm-production'));

    // EFFET côté sparkd : c'est bien le nom EXACT qui est rencontré en premier
    // par le proxy — la préséance ne se voit pas à l'écran, elle se lit dans la
    // configuration produite.
    const { corps } = await pile.lireSparkd('/v1/ingress');
    const joker_ = corps.routes.find((r) => r.domain === '*.boutique.example.com');
    assert.deepEqual(joker_.superseded_by,
      [{ domain: 'vip.boutique.example.com', spark_name: 'crm-production' }]);
  });
});

test('déclarer un nom avalé par un joker RÉUSSIT, et nomme le Spark dépassé', async () => {
  await parcours('joker-prise-de-pas', async () => {
    await ouvrir('crm-production', 'routes');
    await page.waitForSelector('#titre-routes');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('dialog.modale[open] #route-domaine');

    // `*.boutique.example.com` appartient au Spark « boutique » dans le seed.
    await page.fill('#route-domaine', 'promo.boutique.example.com');
    await page.fill('#route-port', '8080');
    // L'interface ne s'y oppose PAS : c'est une déclaration légitime, celle par
    // laquelle on sort un sous-domaine du joker pour lui donner son Spark.
    assert.equal(await page.isDisabled('[data-engage="route"]'), false);
    await page.click('[data-engage="route"]');

    await page.waitForSelector('#prise-de-pas', { timeout: 10000 });
    const avis = await page.textContent('#prise-de-pas');
    assert.ok(avis.includes('*.boutique.example.com'));
    assert.ok(avis.includes('boutique'), 'le Spark dépassé doit être NOMMÉ');

    // Ce n'est pas un refus : la route existe réellement.
    assert.ok(await page.$(ligneRoute('promo.boutique.example.com')));
    const { corps } = await pile.lireSparkd('/v1/ingress');
    const posee = corps.routes.find((r) => r.domain === 'promo.boutique.example.com');
    assert.equal(posee.spark_name, 'crm-production');
  });
});

test('un joker mal placé est refusé en NOMMANT la borne', async () => {
  await parcours('joker-borne', async () => {
    await ouvrir('crm-production', 'routes');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('dialog.modale[open] #route-domaine');
    await page.fill('#route-domaine', 'api.*.monapi.fr');
    await page.fill('#route-port', '8080');
    await page.click('[data-engage="route"]');

    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });
    const refus = await page.textContent('dialog.modale[open] .refus');
    assert.ok(/joker/.test(refus), 'le refus doit nommer la borne, pas dire « invalide »');
    assert.ok(refus.includes('*.monapi.fr'), 'il doit montrer la forme acceptée');
  });
});

// --- LES PORTS PUBLIÉS (SPK-49, docs/DAT.md §39) ---------------------------

const lignePort = (p) => `li:has(span.technique:text-is("${p}"))`;

test('le port publié du seed se lit, avec ce à quoi il sert', async () => {
  await parcours('port-seede', async () => {
    await ouvrir('crm-production', 'routes');
    await page.waitForSelector('#titre-ports');
    const ligne = await page.textContent(lignePort('2525/tcp'));
    assert.ok(ligne.includes('port 25 du Spark'));
    assert.ok(ligne.includes('SMTP entrant'), 'la raison d’être doit être lisible');

    // EFFET côté sparkd : le device est réellement posé sur l'instance.
    const { corps } = await pile.lireSparkd('/v1/ports');
    const publie = corps.ports.find((p) => p.public_port === 2525);
    assert.equal(publie.spark_name, 'crm-production');
    assert.ok(publie.applied_at, 'un Spark appliqué voit son port appliqué');
  });
});

test('publier un port RÉSERVÉ est refusé en nommant ce qui le tient', async () => {
  await parcours('port-reserve', async () => {
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-ports');
    await page.click('[data-ouvre="port"]');
    await page.waitForSelector('dialog.modale[open] #port-public');

    // La mise en garde du §39.3 est là AVANT toute saisie.
    const modale = await page.textContent('dialog.modale[open]');
    assert.ok(modale.includes('certificat automatique'));
    assert.ok(modale.includes('route publique'));

    await page.fill('#port-public', '443');
    await page.fill('#port-cible', '8080');
    // L'interface ne s'y oppose PAS : le refus est une RÈGLE, pas un grisage.
    assert.equal(await page.isDisabled('[data-engage="port"]'), false);
    await page.click('[data-engage="port"]');

    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });
    const refus = await page.textContent('dialog.modale[open] .refus');
    assert.ok(refus.includes('proxy'), 'le refus doit NOMMER ce qui tient le port');
    assert.ok(refus.includes('pas attribuable'));
  });
});

test('publier un port DÉJÀ PRIS est refusé en nommant le Spark qui le détient', async () => {
  await parcours('port-conflit', async () => {
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-ports');
    await page.click('[data-ouvre="port"]');
    await page.waitForSelector('dialog.modale[open] #port-public');
    await page.fill('#port-public', '2525');       // détenu par crm-production
    await page.fill('#port-cible', '25');
    await page.click('[data-engage="port"]');

    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 10000 });
    const refus = await page.textContent('dialog.modale[open] .refus');
    assert.ok(refus.includes('crm-production'), 'le Spark détenteur doit être NOMMÉ');

    // Effet backend : le port appartient toujours au même Spark.
    const { corps } = await pile.lireSparkd('/v1/ports');
    assert.equal(corps.ports.find((p) => p.public_port === 2525).spark_name,
                 'crm-production');
  });
});

test('publier puis retirer un port ouvre puis REFERME réellement', async () => {
  await parcours('port-cycle', async () => {
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-ports');
    await page.click('[data-ouvre="port"]');
    await page.waitForSelector('dialog.modale[open] #port-public');
    await page.fill('#port-public', '5433');
    await page.fill('#port-cible', '5432');
    await page.fill('#port-note', 'Postgres depuis le poste');
    await page.click('[data-engage="port"]');
    await page.waitForSelector(lignePort('5433/tcp'), { timeout: 10000 });

    const { corps: apres } = await pile.lireSparkd('/v1/ports');
    assert.ok(apres.ports.some((p) => p.public_port === 5433));

    // Le retrait CONFIRME, puis referme.
    await page.click(`${lignePort('5433/tcp')} [data-retire-port]`);
    await page.waitForSelector('.confirmation [data-confirme-port]');
    await page.click('[data-confirme-port]');
    await page.waitForSelector(lignePort('5433/tcp'), { state: 'detached', timeout: 10000 });

    const { corps: fini } = await pile.lireSparkd('/v1/ports');
    assert.ok(!fini.ports.some((p) => p.public_port === 5433),
      'le port doit avoir disparu du registre');
  });
});

// --- LES RECETTES DNS (SPK-50, docs/DAT.md §38.6) --------------------------

test('appliquer une recette écrit TOUTES ses lignes, et rend le sort de chacune', async () => {
  await parcours('recette-site-web', async () => {
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-routes');
    await page.click('[data-ouvre="recette"]');
    await page.waitForSelector('dialog.modale[open] #recette-id', { timeout: 15000 });

    await page.selectOption('#recette-id', 'site-web');
    await page.selectOption('#recette-zone', 'exemple.test');
    await page.fill('[data-param="domain"]', 'exemple.test');
    await page.fill('[data-param="address"]', '198.51.100.7');
    await page.dispatchEvent('[data-param="address"]', 'change');

    // L'écran présente la recette ENTIÈRE avant d'écrire (§38.6.3).
    await page.waitForSelector('#recette-apercu .recette-lignes', { timeout: 15000 });
    const apercu = await page.textContent('#recette-apercu');
    assert.ok(apercu.includes('@ A'), 'le domaine nu se note « @ »');
    assert.ok(apercu.includes('www A'));
    assert.ok(apercu.includes('198.51.100.7'));

    await page.click('[data-engage="recette"]');
    await page.waitForSelector('#recette-resultat', { timeout: 20000 });
    const bilan = await page.textContent('#recette-resultat');
    assert.ok(bilan.includes('2 écrit(s)'));
    assert.ok(!bilan.includes('en échec'));

    // EFFET, constaté chez le fournisseur : les deux lignes sont là…
    const zone = dns.enregistrements();
    assert.ok(zone.some((r) => r.name === '' && r.type === 'A' && r.data === '198.51.100.7'));
    assert.ok(zone.some((r) => r.name === 'www' && r.type === 'A' && r.data === '198.51.100.7'));
    // … et le MX de l'apex, qui est d'un AUTRE type, n'a pas bougé.
    assert.ok(zone.some((r) => r.name === '' && r.type === 'MX'),
      'la messagerie de l’apex ne doit pas être emportée');
  });
});

test('la recette du relais RÉCLAME sa clé et se dit incomplète sans elle', async () => {
  await parcours('recette-relais', async () => {
    await ouvrir('boutique', 'routes');
    await page.click('[data-ouvre="recette"]');
    await page.waitForSelector('dialog.modale[open] #recette-id', { timeout: 15000 });

    await page.selectOption('#recette-id', 'relais-transactionnel');
    // L'avertissement est lisible AVANT d'appliquer.
    const modale = await page.textContent('dialog.modale[open]');
    assert.ok(/ÉMET et NE REÇOIT PAS/.test(modale));
    assert.ok(modale.includes('PTR'), 'les actions humaines restantes sont dites');

    await page.selectOption('#recette-zone', 'exemple.test');
    await page.fill('[data-param="domain"]', 'noreply.exemple.test');
    await page.fill('[data-param="selector"]', 'projet-1');
    await page.dispatchEvent('[data-param="selector"]', 'change');

    await page.waitForSelector('#recette-apercu .recette-lignes', { timeout: 15000 });
    const apercu = await page.textContent('#recette-apercu');
    assert.ok(apercu.includes('SANS SIGNATURE'),
      'sans la clé, l’écran doit dire ce que l’absence entraîne');

    await page.click('[data-engage="recette"]');
    await page.waitForSelector('#recette-resultat', { timeout: 20000 });
    assert.ok((await page.textContent('#recette-resultat')).includes('3 écrit(s)'));

    // Le MX du sous-domaine pointe bien vers un puits, et le SPF est posé.
    const zone = dns.enregistrements();
    assert.ok(zone.some((r) => r.name === 'noreply' && r.type === 'MX'
                               && r.data.includes('blackhole')));
    assert.ok(zone.some((r) => r.name === 'noreply' && r.type === 'TXT'
                               && r.data.includes('_spf.tem.scaleway.com')));
    assert.ok(zone.some((r) => r.name === '_dmarc.noreply' && r.type === 'TXT'));
  });
});

// --- SUPPRESSION D'UN SPARK SANS INSTANCE (SPK-52, docs/DAT.md §14.5) ------

test('supprimer un Spark dont l’instance a disparu RÉUSSIT depuis la console', async () => {
  await parcours('suppression-orphelin', async () => {
    // Mesuré le 2026-08-19 : ce geste rendait 502, la ligne restait au registre
    // et pesait dans l'admission. Le seul recours était d'ouvrir la base.
    const { corps: avant } = await pile.lireSparkd('/v1/forge');
    const placeAvant = avant.pools.memory.allocated;

    await ouvrir('orphelin');
    await page.waitForSelector('.entete-entite');
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('[data-confirme]', { timeout: 10000 });
    await page.click('[data-confirme]');

    // On revient à la liste, et le Spark n'y est plus.
    await page.waitForSelector('tbody a', { timeout: 20000 });
    await page.waitForFunction(
      () => ![...document.querySelectorAll('tbody a')].some((a) => a.textContent.trim() === 'orphelin'),
      null, { timeout: 20000 });

    // EFFET côté sparkd : la ligne est partie ET la place est rendue (§14.4).
    const { status } = await pile.lireSparkd('/v1/sparks/orphelin');
    assert.equal(status, 404);
    const { corps: apres } = await pile.lireSparkd('/v1/forge');
    assert.ok(apres.pools.memory.allocated < placeAvant,
      'la mémoire du Spark disparu doit retourner au pool');

    // L'ÉCART reste lisible : le journal le dit en toutes lettres (§14.5).
    const { corps: journal } = await pile.lireSparkd('/v1/audit?limit=200');
    const marquee = journal.entries.find((e) => e.action === 'spark.delete'
      && /ABSENTE/.test(e.message ?? ''));
    assert.ok(marquee, 'la suppression d’une instance absente ne se lit pas comme une autre');
    assert.ok(marquee.message.includes('admission'));
  });
});

// --- LE TERMINAL (SPK-43, docs/DAT.md §37.4) -------------------------------

test('entrer dans le terminal, écrire, voir répondre, quitter, et le distant meurt', async () => {
  // LE parcours de la DoD. Le transport est doublé (§37.4.2 bis) : « cat »
  // renvoie ce qu'on lui donne, donc la boucle complète — saisie, flux, sortie —
  // est celle de la production, seule la commande lancée change.
  await parcours('terminal', async () => {
    await ouvrir('crm-production', 'terminal');
    await page.waitForSelector('#titre-terminal');

    // Fermé, la saisie est verrouillée : rien ne part vers un Spark sans session.
    assert.ok(await page.isDisabled('#terminal-entree'));

    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });
    assert.equal(await page.isDisabled('#terminal-entree'), false);

    // Une commande, au CLAVIER, et sa réponse.
    await page.fill('#terminal-entree', 'bonjour depuis le parcours');
    await page.press('#terminal-entree', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#terminal-sortie')
        ?.textContent.includes('bonjour depuis le parcours'),
      null, { timeout: 20000 });
    assert.equal(await page.inputValue('#terminal-entree'), '',
      'la saisie se vide après envoi');

    // EFFET côté sparkd : le journal porte l'OUVERTURE, et rien de ce qui a été
    // tapé (§37.5).
    const { corps: journal } = await pile.lireSparkd('/v1/audit?limit=200');
    const ouverture = journal.entries.find((e) => e.action === 'spark.terminal_open');
    assert.ok(ouverture, 'l’ouverture doit être au journal');
    assert.ok(!JSON.stringify(journal.entries).includes('bonjour depuis le parcours'),
      'AUCUNE frappe ne doit atteindre le journal');

    // Quitter : la session se ferme et le distant meurt.
    await page.click('[data-terminal="fermer"]');
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });

    const { corps: apres } = await pile.lireSparkd('/v1/audit?limit=200');
    const fermeture = apres.entries.find((e) => e.action === 'spark.terminal_close');
    assert.ok(fermeture, 'la fermeture doit être au journal, avec sa durée');
    assert.match(fermeture.message, /après \d+ s/);
  });
});

test('quitter l’ONGLET termine la session, sans la fermer soi-même', async () => {
  // §37.4 : une session qui survivrait à son écran serait un shell root
  // abandonné dont personne ne se souvient.
  await parcours('terminal-quitter', async () => {
    await ouvrir('boutique', 'terminal');
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

    const avant = (await pile.lireSparkd('/v1/audit?limit=200')).corps.entries
      .filter((e) => e.action === 'spark.terminal_close').length;

    // On CHANGE d'onglet, sans rien fermer.
    await page.click('.onglet[href$="/journal"]');
    await page.waitForSelector('.onglet[href$="/journal"][aria-current="page"]',
                               { timeout: 10000 });

    await page.waitForFunction(async (n) => {
      const r = await fetch('/api/v1/audit?limit=200&server=local');
      const { entries } = await r.json();
      return entries.filter((e) => e.action === 'spark.terminal_close').length > n;
    }, avant, { timeout: 20000 });
  });
});

test('un Spark sans CELLULE nomme ce qui manque', async () => {
  // §37.2 : l'écran ne rend ni onglet vide, ni erreur technique. « analytics »
  // est déclaré mais jamais appliqué : il porte DÉJÀ une adresse — elle est
  // attribuée à l'écriture au registre — et pourtant rien ne tourne.
  await parcours('terminal-sans-cellule', async () => {
    await ouvrir('analytics', 'terminal');
    await page.waitForSelector('#titre-terminal');
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('.refus', { timeout: 20000 });
    assert.match(await page.textContent('.refus'), /pas encore de cellule/);
    assert.ok((await page.textContent('.principal')).includes('doit être'));
  });
});

// --- SPK-54 · AMORCER UN SPARK (§41, §42) -----------------------------------

test('l’amorçage RELÈVE avant d’agir, et ne relève pas de lui-même', async () => {
  await parcours('amorcage-releve', async () => {
    await ouvrir('crm-production');
    await page.waitForSelector('#titre-amorcage');

    // §14.6 : « pas encore relevé » n'est ni « rien à faire », ni « tout va
    // bien ». Le relevé entre dans la cellule du locataire : il se demande.
    const avant = await page.textContent('#titre-amorcage ~ .absence');
    assert.match(avant, /n’a pas encore été relevé/);

    await page.focus('[data-amorcage="relever"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.liste-amorcage', { timeout: 15000 });

    const lignes = await page.$$eval('.ligne-amorcage', (l) => l.map((x) => x.textContent));
    assert.equal(lignes.length, 5, 'les cinq éléments du §42.1');
    const ecran = await page.textContent('.principal');
    assert.ok(!/present|defect|sshd=/.test(ecran),
      'aucun jeton technique brut n’atteint l’écran (§14.7)');

    // Une LECTURE : rien au journal (§36.7).
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.bootstrap&limit=10');
    assert.equal(corps.entries.length, 0, 'relever n’est pas amorcer');
  });
});

test('amorcer NOMME le pouvoir employé, puis rend le sort de chaque ligne', async () => {
  await parcours('amorcage-geste', async () => {
    await ouvrir('crm-production');
    await page.waitForSelector('#titre-amorcage');

    await page.click('[data-amorcage="amorcer"]');
    await page.waitForSelector('[data-amorcage="engager"]', { timeout: 10000 });

    // §6.23 et §42.3 : la confirmation dit ce qui va se passer.
    const confirmation = await page.textContent('.confirmation');
    assert.match(confirmation, /en root dans la\s+cellule/);
    assert.match(confirmation, /sans passer par SSH/);
    assert.match(confirmation, /crm-production/);
    assert.match(confirmation, /Seuls les éléments manquants sont installés/);

    // AU CLAVIER : le focus est déjà sur le point d'engagement (§14.3).
    await page.keyboard.press('Enter');
    await page.waitForSelector('.liste-amorcage', { timeout: 20000 });

    const lignes = await page.$$eval('.ligne-amorcage', (l) => l.map((x) => x.textContent));
    assert.equal(lignes.length, 5);
    assert.ok(lignes.some((l) => /installé/.test(l)), 'ce qui manquait est posé');

    // EFFET côté sparkd : le journal porte l'action DISTINCTE, et elle nomme.
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.bootstrap&limit=10');
    assert.equal(corps.entries.length, 1);
    assert.match(corps.entries[0].message, /Amorçage de « crm-production »/);
    assert.equal(JSON.parse(corps.entries[0].payload).path, 'incus_exec');
    // …et elle ne s'est pas comptée comme un dépannage (§37.3).
    const { corps: depannages } = await pile.lireSparkd(
      '/v1/audit?action=spark.rescue_exec&limit=10');
    assert.equal(depannages.entries.length, 0);
  });
});

test('un SECOND amorçage ne fait rien, et le dit', async () => {
  await parcours('amorcage-idempotent', async () => {
    // C'est LE point de la DoD : un geste bavard redémarrerait le moteur Docker
    // du locataire, donc sa production, pour rien.
    await ouvrir('postgres-dedie');
    await page.waitForSelector('#titre-amorcage');

    for (const _ of [1, 2]) {
      await page.click('[data-amorcage="amorcer"]');
      await page.waitForSelector('[data-amorcage="engager"]', { timeout: 10000 });
      await page.click('[data-amorcage="engager"]');
      await page.waitForSelector('.liste-amorcage', { timeout: 20000 });
    }

    await page.waitForFunction(
      () => document.body.innerText.includes('Rien n’a été fait'), { timeout: 10000 });
    const ecran = await page.textContent('.principal');
    assert.match(ecran, /tout était déjà en place/);

    // Les DEUX amorçages sont au journal : savoir que le geste a été demandé et
    // que rien n'était à faire est une information (§42.8).
    // Le journal est celui de la FORGE : un parcours précédent y a déjà écrit
    // pour un autre Spark. On ne retient que celui-ci.
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.bootstrap&limit=50');
    const siennes = corps.entries.filter((e) => e.message.includes('postgres-dedie'));
    assert.equal(siennes.length, 2, 'les DEUX amorçages sont inscrits');
    assert.ok(siennes.some((e) => /rien à faire/.test(e.message)));
  });
});

test('un Spark PROTÉGÉ refuse l’amorçage, et le refus est LISIBLE', async () => {
  await parcours('amorcage-protege', async () => {
    // §35 : l'amorçage installe des paquets et redémarre des services. La
    // protection se lève par son geste distinct, jamais au passage (§6.23).
    await ouvrir('analytics');
    await page.waitForSelector('.entete-entite');
    // « analytics » est protégé ET sans cellule dans le seed : l'écran nomme
    // d'abord ce qui manque, avant même la protection.
    assert.match(await page.textContent('#titre-amorcage ~ .absence'),
                 /n’a pas encore de cellule/);
    assert.equal(await page.$('[data-amorcage="amorcer"]'), null,
      'une commande qui sera refusée à coup sûr n’est pas offerte (§1.4)');
  });
});

test('cocher le rootless amorce dans ce mode, et le journal le PORTE', async () => {
  await parcours('amorcage-rootless', async () => {
    // §42.2 : l'option est offerte, jamais imposée. On la coche depuis la
    // confirmation, là où le geste s'engage.
    //
    // Sur « boutique », et PAS sur un Spark qu'un parcours antérieur a déjà
    // amorcé : le §42.2 bis refuse de basculer un Docker en place, donc y
    // demander le rootless rendrait 409 et ce parcours n'éprouverait rien.
    // Mesuré — il passait seul et échouait dans la campagne, ce qui est la
    // signature d'un parcours qui dépend de l'état laissé par un autre.
    //
    // « boutique » est à l'arrêt dans le seed : on le démarre depuis l'écran,
    // comme un exploitant, puisque l'amorçage exige une cellule qui tourne.
    await ouvrir('boutique');
    await page.click('[data-commande="start"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('En marche'), { timeout: 20000 });
    await page.waitForSelector('#titre-amorcage');
    await page.click('[data-amorcage="amorcer"]');
    await page.waitForSelector('[data-amorcage="engager"]', { timeout: 10000 });

    // L'option ÉNONCE ses trois coûts au lieu de les vendre (§42.2).
    const confirmation = await page.textContent('.confirmation');
    assert.match(confirmation, /ports sous 1024/);
    assert.match(confirmation, /ne fonctionnent pas telles quelles/);
    assert.match(confirmation, /déjà<\/strong>|déjà/, 'la seconde couche est dite');
    assert.ok(!/plus sûr|recommandé|conseillé/i.test(confirmation),
      'aucun argument de vente ne se glisse à côté de la case');

    // Décochée par défaut : le défaut du produit est ENRACINÉ.
    assert.equal(await page.isChecked('#amorcage-rootless'), false);

    await page.check('#amorcage-rootless');
    await page.click('[data-amorcage="engager"]');
    await page.waitForSelector('.liste-amorcage', { timeout: 20000 });

    // Le mode est rendu à l'écran, en français, sur la ligne du moteur.
    const ecran = await page.textContent('#titre-amorcage ~ .liste-amorcage');
    assert.match(ecran, /rootless/);
    assert.ok(!/enracine\b/.test(ecran), 'aucun jeton brut (§14.7)');

    // §42.2 bis : le journal porte le MODE. C'est ce qu'on cherchera le jour où
    // une pile ne démarre pas, et il ne se retrouve nulle part ailleurs.
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.bootstrap&limit=20');
    const sienne = corps.entries.filter((e) => e.message.includes('boutique'));
    assert.ok(sienne.length > 0);
    assert.equal(JSON.parse(sienne[0].payload).mode, 'rootless');
    assert.match(sienne[0].message, /en rootless/);
  });
});

test('redemander l’autre mode est REFUSÉ, et le refus nomme les deux', async () => {
  await parcours('amorcage-bascule-refusee', async () => {
    // LE point du §42.2 bis. Basculer déplacerait le moteur sous un autre compte,
    // et avec lui les conteneurs, volumes et réseaux du locataire.
    //
    // Sur « boutique », que le parcours précédent vient d'amorcer en ROOTLESS :
    // on éprouve donc le refus dans le sens qui compte le plus — redemander
    // l'enraciné sur une cellule rootless, ce qui est le défaut du produit et
    // donc le clic le plus facile à faire par mégarde.
    await ouvrir('boutique');
    await page.waitForSelector('#titre-amorcage');
    await page.click('[data-amorcage="relever"]');
    await page.waitForSelector('.liste-amorcage', { timeout: 20000 });

    // Le mode est en place : l'option n'est PLUS offerte (§1.4). L'écran ne le
    // suppose pas — il le tient du relevé que le serveur vient de rendre.
    await page.click('[data-amorcage="amorcer"]');
    await page.waitForSelector('[data-amorcage="engager"]', { timeout: 10000 });
    assert.equal(await page.$('#amorcage-rootless'), null,
      'offrir un geste que le serveur refusera à coup sûr est une commande morte');
    assert.match(await page.textContent('.confirmation'),
                 /fait déjà tourner un Docker/);
    await page.click('[data-amorcage="annuler"]');

    // …et le REFUS existe bel et bien au serveur, qui est l'autorité (§10 de
    // CLAUDE.md) : l'écran n'est qu'une aide, la requête reste formable.
    const { status, corps } = await pile.ecrireSparkd(
      '/v1/sparks/boutique/bootstrap', {});
    assert.equal(status, 409, JSON.stringify(corps));
    assert.equal(corps.detail.error, 'bootstrap_mode_conflict');
    assert.equal(corps.detail.installed, 'rootless');
    assert.equal(corps.detail.requested, 'enracine');
    assert.match(corps.detail.message, /enraciné/);
    assert.match(corps.detail.message, /rootless/);
    assert.match(corps.detail.message, /vider la cellule/);
  });
});

// --- SPK-43, tranche 4 · LE DÉPANNAGE (§37.3) -------------------------------

test('un distant qui MEURT fait dire à l’écran ce qui manque, et propose la suite', async () => {
  await parcours('terminal-sshd-muet', async () => {
    // « site-vitrine » : distant qui meurt aussitôt (doublon du §37.4.2 bis),
    // et Spark en erreur dans le seed. C'est le cas du §37.2 — une cellule qui
    // tourne, mais rien qui réponde.
    await ouvrir('site-vitrine', 'terminal');
    await page.waitForSelector('#titre-terminal');
    await page.click('[data-terminal="ouvrir"]');

    // Le shell meurt de lui-même. L'écran ne doit pas s'en tenir là.
    await page.waitForFunction(
      () => document.body.innerText.includes('Le shell distant'), { timeout: 20000 });

    // §6.13 : la mesure EN COURS se voit, elle ne se confond pas avec son
    // résultat — puis le verdict la remplace.
    await page.waitForFunction(
      () => document.body.innerText.includes('Ce Spark est en erreur')
         || document.body.innerText.includes('Aucun serveur SSH ne répond'),
      { timeout: 20000 });

    const ecran = await page.textContent('.principal');
    assert.ok(!/sshd_muet|spark_en_erreur|ssh_disponible/.test(ecran),
      'aucun jeton technique brut n’atteint l’écran (§14.7)');
    assert.ok(await page.$('[role="alert"]'),
      'une panne qui ouvre un pouvoir d’exception est annoncée (§9.7)');

    // …et la commande qui y répond est là, juste à côté.
    assert.ok(await page.$('[data-terminal="depanner"]'));

    // Le diagnostic est une LECTURE : rien n'a été ouvert, rien n'a été
    // journalisé de plus que la session qui vient de mourir (§36.7).
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.rescue_exec&limit=10');
    assert.equal(corps.entries.length, 0, 'diagnostiquer n’ouvre aucun dépannage');
  });
});

test('demander le dépannage montre ce qu’il va employer, et on peut renoncer', async () => {
  await parcours('terminal-depannage-confirmation', async () => {
    // « site-vitrine » est en ERREUR dans le seed : c'est le cas que le §37.3
    // ouvre. On y va comme un exploitant, depuis la liste.
    await ouvrir('site-vitrine', 'terminal');
    await page.waitForSelector('#titre-terminal');

    // La commande EXISTE et n'est pas désactivée : l'écran ne présume pas du
    // verdict, c'est le serveur qui mesure (§14.9).
    const bouton = await page.$('[data-terminal="depanner"]');
    assert.ok(bouton, 'la commande de dépannage est offerte');
    assert.equal(await bouton.getAttribute('disabled'), null);

    await page.click('[data-terminal="depanner"]');
    await page.waitForSelector('[data-terminal="depanner-confirme"]', { timeout: 10000 });

    // §37.3 : la confirmation NOMME le pouvoir employé. Pas « confirmer ».
    const texte = await page.textContent('.confirmation');
    assert.match(texte, /exécuter un shell root dans la cellule/i);
    assert.match(texte, /site-vitrine/, 'elle nomme l’objet visé');
    assert.match(texte, /action\s+distincte/, 'et dit que l’emprunt se compte');

    // Renoncer ne doit RIEN avoir ouvert.
    await page.click('[data-terminal="depanner-annule"]');
    await page.waitForSelector('[data-terminal="depanner"]', { timeout: 10000 });
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.rescue_exec&limit=10');
    assert.equal(corps.entries.length, 0, 'une annulation n’ouvre aucun dépannage');
  });
});

test('confirmer le dépannage ouvre la session, et le journal la compte À PART', async () => {
  await parcours('terminal-depannage-ouvert', async () => {
    await ouvrir('site-vitrine', 'terminal');
    await page.waitForSelector('#titre-terminal');
    await page.click('[data-terminal="depanner"]');
    await page.waitForSelector('[data-terminal="depanner-confirme"]', { timeout: 10000 });
    // AU CLAVIER : le focus est déjà sur le point d'engagement (§14.3).
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 15000 });

    // §37.3, quatrième condition : la bannière NOMME le chemin, et elle tient.
    const bandeau = await page.textContent('.bandeau-terminal');
    assert.match(bandeau, /exécution en root dans la cellule, depuis le plan de contrôle/);
    assert.match(bandeau, /ce Spark est en erreur/, 'elle dit aussi pourquoi');
    assert.ok(!/sshd_muet|spark_en_erreur/.test(bandeau), 'aucun jeton brut à l’écran');
    assert.ok(await page.$('.badge--danger'), 'et la couleur suit le libellé');

    // §37.3, troisième condition : l'action est DISTINCTE, donc dénombrable.
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.rescue_exec&limit=10');
    assert.equal(corps.entries.length, 1, 'le dépannage se compte tout seul');
    assert.match(corps.entries[0].message,
      /exécution en root dans la cellule, depuis le plan de contrôle/);
    const charge = JSON.parse(corps.entries[0].payload);
    assert.equal(charge.path, 'rescue');
    assert.equal(charge.reason, 'spark_en_erreur');

    // …et elle ne s'est pas comptée comme une session SSH.
    const { corps: normales } = await pile.lireSparkd(
      '/v1/audit?action=spark.terminal_open&limit=50');
    assert.ok(normales.entries.every((e) => JSON.parse(e.payload).path !== 'rescue'));

    // La bannière survit à la fin du shell distant : c'est le moment où l'on
    // oublie par quel chemin on est entré.
    await page.click('[data-terminal="fermer"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Session fermée'), { timeout: 10000 });
  });
});

// --- SPK-44 · L'ONGLET DOCKER, EN LECTURE (§37.6) ---------------------------

test('l’onglet Docker liste ce qui tourne, sans offrir de geste SUR un conteneur', async () => {
  await parcours('docker-inventaire', async () => {
    // Depuis la liste, comme un exploitant. « crm-production » est en marche et
    // porte une cellule : c'est le cas nominal.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('#titre-docker', { timeout: 15000 });
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });

    const lignes = await page.$$eval('tbody tr', (l) => l.map((x) => x.textContent));
    assert.equal(lignes.length, 2, 'un conteneur en marche et un arrêté');
    assert.ok(lignes.some((l) => /helo-web-1/.test(l)));
    assert.ok(lignes.some((l) => /helo-base-1/.test(l)));

    // §14.7 : l'état est en français, jamais le jeton de Docker.
    const ecran = await page.textContent('#titre-docker ~ .table-defilante');
    assert.match(ecran, /en marche/);
    assert.match(ecran, /arrêté/);
    assert.ok(!/>running<|>exited</.test(await page.innerHTML('tbody')));

    // SPK-DS-05 : l'écran écrit d'où viennent ces mesures.
    const section = await page.textContent('.principal');
    assert.match(section, /depuis l’intérieur/);
    assert.match(section, /jamais\s+aux quotas du Spark/);

    // §1.4 : l'unité est en LECTURE. Le seul bouton offert DEMANDE une lecture
    // — le §37.6 ter exige qu'inspection et journaux soient demandés — et aucun
    // n'agit sur le conteneur : démarrer, arrêter, supprimer sont SPK-45.
    const libelles = await page.$$eval('#titre-docker ~ * button',
                                       (l) => l.map((b) => b.textContent.trim()));
    assert.ok(libelles.length > 0, 'la lecture doit pouvoir être demandée');
    for (const libelle of libelles) {
      assert.ok(!/démarrer|arrêter|redémarrer|supprimer|relancer/i.test(libelle),
                `geste interdit offert : ${libelle}`);
    }
    assert.equal(await page.$$eval('.bouton--destructif', (l) => l.length), 0);

    // §36.7 : une lecture ne se journalise pas. Le relevé passe toutes les cinq
    // secondes ; le journaliser le remplirait de bruit.
    const { corps } = await pile.lireSparkd('/v1/audit?limit=200');
    assert.ok(!JSON.stringify(corps.entries).includes('docker_read'));
  });
});

test('quitter l’onglet ARRÊTE la collecte', async () => {
  await parcours('docker-collecte-arretee', async () => {
    // §37.6 : une console qui interroge en permanence un Spark qu'on ne regarde
    // plus consomme le quota du locataire pour rien.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });

    // On compte les relevés qui partent, en écoutant les requêtes du navigateur.
    let releves = 0;
    const compter = (requete) => {
      if (requete.url().includes('/api/spark/docker')) releves += 1;
    };
    page.on('request', compter);

    // On quitte l'onglet, puis on laisse passer DEUX cadences.
    await page.click('.onglet[href$="/journal"]');
    await page.waitForSelector('.onglet[href$="/journal"][aria-current="page"]',
                               { timeout: 10000 });
    await page.waitForFunction(
      () => new Promise((r) => setTimeout(() => r(true), 11000)), { timeout: 15000 });

    page.off('request', compter);
    assert.equal(releves, 0,
      `la collecte a continué après le départ : ${releves} relevé(s)`);
  });
});

test('ouvrir un conteneur montre son identité, ses réseaux et ses journaux', async () => {
  await parcours('docker-conteneur-ouvert', async () => {
    // §29.3 : on ouvre le conteneur EN CLIQUANT dessus, jamais par une URL.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
    await page.click('button[data-conteneur="helo-web-1"]');

    await page.waitForSelector('#titre-conteneur', { timeout: 15000 });
    assert.equal(await page.textContent('#titre-conteneur'), 'helo-web-1');

    // §5.4 : une surface, un sujet. La liste a cédé la place.
    assert.equal(await page.$$eval('tbody tr', (l) => l.length), 0);

    await page.waitForSelector('pre.terminal', { timeout: 15000 });
    const ecran = await page.textContent('.principal');

    // L'identité, dite en français (§14.7), et sans code de sortie : ce
    // conteneur TOURNE, en afficher un ferait lire qu'il s'est terminé (§14.6).
    assert.match(ecran, /en marche/);
    assert.ok(!/Code de sortie/.test(ecran), 'un conteneur en marche n’en a pas');
    assert.match(ecran, /nginx:alpine/);

    // Ses réseaux et ses volumes, lus sur le Spark.
    assert.match(ecran, /helo_default/);
    assert.match(ecran, /172\.18\.0\.2/);
    assert.match(ecran, /\/var\/lib\/postgresql\/data/);

    // Les journaux, BORNÉS, et la troncature ANNONCÉE : le doublon en écrit
    // deux cents pile, soit la borne du §37.6 ter.
    const lignes = (await page.textContent('pre.terminal')).trim().split('\n');
    assert.equal(lignes.length, 200, 'la borne est tenue');
    assert.match(ecran, /200 dernières lignes/);

    // Les horodatages sont ceux du LOCATAIRE, rendus tels quels.
    assert.match(lignes[0], /^2026-08-20T18:52:\d\d\.000000000Z ligne 1$/);

    // §37.6 ter : l'exploitant doit savoir qu'il lit un texte non relu.
    assert.match(ecran, /vient du locataire/);
    assert.match(ecran, /ni caviardé/);

    // §36.7 : ces lectures ne se journalisent pas non plus.
    const { corps } = await pile.lireSparkd('/v1/audit?limit=200');
    const journal = JSON.stringify(corps.entries);
    assert.ok(!/container_read|logs_read/.test(journal));
  });
});

test('un conteneur ARRÊTÉ montre son code de sortie, et son silence se distingue', async () => {
  await parcours('docker-conteneur-arrete', async () => {
    // Le cas qu'on vient chercher quand une pile ne répond plus : pourquoi
    // s'est-elle arrêtée, et qu'a-t-elle écrit avant.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
    await page.click('button[data-conteneur="helo-base-1"]');
    await page.waitForSelector('#titre-conteneur', { timeout: 15000 });
    await page.waitForSelector('.absence, pre.terminal', { timeout: 15000 });

    const ecran = await page.textContent('.principal');
    assert.match(ecran, /Code de sortie/);
    assert.match(ecran, /137/);
    assert.match(ecran, /arrêté/);

    // §14.6 : « n'a rien écrit » et « a disparu » sont deux faits différents.
    // Ce conteneur existe et se tait ; l'écran le dit, sans alerter.
    assert.match(ecran, /n’a rien écrit/);
    assert.ok(!/a disparu/.test(ecran));
    assert.equal(await page.$$eval('[role="alert"]', (l) => l.length), 0);
  });
});

test('ouvrir un conteneur SUSPEND le relevé de la liste', async () => {
  await parcours('docker-releve-suspendu', async () => {
    // §37.6 : la liste a cédé la place ; continuer à la relever consommerait le
    // quota du locataire pour un écran que personne ne regarde.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
    await page.click('button[data-conteneur="helo-web-1"]');
    await page.waitForSelector('pre.terminal', { timeout: 15000 });

    let releves = 0;
    const compter = (requete) => {
      if (requete.url().includes('/api/spark/docker')) releves += 1;
    };
    page.on('request', compter);
    await page.waitForFunction(
      () => new Promise((r) => setTimeout(() => r(true), 11000)), { timeout: 15000 });
    page.off('request', compter);
    assert.equal(releves, 0, `la liste a continué d’être relevée : ${releves}`);

    // Et refermer la REPREND : sans cela, la liste resterait figée pour de bon.
    await page.click('button[data-docker="fermer"]');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
  });
});

test('un conteneur DISPARU pendant qu’on le regarde est dit, sans crier à la panne', async () => {
  await parcours('docker-conteneur-disparu', async () => {
    // §37.6 ter : le locataire a le droit de supprimer son conteneur pendant
    // qu'on le lit. Le doublon rend 1 à la DEUXIÈME lecture, comme le vrai
    // Docker — c'est la course, et elle s'éprouve au clavier par « Relire ».
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
    await page.click('button[data-conteneur="helo-web-1"]');
    await page.waitForSelector('pre.terminal', { timeout: 15000 });

    await page.click('button[data-docker="relire"]');
    await page.waitForFunction(
      () => !document.querySelector('pre.terminal'), { timeout: 15000 });

    const ecran = await page.textContent('.principal');
    // Le fait est DIT, et il n'est pas présenté comme un défaut de la console.
    assert.ok(!/rien écrit/.test(ecran), 'un absent n’a pas « rien écrit »');
    assert.ok(!/panne|erreur interne/i.test(ecran));
    // Et le retour à la liste reste offert : on n'est pas coincé sur un absent.
    await page.click('button[data-docker="fermer"]');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
  });
});

test('revenir sur l’onglet repart de la LISTE, jamais d’un journal figé', async () => {
  await parcours('docker-retour-liste', async () => {
    // Retrouver un texte qu'on n'a pas demandé le ferait lire comme courant.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
    await page.click('button[data-conteneur="helo-web-1"]');
    await page.waitForSelector('pre.terminal', { timeout: 15000 });

    await page.click('.onglet[href$="/journal"]');
    await page.waitForSelector('.onglet[href$="/journal"][aria-current="page"]',
                               { timeout: 10000 });
    await page.click('.onglet[href$="/docker"]');
    await page.waitForSelector('#titre-docker', { timeout: 15000 });
    assert.equal(await page.$$eval('pre.terminal', (l) => l.length), 0);
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
  });
});

// --- SPK-38 · L'ANCRE VOIT CE QUE LA CHAÎNE NE PEUT PAS VOIR ----------------
//
// CE BLOC EST LE DERNIER DU FICHIER, ET IL DOIT LE RESTER. Le parcours ci-dessous
// coupe la fin du journal DANS LA BASE de la pile — c'est l'attaque même qu'il
// éprouve, et elle n'est pas annulable. Tout parcours écrit après lui lirait un
// journal amputé et une ancre en alerte, sans que rien ne le lui dise.

/** Ouvre l'onglet Journal PAR LA NAVIGATION, comme un exploitant (§36.8.1). */
async function ouvrirJournalDeLaForge() {
  await accueil();
  await page.click('nav a[href="#/forge"]');
  await page.waitForSelector('#titre-pools', { timeout: 10000 });
  await page.click('.onglet[href="#/forge/journal"]');
  await page.waitForSelector('#titre-journal-forge', { timeout: 10000 });
}

const DD_ANCRE = '#titre-integrite ~ .definitions .def:nth-child(2) dd';
const DD_CHAINE = '#titre-integrite ~ .definitions .def:nth-child(1) dd';

/**
 * Déclenche le relevé AU CLAVIER et attend le REPEINT, pas un texte.
 *
 * Attendre un libellé particulier ferait passer le test pour une autre raison
 * que celle qu'il éprouve ; attendre que le bloc « ait quelque chose » est pire
 * encore — MESURÉ : au deuxième relevé la condition était déjà vraie avant même
 * que la requête ne parte, et le parcours relisait le verdict PRÉCÉDENT.
 *
 * On marque donc le noeud courant, et on attend qu'il ait été remplacé ET que le
 * bouton soit ressorti de son état occupé. Les deux ensemble : `verifierChaine`
 * repeint DEUX fois, et le premier repeint efface déjà la marque alors que
 * l'ancre porte encore la valeur d'avant.
 */
async function releverAuClavier() {
  await page.$eval(DD_ANCRE, (dd) => { dd.dataset.avant = 'oui'; });
  await page.focus('[data-action="verifier-chaine"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction((selecteur) => {
    const dd = document.querySelector(selecteur);
    const bouton = document.querySelector('[data-action="verifier-chaine"]');
    return !!dd && dd.dataset.avant !== 'oui' && !!bouton && !bouton.disabled;
  }, DD_ANCRE, { timeout: 15000 });
  return page.textContent(DD_ANCRE);
}

test('l’ancre SIGNALE une histoire qui ne prolonge pas la précédente', async () => {
  await parcours('journal-ancre-troncature', async () => {
    // 1. La console pose sa référence, depuis l'écran et au clavier.
    await ouvrirJournalDeLaForge();
    const pose = await releverAuClavier();
    assert.match(pose, /Première comparaison|L’histoire se prolonge|Rien de nouveau/,
      'avant l’attaque, l’ancre ne doit rien avoir à signaler');
    assert.ok(!pose.includes('raccourci') && !pose.includes('remplacé'),
      `l’ancre alerte AVANT toute altération : ${pose}`);

    // 2. Combien d'entrées la Forge porte-t-elle ? On LIT pour constater
    //    (§29.3) : la troncature doit être assez profonde pour que la longueur
    //    recule réellement sous celle que la console vient de retenir.
    const { corps: liste } = await pile.lireSparkd('/v1/audit?limit=100000');
    const chainees = liste.entries.filter((e) => e.entry_hash).length;
    assert.ok(chainees > 10,
      `le seed doit écrire assez d’entrées pour que la coupe soit franche (${chainees})`);

    // 3. L'ATTAQUE, hors du produit. On coupe la FIN du journal en base : le
    //    préfixe qui reste est une chaîne parfaitement valide, et c'est tout le
    //    problème (§36.1). Aucun geste de l'interface ne peut faire cela.
    //
    //    Le verrou de SPK-37 refuse ce `DELETE` — MESURÉ, et c'est le produit
    //    qui fonctionne. Il faut donc lever le déclencheur d'abord, puis le
    //    remettre : c'est exactement le pouvoir que l'ancre suppose à
    //    l'adversaire (§36.1 — qui peut écrire dans le fichier peut aussi
    //    recalculer la chaîne, donc a fortiori désarmer une garde locale).
    //    Le remettre en place n'est pas une politesse : sans lui, la suite du
    //    parcours n'éprouverait plus la Forge que le produit livre.
    await pile.alterer(
      'DROP TRIGGER audit_log_immuable_delete;\n'
      + 'DELETE FROM audit_log WHERE id > '
      + '(SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 2);\n'
      + 'CREATE TRIGGER audit_log_immuable_delete\n'
      + 'BEFORE DELETE ON audit_log\n'
      + 'BEGIN\n'
      + "    SELECT RAISE(ABORT, 'audit_log est en ecriture seule : DELETE refuse');\n"
      + 'END;');

    // Le verrou est bien REVENU : la suite de ce parcours doit s'exécuter contre
    // la Forge que le produit livre, pas contre une Forge désarmée.
    await assert.rejects(
      () => pile.alterer('DELETE FROM audit_log WHERE id = '
        + '(SELECT id FROM audit_log ORDER BY id LIMIT 1);'),
      /DELETE refuse/, 'le déclencheur d’immuabilité doit avoir été rétabli');

    // 4. Le même geste, au même endroit, par le même chemin.
    const verdict = await releverAuClavier();

    // La chaîne, elle, ne voit RIEN : elle est intacte, et elle le dit.
    const chaine = await page.textContent(DD_CHAINE);
    assert.match(chaine, /Chaîne intacte/,
      'une chaîne coupée à la fin reste valide — c’est précisément le point');

    // L'ancre, elle, le voit.
    assert.match(verdict, /Le journal a raccourci/);

    // Le verdict CHIFFRE l'écart au lieu de l'affirmer, et c'est le recul lui-même
    // qui est la preuve. On ne fige pas les deux nombres : le relevé s'inscrit au
    // journal avant de lire la tête, donc la Forge en annonce une de plus que ce
    // qui reste. Ce qui doit être vrai, c'est le RECUL.
    const [, retenu, annonce] = verdict.match(
      /avait retenu (\d+) entrée\(s\)[\s\S]*?annonce (\d+)/) ?? [];
    assert.ok(retenu && annonce, `l’écart n’est pas chiffré à l’écran : ${verdict}`);
    assert.ok(Number(retenu) > 10,
      `la console doit avoir retenu une histoire consistante : ${retenu}`);
    assert.ok(Number(annonce) < Number(retenu),
      `la longueur doit avoir RECULÉ : ${annonce} n’est pas inférieur à ${retenu}`);

    // …et il est ANNONCÉ, comme l'est une rupture de chaîne (DESIGN_SYSTEM.md
    // §9.7, §14.8) : la structure porte la nature, pas la seule couleur.
    const forme = await page.$eval(DD_ANCRE, (dd) => ({
      alerte: !!dd.querySelector('[role="alert"]'),
      danger: !!dd.querySelector('.badge--danger'),
    }));
    assert.equal(forme.alerte, true, 'l’alerte d’ancre est une région annoncée');
    assert.equal(forme.danger, true);

    // 5. Le point que le §36.9.6 tranche : l'ancre n'est PAS écrasée par une
    //    alerte. Un second relevé alerte encore — sinon le signal s'effacerait
    //    avec la preuve, et tout paraîtrait normal au relevé suivant.
    const encore = await releverAuClavier();
    assert.match(encore, /Le journal a raccourci/,
      'un relevé de plus ne doit pas absoudre la Forge');
  });
});
