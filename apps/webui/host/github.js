/**
 * Les clés de déploiement GitHub d'un Spark, pilotées par l'hôte console.
 *
 * @spec docs/BACKLOG.md#SPK-178 · docs/DAT.md §71 (la console pose la clé du
 *       Spark chez GitHub), §71.1 (un Spark, un dépôt), §71.2 (le jeton : où, par
 *       qui, comment), §71.3 (les gestes et la garde), §71.4 (ce que GitHub
 *       répond), §71.5 (où cela vit)
 * @spec docs/DAT.md §38.1 (qui détient le secret) · §17.5 (l'identité que le Spark
 *       présente) · §22.4 (l'inventaire ne porte aucun secret)
 *
 * Le jeton vit dans l'environnement de CE processus, jamais sur la Forge et
 * jamais dans `servers.json` : même raisonnement que le jeton DNS. Un jeton
 * absent n'est pas une panne, la fonction se désactive et l'écran le dit.
 *
 * Ce client ne sait faire que trois choses sur un dépôt : lister ses clés de
 * déploiement, en poser une, en retirer une. Il ne crée pas de dépôt, ne touche
 * ni aux collaborateurs, ni aux secrets, ni aux webhooks. Les gardes de ce
 * fichier sont des règles, et un test éprouve chacune.
 */

