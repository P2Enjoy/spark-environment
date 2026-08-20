/**
 * Doublon local du fournisseur DNS, pour le harnais.
 *
 * @spec docs/BACKLOG.md#SPK-47 · docs/DAT.md §38 (le DNS entre dans le
 *       périmètre), §38.2 (ce que le produit ne fait pas), §28.1 (le produit
 *       tient sans réseau sortant)
 *
 * Au même titre que `FakeIncus` et `FakeCaddy` : il parle le protocole du vrai
 * fournisseur, et c'est le VRAI client de la console qui l'interroge — le
 * harnais éprouve donc le code jusqu'au corps de la requête HTTP.
 *
 * Ce qu'il ne prouve PAS, et qu'il ne faut pas lui faire dire : que Scaleway
 * accepte ce corps. Cela exige le vrai fournisseur, se mesure à la main et se
 * consigne dans `docs/JOURNAL.md`.
 *
 * Il porte une zone d'essai et des enregistrements VOISINS — un `MX`, un `TXT`
 * de vérification — parce que la règle à éprouver est qu'ils ne bougent pas.
 */

import { createServer } from 'node:http';

export const ZONES = [
  { domain: 'exemple.test', subdomain: '', status: 'active', ns: ['ns0', 'ns1'] },
  { domain: 'exemple.test', subdomain: 'staging', status: 'active', ns: [] },
];

const INITIAUX = [
  { id: '1', name: '', type: 'MX', data: '10 mail.exemple.test.', ttl: 3600 },
  { id: '2', name: '_verification', type: 'TXT', data: 'preuve-de-propriete', ttl: 3600 },
  { id: '3', name: 'www', type: 'A', data: '198.51.100.1', ttl: 3600 },
];

export async function monterDoublonDns() {
  let enregistrements = INITIAUX.map((r) => ({ ...r }));
  const recus = [];
  let suivant = 100;

  const serveur = createServer(async (requete, reponse) => {
    const url = new URL(requete.url, 'http://127.0.0.1');
    const jeton = requete.headers['x-auth-token'];
    const rendre = (status, corps) => {
      reponse.writeHead(status, { 'content-type': 'application/json' });
      reponse.end(JSON.stringify(corps));
    };
    if (!jeton) return rendre(401, { message: 'no auth token' });

    if (requete.method === 'GET' && url.pathname.endsWith('/dns-zones')) {
      return rendre(200, { dns_zones: ZONES, total_count: ZONES.length });
    }
    if (requete.method === 'GET' && url.pathname.endsWith('/records')) {
      return rendre(200, { records: enregistrements, total_count: enregistrements.length });
    }
    if (requete.method === 'PATCH' && url.pathname.endsWith('/records')) {
      const morceaux = [];
      for await (const bloc of requete) morceaux.push(bloc);
      const corps = JSON.parse(Buffer.concat(morceaux).toString('utf8'));
      recus.push(corps);
      for (const changement of corps.changes ?? []) {
        const { id_fields: cible, records: poses } = changement.set ?? {};
        if (!cible) return rendre(400, { message: 'only `set` is supported here' });
        // MÊME sémantique que le vrai `set` : remplace ce qui porte CE nom et CE
        // type, et rien d'autre. C'est cette exactitude que le parcours éprouve.
        enregistrements = enregistrements.filter(
          (r) => !(r.name === cible.name && r.type === cible.type));
        for (const pose of poses ?? []) {
          enregistrements.push({ id: String(suivant++), ...pose });
        }
      }
      return rendre(200, { records: enregistrements });
    }
    return rendre(404, { message: `rien sur ${url.pathname}` });
  });

  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${serveur.address().port}`,
    /** État courant de la zone, pour CONSTATER l'effet d'un parcours. */
    enregistrements: () => enregistrements.map((r) => ({ ...r })),
    /** Corps réellement reçus, pour vérifier ce que le produit a demandé. */
    recus: () => recus,
    async demonter() {
      await new Promise((r) => serveur.close(r));
    },
  };
}
