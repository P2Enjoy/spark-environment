/**
 * L'onglet des canaux d'alerte.
 *
 * @verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (la configuration au
 *           registre), §47.3.0 bis (l'onglet et ce qu'il montre), §47.3.1 (le
 *           gabarit), §47.3.3 (le mot de passe à chaque écriture),
 *           §14.6 (les états se distinguent), §43.3 (un secret ne s'affiche
 *           pas) · docs/DESIGN_SYSTEM.md §6.13, §1.5 bis
 * @verifies docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 · docs/DESIGN_SYSTEM_APP.md
 *           SPK-DS-40 (l'aperçu du message, sous le gabarit)
 * @verifies docs/BACKLOG.md#SPK-147 · docs/DAT.md §47.3.1 (les dix champs offerts)
 * @verifies docs/BACKLOG.md#SPK-140 · docs/DAT.md §47.3.0 bis (un refus garde
 *           la saisie, sauf le mot de passe) · docs/DESIGN_SYSTEM.md §6.11, §7.1
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ALERTES_VIDE, etatDuCanal, renderAlertes, renderApercu, saisieAlertes } from './forge-alertes.js';

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


// --- SPK-140 · §47.3.0 bis : un refus garde la saisie ------------------------

const REFUSE = 'Le gabarit nomme un champ que l’alerte ne publie pas : inconnu.';
const TAPE = { url: 'https://hooks.exemple.test/abc', template: '{"content": "{inconnu}"}',
               enabled: false };

test('au REFUS, le gabarit, l’adresse et la case gardent ce qui a été tapé', () => {
  const html = renderAlertes({
    ...ALERTES_VIDE, status: 'ready', live: {}, refus: REFUSE, saisie: TAPE,
    config: CONFIG({ enabled: true, configured: true, host: 'hooks.exemple.test',
                     template: '{"content": "{action}"}' }) });
  assert.match(html, /<textarea[^>]*id="alerte-gabarit"[^>]*>\{&quot;content&quot;: &quot;\{inconnu\}&quot;\}<\/textarea>/,
               'le gabarit refusé reste dans le champ');
  assert.ok(!html.includes('{&quot;content&quot;: &quot;{action}&quot;}'),
            'le gabarit du registre ne remplace pas la saisie');
  assert.match(html, /id="alerte-url"[^>]*value="https:\/\/hooks\.exemple\.test\/abc"/,
               'l’adresse tapée reste dans le champ');
  assert.doesNotMatch(html, /id="alerte-actif"[^>]*checked/, 'la case décochée reste décochée');
  assert.match(html, new RegExp(REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('le MOT DE PASSE n’est jamais réécrit dans la page', () => {
  const html = renderAlertes({
    ...ALERTES_VIDE, status: 'ready', live: {}, refus: REFUSE,
    saisie: { ...TAPE, password: 'ne-doit-pas-revenir' },
    config: CONFIG({ enabled: true, configured: true }) });
  assert.ok(!html.includes('ne-doit-pas-revenir'));
  assert.doesNotMatch(html, /id="alerte-mot"[^>]*value=/);
});

test('sans saisie retenue, le formulaire montre la configuration RELUE', () => {
  const html = pret(CONFIG({ enabled: true, configured: true, template: '{"text": "{action}"}' }), {});
  assert.match(html, /\{&quot;text&quot;: &quot;\{action\}&quot;\}<\/textarea>/);
  assert.match(html, /id="alerte-actif"[^>]*checked/);
  assert.doesNotMatch(html, /id="alerte-url"[^>]*value=/, 'l’adresse du registre ne s’affiche jamais');
});

test('la saisie retenue au refus ne garde ni le mot de passe, ni rien d’autre', () => {
  const donnees = new FormData();
  donnees.set('webhook_url', '  https://hooks.exemple.test/abc ');
  donnees.set('webhook_template', '{"content": "{inconnu}"}');
  donnees.set('password', 'secret');
  assert.deepEqual(saisieAlertes(donnees), {
    url: 'https://hooks.exemple.test/abc', template: '{"content": "{inconnu}"}', enabled: false });
  donnees.set('webhook_enabled', 'on');
  assert.equal(saisieAlertes(donnees).enabled, true);
});


// --- SPK-147 · §47.3.1 : l'aide nomme les DIX champs que la Forge accepte ------

test('l’aide du gabarit nomme les dix champs, ni plus ni moins', () => {
  const html = pret(CONFIG({ enabled: true, configured: true }), {});
  const aide = html.slice(html.indexOf('id="alerte-gabarit-aide"'));
  const nommes = [...aide.slice(0, aide.indexOf('</p>')).matchAll(/<code>([a-z_]+)<\/code>/g)]
    .map((m) => m[1]).filter((n) => !['champ'].includes(n));
  assert.deepEqual(nommes, ['version', 'ts', 'forge', 'action', 'actor', 'actor_class',
                            'target_type', 'target_id', 'result', 'message']);
});

// --- SPK-151 · SPK-DS-40 : l'aperçu du message, sous le gabarit ---------------

test('le formulaire porte « Voir le message » et sa zone d’aperçu, annoncée', () => {
  const html = pret(CONFIG({ enabled: true, configured: true }), {});
  assert.match(html, /<button type="button" class="bouton" data-alertes-apercu>Voir le message<\/button>/);
  assert.match(html, /id="alerte-apercu" role="status"/);
});

test('l’aperçu montre le message dans un bloc à chasse fixe, sur l’événement d’exemple', () => {
  const html = renderApercu({ status: 'ready', rendered: '{"text": "a <b>"}',
                              unknown_fields: [], valid_json: true });
  assert.match(html, /Sur un événement d’exemple — la levée d’une protection/);
  assert.match(html, /<pre class="fragment technique bloc-cle" tabindex="0">\{&quot;text&quot;: &quot;a &lt;b&gt;&quot;\}<\/pre>/);
  assert.doesNotMatch(html, /avertissement/);
});

test('un champ inconnu est un AVERTISSEMENT, pas un refus', () => {
  const html = renderApercu({ status: 'ready', rendered: null,
                              unknown_fields: ['inconnu'], valid_json: null });
  assert.match(html, /class="avertissement"[^>]*>Champ inconnu : <code>inconnu<\/code>/);
  assert.doesNotMatch(html, /class="refus"/);
  assert.doesNotMatch(html, /<pre/);
});

test('un message qui n’est pas du JSON le dit, sous le message', () => {
  const html = renderApercu({ status: 'ready', rendered: 'Alerte : x',
                              unknown_fields: [], valid_json: false });
  assert.match(html, /<pre[^>]*>Alerte : x<\/pre>/);
  assert.match(html, /n’est pas un document JSON/);
});

test('le calcul en cours et l’échec se disent', () => {
  assert.match(renderApercu({ status: 'loading' }), /Calcul du message…/);
  assert.match(renderApercu({ status: 'error', error: 'tunnel fermé' }),
               /class="refus"[^>]*>tunnel fermé/);
  assert.equal(renderApercu(null), '');
});


// --- SPK-62 · §47.3.2 : le canal COURRIEL, sa carte et son formulaire ----------

import { saisieSmtp } from './forge-alertes.js';

const SMTP = (extra = {}) => ({ enabled: true, configured: true, host: 'smtp.exemple.fr', port: 587,
  tls: 'starttls', username: 'alerte', from: 'forge@exemple.fr', to: 'admin@exemple.fr',
  password_set: true, ...extra });
const pretSmtp = (smtp, liveSmtp = {}, extra = {}) => renderAlertes({
  ...ALERTES_VIDE, status: 'ready', live: {}, liveSmtp,
  config: { guard_set: true, webhook: { enabled: false, configured: false }, smtp }, ...extra });

test('la carte courriel porte son formulaire, ses champs étiquetés et son mot de passe du garde', () => {
  const html = pretSmtp(SMTP());
  const f = html.slice(html.indexOf('id="formulaire-smtp"'));
  for (const id of ['smtp-hote', 'smtp-port', 'smtp-tls', 'smtp-compte', 'smtp-secret', 'smtp-de', 'smtp-a',
    'smtp-actif', 'smtp-mot']) {
    assert.match(f, new RegExp(`id="${id}"`), id);
    assert.match(f, id === 'smtp-actif' ? /for="smtp-actif"/ : new RegExp(`for="${id}"`), `label de ${id}`);
  }
  assert.match(f, /type="password"[^>]*name="password"|name="password"[^>]*type="password"|id="smtp-mot"/);
});

test('le formulaire courriel montre la configuration RELUE, sans le mot de passe du compte', () => {
  const html = pretSmtp(SMTP({ password_set: true }));
  assert.match(html, /id="smtp-hote"[^>]*value="smtp\.exemple\.fr"/);
  assert.match(html, /id="smtp-port"[^>]*value="587"/);
  assert.match(html, /<option value="starttls" selected>/);
  assert.match(html, /id="smtp-compte"[^>]*value="alerte"/);
  assert.match(html, /Un mot de passe est enregistré<\/strong> ; il ne s’affiche pas/);
  assert.match(html, /id="smtp-secret"[^>]*placeholder="inchangé"/);
  assert.doesNotMatch(html, /id="smtp-secret"[^>]*value=/);
  assert.match(html, /id="smtp-actif"[^>]*checked/);
});

test('l’écran dit que le certificat est TOUJOURS vérifié, et qu’un mot de passe ne part pas en clair', () => {
  const html = pretSmtp(SMTP());
  assert.match(html, /toujours vérifié/);
  assert.match(html, /ne part jamais en clair/);
});

test('aucun bouton n’envoie un courriel d’épreuve : la seule épreuve est un vrai geste', () => {
  const html = pretSmtp(SMTP());
  assert.ok(!/essayer|tester|\btest\b/i.test(html.slice(html.indexOf('id="formulaire-smtp"'))));
});

test('un canal courriel non configuré le dit, sans parler d’une panne', () => {
  const html = pretSmtp({ enabled: false, configured: false, password_set: false });
  const carte = html.slice(html.indexOf('id="formulaire-smtp"'));
  assert.match(carte, /Ce canal n’est pas configuré/);
  assert.match(carte, /Aucun mot de passe n’est enregistré/);
});

test('les états du canal courriel sont distincts et dits pour LUI', () => {
  const sur = (smtp, live) => pretSmtp(smtp, live).slice(pretSmtp(smtp, live).indexOf('id="formulaire-smtp"'));
  assert.match(sur(SMTP({ enabled: false }), {}), /canal courriel est configuré mais désactivé/);
  assert.match(sur(SMTP(), { failed: 2, last_error: 'timed out' }), /Des courriels ne sont pas partis[\s\S]*ont abouti/);
  assert.match(sur(SMTP(), { failed: 2, last_error: 'timed out' }), /timed out/);
  assert.match(sur(SMTP(), { misconfigured: true }), /role="alert"[\s\S]*ressaisissez-le/);
  assert.match(sur(SMTP(), {}), /Le canal courriel veille/);
});

test('« aucun canal » ne se dit PAS quand le courriel veille, même sans webhook', () => {
  const html = pretSmtp(SMTP(), {});
  assert.doesNotMatch(html, /Aucun canal n’est configuré/);
  assert.doesNotMatch(html, /rien\s+n’est surveillé/);
});

test('les compteurs sont PAR canal : le courriel ne montre pas ceux du webhook', () => {
  const html = renderAlertes({
    ...ALERTES_VIDE, status: 'ready', live: { sent: 7, failed: 0 }, liveSmtp: { sent: 1, failed: 4 },
    config: { guard_set: true, webhook: { enabled: true, configured: true }, smtp: SMTP() } });
  const webhook = html.slice(html.indexOf('id="titre-webhook"'), html.indexOf('id="formulaire-smtp"'));
  const courriel = html.slice(html.indexOf('id="formulaire-smtp"'));
  assert.match(webhook, /Envoyées<\/dt><dd>7<\/dd>/);
  assert.match(courriel, /Envoyées<\/dt><dd>1<\/dd>/);
  assert.match(courriel, /En échec<\/dt><dd>4<\/dd>/);
});

test('un refus du courriel s’affiche DANS son formulaire et garde la saisie, sans aucun mot de passe', () => {
  const html = renderAlertes({
    ...ALERTES_VIDE, status: 'ready', live: {}, liveSmtp: {},
    config: { guard_set: true, webhook: { enabled: false, configured: false }, smtp: SMTP({ host: 'ancien.fr' }) },
    smtp: { refus: 'Un mot de passe ne part pas en clair : un compte exige le mode starttls ou tls.',
            enregistre: null,
            saisie: { host: 'nouveau.fr', port: '25', tls: 'none', username: 'alerte', from: 'a@x.fr',
                      to: 'b@x.fr', enabled: false, password: 'NE-DOIT-PAS-REVENIR' } } });
  const carte = html.slice(html.indexOf('id="formulaire-smtp"'));
  assert.match(carte, /class="refus" role="alert">Un mot de passe ne part pas en clair/);
  assert.match(carte, /id="smtp-hote"[^>]*value="nouveau\.fr"/, 'la saisie l’emporte sur le registre');
  assert.match(carte, /<option value="none" selected>/);
  assert.doesNotMatch(carte, /id="smtp-actif"[^>]*checked/);
  assert.ok(!html.includes('NE-DOIT-PAS-REVENIR'));
  // Le refus du courriel ne s'affiche pas dans le formulaire du webhook.
  assert.doesNotMatch(html.slice(0, html.indexOf('id="formulaire-smtp"')), /ne part pas en clair/);
});

test('la saisie retenue du courriel ne garde aucun mot de passe', () => {
  const d = new FormData();
  d.set('smtp_host', ' smtp.exemple.fr '); d.set('smtp_port', '587'); d.set('smtp_tls', 'tls');
  d.set('smtp_username', 'alerte'); d.set('smtp_from', 'a@x.fr'); d.set('smtp_to', 'b@x.fr');
  d.set('smtp_password', 'secret'); d.set('password', 'garde');
  const s = saisieSmtp(d);
  assert.deepEqual(s, { host: 'smtp.exemple.fr', port: '587', tls: 'tls', username: 'alerte',
    from: 'a@x.fr', to: 'b@x.fr', enabled: false });
  assert.ok(!JSON.stringify(s).includes('secret') && !JSON.stringify(s).includes('garde'));
});
