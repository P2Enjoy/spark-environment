/**
 * Onglet de supervision du journal — troisième onglet sous Forge.
 *
 * @spec docs/BACKLOG.md#SPK-39 · docs/DAT.md §36.8 (ce que l'onglet rend),
 *       §36.8 bis (son contrat), §36.4 (deux classes jamais confondues),
 *       §21.6.2 (l'identité attribue, elle ne prouve pas), §36.9.6 (les cinq
 *       verdicts de l'ancre) · docs/DESIGN_SYSTEM.md §5.4, §6.13 (états de
 *       vue), §6.14 (tableau), §14.6, §14.7
 *
 * Le journal couvre TOUS les Sparks : le lire dans la fenêtre d'un seul
 * obligerait à ouvrir chaque Spark pour reconstituer une séquence qui les
 * traverse. La facette « Journal » d'un Spark reste, parce qu'elle répond à une
 * autre question — « qu'est-il arrivé à celui-ci ».
 */

import { renderOngletsForge } from './host-images.js';
import { formatDate } from './host-view.js';
import { traduireMessage } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Les trois résultats, avec leur sens. §14.6 : jamais la couleur seule. */
export const RESULTATS = {
  ok: { label: 'réussi', token: 'success' },
  denied: { label: 'refusé', token: 'accent' },
  error: { label: 'en erreur', token: 'danger' },
};

/**
 * Les cinq verdicts de l'ancre (§36.9.6), et ce qu'ils valent à l'écran.
 *
 * `shrunk` et `diverged` sont les DEUX attaques que la chaîne seule ne voit
 * pas. Ce sont les seules qui portent `danger` : une ancre neuve ou une histoire
 * qui prolonge ne sont pas des anomalies.
 */
export const VERDICTS = {
  first: { label: 'Première comparaison', token: 'neutral' },
  extends: { label: 'L’histoire se prolonge', token: 'success' },
  unchanged: { label: 'Rien de nouveau', token: 'neutral' },
  shrunk: { label: 'Le journal a raccourci', token: 'danger' },
  diverged: { label: 'Le journal a été remplacé', token: 'danger' },
};

export const FILTRES_VIDES = {
  result: '', action: '', actor: '', actor_class: '', since: '',
};

/** Qui a produit l'entrée. Le libellé dit « déclaré », JAMAIS « signé » (§21.6.2). */
export function renderAuteurCellule(entree) {
  if (entree?.actor_class === 'runtime') {
    return `<span class="badge badge--neutral" title="Événement produit par le`
      + ` serveur lui-même. Personne ne l’a demandé, et rien ne le signe.">`
      + `automatique</span>`;
  }
  const qui = entree?.actor && entree.actor !== 'inconnu' ? entree.actor : null;
  // §6.14 : une cellule dense s'ellipse, mais la valeur complete doit rester
  // accessible. L'identite porte le serveur ET l'empreinte de cle : tronquee
  // sans recours, elle ne permettrait plus de distinguer deux postes.
  return qui
    ? `<span class="technique" title="${echapper(qui)}">${echapper(qui)}</span>`
    : '<span class="absence-cellule">auteur non déclaré</span>';
}

/**
 * L'état de la chaîne ET celui de l'ancre, JAMAIS résumés en un seul indicateur.
 *
 * C'est le point qui décide de la forme de cet écran (§36.8.4) : une chaîne
 * intacte avec une ancre qui alerte est exactement la troncature — le cas le
 * plus important de tout le dispositif. « Tout va bien » y serait faux.
 */
