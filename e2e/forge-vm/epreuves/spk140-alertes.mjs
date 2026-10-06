/**
 * Épreuve sur la VM du banc : un gabarit d'alerte refusé garde ce qu'on a tapé.
 *
 * @verifies docs/BACKLOG.md#SPK-140 · docs/DAT.md §47.3.0 bis (un refus garde la
 *           saisie, sauf le mot de passe) · docs/DESIGN_SYSTEM.md §6.11, §7.1 ·
 *           docs/BACKLOG.md#SPK-136 (le refus a la forme `.refus`) · CLAUDE.md §16
 * @verifies docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 · docs/DESIGN_SYSTEM_APP.md
 *           SPK-DS-40 (l'aperçu du message ; le mot de passe tapé survit)
 * @verifies docs/BACKLOG.md#SPK-147 · docs/DAT.md §47.3.1 (l'aide nomme les dix
 *           champs que la Forge accepte)
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
    const aide = await page.innerText('#alerte-gabarit-aide');
    verdict('SPK-147 : l’aide du gabarit nomme les dix champs',
            ['version', 'ts', 'forge', 'action', 'actor', 'actor_class', 'target_type',
             'target_id', 'result', 'message'].every((c) => new RegExp(`\\b${c}\\b`).test(aide)),
            aide.replace(/\s+/g, ' ').slice(0, 160));

    // SPK-151 : l'aperçu, AVANT d'enregistrer — et le mot de passe déjà tapé
    // ne doit pas s'effacer.
    await page.fill('#alerte-mot', MOT);
    await page.fill('#alerte-gabarit', ACCEPTE);
    await page.click('[data-alertes-apercu]');
    await page.waitForSelector('#alerte-apercu pre', { timeout: 30000 });
    const message = await page.innerText('#alerte-apercu pre');
    await capturer(page, 'spk151-vm-apercu-du-message');
    verdict('SPK-151 : l’aperçu montre le message tel qu’il partirait',
            message === '{"content": "spark.unprotect sur exemple"}', message);
    verdict('SPK-151 : le mot de passe tapé survit à l’aperçu',
            (await page.inputValue('#alerte-mot')) === MOT, 'conservé');
    await page.fill('#alerte-gabarit', REFUSE);
    await page.click('[data-alertes-apercu]');
    await page.waitForSelector('#alerte-apercu .avertissement', { timeout: 30000 });
    const avert = await page.innerText('#alerte-apercu .avertissement');
    verdict('SPK-151 : un champ inconnu se dit AVANT d’enregistrer', /Champ inconnu : inconnu/.test(avert),
            avert);

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
