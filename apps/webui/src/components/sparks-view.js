/**
 * Écran « liste des Sparks ».
 *
 * @spec docs/BACKLOG.md#SPK-18 · docs/DESIGN_SYSTEM.md §6.13 (états
 *       systématiques), §6.14 (tableau), §9 (accessibilité), §14.5 (absence),
 *       §14.6 (mesure indisponible) · docs/DESIGN_SYSTEM_APP.md §4
 *
 * Rendu en chaînes HTML plutôt qu'avec un framework : la vue est une liste, et
 * une dépendance de rendu se justifiera quand l'interactivité l'exigera
 * (SPK-19 et suivantes). Les fonctions restent pures, donc éprouvables sans
 * navigateur.
 */

import { stateOf, formatBytes, formatBps, formatCpu, MEASURE } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Badge d'état. La couleur ne porte jamais seule l'information (§9.8). */
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

/** Cellule de mesure instantanée. Une absence de donnée reste VIDE (§6.14). */
function renderMesure(valeur, limite, formateur) {
  if (valeur === null || valeur === undefined) return '';
  const rendu = formateur(valeur);
  const total = limite ? ` / ${formateur(limite)}` : '';
  return `<span class="technique">${echapper(rendu + total)}</span>`;
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
export function renderSparksView({ status, sparks = [], usage = {}, error = null,
                                   sort = { key: 'name', dir: 'asc' }, tunnel = null } = {}) {
  const bandeau = tunnel && tunnel.state !== 'ready'
    ? `<p class="bandeau-tunnel" role="alert">Tunnel « ${echapper(tunnel.name)} » ${echapper(tunnel.state)} — les données affichées ne sont plus à jour.</p>`
    : '';

  if (status === 'loading') return bandeau + renderSkeleton();
  if (status === 'error') return bandeau + renderError(error);
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
      `<td class="cellule-nom"><a class="lien-spark" href="#/sparks/${encodeURIComponent(s.name)}" title="${echapper(s.name)}">${echapper(s.name)}</a></td>`,
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
  <h1>Sparks</h1>
  <p class="titre-vue__compte">${sparks.length} cellule${sparks.length > 1 ? 's' : ''}</p>
  <a class="bouton bouton--primaire bouton--compact" href="#/creer" style="margin-left:auto">Créer un Spark</a>
</div>
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
