/**
 * Le catalogue d'environnement de la Forge — quatrième onglet sous Forge.
 *
 * @spec docs/BACKLOG.md#SPK-64 · docs/DAT.md §43.6 révisé (la Forge propose, le
 *       Spark choisit), §43.3 (le secret est déclaré, sa valeur ne sort jamais),
 *       §43.5.1 (la valeur redevient en clair dans la cellule) ·
 *       docs/DESIGN_SYSTEM.md §5.4, §6.13 (états d'une vue), §6.14 (tableau),
 *       §6.27 (modale limitée à une section), §14.5, §14.6
 *
 * Le catalogue décrit la FORGE, pas un Spark : il vit donc sous Forge, à côté
 * des pools et des images. Ce qui descend, en revanche, se décide dans la
 * fenêtre de chaque Spark — c'est tout l'objet de SPK-64, et l'écran ne doit pas
 * laisser croire qu'écrire ici distribue quoi que ce soit.
 */

import { renderOngletsForge } from './forge-images.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const CATALOGUE_VIDE = {
  open: null,       // 'ajout'
  busy: false,
  refusal: null,
  values: { name: '', value: '', secret: false },
};

/**
 * Ce que l'écran dit de la portée d'une entrée (§14.6).
 *
 * `0` n'est pas « peu » : c'est un état à part. Une entrée définie qu'aucun
 * Spark ne reçoit ressemble en tout point à une entrée active, et c'est
 * exactement la confusion que l'héritage automatique produisait.
 */
export function decrireDescente(nombre) {
  if (nombre === 0) {
    return { texte: 'Ne descend nulle part', token: 'accent' };
  }
  return {
    texte: nombre === 1 ? 'Descend dans 1 Spark' : `Descend dans ${nombre} Sparks`,
    token: 'success',
  };
}

/** Une valeur de secret ne s'affiche JAMAIS (§43.3). L'empreinte la compare. */
function cellule(entree) {
  if (!entree.is_secret) {
    return `<td class="technique">${echapper(entree.value)}</td>`;
  }
  return `<td><span class="badge badge--neutral">Secret</span>
    <span class="technique">${echapper(entree.fingerprint)}</span></td>`;
}

function lignes(entrees) {
  return `<div class="table-defilante">
  <table>
    <thead><tr><th>Nom</th><th>Valeur</th><th>Portée</th><th>Modifié</th><th></th></tr></thead>
    <tbody>${entrees.map((e) => {
      const d = decrireDescente(e.selected_by ?? 0);
      return `<tr>
        <td class="technique">${echapper(e.name)}</td>
        ${cellule(e)}
        <td><span class="badge badge--${d.token}"><span class="badge__point" aria-hidden="true"></span>${
          echapper(d.texte)}</span></td>
        <td class="technique">${echapper((e.updated_at ?? '').slice(0, 16).replace('T', ' '))}</td>
        <td><button type="button" class="bouton" data-retire-catalogue="${
          echapper(e.name)}">Retirer</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>
</div>`;
}

/**
 * L'écran entier.
 *
 * §6.13 : les états sont traités. Le plus important est le catalogue **vide** —
 * il ne se distingue pas d'un chargement raté si on le laisse en blanc.
 */
export function renderForgeEnv({ status = 'loading', entrees = [],
                                 ui = CATALOGUE_VIDE, error = null } = {},
                               renderModale = () => '') {
  const onglets = renderOngletsForge('#/forge/environnement');

  if (status === 'loading') {
    return `${onglets}<section class="carte bloc" aria-busy="true">
      <p class="note">Lecture du catalogue…</p></section>`;
  }
  if (status === 'error') {
    return `${onglets}<section class="carte bloc" role="alert">
      <h1>Catalogue indisponible</h1>
      <p>${echapper(error?.message ?? 'Le catalogue n’a pas pu être lu.')}</p>
    </section>`;
  }

  const corps = entrees.length
    ? lignes(entrees)
    // §14.5 : l'absence se nomme, et elle dit ce qu'elle implique.
    : `<p class="absence">Aucune entrée au catalogue. Rien ne descend dans aucun
       Spark tant qu’il est vide.</p>`;

  return `${onglets}
<section class="carte bloc" aria-labelledby="titre-catalogue-forge">
  <h1 id="titre-catalogue-forge">Catalogue d’environnement</h1>
  <p class="note">Une entrée écrite ici ne descend <strong>nulle part</strong>
  d’elle-même : chaque Spark coche ce qu’il reçoit, dans sa facette
  <em>Environnement</em>. <a href="#/manuel/M8">Manuel M8</a></p>
  ${corps}
  ${ui.refusal ? `<div class="refus" role="alert"><p>${echapper(ui.refusal.message)}</p></div>` : ''}
  <p class="formulaire__actions">
    <button type="button" class="bouton bouton--primaire" data-ouvre="catalogue">
      Ajouter une entrée</button>
  </p>
</section>
${renderModale(ui)}`;
}
