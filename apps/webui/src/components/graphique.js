/**
 * La courbe : première surface graphique du produit.
 *
 * @spec docs/BACKLOG.md#SPK-93 · docs/DESIGN_SYSTEM_APP.md SPK-DS-20 (ce
 *       qu'elle trace et ce qu'elle refuse de relier), SPK-DS-02 (le burst
 *       n'est pas un dépassement), SPK-DS-03 (nommer l'absence de mesure) ·
 *       docs/DESIGN_SYSTEM.md §1.5 (jamais la couleur seule), §6.13 (états
 *       systématiques), §9.2 et §9.7 (accessibilité), §14.6 (mesure
 *       indisponible et zéro) · docs/DAT.md §52.6 (le pas de seau), §52.8 (la
 *       ligne de référence)
 *
 * SVG écrit à la main, sans bibliothèque : quatre courbes ne justifient pas une
 * dépendance, et une bibliothèque de graphiques apporterait ses propres
 * couleurs, ses propres info-bulles et sa propre idée de l'absence de donnée —
 * trois décisions que le design system a déjà prises.
 */

import { MEASURE } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Repère du tracé. Le viewBox est fixe ; la largeur réelle vient du CSS. */
export const CADRE = { largeur: 600, hauteur: 150, gauche: 8, droite: 8, haut: 12, bas: 20 };

/** Repère de la micro-courbe d'une ligne de tableau (SPK-DS-20). */
const MICRO = { largeur: 120, hauteur: 28 };

/**
 * Découpe une série en segments CONTINUS, en coupant sur chaque `null`.
 *
 * C'est la règle qui décide de tout le composant : la courbe ne relie jamais
 * les deux points qui encadrent un trou. Une droite entre eux affirmerait une
 * continuité que rien n'a mesurée (SPK-DS-20, docs/DAT.md §52.6).
 */
export function segments(serie, cle) {
  const trouves = [];
  let courant = [];
  (serie || []).forEach((point, index) => {
    const valeur = point?.[cle];
    if (valeur === null || valeur === undefined) {
      if (courant.length) trouves.push(courant);
      courant = [];
      return;
    }
    courant.push({ index, valeur });
  });
  if (courant.length) trouves.push(courant);
  return trouves;
}

/**
 * Au-delà de ce rapport entre la référence et la plus haute mesure, la
 * référence sort du cadre (SPK-DS-20).
 *
 * MESURÉ le 2026-09-07 sur la pile de développement : un Spark consommant
 * `2 Mbit/s` sous un plafond de `100 Mbit/s`, et `489 Mio` sous un quota de
 * `10 Gio`. Mise à l'échelle sur la référence, la courbe devient un trait posé
 * au sol : deux des quatre graphiques ne montraient plus rien. À quatre, la
 * donnée occupe encore un quart de la hauteur.
 */
export const REFERENCE_MAX_RAPPORT = 4;

/**
 * Borne haute du tracé. Toujours 0 en bas : ce sont des consommations, et une
 * base flottante ferait lire une variation de 1 % comme un effondrement.
 *
 * La référence entre dans le calcul TANT QU'ELLE NE L'ÉCRASE PAS. Au-delà du
 * rapport ci-dessus, l'échelle suit la donnée : la référence reste nommée dans
 * la légende, avec sa valeur, et l'écran dit qu'elle est hors du cadre. On perd
 * le trait, jamais l'information (SPK-DS-20).
 */
export function borneHaute(serie, cle, reference) {
  const valeurs = (serie || [])
    .map((p) => p?.[cle])
    .filter((v) => v !== null && v !== undefined);
  if (!valeurs.length) return null;
  const mesure = Math.max(...valeurs);
  const utile = reference !== null && reference !== undefined && reference > 0
    && (mesure <= 0 || reference <= mesure * REFERENCE_MAX_RAPPORT);
  const haut = utile ? Math.max(mesure, reference) : mesure;
  // Une série entièrement à zéro est une VRAIE mesure — le §14.6 la distingue
  // de l'absence. Elle a besoin d'une échelle quand même.
  return haut > 0 ? haut * 1.08 : 1;
}

