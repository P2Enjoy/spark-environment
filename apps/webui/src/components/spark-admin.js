/**
 * Les trois panneaux d'administration d'un Spark : routes publiques, clés
 * autorisées, instantanés.
 *
 * @spec docs/BACKLOG.md#SPK-21 · docs/DAT.md §26 (les trois surfaces),
 *       §26.2 (un formulaire s'ouvre, il n'occupe pas), §26.3 (routes),
 *       §26.4 (clés), §26.5 (instantanés) · §17, §18, §19 ·
 *       docs/DESIGN_SYSTEM.md §3.1, §6.9, §6.19, §6.22, §6.23, §6.24, §14.7 ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * Ce sont des panneaux du détail, pas des écrans (§26.1) : une route publique
 * et un instantané n'existent pas sans leur Spark.
 */

import { formatBytes } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Horodatage lisible. Le registre rend de l'ISO ; l'écran n'en montre que
 *  ce qui se lit (docs/DESIGN_SYSTEM.md §3.1 pour la typographie technique). */
export function formatDate(valeur) {
  return String(valeur ?? '').slice(0, 16).replace('T', ' ');
}

/** État initial des trois panneaux. Les valeurs vivent ici pour qu'un refus du
 *  serveur ne les efface pas (§26.2). */
export const ADMIN_VIDE = {
  open: null,        // 'route' | 'key' | 'snapshot' — un seul à la fois (§26.2)
  confirming: null,  // { kind, id }
  refusal: null,     // { panel, message, blocking? }
  busy: false,
  values: { domain: '', port: 8080, tls: true,
            key_label: '', new_label: '', public_key: '',
            snapshot: '' },
};

/**
 * Bouton qui ouvre un formulaire, ou rien si un autre panneau est déjà ouvert.
 * §26.2 : un seul formulaire à la fois. Deux formulaires ouverts laisseraient
 * croire qu'on prépare deux gestes qui partiraient ensemble.
 */
function declencheur(panneau, libelle, ui) {
  if (ui.open) return '';
  return `<p class="formulaire__actions"><button type="button" class="bouton" ` +
    `data-ouvre="${panneau}">${echapper(libelle)}</button></p>`;
}

/** Bloc de refus du serveur, commun aux trois panneaux (§26.3, §26.4). */
function refus(ui, panneau) {
  if (!ui.refusal || ui.refusal.panel !== panneau) return '';
  return `<div class="refus" role="alert">
    <p><strong>${echapper(ui.refusal.message)}</strong></p>
  </div>`;
}

/* ------------------------------------------------------------------ routes */

/**
 * Routes publiques.
 *
 * L'unicité du domaine n'est PAS contrôlée ici : elle appartient à la base
 * (§18.4, §26.3). Un contrôle local ne protégerait de rien face à deux consoles
 * simultanées et donnerait l'illusion inverse.
 */
