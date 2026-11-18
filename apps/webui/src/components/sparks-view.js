/**
 * Écran « liste des Sparks ».
 *
 * @spec docs/BACKLOG.md#SPK-18 · docs/DESIGN_SYSTEM.md §6.13 (états
 *       systématiques), §6.14 (tableau), §9 (accessibilité), §14.5 (absence),
 *       §14.6 (mesure indisponible) · docs/DESIGN_SYSTEM_APP.md §4
 * @spec docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.4 (les projets d'un Spark en
 *       pastilles ; l'onglet d'un projet est cette liste, restreinte) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-33 — pour le filtre et les pastilles
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68 (l'anneau de Mémoire et de
 *       Disque, la ligne des totaux de l'onglet « Tous ») ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-44 · docs/DESIGN_SYSTEM.md §1.5, §6.14,
 *       §14.6 — pour `renderAnneau`, `renderMesure`, `capaciteDeForge`,
 *       `sommerMesures` et `renderBlocTotal`
 *
 * Rendu en chaînes HTML plutôt qu'avec un framework : la vue est une liste, et
 * une dépendance de rendu se justifiera quand l'interactivité l'exigera
 * (SPK-19 et suivantes). Les fonctions restent pures, donc éprouvables sans
 * navigateur.
 */

import { stateOf, formatBytes, formatBps, formatCpu, MEASURE, tunnelOf,
         SEUIL_ALERTE_RESSOURCE, proportionRessource } from './tokens.js';
import { renderPastillesProjets, ADRESSE_GESTION } from './sparks-projets.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Badge d'état. La couleur ne porte jamais seule l'information (§9.8). */
/**
 * L'état protégé, visible PARTOUT où le Spark est listé (docs/DAT.md §35.4).
 *
 * @spec docs/BACKLOG.md#SPK-34 · docs/DAT.md §35.4 · docs/DESIGN_SYSTEM.md §6.23
 *
 * Le badge est `neutral` et non `danger` : un Spark protégé n'est pas en panne,
 * il est dans l'état où son responsable l'a laissé. Le §14.6 interdit d'employer
 * la couleur d'alerte pour signaler autre chose qu'un défaut.
 *
 * Le titre dit ce que la protection VAUT — un garde-fou, pas une frontière de
 * sécurité (§35.1) —, parce que la console ne la présentera jamais autrement.
 */
export function renderProtectionBadge(spark) {
  if (!spark?.protected) return '';
  return ` <span class="badge badge--neutral" title="Les écritures visant ce Spark`
    + ` sont refusées tant que la protection est armée. C’est un garde-fou contre`
    + ` le geste accidentel, pas un contrôle d’accès.">`
    + `<span class="badge__point" aria-hidden="true"></span>protégé</span>`;
}

export function renderStateBadge(state) {
  const { token, label, transient } = stateOf(state);
  const classes = `badge badge--${token}${transient ? ' badge--transitoire' : ''}`;
  const suffixe = transient ? ' <span class="sr-only">(opération en cours)</span>' : '';
  return `<span class="${classes}"><span class="badge__point" aria-hidden="true"></span>${echapper(label)}${suffixe}</span>`;
}

/**
 * Jauge CPU. Le burst n'est PAS un dépassement (SPK-DS-02).
 *
 * Une jauge rouge sur « 1,99 / 0,5 » signalerait une violation là où il n'y a
 * qu'un usage optimal de la machine.
 */
