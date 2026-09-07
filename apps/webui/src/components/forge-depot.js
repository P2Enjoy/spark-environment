/**
 * Le dépôt d'images, lu en direct, et coché.
 *
 * @spec docs/BACKLOG.md#SPK-92 · docs/DAT.md §33.6 (le dépôt se lit en direct et
 *       le catalogue se coche ; le serveur reconfirme ; le repli obligatoire),
 *       §33.3 (ce que l'alias porte, et les doublons qu'il cache), §42.9.6
 *       (annoncer l'amorçabilité) · docs/DESIGN_SYSTEM.md §6.27 (modale limitée
 *       à une section), §6.10 (cases à cocher), §6.13 (états systématiques),
 *       §9.9 (une action indisponible dans un état connu reste visible),
 *       §14.4 (pas de contrôle sans objet), §1.5 (jamais la couleur seule),
 *       §6.28 (regrouper sans rendre introuvable) ·
 *       manuel M5
 *
 * Le catalogue ne proposait que quatre références écrites en dur, pendant que le
 * dépôt en publie près de trois cents. Pour en ajouter une cinquième, il fallait
 * connaître sa référence par cœur et la taper à la main — la forme la plus faible
 * du geste explicite, puisqu'elle accepte une référence qui n'existe pas.
 *
 * **Cocher dans un relevé ne peut produire que ce que le dépôt publie.** La faute
 * de frappe disparaît par construction, pas par contrôle.
 */

import { renderModale } from './modale.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const DEPOT_VIDE = {
  open: false, status: 'idle', busy: false, refusal: null, error: null,
  listing: null, filtre: '', cochees: [],
};

/**
 * Restreint l'affichage à ce que la recherche désigne (§14.4).
 *
 * La recherche porte AUSSI sur les synonymes : le dépôt publie « noble » et
 * « 24.04 » pour la même image, et l'écran n'en montre qu'un. Chercher le nom
 * qu'on connaît doit trouver celui qui est affiché — sans quoi le regroupement
 * du §33.6 rendrait une image introuvable au lieu de la rendre lisible.
 */
export function filtrer(familles = [], texte = '') {
  const recherche = texte.trim().toLowerCase();
  if (!recherche) return familles;

  const correspond = (entree) =>
    [entree.alias, entree.libelle, ...(entree.synonymes ?? [])]
      .some((mot) => String(mot ?? '').toLowerCase().includes(recherche));

  return familles
    .map((famille) => {
      if (famille.famille.toLowerCase().includes(recherche)) return famille;
      const versions = famille.versions
        .map((version) => {
          if (correspond(version)) return version;
          const variantes = version.variantes.filter(correspond);
          return variantes.length ? { ...version, variantes } : null;
        })
        .filter(Boolean);
      return versions.length ? { ...famille, versions } : null;
    })
    .filter(Boolean);
}

/** Une ligne cochable : une version, ou une variante de version. */
function renderCase(entree, cochees, { variante = false } = {}) {
  const id = `depot-${entree.alias.replace(/[^a-z0-9]+/gi, '-')}`;
  const tenue = entree.au_catalogue;
  return `<li class="case-catalogue${variante ? ' case-catalogue--variante' : ''}">
  <label for="${id}">
    <input type="checkbox" id="${id}" data-coche="${echapper(entree.reference)}"
           ${tenue || cochees.includes(entree.reference) ? 'checked' : ''}
           ${tenue ? 'disabled' : ''} />
    <span>${echapper(entree.libelle)}</span>
    <span class="technique">${echapper(entree.reference)}</span>
  </label>
  ${tenue
    // Une entrée déjà tenue n'est pas une entrée à ajouter (§33.6). Elle se voit
    // cochée et inerte : la modale ne sert pas à retirer.
    ? '<span class="note">déjà au catalogue</span>'
    : ''}
  ${entree.synonymes?.length
    ? `<span class="note">aussi publiée sous ${echapper(entree.synonymes.join(', '))}</span>`
    : ''}
</li>`;
}

function renderFamille(famille, cochees, deplie) {
  const versions = famille.versions.map((version) => {
    const variantes = version.variantes.length
      ? `<ul class="liste-cases liste-cases--variantes">${
          version.variantes.map((v) => renderCase(v, cochees, { variante: true })).join('')
        }</ul>`
      : '';
    return renderCase(version, cochees).replace('</li>', `${variantes}</li>`);
  }).join('');

  return `<details class="repli depot-famille"${deplie ? ' open' : ''}>
  <summary>${echapper(famille.famille)}
    <span class="note">${famille.versions.length} version${
      famille.versions.length > 1 ? 's' : ''}</span>
    ${famille.amorcable
      // §1.5 : l'état ne repose jamais sur la seule couleur — le badge porte son
      // mot. §42.9.6 : c'est une ANNONCE, jamais un filtre.
      ? '<span class="badge badge--success"><span class="badge__point" aria-hidden="true">'
        + '</span>Amorçable</span>'
      : '<span class="badge badge--neutral"><span class="badge__point" aria-hidden="true">'
        + '</span>Amorçage non pris en charge</span>'}
  </summary>
  <ul class="liste-cases">${versions}</ul>
</details>`;
}