export function renderRoutesPanel(spark, routes = [], ui = ADMIN_VIDE) {
  const lignes = routes.length
    ? `<ul class="liste-administrable">${routes.map((r) => {
        const attente = r.applied_at
          ? ''
          : ` <span class="badge badge--accent"><span class="badge__point" aria-hidden="true"></span>non appliquée</span>`;
        // §26.3 : « non appliquée » est un retard, pas une panne — accent, pas danger.
        const reappliquer = r.applied_at
          ? ''
          : `<button type="button" class="bouton bouton--compact" data-reapplique="1">Réappliquer</button>`;
        const confirme = ui.confirming?.kind === 'route' && ui.confirming.id === r.domain
          ? `<div class="confirmation" role="group" aria-label="Confirmer le retrait">
               <p><strong>Retirer « ${echapper(r.domain)} » ?</strong></p>
               <p class="confirmation__consequence">Ce domaine cessera de répondre
               immédiatement. Le Spark et ses données ne sont pas touchés.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-route="${echapper(r.domain)}">Retirer la route</button>
                 <button type="button" class="bouton" data-annule="route">Annuler</button>
               </p>
             </div>`
          : '';
        return `<li><span class="technique">${echapper(r.domain)}</span>` +
          ` → port ${echapper(r.target_port)} du Spark` +
          `${r.tls ? '' : ' <span class="badge badge--neutral">sans TLS</span>'}${attente}` +
          `<span class="actions-ligne">${reappliquer}` +
          `<button type="button" class="bouton bouton--compact" data-retire-route="${echapper(r.domain)}">Retirer</button></span>` +
          `${confirme}</li>`;
      }).join('')}</ul>`
    : '<p class="absence">Aucune route publique ne pointe vers ce Spark.</p>';

  const formulaire = ui.open === 'route'
    ? `<form class="formulaire-panneau" data-formulaire="route">
         <div class="champ">
           <label for="route-domaine">Domaine</label>
           <input class="controle" id="route-domaine" name="domain" type="text"
                  autocomplete="off" value="${echapper(ui.values.domain)}">
         </div>
         <div class="champ">
           <label for="route-port">Port du Spark</label>
           <input class="controle" id="route-port" name="port" type="number" min="1" max="65535"
                  value="${echapper(ui.values.port)}">
           <p class="champ__aide">Le port sur lequel écoute la pile DANS le Spark,
           pas celui de l’hôte.</p>
         </div>
         <div class="champ">
           <label for="route-tls">
             <input id="route-tls" name="tls" type="checkbox" ${ui.values.tls ? 'checked' : ''}>
             Certificat TLS automatique
           </label>
           <p class="champ__aide">L’émission suppose que le domaine résolve déjà vers
           cet hôte. Le DNS est extérieur au produit : un domaine mal pointé fait
           échouer l’émission côté Caddy, pas côté plan de contrôle.</p>
         </div>
         ${refus(ui, 'route')}
         <p class="formulaire__actions">
           <button type="submit" class="bouton bouton--primaire" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Déclaration…' : 'Déclarer la route'}</button>
           <button type="button" class="bouton" data-ferme="route">Annuler</button>
         </p>
       </form>`
    : refus(ui, 'route');

  return `
<section class="carte bloc" aria-labelledby="titre-routes">
  <h2 id="titre-routes">Routes publiques</h2>
  ${lignes}
  ${formulaire}
  ${declencheur('route', 'Ajouter une route', ui)}
</section>`;
}

/* -------------------------------------------------------------------- clés */

/**
 * Clés autorisées.
 *
 * L'empreinte affichée est celle que le serveur rend, jamais un condensat
 * recalculé ici (§17.2, §26.4).
 */
