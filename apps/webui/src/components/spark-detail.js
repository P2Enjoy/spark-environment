/**
 * Écran « détail d'un Spark ».
 *
 * @spec docs/BACKLOG.md#SPK-19, #SPK-21, #SPK-33, #SPK-64 ·
 *       docs/DESIGN_SYSTEM.md §5.4 (degré 3 : la fenêtre d'un objet), §6.27
 *       (fenêtre, sections, facettes en onglets) · docs/DAT.md §34.1 ·
 *       docs/DAT.md §24 (le runtime publie ce qui est possible), §24.2,
 *       §43.6 révisé (la sélection du catalogue Forge par Spark)
 *       (confirmations), §24.3 (l'identité d'abord), §26 (les trois panneaux
 *       d'administration, portés par `spark-admin.js`) ·
 *       docs/DESIGN_SYSTEM.md §6.3, §6.4, §6.6, §6.22, §6.23, §14.9 ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * Les commandes affichées viennent de `allowed_commands`, publié par le runtime.
 * Cet écran ne connaît pas la machine à états et ne doit pas la connaître.
 */

import { stateOf, formatBytes, formatBps, formatCpu, MEASURE, traduireMessage } from './tokens.js';
import { renderRoutesPanel, renderKeysPanel, renderSnapshotsPanel,
         renderPortsPanel, ADMIN_VIDE } from './spark-admin.js';
import { renderTerminal, TERMINAL_VIDE } from './spark-terminal.js';
import { renderDocker, DOCKER_VIDE } from './spark-docker.js';
import { renderOngletsSpark } from './forge-images.js';
import { renderModale } from './modale.js';
import { ENV_VIDE, renderEnvPanel } from './spark-env.js';
import { IDENTITE_VIDE, renderIdentityPanel } from './spark-identity.js';
// §12.5 : la table des modes CPU vit à UN SEUL endroit. En recopier une
// seconde ici ferait diverger deux libellés pour le même mode.
// `MODES` est DÉJÀ pris dans ce fichier par les modes d'amorçage : on nomme donc
// celui-ci pour ce qu'il est. Deux tables homonymes dans un même module finiraient
// par être confondues.
import { MODES as MODES_CPU } from './spark-create.js';
import { formatDate } from './forge-view.js';

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
export function renderCommands(spark, { confirming = null, admin = null,
                                        frappe = '' } = {}) {
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
  // SPK-63 · §6.23 « Frapper le nom » : la suppression réunit les trois
  // conditions — irréversible, objet confondable avec les autres Sparks, nom
  // court et visible. La comparaison est EXACTE : deux Sparks dont les noms ne
  // diffèrent que par la casse existent, et les confondre rendrait la frappe
  // inutile là où elle sert.
  const nomFrappe = spark?.name ?? '';
  const correspond = frappe === nomFrappe;
  const confirmation = confirming === 'delete'
    ? `<div class="confirmation" role="group" aria-label="Confirmer la suppression">
         <p><strong>Supprimer « ${echapper(nomFrappe)} » ?</strong></p>
         <p class="confirmation__consequence">La cellule, son disque et ses instantanés
         sont détruits. Les données sauvegardées ailleurs ne sont pas concernées.</p>
         <div class="champ">
           <label for="suppression-nom">Frappez <strong>${echapper(nomFrappe)}</strong>
             pour confirmer</label>
           <input class="controle" id="suppression-nom" type="text"
                  autocomplete="off" spellcheck="false"
                  data-frappe="delete" value="${echapper(frappe)}">
           <p class="champ__aide" id="suppression-aide" role="status">${correspond
             ? 'Le nom correspond.'
             : 'Le nom n’est pas encore celui du Spark : la suppression n’est pas engageable.'}</p>
         </div>
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif"
                   data-confirme="delete" aria-describedby="suppression-aide"
                   ${correspond ? '' : 'disabled'}>Supprimer définitivement</button>
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
  <p class="note">Un garde-fou, pas un contrôle d’accès.
  <a href="#/manuel/M8">Manuel M8 — Protéger un Spark</a></p>
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
  <p class="note">Seul le plafond réseau est appliqué par le noyau.
  <a href="#/manuel/M5">Manuel M5 — Ce que « 0,5 CPU » veut dire</a></p>
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre="quotas"
      ${spark.protected ? 'disabled' : ''}>Modifier les quotas</button>
    ${spark.protected
      // §9.9 : l'action EXISTE, elle est indisponible dans un état connu, et la
      // raison reste lisible. La faire disparaître ferait croire que le produit
      // ne sait pas redimensionner.
      ? '<span class="champ__aide">Ce Spark est protégé : levez la protection d’abord.</span>'
      : ''}
  </p>
</section>`;
}

