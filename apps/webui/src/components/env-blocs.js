/**
 * Les deux natures d'une entrée d'environnement, et la recherche qui les traverse.
 *
 * @spec docs/BACKLOG.md#SPK-103 · docs/DAT.md §43.11 (deux natures, deux blocs,
 *       une recherche qui porte sur le NOM), §43.3 (la valeur d'un secret ne
 *       sort jamais) · docs/DESIGN_SYSTEM_APP.md SPK-DS-25 ·
 *       docs/DESIGN_SYSTEM.md §14.10 (une recherche ne compare que ce que toute
 *       entrée porte), §14.4 (pas de contrôle sans objet), §14.5 (l'absence se
 *       nomme), §9.3 (les titres ne sautent pas de niveau), §9.7 (un changement
 *       se dit)
 *
 * Ce module est PARTAGÉ par le catalogue de la Forge et par la facette d'un
 * Spark. Les deux écrans montrent les mêmes deux natures et se cherchent de la
 * même façon ; deux copies de cette logique dériveraient l'une de l'autre, et
 * c'est la recherche — dont la justesse tient à ce qu'elle NE compare PAS —
 * qu'on ne veut surtout pas voir diverger.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Ce que la frappe retient — **le nom, et rien d'autre** (§43.11).
 *
 * Comparer aussi les valeurs paraît plus généreux et ne l'est pas : la console
 * n'a JAMAIS la valeur d'un secret (§43.3), si bien qu'aucune frappe ne
 * trouverait un secret par sa valeur. L'écran répondrait « aucun résultat » sur
 * une entrée qui existe, et seulement sur la nature dont l'exploitant ne peut
 * pas vérifier le contraire (§14.10).
 */
export function correspondEnv(nom, recherche = '') {
  const frappe = String(recherche ?? '').trim().toLowerCase();
  return !frappe || String(nom ?? '').toLowerCase().includes(frappe);
}

/** Le même critère, appliqué à une liste d'entrées. */
export function filtrerEnv(entrees = [], recherche = '') {
  if (!String(recherche ?? '').trim()) return entrees;
  return entrees.filter((e) => correspondEnv(e?.name, recherche));
}

/**
 * La nature, telle qu'elle est DÉCLARÉE (§43.3) — jamais devinée d'après le nom.
 */
export function separer(entrees = []) {
  return {
    variables: entrees.filter((e) => !e?.is_secret),
    secrets: entrees.filter((e) => e?.is_secret),
  };
}

/** « 3 entrées », ou « 2 sur 3 » quand une frappe restreint. */
export function libelleCompte(affichees, total, recherche = '') {
  if (!total) return '';
  if (String(recherche ?? '').trim()) return `${affichees} sur ${total}`;
  return `${total} entrée${total > 1 ? 's' : ''}`;
}

/**
 * Le champ de recherche d'une vue — **un seul**, jamais un par bloc.
 *
 * §14.4 : pas de contrôle sans objet. Il n'est donc pas rendu quand la vue n'a
 * qu'une entrée ou aucune. Il reste en revanche rendu quand la frappe ne laisse
 * rien : il est le seul moyen de sortir de l'état vide qu'il a causé — c'est
 * l'exception que le §14.4 nomme, et `total` compte pour cette raison ce que la
 * vue PORTE, pas ce qu'elle affiche.
 */
export function renderRechercheEnv({ id, valeur = '', total = 0, placeholder = 'SMTP, DATABASE…' }) {
  if (total < 2) return '';
  return `<div class="champ champ-recherche" role="search">
  <label for="${echapper(id)}">Chercher une entrée</label>
  <input class="controle" id="${echapper(id)}" name="recherche" type="search"
         autocomplete="off" placeholder="${echapper(placeholder)}"
         aria-describedby="${echapper(id)}-aide" value="${echapper(valeur)}">
  <p class="champ__aide" id="${echapper(id)}-aide">La recherche porte sur le
  <strong>nom</strong>. La valeur d’un secret n’atteint jamais la console : la
  chercher ne trouverait jamais rien.</p>
</div>`;
}

/**
 * Ce que la frappe a retenu, annoncé aux technologies d'assistance (§9.7).
 *
 * Muet tant qu'aucune frappe n'est en cours : une région vivante qui répète le
 * même nombre à chaque repeinture finit par n'être plus écoutée.
 */
export function renderAnnonceRecherche(affichees, total, recherche = '') {
  if (!String(recherche ?? '').trim()) return '';
  return `<p class="sr-only" role="status">${affichees} entrée${
    affichees > 1 ? 's' : ''} affichée${affichees > 1 ? 's' : ''} sur ${total}.</p>`;
}

/**
 * Un bloc de nature, dans une section.
 *
 * @param {string} niveau le niveau de titre — un cran SOUS celui de la carte
 *        qui le porte (§9.3) : `h2` sous le `h1` d'une page, `h3` sous le `h2`
 *        d'une facette.
 * @param {object} absence les deux vides, qui ne disent PAS la même chose
 *        (§14.5, §14.6) : `vide` quand la nature manque, `filtre` quand c'est la
 *        frappe qui l'exclut — et celle-ci est alors CITÉE.
 */
export function renderBlocEnv({ id, niveau = 'h3', titre, entrees = [], total = 0,
                                recherche = '', absence, rendu }) {
  const frappe = String(recherche ?? '').trim();
  const compte = libelleCompte(entrees.length, total, frappe);
  const corps = entrees.length
    ? rendu(entrees)
    : `<p class="absence">${frappe
        ? `${echapper(absence.filtre)} « ${echapper(frappe)} ».`
        : echapper(absence.vide)}</p>`;
  return `
<section class="sous-bloc" aria-labelledby="${echapper(id)}">
  <div class="sous-bloc__entete">
    <${niveau} id="${echapper(id)}">${echapper(titre)}</${niveau}>
    ${compte ? `<span class="sous-bloc__compte">${echapper(compte)}</span>` : ''}
  </div>
  ${corps}
</section>`;
}