export function renderKeysPanel(spark, { keys = [], registry = [], sshConfig = null } = {},
                                ui = ADMIN_VIDE) {
  const accordees = new Set(keys.map((k) => k.label));
  const disponibles = registry.filter((k) => !accordees.has(k.label));

  const lignes = keys.length
    ? `<ul class="liste-administrable">${keys.map((k) =>
        `<li>${echapper(k.label)} <span class="technique">${echapper(k.fingerprint)}</span>` +
        `<span class="actions-ligne"><button type="button" class="bouton bouton--compact" ` +
        `data-revoque="${echapper(k.label)}">Révoquer</button></span></li>`).join('')}</ul>`
    : "<p class=\"absence\">Aucune clé n’est autorisée : personne ne peut s’y connecter.</p>";

  // §26.4 : révoquer est réversible et ne confirme pas — mais révoquer la
  // DERNIÈRE clé ferme le Spark à tout le monde, et cela se dit avant le geste.
  const derniere = keys.length === 1
    ? `<p class="avertissement" role="status">C’est la seule clé autorisée :
       la révoquer fermera ce Spark à tout le monde.</p>`
    : '';

  const choixRegistre = disponibles.length
    ? `<div class="champ">
         <label for="cle-registre">Clé déjà enregistrée</label>
         <select class="controle" id="cle-registre" name="key_label">
           <option value="">— choisir une clé —</option>
           ${disponibles.map((k) =>
             `<option value="${echapper(k.label)}"${ui.values.key_label === k.label ? ' selected' : ''}>` +
             `${echapper(k.label)}</option>`).join('')}
         </select>
       </div>`
    : `<p class="absence">Le registre ne contient aucune clé que ce Spark n’ait déjà.</p>`;

  const formulaire = ui.open === 'key'
    ? `<form class="formulaire-panneau" data-formulaire="key">
         ${choixRegistre}
         <p class="note">ou enregistrer une clé nouvelle, qui sera accordée dans la foulée :</p>
         <div class="champ">
           <label for="cle-libelle">Libellé</label>
           <input class="controle" id="cle-libelle" name="new_label" type="text"
                  autocomplete="off" value="${echapper(ui.values.new_label)}">
         </div>
         <div class="champ">
           <label for="cle-publique">Clé publique</label>
           <input class="controle technique" id="cle-publique" name="public_key" type="text"
                  autocomplete="off" placeholder="ssh-ed25519 AAAA… poste-de-travail"
                  value="${echapper(ui.values.public_key)}">
           <p class="champ__aide">Seule une clé publique est acceptée. Une clé privée
           collée par erreur est refusée par le registre, pas détectée plus tard.</p>
         </div>
         ${refus(ui, 'key')}
         <p class="formulaire__actions">
           <button type="submit" class="bouton bouton--primaire" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Autorisation…' : 'Autoriser'}</button>
           <button type="button" class="bouton" data-ferme="key">Annuler</button>
         </p>
       </form>`
    : refus(ui, 'key');

  // §17.4 et §26.4 : le fragment vient du serveur, il n'est pas reconstruit ici.
  const fragment = sshConfig?.config
    ? `<h3>Configuration SSH</h3>
       <pre class="fragment technique">${echapper(sshConfig.config)}</pre>
       <p class="note">Un Spark n’expose jamais son port 22 : l’accès passe par rebond
       sur l’hôte.</p>`
    : '';

  return `
<section class="carte bloc" aria-labelledby="titre-cles">
  <h2 id="titre-cles">Clés autorisées</h2>
  ${lignes}
  ${derniere}
  ${formulaire}
  ${declencheur('key', 'Autoriser une clé', ui)}
  ${fragment}
  <p class="note">Retirer une clé du registre commun — donc de tous les Sparks à la
  fois — ne se fait pas depuis cet écran.</p>
</section>`;
}

/* ------------------------------------------------------------- instantanés */

/**
 * Bloc de refus « des instantanés plus récents bloquent la restauration ».
 *
 * §26.5, et c'est la règle à ne pas inverser : l'acceptation de la perte n'est
 * offerte qu'APRÈS ce refus. Une case cochée d'avance le serait par habitude, et
 * ferait perdre des instantanés jamais regardés. Le refus est ce qui rend la
 * perte visible.
 */
export function renderBlockedRestore(refusal) {
  if (!refusal?.blocking?.length) return '';
  const n = refusal.blocking.length;
  // Le bouton final est destructif : il doit nommer SA cible, pas seulement le
  // nombre de victimes. Trois instantanés portent chacun leur « Restaurer ».
  return `<div class="refus" role="alert">
    <p><strong>Restauration de « ${echapper(refusal.snapshot)} » refusée : ${n} instantané${n > 1 ? 's' : ''} plus récent${n > 1 ? 's' : ''} serai${n > 1 ? 'ent' : 't'} détruit${n > 1 ? 's' : ''}.</strong></p>
    <ul class="liste-simple">${refusal.blocking.map((b) =>
      `<li><span class="technique">${echapper(b)}</span></li>`).join('')}</ul>
    <p class="confirmation__consequence">Revenir à un point antérieur détruit
    définitivement tout ce qui a été capturé depuis.</p>
    <p class="confirmation__actions">
      <button type="button" class="bouton bouton--destructif" data-accepte-perte="${echapper(refusal.snapshot)}">
        Restaurer en perdant ${n > 1 ? `ces ${n} instantanés` : 'cet instantané'}</button>
      <button type="button" class="bouton" data-annule="snapshot">Annuler</button>
    </p>
  </div>`;
}