/**
 * Modifier les quotas d'un Spark, sans le détruire (SPK-57).
 *
 * @spec docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.2 (ce que le geste modifie),
 *       §49.3 (rétrécir n'est pas agrandir), §49.4 (l'écran dit le redémarrage
 *       AVANT d'agir), §49.5 (ce que le geste refuse) ·
 *       docs/DESIGN_SYSTEM.md §6.27 (une commande de section ouvre une modale
 *       dont le sujet est CETTE section), §6.9 (structure d'un champ), §14.6
 *
 * **Le point du §49.4** : tant que la prise à chaud d'un champ n'est pas
 * MESURÉE sur une Forge réelle, l'écran annonce un redémarrage. Promettre moins
 * que ce qu'on fait est une erreur sans conséquence ; l'inverse coupe un service
 * en production.
 */
export function renderQuotas(spark, ui = QUOTAS_VIDE) {
  const v = ui.values;
  const champ = (id, libelle, valeur, aide, unite, pas = '1') => `
    <div class="champ">
      <label for="quota-${id}">${echapper(libelle)}</label>
      <input class="controle" id="quota-${id}" name="${id}" type="number"
             min="0" step="${echapper(pas)}" value="${echapper(valeur)}">
      <p class="champ__aide">${echapper(unite)}${aide ? ` · ${aide}` : ''}</p>
    </div>`;

  // §49.2 : le mode CPU se redimensionne. Le §49.4 imposait d'annoncer un
  // redémarrage tant que la prise à chaud n'était pas MESURÉE — elle l'a été le
  // 2026-08-21 sur la Forge de validation : le noyau porte le nouveau `cpu.max`
  // et la cellule voit le nouveau disque, sans redémarrer. L'annonce tombe donc,
  // et l'écran cesse de promettre moins que ce que le produit tient.
  //
  // Les champs qui suivent DÉPENDENT du mode : un mode partagé se règle par une
  // réservation, un mode plafonné par un plafond, un mode dédié par un nombre de
  // cœurs. Afficher les trois ensemble ferait saisir des valeurs que le produit
  // ignorera (§1.4).
  const mode = v.cpu_mode || spark.cpu_mode;
  const options = Object.entries(MODES_CPU).map(([cle, libelle]) =>
    `<option value="${echapper(cle)}"${cle === mode ? ' selected' : ''}>${
      echapper(libelle)}</option>`).join('');

  const champsCpu = ['shared', 'shared-pinned'].includes(mode)
      ? champ('cpu_reservation', 'Réservation CPU', v.cpu_reservation,
              'droit d’ordonnancement sous contention, pas un plafond', 'en CPU', '0.1')
    : mode === 'capped'
      ? champ('cpu_max', 'Plafond CPU', v.cpu_max,
              'jamais dépassé, pas de burst', 'en CPU', '0.1')
    : champ('cpu_cores', 'Cœurs dédiés', v.cpu_cores,
            'cœurs physiques entiers, frères SMT compris', 'en cœurs', '1');

  return renderModale({
    ouverte: ui.open, id: 'quotas', titre: 'Ressources',
    engagement: 'Appliquer les quotas',
    refus: ui.refusal, occupee: ui.busy,
    corps: `
      <div class="champ">
        <label for="quota-cpu_mode">Mode CPU</label>
        <select class="controle" id="quota-cpu_mode" name="cpu_mode">${options}</select>
        <p class="champ__aide">pris en compte immédiatement</p>
      </div>
      ${champsCpu}
      ${champ('memory', 'Mémoire', v.memory_gib, '', 'en Gio')}
      ${champ('storage', 'Disque', v.storage_gib,
              'pris en compte immédiatement', 'en Gio')}
      ${champ('network', 'Plafond réseau', v.network_mbps, '', 'en Mbit/s')}
      <p class="note">Ce que vous retirez doit être libre : réduire la mémoire
      sous ce que la cellule emploie, ou le disque sous ce qu’il contient, sera
      refusé. <a href="#/manuel/M8">Manuel M8 — Exploiter au quotidien</a></p>`,
  });
}

