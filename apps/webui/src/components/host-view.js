/**
 * Écran « pools de ressources de la Forge ».
 *
 * @spec docs/BACKLOG.md#SPK-22 · docs/DAT.md §27 (rendre l'admission control
 *       observable), §27.2 (trois grandeurs), §27.3 (la soustraction mémoire),
 *       §8.8.2 (la marge de métadonnées est nommée à l'écran des pools),
 *       §27.4 (le CPU à deux endroits), §27.5 (le surengagement s'affiche),
 *       §27.6 (la réservation n'est pas une garantie), §27.8 (topologie) ·
 *       §7.7, §15, §16, §13.12 (l'ARC atteint son plafond sous charge) · docs/DESIGN_SYSTEM.md §3.1, §6.4, §6.13, §6.24, §14.6 ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * Cet écran répond à une seule question : « pourquoi cette création serait-elle
 * refusée, et de combien ? ». Tout ce qu'il affiche sert cette question.
 */

import { formatBytes, formatBps, formatCpu } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Les quatre ressources, avec leur formateur et ce que le surengagement veut
 * dire pour chacune. Le stockage n'en porte AUCUN, et c'est délibéré (§7.7).
 */
export const RESSOURCES = [
  { cle: 'cpu', nom: 'Processeur partagé', format: (v) => `${formatCpu(v)} CPU`,
    surengageable: true },
  { cle: 'memory', nom: 'Mémoire', format: formatBytes, surengageable: true },
  { cle: 'storage', nom: 'Disque', format: formatBytes, surengageable: false,
    sansFacteur: 'Aucun surengagement : un pool de disque saturé est une panne '
      + 'dure, là où un pool CPU saturé n’est que de la lenteur.' },
  { cle: 'network', nom: 'Réseau', format: formatBps, surengageable: true },
];

/** Portées possibles de la réservation, telles que le runtime les publie.
 *  §27.6 : la valeur est LUE dans la réponse, jamais écrite en dur ici. */
export const GARANTIES = {
  proportional_between_sparks_only:
    'La réservation CPU n’est proportionnelle qu’entre Sparks : elle est arbitrée '
    + 'contre les tranches de la Forge et n’est pas une garantie absolue.',
  absolute:
    'La réservation CPU est garantie même sous contention de la Forge.',
};

/** Part occupée d'un pool, en pourcentage borné. */
export function fillRatio(pool) {
  if (!pool || !pool.capacity) return 0;
  return Math.max(0, Math.min(100, (pool.allocated / pool.capacity) * 100));
}

/**
 * Ce que l'ARC consomme réellement, face à son plafond.
 *
 * Mesuré le 2026-08-19 (docs/DAT.md §13.12) : sous charge l'ARC atteint son
 * plafond et ne le dépasse pas. La réserve est donc à la fois nécessaire et
 * suffisante — mais seulement tant que c'est vrai. L'afficher rend la
 * vérification permanente au lieu de la laisser périmer.
 *
 * `null` n'est pas zéro : un ARC dont on ignore la taille n'est pas un ARC vide,
 * et les confondre ferait croire la réserve inutile (docs/DESIGN_SYSTEM.md
 * §14.6).
 */
export function describeArcUsage(utilise, plafond) {
  if (utilise === null || utilise === undefined) {
    return 'Sa consommation n’est pas mesurable sur cette Forge.';
  }
  const part = plafond ? Math.round((utilise / plafond) * 100) : null;
  return `Il en consomme actuellement ${formatBytes(utilise)}`
    + (part === null ? '.' : ` — ${part} % de son plafond.`);
}

/**
 * Ce que la marge de métadonnées ajoute à l'alloué du disque (docs/DAT.md §8.8).
 *
 * Elle est invisible du LOCATAIRE — la limite d'un Spark reste ce qu'on lui a
 * vendu — mais elle grossit l'alloué du pool, donc l'exploitant la voit. Un
 * exploitant qui additionne cinq Sparks de 10 Gio et lit 50,3 Gio doit trouver
 * l'explication ici, et non dans le code.
 *
 * La valeur est LUE dans la réponse, jamais posée en dur (§27.6) : c'est un
 * réglage du serveur, et une console qui l'écrirait mentirait dès qu'il change.
 * Une marge nulle ne dit rien — il n'y a rien à expliquer.
 */
export function describeMetadataMargin(forge) {
  const marge = forge?.reserves?.storage_metadata_margin_bytes;
  if (!marge) return '';
  // Le total est LU, pas recomposé : le nombre de Sparks n'est pas dans cette
  // réponse, et le recalculer ici ferait diverger l'écran du registre.
  const total = forge?.reserves?.storage_metadata_total_bytes;
  return `L’alloué comprend ${formatBytes(marge)} de métadonnées par Spark`
    + (total ? `, soit ${formatBytes(total)} au total` : '')
    + `. Sans cette marge, un Spark qui remplit son quota empêcherait Incus `
    + `d’écrire ses métadonnées, et ne pourrait plus être reconfiguré — pas même `
    + `agrandi pour le débloquer. Se règle par SPARKD_STORAGE_METADATA_MARGIN.`;
}

