/**
 * Écran « détail d'un Spark ».
 *
 * @spec docs/BACKLOG.md#SPK-19 · docs/DAT.md §24 (le runtime publie ce qui est
 *       possible), §24.2 (confirmations), §24.3 (l'identité d'abord) ·
 *       docs/DESIGN_SYSTEM.md §6.3, §6.4, §6.6, §6.22, §6.23, §14.9 ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * Les commandes affichées viennent de `allowed_commands`, publié par le runtime.
 * Cet écran ne connaît pas la machine à états et ne doit pas la connaître.
 */

import { stateOf, formatBytes, formatBps, formatCpu, MEASURE } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Libellés des commandes. Seule la suppression est destructive (§24.2). */
export const COMMANDES = {
  apply:   { label: 'Appliquer',  variante: 'primaire',   confirme: false },
  start:   { label: 'Démarrer',   variante: 'primaire',   confirme: false },
  stop:    { label: 'Arrêter',    variante: 'secondaire', confirme: false },
  restart: { label: 'Redémarrer', variante: 'secondaire', confirme: false },
  retry:   { label: 'Reprendre',  variante: 'primaire',   confirme: false },
  delete:  { label: 'Supprimer',  variante: 'secondaire', confirme: true },
};

/**
 * Barre de commandes.
 *
 * Une commande absente d'`allowed_commands` n'est **pas** rendue désactivée :
 * elle n'est pas rendue du tout (§24.1). Un état transitoire le dit en toutes
 * lettres plutôt que d'exposer quatre boutons morts.
 */
export function renderCommands(spark, { confirming = null } = {}) {
  const permises = spark?.allowed_commands ?? [];

  if (spark?.transient) {
    return `<p class="note-transitoire" role="status">Une opération est en cours ` +
      `(${echapper(stateOf(spark.state).label)}). Aucune commande n’est acceptée ` +
      `tant qu’elle n’a pas abouti.</p>`;
  }
  if (permises.length === 0) {
    return `<p class="note-transitoire">Aucune commande disponible dans cet état.</p>`;
  }

  const boutons = permises
    .filter((c) => COMMANDES[c])
    .map((c) => {
      const { label, variante } = COMMANDES[c];
      const classe = variante === 'primaire' ? 'bouton bouton--primaire' : 'bouton';
      return `<button type="button" class="${classe}" data-commande="${c}">${echapper(label)}</button>`;
    })
    .join('');

  // §6.22 : la confirmation est intégrée au flux, sous le déclencheur — pas de
  // voile, pas de piège de focus, pas d'Échap global à écrire.
  const confirmation = confirming === 'delete'
    ? `<div class="confirmation" role="group" aria-label="Confirmer la suppression">
         <p><strong>Supprimer « ${echapper(spark.name)} » ?</strong></p>
         <p class="confirmation__consequence">La cellule, son disque et ses instantanés
         sont détruits. Les données sauvegardées ailleurs ne sont pas concernées.</p>
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif" data-confirme="delete">Supprimer définitivement</button>
           <button type="button" class="bouton" data-annule="delete">Annuler</button>
         </p>
       </div>`
    : '';

  return `<div class="commandes">${boutons}</div>${confirmation}`;
}

/** Paires terme/valeur. Une valeur absente n'est PAS rendue (§6.4). */
function definitions(paires) {
  const lignes = paires
    .filter(([, valeur]) => valeur !== null && valeur !== undefined && valeur !== '')
    .map(([terme, valeur, technique]) =>
      `<div class="def"><dt>${echapper(terme)}</dt>` +
      `<dd${technique ? ' class="technique"' : ''}>${echapper(valeur)}</dd></div>`)
    .join('');
  return lignes ? `<dl class="definitions">${lignes}</dl>` : '';
}

function renderRessources(spark, usage) {
  const cpu = spark.cpu_mode === 'capped'
    ? `${formatCpu(spark.cpu_max)} CPU au plus`
    : spark.cpu_mode === 'dedicated'
      ? `${spark.cpu_cores} cœur${spark.cpu_cores > 1 ? 's' : ''} dédié${spark.cpu_cores > 1 ? 's' : ''}`
      : `${formatCpu(spark.cpu_reservation)} CPU réservés`;

  const mesure = (valeur, absent) =>
    valeur === null || valeur === undefined ? absent : valeur;

  return `
<section class="carte bloc" aria-labelledby="titre-ressources">
  <h2 id="titre-ressources">Ressources</h2>
  ${definitions([
    ['Processeur', cpu],
    ['Consommation CPU', mesure(
      usage?.cpu?.used === null || usage?.cpu?.used === undefined ? null : `${formatCpu(usage.cpu.used)} CPU`,
      spark.state === 'stopped' ? MEASURE.stopped : spark.state === 'error' ? MEASURE.unavailable : MEASURE.pending)],
    ['Mémoire', `${formatBytes(spark.memory_reservation_bytes)}${
      usage?.memory?.used_bytes != null ? ` — ${formatBytes(usage.memory.used_bytes)} utilisés` : ''}`, true],
    ['Disque', `${formatBytes(spark.storage_bytes)}${
      usage?.disk?.used_bytes != null ? ` — ${formatBytes(usage.disk.used_bytes)} utilisés` : ''}`, true],
    ['Plafond réseau', formatBps(spark.network_burst_bps), true],
  ])}
  <p class="note">La réservation CPU est un droit d’ordonnancement sous contention,
  pas un plafond : consommer davantage quand la machine est libre est normal.
  Seul le plafond réseau est appliqué par le noyau.</p>
</section>`;
}

