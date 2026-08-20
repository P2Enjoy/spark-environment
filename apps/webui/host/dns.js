/**
 * Fournisseur DNS piloté par l'hôte console.
 *
 * @spec docs/BACKLOG.md#SPK-47 · docs/DAT.md §38 (le DNS entre dans le
 *       périmètre), §38.1 (où vit le secret), §38.2 (ce que le produit ne fait
 *       pas), §38.3 (ce qu'écrit un enregistrement d'ingress), §38.5 (la garde
 *       d'écriture) · docs/DAT.md §22.4 (l'inventaire ne porte aucun secret)
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

/** Seuls types écrits (§38.2) : une route d'ingress est une adresse, rien d'autre. */
export const TYPES = ['A', 'AAAA'];

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

/**
 * Nom RELATIF à la zone, ou refus motivé (§38.5).
 *
 * Trois refus, et chacun protège quelque chose de réel :
 * - l'apex porte les `NS` et le `MX` de la zone ; y écrire un `A` d'ingress
 *   n'est pas une erreur de frappe rattrapable ;
 * - un domaine hors de la zone viserait une zone qu'on n'a pas choisie ;
 * - un nom vide vaut l'apex.
 */
export function nomRelatif(domaine, zone) {
  const d = normaliser(domaine);
  const z = normaliser(zone);
  if (!d) throw new DnsError('Aucun domaine fourni.');
  if (!z) throw new DnsError('Aucune zone choisie.');
  if (d === z) {
    throw new DnsError(
      `« ${d} » est l'apex de la zone : il porte ses serveurs de noms et sa `
      + "messagerie. Le produit n'y écrit pas. Choisir un sous-domaine.",
    );
  }
  if (!d.endsWith(`.${z}`)) {
    throw new DnsError(`« ${d} » n'est pas dans la zone « ${z} ».`);
  }
  const relatif = d.slice(0, -(z.length + 1));
  if (!relatif || relatif === '@') {
    throw new DnsError(`Nom relatif vide pour « ${d} » dans « ${z} ».`);
  }
  return relatif;
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
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a)
      || a.split('.').some((n) => Number(n) > 255)) {
    throw new DnsError(`« ${a} » n'est pas une adresse IP.`);
  }
  return 'A';
}

/**
 * Garde d'écriture complète (§38.5). Rend ce qui sera écrit, ou refuse.
 *
 * `motif` borne les essais du dépôt à un espace de noms convenu. C'est un
 * paramètre, pas une constante : un exploitant gère sa zone entière, et la
 * garde du harnais ne doit pas devenir une limite du produit.
 */
export function preparer({ domain, zone, address, ttl = TTL, motif = null }) {
  const name = nomRelatif(domain, zone);
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
  return { zone: normaliser(zone), name, type, data: String(address).trim(), ttl };
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
