/**
 * Fournisseur DNS piloté par l'hôte console.
 *
 * @spec docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.6 (les recettes),
 *       §38.6.1 (une recette est une fonction), §38.6.2 (la garde élargie),
 *       §38.6.3 (le compte rendu), §38.6.4 (les deux premières recettes)
 * @spec docs/BACKLOG.md#SPK-47 · docs/DAT.md §38 (le DNS entre dans le
 *       périmètre), §38.1 (où vit le secret), §38.2 (ce que le produit ne fait
 *       pas), §38.3 (ce qu'écrit un enregistrement d'ingress), §38.5 (la garde
 *       d'écriture) · docs/DAT.md §22.4 (l'inventaire ne porte aucun secret)
 * @spec docs/BACKLOG.md#SPK-77 · docs/DAT.md §38.8.3 (la seule suppression que
 *       le produit s'autorise) · §38.2 révisé le 2026-09-02
 *
 * Le jeton vit dans l'environnement de CE processus, jamais sur la Forge et
 * jamais dans `servers.json`. Un jeton absent n'est pas une panne : la fonction
 * se désactive et l'écran le dit.
 *
 * Les gardes de ce fichier ne sont pas des précautions d'usage. Une zone réelle
 * porte des enregistrements dont la casse arrête une messagerie ou invalide une
 * preuve de propriété ; chaque refus ci-dessous est éprouvé par un test.
 */

import { readFile } from 'node:fs/promises';

export class DnsError extends Error {}

/** Types d'une route d'ingress : une route est une adresse, rien d'autre (§38.2). */
export const TYPES = ['A', 'AAAA'];

/**
 * Types qu'une RECETTE sait composer, et la forme que leur donnée doit avoir
 * (§38.6.2).
 *
 * Ce n'est pas une liste de prudence : c'est la liste de ce que le produit sait
 * composer. Écrire un type qu'il ne compose pas serait écrire une valeur qu'il
 * n'a pas vérifiée, et laisser le fournisseur la refuser après coup.
 */
export const FORMES = {
  A: { attendu: 'une adresse IPv4', valide: (d) => estIPv4(d) },
  AAAA: { attendu: 'une adresse IPv6', valide: (d) => d.includes(':') },
  MX: {
    attendu: 'une priorité puis un nom d’hôte, par exemple « 10 mail.exemple.tech. »',
    valide: (d) => /^\d{1,5}\s+\S+$/.test(d),
  },
  TXT: { attendu: 'un texte non vide', valide: (d) => d.trim().length > 0 },
  CNAME: { attendu: 'un nom d’hôte', valide: (d) => /^[a-z0-9.-]+\.?$/i.test(d) },
  SRV: {
    attendu: 'priorité, poids, port et cible, par exemple « 0 1 993 mail.exemple.tech. »',
    valide: (d) => /^\d{1,5}\s+\d{1,5}\s+\d{1,5}\s+\S+$/.test(d),
  },
};

function estIPv4(adresse) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(adresse)
    && adresse.split('.').every((n) => Number(n) <= 255);
}

/** TTL court : une route se déplace, et un TTL long ferait traîner la panne (§38.3). */
export const TTL = 300;

const SCALEWAY = 'https://api.scaleway.com/domain/v2beta1';

/**
 * Lit un fichier `.env` sans rien exiger d'autre que Node.
 *
 * Un fichier absent rend un objet vide : c'est le cas NORMAL d'un poste qui n'a
 * pas configuré de fournisseur, pas une erreur.
 */
export async function readDotEnv(chemin) {
  let texte;
  try {
    texte = await readFile(chemin, 'utf8');
  } catch {
    return {};
  }
  const valeurs = {};
  for (const ligne of texte.split('\n')) {
    const nette = ligne.trim();
    if (!nette || nette.startsWith('#')) continue;
    const coupe = nette.indexOf('=');
    if (coupe <= 0) continue;
    const cle = nette.slice(0, coupe).trim();
    let valeur = nette.slice(coupe + 1).trim();
    if ((valeur.startsWith('"') && valeur.endsWith('"'))
        || (valeur.startsWith("'") && valeur.endsWith("'"))) {
      valeur = valeur.slice(1, -1);
    }
    valeurs[cle] = valeur;
  }
  return valeurs;
}

