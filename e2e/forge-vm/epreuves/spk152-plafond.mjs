/**
 * Épreuve sur la VM du banc : le mode CPU « partagé plafonné », de la création au
 * plafond appliqué par le redémarrage — dans la peau de l'exploitant.
 *
 * @verifies docs/BACKLOG.md#SPK-152 · docs/DAT.md §7.2 quater (traduction, contrôles
 *           de cohérence), §7.7 (l'admission compte la réservation), §49.8 (le
 *           plafond prend effet au démarrage ; l'écran le dit et offre le geste) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-41 · docs/SCHEMA.md §12.3 bis
 *           (la Forge fraîche passe la migration 022) · manuels M5, M8 ·
 *           CLAUDE.md §16
 *
 * Les gestes passent par la console, à la souris et au clavier. Ce qui se relit
 * ailleurs se relit là où le produit agit : le registre, et le `cpu.max` du cgroup
 * de la cellule, avec la part de CPU que deux boucles occupées y obtiennent.
 */
import { capturer, ouvrirNavigateur, ouvrirSpark, accueil, attendreTexte } from './commun.mjs';

const SPARK = 'epreuve-plafond';
const CG = `/sys/fs/cgroup/spark.slice/${SPARK}`;
const FICHE = 'section[aria-labelledby="titre-ressources"]';
const ANNONCE = `${FICHE} .plafond-attente`;

