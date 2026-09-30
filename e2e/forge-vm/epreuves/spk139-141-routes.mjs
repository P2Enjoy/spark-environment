/**
 * Épreuve sur la VM du banc : le refus d'un geste de route se lit dans sa ligne,
 * et une route ne sort du registre qu'une fois Caddy confirmé.
 *
 * @verifies docs/BACKLOG.md#SPK-139 · docs/DESIGN_SYSTEM_APP.md SPK-DS-36 (le
 *           refus dans la ligne, le focus rendu au bouton de la ligne) ·
 *           docs/DESIGN_SYSTEM.md §7.1, §9.7
 * @verifies docs/BACKLOG.md#SPK-141 · docs/DAT.md §18.8 (poser sans la route,
 *           relire Caddy, et seulement alors retirer) · manuel M7 · CLAUDE.md §16
 *
 * Tout se crée par la console, depuis l'accueil (DAT §51.6) : le Spark, sa
 * route, sa protection. Deux refus RÉELS de la `sparkd` de la VM :
 *
 *   1. le Spark est protégé — `423` ;
 *   2. Caddy est arrêté — `502`, et la route doit RESTER. L'arrêt de Caddy est la
 *      reproduction de l'incident, faite sur la VM par SSH, comme on
 *      reproduirait une panne : aucun geste du produit ne l'arrête.
 *
 * Les effets sont constatés aussi côté serveur — le registre par l'API, la
 * configuration vivante de Caddy par son API d'administration —, jamais
 * supposés depuis l'écran.
 */
import { accueil, capturer, ouvrirNavigateur, ouvrirSpark } from './commun.mjs';

const SPARK = 'epreuve-routes';
const DOMAINE = 'epreuve.banc.test';
const MOT = 'protection-du-banc';

const ligne = (page) => page.locator(`li:has(span.technique:text-is("${DOMAINE}"))`);

async function retirer(page) {
  await ligne(page).locator(`[data-retire-route="${DOMAINE}"]`).click();
  await page.click(`[data-confirme-route="${DOMAINE}"]`);
}

async function protection(page, { armer }) {
  await page.click('[data-ouvre="protection"]');
  await page.waitForSelector('dialog.modale[open] #protection-mot');
  await page.fill('#protection-mot', MOT);
  await page.click('dialog.modale[open] [data-engage="protection"]');
  await page.waitForFunction((attendu) => document.body.innerText.includes(attendu),
                             armer ? 'Armée' : 'Désarmée', { timeout: 60000 });
}