/**
 * Normalise un nom de domaine pour la comparaison.
 *
 * Le DNS est insensible à la casse, et un point final désigne la racine : sans
 * cette normalisation, `App.Exemple.tech.` et `app.exemple.tech` seraient deux
 * noms différents, et le rapprochement de §38.2 raterait sa cible.
 */
export function normaliser(nom) {
  return String(nom ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** Nom relatif de l'apex, tel que le fournisseur l'attend. */
export const APEX = '';

/**
 * Nom RELATIF à la zone, ou refus motivé (§38.5).
 *
 * REVISE le 2026-08-20 (§38.5.1) : l'apex n'est plus refusé. Il l'était au motif
 * qu'il porte les `NS` et le `MX` — mais l'écriture vise un nom ET un type
 * exacts, donc à l'apex elle ne remplace que les `A`. Le refus interdisait un
 * site sur le domaine nu, cas ordinaire, sans rien protéger que le §38.2 ne
 * protège déjà.
 *
 * Reste UN refus, et il protège quelque chose de réel : un domaine hors de la
 * zone viserait une zone qu'on n'a pas choisie.
 */
export function nomRelatif(domaine, zone) {
  const d = normaliser(domaine);
  const z = normaliser(zone);
  if (!d) throw new DnsError('Aucun domaine fourni.');
  if (!z) throw new DnsError('Aucune zone choisie.');
  if (d === z) return APEX;
  if (!d.endsWith(`.${z}`)) {
    throw new DnsError(`« ${d} » n'est pas dans la zone « ${z} ».`);
  }
  return d.slice(0, -(z.length + 1));
}

/**
 * Type d'enregistrement déduit de l'adresse (§38.3).
 *
 * L'adresse écrite est celle de la FORGE : un Spark vit sur un bridge privé et
 * n'a pas d'adresse publique. C'est Caddy qui répartit ensuite par nom d'hôte.
 */
export function typePourAdresse(adresse) {
  const a = String(adresse ?? '').trim();
  if (!a) throw new DnsError('Aucune adresse fournie.');
  if (a.includes(':')) return 'AAAA';
  if (!estIPv4(a)) throw new DnsError(`« ${a} » n'est pas une adresse IP.`);
  return 'A';
}

/**
 * Garde d'écriture complète (§38.5). Rend ce qui sera écrit, ou refuse.
 *
 * `motif` borne les essais du dépôt à un espace de noms convenu. C'est un
 * paramètre, pas une constante : un exploitant gère sa zone entière, et la
 * garde du harnais ne doit pas devenir une limite du produit.
 */
export function preparerEnregistrement(
  { domain, zone, type, data, ttl = TTL, motif = null }) {
  const name = nomRelatif(domain, zone);
  const apex = name === APEX;
  const t = String(type ?? '').toUpperCase();
  const forme = FORMES[t];
  if (!forme) {
    throw new DnsError(
      `Type « ${type} » refusé : le produit compose ${Object.keys(FORMES).join(', ')}.`);
  }
  const valeur = String(data ?? '').trim();
  if (!valeur) throw new DnsError(`Un enregistrement ${t} sans valeur ne dit rien.`);
  if (!forme.valide(valeur)) {
    throw new DnsError(
      `Valeur « ${valeur} » invalide pour un ${t} : attendu ${forme.attendu}.`);
  }
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new DnsError(`TTL « ${ttl} » hors bornes : 60 à 86400 secondes.`);
  }
  if (motif && !new RegExp(motif).test(normaliser(domain))) {
    throw new DnsError(
      `Écriture refusée : « ${normaliser(domain)} » sort de l'espace de noms `
      + `autorisé sur ce poste (${motif}).`);
  }
  return { zone: normaliser(zone), name, type: t, data: valeur, ttl, apex };
}

export function preparer({ domain, zone, address, ttl = TTL, motif = null }) {
  const name = nomRelatif(domain, zone);
  // `apex` voyage avec la préparation : l'écran le dit, parce qu'écraser le nom
  // nu coupe le domaine ENTIER et non un sous-domaine (§38.5.1).
  const apex = name === APEX;
  const type = typePourAdresse(address);
  if (!TYPES.includes(type)) {
    throw new DnsError(`Type « ${type} » refusé : seuls ${TYPES.join(' et ')} sont écrits.`);
  }
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new DnsError(`TTL « ${ttl} » hors bornes : 60 à 86400 secondes.`);
  }
  if (motif && !new RegExp(motif).test(normaliser(domain))) {
    throw new DnsError(
      `Écriture refusée : « ${normaliser(domain)} » sort de l'espace de noms `
      + `autorisé sur ce poste (${motif}).`,
    );
  }
  return { zone: normaliser(zone), name, type, data: String(address).trim(), ttl, apex };
}