function abscisse(index, total) {
  const utile = CADRE.largeur - CADRE.gauche - CADRE.droite;
  if (total <= 1) return CADRE.gauche + utile / 2;
  return CADRE.gauche + (index * utile) / (total - 1);
}

function ordonnee(valeur, haut) {
  const utile = CADRE.hauteur - CADRE.haut - CADRE.bas;
  return CADRE.haut + utile - (valeur / haut) * utile;
}

/** Ce que la série porte, ou pourquoi elle ne porte rien (SPK-DS-20). */
export function etatDeLaSerie(serie, cle, { actif = true } = {}) {
  const points = serie || [];
  const mesures = points.filter(
    (p) => p?.[cle] !== null && p?.[cle] !== undefined);
  // Une supervision ÉTEINTE n'efface pas ce qui a déjà été relevé.
  //
  // VU À L'ÉCRAN le 2026-09-07, cadence posée à 0 sur la pile de développement :
  // les quatre courbes de la Forge annonçaient « désactivée » pendant que les
  // micro-courbes par Spark, juste dessous, traçaient la même histoire. Une
  // seule page disait deux choses contraires. L'historique est réel et se lit ;
  // c'est l'arrivée de NOUVEAUX relevés qui s'est arrêtée, et cela se dit dans
  // l'en-tête (§14.5).
  if (mesures.length) return { vide: false, texte: null };

  const releves = points.filter((p) => (p?.samples || 0) > 0);
  if (!releves.length) {
    // Rien à tracer : c'est ici, et seulement ici, que la cause compte.
    return {
      vide: true,
      texte: actif ? 'Aucun relevé sur cette période'
                   : 'Supervision désactivée sur cette Forge',
    };
  }
  // Des relevés existent, mais aucun ne porte cette grandeur : le Spark ne
  // tournait pas. Le §52.4 refuse que ce trou se confonde avec le précédent, et
  // le SPK-DS-03 exige un texte PAR SITUATION — « Mesure en cours » sur un Spark
  // jamais appliqué ferait attendre une valeur qui ne viendra pas.
  const etats = new Set(releves.flatMap((p) => p.states || []));
  if (etats.size === 1) {
    const [seul] = [...etats];
    if (seul === 'stopped') return { vide: true, texte: MEASURE.stopped };
    if (seul === 'pending') return { vide: true, texte: MEASURE.declared };
    if (seul === 'error') return { vide: true, texte: MEASURE.unavailable };
  }
  return { vide: true, texte: MEASURE.pending };
}

/** Valeur du dernier seau MESURÉ, et son horodatage. */
export function dernierPoint(serie, cle) {
  const points = serie || [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const valeur = points[i]?.[cle];
    if (valeur !== null && valeur !== undefined) {
      return { valeur, at: points[i].at, index: i, samples: points[i].samples };
    }
  }
  return null;
}

function tableauCache(serie, cle, format, titre) {
  // §9.2, §9.7 : le SVG est décoratif au sens ARIA. La donnée est rendue AUSSI
  // sous une forme qu'un lecteur d'écran parcourt.
  const lignes = (serie || []).map((point) => {
    const valeur = point?.[cle];
    const dit = valeur === null || valeur === undefined
      ? (point?.samples ? 'non mesuré' : 'aucun relevé')
      : format(valeur);
    return `<tr><th scope="row">${echapper(heure(point?.at))}</th><td>${echapper(dit)}</td></tr>`;
  }).join('');
  // MESURÉ le 2026-09-07 : porté par le `<table>` lui-même, le masquage ne
  // masquait RIEN — `height` n'est qu'un MINIMUM sur une table, et les 240
  // lignes poussaient la page à 10 556 px. Le masquage vit donc sur une
  // enveloppe, dont la hauteur, elle, est une hauteur.
  return `<div class="graphique__donnees"><table>`
    + `<caption>${echapper(titre)}</caption><tbody>${lignes}</tbody></table></div>`;
}

export function heure(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function horodatage(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit',
  });
}

