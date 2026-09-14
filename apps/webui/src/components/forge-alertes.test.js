/**
 * L'onglet des canaux d'alerte.
 *
 * @verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (la configuration au
 *           registre), §47.3.0 bis (l'onglet et ce qu'il montre), §47.3.1 (le
 *           gabarit), §47.3.3 (le mot de passe à chaque écriture),
 *           §14.6 (les états se distinguent), §43.3 (un secret ne s'affiche
 *           pas) · docs/DESIGN_SYSTEM.md §6.13, §1.5 bis
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ALERTES_VIDE, etatDuCanal, renderAlertes } from './forge-alertes.js';

const pret = (config, live) => renderAlertes({
  ...ALERTES_VIDE, status: 'ready', config, live });

const CONFIG = (webhook, guard = true) => ({ guard_set: guard, webhook });


// --- les QUATRE états, jamais confondus (§14.6) ------------------------------

test('les quatre états d’un canal sont DISTINCTS', () => {
  assert.equal(etatDuCanal({ enabled: false, configured: false }, {}), 'absent');
  assert.equal(etatDuCanal({ enabled: false, configured: true }, {}), 'desactive');
  assert.equal(etatDuCanal({ enabled: true }, { misconfigured: true }), 'malconfigure');
  assert.equal(etatDuCanal({ enabled: true }, { failed: 2 }), 'echec');
  assert.equal(etatDuCanal({ enabled: true }, { failed: 0, dropped: 0 }), 'actif');
});

test('« mal configuré » l’emporte sur « en échec », et c’est l’ordre qui compte', () => {
  // Un canal qui n'a RIEN TENTÉ n'a rien raté. Dire « en échec » enverrait
  // chercher une panne de réseau là où il y a une faute de gabarit.
  assert.equal(etatDuCanal({ enabled: true }, { misconfigured: true, failed: 3 }),
               'malconfigure');
});

test('aucun canal n’est dit sans être peint comme une panne', () => {
  const html = pret(CONFIG({ enabled: false, configured: false }, false), {});
  assert.match(html, /Aucun canal n’est configuré/);
  assert.match(html, /rien\s+n’est surveillé/);
  assert.match(html, /Ce n’est pas une panne/);
});

test('« désactivé » DIT que l’adresse est conservée', () => {
  // Sans quoi on la ressaisirait par prudence, alors qu'elle est là.
  const html = pret(CONFIG({ enabled: false, configured: true, host: 'a.test' }), {});
  assert.match(html, /configuré mais désactivé/);
  assert.match(html, /adresse est conservée/);
});

test('un canal MAL CONFIGURÉ nomme le champ refusé, en alerte', () => {
  const html = pret(CONFIG({ enabled: true, configured: true }),
                    { misconfigured: true, unknown_fields: ['payload'] });
  assert.match(html, /role="alert"/);
  assert.match(html, /payload/);
  assert.match(html, /avant<\/strong> l’incident/);
});

test('un canal EN ÉCHEC dit que les gestes, eux, ont abouti', () => {
  const html = pret(CONFIG({ enabled: true, configured: true }),
                    { failed: 1, last_error: 'HTTP Error 400: Bad Request' });
  assert.match(html, /ne sont pas parties/);
  assert.match(html, /ont abouti/);
  assert.match(html, /HTTP Error 400/);
});


// --- ce qui veille, et d'où ça vient (§47.3.0 bis, point 1) ------------------

test('une Forge qui tourne encore sur la VARIABLE le dit', () => {
  // Le taire ferait régler cet écran sans effet et sans le savoir — le pire des
  // deux, parce que l'écran dirait alors le contraire de ce qui se passe.
  const html = pret(CONFIG({ enabled: false, configured: false }),
                    { source: 'environnement', configured: true });
  assert.match(html, /variable d’environnement/);
  assert.match(html, /data-source="environnement"/);
});

test('une Forge réglée au REGISTRE ne porte pas cet avertissement', () => {
  const html = pret(CONFIG({ enabled: true, configured: true }),
                    { source: 'registre' });
  assert.ok(!/data-source="environnement"/.test(html));
});


// --- ce qui ne s'affiche JAMAIS (§43.3) --------------------------------------

test('l’adresse du webhook ne s’affiche NULLE PART', () => {
  const html = pret(CONFIG({
    enabled: true, configured: true, host: 'discord.com',
    // Même si l'appelant la passait par erreur, l'écran ne doit pas la rendre.
    url: 'https://discord.com/api/webhooks/1/JETON-SECRET',
  }), {});
  assert.ok(!/JETON-SECRET/.test(html),
    'qui détient l’adresse peut écrire à votre place : elle ne se montre pas');
  assert.match(html, /discord\.com/, 'son hôte suffit à reconnaître le canal');
  assert.match(html, /ne s’affiche pas/);
});

test('le champ d’adresse annonce que le laisser vide CONSERVE l’existant', () => {
  const html = pret(CONFIG({ enabled: true, configured: true, host: 'a.test' }), {});
  assert.match(html, /placeholder="inchangée"/);
});


// --- le mot de passe, à CHAQUE écriture (§47.3.3) ----------------------------

test('le champ du mot de passe est DANS le formulaire, pas dans une modale', () => {
  const html = pret(CONFIG({ enabled: true, configured: true }), {});
  const formulaire = html.slice(html.indexOf('id="formulaire-alertes"'));
  assert.match(formulaire, /id="alerte-mot"/);
  assert.match(formulaire, /type="password"/);
  assert.match(html, /pas de session déverrouillée/);
});

test('quand AUCUN mot de passe n’est fixé, l’écran dit que celui-ci le deviendra', () => {
  // Poser un garde sans le savoir serait pire que ne pas en poser.
  const html = pret(CONFIG({ enabled: false, configured: false }, false), {});
  assert.match(html, /Aucun mot de passe n’est encore fixé/);
  assert.match(html, /deviendra le mot de passe/);
});


// --- ce que l'onglet NE FAIT PAS (§47.3.0 bis) -------------------------------

test('aucun bouton n’envoie un message d’ESSAI', () => {
  // Un canal qu'on peut faire parler sur commande apprend à son destinataire
  // que certains messages ne comptent pas.
  const html = pret(CONFIG({ enabled: true, configured: true }), {});
  assert.ok(!/essayer|tester|test\b/i.test(html),
    'la seule épreuve d’un canal est un vrai geste sensible');
});


// --- les états de l'écran lui-même (§6.13) -----------------------------------

test('les trois états de l’écran sont traités', () => {
  assert.match(renderAlertes({ ...ALERTES_VIDE, status: 'loading' }), /aria-busy="true"/);
  assert.match(renderAlertes({ ...ALERTES_VIDE, status: 'error', error: 'tunnel fermé' }),
               /tunnel fermé/);
  assert.match(pret(CONFIG({ enabled: true, configured: true }), {}), /formulaire-alertes/);
});

test('un refus du serveur s’affiche MOT POUR MOT et la saisie reste', () => {
  const html = renderAlertes({
    ...ALERTES_VIDE, status: 'ready', config: CONFIG({ enabled: true, configured: true }),
    live: {}, refus: 'Mot de passe refusé : la configuration n’est pas modifiée.' });
  assert.match(html, /Mot de passe refusé/);
  assert.match(html, /role="alert"/);
  assert.match(html, /id="formulaire-alertes"/, 'le formulaire reste en place');
});