function renderAcces(spark, { routes = [], keys = [] } = {}) {
  // §6.4 et §24.3 : une absence qui informe est NOMMÉE. Un Spark sans clé n'est
  // pas un Spark dont on ignore les clés.
  const listeRoutes = routes.length
    ? `<ul class="liste-simple">${routes.map((r) =>
        `<li><span class="technique">${echapper(r.domain)}</span> → port ${echapper(r.target_port)}` +
        `${r.applied_at ? '' : ' <span class="badge badge--accent">non appliquée</span>'}</li>`).join('')}</ul>`
    : '<p class="absence">Aucune route publique ne pointe vers ce Spark.</p>';

  const listeCles = keys.length
    ? `<ul class="liste-simple">${keys.map((k) =>
        `<li>${echapper(k.label)} <span class="technique">${echapper(k.fingerprint)}</span></li>`).join('')}</ul>`
    : "<p class=\"absence\">Aucune clé n’est autorisée : personne ne peut s’y connecter.</p>";

  return `
<section class="carte bloc" aria-labelledby="titre-acces">
  <h2 id="titre-acces">Accès</h2>
  ${definitions([['Adresse privée', spark.ipv4_address, true], ['Image', spark.image, true]])}
  <h3>Routes publiques</h3>${listeRoutes}
  <h3>Clés autorisées</h3>${listeCles}
</section>`;
}

function renderInstantanes(snapshots = []) {
  const contenu = snapshots.length
    ? `<ul class="liste-simple">${snapshots.map((s) =>
        `<li><span class="technique">${echapper(s.incus_name)}</span>` +
        `<span class="absence"> — ${echapper((s.created_at ?? '').slice(0, 16).replace('T', ' '))}</span></li>`).join('')}</ul>`
    : '<p class="absence">Aucun instantané.</p>';
  return `
<section class="carte bloc" aria-labelledby="titre-instantanes">
  <h2 id="titre-instantanes">Instantanés</h2>
  ${contenu}
  <p class="note">Un instantané rend l’état complet de la cellule. Il vit dans le
  même pool que le Spark : il ne protège ni de la perte du pool, ni de celle de la
  machine, et consomme le quota disque.</p>
</section>`;
}

function renderJournal(entries = []) {
  if (entries.length === 0) return '';
  const lignes = entries.slice(0, 8).map((e) => {
    const token = e.result === 'ok' ? 'success' : e.result === 'denied' ? 'accent' : 'danger';
    return `<li class="evenement">
      <span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${echapper(e.result)}</span>
      <span class="evenement__texte">${echapper(e.message ?? e.action)}</span>
      <span class="technique evenement__date">${echapper((e.ts ?? '').slice(0, 16).replace('T', ' '))}</span>
    </li>`;
  }).join('');
  return `
<section class="carte bloc" aria-labelledby="titre-journal">
  <h2 id="titre-journal">Journal</h2>
  <ul class="liste-evenements">${lignes}</ul>
</section>`;
}

/** Vue complète. L'identité vient avant tout le reste (§6.3, §24.3). */
export function renderSparkDetail({ status, spark = null, usage = null, routes = [],
                                    keys = [], snapshots = [], audit = [],
                                    error = null, confirming = null } = {}) {
  if (status === 'loading') return renderDetailSkeleton();
  if (status === 'error') return renderDetailError(error);
  if (!spark) return renderDetailNotFound();

  const { token, label, transient } = stateOf(spark.state);
  const classeBadge = `badge badge--${token}${transient ? ' badge--transitoire' : ''}`;

  return `
<p><a class="lien-spark" href="#/sparks">← Tous les Sparks</a></p>
<header class="entete-entite">
  <div class="entete-entite__identite">
    <h1>${echapper(spark.name)}</h1>
    <span class="${classeBadge}"><span class="badge__point" aria-hidden="true"></span>${echapper(label)}</span>
  </div>
  ${spark.last_error ? `<p class="erreur-derniere" role="status">Dernière erreur : ${echapper(spark.last_error)}</p>` : ''}
  ${renderCommands(spark, { confirming })}
</header>
<div class="detail">
  <div class="detail__principal">
    ${renderRessources(spark, usage)}
    ${renderAcces(spark, { routes, keys })}
  </div>
  <div class="detail__secondaire">
    ${renderInstantanes(snapshots)}
    ${renderJournal(audit)}
  </div>
</div>`;
}

export function renderDetailSkeleton() {
  return `
<p><a class="lien-spark" href="#/sparks">← Tous les Sparks</a></p>
<div class="carte bloc" aria-busy="true">
  <p class="sr-only" role="status">Chargement du Spark…</p>
  ${Array.from({ length: 5 }, (_, i) =>
    `<span class="squelette" style="display:block;width:${70 - i * 8}%;margin-bottom:var(--space-3)"></span>`).join('')}
</div>`;
}

export function renderDetailError(error) {
  return `
<p><a class="lien-spark" href="#/sparks">← Tous les Sparks</a></p>
<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
  <h2>Ce Spark n’a pas pu être chargé</h2>
  <p>${echapper(error?.message ?? 'Cause inconnue.')}</p>
  <p style="margin-top:var(--space-4)"><button type="button" class="bouton" data-action="reessayer">Réessayer</button></p>
</div></div>`;
}

export function renderDetailNotFound() {
  return `
<p><a class="lien-spark" href="#/sparks">← Tous les Sparks</a></p>
<div class="carte"><div class="etat-vue">
  <h2>Ce Spark n’existe pas</h2>
  <p>Il a peut-être été supprimé depuis l’ouverture de cette page.</p>
</div></div>`;
}
