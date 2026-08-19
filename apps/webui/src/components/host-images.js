/**
 * Écran « catalogue d'images » — onglet Images sous Hôte.
 *
 * @spec docs/BACKLOG.md#SPK-32 · docs/DAT.md §33 (le catalogue), §33.2 (ajouter
 *       est un geste explicite), §33.3 (le relevé, ses trois états, sa date),
 *       §33.4 (ce que le catalogue n'est pas), §34.1 (l'onglet Images est la
 *       surface du catalogue : il décrit l'hôte, pas un Spark) ·
 *       docs/DESIGN_SYSTEM.md §6.14, §6.24, §14.6, §14.7
 *
 * Le catalogue existait par l'API sans avoir d'écran : le relevé était daté et
 * ses trois états distingués, mais rien ne les affichait. Un exploitant ne
 * pouvait pas voir qu'une image avait disparu de son dépôt.
 */

import { formatDate } from './host-view.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Les trois états du §33.3, jamais confondus.
 *
 * `unknown` n'est pas une panne : c'est un relevé qui n'a pas eu lieu. Le
 * rendre en `danger` ferait croire à une image retirée du dépôt, ce qui est
 * précisément la confusion que le §14.6 interdit.
 */
export const ETATS = {
  verified: { label: 'Vérifiée', token: 'success',
              sens: 'présente chez son dépôt au dernier relevé' },
  missing: { label: 'Absente', token: 'danger',
             sens: 'le dépôt ne la publie plus' },
  unknown: { label: 'Non relevée', token: 'accent',
             sens: 'jamais relevée, ou relevé impossible' },
};

export function etatOf(valeur) {
  return ETATS[valeur] ?? { label: String(valeur ?? 'inconnu'), token: 'neutral', sens: '' };
}

/**
 * Date du dernier relevé, commune à toutes les entrées.
 *
 * Une capacité sans date serait crue à jour — c'est la règle du §27.8, et elle
 * vaut ici pour la même raison : le relevé est explicite, pas continu.
 */
