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

    // --- M4 · Lire les pools de ressources ----------------------------------
    await page.click('nav a[href="#/hote"]');
    await page.waitForSelector('#titre-pools', { timeout: 10000 });
    await capturer('m4-pools', { hauteur: 1200 });

    // --- M5 · Créer un Spark -------------------------------------------------
    await accueil();
    await page.click('.titre-vue .bouton--primaire');
    await page.waitForSelector('#formulaire-spark', { timeout: 10000 });
    await capturer('m5-formulaire');

    await page.fill('#name', 'demande-trop-grande');
    await page.fill('#memory_gib', '512');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.refus', { timeout: 10000 });
    await capturer('m5-refus');

    // --- M6 · Déployer sa pile : clés et configuration SSH -------------------
    await ouvrir('crm-production', 'cles');
    await page.waitForSelector('#titre-cles', { timeout: 10000 });
    await capturer('m6-cles', { hauteur: 1400 });

    // --- M7 · Exposer un domaine ---------------------------------------------
    await ouvrir('crm-production', 'routes');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('#route-domaine');
    await capturer('m7-route', { hauteur: 1400 });

    // --- M8 · Exploiter au quotidien -----------------------------------------
    await ouvrir('site-vitrine');
    await capturer('m8-erreur', { hauteur: 1000 });

    // --- M9 · Instantanés : le refus qui protège -----------------------------
    await ouvrir('crm-production', 'instantanes');
    await page.waitForSelector('#titre-instantanes');
    await page.click('[data-restaure="avant-deploiement"]');
    await page.waitForSelector('[data-confirme-restauration]');
    await page.click('[data-confirme-restauration]');
    await page.waitForSelector('[data-accepte-perte]', { timeout: 10000 });
    await capturer('m9-restauration-refusee', { hauteur: 1400 });

    // --- M10 · Supprimer un Spark --------------------------------------------
    await ouvrir('boutique');
    await page.click('[data-commande="delete"]');
    await page.waitForSelector('.confirmation', { timeout: 10000 });
    await capturer('m10-suppression');
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
