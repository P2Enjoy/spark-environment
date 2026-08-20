/**
 * Les trois panneaux d'administration d'un Spark : routes publiques, clés
 * autorisées, instantanés.
 *
 * @spec docs/BACKLOG.md#SPK-21 · docs/DAT.md §26 (les trois surfaces),
 *       §26.2 (un formulaire s'ouvre, il n'occupe pas), §26.3 (routes),
 *       §26.4 (clés), §26.5 (instantanés) · §17, §18, §19 ·
 *       docs/DESIGN_SYSTEM.md §3.1, §6.9, §6.19, §6.22, §6.23, §6.24, §6.27
 *       (la saisie est recueillie par une modale limitée à la section), §14.7 ·
 *       docs/DESIGN_SYSTEM_APP.md
 * @spec docs/BACKLOG.md#SPK-48 · docs/DAT.md §18.3 bis (le joker, la préséance
 *       du plus spécifique, et la vue depuis le joker) · §18.4
 * @spec docs/BACKLOG.md#SPK-47 · docs/DAT.md §38 (le DNS entre dans le
 *       périmètre), §38.3 (ce qu'écrit un enregistrement d'ingress),
 *       §38.4 (poser n'est pas résoudre) — pour le panneau « Pointer le
 *       domaine » de la section des routes publiques.
 *
 * Ce sont des panneaux du détail, pas des écrans (§26.1) : une route publique
 * et un instantané n'existent pas sans leur Spark.
 */

import { formatBytes } from './tokens.js';
import { renderModale } from './modale.js';

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
  open: null,        // 'route' | 'key' | 'snapshot' | 'protection' | 'dns' (§26.2)
  confirming: null,  // { kind, id }
  refusal: null,     // { panel, message, blocking? }
  busy: false,
  values: { domain: '', port: 8080, tls: true,
            key_label: '', new_label: '', public_key: '',
            snapshot: '', password: '',
            // SPK-47 · §38.3 : ce qui sera écrit dans la zone.
            dns_zone: '', dns_address: '' },
  // SPK-48 · §18.3 bis : la route qu'une déclaration vient de dépasser, et le
  // Spark qui la servait. Nul tant qu'aucune déclaration n'a pris le pas.
  supersedes: null,
  // SPK-47 · §38.1 : ce que la console SAIT du fournisseur. `configured` vaut
  // `null` tant qu'on n'a pas demandé — « pas encore su » n'est pas « pas
  // configuré », et l'écran ne doit pas annoncer une absence qu'il n'a pas
  // constatée.
  dns: { domain: null, configured: null, reason: null, zones: [],
         loading: false, written: null,
         // Ce qui a DÉJÀ été lu, pour ne pas relire à l'identique (§38.5.2).
         lu: null,
         // §38.5.2 : ce qui occupe DÉJÀ le couple nom + type visé. `effet` vaut
         // 'pose' | 'remplace' | 'inchange'. Tant qu'on ne l'a pas demandé, il
         // est nul — et l'écran dit alors qu'il vérifie, pas qu'il n'y a rien.
         apercu: null, apercuEnCours: false },
};

/**
 * Zone la plus SPÉCIFIQUE qui contienne le domaine (§38.5).
 *
 * Un compte peut porter `exemple.tech` ET `staging.exemple.tech` : proposer la
 * première trouvée écrirait `app.staging` dans la zone parente, où la
 * délégation le rendrait invisible. La plus longue gagne.
 */