export class GithubError extends Error {
  /** `code` est stable : l'écran et les tests s'y accrochent, jamais au texte. */
  constructor(message, { code = 'refus', status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const GITHUB = 'https://api.github.com';

/** Un appel qui ne répond pas ne doit pas figer l'écran (CLAUDE.md §19). */
const DELAI_MS = 15_000;

/** Une page de clés ; au-delà, on pagine. Un dépôt en porte rarement plus de dix. */
const PAR_PAGE = 100;
const PAGES_MAX = 5;

/** Les types de clé publique que GitHub accepte en clé de déploiement. */
const TYPES_DE_CLE = new Set([
  'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

/**
 * Le dépôt, saisi `propriétaire/dépôt` (§71.3).
 *
 * La forme est vérifiée AVANT tout appel : la saisie finit dans un chemin d'URL,
 * et `../` ou `?x=1` y changeraient de cible.
 */
export function depotDepuis(brut) {
  const texte = String(brut ?? '').trim();
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(texte);
  if (!m || m[2] === '.' || m[2] === '..') {
    throw new GithubError(
      'Le dépôt se saisit sous la forme « propriétaire/dépôt », par exemple '
      + '« p2enjoy/crm ».', { code: 'depot_invalide' });
  }
  return { proprietaire: m[1], depot: m[2], nom: `${m[1]}/${m[2]}` };
}

/**
 * Le CORPS d'une clé publique : type et base64, sans commentaire.
 *
 * C'est ce que GitHub rend dans `key`, et ce qui permet de comparer sans se
 * fier à un titre ou à un commentaire que n'importe qui peut écrire.
 *
 * GARDE (§71.3) : une clé privée n'est jamais envoyée. Le refus ne cite aucun
 * octet de ce qui a été reçu, parce qu'un message d'erreur finit dans un journal.
 */
export function corpsDeCle(brut) {
  const texte = String(brut ?? '');
  if (/PRIVATE KEY/i.test(texte)) {
    throw new GithubError(
      'Ce texte est une clé PRIVÉE : elle ne quitte jamais la cellule. '
      + 'Seule la clé publique se pose chez GitHub.', { code: 'cle_privee' });
  }
  const [type, base64] = texte.trim().split(/\s+/);
  if (!TYPES_DE_CLE.has(type) || !base64 || !/^[A-Za-z0-9+/]{16,}={0,3}$/.test(base64)) {
    throw new GithubError(
      'Ce texte n’est pas une clé publique SSH lisible (type puis base64).',
      { code: 'cle_illisible' });
  }
  return `${type} ${base64}`;
}

/** Le titre que porte la clé chez GitHub : il nomme le Spark d'où elle vient. */
export function titreDeCle(spark) {
  return `spark:${spark}`;
}

/**
 * Où en est la clé du Spark sur ce dépôt (§71.3).
 *
 * - `posee` : une clé du dépôt a EXACTEMENT ce corps ;
 * - `perimee` : une clé porte le titre du Spark mais un autre corps — l'identité
 *   a été régénérée depuis (§17.5) ;
 * - `non_posee` : ni l'un ni l'autre.
 *
 * Le résultat ne rend que ce qui concerne CE Spark. Les autres clés du dépôt
 * appartiennent à d'autres usages : ni leur corps, ni leur titre, ni leur nombre
 * ne sortent d'ici.
 */
export function etatDeLaCle({ cles, corps, spark }) {
  const accord = cles.find((c) => c.key === corps);
  const concerne = accord ?? cles.find((c) => c.title === titreDeCle(spark));
  if (!concerne) return { state: 'non_posee' };
  return {
    state: accord ? 'posee' : 'perimee',
    access: concerne.read_only ? 'lecture' : 'ecriture',
    id: concerne.id,
    title: concerne.title,
  };
}

/**
 * Client des clés de déploiement GitHub (API REST, version 2022-11-28).
 *
 * Aucune nouvelle tentative automatique : une écriture rejouée à l'aveugle sur un
 * dépôt tiers n'est pas une précaution, c'est un second geste que personne n'a
 * demandé (§71.4).
 */
export class GithubDeployKeys {
  /**
   * Champ PRIVÉ, comme pour le DNS (§38.1) : un champ public sortirait dès
   * qu'on sérialise le client, donc au premier corps de réponse, au premier
   * journal, au premier rapport de bogue qui l'emporte.
   */
  #token;

  constructor({ token, fetch: fetchFn = fetch, baseUrl = GITHUB } = {}) {
    if (!token) throw new GithubError(
      'Aucun jeton : le fournisseur GitHub est désactivé.', { code: 'sans_jeton' });
    this.#token = token;
    this.fetch = fetchFn;
    this.baseUrl = baseUrl;
  }

  async #appel(chemin, { methode = 'GET', corps = null } = {}) {
    let reponse;
    try {
      reponse = await this.fetch(`${this.baseUrl}${chemin}`, {
        method: methode,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          // GitHub refuse toute requête sans User-Agent. Un nom générique : rien
          // du poste, du compte ni du projet n'a à sortir par cet en-tête.
          'User-Agent': 'spark-console',
          ...(corps ? { 'content-type': 'application/json' } : {}),
        },
        ...(corps ? { body: JSON.stringify(corps) } : {}),
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (erreur) {
      const delai = erreur?.name === 'TimeoutError' || erreur?.name === 'AbortError';
      throw new GithubError(
        delai
          ? 'GitHub n’a pas répondu à temps. Rien n’est dit de l’état de la clé : relisez.'
          : 'GitHub est injoignable depuis ce poste. Rien n’est dit de l’état de la clé : relisez.',
        { code: delai ? 'delai' : 'injoignable' });
    }
    const texte = await reponse.text();
    if (!reponse.ok) throw this.#refus(reponse, texte);
    return texte ? JSON.parse(texte) : {};
  }

  /**
   * Traduit une réponse de refus en ce qui MANQUE réellement (§71.4).
   *
   * « HTTP 403 » nu laisserait chercher entre une permission manquante et une
   * limite de débit, qui se règlent à deux endroits différents.
   */
  #refus(reponse, texte) {
    const { status } = reponse;
    let message = '';
    try {
      const analyse = JSON.parse(texte);
      message = [analyse.message, ...(analyse.errors ?? []).map((e) => e.message ?? e)]
        .filter(Boolean).join(' · ');
    } catch { /* corps non JSON : le statut suffit */ }
    const c = (code, dit) => new GithubError(dit, { code, status });
    if (status === 401) {
      return c('refuse', 'Jeton refusé par GitHub : il est expiré ou révoqué. '
        + 'Créez-en un autre et remplacez-le dans le `.env` du poste.');
    }
    if (status === 403 || status === 429) {
      if (reponse.headers?.get?.('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)
          || status === 429) {
        return c('debit', 'GitHub limite le débit de ce jeton. Attendez avant de réessayer.');
      }
      return c('permission', 'Le jeton n’a pas la permission « Administration » en '
        + 'écriture sur ce dépôt : GitHub la réclame pour gérer les clés de déploiement.');
    }
    if (status === 404) {
      return c('introuvable', 'Dépôt introuvable, ou le jeton n’y a pas accès : GitHub '
        + 'ne distingue pas les deux. Vérifiez le nom, et que le jeton couvre ce dépôt.');
    }
    if (status === 422 && /already in use/i.test(message)) {
      return c('cle_deja_utilisee', 'Un Spark sert un seul dépôt : cette clé est déjà '
        + 'posée ailleurs chez GitHub (un autre dépôt, ou un autre usage).');
    }
    return c('indisponible',
      `GitHub a refusé (HTTP ${status})${message ? ` : ${message.slice(0, 200)}` : '.'}`);
  }

  async #cles(depot) {
    const toutes = [];
    for (let page = 1; page <= PAGES_MAX; page += 1) {
      const lot = await this.#appel(
        `/repos/${depot.proprietaire}/${depot.depot}/keys?per_page=${PAR_PAGE}&page=${page}`);
      const liste = Array.isArray(lot) ? lot : [];
      toutes.push(...liste.map((c) => ({
        id: c.id, key: String(c.key ?? '').trim().split(/\s+/).slice(0, 2).join(' '),
        title: c.title, read_only: c.read_only !== false,
      })));
      if (liste.length < PAR_PAGE) break;
    }
    return toutes;
  }

  /** Où en est la clé du Spark sur ce dépôt. Lecture seule. */
  async verifier({ depot, corps, spark }) {
    return etatDeLaCle({ cles: await this.#cles(depot), corps, spark });
  }

  /**
   * Pose la clé du Spark, lecture seule sauf intention explicite.
   *
   * `ecriture` doit valoir exactement `true` : une chaîne « false » ou un 1 qui
   * passerait pour un accord ouvrirait l'écriture sur un dépôt tiers.
   */
  async poser({ depot, corps, spark, ecriture = false }) {
    const lectureSeule = ecriture !== true;
    const actuel = etatDeLaCle({ cles: await this.#cles(depot), corps, spark });

    if (actuel.state === 'posee') {
      if ((actuel.access === 'lecture') === lectureSeule) {
        return { ...actuel, changed: false, replaced: false };
      }
      // GitHub ne modifie pas l'accès d'une clé : il faut la retirer puis la
      // reposer, et entre les deux le Spark perd son accès. Ce n'est pas un
      // effet de bord qu'on déclenche sans que l'exploitant l'ait voulu.
      throw new GithubError(
        `Cette clé est déjà posée en ${actuel.access === 'lecture' ? 'lecture seule' : 'écriture'}. `
        + 'Pour changer l’accès, retirez-la, puis posez-la de nouveau.',
        { code: 'acces_different' });
    }

    let remplace = false;
    if (actuel.state === 'perimee') {
      // La clé retirée est celle qui porte le titre de CE Spark, et aucune autre.
      await this.#appel(`/repos/${depot.proprietaire}/${depot.depot}/keys/${actuel.id}`,
        { methode: 'DELETE' });
      remplace = true;
    }

    try {
      const cree = await this.#appel(`/repos/${depot.proprietaire}/${depot.depot}/keys`, {
        methode: 'POST',
        corps: { title: titreDeCle(spark), key: corps, read_only: lectureSeule },
      });
      return { state: 'posee', access: lectureSeule ? 'lecture' : 'ecriture',
               id: cree.id, title: titreDeCle(spark), changed: true, replaced: remplace };
    } catch (erreur) {
      if (remplace && erreur instanceof GithubError) {
        // Dire l'état réel : l'ancienne clé n'est plus là, la nouvelle n'y est pas.
        throw new GithubError(
          `L’ancienne clé a été retirée, mais la nouvelle n’a pas été posée : ${erreur.message}`,
          { code: erreur.code, status: erreur.status });
      }
      throw erreur;
    }
  }

  /**
   * Retire la clé du Spark de ce dépôt, et elle seule.
   *
   * GARDE (§71.3) : on relit d'abord, et seule une clé qui porte le corps du
   * Spark, ou son titre périmé, peut partir. Les autres clés du dépôt servent
   * d'autres usages : ni listées, ni touchées.
   */
  async retirer({ depot, corps, spark }) {
    const actuel = etatDeLaCle({ cles: await this.#cles(depot), corps, spark });
    if (actuel.state === 'non_posee') {
      throw new GithubError(
        'Aucune clé de ce Spark sur ce dépôt : il n’y a rien à retirer.', { code: 'absente' });
    }
    await this.#appel(`/repos/${depot.proprietaire}/${depot.depot}/keys/${actuel.id}`,
      { methode: 'DELETE' });
    return { state: 'non_posee', removed: true, was: actuel.state, id: actuel.id };
  }
}

/**
 * Construit le fournisseur depuis l'environnement, ou explique son absence.
 *
 * Rend TOUJOURS un objet : la console doit pouvoir dire « pas de jeton » sans
 * traiter ce cas normal comme une panne (§38.1).
 *
 * `baseUrl` est un ARGUMENT, jamais une variable lue ici : le doublon d'épreuve
 * entre par `epreuve.commande('SPARK_GITHUB_BASE_URL')`, qui l'ignore hors de
 * `SPARK_EPREUVE=1` et le dit (§53.3, §71.6). Une variable lue ici sans ce
 * garde-fou serait un levier que rien ne signalerait.
 */
export function fournisseurGithubDepuis(env = {}, { fetch: fetchFn = fetch, baseUrl = null } = {}) {
  const token = String(env.SPARK_GITHUB_DEPLOY_TOKEN ?? '').trim();
  if (!token) {
    return {
      configured: false,
      provider: null,
      reason: 'Aucun jeton GitHub sur ce poste : poser un `SPARK_GITHUB_DEPLOY_TOKEN` '
              + 'dans le `.env` local pour activer la pose des clés de déploiement.',
    };
  }
  return {
    configured: true,
    reason: null,
    provider: new GithubDeployKeys({ token, fetch: fetchFn, baseUrl: baseUrl || GITHUB }),
  };
}
