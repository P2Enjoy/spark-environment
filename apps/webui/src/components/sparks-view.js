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
 *       `sommerMesures` et `renderTotaux`
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
 * Capacités physiques de la Forge, telles que la liste les compare (DAT §68.3).
 *
 * Physiques, pas allouables : la mémoire vendue en surengagement ne s'ouvre pas à
 * un usage réel qui la dépasserait. Une lecture absente donne `null` par
 * grandeur, jamais zéro (§14.6).
 */
export function capaciteDeForge(forge) {
  if (!forge) return null;
  return {
    cpu: forge.cpu?.cores_total ?? null,
    memoire: forge.memory?.total_bytes ?? null,
    disque: forge.pools?.storage?.capacity ?? null,
  };
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

/** Note d'une somme partielle (§6.13, résultat partiel). */
function noteMesures({ mesures, sparks }) {
  return mesures < sparks
    ? `<span class="total__note">${mesures} Spark${mesures > 1 ? 's' : ''} sur ${sparks} mesuré${mesures > 1 ? 's' : ''}</span>`
    : '';
}

/**
 * Pied « Total » de l'onglet « Tous » (DAT §68.3, SPK-DS-44).
 *
 * @spec docs/BACKLOG.md#SPK-173 · docs/DAT.md §68.3 · docs/DESIGN_SYSTEM_APP.md
 *       SPK-DS-44
 *
 * Le CPU garde sa forme de colonne, la barre ; Mémoire et Disque, leur anneau.
 * Capacité inconnue : la somme reste, l'absence est NOMMÉE une fois, dans la
 * première cellule (§14.6).
 */
export function renderTotaux(sparks, usage, forge) {
  const capacite = capaciteDeForge(forge);
  const cpu = sommerMesures(sparks, usage, (u) => u.cpu?.used);
  const memoire = sommerMesures(sparks, usage, (u) => u.memory?.used_bytes);
  const disque = sommerMesures(sparks, usage, (u) => u.disk?.used_bytes);

  const partCpu = proportionRessource(cpu.somme, capacite?.cpu);
  // Aucun CPU mesuré : s'il y a des Sparks en marche, le premier relevé n'a pas
  // encore de fenêtre (DAT §20.1) — la cellule le DIT, comme celles des lignes,
  // plutôt que de rester muette (§14.6). Sans Spark en marche, il n'y a rien à dire.
  const enMarche = sparks.some((sp) => sp.state === 'running');
  const celluleCpu = cpu.mesures === 0
    ? (enMarche ? `<span class="jauge__absent">${MEASURE.pending}</span>` : '')
    : [
    '<span class="jauge">',
    partCpu === null ? '' : [
      '<span class="jauge__piste" aria-hidden="true">',
      `<span class="jauge__part ${partCpu >= SEUIL_ALERTE_RESSOURCE ? 'jauge__part--depasse' : 'jauge__part--reserve'}" style="width:${(Math.min(partCpu, 1) * 100).toFixed(1)}%"></span>`,
      '</span>',
    ].join(''),
    `<span class="jauge__texte${partCpu >= SEUIL_ALERTE_RESSOURCE ? ' mesure--alerte' : ''}">${echapper(
      formatCpu(cpu.somme) + (capacite?.cpu ? ` sur ${capacite.cpu} cœurs` : ' CPU'))}${
      partCpu >= SEUIL_ALERTE_RESSOURCE ? '<span class="sr-only">, proche de la limite</span>' : ''}</span>`,
    noteMesures(cpu),
    '</span>',
  ].join('');

  const cellule = (somme, limite) => (somme.mesures === 0 ? '' : renderMesure(somme.somme, limite, formatBytes)
    + noteMesures(somme));

  const absence = capacite === null || capacite.cpu === null || capacite.memoire === null
    || capacite.disque === null
    ? '<span class="total__note">Capacité de la Forge non relevée</span>' : '';

  return '<tfoot><tr class="ligne-total">'
    + `<th scope="row" class="nom-cellule">Total<span class="total__note">${sparks.length} Spark${
      sparks.length > 1 ? 's' : ''}</span>${absence}</th>`
    + '<td></td>'
    + `<td>${celluleCpu}</td>`
    + `<td class="aligne-droite">${cellule(memoire, capacite?.memoire)}</td>`
    + `<td class="aligne-droite">${cellule(disque, capacite?.disque)}</td>`
    + '<td class="colonne-secondaire"></td><td class="colonne-secondaire"></td>'
    + '</tr></tfoot>';
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
<div class="carte">
  <div class="tableau-enveloppe">
    <table>
      <caption class="sr-only">Liste des Sparks du serveur courant, avec leur état et leur consommation.</caption>
      <thead><tr>${entetes}</tr></thead>
      <tbody>${lignes}</tbody>${
        // DAT §68.3 : les totaux face à la Forge entière ne se rendent que dans
        // l'onglet « Tous » ; celui d'un projet n'en montrerait qu'une part.
        projet ? '' : renderTotaux(sparks, usage, forge)}
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