/** Horodatage lisible (§3.1 pour la typographie technique). */
export function formatDate(valeur) {
  return String(valeur ?? '').slice(0, 16).replace('T', ' ');
}

/**
 * Une ressource : capacité, alloué, disponible — les TROIS, jamais deux (§27.2).
 * « 4,0 Gio libres » sans dire sur combien ne permet pas de juger s'il faut
 * supprimer un Spark ou agrandir la machine.
 */
function renderPool({ cle, nom, format, surengageable, sansFacteur }, pools,
                    complement = '') {
  const pool = pools?.[cle];
  if (!pool) {
    return `<div class="pool"><h3>${echapper(nom)}</h3>
      <p class="absence">Non relevé.</p></div>`;
  }
  const part = fillRatio(pool);
  // §27.5 : « 8,0 CPU » sur quatre cœurs promettrait du matériel qui n'existe pas.
  const facteur = surengageable && pool.overcommit && pool.overcommit !== 1
    ? ` <span class="badge badge--accent">surengagé ×${echapper(pool.overcommit)}</span>`
    : '';
  const note = [
    !surengageable && sansFacteur ? echapper(sansFacteur) : '',
    complement,
  ].filter(Boolean).map((texte) => `<p class="note">${texte}</p>`).join('');

  return `<div class="pool">
  <h3>${echapper(nom)}${facteur}</h3>
  <div class="jauge">
    <div class="jauge__piste">
      <div class="jauge__part jauge__part--reserve" style="width:${part.toFixed(1)}%"></div>
    </div>
  </div>
  <dl class="definitions definitions--serrees">
    <div class="def"><dt>Capacité</dt><dd class="technique">${echapper(format(pool.capacity))}</dd></div>
    <div class="def"><dt>Alloué</dt><dd class="technique">${echapper(format(pool.allocated))}</dd></div>
    <div class="def"><dt>Disponible</dt><dd class="technique">${echapper(format(pool.available))}</dd></div>
  </dl>
  ${note}
</div>`;
}

/**
 * La soustraction qui donne la mémoire allouable, terme à terme (§27.3, §16.1).
 *
 * Sans elle, lire « 76,2 Gio » sur une machine de 94 Gio se conclut par « il y a
 * un défaut ». Chaque terme retranché est donc nommé à l'endroit où la question
 * se pose.
 */
export function renderMemoryBreakdown(forge) {
  const total = forge?.memory?.total_bytes;
  const allouable = forge?.pools?.memory?.capacity;
  if (total == null || allouable == null) return '';

  const reserve = forge?.reserves?.memory_bytes ?? 0;
  const arc = forge?.reserves?.arc_bytes;
  const marge = forge?.reserves?.margin_bytes;

  // Les deux termes ne sont renseignés qu'à partir du relevé qui suit la
  // migration 002. Tant qu'ils valent zéro alors que la réserve ne l'est pas,
  // on n'a que la somme — on l'affiche comme telle, sans inventer la répartition.
  const detaille = (arc ?? 0) + (marge ?? 0) === reserve && reserve > 0;

  const lignes = [
    ['Mémoire de la machine', formatBytes(total), ''],
    ...(detaille
      ? [['− plafond de l’ARC ZFS', formatBytes(arc),
          `ZFS peut le prendre à tout instant : une réserve qui l’ignore promet une `
          + `mémoire que le noyau reprendra sous les Sparks. Se règle par zfs_arc_max. `
          + describeArcUsage(forge?.reserves?.arc_used_bytes, arc)],
         ['− marge d’exploitation', formatBytes(marge),
          'Ce que la Forge consomme pour elle-même. Se règle par SPARKD_MEMORY_RESERVE.']]
      : [['− réserve de la Forge', formatBytes(reserve),
          'Le détail de cette réserve sera connu au prochain relevé de topologie.']]),
    ['= mémoire allouable', formatBytes(allouable), ''],
  ];

  return `
<section class="carte bloc" aria-labelledby="titre-memoire">
  <h2 id="titre-memoire">D’où vient la mémoire allouable</h2>
  <dl class="definitions soustraction">
    ${lignes.map(([terme, valeur, aide], i) =>
      `<div class="def${i === lignes.length - 1 ? ' def--total' : ''}">
         <dt>${echapper(terme)}${aide ? `<span class="champ__aide">${echapper(aide)}</span>` : ''}</dt>
         <dd class="technique">${echapper(valeur)}</dd>
       </div>`).join('')}
  </dl>
</section>`;
}

/**
 * Carte des cœurs (§27.4). Un Spark `dedicated` ne consomme pas de réservation :
 * il RETIRE des cœurs du pool commun. Une jauge seule masquerait exactement
 * cela — le pool rétrécirait sans qu'aucune allocation n'augmente.
 */
