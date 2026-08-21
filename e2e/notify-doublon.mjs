/**
 * Canal hors bande jetable, pour éprouver SPK-62 de bout en bout.
 *
 * @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (le webhook a été retenu
 *       parce qu'il se DOUBLE localement), §47.4 (ce que l'envoi porte),
 *       §47.5 (un canal injoignable ne fait jamais échouer un geste)
 *
 * C'est un VRAI serveur HTTP, pas un doublon de la fonction d'envoi : ce qu'on
 * veut mesurer est ce qui part sur le réseau, pas ce qu'on croit avoir donné à
 * `urllib`. Même motif que `dns-doublon.mjs`.
 */

import { createServer } from 'node:http';

export async function monterCanalNotify({ refuse = false } = {}) {
  const recus = [];

  const serveur = createServer(async (requete, reponse) => {
    const morceaux = [];
    for await (const bloc of requete) morceaux.push(bloc);
    const brut = Buffer.concat(morceaux).toString('utf8');
    try {
      recus.push(JSON.parse(brut));
    } catch {
      // On garde même ce qui n'est pas du JSON : un envoi malformé doit se voir
      // dans le parcours, pas disparaître dans un `catch`.
      recus.push({ brut });
    }
    reponse.writeHead(refuse ? 500 : 200, { 'content-length': '0' });
    reponse.end();
  });

  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}/notify`,
    recus,
    /** Attend qu'au moins `n` messages soient arrivés, ou rend ce qu'il y a. */
    async attendre(n = 1, { tentatives = 60, delaiMs = 100 } = {}) {
      for (let i = 0; i < tentatives && recus.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, delaiMs));
      }
      return recus;
    },
    oublier() { recus.length = 0; },
    demonter() { return new Promise((r) => serveur.close(r)); },
  };
}
