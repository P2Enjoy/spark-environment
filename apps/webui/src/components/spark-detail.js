/**
 * Écran « détail d'un Spark ».
 *
 * @spec docs/BACKLOG.md#SPK-19, #SPK-21, #SPK-33 ·
 *       docs/DESIGN_SYSTEM.md §5.4 (degré 3 : la fenêtre d'un objet), §6.27
 *       (fenêtre, sections, facettes en onglets) · docs/DAT.md §34.1 ·
 *       docs/DAT.md §24 (le runtime publie ce qui est possible), §24.2
 *       (confirmations), §24.3 (l'identité d'abord), §26 (les trois panneaux
 *       d'administration, portés par `spark-admin.js`) ·
 *       docs/DESIGN_SYSTEM.md §6.3, §6.4, §6.6, §6.22, §6.23, §14.9 ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * Les commandes affichées viennent de `allowed_commands`, publié par le runtime.
 * Cet écran ne connaît pas la machine à états et ne doit pas la connaître.
 */

import { stateOf, formatBytes, formatBps, formatCpu, MEASURE } from './tokens.js';
import { renderRoutesPanel, renderKeysPanel, renderSnapshotsPanel,
         renderPortsPanel, ADMIN_VIDE } from './spark-admin.js';
import { renderOngletsSpark } from './host-images.js';
import { renderModale } from './modale.js';
import { formatDate } from './host-view.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Libellés des commandes. Seule la suppression est destructive (§24.2).
 *
 * `rang` fixe l'ordre d'affichage. Le runtime publie `allowed_commands` trié
 * alphabétiquement — un ordre qui plaçait « Supprimer » en tête, donc l'action
 * la plus dangereuse en premier et la première atteinte au clavier. L'ordre
 * d'affichage suit l'intention, pas l'alphabet.
 */
export const COMMANDES = {
  apply:   { label: 'Appliquer',  variante: 'primaire',   confirme: false, rang: 1 },
  start:   { label: 'Démarrer',   variante: 'primaire',   confirme: false, rang: 1 },
  retry:   { label: 'Reprendre',  variante: 'primaire',   confirme: false, rang: 1 },
  restart: { label: 'Redémarrer', variante: 'secondaire', confirme: false, rang: 2 },
  stop:    { label: 'Arrêter',    variante: 'secondaire', confirme: false, rang: 3 },
  delete:  { label: 'Supprimer',  variante: 'secondaire', confirme: true,  rang: 9 },
};

/** Résultats d'audit, en français. Une valeur technique brute ne doit pas
 *  atteindre l'écran (docs/DESIGN_SYSTEM.md §14.7). */
export const RESULTATS = {
  ok: { label: 'réussi', token: 'success' },
  denied: { label: 'refusé', token: 'accent' },
  error: { label: 'erreur', token: 'danger' },
};

/**
 * Barre de commandes.
 *
 * Une commande absente d'`allowed_commands` n'est **pas** rendue désactivée :
 * elle n'est pas rendue du tout (§24.1). Un état transitoire le dit en toutes
 * lettres plutôt que d'exposer quatre boutons morts.
 */