export function renderIntegrite({ chain = null, anchor = null, checking = false } = {}) {
  const chaine = chain === null
    ? `<p class="absence">La chaîne n’a pas encore été vérifiée dans cette session.
       L’état affiché serait une supposition, et c’est précisément ce que ce
       dispositif existe pour ne pas laisser croire.</p>`
    : chain.intact
      ? `<p><span class="badge badge--success"><span class="badge__point" aria-hidden="true"></span>Chaîne intacte</span>
         ${echapper(chain.checked)} entrée(s) parcourue(s), vérifiées le
         <span class="technique">${echapper(formatDate(chain.verified_at))}</span>.</p>`
      : `<div class="refus" role="alert">
           <p><strong>Chaîne rompue à l’entrée ${echapper(chain.break?.id)}.</strong></p>
           <p>${chain.break?.reason === 'entry_hash'
             ? 'Cette entrée a été récrite : son contenu ne correspond plus à son empreinte.'
             : 'Une entrée a été retirée ou insérée juste avant celle-ci.'}
           Action « <span class="technique">${echapper(chain.break?.action)}</span> »,
           du <span class="technique">${echapper(formatDate(chain.break?.ts))}</span>.</p>
         </div>`;

  const verdict = anchor ? (VERDICTS[anchor.verdict] ?? null) : null;
  const ancre = anchor === null
    ? '<p class="absence">La console n’a pas encore comparé cette histoire à ce qu’elle avait vu.</p>'
    : `<p><span class="badge badge--${verdict?.token ?? 'neutral'}"><span class="badge__point" aria-hidden="true"></span>${
        echapper(verdict?.label ?? anchor.verdict)}</span> ${echapper(anchor.explanation ?? '')}</p>`
      + (anchor.known
        ? `<p class="note">La console avait retenu ${echapper(anchor.known.length)} entrée(s) ;
           le serveur en annonce ${echapper(anchor.announced?.length ?? 0)}.</p>`
        : '');

  return `
<section class="carte bloc" aria-labelledby="titre-integrite">
  <h2 id="titre-integrite">Intégrité</h2>
  <div class="definitions">
    <div class="def"><dt>Chaîne, telle que le serveur la voit</dt><dd>${chaine}</dd></div>
    <div class="def"><dt>Comparaison avec ce que la console avait vu</dt><dd>${ancre}</dd></div>
  </div>
  <p class="note">La chaîne détecte qu’une entrée a été récrite ou retirée du
  milieu. Elle ne peut pas voir qu’on a coupé la fin, ni qu’on a remplacé le
  journal entier : c’est la comparaison ci-dessus qui le voit, parce que la
  référence vit sur cette machine et non sur le serveur.
  <strong>Aucune entrée n’est signée</strong> — l’identité est déclarée par la
  console, elle attribue sans prouver.</p>
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-action="verifier-chaine" ${checking ? 'disabled' : ''}>${
      checking ? 'Vérification…' : 'Vérifier la chaîne'}</button>
  </p>
</section>`;
}

/** Les filtres. §36.8.2 : quatre, plus une date minimale. */
function renderFiltres(filtres) {
  const choix = (nom, libelle, options) =>
    `<div class="champ">
       <label for="filtre-${nom}">${echapper(libelle)}</label>
       <select class="controle" id="filtre-${nom}" name="${nom}">${
         options.map(([valeur, texte]) =>
           `<option value="${echapper(valeur)}"${
             filtres[nom] === valeur ? ' selected' : ''}>${echapper(texte)}</option>`).join('')}
       </select>
     </div>`;

  return `<form class="filtres" data-filtres="journal">
    ${choix('result', 'Résultat', [['', 'Tous'], ['ok', 'réussi'],
                                   ['denied', 'refusé'], ['error', 'en erreur']])}
    ${choix('actor_class', 'Origine', [['', 'Toutes'], ['human', 'geste humain'],
                                       ['runtime', 'événement du serveur']])}
    <div class="champ">
      <label for="filtre-action">Action</label>
      <input class="controle technique" id="filtre-action" name="action" type="text"
             autocomplete="off" placeholder="spark" value="${echapper(filtres.action)}">
      <p class="champ__aide">Un préfixe suffit : « spark » retient toutes les
      actions qui commencent ainsi.</p>
    </div>
    <div class="champ">
      <label for="filtre-actor">Acteur</label>
      <input class="controle" id="filtre-actor" name="actor" type="text"
             autocomplete="off" placeholder="console" value="${echapper(filtres.actor)}">
    </div>
    <p class="formulaire__actions">
      <button type="submit" class="bouton bouton--primaire">Filtrer</button>
      ${Object.values(filtres).some(Boolean)
        // Un « Tout afficher » alors que tout est deja affiche est un bouton
        // mort, et un bouton mort vaut moins que pas de bouton (§1.4).
        ? '<button type="button" class="bouton" data-action="filtres-vides">Tout afficher</button>'
        : ''}
    </p>
  </form>`;
}