/**
 * Client Scaleway Domain & DNS (v2beta1).
 *
 * Mesuré le 2026-08-19 : le jeton se passe en en-tête `X-Auth-Token`, et
 * `GET /dns-zones` exige l'organisation. Le compte d'essai porte quatorze zones
 * RÉELLES ; c'est pourquoi ce client ne sait ni supprimer, ni transférer, ni
 * acheter (§38.2).
 */
export class ScalewayDns {
  /**
   * Le jeton est un champ PRIVÉ, et ce n'est pas une élégance : mesuré, un champ
   * public sortait dès qu'on sérialisait le fournisseur — donc au premier corps
   * de réponse, au premier journal, au premier rapport de bogue qui l'emporte
   * (§38.1).
   */
  #token;

  constructor({ token, organizationId, projectId = null,
                fetch: fetchFn = fetch, baseUrl = SCALEWAY } = {}) {
    if (!token) throw new DnsError('Aucun jeton : le fournisseur DNS est désactivé.');
    this.#token = token;
    this.organizationId = organizationId;
    this.projectId = projectId;
    this.fetch = fetchFn;
    this.baseUrl = baseUrl;
  }

  async #appel(chemin, options = {}) {
    const reponse = await this.fetch(`${this.baseUrl}${chemin}`, {
      ...options,
      headers: {
        'X-Auth-Token': this.#token,
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    const texte = await reponse.text();
    if (!reponse.ok) {
      // Le message du fournisseur est rendu TEL QUEL : « HTTP 403 » seul
      // laisserait chercher entre un jeton faux, une permission manquante et
      // une zone qui n'est pas au compte.
      throw new DnsError(
        `Le fournisseur DNS a refusé (HTTP ${reponse.status}) : ${texte.slice(0, 400)}`,
      );
    }
    return texte ? JSON.parse(texte) : {};
  }

  /** Zones du compte. Lecture seule. */
  async zones() {
    const parametres = new URLSearchParams({ page_size: '100' });
    if (this.organizationId) parametres.set('organization_id', this.organizationId);
    const { dns_zones: zones = [] } = await this.#appel(`/dns-zones?${parametres}`);
    return zones.map((z) => ({
      // Le nom complet d'une zone Scaleway est `subdomain.domain`, et il est
      // vide au niveau du domaine lui-même : le recomposer ici évite que chaque
      // appelant refasse — différemment — la même concaténation.
      zone: [z.subdomain, z.domain].filter(Boolean).join('.'),
      domain: z.domain,
      subdomain: z.subdomain ?? '',
      status: z.status,
      records: z.ns?.length ?? 0,
    }));
  }

  /** Enregistrements d'une zone. Lecture seule. */
  async records(zone) {
    const { records = [] } = await this.#appel(
      `/dns-zones/${encodeURIComponent(normaliser(zone))}/records?page_size=100`,
    );
    return records.map((r) => ({
      name: r.name, type: r.type, data: r.data, ttl: r.ttl, id: r.id,
    }));
  }

  /**
   * Ce qui occupe DÉJÀ ce couple nom + type, ou `null` (§38.5.2).
   *
   * On lit avant d'écrire pour que l'écran puisse dire « remplacera telle
   * valeur » au lieu de « posera ». Un écrasement est le comportement voulu —
   * reposer une route déplacée doit marcher — mais il ne doit jamais surprendre,
   * et c'est ce qui autorise à ne plus refuser l'apex.
   */
  async existant({ zone, name, type }) {
    const tous = await this.records(zone);
    return tous.find((r) => (r.name ?? '') === name && r.type === type) ?? null;
  }

  /**
   * Pose OU met à jour l'enregistrement d'ingress, et lui seul.
   *
   * `set` sur `id_fields {name, type}` remplace exactement les enregistrements
   * de ce nom ET de ce type. Un `MX`, un `TXT` de vérification ou un `A` voisin
   * n'est pas touché : le rapprochement se fait sur le nom EXACT, jamais sur un
   * préfixe (§38.2).
   *
   * `disallow_new_zone_creation` est posé : une faute de frappe sur la zone doit
   * échouer, pas créer une zone.
   */
  async setRecord(prepare) {
    const { zone, name, type, data, ttl } = prepare;
    const corps = {
      changes: [{
        set: {
          id_fields: { name, type },
          records: [{ name, type, data, ttl }],
        },
      }],
      return_all_records: false,
      disallow_new_zone_creation: true,
    };
    await this.#appel(`/dns-zones/${encodeURIComponent(zone)}/records`, {
      method: 'PATCH',
      body: JSON.stringify(corps),
    });
    // On rend ce qui a été ÉCRIT, jamais « le domaine est prêt » : la
    // propagation prend le temps du TTL et un cache chaud sert encore
    // l'ancienne réponse (§38.4).
    return { ...prepare, fqdn: `${name}.${zone}`, written: true };
  }

  /**
   * Retire l'enregistrement de CE nom et de CE type, et rien d'autre (§38.8.3).
   *
   * Cette méthode ne juge RIEN : elle exécute. Les quatre conditions du §38.8.3
   * sont vérifiées par l'appelant, sur une lecture fraîche, avant d'arriver ici.
   * Les dédoubler ici ferait deux règles à maintenir, dont une finirait par
   * mentir.
   *
   * `id_fields` vise le couple nom + type exact — la même précision qu'à
   * l'écriture (§38.2) : un `MX` ou un `TXT` du même nom n'est pas touché.
   */
  async deleteRecord({ zone, name, type }) {
    const corps = {
      changes: [{ delete: { id_fields: { name, type } } }],
      return_all_records: false,
      disallow_new_zone_creation: true,
    };
    await this.#appel(`/dns-zones/${encodeURIComponent(normaliser(zone))}/records`, {
      method: 'PATCH',
      body: JSON.stringify(corps),
    });
    return { zone: normaliser(zone), name, type, deleted: true };
  }
}

