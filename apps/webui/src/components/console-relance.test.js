/**
 * L'avertissement « Console à redémarrer » et son geste.
 *
 * @verifies docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.4 (ce que l'écran fait) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-11 (révisé), SPK-DS-09, SPK-DS-08 ·
 *           docs/DESIGN_SYSTEM.md §1.4 (pas de commande morte), §6.22, §9.7
 * @verifies docs/BACKLOG.md#SPK-65 · docs/DAT.md §40.5 (l'avertissement ne
 *           paraît que sur une console périmée)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderBuildConsole, nommerSession, sessionsOuvertes, RELANCE_VIDE }
  from './console-relance.js';

const PERIMEE = { verdict: 'perimee', title: 'Console à redémarrer',
  detail: 'Console démarrée avant 2 commits · redémarrer pour en bénéficier.',
  relaunchable: true, instance: 'a' };

const phase = (p, extra = {}) => ({ ...RELANCE_VIDE, phase: p, ...extra });

test('rien n’est rendu tant que la console n’est pas périmée', () => {
  for (const verdict of ['a_jour', 'depot_recule', 'indisponible']) {
    assert.equal(renderBuildConsole({ ...PERIMEE, verdict }), '');
  }
  assert.equal(renderBuildConsole(null), '');
});

test('une console périmée et relançable porte le bouton sous son texte', () => {
  const html = renderBuildConsole(PERIMEE);
  assert.match(html, /role="status"/);
  assert.match(html, /Console à redémarrer/);
  assert.match(html, /2 commits/);
  assert.match(html, /<button[^>]*data-relance="ouvrir"[^>]*>Redémarrer la console<\/button>/);
  assert.doesNotMatch(html, /confirmation/, 'rien ne se confirme avant le geste');
});

test('sans lanceur, aucun bouton — ni actif ni désactivé —, une phrase qui dit comment faire', () => {
  const html = renderBuildConsole({ ...PERIMEE, relaunchable: false });
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /se redémarre à la main/);
});

test('la confirmation est en accent, dans le flux, et nomme chaque session qui sera fermée', () => {
  const html = renderBuildConsole(PERIMEE, phase('confirmation', { sessions: [
    { id: '1', spark: 'helo', type: 'spark' },
    { id: '2', spark: 'helo', container: 'helo-web-1', type: 'container' },
  ] }));
  assert.match(html, /class="confirmation confirmation--sensible confirmation--laterale"/);
  assert.match(html, /role="group" aria-labelledby="titre-relance-console"/);
  assert.match(html, /id="titre-relance-console"/);
  assert.match(html, /Ces 2 sessions de terminal seront fermées/);
  assert.match(html, /<li>helo<\/li>/);
  assert.match(html, /<li>helo · conteneur helo-web-1<\/li>/);
  // SPK-DS-09 : un geste qui interrompt n'a pas le bouton de celui qui détruit.
  assert.doesNotMatch(html, /bouton--destructif/);
  assert.match(html, /data-relance="engager"[^>]*>Redémarrer<\/button>/);
  assert.match(html, /data-relance="annuler"[^>]*>Annuler<\/button>/);
  assert.doesNotMatch(html, /data-relance="ouvrir"/, 'le déclencheur cède la place au bloc');
});

test('sans session, la confirmation le dit au lieu de se taire', () => {
  const html = renderBuildConsole(PERIMEE, phase('confirmation'));
  assert.match(html, /Aucune session de terminal n’est ouverte/);
  assert.doesNotMatch(html, /<ul>/);
});

test('une seule session s’écrit au singulier', () => {
  const html = renderBuildConsole(PERIMEE, phase('confirmation', {
    sessions: [{ id: '1', spark: 'helo', type: 'spark' }] }));
  assert.match(html, /Cette session de terminal sera fermée/);
});

test('pendant le préflight, les deux boutons sont présents et désactivés, et l’écran dit pourquoi', () => {
  const html = renderBuildConsole(PERIMEE, phase('envoi'));
  assert.match(html, /data-relance="engager"\s+disabled/);
  assert.match(html, /data-relance="annuler"\s+disabled/);
  assert.match(html, /role="status">Vérification que le nouveau code se charge/);
});

test('un refus est rouge, annoncé, garde le bouton, et montre la sortie du préflight', () => {
  const html = renderBuildConsole(PERIMEE, phase('repos', { refus: {
    message: 'Le nouveau code ne se charge pas : la console courante continue de servir.',
    output: 'host/dns.js:382\nSyntaxError: <token>' } }));
  assert.match(html, /class="refus refus--laterale" role="alert"/);
  assert.match(html, /continue de servir/);
  assert.match(html, /<pre class="refus__sortie">host\/dns\.js:382\nSyntaxError: &lt;token&gt;<\/pre>/);
  assert.match(html, /data-relance="ouvrir"/, 'le geste reste offert après un refus');
});

test('pendant l’attente, l’avertissement dit le redémarrage et n’offre plus rien', () => {
  const html = renderBuildConsole(PERIMEE, phase('attente'));
  assert.match(html, /role="status"/);
  assert.match(html, /Redémarrage de la console…/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /Console à redémarrer/, 'on ne dit pas « à redémarrer » pendant qu’on redémarre');
});

test('une console qui ne revient pas est une alerte en accent, jamais un refus rouge', () => {
  const html = renderBuildConsole(PERIMEE, phase('muette'));
  assert.match(html, /class="avertissement avertissement--laterale" role="alert"/);
  assert.doesNotMatch(html, /class="refus/);
  assert.match(html, /30 s/);
  assert.match(html, /make runProd/);
});

test('le texte venu de l’hôte est échappé', () => {
  const html = renderBuildConsole({ ...PERIMEE, detail: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/);
});

test('une session se nomme comme dans le widget, et seules les vivantes comptent', () => {
  assert.equal(nommerSession({ spark: 'helo', type: 'rescue' }), 'helo · dépannage');
  assert.deepEqual(sessionsOuvertes([
    { id: 'a', state: 'open' }, { id: 'b', state: 'closed', closed: true }, null,
  ]).map((s) => s.id), ['a']);
});
