/**
 * @verifies docs/BACKLOG.md#SPK-77 · docs/DAT.md §38.8 (l'inventaire DNS),
 *           §38.8.1 (le perimetre), §38.8.2 (les deux verdicts et la prudence
 *           du second), §38.8.3 (la confirmation ENUMERE), §38.8.5 (une section
 *           de la Forge) · §38.1.1 (les trois etats d'un relevé vide) ·
 *           docs/DESIGN_SYSTEM.md §6.13, §6.22, §14.5
 *
 * Le point qui decide de l'ecran : « aucune route ne le sert » n'est pas
 * « inutile ». Un libelle qui affirmerait l'inutilite ferait supprimer ce qui
 * marchait.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderForgeDns, FORGE_DNS_VIDE, cleEntree, choisies } from './forge-dns.js';

const FORGE = { nom: 'prod', adresse: '203.0.113.10' };

const PERDUE = { zone: 'exemple.tech', name: 'ancien', fqdn: 'ancien.exemple.tech',
                 type: 'A', data: '203.0.113.10', apex: false, served: false,
                 route: null, spark: null };
const SERVIE = { zone: 'exemple.tech', name: 'crm', fqdn: 'crm.exemple.tech',
                 type: 'A', data: '203.0.113.10', apex: false, served: true,
                 route: '*.exemple.tech', spark: 'crm' };

const vue = (surcharge = {}) => ({ ...FORGE_DNS_VIDE, forge: FORGE, ...surcharge });

// --- LE PERIMETRE EST DIT (§38.8.1) -----------------------------------------

test('la page DIT ce qu’elle ne montre pas, et l’adresse sur laquelle elle filtre', () => {
  const rendu = renderForgeDns(vue({ entries: [SERVIE] }));
  assert.ok(rendu.includes('203.0.113.10'), 'l’adresse filtree doit etre lisible');
  assert.ok(/ne sont jamais touchés/.test(rendu),
    'le hors-perimetre doit etre annonce, pas devine');
});

// --- LES DEUX VERDICTS (§38.8.2) --------------------------------------------

test('une entree servie NOMME son Spark et la route qui la sert', () => {
  const rendu = renderForgeDns(vue({ entries: [SERVIE] }));
  assert.ok(rendu.includes('*.exemple.tech'), 'le joker qui sert doit etre nomme');
  assert.ok(rendu.includes('#/sparks/crm'), 'le Spark doit etre atteignable d’un clic');
});

test('une entree sans route dit « aucune route ne le sert », JAMAIS « inutile »', () => {
  const rendu = renderForgeDns(vue({ entries: [PERDUE] }));
  assert.ok(rendu.includes('Aucune route ne le sert'));
  assert.ok(!/inutile|orphelin|abandonn/i.test(rendu),
    'le produit ignore si l’exploitant sert ce nom autrement : l’affirmer ferait '
    + 'supprimer ce qui marchait');
});

test('une entree SERVIE n’est pas designable : le geste serait refuse', () => {
  const rendu = renderForgeDns(vue({ entries: [SERVIE] }));
  assert.ok(!rendu.includes('data-dns-entree'),
    'offrir la case ferait esperer un geste que le serveur refuse');
  assert.ok(rendu.includes('Chaque nom qui pointe ici est servi'));
});

// --- LA DESIGNATION ET LA CONFIRMATION (§38.8.3) ----------------------------

test('le retrait n’est offert que lorsqu’une entree est DESIGNEE', () => {
  const rien = renderForgeDns(vue({ entries: [PERDUE] }));
  assert.ok(rien.includes('data-dns-nettoyer'));
  assert.ok(/data-dns-nettoyer[^>]*disabled/.test(rien),
    'sans designation, il n’y a rien a retirer');

  const prise = renderForgeDns(vue({ entries: [PERDUE], selection: [cleEntree(PERDUE)] }));
  assert.ok(!/data-dns-nettoyer[^>]*disabled/.test(prise));
});

test('la confirmation ENUMERE ce qui va partir, elle ne le compte pas', () => {
  const rendu = renderForgeDns(vue({
    entries: [PERDUE], selection: [cleEntree(PERDUE)], confirmation: true }));
  assert.ok(rendu.includes('ancien.exemple.tech'), 'le nom doit etre lisible');
  assert.ok(rendu.includes('203.0.113.10'), 'la valeur aussi : c’est ce qui rend relisable');
  assert.ok(rendu.includes('revérifiée par la Forge'),
    'l’ecran dit que la condition est reconstatee cote serveur');
});

test('retirer le domaine NU est annonce comme tel dans la confirmation', () => {
  const apex = { ...PERDUE, name: '', fqdn: 'exemple.tech', apex: true };
  const rendu = renderForgeDns(vue({
    entries: [apex], selection: [cleEntree(apex)], confirmation: true }));
  assert.ok(/domaine ENTIER/.test(rendu),
    'couper le nom nu n’est pas couper un sous-domaine');
});

test('une entree servie ne peut pas etre emportee par une selection perimee', () => {
  // La selection survit a un relevé : si l'entree est devenue SERVIE entre
  // temps, elle ne doit plus partir avec le lot.
  const etat = vue({ entries: [SERVIE], selection: [cleEntree(SERVIE)] });
  assert.deepEqual(choisies(etat), []);
});

// --- LES ETATS SYSTEMATIQUES (§6.13, §38.1.1) -------------------------------

test('sans jeton, la page le DIT et n’affirme aucune absence d’entrees', () => {
  const rendu = renderForgeDns(vue({
    configured: false, reason: 'Aucun jeton DNS sur ce poste.' }));
  assert.ok(rendu.includes('Aucun jeton DNS sur ce poste.'));
  assert.ok(!rendu.includes('Aucun enregistrement'));
});

test('un refus du fournisseur ou de la Forge est rendu tel quel', () => {
  const rendu = renderForgeDns(vue({
    refus: 'La Forge n’a pas pu rapprocher ces noms de ses routes (HTTP 500).' }));
  assert.ok(rendu.includes('id="dns-inventaire-refus"'));
  assert.ok(rendu.includes('HTTP 500'));
  assert.ok(!rendu.includes('Aucun enregistrement'),
    'sans rapprochement il n’y a pas de verdict : ne rien conclure');
});

test('une Forge sans adresse publique le dit, et ne releve rien', () => {
  const rendu = renderForgeDns(vue({
    configured: true, forge: { nom: 'local', adresse: null },
    reason: "Cette Forge n'a pas d'adresse publique : rien ne peut pointer vers elle." }));
  // Le motif vient du serveur : il passe par l'echappement, apostrophe comprise.
  assert.ok(/pas d(&#39;|')adresse publique/.test(rendu));
});

test('un relevé vide est NOMME, pas rendu par un tableau vide', () => {
  const rendu = renderForgeDns(vue({ configured: true, entries: [] }));
  assert.ok(rendu.includes('id="dns-inventaire-vide"'));
  assert.ok(!rendu.includes('<table>'));
});

test('tant qu’on releve, l’ecran ne conclut PAS a l’absence', () => {
  const rendu = renderForgeDns(vue({ chargement: true }));
  assert.ok(rendu.includes('Relevé des zones du compte'));
  assert.ok(!rendu.includes('id="dns-inventaire-vide"'));
});

test('ce qui vient d’etre retire ne promet PAS que le nom ne repond plus', () => {
  const rendu = renderForgeDns(vue({
    entries: [], configured: true,
    resultat: { retires: [{ fqdn: 'ancien.exemple.tech', type: 'A' }], refus: [] } }));
  assert.ok(rendu.includes('id="dns-resultat"'));
  assert.ok(rendu.includes('1 retirée(s)'));
  assert.ok(rendu.includes('TTL'));
  assert.ok(!/ne répond plus|supprimé partout/i.test(rendu));
});

test('un nettoyage PARTIEL rend le sort de chaque ligne, jamais un verdict global', () => {
  // On ne defait pas une suppression DNS : presenter un refus seul cacherait ce
  // qui est DEJA parti (§38.6.3, applique au nettoyage).
  const rendu = renderForgeDns(vue({
    entries: [], configured: true,
    resultat: {
      retires: [{ fqdn: 'exemple.tech', type: 'A' }],
      refus: [{ fqdn: 'perdu.exemple.tech',
                message: '« 198.51.100.42 » ne désigne pas cette Forge.' }],
    } }));
  assert.ok(rendu.includes('1 retirée(s)'));
  assert.ok(rendu.includes('1 refusée(s)'));
  assert.ok(rendu.includes('exemple.tech'));
  assert.ok(rendu.includes('perdu.exemple.tech'));
  assert.ok(rendu.includes('ne désigne pas cette Forge'));
  assert.ok(rendu.includes('avertissement'),
    'un resultat partiel n’est pas une reussite');
});