/** Le corps de la modale, selon l'état de la lecture (§6.13). */
function renderCorps(ui) {
  if (ui.status === 'loading') {
    return `<div aria-busy="true">
      <p class="sr-only" role="status">Lecture du dépôt…</p>
      <p class="note">Le dépôt est interrogé maintenant : la liste n’est pas
      conservée entre deux ouvertures.</p>
      ${Array.from({ length: 5 }, (_, i) =>
        `<span class="squelette" style="display:block;width:${75 - i * 9}%;margin-bottom:var(--space-3)"></span>`).join('')}
    </div>`;
  }

  if (ui.status === 'error') {
    // §33.6 : un dépôt injoignable ne doit pas supprimer la seule voie restante.
    // On NOMME la panne et l'on rappelle la saisie libre — sans l'ouvrir ici,
    // une modale n'en ouvrant pas une autre (§6.27).
    return `<div class="etat-vue etat-vue--erreur etat-vue--dans-modale" role="alert">
      <h3>Le dépôt n’a pas répondu</h3>
      <p>${echapper(ui.error?.message ?? 'Cause inconnue.')}</p>
      <p>La liste ne peut donc pas être proposée. Pour ajouter une image dont
      vous connaissez la référence, fermez cette fenêtre et employez
      <strong>Saisir une référence</strong> : l’entrée naîtra non relevée, et un
      relevé tranchera.</p>
    </div>`;
  }

  const listing = ui.listing ?? { familles: [] };
  const familles = filtrer(listing.familles, ui.filtre);
  const lignes = familles.reduce((n, f) => n + f.versions.length, 0);

  return `
${/* §1.5 bis : l'écran NOMME, le manuel explique. Les badges disent
     l'amorçabilité famille par famille ; une phrase qui la ré-expliquerait ici
     resterait vraie quelles que soient les valeurs affichées — donc elle
     appartient au manuel, et le renvoi la remplace. */ ''}
<p class="note">Lu à l’instant chez <span class="technique">${echapper(listing.remote)}</span> :
${listing.produits} produits publiés, ${listing.alias} alias.
<a href="#/manuel/M5">Manuel M5 — Choisir l’image</a></p>

${listing.familles.length > 1
  // §14.4 : pas de filtre quand il n'y a rien à filtrer.
  ? `<div class="champ">
      <label for="depot-filtre">Chercher une image</label>
      <input class="controle" id="depot-filtre" name="filtre" type="search"
             autocomplete="off" placeholder="debian, noble, alpine…"
             value="${echapper(ui.filtre)}">
      <p class="champ__aide">Cherche aussi les noms de code : « trixie » trouve
      Debian 13.</p>
    </div>`
  : ''}

${familles.length
  ? `<p class="sr-only" role="status">${lignes} image${lignes > 1 ? 's' : ''} affichée${
      lignes > 1 ? 's' : ''}.</p>
    <div class="depot-familles">${
      familles.map((f) => renderFamille(f, ui.cochees, Boolean(ui.filtre))).join('')
    }</div>`
  : `<div class="etat-vue etat-vue--dans-modale">
      <h3>Aucune image ne correspond</h3>
      <p>Le dépôt publie ${listing.alias} alias, mais aucun ne porte
      « ${echapper(ui.filtre)} ».</p>
    </div>`}`;
}

/**
 * La modale « Ajouter depuis le dépôt ».
 *
 * Son sujet est la section « Catalogue », et rien d'autre (§6.27). Son unique
 * point d'engagement pose le LOT coché : la preuve est commune, et le serveur
 * relit le dépôt une seule fois pour tout confirmer (§33.6).
 */
export function renderDepotModale(ui = DEPOT_VIDE) {
  const compte = ui.cochees.length;
  return renderModale({
    ouverte: Boolean(ui.open), id: 'depot', titre: 'Catalogue',
    engagement: libelleEngagement(compte),
    refus: ui.refusal, occupee: ui.busy,
    desactivee: ui.status !== 'ready' || compte === 0,
    // §9.9 : un bouton désactivé SANS raison est un mur muet. Il en a donc une
    // dans les trois états, y compris quand la liste n'a pas pu être lue —
    // MESURÉ en capture : l'engagement restait grisé sans un mot.
    indication: libelleIndication(compte, ui.status),
    corps: renderCorps(ui),
  });
}

/**
 * Les deux libellés que le rendu ET la mise à jour sur place doivent produire.
 *
 * Cocher une case ne repeint pas — la repeinture rendrait le focus au champ de
 * recherche et l'on ne pourrait plus cocher au clavier (§14.3). L'engagement est
 * donc mis à jour à la main, et ces deux fonctions sont ce qui garantit que la
 * main écrit la même chose que le rendu.
 */
export function libelleEngagement(compte) {
  return compte > 1 ? `Ajouter ${compte} images au catalogue`
                    : 'Ajouter au catalogue';
}

/**
 * §9.9 : la raison pour laquelle l'engagement ne part pas, ou ce qu'il emporte.
 *
 * Elle est TOUJOURS rendue, et dit l'état courant plutôt que la seule condition
 * manquante : une phrase « cochez au moins une image » laissée en place pendant
 * que le bouton s'active afficherait deux états contradictoires (§6.11).
 */
export function libelleIndication(compte, status = 'ready') {
  if (status === 'loading') return 'Lecture du dépôt en cours…';
  if (status === 'error') return 'Rien à cocher : le dépôt n’a pas répondu.';
  if (compte === 0) return 'Cochez au moins une image à ajouter.';
  return compte > 1 ? `${compte} images cochées.` : '1 image cochée.';
}