export function zonePour(domaine, zones = []) {
  const d = String(domaine ?? '').trim().toLowerCase().replace(/\.$/, '');
  return zones
    .map((z) => (typeof z === 'string' ? z : z.zone))
    // Le domaine peut ÊTRE la zone : c'est le cas d'un site sur le domaine nu,
    // `johndalia.com`. Ne retenir que les sous-domaines laissait l'exploitant
    // choisir à la main la seule zone possible, sans lui dire laquelle (§38.5.1).
    .filter((z) => z && (d === z.toLowerCase() || d.endsWith(`.${z.toLowerCase()}`)))
    .sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * Bouton qui ouvre un formulaire, ou rien si un autre panneau est déjà ouvert.
 * §26.2 : un seul formulaire à la fois. Deux formulaires ouverts laisseraient
 * croire qu'on prépare deux gestes qui partiraient ensemble.
 */
/**
 * Commande de section. Elle ouvre une modale dont le sujet est CETTE section
 * (§6.27) ; elle ne se remplace plus par un formulaire dans le flux.
 *
 * Elle reste visible pendant la saisie : c'est elle qui reçoit le focus à la
 * fermeture, et un déclencheur disparu n'aurait rien à qui le rendre.
 */
function declencheur(panneau, libelle) {
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
          // SPK-47 · §38 : pointer le DNS est un geste de CETTE route, pas de la
          // section — deux routes du même Spark ont deux domaines distincts.
          `<button type="button" class="bouton bouton--compact" data-dns-route="${echapper(r.domain)}">DNS</button>` +
          `<button type="button" class="bouton bouton--compact" data-retire-route="${echapper(r.domain)}">Retirer</button></span>` +
          `${renderSurcharges(r)}${confirme}</li>`;
      }).join('')}</ul>`
    : '<p class="absence">Aucune route publique ne pointe vers ce Spark.</p>';

  const modale = renderModale({
    ouverte: ui.open === 'route', id: 'route', titre: 'Routes publiques',
    engagement: 'Déclarer la route', refus: ui.refusal?.panel === 'route' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
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
           cette Forge. Le bouton « DNS » de la route pose l’enregistrement chez le
           fournisseur ; la résolution reste soumise à la propagation, et un domaine
           mal pointé fait échouer l’émission côté Caddy, pas côté plan de contrôle.</p>
         </div>`,
  });

  return `
<section class="carte bloc" aria-labelledby="titre-routes">
  <h2 id="titre-routes">Routes publiques</h2>
  ${lignes}
  ${renderPriseDePas(ui)}
  ${renderDnsEcrit(ui)}
  ${declencheur('route', 'Ajouter une route')}
  ${modale}
  ${renderDnsModale(ui)}
</section>`;
}

/**
 * Ce que la déclaration vient de détourner (SPK-48, §18.3 bis).
 *
 * La déclaration a RÉUSSI — ce n'est pas un refus, donc accent et non danger.
 * Mais un exploitant qui déclare `admin.monapi.fr` doit savoir qu'il vient de
 * prendre le pas sur une adresse qui partait ailleurs : le silence ici
 * produirait une panne cherchée pendant des heures du mauvais côté.
 */
function renderPriseDePas(ui) {
  const prise = ui.supersedes;
  if (!prise) return '';
  return `<p class="avertissement" role="status" id="prise-de-pas">Cette route prend
    le pas sur <span class="technique">${echapper(prise.domain)}</span>, servi
    par le Spark <strong>${echapper(prise.spark_name)}</strong>. Ce nom ne part
    plus là-bas.</p>`;
}

/**
 * Les noms qu'un joker s'est fait SOUSTRAIRE (SPK-48, §18.3 bis).
 *
 * Dire la surcharge au moment où on la crée ne suffit pas : ce message passe
 * une fois, et l'exploitant du Spark porteur du joker ne l'a peut-être jamais
 * lu. C'est aussi ce qui manque au diagnostic — sans cette liste, on cherche
 * dans la configuration du Spark porteur, où il n'y a rien à trouver.
 *
 * Le repli est l'absence, jamais `undefined` à l'écran (§14.7) : une route
 * exacte ne porte pas cette clé, et un joker sans surcharge porte une liste
 * vide, ce qui n'est pas la même chose.
 */
function renderSurcharges(route) {
  const pris = route.superseded_by;
  if (!Array.isArray(pris) || pris.length === 0) return '';
  // §14.8 : une nature différente se distingue par la STRUCTURE, pas seulement
  // par la couleur — d'où une liste imbriquée SOUS la route, et non un badge.
  //
  // Elle est écrite en FIN de ligne, après les actions : la ligne est un flex
  // qui replie, et l'insérer avant les actions les renvoyait à la ligne
  // suivante. Mesuré sur la capture.
  return `<ul class="surcharges">${pris.map((p) =>
    `<li><span class="technique">${echapper(p.domain)}</span> est servi par le
     Spark <strong>${echapper(p.spark_name)}</strong></li>`).join('')}</ul>`;
}

