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

/** Zone par défaut du doublon : celle que les parcours d'écriture visent. */
const ZONE = 'exemple.test';

export async function monterDoublonDns() {
  // SPK-77 · §38.8 : les enregistrements vivent PAR ZONE, comme chez le vrai
  // fournisseur. Un jeu partagé faisait apparaître chaque nom dans les deux
  // zones du compte, et l'inventaire y voyait deux entrées là où il n'y en a
  // qu'une.
  const parZone = new Map([[ZONE, INITIAUX.map((r) => ({ ...r }))]]);
  const zoneDe = (chemin) => decodeURIComponent(
    chemin.replace(/^.*\/dns-zones\//, '').replace(/\/records$/, ''));
  const lire = (zone) => parZone.get(zone) ?? [];
  const recus = [];
  let suivant = 100;
  // §38.1.1 : le refus du fournisseur est un état à ÉPROUVER, pas à imaginer.
  // Une clé expirée n'est pas une clé absente, et le harnais doit pouvoir
  // reproduire ce que le compte du responsable a réellement rendu le
  // 2026-09-02 : `401 {"reason":"expired"}`.
  let refus = null;

  const serveur = createServer(async (requete, reponse) => {
    const url = new URL(requete.url, 'http://127.0.0.1');
    const jeton = requete.headers['x-auth-token'];
    const rendre = (status, corps) => {
      reponse.writeHead(status, { 'content-type': 'application/json' });
      reponse.end(JSON.stringify(corps));
    };
    if (!jeton) return rendre(401, { message: 'no auth token' });

    if (requete.method === 'GET' && url.pathname.endsWith('/dns-zones')) {
      if (refus) return rendre(refus.status, refus.corps);
      return rendre(200, { dns_zones: ZONES, total_count: ZONES.length });
    }
    if (requete.method === 'GET' && url.pathname.endsWith('/records')) {
      const dedans = lire(zoneDe(url.pathname));
      return rendre(200, { records: dedans, total_count: dedans.length });
    }
    if (requete.method === 'PATCH' && url.pathname.endsWith('/records')) {
      const morceaux = [];
      for await (const bloc of requete) morceaux.push(bloc);
      const corps = JSON.parse(Buffer.concat(morceaux).toString('utf8'));
      recus.push(corps);
      const zone = zoneDe(url.pathname);
      let enregistrements = lire(zone);
      for (const changement of corps.changes ?? []) {
        // SPK-77 · §38.8.3 : le retrait vise le nom ET le type exacts, comme
        // l'écriture. Le doublon parle la même forme que le vrai fournisseur.
        if (changement.delete) {
          const { id_fields: vise } = changement.delete;
          if (!vise) return rendre(400, { message: '`delete` needs `id_fields` here' });
          enregistrements = enregistrements.filter(
            (r) => !(r.name === vise.name && r.type === vise.type));
          continue;
        }
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
      parZone.set(zone, enregistrements);
      return rendre(200, { records: enregistrements });
    }
    return rendre(404, { message: `rien sur ${url.pathname}` });
  });

  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${serveur.address().port}`,
    /** État courant d'une zone, pour CONSTATER l'effet d'un parcours. */
    enregistrements: (zone = ZONE) => lire(zone).map((r) => ({ ...r })),
    /** Corps réellement reçus, pour vérifier ce que le produit a demandé. */
    recus: () => recus,
    /**
     * Remplace l'état de la zone (SPK-77, §38.8).
     *
     * Un parcours d'inventaire doit partir d'un état DÉTERMINISTE : les
     * parcours d'écriture qui le précèdent ont laissé la zone dans un état
     * qui leur appartient. C'est le pendant du seed pour le registre.
     */
    poser(nouveaux, zone = ZONE) {
      parZone.set(zone, nouveaux.map((r, i) => ({ id: String(900 + i), ttl: 300, ...r })));
    },
    /**
     * Fait REFUSER la lecture des zones, ou lève le refus avec `null` (§38.1.1).
     *
     * Le corps est celui du vrai fournisseur : c'est son message que l'écran
     * doit rendre tel quel, parce qu'« expired » et « permission denied »
     * n'appellent pas le même geste.
     */
    refuserZones(corps = null, status = 401) {
      refus = corps ? { status, corps } : null;
    },
    async demonter() {
      await new Promise((r) => serveur.close(r));
    },
  };
}
