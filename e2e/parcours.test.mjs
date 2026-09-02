/**
 * Parcours E2E contre la pile réelle.
 *
 * @verifies docs/BACKLOG.md#SPK-24, docs/BACKLOG.md#SPK-70 ·
 *           docs/DAT.md §29 (éprouver le produit par où
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
import { monterCanalNotify } from './notify-doublon.mjs';
// Le motif du SERVEUR, employé tel quel : une seconde heuristique écrite
// ici dériverait de celle qui est réellement appliquée (§22.4).
import { SECRET_HINT } from '../apps/webui/host/inventory.js';

const ECHECS = new URL('./captures/echecs/', import.meta.url).pathname;

let pile;
let dns;
let canal;
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
  // SPK-62 · §47.3 : la pile des parcours a un canal hors bande, comme une Forge
  // configurée. Les autres parcours y envoient donc leurs gestes sensibles — et
  // c'est voulu : si le canal cassait un geste, TOUTE la série le dirait.
  canal = await monterCanalNotify();
  pile = await monterPile({ dns, notify: canal.baseUrl });
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
  await canal?.demonter();
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

/** Déplie le widget d'inventaire (SPK-75), par sa pastille. */
async function ouvrirWidget(cible = page) {
  const pastille = cible.locator('[data-widget="basculer"]');
  if ((await pastille.getAttribute('aria-expanded')) !== 'true') await pastille.click();
  await cible.waitForSelector('.widget-inv__contenu', { timeout: 10000 });
}

/** Replie le widget. Déplié il RECOUVRE le contenu, comme toute surface qu'on
 *  vient d'ouvrir : on la referme avant d'agir dessous, comme un exploitant. */
