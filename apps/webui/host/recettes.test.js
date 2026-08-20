/**
 * @verifies docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.6 (les recettes),
 *           §38.6.1 (une fonction, pas une donnée), §38.6.2 (la garde élargie),
 *           §38.6.3 (le compte rendu), §38.6.4 (les deux recettes) · §38.5
 *
 * Une recette à moitié posée est pire qu'une recette absente : un `MX` sans SPF
 * fait recevoir du courrier qu'on ne peut pas renvoyer. C'est ce que ces preuves
 * gardent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogue, composer, RECETTES, ValeurManquante } from './recettes.js';
import { DnsError, FORMES, preparerEnregistrement } from './dns.js';

// --- la garde élargie (§38.6.2) ---------------------------------------------

test('chaque type declare la FORME que sa donnee doit avoir', () => {
  assert.deepEqual(Object.keys(FORMES).sort(),
                   ['A', 'AAAA', 'CNAME', 'MX', 'SRV', 'TXT']);
});

test('un MX exige une PRIORITE puis un nom d’hote', () => {
  // Sans la priorite, le fournisseur refuserait apres coup et avec son propre
  // message — on ne saurait pas que c'est le produit qui a mal compose.
  assert.doesNotThrow(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'MX',
    data: '10 mail.exemple.tech.' }));
  assert.throws(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'MX',
    data: 'mail.exemple.tech.' }), /priorité/);
});

test('un SRV exige ses quatre champs', () => {
  assert.doesNotThrow(() => preparerEnregistrement({
    domain: '_imaps._tcp.exemple.tech', zone: 'exemple.tech', type: 'SRV',
    data: '0 1 993 mail.exemple.tech.' }));
  assert.throws(() => preparerEnregistrement({
    domain: '_imaps._tcp.exemple.tech', zone: 'exemple.tech', type: 'SRV',
    data: '993 mail.exemple.tech.' }), DnsError);
});

test('un TXT vide est refuse : il ne dirait rien', () => {
  assert.throws(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'TXT', data: '   ' }),
    /sans valeur/);
});

test('un type que le produit ne COMPOSE pas est refuse, en les enumerant', () => {
  // Ce n'est pas de la prudence : ecrire un type qu'on ne compose pas serait
  // ecrire une valeur qu'on n'a pas verifiee (§38.6.2).
  assert.throws(() => preparerEnregistrement({
    domain: 'a.exemple.tech', zone: 'exemple.tech', type: 'NS', data: 'ns0.x.' }),
    /le produit compose/);
});

test('une recette n’est PAS une porte derobee : chaque ligne passe la garde', () => {
  // Un domaine hors de la zone reste refuse, meme composé par une recette.
  assert.throws(() => composer('site-web',
    { domain: 'autre.fr', address: '203.0.113.7' }, { zone: 'exemple.tech' }),
    /n'est pas dans la zone/);
});

// --- le catalogue (§38.6.1) --------------------------------------------------

test('le catalogue vient du CODE et decrit ce que chaque recette reclame', () => {
  const noms = catalogue().map((r) => r.id).sort();
  assert.deepEqual(noms, ['relais-transactionnel', 'site-web']);
  for (const recette of catalogue()) {
    assert.ok(recette.label && recette.description);
    assert.ok(Array.isArray(recette.parametres) && recette.parametres.length > 0);
  }
});

// --- « site-web » (§38.6.4) --------------------------------------------------

test('« site-web » pose le domaine NU et son www, et rien d’autre', () => {
  const vu = composer('site-web',
    { domain: 'exemple.tech', address: '203.0.113.7' }, { zone: 'exemple.tech' });
  assert.deepEqual(vu.records.map((r) => [r.name, r.type, r.data]), [
    ['', 'A', '203.0.113.7'],
    ['www', 'A', '203.0.113.7'],
  ]);
  assert.equal(vu.records[0].apex, true, 'le domaine nu doit se signaler comme apex');
  assert.ok(vu.records.every((r) => r.role), 'chaque ligne dit ce qu’elle fait');
  assert.equal(vu.incomplete, null, 'elle ne depend d’aucune valeur exterieure');
});

test('une adresse IPv6 donne un AAAA dans « site-web »', () => {
  assert.throws(() => composer('site-web',
    { domain: 'exemple.tech', address: '2001:db8::1' }, { zone: 'exemple.tech' }),
    /invalide pour un A/,
    'la recette compose des A : une IPv6 doit être REFUSÉE, pas écrite comme un A');
});

// --- « relais-transactionnel » (§38.6.4) ------------------------------------

const RELAIS = { domain: 'noreply.exemple.tech', selector: 'projet-1',
                 dkim: 'v=DKIM1; h=sha256; k=rsa; p=AAAA', policy: 'none' };

test('« relais-transactionnel » compose les quatre enregistrements mesures', () => {
  const vu = composer('relais-transactionnel', RELAIS, { zone: 'exemple.tech' });
  const lignes = vu.records.map((r) => [r.name, r.type]);
  assert.deepEqual(lignes, [
    ['noreply', 'MX'],
    ['noreply', 'TXT'],
    ['_dmarc.noreply', 'TXT'],
    ['projet-1._domainkey.noreply', 'TXT'],
  ]);
  assert.ok(vu.records[0].data.includes('blackhole'));
  assert.ok(vu.records[1].data.includes('_spf.tem.scaleway.com'));
  assert.equal(vu.incomplete, null);
});

test('le MX vers un PUITS est annonce comme tel, pas laisse a deviner', () => {
  // Un exploitant qui l'appliquerait sur un domaine cense RECEVOIR du courrier
  // le couperait. C'est ecrit dans la recette, pas seulement dans le DAT.
  const vu = composer('relais-transactionnel', RELAIS, { zone: 'exemple.tech' });
  assert.ok(/ÉMET et ne reçoit pas/.test(vu.records[0].role));
  assert.ok(/NE REÇOIT PAS/.test(RECETTES['relais-transactionnel'].description));
});

test('SANS la cle DKIM, la recette est posee mais annoncee INCOMPLETE', () => {
  // §38.6 : la valeur DKIM ne s'invente pas. L'inventer produirait une signature
  // invalide, donc exactement l'effet qu'on pretend eviter.
  const vu = composer('relais-transactionnel', { ...RELAIS, dkim: '' },
                      { zone: 'exemple.tech' });
  assert.equal(vu.records.length, 3, 'les trois autres sont posees quand meme');
  assert.ok(vu.incomplete.includes('SANS SIGNATURE'));
  assert.ok(vu.incomplete.includes('console du fournisseur'),
    'elle doit dire OU lire la cle');
});

test('sans SELECTEUR, la recette REFUSE au lieu d’inventer un nom', () => {
  assert.throws(
    () => composer('relais-transactionnel', { ...RELAIS, selector: '' },
                   { zone: 'exemple.tech' }),
    (e) => e instanceof ValeurManquante && e.champ === 'selector');
});

test('une politique DMARC inconnue est refusee en enumerant les trois', () => {
  assert.throws(() => composer('relais-transactionnel',
    { ...RELAIS, policy: 'detruire' }, { zone: 'exemple.tech' }),
    /none, quarantine ou reject/);
});

test('les actions HUMAINES restantes voyagent avec la recette', () => {
  // §38.7 : le produit fait sa part et dit precisement ou s'arrete son pouvoir.
  const vu = composer('relais-transactionnel', RELAIS, { zone: 'exemple.tech' });
  assert.ok(vu.actionsHumaines.length >= 2);
  assert.ok(vu.actionsHumaines.some((a) => /PTR/.test(a)));
});

test('une recette inconnue est refusee', () => {
  assert.throws(() => composer('inexistante', {}, { zone: 'exemple.tech' }),
                /inconnue/);
});
