/**
 * @verifies docs/BACKLOG.md#SPK-118 · docs/DAT.md §63.2 (trois gardes, à un seul
 *           endroit), §63.1 (les deux voies mesurées)
 *
 * Chaque cas est une requête qu'un navigateur envoie réellement : la page de la
 * console, un formulaire caché d'un site tiers, un `fetch` en `no-cors`, une
 * page servie sous DNS rebinding, un outil local.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { examinerRequete } from './garde.js';

const PORT = 5175;
const PAGE = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`,
               'content-type': 'application/json' };
const verdict = (method, headers) => examinerRequete({ method, headers, port: PORT });

test('la page de la console passe, en lecture comme en écriture', () => {
  assert.equal(verdict('GET', { host: PAGE.host }), null);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(verdict(m, PAGE), null);
  assert.equal(verdict('POST', { ...PAGE, 'content-type': 'application/json; charset=utf-8' }), null);
});

test('localhost est la console aussi, avec son origine propre', () => {
  const hote = `localhost:${PORT}`;
  assert.equal(verdict('GET', { host: hote }), null);
  assert.equal(verdict('POST', { host: hote, origin: `http://${hote}`,
                                 'content-type': 'application/json' }), null);
});

test('DNS rebinding : un autre nom est refusé, lectures et fichiers compris', () => {
  for (const host of [`site-piege.example:${PORT}`, 'site-piege.example',
                      `127.0.0.1:${PORT + 1}`, '127.0.0.1', '', undefined]) {
    const r = verdict('GET', { host });
    assert.equal(r?.status, 403, `Host ${host} devait être refusé`);
    assert.equal(r.error, 'hote_refuse');
  }
  // Le nom est comparé sans égard à la casse, comme le fait le DNS.
  assert.equal(verdict('GET', { host: `LOCALHOST:${PORT}` }), null);
});

test('un geste d’une autre origine est refusé, même en JSON', () => {
  const r = verdict('POST', { ...PAGE, origin: 'https://site-piege.example' });
  assert.equal(r.status, 403);
  assert.equal(r.error, 'origine_refusee');
  // Même hôte, autre port : une autre origine.
  assert.equal(verdict('POST', { ...PAGE, origin: `http://127.0.0.1:${PORT + 1}` }).status, 403);
  // L'origine de localhost ne vaut pas pour 127.0.0.1 : ce sont deux origines.
  assert.equal(verdict('POST', { ...PAGE, origin: `http://localhost:${PORT}` }).status, 403);
});

test('Origin: null — iframe isolée, fichier local — est refusé', () => {
  assert.equal(verdict('POST', { ...PAGE, origin: 'null' }).error, 'origine_refusee');
});

test('sans type JSON, une écriture est refusée en 415 : formulaire, texte brut, rien', () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded',
                      'multipart/form-data; boundary=x', undefined]) {
    const r = verdict('POST', { host: PAGE.host, origin: PAGE.origin, 'content-type': type });
    assert.equal(r?.status, 415, `type ${type} devait être refusé`);
    assert.equal(r.error, 'json_requis');
  }
  assert.equal(verdict('DELETE', { host: PAGE.host, origin: PAGE.origin }).status, 415);
});

test('un outil local sans Origin passe, s’il vise le bon hôte avec du JSON', () => {
  assert.equal(verdict('POST', { host: PAGE.host, 'content-type': 'application/json' }), null);
});

test('les lectures n’exigent ni origine ni type', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(verdict(m, { host: PAGE.host, origin: 'https://site-piege.example' }), null);
  }
});