/** Valeurs de la modale des quotas. Vide tant qu'on ne l'a pas ouverte. */
export const QUOTAS_VIDE = {
  open: false, busy: false, refusal: null,
  values: { memory_gib: '', storage_gib: '', network_mbps: '',
            cpu_mode: '', cpu_reservation: '', cpu_max: '', cpu_cores: '' },
};

function renderAcces(spark) {
  return `
<section class="carte bloc" aria-labelledby="titre-acces">
  <h2 id="titre-acces">Accès</h2>
  ${definitions([['Adresse privée', spark.ipv4_address, true], ['Image', spark.image, true]])}
</section>`;
}

/**
 * L'amorçage d'un Spark (SPK-54, docs/DAT.md §41, §42).
 *
 * @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §42.1 (détecter d'abord),
 *       §42.3 (par où il passe), §42.7 (le contrat) ·
 *       docs/DESIGN_SYSTEM.md §6.13 (les états d'une vue), §6.22
 *       (confirmation dans le flux), §6.23 (une action sensible se confirme),
 *       §14.6 (« pas encore relevé » n'est pas « rien à faire »)
 *
 * `null` tant qu'on n'a pas demandé. C'est délibéré et cela vaut d'être dit : le
 * relevé EXÉCUTE une commande dans la cellule du locataire. Le lancer à chaque
 * ouverture de l'écran ferait entrer la console chez lui à chaque coup d'œil,
 * pour une information qui ne change qu'après un geste.
 */
export const AMORCAGE_VIDE = {
  releve: null,       // null | 'en-cours' | { items, complete }
  resultat: null,     // le compte rendu ligne à ligne du dernier amorçage
  confirme: false,    // §6.23 : la confirmation qui nomme le pouvoir employé
  // §42.2 : le rootless est OFFERT, jamais imposé. Le défaut est enraciné, et
  // annoncer l'inverse ferait échouer la promesse centrale du produit — reprendre
  // une pile Compose existante sans la réécrire — sur la moitié des piles.
  rootless: false,
  busy: false,
  erreur: null,
};

/** Les deux modes, dits en français (§14.7). */
const MODES = { enracine: 'enraciné', rootless: 'rootless' };

/** Les trois états d'un élément, dits en français (§14.7). */
const ETATS_AMORCAGE = {
  present: { libelle: 'en place', token: 'success' },
  absent: { libelle: 'absent', token: 'neutral' },
  defect: { libelle: 'à corriger', token: 'danger' },
};

const SORTS_AMORCAGE = {
  'inchangé': { libelle: 'inchangé', token: 'neutral' },
  'installé': { libelle: 'installé', token: 'success' },
  'échoué': { libelle: 'échoué', token: 'danger' },
};

function ligneAmorcage(ligne) {
  const etat = ETATS_AMORCAGE[ligne.state] ?? ETATS_AMORCAGE.absent;
  const sort = ligne.outcome ? SORTS_AMORCAGE[ligne.outcome] : null;
  // Le runtime rend « absent » comme détail d'un élément absent. La pastille le
  // dit déjà : le répéter écrit deux fois la même chose sur une ligne, et §14.5
  // veut qu'une absence soit nommée UNE fois.
  const detail = (ligne.detail ?? '').trim();
  const utile = detail && detail !== etat.libelle && detail !== ligne.state;
  // §42.2 bis : le mode est une OBSERVATION. Il ne s'affiche que lorsqu'il y en
  // a un — un Docker absent, ou de distribution, n'en a pas, et lui en prêter un
  // ferait croire à un choix là où rien ne tourne.
  const mode = ligne.mode ? MODES[ligne.mode] ?? ligne.mode : null;
  return `<li class="ligne-amorcage">
    <span class="badge badge--${etat.token}">${echapper(etat.libelle)}</span>
    <strong>${echapper(ligne.label ?? ligne.key)}</strong>
    ${sort ? `<span class="badge badge--${sort.token}">${echapper(sort.libelle)}</span>` : ''}
    ${mode ? `<span class="badge badge--neutral">${echapper(mode)}</span>` : ''}
    ${utile ? `<span class="note">${echapper(detail)}</span>` : ''}
  </li>`;
}