export default async function jouer({ console: url, verdict, dire, ssh, api, jusqua }) {
  const { navigateur, page, bruits } = await ouvrirNavigateur();
  const auRegistre = () => (api('GET', '/v1/ingress').routes ?? [])
    .some((r) => r.domain === DOMAINE);
  const servieParCaddy = () => ssh('curl -s -m 5 http://127.0.0.1:2019/config/',
                                   { tolerer: true }).sortie.includes(`"${DOMAINE}"`);
  try {
    // --- le Spark, créé par la console --------------------------------------
    await accueil(page, url);
    await page.click('a[href="#/creer"]');
    await page.waitForSelector('#formulaire-spark', { timeout: 30000 });
    await page.fill('#name', SPARK);
    // L'image que le banc a déjà tirée : pas de second téléchargement.
    await page.selectOption('#image', 'images:ubuntu/24.04');
    await page.fill('#memory_gib', '0.5');
    await page.fill('#storage_gib', '2');
    await page.fill('#network_mbit', '50');
    await page.click('#formulaire-spark button[type="submit"]');
    await page.waitForSelector('.entete-entite', { timeout: 60000 });
    await page.click('[data-commande="apply"]');
    await page.waitForSelector('[data-commande="start"]', { timeout: 300000 });
    await page.click('[data-commande="start"]');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 600000 });
    dire(`Spark « ${SPARK} » créé, appliqué et démarré depuis la console`);

    // --- sa route, par la modale de la section ------------------------------
    await page.click('.onglet[href$="/routes"]');
    await page.click('[data-ouvre="route"]');
    await page.waitForSelector('dialog.modale[open] #route-domaine');
    await page.fill('#route-domaine', DOMAINE);
    await page.fill('#route-port', '8080');
    await page.uncheck('#route-tls');
    await page.click('dialog.modale[open] [data-engage="route"]');
    await ligne(page).waitFor({ timeout: 60000 });
    verdict('la route se déclare depuis la console', auRegistre() && servieParCaddy(),
            `registre : ${auRegistre()}, Caddy : ${servieParCaddy()}`);

    // --- 1. SPK-139 : le refus d'un Spark protégé, dans la ligne -------------
    await ouvrirSpark(page, url, SPARK);
    await page.waitForSelector('#titre-protection', { timeout: 30000 });
    await protection(page, { armer: true });
    await page.click('.onglet[href$="/routes"]');
    await ligne(page).waitFor({ timeout: 30000 });
    await retirer(page);
    await ligne(page).locator('.refus[role="alert"]').waitFor({ timeout: 30000 });
    const refusProtege = (await ligne(page).locator('.refus').innerText()).trim();
    const focusProtege = await page.evaluate(
      () => document.activeElement?.getAttribute('data-retire-route'));
    await capturer(page, 'spk139-vm-refus-protege-dans-la-ligne');
    verdict('SPK-139 : le refus d’un Spark protégé se lit DANS la ligne de la route',
            /protég/i.test(refusProtege), refusProtege);
    verdict('SPK-139 : le focus revient au bouton « Retirer » de la ligne',
            focusProtege === DOMAINE, String(focusProtege));
    verdict('SPK-139 : la route protégée est toujours au registre', auRegistre(), 'relu par l’API');
    await ouvrirSpark(page, url, SPARK);
    await page.waitForSelector('#titre-protection', { timeout: 30000 });
    await protection(page, { armer: false });

    // --- 2. SPK-141 : Caddy arrêté, le retrait refusé, la route RESTE ---------
    ssh('sudo systemctl stop caddy-api.service');
    dire('Caddy arrêté sur la VM : reproduction de l’incident');
    await page.click('.onglet[href$="/routes"]');
    await ligne(page).waitFor({ timeout: 30000 });
    await retirer(page);
    await ligne(page).locator('.refus[role="alert"]').waitFor({ timeout: 30000 });
    const refusCaddy = (await ligne(page).locator('.refus').innerText()).trim();
    await capturer(page, 'spk141-vm-caddy-arrete-la-route-reste');
    verdict('SPK-141 : Caddy arrêté, le retrait est refusé et le dit dans la ligne',
            /pas retiré|Caddy/i.test(refusCaddy), refusCaddy);
    verdict('SPK-141 : Caddy arrêté, la route RESTE au registre', auRegistre(), 'relu par l’API');
    // Relue par la console, comme l'exploitant qui revient sur la page.
    await ouvrirSpark(page, url, SPARK, 'routes');
    const toujours = await ligne(page).count();
    verdict('SPK-141 : revenue sur la page, la route est toujours listée', toujours === 1,
            `${toujours} ligne(s)`);

    // --- Caddy revenu, le retrait aboutit --------------------------------------
    ssh('sudo systemctl start caddy-api.service');
    await jusqua('Caddy répond', () => ssh('curl -s -m 3 -o /dev/null -w "%{http_code}" '
      + 'http://127.0.0.1:2019/config/', { tolerer: true }).sortie === '200', { delai: 60, pas: 2 });
    await retirer(page);
    await ligne(page).waitFor({ state: 'detached', timeout: 60000 });
    await capturer(page, 'spk141-vm-retrait-confirme');
    verdict('SPK-141 : Caddy revenu, la route est retirée du registre', !auRegistre(),
            'relu par l’API');
    verdict('SPK-141 : …et Caddy ne la sert plus', !servieParCaddy(),
            'configuration vivante relue');
    verdict('la console n’a rien écrit d’anormal', bruits.length === 0, bruits.join(' | ') || 'rien');
  } finally {
    await navigateur.close();
  }
}
