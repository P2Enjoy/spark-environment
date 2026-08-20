/**
 * Illustrations du manuel utilisateur, produites depuis la pile réelle.
 *
 * @spec docs/BACKLOG.md#SPK-25 · docs/DAT.md §30.1 (les illustrations sont
 *       produites, jamais collectées à la main), §28 (la pile et le seed) ·
 *       docs/MANUAL_PLAN.md · CLAUDE.md §7, §16
 *
 * Chaque image est nommée d'après le chapitre qui l'emploie. Le harnais monte sa
 * propre pile seedée : une illustration ne peut donc pas montrer un écran qui
 * n'existe plus, puisqu'elle est refaite depuis l'application à chaque exécution.
 *
 * Si un parcours change au point que le harnais n'atteint plus l'écran, il
 * ÉCHOUE — laisser en place une image périmée serait pire, parce que personne ne
 * la relit.
 */

import { chromium } from 'playwright';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { monterPile } from './pile.mjs';

const IMAGES = fileURLToPath(new URL('../docs/manuel/images/', import.meta.url));

/** Largeur du manuel : un écran de travail ordinaire, pas un mur de pixels. */
const LARGEUR = 1280;

export async function produireIllustrations({ silencieux = false } = {}) {
  await mkdir(IMAGES, { recursive: true });
  // On repart d'un dossier vide : une image dont le parcours a disparu ne doit
  // pas survivre à l'exécution qui ne la produit plus (§30.1).
  for (const fichier of await readdir(IMAGES)) {
    if (fichier.endsWith('.png')) await rm(join(IMAGES, fichier));
  }

  const pile = await monterPile();
  const navigateur = await chromium.launch();
  const page = await navigateur.newPage();
  const bruits = [];
  const RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && !RESEAU.test(m.text())) {
      bruits.push(`[${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

  const produites = [];
  const capturer = async (nom, { hauteur = 900 } = {}) => {
    await page.setViewportSize({ width: LARGEUR, height: hauteur });
    await page.screenshot({ path: join(IMAGES, `${nom}.png`) });
    produites.push(nom);
    if (!silencieux) console.log(`  ${nom}.png`);
  };

  /**
   * Pousse un quota à sa borne haute, AU CLAVIER (SPK-59, §6.9 bis).
   *
   * On ne « remplit » pas un curseur : `page.fill` rend « Malformed value » sur
   * un `input[type=range]`. « Fin » est le geste natif qui va à la borne haute —
   * la capacité TOTALE de la Forge, donc au-delà de ce qui reste libre.
   */
  const auMaximum = async (selecteur) => {
    const controle = page.locator(selecteur);
    const type = await controle.getAttribute('type');
    await controle.focus();
    if (type === 'range') await controle.press('End');
    else await controle.fill('999999');   // repli du §6.9 bis : resté une saisie
  };

  const accueil = async () => {
    await page.setViewportSize({ width: LARGEUR, height: 900 });
    await page.goto(pile.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('tbody a', { timeout: 20000 });
  };
  // SPK-33 : la fenêtre d'un Spark répartit ses facettes en onglets (§6.27).
  // Les illustrations montrent donc la facette qu'elles illustrent.
  const ouvrir = async (nom, facette = '') => {
    await accueil();
    await page.click(`tbody a:has-text("${nom}")`);
    await page.waitForSelector('.entete-entite', { timeout: 10000 });
    if (facette) {
      await page.click(`.onglet[href$="/${facette}"]`);
      await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`,
                                 { timeout: 10000 });
    }
  };

  try {
    // --- M3 · Ouvrir la console ---------------------------------------------
    await accueil();
    await capturer('m3-liste');

    // --- M3 · Déclarer un serveur (SPK-41) -----------------------------------
    await page.click('nav a[href="#/serveurs"]');
    await page.waitForSelector('#titre-serveurs', { timeout: 10000 });
    await capturer('m3-serveurs', { hauteur: 600 });

    // --- M4 · Lire les pools de ressources ----------------------------------
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await capturer('m4-pools', { hauteur: 1200 });

    // --- M5 · Créer un Spark -------------------------------------------------
    await accueil();
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });
    // Depuis les curseurs (SPK-59) le formulaire est plus haut : sans cette
    // hauteur, l'illustration coupe le bouton de création.
    await capturer('m5-formulaire', { hauteur: 1150 });

    await page.fill('#name', 'demande-trop-grande');
    // SPK-59 : la mémoire est un curseur. « Fin » le pousse à la capacité
    // totale de la Forge, au-delà de ce qui reste libre.
    await auMaximum('#memory_gib');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.refus', { timeout: 10000 });
    await capturer('m5-refus');

    // Le catalogue, puisque M5 renvoie à ce geste sans dire où il vit. On y va
    // par la navigation : Forge, puis l'onglet Images.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/images"]');
    await page.waitForSelector('#titre-catalogue', { timeout: 10000 });
    await page.click('[data-ouvre="image"]');
    await page.waitForSelector('dialog.modale[open] #image-reference', { timeout: 10000 });
    await capturer('m5-catalogue', { hauteur: 800 });

    // --- M6 · Déployer sa pile : clés et configuration SSH -------------------
    await ouvrir('crm-production', 'cles');
    await page.waitForSelector('#titre-cles', { timeout: 10000 });
    await capturer('m6-cles', { hauteur: 800 });

    // --- M7 · Exposer un domaine ---------------------------------------------
    await ouvrir('crm-production', 'routes');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('#route-domaine');
    await capturer('m7-route', { hauteur: 800 });

    // --- M8 · Exploiter au quotidien -----------------------------------------
    await ouvrir('site-vitrine');
    await capturer('m8-erreur', { hauteur: 1000 });

    // --- M8 · Protéger un Spark (SPK-34) -------------------------------------
    // « analytics » est protégé par le seed. On l'ouvre PAR SON LIEN, comme un
    // exploitant, et la fenêtre montre les deux choses à la fois : la barre qui
    // nomme la protection, et la section qui porte le geste.
    await accueil();
    await page.click('tbody a:has-text("analytics")');
    await page.waitForSelector('#titre-protection', { timeout: 10000 });
    await capturer('m8-protection', { hauteur: 900 });

    // --- M9 · Instantanés : le refus qui protège -----------------------------
    await ouvrir('crm-production', 'instantanes');
    await page.waitForSelector('#titre-instantanes');
    await page.click('[data-restaure="avant-deploiement"]');
    await page.waitForSelector('[data-confirme-restauration]');
    await page.click('[data-confirme-restauration]');
    await page.waitForSelector('[data-accepte-perte]', { timeout: 10000 });
    await capturer('m9-restauration-refusee', { hauteur: 800 });

    // --- M12 · Le journal de tous les Sparks (SPK-39) ------------------------
    // On y va par la navigation : Forge, puis l'onglet Journal. Le relevé de la
    // chaîne est déclenché, sinon l'illustration montrerait « pas encore
    // vérifiée » — ce qui est vrai mais n'illustre pas le chapitre.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/journal"]');
    await page.waitForSelector('#titre-journal-forge', { timeout: 10000 });
    await page.click('[data-action="verifier-chaine"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Chaîne intacte'), { timeout: 15000 });
    await capturer('m12-journal', { hauteur: 1000 });

    // --- M10 · Supprimer un Spark --------------------------------------------
    await ouvrir('boutique');
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('.confirmation', { timeout: 10000 });
    await capturer('m10-suppression');

    // --- M4 · LE CODE DÉPLOYÉ (SPK-53, §40.3) --------------------------------
    // L'état qui appelle un geste : la Forge en retard sur le dépôt du poste.
    // La pile de développement n'est pas estampillée, donc c'est « non
    // estampillée » qui s'affichera — l'illustration montre alors le cas que le
    // chapitre nomme en premier parmi les non-réponses.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-build', { timeout: 10000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes('Comparaison en cours'), { timeout: 15000 });
    await capturer('m4-code-deploye', { hauteur: 900 });

    // --- M6 · L'AMORÇAGE (SPK-54, §42) ---------------------------------------
    // Le relevé AVANT d'agir : c'est ce que le chapitre demande au lecteur de
    // reconnaître, et c'est l'état où il arrivera.
    await ouvrir('crm-production');
    await page.waitForSelector('#titre-amorcage', { timeout: 10000 });
    await page.click('[data-amorcage="relever"]');
    await page.waitForSelector('.liste-amorcage', { timeout: 20000 });
    await capturer('m6-amorcage', { hauteur: 1000 });

    // --- M8 · L'ONGLET DOCKER (SPK-44, §37.6) --------------------------------
    await ouvrir('crm-production');
    await page.click('.onglet[href$="/docker"]');
    await page.waitForSelector('#titre-docker', { timeout: 15000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes('Lecture de ce qui tourne'),
      { timeout: 15000 });
    await capturer('m8-docker', { hauteur: 800 });

    // --- M8 · LE SSHD MUET (SPK-43, §37.2) -----------------------------------
    // « site-vitrine » : son chemin normal meurt aussitôt dans la pile de
    // vérification, comme le fait `ssh` face à un port fermé.
    await ouvrir('site-vitrine');
    await page.click('.onglet[href$="/terminal"]');
    await page.waitForSelector('#titre-terminal', { timeout: 10000 });
    await page.click('[data-terminal="ouvrir"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Ce Spark est en erreur')
         || document.body.innerText.includes('Aucun serveur SSH ne répond'),
      { timeout: 20000 });
    await capturer('m8-sshd-muet', { hauteur: 1050 });

    // --- M8 · LE TERMINAL DE DÉPANNAGE (SPK-43, §37.3) -----------------------
    // C'est la confirmation qui doit être illustrée : elle NOMME le pouvoir
    // employé, et c'est ce que le chapitre demande au lecteur de reconnaître.
    // « site-vitrine » est en erreur dans le seed, donc le chemin est ouvert.
    await ouvrir('site-vitrine');
    await page.click('.onglet[href$="/terminal"]');
    await page.waitForSelector('#titre-terminal', { timeout: 10000 });
    await page.click('[data-terminal="depanner"]');
    await page.waitForSelector('[data-terminal="depanner-confirme"]', { timeout: 10000 });
    await capturer('m8-depannage', { hauteur: 900 });

    // --- M12 · L'ANCRE QUI ALERTE (SPK-38) -----------------------------------
    // EN DERNIER, et cela doit le rester : la coupe ci-dessous ampute le journal
    // de la pile et n'est pas annulable. Toute illustration produite après elle
    // montrerait un journal amputé sans que rien ne le dise.
    //
    // Le verrou d'immuabilité refuse ce DELETE : on lève le déclencheur puis on
    // le rétablit. C'est le pouvoir que l'ancre suppose à l'adversaire — qui a
    // pris la main sur la Forge — et non un contournement du produit.
    await accueil();
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await page.click('.onglet[href="#/forge/journal"]');
    await page.waitForSelector('#titre-journal-forge', { timeout: 10000 });
    await page.click('[data-action="verifier-chaine"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Chaîne intacte'), { timeout: 15000 });
    await pile.alterer(
      'DROP TRIGGER audit_log_immuable_delete;\n'
      + 'DELETE FROM audit_log WHERE id > '
      + '(SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 2);\n'
      + 'CREATE TRIGGER audit_log_immuable_delete\n'
      + 'BEFORE DELETE ON audit_log\n'
      + 'BEGIN\n'
      + "    SELECT RAISE(ABORT, 'audit_log est en ecriture seule : DELETE refuse');\n"
      + 'END;');
    await page.click('[data-action="verifier-chaine"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Le journal a raccourci'), { timeout: 15000 });
    await capturer('m12-ancre-alerte', { hauteur: 700 });
  } finally {
    await navigateur.close();
    await pile.demonter();
  }

  if (bruits.length) {
    throw new Error(
      `L'application a écrit dans la console pendant la production des ` +
      `illustrations :\n  ${[...new Set(bruits)].join('\n  ')}`,
    );
  }
  return produites;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  produireIllustrations()
    .then((p) => { console.log(`\n  ${p.length} illustrations dans docs/manuel/images/`); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
