/**
 * Supervision continue : les courbes de la Forge, et celles d'un Spark.
 *
 * @spec docs/BACKLOG.md#SPK-93 · docs/DAT.md §52.6 (le pas de seau est écrit),
 *       §52.7 (l'agrégat dit combien de Sparks il somme), §52.8 (à quoi chaque
 *       courbe se compare), §52.11 (deux surfaces, un sujet chacune) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-20 (la courbe), SPK-DS-02 (le burst),
 *       SPK-DS-03 (nommer l'absence de mesure), SPK-DS-01 (l'état d'un Spark) ·
 *       docs/DESIGN_SYSTEM.md §6.13 (états systématiques), §6.14 (tableau de
 *       données), §14.5 (l'absence se nomme)
 *
 * Deux surfaces, et le §34 interdit qu'une surface ait deux sujets : l'écran de
 * Forge ne porte AUCUN geste sur un Spark, il y ramène.
 */

import { formatBytes, formatBps, formatCpu, stateOf } from './tokens.js';
import { renderGraphique, renderMicroCourbe, horodatage } from './graphique.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Fenêtres offertes. Les mêmes que celles que le serveur accepte (§52.6). */
export const FENETRES = [
  ['15m', '15 min'], ['1h', '1 h'], ['6h', '6 h'],
  ['24h', '24 h'], ['7d', '7 jours'],
];

export const SUPERVISION_VIDE = {
  status: 'loading',   // 'loading' | 'pret' | 'erreur'
  fenetre: '1h',
  donnees: null,
  error: null,
  curseur: null,       // index de seau visé, partagé par les quatre courbes
};

/**
 * Les quatre ressources, dans le même ordre partout.
 *
 * Une ressource, un token, le même sur l'écran de Forge et dans la fenêtre d'un
 * Spark (SPK-DS-20). Le format vient de `tokens.js` : deux écritures d'une même
 * grandeur divergeraient.
 */
export const RESSOURCES = [
  {
    cle: 'cpu', titre: 'Processeur', couleur: 'brand', burst: true,
    format: (v) => `${formatCpu(v)} CPU`,
  },
  {
    cle: 'memory_bytes', titre: 'Mémoire', couleur: 'success', burst: false,
    format: formatBytes,
  },
  {
    cle: 'rx_bps', titre: 'Réseau entrant', couleur: 'accent', burst: false,
    format: formatBps,
  },
  {
    cle: 'disk_bytes', titre: 'Disque', couleur: 'neutre', burst: false,
    format: formatBytes,
  },
];

/** À quoi chaque courbe se compare, et sous quel nom (§52.8). */
function reference(ressource, limites, { spark = false } = {}) {
  if (!limites) return { valeur: null, nom: null };
  switch (ressource.cle) {
    case 'cpu':
      // Les quatre modes du §7.2 ne garantissent pas la même chose, et le nom
      // doit le dire : un plafond se dépasse, une réservation se déborde, des
      // cœurs dédiés sont à soi.
      return {
        valeur: limites.cpu,
        nom: !spark ? 'Pool allouable'
          : limites.cpu_capped ? 'Plafond'
          : limites.cpu_mode === 'dedicated' ? 'Cœurs dédiés'
          : 'Réservation',
      };
    case 'memory_bytes':
      return { valeur: limites.memory_bytes, nom: spark ? 'Réservation' : 'Pool allouable' };
    case 'disk_bytes':
      return { valeur: limites.disk_bytes, nom: spark ? 'Quota' : 'Pool allouable' };
    case 'rx_bps':
      // §20.3 : le réseau se compare au PLAFOND, JAMAIS à la réservation que le
      // noyau n'applique pas.
      return { valeur: limites.net_bps, nom: spark ? 'Plafond' : 'Débit du lien' };
    default:
      return { valeur: null, nom: null };
  }
}

/**
 * Le burst n'existe QUE sur le CPU d'un Spark (SPK-DS-02).
 *
 * Sur l'agrégat de la Forge, la référence est une capacité de pool et non une
 * réservation : au-delà, ce n'est plus du burst, c'est un pool dépassé. Peindre
 * l'un comme l'autre nommerait deux choses différentes du même mot.
 */
function burstApplicable(ressource, { spark }) {
  return Boolean(ressource.burst && spark);
}