export function renderAmorcage(spark, etat = AMORCAGE_VIDE) {
  // §37.2 : sans cellule, il n'y a rien où exécuter. L'écran le NOMME plutôt
  // que d'offrir un geste qui sera refusé.
  if (!spark.incus_name) {
    return `
<section class="carte bloc" aria-labelledby="titre-amorcage">
  <h2 id="titre-amorcage">Amorçage</h2>
  <p class="absence">Ce Spark n’a pas encore de cellule. Il doit être créé avant
  qu’on puisse l’amorcer.</p>
</section>`;
  }

  const releve = etat.releve;
  const lignes = etat.resultat?.items ?? (releve && releve !== 'en-cours' ? releve.items : null);

  // §6.13 et §14.6 : « pas encore relevé » n'est NI « rien à faire », NI « tout
  // va bien ». L'écran ne prétend pas savoir ce qu'il n'a pas mesuré.
  const corps = etat.erreur
    ? `<div class="refus" role="alert"><p>${echapper(etat.erreur)}</p></div>`
    : releve === 'en-cours'
      ? '<p class="note" role="status" aria-busy="true">Relevé de la cellule en cours…</p>'
      : !lignes
        ? `<p class="absence">L’état de cette cellule n’a pas encore été relevé.
           Le relevé exécute une commande <strong>dans</strong> le Spark : il est
           demandé, jamais lancé de lui-même.</p>`
        : `<ul class="liste-amorcage">${lignes.map(ligneAmorcage).join('')}</ul>`;

  const complet = etat.resultat?.complete ?? (releve && releve !== 'en-cours'
    ? releve.complete : null);
  const verdict = lignes && complet
    ? `<p class="note" role="status">Cette cellule est complète : elle est joignable
       en SSH et capable de faire tourner une pile Compose.</p>`
    : '';

  // §42.1 : un second amorçage ne fait rien, et l'écran le DIT.
  const rien = etat.resultat && etat.resultat.changed === false
    ? `<p class="note" role="status">Rien n’a été fait : tout était déjà en place.</p>`
    : '';

  // §6.23 et §42.3 : l'amorçage passe par le plan de contrôle, en root dans la
  // cellule. La confirmation le NOMME, et elle est rendue dans le flux (§6.22).
  // §42.2 bis : le mode ne se BASCULE pas. Quand le relevé en montre un en
  // place, le choix n'est plus ouvert — l'offrir serait offrir un geste que le
  // serveur refusera à coup sûr (§1.4). La différence avec le §14.9 tient à ce
  // que l'écran ne le SUPPOSE pas : il le tient d'une mesure que le serveur
  // vient de rendre.
  const modeEnPlace = lignes?.find((l) => l.key === 'docker')?.mode ?? null;
  const option = modeEnPlace
    ? `<p class="note">Ce Spark fait déjà tourner un Docker
       <strong>${echapper(MODES[modeEnPlace] ?? modeEnPlace)}</strong>. Le mode ne
       se change pas par un amorçage : basculer déplacerait le moteur sous un autre
       compte, et avec lui les conteneurs, les volumes et les réseaux qui y
       tournent.</p>`
    : `<p class="champ">
         <label for="amorcage-rootless">
           <input type="checkbox" id="amorcage-rootless" data-amorcage="rootless"
                  ${etat.rootless ? 'checked' : ''}>
           Installer Docker en mode <strong>rootless</strong>
         </label>
       </p>
       <p class="champ__aide">Le moteur tourne alors sous un compte non
       privilégié <em>dans</em> la cellule. <strong>Ce choix ne se reprend
       pas.</strong> Trois choses changent :</p>
       <ul class="champ__aide">
         <li>les ports sous 1024 deviennent impossibles à publier dans la cellule ;</li>
         <li>certaines piles Compose existantes ne fonctionnent pas telles quelles ;</li>
         <li>la cellule est <strong>déjà</strong> non privilégiée sur la Forge.</li>
       </ul>
       <p class="champ__aide">
         <a href="#/manuel/M6">Manuel M6 — Le mode rootless</a></p>`;

  const confirmation = etat.confirme
    ? `<div class="confirmation" role="group" aria-labelledby="titre-confirme-amorcage">
         <p id="titre-confirme-amorcage"><strong>Amorcer « ${echapper(spark.name)} » ?</strong></p>
         <p>Le plan de contrôle va <strong>exécuter des commandes en root dans la
         cellule</strong>, sans passer par SSH — c’est justement ce qui n’existe
         pas encore sur un Spark neuf.</p>
         <p class="note">Seuls les éléments manquants sont installés ; ce qui est
         déjà en place n’est pas touché.</p>
         ${option}
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif" data-amorcage="engager">
             Exécuter en root dans la cellule
           </button>
           <button type="button" class="bouton" data-amorcage="annuler">Annuler</button>
         </p>
       </div>`
    : '';

  return `
<section class="carte bloc" aria-labelledby="titre-amorcage">
  <h2 id="titre-amorcage">Amorçage</h2>
  <p class="note">L’amorçage relève ce qui manque dans la cellule et ne pose que
  cela. <a href="#/manuel/M6">Manuel M6 — Amorcer le Spark, une fois</a></p>
  ${corps}
  ${verdict}${rien}
  ${confirmation}
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-amorcage="relever"
            ${etat.busy ? 'disabled' : ''}>
      ${lignes ? 'Relever à nouveau' : 'Relever l’état'}
    </button>
    ${etat.confirme ? '' : `<button type="button" class="bouton bouton--primaire"
            data-amorcage="amorcer" ${etat.busy ? 'disabled' : ''}>
      Amorcer ce Spark
    </button>`}
  </p>
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
      <span class="evenement__texte">${echapper(traduireMessage(e.message) || e.action)}</span>
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
                                    terminal = TERMINAL_VIDE,
                                    docker = DOCKER_VIDE,
                                    amorcage = AMORCAGE_VIDE,
                                    error = null, confirming = null,
                                    admin = ADMIN_VIDE, facette = '',
                                    quotas = QUOTAS_VIDE,
                                    env = [], envUi = ENV_VIDE,
                                    identite = IDENTITE_VIDE,
                                    catalogue = [] } = {}) {
  if (status === 'loading') return renderDetailSkeleton();
  if (status === 'error') return renderDetailError(error);
  if (!spark) return renderDetailNotFound();

  const { token, label, transient } = stateOf(spark.state);
  const classeBadge = `badge badge--${token}${transient ? ' badge--transitoire' : ''}`;

  const facettes = {
    '': () => `<div class="detail">
      <div class="detail__principal">${renderRessources(spark, usage)}${renderQuotas(spark, quotas)}
        ${renderProtection(spark, admin)}</div>
      <div class="detail__secondaire">${renderAcces(spark)}
        ${renderAmorcage(spark, amorcage)}</div>
    </div>`,
    // §39.3 : le nom D'ABORD, le port publié comme un second geste qui annonce
    // ce qu'il coûte. Les deux vivent donc sur la même facette, dans cet ordre.
    routes: () => renderRoutesPanel(spark, routes, admin)
                  + renderPortsPanel(spark, ports, admin, reservedPorts),
    cles: () => renderKeysPanel(spark, { keys, registry, sshConfig }, admin)
               + renderIdentityPanel(spark, identite),
    instantanes: () => renderSnapshotsPanel(spark, snapshots, admin),
    environnement: () => renderEnvPanel(spark, env, envUi, renderModale, catalogue),
    terminal: () => renderTerminal(spark, terminal),
    docker: () => renderDocker(spark, docker),
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
  <p>${echapper(traduireMessage(error?.message) || 'Cause inconnue.')}</p>
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
