/**
 * Les propositions en attente de toute la Forge : un INDEX, pas un écran de
 * décision.
 *
 * @spec docs/BACKLOG.md#SPK-115 · docs/DAT.md §60.1 (qu'est-ce qui attend, et
 *       où — sans aucune valeur), §60.2 (une cellule non consultée est nommée),
 *       §60.3 (lu à l'ouverture et au bouton, jamais en tâche de fond) ·
 *       §55.9 (le geste se conclut là où vit l'objet) ·
 *       docs/DESIGN_SYSTEM.md §5.2 (une destination est un lien), §6.13 (états
 *       systématiques), §6.14 (tableau), §14.5, §14.6 ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-32
 *
 * Chaque ligne MÈNE à la facette du Spark où la proposition se tranche. Aucun
 * bouton « Ajouter » ni « Refuser » ici : un second endroit pour décider ferait
 * deux gestes pour le même objet.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** `loading` et non vide : « pas encore lu » n'est pas « rien n'attend » (§14.6). */
export const PROPOSITIONS_FORGE_VIDE = {
  status: 'loading', sparks: [], error: null, luA: null,
};

/** Chaque nature, son libellé, et la facette où elle se tranche (§55.9). */
export const NATURES_FORGE = {
  variables: { libelle: 'Variables proposées', facette: 'environnement' },
  secrets: { libelle: 'Secrets proposés', facette: 'environnement' },
  routes: { libelle: 'Routes proposées', facette: 'routes' },
  readme: { libelle: 'README.md', facette: 'notes' },
  contributors: { libelle: 'CONTRIBUTORS.md', facette: 'notes' },
  install: { libelle: 'INSTALL.md', facette: 'notes' },
};

/** L'adresse de la facette où se tranche une proposition de cette nature. */
export function lienProposition(spark, kind) {
  const facette = NATURES_FORGE[kind]?.facette ?? '';
  return `#/sparks/${encodeURIComponent(spark)}${facette ? `/${facette}` : ''}`;
}

/** Ce qui attend : un nombre de lignes, ou un texte à trancher en entier. */
function attente(item) {
  if (item.lines === null || item.lines === undefined) return 'un texte à relire en entier';
  return `${item.lines} ligne(s)`;
}

export function renderPropositionsForge(vue = PROPOSITIONS_FORGE_VIDE) {
  const relire = `<p class="relecture">
      <button type="button" class="bouton" data-propositions-relire
        ${vue.status === 'loading' ? 'disabled' : ''}>Relire les cellules</button>
      ${vue.luA ? `<span class="note">Lu à <span class="technique">${
        echapper(vue.luA)}</span>.</span>` : ''}
    </p>`;
  let corps;
  if (vue.status === 'loading') {
    corps = '<p class="note" role="status" aria-busy="true">Lecture des cellules…</p>';
  } else if (vue.status === 'error') {
    corps = `<div class="refus" role="alert"><p><strong>${
      echapper(vue.error ?? 'La Forge n’a pas pu être lue.')}</strong></p></div>`;
  } else {
    const lignes = (vue.sparks ?? []).flatMap((s) => (s.pending ?? []).map((p) => `
      <tr>
        <th scope="row" class="nom-cellule"><a href="#/sparks/${
          encodeURIComponent(s.spark)}" class="lien-spark technique">${echapper(s.spark)}</a></th>
        <td><a class="lien-spark" href="${lienProposition(s.spark, p.kind)}" data-proposition-lien="${
          echapper(`${s.spark}:${p.kind}`)}">${
          echapper(NATURES_FORGE[p.kind]?.libelle ?? p.kind)}</a></td>
        <td>${echapper(attente(p))}</td>
      </tr>`)).join('');
    const nonLues = (vue.sparks ?? []).filter((s) => !s.cell_read).map((s) => s.spark);
    corps = (lignes
      ? `<div class="tableau-defilant">
          <p class="tableau-indice">Le tableau défile horizontalement.</p>
          <table>
            <thead><tr><th scope="col">Spark</th><th scope="col">Proposition</th>
              <th scope="col">En attente</th></tr></thead>
            <tbody>${lignes}</tbody>
          </table></div>`
      : '<p class="absence">Aucune proposition n’attend dans les Sparks de cette Forge.</p>')
      + (nonLues.length
        ? `<p class="avertissement" role="status"><strong>Cellule(s) non consultée(s)
            </strong> : ${echapper(nonLues.join(', '))}. Leurs propositions éventuelles
            ne sont pas comptées ici.</p>`
        : '');
  }
  return `
<section class="carte bloc" aria-labelledby="titre-propositions-forge">
  <h2 id="titre-propositions-forge">Propositions en attente</h2>
  <p class="note">Ce que les agents ont déposé dans les Sparks, et que personne n’a
  encore tranché. Chaque proposition s’ouvre dans l’onglet du Spark où elle se
  décide.</p>
  ${relire}
  ${corps}
</section>`;
}