/** Instantanés. `stateful` n'est pas proposé : il échoue sur cet hôte (§19.3). */
export function renderSnapshotsPanel(spark, snapshots = [], ui = ADMIN_VIDE) {
  const lignes = snapshots.length
    ? `<ul class="liste-administrable">${snapshots.map((s) => {
        const nom = s.incus_name;
        const taille = s.size_bytes != null ? ` — ${formatBytes(s.size_bytes)}` : '';
        const confirmeSuppression = ui.confirming?.kind === 'snapshot-delete' && ui.confirming.id === nom
          ? `<div class="confirmation" role="group" aria-label="Confirmer la suppression">
               <p><strong>Supprimer « ${echapper(nom)} » ?</strong></p>
               <p class="confirmation__consequence">Cet instantané est détruit
               définitivement. Le Spark n’est pas touché.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-suppression="${echapper(nom)}">Supprimer</button>
                 <button type="button" class="bouton" data-annule="snapshot">Annuler</button>
               </p>
             </div>`
          : '';
        const confirmeRestauration = ui.confirming?.kind === 'snapshot-restore' && ui.confirming.id === nom
          ? `<div class="confirmation" role="group" aria-label="Confirmer la restauration">
               <p><strong>Restaurer « ${echapper(nom)} » ?</strong></p>
               <p class="confirmation__consequence">L’état actuel de la cellule est
               remplacé par celui de cet instantané. Ce qui a été écrit depuis est perdu.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-restauration="${echapper(nom)}">Restaurer</button>
                 <button type="button" class="bouton" data-annule="snapshot">Annuler</button>
               </p>
             </div>`
          : '';
        const bloque = ui.refusal?.panel === 'snapshot' && ui.refusal.snapshot === nom
          ? renderBlockedRestore(ui.refusal)
          : '';
        return `<li><span class="technique">${echapper(nom)}</span>` +
          `<span class="absence"> — ${echapper(formatDate(s.created_at))}${echapper(taille)}</span>` +
          `<span class="actions-ligne">` +
          `<button type="button" class="bouton bouton--compact" data-restaure="${echapper(nom)}">Restaurer</button>` +
          `<button type="button" class="bouton bouton--compact" data-supprime-instantane="${echapper(nom)}">Supprimer</button>` +
          `</span>${confirmeSuppression}${confirmeRestauration}${bloque}</li>`;
      }).join('')}</ul>`
    : '<p class="absence">Aucun instantané.</p>';

  const formulaire = ui.open === 'snapshot'
    ? `<form class="formulaire-panneau" data-formulaire="snapshot">
         <div class="champ">
           <label for="instantane-nom">Nom de l’instantané</label>
           <input class="controle" id="instantane-nom" name="snapshot" type="text"
                  autocomplete="off" placeholder="avant-deploiement"
                  value="${echapper(ui.values.snapshot)}">
           <p class="champ__aide">Un instantané consomme le quota disque du Spark :
           il coûte d’abord zéro, puis grossit à mesure que le Spark s’en écarte.</p>
         </div>
         ${ui.refusal?.panel === 'snapshot' && !ui.refusal.blocking ? refus(ui, 'snapshot') : ''}
         <p class="formulaire__actions">
           <button type="submit" class="bouton bouton--primaire" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Capture…' : 'Prendre l’instantané'}</button>
           <button type="button" class="bouton" data-ferme="snapshot">Annuler</button>
         </p>
       </form>`
    : (ui.refusal?.panel === 'snapshot' && !ui.refusal.blocking && !ui.refusal.snapshot ? refus(ui, 'snapshot') : '');

  return `
<section class="carte bloc" aria-labelledby="titre-instantanes">
  <h2 id="titre-instantanes">Instantanés</h2>
  ${lignes}
  ${formulaire}
  ${declencheur('snapshot', 'Prendre un instantané', ui)}
  <p class="note">Un instantané rend l’état complet de la cellule. Il vit dans le
  même pool que le Spark : il ne protège ni de la perte du pool, ni de celle de la
  machine, et consomme le quota disque.</p>
</section>`;
}