/**
 * Ce qui a été ÉCRIT, et rien de plus (§38.4).
 *
 * On n'annonce jamais « le domaine est prêt » : la propagation prend le temps du
 * TTL, et un résolveur qui a déjà l'ancienne réponse en cache la sert encore.
 * Annoncer « prêt » ferait chercher la panne ailleurs pendant tout ce temps.
 */
function renderDnsEcrit(ui) {
  const ecrit = ui.dns?.written;
  if (!ecrit) return '';
  // `id` distinct de celui de l'effet : deux blocs de même classe et même rôle
  // coexistent dans cet écran — « sera remplacé » dans la modale, « a été écrit »
  // dans la section —, et les confondre ferait lire un projet pour un fait.
  return `<p class="avertissement" role="status" id="dns-ecrit">Enregistrement
    <span class="technique">${echapper(ecrit.type)} ${echapper(ecrit.fqdn)}
    → ${echapper(ecrit.data)}</span> écrit chez le fournisseur.
    ${echapper(ecrit.propagation ?? '')}</p>`;
}

/**
 * « Pointer le domaine » : modale limitée à la section des routes (§6.27).
 *
 * Le domaine n'est PAS saisissable : il vient de la route qu'on pointe. Le
 * rendre modifiable ici laisserait poser un enregistrement pour un domaine que
 * la Forge ne route pas, c'est-à-dire un domaine qui résoudrait vers un 404.
 */
function renderDnsModale(ui) {
  const dns = ui.dns ?? ADMIN_VIDE.dns;
  const domaine = dns.domain ?? '';

  const corps = dns.loading
    ? '<p class="absence">Lecture des zones du compte…</p>'
    : dns.configured === false
      ? `<p class="absence">${echapper(dns.reason ?? '')}</p>
         <p class="champ__aide">Le jeton vit sur ce poste, jamais sur la Forge :
         un jeton déposé sur la Forge serait lisible par qui y détient
         l’administration.</p>`
      : dns.zones.length === 0
        ? '<p class="absence">Le compte ne porte aucune zone DNS.</p>'
        : `
         <div class="champ">
           <label for="dns-domaine">Domaine de la route</label>
           <input class="controle technique" id="dns-domaine" type="text" readonly
                  value="${echapper(domaine)}">
           <p class="champ__aide">Il vient de la route publique : la Forge ne
           routerait pas un autre nom.</p>
         </div>
         <div class="champ">
           <label for="dns-zone">Zone</label>
           <select class="controle" id="dns-zone" name="dns_zone">
             <option value="">— choisir une zone —</option>
             ${dns.zones.map((z) =>
               `<option value="${echapper(z.zone)}"` +
               `${ui.values.dns_zone === z.zone ? ' selected' : ''}>` +
               `${echapper(z.zone)}${z.status === 'active' ? '' : ` (${echapper(z.status)})`}` +
               `</option>`).join('')}
           </select>
         </div>
         <div class="champ">
           <label for="dns-adresse">Adresse publique de la Forge</label>
           <input class="controle technique" id="dns-adresse" name="dns_address" type="text"
                  autocomplete="off" value="${echapper(ui.values.dns_address)}">
           <p class="champ__aide">C’est l’adresse de la FORGE, pas celle du Spark :
           un Spark vit sur un réseau privé, et c’est Caddy qui répartit ensuite
           par nom d’hôte.</p>
         </div>
         <p class="note">Sera écrit :
           <span class="technique" id="dns-apercu">${echapper(apercu(domaine, ui.values))}</span>,
           TTL 300 s. Rien d’autre n’est touché dans la zone.</p>
         <div id="dns-effet">${renderEffet(dns)}</div>`;

  return renderModale({
    ouverte: ui.open === 'dns', id: 'dns',
    titre: 'Pointer le domaine',
    engagement: 'Poser l’enregistrement',
    refus: ui.refusal?.panel === 'dns' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps,
  });
}

