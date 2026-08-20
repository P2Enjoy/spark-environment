/**
 * @verifies docs/BACKLOG.md#SPK-39 · docs/DAT.md §36.8 (ce que l'onglet rend),
 *           §36.8 bis (son contrat), §36.4 (deux classes), §21.6.2 (l'identité
 *           attribue, elle ne prouve pas) · docs/DESIGN_SYSTEM.md §6.13, §6.14
 *
 * Le point qui décide de la forme de cet écran : une chaîne intacte AVEC une
 * ancre qui alerte est exactement la troncature — le cas le plus important de
 * tout le dispositif. Ces tests interdisent qu'un seul indicateur les résume.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderJournalHote, renderIntegrite, renderAuteurCellule,
  VERDICTS, FILTRES_VIDES,
} from './host-journal.js';
import { ONGLETS_FORGE } from './host-images.js';

const ENTREES = [
  { ts: '2026-08-19T10:00:00', action: 'spark.create', result: 'ok',
    actor: 'console/prod key=SHA256:AbCd', actor_class: 'human',
    message: 'Spark « crm » enregistré.' },
  { ts: '2026-08-19T10:00:01', action: 'spark.settle', result: 'ok',
    actor: 'sparkd', actor_class: 'runtime', message: '« starting » → « running ».' },
  { ts: '2026-08-19T09:00:00', action: 'spark.create', result: 'denied',
    actor: 'inconnu', actor_class: 'human', message: 'Capacité insuffisante.' },
];

const pret = (surcharge = {}) => renderJournalHote({
  status: 'ready', entries: ENTREES, filtres: FILTRES_VIDES, ...surcharge });

// --- la destination (§36.8.1) ----------------------------------------------

test('le journal est un onglet de l’HÔTE, à côté de Pools et Images', () => {
  const chemins = ONGLETS_FORGE.map(([href]) => href);
  assert.deepEqual(chemins, ['#/forge', '#/forge/images', '#/forge/journal']);
});

test('l’écran dit qu’il couvre TOUS les Sparks', () => {
  // Sans quoi on le confondrait avec la facette d'un Spark, qui répond à une
  // autre question.
  assert.match(pret(), /sur tous les Sparks/);
});

// --- LE POINT QUI DÉCIDE : chaîne et ancre ne se résument pas ---------------

test('une chaîne INTACTE avec une ancre qui ALERTE montre les DEUX', () => {
  // C'est exactement la troncature : la chaîne restante est valide, seule la
  // console voit qu'il en manque. « Tout va bien » serait faux (§36.8.4).
  const html = renderIntegrite({
    chain: { intact: true, checked: 3, verified_at: '2026-08-19T10:00:00', break: null },
    anchor: { verdict: 'shrunk', explanation: 'Le journal a RACCOURCI.',
              known: { length: 9 }, announced: { length: 3 } },
  });
  assert.match(html, /Chaîne intacte/);
  assert.match(html, /Le journal a raccourci/);
  assert.match(html, /badge--danger/, 'le verdict d’alerte porte la couleur d’alerte');
  assert.match(html, /avait retenu 9 entrée\(s\)/);
  assert.match(html, /annonce 3/);
});

test('une chaîne ROMPUE désigne la ligne et dit ce qui s’est passé', () => {
  const recrite = renderIntegrite({
    chain: { intact: false, checked: 2, verified_at: 't',
             break: { id: 42, reason: 'entry_hash', ts: 't', action: 'spark.create' } },
  });
  assert.match(recrite, /rompue à l’entrée 42/);
  assert.match(recrite, /a été récrite/);

  const retiree = renderIntegrite({
    chain: { intact: false, checked: 2, verified_at: 't',
             break: { id: 7, reason: 'prev_hash', ts: 't', action: 'x' } },
  });
  assert.match(retiree, /retirée ou insérée/);
});

test('sans relevé, l’écran le DIT au lieu d’afficher « intacte »', () => {
  // Une intégrité supposée est précisément ce que ce dispositif existe pour ne
  // pas laisser croire (§36.8.3).
  const html = renderIntegrite({});
  assert.match(html, /n’a pas encore été vérifiée/);
  assert.ok(!html.includes('Chaîne intacte'));
});

test('l’écran ne prétend JAMAIS qu’une entrée est signée', () => {
  // §36.8.5 : une page entière consacrée à l'intégrité est l'endroit où l'on
  // croirait le plus volontiers à une garantie qui n'existe pas encore.
  const html = pret({ chain: { intact: true, checked: 3, verified_at: 't', break: null } });
  assert.match(html, /Aucune entrée n’est signée/);
  assert.ok(!/\bsigné par\b/.test(html));
});

test('les cinq verdicts existent, et SEULS les deux dangereux sont en danger', () => {
  assert.deepEqual(Object.keys(VERDICTS).sort(),
                   ['diverged', 'extends', 'first', 'shrunk', 'unchanged']);
  assert.equal(VERDICTS.shrunk.token, 'danger');
  assert.equal(VERDICTS.diverged.token, 'danger');
  for (const sain of ['first', 'extends', 'unchanged']) {
    assert.notEqual(VERDICTS[sain].token, 'danger',
      'une ancre neuve ou une histoire qui prolonge n’est pas une anomalie');
  }
});

// --- le tableau et ses auteurs (§6.14, §36.4) -------------------------------

test('les entrées sont dans un VRAI tableau', () => {
  const html = pret();
  for (const balise of ['<table>', '<thead>', '<tbody>', '<th scope="col">'])
    assert.ok(html.includes(balise), `${balise} attendu (§6.14)`);
});

test('un événement du serveur ne se confond pas avec un geste humain', () => {
  assert.match(renderAuteurCellule({ actor: 'sparkd', actor_class: 'runtime' }),
               /automatique/);
  assert.match(renderAuteurCellule({ actor: 'console/prod', actor_class: 'human' }),
               /console\/prod/);
});

test('un auteur non déclaré le DIT, sans afficher la valeur technique', () => {
  const html = renderAuteurCellule({ actor: 'inconnu', actor_class: 'human' });
  assert.match(html, /auteur non déclaré/);
  assert.ok(!html.includes('>inconnu<'));
});

// --- les états de vue (§6.13) -----------------------------------------------

test('chargement, erreur et vide sont traités explicitement', () => {
  assert.match(renderJournalHote({ status: 'loading' }), /aria-busy/);
  assert.match(renderJournalHote({ status: 'error', error: { message: 'tunnel rompu' } }),
               /etat-vue--erreur[\s\S]*tunnel rompu/);
  assert.match(renderJournalHote({ status: 'ready', entries: [] }),
               /Aucune opération enregistrée/);
});

test('un vide PAR FILTRE ne se confond pas avec un journal vide', () => {
  // §6.13 : un état vide ne propose une action que si elle est pertinente. Ici
  // elle l'est — élargir. Sur un journal réellement vide, elle ne l'est pas.
  const filtre = renderJournalHote({
    status: 'ready', entries: [], filtres: { ...FILTRES_VIDES, action: 'spark' } });
  assert.match(filtre, /ce sont les filtres qui excluent tout/);
  assert.match(filtre, /data-action="filtres-vides"/);

  const vide = renderJournalHote({ status: 'ready', entries: [], filtres: FILTRES_VIDES });
  assert.ok(!vide.includes('data-action="filtres-vides"'),
    'sur un journal vide, élargir ne servirait à rien');
});

test('les filtres conservent ce qui a été saisi', () => {
  const html = pret({ filtres: { ...FILTRES_VIDES, action: 'snapshot', actor: 'console',
                                 result: 'denied', actor_class: 'human' } });
  assert.match(html, /id="filtre-action"[^>]*value="snapshot"/);
  assert.match(html, /id="filtre-actor"[^>]*value="console"/);
  assert.match(html, /<option value="denied" selected>/);
  assert.match(html, /<option value="human" selected>/);
});

test('l’écran rappelle que les lectures ne sont pas journalisées', () => {
  // Sinon un exploitant chercherait longtemps qui a consulté quoi.
  assert.match(pret(), /lectures ne sont pas journalisées/);
});