export function dernierReleve(images = []) {
  const dates = images.map((i) => i.verified_at).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function renderLigne(image) {
  const { label, token, sens } = etatOf(image.state);
  return `<tr>
  <td class="cellule-nom">${echapper(image.label)}${
    image.is_default ? ' <span class="badge badge--neutral">par défaut</span>' : ''}</td>
  <td class="technique cellule-dense">${echapper(image.reference)}</td>
  <td><span class="badge badge--${token}" title="${echapper(sens)}">` +
    `<span class="badge__point" aria-hidden="true"></span>${echapper(label)}</span></td>
  <td class="technique">${echapper(formatDate(image.verified_at)) || '—'}</td>
  <td>${echapper(image.detail)}</td>
</tr>`;
}

/** Formulaire d'ajout. §33.2 : un geste EXPLICITE, jamais le formulaire de création. */
function renderAjout(ui) {
  if (!ui.open) {
    return `<p class="formulaire__actions"><button type="button" class="bouton"
      data-ouvre="image">Ajouter une image</button></p>`;
  }
  return `<form class="formulaire-panneau" data-formulaire="image">
    <div class="champ">
      <label for="image-reference">Référence</label>
      <input class="controle technique" id="image-reference" name="reference" type="text"
             autocomplete="off" placeholder="images:debian/13"
             value="${echapper(ui.values.reference)}">
      <p class="champ__aide">Forme « dépôt:alias ». L’entrée naît non relevée :
      elle ne devient utilisable qu’après un relevé.</p>
    </div>
    <div class="champ">
      <label for="image-label">Libellé</label>
      <input class="controle" id="image-label" name="label" type="text"
             autocomplete="off" value="${echapper(ui.values.label)}">
    </div>
    ${ui.refusal ? `<div class="refus" role="alert"><p><strong>${
      echapper(ui.refusal)}</strong></p></div>` : ''}
    <p class="formulaire__actions">
      <button type="submit" class="bouton bouton--primaire" ${ui.busy ? 'disabled' : ''}>${
        ui.busy ? 'Ajout…' : 'Ajouter au catalogue'}</button>
      <button type="button" class="bouton" data-ferme="image">Annuler</button>
    </p>
  </form>`;
}

export const CATALOGUE_VIDE = {
  open: false, busy: false, refusal: null, syncing: false,
  values: { reference: '', label: '' },
};

/** Vue complète du catalogue. */
export function renderCatalogue({ status = 'loading', images = [], error = null,
                                  ui = CATALOGUE_VIDE } = {}) {
  if (status === 'loading') {
    return `<div class="carte bloc" aria-busy="true">
      <p class="sr-only" role="status">Chargement du catalogue…</p>
      ${Array.from({ length: 4 }, (_, i) =>
        `<span class="squelette" style="display:block;width:${70 - i * 8}%;margin-bottom:var(--space-3)"></span>`).join('')}
    </div>`;
  }
  if (status === 'error') {
    return `<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
      <h2>Le catalogue n’a pas pu être lu</h2>
      <p>${echapper(error?.message ?? 'Cause inconnue.')}</p>
      <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
    </div></div>`;
  }

  const releve = dernierReleve(images);
  const compte = images.reduce((acc, i) => ({ ...acc, [i.state]: (acc[i.state] ?? 0) + 1 }), {});

  const corps = images.length
    ? `<div class="tableau-enveloppe">
    <p class="tableau-indice">Le tableau défile horizontalement.</p>
    <table>
      <thead><tr>
        <th scope="col">Image</th><th scope="col">Référence</th>
        <th scope="col">État</th><th scope="col">Dernier relevé</th>
        <th scope="col">Ce que le relevé a constaté</th>
      </tr></thead>
      <tbody>${images.map(renderLigne).join('')}</tbody>
    </table>
  </div>`
    : `<div class="etat-vue">
      <h2>Le catalogue est vide</h2>
      <p>Aucune image n’est enregistrée : aucun Spark ne peut être créé.</p>
    </div>`;

  return `
<header class="entete-entite">
  <div class="entete-entite__identite"><h1>Images</h1></div>
  <p class="note">
    ${releve
      ? `Dernier relevé le <span class="technique">${echapper(formatDate(releve))}</span>.`
      : 'Aucun relevé n’a encore eu lieu.'}
    Les images ne sont pas revérifiées à chaque ouverture : interroger le dépôt à
    chaque fois rendrait la création tributaire d’un service extérieur.
    <button type="button" class="bouton bouton--compact" data-action="relever-images"
      ${ui.syncing ? 'disabled' : ''}>${ui.syncing ? 'Relevé…' : 'Relever le catalogue'}</button>
  </p>
</header>
<section class="carte bloc" aria-labelledby="titre-catalogue">
  <h2 id="titre-catalogue">Catalogue</h2>
  ${corps}
  ${(compte.missing || compte.unknown)
    ? `<p class="avertissement" role="status">${
        [compte.missing ? `${compte.missing} image(s) absente(s) du dépôt` : null,
         compte.unknown ? `${compte.unknown} non relevée(s)` : null]
          .filter(Boolean).join(' et ')} : elles restent affichées, mais ne sont
      pas proposées à la création. Les faire disparaître ferait croire qu’elles
      n’ont jamais existé.</p>`
    : ''}
  ${renderAjout(ui)}
  <p class="note">Ce catalogue n’est pas un registre d’images : il ne stocke, ne
  construit et ne publie rien. Il tient la liste des images système utilisables
  pour créer une cellule. Les images Docker de vos piles vivent dans le Spark et
  ne le concernent pas.</p>
</section>`;
}

/** Onglets du second degré sous « Hôte » (docs/DAT.md §34.1).
 *
 *  Ce sont de véritables destinations — on doit pouvoir recharger la page sur
 *  « Images » — donc des liens dans un `nav`, jamais un `tablist`. */
export function renderOngletsHote(courant) {
  const onglets = [['#/hote', 'Pools'], ['#/hote/images', 'Images']];
  return `<nav class="onglets" aria-label="Sections de l’hôte">${
    onglets.map(([href, libelle]) =>
      `<a href="${href}" class="onglet${href === courant ? ' onglet--courant' : ''}"${
        href === courant ? ' aria-current="page"' : ''}>${libelle}</a>`).join('')}</nav>`;
}