export function renderCpuGauge(usage, spark) {
  const reservation = spark?.cpu_reservation ?? spark?.cpu_max ?? null;

  if (spark?.state === 'stopped') return `<span class="jauge__absent">${MEASURE.stopped}</span>`;
  if (spark?.state === 'error') return `<span class="jauge__absent">${MEASURE.unavailable}</span>`;
  if (spark?.state === 'pending') return `<span class="jauge__absent">${MEASURE.declared}</span>`;
  if (usage?.used === null || usage?.used === undefined)
    return `<span class="jauge__absent">${MEASURE.pending}</span>`;

  const used = usage.used;
  const depasse = Boolean(usage.over_limit);
  const echelle = Math.max(reservation ?? used, used, 0.0001);
  const partReserve = Math.min(used, reservation ?? used) / echelle;
  const partBurst = Math.max(0, used - (reservation ?? used)) / echelle;

  const classeSurplus = depasse ? 'jauge__part--depasse' : 'jauge__part--burst';
  const nomSurplus = depasse ? 'dépassement' : 'burst';
  const texte = reservation
    ? `${formatCpu(used)} sur ${formatCpu(reservation)} CPU réservés`
    : `${formatCpu(used)} CPU`;
  const mention = partBurst > 0 ? ` — ${formatCpu(used - reservation)} en ${nomSurplus}` : '';

  return [
    '<span class="jauge">',
    '<span class="jauge__piste" aria-hidden="true">',
    `<span class="jauge__part jauge__part--reserve" style="width:${(partReserve * 100).toFixed(1)}%"></span>`,
    partBurst > 0
      ? `<span class="jauge__part ${classeSurplus}" style="width:${(partBurst * 100).toFixed(1)}%"></span>`
      : '',
    '</span>',
    `<span class="jauge__texte">${echapper(texte + mention)}</span>`,
    '</span>',
  ].join('');
}

// Anneau de 24 px (l'échelle d'espacement, DESIGN_SYSTEM.md §4.1) : rayon 9 et
// trait 4 le tiennent dans sa boîte, et sa circonférence se calcule une fois.
const RAYON_ANNEAU = 9;
const CIRCONFERENCE_ANNEAU = 2 * Math.PI * RAYON_ANNEAU;

/**
 * Anneau d'une part de limite occupée (SPK-DS-44). Décoratif : les chiffres et
 * le texte réservé aux lecteurs d'écran portent l'information (§1.5).
 *
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68.2 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-44
 */
export function renderAnneau(proportion) {
  const borne = Math.min(Math.max(proportion, 0), 1);
  const alerte = proportion >= SEUIL_ALERTE_RESSOURCE;
  const trait = (CIRCONFERENCE_ANNEAU * borne).toFixed(2);
  return '<svg class="anneau" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">'
    + `<circle class="anneau__piste" cx="12" cy="12" r="${RAYON_ANNEAU}"/>`
    + (borne > 0
      ? `<circle class="anneau__part${alerte ? ' anneau__part--alerte' : ''}" cx="12" cy="12" r="${RAYON_ANNEAU}"`
        + ` stroke-dasharray="${trait} ${CIRCONFERENCE_ANNEAU.toFixed(2)}" transform="rotate(-90 12 12)"/>`
      : '')
    + '</svg>';
}

/**
 * Pourcentage ENTIER d'une part, tronqué et non arrondi : 89,6 % se dit 89 %, de
 * sorte que le chiffre annoncé ne contredit jamais l'alerte (qui tient à 90 %
 * exactement). La tolérance absorbe les restes de la virgule flottante : 0,95 ×
 * 100 ne doit pas se dire 94 %.
 */
function pourcentage(proportion) {
  return Math.floor(proportion * 100 + 1e-9);
}

/**
 * Une mesure et sa limite : chiffres, et anneau quand la part se calcule.
 *
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68.2 · docs/DESIGN_SYSTEM.md
 *       §14.6 (une absence de donnée reste VIDE, §6.14)
 *
 * Sans mesure : rien. Sans limite : les chiffres seuls, il n'y a pas de part à
 * dessiner. Au-delà du seuil, la couleur est doublée du gras et d'un texte pour
 * lecteurs d'écran : elle ne porte jamais seule l'information (§1.5).
 */
function renderMesure(valeur, limite, formateur) {
  if (valeur === null || valeur === undefined) return '';
  const texte = formateur(valeur) + (limite ? ` / ${formateur(limite)}` : '');
  const proportion = proportionRessource(valeur, limite);
  if (proportion === null) return `<span class="technique">${echapper(texte)}</span>`;
  const alerte = proportion >= SEUIL_ALERTE_RESSOURCE;
  return `<span class="mesure${alerte ? ' mesure--alerte' : ''}">${renderAnneau(proportion)}`
    + `<span class="technique">${echapper(texte)}</span>`
    + `<span class="sr-only"> ${pourcentage(proportion)} % de la limite${
      alerte ? ', proche de la limite' : ''}</span></span>`;
}

