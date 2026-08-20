/**
 * @verifies docs/BACKLOG.md#SPK-47 · docs/DAT.md §38.1 (où vit le secret),
 *           §38.2 (ce que le produit ne fait pas), §38.3 (ce qui est écrit),
 *           §38.5 (la garde d'écriture)
 *
 * Le compte d'essai porte quatorze zones RÉELLES en exploitation. Chaque refus
 * de ce fichier protège quelque chose qu'une écriture de trop casserait pour de
 * bon : les serveurs de noms d'une zone, sa messagerie, une preuve de propriété.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DnsError, TTL, TYPES, ScalewayDns, fournisseurDepuis, nomRelatif, normaliser,
  preparer, readDotEnv, typePourAdresse,
} from './dns.js';

// --- le nom relatif, et les trois refus (§38.5) -----------------------------

test('un sous-domaine rend son nom relatif à la zone', () => {
  assert.equal(nomRelatif('app.exemple.tech', 'exemple.tech'), 'app');
  assert.equal(nomRelatif('test.spark.exemple.tech', 'exemple.tech'), 'test.spark');
});

test("l'APEX de la zone est refusé, en disant pourquoi", () => {
  // Il porte les NS et le MX : y écrire un A d'ingress casse la délégation et la
  // messagerie de tout le domaine, et ce n'est pas rattrapable en une minute.
  assert.throws(() => nomRelatif('exemple.tech', 'exemple.tech'),
                /apex de la zone/);
  assert.throws(() => nomRelatif('exemple.tech.', 'exemple.tech'), DnsError);
});

test("un domaine HORS de la zone choisie est refusé", () => {
  assert.throws(() => nomRelatif('app.autre.tech', 'exemple.tech'),
                /n'est pas dans la zone/);
});

test('un suffixe qui ressemble à la zone sans en être ne passe pas', () => {
  // « pasexemple.tech » finit par « exemple.tech » : un rapprochement par
  // simple suffixe écrirait dans la mauvaise zone. Le point séparateur est
  // exigé (§38.2 : le nom EXACT, jamais un préfixe).
  assert.throws(() => nomRelatif('app.pasexemple.tech', 'exemple.tech'), DnsError);
});

test('la casse et le point final ne font pas deux noms différents', () => {
  assert.equal(nomRelatif('APP.Exemple.TECH.', 'exemple.tech'), 'app');
  assert.equal(normaliser('  Exemple.Tech. '), 'exemple.tech');
});

test('un domaine ou une zone vide est refusé', () => {
  assert.throws(() => nomRelatif('', 'exemple.tech'), /Aucun domaine/);
  assert.throws(() => nomRelatif('app.exemple.tech', ''), /Aucune zone/);
});

// --- le type, déduit de l'adresse (§38.3) -----------------------------------

test('une adresse IPv4 donne un A, une IPv6 donne un AAAA', () => {
  assert.equal(typePourAdresse('163.172.156.76'), 'A');
  assert.equal(typePourAdresse('2001:bc8:1200::1'), 'AAAA');
  assert.deepEqual(TYPES, ['A', 'AAAA']);
});

test("ce qui n'est pas une adresse est refusé", () => {
  // Un nom d'hôte écrirait un A dont la donnée n'est pas une adresse : le
  // fournisseur le refuserait, mais après coup et avec son propre message.
  for (const valeur of ['forge.exemple.tech', '999.1.1.1', '1.2.3', '', 'abc'])
    assert.throws(() => typePourAdresse(valeur), DnsError);
});

// --- la garde complète ------------------------------------------------------

test('une préparation valide rend exactement ce qui sera écrit', () => {
  assert.deepEqual(
    preparer({ domain: 'app.exemple.tech', zone: 'exemple.tech', address: '203.0.113.7' }),
    { zone: 'exemple.tech', name: 'app', type: 'A', data: '203.0.113.7', ttl: TTL },
  );
  assert.equal(TTL, 300, 'un TTL long ferait traîner la panne après sa correction');
});

test('un TTL hors bornes est refusé', () => {
  const base = { domain: 'a.exemple.tech', zone: 'exemple.tech', address: '203.0.113.7' };
  assert.throws(() => preparer({ ...base, ttl: 5 }), /hors bornes/);
  assert.throws(() => preparer({ ...base, ttl: 100000 }), /hors bornes/);
  assert.throws(() => preparer({ ...base, ttl: 60.5 }), /hors bornes/);
});

test("l'espace de noms des essais borne l'écriture quand il est posé", () => {
  // Garde du HARNAIS, pas du produit : un exploitant gère sa zone entière, et
  // le motif est donc un paramètre, jamais une constante (§38.5).
  const motif = '^test\\.[a-z0-9-]+\\.lelabs\\.tech$';
  assert.doesNotThrow(() => preparer({
    domain: 'test.spark.lelabs.tech', zone: 'lelabs.tech',
    address: '203.0.113.7', motif,
  }));
  assert.throws(() => preparer({
    domain: 'gram.lelabs.tech', zone: 'lelabs.tech', address: '203.0.113.7', motif,
  }), /sort de l'espace de noms autorisé/);
});

test("sans motif, aucune borne d'espace de noms n'est appliquée", () => {
  assert.doesNotThrow(() => preparer({
    domain: 'crm.exemple.tech', zone: 'exemple.tech', address: '203.0.113.7',
  }));
});

// --- le `.env` (§38.1) ------------------------------------------------------

async function fichierEnv(contenu) {
  const chemin = join(await mkdtemp(join(tmpdir(), 'spark-env-')), '.env');
  await writeFile(chemin, contenu);
  return chemin;
}

test('un `.env` absent rend un objet vide, pas une erreur', async () => {
  // Un poste sans fournisseur configuré est le cas NORMAL (§38.1).
  assert.deepEqual(await readDotEnv(join(tmpdir(), 'absent-' + process.pid, '.env')), {});
});

test('le `.env` se lit, commentaires et guillemets compris', async () => {
  const chemin = await fichierEnv(
    '# un commentaire\nSCW_SECRET_KEY="secret"\n\nSCW_DEFAULT_ORGANIZATION_ID=org-1\nSANS_EGAL\n',
  );
  const lu = await readDotEnv(chemin);
  assert.equal(lu.SCW_SECRET_KEY, 'secret');
  assert.equal(lu.SCW_DEFAULT_ORGANIZATION_ID, 'org-1');
  assert.ok(!('SANS_EGAL' in lu));
});

test('sans jeton, le fournisseur est DÉSACTIVÉ et le dit — ce n’est pas une panne', () => {
  const bilan = fournisseurDepuis({});
  assert.equal(bilan.configured, false);
  assert.equal(bilan.provider, null);
  assert.match(bilan.reason, /Aucun jeton DNS/);
});

test('avec un jeton, le fournisseur existe et le jeton ne SORT pas du bilan', () => {
  // Le rendre à l'appelant reviendrait à le mettre à un clic d'un écran, d'un
  // journal ou d'un rapport de bogue (§38.1).
  const bilan = fournisseurDepuis({ SCW_SECRET_KEY: 'secret', SCW_DEFAULT_ORGANIZATION_ID: 'o' });
  assert.equal(bilan.configured, true);
  assert.ok(bilan.provider instanceof ScalewayDns);
  assert.ok(!JSON.stringify(bilan).includes('secret'));
});

test('construire un client sans jeton est refusé', () => {
  assert.throws(() => new ScalewayDns({}), /Aucun jeton/);
});

// --- le client, sur un fournisseur simulé ----------------------------------

function faux(reponses) {
  const appels = [];
  const fetchFn = async (url, options = {}) => {
    appels.push({ url, options });
    const reponse = reponses.shift() ?? { status: 200, body: {} };
    return {
      ok: reponse.status < 400,
      status: reponse.status,
      text: async () => JSON.stringify(reponse.body ?? {}),
    };
  };
  return { appels, fetchFn };
}

test('le jeton part en en-tête, jamais dans l’URL', async () => {
  // Une URL se retrouve dans les journaux d'un proxy, dans un historique et
  // dans un rapport d'erreur ; un en-tête, beaucoup moins.
  const { appels, fetchFn } = faux([{ status: 200, body: { dns_zones: [] } }]);
  await new ScalewayDns({ token: 'secret', organizationId: 'o', fetch: fetchFn }).zones();
  assert.ok(!appels[0].url.includes('secret'));
  assert.equal(appels[0].options.headers['X-Auth-Token'], 'secret');
});

test('les zones sont rendues avec leur nom COMPLET recomposé', async () => {
  const { fetchFn } = faux([{ status: 200, body: { dns_zones: [
    { domain: 'exemple.tech', subdomain: '', status: 'active', ns: ['a', 'b'] },
    { domain: 'exemple.tech', subdomain: 'staging', status: 'pending', ns: [] },
  ] } }]);
  const zones = await new ScalewayDns({ token: 't', organizationId: 'o', fetch: fetchFn }).zones();
  assert.deepEqual(zones.map((z) => z.zone), ['exemple.tech', 'staging.exemple.tech']);
  assert.equal(zones[1].status, 'pending');
});

test('une écriture vise le nom ET le type exacts, et interdit de créer une zone', async () => {
  // C'est ce qui garantit qu'un MX, un TXT de vérification ou un A voisin n'est
  // pas emporté par l'écriture (§38.2).
  const { appels, fetchFn } = faux([{ status: 200, body: {} }]);
  const client = new ScalewayDns({ token: 't', organizationId: 'o', fetch: fetchFn });
  const ecrit = await client.setRecord(preparer({
    domain: 'test.spark.lelabs.tech', zone: 'lelabs.tech', address: '203.0.113.7',
  }));

  assert.equal(appels[0].options.method, 'PATCH');
  const corps = JSON.parse(appels[0].options.body);
  assert.deepEqual(corps.changes[0].set.id_fields, { name: 'test.spark', type: 'A' });
  assert.deepEqual(corps.changes[0].set.records,
                   [{ name: 'test.spark', type: 'A', data: '203.0.113.7', ttl: 300 }]);
  assert.equal(corps.disallow_new_zone_creation, true,
               'une faute de frappe sur la zone doit échouer, pas créer une zone');
  assert.equal(ecrit.fqdn, 'test.spark.lelabs.tech');
  assert.equal(ecrit.written, true);
  assert.ok(!('ready' in ecrit), 'poser un enregistrement ne le fait pas RÉSOUDRE (§38.4)');
});

test('aucune méthode ne SUPPRIME : le produit ne défait pas ce qu’il n’a pas posé', () => {
  // §38.2. La preuve porte sur la surface publique du client, parce que c'est
  // elle qu'un écran pourrait appeler.
  const client = new ScalewayDns({ token: 't', organizationId: 'o', fetch: async () => {} });
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
  assert.deepEqual(surface.sort(), ['constructor', 'records', 'setRecord', 'zones']);
});

test('un refus du fournisseur remonte SON message, pas un « HTTP 403 » nu', async () => {
  const { fetchFn } = faux([{ status: 403, body: { message: 'permission denied' } }]);
  await assert.rejects(
    new ScalewayDns({ token: 't', organizationId: 'o', fetch: fetchFn }).zones(),
    /HTTP 403.*permission denied/s,
  );
});