function renderLigne(e) {
  const { label, token } = RESULTATS[e.result] ?? { label: e.result, token: 'neutral' };
  return `<tr>
  <td class="technique cellule-dense">${echapper(formatDate(e.ts))}</td>
  <td><span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${echapper(label)}</span></td>
  <td class="technique cellule-dense">${echapper(e.action)}</td>
  <td class="cellule-dense">${renderAuteurCellule(e)}</td>
  <td>${echapper(traduireMessage(e.message))}</td>
</tr>`;
}

/** Vue complète. §6.13 : chargement, vide et erreur sont traités explicitement. */
export function renderJournalHote({ status = 'loading', entries = [], error = null,
                                    filtres = FILTRES_VIDES, chain = null,
                                    anchor = null, checking = false } = {}) {
  const entete = `
<header class="entete-entite">
  <div class="entete-entite__identite"><h1>Journal</h1></div>
  <p class="note">Toutes les opérations, sur tous les Sparks. La facette
  « Journal » d’un Spark ne montre que ce qui le concerne.</p>
</header>`;

  if (status === 'loading') {
    return `${entete}<div class="carte bloc" aria-busy="true">
      <p class="sr-only" role="status">Chargement du journal…</p>
      ${Array.from({ length: 5 }, (_, i) =>
        `<span class="squelette" style="display:block;width:${75 - i * 7}%;margin-bottom:var(--space-3)"></span>`).join('')}
    </div>`;
  }
  if (status === 'error') {
    return `${entete}<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
      <h2>Le journal n’a pas pu être lu</h2>
      <p>${echapper(traduireMessage(error?.message) || 'Cause inconnue.')}</p>
      <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
    </div></div>`;
  }

  const filtre = Object.values(filtres).some(Boolean);
  const corps = entries.length
    ? `<div class="tableau-enveloppe">
    <p class="tableau-indice">Le tableau défile horizontalement.</p>
    <table>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Résultat</th>
        <th scope="col">Action</th><th scope="col">Auteur</th>
        <th scope="col">Ce qui s’est passé</th>
      </tr></thead>
      <tbody>${entries.map(renderLigne).join('')}</tbody>
    </table>
  </div>`
    // §6.13 : un état vide ne propose une action que si elle est pertinente.
    // Filtré, l'action utile est d'élargir ; non filtré, il n'y a rien à faire.
    : filtre
      ? `<div class="etat-vue">
         <h2>Aucune opération ne correspond à ces filtres</h2>
         <p>Le journal n’est pas vide : ce sont les filtres qui excluent tout.</p>
         <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="filtres-vides">Tout afficher</button></p>
       </div>`
      : `<div class="etat-vue">
         <h2>Aucune opération enregistrée</h2>
         <p>Le journal se remplit dès la première écriture sur ce serveur.</p>
       </div>`;

  return `${entete}
${renderIntegrite({ chain, anchor, checking })}
<section class="carte bloc" aria-labelledby="titre-journal-forge">
  <h2 id="titre-journal-forge">Opérations</h2>
  ${renderFiltres(filtres)}
  ${corps}
  <p class="note">Les lectures ne sont pas journalisées : elles n’altèrent rien et
  noieraient ce qu’on vient chercher. Deux exceptions, parce qu’elles disent qui
  est entré : l’ouverture d’un tunnel et les vérifications d’intégrité.</p>
</section>`;
}

/** Les onglets de la Forge, journal compris (§34.1). */
export function renderJournalHotePage(etat) {
  return renderOngletsForge('#/forge/journal') + renderJournalHote(etat);
}
