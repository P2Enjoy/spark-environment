/**
 * @verifies docs/BACKLOG.md#SPK-179 · docs/DAT.md §72 (le domaine d'une route est
 *           un lien ouvert dans un nouvel onglet) · docs/DESIGN_SYSTEM.md §1.4
 *           (pas de commande morte), §1.5 (la couleur ne porte jamais seule),
 *           §9.2, §10 · docs/DESIGN_SYSTEM_APP.md SPK-DS-49
 *
 * Ce que ces preuves verrouillent : le schéma est celui de la route ; un joker et
 * une valeur qui n'est pas un nom d'hôte restent du TEXTE ; le lien sort de la
 * page en le disant (icône, texte pour lecteurs d'écran) et sans donner à l'onglet
 * ouvert ni la main sur la console ni son adresse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderRoutesPanel, domaineDeRoute, lienDomaine } from './spark-admin.js';

const SPARK = { name: 'crm', state: 'running', protected: false };
const route = (domain, extra = {}) =>
  ({ domain, target_port: 8080, tls: true, applied_at: '2026-11-18T10:00:00', ...extra });

// --- le schéma est celui de la route ------------------------------------------

test('route avec TLS → https', () => {
  assert.equal(domaineDeRoute(route('crm.example.com')), 'https://crm.example.com/');
});

test('route SANS TLS → http (forcer https ouvrirait une erreur de connexion)', () => {
  assert.equal(domaineDeRoute(route('crm.example.com', { tls: false })), 'http://crm.example.com/');
});

test('le nom d\'hôte est mis en minuscules, comme le DNS le lit', () => {
  assert.equal(domaineDeRoute(route('CRM.Example.COM')), 'https://crm.example.com/');
});

// --- ce qui n'est pas un lien -------------------------------------------------

test('un JOKER n\'est pas un lien : il ne désigne aucune adresse (§18.3 bis)', () => {
  assert.equal(domaineDeRoute(route('*.monapi.fr')), null);
  const html = lienDomaine(route('*.monapi.fr'));
  assert.equal(html.includes('<a '), false);
  assert.match(html, /<span class="technique">\*\.monapi\.fr<\/span>/);
});

test('une valeur qui n\'est pas un nom d\'hôte reste du texte, jamais un href', () => {
  for (const mauvais of ['', null, undefined, 'localhost', 'a b.example.com', 'x.example.com/chemin',
                         'https://x.example.com', 'javascript:alert(1)', 'x.example.com"><script>',
                         '-x.example.com', 'x-.example.com', 'x..example.com', 'x.example.com.']) {
    assert.equal(domaineDeRoute(route(mauvais)), null, `« ${String(mauvais)} »`);
    assert.equal(lienDomaine(route(mauvais)).includes('href='), false, `« ${String(mauvais)} »`);
  }
});

test('un nom hostile est échappé, même quand il reste du texte', () => {
  const html = lienDomaine(route('x.example.com"><script>alert(1)</script>'));
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('un nom d\'hôte valide : punycode, chiffres, traits d\'union', () => {
  for (const bon of ['xn--caf-dma.example.com', '123.example.com', 'a-b.c-d.example.fr', 'a.io']) {
    assert.ok(domaineDeRoute(route(bon)), bon);
  }
});

// --- le lien s'ouvre dans un nouvel onglet, et le dit --------------------------

test('le lien : target _blank, rel noopener noreferrer', () => {
  const html = lienDomaine(route('crm.example.com'));
  assert.match(html, /<a [^>]*href="https:\/\/crm\.example\.com\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('le domaine reste lisible, en police technique', () => {
  assert.match(lienDomaine(route('crm.example.com')), /class="technique lien-externe"[^>]*>crm\.example\.com/);
});

test('le lien dit qu\'il sort de la page : icône décorative ET texte pour lecteurs d\'écran (§1.5)', () => {
  const html = lienDomaine(route('crm.example.com'));
  assert.match(html, /<svg class="icone-lien-externe"[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="sr-only"> \(s’ouvre dans un nouvel onglet\)<\/span>/);
});

// --- dans la section Routes ----------------------------------------------------

test('section Routes : chaque route nommée est un lien, un joker reste du texte', () => {
  const html = renderRoutesPanel(SPARK, [
    route('crm.example.com'), route('vieux.example.com', { tls: false }), route('*.clients.example.com'),
  ]);
  assert.match(html, /href="https:\/\/crm\.example\.com\/"/);
  assert.match(html, /href="http:\/\/vieux\.example\.com\/"/);
  assert.equal(html.includes('href="https://*'), false);
  assert.match(html, /<span class="technique">\*\.clients\.example\.com<\/span>/);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 2);
});

test('section Routes : une route non appliquée reste liée, sa pastille dit pourquoi', () => {
  const html = renderRoutesPanel(SPARK, [route('neuf.example.com', { applied_at: null })]);
  assert.match(html, /href="https:\/\/neuf\.example\.com\/"/);
  assert.match(html, /non appliquée/);
});

test('section Routes : le lien ne retire ni ne déplace les gestes de la ligne', () => {
  const html = renderRoutesPanel(SPARK, [route('crm.example.com')]);
  for (const geste of ['data-dns-route="crm.example.com"', 'data-modifie-route="crm.example.com"',
                       'data-retire-route="crm.example.com"']) {
    assert.ok(html.includes(geste), geste);
  }
});

test('section Routes : aucune route → l\'absence nommée, pas de lien', () => {
  const html = renderRoutesPanel(SPARK, []);
  assert.equal(html.includes('target="_blank"'), false);
  assert.match(html, /Aucune route publique/);
});