/**
 * Les pools de la Forge que la liste compare : capacité, alloué, disponible.
 *
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68.3 (le bloc « Total de la
 *       Forge »), §27.2 (les trois valeurs d'un pool, LUES et jamais recomposées)
 *
 * Alloué et disponible sont ceux de l'écran Forge : un second calcul ferait
 * diverger les deux écrans. Une lecture absente donne `null` par ressource,
 * jamais zéro (§14.6).
 */
export function capaciteDeForge(forge) {
  if (!forge?.pools) return null;
  const pool = (p) => (p && typeof p.capacity === 'number' ? {
    capacite: p.capacity, alloue: p.allocated ?? null, disponible: p.available ?? null,
    surengagement: p.overcommit ?? null } : null);
  return { cpu: pool(forge.pools.cpu), memoire: pool(forge.pools.memory),
           disque: pool(forge.pools.storage) };
}

/**
 * Somme des mesures disponibles, et combien de Sparks en ont une.
 *
 * Un Spark arrêté n'a pas de CPU ni de mémoire mesurés (DAT §20.4) : il
 * n'ajoute rien, et il n'est pas compté « mesuré ». Zéro n'est pas inconnu.
 */
export function sommerMesures(sparks, usage, lire) {
  let somme = 0;
  let mesures = 0;
  for (const s of sparks) {
    const v = lire(usage?.[s.name] ?? {});
    if (typeof v === 'number' && Number.isFinite(v)) { somme += v; mesures += 1; }
  }
  return { somme, mesures, sparks: sparks.length };
}

const RESSOURCES_TOTAL = [
  { cle: 'cpu', nom: 'Processeur', format: (v) => `${formatCpu(v)} CPU` },
  { cle: 'memoire', nom: 'Mémoire', format: formatBytes },
  { cle: 'disque', nom: 'Disque', format: formatBytes },
];

// Anneau du bloc de totaux : 128 px de côté et un trait de 16 px, dimensions du
// COMPOSANT (hors échelle d'espacement, comme les 288 px d'une colonne de board).
const RAYON_TOTAL = 56;
const CIRCONFERENCE_TOTAL = 2 * Math.PI * RAYON_TOTAL;

/** Un arc commençant en haut, de la part donnée (0 à 1) de la circonférence. */
function arcTotal(classe, part) {
  const trait = (CIRCONFERENCE_TOTAL * Math.min(Math.max(part, 0), 1)).toFixed(2);
  return `<circle class="total-anneau__arc ${classe}" cx="64" cy="64" r="${RAYON_TOTAL}"`
    + ` stroke-dasharray="${trait} ${CIRCONFERENCE_TOTAL.toFixed(2)}" transform="rotate(-90 64 64)"/>`;
}

/**
 * L'anneau d'une ressource : la capacité, avec l'alloué en gris (ou rouge au-delà
 * du seuil) et l'utilisé par-dessus, en bleu. Ce qui reste de la piste est le
 * disponible. Décoratif : la légende porte les valeurs (§1.5).
 *
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68.3 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-44
 */
export function renderAnneauTotal({ partAlloue, partUtilise, alerte, centre }) {
  return '<div class="total-anneau">'
    + '<svg viewBox="0 0 128 128" width="128" height="128" aria-hidden="true" focusable="false">'
    + `<circle class="total-anneau__piste" cx="64" cy="64" r="${RAYON_TOTAL}"/>`
    + (partAlloue > 0 ? arcTotal(alerte ? 'total-anneau__arc--alerte' : 'total-anneau__arc--alloue', partAlloue) : '')
    + (partUtilise > 0 ? arcTotal('total-anneau__arc--utilise', partUtilise) : '')
    + '</svg>'
    + `<div class="total-anneau__centre">${centre}</div>`
    + '</div>';
}

/** Une ligne de légende : pastille de la couleur de la part, nom, valeur. */
function renderLegende(classe, nom, valeur, { alerte = false, aide = '' } = {}) {
  return `<li class="total-legende__ligne${alerte ? ' mesure--alerte' : ''}">`
    + `<span class="total-legende__pastille total-legende__pastille--${classe}" aria-hidden="true"></span>`
    + `<span class="total-legende__nom">${echapper(nom)}</span>`
    + `<span class="technique">${valeur}${aide}</span></li>`;
}

