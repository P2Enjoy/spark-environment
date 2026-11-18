/**
 * Doublon local de l'API GitHub des clés de déploiement, pour le harnais.
 *
 * @spec docs/BACKLOG.md#SPK-178 · docs/DAT.md §71.6 (le sixième doublon), §71.8
 *       (la vérification), §28.1 (le produit tient sans réseau sortant)
 *
 * Au même titre que le doublon DNS : il parle la forme de l'API réelle, et c'est
 * le VRAI client de la console qui l'interroge — le harnais éprouve donc le code
 * jusqu'au corps de la requête HTTP.
 *
 * CE QU'IL NE PROUVE PAS, et qu'il ne faut pas lui faire dire : que GitHub se
 * comporte ainsi. En particulier, le refus « key is already in use » d'une même
 * clé sur un second dépôt est l'HYPOTHÈSE du DAT §71.1, que ce doublon encode ; il
 * ne la démontre pas. Elle se mesure sur deux dépôts jetables, avec le jeton du
 * responsable, et le résultat se consigne dans `docs/JOURNAL.md`.
 *
 * Il porte des dépôts qui ne se ressemblent pas, parce que chaque refus du §71.4
 * a son dépôt : un qui marche, un second pour la clé déjà utilisée, un dont le
 * jeton n'a pas la permission, un qui n'existe pas. Et une clé VOISINE sur le
 * premier, parce que la règle à éprouver est qu'elle ne bouge pas.
 */

import { createServer } from 'node:http';

export const JETON = 'jeton-de-doublon-github';

/** Le dépôt d'un Spark, et celui qui sert à éprouver « un Spark, un dépôt ». */
export const DEPOT = 'p2enjoy/crm';
export const AUTRE_DEPOT = 'p2enjoy/autre';
/** Le jeton n'a pas la permission « Administration » ici : GitHub répond 403. */
export const DEPOT_INTERDIT = 'p2enjoy/interdit';
export const DEPOT_INCONNU = 'p2enjoy/fantome';

/** Une clé qui n'est pas celle d'un Spark : elle doit survivre à tout parcours. */
export const CLE_VOISINE = {
  id: 1, title: 'ci-deploy', read_only: true,
  key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIVoisine000000000000000000000000000000000000',
};

export async function monterDoublonGithub() {
  const depots = new Map([
    [DEPOT, [{ ...CLE_VOISINE }]],
    [AUTRE_DEPOT, []],
    [DEPOT_INTERDIT, []],
  ]);
  const recus = [];
  let suivant = 100;
  // §71.4 : un jeton expiré est un état à ÉPROUVER, pas à imaginer.
  let refus = null;

  const serveur = createServer(async (requete, reponse) => {
    const url = new URL(requete.url, 'http://127.0.0.1');
    const rendre = (status, corps) => {
      reponse.writeHead(status, { 'content-type': 'application/json' });
      reponse.end(corps === null ? undefined : JSON.stringify(corps));
    };
    const morceaux = [];
    for await (const bloc of requete) morceaux.push(bloc);
    const brut = Buffer.concat(morceaux).toString('utf8');
    const corps = brut ? JSON.parse(brut) : null;
    recus.push({ methode: requete.method, chemin: url.pathname, corps,
                 jeton: requete.headers.authorization ?? null });

    if (requete.headers.authorization !== `Bearer ${JETON}` || refus) {
      const r = refus ?? { status: 401, corps: { message: 'Bad credentials' } };
      return rendre(r.status, r.corps);
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/keys(?:\/(\d+))?$/.exec(url.pathname);
    if (!m) return rendre(404, { message: 'Not Found' });
    const nom = `${m[1]}/${m[2]}`;
    if (nom === DEPOT_INTERDIT) {
      return rendre(403, { message: 'Resource not accessible by personal access token' });
    }
    if (!depots.has(nom)) return rendre(404, { message: 'Not Found' });
    const cles = depots.get(nom);

    if (requete.method === 'GET') return rendre(200, cles);
    if (requete.method === 'POST') {
      const cle = String(corps?.key ?? '').trim().split(/\s+/).slice(0, 2).join(' ');
      // L'HYPOTHÈSE du §71.1 : une clé ne sert qu'un dépôt, sur tout GitHub.
      const prise = [...depots.values()].some((l) => l.some((c) => c.key === cle));
      if (prise) {
        return rendre(422, { message: 'Validation Failed',
                             errors: [{ message: 'key is already in use' }] });
      }
      const creee = { id: suivant++, key: cle, title: corps.title,
                      read_only: corps.read_only !== false };
      cles.push(creee);
      return rendre(201, creee);
    }
    if (requete.method === 'DELETE' && m[3]) {
      depots.set(nom, cles.filter((c) => String(c.id) !== m[3]));
      return rendre(204, null);
    }
    return rendre(405, { message: 'Method Not Allowed' });
  });

  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${serveur.address().port}`,
    jeton: JETON,
    /** Les clés d'un dépôt, pour CONSTATER l'effet d'un parcours (§29.3). */
    cles: (depot = DEPOT) => (depots.get(depot) ?? []).map((c) => ({ ...c })),
    /** Les requêtes réellement reçues : ce que le produit a demandé. */
    recus: () => recus.map((r) => ({ ...r })),
    /** Fait REFUSER toute requête (jeton expiré), ou lève le refus avec `null`. */
    refuser(corps = null, status = 401) {
      refus = corps ? { status, corps } : null;
    },
    /** Pose une clé directement, comme si elle venait d'ailleurs. */
    poser(depot, cle) {
      depots.set(depot, [...(depots.get(depot) ?? []), { id: suivant++, read_only: true, ...cle }]);
    },
    async demonter() {
      await new Promise((r) => serveur.close(r));
    },
  };
}