/**
 * Ce que l'écriture fera à ce qui est DÉJÀ là (§38.5.2).
 *
 * C'est ce qui remplace le refus d'écrire à l'apex : on ne retire pas le
 * pouvoir, on montre ce qu'il va faire. Un écrasement reste le comportement
 * voulu — reposer une route déplacée doit marcher — mais jamais une surprise.
 *
 * Exporté parce que l'écran le remplace SUR PLACE, dans `#dns-effet`, sans
 * repeindre. Mesuré : repeindre la modale pendant la lecture reconstruisait le
 * formulaire sous les doigts — le focus repartait au premier champ, et le bouton
 * d'engagement se détachait sous le clic.
 */
export function renderEffet(dns) {
  const vu = dns.apercu;
  // Pendant une RELECTURE, on garde ce qui est affiché et on le marque occupé.
  //
  // Mesuré : vider le bloc le faisait rétrécir, la modale avec — et le bouton
  // d'engagement se dérobait entre l'appui et le relâchement. Le clic ne partait
  // jamais. Un bloc qui change de hauteur sous le curseur est un piège, pas une
  // information (docs/DESIGN_SYSTEM.md §6.13).
  if (dns.apercuEnCours && !vu) {
    return '<p class="note" aria-busy="true">Lecture de ce qui est déjà en place…</p>';
  }
  if (!vu) return '';
  const occupe = dns.apercuEnCours ? ' aria-busy="true"' : '';

  if (vu.effet === 'inchange') {
    return `<p class="note" role="status"${occupe}>Cet enregistrement porte déjà cette
      valeur : l’écrire ne changera rien.</p>`;
  }
  if (vu.effet === 'remplace') {
    // Accent, pas danger : remplacer est le geste demandé, pas une panne — mais
    // la valeur remplacée doit être LUE avant, pas devinée après.
    return `<p class="avertissement" role="status"${occupe}>Cet enregistrement existe déjà.
      Il sera <strong>remplacé</strong> :
      <span class="technique">${echapper(vu.current?.data ?? '')}</span> →
      <span class="technique">${echapper(vu.data)}</span>.${
      vu.apex ? ' C’est le domaine <strong>nu</strong> : le remplacer déplace tout'
              + ' ce qui répond sur ce domaine, pas seulement un sous-domaine.' : ''}</p>`;
  }
  return `<p class="note" role="status"${occupe}>Rien n’occupe ce nom pour l’instant :
    l’enregistrement sera posé.${
    vu.apex ? ' Il porte sur le domaine <strong>nu</strong>.' : ''}</p>`;
}

/**
 * Aperçu de l'enregistrement, tel qu'il partira.
 *
 * Exporté parce que l'écran le RECALCULE à chaque frappe sans repeindre : un
 * repeint à chaque touche déplacerait le curseur, et un aperçu qui ne suit pas
 * la saisie est pire que pas d'aperçu — il montre une valeur qui ne sera pas
 * écrite. Mesuré par le parcours E2E.
 */
export function apercu(domaine, valeurs = {}) {
  const adresse = String(valeurs.dns_address ?? '').trim();
  const type = adresse.includes(':') ? 'AAAA' : 'A';
  return `${nomAEcrire(domaine, valeurs.dns_zone)} ${type} → ${adresse || '…'}`;
}

/**
 * Nom relatif tel qu'il sera écrit, ou un tiret tant que la zone n'est pas
 * choisie.
 *
 * L'apex s'écrit `@` — la notation des fichiers de zone —, pas un tiret : un
 * tiret se lit « rien » là où il faut lire « le domaine lui-même ».
 */