/**
 * Bloc « Total de la Forge », au-dessus du tableau de l'onglet « Tous »
 * (DAT §68.3, SPK-DS-44).
 *
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68.3 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-44 · docs/DESIGN_SYSTEM.md §1.5, §6.13, §14.6
 *
 * Un GRAPHIQUE, pas une copie de l'écran Forge : un anneau par ressource, dont la
 * légende donne, une fois, utilisé, alloué et disponible. Alloué et disponible
 * sont LUS de `/v1/forge` ; l'utilisé est la somme des mesures. L'alerte porte
 * sur l'ALLOUÉ (la Forge n'accepte presque plus de Spark), pas sur l'utilisé : le
 * CPU consomme au-delà de sa réservation sans défaut (SPK-DS-02). Capacité
 * inconnue : pas d'anneau à découper, l'utilisé en chiffres, l'absence nommée.
 */
export function renderBlocTotal(sparks, usage, forge) {
  const pools = capaciteDeForge(forge);
  // Les Sparks à cœurs dédiés ne tirent pas sur le pool partagé (§7.7) : leur CPU
  // n'est pas dans la capacité qu'on compare, il n'est donc pas dans la somme.
  const partages = sparks.filter((sp) => sp.cpu_mode !== 'dedicated');
  const dedies = sparks.length - partages.length;
  const sommes = {
    cpu: sommerMesures(partages, usage, (u) => u.cpu?.used),
    memoire: sommerMesures(sparks, usage, (u) => u.memory?.used_bytes),
    disque: sommerMesures(sparks, usage, (u) => u.disk?.used_bytes),
  };
  const enMarche = sparks.some((sp) => sp.state === 'running');

  const colonnes = RESSOURCES_TOTAL.map(({ cle, nom, format }) => {
    const pool = pools?.[cle] ?? null;
    const somme = sommes[cle];
    const utilise = somme.mesures > 0
      ? echapper(format(somme.somme))
      : `<span class="jauge__absent">${(cle === 'cpu' || cle === 'memoire') && enMarche
        ? MEASURE.pending : 'Aucune mesure'}</span>`;

    const partAlloue = pool ? proportionRessource(pool.alloue, pool.capacite) : null;
    const partUtilise = pool && somme.mesures > 0
      ? proportionRessource(somme.somme, pool.capacite) : null;
    const alerte = partAlloue !== null && partAlloue >= SEUIL_ALERTE_RESSOURCE;

    const surengage = pool?.surengagement && pool.surengagement !== 1 && cle !== 'disque'
      ? ` <span class="badge badge--accent">surengagé ×${echapper(String(pool.surengagement).replace('.', ','))}</span>` : '';

    const notes = [
      somme.mesures < somme.sparks
        ? `${somme.mesures} Spark${somme.mesures > 1 ? 's' : ''} sur ${somme.sparks} mesuré${somme.mesures > 1 ? 's' : ''}` : '',
      cle === 'cpu' && dedies > 0 ? 'Sparks à cœurs dédiés exclus' : '',
    ].filter(Boolean);
    // Les notes se disent en UNE ligne : deux paragraphes empilés laissaient un
    // grand vide sous la seule colonne qui en porte deux (observé en capture).
    const notesRendues = notes.length
      ? `<p class="total__note">${echapper(notes.join(' · '))}</p>` : '';

    // Sans capacité (ou sans part calculable) il n'y a rien à découper : pas
    // d'anneau, l'utilisé seul en légende.
    const anneau = partAlloue === null ? '' : renderAnneauTotal({
      partAlloue, partUtilise: partUtilise ?? 0, alerte,
      centre: `<strong class="technique">${echapper(format(pool.capacite))}</strong><span>capacité</span>`,
    });
    const legende = [
      renderLegende('utilise', 'Utilisé', utilise),
      pool ? renderLegende(alerte ? 'alerte' : 'alloue', 'Alloué', echapper(format(pool.alloue)), {
        alerte, aide: alerte ? '<span class="sr-only">, proche de la limite</span>' : '' }) : '',
      pool ? renderLegende('disponible', 'Disponible', echapper(format(pool.disponible))) : '',
    ].join('');

    return `<div class="total-ressource">
  <h3>${echapper(nom)}${surengage}</h3>
  ${anneau}
  <ul class="total-legende">${legende}</ul>
  ${notesRendues}
</div>`;
  }).join('');

  const absence = pools === null || RESSOURCES_TOTAL.some(({ cle }) => !pools[cle])
    ? '<p class="avertissement" role="status">Capacité de la Forge non relevée : seul l’utilisé est affiché.</p>'
    : '';

  return `<section class="carte bloc total-forge" aria-labelledby="titre-total-forge">
  <h2 id="titre-total-forge">Total de la Forge</h2>
  ${absence}
  <div class="total-forge__ressources">${colonnes}</div>
</section>`;
}

