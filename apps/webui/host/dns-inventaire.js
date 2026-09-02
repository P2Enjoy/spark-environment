/**
 * L'inventaire DNS d'une Forge : ce qui pointe vers elle, et ce qui s'est perdu.
 *
 * @spec docs/BACKLOG.md#SPK-77 · docs/DAT.md §38.8 (l'inventaire),
 *       §38.8.1 (le périmètre étroit), §38.8.2 (les deux verdicts),
 *       §38.8.3 (les quatre conditions d'une suppression) · §38.2 révisé ·
 *       §18.3 bis (le rapprochement, qui se fait chez `sparkd`)
 *
 * Ce module ne parle ni au fournisseur DNS ni à `sparkd` : il reçoit ce qu'ils
 * ont dit et en tire un verdict. C'est ce qui le rend éprouvable sans réseau, et
 * c'est aussi ce qui permet à la route de suppression de RECONSTATER les
 * conditions avec exactement le même code que celui qui les a affichées.
 */

/** Types d'une route d'ingress. Un `CNAME` vers la Forge n'en est pas une : il
 *  désigne un NOM, pas cette adresse, et le §38.8.1 ne le retient pas. */
export const TYPES_INGRESS = ['A', 'AAAA'];

/**
 * Le nom pleinement qualifié d'un enregistrement, depuis son nom RELATIF.
 *
 * Un nom vide désigne l'apex : la zone elle-même. Le composer par
 * concaténation naïve donnerait « .exemple.tech ».
 */
export function fqdn(name, zone) {
  const n = String(name ?? '').trim().replace(/\.$/, '');
  const z = String(zone ?? '').trim().toLowerCase().replace(/\.$/, '');
  return n ? `${n.toLowerCase()}.${z}` : z;
}

/**
 * L'enregistrement désigne-t-il CETTE Forge ? (§38.8.1)
 *
 * Les deux conditions sont indissociables. Le type seul retiendrait le `A` d'une
 * autre machine ; l'adresse seule retiendrait un `TXT` qui la cite, par exemple
 * un SPF `ip4:203.0.113.7` — que le produit n'a aucune raison de toucher.
 */
export function pointeVers(enregistrement, adresse) {
  const cible = String(adresse ?? '').trim();
  if (!cible) return false;
  return TYPES_INGRESS.includes(String(enregistrement?.type ?? '').toUpperCase())
    && String(enregistrement?.data ?? '').trim() === cible;
}

/**
 * L'inventaire, depuis les relevés bruts (§38.8.2).
 *
 * `zones` : `[{ zone, records: [...] }]` tel que le fournisseur les a rendus.
 * `matches` : ce que `sparkd` a répondu, `{ <fqdn>: {domain, spark_name} | null }`.
 *
 * Le verdict « perdu » se dit **aucune route ne le sert**, jamais « inutile » :
 * le produit ignore si l'exploitant sert ce nom sur la Forge par un autre moyen,
 * et l'affirmer ferait supprimer ce qui marchait (§38.8.2).
 */
export function inventorier({ zones = [], adresse, matches = {} }) {
  const entrees = [];
  for (const { zone, records = [] } of zones) {
    for (const r of records) {
      if (!pointeVers(r, adresse)) continue;
      const nom = fqdn(r.name, zone);
      const servie = matches[nom] ?? null;
      entrees.push({
        zone, name: r.name ?? '', fqdn: nom, type: String(r.type).toUpperCase(),
        data: r.data, ttl: r.ttl ?? null,
        // `apex` voyage jusqu'à l'écran : retirer le nom nu coupe le domaine
        // ENTIER, et l'écran doit pouvoir le dire avant de confirmer (§38.5.1).
        apex: !r.name,
        served: Boolean(servie),
        route: servie?.domain ?? null,
        spark: servie?.spark_name ?? null,
      });
    }
  }
  // Les perdues d'abord : ce sont elles qui appellent un geste. À l'intérieur
  // d'un même verdict, l'ordre du nom, pour que deux relevés se comparent.
  return entrees.sort((a, b) =>
    (a.served === b.served ? a.fqdn.localeCompare(b.fqdn) : (a.served ? 1 : -1)));
}

/** Les noms à soumettre au rapprochement, sans doublon. */
export function nomsARapprocher(zones = [], adresse) {
  const noms = new Set();
  for (const { zone, records = [] } of zones) {
    for (const r of records) {
      if (pointeVers(r, adresse)) noms.add(fqdn(r.name, zone));
    }
  }
  return [...noms];
}