export function renderCommands(spark, { confirming = null, admin = null } = {}) {
  const permises = spark?.allowed_commands ?? [];

  // §6.23 : « lorsqu'un objet est protégé, la protection se LÈVE D'ABORD, par un
  // geste distinct et explicite ». Le runtime ne publie alors aucune commande
  // (§24.1) ; sans ce cas, l'écran dirait « aucune commande dans cet état », ce
  // qui désignerait la mauvaise cause.
  if (spark?.protected) {
    return `<p class="note-transitoire" role="status">Ce Spark est <strong>protégé</strong> :
      aucune écriture ne l’atteint tant que la protection est armée. La lever est un
      geste distinct, en bas de cette fenêtre.</p>`;
  }

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
    .sort((a, b) => COMMANDES[a].rang - COMMANDES[b].rang)
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

/**
 * La section « Protection » et son geste (SPK-34).
 *
 * @spec docs/BACKLOG.md#SPK-34 · docs/DAT.md §35.1 (garde-fou, pas contrôle
 *       d'accès), §35.3 (le mot de passe), §35.4 (lever est un état) ·
 *       docs/DESIGN_SYSTEM.md §6.23, §6.27 (la saisie passe par une modale)
 *
 * La section dit toujours son état — armé COMME désarmé. Un Spark désarmé qui ne
 * dirait rien laisserait l'oubli de réarmement invisible, ce que le §35.4
 * interdit explicitement.
 *
 * Elle dit aussi ce que la protection VAUT. Le §35.1 est catégorique : le
 * produit ne la présentera jamais comme une frontière de sécurité, et l'écran
 * est le premier endroit où l'on serait tenté de le laisser croire.
 */
export function renderProtection(spark, admin = null) {
  const arme = Boolean(spark?.protected);
  const ui = admin ?? {};
  const modale = renderModale({
    ouverte: ui.open === 'protection', id: 'protection', titre: 'Protection',
    engagement: arme ? 'Lever la protection' : 'Armer la protection',
    refus: ui.refusal?.panel === 'protection' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
       <div class="champ">
         <label for="protection-mot">Mot de passe</label>
         <input class="controle" id="protection-mot" name="password" type="password"
                autocomplete="off" value="${echapper(ui.values?.password ?? '')}">
         <p class="champ__aide">${arme
           ? 'Le mot de passe posé à l’armement. Il n’y a aucune récupération : '
             + 'un mot de passe perdu se lève sur le serveur.'
           : 'Réarmer accepte un autre mot de passe que le précédent : le produit '
             + 'ne retient pas l’ancien.'}</p>
       </div>`,
  });

  return `
<section class="carte bloc" aria-labelledby="titre-protection">
  <h2 id="titre-protection">Protection</h2>
  <p>${arme
    ? `<strong>Armée</strong> depuis <span class="technique">${
        echapper(formatDate(spark.protected_at))}</span>. Toute écriture visant ce
       Spark est refusée par le serveur — commandes, routes, octroi de clé,
       instantanés.`
    : '<strong>Désarmée.</strong> Ce Spark accepte toutes les écritures.'}</p>
  <p class="note">Elle arrête le geste accidentel : le mauvais Spark sélectionné,
  la ligne cliquée trop vite, le script lancé sur le mauvais nom. Ce n’est pas un
  contrôle d’accès — qui atteint le serveur atteint le registre.
  <strong>Retirer un accès n’est jamais bloqué</strong> : révoquer une clé reste
  possible sur un Spark protégé, après une confirmation qui le nomme.</p>
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre="protection">${
      arme ? 'Lever la protection' : 'Armer la protection'}</button>
  </p>
  ${modale}
</section>`;
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
      spark.state === 'stopped' ? MEASURE.stopped
      : spark.state === 'error' ? MEASURE.unavailable
      : spark.state === 'pending' ? MEASURE.declared
      : MEASURE.pending)],
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

function renderAcces(spark) {
  return `
<section class="carte bloc" aria-labelledby="titre-acces">
  <h2 id="titre-acces">Accès</h2>
  ${definitions([['Adresse privée', spark.ipv4_address, true], ['Image', spark.image, true]])}
</section>`;
}

/**
 * Qui a produit une entrée du journal (SPK-37, docs/DAT.md §21.6, §36.4).
 *
 * Les deux classes ne se confondent pas : les afficher pareillement laisserait
 * croire que l'événement du runtime a été demandé par quelqu'un — il ne l'est
 * par personne, et ne le sera jamais.
 *
 * L'identité affichée est DÉCLARATIVE. La console ne la présente donc pas comme
 * une preuve : le libellé dit « déclaré par », jamais « signé par ».
 */
export function renderAuteur(entree) {
  if (entree?.actor_class === 'runtime') {
    return `<span class="evenement__auteur" title="Événement produit par le`
      + ` serveur lui-même. Personne ne l’a demandé, et rien ne le signe.">`
      + `automatique</span>`;
  }
  const qui = entree?.actor && entree.actor !== 'inconnu' ? entree.actor : null;
  return `<span class="evenement__auteur" title="Identité déclarée par la`
    + ` console à l’appel. Elle attribue, elle ne prouve pas.">${
      qui ? `déclaré par ${echapper(qui)}` : 'auteur non déclaré'}</span>`;
}

function renderJournal(entries = []) {
  if (entries.length === 0) return '';
  const lignes = entries.slice(0, 8).map((e) => {
    const { label, token } = RESULTATS[e.result] ?? { label: e.result ?? 'inconnu', token: 'neutral' };
    return `<li class="evenement">
      <span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${echapper(label)}</span>
      <span class="evenement__texte">${echapper(e.message ?? e.action)}</span>
      ${renderAuteur(e)}
      <span class="technique evenement__date">${echapper((e.ts ?? '').slice(0, 16).replace('T', ' '))}</span>
    </li>`;
  }).join('');
  return `
<section class="carte bloc" aria-labelledby="titre-journal">
  <h2 id="titre-journal">Journal</h2>
  <ul class="liste-evenements">${lignes}</ul>
</section>`;
}

/**
 * Fenêtre d'un Spark (DESIGN_SYSTEM.md §5.4 degré 3, §6.27).
 *
 * Elle était une page unique empilant cinq sujets. Le §6.27 les répartit en
 * **facettes** : ce qui se lit ensemble d'un côté — l'identité et les mesures —,
 * les éléments liés de l'autre. Chaque facette est une véritable destination :
 * on doit pouvoir recharger la page sur « Instantanés ».
 *
 * L'en-tête d'identité et les commandes de cycle de vie restent au-dessus des
 * onglets : ils appartiennent au Spark, pas à une de ses facettes (§34.2).
 */
export function renderSparkDetail({ status, spark = null, usage = null, routes = [],
                                    keys = [], registry = [], sshConfig = null,
                                    snapshots = [], audit = [],
                                    ports = [], reservedPorts = [],
                                    error = null, confirming = null,
                                    admin = ADMIN_VIDE, facette = '' } = {}) {
  if (status === 'loading') return renderDetailSkeleton();
  if (status === 'error') return renderDetailError(error);
  if (!spark) return renderDetailNotFound();

  const { token, label, transient } = stateOf(spark.state);
  const classeBadge = `badge badge--${token}${transient ? ' badge--transitoire' : ''}`;

  const facettes = {
    '': () => `<div class="detail">
      <div class="detail__principal">${renderRessources(spark, usage)}
        ${renderProtection(spark, admin)}</div>
      <div class="detail__secondaire">${renderAcces(spark)}</div>
    </div>`,
    // §39.3 : le nom D'ABORD, le port publié comme un second geste qui annonce
    // ce qu'il coûte. Les deux vivent donc sur la même facette, dans cet ordre.
    routes: () => renderRoutesPanel(spark, routes, admin)
                  + renderPortsPanel(spark, ports, admin, reservedPorts),
    cles: () => renderKeysPanel(spark, { keys, registry, sshConfig }, admin),
    instantanes: () => renderSnapshotsPanel(spark, snapshots, admin),
    journal: () => renderJournal(audit) ||
      '<div class="carte bloc"><p class="absence">Aucune opération enregistrée.</p></div>',
  };

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
${renderOngletsSpark(spark.name, facette)}
${(facettes[facette] ?? facettes[''])()}`;
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