function nomAEcrire(domaine, zone) {
  if (!zone) return '—';
  const d = String(domaine ?? '').toLowerCase();
  const z = String(zone).toLowerCase();
  if (d === z) return '@';
  return d.endsWith(`.${z}`) ? d.slice(0, -(z.length + 1)) : '—';
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

  // §35.2 : la révocation qui traverse un Spark protégé le NOMME avant d'aboutir.
  const traverse = ui.refusal?.panel === 'key' && ui.refusal.protected_sparks
    ? renderProtectedRevocation(ui.refusal)
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

  const modale = renderModale({
    ouverte: ui.open === 'key', id: 'key', titre: 'Clés autorisées',
    engagement: 'Autoriser', refus: ui.refusal?.panel === 'key' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
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
         </div>`,
  });

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
  ${traverse}
  ${declencheur('key', 'Autoriser une clé')}
  ${fragment}
  ${modale}
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
/**
 * La révocation d'une clé traverse un Spark protégé, et le NOMME (SPK-34).
 *
 * @spec docs/BACKLOG.md#SPK-34 · docs/DAT.md §35.2 (retirer un accès passe
 *       toujours), §35.5 (l'ordre refus-puis-acceptation) ·
 *       docs/DESIGN_SYSTEM.md §6.23 (une protection ne bloque jamais un geste
 *       qui réduit un risque), §6.22 (la confirmation reste dans le flux)
 *
 * Ce n'est PAS un blocage : c'est la façon dont le runtime dit ce qu'il va
 * toucher. Le §6.23 l'exige mot pour mot — les objets protégés sont **nommés**,
 * pas comptés, et l'action aboutit sans qu'aucune protection soit levée.
 *
 * Le bouton n'est PAS destructif : révoquer un accès réduit un risque. Le §6.23
 * interdit d'employer `danger` parce qu'une action est importante.
 */
export function renderProtectedRevocation(refusal) {
  if (!refusal?.protected_sparks?.length) return '';
  const noms = refusal.protected_sparks;
  const n = noms.length;
  return `<div class="refus" role="alert">
    <p><strong>Révoquer « ${echapper(refusal.label)} » touche ${n} Spark${
      n > 1 ? 's' : ''} protégé${n > 1 ? 's' : ''}.</strong></p>
    <ul class="liste-simple">${noms.map((nom) =>
      `<li><span class="technique">${echapper(nom)}</span></li>`).join('')}</ul>
    <p class="confirmation__consequence">Retirer un accès n’est jamais refusé par
    la protection : elle arrête l’erreur, elle ne retient pas un geste qui réduit
    un risque. <strong>Aucune protection ne sera levée.</strong></p>
    <p class="confirmation__actions">
      <button type="button" class="bouton bouton--primaire" data-accepte-protege="${
        echapper(refusal.label)}">Révoquer quand même</button>
      <button type="button" class="bouton" data-annule="key">Annuler</button>
    </p>
  </div>`;
}

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

  const modale = renderModale({
    ouverte: ui.open === 'snapshot', id: 'snapshot', titre: 'Instantanés',
    engagement: 'Prendre l’instantané', occupee: ui.busy,
    refus: (ui.refusal?.panel === 'snapshot' && !ui.refusal.blocking && !ui.refusal.snapshot)
      ? ui.refusal.message : null,
    corps: `
         <div class="champ">
           <label for="instantane-nom">Nom de l’instantané</label>
           <input class="controle" id="instantane-nom" name="snapshot" type="text"
                  autocomplete="off" placeholder="avant-deploiement"
                  value="${echapper(ui.values.snapshot)}">
           <p class="champ__aide">Un instantané consomme le quota disque du Spark :
           il coûte d’abord zéro, puis grossit à mesure que le Spark s’en écarte.</p>
         </div>`,
  });

  return `
<section class="carte bloc" aria-labelledby="titre-instantanes">
  <h2 id="titre-instantanes">Instantanés</h2>
  ${lignes}
  ${declencheur('snapshot', 'Prendre un instantané')}
  ${modale}
  <p class="note">Un instantané rend l’état complet de la cellule. Il vit dans le
  même pool que le Spark : il ne protège ni de la perte du pool, ni de celle de la
  machine, et consomme le quota disque.</p>
</section>`;
}
