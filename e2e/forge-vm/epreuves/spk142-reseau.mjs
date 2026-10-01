/**
 * Épreuve sur la VM du banc : la réservation et le plafond réseau se règlent
 * séparément, et le plafond atteint la carte du Spark.
 *
 * @verifies docs/BACKLOG.md#SPK-142 · docs/DAT.md §49.7 (deux valeurs, trois
 *           contrôles de cohérence, le plafond posé sur `eth0`) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-37 · manuels M5, M8 · CLAUDE.md §16
 *
 * Le cas signalé par le responsable le 2026-10-01, rejoué par la console : un
 * Spark créé à 10 Mbit/s, dont on monte la réservation à 100 Mbit/s. Puis le
 * plafond monté à son tour, et RELU là où il agit : la configuration du device
 * `eth0`, et la classe `htb` que le noyau a posée sur l'interface de la cellule.
 */
import { capturer, ouvrirNavigateur, ouvrirSpark, accueil } from './commun.mjs';

const SPARK = 'epreuve-reseau';

export default async function jouer({ console: url, verdict, dire, ssh, api }) {
  const { navigateur, page, bruits } = await ouvrirNavigateur();
  const lu = () => api('GET', `/v1/sparks/${SPARK}`);
  const surLaCarte = () => ssh(`sudo incus config device get ${SPARK} eth0 limits.max`,
                               { tolerer: true }).sortie;
  /** La classe htb du noyau, sur l'interface de la cellule côté Forge. */
  const classeHtb = () => {
    const etat = ssh(`sudo incus query /1.0/instances/${SPARK}/state`, { tolerer: true }).sortie;
    let interfaceHote = '';
    try { interfaceHote = JSON.parse(etat).network.eth0.host_name; } catch { return '?'; }
    return ssh(`tc class show dev ${interfaceHote}`, { tolerer: true }).sortie;
  };
  try {
    // --- le Spark, créé à 10 Mbit/s : le plafond SUIT la réservation ----------
    await accueil(page, url);
    await page.click('a[href="#/creer"]');
    await page.waitForSelector('#formulaire-spark', { timeout: 30000 });
    await page.fill('#name', SPARK);
    await page.selectOption('#image', 'images:ubuntu/24.04');
    await page.fill('#memory_gib', '0.5');
    await page.fill('#storage_gib', '2');
    await page.fill('#network_mbit', '10');
    const suit = await page.inputValue('#burst_mbit');
    await page.click('#formulaire-spark button[type="submit"]');
    await page.waitForSelector('.entete-entite', { timeout: 60000 });
    await page.click('[data-commande="apply"]');
    await page.waitForSelector('[data-commande="start"]', { timeout: 300000 });
    await page.click('[data-commande="start"]');
    await page.waitForSelector('[data-commande="stop"]', { timeout: 600000 });
    const cree = lu();
    verdict('SPK-142 : à la création, le plafond suit la réservation', suit === '10'
            && cree.network_burst_bps === 10_000_000,
            `curseur ${suit}, registre ${cree.network_burst_bps}`);

    // --- le cas signalé : la réservation montée seule, au-dessus du plafond -----
    await ouvrirSpark(page, url, SPARK);
    await page.click('[data-ouvre="quotas"]');
    await page.waitForSelector('dialog.modale[open] #quota-network');
    await page.fill('#quota-network', '100');
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForSelector('dialog.modale[open] .refus', { timeout: 30000 });
    const refus = (await page.innerText('dialog.modale[open] .refus')).trim();
    await capturer(page, 'spk142-vm-plafond-sous-la-reservation');
    verdict('SPK-142 : réservation au-dessus du plafond, refus NOMMÉ (plus de 500)',
            /plafond réseau \(10 Mbit\/s\) est sous la réservation \(100 Mbit\/s\)/.test(refus), refus);
    verdict('SPK-142 : la saisie reste dans la modale',
            (await page.inputValue('#quota-network')) === '100', await page.inputValue('#quota-network'));
    verdict('SPK-142 : rien n’a été écrit', lu().network_reservation_bps === 10_000_000,
            String(lu().network_reservation_bps));

    // --- le plafond monté à son tour : accepté, et posé sur la carte ---------------
    await page.fill('#quota-burst', '200');
    await page.click('dialog.modale[open] [data-engage="quotas"]');
    await page.waitForSelector('dialog.modale[open]', { state: 'detached', timeout: 60000 });
    const apres = lu();
    await page.locator('#titre-ressources').scrollIntoViewIfNeeded();
    await capturer(page, 'spk142-vm-reservation-et-plafond');
    const fiche = await page.innerText('section[aria-labelledby="titre-ressources"]');
    verdict('SPK-142 : les deux valeurs sont au registre', apres.network_reservation_bps === 100_000_000
            && apres.network_burst_bps === 200_000_000,
            `${apres.network_reservation_bps} / ${apres.network_burst_bps}`);
    verdict('SPK-142 : la fiche montre les deux', /Réservation réseau\s+100 Mbit\/s/.test(fiche)
            && /Plafond réseau\s+200 Mbit\/s/.test(fiche), fiche.replace(/\s+/g, ' ').slice(0, 200));
    const carte = surLaCarte();
    verdict('SPK-142 : le plafond est posé sur eth0', carte === '200000000', carte || 'vide');
    const htb = classeHtb();
    dire(`classe htb relevée : ${htb.replace(/\s+/g, ' ').slice(0, 200)}`);
    verdict('SPK-142 : le noyau applique le nouveau plafond À CHAUD', /rate 200Mbit/.test(htb),
            htb.replace(/\s+/g, ' ').slice(0, 120) || 'aucune classe');
    verdict('la console n’a rien écrit d’anormal', bruits.length === 0, bruits.join(' | ') || 'rien');
  } finally {
    await navigateur.close();
  }
}