const COLONNES = [
  { cle: 'name', libelle: 'Spark', triable: true },
  { cle: 'state', libelle: 'État', triable: true },
  { cle: 'cpu', libelle: 'CPU', triable: false },
  { cle: 'memory', libelle: 'Mémoire', triable: false },
  { cle: 'disk', libelle: 'Disque', triable: false },
  { cle: 'ipv4_address', libelle: 'Adresse', triable: false, secondaire: true },
  { cle: 'image', libelle: 'Image', triable: false, secondaire: true },
];

/** Vue complète. Traite explicitement chargement, vide et erreur (§6.13). */
export function renderSparksView({ status, sparks = [], usage = {}, error = null, forge = null,
                                   sort = { key: 'name', dir: 'asc' }, tunnel = null,
                                   // SPK-116 · §61.4 : l'onglet d'un projet est
                                   // CETTE liste, restreinte à ses Sparks.
                                   projet = null, projetAbsent = false } = {}) {
  const bandeau = tunnel && tunnel.state !== 'ready'
    ? `<p class="bandeau-tunnel" role="alert">Tunnel « ${echapper(tunnel.name)} » ${echapper(tunnelOf(tunnel.state).label)} — les données affichées ne sont plus à jour.</p>`
    : '';

  if (status === 'loading') return bandeau + renderSkeleton();
  if (status === 'error') return bandeau + renderError(error);
  if (projetAbsent) return bandeau + renderProjetAbsent();
  if (projet && sparks.length === 0) return bandeau + renderProjetVide(projet);
  if (sparks.length === 0) return bandeau + renderEmpty();

  const tries = [...sparks].sort((a, b) => {
    const va = String(a[sort.key] ?? ''); const vb = String(b[sort.key] ?? '');
    return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  const entetes = COLONNES.map((c) => {
    const classe = c.secondaire ? ' class="colonne-secondaire"' : '';
    if (!c.triable) return `<th scope="col"${classe}>${echapper(c.libelle)}</th>`;
    const actif = sort.key === c.cle;
    const ordre = actif ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    const fleche = actif ? (sort.dir === 'asc' ? '▲' : '▼') : '';
    return `<th scope="col" aria-sort="${ordre}"${classe}>` +
      `<button type="button" class="tri" data-tri="${c.cle}">${echapper(c.libelle)}` +
      `<span class="tri__fleche" aria-hidden="true">${fleche}</span></button></th>`;
  }).join('');

  const lignes = tries.map((s) => {
    const u = usage[s.name] ?? {};
    return [
      '<tr>',
      `<td class="cellule-nom"><a class="lien-spark" href="#/sparks/${encodeURIComponent(s.name)}" title="${echapper(s.name)}">${echapper(s.name)}</a>${
        renderProtectionBadge(s)}${renderPastillesProjets(s.projects)}</td>`,
      `<td>${renderStateBadge(s.state)}</td>`,
      `<td>${renderCpuGauge(u.cpu, s)}</td>`,
      `<td class="aligne-droite">${renderMesure(u.memory?.used_bytes, s.memory_reservation_bytes, formatBytes)}</td>`,
      `<td class="aligne-droite">${renderMesure(u.disk?.used_bytes, s.storage_bytes, formatBytes)}</td>`,
      `<td class="colonne-secondaire"><span class="technique">${echapper(s.ipv4_address ?? '')}</span></td>`,
      `<td class="colonne-secondaire cellule-dense" title="${echapper(s.image ?? '')}">${echapper(s.image ?? '')}</td>`,
      '</tr>',
    ].join('');
  }).join('');

  return `${bandeau}
<div class="titre-vue">
  <h1>${projet ? echapper(projet.name) : 'Sparks'}</h1>
  <p class="titre-vue__compte">${sparks.length} cellule${sparks.length > 1 ? 's' : ''}${
    projet ? ' dans ce projet' : ''}</p>
  <a class="bouton bouton--primaire bouton--compact" href="#/creer" style="margin-left:auto">Créer un Spark</a>
</div>
${
  // DAT §68.3 : les totaux de la Forge entière ne se rendent que dans l'onglet
  // « Tous » ; celui d'un projet n'en montrerait qu'une part.
  projet ? '' : renderBlocTotal(sparks, usage, forge)}
<div class="carte">
  <div class="tableau-enveloppe">
    <table>
      <caption class="sr-only">Liste des Sparks du serveur courant, avec leur état et leur consommation.</caption>
      <thead><tr>${entetes}</tr></thead>
      <tbody>${lignes}</tbody>
    </table>
  </div>
  <p class="tableau-indice">Le tableau défile horizontalement pour révéler les colonnes suivantes.</p>
</div>`;
}

/** Squelettes à la forme du contenu final, pas un spinner plein écran (§6.13). */
export function renderSkeleton(lignes = 4) {
  const cellules = () => COLONNES.map((c) =>
    `<td${c.secondaire ? ' class="colonne-secondaire"' : ''}><span class="squelette" style="display:block;width:${40 + (c.cle.length * 4)}%"></span></td>`,
  ).join('');
  return `
<div class="titre-vue"><h1>Sparks</h1></div>
<div class="carte" aria-busy="true">
  <p class="sr-only" role="status">Chargement des Sparks…</p>
  <div class="tableau-enveloppe"><table>
    <thead><tr>${COLONNES.map((c) => `<th scope="col"${c.secondaire ? ' class="colonne-secondaire"' : ''}>${echapper(c.libelle)}</th>`).join('')}</tr></thead>
    <tbody>${Array.from({ length: lignes }, () => `<tr>${cellules()}</tr>`).join('')}</tbody>
  </table></div>
</div>`;
}

/**
 * État vide. Il ne propose une action que lorsqu'une action pertinente existe
 * réellement (§6.13) — ici, créer un Spark en est une.
 */
export function renderEmpty() {
  return `
<div class="titre-vue"><h1>Sparks</h1></div>
<div class="carte"><div class="etat-vue">
  <h2>Aucun Spark sur ce serveur</h2>
  <p>Un Spark est une cellule d’exécution contingentée, destinée à héberger une pile Docker Compose.</p>
  <p style="margin-top:var(--space-4)"><a class="bouton bouton--primaire" href="#/creer">Créer un Spark</a></p>
</div></div>`;
}

/**
 * L'onglet d'un projet sans Spark : il le dit, et dit où l'on range (§61.4).
 *
 * @spec docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.4 · docs/DESIGN_SYSTEM.md §14.5
 */
export function renderProjetVide(projet) {
  return `
<div class="titre-vue"><h1>${echapper(projet.name)}</h1></div>
<div class="carte"><div class="etat-vue">
  <h2>Aucun Spark dans ce projet</h2>
  <p>On range un Spark depuis sa fenêtre : onglet <em>Infos</em>, section <em>Projets</em>.</p>
</div></div>`;
}

/**
 * Une adresse de projet qui ne mène à rien — supprimé depuis une autre console,
 * ou favori périmé. On le NOMME plutôt que de montrer une liste vide qui se
 * lirait comme un projet sans Spark (§14.6).
 */
export function renderProjetAbsent() {
  return `
<div class="titre-vue"><h1>Projet introuvable</h1></div>
<div class="carte"><div class="etat-vue">
  <h2>Ce projet n’existe pas, ou plus</h2>
  <p>Il a pu être supprimé depuis une autre console. Les projets existants sont listés dans
  l’onglet <a href="${ADRESSE_GESTION}">Projets</a>.</p>
</div></div>`;
}

/** Erreur. Le motif accompagne toujours le refus (docs/DAT.md §22.3). */
export function renderError(error) {
  const message = error?.message ?? 'Cause inconnue.';
  return `
<div class="titre-vue"><h1>Sparks</h1></div>
<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
  <h2>Les Sparks n’ont pas pu être chargés</h2>
  <p>${echapper(message)}</p>
  <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
</div></div>`;
}
