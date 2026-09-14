/**
 * @verifies docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.3.1 (la grammaire des
 * routes), §55.5 (consulter ne consomme pas, accepter vide), §55.8 (l'analyse
 * vit dans la console), §55.9 · docs/DESIGN_SYSTEM.md §14.5, §14.6, §1.3 ·
 * docs/DESIGN_SYSTEM_APP.md SPK-DS-23
 *
 * Ce que ces preuves gardent : l'écran montre CE QU'IL A COMPRIS — pas le texte
 * brut —, une ligne illisible est nommée sans que la proposition soit perdue, et
 * le chemin du fichier décide de la nature proposée sans décider à la place du
 * propriétaire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROPOSITIONS_VIDE, analyserRoutes, comprendre,
         renderPropositions } from './spark-suggestions.js';

const SUGG = (champs = {}) => ({
  kind: 'variables', nature: 'entrees', present: true,
  title: 'Variables d’environnement souhaitées', expected: '…',
  path: '/etc/spark/env.?', target: '/etc/spark/env',
  body: 'REDIS_URL=redis://cache:6379\nLOG_LEVEL=debug',
  sha256: 'abc123', ...champs,
});

const ui = (champs = {}) => ({
  ...PROPOSITIONS_VIDE, status: 'pret', cellLue: true,
  items: [SUGG()], ...champs,
});

// --- la grammaire des routes (§55.3.1) --------------------------------------

test('une route se lit « domaine port [tls|clair] », et TLS est le défaut', () => {
  const { entrees, refus } = analyserRoutes(
    '# un commentaire\nsso.exemple.fr 8080\napi.exemple.fr 3000 clair\n');
  assert.equal(refus.length, 0);
  assert.deepEqual(entrees.map((e) => [e.domaine, e.port, e.tls]), [
    ['sso.exemple.fr', 8080, true],
    ['api.exemple.fr', 3000, false],
  ]);
});

test('une ligne fautive est NOMMÉE avec son numéro, et n’emporte pas les autres', () => {
  const { entrees, refus } = analyserRoutes(
    'bon.exemple.fr 8080\npasdeport.exemple.fr\nmauvais 1234\nx.exemple.fr 99999\n'
    + 'y.exemple.fr 80 peutetre\n');
  assert.equal(entrees.length, 1, 'la ligne valide survit aux quatre autres');
  assert.deepEqual(refus.map((r) => r.ligne), [2, 3, 4, 5]);
  assert.match(refus[0].raison, /domaine, un port/);
  assert.match(refus[1].raison, /ne ressemble pas à un nom de domaine/);
  assert.match(refus[2].raison, /entre 1 et 65535/);
  assert.match(refus[3].raison, /ni « tls » ni « clair »/);
});

test('un joker est accepté : le §18.3 bis en fait un domaine légitime', () => {
  const { entrees, refus } = analyserRoutes('*.exemple.fr 8080\n');
  assert.equal(refus.length, 0);
  assert.equal(entrees[0].domaine, '*.exemple.fr');
});

// --- le chemin dit la nature, l'écran laisse le dernier mot (§55.3) ---------

test('ce qui vient de secrets.? est PRÉ-COCHÉ secret, pas décidé', () => {
  const secrets = comprendre(SUGG({ kind: 'secrets', body: 'TOKEN=abc' }));
  assert.equal(secrets.entrees[0].secret, true);

  const variables = comprendre(SUGG({ body: 'TOKEN=abc' }));
  assert.equal(variables.entrees[0].secret, false);
});

test('une proposition ABSENTE ne s’analyse pas et ne rend rien', () => {
  assert.deepEqual(comprendre(SUGG({ present: false })), { entrees: [], refus: [] });
  assert.equal(renderPropositions(ui({
    items: [SUGG({ present: false })] }), ['variables']), '');
});

// --- ce que la facette montre (§55.9) ---------------------------------------

test('chaque facette ne montre QUE les natures qui lui appartiennent', () => {
  const etat = ui({ items: [SUGG(), SUGG({ kind: 'routes', body: 'a.exemple.fr 80' })] });
  const env = renderPropositions(etat, ['variables', 'secrets']);
  assert.match(env, /Variables proposées/);
  assert.doesNotMatch(env, /Routes proposées/);

  const routes = renderPropositions(etat, ['routes']);
  assert.match(routes, /Routes proposées/);
  assert.doesNotMatch(routes, /Variables proposées/);
});

test('la bannière compte, nomme le fichier, et dit que lire ne consomme pas', () => {
  const rendu = renderPropositions(ui(), ['variables']);
  assert.match(rendu, /2 variable\(s\) proposée\(s\)/);
  assert.match(rendu, /\/etc\/spark\/env\.\?/);
  assert.match(rendu, /la lire ne l’efface pas/);
  // Le produit ne les a pas vérifiées : l'écran le dit avant de les montrer.
  assert.match(rendu, /n’a pas vérifié ces valeurs/);
});

test('rien n’est rendu quand aucune proposition n’attend', () => {
  assert.equal(renderPropositions(ui({ items: [] }), ['variables']), '');
  assert.equal(renderPropositions(PROPOSITIONS_VIDE, ['variables']), '');
});

test('le compte rendu SURVIT à la proposition qu’il décrit (§1.3, §6.11)', () => {
  // Vu à l'écran : une fois la proposition appliquée, son bloc disparaît — et
  // le compte rendu avec lui. L'exploitant venait d'agir et n'avait aucune
  // confirmation.
  const rendu = renderPropositions(ui({
    items: [SUGG({ present: false })],
    issue: { kind: 'variables', ok: true,
             message: 'Proposition appliquée, et le fichier de la cellule est vidé.' },
  }), ['variables']);
  assert.match(rendu, /class="succes"[^>]*role="status"/);
  assert.match(rendu, /Proposition appliquée/);
  // Et rien de ce qui ne sert plus : ni relecture, ni boutons.
  assert.doesNotMatch(rendu, /data-sugg-appliquer/);
  assert.doesNotMatch(rendu, /data-sugg-ouvrir/);
});

test('un compte rendu ne s’affiche PAS sur la facette d’une autre nature', () => {
  const rendu = renderPropositions(ui({
    items: [SUGG({ present: false })],
    issue: { kind: 'variables', ok: true, message: 'Appliquée.' },
  }), ['routes']);
  assert.equal(rendu, '');
});

// --- la relecture (§43.10.2, SPK-DS-23) -------------------------------------

test('la relecture montre CE QUI A ÉTÉ COMPRIS, pas le texte brut', () => {
  const rendu = renderPropositions(ui({ ouvert: 'variables' }), ['variables']);
  assert.match(rendu, /<div class="tableau-defilant"><table>/);
  assert.match(rendu, /REDIS_URL/);
  assert.match(rendu, /redis:\/\/cache:6379/);
  // Une case par ligne, et une case « secret » par ligne (§43.10.2).
  assert.match(rendu, /data-sugg-garder="variables" data-ligne="1"/);
  assert.match(rendu, /data-sugg-secret="variables" data-ligne="1"/);
});

test('une ligne ÉCARTÉE se décoche et le bouton compte les retenues', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables', exclues: { variables: new Set([2]) } }), ['variables']);
  assert.match(rendu, /Ajouter les 1 retenue\(s\)/);
  assert.match(rendu, /data-ligne="2"(?![^>]*checked)/);
});

test('tout écarter DÉSACTIVE l’ajout mais laisse le refus (§9.9)', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables', exclues: { variables: new Set([1, 2]) } }), ['variables']);
  assert.match(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
  assert.doesNotMatch(rendu, /data-sugg-refuser="variables"[^>]*disabled/);
});

test('une ligne illisible est nommée, et ne fait pas perdre les bonnes', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables',
    items: [SUGG({ body: 'BON=1\nsans_egal\n' })] }), ['variables']);
  assert.match(rendu, /BON/);
  assert.match(rendu, /1 ligne\(s\) refusée\(s\)/);
  assert.match(rendu, /ligne 2/);
  // §55.5 : le refus du produit ne consomme pas — l'écran le dit, sinon on
  // refuserait la proposition entière pour corriger une ligne.
  assert.match(rendu, /le refuser ici l’effacerait/);
});

test('une proposition ENTIÈREMENT illisible le dit au lieu d’un tableau vide', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables', items: [SUGG({ body: 'n’importe quoi\n' })] }), ['variables']);
  assert.match(rendu, /Rien de lisible dans cette proposition/);
  assert.match(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
});

test('l’écran dit que trancher VIDE le fichier, et pourquoi', () => {
  const rendu = renderPropositions(ui({ ouvert: 'variables' }), ['variables']);
  assert.match(rendu, /le fichier de la cellule\s*\n?\s*est vidé/);
  assert.match(rendu, /refusé, pas ajourné/);
  assert.match(rendu, /son auteur apprend qu’une décision a été prise/);
});

test('le compte rendu d’un refus du produit est un REFUS (§1.3)', () => {
  const rendu = renderPropositions(ui({
    issue: { kind: 'variables', ok: false,
             message: '« pris.exemple.fr » est déjà routé.' } }), ['variables']);
  assert.match(rendu, /class="refus"[^>]*role="alert"/);
  assert.match(rendu, /déjà routé/);
});

test('rien de ce qui vient de la cellule n’est injecté sans échappement', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables',
    items: [SUGG({ body: 'X=<script>alert(1)</script>' })] }), ['variables']);
  assert.doesNotMatch(rendu, /<script>alert/);
  assert.match(rendu, /&lt;script&gt;/);
});