export function renderCores(cores, nomsParSpark = {}) {
  if (!cores) return '';
  const communs = cores.shared?.cores ?? [];
  const dedies = cores.dedicated ?? [];

  const pastille = (id, dedie) =>
    `<li class="coeur${dedie ? ' coeur--dedie' : ''}">
       <span class="coeur__id technique">cœur ${echapper(id)}</span>
       <span class="coeur__role">${dedie
         ? `dédié à ${echapper(nomsParSpark[dedie] ?? dedie)}`
         : 'pool commun'}</span>
     </li>`;

  const toutes = [
    ...communs.map((id) => ({ id, spark: null })),
    ...dedies.map((d) => ({ id: d.core_id, spark: d.spark_id })),
  ].sort((a, b) => a.id - b.id);

  return `
<section class="carte bloc" aria-labelledby="titre-coeurs">
  <h2 id="titre-coeurs">Carte des cœurs</h2>
  <ul class="coeurs">${toutes.map((c) => pastille(c.id, c.spark)).join('')}</ul>
  <p class="note">Un Spark en mode dédié ne consomme pas de réservation : il
  retire ses cœurs du pool commun, ce qui réduit la capacité de tous les autres.
  La capacité se compte en cœurs physiques — le SMT entrelace l’exécution, il
  n’ajoute pas de capacité.</p>
</section>`;
}

/** Pool d'adresses privées (§27.7) : il s'épuise en silence, et refuse alors
 *  une création pour une raison étrangère au CPU et à la mémoire. */
function renderAddresses(adresses) {
  if (!adresses) return '';
  return `
<section class="carte bloc" aria-labelledby="titre-adresses">
  <h2 id="titre-adresses">Adresses privées</h2>
  <dl class="definitions">
    <div class="def"><dt>Capacité</dt><dd class="technique">${echapper(adresses.capacity)}</dd></div>
    <div class="def"><dt>Attribuées</dt><dd class="technique">${echapper(adresses.used)}</dd></div>
    <div class="def"><dt>Libres</dt><dd class="technique">${echapper(adresses.free)}</dd></div>
    ${adresses.dhcp_dynamic_range
      ? `<div class="def"><dt>Plage DHCP</dt><dd class="technique">${echapper(adresses.dhcp_dynamic_range)}</dd></div>`
      : ''}
  </dl>
</section>`;
}

/** Vue complète. */
export function renderHostView({ status = 'loading', host = null, cores = null,
                                 sparkNames = {}, error = null,
                                 syncing = false } = {}) {
  if (status === 'loading') return renderHostSkeleton();
  if (status === 'not-synced') return renderNotSynced(error, syncing);
  if (status === 'error') return renderHostError(error);
  if (!host) return renderHostError(null);

  const garantie = GARANTIES[host.reservation_guarantee];

  return `
<header class="entete-entite">
  <div class="entete-entite__identite">
    <h1>Ressources de la Forge</h1>
    ${host.hostname ? `<span class="technique">${echapper(host.hostname)}</span>` : ''}
  </div>
  <p class="note">Relevé le
    <span class="technique">${echapper(formatDate(host.topology_synced_at)) || 'jamais'}</span>.
    La capacité n’est pas rafraîchie à chaque requête.
    <button type="button" class="bouton bouton--compact" data-action="relever"
      ${syncing ? 'disabled' : ''}>${syncing ? 'Relevé…' : 'Relever à nouveau'}</button>
  </p>
</header>
<section class="carte bloc" aria-labelledby="titre-pools">
  <h2 id="titre-pools">Pools</h2>
  <div class="pools">${RESSOURCES.map((r) =>
    renderPool(r, host.pools, r.cle === 'storage' ? describeMetadataMargin(host) : '')).join('')}</div>
  ${garantie ? `<p class="avertissement" role="status">${echapper(garantie)}</p>` : ''}
</section>
<div class="detail">
  <div class="detail__principal">
    ${renderMemoryBreakdown(host)}
    ${renderCores(cores, sparkNames)}
  </div>
  <div class="detail__secondaire">
    ${renderAddresses(host.addresses)}
  </div>
</div>`;
}

export function renderHostSkeleton() {
  return `
<div class="carte bloc" aria-busy="true">
  <p class="sr-only" role="status">Relevé de la Forge en cours…</p>
  ${Array.from({ length: 4 }, (_, i) =>
    `<span class="squelette" style="display:block;width:${70 - i * 8}%;margin-bottom:var(--space-3)"></span>`).join('')}
</div>`;
}

/**
 * §27.8 : une topologie jamais relevée n'est pas une panne, c'est une machine
 * qu'on n'a pas encore interrogée. Le remède est offert comme une ACTION.
 */
export function renderNotSynced(error, syncing = false) {
  return `
<div class="carte"><div class="etat-vue">
  <h2>La topologie de cette Forge n’a pas encore été relevée</h2>
  <p>${echapper(error?.message ?? 'Le registre ne connaît pas encore la capacité de la machine.')}</p>
  <p style="margin-top:var(--space-4)">
    <button type="button" class="bouton bouton--primaire" data-action="relever"
      ${syncing ? 'disabled' : ''}>${syncing ? 'Relevé…' : 'Relever la topologie'}</button>
  </p>
</div></div>`;
}

export function renderHostError(error) {
  return `
<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
  <h2>Les ressources de la Forge n’ont pas pu être lues</h2>
  <p>${echapper(error?.message ?? 'Cause inconnue.')}</p>
  <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
</div></div>`;
}