export function renderFenetres(courante, base) {
  return `<nav class="fenetres" aria-label="Période observée">${
    FENETRES.map(([cle, libelle]) =>
      `<a href="${echapper(base)}?fenetre=${echapper(cle)}" class="fenetre${
        cle === courante ? ' fenetre--courante' : ''}"${
        cle === courante ? ' aria-current="true"' : ''}>${echapper(libelle)}</a>`).join('')
  }</nav>`;
}

/**
 * Le pas de temps, écrit à côté de la fenêtre (SPK-DS-20).
 *
 * « 1 h — un point toutes les 15 s ». Une valeur agrégée sans son pas n'est pas
 * interprétable, et c'est la même raison qu'au §20.1 pour la fenêtre d'un taux.
 */
export function decrirePas(donnees) {
  const seau = donnees?.window?.bucket_seconds;
  if (!seau) return '';
  if (seau < 60) return `un point toutes les ${Math.round(seau)} s`;
  if (seau < 3600) return `un point toutes les ${Math.round(seau / 60)} min`;
  return `un point toutes les ${Math.round(seau / 3600)} h`;
}

/** Ce que l'écran dit de la fraîcheur, ou de son absence (§14.5, §14.6). */
export function renderFraicheur(donnees) {
  if (!donnees) return '';
  if (donnees.enabled === false) {
    // §52.2 : une cadence nulle est une CONFIGURATION, pas une panne. Le §14.5
    // interdit de la peindre comme une erreur.
    return `<p class="note" role="status">Supervision désactivée sur cette Forge :
      <span class="technique">SPARKD_METRICS_INTERVAL</span> vaut 0. Les courbes
      resteront vides tant qu’aucun relevé n’est pris.</p>`;
  }
  const pas = decrirePas(donnees);
  const dernier = donnees.last_sample_at;
  return `<p class="note" role="status">${
    echapper(donnees.window?.name || '')} — ${echapper(pas)}.
    ${dernier
      ? `Dernier relevé : <span class="technique">${echapper(horodatage(dernier))}</span>.`
      : 'Aucun relevé pour l’instant : le premier arrive à la prochaine cadence.'}</p>`;
}

function renderCourbes(serie, limites, { spark, curseur, actif }) {
  return `<div class="graphiques">${
    RESSOURCES.map((ressource) => {
      const ref = reference(ressource, limites, { spark });
      return renderGraphique({
        cle: ressource.cle,
        titre: ressource.titre,
        serie,
        format: ressource.format,
        reference: ref.valeur,
        referenceNom: ref.nom,
        couleur: ressource.couleur,
        burst: burstApplicable(ressource, { spark }),
        curseur,
        actif,
      });
    }).join('')
  }</div>`;
}

function renderErreur(error) {
  return `<section class="carte bloc" role="alert">
  <h2>Les mesures n’ont pas pu être lues</h2>
  <p>${echapper(error || 'La Forge n’a pas répondu.')}</p>
  <p class="note">Les Sparks continuent de tourner : c’est la lecture des
  mesures qui a échoué, pas la Forge.</p>
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
</section>`;
}

function renderSquelette() {
  return `<section class="carte bloc" aria-busy="true">
  <h2>Supervision</h2><p class="note">Lecture des mesures…</p></section>`;
}

/**
 * La répartition par Spark : un TABLEAU, pas quatre graphiques de plus.
 *
 * C'est une comparaison entre objets (§6.14, SPK-DS-20). Chaque ligne ramène à
 * la fenêtre du Spark et ne porte aucun geste : l'écran de Forge a pour sujet la
 * Forge (§52.11).
 */
export function renderRepartition(sparks) {
  if (!sparks?.length) {
    return `<section class="carte bloc" aria-labelledby="titre-repartition">
  <h2 id="titre-repartition">Par Spark</h2>
  <p class="absence">Aucun Spark sur cette Forge : il n’y a rien à mesurer.</p>
</section>`;
  }
  const lignes = sparks.map((entree) => {
    const etat = stateOf(entree.state);
    const cellules = RESSOURCES.map((ressource) => {
      const dernier = [...(entree.series || [])].reverse()
        .find((p) => p?.[ressource.cle] !== null && p?.[ressource.cle] !== undefined);
      return `<td class="mesure">${
        renderMicroCourbe(entree.series, ressource.cle, {
          couleur: ressource.couleur,
          titre: `${ressource.titre} de ${entree.spark}`,
        })}<span class="mesure__valeur">${
        dernier ? echapper(ressource.format(dernier[ressource.cle]))
          : '<span class="graphique__absente">—</span>'}</span></td>`;
    }).join('');
    return `<tr>
      <th scope="row"><a href="#/sparks/${encodeURIComponent(entree.spark)}/mesures">${
        echapper(entree.spark)}</a>
        <span class="badge badge--${echapper(etat.token)}">${echapper(etat.label)}</span></th>
      ${cellules}</tr>`;
  }).join('');

  return `<section class="carte bloc" aria-labelledby="titre-repartition">
  <h2 id="titre-repartition">Par Spark</h2>
  <div class="tableau-defilant">
  <table>
    <thead><tr><th scope="col">Spark</th>${
      RESSOURCES.map((r) => `<th scope="col">${echapper(r.titre)}</th>`).join('')}</tr></thead>
    <tbody>${lignes}</tbody>
  </table></div>
  <p class="note">Chaque ligne mène à la fenêtre du Spark, où ses gestes vivent.</p>
</section>`;
}