async function replierWidget(cible = page) {
  const pastille = cible.locator('[data-widget="basculer"]');
  if ((await pastille.getAttribute('aria-expanded')) === 'true') await pastille.click();
  await cible.waitForFunction(
    () => !document.querySelector('.widget-inv__contenu'), null, { timeout: 10000 });
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
    // RÉVISÉE le 2026-08-21, et il faut dire pourquoi. Ce contrôle cherchait
    // « key » dans le nom des champs. SPK-40 en ajoute un — `signingKey`, un
    // chemin vers une clé PUBLIQUE (§36.10.8) —, et l'heuristique le prenait
    // pour un secret. C'est l'heuristique qui était trop large, pas le champ qui
    // est fautif : le motif employé est désormais CELUI DU SERVEUR
    // (`SECRET_HINT`, `apps/webui/host/inventory.js`), et non une seconde règle
    // écrite à côté qui dériverait de la première.
    assert.ok(!champs.some((n) => SECRET_HINT.test(n)),
      'aucun champ de secret n’est même proposé');

    // …et le champ ajouté ne devient pas une porte : y COLLER une clé privée est
    // refusé, comme n'importe quel autre secret. C'est ce qui rend la révision
    // ci-dessus honnête — on n'a pas retiré un rempart, on l'a déplacé sur ce
    // que le serveur applique réellement.
    const collee = await fetch(`${pile.base}/api/servers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fuite', kind: 'local', port: 9876,
                             signingKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }),
    });
    assert.equal(collee.status, 422);
    assert.match((await collee.json()).message, /ressemble à un secret/);

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

// --- SPK-57 · REDIMENSIONNER UN SPARK (§49) --------------------------------

test('redimensionner un Spark depuis l’écran, sans le détruire', async () => {
  await parcours('quotas-redimensionner', async () => {
    // Le geste que le produit ne savait pas faire : jusqu'ici, changer un quota
    // imposait de supprimer et recréer — on perdait la cellule, ses images
    // Docker et ses volumes.
    //
    // Le parcours rétrécit le DISQUE d'un Spark ARRÊTÉ, et les deux termes sont
    // MESURÉS, pas choisis au hasard :
    //
    // - agrandir est légitimement refusé ici : il ne reste que ~1,36 Gio libres
    //   sur la pile du harnais ;
    // - rétrécir la MÉMOIRE d'un Spark EN MARCHE est refusé aussi, et c'est le
    //   produit qui a raison : le §49.3 interdit de descendre sous ce que la
    //   cellule emploie, sous peine de livrer ses processus à l'OOM killer.
    //
    // Un Spark arrêté n'occupe pas de mémoire — c'est la dissymétrie du §49.3 —
    // et rendre du disque ne peut jamais manquer de place (§49.1). Rétrécir de
    // 1 Gio reste très au-dessus de ce que la cellule occupe, donc le refus de
    // rétrécissement ne se déclenche pas : il est éprouvé par le parcours
    // « le disque OCCUPÉ refuse d'être rétréci », plus bas. Le geste est en
    // outre réversible, donc le parcours ne laisse aucune trace aux
    // suivants (§29.2).
    await ouvrir('boutique');
    await page.waitForSelector('#titre-ressources', { timeout: 10000 });

    const avant = await pile.lireSparkd('/v1/sparks/boutique');
    const cible = avant.corps.storage_bytes - 1024 ** 3;

    // AU CLAVIER, depuis la commande de la section (§6.27).
    await page.focus('[data-ouvre="quotas"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #quota-storage', { timeout: 10000 });

    // La modale s'ouvre PRÉ-REMPLIE : faire ressaisir de mémoire ce qui est déjà
    // à l'écran invite à se tromper d'ordre de grandeur.
    assert.equal(await page.inputValue('#quota-storage'),
                 String(Math.round(avant.corps.storage_bytes / 1024 ** 3)));

    // §49.4, RÉVISÉ le 2026-08-21 : la prise à chaud a été MESURÉE sur la Forge
    // de validation — la cellule voit le nouveau disque sans redémarrer. L'écran
    // ne promet donc plus un redémarrage qui n'a pas lieu.
    assert.match(await page.innerText('dialog.modale[open]'), /pris en compte immédiatement/);

    await page.fill('#quota-storage', String(Math.round(cible / 1024 ** 3)));
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 15000 });

    // Effet BACKEND (§29.3 : on lit pour constater, jamais pour agir).
    const apres = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(apres.corps.storage_bytes, cible);
    // Et le Spark existe TOUJOURS : c'est tout l'intérêt du geste.
    assert.equal(apres.corps.name, 'boutique');

    // On remet la pile dans l'état du seed.
    await page.focus('[data-ouvre="quotas"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #quota-storage', { timeout: 10000 });
    await page.fill('#quota-storage',
                    String(Math.round(avant.corps.storage_bytes / 1024 ** 3)));
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 15000 });
    const rendu = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(rendu.corps.storage_bytes, avant.corps.storage_bytes);
  });
});

test('changer le MODE CPU depuis l’écran, au clavier', async () => {
  await parcours('quotas-mode-cpu', async () => {
    // §49.2 : le mode CPU est un champ redimensionnable. Le geste se fait sur un
    // Spark ARRÊTÉ — donc sans mémoire relevée, ce qui écarte le refus du
    // §49.3 —, et il est réversible : le parcours rend la pile à l'état du
    // seed (§29.2).
    await ouvrir('boutique');
    await page.waitForSelector('#titre-ressources', { timeout: 10000 });

    const avant = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(avant.corps.cpu_mode, 'shared', 'le seed le pose partagé');

    await page.focus('[data-ouvre="quotas"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #quota-cpu_mode', { timeout: 10000 });

    // §49.4 : le mode annonce son redémarrage AVANT qu'on agisse.
    assert.match(await page.innerText('dialog.modale[open]'), /pris en compte immédiatement/);
    // Le mode courant est PRÉ-SÉLECTIONNÉ.
    assert.equal(await page.inputValue('#quota-cpu_mode'), 'shared');
    // …et le champ qui lui correspond est là, les autres non (§1.4).
    assert.ok(await page.$('#quota-cpu_reservation'));
    assert.equal(await page.$('#quota-cpu_max'), null);
    // Amendement du responsable, 2026-09-02 (docs/DESIGN_SYSTEM_APP.md
    // SPK-DS-07) : la grille du CPU est le QUART de CPU, borne basse comprise.
    // La réservation du seed vaut 1 CPU, donc elle tombe sur un cran et le
    // réglage reste un curseur.
    assert.deepEqual(
      await page.locator('#quota-cpu_reservation')
        .evaluate((el) => ({ type: el.type, min: el.min, step: el.step })),
      { type: 'range', min: '0.25', step: '0.25' });

    // Basculer en « plafonné » CHANGE les champs offerts.
    await page.selectOption('#quota-cpu_mode', 'capped');
    await page.waitForSelector('dialog.modale[open] #quota-cpu_max', { timeout: 10000 });
    assert.equal(await page.$('#quota-cpu_reservation'), null);

    await page.fill('#quota-cpu_max', '1');
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 15000 });

    // Effet BACKEND (§29.3 : on lit pour constater).
    const apres = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(apres.corps.cpu_mode, 'capped');
    assert.equal(apres.corps.cpu_max, 1);
    // §49.2 : les réglages de l'ANCIEN mode ne survivent pas — une réservation
    // sur un Spark plafonné serait une valeur que rien n'emploie.
    assert.equal(apres.corps.cpu_reservation, null);

    // On rend la pile à l'état du seed.
    await page.focus('[data-ouvre="quotas"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #quota-cpu_mode', { timeout: 10000 });
    await page.selectOption('#quota-cpu_mode', 'shared');
    await page.waitForSelector('dialog.modale[open] #quota-cpu_reservation', { timeout: 10000 });
    await page.fill('#quota-cpu_reservation', String(avant.corps.cpu_reservation));
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 15000 });
    const rendu = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(rendu.corps.cpu_mode, 'shared');
    assert.equal(rendu.corps.cpu_reservation, avant.corps.cpu_reservation);
  });
});

test('un quota REFUSÉ reste dans la modale, sans effacer la saisie', async () => {
  await parcours('quotas-refus', async () => {
    // §6.27 : une modale qui se refermerait sur un refus ferait perdre le
    // travail ET cacherait la raison.
    await ouvrir('crm-production');
    await page.waitForSelector('#titre-ressources', { timeout: 10000 });
    await page.click('[data-ouvre="quotas"]');
    await page.waitForSelector('dialog.modale[open] #quota-memory', { timeout: 10000 });

    await page.fill('#quota-memory', '900000');
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 15000 });

    const refus = await page.textContent('dialog.modale[open] .refus');
    assert.match(refus, /Capacité insuffisante/);
    assert.match(refus, /mémoire|memory/, 'la ressource manquante est NOMMÉE');
    // La saisie survit (§25.2) : on corrige, on ne recommence pas.
    assert.equal(await page.inputValue('#quota-memory'), '900000');

    // Rien n'a bougé côté Forge : un refus ne laisse aucune trace.
    const { corps } = await pile.lireSparkd('/v1/sparks/crm-production');
    assert.notEqual(corps.memory_reservation_bytes, 900000 * 1024 ** 3);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 10000 });
  });
});

test('le disque OCCUPÉ refuse d’être rétréci, et le dit autrement', async () => {
  await parcours('quotas-disque-occupe', async () => {
    // §49.3 : les DEUX refus arrivent par le même code HTTP et la même modale.
    // Ce parcours prouve qu'ils ne DISENT pas la même chose — l'admission
    // envoie libérer de la place sur la Forge, celui-ci envoie vider la cellule.
    // Les confondre ferait chercher au mauvais endroit.
    //
    // La valeur saisie est ZÉRO, et ce n'est pas une provocation : la cellule du
    // harnais occupe moins d'un gibioctet, et le champ se saisit au gibioctet.
    // Sur une Forge réelle, une cellule occupe plusieurs gibioctets et le refus
    // tombe à des valeurs ordinaires.
    await ouvrir('boutique');
    await page.waitForSelector('#titre-ressources', { timeout: 10000 });

    const avant = await pile.lireSparkd('/v1/sparks/boutique');

    await page.focus('[data-ouvre="quotas"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #quota-storage', { timeout: 10000 });

    await page.fill('#quota-storage', '0');
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 15000 });

    const refus = await page.textContent('dialog.modale[open] .refus');
    // Le message porte l'occupation MESURÉE, et dit quoi faire : vider la
    // cellule. Pas « capacité insuffisante », qui enverrait ailleurs.
    assert.match(refus, /occupe actuellement/);
    assert.match(refus, /octets de disque/);
    assert.doesNotMatch(refus, /Capacité insuffisante/);

    // Rien n'a bougé côté Forge : le disque du Spark est intact.
    const apres = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(apres.corps.storage_bytes, avant.corps.storage_bytes);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 10000 });
  });
});

// --- SPK-58 / SPK-64 · L'ENVIRONNEMENT D'UN SPARK (§43) -------------------

test('l’environnement se lit avec l’ORIGINE de chaque valeur', async () => {
  await parcours('env-origines', async () => {
    // §43.9.4 : c'est l'information la plus difficile à reconstituer. Sans elle,
    // on lit une valeur sans pouvoir dire pourquoi elle est celle-là — et on va
    // la chercher au mauvais endroit.
    //
    // Le seed pose les trois origines sur « crm-production » (§28.5).
    await ouvrir('crm-production', 'environnement');
    await page.waitForSelector('#titre-env-forge', { timeout: 10000 });

    const ecran = await page.innerText('body');
    assert.match(ecran, /Cochée au catalogue/);
    assert.match(ecran, /Masque une entrée cochée/);
    assert.match(ecran, /Propre à ce Spark/);

    // La surcharge porte bien la valeur DU SPARK, pas celle de la Forge.
    const ligne = await page.innerText(
      'tr:has(th:text-is("SMTP_HOST"))');
    assert.match(ligne, /relais\.crm\.example/);
    assert.doesNotMatch(ligne, /relais\.interne\.example/);
  });
});

test('la valeur d’un SECRET ne s’affiche NULLE PART à l’écran', async () => {
  await parcours('env-secret', async () => {
    // La Definition of Done de l'unité, éprouvée depuis le parcours canonique :
    // on CHERCHE la valeur seedée dans tout le texte rendu, pas seulement là où
    // on s'attend à ne pas la trouver.
    await ouvrir('crm-production', 'environnement');
    await page.waitForSelector('#titre-env-forge', { timeout: 10000 });

    const ecran = await page.innerText('body');
    assert.doesNotMatch(ecran, /mot-de-passe-de-demonstration/);
    assert.doesNotMatch(ecran, /postgres:\/\//);
    // Le NOM et une empreinte, eux, sont là : c'est ce qui permet de comparer
    // deux Sparks sans rien révéler (§43.3).
    assert.match(ecran, /SMTP_PASSWORD/);
    assert.match(ecran, /DATABASE_URL/);
  });
});

test('poser une variable AU CLAVIER, et la retirer', async () => {
  await parcours('env-poser', async () => {
    // Le geste complet depuis le parcours canonique, et il est RÉVERSIBLE : le
    // parcours rend la pile à l'état du seed (§29.2).
    await ouvrir('boutique', 'environnement');
    await page.waitForSelector('#titre-env-spark', { timeout: 10000 });

    await page.focus('[data-ouvre-env="spark"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #env-nom-spark', { timeout: 10000 });

    // §43.7 : l'écran annonce AVANT le geste que rien ne redémarre.
    assert.match(await page.innerText('dialog.modale[open]'), /ne redémarre rien/);

    await page.fill('#env-nom-spark', 'PARCOURS_E2E');
    await page.fill('#env-valeur-spark', 'valeur-du-parcours');
    await page.click('dialog.modale[open] [data-engage="env-spark"]');
    // La modale se ferme, PUIS l'écran est relu (§1.3). On attend la ligne, pas
    // la fermeture : une première version assertait entre les deux, pendant
    // « Chargement du Spark… », et lisait un écran qui n'était pas encore là.
    await page.waitForFunction(
      () => document.body.innerText.includes('PARCOURS_E2E'), { timeout: 15000 });

    // Effet BACKEND (§29.3 : on lit pour constater, jamais pour agir).
    const apres = await pile.lireSparkd('/v1/sparks/boutique/env');
    const posee = apres.corps.env.find((e) => e.name === 'PARCOURS_E2E');
    assert.equal(posee?.value, 'valeur-du-parcours');
    assert.equal(posee?.origin, 'spark', 'elle est PROPRE au Spark, pas cochée au catalogue');

    // On rend la pile à l'état du seed.
    await page.click('[data-env-retire="PARCOURS_E2E"]');
    await page.waitForFunction(
      () => !document.body.innerText.includes('PARCOURS_E2E'), { timeout: 15000 });
    const rendu = await pile.lireSparkd('/v1/sparks/boutique/env');
    assert.equal(rendu.corps.env.find((e) => e.name === 'PARCOURS_E2E'), undefined);
  });
});

test('un nom REFUSÉ reste dans la modale, et « Échap » la ferme', async () => {
  await parcours('env-refus', async () => {
    // §6.27 : une modale qui se refermerait sur un refus ferait perdre le
    // travail ET cacherait la raison. Et « Échap » DOIT la fermer — ce parcours
    // a trouvé le défaut inverse : `onFermer` oubliait l'état de la facette,
    // donc la repeinte rouvrait aussitôt la modale que `close()` venait de
    // fermer, et « Échap » paraissait sans effet.
    await ouvrir('boutique', 'environnement');
    await page.waitForSelector('#titre-env-spark', { timeout: 10000 });
    await page.click('[data-ouvre-env="spark"]');
    await page.waitForSelector('dialog.modale[open] #env-nom-spark', { timeout: 10000 });

    await page.fill('#env-nom-spark', 'AVEC-TIRET');
    await page.fill('#env-valeur-spark', 'x');
    await page.click('dialog.modale[open] [data-engage="env-spark"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 15000 });

    const refus = await page.textContent('dialog.modale[open] .refus');
    // Le refus NOMME ce qui ne va pas, et dit la règle plutôt que « invalide ».
    assert.match(refus, /AVEC-TIRET/);
    assert.match(refus, /souligné/);
    // La saisie survit : on corrige, on ne recommence pas.
    assert.equal(await page.inputValue('#env-nom-spark'), 'AVEC-TIRET');

    // Rien n'a bougé côté Forge : un refus ne laisse aucune trace.
    const { corps } = await pile.lireSparkd('/v1/sparks/boutique/env');
    assert.equal(corps.env.find((e) => e.name === 'AVEC-TIRET'), undefined);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('dialog.modale[open]'), { timeout: 10000 });
  });
});

test('le catalogue ne descend qu’après une case cochée, puis le décochage le retire', async () => {
  await parcours('env-selection', async () => {
    // Le catalogue s'atteint par la navigation de la Forge, jamais par une URL
    // profonde ou un appel d'API. Ajouter ici n'est PAS distribuer : c'est la
    // propriété de sécurité de SPK-64 que le parcours va constater.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/environnement"]');
    await page.waitForSelector('#titre-catalogue-forge', { timeout: 10000 });

    await page.focus('[data-ouvre="catalogue-env"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.modale[open] #catalogue-env-nom', { timeout: 10000 });
    await page.fill('#catalogue-env-nom', 'PARCOURS_SELECTION');
    await page.fill('#catalogue-env-valeur', 'choisi-explicitement');
    await page.click('dialog.modale[open] [data-engage="catalogue-env"]');
    // Une entrée nouvelle n'a encore aucun destinataire : même si la Forge
    // contient un Spark protégé, elle s'ajoute sans confirmation ni effet.
    await page.waitForFunction(
      () => document.querySelector('[data-retire-catalogue="PARCOURS_SELECTION"]'),
      { timeout: 15000 });
    assert.match(await page.innerText('body'), /Ne descend nulle part/);

    await ouvrir('boutique', 'environnement');
    const caseSelection = '[data-descend="PARCOURS_SELECTION"]';
    await page.waitForSelector(caseSelection, { timeout: 15000 });
    assert.equal(await page.isChecked(caseSelection), false,
      'une entrée nouvelle ne change aucun Spark tant qu’elle n’est pas cochée');
    let etatBackend = await pile.lireSparkd('/v1/sparks/boutique/env');
    assert.equal(etatBackend.corps.env.some((e) => e.name === 'PARCOURS_SELECTION'), false);

    await page.click(caseSelection);
    await page.waitForFunction(
      () => document.body.innerText.includes('Cochée au catalogue'), { timeout: 15000 });
    etatBackend = await pile.lireSparkd('/v1/sparks/boutique/env');
    assert.equal(etatBackend.corps.env.find((e) => e.name === 'PARCOURS_SELECTION')?.origin,
      'forge', 'la Forge confirme ce que la case a sélectionné');

    await page.click(caseSelection);
    await page.waitForFunction(
      () => !document.body.innerText.includes('PARCOURS_SELECTION'), { timeout: 15000 });
    etatBackend = await pile.lireSparkd('/v1/sparks/boutique/env');
    assert.equal(etatBackend.corps.env.some((e) => e.name === 'PARCOURS_SELECTION'), false,
      'décocher retire réellement la valeur du jeu résolu');

    // On retire ensuite l'entrée du catalogue par son propre écran : la pile
    // retrouve exactement le seed pour les parcours suivants.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/environnement"]');
    await page.waitForSelector('[data-retire-catalogue="PARCOURS_SELECTION"]', { timeout: 10000 });
    await page.click('[data-retire-catalogue="PARCOURS_SELECTION"]');
    await page.waitForFunction(
      () => !document.body.innerText.includes('PARCOURS_SELECTION'), { timeout: 15000 });
  });
});

// --- SPK-62 · L'ALERTE HORS BANDE (§47) ------------------------------------

test('un geste sensible envoie une alerte hors bande, un geste ordinaire non', async () => {
  await parcours('notify-alerte', async () => {
    // Le geste éprouvé est la LEVÉE DE PROTECTION, et le choix n'est pas
    // indifférent : le §47.2 la range en tête — c'est le geste qui rend tous les
    // autres possibles — et elle se REMET, là où une suppression ne se remet
    // pas. MESURÉ le 2026-08-21 : une première version supprimait
    // « site-vitrine », et les parcours du terminal, plus bas dans ce fichier,
    // tombaient trente secondes durant sur un Spark disparu. Un parcours qui
    // laisse une trace rend le verdict des suivants dépendant de l'ordre (§29.2).
    canal.oublier();

    // §47.2 : DÉMARRER ne détruit rien et ne donne aucun accès. Le geste est
    // réel, et l'état est remis juste après.
    await ouvrir('boutique');
    await page.click('[data-commande="start"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="stop"]') !== null,
      { timeout: 15000 });
    await canal.attendre(1, { tentatives: 8 });
    assert.deepEqual(canal.recus, [], 'aucune alerte pour un geste qui construit');
    await page.click('[data-commande="stop"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="start"]') !== null,
      { timeout: 15000 });

    // LEVER la protection d'« analytics », protégé par le seed.
    canal.oublier();
    await ouvrir('analytics');
    await page.waitForSelector('#titre-protection', { timeout: 10000 });
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', MOT_DE_PASSE);
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Désarmée'), { timeout: 15000 });

    const recus = await canal.attendre(1);
    assert.ok(recus.length >= 1, 'la levée de protection a produit une alerte');
    const vu = recus[0];
    assert.equal(vu.action, 'spark.unprotect');
    assert.equal(vu.result, 'ok');
    assert.equal(vu.actor_class, 'human');
    assert.equal(vu.actor, 'console/local',
      'l’alerte nomme qui a agi, tel que le journal l’inscrit');
    assert.equal(vu.version, 'spark-notify-v1');
    assert.equal(vu.target_type, 'spark');
    assert.ok(vu.target_id, 'la cible est désignée');
    assert.match(vu.message, /analytics/,
      'elle NOMME l’objet : « une protection a été levée » serait inexploitable');
    // §47.4 : le payload n'y est PAS. Un champ qu'on n'envoie pas ne fuit pas,
    // et le mot de passe de protection vit précisément là.
    assert.ok(!('payload' in vu));
    assert.ok(!JSON.stringify(vu).includes(MOT_DE_PASSE),
      'le mot de passe de protection ne sort PAS par le canal');

    // …et l'écran de la Forge le DIT (§47.6), atteint par la navigation.
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-notify', { timeout: 10000 });
    const dit = await page.innerText('#titre-notify ~ *');
    assert.match(dit, /Toutes les alertes sont parties/);

    // On REMET la pile dans l'état du seed : « analytics » y est protégé, et le
    // laisser ouvert ferait dépendre du hasard les parcours qui éprouvent un
    // refus de Spark protégé.
    await ouvrir('analytics');
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot');
    await page.fill('#protection-mot', MOT_DE_PASSE);
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Armée'), { timeout: 15000 });
    assert.equal((await pile.lireSparkd('/v1/sparks/analytics/protection'))
      .corps.protected, true, 'la pile est rendue dans l’état du seed');
  });
});

// --- SPK-40 · LA CHAÎNE DE SIGNATURE, DE BOUT EN BOUT (§36.10.9) -----------

test('un geste signé traverse la chaîne : la console signe, la Forge vérifie, le journal le porte', async () => {
  await parcours('signature-chaine', async () => {
    // Ce que ce parcours ajoute aux preuves unitaires : la JONCTION. Les deux
    // moitiés étaient prouvées séparément — la console produit une signature,
    // la Forge sait en vérifier une —, mais rien ne montrait qu'elles se
    // parlent. Ici la clé est réelle, `ssh-keygen` est réel des deux côtés, et
    // le geste part d'un clic.
    await ouvrir('crm-production');
    await page.click('[data-commande="stop"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="start"]') !== null,
      { timeout: 15000 });

    // Ce que la FORGE a retenu (§29.3 : on lit pour constater, jamais pour agir).
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.stop&limit=10');
    const geste = corps.entries[0];
    assert.ok(geste, 'l’arrêt a laissé une trace');
    assert.equal(geste.actor, 'console/local',
      'la signature a été vérifiée contre l’identité que le journal inscrit');
    assert.equal(geste.signed, true,
      'la Forge a VÉRIFIÉ cette signature : sans quoi elle aurait refusé en 422');

    // …et l'exploitant le lit à l'écran, par la navigation (§36.10.9).
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/journal"]');
    await page.waitForSelector('#titre-journal-forge', { timeout: 10000 });

    const colonnes = await page.$$eval('thead th', (l) => l.map((c) => c.textContent.trim()));
    assert.ok(colonnes.includes('Signature'),
      'la colonne existe : une cellule sans en-tête laisserait deviner');

    const lignes = await page.$$eval('tbody tr', (l) => l.map((r) => ({
      action: r.children[2]?.textContent.trim(),
      auteur: r.children[3]?.textContent.trim(),
      signature: r.children[4]?.textContent.trim(),
    })));

    const arret = lignes.find((r) => r.action === 'spark.stop');
    assert.ok(arret, 'l’arrêt figure au journal');
    assert.equal(arret.signature, 'signée');

    // Les TROIS situations du §36.10.9 se lisent sur le même écran, et ne se
    // confondent pas — c'est là tout l'intérêt de les nommer.
    const automatique = lignes.find((r) => r.auteur === 'automatique');
    assert.ok(automatique, 'le seed produit des événements du runtime');
    assert.equal(automatique.signature, 'sans objet',
      'personne n’a demandé cet événement : il n’y a rien à signer');

    const nue = lignes.find((r) => r.auteur !== 'automatique' && r.signature === 'non signée');
    assert.ok(nue, 'le seed produit des gestes arrivés sans signature');

    // La page ne prétend plus que rien n’est signé : c’était vrai avant SPK-40.
    const texte = await page.innerText('body');
    assert.ok(!texte.includes('Aucune entrée n’est signée'));

    // On remet la pile dans l'état du seed.
    await ouvrir('crm-production');
    await page.click('[data-commande="start"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="stop"]') !== null,
      { timeout: 15000 });
  });
});

test('un geste que la console n’a PAS pu signer part quand même, et l’écran le DIT', async () => {
  await parcours('signature-echec', async () => {
    // §36.10.1 : refuser d'agir faute de signature ferait de ce mécanisme un
    // contrôle d'accès. §36.10.8 : l'échec est dit, jamais tu. Les deux se
    // vérifient d'un seul geste.
    await accueil();
    assert.equal(await page.$('.entete__signature .avertissement'), null,
      'rien n’est dit tant que rien n’a échoué');

    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('[data-action="relever"]');

    await page.waitForSelector('.entete__signature .avertissement', { timeout: 15000 });
    const dit = await page.innerText('.entete__signature .avertissement');
    assert.match(dit, /Geste non signé/);
    assert.match(dit, /a bien eu lieu/, 'le geste a eu lieu : ne pas le refaire');
    assert.match(dit, /ssh-add/, 'l’avertissement dit quoi FAIRE');
    // §14.7 : le message d'OpenSSH nomme un fichier qu'on n'a pas demandé, et
    // le jeton technique n'atteint pas l'écran.
    assert.ok(!/No such file/.test(dit));
    assert.ok(!/agent_muet/.test(dit));

    // §25.1 : le rouge est réservé au REFUS du serveur. Ici la Forge a accepté.
    const classes = await page.getAttribute('.entete__signature .avertissement', 'class');
    assert.ok(!classes.includes('refus'));
    assert.ok(!classes.includes('danger'));
    // §9.7 : le changement est annoncé, sans être une erreur.
    assert.equal(await page.getAttribute('.entete__signature .avertissement', 'role'),
                 'status');

    // Le relevé a bien EU LIEU malgré l'absence de signature.
    const { corps } = await pile.lireSparkd('/v1/audit?action=host.sync&limit=5');
    assert.ok(corps.entries.length > 0, 'le geste est passé, non signé');

    // …et l'avertissement s'EFFACE de lui-même dès qu'un geste repart signé :
    // un avertissement qui survivrait à sa cause mentirait dans l'autre sens.
    await page.click('nav a[href="#/sparks"]');
    await page.waitForSelector('tbody a', { timeout: 10000 });
    await page.click('tbody a:has-text("crm-production")');
    await page.waitForSelector('.entete-entite', { timeout: 10000 });
    assert.ok(await page.$('.entete__signature .avertissement'),
      'changer d’écran n’efface pas la cause, donc n’efface pas l’avertissement');

    await page.click('[data-commande="stop"]');
    await page.waitForFunction(
      () => document.querySelector('.entete__signature .avertissement') === null,
      { timeout: 15000 });

    await page.click('[data-commande="start"]');
    await page.waitForFunction(
      () => document.querySelector('[data-commande="stop"]') !== null,
      { timeout: 15000 });
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

// --- SPK-74 · l'identité que le Spark PRÉSENTE (docs/DAT.md §17.5) ----------

test('l’identité se crée d’un bouton, et sa clé publique se copie au presse-papier', async () => {
  await parcours('identite-creation', async () => {
    // §29.3 : on y va à la souris, jamais par une URL profonde.
    await ouvrir('crm-production', 'cles');
    await page.waitForSelector('#titre-cles', { timeout: 10000 });

    // D'ABORD absente, et l'écran le dit sans le confondre avec « illisible ».
    await page.waitForSelector('[data-identite-creer]', { timeout: 20000 });
    const avant = await page.textContent('section.identite');
    assert.match(avant, /Aucune identité/);
    assert.ok(!/illisible/.test(avant), '« absente » n’est pas « illisible » (§14.6)');

    await page.click('[data-identite-creer]');
    await page.waitForSelector('.bloc-cle', { timeout: 20000 });

    const cle = (await page.textContent('.bloc-cle')).trim();
    assert.match(cle, /^ssh-ed25519 /, 'la clé publique est affichée en entier');
    assert.ok(!/PRIVATE KEY/i.test(await page.content()),
      'la clé privée n’atteint JAMAIS l’écran (§17.2)');

    // L'EFFET est constaté sur `sparkd`, jamais supposé depuis l'écran.
    const { corps } = await pile.lireSparkd('/v1/sparks/crm-production/identity');
    assert.equal(corps.state, 'presente');
    assert.equal(corps.public_key, cle, 'l’écran montre ce que la CELLULE porte');
    assert.match(corps.comment, /^spark:crm-production$/);

    // La copie au presse-papier, par le bouton, et vérifiée dans le presse-papier.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('[data-identite-copie]');
    await page.waitForFunction(
      () => document.body.innerText.includes('copiée dans le presse-papier'),
      { timeout: 10000 });
    const colle = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(colle, cle, 'c’est bien la clé publique qui est dans le presse-papier');
  });
});

test('remplacer une identité exige la FRAPPE DU NOM, et change réellement la clé', async () => {
  await parcours('identite-remplacement', async () => {
    await ouvrir('crm-production', 'cles');
    await page.waitForSelector('.bloc-cle', { timeout: 20000 });
    const avant = (await page.textContent('.bloc-cle')).trim();

    await page.click('[data-identite-remplacer]');
    await page.waitForSelector('[data-frappe-identite]', { timeout: 10000 });

    // §9.9 : le bouton est PRÉSENT et désactivé, pas absent — et l'écran dit ce
    // qui casse avant le geste.
    assert.equal(await page.isDisabled('[data-identite-remplace]'), true);
    const consequence = await page.textContent('.confirmation__consequence');
    assert.match(consequence, /cesse d’être valide/);

    // Un nom approchant ne suffit pas : la comparaison est EXACTE.
    await page.fill('[data-frappe-identite]', 'crm-production ');
    assert.equal(await page.isDisabled('[data-identite-remplace]'), true);

    await page.fill('[data-frappe-identite]', 'crm-production');
    await page.waitForFunction(
      () => !document.querySelector('[data-identite-remplace]').disabled,
      { timeout: 10000 });
    await page.click('[data-identite-remplace]');

    await page.waitForFunction(
      (ancienne) => {
        const bloc = document.querySelector('.bloc-cle');
        return bloc && bloc.textContent.trim() !== ancienne;
      }, avant, { timeout: 20000 });

    const { corps } = await pile.lireSparkd('/v1/sparks/crm-production/identity');
    assert.notEqual(corps.public_key, avant, 'la cellule porte une NOUVELLE clé');
    assert.equal(corps.public_key, (await page.textContent('.bloc-cle')).trim());
  });
});

test('un Spark ARRÊTÉ dit son identité illisible, et n’offre pas d’en créer une', async () => {
  await parcours('identite-spark-arrete', async () => {
    // « boutique » est arrêté par le seed. §14.6 : « illisible » n'est pas
    // « aucune » — le geste attendu est de démarrer, pas de créer une seconde
    // identité, ce qui invaliderait la clé déjà posée chez le tiers.
    await ouvrir('boutique', 'cles');
    await page.waitForSelector('#titre-cles', { timeout: 10000 });
    await page.waitForFunction(
      () => document.body.innerText.includes('illisible'), { timeout: 20000 });

    const section = await page.textContent('section.identite');
    assert.ok(!/Aucune identité/.test(section),
      '« illisible » ne doit jamais se lire « aucune » (§14.6)');
    assert.equal(await page.locator('[data-identite-creer]').count(), 0,
      'un Spark arrêté ne propose pas de créer une identité');
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

test('un fournisseur qui REFUSE ne laisse pas un sélecteur vide et muet', async () => {
  // Défaut mesuré le 2026-09-02 (§38.1.1) : la clé du poste avait expiré, le
  // fournisseur répondait `401 {"reason":"expired"}` — et la modale des
  // recettes montrait un sélecteur de zones vide, sans un mot. L'exploitant
  // voyait une liste vide et une clé en place, sans savoir laquelle accuser.
  dns.refuserZones({ message: 'authentication is denied',
                     method: 'api_key', reason: 'expired',
                     type: 'denied_authentication' });
  try {
    await parcours('recette-zones-refusees', async () => {
      await ouvrir('boutique', 'routes');
      await page.waitForSelector('#titre-routes');
      await page.click('[data-ouvre="recette"]');
      await page.waitForSelector('dialog.modale[open] #recette-zone', { timeout: 15000 });

      // Le sélecteur ne porte que son invite : il n'y a rien à choisir…
      const options = await page.$$eval('#recette-zone option', (o) => o.map((e) => e.value));
      assert.deepEqual(options, [''], 'aucune zone ne doit être proposée');

      // … et il DIT pourquoi, avec le message du fournisseur tel quel.
      await page.waitForSelector('#recette-zones-vides', { timeout: 10000 });
      const raison = await page.textContent('#recette-zones-vides');
      assert.match(raison, /401/, 'le refus du fournisseur doit être nommé');
      assert.match(raison, /expired/, 'sa raison doit être rendue TELLE QUELLE');
      assert.ok(!/aucune zone DNS/i.test(raison),
        'un refus n’est pas un compte sans zone');
      assert.equal(await page.getAttribute('#recette-zone', 'aria-describedby'),
        'recette-zones-vides', 'le champ doit décrire son propre vide');

      // La raison SURVIT au geste qui remettait l'aperçu à zéro : c'est là que
      // le message disparaissait, et que le sélecteur redevenait muet.
      await page.selectOption('#recette-id', 'site-web');
      // Repère DÉTERMINISTE de la repeinture : les paramètres de la recette
      // choisie apparaissent. Attendre un délai ne prouverait rien.
      await page.waitForSelector('[data-param="address"]', { timeout: 10000 });
      assert.match(await page.textContent('#recette-zones-vides'), /expired/);
    });
  } finally {
    dns.refuserZones(null);
  }
});

test('le widget qui se rafraîchit NE VOLE PAS le focus du clavier', async () => {
  await parcours('widget-focus-clavier', async () => {
    // MESURÉ le 2026-09-02 : le registre est reconstruit toutes les trois
    // secondes. Le focus qui s'y trouvait tombait sur `<body>`, et la tabulation
    // repartait du début de la page — un exploitant au clavier était éjecté sans
    // rien avoir fait (DESIGN_SYSTEM.md §14.3).
    await accueil();
    await page.focus('[data-widget="basculer"]');
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset?.widget), 'basculer');

    // Deux cadences complètes : le rafraîchissement a forcément eu lieu.
    await page.waitForFunction(
      () => document.activeElement?.dataset?.widget !== 'basculer', null,
      { timeout: 7000 })
      .then(() => { throw new Error('le focus a quitté la pastille tout seul'); },
            () => {});
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset?.widget), 'basculer',
      'le focus doit survivre à la reconstruction du widget');
  });
});

// --- SPK-78 · UNE ÉCRITURE DNS SE VÉRIFIE (docs/DAT.md §38.9) --------------

test('le compte rendu d’une recette se VÉRIFIE, et voit l’écart quand il y en a un', async () => {
  await parcours('recette-verification', async () => {
    dns.poser([{ name: '', type: 'MX', data: '10 mail.exemple.test.', ttl: 3600 }]);
    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-routes');
    await page.click('[data-ouvre="recette"]');
    await page.waitForSelector('dialog.modale[open] #recette-id', { timeout: 15000 });

    await page.selectOption('#recette-id', 'site-web');
    await page.selectOption('#recette-zone', 'exemple.test');
    await page.fill('[data-param="domain"]', 'exemple.test');
    await page.fill('[data-param="address"]', '203.0.113.10');
    await page.dispatchEvent('[data-param="address"]', 'change');
    await page.waitForSelector('#recette-apercu .recette-lignes', { timeout: 15000 });
    await page.click('[data-engage="recette"]');
    await page.waitForSelector('#recette-resultat', { timeout: 20000 });

    // §38.9.1 : le compte rendu dit ce qui a été écrit UNE FOIS. La vérification
    // relit la zone, et dit ce qui est en place MAINTENANT.
    await page.click('[data-verifier-recette]');
    await page.waitForSelector('#recette-verification .note-transitoire', { timeout: 15000 });
    const conforme = await page.textContent('#recette-verification');
    assert.match(conforme, /chaque ligne est en place/);
    assert.match(conforme, /TTL/, '§38.9.2 : conforme ne veut pas dire résolu');

    // On déplace la valeur chez le fournisseur : la relecture doit le VOIR, et
    // nommer ce qu'elle trouve. C'est ce qu'un compte rendu persisté ne saurait
    // pas faire.
    dns.poser([{ name: '', type: 'MX', data: '10 mail.exemple.test.', ttl: 3600 },
               { name: '', type: 'A', data: '198.51.100.77' }]);
    await page.click('[data-verifier-recette]');
    await page.waitForSelector('#recette-verification .avertissement', { timeout: 15000 });
    const ecart = await page.textContent('#recette-verification');
    assert.match(ecart, /des écarts subsistent/);
    assert.match(ecart, /198\.51\.100\.77/, 'la valeur TROUVÉE est nommée');
    assert.match(ecart, /absent/, 'le « www » retiré chez le fournisseur est vu absent');
  });
});

test('la facette Routes MONTRE l’état DNS de chaque route', async () => {
  await parcours('routes-etat-dns', async () => {
    dns.poser([
      { name: 'ici', type: 'A', data: '203.0.113.10' },
      { name: 'ailleurs', type: 'A', data: '198.51.100.9' },
    ]);
    await declarerRoute('boutique', 'ici.exemple.test', '8091');
    await declarerRoute('boutique', 'ailleurs.exemple.test', '8092');
    await declarerRoute('boutique', 'sans-dns.exemple.test', '8093');

    await ouvrir('boutique', 'routes');
    await page.waitForSelector('#titre-routes');
    // Le relevé part APRÈS la peinture : on attend le premier badge.
    await page.waitForSelector('li:has-text("ici.exemple.test") .badge', { timeout: 20000 });

    assert.match(await page.textContent('li:has-text("ici.exemple.test")'), /DNS ici/);
    const ailleurs = await page.textContent('li:has-text("ailleurs.exemple.test")');
    assert.match(ailleurs, /198\.51\.100\.9/,
      'une route qui pointe ailleurs doit dire OÙ');
    assert.match(await page.textContent('li:has-text("sans-dns.exemple.test")'),
      /Aucun enregistrement/);
  });
});

// --- SPK-77 · L'INVENTAIRE DNS DE LA FORGE (docs/DAT.md §38.8) -------------

const ZONE_INVENTAIRE = [
  // Servi : une route de cette Forge porte ce nom.
  { name: 'servi', type: 'A', data: '203.0.113.10' },
  // Perdu : la Forge reçoit ce trafic et n'a rien à en faire.
  { name: 'perdu', type: 'A', data: '203.0.113.10' },
  // Hors périmètre : une AUTRE machine, et un type que le produit ne retire pas.
  { name: 'nas', type: 'A', data: '198.51.100.9' },
  { name: '', type: 'MX', data: '10 mail.exemple.test.', ttl: 3600 },
];

test('l’inventaire DNS sépare ce qui est servi de ce qui s’est perdu, et nettoie', async () => {
  await parcours('dns-inventaire', async () => {
    // Le parcours part d'un état de zone DÉTERMINISTE : les parcours d'écriture
    // qui précèdent ont laissé la zone dans un état qui leur appartient.
    dns.poser(ZONE_INVENTAIRE);
    await declarerRoute('boutique', 'servi.exemple.test', '8090');

    // Depuis l'accueil, par la Forge et son onglet — le chemin d'un exploitant.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('.onglet[href="#/forge/dns"]', { timeout: 15000 });
    await page.click('.onglet[href="#/forge/dns"]');
    await page.waitForSelector('#titre-dns', { timeout: 15000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 });

    // Le PÉRIMÈTRE : ni le `A` d'une autre machine, ni le `MX`.
    const tableau = await page.textContent('table');
    assert.ok(tableau.includes('servi.exemple.test'));
    assert.ok(tableau.includes('perdu.exemple.test'));
    assert.ok(!tableau.includes('nas.exemple.test'),
      'un A qui pointe ailleurs n’est pas dans le périmètre');
    assert.ok(!/\bMX\b/.test(tableau), 'un autre type n’est pas dans le périmètre');

    // Les DEUX VERDICTS, et le Spark nommé.
    const ligneServie = 'tr:has-text("servi.exemple.test")';
    assert.match(await page.textContent(ligneServie), /Servi/);
    assert.match(await page.textContent(ligneServie), /boutique/);
    const lignePerdue = 'tr:has-text("perdu.exemple.test")';
    assert.match(await page.textContent(lignePerdue), /Aucune route ne le sert/);

    // Une entrée SERVIE n'est pas désignable : le serveur la refuserait.
    assert.equal(await page.locator(`${ligneServie} input[type=checkbox]`).count(), 0);

    // On désigne la perdue, et la confirmation l'ÉNUMÈRE.
    await page.click(`${lignePerdue} input[type=checkbox]`);
    await page.click('[data-dns-nettoyer]');
    await page.waitForSelector('dialog.modale[open]', { timeout: 10000 });
    const confirmation = await page.textContent('dialog.modale[open]');
    assert.ok(confirmation.includes('perdu.exemple.test'));
    assert.ok(confirmation.includes('203.0.113.10'),
      'la valeur est montrée : c’est ce qui rend le geste relisable');

    // LE POINT QUI DÉCIDE (§38.8.3) : la condition est RECONSTATÉE au moment du
    // retrait. On fait changer l'enregistrement sous les doigts — exactement la
    // course que la règle protège — et le serveur refuse.
    dns.poser([...ZONE_INVENTAIRE.filter((r) => r.name !== 'perdu'),
               { name: 'perdu', type: 'A', data: '198.51.100.42' }]);
    await page.click('[data-engage="dns-nettoyage"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 15000 });
    assert.match(await page.textContent('dialog.modale[open] .refus'),
      /ne désigne pas cette Forge/);
    assert.ok(dns.enregistrements().some((r) => r.name === 'perdu'),
      'un refus ne doit RIEN retirer');

    // Remis dans l'état affiché, le retrait passe.
    dns.poser(ZONE_INVENTAIRE);
    await page.click('[data-engage="dns-nettoyage"]');
    await page.waitForSelector('#dns-resultat', { timeout: 20000 });
    const bilan = await page.textContent('#dns-resultat');
    assert.match(bilan, /1 retirée\(s\)/);
    assert.ok(!bilan.includes('refusée'), 'rien ne devait être refusé cette fois');
    assert.match(bilan, /TTL/, 'on ne promet jamais que le nom ne répond plus');

    // EFFET, constaté chez le fournisseur.
    const zone = dns.enregistrements();
    assert.ok(!zone.some((r) => r.name === 'perdu'), 'l’entrée perdue doit avoir disparu');
    assert.ok(zone.some((r) => r.name === 'servi'), 'la route servie ne bouge pas');
    assert.ok(zone.some((r) => r.type === 'MX'),
      'la messagerie n’est jamais emportée par un nettoyage d’ingress');
    assert.ok(zone.some((r) => r.name === 'nas'),
      'un A qui pointe ailleurs n’est jamais retiré');
  });
});

// --- SPK-67 · LE CONTRAT D'ÉCHEC DU PILOTE (docs/DAT.md §12.1.4) -----------

test('un geste ORDINAIRE sur une cellule disparue est refusé DANS la modale', async () => {
  await parcours('cellule-absente-instantane', async () => {
    // Ce parcours passe AVANT celui de SPK-36 : « orphelin » y est encore
    // « arrêté », et c'est l'état qui décide. L'écran n'offre alors que
    // « Démarrer » et « Supprimer » — pas « Reprendre », qui n'apparaît qu'en
    // panne. Un refus qui nommerait « Reprendre » enverrait donc chercher un
    // bouton absent (DESIGN_SYSTEM.md §1.5 bis).
    await ouvrir('orphelin', 'instantanes');
    await page.click('button:has-text("Prendre un instantané")');
    await page.waitForSelector('dialog[open] input', { timeout: 10000 });
    await page.keyboard.type('avant-mise-a-jour');
    await page.click('button:has-text("Prendre l\u2019instantané")');

    // §6.27 : le refus s'affiche DANS la modale, près du bouton d'engagement.
    // Une modale qui se refermerait ferait perdre la saisie ET cacherait la
    // raison — les deux à la fois.
    await page.waitForFunction(
      () => /a disparu/.test(document.querySelector('dialog[open]')?.innerText ?? ''),
      null, { timeout: 15000 });

    const modale = await page.textContent('dialog[open]');
    assert.match(modale, /orphelin/, 'le refus NOMME le Spark');
    assert.match(modale, /reconstruite/, 'et dit ce qu\'on peut faire');
    assert.doesNotMatch(modale, /« Reprendre »/,
      'il ne nomme pas un bouton que cet écran n\'offre pas');

    const saisie = await page.inputValue('dialog[open] input');
    assert.equal(saisie, 'avant-mise-a-jour', '§6.27 : la saisie SURVIT au refus');

    // §1.3 : aucun succès simulé. L'instantané n'existe ni à l'écran ni côté
    // sparkd — et c'est le second qui fait foi.
    await page.click('button:has-text("Annuler")');
    const { corps } = await pile.lireSparkd('/v1/sparks/orphelin/snapshots');
    assert.deepEqual(corps.snapshots ?? [], [],
      'un geste refusé ne laisse RIEN derrière lui');

    // La borne du §12.1.4 : cette route n'a posé aucun état transitoire, donc
    // elle refuse sans rien écrire. Lire ou tenter un geste ordinaire ne met
    // pas le Spark en panne — seul le cycle de vie le fait, et le parcours
    // suivant le montre.
    const { corps: fiche } = await pile.lireSparkd('/v1/sparks/orphelin');
    assert.equal(fiche.state, 'stopped', 'l\'état n\'a pas bougé');
    assert.equal(fiche.last_error, null, 'et rien n\'est écrit sur sa fiche');
  });
});

// --- SPK-36 · PERTE DE LA CELLULE (docs/DAT.md §14.6, CONTINGENCE §4.5) ---

test('démarrer un Spark dont la cellule a disparu le laisse MANŒUVRABLE', async () => {
  await parcours('cellule-perdue', async () => {
    // Mesuré sur la Forge de validation le 2026-08-21, et atteignable ICI en un
    // seul clic sur un Spark seedé : ce geste rendait 500, et laissait le Spark
    // en « starting », `allowed_commands` VIDE, `last_error` nul. Un état
    // transitoire dont on ne sort plus, sans commande et sans raison — l'écran
    // montrait un démarrage qui n'aboutirait jamais (DESIGN_SYSTEM.md §1.3),
    // aucune commande alors que deux existaient (§9.9), et une absence que rien
    // ne nommait (§14.5).
    //
    // `orphelin` est seedé comme la reproduction fidèle de l'évènement du
    // 2026-08-19 : sa ligne est écrite par le vrai chemin, son instance est
    // retirée du pilote. C'est le fantôme du §4.1, tel quel.
    await ouvrir('orphelin');
    assert.ok(await page.$('[data-commande="start"]'),
      '§1.4 : la commande EXISTE, c\'est le serveur qui refusera — pas l\'écran');

    await page.click('[data-commande="start"]');
    // On attend l'état RÉEL relu par la console, pas un message fugace :
    // `lancer()` relit la fiche plutôt que d'afficher le refus, et c'est la
    // fiche qui doit porter la raison.
    await page.waitForFunction(
      () => document.querySelector('[data-commande="retry"]') !== null,
      null, { timeout: 20000 });

    const entete = await page.textContent('.entete-entite');
    assert.match(entete, /Dernière erreur/, '§14.5 : l\'absence est NOMMÉE');
    assert.match(entete, /cellule/i, 'la raison dit ce qui a disparu');
    assert.match(entete, /orphelin/, 'et de quel Spark il s\'agit');
    assert.doesNotMatch(entete, /\/1\.0\//,
      '§20 : aucun chemin de l\'API interne d\'Incus sous les yeux de l\'exploitant');

    // Les DEUX remèdes annoncés par le contrôle REG-FANTOME sont offerts, et
    // c'est tout l'objet du correctif : l'ancien comportement n'en offrait
    // aucun.
    assert.ok(await page.$('[data-commande="retry"]'), '« Reprendre » doit être offert');
    assert.ok(await page.$('[data-commande="delete"]'), '« Supprimer » doit rester offert');

    // EFFET côté sparkd : la panne est nommée et l'état n'est plus transitoire.
    const { corps } = await pile.lireSparkd('/v1/sparks/orphelin');
    assert.equal(corps.state, 'error', 'surtout pas un état transitoire sans issue');
    assert.equal(corps.transient, false);
    assert.ok(corps.last_error, 'la raison est PERSISTÉE, pas seulement affichée');
    assert.deepEqual(corps.allowed_commands.sort(), ['delete', 'retry']);

    // On ne clique PAS « Reprendre » : la reconstruction recréerait la cellule,
    // et le parcours suivant a besoin de ce Spark SANS instance pour éprouver
    // SPK-52. Les deux parcours racontent ensemble le §4.5 — ici le refus qui
    // laisse manœuvrable, là l'autre remède qui aboutit. La reconstruction
    // elle-même est éprouvée en unité, et elle a été JOUÉE sur la Forge.
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

    // RÉVISÉ le 2026-08-20 par SPK-63 (§6.23) : la suppression exige désormais
    // qu'on FRAPPE le nom. Le parcours cliquait directement — ce qui prouvait la
    // suppression, mais ne pouvait plus aboutir. On frappe donc, comme un
    // exploitant, et le clavier fait foi.
    await page.fill('[data-frappe="delete"]', 'orphelin');
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

// --- SPK-63 · FRAPPER LE NOM (§6.23) ---------------------------------------

test('sans la frappe du nom, la suppression ne s’engage PAS', async () => {
  await parcours('suppression-frappe', async () => {
    // §6.23 : une confirmation ordinaire prouve qu'on a VU l'écran ; frapper le
    // nom prouve qu'on a lu LEQUEL. C'est la seule différence qui compte quand
    // on a sélectionné le mauvais Spark.
    await ouvrir('boutique');
    await page.waitForSelector('.entete-entite');
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('[data-frappe="delete"]', { timeout: 10000 });

    // §6.22 et §14.3 : le focus entre dans le CHAMP, pas sur un bouton inerte.
    const focalise = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-frappe'));
    assert.equal(focalise, 'delete');

    // §9.9 : le bouton est PRÉSENT et désactivé — le faire disparaître ferait
    // croire que le produit ne sait pas supprimer.
    const engage = () => page.$eval('[data-confirme]', (b) => b.disabled);
    assert.equal(await engage(), true, 'rien de frappé : rien n’est engageable');

    // Un nom APPROCHANT n'engage pas. La casse ne suffit pas non plus : deux
    // Sparks qui ne diffèrent que par elle existent.
    for (const approche of ['bouti', 'BOUTIQUE', 'boutique ']) {
      await page.fill('[data-frappe="delete"]', approche);
      assert.equal(await engage(), true, approche);
    }

    // Et rien n'a été tenté : ce n'est pas une erreur, donc pas de rouge.
    assert.equal(await page.$$eval('.refus', (l) => l.length), 0);

    // Le nom EXACT engage.
    await page.fill('[data-frappe="delete"]', 'boutique');
    assert.equal(await engage(), false);

    // On ANNULE : le Spark doit être intact, et c'est `sparkd` qui le dit.
    await page.click('[data-annule]');
    await page.waitForFunction(
      () => !document.querySelector('[data-frappe="delete"]'), { timeout: 10000 });
    const { status } = await pile.lireSparkd('/v1/sparks/boutique');
    assert.equal(status, 200, 'une confirmation annulée n’a rien supprimé');

    // Rouvrir REPART à vide : garder la frappe précédente rendrait la suivante
    // engageable sans avoir rien lu.
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('[data-frappe="delete"]', { timeout: 10000 });
    assert.equal(await page.$eval('[data-frappe="delete"]', (c) => c.value), '');
    assert.equal(await engage(), true);
    await page.click('[data-annule]');
  });
});

// --- LE TERMINAL (SPK-43, docs/DAT.md §37.4) -------------------------------

test('entrer dans le terminal ANSI, écrire, coller, répondre à DSR, redimensionner et quitter', async () => {
  // LE parcours de la DoD. Le transport est doublé (§37.4.2 bis) : un relai
  // brut renvoie les octets, donc la boucle complète — vraie grille xterm,
  // touches, collage, flux, réponse terminal et sortie — est celle de la
  // production, seule la commande lancée change.
  await parcours('terminal', async () => {
    await ouvrir('crm-production', 'terminal');
    await page.waitForSelector('#titre-terminal');

    // Il n'y a pas de champ parallèle : ce serait lui qui volerait les touches
    // de contrôle, la sélection et le collage à l'émulateur.
    assert.equal(await page.$('#terminal-entree'), null);

    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });
    const grille = page.locator('.terminal--emulateur .xterm-helper-textarea');
    await grille.waitFor({ state: 'attached', timeout: 20000 });

    // Une commande, au CLAVIER, et sa réponse : elle traverse la vraie grille.
    await grille.pressSequentially('bonjour depuis le parcours');
    await grille.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.xterm-rows')?.innerText.includes('bonjour depuis le parcours'),
      null, { timeout: 20000 });

    // Un collage est lui aussi livré à xterm, pas à un champ caché.
    const coller = (texte) => grille.evaluate((element, valeur) => {
      const pressePapier = new DataTransfer();
      pressePapier.setData('text/plain', valeur);
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: pressePapier,
      }));
    }, texte);
    await coller('collage direct');
    await page.waitForFunction(
      () => document.querySelector('.xterm-rows')?.innerText.includes('collage direct'),
      null, { timeout: 20000 });

    // Une touche de contrôle part par le même flux ; le vrai terminal répond à
    // CSI 6n. Le relai réémet la demande et xterm produit alors son rapport CPR.
    const entreeDeTerminal = (requete) => {
      if (!requete.url().includes('/api/terminal/entree')) return null;
      try { return JSON.parse(requete.postData() ?? '').data; } catch { return null; }
    };
    const controle = page.waitForRequest((requete) => entreeDeTerminal(requete) === '\f',
                                          { timeout: 10000 });
    await grille.press('Control+L');
    await controle;
    const dsr = page.waitForRequest((requete) => /^\x1b\[\d+;\d+R$/.test(
      entreeDeTerminal(requete) ?? ''), { timeout: 10000 });
    await coller('\u001b[6n');
    await dsr;
    assert.equal(await page.locator('#terminal-sortie').evaluate(
      (element) => element.innerText.includes('\u001b[')), false,
    'une séquence ANSI reste interprétée, jamais rendue comme texte brut');

    // xterm publie sa géométrie au PTY. Le corps ne contient aucun `stty` : le
    // programme distant déjà ouvert recevra son SIGWINCH réel.
    const taille = page.waitForRequest((requete) =>
      requete.url().includes('/api/terminal/taille'), { timeout: 10000 });
    await page.setViewportSize({ width: 1200, height: 1000 });
    const requeteTaille = await taille;
    const dimensions = JSON.parse(requeteTaille.postData());
    assert.ok(dimensions.rows > 0 && dimensions.cols > 0);
    assert.ok(!requeteTaille.postData().includes('stty'));

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

test('changer de page NE TUE PLUS la session, et le widget la montre', async () => {
  // SPK-75 · §37.4.2 RÉVISÉ. C'est LE reproche qui a ouvert l'unité : le
  // travail était perdu au moindre changement de page. Regarder le journal
  // pendant qu'une commande tourne ne doit plus tuer la commande.
  await parcours('terminal-survit-a-la-navigation', async () => {
    await ouvrir('boutique', 'terminal');
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

    // On CHANGE d'onglet, sans rien fermer.
    await page.click('.onglet[href$="/journal"]');
    await page.waitForSelector('.onglet[href$="/journal"][aria-current="page"]',
                               { timeout: 10000 });

    // La session vit toujours, côté HÔTE — constaté, pas supposé.
    await page.waitForFunction(async () => {
      const r = await fetch('/api/terminal/sessions');
      return (await r.json()).sessions.length === 1;
    }, null, { timeout: 10000 });

    // …et le widget la montre, sur une route qui n'est pas celle du terminal.
    await ouvrirWidget();
    const ligne = page.locator('.widget-inv__ligne').filter({ hasText: 'boutique' }).first();
    await ligne.waitFor({ timeout: 10000 });
    assert.match(await ligne.textContent(), /shell ouvert/);

    // On y REVIENT par le widget, et on retrouve sa grille.
    await ligne.locator('[data-widget-spark="boutique"]').click();
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

    await replierWidget();
    await page.locator('[data-terminal="fermer"]').click();
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 15000 });
  });
});

test('la session se RETROUVE après un rechargement de la page', async () => {
  // SPK-75 · §37.4.8 : faire survivre un shell sans savoir le retrouver ne
  // ferait que le cacher. Le rechargement est le cas qui le prouve.
  await parcours('terminal-reprise-apres-rechargement', async () => {
    await ouvrir('boutique', 'terminal');
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.entete-entite', { timeout: 20000 });

    // La grille est REPRISE, pas rouverte : une seule session côté hôte.
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });
    const listees = await page.evaluate(async () =>
      (await (await fetch('/api/terminal/sessions')).json()).sessions);
    assert.equal(listees.length, 1, 'aucune seconde session n’a été ouverte');

    await replierWidget();
    await page.locator('[data-terminal="fermer"]').click();
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 15000 });
  });
});

test('passer au terminal d’un autre Spark NE TUE PLUS le premier', async () => {
  await parcours('terminal-changement-spark', async () => {
    await ouvrir('boutique', 'terminal');
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

    // Les deux destinations finissent par `/terminal` : la fenêtre suit bien le
    // second Spark, mais le shell du premier CONTINUE (SPK-75).
    await page.evaluate(() => { location.hash = '#/sparks/crm-production/terminal'; });
    await page.waitForFunction(
      () => document.querySelector('.entete-entite')?.textContent.includes('crm-production'),
      null, { timeout: 20000 });
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 20000 });

    const listees = await page.evaluate(async () =>
      (await (await fetch('/api/terminal/sessions')).json()).sessions);
    assert.equal(listees.length, 1, 'le shell de « boutique » vit encore');
    assert.equal(listees[0].spark, 'boutique');

    // Le widget le montre, alors qu'on regarde un AUTRE Spark.
    await ouvrirWidget();
    const ligne = page.locator('.widget-inv__ligne').filter({ hasText: 'boutique' }).first();
    assert.match(await ligne.textContent(), /shell ouvert/);

    await ligne.locator('[data-session-close]').click();
    await ligne.locator('[data-session-close-confirm]').click();
    await page.waitForFunction(async () =>
      (await (await fetch('/api/terminal/sessions')).json()).sessions.length === 0,
      null, { timeout: 15000 });
  });
});

test('déplier un Spark relève SES conteneurs, et n’interroge aucun autre', async () => {
  // SPK-75 · §37.4.8 : le §37.6 tient — un Spark qu'on ne regarde pas n'est
  // jamais interrogé. Interroger Docker en boucle sur chaque Spark ferait
  // tourner une commande en continu chez chaque locataire.
  await parcours('widget-conteneurs', async () => {
    await accueil();
    await ouvrirWidget();

    // §F.4 du runbook : ce parcours déplie « postgres-dedie » et NON
    // « crm-production », qui est le Spark des parcours Docker. Déplier lance un
    // relevé sur la même route qu'eux ; les tenir sur deux Sparks distincts
    // garde les deux familles indépendantes, quoi qu'elles gagnent plus tard.
    const cible = page.locator('.widget-inv__ligne').filter({ hasText: 'postgres-dedie' }).first();
    await cible.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-widget-conteneur]').count(), 0,
      'aucun conteneur n’est listé tant que rien n’est déplié');

    await page.locator('[data-widget-deplier="postgres-dedie"]').click();
    await page.waitForSelector('[data-widget-conteneur="postgres-dedie"]', { timeout: 20000 });

    // Le Spark voisin n'a rien demandé.
    assert.equal(await page.locator('[data-widget-conteneur="crm-production"]').count(), 0);

    // Replier arrête le relevé.
    await page.locator('[data-widget-deplier="postgres-dedie"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-widget-conteneur]').length === 0,
      null, { timeout: 10000 });
  });
});

test('le registre retrouve deux sessions, en reprend une et ferme explicitement la bonne', async () => {
  await parcours('registre-sessions', async () => {
    // Première fenêtre : un shell de Spark, ouvert par l'interface.
    await ouvrir('crm-production', 'terminal');
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

    // Seconde fenêtre : le shell du conteneur. Les deux doivent rester vivants
    // et être décrits par le même registre local, sans jamais lire leur sortie.
    const autre = await navigateur.newPage();
    autre.on('console', (m) => {
      if (['error', 'warning'].includes(m.type()) && !JOURNAL_RESEAU.test(m.text())) {
        bruits.push(`[registre/${m.type()}] ${m.text()}`);
      }
    });
    autre.on('pageerror', (e) => bruits.push(`[registre/pageerror] ${e.message}`));
    try {
      await autre.setViewportSize({ width: 1440, height: 1000 });
      await autre.goto(pile.base, { waitUntil: 'domcontentloaded' });
      await autre.waitForSelector('tbody a', { timeout: 20000 });
      await autre.click('tbody a:has-text("crm-production")');
      await autre.waitForSelector('.entete-entite', { timeout: 10000 });
      await autre.click('.onglet[href$="/docker"]');
      await autre.waitForSelector('tbody tr', { timeout: 15000 });
      await autre.click('button[data-conteneur="helo-web-1"]');
      await autre.waitForSelector('button[data-docker="terminal"]', { timeout: 10000 });
      await autre.click('button[data-docker="terminal"]');
      await autre.waitForSelector('[data-terminal="fermer"]', { timeout: 20000 });

      await ouvrirWidget();
      // Le widget déplie le Spark pour montrer le conteneur qui porte le shell.
      await page.locator('[data-widget-deplier="crm-production"]').click();
      await page.waitForSelector('[data-widget-conteneur="crm-production"]', { timeout: 20000 });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-vivante="oui"]').length === 2,
        null, { timeout: 15000 });

      const inventaire = await page.textContent('.widget-inv');
      assert.match(inventaire, /crm-production/);
      assert.match(inventaire, /helo-web-1/);
      assert.ok(!/bonjour depuis le parcours|collage direct/.test(inventaire),
        'le widget ne réutilise jamais la sortie de terminal (§37.5)');

      // La fermeture est confirmée et vise la ligne Spark, pas le conteneur.
      const ligneSpark = page.locator('.widget-inv__ligne')
        .filter({ has: page.locator('[data-widget-spark="crm-production"]') });
      await ligneSpark.locator('[data-session-close]').click();
      await ligneSpark.locator('[data-session-close-confirm]').click();
      await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 15000 });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-vivante="oui"]').length === 1,
        null, { timeout: 15000 });
      assert.ok(await autre.$('[data-terminal="fermer"]'),
        'fermer une ligne ne tue pas le terminal du conteneur voisin');

      // La ligne restante se sélectionne : la première grille reprend la vraie
      // session conteneur sans produire de troisième shell.
      // Trois conteneurs sont listés : on vise CELUI qui porte le shell.
      await page.locator('[data-widget-conteneur="crm-production"][data-conteneur="helo-web-1"]')
        .click();
      await page.waitForSelector('[data-terminal="fermer"]', { timeout: 15000 });
      assert.match(await page.textContent('.bandeau-terminal'), /Conteneur/);
    } finally {
      await autre.locator('[data-terminal="fermer"]').click().catch(() => {});
      await autre.close();
      // La sélection a pu recevoir la fin de l'autre vue ; quitter la première
      // ne doit laisser aucune session du parcours suivant.
      await page.locator('[data-terminal="fermer"]').click().catch(() => {});
    }
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

// --- SPK-76 · LA FAMILLE DE LA CELLULE (§42.9) ------------------------------
//
// @verifies docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.5, §42.9.6

test('une cellule que l’amorçage ne sert pas est REFUSÉE, et le refus la nomme', async () => {
  await parcours('amorcage-non-servi', async () => {
    // Le cas réel du responsable : `alpine-demo` rendait le refus brut d'Incus,
    // « Command not found », qui ne désigne pas sa cause. Depuis l'accueil, à
    // la souris — c'est le parcours canonique qui doit le dire.
    await ouvrir('alpine-demo');
    await page.waitForSelector('#titre-amorcage');

    await page.click('[data-amorcage="relever"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('ne sait pas servir'), { timeout: 15000 });

    const ecran = await page.textContent('.principal');
    assert.match(ecran, /alpine/, 'le refus NOMME la distribution relevée');
    assert.match(ecran, /Debian et Ubuntu/, 'et dit ce qu’il sert');
    assert.ok(!/Command not found/.test(ecran),
      'le refus d’Incus ne fuit plus jusqu’à l’écran');

    // §1.4 : le geste n'est pas offert, puisqu'il sera refusé à coup sûr.
    assert.equal(await page.$('[data-amorcage="amorcer"]'), null);
  });
});

test('un amorçage sur UBUNTU pose le dépôt d’Ubuntu, pas celui de Debian', async () => {
  await parcours('amorcage-ubuntu', async () => {
    // La seconde cellule du responsable. Elle recevait `linux/debian trixie` :
    // le dépôt RÉPOND, donc rien ne prévenait avant qu'`apt` ne refuse ses
    // paquets sur `noble`.
    await ouvrir('ubuntu-24');
    await page.waitForSelector('#titre-amorcage');

    await page.click('[data-amorcage="amorcer"]');
    await page.waitForSelector('[data-amorcage="engager"]', { timeout: 10000 });
    await page.click('[data-amorcage="engager"]');
    await page.waitForSelector('.liste-amorcage', { timeout: 20000 });

    const lignes = await page.$$eval('.ligne-amorcage', (l) => l.map((x) => x.textContent));
    const depot = lignes.find((l) => l.includes('dépôt Docker amont'));
    assert.match(depot, /ubuntu noble/, 'le dépôt suit la distribution de la cellule');
    assert.ok(!/debian trixie/.test(depot));

    const ecran = await page.textContent('.principal');
    assert.match(ecran, /Cette cellule est complète/);
  });
});

test('le relevé d’un Spark ne DÉBORDE pas sur la fiche du suivant', async () => {
  await parcours('amorcage-pas-de-debordement', async () => {
    // §42.6 : un relevé porte sur UNE cellule. L'état n'était jamais remis à
    // zéro entre deux fiches — même défaut que celui que le §37.6 corrige pour
    // Docker. Trouvé en produisant les captures, pas par une preuve de rendu :
    // celles-ci peignent une fiche à la fois et ne peuvent pas le voir.
    await ouvrir('alpine-demo');
    await page.waitForSelector('#titre-amorcage');
    await page.click('[data-amorcage="relever"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('ne sait pas servir'), { timeout: 15000 });

    // On NAVIGUE dans l'application, sans recharger : `ouvrir()` repasse par
    // l'accueil et remettrait l'état à zéro tout seul — le défaut ne se
    // reproduirait pas, et la preuve serait verte sans rien garder.
    await page.click('nav a[href="#/sparks"]');
    await page.waitForSelector('tbody a:has-text("ubuntu-24")', { timeout: 10000 });
    await page.click('tbody a:has-text("ubuntu-24")');
    await page.waitForSelector('#titre-amorcage');
    const section = await page.$eval(
      '#titre-amorcage', (h) => h.closest('section').innerText);
    assert.ok(!/ne sait pas servir/.test(section),
      'la fiche d’ubuntu-24 hérite du refus d’alpine-demo');
    assert.ok(await page.$('[data-amorcage="amorcer"]'),
      'un Spark amorçable doit garder son geste');
  });
});

test('en 390 px, le widget flottant ne rend AUCUNE action incliquable', async () => {
  await parcours('widget-ne-recouvre-pas', async () => {
    // SPK-75 · DESIGN_SYSTEM_APP.md : « le widget ne masque jamais une action du
    // contenu ». La réserve existait mais était ÉCRASÉE par les raccourcis
    // `padding:` qui la suivaient — elle ne s'appliquait donc nulle part.
    //
    // Trouvé en produisant les captures de SPK-76 : Playwright ne POUVAIT PAS
    // cliquer « Relever l'état », le widget interceptant le pointeur. Mesuré
    // alors : réserve effective 16 px pour un widget qui en occupe 54.
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      // Un Spark du seed de base : la preuve ne doit dépendre d'aucun ajout.
      await ouvrir('crm-production');
      await page.waitForSelector('[data-amorcage="relever"]', { timeout: 10000 });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      // On éprouve l'INVARIANT, pas une géométrie de circonstance : selon la
      // hauteur de la fiche, le dernier bouton tombe ou non sous le widget, et
      // une preuve qui en dépendrait serait verte un jour sur deux.
      //
      // La règle est : la réserve du contenu couvre ce que la pastille occupe.
      const vu = await page.evaluate(() => {
        const principal = document.querySelector('.principal');
        const widget = document.querySelector('.widget-inv');
        const reserve = parseFloat(getComputedStyle(principal).paddingBottom);
        const occupe = window.innerHeight - widget.getBoundingClientRect().top;
        return { reserve, occupe };
      });
      assert.ok(vu.reserve >= vu.occupe,
        `la page réserve ${vu.reserve} px pour un widget qui en occupe `
        + `${vu.occupe} : le contenu passe dessous et devient incliquable`);

      // …et le clic passe VRAIMENT, pas seulement la géométrie.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.click('[data-amorcage="relever"]', { timeout: 5000 });
    } finally {
      await page.setViewportSize({ width: 1440, height: 1300 });
    }
  });
});

test('l’écran de création DIT quelles images l’amorçage sait servir', async () => {
  await parcours('creation-images-amorcables', async () => {
    // §42.9.6 : le §33 proposait une image que le §42 ne savait pas équiper, et
    // rien ne le disait avant l'échec. C'est ce silence qui a produit la cellule
    // du responsable.
    await accueil();
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });

    const options = await page.$$eval('#image option', (o) => o.map((x) => x.textContent));
    const alpine = options.find((o) => o.includes('alpine'));
    assert.match(alpine, /amorçage non pris en charge/);
    // …et elle reste CHOISISSABLE : le produit sert des cellules, pas seulement
    // des cellules amorçables (§25 — montrer sans décider).
    assert.equal(await page.$eval('#image', (s) => s.disabled), false);
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

    // RÉVISÉE le 2026-08-20 par SPK-45 tranche 2, pour la raison DÉJÀ rencontrée
    // en tête de ce fichier : le compte était FIGÉ à deux. Le doublon porte
    // désormais un conteneur sans shell, et le nombre a rougi sans rien dire du
    // produit — il rougirait encore à la prochaine fixture.
    //
    // Ce que la preuve établit est inchangé, et mieux dit : `docker ps -a`
    // liste ce qui tourne ET ce qui est arrêté. C'est le point du §37.6 bis —
    // une pile qui ne répond plus a justement des conteneurs arrêtés.
    const lignes = await page.$$eval('tbody tr', (l) => l.map((x) => x.textContent));
    assert.ok(lignes.some((l) => /helo-web-1/.test(l)), 'celui qui tourne');
    assert.ok(lignes.some((l) => /helo-base-1/.test(l)), 'et celui qui est arrêté');

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
    assert.match(ecran, /vient du\s+locataire/);
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
    // §25.1 : le rouge est réservé au refus du serveur. Une course perdue est un
    // avertissement — la dire en rouge contredirait à l'œil le texte qui la dit.
    assert.equal(await page.$$eval('.refus', (l) => l.length), 0);
    assert.ok(await page.$('.avertissement'));
    // Et le retour à la liste reste offert : on n'est pas coincé sur un absent.
    await page.click('button[data-docker="fermer"]');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
  });
});

test('sur 390 px, les journaux défilent dans LEUR bloc et la page ne déborde pas', async () => {
  await parcours('docker-conteneur-etroit', async () => {
    // §8.1 : la page ne défile jamais horizontalement. Un journal contient des
    // lignes très longues — une requête HTTP complète en fait couramment cent
    // cinquante colonnes — et c'est LUI qui doit défiler, pas l'écran.
    await ouvrir('crm-production', 'docker');
    await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
    await page.click('button[data-conteneur="helo-web-1"]');
    await page.waitForSelector('pre.terminal', { timeout: 15000 });

    const avant = await page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    const mesure = await page.evaluate(() => {
      const large = document.documentElement.clientWidth;
      const pre = document.querySelector('pre.terminal');
      const fiche = document.querySelector('.fiche-conteneur');
      const deborde = (n) => n
        ? Math.round(n.getBoundingClientRect().right - large) : null;
      return { journal: deborde(pre), fiche: deborde(fiche),
               // Le journal DOIT défiler chez lui : sans quoi il n'y aurait rien
               // à faire des lignes longues, sinon les tronquer.
               defile: pre ? pre.scrollWidth > pre.clientWidth : false };
    });
    await page.setViewportSize(avant);
    assert.ok(mesure.journal <= 1, `le journal déborde de ${mesure.journal} px`);
    assert.ok(mesure.fiche <= 1, `la fiche déborde de ${mesure.fiche} px`);
    // La barre d'onglets, elle, déborde — c'est INC-07, antérieur à cette unité
    // et consigné au registre. On ne le corrige pas ici, et on ne le masque pas
    // non plus : cette preuve mesure ce que l'unité AJOUTE.
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

// --- SPK-45 · LES GESTES SUR UN CONTENEUR (§37.7) --------------------------

/** Ouvre un conteneur de « crm-production » depuis la liste, à la souris. */
async function ouvrirConteneur(nom, spark = 'crm-production') {
  await ouvrir(spark, 'docker');
  await page.waitForSelector('.table-defilante table tbody tr', { timeout: 15000 });
  await page.click(`button[data-conteneur="${nom}"]`);
  await page.waitForSelector('#titre-conteneur', { timeout: 15000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes('Inspection en cours'), { timeout: 15000 });
}

test('arrêter un conteneur : la confirmation NOMME l’effet, et le journal le retient',
     async () => {
  await parcours('geste-arreter', async () => {
    await ouvrirConteneur('helo-web-1');

    // §29.3 : on demande le geste EN CLIQUANT, jamais par un appel d'API.
    await page.click('button[data-geste="stop"]');
    await page.waitForSelector('.confirmation', { timeout: 10000 });

    // §6.23 : l'effet est décrit, jamais un « êtes-vous sûr ».
    const confirmation = await page.textContent('.confirmation');
    assert.match(confirmation, /helo-web-1/);
    assert.match(confirmation, /La production servie par « helo-web-1 » s’interrompt/);
    assert.ok(!/êtes-vous sûr/i.test(confirmation));
    assert.match(confirmation, /inscrit au journal/);

    // §6.22 : le focus ENTRE dans la confirmation.
    const focalise = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-geste-confirme'));
    assert.equal(focalise, 'stop', 'le focus entre dans la confirmation');

    await page.click('[data-geste-confirme="stop"]');
    await page.waitForSelector('.succes', { timeout: 15000 });
    const issue = await page.textContent('.succes');
    assert.match(issue, /c’est fait/);
    assert.match(issue, /helo-web-1/);

    // CLAUDE.md §15 : on LIT `sparkd` pour constater l'effet, jamais pour agir.
    const { corps } = await pile.lireSparkd('/v1/audit?action=spark.container_stop');
    const inscrit = corps.entries[0];
    assert.ok(inscrit, 'le geste doit être au journal');
    assert.equal(inscrit.result, 'ok');
    // Le nom est humain et peut changer ; le journal cible l'identifiant
    // immuable que sparkd a réellement attribué au Spark (§36.9, §37.7.4).
    const { corps: sparkCible } = await pile.lireSparkd('/v1/sparks/crm-production');
    assert.notEqual(sparkCible.id, sparkCible.name);
    assert.equal(inscrit.target_id, sparkCible.id);
    assert.equal(JSON.parse(inscrit.payload).container, 'helo-web-1');
  });
});

test('annuler une confirmation ne fait RIEN, et rend le focus au déclencheur', async () => {
  await parcours('geste-annule', async () => {
    // Une confirmation dont l'annulation agirait quand même serait pire que pas
    // de confirmation du tout.
    const { corps: avant } = await pile.lireSparkd('/v1/audit?action=spark.container_kill');
    await ouvrirConteneur('helo-web-1');
    await page.click('button[data-geste="kill"]');
    await page.waitForSelector('.confirmation', { timeout: 10000 });
    await page.click('[data-geste-annule]');
    await page.waitForFunction(
      () => !document.querySelector('.confirmation'), { timeout: 10000 });

    // §6.22 : l'annulation rend le focus au déclencheur.
    const focalise = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-geste'));
    assert.equal(focalise, 'kill');

    const { corps: apres } = await pile.lireSparkd('/v1/audit?action=spark.container_kill');
    assert.equal(apres.entries.length, avant.entries.length,
      'annuler n’a rien inscrit, donc rien fait');
  });
});

test('tuer un conteneur DÉJÀ ARRÊTÉ le dit, sans crier à la panne', async () => {
  await parcours('geste-deja-arrete', async () => {
    // MESURÉ (§37.7.1) : le seul geste non idempotent. L'état voulu est
    // pourtant déjà celui-là — ce n'est pas un échec du produit.
    await ouvrirConteneur('helo-base-1');
    await page.click('button[data-geste="start"]');
    await page.waitForSelector('.confirmation', { timeout: 10000 });
    await page.click('[data-geste-confirme="start"]');
    await page.waitForSelector('.succes', { timeout: 15000 });

    // « helo-base-1 » est arrêté dans l'inventaire : le doublon fait échouer son
    // « kill » avec « is not running », comme le vrai Docker.
    await ouvrirConteneur('helo-base-1');
    const rendu = await page.content();
    if (rendu.includes('data-geste="kill"')) {
      await page.click('button[data-geste="kill"]');
      await page.click('[data-geste-confirme="kill"]');
      await page.waitForSelector('.avertissement', { timeout: 15000 });
      const issue = await page.textContent('.avertissement');
      assert.match(issue, /ne tournait pas/);
      assert.ok(!/panne/i.test(issue));
      // §25.1 : ce n'est pas un refus, donc pas de rouge.
      assert.equal(await page.$$eval('.refus', (l) => l.length), 0);
    }
  });
});

test('un Spark GELÉ refuse le geste et LAISSE la lecture (§37.7)', async () => {
  await parcours('geste-gel', async () => {
    // La DoD de SPK-45. On arme la protection DEPUIS L'ÉCRAN, comme un
    // exploitant, puis on la rend — les parcours partagent une pile.
    //
    // « postgres-dedie » et non « boutique » : il faut un Spark EN MARCHE, sinon
    // l'onglet Docker n'a pas d'inventaire et l'on éprouverait l'arrêt du Spark
    // au lieu du gel. Mesuré — « boutique » est arrêté dans le seed.
    await ouvrir('postgres-dedie');
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot',
                               { timeout: 10000 });
    await page.fill('#protection-mot', 'gel-des-gestes');
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Armée'), { timeout: 10000 });

    try {
      await ouvrirConteneur('helo-web-1', 'postgres-dedie');

      // Les gestes sont PRÉSENTS, désactivés et expliqués (§1.4, §37.7.3).
      const boutons = await page.$$eval('button[data-geste]',
        (l) => l.map((b) => ({ cle: b.dataset.geste, gele: b.disabled })));
      assert.ok(boutons.length >= 3, 'les gestes restent visibles');
      assert.ok(boutons.every((b) => b.gele), 'et tous sont désactivés');

      const ecran = await page.textContent('.principal');
      assert.match(ecran, /Levez la protection/);
      assert.match(ecran, /Infos/);

      // …et la LECTURE reste entière : c'est l'arbitrage du §37.7.
      assert.ok(await page.$('pre.terminal'), 'les journaux restent lisibles');
      assert.match(ecran, /Réseaux/);
      const relire = await page.$eval('[data-docker="relire"]', (b) => b.disabled);
      assert.equal(relire, false, 'relire est une lecture, pas un geste');
    } finally {
      // Ce parcours REND l'état qu'il a trouvé : laisser ce Spark armé ferait
      // échouer ceux qui le pilotent ensuite — et c'est la bonne défaillance,
      // la protection mord vraiment.
      await ouvrir('postgres-dedie');
      await page.click('[data-ouvre="protection"]');
      await page.waitForSelector('dialog.modale[open] #protection-mot',
                                 { timeout: 10000 });
      await page.fill('#protection-mot', 'gel-des-gestes');
      await page.click('dialog.modale[open] [data-engage="protection"]');
      await page.waitForFunction(
        () => document.body.innerText.includes('Désarmée'), { timeout: 10000 });
    }
  });
});

// --- SPK-45 tranche 2 · LE TERMINAL DANS UN CONTENEUR (§37.4.7) ------------

test('entrer dans un conteneur : la bannière le NOMME, le journal le distingue',
     async () => {
  await parcours('terminal-conteneur', async () => {
    // §29.3 : on y entre EN CLIQUANT depuis la fiche du conteneur.
    await ouvrirConteneur('helo-web-1');
    await page.click('button[data-docker="terminal"]');

    // La session vit sur l'onglet Terminal (SPK-DS-04), pas sous Docker.
    await page.waitForSelector('.onglet[href$="/terminal"][aria-current="page"]',
                               { timeout: 15000 });
    // Le bandeau existe aussi pendant l'ouverture ; la commande « Fermer »
    // prouve que la réponse du serveur a bien apporté le chemin conteneur.
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 15000 });

    const bandeau = await page.textContent('.bandeau-terminal');
    // §9.8 : la couleur seule ne distingue pas — le libellé le dit en toutes
    // lettres, et le conteneur est NOMMÉ. Deux conteneurs d'une même pile se
    // ressemblent, et taper la mauvaise commande dans le mauvais est l'erreur
    // que cette ligne existe pour empêcher.
    assert.match(bandeau, /Conteneur/);
    assert.match(bandeau, /pas dans le Spark/);
    assert.match(bandeau, /helo-web-1/);
    assert.match(bandeau, /\/bin\/bash/, 'le shell SONDÉ, pas un shell supposé');

    // CLAUDE.md §15 : on LIT `sparkd` pour constater l'effet.
    const { corps } = await pile.lireSparkd(
      '/v1/audit?action=spark.container_terminal_open');
    const inscrit = corps.entries[0];
    assert.ok(inscrit, 'l’ouverture doit porter l’action du CONTENEUR');
    // Même cible stable que les gestes : le conteneur est dans la charge,
    // le Spark est référencé par son identifiant, jamais par son nom mutable.
    const { corps: sparkCible } = await pile.lireSparkd('/v1/sparks/crm-production');
    assert.notEqual(sparkCible.id, sparkCible.name);
    assert.equal(inscrit.target_id, sparkCible.id);
    assert.equal(JSON.parse(inscrit.payload).container, 'helo-web-1');

    // Et elle ne se confond pas avec un terminal de Spark.
    const spark = await pile.lireSparkd('/v1/audit?action=spark.terminal_open');
    assert.ok(!JSON.stringify(spark.corps.entries).includes('helo-web-1'));
  });
});

test('fermer la session d’un conteneur, et le journal porte sa DURÉE', async () => {
  await parcours('terminal-conteneur-ferme', async () => {
    await ouvrirConteneur('helo-web-1');
    await page.click('button[data-docker="terminal"]');
    await page.waitForSelector('[data-terminal="fermer"]', { timeout: 15000 });

    // SPK-75 : quitter l'onglet ne ferme plus rien. C'est la fermeture
    // EXPLICITE qui termine la session — et c'est elle qui doit porter la durée
    // au journal, puisque c'est désormais le seul geste d'arrêt de l'opérateur.
    await page.locator('[data-terminal="fermer"]').click();
    await page.waitForSelector('[data-terminal="ouvrir"]', { timeout: 15000 });

    const { corps } = await pile.lireSparkd(
      '/v1/audit?action=spark.container_terminal_close');
    const ferme = corps.entries[0];
    assert.ok(ferme, 'la fermeture porte l’action du conteneur');
    const charge = JSON.parse(ferme.payload);
    assert.equal(charge.container, 'helo-web-1');
    assert.equal(typeof charge.duration_seconds, 'number');
    assert.equal(charge.reason, 'sortie');
  });
});

test('un conteneur SANS SHELL le dit, et n’ouvre pas de fenêtre noire', async () => {
  await parcours('terminal-conteneur-sans-shell', async () => {
    // §37.4.7 : une image « distroless » n'embarque aucun shell, et c'est un
    // choix de sécurité du locataire — pas une panne.
    const { corps: avant } = await pile.lireSparkd(
      '/v1/audit?action=spark.container_terminal_open');
    await ouvrirConteneur('distroless-1');
    await page.click('button[data-docker="terminal"]');
    await page.waitForSelector('.onglet[href$="/terminal"][aria-current="page"]',
                               { timeout: 15000 });
    await page.waitForFunction(
      () => document.body.innerText.includes('pas de shell'), { timeout: 15000 });

    const ecran = await page.textContent('.principal');
    assert.match(ecran, /pas de shell/);
    assert.match(ecran, /distroless/);
    assert.match(ecran, /pas une panne/);
    // Aucune SESSION n'est ouverte : la commande d'ouverture est toujours là,
    // et rien n'a été inscrit au journal.
    //
    // On ne mesure PAS l'absence de bannière : elle s'affiche même sans session
    // — c'est INC-10, antérieur à cette unité et laissé inchangé.
    assert.ok(await page.$('[data-terminal="ouvrir"]'),
              'le terminal du Spark reste offert : ce refus n’est pas une impasse');
    // …et rien n'est inscrit au journal : il ne s'est rien passé.
    const { corps: apres } = await pile.lireSparkd(
      '/v1/audit?action=spark.container_terminal_open');
    assert.equal(apres.entries.length, avant.entries.length);
  });
});

test('un conteneur ARRÊTÉ n’offre pas d’y entrer', async () => {
  await parcours('terminal-conteneur-arrete', async () => {
    // §1.4 : une commande qui ne peut pas aboutir n'a rien à faire à l'écran.
    await ouvrirConteneur('helo-base-1');
    assert.equal(await page.$$eval('[data-docker="terminal"]', (l) => l.length), 0);
    // …alors que la lecture, elle, reste offerte.
    assert.ok(await page.$('[data-docker="relire"]'));
  });
});

test('un Spark GELÉ laisse entrer dans un conteneur (§37.7)', async () => {
  await parcours('terminal-conteneur-gel', async () => {
    // La seconde moitié de la DoD : le gel refuse les GESTES, laisse la lecture
    // ET laisse le terminal. Le bloquer pousserait à désarmer pour regarder,
    // donc à oublier de réarmer (§35.4).
    await ouvrir('postgres-dedie');
    await page.click('[data-ouvre="protection"]');
    await page.waitForSelector('dialog.modale[open] #protection-mot',
                               { timeout: 10000 });
    await page.fill('#protection-mot', 'gel-du-terminal');
    await page.click('dialog.modale[open] [data-engage="protection"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Armée'), { timeout: 10000 });

    try {
      await ouvrirConteneur('helo-web-1', 'postgres-dedie');
      // Le bouton est là, ACTIF, malgré le gel.
      const bouton = await page.$eval('[data-docker="terminal"]', (b) => b.disabled);
      assert.equal(bouton, false, 'le terminal reste offert sous gel');

      await page.click('button[data-docker="terminal"]');
      await page.waitForSelector('[data-terminal="fermer"]', { timeout: 15000 });
      const bandeau = await page.textContent('.bandeau-terminal');
      assert.match(bandeau, /helo-web-1/);
      // …et la bannière rappelle que ce Spark est protégé (§35.4).
      assert.match(bandeau, /protégé/);
    } finally {
      await ouvrir('postgres-dedie');
      await page.click('[data-ouvre="protection"]');
      await page.waitForSelector('dialog.modale[open] #protection-mot',
                                 { timeout: 10000 });
      await page.fill('#protection-mot', 'gel-du-terminal');
      await page.click('dialog.modale[open] [data-engage="protection"]');
      await page.waitForFunction(
        () => document.body.innerText.includes('Désarmée'), { timeout: 10000 });
    }
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
