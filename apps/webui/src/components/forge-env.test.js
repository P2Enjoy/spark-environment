/**
 * Le catalogue d'environnement de la Forge.
 *
 * @verifies docs/BACKLOG.md#SPK-64 · docs/DAT.md §43.6 révisé, §43.3 (la valeur
 *           d'un secret ne sort jamais), §43.5.1 ·
 *           docs/DESIGN_SYSTEM.md §6.13 (états d'une vue), §14.5, §14.6
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderForgeEnv, decrireDescente, CATALOGUE_VIDE } from './forge-env.js';

const ENTREES = [
  { name: 'TZ', is_secret: false, value: 'Europe/Paris', selected_by: 2,
    updated_at: '2026-08-21T10:00:00+00:00' },
  { name: 'SMTP_PASSWORD', is_secret: true, value: null, fingerprint: 'ab12cd34',
    selected_by: 1, updated_at: '2026-08-21T10:00:00+00:00' },
  { name: 'OBJECT_STORAGE_URL', is_secret: false, value: 'https://s3.example',
    selected_by: 0, updated_at: '2026-08-21T10:00:00+00:00' },
];

test('« ne descend nulle part » est un ÉTAT, pas un petit nombre', () => {
  // §14.6 : zéro ne se range pas avec un et deux. Une entrée définie que
  // personne ne reçoit ressemble sinon à une entrée active.
  assert.equal(decrireDescente(0).texte, 'Ne descend nulle part');
  assert.notEqual(decrireDescente(0).token, decrireDescente(1).token);
  assert.equal(decrireDescente(1).texte, 'Descend dans 1 Spark');
  assert.equal(decrireDescente(4).texte, 'Descend dans 4 Sparks');
});

test('l’écran DIT qu’écrire ici ne distribue rien', () => {
  // C'est la phrase qui empêche la méprise que l'unité corrige : on écrit au
  // catalogue en croyant avoir posé une valeur quelque part.
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES });
  assert.match(rendu, /ne descend <strong>nulle part<\/strong>/);
});

test('la valeur d’un secret n’atteint jamais l’écran', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES });
  // Chercher « null » dans toute la page donnait un faux positif : « nulle
  // part » le contient. La preuve vise donc la CELLULE, seul endroit où une
  // valeur s'affiche.
  assert.doesNotMatch(rendu, /<td[^>]*>\s*null\s*</,
                      'aucune cellule ne rend la valeur nulle telle quelle');
  assert.match(rendu, /ab12cd34/, 'l’empreinte, elle, permet de comparer');
  assert.match(rendu, /badge--neutral">Secret/);
});

test('une entrée qui ne descend nulle part est SIGNALÉE', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES });
  assert.match(rendu, /OBJECT_STORAGE_URL/);
  assert.match(rendu, /Ne descend nulle part/);
});

test('les états de la vue sont traités', () => {
  assert.match(renderForgeEnv({ status: 'loading' }), /aria-busy="true"/);

  const erreur = renderForgeEnv({ status: 'error', error: new Error('Tunnel rompu.') });
  assert.match(erreur, /role="alert"/);
  assert.match(erreur, /Tunnel rompu\./);

  // §14.5 : le catalogue vide dit ce qu'il implique, il ne reste pas blanc.
  const vide = renderForgeEnv({ status: 'ready', entrees: [] });
  assert.match(vide, /Aucune entrée au catalogue/);
  assert.match(vide, /Rien ne descend dans aucun/);
});

test('le tableau défile dans SON conteneur et le signale', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES });
  assert.match(rendu, /class="tableau-enveloppe"/);
  assert.match(rendu, /Le tableau défile horizontalement/);
});

test('un nom d’entrée est ÉCHAPPÉ avant d’atteindre l’écran', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: [
    { name: '<script>alert(1)</script>', is_secret: false, value: 'x',
      selected_by: 0, updated_at: '' },
  ] });
  assert.ok(!rendu.includes('<script>alert'));
  assert.match(rendu, /&lt;script&gt;/);
});

test('l’onglet du catalogue est marqué courant', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES, ui: CATALOGUE_VIDE });
  assert.match(rendu, /href="#\/forge\/environnement"[^>]*aria-current="page"/);
});

test('la saisie du catalogue précise qu’elle ne distribue rien', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES,
                                 ui: { ...CATALOGUE_VIDE, open: true } });
  assert.match(rendu, /data-modale="catalogue-env"/);
  assert.match(rendu, /ne la distribue dans aucun Spark/);
});

test('une écriture qui atteint un Spark protégé demande une confirmation explicite', () => {
  const rendu = renderForgeEnv({ status: 'ready', entrees: ENTREES,
    ui: { ...CATALOGUE_VIDE, confirming: {
      message: 'Poser « SMTP_HOST » touche 1 Spark protégé : analytics.',
      protected_sparks: ['analytics'],
    } },
  });
  assert.match(rendu, /analytics/);
  assert.match(rendu, /Continuer malgré les protections/);
  assert.match(rendu, /Aucune protection ne sera levée/);
});