/** Écran « Forge → Supervision » (§52.11). */
export function renderSupervisionForge(ui = SUPERVISION_VIDE) {
  if (ui.status === 'loading') return renderSquelette();
  if (ui.status === 'erreur') return renderErreur(ui.error);
  const donnees = ui.donnees;
  if (!donnees) return renderErreur(null);
  const actif = donnees.enabled !== false;

  return `
<header class="entete-entite">
  <div class="entete-entite__identite"><h1>Supervision</h1></div>
  ${renderFenetres(ui.fenetre, '#/forge/supervision')}
</header>
${renderFraicheur(donnees)}
<section class="carte bloc" aria-labelledby="titre-total">
  <h2 id="titre-total">Toute la Forge</h2>
  <p class="note">Somme de ce que consomment les Sparks. Elle ne mesure ni la
  Forge elle-même, ni ce que consomment le plan de contrôle, Incus ou le proxy.</p>
  ${renderCourbes(donnees.total, donnees.limits, {
    spark: false, curseur: ui.curseur, actif,
  })}
  ${renderContributeurs(donnees.total)}
</section>
${renderRepartition(donnees.sparks)}`;
}

/**
 * Combien de Sparks la somme somme (§52.7).
 *
 * Sans cette phrase, une marche dans la courbe se lit comme un incident alors
 * qu'un Spark est simplement entré ou sorti de la mesure.
 */
export function renderContributeurs(total) {
  const portants = (total || []).filter((p) => (p?.samples || 0) > 0);
  if (!portants.length) return '';
  const nombres = [...new Set(portants.map((p) => p.sparks))].sort((a, b) => a - b);
  const dernier = portants[portants.length - 1].sparks;
  if (nombres.length === 1) {
    return `<p class="note">Somme de ${nombres[0]} Spark${nombres[0] > 1 ? 's' : ''}
      sur toute la période.</p>`;
  }
  return `<p class="note">Le nombre de Sparks mesurés varie sur la période
    (de ${nombres[0]} à ${nombres[nombres.length - 1]} ; ${dernier} au dernier
    relevé) : une marche dans la courbe peut venir de là, et non d’un changement
    de consommation.</p>`;
}

/** Facette « Mesures » d'un Spark (§52.11). */
export function renderSupervisionSpark(ui = SUPERVISION_VIDE) {
  if (ui.status === 'loading') return renderSquelette();
  if (ui.status === 'erreur') return renderErreur(ui.error);
  const donnees = ui.donnees;
  if (!donnees) return renderErreur(null);
  const actif = donnees.enabled !== false;
  const etat = stateOf(donnees.state);

  return `
<section class="carte bloc" aria-labelledby="titre-mesures">
  <div class="graphiques__entete">
    <h2 id="titre-mesures">Mesures — ${echapper(donnees.spark || '')}
      <span class="badge badge--${echapper(etat.token)}">${echapper(etat.label)}</span></h2>
    ${renderFenetres(ui.fenetre, `#/sparks/${encodeURIComponent(donnees.spark || '')}/mesures`)}
  </div>
  ${renderFraicheur(donnees)}
  ${renderCourbes(donnees.series, donnees.limits, {
    spark: true, curseur: ui.curseur, actif,
  })}
  <p class="note">La consommation au-delà de la réservation est du
  <strong>burst</strong> : en mode partagé, un Spark prend ce qui traîne, et
  c’est le produit qui fonctionne. Seul le mode plafonné pose une limite que le
  noyau applique.
  <a href="#/manuel/M8">Manuel M8 — Suivre la consommation</a></p>
</section>`;
}
