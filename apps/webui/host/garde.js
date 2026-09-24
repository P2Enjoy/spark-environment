/**
 * La garde de l'hôte console : il n'obéit qu'à sa propre page.
 *
 * @spec docs/BACKLOG.md#SPK-118 · docs/DAT.md §63.2 (trois gardes, à un seul
 *       endroit), §63.1 (le défaut mesuré)
 *
 * L'hôte n'écoute que sur `127.0.0.1`, mais le navigateur de l'exploitant
 * l'atteint avec toutes ses autres pages. Trois gardes, examinées AVANT toute
 * route — routes de l'hôte, flux de terminal, relais `/api/v1/*`, fichiers :
 *
 * - l'HÔTE arrête le DNS rebinding, qui rend une page piégée « de même origine »
 *   et lui fait lire les réponses ;
 * - l'ORIGINE arrête le geste d'un site tiers ;
 * - le CORPS JSON impose le pré-vol CORS, que l'hôte ne satisfait jamais.
 *
 * Verdict PUR : la requête arrive décrite, le port est lu sur la socket par
 * l'appelant. Aucun réglage.
 */

const LECTURES = new Set(['GET', 'HEAD', 'OPTIONS']);
const NOMS_LOCAUX = ['127.0.0.1', 'localhost'];

/**
 * Rend `null` si la requête passe, sinon `{ status, error, message }`.
 *
 * `headers` est l'objet de Node : noms en minuscules, valeurs en chaînes.
 */
export function examinerRequete({ method, headers = {}, port }) {
  const hote = String(headers.host ?? '').toLowerCase();
  const attendus = NOMS_LOCAUX.map((nom) => `${nom}:${port}`);
  if (!attendus.includes(hote)) {
    return { status: 403, error: 'hote_refuse',
      message: `La console ne répond qu’à ${attendus.join(' ou ')}.` };
  }
  if (LECTURES.has(String(method).toUpperCase())) return null;

  // `in` et non `??` : `Origin: null` est une valeur, et elle se refuse.
  if ('origin' in headers && headers.origin !== `http://${hote}`) {
    return { status: 403, error: 'origine_refusee',
      message: 'Ce geste ne vient pas de la page de la console : il est refusé.' };
  }
  if (!/^application\/json\b/i.test(String(headers['content-type'] ?? ''))) {
    return { status: 415, error: 'json_requis',
      message: 'Corps JSON exigé : la console ne répond qu’à sa propre page.' };
  }
  return null;
}