export default async function jouer({ console: url, verdict, dire, ssh, api }) {
  const { navigateur, page, bruits } = await ouvrirNavigateur();
  const sh = (commande) => ssh(commande, { tolerer: true, delai: 300 });
  const lu = () => api('GET', `/v1/sparks/${SPARK}`);
  const cpuMax = () => sh(`sudo cat ${CG}/cpu.max`).sortie.trim();
  /** La part de CPU prise par deux boucles occupées, sur 6 s. */
  const charge = () => {
    const r = sh(`sudo sh -c 'incus exec ${SPARK} -- sh -c "(while :; do :; done) >/dev/null 2>&1 & `
      + `(while :; do :; done) >/dev/null 2>&1 &"; sleep 2; `
      + `t0=$(date +%s%N); a0=$(grep "^usage_usec" ${CG}/cpu.stat | cut -d" " -f2); sleep 6; `
      + `t1=$(date +%s%N); a1=$(grep "^usage_usec" ${CG}/cpu.stat | cut -d" " -f2); `
      + `incus exec ${SPARK} -- pkill -f "while :"; echo $a0 $a1 $t0 $t1'`).sortie;
    const [a0, a1, t0, t1] = r.trim().split(/\s+/).map(Number);
    return (a1 - a0) / ((t1 - t0) / 1000);
  };
  const ouvrirLaModale = async () => {
    await page.click('[data-ouvre="quotas"]');
    await page.waitForSelector('dialog.modale[open] #quota-cpu_max');
  };
  const engager = () => page.click('dialog.modale[open] [data-engage="quotas"]');
  const fiche = async () => (await page.innerText(FICHE)).replace(/\s+/g, ' ');

  try {
    // --- la Forge fraîche a passé la migration 022 -------------------------------
    const pret = api('GET', '/readyz');
    verdict('SPK-152 : la Forge fraîche sert le schéma 22', pret.schema_version === 22,
            JSON.stringify(pret).slice(0, 160));

    // --- la création : le mode, ses deux champs, et un refus NOMMÉ -----------------
    await accueil(page, url);
    await page.click('a[href="#/creer"]');
    await page.waitForSelector('#formulaire-spark', { timeout: 30000 });
    await page.fill('#name', SPARK);
    await page.selectOption('#image', 'images:ubuntu/24.04');
    await page.selectOption('#cpu_mode', 'shared-capped');
    await page.waitForSelector('#formulaire-spark #cpu_max');
    const formulaire = await page.innerText('#formulaire-spark');
    verdict('SPK-DS-41 : à la création, réservation puis plafond, avec leur aide',
            formulaire.indexOf('Réservation CPU') < formulaire.indexOf('Plafond CPU')
            && /Jamais dépassé — prend effet au démarrage\./.test(formulaire),
            formulaire.replace(/\s+/g, ' ').slice(0, 160));
    await page.fill('#memory_gib', '0.5');
    await page.fill('#storage_gib', '2');
    await page.fill('#cpu_reservation', '1');
    await page.fill('#cpu_max', '0.5');
    await page.click('#formulaire-spark button[type="submit"]');
    await attendreTexte(page, '#formulaire-spark .refus', /sous la réservation/);
    const refusCreation = (await page.innerText('#formulaire-spark .refus')).replace(/\s+/g, ' ');
    await capturer(page, 'spk152-vm-creation-refus');
    verdict('SPK-152 : un plafond sous la réservation est refusé, et la raison se lit',
            /Le plafond CPU \(0,5 CPU\) est sous la réservation \(1 CPU\)/.test(refusCreation), refusCreation);
    verdict('SPK-152 : la saisie reste en place', (await page.inputValue('#cpu_max')) === '0.5',
            await page.inputValue('#cpu_max'));

    await page.fill('#cpu_reservation', '0.5');
    await page.fill('#cpu_max', '0.75');
    await page.click('#formulaire-spark button[type="submit"]');
    await page.waitForSelector('.entete-entite', { timeout: 60000 });
    await page.click('[data-commande="apply"]');
    await page.waitForSelector('[data-commande="start"]', { timeout: 300000 });
    await page.click('[data-commande="start"]');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 600000 });
    const cree = lu();
    verdict('SPK-152 : le registre porte le mode et ses deux valeurs',
            cree.cpu_mode === 'shared-capped' && cree.cpu_reservation === 0.5 && cree.cpu_max === 0.75,
            `${cree.cpu_mode} ${cree.cpu_reservation} ${cree.cpu_max}`);
    const forge = api('GET', '/v1/forge');
    dire(`pool CPU après création : ${JSON.stringify(forge.pools.cpu)}`);

    // --- au premier démarrage, le plafond est dans la tranche, et il tient --------
    const premier = cpuMax();
    const chargePremiere = charge();
    dire(`cpu.max ${premier} · charge ${chargePremiere.toFixed(2)} CPU`);
    verdict('SPK-152 : au démarrage, cpu.max porte le plafond', premier === '75000 100000', premier);
    verdict('SPK-152 : deux boucles occupées ne dépassent pas 0,75 CPU',
            chargePremiere <= 0.80 && chargePremiere >= 0.65, chargePremiere.toFixed(2));
    await ouvrirSpark(page, url, SPARK);
    await page.locator('#titre-ressources').scrollIntoViewIfNeeded();
    await capturer(page, 'spk152-vm-fiche-plafond-en-vigueur');
    const ficheEnVigueur = await fiche();
    verdict('SPK-DS-41 : la fiche dit les deux valeurs',
            /0,50 CPU réservés · plafond 0,75 CPU/.test(ficheEnVigueur), ficheEnVigueur.slice(0, 160));
    verdict('SPK-152 : plafond en vigueur — aucune annonce', (await page.$(ANNONCE)) === null,
            'annonce présente');

    // --- dans la modale : un refus nommé, puis un plafond monté ---------------------
    await ouvrirLaModale();
    await page.fill('#quota-cpu_max', '0.25');
    await engager();
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 30000 });
    const refusModale = (await page.innerText('dialog.modale[open] .refus')).replace(/\s+/g, ' ');
    await capturer(page, 'spk152-vm-modale-refus');
    verdict('SPK-152 : la modale montre le refus de la Forge, saisie intacte',
            /sous la réservation/.test(refusModale)
            && (await page.inputValue('#quota-cpu_max')) === '0.25', refusModale);

    await page.fill('#quota-cpu_max', '1.25');
    await engager();
    await page.waitForSelector('dialog.modale[open]', { state: 'detached', timeout: 60000 });
    await page.waitForSelector(ANNONCE, { timeout: 30000 });
    const annonce = (await page.innerText(ANNONCE)).replace(/\s+/g, ' ');
    await page.locator('#titre-ressources').scrollIntoViewIfNeeded();
    await capturer(page, 'spk152-vm-plafond-en-attente');
    await capturer(page, 'spk152-vm-plafond-en-attente-mobile', { largeur: 390, hauteur: 900 });
    verdict('SPK-DS-41 : l’annonce dit la promesse et ce qui est en vigueur',
            /en attente du démarrage/.test(annonce)
            && /Plafond de 1,25 CPU : prendra effet au prochain démarrage\. En vigueur : 0,75 CPU\./.test(annonce)
            && /Redémarrer pour l’appliquer/.test(annonce), annonce);
    const pasAChaud = cpuMax();
    verdict('SPK-152 : le nouveau plafond n’est PAS appliqué à chaud', pasAChaud === '75000 100000',
            pasAChaud);

    // --- le geste, à la souris : le plafond prend effet -------------------------------
    await page.click('[data-plafond-redemarrer]');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 600000 });
    await page.waitForSelector('#titre-ressources', { timeout: 60000 });
    const apresRedemarrage = cpuMax();
    const chargeApres = charge();
    dire(`après le redémarrage : cpu.max ${apresRedemarrage} · charge ${chargeApres.toFixed(2)} CPU`);
    verdict('SPK-152 : après « Redémarrer pour l’appliquer », cpu.max porte 1,25 CPU',
            apresRedemarrage === '125000 100000', apresRedemarrage);
    verdict('SPK-152 : la part de CPU suit le nouveau plafond',
            chargeApres <= 1.32 && chargeApres >= 1.0, chargeApres.toFixed(2));
    await ouvrirSpark(page, url, SPARK);
    verdict('SPK-152 : relu « appliqué », l’annonce a disparu', (await page.$(ANNONCE)) === null,
            'annonce encore là');

    // --- une réservation reposée à chaud efface le plafond : l'écran le DIT ------------
    await ouvrirLaModale();
    await page.fill('#quota-cpu_reservation', '0.75');
    await engager();
    await page.waitForSelector('dialog.modale[open]', { state: 'detached', timeout: 60000 });
    const efface = cpuMax();
    dire(`après la réservation reposée : cpu.max ${efface}`);
    await page.waitForSelector(ANNONCE, { timeout: 30000 });
    const annonceEfface = (await page.innerText(ANNONCE)).replace(/\s+/g, ' ');
    await page.locator('#titre-ressources').scrollIntoViewIfNeeded();
    await capturer(page, 'spk152-vm-plafond-efface-se-voit');
    verdict('SPK-152 : un plafond effacé par Incus se voit, il ne disparaît pas en silence',
            efface.startsWith('max') && /En vigueur : aucun plafond\./.test(annonceEfface),
            `${efface} · ${annonceEfface}`);

    // --- le même geste, au clavier ---------------------------------------------------
    await page.focus('[data-plafond-redemarrer]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 600000 });
    await page.waitForFunction(() => document.activeElement?.id === 'titre-ressources',
                               null, { timeout: 60000 }).catch(() => {});
    const focus = await page.evaluate(() => document.activeElement?.id ?? '');
    verdict('SPK-DS-41 : après le geste, le focus est au titre de la section', focus === 'titre-ressources',
            focus || 'body');
    verdict('SPK-152 : au clavier aussi, le plafond revient', cpuMax() === '125000 100000', cpuMax());
    await capturer(page, 'spk152-vm-plafond-reapplique');
    verdict('la console n’a rien écrit d’anormal', bruits.length === 0, bruits.join(' | ') || 'rien');
  } finally {
    await navigateur.close();
  }
}