/**
 * Construit le fournisseur depuis un environnement, ou explique son absence.
 *
 * Rend TOUJOURS un objet : la console doit pouvoir dire « pas de fournisseur
 * configuré » sans traiter ce cas normal comme une panne (§38.1).
 */
export function fournisseurDepuis(env = {}, { fetch: fetchFn = fetch } = {}) {
  const token = env.SCW_SECRET_KEY;
  const motif = env.SPARK_DNS_ALLOW_PATTERN || null;
  // `SPARK_DNS_BASE_URL` fait parler le MÊME client à un doublon local, comme
  // `FakeIncus` et `FakeCaddy` le font pour le reste de la pile (§28.1) : le
  // harnais éprouve le vrai code jusqu'au corps de la requête HTTP, sans
  // qu'aucun parcours automatique n'atteigne quatorze zones en exploitation.
  const baseUrl = env.SPARK_DNS_BASE_URL || SCALEWAY;
  if (!token) {
    return {
      configured: false,
      provider: null,
      motif,
      reason: "Aucun jeton DNS sur ce poste : poser un `SCW_SECRET_KEY` dans le "
              + "`.env` local pour activer le pilotage du DNS.",
    };
  }
  return {
    configured: true,
    motif,
    reason: null,
    provider: new ScalewayDns({
      token,
      organizationId: env.SCW_DEFAULT_ORGANIZATION_ID,
      projectId: env.SCW_DEFAULT_PROJECT_ID,
      fetch: fetchFn,
      baseUrl,
    }),
  };
}
