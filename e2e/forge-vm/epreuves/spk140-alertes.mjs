/**
 * Épreuve sur la VM du banc : un gabarit d'alerte refusé garde ce qu'on a tapé.
 *
 * @verifies docs/BACKLOG.md#SPK-140 · docs/DAT.md §47.3.0 bis (un refus garde la
 *           saisie, sauf le mot de passe) · docs/DESIGN_SYSTEM.md §6.11, §7.1 ·
 *           docs/BACKLOG.md#SPK-136 (le refus a la forme `.refus`) · CLAUDE.md §16
 *
 * Le parcours d'un exploitant : l'accueil, la Forge, l'onglet Alertes ; un
 * gabarit qui nomme un champ inconnu, refusé par la VRAIE `sparkd` de la VM ;
 * puis le gabarit corrigé, accepté. L'adresse du canal ne mène nulle part
 * (`127.0.0.1:9`) : aucune alerte ne sort du banc.
 */
import { accueil, capturer, ouvrirNavigateur } from './commun.mjs';

const ADRESSE = 'http://127.0.0.1:9/banc';
const REFUSE = '{"content": "{inconnu}"}';
const ACCEPTE = '{"content": "{action} sur {target_id}"}';
const MOT = 'mot-de-passe-du-banc';

export default async function jouer({ console: url, verdict, dire }) {
  const { navigateur, page, bruits } = await ouvrirNavigateur();
  try {
    await accueil(page, url);
    await page.click('nav a[href="#/forge"]');
    await page.click('.onglet[href="#/forge/alertes"]');
    await page.waitForSelector('#formulaire-alertes', { timeout: 30000 });

    await page.fill('#alerte-url', ADRESSE);
    await page.fill('#alerte-gabarit', REFUSE);
    await page.check('#alerte-actif');
    await page.fill('#alerte-mot', MOT);
    await page.click('#formulaire-alertes button[type="submit"]');
    await page.waitForSelector('#formulaire-alertes .refus[role="alert"]', { timeout: 30000 });
    const raison = (await page.innerText('#formulaire-alertes .refus')).trim();
    dire(`refus de la Forge : ${raison}`);
    await capturer(page, 'spk140-vm-refus-garde-la-saisie');

    const garde = {
      gabarit: await page.inputValue('#alerte-gabarit'),
      adresse: await page.inputValue('#alerte-url'),
      veille: await page.isChecked('#alerte-actif'),
      mot: await page.inputValue('#alerte-mot'),
    };
    verdict('SPK-140 : le refus s’affiche, sous la forme d’un refus', /inconnu/.test(raison), raison);
    verdict('SPK-140 : le gabarit refusé reste dans le champ', garde.gabarit === REFUSE, garde.gabarit);
    verdict('SPK-140 : l’adresse tapée reste dans le champ', garde.adresse === ADRESSE, garde.adresse);
    verdict('SPK-140 : la case « Le canal veille » garde son état', garde.veille === true,
            String(garde.veille));
    verdict('SPK-140 : le mot de passe n’est pas réécrit dans la page', garde.mot === '',
            garde.mot ? 'réécrit' : 'vide');

    // Corriger, sans rien retaper d'autre que le mot de passe.
    await page.fill('#alerte-gabarit', ACCEPTE);
    await page.fill('#alerte-mot', MOT);
    await page.click('#formulaire-alertes button[type="submit"]');
    await page.waitForSelector('#formulaire-alertes .succes[role="status"]', { timeout: 30000 });
    await capturer(page, 'spk140-vm-gabarit-corrige');
    verdict('SPK-140 : le gabarit corrigé est enregistré', true,
            (await page.innerText('#formulaire-alertes .succes')).trim());
    verdict('la console n’a rien écrit d’anormal', bruits.length === 0, bruits.join(' | ') || 'rien');
  } finally {
    await navigateur.close();
  }
}
