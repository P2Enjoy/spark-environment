/**
 * @verifies docs/BACKLOG.md#SPK-78 · docs/DAT.md §38.9 (une ecriture DNS se
 *           verifie), §38.9.1 (relire plutot que persister), §38.9.2 (conforme
 *           ne veut pas dire resolu)
 * @verifies docs/BACKLOG.md#SPK-77 · docs/DAT.md §38.8 (l'inventaire DNS d'une
 *           Forge), §38.8.1 (le perimetre etroit, et pourquoi il l'est),
 *           §38.8.2 (les deux verdicts et la prudence du second),
 *           §38.8.3 (les quatre conditions d'une suppression) · §38.2 revise
 *
 * Le coeur de l'unite : ce qui borne le pouvoir de SUPPRESSION est le perimetre
 * du relevé. Chaque preuve ci-dessous vise cette borne, pas l'affichage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fqdn, pointeVers, inventorier, nomsARapprocher, refusDeSuppression,
  confronter, etatDuNom,
} from './dns-inventaire.js';

const FORGE = '203.0.113.10';

const ZONES = [{
  zone: 'exemple.tech',
  records: [
    { name: 'crm', type: 'A', data: FORGE, ttl: 300 },
    { name: 'ancien', type: 'A', data: FORGE, ttl: 300 },
    // Hors perimetre : une AUTRE machine.
    { name: 'nas', type: 'A', data: '198.51.100.9', ttl: 300 },
    // Hors perimetre : un autre TYPE, meme s'il CITE l'adresse de la Forge.
    { name: '', type: 'TXT', data: `v=spf1 ip4:${FORGE} -all`, ttl: 3600 },
    { name: '', type: 'MX', data: '10 mail.exemple.tech.', ttl: 3600 },
  ],
}];

// --- LE PERIMETRE (§38.8.1) -------------------------------------------------

test('un nom RELATIF vide designe la zone elle-meme', () => {
  assert.equal(fqdn('', 'exemple.tech'), 'exemple.tech');
  assert.equal(fqdn('crm', 'exemple.tech'), 'crm.exemple.tech');
  assert.equal(fqdn('CRM', 'Exemple.tech.'), 'crm.exemple.tech');
});

test('le type ET l’adresse sont exiges, jamais l’un des deux', () => {
  assert.equal(pointeVers({ type: 'A', data: FORGE }, FORGE), true);
  assert.equal(pointeVers({ type: 'AAAA', data: '2001:db8::1' }, '2001:db8::1'), true);
  // Le type seul retiendrait le A d'une autre machine.
  assert.equal(pointeVers({ type: 'A', data: '198.51.100.9' }, FORGE), false);
  // L'adresse seule retiendrait un SPF qui la cite, que le produit n'a aucune
  // raison de toucher.
  assert.equal(pointeVers({ type: 'TXT', data: `v=spf1 ip4:${FORGE}` }, FORGE), false);
  assert.equal(pointeVers({ type: 'CNAME', data: FORGE }, FORGE), false);
});

test('sans adresse de Forge, RIEN n’est retenu', () => {
  // Une Forge locale n'a pas d'adresse publique (§38.8.5). Retenir sur une
  // chaine vide rapprocherait sur une adresse inventee.
  assert.equal(pointeVers({ type: 'A', data: '' }, ''), false);
  assert.deepEqual(nomsARapprocher(ZONES, null), []);
});

test('seuls les noms du perimetre sont soumis au rapprochement', () => {
  assert.deepEqual(nomsARapprocher(ZONES, FORGE).sort(),
    ['ancien.exemple.tech', 'crm.exemple.tech']);
});

// --- LES DEUX VERDICTS (§38.8.2) --------------------------------------------

test('une entree servie NOMME le Spark et la route qui la sert', () => {
  const [, servie] = inventorier({
    zones: ZONES, adresse: FORGE,
    matches: { 'crm.exemple.tech': { domain: '*.exemple.tech', spark_name: 'crm' } },
  });
  assert.equal(servie.fqdn, 'crm.exemple.tech');
  assert.equal(servie.served, true);
  assert.equal(servie.spark, 'crm');
  assert.equal(servie.route, '*.exemple.tech', 'le joker qui sert doit etre NOMME');
});

test('les entrees SANS route viennent en premier : ce sont elles qui appellent un geste', () => {
  const vu = inventorier({
    zones: ZONES, adresse: FORGE,
    matches: { 'crm.exemple.tech': { domain: 'crm.exemple.tech', spark_name: 'crm' } },
  });
  assert.equal(vu.length, 2, 'les trois enregistrements hors perimetre sont ecartes');
  assert.equal(vu[0].fqdn, 'ancien.exemple.tech');
  assert.equal(vu[0].served, false);
  assert.equal(vu[0].spark, null);
});

test('l’apex voyage jusqu’a l’ecran : retirer le nom NU coupe le domaine entier', () => {
  const [entree] = inventorier({
    zones: [{ zone: 'exemple.tech', records: [{ name: '', type: 'A', data: FORGE }] }],
    adresse: FORGE, matches: {},
  });
  assert.equal(entree.apex, true);
  assert.equal(entree.fqdn, 'exemple.tech');
});

// --- LES CONDITIONS DE SUPPRESSION (§38.8.3) --------------------------------

test('une entree perdue, du bon type et de la bonne valeur, est retirable', () => {
  assert.equal(refusDeSuppression({
    enregistrement: { type: 'A', data: FORGE }, adresse: FORGE, servie: null,
  }), null);
});

test('une entree SERVIE est refusee, en nommant la route et le Spark', () => {
  const refus = refusDeSuppression({
    enregistrement: { type: 'A', data: FORGE }, adresse: FORGE,
    servie: { domain: '*.exemple.tech', spark_name: 'crm' },
  });
  assert.match(refus, /\*\.exemple\.tech/);
  assert.match(refus, /crm/);
  assert.match(refus, /couperait une route en service/);
});

test('une entree qui pointe AILLEURS est refusee, meme dans la meme zone', () => {
  const refus = refusDeSuppression({
    enregistrement: { type: 'A', data: '198.51.100.9' }, adresse: FORGE, servie: null,
  });
  assert.match(refus, /ne désigne pas cette Forge/);
});

test('un autre TYPE est refuse : une messagerie ne se retire pas par ce chemin', () => {
  const refus = refusDeSuppression({
    enregistrement: { type: 'MX', data: FORGE }, adresse: FORGE, servie: null,
  });
  assert.match(refus, /MX/);
  assert.match(refus, /A et AAAA/);
});

test('un enregistrement DISPARU entre l’affichage et le clic est dit tel quel', () => {
  const refus = refusDeSuppression({ enregistrement: null, adresse: FORGE, servie: null });
  assert.match(refus, /n'existe plus/);
});

// --- SPK-78 · RELIRE, PLUTOT QUE PERSISTER (docs/DAT.md §38.9.1) ------------

test('la confrontation rend TROIS etats, et NOMME la valeur trouvee', () => {
  const vu = confronter({
    attendus: [
      { name: 'www', type: 'A', data: '203.0.113.10' },
      { name: '', type: 'A', data: '203.0.113.10' },
      { name: 'absent', type: 'A', data: '203.0.113.10' },
    ],
    records: [
      { name: 'www', type: 'A', data: '203.0.113.10' },
      { name: '', type: 'A', data: '198.51.100.9' },
    ],
  });
  assert.equal(vu[0].etat, 'conforme');
  assert.equal(vu[1].etat, 'different');
  assert.equal(vu[1].trouve, '198.51.100.9',
    '« different » sans dire quoi n’apprend pas ce qu’il faut corriger');
  assert.equal(vu[2].etat, 'absent');
  assert.equal(vu[2].trouve, null);
});

test('la confrontation vise le nom ET le type : un TXT du meme nom ne compte pas', () => {
  const [vu] = confronter({
    attendus: [{ name: 'noreply', type: 'MX', data: '10 blackhole.' }],
    records: [{ name: 'noreply', type: 'TXT', data: 'v=spf1 -all' }],
  });
  assert.equal(vu.etat, 'absent');
});

// --- SPK-78 · L'ETAT DNS D'UNE ROUTE (docs/DAT.md §38.9.1) ------------------

const ZONES_ETAT = [
  { zone: 'exemple.tech',
    records: [{ name: 'crm', type: 'A', data: '203.0.113.10' },
              { name: 'ailleurs', type: 'A', data: '198.51.100.9' },
              { name: 'staging', type: 'A', data: '203.0.113.10' }] },
  { zone: 'staging.exemple.tech',
    records: [{ name: 'app', type: 'A', data: '203.0.113.10' }] },
];

test('un nom qui pointe ICI est reconnu', () => {
  const vu = etatDuNom('crm.exemple.tech', ZONES_ETAT, '203.0.113.10');
  assert.equal(vu.etat, 'ici');
  assert.equal(vu.zone, 'exemple.tech');
});

test('un nom qui pointe AILLEURS nomme la valeur trouvee', () => {
  const vu = etatDuNom('ailleurs.exemple.tech', ZONES_ETAT, '203.0.113.10');
  assert.equal(vu.etat, 'ailleurs');
  assert.equal(vu.data, '198.51.100.9');
});

test('un nom SANS enregistrement est distingue d’un nom hors zone', () => {
  // Le distinguo n'est pas cosmetique : « absent » fait chercher un oubli,
  // « hors zone » dit que le DNS de ce nom est tenu ailleurs.
  assert.equal(etatDuNom('rien.exemple.tech', ZONES_ETAT, '203.0.113.10').etat, 'absent');
  const dehors = etatDuNom('crm.autre-compte.fr', ZONES_ETAT, '203.0.113.10');
  assert.equal(dehors.etat, 'hors-zone');
  assert.equal(dehors.zone, null);
});

test('la zone la PLUS SPECIFIQUE decide, comme a l’ecriture', () => {
  // `app.staging.exemple.tech` vit dans la zone deleguee, pas dans la parente :
  // y chercher rendrait « absent » un nom parfaitement pose.
  const vu = etatDuNom('app.staging.exemple.tech', ZONES_ETAT, '203.0.113.10');
  assert.equal(vu.zone, 'staging.exemple.tech');
  assert.equal(vu.etat, 'ici');
});

test('l’apex d’une zone se releve comme les autres noms', () => {
  const vu = etatDuNom('staging.exemple.tech', ZONES_ETAT, '203.0.113.10');
  assert.equal(vu.zone, 'staging.exemple.tech');
  assert.equal(vu.etat, 'absent',
    'la zone deleguee ne porte pas d’enregistrement pour son propre apex');
});
