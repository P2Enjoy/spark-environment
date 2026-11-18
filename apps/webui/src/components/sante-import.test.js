/**
 * @verifies docs/BACKLOG.md#SPK-185 · docs/DAT.md §75.9 (la grammaire d'une ligne ; valider
 *           avant d'accepter ; la cible va en dernier), §55.8 (la grammaire vit dans la console)
 *
 * Ce que ces preuves verrouillent : la cible se lit jusqu'à la fin de la ligne (une commande
 * contient des espaces) ; la cadence garde ses cinq champs ; une ligne illisible n'est jamais
 * perdue en silence ; un nom déclaré deux fois est DIT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lireLigne, lireProposition, definitionDe, resume, NOM_SONDE } from './sante-import.js';

test('une ligne http se lit en six morceaux', () => {
  const { entree } = lireLigne('api http */5 * * * * 3 200 https://app.example.com/healthz');
  assert.deepEqual(entree, {
    name: 'api', kind: 'http', schedule: '*/5 * * * *', threshold: 3, expected: 200,
    target: 'https://app.example.com/healthz',
  });
});

test('la cible d\'un script est le RESTE de la ligne, espaces compris', () => {
  const { entree } = lireLigne(
    'base script */10 * * * * 2 0 docker compose -f /srv/app/compose.yml exec -T db pg_isready');
  assert.equal(entree.target, 'docker compose -f /srv/app/compose.yml exec -T db pg_isready');
  assert.equal(entree.expected, 0);
});

test('les blancs multiples sont tolérés et la cadence est normalisée', () => {
  const { entree } = lireLigne('  api   http   0   2   *   *   1-5   3   200    https://a.example.com/  ');
  assert.equal(entree.schedule, '0 2 * * 1-5');
  assert.equal(entree.target, 'https://a.example.com/');
});

test('une cible de script peut contenir des guillemets, des tubes et des dièses', () => {
  const { entree } = lireLigne('x script 0 * * * * 1 0 curl -fsS "http://localhost/ok" | grep -q "#up"');
  assert.equal(entree.target, 'curl -fsS "http://localhost/ok" | grep -q "#up"');
});

test('refus avec la raison, jamais en silence', () => {
  const cas = [
    ['api http */5 * * * * 3 200', /Format attendu/],
    ['api http */5 * * * 3 200 https://a/', /Format attendu|Seuil|attendu/],
    ['Api http */5 * * * * 3 200 https://a.example.com/', /Nom « Api » invalide/],
    ['api tcp */5 * * * * 3 200 https://a.example.com/', /Type « tcp » inconnu/],
    ['api http */5 * * * * 0 200 https://a.example.com/', /Seuil « 0 »/],
    ['api http */5 * * * * 21 200 https://a.example.com/', /Seuil « 21 »/],
    ['api http */5 * * * * x 200 https://a.example.com/', /Seuil « x »/],
    ['api http */5 * * * * 3 99 https://a.example.com/', /de 100 à 599/],
    ['api http */5 * * * * 3 200 http://a.example.com/', /https:\/\//],
    ['api http */5 * * * * 3 200 ftp://a.example.com/', /https:\/\//],
    ['base script */5 * * * * 3 256 true', /de 0 à 255/],
  ];
  for (const [ligne, raison] of cas) {
    const lue = lireLigne(ligne);
    assert.equal(lue.entree, undefined, ligne);
    assert.match(lue.raison, raison, ligne);
  }
});

test('la forme seule est vérifiée : un domaine étranger ou une cadence serrée sont du ressort du serveur', () => {
  assert.ok(lireLigne('api http */1 * * * * 3 200 https://etranger.example.net/').entree);
});

test('une proposition : commentaires et lignes vides sont ignorés, les numéros sont ceux du fichier', () => {
  const { entrees, refus } = lireProposition([
    '# Une page publique.',
    'accueil http */5 * * * * 3 200 https://crm.example.com/',
    '',
    '',
    'base script */10 * * * * 2 0 pg_isready',
  ].join('\n'));
  assert.deepEqual(entrees.map((e) => [e.name, e.ligne]), [['accueil', 2], ['base', 5]]);
  assert.equal(refus.length, 0);
});

test('l\'étiquette est le commentaire JUSTE au-dessus ; une ligne vide rompt le lien', () => {
  const { entrees } = lireProposition([
    '# Étiquette liée', 'a http */5 * * * * 3 200 https://a.example.com/',
    '# Étiquette rompue', '', 'b http */5 * * * * 3 200 https://a.example.com/b',
  ].join('\n'));
  assert.equal(entrees[0].commentaire, 'Étiquette liée');
  assert.equal(entrees[1].commentaire, null);
});

test('une ligne illisible est un refus nommé avec son numéro ; les autres restent', () => {
  const { entrees, refus } = lireProposition([
    'bon http */5 * * * * 3 200 https://a.example.com/',
    'cassee http */5 * * * * 0 200 https://a.example.com/',
  ].join('\n'));
  assert.equal(entrees.length, 1);
  assert.deepEqual(refus.map((r) => r.ligne), [2]);
  assert.match(refus[0].raison, /Seuil/);
});

test('un nom déclaré deux fois : la dernière l\'emporte et la première est DITE', () => {
  const { entrees, supplantees } = lireProposition([
    'api http */5 * * * * 3 200 https://a.example.com/v1',
    'api http */10 * * * * 5 200 https://a.example.com/v2',
  ].join('\n'));
  assert.equal(entrees.length, 1);
  assert.equal(entrees[0].target, 'https://a.example.com/v2');
  assert.deepEqual(supplantees, [{ ligne: 1, nom: 'api', gagnante: 2 }]);
});

test('un corps vide ou absent ne rend rien, sans lever', () => {
  for (const corps of ['', null, undefined, '# seulement un commentaire\n']) {
    assert.deepEqual(lireProposition(corps), { entrees: [], refus: [], supplantees: [] });
  }
});

test('les fins de ligne Windows sont lues', () => {
  const { entrees } = lireProposition('a http */5 * * * * 3 200 https://a.example.com/\r\nb script */5 * * * * 3 0 true\r\n');
  assert.deepEqual(entrees.map((e) => e.name), ['a', 'b']);
});

test('ce que le serveur reçoit : la définition, sans le décor de lecture', () => {
  const { entrees } = lireProposition('# note\napi http */5 * * * * 3 200 https://a.example.com/');
  assert.deepEqual(Object.keys(definitionDe(entrees[0])).sort(),
    ['expected', 'kind', 'name', 'schedule', 'target', 'threshold']);
});

test('le résumé distingue les scripts, qui se montrent avec leur commande exacte', () => {
  const { entrees } = lireProposition('a http */5 * * * * 3 200 https://a.example.com/\nb script */5 * * * * 3 0 true');
  assert.deepEqual(resume(entrees), { total: 2, scripts: 1, http: 1 });
});

test('le nom admis est celui de la Forge', () => {
  for (const bon of ['api', 'a', 'sauvegarde-nuit', 'a1']) assert.ok(NOM_SONDE.test(bon), bon);
  for (const mauvais of ['', '-a', 'a-', 'A', 'a b', 'a_b', 'x'.repeat(43)]) assert.equal(NOM_SONDE.test(mauvais), false, mauvais);
});