/**
 * Un graphique complet : titre, valeur courante, tracé, légende, lecture.
 *
 * `reference` est la ligne à laquelle la courbe se compare (docs/DAT.md §52.8).
 * Elle est TRACÉE et NOMMÉE : un trait sans légende n'est pas un référentiel,
 * et une courbe sans référentiel est un chiffre faux (SPK-DS-05).
 */
export function renderGraphique({
  cle, titre, serie, format, reference = null, referenceNom = 'Quota',
  couleur = 'brand', burst = false, curseur = null, actif = true, unite = '',
}) {
  const etat = etatDeLaSerie(serie, cle, { actif });
  const dernier = dernierPoint(serie, cle);
  const identifiant = `graphique-${cle}`;

  const titreHtml = `<h3 class="graphique__titre" id="${identifiant}-titre">${
    echapper(titre)}</h3>`;

  if (etat.vide) {
    // §6.13 : un état vide se NOMME — et il se nomme UNE FOIS. Vu à l'écran le
    // 2026-09-07 : la phrase occupait la place de la valeur ET le corps de la
    // carte, deux fois la même sur quatre cartes. Répéter un fait ne le rend
    // pas plus vrai, il fait chercher la différence entre les deux.
    return `<section class="carte graphique graphique--vide" aria-labelledby="${identifiant}-titre">`
      + `<div class="graphique__entete">${titreHtml}</div>`
      + `<p class="graphique__vide">${echapper(etat.texte)}</p></section>`;
  }

  const entete = `<div class="graphique__entete">${titreHtml}`
    + `<p class="graphique__valeur">${
      dernier ? echapper(format(dernier.valeur)) : `<span class="graphique__absente">${
        echapper(etat.texte || 'Indisponible')}</span>`}</p></div>`;

  const haut = borneHaute(serie, cle, reference);
  const total = serie.length;
  const traces = segments(serie, cle).map((segment) => {
    const points = segment
      .map((p) => `${abscisse(p.index, total).toFixed(1)},${ordonnee(p.valeur, haut).toFixed(1)}`)
      .join(' ');
    // Un segment d'UN seul point n'est pas une ligne : sans ce cercle, un
    // relevé isolé entre deux trous serait invisible.
    return segment.length === 1
      ? `<circle class="graphique__point" cx="${abscisse(segment[0].index, total).toFixed(1)}"`
        + ` cy="${ordonnee(segment[0].valeur, haut).toFixed(1)}" r="2.5" />`
      : `<polyline class="graphique__trace" points="${points}" />`;
  }).join('');

  const yReference = reference > 0 && reference <= haut
    ? ordonnee(reference, haut) : null;

  // SPK-DS-02 : la part AU-DELÀ de la référence est du burst. Elle se distingue
  // par un aplat, jamais par du rouge — c'est un usage optimal de la machine.
  const aplat = burst && yReference !== null
    ? segments(serie, cle).filter((s) => s.length > 1).map((segment) => {
      const contour = segment
        .map((p) => `${abscisse(p.index, total).toFixed(1)},${ordonnee(p.valeur, haut).toFixed(1)}`)
        .join(' L ');
      const debut = abscisse(segment[0].index, total).toFixed(1);
      const fin = abscisse(segment[segment.length - 1].index, total).toFixed(1);
      return `<path class="graphique__burst" d="M ${contour} L ${fin},${yReference.toFixed(1)}`
        + ` L ${debut},${yReference.toFixed(1)} Z" clip-path="url(#${identifiant}-clip)" />`;
    }).join('')
    : '';

  const curseurTrace = Number.isInteger(curseur) && curseur >= 0 && curseur < total
    ? `<line class="graphique__curseur" x1="${abscisse(curseur, total).toFixed(1)}"`
      + ` y1="${CADRE.haut}" x2="${abscisse(curseur, total).toFixed(1)}"`
      + ` y2="${CADRE.hauteur - CADRE.bas}" />`
    : '';

  const vise = Number.isInteger(curseur) ? serie[curseur] : null;
  const lecture = vise
    ? `${heure(vise.at)} — ${
      vise[cle] === null || vise[cle] === undefined
        ? (vise.samples ? 'non mesuré' : 'aucun relevé')
        : format(vise[cle])}${
      vise.samples > 1 ? ` (moyenne de ${vise.samples} relevés)` : ''}`
    : dernier
      ? `Dernier point : ${heure(dernier.at)} — ${format(dernier.valeur)}`
      : '';

  return `<section class="carte graphique graphique--${echapper(couleur)}"`
    + ` aria-labelledby="${identifiant}-titre">${entete}`
    + `<div class="graphique__cadre" tabindex="0" role="group"`
    + ` aria-label="${echapper(titre)} — parcourir les points avec les flèches"`
    + ` data-graphique="${echapper(cle)}" data-points="${total}">`
    + `<svg class="graphique__svg" viewBox="0 0 ${CADRE.largeur} ${CADRE.hauteur}"`
    + ` preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + (yReference !== null
      ? `<defs><clipPath id="${identifiant}-clip"><rect x="0" y="0"`
        + ` width="${CADRE.largeur}" height="${yReference.toFixed(1)}" /></clipPath></defs>`
      : '')
    + `<line class="graphique__base" x1="${CADRE.gauche}" y1="${CADRE.hauteur - CADRE.bas}"`
    + ` x2="${CADRE.largeur - CADRE.droite}" y2="${CADRE.hauteur - CADRE.bas}" />`
    + (yReference !== null
      ? `<line class="graphique__reference" x1="${CADRE.gauche}" y1="${yReference.toFixed(1)}"`
        + ` x2="${CADRE.largeur - CADRE.droite}" y2="${yReference.toFixed(1)}" />`
      : '')
    + aplat + traces + curseurTrace
    + `</svg></div>`
    + `<p class="graphique__lecture" role="status">${echapper(lecture)}</p>`
    + `<p class="graphique__legende">`
    + `<span class="graphique__cle graphique__cle--trace"></span>${echapper(titre)}`
    + (reference > 0
      ? `<span class="graphique__cle graphique__cle--reference"></span>${
        echapper(referenceNom)} : ${echapper(format(reference))}${
        yReference === null
          // La valeur reste LUE ; seul le trait manque, et l'écran le dit.
          ? ' <span class="graphique__hors-cadre">(hors du cadre)</span>' : ''}`
      : `<span class="graphique__sans-reference">Aucune référence connue</span>`)
    + (burst && yReference !== null
      ? `<span class="graphique__cle graphique__cle--burst"></span>Burst — au-delà de la réservation, et c’est normal`
      : '')
    + `</p>`
    + tableauCache(serie, cle, format, `${titre}, point par point`)
    + `</section>`;
}

/**
 * Micro-courbe d'une ligne de tableau. Même règle sur les trous, aucune
 * légende : c'est une comparaison entre objets, pas un quatrième graphique.
 */
export function renderMicroCourbe(serie, cle, { couleur = 'brand', titre = '' } = {}) {
  const haut = borneHaute(serie, cle, null);
  if (haut === null) {
    return `<span class="micro micro--vide" role="img"`
      + ` aria-label="${echapper(titre)} : aucune mesure">—</span>`;
  }
  const total = serie.length;
  const utileX = MICRO.largeur;
  const traces = segments(serie, cle).map((segment) => {
    const points = segment.map((p) => {
      const x = total <= 1 ? utileX / 2 : (p.index * utileX) / (total - 1);
      const y = MICRO.hauteur - 2 - (p.valeur / haut) * (MICRO.hauteur - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return segment.length === 1
      ? `<circle cx="${points.split(',')[0]}" cy="${points.split(',')[1]}" r="1.5" />`
      : `<polyline points="${points}" />`;
  }).join('');
  return `<svg class="micro micro--${echapper(couleur)}" role="img"`
    + ` aria-label="${echapper(titre)}"`
    + ` viewBox="0 0 ${MICRO.largeur} ${MICRO.hauteur}" preserveAspectRatio="none">`
    + `${traces}</svg>`;
}