/**
 * Ce que la zone porte MAINTENANT, ligne à ligne (SPK-78, §38.9.1).
 *
 * @spec docs/BACKLOG.md#SPK-78 · docs/DAT.md §38.9.1 (relire plutôt que
 *       persister), §38.9.2 (conforme ne veut pas dire résolu)
 *
 * Trois états, et pas un de plus : `conforme`, `different` — la valeur trouvée
 * est NOMMÉE, sans quoi on ne saurait pas quoi corriger — et `absent`.
 *
 * Ce n'est pas un souvenir de ce qui a été écrit : c'est une lecture. Un compte
 * rendu persisté affirmerait ce qui a été posé une fois, et non ce qui est en
 * place — la faute que le §38.4 interdit.
 */
export function confronter({ attendus = [], records = [] }) {
  return attendus.map((a) => {
    const nom = String(a.name ?? '');
    const type = String(a.type ?? '').toUpperCase();
    const trouve = records.find(
      (r) => String(r.name ?? '') === nom && String(r.type ?? '').toUpperCase() === type);
    if (!trouve) return { ...a, name: nom, type, etat: 'absent', trouve: null };
    const identique = String(trouve.data ?? '').trim() === String(a.data ?? '').trim();
    return { ...a, name: nom, type,
             etat: identique ? 'conforme' : 'different',
             trouve: trouve.data };
  });
}

/**
 * L'état DNS d'un nom de route, dans les zones du compte (§38.9.1).
 *
 * Quatre états, et le quatrième compte autant que les autres : un domaine dont
 * AUCUNE zone du compte ne relève n'est pas « sans enregistrement ». Le produit
 * n'en sait rien — la zone est ailleurs —, et dire « absent » ferait croire à un
 * oubli là où il n'y a rien à voir.
 *
 * `ailleurs` NOMME la valeur trouvée : « pointe ailleurs » sans dire où
 * n'apprend rien.
 */
export function etatDuNom(domaine, zones = [], adresse) {
  const d = String(domaine ?? '').trim().toLowerCase().replace(/\.$/, '');
  // La zone la plus SPÉCIFIQUE qui contienne le nom : un compte peut porter
  // `exemple.tech` ET `staging.exemple.tech`, et l'enregistrement de
  // `a.staging.exemple.tech` vit dans la seconde (§38.5).
  const candidates = zones
    .filter(({ zone }) => {
      const z = String(zone).toLowerCase();
      return d === z || d.endsWith(`.${z}`);
    })
    .sort((a, b) => String(b.zone).length - String(a.zone).length);
  if (!candidates.length) return { domain: d, etat: 'hors-zone', zone: null, data: null };
  const { zone, records = [] } = candidates[0];
  const relatif = d === String(zone).toLowerCase()
    ? '' : d.slice(0, -(String(zone).length + 1));
  const ici = records.filter(
    (r) => String(r.name ?? '') === relatif && TYPES_INGRESS.includes(
      String(r.type ?? '').toUpperCase()));
  if (!ici.length) return { domain: d, etat: 'absent', zone, data: null };
  const bon = ici.find((r) => String(r.data ?? '').trim() === String(adresse ?? '').trim());
  return bon
    ? { domain: d, etat: 'ici', zone, data: bon.data, type: bon.type }
    : { domain: d, etat: 'ailleurs', zone, data: ici[0].data, type: ici[0].type };
}

/**
 * La suppression est-elle permise ? Rend `null` si oui, le refus MOTIVÉ sinon.
 *
 * @spec docs/DAT.md §38.8.3 — les trois premières conditions y sont dites
 *       « reconstatées par le serveur ». Cette fonction EST cette
 *       reconstatation : la route de suppression la rejoue depuis une lecture
 *       fraîche, sans rien croire de ce que l'écran a envoyé.
 */
export function refusDeSuppression({ enregistrement, adresse, servie }) {
  if (!enregistrement) {
    return "Cet enregistrement n'existe plus dans la zone : rien à retirer.";
  }
  if (!TYPES_INGRESS.includes(String(enregistrement.type ?? '').toUpperCase())) {
    return `Un ${enregistrement.type} n'est pas une route d'ingress : `
           + `seuls ${TYPES_INGRESS.join(' et ')} sont retirés.`;
  }
  if (String(enregistrement.data ?? '').trim() !== String(adresse ?? '').trim()) {
    return `« ${enregistrement.data} » ne désigne pas cette Forge (${adresse}) : `
           + `le produit ne retire pas un enregistrement qui pointe ailleurs.`;
  }
  if (servie) {
    return `« ${servie.domain} » sert ce nom vers le Spark « ${servie.spark_name} » : `
           + `le retirer couperait une route en service.`;
  }
  return null;
}
