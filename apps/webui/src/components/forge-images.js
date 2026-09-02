/**
 * Écran « catalogue d'images » — onglet Images sous Forge.
 *
 * @spec docs/BACKLOG.md#SPK-32 · docs/DAT.md §33 (le catalogue), §33.2 (ajouter
 *       est un geste explicite), §33.3 (le relevé, ses trois états, sa date),
 *       §33.4 (ce que le catalogue n'est pas), §34.1 (l'onglet Images est la
 *       surface du catalogue : il décrit la Forge, pas un Spark) ·
 *       docs/DAT.md §26.2 (la saisie est recueillie par une modale limitée
 *       à la section), §34.2 · docs/DESIGN_SYSTEM.md §6.14, §6.24, §6.27,
 *       §5.4 (afficher et saisir ne partagent pas la même surface), §14.6, §14.7
 *
 * Le catalogue existait par l'API sans avoir d'écran : le relevé était daté et
 * ses trois états distingués, mais rien ne les affichait. Un exploitant ne
 * pouvait pas voir qu'une image avait disparu de son dépôt.
 */

import { formatDate } from './forge-view.js';
import { renderModale } from './modale.js';

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

/**
 * Commande de la section « Catalogue », et la modale qu'elle ouvre.
 *
 * §33.2 : ajouter est un geste EXPLICITE, jamais le formulaire de création.
 * §5.4 point 1 : le catalogue AFFICHE, la modale RECUEILLE — ils ne partagent
 * pas la même surface. Le formulaire s'ouvrait auparavant dans le flux, sous le
 * tableau qu'il décrit : la section portait alors deux sujets, et l'on pouvait
 * tabuler hors de la saisie sans s'en apercevoir.
 *
 * Insérer un élément DANS une section reste une modale (§6.27) — c'est l'écran
 * de création d'un Spark, objet de premier plan, qui garde sa destination.
 *
 * Le déclencheur reste visible pendant la saisie : c'est lui qui reçoit le focus
 * à la fermeture.
 */
function renderAjout(ui) {
  const modale = renderModale({
    ouverte: Boolean(ui.open), id: 'image', titre: 'Catalogue',
    engagement: 'Ajouter au catalogue', refus: ui.refusal, occupee: ui.busy,
    corps: `
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
    </div>`,
  });
  return `<p class="formulaire__actions"><button type="button" class="bouton"
      data-ouvre="image">Ajouter une image</button></p>${modale}`;
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
  <p class="note">Les images <strong>système</strong> avec lesquelles une cellule
  se crée — pas un registre, et pas les images Docker de vos piles.
  <a href="#/manuel/M5">Manuel M5 — Ce catalogue n’est pas un registre d’images</a></p>
</section>`;
}

/**
 * Onglets de second degré (docs/DAT.md §34.1, DESIGN_SYSTEM.md §5.4).
 *
 * Ce sont de **véritables destinations** — on doit pouvoir recharger la page sur
 * « Images » ou sur « Instantanés » —, donc des liens dans un `nav` avec
 * `aria-current="page"`, et surtout **pas** un `tablist`. Le critère est l'URL,
 * jamais l'apparence.
 *
 * Un onglet change ce que l'on REGARDE : il ne porte aucune action, car les
 * actions appartiennent à la section qu'il révèle.
 */
export function renderOnglets(onglets, courant, etiquette) {
  return `<nav class="onglets" aria-label="${echapper(etiquette)}">${
    onglets.map(([href, libelle]) =>
      `<a href="${echapper(href)}" class="onglet${href === courant ? ' onglet--courant' : ''}"${
        href === courant ? ' aria-current="page"' : ''}>${echapper(libelle)}</a>`).join('')}</nav>`;
}

// SPK-39 : le journal est une destination sous Forge, pas une facette d'un
// Spark — il couvre TOUS les Sparks (docs/DAT.md §36.8.1).
export const ONGLETS_FORGE = [['#/forge', 'Pools'], ['#/forge/images', 'Images'],
                             // SPK-64 · §43.6 : le CATALOGUE vit ici, parce
                             // qu'il décrit la Forge et non un Spark. Ce qui
                             // descend se décide en revanche Spark par Spark.
                             ['#/forge/environnement', 'Environnement'],
                             // SPK-77 · §38.8.5 : le DNS décrit la Forge, pas un
                             // Spark — la page couvre TOUS les Sparks, et
                             // surtout les noms qui n'appartiennent à aucun.
                             ['#/forge/dns', 'DNS'],
                             ['#/forge/journal', 'Journal']];

/** Facettes d'un Spark (DESIGN_SYSTEM.md §6.27) : ce qui se lit ensemble. */
export const FACETTES_SPARK = [
  ['', 'Infos'], ['routes', 'Routes'], ['cles', 'Clés'],
  ['instantanes', 'Instantanés'],
  // SPK-58 · §43 : ce que la pile du locataire RECEVRA. La facette vient après
  // les instantanés et avant le terminal : elle se lit, quand celui-ci s'emploie.
  ['environnement', 'Environnement'],
  // SPK-43 · SPK-DS-04 : le terminal est une DESTINATION, avec sa propre
  // adresse — ni une section, ni une modale.
  ['terminal', 'Terminal'],
  // SPK-44 · §37.6 : ce que le locataire fait tourner, en LECTURE. La facette
  // vient après le terminal parce qu'elle s'observe, quand celui-ci s'emploie.
  ['docker', 'Docker'],
  ['journal', 'Journal'],
];

export function renderOngletsSpark(nom, courant) {
  const base = `#/sparks/${encodeURIComponent(nom)}`;
  return renderOnglets(
    FACETTES_SPARK.map(([suffixe, libelle]) =>
      [suffixe ? `${base}/${suffixe}` : base, libelle]),
    courant ? `${base}/${courant}` : base,
    `Facettes de ${nom}`);
}

export function renderOngletsForge(courant) {
  return renderOnglets(ONGLETS_FORGE, courant, 'Sections de la Forge');
}
